import { git, gitAsync, isBranchName, latestBaseRef } from './git.js';
import { ControlError, type Project, type Task } from './types.js';

export function isRepository(path: string): boolean {
  try { return git(path, 'rev-parse', '--is-inside-work-tree') === 'true'; }
  catch (error) {
    if ((error as Error).message.includes('not a git repository')) return false;
    throw new ControlError('Unable to inspect the Git workspace. Check that Git is installed and the repository is accessible.', 409);
  }
}
export function validateBranch(value: string): string {
  if (value.length > 250 || value === 'HEAD' || !isBranchName(value)) throw new ControlError('A valid Git branch name is required.');
  return value;
}
export async function projectBranches(project: Project): Promise<{ defaultBranch: string; branches: string[] }> {
  const defaultBranch = project.defaultBranch ?? 'main';
  // Read off the event loop; a folder that is not a repository has no branches.
  const refs = await gitAsync(project.repositoryPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/']).catch(() => null);
  if (refs === null) return { defaultBranch, branches: [] };
  const branches = refs.split(/\r?\n/).filter(Boolean).map((ref) => ref.replace(/^refs\/(heads|remotes\/origin)\//, '')).filter((ref) => ref !== 'HEAD');
  return { defaultBranch, branches: [...new Set(branches)].sort() };
}
/** Branch in the existing workspace; uncommitted changes travel with the checkout and Git refuses only when they conflict. */
export function prepareTaskBranch(project: Project, task: Task): void {
  const path = project.repositoryPath;
  if (!isRepository(path)) return;
  const branch = task.taskBranch ?? `aiws/${task.id}`;
  validateBranch(branch);
  if (task.pullRequest?.merged) delete task.pullRequest;
  const current = git(path, 'branch', '--show-current');
  if (task.taskBranch && current === branch) return;
  const base = validateBranch(task.baseBranch ?? project.defaultBranch ?? 'main');
  try {
    // A merged task's deleted branch starts again from the base, so finished work can still be continued.
    const exists = git(path, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) === `refs/heads/${branch}`;
    if (task.taskBranch && exists) git(path, 'switch', branch);
    else {
      const ref = latestBaseRef(path, base);
      if (!ref) throw new ControlError(`Git: base branch ${base} was not found locally or on origin.`, 409);
      git(path, 'switch', '-c', branch, ref);
      task.baseBranch = base; task.taskBranch = branch;
    }
  } catch (error) { throw new ControlError(`Cannot prepare task branch ${branch} from ${base}. Verify the source branch exists, is available in this checkout and does not conflict with uncommitted changes. ${(error as Error).message}`, 409); }
}
