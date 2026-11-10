import { ControlError, type Run, type Task } from '../types.js';
import { continuationOrder, ExecutionCapacityError, readyQueue } from './common.js';
import type { ControlContext } from './context.js';

export interface ReadyQueueDependencies {
  startTask(taskId: string): Run;
  startQueuedTask(taskId: string): Promise<Run>;
  /** Publishes pending state changes to clients at once. */
  publish(): void;
  /** A session operation of the task is in progress. */
  continuing(taskId: string): boolean;
  /** The task waits for a provider quota window. */
  usageWaiting(task: Task, current: number): boolean;
  /** When a task whose workspace failed may be tried again. */
  retryAt(taskId: string): number;
  runtimeError(error: unknown): void;
}

/** Starts ready tasks in queue order while capacity allows; blocked ones keep the reason they wait. */
export class ReadyQueueDispatcher {
  constructor(private readonly ctx: ControlContext, private readonly deps: ReadyQueueDependencies) {}

  tick(current: number): void {
    const { ctx, deps } = this, tasks = ctx.state.tasks;
    let queueChanged = false;
    // A task that left the ready queue loses its manual position, so returning puts it at the end.
    for (const task of tasks) if (task.queueOrder !== undefined && task.status !== 'ready') { delete task.queueOrder; queueChanged = true; }
    // A scheduled ready task waits for its time; a time already past (also after a restart) starts it now.
    const ready = tasks.filter((item) => item.status === 'ready' && !item.archivedAt && (!item.externalHistory || item.queuedContinuation) && !(item.scheduledAt && Date.parse(item.scheduledAt) > current) && !deps.usageWaiting(item, current));
    // A continuation that cannot start now for another reason stops holding a slot.
    for (const task of tasks) if (task.queuedContinuation?.awaitingSlot && !ready.includes(task)) { delete task.queuedContinuation.awaitingSlot; queueChanged = true; }
    // Continuations go first: they reserve the slots they wait for, so a ready task cannot take one while their start is in progress.
    for (const task of [...ready.filter((item) => item.queuedContinuation).sort(continuationOrder), ...readyQueue(ready.filter((item) => !item.queuedContinuation), tasks)]) {
      const queued = task.queuedContinuation;
      if (queued) {
        if (!queued.confirmationRequired && !deps.continuing(task.id) && ctx.state.settings.systemEnabled) {
          void deps.startQueuedTask(task.id).catch((error) => {
            if (!(error instanceof ControlError)) { deps.runtimeError(error); return; }
            const awaiting = error instanceof ExecutionCapacityError, current = task.queuedContinuation === queued && task.status === 'ready';
            if (current && (task.queueReason !== error.message || Boolean(queued.awaitingSlot) !== awaiting)) {
              task.queueReason = error.message;
              if (awaiting) queued.awaitingSlot = true; else delete queued.awaitingSlot;
              ctx.changed();
            }
          });
        }
        continue;
      }
      // Preparing the workspace runs Git synchronously; a blocked one is not retried on every tick.
      if (deps.retryAt(task.id) > current) continue;
      const reason = task.queueReason;
      // Starting prepares the workspace synchronously, so clients first receive the task as it is (a just-created card).
      deps.publish();
      try { deps.startTask(task.id); } catch (error) {
        if (error instanceof ControlError) { task.queueReason = error.message; if (reason !== error.message) queueChanged = true; }
        else deps.runtimeError(error);
      }
    }
    if (queueChanged) ctx.changed();
  }
}
