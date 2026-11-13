import { Option, type Command } from 'commander';
import { milestoneOrder } from '../../../control-server/milestones.js';
import type { Project, ProjectMilestone } from '../../../control-server/types.js';
import { ids, print, projectRef, request, segment } from './client.js';

/** `none` clears a value; anything else is sent as is. */
const nullable = (value: string): string | null => value === 'none' ? null : value;

/** Milestone fields shared by `milestones create` and `milestones update`. */
function milestoneFields(options: Record<string, any>): Record<string, unknown> {
  return { ...(options.title === undefined ? {} : { title: options.title }), ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.due === undefined ? {} : { dueOn: nullable(options.due) }), ...(options.state === undefined ? {} : { state: options.state }), ...(options.current ? { current: true } : {}) };
}

/** The project's milestones in GitHub's order, marking the current one and counting its tasks. */
async function listed(command: Command, projectId: string): Promise<{ project: Project; milestones: Array<ProjectMilestone & { current: boolean; taskCount: number }>; tasks: any[] }> {
  const state = await request(command, '/api/state'), id = projectRef(projectId);
  const project: Project | undefined = state.projects.find((entry: Project) => entry.id === id);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const tasks = state.tasks.filter((task: any) => task.projectId === id);
  const milestones = [...(project.milestones ?? [])].sort(milestoneOrder)
    .map((milestone) => ({ ...milestone, current: project.currentMilestoneId === milestone.id, taskCount: tasks.filter((task: any) => task.milestoneId === milestone.id).length }));
  return { project, milestones, tasks };
}

/** Project milestones: list, create, edit, close, delete, choose the current one new tasks join, and move tasks between them. */
export function registerMilestoneCommands(control: Command): void {
  const milestones = control.command('milestones').description('Manage project milestones; new tasks join the current milestone unless --milestone is given.');
  milestones.command('list <projectId>').description('List milestones (closest due date first), marking the current one.')
    .addOption(new Option('--state <state>', 'filter by state').choices(['open', 'closed', 'all']).default('all'))
    .action(async (projectId, options, command) => {
      const { milestones: entries } = await listed(command, projectId);
      print(entries.filter((milestone) => options.state === 'all' || milestone.state === options.state));
    });
  milestones.command('show <projectId> <milestoneId>').description('Show a milestone and its tasks.')
    .action(async (projectId, milestoneId, _options, command) => {
      const { milestones: entries, tasks } = await listed(command, projectId), milestone = entries.find((entry) => entry.id === milestoneId);
      if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);
      print({ ...milestone, tasks: tasks.filter((task) => task.milestoneId === milestoneId).map((task) => ({ id: task.id, title: task.title, status: task.status })) });
    });
  milestones.command('current <projectId> [milestoneId]').description("Show the current milestone, or choose it; 'none' makes new tasks start without a milestone.")
    .action(async (projectId, milestoneId, _options, command) => {
      if (milestoneId === undefined) { const { milestones: entries } = await listed(command, projectId); print(entries.find((entry) => entry.current) ?? null); return; }
      print(await request(command, `/api/projects/${segment(projectRef(projectId))}/milestones/current`, 'PUT', { milestoneId: nullable(milestoneId) }));
    });
  milestones.command('create <projectId> <title>').option('--description <text>').option('--due <date>', 'due date as YYYY-MM-DD')
    .addOption(new Option('--state <state>').choices(['open', 'closed'])).option('--current', 'make it the current milestone new tasks join', false)
    .action(async (projectId, title, options, command) => print(await request(command, `/api/projects/${segment(projectRef(projectId))}/milestones`, 'POST', milestoneFields({ ...options, title }))));
  milestones.command('update <projectId> <milestoneId>').option('--title <text>').option('--description <text>').option('--due <date>', 'due date as YYYY-MM-DD, or none to clear')
    .addOption(new Option('--state <state>', 'close or reopen').choices(['open', 'closed'])).option('--current', 'make it the current milestone new tasks join', false)
    .action(async (projectId, milestoneId, options, command) => print(await request(command, `/api/projects/${segment(projectRef(projectId))}/milestones/${segment(milestoneId)}`, 'PATCH', milestoneFields(options))));
  milestones.command('delete <projectId> <milestoneId>').description('Delete the milestone; its tasks stay, without a milestone.')
    .action(async (projectId, milestoneId, _options, command) => print(await request(command, `/api/projects/${segment(projectRef(projectId))}/milestones/${segment(milestoneId)}`, 'DELETE')));
  milestones.command('assign <projectId> <milestoneId> <taskIds>').description("Move comma-separated tasks to the milestone; 'none' takes them out of their milestone.")
    .action(async (projectId, milestoneId, taskIds, _options, command) => print(await request(command, `/api/projects/${segment(projectRef(projectId))}/milestones/assign`, 'POST', { milestoneId: nullable(milestoneId), taskIds: ids(taskIds) })));
}
