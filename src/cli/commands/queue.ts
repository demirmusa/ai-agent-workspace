import type { AppContext } from './context.js';
import { loadRepository, loadTrackedRepository, type LoadedRepository } from './repository-context.js';
import { composeBaseArgs } from '../../runtime/compose.js';
import { runOnTarget } from '../../runtime/target.js';
import { AiwsError } from '../../shared/core/logger.js';

export interface QueueState {
  updatedAt?: number;
  tasks: Record<string, { state: string; kind?: string; blockedBy?: number[]; runId?: number; cycle?: boolean }>;
  reservations: Record<string, { phase: string; issue: number; runId?: number }>;
}

export async function readQueueState(context: AppContext, repository?: LoadedRepository): Promise<QueueState> {
  const loaded = repository ?? await loadRepository(context);
  const result = await runOnTarget(context.runner, loaded.installation, 'docker', [
    ...composeBaseArgs(loaded.installation), 'exec', '-T', 'queue-poller', 'cat', '/var/lib/aiws/scheduler/state.json',
  ], { runtimeDirectory: loaded.targetRuntimeDirectory });
  return JSON.parse(result.stdout) as QueueState;
}

export async function runQueueStatus(context: AppContext, options: { json: boolean }): Promise<void> {
  const state = await readQueueState(context);
  if (options.json) { context.logger.info(JSON.stringify(state, null, 2)); return; }
  context.logger.info(`Queue snapshot: ${state.updatedAt ? new Date(state.updatedAt * 1000).toISOString() : 'not yet polled'}`);
  context.logger.info('ISSUE     STATE          DETAILS');
  for (const [number, task] of Object.entries(state.tasks)) {
    const details = [task.kind, task.blockedBy?.length ? `waiting for ${task.blockedBy.map((n) => `#${n}`).join(', ')}` : '', task.cycle ? 'dependency cycle' : '', task.runId ? `run ${task.runId}` : ''].filter(Boolean).join(' · ');
    context.logger.info(`${`#${number}`.padEnd(10)}${task.state.padEnd(15)}${details}`);
  }
  if (!Object.keys(state.tasks).length) context.logger.info('No queued or active tasks.');
  for (const item of Object.values(state.reservations).filter(({ phase }) => phase === 'uncertain')) {
    context.logger.warn(`#${item.issue}: dispatch outcome uncertain. Inspect GitHub runs before aiws queue retry ${item.issue} --force.`);
  }
}

function issueNumber(number: string): string {
  if (!/^[1-9][0-9]*$/.test(number)) throw new AiwsError('Issue number must be a positive integer.');
  return number;
}

export async function runQueueAdd(context: AppContext, number: string, organize: boolean): Promise<void> {
  issueNumber(number);
  const { config } = await loadTrackedRepository(context);
  const result = await context.runner.run('gh', ['issue', 'view', number, '--repo', config.repository.slug, '--json', 'state,labels']);
  const issue = JSON.parse(result.stdout) as { state: string; labels: { name: string }[] };
  if (issue.state !== 'OPEN' || issue.labels.some(({ name }) => name === config.queue.labels.running)) throw new AiwsError('Only open, non-running issues can be queued.');
  await context.runner.run('gh', ['issue', 'edit', number, '--repo', config.repository.slug,
    '--add-label', organize ? config.queue.labels.organize : config.queue.labels.run,
    '--remove-label', config.queue.labels.failed, '--remove-label', config.queue.labels.done]);
  context.logger.success(`#${number} queued for ${organize ? 'organization' : 'execution'}.`);
}

export async function runQueueRetry(context: AppContext, number: string, force: boolean): Promise<void> {
  issueNumber(number);
  const loaded = await loadRepository(context);
  await runOnTarget(context.runner, loaded.installation, 'docker', [...composeBaseArgs(loaded.installation),
    'exec', '-T', 'queue-poller', 'python3', '/opt/aiws/bin/scheduler.py', 'retry', '--issue', number, ...(force ? ['--force'] : [])],
  { runtimeDirectory: loaded.targetRuntimeDirectory });
  context.logger.success(`Retry requested for #${number}; the scheduler checks active runs before requeuing.`);
}

export async function runQueueBlock(context: AppContext, number: string, blocker: string, remove = false): Promise<void> {
  issueNumber(number); issueNumber(blocker);
  if (number === blocker) throw new AiwsError('An issue cannot block itself.');
  const { config } = await loadTrackedRepository(context);
  const prefix = `repos/${config.repository.slug}/issues`;
  const result = await context.runner.run('gh', ['api', `${prefix}/${blocker}`, '--jq', '.id']);
  const id = result.stdout.trim(); issueNumber(id);
  await context.runner.run('gh', remove
    ? ['api', '--method', 'DELETE', `${prefix}/${number}/dependencies/blocked_by/${id}`]
    : ['api', '--method', 'POST', `${prefix}/${number}/dependencies/blocked_by`, '-F', `issue_id=${id}`]);
  context.logger.success(remove ? `Removed dependency #${number} → #${blocker}.` : `#${number} now waits for #${blocker}.`);
}
