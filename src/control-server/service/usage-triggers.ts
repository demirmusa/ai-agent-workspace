import type { ProviderUsage } from '../ai-providers/usage.js';
import type { Task } from '../types.js';
import { usageTriggerChangedMessage, usageTriggerState } from '../usage-trigger.js';
import { now } from './common.js';
import type { ControlContext } from './context.js';

/** Ready tasks that wait for a provider quota window: reads the windows and decides which tasks may start. */
export class UsageTriggers {
  /** Supplies provider quota windows for usage-triggered tasks; set by the server. */
  source?: () => Promise<ProviderUsage[]>;
  private snapshot: { providers: ProviderUsage[]; at: number } | undefined;
  private refreshing = false;
  constructor(private readonly ctx: ControlContext) {}

  /** Refreshes the windows and fails tasks whose window no longer exists. */
  tick(current: number): void {
    this.refresh(current);
    this.failChanged(current);
  }
  waiting(task: Task, current: number): boolean {
    return Boolean(task.usageTrigger) && usageTriggerState(task.usageTrigger!, this.snapshot?.providers ?? [], current) !== 'open';
  }
  /** Quota windows are only read while a ready task waits on one, at most once a minute. */
  private refresh(current: number): void {
    if (!this.source || this.refreshing || current - (this.snapshot?.at ?? 0) < 60_000) return;
    if (!this.ctx.state.tasks.some((task) => task.usageTrigger && task.status === 'ready' && !task.archivedAt)) return;
    this.refreshing = true;
    void this.source().then((providers) => { this.snapshot = { providers, at: Date.now() }; }, () => { this.snapshot = { providers: this.snapshot?.providers ?? [], at: Date.now() }; }).finally(() => { this.refreshing = false; });
  }
  /** A task waiting on a window its provider no longer has needs the user: it moves to "needs you" with the reason. */
  private failChanged(current: number): void {
    for (const task of this.ctx.state.tasks) {
      if (!task.usageTrigger || task.status !== 'ready' || task.archivedAt || usageTriggerState(task.usageTrigger, this.snapshot?.providers ?? [], current) !== 'changed') continue;
      task.status = 'failed'; task.queueReason = usageTriggerChangedMessage(task.usageTrigger.provider); task.updatedAt = now(); this.ctx.changed();
    }
  }
}
