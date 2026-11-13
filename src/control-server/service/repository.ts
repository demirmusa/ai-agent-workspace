import { resolve } from 'node:path';
import type { ControlGitHub } from '../github.js';
import { openDirectory, openProjectPath } from '../project-files.js';
import { changeDiff, conflictedFiles, deleteWorktreeOrBranch, gitCommit, gitFetch, gitOverview, gitPull, gitPush, managedFolders, mergePlainBranch, taskChanges, taskForBranch, validateBranchName, workingChanges, worktreeEntries, type GitChanges, type GitMergeResult, type GitOverview } from '../repository-git.js';
import { ControlError, type Task } from '../types.js';
import { jsonObject } from '../validation.js';
import { projectBranches } from '../workspace.js';
import { removeManagedFolder, validateMainBranch, WorktreeMergeConflict } from '../worktrees.js';
import { now } from './common.js';
import type { ControlContext } from './context.js';
import type { TaskDelivery } from './delivery.js';

type ChangeScope = { projectId: string; worktree?: string | undefined } | { taskId: string };

/** The project Git panel: overview, changes, fetch/pull/push, branch merges and managed task folders. */
export class RepositoryOperations {
  private gitBusy = new Set<string>();
  private mergedPullChanges = new Map<string, Promise<GitChanges>>();
  constructor(private readonly ctx: ControlContext, private readonly github: ControlGitHub, private readonly delivery: TaskDelivery) {}

  branches(projectId: string): ReturnType<typeof projectBranches> { return projectBranches(this.ctx.project(projectId)); }
  overview(projectId: string): Promise<GitOverview> { return gitOverview(this.ctx.project(projectId), this.ctx.state.tasks, this.ctx.store.directory); }
  changes(projectId: string, worktree?: string): Promise<GitChanges> { return workingChanges(this.ctx.project(projectId), worktree); }
  /** A task's changes against main; `changes` is null once its branch is gone. */
  async taskChanges(taskId: string): Promise<{ changes: GitChanges | null }> { return { changes: await this.readTaskChanges(this.ctx.task(taskId)) }; }
  /** One file of a changes list: its patch, or (with `open`) opened in the default program / revealed in the file manager. */
  async changeFile(scope: ChangeScope, file: unknown, open?: unknown): Promise<{ path: string; diff: string; truncated: boolean } | { ok: true }> {
    const task = 'taskId' in scope ? this.ctx.task(scope.taskId) : undefined;
    const project = this.ctx.project(task ? task.projectId : (scope as { projectId: string }).projectId);
    const changes = task ? await this.readTaskChanges(task) : await workingChanges(project, (scope as { worktree?: string }).worktree);
    if (!changes) throw new ControlError('The task has no branch.', 404);
    const shown = await changeDiff(project, changes, file);
    if (open === undefined) return shown;
    if (!changes.root) throw new ControlError('The branch is not checked out, so its files cannot be opened.', 409);
    return openProjectPath(changes.root, { path: shown.path, action: open });
  }
  async command(projectId: string, command: string, input: unknown): Promise<{ message: string }> {
    const project = this.ctx.project(projectId); const value = jsonObject(input);
    if (!['fetch', 'pull', 'push', 'commit'].includes(command)) throw new ControlError('Unknown Git command.', 404);
    return this.exclusive(projectId, async () => {
      const message = command === 'fetch' ? await gitFetch(project) : command === 'pull' ? await gitPull(project) : command === 'commit' ? await gitCommit(project, value) : await gitPush(project, value);
      this.ctx.event(null, null, `git.${command}`, message, { projectId }); this.ctx.changed();
      return { message };
    });
  }
  /** Opens one managed task folder in the file manager; only folders the Git panel lists can be opened. */
  async openFolder(projectId: string, input: unknown): Promise<{ ok: true }> {
    const project = this.ctx.project(projectId), value = jsonObject(input);
    const folder = (await managedFolders(project, this.ctx.state.tasks, this.ctx.store.directory)).find((item) => item.path === value.path);
    if (!folder) throw new ControlError('Folder not found.', 404);
    return openDirectory(folder.path);
  }
  /** Deletes managed task folders (one `path`, or every idle folder with `all`); branches are never touched and working tasks are skipped. */
  async deleteFolders(projectId: string, input: unknown): Promise<{ removed: string[]; errors: Array<{ path: string; error: string }> }> {
    const project = this.ctx.project(projectId), value = jsonObject(input), all = value.all === true;
    return this.exclusive(projectId, async () => {
      const folders = await managedFolders(project, this.ctx.state.tasks, this.ctx.store.directory);
      const working = (path: string) => this.ctx.state.runs.some((run) => this.ctx.busy(run) && run.workspacePath && resolve(run.workspacePath) === path);
      const targets = all ? folders : folders.filter((folder) => folder.path === value.path);
      if (!all && !targets.length) throw new ControlError('Folder not found.', 404);
      const removed: string[] = [], errors: Array<{ path: string; error: string }> = [];
      for (const folder of targets) {
        if (folder.active || working(folder.path)) { if (!all) errors.push({ path: folder.path, error: 'A task is working in this folder.' }); continue; }
        try {
          removeManagedFolder(project.repositoryPath, folder.path); removed.push(folder.path);
          const owner = this.ctx.state.tasks.find((task) => task.worktree && resolve(task.worktree.path) === folder.path);
          if (owner?.worktree?.mergedSha && !owner.worktree.cleanedAt) { owner.worktree.cleanedAt = now(); delete owner.worktree.cleanupWarning; }
        } catch (error) { errors.push({ path: folder.path, error: (error as Error).message }); }
      }
      if (removed.length) { this.ctx.event(null, null, 'git.folders.deleted', `Deleted ${removed.length} task folder(s).`, { projectId }); this.ctx.changed(); }
      return { removed, errors };
    });
  }
  /** Deletes a worktree, a branch (with its worktree) or both without merging; refused while an agent works there. */
  async deleteWorktreeOrBranch(projectId: string, input: unknown): Promise<{ message: string; warnings: string[] }> {
    const { ctx } = this, project = ctx.project(projectId), value = jsonObject(input);
    const branch = value.branch === undefined ? undefined : validateBranchName(value.branch);
    const worktree = value.worktree === undefined ? undefined : typeof value.worktree === 'string' && value.worktree ? resolve(value.worktree) : (() => { throw new ControlError('worktree must be a path.', 400); })();
    if (!branch && !worktree) throw new ControlError('branch or worktree is required.', 400);
    return this.exclusive(projectId, async () => {
      const entries = await worktreeEntries(project.repositoryPath);
      const path = worktree ?? entries.find((entry) => entry.branch === branch)?.path;
      if (path && ctx.state.runs.some((run) => ctx.busy(run) && resolve(ctx.runWorkspace(run)) === resolve(path))) throw new ControlError('An agent is working in this worktree. Wait for it to exit before deleting.', 409);
      const warnings = await deleteWorktreeOrBranch(project.repositoryPath, validateMainBranch(project.mainBranch ?? 'main'), { branch, worktree });
      const owner = path ? ctx.state.tasks.find((task) => task.worktree && !task.worktree.cleanedAt && resolve(task.worktree.path) === resolve(path)) : undefined;
      if (owner?.worktree) { owner.worktree.cleanedAt = now(); owner.updatedAt = now(); }
      const message = `Deleted ${[path ? `worktree ${path}` : '', branch ? `branch ${branch}` : ''].filter(Boolean).join(' and ')}.`;
      ctx.event(null, null, 'git.deleted', message, { projectId }); ctx.changed();
      return { message, warnings };
    });
  }
  /** "Merge into main and delete": task branches use the task merge with agent conflict recovery; other branches get a resolver task on conflict. */
  async mergeBranch(projectId: string, input: unknown): Promise<GitMergeResult> {
    const { ctx, delivery } = this, project = ctx.project(projectId); const value = jsonObject(input); const branch = validateBranchName(value.branch);
    // `keep` merges only: the branch, its worktree and the task stay as they are, and a conflict is reported instead of handed to an agent.
    const keep = value.keep === true;
    const mainBranch = validateMainBranch(project.mainBranch ?? 'main');
    if (branch === mainBranch) throw new ControlError('The main branch cannot be merged into itself.', 409);
    if (this.gitBusy.has(projectId)) throw new ControlError('Another Git operation is running for this project.', 409);
    const task = taskForBranch(ctx.state.tasks.filter((item) => item.projectId === projectId), branch);
    const tree = task?.worktree && !task.worktree.cleanedAt && task.worktree.branch === branch ? task.worktree : undefined;
    if (task) delivery.recheckGitHubRemote(task);
    if (task && (tree || (delivery.usesPullRequests(task) && task.taskBranch === branch)) && (!keep || delivery.usesPullRequests(task))) {
      if (task.queuedContinuation?.mergeRecovery || ctx.running(task)) throw new ControlError('The task is still working on this branch. Wait for its run to finish.', 409);
      if (delivery.usesPullRequests(task)) {
        if (tree) tree.mergeRequested = true; await delivery.autoMerge(task, true);
        if (!task.pullRequest?.merged) throw new ControlError(task.pullRequest?.mergeStatus ?? 'Pull request merge pending; see task events.', 409);
        return { status: 'merged', branch, sha: tree?.mergedSha ?? task.pullRequest.headSha!, warnings: [], taskId: task.id };
      }
      try { delivery.mergeLocalTask(task); }
      catch (error) {
        if (!(error instanceof WorktreeMergeConflict)) throw error;
        return { status: 'conflict', branch, conflicts: error.files, message: error.message };
      }
      if (task.queuedContinuation?.mergeRecovery) return { status: 'resolving', branch, taskId: task.id, conflicts: await conflictedFiles(tree!.path).catch(() => []) };
      task.updatedAt = now(); ctx.changed();
      return { status: 'merged', branch, sha: tree!.mergedSha!, warnings: tree!.cleanupError ? [tree!.cleanupError] : [], taskId: task.id };
    }
    // The source branch of a resolver task is merged through that task, which also retries a failed resolution.
    if (!keep && task?.worktree?.sourceBranch === branch && !task.worktree.cleanedAt) return this.mergeBranch(projectId, { branch: task.worktree.branch });
    return this.exclusive(projectId, async () => {
      const active = (path: string) => ctx.state.runs.some((run) => ctx.busy(run) && resolve(ctx.runWorkspace(run)) === resolve(path));
      const checkedOut = (await worktreeEntries(project.repositoryPath)).filter((entry) => entry.branch === branch || entry.branch === mainBranch);
      if (active(project.repositoryPath) || checkedOut.some((entry) => active(entry.path))) throw new ControlError('An agent is using this branch or the main workspace. Wait for it to exit before merging.', 409);
      const result = await mergePlainBranch(project.repositoryPath, ctx.store.directory, mainBranch, branch, keep);
      if (result.status === 'merged') {
        ctx.event(null, null, 'git.merge', `Merged ${branch} into ${mainBranch}${keep ? '.' : ' and deleted it.'}${result.warnings.length ? `\n${result.warnings.join('\n')}` : ''}`, { projectId, sha: result.sha }); ctx.changed();
        return result;
      }
      if (result.status !== 'conflict' || keep) return result;
      try { return { status: 'resolving', branch, taskId: delivery.queueBranchIntegration(project, branch, mainBranch, result.conflicts), conflicts: result.conflicts }; }
      catch (error) { return { ...result, message: `${result.message}\n${(error as Error).message}` }; }
    });
  }
  /** One Git operation per project at a time. */
  private async exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (this.gitBusy.has(projectId)) throw new ControlError('Another Git operation is running for this project.', 409);
    this.gitBusy.add(projectId);
    try { return await work(); } finally { this.gitBusy.delete(projectId); }
  }
  private async readTaskChanges(task: Task): Promise<GitChanges | null> {
    const project = this.ctx.project(task.projectId);
    if (task.pullRequest?.merged) {
      const key = `${project.id}:${project.github?.repository ?? project.repositoryPath}:${task.pullRequest.number}`;
      let cached = this.mergedPullChanges.get(key);
      if (!cached) {
        cached = this.github.pullRequestChanges(project, task).catch((error) => { this.mergedPullChanges.delete(key); throw error; });
        if (this.mergedPullChanges.size >= 100) this.mergedPullChanges.delete(this.mergedPullChanges.keys().next().value!);
        this.mergedPullChanges.set(key, cached);
      }
      return cached;
    }
    return await taskChanges(project, task) ?? (task.pullRequest?.number ? this.github.pullRequestChanges(project, task) : null);
  }
}
