import { AiwsError } from '../../shared/core/logger.js';
import { AGENT_PROVIDERS, type AgentProvider } from '../../shared/config/schema.js';
import { password } from '@inquirer/prompts';
import { GitHubClient } from '../../shared/github/client.js';
import { loadInstallationCredentials, saveInstallationCredentials } from '../../runtime/credential-store.js';
import { findAssetsRoot } from '../../shared/core/assets.js';
import { composeBaseArgs } from '../../runtime/compose.js';
import { deployRuntime } from '../../runtime/deploy.js';
import { runOnTarget } from '../../runtime/target.js';
import type { AppContext } from './context.js';
import { loadRepository, runtimeExists, type LoadedRepository } from './repository-context.js';
import { configurationRoot } from './configure.js';

export type LoginProvider = AgentProvider;
export interface LoginOptions {
  provider: string;
  auth: 'subscription' | 'api-key';
}

export function providerMount(loaded: LoadedRepository, provider: LoginProvider): { volume: string; directory: string } {
  const mounts = {
    claude: { volume: loaded.installation.names.volumes.claudeAuth, directory: '/home/agent/.claude' },
    codex: { volume: loaded.installation.names.volumes.codexAuth, directory: '/home/agent/.codex' },
    opencode: { volume: loaded.installation.names.volumes.opencodeAuth, directory: '/home/agent/.local/share/opencode' },
  };
  return mounts[provider];
}

export function providerDockerArgs(loaded: LoadedRepository, provider: LoginProvider, interactive = false): string[] {
  const { volume, directory } = providerMount(loaded, provider);
  return ['run', '--rm', '--pull', 'never', ...(interactive ? ['-it'] : ['-i']),
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '-e', 'HOME=/home/agent', '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    '-e', 'CODEX_HOME=/home/agent/.codex', '-e', 'XDG_DATA_HOME=/home/agent/.local/share',
    '-v', `${volume}:${directory}`, loaded.installation.names.images.agent];
}

export async function runLogin(context: AppContext, options: LoginOptions): Promise<void> {
  if (!['all', 'github', ...AGENT_PROVIDERS].includes(options.provider)) {
    throw new AiwsError('Provider must be github, claude, codex, opencode, or all.');
  }
  if (options.provider === 'github') {
    let hasConfig = true;
    try { await configurationRoot(context.cwd); } catch { hasConfig = false; }
    if (!hasConfig) {
      if (options.auth === 'subscription') await context.runner.run('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--scopes', 'repo,workflow,project'], { stdio: 'inherit' });
      else await new GitHubClient(context.runner).resolveToken();
      context.logger.success('GitHub login complete. Run aiws init to configure a repository.');
      return;
    }
  }
  const loaded = await loadRepository(context);
  if (options.provider === 'github' || options.provider === 'all') {
    if (options.auth === 'subscription') {
      await context.runner.run('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--scopes', 'repo,workflow,project'], { stdio: 'inherit' });
    }
    const token = await new GitHubClient(context.runner).resolveToken();
    await saveInstallationCredentials(loaded.config.repository.slug, { runnerToken: token, automationToken: process.env.AIWS_AUTOMATION_TOKEN?.trim() || token, projectToken: process.env.AIWS_PROJECT_TOKEN?.trim() || token });
    context.logger.success('GitHub credentials saved for Docker startup. Run `aiws up` to refresh a running runtime.');
    if (options.provider === 'github') return;
  }
  if (!(await runtimeExists(loaded.localRuntimeDirectory))) {
    context.logger.info('Preparing the agent image for first login (workers start with aiws up)...');
    const targetDirectory = await deployRuntime(context.runner, loaded.config, loaded.installation, await findAssetsRoot(),
      await loadInstallationCredentials(loaded.config.repository.slug), loaded.targetRuntimeDirectory);
    await runOnTarget(context.runner, loaded.installation, 'docker', [...composeBaseArgs(loaded.installation), 'build', 'agent-image'], {
      runtimeDirectory: targetDirectory, stdio: 'inherit',
    });
  }
  const requested = options.provider === 'all'
    ? [...new Set(loaded.config.agents.profiles.map(({ provider }) => provider))]
    : [options.provider as LoginProvider];
  for (const provider of requested) {
    const interactive = provider === 'opencode' || options.auth === 'subscription';
    const args = providerDockerArgs(loaded, provider, interactive);
    let input: string | undefined;
    if (provider === 'codex' && options.auth === 'api-key') {
      const apiKey = await readApiKey('OPENAI_API_KEY');
      args.push('codex', 'login', '--with-api-key');
      input = `${apiKey}\n`;
    } else if (provider === 'codex') {
      args.push('codex', 'login', '--device-auth');
    } else if (provider === 'opencode') {
      args.push('opencode', 'auth', 'login');
    } else if (options.auth === 'api-key') {
      const apiKey = await readApiKey('ANTHROPIC_API_KEY');
      args.push('bash', '-c', 'umask 077; cat > "$CLAUDE_CONFIG_DIR/aiws-api-key"');
      input = `${apiKey}\n`;
    } else {
      args.push('bash', '-c', 'claude auth login && rm -f -- "$CLAUDE_CONFIG_DIR/aiws-api-key"');
    }
    context.logger.info(`Starting ${provider} authentication inside the isolated agent image...`);
    await runOnTarget(context.runner, loaded.installation, 'docker', args, {
      runtimeDirectory: loaded.targetRuntimeDirectory,
      stdio: input ? 'pipe' : 'inherit', tty: interactive,
      ...(input ? { input, redact: [input.trim()] } : {}),
    });
    context.logger.success(`${provider} credentials saved in the persistent repository auth volume.`);
  }
}

async function readApiKey(name: string): Promise<string> {
  const key = process.env[name]?.trim() || (process.stdin.isTTY ? (await password({ message: `${name} (saved in the provider auth volume)`, mask: '*' })).trim() : '');
  if (!key || /[\r\n\0]/.test(key)) throw new AiwsError(`${name} must be a non-empty, single-line API key. Set it in the environment or use an interactive terminal.`);
  return key;
}

export async function runModels(context: AppContext, options: { provider: string }): Promise<void> {
  if (options.provider !== 'opencode') throw new AiwsError('Dynamic model discovery is available for opencode. Configure Claude/Codex model IDs in profiles.');
  const loaded = await loadRepository(context);
  await runOnTarget(context.runner, loaded.installation, 'docker', [...providerDockerArgs(loaded, 'opencode'), 'opencode', 'models', '--refresh'], {
    runtimeDirectory: loaded.targetRuntimeDirectory, stdio: 'inherit',
  });
  context.logger.info('Use a returned provider/model ID in your profile. Free model availability is provider-dependent.');
}
