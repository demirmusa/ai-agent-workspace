import { AiwsError } from '../../shared/core/logger.js';
import type { AppContext } from './context.js';
import { loadTrackedRepository } from './repository-context.js';
import { configurationRoot, runConfigSet } from './configure.js';
import { loadRepoConfig } from '../../shared/config/store.js';

export async function runReviewProfile(context: AppContext, profile: string): Promise<void> {
  const config = await loadRepoConfig(await configurationRoot(context.cwd));
  await runConfigSet(context, 'review', JSON.stringify({ ...config.review, profile: profile === 'null' ? null : profile, profiles: [] }));
}

export async function runReview(context: AppContext, number: string): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(number)) throw new AiwsError('PR number must be a positive integer.');
  const { config } = await loadTrackedRepository(context);
  if (!config.review.enabled) throw new AiwsError('PR review is disabled.', 2, 'Run aiws review enable, sync and merge the settings first.');
  await context.runner.run('gh', ['workflow', 'run', 'aiws-pr-review.yml', '--repo', config.repository.slug,
    '--ref', config.repository.defaultBranch, '-f', `pr_number=${number}`]);
  context.logger.success(`Requested review of PR #${number} with ${config.review.profiles.length ? config.review.profiles.join(', ') : config.review.profile ?? config.agents.defaultProfile}.`);
}
