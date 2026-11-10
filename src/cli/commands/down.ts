import { GitHubClient } from '../../shared/github/client.js';
import { AiwsError } from '../../shared/core/logger.js';
import { composeDown, loadInstallationCredentials } from '../../runtime/index.js';
import type { AppContext } from './context.js';
import { loadRepository, runtimeExists } from './repository-context.js';
import { poolRunnerName, runnerPoolSize } from '../../runtime/materialize.js';
import { saveInstallationState } from '../../shared/config/store.js';

export interface DownOptions {
  dryRun: boolean;
}

export async function runDown(context: AppContext, options: DownOptions): Promise<void> {
  const loaded = await loadRepository(context);
  if (options.dryRun) {
    context.logger.info(`Would stop Compose project ${loaded.installation.names.composeProject}.`);
    context.logger.info(`Would remove GitHub runner registration ${loaded.installation.runnerName}.`);
    context.logger.info('Persistent workspace and auth volumes would be kept.');
    return;
  }

  const failures: string[] = [];
  const canRunCompose =
    loaded.installation.target === 'ssh' || (await runtimeExists(loaded.localRuntimeDirectory));
  if (canRunCompose) {
    try {
      await composeDown(
        context.runner,
        loaded.installation,
        loaded.targetRuntimeDirectory,
        false,
      );
    } catch (error) {
      const message = `Compose shutdown failed: ${(error as Error).message}`;
      failures.push(message);
      context.logger.warn(message);
    }
  } else {
    const message = 'Local runtime directory is absent; Docker Compose shutdown could not be verified.';
    if (loaded.installation.manifestHash) failures.push(message);
    context.logger.warn(
      loaded.installation.manifestHash
        ? message
        : 'Runtime was never successfully started on this installation; skipping Compose shutdown.',
    );
  }

  let github: GitHubClient | undefined;
  let ownedRunners: Array<{ id: number }> = [];
  try {
    const credentials = await loadInstallationCredentials(loaded.config.repository.slug);
    github = new GitHubClient(context.runner, credentials.runnerToken);
    const runners = await github.listRunners(loaded.config.repository.slug);
    const ownedNames = new Set(Array.from({ length: Math.max(loaded.installation.runnerSlots, runnerPoolSize(loaded.config)) }, (_, index) => poolRunnerName(loaded.installation.runnerName, index + 1)));
    ownedRunners = runners.filter(({ name }) => ownedNames.has(name));
  } catch (error) {
    const message = `Runner registration lookup failed: ${(error as Error).message}`;
    failures.push(message);
    context.logger.warn(message);
  }
  let removedRunners = 0;
  if (github) {
    for (const runner of ownedRunners) {
      try {
        await github.deleteRunner(loaded.config.repository.slug, runner.id);
        removedRunners += 1;
      } catch (error) {
        const message = `Runner deregistration failed for id ${runner.id}: ${(error as Error).message}`;
        failures.push(message);
        context.logger.warn(message);
      }
    }
  }
  if (removedRunners > 0) context.logger.success(`${removedRunners} stale GitHub runner registration(s) removed.`);
  if (failures.length > 0) {
    throw new AiwsError(
      `Runner stack was not fully stopped (${failures.length} failure${failures.length === 1 ? '' : 's'}).`,
      1,
      failures.join(' | '),
    );
  }
  const { manifestHash: _runningManifest, ...stopped } = loaded.installation;
  await saveInstallationState(stopped);
  context.logger.success('Runner stack is down; workspace and provider auth volumes were preserved.');
}
