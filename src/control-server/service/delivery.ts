import { git, gitAsync, gitQuery, gitResult } from '../git.js';
import { isTransientRemoteError } from '../github-api.js';
import { PullRequestConflict, githubRepositoryFromRemote, type ControlGitHub } from '../github.js';
import { deleteBranchAfterMerge } from '../repository-git.js';
import { ControlError, DEFAULT_TASK_MERGE_MODE, type Project, type Task } from '../types.js';
import { cleanupTaskWorktree, deleteMergedLocalBranch, deleteMergedRemoteBranches, assertMergedIntoTarget, detectExternalMerge, mergeTaskWorktree, prepareTaskWorktree, WorktreeMergeConflict } from '../worktrees.js';
import { now, runEnded } from './common.js';
import type { ControlContext } from './context.js';

/** Agents resolve conflicts on the task branch and fast-forward main themselves; AIWS then verifies the merge. */
function mergeRecoveryInstruction(tree: NonNullable<Task['worktree']>, files: string[], diagnostics: string): string {
  return `Finish the requested merge. Work only in the existing task branch ${tree.branch}. Main (${tree.mainBranch}) has been merged into this branch and needs integration. Resolve all conflicts, preserving the intent of both branches. Conflicted files: ${files.join(', ') || '(main advanced during integration)'}. Inspect Git status and the changes, run relevant checks, stage the resolved files and commit the merge. Then merge the latest local ${tree.mainBranch} into this task branch again; if further conflicts occur, resolve, verify and commit them in the same way. Do not abort and stop merely because there is a conflict. Do not edit files in the main workspace and do not switch its branch. Once the task branch is committed and contains the latest ${tree.mainBranch}, perform the final merge yourself: in the main workspace (${tree.repositoryPath}) check that ${tree.mainBranch} is checked out with a clean \`git status --porcelain\`, then run \`git merge --ff-only ${tree.branch}\`. If the fast-forward fails because ${tree.mainBranch} advanced, merge it into the task branch again, resolve, verify, commit and retry. Confirm with \`git merge-base --is-ancestor ${tree.branch} ${tree.mainBranch}\`. Do not delete the task branch or worktree; AIWS cleans them up. Report completion only after ${tree.branch} is merged into ${tree.mainBranch}. AIWS then checks that the merge really happened; if it did not, or ${tree.mainBranch} changed again, the recovery continues in this session.\nGit diagnostics:\n${diagnostics}`;
}
/** GitHub reports the task pull request as conflicting; the agent that did the work reconciles the branch and pushes it. */
function pullRequestConflictInstruction(branch: string, mainBranch: string, url?: string): string {
  return `The pull request${url ? ` (${url})` : ''} for branch ${branch} has merge conflicts with ${mainBranch} on GitHub, so it cannot be merged. Work only in the existing task branch ${branch}. Run \`git fetch origin\`, then \`git merge origin/${mainBranch}\` into the task branch. Resolve all conflicts, preserving the intent of both branches, run relevant checks, stage the resolved files and commit the merge. Do not abort and stop merely because there is a conflict. Then push ${branch} to origin. Do not edit the main workspace and do not delete the branch. Once the push succeeds, finish and report the task as completed again; AIWS then updates the pull request and runs the merge process.`;
}

/** The pull request is merged on GitHub but the local main could not take it; the agent pulls it in the main workspace. */
function localMainPullInstruction(repository: string, main: string, diagnostics: string): string {
  return `The pull request is merged on GitHub, but AIWS could not pull origin/${main} into the local ${main} branch of the main workspace (${repository}), so the task is not finished. In that workspace, bring origin/${main} into local ${main}: run \`git fetch origin\`, then \`git pull --no-rebase origin ${main}\` with ${main} checked out. Keep the user's local commits and uncommitted changes: do not reset, do not discard anything and do not force. Resolve whatever blocks the pull (conflicts, uncommitted changes that overlap, a merge left in progress), preserving the intent of both sides, and put back any changes you set aside. If the workspace was on another branch, return to it afterwards. Do not push. Confirm with \`git merge-base --is-ancestor origin/${main} ${main}\`. Do not delete the task branch or worktree; AIWS cleans them up. AIWS then checks the result; if local ${main} still lacks origin/${main}, the recovery continues in this session.\nGit diagnostics:\n${diagnostics}`;
}
/** Any other delivery failure goes back to the session that did the work, with the error, so the agent can fix it. */
function deliveryFailureInstruction(branch: string | undefined, mainBranch: string, diagnostics: string): string {
  return `AIWS could not finish delivering this task, so it was reopened. Delivery means pushing the task branch${branch ? ` ${branch}` : ''}, merging it into ${mainBranch} and removing the task branch and worktree. It failed with this error:\n${diagnostics}\n\nFind the cause and fix it. If you changed anything, commit it to the task branch. If the cause is an outage of the remote, retry until the failing operation works or it is clear the outage continues. Do not force push, do not discard anyone's changes and do not bypass branch protection or required reviews. Do not delete the task branch or worktree; AIWS cleans them up. When it is fixed, finish and report the task as completed again; AIWS then retries the delivery. If you cannot fix it, say why and report the task as failed.`;
}
/** The agent gets a few sessions to repair a delivery failure; after that the task fails visibly instead of looping. */
const MAX_DELIVERY_RECOVERIES = 3;
/** A remote outage is retried by the delivery loop's backoff (about eight minutes in total) before an agent is involved. */
const MAX_TRANSIENT_RETRIES = 4;
class LocalMainPullFailure extends ControlError {}

const hasGitHubFetchRemote = (remotes: string): boolean => remotes.split(/\r?\n/).some((line) => { const url = /^\S+\s+(\S+)\s+\(fetch\)$/.exec(line)?.[1]; return !!url && !!githubRepositoryFromRemote(url); });

export interface DeliveryDependencies {
  github: ControlGitHub;
  /** Automatic merge applies to the task's completed work. */
  autoMerge(task: Task): boolean;
  /** A session operation (continuation, handoff, transfer) of the task is in progress. */
  continuing(taskId: string): boolean;
  createTask(input: unknown): Task;
}

/**
 * Git delivery of finished tasks: merging the worktree branch or the pull request into
 * main, verifying main, cleaning up worktrees and branches, and handing merge conflicts
 * back to an agent. A task is done only once its delivery is verified.
 */
export class TaskDelivery {
  private merging = new Set<string>();
  private lastMerge = new Map<string, number>();
  private mergeFailures = new Map<string, { message: string; count: number }>();
  private githubRemotes = new Map<string, boolean>();
  private deliveryRecoveries = new Map<string, number>();
  private waitingForLocalMain = new Set<string>();
  constructor(private readonly ctx: ControlContext, private readonly deps: DeliveryDependencies) {}

  assertDeliveryIdle(task: Task): void {
    if (task.status === 'completing' || this.merging.has(`cleanup:${task.id}`)) throw new ControlError('Task merge and cleanup are still in progress.', 409);
  }
  usesPullRequests(task: Task): boolean {
    const project = this.ctx.project(task.projectId);
    if ((project.taskMergeMode ?? this.ctx.state.settings.taskMergeMode ?? DEFAULT_TASK_MERGE_MODE) !== 'pull-request') return false;
    // A project without a github.com remote is local: its tasks merge locally instead of failing on a pull request.
    return !!project.github || this.hasGitHubRemote(project.repositoryPath);
  }
  /**
   * Read by the once-a-second task loop, so Git is asked only when the answer is unknown. A GitHub remote once found stays
   * known; "none" (a failed Git call counts as none) holds until the next task boundary asks again.
   */
  private hasGitHubRemote(repositoryPath: string): boolean {
    const known = this.githubRemotes.get(repositoryPath);
    if (known !== undefined) return known;
    const found = hasGitHubFetchRemote(gitQuery(repositoryPath, ['remote', '-v']));
    this.githubRemotes.set(repositoryPath, found);
    return found;
  }
  /** Called when a task starts or finishes and before a merge: a repository without a GitHub remote may have gained one. */
  recheckGitHubRemote(task: Task): void {
    const path = this.ctx.state.projects.find((project) => project.id === task.projectId)?.repositoryPath;
    if (path && this.githubRemotes.get(path) === false) this.githubRemotes.delete(path);
  }
  /** Answers the question once when the service starts, without blocking it. */
  async warmGitHubRemotes(): Promise<void> {
    const { projects, settings } = this.ctx.state;
    await Promise.all(projects.filter((project) => !project.github && !project.general && (project.taskMergeMode ?? settings.taskMergeMode ?? DEFAULT_TASK_MERGE_MODE) === 'pull-request').map(async (project) => {
      const found = hasGitHubFetchRemote(await gitAsync(project.repositoryPath, ['remote', '-v']).catch(() => ''));
      if (!this.githubRemotes.has(project.repositoryPath)) this.githubRemotes.set(project.repositoryPath, found);
    }));
  }
  hasMergeTarget(task: Task): boolean {
    return !!(task.worktree || task.taskBranch || task.pullRequest?.number || task.github?.issueNumber);
  }
  dependencySatisfied(task: Task): boolean {
    // Done is only reached after the branch is merged into main and its worktree is cleaned up,
    // so a task in Review, with a merge conflict or a failed cleanup keeps its dependents blocked.
    return task.status === 'done' && (!(task.worktree || task.taskBranch || (task.currentRunId && this.hasMergeTarget(task))) || Boolean(task.deliveryVerifiedAt))
      && (!task.worktree || Boolean(task.worktree.mergedSha && task.worktree.cleanedAt && !task.worktree.cleanupError))
      && (!(task.taskBranch || task.pullRequest) || Boolean(task.pullRequest?.merged || task.deliveryVerifiedAt) || !this.usesPullRequests(task));
  }
  taskPullRequestNeedsUpdate(task: Task): boolean {
    if (!this.usesPullRequests(task) || !(task.worktree || task.taskBranch) || task.pullRequest?.merged || (task.status === 'done' && task.deliveryVerifiedAt)) return false;
    if (!task.pullRequest?.number) return true;
    const path = task.worktree?.path ?? this.ctx.project(task.projectId).repositoryPath;
    const branch = task.worktree?.branch ?? task.taskBranch!;
    return gitQuery(path, ['rev-parse', `refs/heads/${branch}`]) !== task.pullRequest.headSha
      || (gitQuery(path, ['symbolic-ref', '--short', 'HEAD']) === branch && !!gitQuery(path, ['status', '--porcelain']));
  }
  /** Cheap checks come first: this runs for every task each second, and the last ones read Git. */
  shouldAutoMerge(task: Task): boolean {
    if (task.archivedAt || !['review', 'completing', 'done'].includes(task.status) || this.deps.continuing(task.id) || !this.hasMergeTarget(task) || task.workflowProgress?.status === 'running') return false;
    const run = task.currentRunId ? this.ctx.run(task.currentRunId) : undefined, requested = !!(task.worktree?.mergeRequested || task.pullRequest?.mergeRequested);
    if (run && !runEnded(run)) return false;
    if (!requested && run?.status !== 'completed') return false;
    return !this.dependencySatisfied(task) && (requested || this.deps.autoMerge(task) || this.taskPullRequestNeedsUpdate(task));
  }
  mergeIfDue(task: Task): void { if (this.shouldAutoMerge(task)) this.ctx.background(this.autoMerge(task)); }
  /** Retries due merges and cleanups; repeated failures back off. */
  tick(): void {
    const current = Date.now();
    for (const task of this.ctx.state.tasks) {
      if (task.worktree?.mergedSha && task.status === 'completing' && current - (this.lastMerge.get(task.id) ?? 0) >= this.retryDelay(task.id)) this.ctx.background(this.cleanupMergedTask(task));
    }
    for (const task of this.ctx.state.tasks) {
      if (!this.merging.has(task.id) && !this.waitsForUser(task) && current - (this.lastMerge.get(task.id) ?? 0) >= this.retryDelay(task.id) && this.shouldAutoMerge(task)) this.ctx.background(this.autoMerge(task));
    }
  }
  /** A pull request in review only changes when its run ends or a merge is requested; both check the branch themselves, so the loop does not read Git for it. */
  private waitsForUser(task: Task): boolean {
    return task.status === 'review' && !!task.pullRequest?.number && !task.worktree?.mergeRequested && !task.pullRequest.mergeRequested && !this.deps.autoMerge(task);
  }
  forget(taskIds: ReadonlySet<string>): void { for (const taskId of taskIds) { this.lastMerge.delete(taskId); this.mergeFailures.delete(taskId); this.deliveryRecoveries.delete(taskId); this.waitingForLocalMain.delete(taskId); } }
  async autoMerge(task: Task, requested = false): Promise<void> {
    if (this.merging.has(task.id) || this.ctx.closing) return; this.merging.add(task.id); this.lastMerge.set(task.id, Date.now());
    const { ctx, deps } = this;
    this.recheckGitHubRemote(task);
    try {
      if (requested || deps.autoMerge(task) || task.worktree?.mergeRequested || task.pullRequest?.mergeRequested) { task.status = 'completing'; ctx.changed(); }
      if (task.worktree && !this.usesPullRequests(task)) {
        if (task.currentRunId && ctx.handles.has(task.currentRunId)) return;
        this.mergeLocalTask(task);
        // cleanupMergedTask publishes the final outcome after all cleanup finishes.
        task.updatedAt = now(); ctx.changed(); return;
      }
      if (task.currentRunId && ctx.handles.has(task.currentRunId)) return;
      if (task.worktree?.mergedSha) { await this.cleanupMergedTask(task); return; }
      if (this.taskPullRequestNeedsUpdate(task)) {
        // A worktree folder the agent already removed cannot be pushed from; detectExternalMerge only reports a branch that reached main.
        const external = (() => { try { return detectExternalMerge(task, ctx.project(task.projectId)); } catch { return undefined; } })();
        if (external) {
          await this.finishMergedTask(task, external, task.worktree?.branch ?? task.taskBranch);
          ctx.event(task.currentRunId, task.id, 'github.merge', `${task.taskBranch} was already merged into the main branch; no pull request is needed.`);
          return;
        }
        try { this.setPullRequest(task, await deps.github.createTaskPullRequest(ctx.project(task.projectId), task)); ctx.changed(); }
        catch (error) {
          if (!(error instanceof ControlError) || !/^GitHub: No commits between /i.test(error.message)) throw error;
          const project = ctx.project(task.projectId), branch = task.worktree?.branch ?? task.taskBranch!;
          const headSha = git(task.worktree?.repositoryPath ?? project.repositoryPath, 'rev-parse', `refs/heads/${branch}`);
          await this.finishMergedTask(task, headSha, branch);
          if (task.status === 'done') ctx.event(task.currentRunId, task.id, 'github.merge', `${branch} was already merged into the main branch; no pull request is needed.`);
          return;
        }
      }
      const mergeRequested = requested || task.worktree?.mergeRequested || task.pullRequest?.mergeRequested;
      if (mergeRequested && task.pullRequest) task.pullRequest.mergeRequested = true;
      if (!mergeRequested && !deps.autoMerge(task)) return;
      const result = await deps.github.mergePullRequest(ctx.project(task.projectId), { ...task, autoMerge: !!mergeRequested || deps.autoMerge(task) });
      if (ctx.closing || !ctx.state.tasks.includes(task)) return;
      this.setPullRequest(task, { number: result.number, url: result.url, merged: result.merged, ...(mergeRequested && !result.merged ? { mergeRequested: true } : {}), mergeStatus: result.message, ...(result.headSha ? { headSha: result.headSha } : {}) });
      task.status = result.merged || mergeRequested || deps.autoMerge(task) ? 'completing' : 'review'; ctx.event(task.currentRunId, task.id, 'github.merge', result.message); ctx.changed();
      this.mergeFailures.delete(task.id);
      if (result.merged) await this.finishMergedTask(task, result.headSha, result.headRef ?? task.taskBranch, result.mergeSha);
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PullRequestConflict && task.currentRunId && ctx.run(task.currentRunId).provider !== 'command' && !ctx.closing && ctx.state.tasks.includes(task)) {
        const project = ctx.project(task.projectId), branch = task.worktree?.branch ?? task.taskBranch;
        if (branch) {
          const mainBranch = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main';
          if (task.worktree) task.worktree.mergeRequested = true;
          if (task.pullRequest) task.pullRequest.mergeRequested = true;
          task.queuedContinuation = { instruction: pullRequestConflictInstruction(branch, mainBranch, task.pullRequest?.url), confirmationRequired: false, mergeRecovery: true };
          task.status = 'ready'; task.updatedAt = now();
          ctx.addMessage(task.id, 'system', 'The pull request has merge conflicts. The agent that did the work is asked to resolve them in the task branch; the pull request is merged afterwards.');
          ctx.event(task.currentRunId, task.id, 'github.merge.recovery', message); ctx.changed(); return;
        }
      }
      const retry = requested || !!task.pullRequest?.merged;
      if (error instanceof LocalMainPullFailure && ctx.state.tasks.includes(task)) {
        const project = ctx.project(task.projectId), repository = task.worktree?.repositoryPath ?? project.repositoryPath, main = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main';
        if (this.recoverWithAgent(task, localMainPullInstruction(repository, main, message), `Local ${main} could not be pulled after the merge. The agent is asked to resolve it; the task finishes once local ${main} contains origin/${main}.`, 'github.merge.recovery', message, true)) return;
      } else if (ctx.state.tasks.includes(task)) {
        if (this.retriesRemoteFailure(task, error)) {
          if (retry) this.requestDeliveryRetry(task);
          task.updatedAt = now();
          if (this.recordMergeFailure(task.id, message) && !ctx.closing) ctx.event(task.currentRunId, task.id, 'github.merge.retry', message);
          ctx.changed(); return;
        }
        if (this.recoverFailure(task, message, 'github.merge.recovery', retry)) return;
      }
      task.status = 'failed'; task.updatedAt = now();
      if (this.recordMergeFailure(task.id, message) && !ctx.closing && ctx.state.tasks.includes(task)) { ctx.event(task.currentRunId, task.id, 'github.merge.error', message); ctx.changed(); }
    }
    finally { this.merging.delete(task.id); }
  }
  /** The task forgets a merged pull request when it continues, so the run that delivered it keeps its own record. */
  private setPullRequest(task: Task, pull: NonNullable<Task['pullRequest']>): void {
    task.pullRequest = pull;
    const run = this.ctx.state.runs.find((entry) => entry.id === task.currentRunId);
    if (run) run.pullRequest = { number: pull.number, ...(pull.url ? { url: pull.url } : {}) };
  }
  mergeLocalTask(task: Task): void {
    const { ctx } = this, tree = task.worktree!;
    if (ctx.state.runs.some((run) => ctx.busy(run) && (run.taskId === task.id || ctx.runWorkspace(run) === tree.repositoryPath))) throw new ControlError('An agent is still using the task or main workspace. Wait for it to exit before merging.', 409);
    task.status = 'completing';
    if (tree.mergedSha) { ctx.background(this.cleanupMergedTask(task)); return; }
    try {
      const external = detectExternalMerge(task, ctx.project(task.projectId));
      const sha = external ?? mergeTaskWorktree(task, ctx.store.directory);
      if (external) tree.mergedSha = external;
      delete tree.mergeRequested; delete tree.mergeError;
      ctx.event(task.currentRunId, task.id, 'worktree.merge', external ? `${tree.branch} was already merged into ${tree.mainBranch} and its worktree removed by the agent.` : `Merged ${tree.branch} into ${tree.mainBranch}.`, { sha });
      // Completion waits for local and remote cleanup.
      ctx.background(this.cleanupMergedTask(task));
    } catch (error) {
      tree.mergeError = (error as Error).message;
      ctx.event(task.currentRunId, task.id, 'worktree.merge.error', (error as Error).message);
      if (error instanceof WorktreeMergeConflict && task.currentRunId && ctx.run(task.currentRunId).provider !== 'command') {
        const instruction = mergeRecoveryInstruction(tree, error.files, error.message);
        tree.mergeRequested = true;
        task.queuedContinuation = { instruction, confirmationRequired: false, mergeRecovery: true };
        task.status = 'ready'; task.updatedAt = now();
        ctx.addMessage(task.id, 'system', 'Merge conflicts are queued for agent resolution in the task branch. The merge will be retried after verification.');
        ctx.event(task.currentRunId, task.id, 'worktree.merge.recovery', instruction);
        ctx.changed(); return;
      }
      if (this.recoverFailure(task, (error as Error).message, 'worktree.merge.recovery', true)) return;
      task.status = 'failed'; ctx.changed(); throw error;
    }
  }
  /** The session that did the work gets the failure as a new instruction; false when no agent can take it or its attempts are used up. */
  private recoverWithAgent(task: Task, instruction: string, notice: string, eventType: string, diagnostics: string, retry: boolean): boolean {
    const { ctx } = this, attempts = this.deliveryRecoveries.get(task.id) ?? 0;
    if (!task.currentRunId || ctx.run(task.currentRunId).provider === 'command' || ctx.closing || !ctx.state.tasks.includes(task) || attempts >= MAX_DELIVERY_RECOVERIES) return false;
    this.deliveryRecoveries.set(task.id, attempts + 1);
    if (retry) this.requestDeliveryRetry(task);
    task.queuedContinuation = { instruction, confirmationRequired: false, mergeRecovery: true };
    task.status = 'ready'; task.updatedAt = now();
    ctx.addMessage(task.id, 'system', notice);
    ctx.event(task.currentRunId, task.id, eventType, diagnostics); ctx.changed();
    return true;
  }
  private recoverFailure(task: Task, diagnostics: string, eventType: string, retry: boolean): boolean {
    const project = this.ctx.project(task.projectId);
    return this.recoverWithAgent(task, deliveryFailureInstruction(task.worktree?.branch ?? task.taskBranch, task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main', diagnostics), `Delivery failed: ${diagnostics.split('\n')[0]} The task was reopened and the agent is asked to fix it; delivery is retried afterwards.`, eventType, diagnostics, retry);
  }
  /** A remote outage is not the agent's to fix at first: the task keeps waiting and the delivery loop tries again with backoff. */
  private retriesRemoteFailure(task: Task, error: unknown): boolean {
    return isTransientRemoteError(error) && (this.mergeFailures.get(task.id)?.count ?? 0) < MAX_TRANSIENT_RETRIES && !this.waitsForUser(task);
  }
  /** A resolver task gets its own worktree from the branch, has main merged in, and lets an agent resolve and verify it. */
  queueBranchIntegration(project: Project, branch: string, mainBranch: string, conflicts: string[]): string {
    const { ctx } = this;
    const provider = ctx.providerSettings(project.id).defaultProvider;
    if (!provider) throw new ControlError('No AI provider is configured to resolve the conflicts.', 409);
    const created = this.deps.createTask({ projectId: project.id, title: `Merge ${branch} into ${mainBranch}`.slice(0, 240), description: `Integrate branch ${branch} into ${mainBranch}. Merging conflicts in: ${conflicts.join(', ')}. Resolve the conflicts preserving the intent of both branches and verify the result.`, autoMerge: true, status: 'backlog' });
    const task = ctx.task(created.id);
    try {
      task.baseBranch = branch;
      const tree = task.worktree = prepareTaskWorktree(project, task, ctx.store.directory, mainBranch);
      tree.sourceBranch = branch;
      let diagnostics = '';
      try { git(tree.path, 'merge', '--no-edit', `refs/heads/${mainBranch}`); }
      catch (error) { diagnostics = (error as Error).message.replace(/^Git: /, ''); }
      tree.mergeRequested = true;
      task.queuedContinuation = { instruction: mergeRecoveryInstruction(tree, conflicts, diagnostics || `Merging ${mainBranch} into ${branch} conflicted.`), confirmationRequired: false, mergeRecovery: true };
      task.status = 'ready'; task.updatedAt = now();
      ctx.addMessage(task.id, 'system', `Merging ${branch} into ${mainBranch} conflicts. An agent resolves them in ${tree.branch}; once verified, the result is merged into ${mainBranch} and ${branch} is deleted.`);
      ctx.event(null, task.id, 'worktree.merge.recovery', `Queued conflict resolution for ${branch}.`, { projectId: project.id });
      ctx.changed(); return task.id;
    } catch (error) {
      if (task.worktree) { try { git(project.repositoryPath, 'worktree', 'remove', '--force', task.worktree.path); git(project.repositoryPath, 'branch', '-D', task.worktree.branch); } catch { /* Best effort. */ } }
      ctx.state.tasks.splice(ctx.state.tasks.indexOf(task), 1); ctx.changed(); throw error;
    }
  }
  private async cleanupMergedTask(task: Task): Promise<void> {
    const { ctx } = this, tree = task.worktree;
    if (!tree?.mergedSha || this.merging.has(`cleanup:${task.id}`) || ctx.state.runs.some((run) => ctx.busy(run) && (run.taskId === task.id || run.workspacePath === tree.path))) return;
    this.merging.add(`cleanup:${task.id}`);
    task.status = 'completing'; this.lastMerge.set(task.id, Date.now()); ctx.changed();
    try {
      cleanupTaskWorktree(task, ctx.store.directory);
      const warnings = await deleteMergedRemoteBranches(tree);
      if (task.pullRequest?.merged) await this.cleanupPullRequestBranch(task, tree.branch);
      if (tree.sourceBranch) warnings.push(...await deleteBranchAfterMerge(tree.repositoryPath, tree.mainBranch, tree.sourceBranch));
      if (warnings.length) throw new ControlError(warnings.join('\n'), 409);
      // Recheck main after network operations, before releasing dependencies or capacity.
      assertMergedIntoTarget(task);
      delete tree.cleanupError; delete tree.mergeRequested; delete tree.mergeError; this.mergeFailures.delete(task.id); this.deliveryRecoveries.delete(task.id);
      task.status = 'done'; task.deliveryVerifiedAt = now(); task.updatedAt = now();
      ctx.event(task.currentRunId, task.id, 'worktree.cleanup', `Verified main and removed merged task worktree and branches ${tree.branch}.`);
      if (tree.cleanupWarning) ctx.event(task.currentRunId, task.id, 'worktree.cleanup.warning', tree.cleanupWarning);
    } catch (error) {
      const message = (error as Error).message, retries = this.retriesRemoteFailure(task, error);
      this.recordMergeFailure(task.id, message);
      if (tree.cleanupError !== message) ctx.event(task.currentRunId, task.id, 'worktree.cleanup.error', message);
      tree.cleanupError = message; task.updatedAt = now();
      // Still 'completing', the delivery loop retries the cleanup itself.
      if (!retries && !this.recoverFailure(task, message, 'worktree.cleanup.recovery', true)) task.status = 'failed';
    } finally { this.merging.delete(`cleanup:${task.id}`); ctx.changed(); }
  }
  /** Both GitHub PR merges and manual branch merges require verified main and completed cleanup. */
  private async finishMergedTask(task: Task, headSha: string, branch?: string, mergeSha?: string): Promise<void> {
    if (await this.verifyPullRequestMain(task, mergeSha ?? headSha) === 'waiting') {
      this.requestDeliveryRetry(task); task.status = 'completing'; task.updatedAt = now();
      if (!this.waitingForLocalMain.has(task.id)) { this.waitingForLocalMain.add(task.id); this.ctx.event(task.currentRunId, task.id, 'github.merge.waiting', 'An agent is working in the main workspace; the local main branch is pulled when it finishes.'); }
      this.ctx.changed(); return;
    }
    this.waitingForLocalMain.delete(task.id);
    if (task.worktree) {
      task.worktree.mergedSha = mergeSha ?? headSha;
      delete task.worktree.mergeRequested; await this.cleanupMergedTask(task);
    } else {
      if (branch) await this.cleanupPullRequestBranch(task, branch);
      this.deliveryRecoveries.delete(task.id);
      task.status = 'done'; task.deliveryVerifiedAt = now(); task.updatedAt = now(); this.ctx.changed();
    }
  }
  /** The delivery pass runs again on the next tick (or after the recovery run), whatever the task's automatic merge setting. */
  private requestDeliveryRetry(task: Task): void {
    if (task.worktree) task.worktree.mergeRequested = true;
    if (task.pullRequest) task.pullRequest.mergeRequested = true;
  }
  /**
   * GitHub holds the merge, so `origin/<main>` must contain it, and a task is finished only once the local main does too.
   * Returns 'waiting' while an agent works in the main workspace; throws LocalMainPullFailure when the pull cannot be done.
   */
  async verifyPullRequestMain(task: Task, mergedSha: string): Promise<'waiting' | undefined> {
    const { ctx } = this, project = ctx.project(task.projectId), repository = task.worktree?.repositoryPath ?? project.repositoryPath;
    const main = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main';
    await gitAsync(repository, ['fetch', 'origin', `refs/heads/${main}:refs/remotes/origin/${main}`], 120_000);
    try { git(repository, 'merge-base', '--is-ancestor', mergedSha, `refs/remotes/origin/${main}`); }
    catch { throw new ControlError(`Commit ${mergedSha.slice(0, 7)} is not in origin/${main} yet. If it was merged into ${main} locally, push ${main} to origin; if it was squash or rebase merged, retry once GitHub reports the merge commit.`, 409); }
    try { return await this.pullLocalMain(task, repository, main); }
    catch (error) { throw new LocalMainPullFailure((error as Error).message, 409); }
  }
  /** Local commits do not block the pull: they are merged with origin. Git refuses a merge that would overwrite uncommitted changes. */
  private async pullLocalMain(task: Task, repository: string, main: string): Promise<'waiting' | undefined> {
    const { ctx } = this, remote = `refs/remotes/origin/${main}`;
    const busy = ctx.state.runs.some((run) => ctx.busy(run) && ctx.runWorkspace(run) === repository);
    let head = gitQuery(repository, ['symbolic-ref', '--short', 'HEAD']);
    if (!task.worktree && head === task.taskBranch) {
      if (busy) return 'waiting';
      git(repository, 'switch', main); head = main;
    }
    if (!(await gitResult(repository, ['merge-base', '--is-ancestor', remote, `refs/heads/${main}`])).code) return undefined;
    // Off main only a fast-forward can move the branch; a diverged main needs a checkout, which is the agent's to do.
    if (head !== main) { await gitAsync(repository, ['fetch', '.', `${remote}:refs/heads/${main}`]); return undefined; }
    if (busy) return 'waiting';
    try { await gitAsync(repository, ['merge', '--no-edit', remote]); }
    catch (error) { await gitResult(repository, ['merge', '--abort']).catch(() => undefined); throw error; }
    return undefined;
  }
  /** Branch deletion failures are delivery failures, so dependents remain blocked. */
  private async cleanupPullRequestBranch(task: Task, branch: string): Promise<void> {
    const project = this.ctx.project(task.projectId);
    if (await this.deps.github.deleteBranch(project, branch)) this.ctx.event(task.currentRunId, task.id, 'github.branch.deleted', `Deleted merged branch ${branch} on GitHub.`);
    await deleteMergedLocalBranch(project.repositoryPath, branch);
    if (git(project.repositoryPath, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`).split('\n').includes(`refs/heads/${branch}`)) throw new ControlError(`Merged local branch ${branch} could not be removed.`, 409);
    this.ctx.changed();
  }
  /** Repeated merge or cleanup failures back off from 30 seconds to 10 minutes. */
  private retryDelay(taskId: string): number { return Math.min(600_000, 30_000 * 2 ** Math.min(5, (this.mergeFailures.get(taskId)?.count ?? 1) - 1)); }
  /** Returns false for a repeat of the last failure, which is not journaled again. */
  private recordMergeFailure(taskId: string, message: string): boolean {
    const previous = this.mergeFailures.get(taskId);
    this.mergeFailures.set(taskId, { message, count: (previous?.count ?? 0) + 1 });
    return previous?.message !== message;
  }
}
