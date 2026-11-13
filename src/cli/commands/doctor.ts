import { providerAuthStatus } from './status.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findAssetsRoot } from '../../shared/core/assets.js';
import { commandExists } from '../../shared/core/command.js';
import { GitHubClient } from '../../shared/github/client.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { renderRepository } from '../../templates/repository.js';
import { planRepositoryWrite } from '../../templates/writer.js';
import type { AppContext } from './context.js';
import { loadRepository, runtimeExists, type LoadedRepository } from './repository-context.js';

export interface DoctorOptions {
  json: boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(context: AppContext, options: DoctorOptions): Promise<void> {
  const checks: Check[] = [];
  const toolNames = ['git', 'gh', 'docker'];
  for (const [tool, present] of await Promise.all(toolNames.map(async (tool) => [tool, await commandExists(tool)] as const))) {
    checks.push({ name: tool, status: present ? 'pass' : 'fail', message: present ? 'found' : 'not found' });
  }

  let loaded: LoadedRepository | undefined;
  try {
    loaded = await loadRepository(context);
    checks.push({ name: 'config', status: 'pass', message: 'tracked and local configuration are valid' });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', message: (error as Error).message });
  }

  if (loaded) {
    if (loaded.installation.target === 'ssh') {
      const [sshPresent, scpPresent] = await Promise.all([commandExists('ssh'), commandExists('scp')]);
      checks.push({
        name: 'ssh tools',
        status: sshPresent && scpPresent ? 'pass' : 'fail',
        message: sshPresent && scpPresent ? 'ssh and scp found' : 'ssh and/or scp missing',
      });
    }

    try {
      const assets = await findAssetsRoot();
      const rendered = await renderRepository(loaded.config, assets, PACKAGE_VERSION);
      const { plan } = await planRepositoryWrite(loaded.info.root, rendered);
      const changed = plan.create.length + plan.update.length + plan.remove.length;
      checks.push({
        name: 'generated files',
        status: changed === 0 ? 'pass' : 'warn',
        message: changed === 0 ? 'in sync' : `${changed} file(s) differ; run aiws sync`,
      });
    } catch (error) {
      checks.push({ name: 'generated files', status: 'fail', message: (error as Error).message });
    }

    try {
      const github = new GitHubClient(context.runner);
      const repository = await github.getRepository(loaded.config.repository.slug);
      checks.push({
        name: 'GitHub access',
        status: repository.permissions.admin || repository.permissions.maintain || repository.permissions.push ? 'pass' : 'fail',
        message: `${repository.visibility}; default branch ${repository.defaultBranch}`,
      });
      if (repository.visibility === 'public') {
        checks.push({
          name: 'public repository',
          status: loaded.config.security.allowPublicRepository ? 'warn' : 'fail',
          message: 'self-hosted runners are unsafe for untrusted public contributions',
        });
      }
      const actions = await github.getActionsPermissions(loaded.config.repository.slug);
      const prAllowed = Boolean(actions.can_approve_pull_request_reviews);
      checks.push({
        name: 'Actions PR setting',
        status: prAllowed ? 'pass' : 'warn',
        message: prAllowed
          ? 'Actions may create pull requests'
          : 'verify “Allow GitHub Actions to create and approve pull requests” or install AIWS_AUTOMATION_TOKEN',
      });
    } catch (error) {
      checks.push({ name: 'GitHub access', status: 'fail', message: (error as Error).message });
    }

    const prepared =
      loaded.installation.target === 'ssh' || (await runtimeExists(loaded.localRuntimeDirectory));
    if (!prepared) {
      checks.push({ name: 'runtime', status: 'warn', message: 'not materialized; run aiws up when ready' });
    } else if (loaded.installation.target === 'local') {
      try {
        const version = (await readFile(join(loaded.localRuntimeDirectory, 'VERSION'), 'utf8')).trim();
        checks.push({
          name: 'runtime version',
          status: version === PACKAGE_VERSION ? 'pass' : 'warn',
          message: `${version || 'unknown'} (CLI ${PACKAGE_VERSION})`,
        });
      } catch (error) {
        checks.push({ name: 'runtime version', status: 'warn', message: (error as Error).message });
      }
    }

    if (prepared) {
      const providers = [...new Set(loaded.config.agents.profiles.map(({ provider }) => provider))];
      const states = await Promise.all(providers.map((provider) => providerAuthStatus(context, loaded!, provider)));
      for (const [index, provider] of providers.entries()) {
        const state = states[index];
        checks.push({ name: `${provider} credentials`, status: state === 'authenticated' ? 'pass' : 'warn',
          message: state === 'authenticated' ? 'credentials present in persistent volume (validity checked on use)' : `${state}; run aiws login ${provider}${provider === 'opencode' ? ' unless using a provider that needs no login' : ''}` });
      }
    }
    if (loaded.installation.target === 'local') {
      try {
        await context.runner.run('docker', ['info', '--format', '{{json .ServerVersion}}']);
        await context.runner.run('docker', ['compose', 'version']);
        checks.push({ name: 'Docker daemon', status: 'pass', message: 'reachable with Compose v2' });
      } catch (error) {
        checks.push({ name: 'Docker daemon', status: 'fail', message: (error as Error).message });
      }
    }
  }

  if (options.json) {
    context.logger.info(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
      context.logger.info(`${marker.padEnd(4)}  ${check.name}: ${check.message}`);
    }
  }
  if (checks.some(({ status }) => status === 'fail')) process.exitCode = 1;
}

