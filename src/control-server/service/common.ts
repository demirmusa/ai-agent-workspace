import { randomUUID } from 'node:crypto';
import { renderTerminalScreen } from '../terminal-screen.js';
import { ControlError, type Run, type Task, type TaskStatus } from '../types.js';

/** Shared helpers and constants of the control service modules. */

/** The built-in workspace for work outside any repository, such as recurring automations. */
export const GENERAL_WORKSPACE_ID = 'project_general';
export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'ready', 'running', 'waiting', 'paused', 'review', 'completing', 'done', 'failed', 'cancelled'];
/** Task statuses that only a run can enter. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['running', 'waiting', 'paused'];
const finishedRunStatuses = new Set<Run['status']>(['completed', 'failed', 'cancelled', 'interrupted']);
/** True once a run has ended; its process may still be exiting. */
export const runEnded = (run: Pick<Run, 'status'>): boolean => finishedRunStatuses.has(run.status);

export class ExecutionCapacityError extends ControlError {}

export const now = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
/** A required text field; `fallback` replaces only a missing value. */
export function text(value: unknown, name: string, max = 20_000, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new ControlError(`${name} must be text, at most ${max} characters.`);
  return value;
}
export const has = (input: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);

type QueueTask = Pick<Task, 'id' | 'queueOrder' | 'priority' | 'createdAt' | 'dependsOn' | 'status'> & { archivedAt?: string };
/** A task's priority raised to the highest priority of the unfinished tasks waiting on it, directly or through other blockers. */
export function effectivePriorities(all: readonly QueueTask[]): Map<string, number> {
  const dependents = new Map<string, QueueTask[]>();
  for (const task of all) {
    if (task.archivedAt || task.status === 'done' || task.status === 'cancelled') continue;
    for (const id of task.dependsOn ?? []) { const list = dependents.get(id); if (list) list.push(task); else dependents.set(id, [task]); }
  }
  const result = new Map<string, number>(), visiting = new Set<string>();
  const resolve = (task: QueueTask): number => {
    const known = result.get(task.id);
    if (known !== undefined) return known;
    if (visiting.has(task.id)) return task.priority;
    visiting.add(task.id);
    let value = task.priority;
    for (const dependent of dependents.get(task.id) ?? []) value = Math.max(value, resolve(dependent));
    visiting.delete(task.id); result.set(task.id, value);
    return value;
  };
  for (const task of all) resolve(task);
  return result;
}
/**
 * Ready queue order. Unplaced tasks run by effective priority (see effectivePriorities), then oldest. Manually placed tasks keep
 * their positions; an unplaced task goes ahead of the first placed task with a lower effective priority. Blocked ones are skipped
 * when dispatched. `all` holds the tasks whose dependencies raise priorities; it defaults to `tasks`.
 */
export function readyQueue<T extends QueueTask>(tasks: readonly T[], all: readonly QueueTask[] = tasks): T[] {
  const priorities = effectivePriorities(all), priority = (task: T) => priorities.get(task.id) ?? task.priority;
  const placed = tasks.filter((task) => task.queueOrder !== undefined).sort((a, b) => a.queueOrder! - b.queueOrder! || a.createdAt.localeCompare(b.createdAt));
  const unplaced = tasks.filter((task) => task.queueOrder === undefined).sort((a, b) => priority(b) - priority(a) || a.createdAt.localeCompare(b.createdAt));
  const ordered: T[] = [];
  for (const task of placed) {
    while (unplaced.length && priority(unplaced[0]!) > priority(task)) ordered.push(unplaced.shift()!);
    ordered.push(task);
  }
  return [...ordered, ...unplaced];
}
/** Queued continuations start first-in, first-out, ahead of other ready tasks. */
export function continuationOrder(a: Pick<Task, 'queuedContinuation' | 'updatedAt' | 'id'>, b: Pick<Task, 'queuedContinuation' | 'updatedAt' | 'id'>): number {
  return (a.queuedContinuation?.queuedAt ?? a.updatedAt).localeCompare(b.queuedContinuation?.queuedAt ?? b.updatedAt) || a.id.localeCompare(b.id);
}
/** A queue time after every queued continuation, so two queued within the same millisecond keep their order. */
export function continuationQueuedAt(tasks: readonly Task[]): string {
  const latest = Math.max(0, ...tasks.map((task) => Date.parse(task.queuedContinuation?.queuedAt ?? '') || 0));
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}
/** A project-relative POSIX path that stays inside the project; a trailing slash marks a folder. */
export const validAttachedFile = (value: string): boolean => value.length > 0 && value.length <= 1_000 && !/[\\\x00\r\n]/.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && value.replace(/\/$/, '').split('/').every((part) => part && part !== '.' && part !== '..');

/** Readable tail of a raw PTY replay for provider prompts and transcripts. */
export function terminalTranscript(output: string, limit: number): string {
  return renderTerminalScreen(output).join('\n').replace(/\n{3,}/g, '\n\n').slice(-limit).trim();
}
/** Undoes changes made to a task while an operation failed: the stored object keeps its identity. */
export function restoreTask(task: Task, before: Task): void {
  for (const field of Object.keys(task)) delete (task as unknown as Record<string, unknown>)[field];
  Object.assign(task, before);
}
/** Milliseconds a run has been working, including the current stretch. */
export function activeMs(run: Pick<Run, 'activeMs' | 'lastResumedAt' | 'status'>, current = Date.now()): number {
  return (run.activeMs ?? 0) + (run.lastResumedAt && (run.status === 'running' || run.status === 'waiting') ? Math.max(0, current - Date.parse(run.lastResumedAt)) : 0);
}
/** Adds the time since the run last resumed to its active time. */
export function accumulateTime(run: Run): void {
  if (run.lastResumedAt) run.activeMs = (run.activeMs ?? 0) + Math.max(0, Date.now() - Date.parse(run.lastResumedAt));
  delete run.lastResumedAt;
}
export const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
