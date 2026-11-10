import { basename } from 'node:path';
import { gitAsync } from './git.js';
import { repositoryApi, type GitHubApi } from './github-api.js';
import { ControlError, type GitHubConnection, type TaskStatus } from './types.js';

// Connecting a folder to GitHub: creating the repository, discovering and linking a Projects board, and its Status field.
/** The Status option names AIWS creates on a board, one per task status. */
export const TASK_STATUS_OPTIONS: Record<TaskStatus, string> = { backlog: 'Backlog', ready: 'Ready', running: 'In progress', waiting: 'Waiting', paused: 'Paused', review: 'In review', completing: 'Completing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
export interface DiscoveredGitHubProject { id: string; number: number; title: string; url: string; owner: string; ownerType: 'user' | 'organization'; linked: boolean }
export interface GitHubDiscovery { repository: string; owner: string; ownerType: 'user' | 'organization'; defaultBranch: string; projects: DiscoveredGitHubProject[]; suggestedProject: number | null; warning?: string }
export interface ConnectOptions { projectNumber?: number; createProject?: boolean; projectTitle?: string; projectOwner?: string; projectOwnerType?: 'user' | 'organization' }
export interface CreateRepositoryOptions { name?: string; owner?: string; private?: boolean; description?: string }
/** GraphQL root field of a board owner; only these two names are ever interpolated into a query. */
const ownerField = (type: unknown): 'user' | 'organization' => type === 'organization' ? 'organization' : 'user';

/** Create a GitHub repository for a local folder, add it as a remote and push the current branch when one exists. */
export async function createRepository(api: GitHubApi, repositoryPath: string, options: CreateRepositoryOptions = {}): Promise<{ repository: string; url: string; remote: string; pushed: boolean; warning?: string }> {
  if (options.name !== undefined && typeof options.name !== 'string') throw new ControlError('Repository name must be text.');
  const name = (options.name || basename(repositoryPath)).trim().replace(/\s+/g, '-');
  if (!/^[\w.-]{1,100}$/.test(name) || name === '.' || name === '..') throw new ControlError('Repository name may contain letters, digits, ".", "-" and "_" (at most 100 characters).');
  if (options.owner !== undefined && (typeof options.owner !== 'string' || !/^[\w-]+$/.test(options.owner))) throw new ControlError('Invalid repository owner.');
  if (options.private !== undefined && typeof options.private !== 'boolean') throw new ControlError('private must be boolean.');
  const git = (...args: string[]) => gitAsync(repositoryPath, args, 120_000);
  try { await git('rev-parse', '--is-inside-work-tree'); } catch { await git('init'); }
  const remotes = (await git('remote')).split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'github' : 'origin';
  if (remotes.includes(remote)) throw new ControlError(`Git remote '${remote}' already exists. Remove it or connect the existing repository.`, 409);
  const user = await api.api<any>('user');
  const owner = options.owner && options.owner.toLowerCase() !== String(user.login).toLowerCase() ? options.owner : undefined;
  const created = await api.api<any>(owner ? `orgs/${owner}/repos` : 'user/repos', 'POST', { name, private: options.private ?? true, ...(options.description ? { description: String(options.description).slice(0, 350) } : {}) });
  if (typeof created.clone_url !== 'string' || !created.clone_url || created.clone_url.startsWith('-')) throw new ControlError('GitHub returned an invalid repository URL.', 502);
  await git('remote', 'add', remote, created.clone_url);
  let pushed = false; let warning: string | undefined;
  let hasCommit = true; try { await git('rev-parse', '--verify', 'HEAD'); } catch { hasCommit = false; }
  if (!hasCommit) warning = 'Repository created. The folder has no commits yet; push after your first commit.';
  else try { await git('push', '-u', remote, 'HEAD'); pushed = true; }
  catch (error) { warning = `Repository created, but pushing the current branch failed: ${(error as Error).message.split('\n')[0]} Run gh auth setup-git, then git push -u ${remote} HEAD.`; }
  return { repository: created.full_name, url: created.html_url, remote, pushed, ...(warning ? { warning } : {}) };
}

/** The repository behind the folder's github.com remote and the open Projects boards linked to it or to its owner. */
export async function detectRepository(api: GitHubApi, repositoryPath: string): Promise<GitHubDiscovery> {
  const slug = await api.repositorySlug(repositoryPath);
  const repository = await api.api<any>(repositoryApi(slug));
  const owner = String(repository.owner?.login ?? slug.split('/')[0]);
  const ownerType = repository.owner?.type === 'Organization' ? 'organization' : 'user';
  const projects: DiscoveredGitHubProject[] = [];
  let warning: string | undefined;
  try {
    let after: string | null = null;
    do {
      const data = await api.graphql('query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){projectsV2(first:100,after:$after){nodes{id number title url closed owner{__typename ... on User{login} ... on Organization{login}}} pageInfo{hasNextPage endCursor}}}}', { owner, repo: slug.split('/')[1], after });
      const connection = data?.repository?.projectsV2;
      for (const entry of connection?.nodes ?? []) if (entry && !entry.closed) projects.push({ id: entry.id, number: entry.number, title: entry.title, url: entry.url, owner: entry.owner?.login ?? owner, ownerType: entry.owner?.__typename === 'Organization' ? 'organization' : entry.owner?.__typename === 'User' ? 'user' : ownerType, linked: true });
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    after = null;
    do {
      const data = await api.graphql(`query($owner:String!,$after:String){${ownerType}(login:$owner){projectsV2(first:100,after:$after){nodes{id number title url closed} pageInfo{hasNextPage endCursor}}}}`, { owner, after });
      const connection = data?.[ownerType]?.projectsV2;
      for (const entry of connection?.nodes ?? []) if (entry && !entry.closed && !projects.some((existing) => existing.id === entry.id)) projects.push({ id: entry.id, number: entry.number, title: entry.title, url: entry.url, owner, ownerType, linked: false });
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
  } catch (error) { warning = (error as Error).message; }
  const linked = projects.filter((entry) => entry.linked);
  return { repository: repository.full_name ?? slug, owner, ownerType, defaultBranch: repository.default_branch ?? 'main', projects, suggestedProject: linked.length === 1 ? linked[0]!.number : null, ...(warning ? { warning } : {}) };
}

/** Links the chosen (or a new) board to the repository and makes sure its Status field has an option per task status. */
export async function connectRepository(api: GitHubApi, discovery: GitHubDiscovery, options: ConnectOptions = {}): Promise<GitHubConnection> {
  const matches = discovery.projects.filter((entry) => entry.number === (options.projectNumber ?? discovery.suggestedProject) && (!options.projectOwner || entry.owner === options.projectOwner));
  if (matches.length > 1 && !options.createProject) throw new ControlError('Several project owners use this number. Select the discovered project owner explicitly.', 409);
  let selected = matches[0];
  if (options.createProject) {
    const owner = options.projectOwner ?? discovery.owner;
    const ownerType = ownerField(options.projectOwnerType ?? discovery.ownerType);
    const ownerData = await api.graphql(`query($owner:String!){${ownerType}(login:$owner){id}}`, { owner });
    if (!ownerData?.[ownerType]?.id) throw new ControlError('GitHub Project sahibi bulunamadı.', 502);
    const created = await api.graphql('mutation($owner:ID!,$title:String!){createProjectV2(input:{ownerId:$owner,title:$title}){projectV2{id number title url}}}', { owner: ownerData[ownerType].id, title: options.projectTitle?.trim() || `${discovery.repository.split('/')[1]} · AIWS` });
    const value = created.createProjectV2.projectV2;
    selected = { ...value, owner, ownerType, linked: false };
  }
  if (!selected) throw new ControlError('Bir GitHub Projects panosu seçin veya yeni pano oluşturun. Repository sahibi ve adı Git remote üzerinden bulundu.', 409);
  if (!selected.linked) {
    const repo = await api.api<any>(repositoryApi(discovery.repository));
    await api.graphql('mutation($project:ID!,$repository:ID!){linkProjectV2ToRepository(input:{projectId:$project,repositoryId:$repository}){repository{id}}}', { project: selected.id, repository: repo.node_id });
  }
  const statuses = await ensureProjectStatuses(api, selected.id);
  return { repository: discovery.repository, owner: selected.owner, ownerType: selected.ownerType, number: selected.number, statusField: 'Status', statuses };
}

/** Validates the connect request before any GitHub call. */
export function validateConnectOptions(options: ConnectOptions): void {
  if (options.createProject !== undefined && typeof options.createProject !== 'boolean') throw new ControlError('createProject must be boolean.');
  if (options.projectNumber !== undefined && (!Number.isSafeInteger(options.projectNumber) || options.projectNumber < 1)) throw new ControlError('projectNumber must be a positive integer.');
  if (options.projectTitle !== undefined && (typeof options.projectTitle !== 'string' || !options.projectTitle.trim() || options.projectTitle.length > 200)) throw new ControlError('Project title must contain 1 to 200 characters.');
  if (options.projectOwner !== undefined && (typeof options.projectOwner !== 'string' || !/^[\w-]+$/.test(options.projectOwner))) throw new ControlError('Invalid project owner.');
  if (options.projectOwnerType !== undefined && !['user', 'organization'].includes(options.projectOwnerType)) throw new ControlError('Invalid project owner type.');
}

async function ensureProjectStatuses(api: GitHubApi, projectId: string): Promise<Partial<Record<TaskStatus, string>>> {
  const fields: any[] = []; let after: string | null = null;
  do {
    const data = await api.graphql('query($id:ID!,$after:String){node(id:$id){... on ProjectV2{fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name color description}}} pageInfo{hasNextPage endCursor}}}}}', { id: projectId, after });
    const connection = data?.node?.fields; if (!connection) throw new ControlError('GitHub Project fields are not accessible.', 502);
    fields.push(...connection.nodes.filter((field: any) => field?.options)); after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  const field = fields.find((entry) => entry.name === 'Status');
  const existing: Array<{ id?: string; name: string; color: string; description: string }> = (field?.options ?? []).map((option: any) => ({ id: option.id, name: option.name, color: option.color ?? 'GRAY', description: option.description ?? '' }));
  const mapping: Partial<Record<TaskStatus, string>> = {}; const options = [...existing];
  for (const [status, name] of Object.entries(TASK_STATUS_OPTIONS) as Array<[TaskStatus, string]>) {
    const found = options.find((option: any) => option.name.toLowerCase() === name.toLowerCase());
    if (found) mapping[status] = found.name;
    else { options.push({ name, color: status === 'done' ? 'GREEN' : status === 'running' ? 'BLUE' : 'GRAY', description: 'AI Agent Workspace lifecycle' }); mapping[status] = name; }
  }
  if (!field) await api.graphql('mutation($input:CreateProjectV2FieldInput!){createProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}', { input: { projectId, name: 'Status', dataType: 'SINGLE_SELECT', singleSelectOptions: options } });
  else if (options.length !== existing.length) await api.graphql('mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}', { input: { fieldId: field.id, singleSelectOptions: options } });
  return mapping;
}
