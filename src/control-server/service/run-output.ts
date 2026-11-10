import { detectInputRequest } from '../input-request.js';
import { UsageTally } from '../run-usage.js';
import { TerminalScreen } from '../terminal-screen.js';
import type { Question, Run, RunUsage, Task, TaskSession, TerminalPrompt } from '../types.js';
import type { StateBroadcaster } from './broadcaster.js';
import { now } from './common.js';
import type { ControlContext } from './context.js';
import { parseStreamLine, readStreamLine } from './stream-lines.js';

/** Output after a resize within which the TUI's repaint is still arriving. */
const REPAINT_SPAN = 8000;

export interface RunOutputDependencies {
  broadcaster: StateBroadcaster;
  ask(runId: string, input: unknown, prompt?: TerminalPrompt): Question;
  detectUsageLimit(run: Run, output: string): void;
  recordSession(run: Run, sessionId: string, source: TaskSession['source']): void;
  /** The run has an unanswered question or native prompt. */
  pendingQuestion(runId: string): boolean;
  /** The run is waiting for its provider's usage limit to reset. */
  usageLimitWaiting(runId: string): boolean;
  /** A native dialog left the screen without an Enter. */
  dialogClosed(question: Question): void;
}

/** Reads one provider process: journals its output and reports the first failure of its turn. */
export interface OutputReader {
  write(stream: 'stdout' | 'stderr' | 'terminal', value: string): void;
  /** Reads a last stdout line without a line break. */
  end(): void;
  readonly failure: string | undefined;
}

/**
 * Watches provider output: stream-json records (model, session, failures, answers,
 * token usage) and the native terminal screen (input requests and usage limits).
 */
export class RunOutput {
  /** The virtual screen of each live process, the screen that prompts are recognized on. */
  private screens = new Map<string, TerminalScreen>();
  /** What each live process drew since the last Enter typed into it; a notice answered by that Enter is not on it. */
  private recentScreens = new Map<string, TerminalScreen>();
  /** The native request text each screen shows, and the one answered from the terminal while it is still drawn. */
  private shownRequests = new Map<string, string>();
  private dismissedRequests = new Map<string, string>();
  /** Terminal offset at which each run's pending native prompt was recognized. */
  private promptOffsets = new Map<string, number>();
  /** Token readings of runs still streaming output. */
  private usageTallies = new Map<string, UsageTally>();
  constructor(private readonly ctx: ControlContext, private readonly deps: RunOutputDependencies) {}

  /** The lines a live run drew since the last Enter typed into it. */
  screen(runId: string): string[] { return this.recentScreens.get(runId)?.logicalText() ?? []; }
  /** Enter was typed into the terminal; a dialog it answered stays drawn until the TUI repaints and is not asked again. */
  clearPrompt(runId: string): void {
    const shown = this.shownRequests.get(runId); if (shown) this.dismissedRequests.set(runId, shown);
    this.recentScreens.delete(runId);
  }
  /** The run's process exited. */
  closed(runId: string): void { for (const map of [this.screens, this.recentScreens, this.shownRequests, this.dismissedRequests, this.promptOffsets]) map.delete(runId); }
  takeUsage(runId: string): RunUsage | undefined { const usage = this.usageTallies.get(runId)?.result(); this.usageTallies.delete(runId); return usage; }
  reader(run: Run, task: Task): OutputReader {
    let line = '', failure: string | undefined;
    const consume = (chunk: string): void => {
      try {
        const message = parseStreamLine(chunk); if (!message) return;
        const info = readStreamLine(run.provider, message);
        if (info.usage) { let tally = this.usageTallies.get(run.id); if (!tally) this.usageTallies.set(run.id, tally = new UsageTally()); tally.add(info.usage); }
        if (info.model) run.executionInfo = { ...run.executionInfo, model: info.model, modelSource: 'reported' };
        if (info.sessionId) {
          if (run.historyResume && info.sessionId.toLowerCase() !== run.historyResume.sessionId.toLowerCase()) {
            failure ??= 'Provider opened a different session instead of resuming the selected session. Inspect the provider session state before retrying.';
            this.ctx.event(run.id, task.id, 'provider.error', failure);
          } else if (run.sessionId !== info.sessionId || !task.sessions?.some((entry) => entry.sessionId === info.sessionId && entry.source !== 'assigned')) { run.sessionId = info.sessionId; this.deps.recordSession(run, info.sessionId, 'provider'); }
        }
        if (info.failure !== undefined) {
          failure ??= info.failure;
          this.ctx.event(run.id, task.id, 'provider.error', info.failure);
          this.deps.detectUsageLimit(run, info.failure);
        }
        if (info.question) this.deps.ask(run.id, { text: info.question.text, kind: info.question.kind });
        if (info.text?.trim() && this.ctx.state.messages.at(-1)?.text !== info.text) this.ctx.addMessage(task.id, 'agent', info.text, run);
      } catch { /* Provider log lines need not be JSON. */ if (run.provider !== 'command') this.deps.detectUsageLimit(run, chunk); }
    };
    return {
      write: (stream, value) => {
        run.lastActivityAt = now();
        if (stream !== 'terminal') { this.ctx.event(run.id, task.id, stream, value); this.ctx.store.scheduleSave(1000); }
        if (stream === 'stderr' && run.provider !== 'command') this.deps.detectUsageLimit(run, value);
        if (stream === 'terminal') this.terminal(run, task, value);
        if (stream === 'stdout') {
          line += value; const lines = line.split('\n'); line = lines.pop()?.slice(-100_000) ?? '';
          for (const chunk of lines) consume(chunk);
        }
        this.deps.broadcaster.scheduleOutput();
      },
      end: () => { if (line.trim()) { consume(line); line = ''; } },
      get failure() { return failure; },
    };
  }
  private terminal(run: Run, task: Task, value: string): void {
    // The replay lives outside the event journal; a PTY repaints far too often to journal it.
    this.deps.broadcaster.terminal(run.id, this.ctx.store.appendTerminal(run, value), value);
    const [screen, recent] = [this.screens, this.recentScreens].map((screens) => {
      let screen = screens.get(run.id);
      if (!screen) { screen = new TerminalScreen(run.rows ?? 30); screens.set(run.id, screen); }
      screen.resize(run.cols ?? 100, run.rows ?? 30);
      screen.write(value);
      return screen;
    }) as [TerminalScreen, TerminalScreen];
    // Only the visible screen counts: a limit notice the TUI shows, not one scrolling past in tool output.
    if (/limit|quota|exhaust|usage/i.test(value)) this.deps.detectUsageLimit(run, recent.logicalText().slice(-8).join('\n'));
    const lines = screen.text();
    const pending = this.ctx.state.questions.filter((question) => question.runId === run.id && question.status === 'pending');
    const nativePrompt = pending.find((question) => question.source === 'terminal');
    // A resize after the prompt appeared makes the TUI repaint at the new size; until the repaint is through, the screen is a
    // blend of both sizes that would rewrite the prompt, resize the console that shows it, and trigger the next repaint.
    const resizedAt = run.terminalResizes?.at(-1)?.offset ?? 0;
    const repainting = nativePrompt && resizedAt >= (this.promptOffsets.get(run.id) ?? Infinity) && (run.terminalLength ?? 0) - resizedAt < REPAINT_SPAN;
    if ((pending.length && !nativePrompt) || repainting) return;
    const shown = detectInputRequest(lines, { cols: run.cols ?? 100, rows: run.rows ?? 30 });
    if (shown) this.shownRequests.set(run.id, shown.text); else this.shownRequests.delete(run.id);
    if (shown?.text !== this.dismissedRequests.get(run.id)) this.dismissedRequests.delete(run.id);
    const request = shown && !this.dismissedRequests.has(run.id) ? shown : null;
    if (request && !nativePrompt) { this.deps.ask(run.id, { text: request.text, kind: request.kind, source: 'terminal' }, request.prompt); this.promptOffsets.set(run.id, run.terminalLength ?? 0); }
    // A dialog may arrive across several chunks; keep the pending request in step with the screen.
    else if (request && nativePrompt && request.kind === nativePrompt.kind && (request.text !== nativePrompt.text || JSON.stringify(request.prompt) !== JSON.stringify(nativePrompt.prompt))) {
      nativePrompt.text = request.text; if (request.prompt) nativePrompt.prompt = request.prompt; else delete nativePrompt.prompt;
      this.ctx.changed();
    }
    // The dialog left the screen (answered in the TUI, or never was one): drop the stale request.
    else if (!request && nativePrompt) {
      this.deps.dialogClosed(nativePrompt);
      if (run.status === 'waiting' && !this.deps.pendingQuestion(run.id) && !this.deps.usageLimitWaiting(run.id)) { run.status = 'running'; task.status = 'running'; }
      this.ctx.changed();
    }
  }
}
