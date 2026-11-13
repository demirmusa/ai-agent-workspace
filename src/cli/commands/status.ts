import { providerDockerArgs, type LoginProvider } from './login.js';
import { CommandError } from '../../shared/core/command.js';
import { GitHubClient, type GitHubRunnerStatus } from '../../shared/github/client.js';
import { composeBaseArgs } from '../../runtime/compose.js';
import { loadInstallationCredentials } from '../../runtime/credential-store.js';
import { runOnTarget } from '../../runtime/target.js';
import type { AppContext } from './context.js';
import { loadRepository, runtimeExists, type LoadedRepository } from './repository-context.js';
import { poolRunnerName, runnerPoolSize } from '../../runtime/materialize.js';
import { readQueueState, type QueueState } from './queue.js';

export interface StatusOptions {
  json: boolean;
}

interface StatusReport {
  repository: string;
  target: string;
  runtimePrepared: boolean;
  containers: unknown[];
  runner: GitHubRunnerStatus | null;
  runners: GitHubRunnerStatus[];
  queue: QueueState | null;
  auth: Record<string, 'authenticated' | 'missing' | 'unknown'>;
  recentRuns: unknown[];
  warnings: string[];
}

export async function runStatus(context: AppContext, options: StatusOptions): Promise<void> {
  const loaded = await loadRepository(context);
  const runtimePrepared =
    loaded.installation.target === 'ssh' || (await runtimeExists(loaded.localRuntimeDirectory));
  // Every probe is independent and may wait on Docker or GitHub, so they run concurrently. Each keeps its own
  // warnings so the report order stays stable.
  const [dockerProbe, runnerProbe, auth, runsProbe, queueProbe] = await Promise.all([
    probeContainers(context, loaded, runtimePrepared),
    probeRunners(context, loaded),
    probeProviderAuth(context, loaded, runtimePrepared),
    probeRecentRuns(context, loaded),
    probeQueue(context, loaded, runtimePrepared),
  ]);
  const warnings = [dockerProbe, runnerProbe, runsProbe, queueProbe].flatMap((probe) => probe.warnings);
  const containers = dockerProbe.value, { runner: runnerStatus, pool } = runnerProbe.value, recentRuns = runsProbe.value, queue = queueProbe.value;
  const report: StatusReport = {
    repository: loaded.config.repository.slug,
    target: loaded.installation.target,
    runtimePrepared,
    containers,
    runner: runnerStatus,
    runners: pool,
    queue,
    auth,
    recentRuns,
    warnings,
  };
  if (options.json) {
    context.logger.info(JSON.stringify(report, null, 2));
    return;
  }
  context.logger.info(`${report.repository} (${report.target})`);
  context.logger.info(`Worker pool: ${pool.filter(({ status }) => status === 'online').length}/${runnerPoolSize(loaded.config)} online, ${pool.filter(({ busy }) => busy).length} busy`);
  if (queue) {
    const counts = Object.values(queue.tasks).reduce<Record<string, number>>((result, { state }) => { result[state] = (result[state] ?? 0) + 1; return result; }, {});
    context.logger.info(`Queue: ${Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ') || 'empty'}. Details: aiws queue status`);
  }
  context.logger.info(`Docker: ${containers.length > 0 ? `${containers.length} service(s)` : 'not running'}`);
  context.logger.info(
    `GitHub runner: ${runnerStatus ? `${runnerStatus.status}${runnerStatus.busy ? ', busy' : ', idle'}` : 'not registered'}`,
  );
  for (const [provider, state] of Object.entries(auth)) context.logger.info(`${provider} auth: ${state}`);
  context.logger.info(`Recent AIWS/GitHub runs returned: ${recentRuns.length}`);
  for (const warning of warnings) context.logger.warn(warning);
}

interface Probe<T> { value: T; warnings: string[] }
const failure = (prefix: string, error: unknown): string => `${prefix}: ${(error as Error).message}`;

async function probeContainers(context: AppContext, loaded: LoadedRepository, runtimePrepared: boolean): Promise<Probe<unknown[]>> {
  if (!runtimePrepared) return { value: [], warnings: ['Runtime has not been prepared; run `aiws up`.'] };
  try {
    const result = await runOnTarget(context.runner, loaded.installation, 'docker',
      [...composeBaseArgs(loaded.installation), 'ps', '--format', 'json'], { runtimeDirectory: loaded.targetRuntimeDirectory });
    return { value: parseComposeJson(result.stdout), warnings: [] };
  } catch (error) {
    return { value: [], warnings: [failure('Docker status unavailable', error)] };
  }
}

async function probeRunners(context: AppContext, loaded: LoadedRepository): Promise<Probe<{ runner: GitHubRunnerStatus | null; pool: GitHubRunnerStatus[] }>> {
  try {
    const token = (await loadInstallationCredentials(loaded.config.repository.slug)).runnerToken;
    const github = new GitHubClient(context.runner, token);
    const ownedNames = new Set(Array.from({ length: runnerPoolSize(loaded.config) }, (_, index) => poolRunnerName(loaded.installation.runnerName, index + 1)));
    const pool = (await github.listRunners(loaded.config.repository.slug)).filter(({ name }) => ownedNames.has(name));
    const runner = pool.find(({ name }) => name === loaded.installation.runnerName) ?? null;
    return { value: { runner, pool }, warnings: runner ? [] : ['Runner is not registered on GitHub.'] };
  } catch (error) {
    return { value: { runner: null, pool: [] }, warnings: [failure('GitHub runner status unavailable', error)] };
  }
}

async function probeProviderAuth(context: AppContext, loaded: LoadedRepository, runtimePrepared: boolean): Promise<Record<string, 'authenticated' | 'missing' | 'unknown'>> {
  const providers = [...new Set(loaded.config.agents.profiles.map(({ provider }) => provider))];
  const states = await Promise.all(providers.map(async (provider) => runtimePrepared ? await providerAuthStatus(context, loaded, provider) : 'unknown' as const));
  return Object.fromEntries(providers.map((provider, index) => [provider, states[index]!]));
}

async function probeRecentRuns(context: AppContext, loaded: LoadedRepository): Promise<Probe<unknown[]>> {
  try {
    const credentials = await loadInstallationCredentials(loaded.config.repository.slug).catch(() => undefined);
    const githubToken = credentials?.runnerToken ?? (await new GitHubClient(context.runner).resolveToken());
    const result = await context.runner.run('gh',
      ['run', 'list', '--repo', loaded.config.repository.slug, '--limit', '10', '--json', 'databaseId,name,status,conclusion,createdAt,url'],
      { env: { GH_TOKEN: githubToken }, redact: [githubToken] });
    return { value: JSON.parse(result.stdout) as unknown[], warnings: [] };
  } catch (error) {
    return { value: [], warnings: [failure('Recent workflow runs unavailable', error)] };
  }
}

async function probeQueue(context: AppContext, loaded: LoadedRepository, runtimePrepared: boolean): Promise<Probe<QueueState | null>> {
  if (!runtimePrepared || !loaded.config.orchestration.enabled) return { value: null, warnings: [] };
  try { return { value: await readQueueState(context, loaded), warnings: [] }; }
  catch (error) { return { value: null, warnings: [failure('Queue snapshot unavailable', error)] }; }
}

export async function providerAuthStatus(
  context: AppContext,
  loaded: LoadedRepository,
  provider: LoginProvider,
): Promise<'authenticated' | 'missing' | 'unknown'> {
  const command = provider === 'opencode'
    ? ['bash', '-c', 'test -s "$XDG_DATA_HOME/opencode/auth.json" && jq -e "length > 0" "$XDG_DATA_HOME/opencode/auth.json" >/dev/null']
    : provider === 'claude'
      ? ['bash', '-c', 'test -s "$CLAUDE_CONFIG_DIR/aiws-api-key" || claude auth status --json']
      : ['codex', 'login', 'status'];
  try {
    const result = await runOnTarget(context.runner, loaded.installation, 'docker',
      [...providerDockerArgs(loaded, provider), ...command],
      { runtimeDirectory: loaded.targetRuntimeDirectory, timeoutMs: 30_000 });
    if (provider === 'claude' && result.stdout.trim()) {
      try { if (JSON.parse(result.stdout).loggedIn === false) return 'missing'; } catch { /* CLI may emit diagnostics. */ }
    }
    return 'authenticated';
  } catch (error) {
    if (error instanceof CommandError && (error.result.exitCode === 1 || /not logged|not authenticated|login/i.test(error.result.stderr))) return 'missing';
    return 'unknown';
  }
}

function parseComposeJson(source: string): unknown[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
}
