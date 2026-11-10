import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { taskTitle } from '../shared/core/task-title.js';
import { mapLimit } from '../shared/core/concurrency.js';
import { ControlError, type Project, type Task, type TaskStatus } from './types.js';
import { validateMainBranch, deleteRemoteBranches, projectWorktreeRoots, taskFolderName } from './worktrees.js';
import { gitAsync as git, gitResult as run } from './git.js';

/** Git for the footer panel. Every command is asynchronous; network commands never prompt for credentials. */
const NETWORK_TIMEOUT = 180_000;
/** Git processes one overview may run at once; a repository with hundreds of branches or worktrees must not start hundreds. */
const GIT_FAN_OUT = 8;

export interface GitTaskLink { id: string; title: string; status: TaskStatus; merging?: boolean; mergeError?: string }
export interface GitBranch {
  name: string; sha: string; subject: string; date: string; current: boolean; main: boolean;
  upstream: string | null; ahead: number; behind: number; gone: boolean;
  /** Commits the branch has that main lacks, and the reverse. */
  mainAhead: number; mainBehind: number;
  worktreePath: string | null; task: GitTaskLink | null;
}
export interface GitWorktree { path: string; branch: string | null; head: string; main: boolean; locked: boolean; prunable: boolean; changes: number; additions: number; deletions: number; conflicts: string[]; task: GitTaskLink | null }
/** A folder under the managed `worktrees/<project>` directory; `active` ones belong to a task that is working. */
export interface GitFolder { name: string; path: string; registered: boolean; branch: string | null; changes: number; active: boolean; task: GitTaskLink | null }
/** A recent commit of the current branch. */
export interface GitCommit { sha: string; subject: string; author: string; date: string }
export interface GitOverview {
  repositoryPath: string; mainBranch: string; currentBranch: string | null; upstream: string | null; ahead: number; behind: number;
  changes: number; additions: number; deletions: number; operation: 'merge' | 'rebase' | 'cherry-pick' | null; conflicts: string[]; remotes: string[];
  branches: GitBranch[]; worktrees: GitWorktree[]; folders: GitFolder[];
  /** The newest commits of HEAD, newest first. */
  commits: GitCommit[];
}
export type GitMergeResult = { status: 'merged'; branch: string; sha: string; warnings: string[]; taskId?: string }
  | { status: 'resolving'; branch: string; taskId: string; conflicts: string[] }
  | { status: 'conflict'; branch: string; conflicts: string[]; message: string };

const branchPattern = /^[^\s~^:?*[\\]+$/;
export function validateBranchName(value: unknown, name = 'branch'): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || value.includes('@{') || value.includes('..') || !branchPattern.test(value)) throw new ControlError(`${name} must be a Git branch name.`);
  return value;
}

/** A task owns a branch through its live worktree, its recorded task branch, or the managed `aiws/<task>` name. */
export function taskForBranch(tasks: Task[], branch: string): Task | undefined {
  return tasks.find(task => task.worktree && !task.worktree.cleanedAt && (task.worktree.branch === branch || task.worktree.sourceBranch === branch))
    ?? tasks.find(task => task.taskBranch === branch || `aiws/${task.id}` === branch);
}
function link(task: Task | undefined): GitTaskLink | null {
  if (!task) return null;
  const merging = !task.worktree?.mergedSha && !task.worktree?.cleanedAt && task.status !== 'done' && (task.queuedContinuation?.mergeRecovery || task.worktree?.mergeRequested);
  return { id: task.id, title: taskTitle(task), status: task.status, ...(merging ? { merging: true } : {}), ...(task.worktree?.mergeError && !task.worktree.mergedSha ? { mergeError: task.worktree.mergeError } : {}) };
}
function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  return { ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), gone: track.includes('gone') };
}
export async function worktreeEntries(repository: string): Promise<Array<{ path: string; head: string; branch: string | null; locked: boolean; prunable: boolean; bare: boolean }>> {
  return (await git(repository, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean).map(entry => {
    const fields = entry.split('\0'); const value = (key: string) => fields.find(field => field === key || field.startsWith(`${key} `))?.slice(key.length + 1);
    const branch = value('branch');
    return { path: resolve(value('worktree') ?? ''), head: value('HEAD') ?? '', branch: branch?.startsWith('refs/heads/') ? branch.slice(11) : null, locked: value('locked') !== undefined, prunable: value('prunable') !== undefined, bare: fields.includes('bare') };
  });
}
async function changeCount(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  try { return (await git(path, ['status', '--porcelain', '--untracked-files=normal'])).split('\n').filter(Boolean).length; } catch { return 0; }
}
/** Lines added and removed in tracked files relative to HEAD; binary files count as zero. */
async function changeLines(path: string): Promise<{ additions: number; deletions: number }> {
  const total = { additions: 0, deletions: 0 };
  if (!existsSync(path)) return total;
  try {
    for (const line of (await git(path, ['diff', 'HEAD', '--numstat'])).split('\n')) {
      const [added = '', removed = ''] = line.split('\t');
      total.additions += Number(added) || 0; total.deletions += Number(removed) || 0;
    }
  } catch { /* No HEAD yet. */ }
  return total;
}
async function operation(path: string): Promise<GitOverview['operation']> {
  const gitDirectory = await git(path, ['rev-parse', '--absolute-git-dir']);
  if (existsSync(join(gitDirectory, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDirectory, 'rebase-merge')) || existsSync(join(gitDirectory, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDirectory, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}
export const conflictedFiles = async (path: string): Promise<string[]> => (await git(path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);

const RECENT_COMMITS = 5;
/** The newest commits of HEAD; a repository without commits has none. */
async function recentCommits(path: string): Promise<GitCommit[]> {
  const listed = await run(path, ['log', `-${RECENT_COMMITS}`, '--format=%h%x00%s%x00%an%x00%cI']);
  if (listed.code) return [];
  return listed.stdout.split('\n').filter(Boolean).map(line => { const [sha = '', subject = '', author = '', date = ''] = line.split('\0'); return { sha, subject, author, date }; });
}

const ACTIVE_STATUSES = new Set<TaskStatus>(['running', 'waiting', 'paused', 'completing']);
/** Every folder AIWS created for this project's tasks, registered with Git or left behind. */
export async function managedFolders(project: Project, tasks: Task[], directory: string): Promise<GitFolder[]> {
  const folders = projectWorktreeRoots(directory, project.id).filter(root => existsSync(root)).flatMap(root => readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => ({ name: item.name, path: join(root, item.name) })));
  if (!folders.length) return [];
  const entries = await worktreeEntries(project.repositoryPath);
  const projectTasks = tasks.filter(task => task.projectId === project.id);
  return mapLimit(folders, GIT_FAN_OUT, async ({ name, path }): Promise<GitFolder> => {
    const entry = entries.find(candidate => candidate.path === path);
    const owner = projectTasks.find(task => task.id === name || taskFolderName(task.id) === name || (task.worktree && resolve(task.worktree.path) === path));
    return { name, path, registered: Boolean(entry), branch: entry?.branch ?? null, changes: await changeCount(path), active: Boolean(owner && ACTIVE_STATUSES.has(owner.status)), task: link(owner) };
  });
}

export async function gitOverview(project: Project, tasks: Task[], directory: string): Promise<GitOverview> {
  const repository = project.repositoryPath; const mainBranch = project.mainBranch ?? project.defaultBranch ?? 'main';
  const projectTasks = tasks.filter(task => task.projectId === project.id);
  await git(repository, ['rev-parse', '--git-dir']);
  let currentBranch: string | null = null;
  try { currentBranch = await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* Detached HEAD. */ }
  const hasMain = (await run(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${mainBranch}`])).code === 0;
  const worktrees = (await worktreeEntries(repository)).filter(entry => !entry.bare);
  const rootPath = resolve(await git(repository, ['rev-parse', '--show-toplevel']));
  // Git 2.41+ counts every branch against main in this one command; older Git falls back to one bounded rev-list per branch.
  const fields = '%(refname:strip=2)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:iso-strict)%00%(contents:subject)';
  const listRefs = (format: string) => run(repository, ['for-each-ref', '--count=300', '--sort=-committerdate', `--format=${format}`, 'refs/heads']);
  let listed = hasMain ? await listRefs(`${fields}%00%(ahead-behind:refs/heads/${mainBranch})`) : undefined;
  const counted = listed?.code === 0;
  if (!counted) listed = await listRefs(fields);
  if (listed!.code) throw new ControlError(`Git: ${(listed!.stderr || listed!.stdout).trim()}`, 409);
  const refs = listed!.stdout.split('\n').filter(Boolean);
  const branches = await mapLimit(refs, GIT_FAN_OUT, async (line): Promise<GitBranch> => {
    const [name = '', sha = '', upstream = '', track = '', date = '', subject = '', aheadBehind = ''] = line.split('\0');
    let mainAhead = 0, mainBehind = 0;
    if (counted && name !== mainBranch) [mainAhead = 0, mainBehind = 0] = aheadBehind.trim().split(/\s+/).map((value) => Number(value) || 0);
    else if (hasMain && name !== mainBranch) {
      const counts = await run(repository, ['rev-list', '--left-right', '--count', `refs/heads/${mainBranch}...refs/heads/${name}`]);
      if (!counts.code) [mainBehind = 0, mainAhead = 0] = counts.stdout.trim().split(/\s+/).map(Number);
    }
    return { name, sha, subject, date, current: name === currentBranch, main: name === mainBranch, upstream: upstream || null, ...parseTrack(track), mainAhead, mainBehind, worktreePath: worktrees.find(entry => entry.branch === name)?.path ?? null, task: link(taskForBranch(projectTasks, name)) };
  });
  branches.sort((a, b) => Number(b.main) - Number(a.main) || Number(b.current) - Number(a.current) || b.date.localeCompare(a.date));
  const current = branches.find(branch => branch.current);
  const trees = await mapLimit(worktrees, GIT_FAN_OUT, async (entry): Promise<GitWorktree> => ({
    path: entry.path, branch: entry.branch, head: entry.head.slice(0, 9), main: entry.path === rootPath, locked: entry.locked, prunable: entry.prunable,
    changes: entry.prunable ? 0 : await changeCount(entry.path), ...(entry.prunable ? { additions: 0, deletions: 0 } : await changeLines(entry.path)), conflicts: entry.prunable || !existsSync(entry.path) ? [] : await conflictedFiles(entry.path).catch(() => []),
    task: link(projectTasks.find(task => task.worktree && !task.worktree.cleanedAt && resolve(task.worktree.path) === entry.path) ?? (entry.branch ? taskForBranch(projectTasks, entry.branch) : undefined)),
  }));
  const state = await operation(repository);
  const rootTree = trees.find(tree => tree.path === rootPath);
  const lines = rootTree ?? { ...(await changeLines(repository)) };
  return {
    repositoryPath: repository, mainBranch, currentBranch, upstream: current?.upstream ?? null, ahead: current?.ahead ?? 0, behind: current?.behind ?? 0,
    changes: rootTree?.changes ?? await changeCount(repository), additions: lines.additions, deletions: lines.deletions, operation: state, conflicts: state ? await conflictedFiles(repository) : [],
    remotes: (await git(repository, ['remote'])).split('\n').filter(Boolean), branches, worktrees: trees, folders: await managedFolders(project, tasks, directory),
    commits: await recentCommits(repository),
  };
}

export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
export interface GitChange { path: string; oldPath?: string; status: GitChangeStatus; additions: number; deletions: number; binary?: boolean }
export interface GitChanges {
  patches?: Record<string, string>;
  /** Folder the paths are relative to; null when the changes exist only as commits of a branch without a checkout. */
  root: string | null; branch: string | null; base: string | null;
  files: GitChange[]; additions: number; deletions: number; truncated: boolean;
}
const MAX_CHANGES = 2000;
const nameStatus: Record<string, GitChangeStatus> = { M: 'modified', T: 'modified', A: 'added', C: 'added', D: 'deleted', R: 'renamed', U: 'conflicted' };

/**
 * Files that differ from `base`: the working tree of `cwd` (with untracked files and conflicts) or,
 * given `target`, that commit. Without a base (a repository with no commit yet) every file is untracked.
 */
async function diffChanges(cwd: string, base: string | null, target?: string): Promise<Omit<GitChanges, 'root' | 'branch' | 'base'>> {
  const files = new Map<string, GitChange>();
  const range = base ? [base, ...(target ? [target] : [])] : [];
  if (base) {
    const status = (await run(cwd, ['diff', '--name-status', '-z', '-M', ...range, '--'])).stdout.split('\0');
    for (let index = 0; index < status.length - 1;) {
      const code = status[index]!.charAt(0), renamed = code === 'R' || code === 'C';
      const oldPath = renamed ? status[index + 1]! : undefined, path = status[index + (renamed ? 2 : 1)]!;
      index += renamed ? 3 : 2;
      if (path) files.set(path, { path, ...(code === 'R' && oldPath ? { oldPath } : {}), status: nameStatus[code] ?? 'modified', additions: 0, deletions: 0 });
    }
    const numbers = (await run(cwd, ['diff', '--numstat', '-z', '-M', ...range, '--'])).stdout.split('\0');
    for (let index = 0; index < numbers.length - 1;) {
      const [added = '', removed = '', named = ''] = numbers[index]!.split('\t');
      // A rename lists its old and new path as the next two fields.
      const path = named || numbers[index + 2]!; index += named ? 1 : 3;
      const entry = files.get(path); if (!entry) continue;
      if (added === '-') entry.binary = true; else { entry.additions = Number(added) || 0; entry.deletions = Number(removed) || 0; }
    }
  }
  if (!target) {
    for (const path of (await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)) files.set(path, { path, status: 'untracked', additions: 0, deletions: 0 });
    for (const path of await conflictedFiles(cwd).catch(() => [])) files.set(path, { ...(files.get(path) ?? { path, additions: 0, deletions: 0 }), status: 'conflicted' });
  }
  const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files: all.slice(0, MAX_CHANGES), additions: all.reduce((sum, file) => sum + file.additions, 0), deletions: all.reduce((sum, file) => sum + file.deletions, 0), truncated: all.length > MAX_CHANGES };
}
const hasHead = async (cwd: string): Promise<boolean> => (await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;

/** Uncommitted changes of the main repository, or of one of its worktrees. */
export async function workingChanges(project: Project, worktreePath?: unknown): Promise<GitChanges> {
  const repository = project.repositoryPath;
  let path = resolve(await git(repository, ['rev-parse', '--show-toplevel']));
  if (worktreePath !== undefined && worktreePath !== null && worktreePath !== '') {
    const entry = typeof worktreePath === 'string' ? (await worktreeEntries(repository)).find(item => !item.bare && !item.prunable && item.path === resolve(worktreePath)) : undefined;
    if (!entry) throw new ControlError('Select a worktree of this repository.', 404);
    path = entry.path;
  }
  let branch: string | null = null;
  try { branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* Detached HEAD. */ }
  const base = await hasHead(path) ? 'HEAD' : null;
  return { root: path, branch, base, ...(await diffChanges(path, base)) };
}

/** The branch a task works on, while it still exists; tasks without their own branch have none. */
export async function taskBranch(project: Project, task: Task): Promise<string | null> {
  const mainBranch = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main';
  const branch = task.worktree?.branch ?? task.taskBranch;
  if (!branch || branch === mainBranch) return null;
  return (await run(project.repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0 ? branch : null;
}

/** Everything a task changed since its branch left main: its commits plus the uncommitted work of its checkout. */
export async function taskChanges(project: Project, task: Task): Promise<GitChanges | null> {
  const repository = project.repositoryPath, branch = await taskBranch(project, task);
  if (!branch) return null;
  const mainBranch = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch ?? 'main';
  const fork = await run(repository, ['merge-base', `refs/heads/${mainBranch}`, `refs/heads/${branch}`]);
  const base = fork.code ? null : fork.stdout.trim();
  const checkout = (await worktreeEntries(repository)).find(entry => entry.branch === branch && !entry.prunable && existsSync(entry.path));
  if (checkout) return { root: checkout.path, branch, base, ...(await diffChanges(checkout.path, base ?? (await hasHead(checkout.path) ? 'HEAD' : null))) };
  if (!base) return { root: null, branch, base, files: [], additions: 0, deletions: 0, truncated: false };
  return { root: null, branch, base, ...(await diffChanges(repository, base, `refs/heads/${branch}`)) };
}

export async function gitFetch(project: Project): Promise<string> {
  const remotes = (await git(project.repositoryPath, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.length) throw new ControlError('The repository has no remote to fetch from.', 409);
  await git(project.repositoryPath, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT);
  return `Fetched ${remotes.join(', ')}.`;
}
/** Pulls only fast-forward the checked-out branch, so a pull never leaves the main workspace mid-merge. */
export async function gitPull(project: Project): Promise<string> {
  const repository = project.repositoryPath;
  let branch: string;
  try { branch = await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { throw new ControlError('The repository has a detached HEAD. Check out a branch before pulling.', 409); }
  const upstream = await run(repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.code) throw new ControlError(`Branch ${branch} has no upstream branch to pull from.`, 409);
  const output = await git(repository, ['pull', '--ff-only', '--no-rebase'], NETWORK_TIMEOUT);
  return output.split('\n').at(-1) || `Pulled ${upstream.stdout.trim()} into ${branch}.`;
}
/** Pushes a branch (the checked-out one by default); a branch without upstream is published to the first remote. */
export async function gitPush(project: Project, input: { branch?: unknown }): Promise<string> {
  const repository = project.repositoryPath;
  let branch: string;
  if (input.branch !== undefined) branch = validateBranchName(input.branch);
  else try { branch = await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { throw new ControlError('The repository has a detached HEAD. Choose a branch to push.', 409); }
  await git(repository, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  const remotes = (await git(repository, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.length) throw new ControlError('The repository has no remote to push to.', 409);
  const configured = await run(repository, ['config', '--get', `branch.${branch}.remote`]);
  const remote = configured.code ? (remotes.includes('origin') ? 'origin' : remotes[0]!) : configured.stdout.trim();
  await git(repository, ['push', ...(configured.code ? ['--set-upstream'] : []), remote, `refs/heads/${branch}:refs/heads/${branch}`], NETWORK_TIMEOUT);
  return `Pushed ${branch} to ${remote}.`;
}

/** Commits every change of the main workspace with a summary line and an optional description. */
export async function gitCommit(project: Project, input: { summary?: unknown; description?: unknown }): Promise<string> {
  const repository = project.repositoryPath;
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!summary) throw new ControlError('summary is required.', 400);
  if (summary.length > 500 || description.length > 20_000) throw new ControlError('The commit message is too long.', 400);
  if (await operation(repository)) throw new ControlError('Finish the merge, rebase or cherry-pick in progress before committing.', 409);
  if (!await changeCount(repository)) throw new ControlError('There are no changes to commit.', 409);
  await git(repository, ['add', '--all']);
  await git(repository, ['commit', '-m', summary, ...(description ? ['-m', description] : [])]);
  return `Committed ${await git(repository, ['rev-parse', '--short', 'HEAD'])}: ${summary}`;
}

/** Without touching any worktree, report the files that merging `branch` into main would conflict on. */
export async function predictConflicts(repository: string, mainBranch: string, branch: string): Promise<string[] | null> {
  const result = await run(repository, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/heads/${mainBranch}`, `refs/heads/${branch}`]);
  if (result.code === 0) return [];
  if (result.code === 1) return result.stdout.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
  // Old Git without `merge-tree --write-tree`: the merge itself will reveal conflicts.
  return null;
}

/**
 * Merge a branch that no task owns into main and delete it. The merge runs in the
 * worktree that has main checked out, or a temporary one; conflicts abort the merge
 * so main is never left half-merged.
 */
export async function mergePlainBranch(repository: string, directory: string, mainBranch: string, branch: string, keep = false): Promise<GitMergeResult> {
  validateMainBranch(mainBranch); validateBranchName(branch);
  if (branch === mainBranch) throw new ControlError('The main branch cannot be merged into itself.', 409);
  await git(repository, ['rev-parse', '--verify', `refs/heads/${mainBranch}`]); await git(repository, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  const merged = (await run(repository, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${mainBranch}`])).code === 0;
  let sha = await git(repository, ['rev-parse', `refs/heads/${mainBranch}`]);
  if (!merged) {
    const predicted = await predictConflicts(repository, mainBranch, branch);
    if (predicted?.length) return { status: 'conflict', branch, conflicts: predicted, message: `Merging ${branch} into ${mainBranch} conflicts in: ${predicted.join(', ')}` };
    const entries = await worktreeEntries(repository);
    let target = entries.find(entry => entry.branch === mainBranch)?.path;
    const temporary = !target;
    if (!target) { const parent = join(directory, 'merge-worktrees'); mkdirSync(parent, { recursive: true }); target = join(parent, `branch-${Date.now().toString(36)}`); await git(repository, ['worktree', 'add', target, mainBranch]); }
    try {
      if (await git(target, ['status', '--porcelain', '--untracked-files=no'])) throw new ControlError('Main branch workspace has uncommitted changes. Commit or move them before merging.', 409);
      const result = await run(target, ['merge', '--no-edit', `refs/heads/${branch}`]);
      if (result.code) {
        const conflicts = await conflictedFiles(target);
        await run(target, ['merge', '--abort']);
        if (conflicts.length) return { status: 'conflict', branch, conflicts, message: `Merging ${branch} into ${mainBranch} conflicts in: ${conflicts.join(', ')}` };
        throw new ControlError(`Git: ${(result.stderr || result.stdout).trim()}`, 409);
      }
      sha = await git(target, ['rev-parse', 'HEAD']);
    } finally { if (temporary) await run(repository, ['worktree', 'remove', '--force', target]); }
  }
  return { status: 'merged', branch, sha, warnings: keep ? [] : await deleteBranchAfterMerge(repository, mainBranch, branch) };
}

/**
 * Remove a branch that main already contains: its clean worktree, the local branch
 * and pushed copies. Anything with unmerged or uncommitted work is kept and reported.
 */
export async function deleteBranchAfterMerge(repository: string, mainBranch: string, branch: string): Promise<string[]> {
  const warnings: string[] = [];
  if ((await run(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code) return warnings;
  if ((await run(repository, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${mainBranch}`])).code) return [`Branch ${branch} has commits that are not in ${mainBranch}; it was kept.`];
  const root = resolve(await git(repository, ['rev-parse', '--show-toplevel']));
  const entries = await worktreeEntries(repository);
  let tree = entries.find(entry => entry.branch === branch);
  if (tree && tree.path === root) {
    // The main checkout moves to main first; main already contains the branch, so nothing is lost.
    const mainTree = entries.find(entry => entry.branch === mainBranch);
    if (mainTree) return [`Branch ${branch} is checked out in the main repository and ${mainBranch} is checked out in ${mainTree.path}; it was kept.`];
    if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) return [`The main repository has uncommitted changes on ${branch}; it was kept.`];
    const switched = await run(root, ['checkout', mainBranch, '--']);
    if (switched.code) return [`Could not switch the main repository to ${mainBranch}; branch ${branch} was kept: ${(switched.stderr || switched.stdout).trim().split('\n')[0]}`];
    tree = undefined;
  }
  if (tree) {
    if (!tree.prunable && await git(tree.path, ['status', '--porcelain', '--untracked-files=all'])) return [`Worktree ${tree.path} has uncommitted changes; branch ${branch} was kept.`];
    warnings.push(...await removeWorktree(repository, tree.path));
  }
  await git(repository, ['branch', '-D', '--', branch]);
  warnings.push(...await deleteRemoteBranches(repository, branch, mainBranch));
  return warnings;
}

/** Unregisters a linked worktree and deletes its folder, uncommitted changes included; returns a warning when the folder stays in use. */
async function removeWorktree(repository: string, path: string): Promise<string[]> {
  // On Windows Git may unregister the worktree yet fail to delete a folder that is in use.
  const removed = await run(repository, ['worktree', 'remove', '--force', '--force', '--', path]);
  if (removed.code) {
    await run(repository, ['worktree', 'prune']);
    if ((await worktreeEntries(repository)).some(entry => resolve(entry.path) === resolve(path))) throw new ControlError(`Git: ${(removed.stderr || removed.stdout).trim()}`, 409);
  }
  if (existsSync(path)) { try { rmdirSync(path); } catch { return [`The worktree was removed, but the folder ${path} is still in use. Delete it manually once nothing uses it.`]; } }
  return [];
}

/**
 * Deletes without merging, as the user asked from the Git panel: a linked worktree (`worktree`),
 * a local branch with the worktree it is checked out in (`branch`), or both. Unmerged commits and
 * uncommitted changes are discarded; pushed copies stay. The main checkout and main branch are refused.
 */
export async function deleteWorktreeOrBranch(repository: string, mainBranch: string, target: { branch?: string | undefined; worktree?: string | undefined }): Promise<string[]> {
  const root = resolve(await git(repository, ['rev-parse', '--show-toplevel']));
  const entries = await worktreeEntries(repository);
  const tree = target.worktree ? entries.find(entry => resolve(entry.path) === resolve(target.worktree!)) : target.branch ? entries.find(entry => entry.branch === target.branch) : undefined;
  if (target.worktree && !tree) throw new ControlError('Worktree not found.', 404);
  const branch = target.branch ?? null;
  if (branch === mainBranch) throw new ControlError('The main branch cannot be deleted.', 409);
  if (tree && resolve(tree.path) === root) throw new ControlError('The main repository checkout cannot be deleted.', 409);
  if (branch && (await run(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code) throw new ControlError('Branch not found.', 404);
  const warnings = tree ? await removeWorktree(repository, tree.path) : [];
  if (branch) await git(repository, ['branch', '-D', '--', branch]);
  return warnings;
}

const MAX_DIFF = 400_000;
/** The patch of one listed file, against the same base as the list; the file must be one of `changes.files`. */
export async function changeDiff(project: Project, changes: GitChanges, file: unknown): Promise<{ path: string; diff: string; truncated: boolean }> {
  const entry = typeof file === 'string' ? changes.files.find(item => item.path === file) : undefined;
  if (!entry) throw new ControlError('Select a changed file.', 404);
  if (changes.patches) { const diff = changes.patches[entry.path] ?? ''; return { path: entry.path, diff: diff.slice(0, MAX_DIFF), truncated: diff.length > MAX_DIFF }; }
  const cwd = changes.root ?? project.repositoryPath, paths = [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])];
  let output: string;
  if (entry.binary) output = '';
  else if (entry.status === 'untracked') output = (await run(cwd, ['diff', '--no-index', '--no-color', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', entry.path])).stdout;
  else if (!changes.base) output = '';
  else output = (await run(cwd, ['diff', '--no-color', '-M', changes.base, ...(changes.root || !changes.branch ? [] : [`refs/heads/${changes.branch}`]), '--', ...paths])).stdout;
  return { path: entry.path, diff: output.slice(0, MAX_DIFF), truncated: output.length > MAX_DIFF };
}
