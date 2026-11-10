import { CONNECTION_CONTINUE_MESSAGE, connectionErrorReason, rejectedRequestReason } from '../connection-recovery.js';
import type { Run } from '../types.js';
import { runEnded } from './common.js';
import type { ControlContext } from './context.js';
import { serviceTiming as timing } from './timing.js';

export interface ConnectionWatchDependencies {
  /** The visible terminal lines of a live run. */
  screen(runId: string): string[];
  isSettling(runId: string): boolean;
  pendingQuestion(runId: string): boolean;
  usageLimitWaiting(runId: string): boolean;
  finish(run: Run, status: Run['status'], code: number, message?: string): void;
  typeIntoTerminal(runId: string, message: string): void;
}

interface Recovery { attempts: number; resumedAt: number; nextAt: number; probing?: boolean; offline?: boolean }

/**
 * A native TUI whose turn died on a dropped connection idles at its prompt and the run
 * would look busy forever. Once its screen settles on the error, wait for the provider
 * to be reachable again and type a continuation; give up after repeated failures.
 */
export class ConnectionWatch {
  /** Native TUI runs whose turn a connection error cut off, while they are being resumed. */
  readonly recoveries = new Map<string, Recovery>();
  /** Last quiet screen checked per run so idle terminals are not re-checked every second. */
  private checked = new Map<string, string>();
  constructor(private readonly ctx: ControlContext, private readonly deps: ConnectionWatchDependencies) {}

  tick(current: number): void {
    const { ctx, deps } = this;
    for (const [runId] of ctx.handles) {
      const run = ctx.state.runs.find((item) => item.id === runId); if (!run) continue;
      const recovery = this.recoveries.get(run.id);
      if (run.terminalMode !== 'pty' || deps.isSettling(run.id) || !(run.status === 'running' || (run.status === 'waiting' && recovery?.offline))) continue;
      if (recovery?.probing || (recovery && recovery.nextAt > current)) continue;
      if (current - (Date.parse(run.lastActivityAt ?? '') || current) < timing.connectionQuietMs) continue;
      if (deps.pendingQuestion(run.id) || deps.usageLimitWaiting(run.id)) continue;
      const task = ctx.task(run.taskId); if (task.handoffRequest?.runId === run.id) continue;
      const screen = deps.screen(run.id).slice(-12).join('\n');
      if (!recovery && this.checked.get(run.id) === screen) continue;
      const rejected = rejectedRequestReason(screen);
      if (rejected) {
        this.recoveries.delete(run.id);
        deps.finish(run, 'failed', 1, rejected);
        void ctx.handles.get(run.id)?.stop().catch(() => {});
        continue;
      }
      const reason = connectionErrorReason(screen);
      if (!reason) { if (recovery && !recovery.offline) this.recoveries.delete(run.id); this.checked.set(run.id, screen); continue; }
      this.checked.delete(run.id);
      const state = recovery && current - recovery.resumedAt < timing.connectionRecoveryWindowMs ? recovery : { attempts: 0, resumedAt: 0, nextAt: 0 };
      this.recoveries.set(run.id, state);
      if (state.attempts >= timing.connectionRecoveryAttempts) {
        this.recoveries.delete(run.id);
        const handle = ctx.handles.get(run.id);
        deps.finish(run, 'failed', 1, `The provider kept losing its connection (${reason}). Resume the task once the connection is stable.`);
        void handle?.stop().catch(() => {});
        continue;
      }
      state.probing = true;
      void timing.connectivityProbe(run.provider).catch(() => false).then((online) => {
        state.probing = false;
        if (ctx.closing || this.recoveries.get(run.id) !== state || !ctx.handles.has(run.id) || runEnded(run)) return;
        const at = Date.now();
        if (!online) {
          state.nextAt = at + timing.connectivityRetryMs;
          if (!state.offline) {
            state.offline = true; run.status = 'waiting'; task.status = 'waiting';
            ctx.event(run.id, task.id, 'connection.waiting', `Connection lost (${reason}). Waiting for the internet connection to continue.`);
            ctx.addMessage(task.id, 'system', `Connection lost (${reason}). The run continues automatically once the internet connection is back.`, run);
            ctx.changed();
          }
          return;
        }
        state.offline = false; state.attempts++; state.resumedAt = at;
        state.nextAt = at + Math.min(300_000, timing.connectionQuietMs * 2 ** state.attempts);
        if (run.status === 'waiting') { run.status = 'running'; task.status = 'running'; }
        ctx.event(run.id, task.id, 'connection.resume', `Connection error (${reason}). Continuing the interrupted turn (attempt ${state.attempts}/${timing.connectionRecoveryAttempts}).`);
        try { deps.typeIntoTerminal(run.id, CONNECTION_CONTINUE_MESSAGE); } catch { /* The terminal closed meanwhile. */ }
        ctx.changed();
      });
    }
    for (const id of this.recoveries.keys()) if (!ctx.handles.has(id)) this.recoveries.delete(id);
    for (const id of this.checked.keys()) if (!ctx.handles.has(id)) this.checked.delete(id);
  }
}
