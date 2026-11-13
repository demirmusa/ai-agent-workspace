import { taskTitle } from '../shared/core/task-title.js';
import { gitAsync } from './git.js';
import { GitHubUnavailable, githubRepositoryFromRemote, repositoryApi, type GitHubApi } from './github-api.js';
import { taskMarker } from './github-issues.js';
import type { GitChange, GitChanges } from './repository-git.js';
import { commitTaskBranch } from './worktrees.js';
import { ControlError, type ControlProject, type ControlTask } from './types.js';

// Task pull requests: creating them from task branches, reading their files, merging them and deleting merged branches.
/** The task pull request cannot merge until its branch is reconciled with the base branch. */
export class PullRequestConflict extends ControlError {}
export interface PullRequestMerge { number: number; url: string; merged: boolean; message: string; headSha: string; headRef?: string; mergeSha?: string }
const slugOf = async (api: GitHubApi, project: ControlProject): Promise<string> => project.github?.repository ?? await api.repositorySlug(project.repositoryPath);

/** Delete a merged branch on GitHub; never the default branch. Returns false when it no longer exists. */
export async function deleteRemoteBranch(api: GitHubApi, project: ControlProject, branch: string): Promise<boolean> {
  const base = repositoryApi(await slugOf(api, project));
  const metadata = await api.api<any>(base);
  if (!branch || branch === metadata.default_branch) return false;
  const response = await api.send(`${base}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'DELETE', undefined);
  if (response.status === 204) return true;
  if (response.status === 404 || response.status === 422) return false;
  throw new (response.status >= 500 ? GitHubUnavailable : ControlError)(`GitHub: branch deletion failed (${response.status}).`, 502);
}

/** Reconcile by branch and task marker before creating, including after a lost POST response. */
export async function createTaskPullRequest(api: GitHubApi, project: ControlProject, task: ControlTask): Promise<NonNullable<ControlTask['pullRequest']>> {
  const tree = task.worktree ?? (task.taskBranch ? { path: project.repositoryPath, branch: task.taskBranch, mainBranch: project.mainBranch ?? project.defaultBranch ?? 'main' } : null);
  if (!tree || tree.branch === tree.mainBranch) throw new ControlError('A task branch is required.', 409);
  const slug = await slugOf(api, project), base = repositoryApi(slug);
  const remote = githubRepositoryFromRemote(await gitAsync(tree.path, ['remote', 'get-url', 'origin']));
  if (remote?.toLowerCase() !== slug.toLowerCase()) throw new ControlError('Origin must point to the project GitHub repository.', 409);
  commitTaskBranch(task, tree.path, tree.branch);
  const headSha = await gitAsync(tree.path, ['rev-parse', 'HEAD']);
  await gitAsync(tree.path, ['push', 'origin', `refs/heads/${tree.branch}:refs/heads/${tree.branch}`], 120_000);
  const query = new URLSearchParams({ state: 'all', head: `${slug.split('/')[0]}:${tree.branch}`, base: tree.mainBranch, per_page: '100' });
  const existing = await api.api<any[]>(`${base}/pulls?${query}`);
  let pull = existing.find(entry => String(entry.body ?? '').includes(taskMarker(task.id)) && (entry.state === 'open' || (entry.merged_at && entry.head?.sha === headSha)));
  if (!pull) pull = await api.api<any>(`${base}/pulls`, 'POST', {
    title: taskTitle(task), head: tree.branch, base: tree.mainBranch,
    body: `${task.description}\n\n${task.github?.issueNumber ? `Closes #${task.github.issueNumber}\n\n` : ''}${taskMarker(task.id)}`,
  });
  return { number: pull.number, url: pull.html_url, headSha };
}

/** GitHub retains PR files and patches after task worktrees and branches are removed. */
export async function pullRequestChanges(api: GitHubApi, project: ControlProject, task: ControlTask): Promise<GitChanges> {
  const base = repositoryApi(await slugOf(api, project));
  const files: GitChange[] = [], patches: Record<string, string> = Object.create(null);
  let truncated = false;
  for (let page = 1; page <= 30; page++) {
    const batch = await api.api<any[]>(`${base}/pulls/${Number(task.pullRequest!.number)}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    for (const file of batch) {
      files.push({ path: file.filename, ...(file.previous_filename ? { oldPath: file.previous_filename } : {}), status: file.status === 'removed' ? 'deleted' : file.status === 'added' ? 'added' : file.status === 'renamed' ? 'renamed' : 'modified', additions: file.additions, deletions: file.deletions });
      patches[file.filename] = typeof file.patch === 'string' ? file.patch : 'GitHub did not provide a patch for this file. Open the pull request to inspect it.';
    }
    if (batch.length < 100) break;
    if (page === 30) truncated = true;
  }
  return { root: null, branch: null, base: null, files, patches, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0), truncated };
}

/** Merges (or queues GitHub auto-merge for) the one pull request verifiably linked to the task. */
export async function mergePullRequest(api: GitHubApi, project: ControlProject, task: ControlTask): Promise<PullRequestMerge> {
  if (!(task.autoMerge ?? project.autoMerge)) throw new ControlError('Automatic merge is not enabled for this task.', 409);
  const slug = await slugOf(api, project), base = repositoryApi(slug);
  const [owner, repoName] = slug.split('/');
  const metadata = await api.api<any>(base);
  if (!metadata.permissions?.push && !metadata.permissions?.maintain && !metadata.permissions?.admin) throw new ControlError('GitHub token does not have verified write permission for this repository.', 403);
  let number = task.pullRequest?.number;
  if (!number && task.github?.issueNumber) {
    const candidates: number[] = []; let after: string | null = null;
    do {
      const data = await api.graphql('query($owner:String!,$repo:String!,$issue:Int!,$after:String){repository(owner:$owner,name:$repo){issue(number:$issue){closedByPullRequestsReferences(first:100,after:$after){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}', { owner, repo: repoName, issue: task.github.issueNumber, after });
      const connection = data?.repository?.issue?.closedByPullRequestsReferences;
      for (const entry of connection?.nodes ?? []) if (entry.repository?.nameWithOwner?.toLowerCase() === slug.toLowerCase()) candidates.push(entry.number);
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    if (candidates.length !== 1) throw new ControlError('Exactly one task-linked pull request is required for automatic merge.', 409);
    number = candidates[0];
  }
  if (!number || !Number.isSafeInteger(number) || number < 1) throw new ControlError('No verified task pull request is available. Local workspace changes cannot be auto-merged.', 409);
  const pull = await api.api<any>(`${base}/pulls/${number}`);
  if (pull.base?.repo?.full_name?.toLowerCase() !== slug.toLowerCase() || pull.head?.repo?.full_name?.toLowerCase() !== slug.toLowerCase()) throw new ControlError('Automatic merge requires a pull request from the same repository.', 409);
  if (pull.base.ref !== (task.worktree?.mainBranch ?? project.mainBranch ?? metadata.default_branch)) throw new ControlError('Automatic merge only targets the configured main branch.', 409);
  const headSha = String(pull.head.sha);
  if (task.pullRequest?.headSha && task.pullRequest.headSha !== headSha) throw new ControlError('Pull request HEAD changed. Review the new commit before merging.', 409);
  let related = String(pull.body ?? '').includes(taskMarker(task.id));
  if (!related && task.github?.issueNumber) {
    let after: string | null = null;
    do {
      const data = await api.graphql('query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100,after:$after){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}', { owner, repo: repoName, number, after });
      const connection = data?.repository?.pullRequest?.closingIssuesReferences;
      related = !!connection?.nodes?.some((issue: any) => issue.number === task.github!.issueNumber && issue.repository?.nameWithOwner?.toLowerCase() === slug.toLowerCase());
      after = !related && connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
  }
  if (!related) throw new ControlError('Pull request is not linked to this task or its GitHub issue.', 409);
  const result = { number, url: String(pull.html_url), headSha, ...(typeof pull.head?.ref === 'string' ? { headRef: pull.head.ref } : {}) };
  if (pull.merged) return { ...result, merged: true, ...(pull.merge_commit_sha ? { mergeSha: String(pull.merge_commit_sha) } : {}), message: 'GitHub confirms that this task pull request was merged.' };
  if (pull.state !== 'open' || pull.draft) throw new ControlError('Automatic merge requires an open, non-draft pull request.', 409);
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') throw new PullRequestConflict('Pull request has merge conflicts.', 409);
  const mergeMethod = task.worktree ? (metadata.allow_merge_commit ? 'merge' : undefined) : metadata.allow_squash_merge ? 'squash' : metadata.allow_merge_commit ? 'merge' : undefined;
  if (!mergeMethod) throw new ControlError('The repository does not allow a supported merge method.', 409);
  if (pull.mergeable_state === 'clean') {
    const merged = await api.api<any>(`${base}/pulls/${number}/merge`, 'PUT', { sha: headSha, merge_method: mergeMethod });
    return { ...result, merged: merged.merged === true, ...(merged.sha ? { mergeSha: String(merged.sha) } : {}), message: String(merged.message ?? 'GitHub merge request completed.') };
  }
  if (!metadata.allow_auto_merge) return { ...result, merged: false, message: 'Checks or reviews are pending. Enable GitHub repository auto-merge to queue this pull request.' };
  await api.graphql('mutation($id:ID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{number autoMergeRequest{enabledAt}}}}', { id: pull.node_id, method: mergeMethod.toUpperCase() });
  return { ...result, merged: false, message: 'GitHub auto-merge enabled; required checks and reviews still control the merge.' };
}
