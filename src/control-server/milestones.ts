import { ControlError, type MilestoneFields, type Project, type ProjectMilestone } from './types.js';

/** Project milestones: field validation, GitHub's ordering and the current milestone new tasks join. */
export const MILESTONE_TITLE_LIMIT = 255, MILESTONE_DESCRIPTION_LIMIT = 10_000, MILESTONE_LIMIT = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const milestoneKey = (title: string): string => title.trim().toLocaleLowerCase('en-US');
/** A calendar date as YYYY-MM-DD; GitHub's `due_on` timestamps keep their date part. */
export function milestoneDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = String(value).slice(0, 10);
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new ControlError('dueOn must be a date (YYYY-MM-DD) or null.');
  return date;
}

/** Validates milestone fields; fields absent from `input` keep their `previous` value. */
export function validateMilestoneFields(input: Record<string, unknown>, previous?: MilestoneFields): MilestoneFields {
  const title = input.title === undefined ? previous?.title : input.title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > MILESTONE_TITLE_LIMIT) throw new ControlError(`Milestone titles must be 1-${MILESTONE_TITLE_LIMIT} characters.`);
  const description = input.description === undefined ? previous?.description ?? '' : input.description ?? '';
  if (typeof description !== 'string' || description.length > MILESTONE_DESCRIPTION_LIMIT) throw new ControlError(`Milestone descriptions must be text, at most ${MILESTONE_DESCRIPTION_LIMIT} characters.`);
  const dueOn = input.dueOn === undefined ? previous?.dueOn ?? null : milestoneDate(input.dueOn);
  const state = input.state === undefined ? previous?.state ?? 'open' : input.state;
  if (state !== 'open' && state !== 'closed') throw new ControlError('Milestone state must be open or closed.');
  return { title: title.trim(), description, dueOn, state };
}

export const sameMilestoneFields = (a: MilestoneFields, b: MilestoneFields): boolean => a.title === b.title && a.description === b.description && a.dueOn === b.dueOn && a.state === b.state;
export const milestoneFields = (milestone: MilestoneFields): MilestoneFields => ({ title: milestone.title, description: milestone.description, dueOn: milestone.dueOn, state: milestone.state });

/** GitHub's default milestone order: closest due date first, undated ones after, then by title. */
export function milestoneOrder(a: ProjectMilestone, b: ProjectMilestone): number {
  if (a.dueOn !== b.dueOn) return a.dueOn === null ? 1 : b.dueOn === null ? -1 : a.dueOn.localeCompare(b.dueOn);
  return a.title.localeCompare(b.title);
}

/** The open milestone new tasks of the project join, if any. */
export function currentMilestone(project: Project): ProjectMilestone | undefined {
  const milestone = project.milestones?.find((entry) => entry.id === project.currentMilestoneId);
  return milestone?.state === 'open' ? milestone : undefined;
}

/**
 * Keeps the current milestone pointing at an open milestone: when it closes or disappears, the next open milestone
 * by due date takes over; with no open milestone it is cleared. An explicit `null` (no current milestone) stays.
 */
export function settleCurrentMilestone(project: Project): void {
  if (project.currentMilestoneId === null || currentMilestone(project)) return;
  const next = [...(project.milestones ?? [])].filter((entry) => entry.state === 'open').sort(milestoneOrder)[0];
  if (next) project.currentMilestoneId = next.id; else delete project.currentMilestoneId;
}

/** A project disconnected from GitHub keeps its milestones as local ones. */
export function unlinkMilestones(project: Project): void {
  for (const milestone of project.milestones ?? []) delete milestone.github;
  delete project.milestoneDeletions;
}
