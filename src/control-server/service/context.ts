import { existsSync } from 'node:fs';
import { effectiveProviderSettings } from '../provider-settings.js';
import type { RuntimeHandle } from '../runner.js';
import type { ControlStore } from '../store.js';
import { ControlError, type ControlSettings, type ControlState, type Project, type Run, type Task, type TaskMessage } from '../types.js';
import { GENERAL_WORKSPACE_ID, runEnded } from './common.js';
import type { Journal } from './journal.js';

/**
 * What every part of the control service shares: the state and its lookups, the
 * journal, change publication, the live agent processes and tracked background work.
 */
export class ControlContext {
  /** Agent processes by run ID; a run keeps its entry until its process has exited. */
  readonly handles = new Map<string, RuntimeHandle>();
  closing = false;
  private pendingWork = new Set<Promise<unknown>>();

  constructor(readonly store: ControlStore, readonly journal: Journal, readonly changed: (options?: { full?: boolean }) => void) {}

  get state(): ControlState { return this.store.state; }
  project(projectId: string): Project {
    const project = this.state.projects.find((item) => item.id === projectId) ?? (projectId === GENERAL_WORKSPACE_ID ? this.state.generalWorkspace : undefined);
    if (!project) throw new ControlError('Project not found.', 404); return project;
  }
  task(taskId: string): Task {
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task) throw new ControlError('Task not found.', 404); return task;
  }
  run(runId: string): Run {
    const run = this.state.runs.find((item) => item.id === runId);
    if (!run) throw new ControlError('Run not found.', 404); return run;
  }
  /** The latest run of a task: its current one, else the last it had. */
  lastRun(task: Task): Run | undefined { return task.currentRunId ? this.run(task.currentRunId) : this.state.runs.filter((run) => run.taskId === task.id).at(-1); }
  /** A run holds its workspace and execution slot while it is active or its process has not exited yet. */
  busy(run: Run): boolean { return !runEnded(run) || this.handles.has(run.id); }
  /** The task's current run has not ended. */
  running(task: Task): boolean { return Boolean(task.currentRunId && !runEnded(this.run(task.currentRunId))); }
  /** The folder a run works in. */
  runWorkspace(run: Run): string { return run.workspacePath ?? this.project(this.task(run.taskId).projectId).repositoryPath; }
  /** The task's project, located at the task worktree when it has one. */
  taskWorkspace(task: Task): Project { const project = this.project(task.projectId); return { ...project, repositoryPath: task.worktree?.path ?? project.repositoryPath }; }
  /** A finished run may point at a task worktree that was cleaned up after merging; reads then fall back to the project folder. */
  runProject(run: Run): Project {
    const base = this.project(this.task(run.taskId).projectId);
    return { ...base, repositoryPath: run.workspacePath && existsSync(run.workspacePath) ? run.workspacePath : base.repositoryPath };
  }
  /** Provider settings of a project: its own choices over the global ones. */
  providerSettings(projectId: string): ControlSettings { return effectiveProviderSettings(this.state.settings, this.project(projectId)); }
  event(runId: string | null, taskId: string | null, type: string, message: string, data?: unknown): void { this.journal.event(runId, taskId, type, message, data); }
  addMessage(taskId: string, authorType: TaskMessage['authorType'], message: string, run?: Run): TaskMessage { return this.journal.message(taskId, authorType, message, run); }
  /** Background work the service waits for before it closes and releases its files. */
  background(work: Promise<unknown>): void {
    const tracked = work.catch(() => {}).finally(() => this.pendingWork.delete(tracked));
    this.pendingWork.add(tracked);
  }
  /** Waits for background work, at most `timeout` milliseconds. */
  async settle(timeout: number): Promise<void> {
    await Promise.race([Promise.allSettled([...this.pendingWork]), new Promise((resolve) => setTimeout(resolve, timeout).unref())]);
  }
}
