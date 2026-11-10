import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, gitAsync, isBranchName, latestBaseRef } from './git.js';
import { isRepository } from './workspace.js';
import { ControlError, type Task, type Project } from './types.js';
import { taskTitle } from '../shared/core/task-title.js';

/** First eight characters of an id, without its `task_`/`project_` prefix. */
const shortId = (id: string): string => id.replace(/^[a-z]+_/, '').slice(0, 8);
/** Folder name of a task under its project's short worktree root. */
export const taskFolderName = (taskId: string): string => shortId(taskId);
/**
 * Roots of a project's task folders, current first. Windows build tools (Gradle, CMake, the NDK) fail near 260 characters,
 * so the path stays short; tasks created earlier keep working in the long legacy root.
 */
export const projectWorktreeRoots = (directory: string, projectId: string): [string, string] =>
  [resolve(directory, 'wt', shortId(projectId)), resolve(directory, 'worktrees', projectId)];

export function validateMainBranch(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new ControlError('mainBranch must be a Git branch name.');
  if (!isBranchName(value)) throw new ControlError('mainBranch must be a valid Git branch name.');
  return value;
}
/** Local branches only: worktree creation and merge targets require refs/heads. */
export function repositoryBranches(path: string): { branches: string[]; currentBranch: string | null } {
  const branches = git(path, 'for-each-ref', '--format=%(refname:strip=2)', '--sort=refname', 'refs/heads').split('\n').map(value => value.trim()).filter(Boolean);
  let currentBranch: string | null = null;
  try { currentBranch = git(path, 'symbolic-ref', '--short', 'HEAD'); } catch { /* Detached HEAD. */ }
  return { branches, currentBranch };
}
/** A cleaned worktree, or one whose folder was deleted outside AIWS, is rebuilt before the task works again. */
export function worktreeNeedsRestore(task: Task): task is Task & { worktree: NonNullable<Task['worktree']> } {
  return Boolean(task.worktree && (task.worktree.cleanedAt || !existsSync(task.worktree.path)));
}
/** Removes links (Windows junctions) first, so deleting a folder can never follow them into the main checkout. */
function unlinkLinks(folder: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (lstatSync(path).isSymbolicLink()) { try { unlinkSync(path); } catch { rmdirSync(path); } }
    else if (entry.isDirectory()) unlinkLinks(path);
  }
}
/** A folder left behind by a failed cleanup is not a registered worktree, but still blocks `git worktree add`. */
function removeStaleFolder(repository: string, path: string): void {
  if (!existsSync(path)) return;
  const registered = git(repository, 'worktree', 'list', '--porcelain').split('\n').some(line => line.startsWith('worktree ') && resolve(line.slice(9)) === resolve(path));
  if (registered) return;
  unlinkLinks(path);
  rmSync(path, { recursive: true, force: true });
}
/** Deletes a managed task folder (registered worktree or leftover) without touching branches; throws while Windows still holds it. */
export function removeManagedFolder(repository: string, path: string, allowEmptyLeftover = false): void {
  const target = resolve(path);
  const registered = () => git(repository, 'worktree', 'list', '--porcelain', '-z').split('\0').some(field => field.startsWith('worktree ') && resolve(field.slice(9)) === target);
  if (existsSync(target) && registered()) {
    try { unlinkLinks(target); git(repository, 'worktree', 'remove', '--force', '--', target); } catch { /* Git may unregister it and still fail to delete the folder. */ }
  }
  if (existsSync(target)) { try { unlinkLinks(target); rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Reported below. */ } }
  try { git(repository, 'worktree', 'prune'); } catch { /* Best effort. */ }
  // Windows may keep the emptied folder itself locked (a shell or indexer holding it); `git worktree add` accepts an empty folder.
  if (allowEmptyLeftover && existsSync(target) && readdirSync(target).length === 0) return;
  if (existsSync(target)) throw new ControlError(`The folder ${target} is still in use and could not be removed. Close whatever uses it and try again.`, 409);
}
/** If a failed continuation recreated a cleaned worktree, remove that empty worktree and branch on rollback. */
export function discardRestoredWorktree(task: Task): void {
  const tree = task.worktree; if (!tree) return;
  try { removeManagedFolder(tree.repositoryPath, tree.path); } catch { /* Best effort on rollback. */ }
  try {
    const baseRef = latestBaseRef(tree.repositoryPath, task.baseBranch ?? tree.mainBranch);
    if (baseRef) { git(tree.repositoryPath, 'merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, baseRef); git(tree.repositoryPath, 'branch', '-D', '--', tree.branch); }
  } catch { /* Keep any branch that is not an ancestor of base. */ }
}
/** Drops a cancelled task's worktree and branch, so its next run starts over from the latest base branch. */
export function discardTaskWorktree(task: Task): void {
  const tree = task.worktree; if (!tree) return;
  removeManagedFolder(tree.repositoryPath, tree.path, true);
  try { git(tree.repositoryPath, 'branch', '-D', '--', tree.branch); } catch { /* The branch was never created or is already gone. */ }
  delete task.worktree; delete task.taskBranch; delete task.pullRequest;
}
export function prepareTaskWorktree(project: Project, task: Task, directory: string, mainBranch: string): NonNullable<Task['worktree']> {
  if (task.worktree && !worktreeNeedsRestore(task)) {
    if (resolve(task.worktree.repositoryPath) !== resolve(project.repositoryPath)) throw new ControlError('The task worktree belongs to another repository.', 409);
    if (git(task.worktree.path, 'symbolic-ref', '--short', 'HEAD') !== task.worktree.branch) throw new ControlError('Task worktree branch changed. Restore it before continuing.', 409);
    return task.worktree;
  }
  validateMainBranch(mainBranch);
  git(project.repositoryPath, 'rev-parse', '--verify', `refs/heads/${mainBranch}`);
  const baseBranch = validateMainBranch(task.worktree ? mainBranch : task.baseBranch ?? project.defaultBranch ?? mainBranch);
  const baseRef = latestBaseRef(project.repositoryPath, baseBranch);
  if (!baseRef) throw new ControlError(`Git: base branch ${baseBranch} was not found locally or on origin.`, 409);
  const branch = `aiws/${task.id}`;
  const [parent, legacyParent] = projectWorktreeRoots(directory, project.id); mkdirSync(parent, { recursive: true });
  const path = join(parent, taskFolderName(task.id));
  // A deleted folder leaves its registration behind, which would block the branch and the path.
  git(project.repositoryPath, 'worktree', 'prune');
  if (task.worktree?.cleanedAt) { removeManagedFolder(project.repositoryPath, path, true); removeManagedFolder(project.repositoryPath, join(legacyParent, task.id), true); }
  else removeStaleFolder(project.repositoryPath, path);
  const branchExists = git(project.repositoryPath, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) === `refs/heads/${branch}`;
  let reuse = false;
  if (branchExists) {
    // Work that never reached the base continues on its own branch; an already merged branch starts over from the base.
    try { git(project.repositoryPath, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, baseRef); } catch { reuse = true; }
    if (!reuse) git(project.repositoryPath, 'branch', '-D', '--', branch);
  }
  if (reuse) git(project.repositoryPath, 'worktree', 'add', path, branch);
  else git(project.repositoryPath, 'worktree', 'add', '-b', branch, path, baseRef);
  if (task.pullRequest?.merged) delete task.pullRequest;
  task.baseBranch = baseBranch; task.taskBranch = branch;
  return { path: realpathSync.native(path), branch, mainBranch, repositoryPath: project.repositoryPath, gitDirectory: git(path, 'rev-parse', '--absolute-git-dir'), gitCommonDirectory: resolve(path, git(path, 'rev-parse', '--git-common-dir')) };
}
export class WorktreeMergeConflict extends ControlError {
  constructor(public readonly files: string[], diagnostics: string) { super(diagnostics, 409); }
}

/**
 * Delete pushed copies of a merged branch; return failures so delivery can remain blocked.
 * A copy the host already removed (for example GitHub's delete-on-merge) only leaves a stale local ref, which is dropped.
 */
export async function deleteRemoteBranches(repository: string, branch: string, mainBranch: string): Promise<string[]> {
  const warnings: string[] = [];
  const refs = (await gitAsync(repository, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).split('\n').filter((ref) => ref.endsWith(`/${branch}`));
  for (const ref of refs) {
    const remote = ref.slice('refs/remotes/'.length, -(branch.length + 1));
    if (!remote || remote.includes('/')) continue;
    // A pull request merges on the remote, so the remote main counts too while the local main is behind or diverged.
    const merged = async (target: string) => gitAsync(repository, ['merge-base', '--is-ancestor', ref, target]).then(() => true, () => false);
    if (!await merged(`refs/heads/${mainBranch}`) && !await merged(`refs/remotes/${remote}/${mainBranch}`)) { warnings.push(`Remote branch ${remote}/${branch} has commits that are not in ${mainBranch}; it was kept.`); continue; }
    try {
      await gitAsync(repository, ['push', remote, '--delete', branch]);
    } catch (error) {
      const message = (error as Error).message;
      if (/remote ref does not exist/i.test(message)) await gitAsync(repository, ['update-ref', '-d', ref]);
      else warnings.push(`Remote branch ${remote}/${branch} was kept: ${message.split('\n')[0]}`);
    }
  }
  return warnings;
}

/** Where a task's merge must be visible: `origin/<main>` for pull requests (local main may lag), else the local main. */
/** Throws a readable error when the merged commit is not in the merge target. */
export function assertMergedIntoTarget(task: Task): void {
  const tree = task.worktree!, target = mergeTargetRef(task);
  try { git(tree.repositoryPath, 'merge-base', '--is-ancestor', tree.mergedSha!, target); }
  catch { throw new ControlError(`Merged commit ${tree.mergedSha!.slice(0, 7)} is not in ${target.replace(/^refs\/(heads|remotes)\//, '')}. The branch may have been squash/rebase merged, or ${tree.mainBranch} was reset or moved after the merge. Make sure ${tree.mainBranch} contains the task's commits (or merge them again), then retry.`, 409); }
}
export function mergeTargetRef(task: Task): string {
  const tree = task.worktree!;
  return task.pullRequest?.merged ? `refs/remotes/origin/${tree.mainBranch}` : `refs/heads/${tree.mainBranch}`;
}
/** Only remove managed, clean work that has already reached its merge target, including pushed task branches. */
export function cleanupTaskWorktree(task: Task, directory: string): void {
  const tree = task.worktree;
  if (!tree?.mergedSha || tree.cleanedAt) return;
  const repository = tree.repositoryPath;
  const [root, legacyRoot] = projectWorktreeRoots(directory, task.projectId);
  const expected = resolve(tree.path);
  if ((expected !== join(root, taskFolderName(task.id)) && expected !== join(legacyRoot, task.id)) || resolve(tree.path) === resolve(repository) || tree.branch !== `aiws/${task.id}` || tree.branch === tree.mainBranch) throw new ControlError('Task worktree cleanup refused: unexpected path or branch.', 409);
  assertMergedIntoTarget(task);
  const refs = git(repository, 'for-each-ref', '--format=%(refname)', `refs/heads/${tree.branch}`).split('\n');
  // A squash- or rebase-merged pull request branch is never an ancestor of main; GitHub confirmed that merge.
  if (!task.pullRequest?.merged && refs.includes(`refs/heads/${tree.branch}`)) git(repository, 'merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, `refs/heads/${tree.mainBranch}`);
  
  const entries = git(repository, 'worktree', 'list', '--porcelain', '-z').split('\0\0').map(entry => entry.split('\0'));
  const entry = entries.find(fields => fields.some(field => field.startsWith('worktree ') && resolve(field.slice(9)) === expected));
  if (entry) {
    if (!entry.includes(`branch refs/heads/${tree.branch}`)) throw new ControlError('Task worktree branch changed; cleanup cancelled.', 409);
    // A registered folder that is no longer a working repository has nothing left to protect.
    if (isRepository(tree.path) && git(tree.path, 'status', '--porcelain', '--untracked-files=all')) throw new ControlError('Task worktree has uncommitted changes; cleanup cancelled.', 409);
    unlinkLinks(tree.path);
    // On Windows Git can unregister the worktree yet fail to delete a folder that is in use; that is handled below.
    try { git(repository, 'worktree', 'remove', '--', tree.path); }
    catch (error) {
      try { git(repository, 'worktree', 'prune'); } catch { /* the registration check below decides */ }
      const stillRegistered = git(repository, 'worktree', 'list', '--porcelain', '-z').split('\0').some(field => field.startsWith('worktree ') && resolve(field.slice(9)) === expected);
      if (stillRegistered) throw error;
    }
  }
  // Git can unregister a worktree but leave a folder Windows still holds (ignored files, a lingering handle).
  // The path was verified as the managed task folder and its work is merged, so it is removed with retries.
  // Remove the merged branch even if the folder is locked. The work is in main, so a locked folder only
  // leaves a warning for the user to clean up; it does not block completion or dependent tasks.
  let leftover = false;
  if (existsSync(tree.path)) { try { rmSync(tree.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { leftover = true; } }
  if (existsSync(tree.path)) leftover = true;
  if (refs.includes(`refs/heads/${tree.branch}`)) {
    // Ancestry was verified against the configured target, which need not be HEAD.
    git(repository, 'branch', '-D', '--', tree.branch);
  }
  tree.cleanedAt = new Date().toISOString(); delete tree.cleanupError;
  if (leftover) tree.cleanupWarning = `The branch was merged and deleted, but the folder ${tree.path} is still in use and could not be removed. Delete it manually once nothing uses it.`;
  else delete tree.cleanupWarning;
}
/** Pushed copies of a cleaned task branch are removed over the network, in the background. */
export function deleteMergedRemoteBranches(tree: NonNullable<Task['worktree']>): Promise<string[]> {
  return deleteRemoteBranches(tree.repositoryPath, tree.branch, tree.mainBranch);
}
/** After a pull request merge, remove the local branch when it is fully merged and not checked out anywhere. */
export async function deleteMergedLocalBranch(repository: string, branch: string): Promise<boolean> {
  try {
    if (await gitAsync(repository, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]) !== `refs/heads/${branch}`) return false;
    if ((await gitAsync(repository, ['worktree', 'list', '--porcelain'])).split('\n').includes(`branch refs/heads/${branch}`)) return false;
    await gitAsync(repository, ['branch', '-D', '--', branch]);
    return true;
  } catch { return false; }
}

/**
 * Detect work integrated by an agent before delivery, including shared checkouts switched off
 * the task branch. A deleted shared-checkout branch requires a recorded PR head as evidence.
 */
export function detectExternalMerge(task: Task, project: Project): string | undefined {
  const tree = task.worktree;
  if (!tree) {
    const branch = task.taskBranch, repository = project.repositoryPath;
    if (!branch || git(repository, 'branch', '--show-current') === branch) return undefined;
    // Never infer delivery from main alone when an agent has also deleted the task branch.
    const sha = (() => { try { return git(repository, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`); } catch { return task.pullRequest?.headSha; } })();
    if (!sha) return undefined;
    const main = project.mainBranch ?? project.defaultBranch ?? 'main';
    try { git(repository, 'merge-base', '--is-ancestor', sha, `refs/heads/${main}`); } catch { return undefined; }
    return sha;
  }
  // A leftover folder whose worktree registration was pruned is as gone as a missing one.
  if (existsSync(join(tree.path, '.git')) && isRepository(tree.path)) return undefined;
  const branchSha = (() => { try { return git(tree.repositoryPath, 'rev-parse', '--verify', `refs/heads/${tree.branch}^{commit}`); } catch { return undefined; } })();
  const mainSha = git(tree.repositoryPath, 'rev-parse', '--verify', `refs/heads/${tree.mainBranch}^{commit}`);
  if (!branchSha) return mainSha;
  git(tree.repositoryPath, 'merge-base', '--is-ancestor', branchSha, mainSha);
  return branchSha;
}

/** Commit pending task work once, for either local integration or a pull request. */
export function commitTaskBranch(task: Task, path = task.worktree!.path, branch = task.worktree!.branch): void {
  if (git(path, 'symbolic-ref', '--short', 'HEAD') !== branch) throw new ControlError('Task branch changed. Restore it or verify that its commits reached the main branch before continuing.', 409);
  const unresolved = git(path, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  if (unresolved.length) throw new WorktreeMergeConflict(unresolved, `Resolve merge conflicts in the task branch: ${unresolved.join(', ')}`);
  if (git(path, 'status', '--porcelain')) {
    git(path, 'add', '--all');
    git(path, 'commit', '-m', `Complete task: ${taskTitle(task)}`);
  }
  // A resolver may have staged all files without committing the merge yet.
  let merging = false;
  try { git(path, 'rev-parse', '--verify', 'MERGE_HEAD'); merging = true; } catch { /* No merge in progress. */ }
  if (merging) git(path, 'commit', '--no-edit');
}

/** Preserve failed worktrees for resolution; successful merges are cleaned by the service. */
export function mergeTaskWorktree(task: Task, directory: string): string {
  const worktree = task.worktree!;
  if (git(worktree.path, 'symbolic-ref', '--short', 'HEAD') !== worktree.branch) throw new ControlError('Task worktree branch changed; merge cancelled.', 409);
  const entries = git(worktree.repositoryPath, 'worktree', 'list', '--porcelain', '-z').split('\0\0');
  let target = entries.map(entry => entry.split('\0')).find(fields => fields.includes(`branch refs/heads/${worktree.mainBranch}`))?.find(field => field.startsWith('worktree '))?.slice(9);
  const temporary = !target;
  if (!target) { const parent = join(directory, 'merge-worktrees'); mkdirSync(parent, { recursive: true }); target = join(parent, task.id); git(worktree.repositoryPath, 'worktree', 'add', target, worktree.mainBranch); }
  try {
    if (git(target, 'status', '--porcelain')) throw new ControlError('Main branch workspace has uncommitted changes. Commit or move them before merging.', 409);
    if (git(target, 'symbolic-ref', '--short', 'HEAD') !== worktree.mainBranch) throw new ControlError('Main branch workspace changed.', 409);
    commitTaskBranch(task);
    // Resolve on the task branch. Main only ever receives an already integrated commit.
    try { git(worktree.path, 'merge', '--no-edit', `refs/heads/${worktree.mainBranch}`); }
    catch (error) {
      const files = git(worktree.path, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      if (files.length) throw new WorktreeMergeConflict(files, (error as Error).message);
      throw error;
    }
    const sha = git(worktree.path, 'rev-parse', 'HEAD');
    try { git(target, 'merge', '--ff-only', sha); }
    catch (error) {
      if (git(target, 'rev-parse', 'HEAD') !== git(worktree.path, 'rev-parse', `refs/heads/${worktree.mainBranch}`)) throw error;
      // Main can advance in another process between integration and fast-forward.
      try { git(worktree.path, 'merge-base', '--is-ancestor', `refs/heads/${worktree.mainBranch}`, sha); }
      catch { throw new WorktreeMergeConflict([], `Main advanced during integration. Retry merging main into the task branch. ${(error as Error).message}`); }
      throw error;
    }
    worktree.mergedSha = sha; delete worktree.mergeError;
    return sha;
  } finally { if (temporary) git(worktree.repositoryPath, 'worktree', 'remove', target); }
}
