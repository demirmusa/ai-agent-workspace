import { randomUUID } from 'node:crypto';
import { taskTitle } from '../shared/core/task-title.js';
import { isRepositorySlug, type GitHubApi } from './github-api.js';
import type { GitHubImages } from './github-images.js';
import { syncMilestones, type MilestoneSync } from './github-milestones.js';
import { remoteLabels, repositoryIssues, taskMarker, triggeredRequest, trustedAuthor, withoutTaskMarker, type lookupIssue } from './github-issues.js';
import { TASK_STATUS_OPTIONS } from './github-projects.js';
import { labelKey, sameLabels } from './labels.js';
import type { ImageStore } from './attachments.js';
import { ControlError, type ControlProject, type ControlTask, type DefaultProvider, type ProjectLabel, type TaskStatus } from './types.js';
import { newId } from './service/common.js';

// Two-way task sync with a GitHub Projects board: GitHub remains authoritative for remote edits; locally modified fields win simultaneous conflicts.
export interface SyncOptions { intakeSince?: string; connectedAt?: string; trigger?: string; ignored?: number[]; images?: ImageStore }
/** What the sync needs besides the API: issue lookup (so callers can observe it) and image publishing. */
export interface SyncHost extends GitHubApi { lookupIssue(project: ControlProject, number: number): ReturnType<typeof lookupIssue> }
type Remote = { id: string; number: number; title: string; body: string; url: string; state: string; itemId: string; status: string | null; labels: string[]; milestone: number | null };
type Field = { id: string; name: string; options: Array<{ id: string; name: string }> };

export interface SyncResult { project: ControlProject; tasks: ControlTask[]; labels: ProjectLabel[]; milestones?: MilestoneSync }
/**
 * One cheap query whose answer changes whenever the board (item fields, order, additions), an issue (edits, labels,
 * comments, new issues) or a milestone changes on GitHub, so polling can skip the full sync while nothing moved.
 */
export async function remoteChangeMark(github: GitHubApi, project: ControlProject): Promise<string | null> {
  const connection = project.github;
  if (!connection || !isRepositorySlug(connection.repository)) return null;
  const [repositoryOwner, repositoryName] = connection.repository.split('/');
  const root = connection.ownerType === 'organization' ? 'organization' : 'user';
  const latest = 'first:1,orderBy:{field:UPDATED_AT,direction:DESC}';
  const data = await github.graphql(`query($repositoryOwner:String!,$repositoryName:String!,$owner:String!,$number:Int!){repository(owner:$repositoryOwner,name:$repositoryName){issues(${latest}){nodes{updatedAt}} milestones(${latest}){nodes{updatedAt}}} ${root}(login:$owner){projectV2(number:$number){updatedAt}}}`, { repositoryOwner, repositoryName, owner: connection.owner, number: connection.number });
  const board = data?.[root]?.projectV2?.updatedAt;
  if (!board || !data?.repository) return null;
  return [board, data.repository.issues?.nodes?.[0]?.updatedAt ?? '', data.repository.milestones?.nodes?.[0]?.updatedAt ?? ''].join('|');
}
export async function syncProject(github: SyncHost, images: GitHubImages, project: ControlProject, tasks: ControlTask[], defaultProvider: DefaultProvider = 'codex', options: SyncOptions = {}): Promise<SyncResult> {
  const connection = project.github;
  if (!connection) return { project, tasks, labels: [] };
  if (!isRepositorySlug(connection.repository) || !/^[\w-]+$/.test(connection.owner) || !Number.isSafeInteger(connection.number) || connection.number < 1) throw new ControlError('Geçerli GitHub repository, owner ve project number gereklidir.');
  const root = connection.ownerType === 'organization' ? 'organization' : 'user';
  let projectId = '';
  const fields: Field[] = [];
  let cursor: string | null = null;
  do {
    const data = await github.graphql(`query($owner:String!,$number:Int!,$after:String){${root}(login:$owner){projectV2(number:$number){id fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name}}} pageInfo{hasNextPage endCursor}}}}}`, { owner: connection.owner, number: connection.number, after: cursor });
    const value = data?.[root]?.projectV2;
    if (!value) throw new ControlError('GitHub Project bulunamadı veya token erişemiyor.', 502);
    projectId = value.id;
    fields.push(...value.fields.nodes.filter((field: any) => field?.options));
    cursor = value.fields.pageInfo.hasNextPage ? value.fields.pageInfo.endCursor : null;
  } while (cursor);
  const field = fields.find((entry) => entry.name === (connection.statusField ?? 'Status'));
  if (!field) throw new ControlError(`GitHub Project içinde '${connection.statusField ?? 'Status'}' single-select alanı bulunamadı.`, 502);
  const mapping = { ...TASK_STATUS_OPTIONS, ...connection.statuses };
  // Common default GitHub boards use Todo/In Progress/Done. Exact custom mappings take priority.
  const aliases: Partial<Record<TaskStatus, string[]>> = { backlog: ['Todo', 'To do', 'Backlog'], ready: ['Ready', 'Todo', 'To do'], running: ['In progress', 'In Progress'], review: ['In review', 'In Review'], done: ['Done'], cancelled: ['Cancelled', 'Done'], waiting: ['Waiting', 'Blocked', 'In Progress', 'In progress'], paused: ['Paused', 'In Progress', 'In progress'], failed: ['Failed', 'Todo', 'To do'] };
  const optionFor = (status: TaskStatus) => field.options.find((option) => option.name === mapping[status]) ?? (!connection.statuses?.[status] ? field.options.find((option) => aliases[status]?.includes(option.name)) : undefined);
  const statusFor = (remote: Remote, previous?: ControlTask): TaskStatus => {
    if (remote.state === 'CLOSED') return previous?.status === 'cancelled' ? 'cancelled' : 'done';
    if (previous && optionFor(previous.status)?.name === remote.status) return previous.status;
    return (Object.keys(mapping) as TaskStatus[]).find((status) => mapping[status] === remote.status) ?? (Object.keys(mapping) as TaskStatus[]).find((status) => optionFor(status)?.name === remote.status) ?? 'backlog';
  };
  const setStatus = (itemId: string, optionId: string) => github.graphql('mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}', { project: projectId, item: itemId, field: field.id, option: optionId });
  const addItem = async (contentId: string): Promise<string> => (await github.graphql('mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}', { project: projectId, content: contentId })).addProjectV2ItemById.item.id;
  // Milestones first, so every task milestone has a repository number to compare with its issue's milestone.
  const milestones = await syncMilestones(github, connection.repository, project.milestones ?? [], project.milestoneDeletions ?? [], () => newId('milestone'));
  const milestoneNumber = (id: string | undefined): number | null | undefined => { if (!id) return null; const milestone = milestones.milestones.find((entry) => entry.id === id); return milestone ? milestone.github?.number : null; };
  const milestoneId = (number: number | null): string | undefined => number === null ? undefined : milestones.milestones.find((entry) => entry.github?.number === number)?.id;
  const issueMilestone = (value: unknown): number | null => { const number = (value as { number?: unknown } | null)?.number; return Number.isSafeInteger(number) ? number as number : null; };
  const remotes: Remote[] = [];
  // Label definitions seen on issues, so the project catalog learns labels created on GitHub.
  const seenLabels = new Map<string, ProjectLabel>();
  const issueLabels = (values: unknown): string[] => remoteLabels(values).map((label) => { if (!seenLabels.has(labelKey(label.name))) seenLabels.set(labelKey(label.name), label); return label.name; });
  cursor = null;
  do {
    const data = await github.graphql('query($id:ID!,$after:String,$status:String!){node(id:$id){... on ProjectV2{items(first:100,after:$after){nodes{id fieldValueByName(name:$status){... on ProjectV2ItemFieldSingleSelectValue{name}} content{... on Issue{id number title body url state repository{nameWithOwner} labels(first:100){nodes{name color description}} milestone{number}}}} pageInfo{hasNextPage endCursor}}}}}', { id: projectId, after: cursor, status: field.name });
    const items = data?.node?.items;
    if (!items) throw new ControlError('GitHub Project kartları okunamadı.', 502);
    for (const item of items.nodes) if (item?.content?.repository?.nameWithOwner?.toLowerCase() === connection.repository.toLowerCase()) remotes.push({ ...item.content, itemId: item.id, status: item.fieldValueByName?.name ?? null, labels: issueLabels(item.content.labels?.nodes), milestone: issueMilestone(item.content.milestone) });
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);
  const forced = new Map<number, TaskStatus>();
  if (options.intakeSince) {
    // Issues opened on GitHub (for example from a phone) join the board; addressing the agent makes them Ready.
    const connectedAt = options.connectedAt ?? options.intakeSince;
    for (let page = 1; page <= 10; page++) {
      const batch = await github.api<any[]>(`repos/${connection.repository}/issues?state=open&since=${encodeURIComponent(options.intakeSince)}&sort=created&direction=asc&per_page=100&page=${page}`);
      if (!Array.isArray(batch)) break;
      for (const issue of batch) {
        if (issue.pull_request || String(issue.created_at) < connectedAt || !trustedAuthor(issue.author_association) || String(issue.body ?? '').includes('<!-- aiws-task:')) continue;
        if (remotes.some((remote) => remote.number === issue.number) || tasks.some((task) => task.github?.issueNumber === issue.number) || options.ignored?.includes(issue.number)) continue;
        const itemId = await addItem(issue.node_id);
        let status: string | null = null;
        if (options.trigger && triggeredRequest(`${issue.title}\n${issue.body ?? ''}`, options.trigger) !== null) {
          const option = optionFor('ready');
          if (option) { await setStatus(itemId, option.id); status = option.name; }
          forced.set(issue.number, 'ready');
        }
        remotes.push({ id: issue.node_id, number: issue.number, title: issue.title, body: issue.body ?? '', url: issue.html_url, state: 'OPEN', itemId, status, labels: issueLabels(issue.labels), milestone: issueMilestone(issue.milestone) });
      }
      if (batch.length < 100) break;
    }
  }
  const result: ControlTask[] = [];
  const now = new Date().toISOString();
  let repoIssues: any[] | undefined;
  for (const task of tasks) {
    if (task.projectId !== project.id) continue;
    if (task.externalDependency) {
      if (!task.github?.issueNumber) throw new ControlError('External blockers must reference an existing GitHub issue.');
      const issue = await github.lookupIssue(project, task.github.issueNumber);
      result.push({ ...task, title: issue.title, description: issue.body, status: issue.state === 'closed' ? 'done' : 'backlog', updatedAt: now,
        github: { issueNumber: issue.number, issueUrl: issue.url, ...(issue.nodeId ? { issueId: issue.nodeId } : {}), updatedAt: now, lastSyncedAt: now } });
      continue;
    }
    let remote = remotes.find((item) => item.number === task.github?.issueNumber || item.body?.includes(taskMarker(task.id)));
    let newlyLinked = false;
    if (!remote) {
      let issue: any;
      if (task.github?.issueNumber) issue = await github.api(`repos/${connection.repository}/issues/${Number(task.github.issueNumber)}`);
      else {
        // A marker reconciles partial creation failures before retry, avoiding duplicate issues.
        repoIssues ??= await repositoryIssues(github, connection.repository);
        issue = repoIssues.find((entry) => entry.body?.includes(taskMarker(task.id)));
        if (!issue) { issue = await github.api(`repos/${connection.repository}/issues`, 'POST', { title: taskTitle(task), body: `${await images.toRemote(connection.repository, task.description, options.images)}\n\n${taskMarker(task.id)}`, ...(task.tags?.length ? { labels: task.tags } : {}), ...(milestoneNumber(task.milestoneId) ? { milestone: milestoneNumber(task.milestoneId) } : {}) }); repoIssues.push(issue); }
      }
      remote = { id: issue.node_id, number: issue.number, title: issue.title, body: issue.body ?? '', url: issue.html_url, state: String(issue.state).toUpperCase(), itemId: await addItem(issue.node_id), status: null, labels: issueLabels(issue.labels), milestone: issueMilestone(issue.milestone) };
      newlyLinked = true;
    }
    const baseline = task.github?.baseline;
    const localTitle = !baseline || task.title !== baseline.title;
    const localBody = !baseline || task.description !== baseline.description;
    const localStatus = !baseline || task.status !== baseline.status;
    // Tasks synchronized before labels existed have no label baseline; their remote labels win unless they carry tags.
    const tags = task.tags ?? [];
    const localLabels = baseline?.labels ? !sameLabels(tags, baseline.labels) : tags.length > 0;
    const title = localTitle ? taskTitle(task) : remote.title;
    const description = localBody ? task.description : await images.toLocal(connection.repository, withoutTaskMarker(remote.body ?? ''), options.images);
    const status = localStatus ? task.status : statusFor(remote, task);
    const labels = localLabels ? tags : remote.labels;
    const labelsChanged = !sameLabels(labels, remote.labels);
    // A task milestone not on GitHub yet (its creation failed) stays as it is until a later sync links it.
    const localMilestone = milestoneNumber(task.milestoneId);
    const milestoneSynced = localMilestone !== undefined;
    const localMilestoneChanged = milestoneSynced && (baseline && baseline.milestone !== undefined ? localMilestone !== baseline.milestone : localMilestone !== null);
    const milestone = !milestoneSynced ? baseline?.milestone ?? remote.milestone : localMilestoneChanged ? localMilestone : remote.milestone;
    const milestoneChanged = milestoneSynced && milestone !== remote.milestone;
    const remoteDescription = await images.toRemote(connection.repository, description, options.images);
    const body = `${remoteDescription}\n\n${taskMarker(task.id)}`;
    const closed = status === 'done' || status === 'cancelled';
    if (title !== remote.title || withoutTaskMarker(remote.body ?? '') !== remoteDescription || closed !== (remote.state === 'CLOSED') || !String(remote.body ?? '').includes(taskMarker(task.id)) || labelsChanged || milestoneChanged) await github.api(`repos/${connection.repository}/issues/${remote.number}`, 'PATCH', { title, body, state: closed ? 'closed' : 'open', ...(closed ? { state_reason: status === 'cancelled' ? 'not_planned' : 'completed' } : {}), ...(labelsChanged ? { labels } : {}), ...(milestoneChanged ? { milestone } : {}) });
    if (localStatus || newlyLinked) {
      const option = optionFor(status);
      if (!option) throw new ControlError(`GitHub Project '${field.name}' alanında '${mapping[status]}' durumu yok. Project durumunu ekleyin veya bağlantının statuses eşlemesini ayarlayın.`, 502);
      if (remote.status !== option.name) await setStatus(remote.itemId, option.id);
    }
    const synced: ControlTask = { ...task, title, description, status, tags: labels, updatedAt: now, github: { issueNumber: remote.number, issueUrl: remote.url, issueId: remote.id, itemId: remote.itemId, updatedAt: now, lastSyncedAt: now, baseline: { title, description, status, labels, milestone } } };
    if (milestoneSynced) { const id = milestoneId(milestone); if (id) synced.milestoneId = id; else delete synced.milestoneId; }
    result.push(synced);
  }
  for (const remote of remotes) {
    if (result.some((task) => task.github?.issueNumber === remote.number)) continue;
    const status = forced.get(remote.number) ?? statusFor(remote);
    const remoteDescription = withoutTaskMarker(remote.body ?? '');
    const description = await images.toLocal(connection.repository, remoteDescription, options.images);
    const id = randomUUID();
    await github.api(`repos/${connection.repository}/issues/${remote.number}`, 'PATCH', { body: `${remoteDescription}\n\n${taskMarker(id)}` });
    const imported = milestoneId(remote.milestone);
    result.push({ id, projectId: project.id, title: remote.title, description, status, provider: defaultProvider, priority: 0, tags: remote.labels, ...(imported ? { milestoneId: imported } : {}), dependsOn: [], autoStart: false, currentRunId: null, createdAt: now, updatedAt: now, github: { issueNumber: remote.number, issueUrl: remote.url, issueId: remote.id, itemId: remote.itemId, updatedAt: now, lastSyncedAt: now, baseline: { title: remote.title, description, status, labels: remote.labels, milestone: remote.milestone } } });
  }
  return { project, tasks: result, labels: [...seenLabels.values()], milestones };
}
