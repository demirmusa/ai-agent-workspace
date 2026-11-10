import { aiProviders } from '../ai-providers/index.js';
import type { ControlGitHub } from '../github.js';
import { ControlError, type Task, type TaskSchedule, type TaskSearchResult } from '../types.js';
import { jsonObject } from '../validation.js';
import { taskTitle } from '../../shared/core/task-title.js';
import { discardTaskWorktree } from '../worktrees.js';
import { ACTIVE_TASK_STATUSES, continuationQueuedAt, has, newId, now, readyQueue, text } from './common.js';
import type { ControlContext } from './context.js';
import type { TaskFieldValidator } from './task-fields.js';

export interface TaskDependencies {
  fields: TaskFieldValidator;
  github: ControlGitHub;
  learnLabels(projectId: string, tags: string[]): void;
  /** A GitHub synchronization of the project is running. */
  syncing(projectId: string): boolean;
  /** Stops the task's run, and its lingering process, before the task moves to done. */
  releaseForDone(task: Task): Promise<void>;
  /** Stops the task's run, and its lingering process, before the task is cancelled. */
  releaseForCancel(task: Task): Promise<void>;
  /** Throws while the task's merge or cleanup is in progress. */
  assertDeliveryIdle(task: Task): void;
  hasMergeTarget(task: Task): boolean;
  usesPullRequests(task: Task): boolean;
  recheckGitHubRemote(task: Task): void;
  /** Starts merging the task in the background (pull request or worktree branch). */
  requestMerge(task: Task): void;
  mergeLocalTask(task: Task): void;
  /** Public entry points that saves and schedules go through, so service overrides apply to them as well. */
  createTask(input: unknown, extra?: Pick<Task, 'scheduleId' | 'scheduledFor'>): Task;
  updateTask(taskId: string, input: unknown): Task;
  /** Drops what other parts of the service keep about deleted tasks. */
  forget(taskIds: ReadonlySet<string>): void;
}

/** Task records: creation, edits and status moves, search, ordering, archiving and deletion. */
export class TaskManager {
  constructor(private readonly ctx: ControlContext, private readonly deps: TaskDependencies) {}

  create(input: unknown, extra: Pick<Task, 'scheduleId' | 'scheduledFor'> = {}): Task {
    const fields = this.deps.fields.validate(jsonObject(input));
    if (ACTIVE_TASK_STATUSES.includes(fields.status)) throw new ControlError('Start a run to enter an active status.');
    const task: Task = { id: newId('task'), ...fields, ...extra, currentRunId: null, createdAt: now(), updatedAt: now() };
    this.ctx.state.tasks.push(task); this.deps.learnLabels(task.projectId, task.tags ?? []); this.ctx.changed(); return structuredClone(task);
  }
  createScheduled(schedule: TaskSchedule, occurrence: string | null): Task {
    return this.deps.createTask(this.deps.fields.templateInput(schedule.projectId, schedule.task), { scheduleId: schedule.id, scheduledFor: occurrence ?? now() });
  }
  update(taskId: string, input: unknown): Task {
    const task = this.ctx.task(taskId); const fields = this.deps.fields.validate(jsonObject(input), task);
    if (fields.status !== task.status && fields.status !== 'done') this.deps.assertDeliveryIdle(task);
    // A cancelled task restarts from scratch on the latest base branch, so its earlier sessions are not continued.
    const restart = fields.status === 'ready' && task.status === 'cancelled' && !task.externalHistory && !task.historyResume;
    // A task that already ran continues its original conversation when it returns to ready, from any status.
    const requeue = fields.status === 'ready' && task.status !== 'ready' && !restart && !task.externalDependency && task.workflowProgress?.status !== 'running'
      && (['review', 'completing', 'done'].includes(task.status) ? Boolean(task.currentRunId || task.externalHistory) : !task.externalHistory && this.ctx.state.runs.some((run) => run.taskId === task.id && aiProviders.isHistoryProvider(run.provider)));
    if (task.externalHistory && (fields.projectId !== task.projectId || fields.provider !== task.externalHistory.provider || fields.agentId || fields.model || fields.command || fields.workflowId || fields.skillIds?.length)) throw new ControlError('Imported sessions retain their original provider and project. Create a new task to use a different execution profile.', 409);
    if (task.historyResume && (fields.projectId !== task.projectId || fields.provider !== task.historyResume.provider || fields.agentId || fields.model || fields.command || fields.workflowId || fields.skillIds?.length)) throw new ControlError('Historical sessions retain their original provider and project. Create a separate task to use another agent, model, workflow or skills.', 409);
    const active = this.ctx.running(task);
    const profileChanged = fields.provider !== task.provider || fields.agentId !== (task.agentId ?? null) || fields.model !== task.model || fields.reasoningEffort !== task.reasoningEffort || fields.account !== task.account || JSON.stringify(fields.skillIds) !== JSON.stringify(task.skillIds ?? []) || JSON.stringify(fields.command) !== JSON.stringify(task.command);
    if (active && (fields.status !== task.status || fields.projectId !== task.projectId || profileChanged)) throw new ControlError('Use run controls to change an active execution.', 409);
    // The execution profile (provider, model, agent...) is editable only while the task is in backlog or ready.
    if (!['backlog', 'ready'].includes(task.status) && profileChanged) throw new ControlError('The provider and model can only change while a task is in backlog or ready.', 409);
    if (!active && ACTIVE_TASK_STATUSES.includes(fields.status) && (!task.externalHistory || fields.status !== task.status)) throw new ControlError('Start a run to enter an active status.');
    if (active && (fields.terminalMode !== task.terminalMode || fields.workflowId !== (task.workflowId ?? null))) throw new ControlError('Stop the run before changing its terminal or workflow.', 409);
    if (task.worktree && fields.projectId !== task.projectId) throw new ControlError('A task with a worktree cannot move to another project.', 409);
    if (restart) { discardTaskWorktree(task); task.freshStart = true; }
    // Any move to done merges the task branch into main and removes its worktree and branch.
    if (fields.status === 'done' && task.status !== 'done' && this.deps.hasMergeTarget(task)) {
      this.deps.recheckGitHubRemote(task);
      if (!task.worktree || this.deps.usesPullRequests(task)) {
        Object.assign(task, fields, { status: 'completing', updatedAt: now() });
        if (task.worktree) task.worktree.mergeRequested = true; this.ctx.changed(); this.deps.requestMerge(task);
        return structuredClone(task);
      }
      this.deps.mergeLocalTask(task);
      if (task.queuedContinuation?.mergeRecovery) return structuredClone(task);
      if (task.status === 'completing' || task.status === 'failed') return structuredClone(task);
    }
    const descriptionChanged = fields.description !== task.description;
    delete task.model; delete task.command; delete task.providerOverride; delete task.modelOverride; delete task.reasoningEffort; delete task.account; delete task.pullRequest; delete task.terminalMode; delete task.scheduledAt; delete task.usageTrigger; delete task.attachedFiles; delete task.pluginData; delete task.milestoneId;
    Object.assign(task, fields, { updatedAt: now() });
    if (requeue) task.queuedContinuation = { instruction: (descriptionChanged && fields.description) || 'Continue the task from its current state. Review the conversation history and perform the requested remaining work.', confirmationRequired: false, queuedAt: continuationQueuedAt(this.ctx.state.tasks) };
    else if (fields.status !== 'ready') delete task.queuedContinuation;
    if (task.historyResume) task.historyResume.initialMessage = task.description;
    this.deps.learnLabels(task.projectId, task.tags ?? []); this.ctx.changed(); return structuredClone(task);
  }
  async save(input: unknown, taskId?: string): Promise<Task> {
    const value = jsonObject(input);
    if (taskId && value.status === 'done') { this.deps.fields.validate(value, this.ctx.task(taskId)); await this.deps.releaseForDone(this.ctx.task(taskId)); }
    if (taskId && value.status === 'cancelled') { this.deps.fields.validate(value, this.ctx.task(taskId)); await this.deps.releaseForCancel(this.ctx.task(taskId)); }
    if (!has(value, 'dependencyRefs')) return taskId ? this.deps.updateTask(taskId, value) : this.deps.createTask(value);
    const projectId = text(value.projectId, 'projectId', 200, taskId ? this.ctx.task(taskId).projectId : undefined);
    const resolved = await this.resolveDependencyRefs(projectId, value.dependencyRefs, taskId);
    // Network lookups above are read-only; imports and the saved task are committed together.
    const state = this.ctx.state, oldTasks = state.tasks; const oldIgnored = structuredClone(state.ignoredGitHubIssues);
    state.tasks = [...oldTasks, ...resolved.imports];
    if (state.ignoredGitHubIssues?.[projectId]) state.ignoredGitHubIssues[projectId] = state.ignoredGitHubIssues[projectId]!.filter((number) => !resolved.imports.some((task) => task.github?.issueNumber === number));
    try { return taskId ? this.deps.updateTask(taskId, { ...value, dependsOn: resolved.ids }) : this.deps.createTask({ ...value, dependsOn: resolved.ids }); }
    catch (error) { state.tasks = oldTasks; if (oldIgnored === undefined) delete state.ignoredGitHubIssues; else state.ignoredGitHubIssues = oldIgnored; throw error; }
  }
  async search(input: { projectId: string; q: string; excludeTaskId?: string; limit?: number; cursor?: string }): Promise<TaskSearchResult> {
    const project = this.ctx.project(input.projectId); const q = input.q.trim();
    if (q.length > 200) throw new ControlError('Search text must be at most 200 characters.');
    const limit = input.limit ?? 20; const cursor = input.cursor ?? '0';
    if (!Number.isInteger(limit) || limit < 1 || limit > 30 || !/^\d{1,8}$/.test(cursor)) throw new ControlError('Search limit must be 1..30 and cursor a valid offset.');
    if (input.excludeTaskId && this.ctx.task(input.excludeTaskId).projectId !== project.id) throw new ControlError('Excluded task belongs to another project.');
    if (!q || (q.length < 2 && !/^#?\d+$/.test(q))) return { items: [], nextCursor: null };
    const lower = q.toLocaleLowerCase(); const issue = /^#?([1-9]\d*)$/.exec(q); const number = issue ? Number(issue[1]) : undefined;
    // Short task keys as shown in the UI (AIWS-EEC092 or EEC092) match the start of the id after its type prefix.
    const key = /^(?:aiws-)?([0-9a-f-]{2,})$/.exec(lower)?.[1];
    const keyMatches = (task: Task) => key !== undefined && task.id.toLocaleLowerCase().replace(/^[a-z]+[_-]/, '').startsWith(key);
    const matches = this.ctx.state.tasks.filter((task) => task.projectId === project.id && task.id !== input.excludeTaskId && (number !== undefined ? task.github?.issueNumber === number : task.id.toLocaleLowerCase().startsWith(lower) || keyMatches(task) || task.title.toLocaleLowerCase().includes(lower)));
    // Only active tasks can block others; completed, cancelled or archived ones are hidden from the picker.
    const local = matches.filter((task) => !task.archivedAt && task.status !== 'done' && task.status !== 'cancelled')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const items: TaskSearchResult['items'] = local.map((task) => ({ id: task.id, reference: task.id, code: task.github ? `#${task.github.issueNumber}` : task.id, title: taskTitle(task), status: task.status, projectId: task.projectId, remote: false,
      ...(task.github ? { issueNumber: task.github.issueNumber, ...(task.github.issueUrl ? { issueUrl: task.github.issueUrl } : {}) } : {}) }));
    if (!matches.length && number !== undefined && project.github && !this.ctx.state.tasks.some((task) => task.id === input.excludeTaskId && task.github?.issueNumber === number)) {
      if (!Number.isSafeInteger(number)) throw new ControlError('Invalid issue number.');
      try { const remote = await this.deps.github.lookupIssue(project, number); if (remote.state !== 'closed') items.push({ id: null, reference: `#${remote.number}`, code: `#${remote.number}`, title: remote.title, status: 'backlog', projectId: project.id, issueNumber: remote.number, issueUrl: remote.url, remote: true }); }
      catch (error) { if (!(error instanceof ControlError) || error.statusCode !== 404) throw error; }
    }
    const offset = Number(cursor); return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
  }
  setArchived(input: unknown): Task[] {
    const value = jsonObject(input);
    if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 1000 || value.taskIds.some((id) => typeof id !== 'string')) throw new ControlError('taskIds must contain 1..1000 task IDs.');
    if (typeof value.archived !== 'boolean') throw new ControlError('archived must be a boolean.');
    // Resolve the whole selection before changing anything, including mixed-project selections.
    const tasks = [...new Set(value.taskIds as string[])].map((id) => this.ctx.task(id));
    const timestamp = now();
    for (const task of tasks) {
      if (value.archived) task.archivedAt ??= timestamp;
      else delete task.archivedAt;
      task.updatedAt = timestamp;
    }
    this.ctx.changed(); return structuredClone(tasks);
  }
  /** Reorders a project's ready queue; the given tasks take the queue slots they already occupy, in the given order. */
  reorderReady(input: unknown): Task[] {
    const value = jsonObject(input), projectId = value.projectId;
    if (typeof projectId !== 'string') throw new ControlError('projectId is required.');
    this.ctx.project(projectId);
    if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 1000 || value.taskIds.some((id) => typeof id !== 'string')) throw new ControlError('taskIds must contain 1..1000 task IDs.');
    const ids = [...new Set(value.taskIds as string[])], queue = readyQueue(this.ctx.state.tasks.filter((task) => task.projectId === projectId && task.status === 'ready' && !task.archivedAt), this.ctx.state.tasks);
    const index = new Map(queue.map((task, position) => [task.id, position])), positions = ids.map((id) => index.get(id) ?? -1);
    if (positions.some((position) => position < 0)) throw new ControlError('Only ready tasks of this project can be reordered.', 409);
    const slots = [...positions].sort((a, b) => a - b), ordered = [...queue];
    slots.forEach((slot, position) => { ordered[slot] = queue[positions[position]!]!; });
    ordered.forEach((task, position) => { task.queueOrder = position; });
    this.ctx.changed(); return structuredClone(ordered);
  }
  delete(taskId: string): void {
    const task = this.ctx.task(taskId); this.assertRemovable(task);
    if (task.github && !task.externalDependency) {
      const ignored = this.ctx.state.ignoredGitHubIssues ??= {};
      ignored[task.projectId] = [...new Set([...(ignored[task.projectId] ?? []), task.github.issueNumber])];
    }
    this.purge(new Set([taskId]));
  }
  /** Deletes the task's GitHub issue first, then the task; when GitHub refuses, the task is kept. */
  async deleteWithIssue(taskId: string): Promise<void> {
    const task = this.ctx.task(taskId); this.assertRemovable(task);
    if (!task.github || task.externalDependency) throw new ControlError('Task is not linked to an issue of this project.', 409);
    const project = this.ctx.project(task.projectId);
    await this.deps.github.deleteIssue(project, task.github);
    // The task's own events are purged with it, so the deletion is recorded on the project.
    this.ctx.event(null, null, 'github.issue', `Deleted GitHub issue #${task.github.issueNumber} with task ${task.title}.`, { projectId: project.id, issueNumber: task.github.issueNumber });
    this.delete(taskId);
  }
  private assertRemovable(task: Task): void {
    this.assertDeletable(task);
    if (this.deps.syncing(task.projectId)) throw new ControlError('Wait for project synchronization before deleting its tasks.', 409);
  }
  /** Deletes every task of a project at once; nothing is deleted when one of them cannot be. */
  deleteProjectTasks(projectId: string): void {
    const tasks = this.ctx.state.tasks.filter((task) => task.projectId === projectId);
    for (const task of tasks) this.assertDeletable(task);
    const ids = new Set(tasks.map((task) => task.id));
    if (this.ctx.state.tasks.some((task) => task.projectId !== projectId && task.dependsOn.some((dependency) => ids.has(dependency)))) throw new ControlError('Other project tasks depend on this project. Remove those Blocked by references first.', 409);
    this.purge(ids);
  }
  refreshInheritedProviders(projectId?: string): void {
    for (const task of this.ctx.state.tasks) {
      if (projectId && task.projectId !== projectId) continue;
      if (!task.agentId && !task.providerOverride && !task.command && !task.currentRunId && !task.historyResume && !task.externalHistory) task.provider = this.ctx.providerSettings(task.projectId).defaultProvider;
    }
  }
  private assertDeletable(task: Task): void {
    if (this.ctx.running(task)) throw new ControlError('Stop a running task before deleting it.', 409);
    if (task.currentRunId && this.ctx.handles.has(task.currentRunId)) throw new ControlError('The agent process is still stopping. Wait for it to exit, then delete the task.', 409);
  }
  /** Removes tasks with their runs, questions and journal entries. */
  private purge(ids: ReadonlySet<string>): void {
    const state = this.ctx.state, kept = <T extends { taskId: string | null }>(item: T): boolean => !item.taskId || !ids.has(item.taskId);
    state.tasks = state.tasks.filter((item) => !ids.has(item.id));
    for (const task of state.tasks) {
      if (!task.dependsOn.some((id) => ids.has(id))) continue;
      task.dependsOn = task.dependsOn.filter((id) => !ids.has(id));
      task.updatedAt = now();
    }
    state.runs = state.runs.filter(kept); state.questions = state.questions.filter(kept);
    state.events = state.events.filter(kept); state.messages = state.messages.filter(kept);
    this.deps.forget(ids);
    this.ctx.changed({ full: true });
  }
  private async resolveDependencyRefs(projectId: string, raw: unknown, excludeTaskId?: string): Promise<{ ids: string[]; imports: Task[] }> {
    const project = this.ctx.project(projectId);
    if (!Array.isArray(raw) || raw.length > 200 || raw.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200)) throw new ControlError('dependencyRefs must contain at most 200 issue numbers or task IDs.');
    const ids: string[] = []; const imports: Task[] = [];
    for (const reference of [...new Set((raw as string[]).map((value) => value.trim()))]) {
      const issue = /^#?([1-9]\d*)$/.exec(reference); const number = issue ? Number(issue[1]) : undefined;
      const candidates = [...this.ctx.state.tasks, ...imports].filter((task) => task.projectId === projectId && (number !== undefined ? task.github?.issueNumber === number : task.id === reference || (reference.length >= 4 && task.id.startsWith(reference))));
      if (candidates.some((task) => task.id === excludeTaskId)) throw new ControlError('A task cannot be blocked by itself.');
      if (candidates.length > 1) throw new ControlError(`Blocked by reference '${reference}' is ambiguous. Select a specific task result.`);
      if (candidates[0]) { ids.push(candidates[0].id); continue; }
      if (number === undefined || !Number.isSafeInteger(number) || !project.github) throw new ControlError(`Blocked by reference '${reference}' was not found in this project.`);
      const remote = await this.deps.github.lookupIssue(project, number);
      const timestamp = now(), status = remote.state === 'closed' ? 'done' : 'backlog';
      const imported: Task = { id: newId('task'), projectId, externalDependency: true, title: remote.title, description: remote.body, status, provider: this.ctx.providerSettings(projectId).defaultProvider, priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: timestamp, updatedAt: timestamp,
        github: { issueNumber: remote.number, issueUrl: remote.url, ...(remote.nodeId ? { issueId: remote.nodeId } : {}), baseline: { title: remote.title, description: remote.body, status } } };
      imports.push(imported); ids.push(imported.id);
    }
    return { ids: [...new Set(ids)], imports };
  }
}
