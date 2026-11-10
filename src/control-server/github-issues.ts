import { escapeRegExp } from '../shared/core/redact.js';
import { repositoryApi, type GitHubApi } from './github-api.js';
import { labelKey, validateLabel } from './labels.js';
import { ControlError, type ControlProject, type ProjectLabel } from './types.js';

/** Issues, issue comments and repository labels: the markers AIWS writes into them and the calls that read and write them. */
export const taskMarker = (id: string): string => `<!-- aiws-task:${id} -->`;
/** An issue body without the task marker AIWS appended. */
export const withoutTaskMarker = (body: string): string => body.replace(/\n?<!-- aiws-task:[^>]+ -->/g, '').trimEnd();
/** Comments written by AIWS carry this marker so polling never treats them as requests. */
export const COMMENT_MARKER = '<!-- aiws-comment -->';
const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** Only repository owners, organization members and collaborators may direct agents on this machine. */
export const trustedAuthor = (association: unknown): boolean => typeof association === 'string' && trustedAssociations.has(association);
/** Returns the request addressed to the agent, or null when the trigger is absent. Quoted lines are ignored. */
export function triggeredRequest(body: string, trigger: string): string | null {
  const own = body.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('>')).join('\n');
  const pattern = () => new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?=$|[\\s,.:;!?])`, 'gi');
  if (!pattern().test(own)) return null;
  return own.replace(pattern(), '$1').trim();
}
export interface IssueComment { id: number; issueNumber: number; body: string; author: string; association: string; createdAt: string; url: string }

/** GitHub label objects (REST or GraphQL) as project labels; malformed entries are skipped. */
export function remoteLabels(values: unknown): ProjectLabel[] {
  const result: ProjectLabel[] = [];
  for (const value of Array.isArray(values) ? values : []) { try { const label = value as Record<string, unknown>; result.push(validateLabel({ name: label.name, color: label.color, description: String(label.description ?? '').slice(0, 100) })); } catch { /* GitHub names never break the sync. */ } }
  return result;
}
const linkedRepository = (project: ControlProject): string => { if (!project.github) throw new ControlError('Project is not connected to GitHub.'); return repositoryApi(project.github.repository); };

/** Read an existing blocker without importing it, adding it to a board or creating issues. */
export async function lookupIssue(api: GitHubApi, project: ControlProject, number: number): Promise<{ number: number; title: string; body: string; url: string; state: 'open' | 'closed'; nodeId?: string }> {
  if (!project.github) throw new ControlError('Issue lookup requires a linked GitHub repository.');
  const repository = repositoryApi(project.github.repository);
  if (!Number.isSafeInteger(number) || number < 1) throw new ControlError('Issue number must be a positive integer.');
  const issue = await api.api<any>(`${repository}/issues/${number}`);
  if (issue.pull_request) throw new ControlError('Blocked-by references must identify issues, not pull requests.');
  if (issue.number !== number || typeof issue.title !== 'string' || typeof issue.html_url !== 'string' || !['open', 'closed'].includes(issue.state)) throw new ControlError('GitHub returned an invalid issue.', 502);
  return { number, title: issue.title, body: issue.body ?? '', url: issue.html_url, state: issue.state, ...(issue.node_id ? { nodeId: issue.node_id } : {}) };
}

/** Permanently deletes an issue of the linked repository. GitHub allows this only to repository admins and only through GraphQL. */
export async function deleteIssue(api: GitHubApi, project: ControlProject, issue: { issueNumber: number; issueId?: string }): Promise<void> {
  const issueId = issue.issueId ?? (await lookupIssue(api, project, issue.issueNumber)).nodeId;
  if (!issueId) throw new ControlError('GitHub did not return the issue ID.', 502);
  await api.graphql('mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }', { issueId });
}

/** Repository issues read in one listing; more pages than this are not scanned. */
const MAX_ISSUE_PAGES = 50;
/** Every issue of a repository (`owner/name`), open and closed, oldest first, without pull requests. */
export async function repositoryIssues(api: GitHubApi, repository: string): Promise<any[]> {
  const path = repositoryApi(repository), issues: any[] = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const batch = await api.api<any[]>(`${path}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break; issues.push(...batch.filter((issue) => !issue.pull_request)); if (batch.length < 100) break;
  }
  return issues;
}

/** Every label of the linked repository. */
export async function repositoryLabels(api: GitHubApi, project: ControlProject): Promise<ProjectLabel[]> {
  const repository = linkedRepository(project), labels: ProjectLabel[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api.api<any[]>(`${repository}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break; labels.push(...remoteLabels(batch)); if (batch.length < 100) break;
  }
  return labels;
}
/** Creates missing repository labels and updates the color and description of existing ones. Labels only on GitHub stay. */
export async function exportLabels(api: GitHubApi, project: ControlProject, labels: ProjectLabel[], remote: ProjectLabel[]): Promise<{ created: string[]; updated: string[] }> {
  const repository = linkedRepository(project), created: string[] = [], updated: string[] = [];
  for (const label of labels) {
    const existing = remote.find((entry) => labelKey(entry.name) === labelKey(label.name));
    if (!existing) { await api.api(`${repository}/labels`, 'POST', { name: label.name, color: label.color, description: label.description }); created.push(label.name); continue; }
    if (existing.name === label.name && existing.color === label.color && existing.description === label.description) continue;
    await api.api(`${repository}/labels/${encodeURIComponent(existing.name)}`, 'PATCH', { new_name: label.name, color: label.color, description: label.description }); updated.push(label.name);
  }
  return { created, updated };
}

export async function postComment(api: GitHubApi, project: ControlProject, issueNumber: number, body: string): Promise<{ id: number; url: string }> {
  const repository = linkedRepository(project);
  const text = body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n…` : body;
  const created = await api.api<any>(`${repository}/issues/${Number(issueNumber)}/comments`, 'POST', { body: `${text}\n\n${COMMENT_MARKER}` });
  return { id: created.id, url: created.html_url };
}
export async function reactToComment(api: GitHubApi, project: ControlProject, commentId: number, content: 'eyes' | 'confused'): Promise<void> {
  if (!project.github) return;
  await api.api(`${repositoryApi(project.github.repository)}/issues/comments/${Number(commentId)}/reactions`, 'POST', { content });
}
/** Repository issue comments created at or after `since`, oldest first. */
export async function issueComments(api: GitHubApi, project: ControlProject, since: string): Promise<IssueComment[]> {
  if (!project.github) return [];
  const repository = repositoryApi(project.github.repository), result: IssueComment[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api.api<any[]>(`${repository}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    for (const entry of batch) {
      const issueNumber = Number(/\/issues\/(\d+)$/.exec(String(entry?.issue_url ?? ''))?.[1]);
      if (!Number.isSafeInteger(issueNumber) || typeof entry.body !== 'string' || String(entry.created_at) < since) continue;
      result.push({ id: entry.id, issueNumber, body: entry.body, author: String(entry.user?.login ?? ''), association: String(entry.author_association ?? 'NONE'), createdAt: String(entry.created_at), url: String(entry.html_url ?? '') });
    }
    if (batch.length < 100) break;
  }
  return result;
}
