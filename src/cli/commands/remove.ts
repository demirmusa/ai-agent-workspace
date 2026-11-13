import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { aiwsHomePath, localRepositoryStateDirectory } from '../../shared/core/paths.js';
import { AiwsError } from '../../shared/core/logger.js';
import { GitHubClient } from '../../shared/github/client.js';
import { runOnTarget } from '../../runtime/target.js';
import { RUNTIME_SECRETS_DIRECTORY, runtimeSecretPaths, SECRET_FILE_NAMES } from '../../runtime/secrets.js';
import { runnerPoolSize } from '../../runtime/materialize.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { removeManagedFiles } from '../../templates/writer.js';
import type { AppContext } from './context.js';
import { runDown } from './down.js';
import { parsePullRequestNumber, requireConfirmation, setupBranchName } from './input.js';
import { loadRepository } from './repository-context.js';

export interface RemoveOptions {
  pr: boolean;
  keepLabels: boolean;
  keepSecrets: boolean;
  purgeWork: boolean;
  purgeAuth: boolean;
  force: boolean;
  yes: boolean;
  dryRun: boolean;
}

export async function runRemove(context: AppContext, options: RemoveOptions): Promise<void> {
  const loaded = await loadRepository(context);
  const plan = await removeManagedFiles(loaded.info.root, options.force, true);
  context.logger.info(`Tracked files to remove: ${plan.length}`);
  context.logger.info(`Runner: ${loaded.installation.runnerName}`);
  if (!options.keepLabels) context.logger.info(`Owned labels: ${loaded.installation.createdLabels.length}`);
  if (!options.keepSecrets) context.logger.info(`Owned secrets: ${loaded.installation.managedSecrets.length}`);
  if (options.purgeWork) context.logger.warn('The persistent repository workspace volume will be deleted.');
  if (options.purgeAuth) context.logger.warn('Claude, Codex and OpenCode authentication volumes will be deleted.');

  if (options.dryRun) {
    for (const file of plan) context.logger.info(`remove  ${file}`);
    context.logger.info('Dry run complete; no local, Docker, SSH, or GitHub state was changed.');
    return;
  }
  await requireConfirmation(
    `Remove the AIWS installation for ${loaded.config.repository.slug}?`,
    options.yes,
  );

  // Stop first while both tracked config and local installation state still exist.
  await runDown(context, { dryRun: false });

  const github = new GitHubClient(context.runner);
  if (!options.keepLabels && loaded.installation.createdLabels.length > 0) {
    await github.deleteLabels(loaded.config.repository.slug, loaded.installation.createdLabels);
  }
  if (!options.keepSecrets) {
    for (const secret of loaded.installation.managedSecrets) {
      await github.deleteSecret(loaded.config.repository.slug, secret);
    }
  }

  const cleanupFailures: string[] = [];
  const volumes = [loaded.installation.names.volumes.runner, loaded.installation.names.volumes.cache, loaded.installation.names.volumes.scheduler];
  for (let slot = 2; slot <= Math.max(loaded.installation.runnerSlots, runnerPoolSize(loaded.config)); slot += 1) {
    volumes.push(`${loaded.installation.names.volumes.runner}-${slot}`, `${loaded.installation.names.volumes.cache}-${slot}`);
    if (options.purgeWork) volumes.push(`${loaded.installation.names.volumes.workspace}-${slot}`);
  }
  if (options.purgeWork) volumes.push(loaded.installation.names.volumes.workspace);
  if (options.purgeAuth) {
    volumes.push(
      loaded.installation.names.volumes.claudeAuth,
      loaded.installation.names.volumes.codexAuth,
      loaded.installation.names.volumes.opencodeAuth,
    );
  }
  for (const volume of [...new Set(volumes)]) {
    try {
      await runOnTarget(context.runner, loaded.installation, 'docker', ['volume', 'rm', volume], {
        runtimeDirectory: loaded.targetRuntimeDirectory,
      });
    } catch (error) {
      if (!isMissingDockerResource(error)) {
        const message = `Could not remove Docker volume ${volume}: ${(error as Error).message}`;
        cleanupFailures.push(message);
        context.logger.warn(message);
      }
    }
  }

  for (const image of [loaded.installation.names.images.runner, loaded.installation.names.images.agent]) {
    try {
      await runOnTarget(context.runner, loaded.installation, 'docker', ['image', 'rm', image], {
        runtimeDirectory: loaded.targetRuntimeDirectory,
      });
    } catch (error) {
      if (!isMissingDockerResource(error)) {
        const message = `Could not remove Docker image ${image}: ${(error as Error).message}`;
        cleanupFailures.push(message);
        context.logger.warn(message);
      }
    }
  }

  // On SSH targets the remaining compose files are harmless, but credentials
  // must never be left behind after uninstall.
  try {
    if (loaded.installation.target === 'local') {
      const { directory: _directory, ...files } = runtimeSecretPaths(loaded.targetRuntimeDirectory);
      await Promise.all(Object.values(files).map((file) => rm(file, { force: true })));
    } else {
      await runOnTarget(
        context.runner,
        loaded.installation,
        'rm',
        ['-f', ...Object.values(SECRET_FILE_NAMES).map((name) => `${RUNTIME_SECRETS_DIRECTORY}/${name}`)],
        { runtimeDirectory: loaded.targetRuntimeDirectory },
      );
    }
  } catch (error) {
    const message = `Could not scrub target credential files: ${(error as Error).message}`;
    cleanupFailures.push(message);
    context.logger.warn(message);
  }

  if (cleanupFailures.length > 0) {
    throw new AiwsError(
      `Cleanup was incomplete; local installation state was preserved (${cleanupFailures.length} failure${cleanupFailures.length === 1 ? '' : 's'}).`,
      1,
      cleanupFailures.join(' | '),
    );
  }

  // Tracked config is removed only after runtime/GitHub cleanup succeeds so a
  // failed uninstall remains retryable with the normal CLI commands.
  let removalPullRequest: string | undefined;
  if (!options.pr) {
    const removed = await removeManagedFiles(loaded.info.root, options.force, false);
    for (const file of removed) context.logger.info(`removed ${file}`);
  } else {
    const branch = setupBranchName('remove', PACKAGE_VERSION);
    await loaded.git.fetchDefault(loaded.info.root, loaded.config.repository.defaultBranch);
    await loaded.git.withTemporaryWorktree(
      loaded.info.root,
      `origin/${loaded.config.repository.defaultBranch}`,
      async (worktree) => {
        const removed = await removeManagedFiles(worktree, options.force, false);
        if (removed.length === 0) throw new AiwsError('No managed repository files remain.', 3);
        await loaded.git.createAndPushBranch(
          worktree,
          branch,
          'Remove ai-agent-workspace integration',
        );
      },
    );
    removalPullRequest = await github.createPullRequest({
      slug: loaded.config.repository.slug,
      base: loaded.config.repository.defaultBranch,
      head: branch,
      title: 'Remove ai-agent-workspace integration',
      body: [
        'Removes only the tracked files owned by ai-agent-workspace.',
        '',
        'The Docker runner has been stopped and deregistered.',
        '',
        '<!-- generated-by: ai-agent-workspace -->',
      ].join('\n'),
    });
    context.logger.success(`Removal pull request opened: ${removalPullRequest}`);
  }

  await purgeLocalControlState(loaded.config.repository.slug);
  context.logger.success('AIWS runtime state and permission-restricted local credentials were removed.');
  if (removalPullRequest) {
    const number = parsePullRequestNumber(removalPullRequest);
    if (number) context.logger.info(`Merge PR #${number} to finish removing tracked workflows.`);
  }
}

function isMissingDockerResource(error: unknown): boolean {
  return /(?:no such (?:volume|image)|error response from daemon:.*(?:volume|image).*not found)/i.test(
    (error as Error).message,
  );
}

async function purgeLocalControlState(repositorySlug: string): Promise<void> {
  const home = resolve(aiwsHomePath());
  const repositoriesRoot = resolve(home, 'repositories');
  const target = resolve(localRepositoryStateDirectory(repositorySlug));
  if (!target.startsWith(`${repositoriesRoot}${sep}`) || target === repositoriesRoot || target === home) {
    throw new AiwsError(`Refusing to remove unexpected local state path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
