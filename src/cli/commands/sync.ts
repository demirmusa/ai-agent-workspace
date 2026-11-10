import { findAssetsRoot } from '../../shared/core/assets.js';
import { AiwsError } from '../../shared/core/logger.js';
import { saveInstallationState } from '../../shared/config/store.js';
import { GitHubClient } from '../../shared/github/client.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { renderRepository } from '../../templates/repository.js';
import { writeRenderedRepository } from '../../templates/writer.js';
import type { AppContext } from './context.js';
import { printFilePlan } from './file-plan.js';
import { parsePullRequestNumber, requireGitBranchName, setupBranchName } from './input.js';
import { loadRepository } from './repository-context.js';

export interface SyncOptions {
  pr: boolean;
  branch?: string;
  force: boolean;
  dryRun: boolean;
}

export async function runSync(context: AppContext, options: SyncOptions): Promise<void> {
  const loaded = await loadRepository(context);
  const assets = await findAssetsRoot();
  const rendered = await renderRepository(loaded.config, assets, PACKAGE_VERSION);
  const branch = options.branch
    ? requireGitBranchName(options.branch)
    : setupBranchName('sync', PACKAGE_VERSION);

  if (options.dryRun || !options.pr) {
    const plan = await writeRenderedRepository(loaded.info.root, rendered, {
      force: options.force,
      dryRun: options.dryRun,
    });
    printFilePlan(context, plan);
    if (options.dryRun) {
      context.logger.info('Dry run complete; no files or GitHub resources were changed.');
      return;
    }
    context.logger.success('Generated files were updated in the current working tree.');
    return;
  }

  await loaded.git.fetchDefault(loaded.info.root, loaded.config.repository.defaultBranch);
  let changed = false;
  let headSha: string | undefined;
  try {
    await loaded.git.withTemporaryWorktree(
      loaded.info.root,
      `origin/${loaded.config.repository.defaultBranch}`,
      async (worktree) => {
        const plan = await writeRenderedRepository(worktree, rendered, {
          force: options.force,
          updateConfig: true,
        });
        printFilePlan(context, plan);
        changed = plan.create.length + plan.update.length + plan.remove.length > 0;
        if (!changed) return;
        headSha = await loaded.git.createAndPushBranch(
          worktree,
          branch,
          `Sync ai-agent-workspace v${PACKAGE_VERSION}`,
        );
      },
    );
  } catch (error) {
    if (error instanceof AiwsError && error.exitCode === 3) changed = false;
    else throw error;
  }
  if (!changed) {
    context.logger.success('Generated files are already up to date.');
    return;
  }

  const github = new GitHubClient(context.runner);
  const url = await github.createPullRequest({
    slug: loaded.config.repository.slug,
    base: loaded.config.repository.defaultBranch,
    head: branch,
    title: `Sync ai-agent-workspace v${PACKAGE_VERSION}`,
    body: [
      `Updates AIWS-generated workflows to v${PACKAGE_VERSION}.`,
      '',
      'After merging, run `aiws up` so the trusted runner runtime matches the workflow version.',
      '',
      '<!-- generated-by: ai-agent-workspace -->',
    ].join('\n'),
  });
  const number = parsePullRequestNumber(url);
  await saveInstallationState({
    ...loaded.installation,
    initPr:
      number
        ? {
            number,
            url,
            headBranch: branch,
            baseBranch: loaded.config.repository.defaultBranch,
            ...(headSha ? { headSha } : {}),
          }
        : loaded.installation.initPr,
  });
  context.logger.success(`Sync pull request opened: ${url}`);
}
