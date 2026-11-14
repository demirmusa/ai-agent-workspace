import { ControlError, type Question, type Run } from '../types.js';
import { jsonObject } from '../validation.js';
import { accumulateTime, now, runEnded, text } from './common.js';
import type { ControlContext } from './context.js';
import type { StateBroadcaster } from './broadcaster.js';
import type { Questions } from './questions.js';
import { serviceTiming } from './timing.js';

/** Transient states of live runs that decide what happens when a provider process exits. */
export class RunSignals {
  /** Paused by stopping the process (Windows native); resume starts a new turn. */
  readonly checkpoint = new Set<string>();
  readonly pausing = new Set<string>();
  /** Runs whose provider turn was cut short by the user; the console stays open and waits for the next instruction. */
  readonly interrupting = new Set<string>();
  /** Stream runs waiting for the next instruction after an interrupted turn. */
  readonly idle = new Set<string>();
  /** The run ends now; a pause in progress no longer applies. */
  ending(runId: string): void { this.checkpoint.delete(runId); this.pausing.delete(runId); }
}

export interface RunControlDependencies {
  signals: RunSignals;
  broadcaster: StateBroadcaster;
  questions: Pick<Questions, 'pending' | 'cancel' | 'answerInTerminal' | 'chooseInTerminal'>;
  launch(run: Run): void;
  finish(run: Run, status: Run['status'], code: number, message?: string): void;
  /** Forgets the native prompt seen on the run's screen. */
  clearPrompt(runId: string): void;
  usageLimitWaiting(runId: string): boolean;
  clearUsageWait(runId: string): void;
}

/** What the user does with a live run: pause, resume, stop, instruct, interrupt, type and resize its terminal. */
export class RunControls {
  constructor(private readonly ctx: ControlContext, private readonly deps: RunControlDependencies) {}

  async pause(runId: string): Promise<Run> {
    const run = this.ctx.run(runId); if (!['running', 'waiting'].includes(run.status)) throw new ControlError('Only running or waiting executions can pause.', 409);
    const handle = this.ctx.handles.get(runId); if (!handle) throw new ControlError('No active process to pause.', 409);
    const { signals } = this.deps;
    signals.pausing.add(runId);
    try {
      const mode = await handle.pause();
      // The run may have been stopped while its process was pausing.
      if (runEnded(run)) { signals.checkpoint.delete(runId); return structuredClone(run); }
      if (mode === 'checkpoint') signals.checkpoint.add(runId);
      accumulateTime(run);
      run.status = 'paused'; this.ctx.task(run.taskId).status = 'paused';
      this.ctx.event(runId, run.taskId, 'paused', mode === 'checkpoint' ? 'Windows native checkpoint: process stopped. Resume starts a new turn with the saved transcript.' : 'Process execution suspended.'); this.ctx.changed();
    } finally { signals.pausing.delete(runId); }
    return structuredClone(run);
  }
  async resume(runId: string): Promise<Run> {
    const run = this.ctx.run(runId); if (run.status !== 'paused') throw new ControlError('Only paused executions can resume.', 409);
    const { signals } = this.deps;
    if (signals.checkpoint.has(runId)) {
      // A Windows taskkill may report close just after the pause request returns.
      if (this.ctx.handles.has(runId)) throw new ControlError('Process is still stopping. Retry resume shortly.', 409);
      signals.checkpoint.delete(runId); run.continuation++; this.deps.launch(run);
    } else {
      await this.ctx.handles.get(runId)?.resume();
      // The run may have been stopped while its process was resuming.
      if (runEnded(run)) return structuredClone(run);
      run.status = 'running'; this.ctx.task(run.taskId).status = 'running';
      if (run.terminalMode === 'pty' && run.pendingCommands.length) { if (this.ctx.handles.get(runId)?.input) this.typeIntoTerminal(runId, run.pendingCommands.join('\n\n')); run.pendingCommands = []; }
    }
    if (this.deps.questions.pending(runId)) { run.status = 'waiting'; this.ctx.task(run.taskId).status = 'waiting'; }
    run.lastResumedAt = now();
    this.ctx.event(runId, run.taskId, 'resumed', 'Execution resumed.'); this.ctx.changed(); return structuredClone(run);
  }
  async stop(runId: string): Promise<Run> {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Execution has already ended.', 409);
    this.deps.clearUsageWait(runId);
    const { signals } = this.deps;
    signals.ending(runId); signals.idle.delete(runId); signals.interrupting.delete(runId); this.deps.finish(run, 'cancelled', 130, 'Stopped by user.');
    await this.ctx.handles.get(runId)?.stop(); return structuredClone(run);
  }
  command(runId: string, input: unknown): Run {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Start a new run to send further instructions.', 409);
    const message = text(jsonObject(input).message, 'message', 20_000).trim(); if (!message) throw new ControlError('Command text is required.');
    this.deps.clearUsageWait(runId);
    if (run.terminalMode === 'pty') {
      if (run.status === 'paused') { run.pendingCommands.push(message); this.ctx.event(runId, run.taskId, 'command.queued', 'Instruction queued for terminal resume.'); }
      else if (!this.ctx.handles.has(runId) && run.status === 'waiting') {
        run.pendingCommands.push(message); run.continuation++; run.status = 'running'; this.ctx.task(run.taskId).status = 'running';
        this.ctx.event(runId, run.taskId, 'command', message); this.ctx.changed(); this.deps.launch(run); return structuredClone(run);
      } else {
        // A TUI queues text typed while it works; Escape cuts the running turn first so the instruction is read now.
        try { this.input(runId, { data: '\u001b' }); } catch { /* No interactive terminal to interrupt. */ }
        setTimeout(() => { try { this.typeIntoTerminal(runId, message); } catch { /* The terminal closed meanwhile. */ } }, serviceTiming.terminalSubmitDelayMs).unref();
      }
      this.ctx.event(runId, run.taskId, 'command', message); this.ctx.changed(); return structuredClone(run);
    }
    run.pendingCommands.push(message); this.ctx.event(runId, run.taskId, 'command', message);
    // The instruction is the user's reply; questions left pending would keep the run in "needs you" after it resumes.
    if (this.deps.questions.cancel(runId, 'agent') && run.status === 'waiting' && this.ctx.handles.has(runId) && !this.deps.usageLimitWaiting(runId)) { run.status = 'running'; this.ctx.task(run.taskId).status = 'running'; }
    if (this.deps.signals.idle.delete(runId) || (!this.ctx.handles.has(runId) && run.status === 'waiting')) {
      run.status = 'running'; this.ctx.task(run.taskId).status = 'running'; run.continuation++; this.ctx.changed(); this.deps.launch(run); return structuredClone(run);
    }
    // The instruction waits for the current provider turn; deliverNow cuts the turn short on request.
    this.ctx.event(runId, run.taskId, 'command.queued', 'Instruction queued. It will automatically run as a continuation after the current provider turn.');
    this.ctx.changed(); return structuredClone(run);
  }
  /** Cuts the running provider turn so queued instructions continue the session right away. */
  deliverNow(runId: string): Run {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Execution has already ended.', 409);
    if (run.terminalMode !== 'pty' && run.pendingCommands.length && run.status === 'running' && this.ctx.handles.has(runId)) { this.ctx.event(runId, run.taskId, 'command.deliver', 'Queued instruction delivered now.'); this.cutTurn(runId); }
    this.ctx.changed(); return structuredClone(run);
  }
  /** Esc in the console: stops what the AI is doing without closing the run, which then waits for a message. */
  interrupt(runId: string): Run {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Execution has already ended.', 409);
    if (run.terminalMode === 'pty') { this.input(runId, { data: '\u001b' }); this.ctx.event(runId, run.taskId, 'interrupt', 'Escape sent to the terminal.'); this.ctx.changed(); return structuredClone(run); }
    if (run.status === 'paused' || !this.ctx.handles.has(runId)) throw new ControlError('The agent is not working right now.', 409);
    this.ctx.event(runId, run.taskId, 'interrupt', 'Current turn stopped by user.'); this.cutTurn(runId); this.ctx.changed(); return structuredClone(run);
  }
  /**
   * A native TUI reads text and Enter arriving in one chunk as a paste and keeps the
   * line in its editor, so Enter follows separately once the text has been taken in.
   */
  typeIntoTerminal(runId: string, message: string): void {
    this.input(runId, { data: message });
    setTimeout(() => { try { this.input(runId, { data: '\r' }); } catch { /* The terminal closed meanwhile. */ } }, serviceTiming.terminalSubmitDelayMs).unref();
  }
  /**
   * A reply from outside the terminal (a GitHub comment) to a native CLI dialog. An option number picks that option, as typing it
   * would; any other text dismisses the dialog and is typed as the agent's next instruction, so it can be told what to do instead.
   */
  answerNativePrompt(question: Question, reply: string): void {
    const runId = question.runId, choice = /^\s*([1-9])[.)]?\s*$/.exec(reply)?.[1];
    if (choice && question.prompt?.options[Number(choice) - 1]) {
      this.input(runId, { data: choice });
      // Some CLIs close the dialog on the number itself, others wait for Enter.
      setTimeout(() => { if (question.status === 'pending') try { this.input(runId, { data: '\r' }); } catch { /* The terminal closed meanwhile. */ } }, serviceTiming.terminalSubmitDelayMs).unref();
      return;
    }
    this.input(runId, { data: '\u001b' });
    setTimeout(() => { try { this.typeIntoTerminal(runId, reply); } catch { /* The terminal closed meanwhile. */ } }, serviceTiming.terminalSubmitDelayMs).unref();
  }
  terminal(runId: string): { mode: string; output: string; end: number; cols: number; rows: number; resizes: { offset: number; cols: number; rows: number }[]; interactive: boolean } {
    const run = this.ctx.run(runId), output = this.ctx.store.terminalOutput(run);
    return { mode: run.terminalMode ?? 'pty', output, end: run.terminalLength ?? output.length, cols: run.cols ?? 100, rows: run.rows ?? 30, resizes: run.terminalResizes ?? [], interactive: run.terminalMode === 'pty' && this.ctx.handles.has(runId) && !runEnded(run) };
  }
  input(runId: string, input: unknown): void {
    const run = this.ctx.run(runId); const data = text(jsonObject(input).data, 'data', 65536);
    const handle = this.ctx.handles.get(runId);
    if (run.terminalMode !== 'pty' || runEnded(run) || run.status === 'paused' || !handle?.input) throw new ControlError('Run does not have an active interactive terminal.', 409);
    handle.input(data); run.lastActivityAt = now();
    // Native prompts are answered in their own TUI, preserving provider-specific choices.
    if (/^[1-9]$/.test(data)) this.deps.questions.chooseInTerminal(runId, Number(data));
    if (/[\r\n]/.test(data) || data === '\u001b') {
      // Every Enter would otherwise publish the whole state; only a cleared prompt changes it. Enter answers the dialog, Esc dismisses it.
      if (/[\r\n]/.test(data)) this.deps.clearUsageWait(runId);
      // A reply typed into the terminal supersedes the agent's own questions too: the agent reads it there and moves on.
      const settled = data === '\u001b' ? this.deps.questions.cancel(runId, 'terminal') : this.deps.questions.answerInTerminal(runId);
      let changed = this.deps.questions.cancel(runId, 'agent') || settled;
      if (run.status === 'waiting' && !this.deps.questions.pending(runId) && !this.deps.usageLimitWaiting(runId)) { run.status = 'running'; this.ctx.task(run.taskId).status = 'running'; changed = true; }
      this.deps.clearPrompt(runId); if (changed) this.ctx.changed();
    }
  }
  /** The user cleared the console: the PTY clears its screen too, so the program keeps drawing from the top. */
  clear(runId: string): void { this.ctx.handles.get(runId)?.clear?.(); }
  resize(runId: string, input: unknown): void {
    const value = jsonObject(input); const cols = Number(value.cols); const rows = Number(value.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 3 || rows > 300) throw new ControlError('Terminal dimensions must be 10..500 columns and 3..300 rows.');
    const run = this.ctx.run(runId), handle = this.ctx.handles.get(runId); if (run.terminalMode !== 'pty' || !handle?.resize) throw new ControlError('Run has no interactive terminal.', 409);
    if (run.cols === cols && run.rows === rows) return;
    handle.resize(cols, rows);
    const resizes = run.terminalResizes ??= [{ offset: 0, cols: run.cols ?? 100, rows: run.rows ?? 30 }], offset = run.terminalLength ?? 0;
    // Resizes at the same offset collapse; keep the history bounded for long sessions.
    if (resizes.at(-1)!.offset === offset) resizes.pop();
    resizes.push({ offset, cols, rows }); if (resizes.length > 200) resizes.splice(1, resizes.length - 200);
    run.cols = cols; run.rows = rows;
    this.deps.broadcaster.updateRun({ id: run.id, cols, rows });
    this.deps.broadcaster.scheduleOutput();
  }
  private cutTurn(runId: string): void { this.deps.signals.interrupting.add(runId); void this.ctx.handles.get(runId)?.stop().catch(() => undefined); }
}
