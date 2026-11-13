import type { MilestoneSync } from '../github-milestones.js';
import { MILESTONE_LIMIT, milestoneKey, settleCurrentMilestone, validateMilestoneFields } from '../milestones.js';
import { ControlError, type Project, type ProjectMilestone } from '../types.js';
import { jsonObject } from '../validation.js';
import { has, newId, now } from './common.js';
import type { ControlContext } from './context.js';

/**
 * Project milestones as on GitHub: create, edit, close and delete them, choose the current milestone new tasks join, and
 * move tasks between milestones. Linked projects reconcile them with the repository on every GitHub sync.
 */
export class MilestoneManager {
  constructor(private readonly ctx: ControlContext) {}

  create(projectId: string, input: unknown): Project {
    const project = this.ctx.project(projectId), value = jsonObject(input), milestones = project.milestones ??= [];
    if (milestones.length >= MILESTONE_LIMIT) throw new ControlError(`A project can have at most ${MILESTONE_LIMIT} milestones.`);
    const fields = validateMilestoneFields(value); this.assertUniqueTitle(project, fields.title);
    const timestamp = now(), milestone: ProjectMilestone = { id: newId('milestone'), ...fields, ...(fields.state === 'closed' ? { closedAt: timestamp } : {}), createdAt: timestamp, updatedAt: timestamp };
    milestones.push(milestone);
    if (value.current === true && milestone.state === 'open') project.currentMilestoneId = milestone.id;
    return this.saved(project);
  }
  update(projectId: string, milestoneId: string, input: unknown): Project {
    const project = this.ctx.project(projectId), milestone = this.milestone(project, milestoneId), value = jsonObject(input);
    const fields = validateMilestoneFields(value, milestone); this.assertUniqueTitle(project, fields.title, milestone.id);
    if (fields.state !== milestone.state) { if (fields.state === 'closed') milestone.closedAt = now(); else delete milestone.closedAt; }
    Object.assign(milestone, fields, { updatedAt: now() });
    if (value.current === true) { if (milestone.state !== 'open') throw new ControlError('Only an open milestone can be current.'); project.currentMilestoneId = milestone.id; }
    return this.saved(project);
  }
  /** Deletes the milestone; its tasks keep going without one, as issues do when a GitHub milestone is deleted. */
  delete(projectId: string, milestoneId: string): Project {
    const project = this.ctx.project(projectId), milestone = this.milestone(project, milestoneId);
    project.milestones = project.milestones!.filter((entry) => entry.id !== milestoneId);
    if (milestone.github && project.github) project.milestoneDeletions = [...new Set([...(project.milestoneDeletions ?? []), milestone.github.number])];
    for (const task of this.ctx.state.tasks) if (task.projectId === projectId && task.milestoneId === milestoneId) { delete task.milestoneId; task.updatedAt = now(); }
    if (project.currentMilestoneId === milestoneId) delete project.currentMilestoneId;
    return this.saved(project);
  }
  /** Chooses the open milestone new tasks join; null means new tasks start without one. */
  setCurrent(projectId: string, input: unknown): Project {
    const project = this.ctx.project(projectId), value = jsonObject(input);
    if (!has(value, 'milestoneId') || (value.milestoneId !== null && typeof value.milestoneId !== 'string')) throw new ControlError('milestoneId must be a milestone ID or null.');
    if (value.milestoneId === null) project.currentMilestoneId = null;
    else { const milestone = this.milestone(project, value.milestoneId as string); if (milestone.state !== 'open') throw new ControlError('Only an open milestone can be current.'); project.currentMilestoneId = milestone.id; }
    return this.saved(project);
  }
  /** Moves tasks of the project to a milestone, or out of their milestone with null. */
  assign(projectId: string, input: unknown): { moved: number } {
    const project = this.ctx.project(projectId), value = jsonObject(input);
    if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 1000 || value.taskIds.some((id) => typeof id !== 'string')) throw new ControlError('taskIds must list 1-1000 task IDs.');
    if (!has(value, 'milestoneId') || (value.milestoneId !== null && typeof value.milestoneId !== 'string')) throw new ControlError('milestoneId must be a milestone ID or null.');
    const milestoneId = value.milestoneId === null ? null : this.milestone(project, value.milestoneId as string).id;
    const tasks = (value.taskIds as string[]).map((id) => this.ctx.task(id));
    if (tasks.some((task) => task.projectId !== projectId)) throw new ControlError('Tasks must belong to the project.');
    let moved = 0;
    for (const task of tasks) {
      if ((task.milestoneId ?? null) === milestoneId) continue;
      if (milestoneId) task.milestoneId = milestoneId; else delete task.milestoneId;
      task.updatedAt = now(); moved++;
    }
    if (moved) this.ctx.changed();
    return { moved };
  }
  /**
   * Applies a GitHub sync's milestones. Milestones edited while the sync ran keep their edits and only take the GitHub link;
   * ones deleted meanwhile stay deleted (on GitHub too, at the next sync); ones created meanwhile are kept.
   */
  applySync(project: Project, before: ProjectMilestone[], result: MilestoneSync): void {
    const current = project.milestones ?? [], previous = new Map(before.map((entry) => [entry.id, entry])), next: ProjectMilestone[] = [];
    const deletions = new Set((project.milestoneDeletions ?? []).filter((number) => !result.deleted.includes(number)));
    for (const synced of result.milestones) {
      const local = current.find((entry) => entry.id === synced.id);
      if (!local) { if (!previous.has(synced.id)) next.push(synced); else if (synced.github) deletions.add(synced.github.number); continue; }
      if (local.updatedAt !== previous.get(local.id)?.updatedAt) { if (synced.github) local.github = synced.github; next.push(local); } else next.push(synced);
    }
    for (const local of current) if (!previous.has(local.id) && !next.includes(local)) next.push(local);
    project.milestones = next;
    if (deletions.size) project.milestoneDeletions = [...deletions]; else delete project.milestoneDeletions;
    const known = new Set(next.map((entry) => entry.id));
    for (const task of this.ctx.state.tasks) if (task.projectId === project.id && task.milestoneId && !known.has(task.milestoneId)) delete task.milestoneId;
    settleCurrentMilestone(project);
    for (const error of result.errors) this.ctx.event(null, null, 'github.error', `Milestone ${error}`, { projectId: project.id });
  }
  private milestone(project: Project, milestoneId: string): ProjectMilestone {
    const milestone = project.milestones?.find((entry) => entry.id === milestoneId);
    if (!milestone) throw new ControlError('Milestone not found.', 404);
    return milestone;
  }
  private assertUniqueTitle(project: Project, title: string, except?: string): void {
    if (project.milestones?.some((entry) => entry.id !== except && milestoneKey(entry.title) === milestoneKey(title))) throw new ControlError(`A milestone titled '${title}' already exists.`, 409);
  }
  private saved(project: Project): Project {
    settleCurrentMilestone(project); project.updatedAt = now(); this.ctx.changed(); return structuredClone(project);
  }
}
