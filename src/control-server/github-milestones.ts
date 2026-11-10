import { repositoryApi, type GitHubApi } from './github-api.js';
import { milestoneDate, milestoneFields, milestoneKey, sameMilestoneFields } from './milestones.js';
import type { MilestoneFields, ProjectMilestone } from './types.js';

/** Repository milestones and their two-way sync with the project's milestones. */
interface RemoteMilestone extends MilestoneFields { number: number; url: string; closedAt: string | null }
export interface MilestoneSync { milestones: ProjectMilestone[]; deleted: number[]; errors: string[] }

function remoteMilestone(value: unknown): RemoteMilestone | null {
  const entry = value as Record<string, unknown> | null;
  if (!entry || !Number.isSafeInteger(entry.number) || typeof entry.title !== 'string' || !entry.title.trim()) return null;
  let dueOn: string | null = null; try { dueOn = milestoneDate(entry.due_on); } catch { /* An unreadable date is treated as none. */ }
  return { number: entry.number as number, title: entry.title.trim(), description: typeof entry.description === 'string' ? entry.description : '', dueOn,
    state: entry.state === 'closed' ? 'closed' : 'open', url: typeof entry.html_url === 'string' ? entry.html_url : '', closedAt: typeof entry.closed_at === 'string' ? entry.closed_at : null };
}
/** GitHub stores a due date as a timestamp; noon UTC keeps the calendar date in every time zone GitHub uses. */
const remoteBody = (fields: MilestoneFields) => ({ title: fields.title, description: fields.description, due_on: fields.dueOn ? `${fields.dueOn}T12:00:00Z` : null, state: fields.state });

/** Every milestone of the repository, open and closed. */
export async function repositoryMilestones(api: GitHubApi, repository: string): Promise<RemoteMilestone[]> {
  const path = repositoryApi(repository), result: RemoteMilestone[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api.api<unknown[]>(`${path}/milestones?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    for (const value of batch) { const milestone = remoteMilestone(value); if (milestone) result.push(milestone); }
    if (batch.length < 100) break;
  }
  return result;
}

/**
 * Reconciles project milestones with the repository's, field by field like task sync: a field changed here since the last
 * sync wins, otherwise GitHub's value is taken. Unlinked milestones link to a repository milestone of the same title or
 * create one; repository milestones without a project milestone are imported; linked milestones missing on GitHub were
 * deleted there and are dropped. `deletions` are linked milestones deleted here, which are deleted on GitHub.
 */
export async function syncMilestones(api: GitHubApi, repository: string, milestones: ProjectMilestone[], deletions: number[], newId: () => string): Promise<MilestoneSync> {
  const path = repositoryApi(repository), now = new Date().toISOString(), errors: string[] = [], deleted: number[] = [];
  const remote = await repositoryMilestones(api, repository);
  for (const number of deletions) {
    try { if (remote.some((entry) => entry.number === number)) await api.api(`${path}/milestones/${number}`, 'DELETE'); deleted.push(number); }
    catch (error) { errors.push(`#${number}: ${(error as Error).message}`); }
  }
  const live = remote.filter((entry) => !deletions.includes(entry.number)), linked = new Set<number>(milestones.flatMap((entry) => entry.github ? [entry.github.number] : []));
  const result: ProjectMilestone[] = [];
  const link = (milestone: ProjectMilestone, match: RemoteMilestone, fields: MilestoneFields): ProjectMilestone => {
    const changed = !sameMilestoneFields(milestone, fields);
    const closedAt = fields.state === 'closed' ? milestone.closedAt ?? match.closedAt ?? now : undefined;
    const next: ProjectMilestone = { ...milestone, ...fields, ...(changed ? { updatedAt: now } : {}), github: { number: match.number, ...(match.url ? { url: match.url } : {}), baseline: milestoneFields(fields) } };
    if (closedAt) next.closedAt = closedAt; else delete next.closedAt;
    return next;
  };
  for (const milestone of milestones) {
    let match: RemoteMilestone | null | undefined = milestone.github ? live.find((entry) => entry.number === milestone.github!.number) : live.find((entry) => !linked.has(entry.number) && milestoneKey(entry.title) === milestoneKey(milestone.title));
    // A linked milestone missing on GitHub was deleted there.
    if (milestone.github && !match) continue;
    try {
      if (!match) {
        match = remoteMilestone(await api.api(`${path}/milestones`, 'POST', remoteBody(milestone)));
        if (!match) throw new Error('GitHub returned an invalid milestone.');
        linked.add(match.number); result.push(link(milestone, match, milestoneFields(milestone))); continue;
      }
      linked.add(match.number);
      const baseline = milestone.github?.baseline;
      const pick = <K extends keyof MilestoneFields>(key: K): MilestoneFields[K] => !baseline || milestone[key] !== baseline[key] ? milestone[key] : match![key];
      const fields: MilestoneFields = { title: pick('title'), description: pick('description'), dueOn: pick('dueOn'), state: pick('state') };
      if (!sameMilestoneFields(fields, match)) await api.api(`${path}/milestones/${match.number}`, 'PATCH', remoteBody(fields));
      result.push(link(milestone, match, fields));
    } catch (error) { errors.push(`${milestone.title}: ${(error as Error).message}`); result.push(milestone); }
  }
  for (const entry of live) {
    if (linked.has(entry.number)) continue;
    const fields = milestoneFields(entry);
    result.push({ id: newId(), ...fields, ...(entry.state === 'closed' ? { closedAt: entry.closedAt ?? now } : {}), createdAt: now, updatedAt: now, github: { number: entry.number, ...(entry.url ? { url: entry.url } : {}), baseline: fields } });
  }
  return { milestones: result, deleted, errors };
}
