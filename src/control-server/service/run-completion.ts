import { aiProviders } from '../ai-providers/index.js';
import type { SessionHistory } from '../history.js';
import { readTranscriptUsage } from '../run-usage.js';
import { ControlError, type Run, type RunUsage, type Task, type TokenCounts } from '../types.js';
import { jsonObject } from '../validation.js';
import { nextWorkflowStep, selectWorkflow, snapshotWorkflow } from '../workflows.js';
import { accumulateTime, delay, now, runEnded, text } from './common.js';
import type { ControlContext } from './context.js';
import { readSessionPages, runSessionPointer } from './provider-history.js';
import type { RunSignals } from './run-controls.js';
import { providerAnswer } from './stream-lines.js';
import { serviceTiming } from './timing.js';

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;

export interface RunCompletionDependencies {
  history: SessionHistory;
  signals: RunSignals;
  /** Automatic merge applies to the task's completed work. */
  autoMerge(task: Task): boolean;
  hasMergeTarget(task: Task): boolean;
  /** Starts merging the task in the background when it is due. */
  mergeIfDue(task: Task): void;
  recheckGitHubRemote(task: Task): void;
  cancelQuestions(runId: string): void;
  /** Tokens the run's stream output reported, removed from the live tally. */
  takeUsage(runId: string): RunUsage | undefined;
  reply(runId: string, input: unknown): Run;
  postRunReply(task: Task, run: Run, status: Run['status'], summary?: string): void;
}

/** Ends runs: their outcome, task status, workflow advance, usage, the last native answer and the process exit. */
export class RunCompletion {
  /** Explicitly completed runs whose provider is still producing its final answer. */
  private settling = new Map<string, NodeJS.Timeout>();
  constructor(private readonly ctx: ControlContext, private readonly deps: RunCompletionDependencies) {}

  isSettling(runId: string): boolean { return this.settling.has(runId); }
  finish(run: Run, status: Run['status'], code: number, message?: string): void {
    accumulateTime(run);
    run.status = status; run.exitCode = code; run.finishedAt = now(); delete run.pid;
    this.recordUsage(run);
    const task = this.ctx.task(run.taskId);
    const autoMerge = this.deps.autoMerge(task);
    task.status = status === 'completed' ? (autoMerge ? (this.deps.hasMergeTarget(task) ? 'completing' : 'done') : 'review') : status === 'cancelled' ? 'cancelled' : 'failed'; task.updatedAt = now();
    this.deps.cancelQuestions(run.id);
    this.ctx.addMessage(task.id, 'system', message ?? `Execution ${status}.`, run);
    if (status === 'completed' && !task.workflowProgress && task.requestedActions?.includes('deploy')) {
      try {
        const definition = selectWorkflow(task, this.ctx.project(task.projectId), this.ctx.state.workflows);
        if (definition) {
          task.workflowProgress = { definition: snapshotWorkflow(definition, task), stepIndex: definition.steps.findIndex((step) => step.agentId === run.executionSnapshot?.agent?.id), status: 'running' };
        } else this.ctx.addMessage(task.id, 'system', 'Deployment was requested, but no configured delivery workflow is available. Configure one before deployment.', run);
      } catch (error) { this.ctx.addMessage(task.id, 'system', `Delivery workflow needs configuration: ${(error as Error).message}`, run); }
    }
    if (task.workflowProgress?.status === 'running') {
      if (status === 'completed') {
        const next = nextWorkflowStep(task.workflowProgress.definition, task.workflowProgress.stepIndex, task);
        if (next !== null) { task.workflowProgress.stepIndex = next; task.status = 'ready'; this.ctx.event(run.id, task.id, 'workflow.next', `Next stage: ${task.workflowProgress.definition.steps[next]!.name}`); }
        else task.workflowProgress.status = 'completed';
      } else task.workflowProgress.status = 'failed';
    }
    this.ctx.event(run.id, task.id, status, message ?? (status === 'completed' ? (task.status === 'ready' ? 'Provider finished. Continuing the workflow.' : autoMerge ? 'Provider finished. Finalizing merge and cleanup with automatic merge enabled.' : 'Provider finished. Review the workspace and results.') : `Execution ${status} (exit ${code}).`));
    if (status === 'completed' && autoMerge && task.status === 'done' && !this.deps.hasMergeTarget(task)) {
      this.ctx.event(run.id, task.id, 'merge.skipped', 'Task completed without merging: no task worktree, pull request or linked GitHub issue is available. Enable project Git worktrees for future local tasks, or link a task pull request for GitHub merging.');
    }
    this.ctx.changed();
    this.deps.recheckGitHubRemote(task);
    this.deps.mergeIfDue(task);
    if ((status === 'completed' || status === 'failed') && !this.ctx.closing && (run.reply || task.status !== 'ready')) this.deps.postRunReply(task, run, status, message);
  }
  complete(runId: string, input: unknown): Run {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Run has already ended.', 409);
    const value = jsonObject(input); const success = value.success ?? true; if (typeof success !== 'boolean') throw new ControlError('success must be boolean.');
    if (value.reply !== undefined) this.deps.reply(runId, { text: value.reply });
    this.finish(run, success ? 'completed' : 'failed', success ? 0 : 1, text(value.summary, 'summary', 20000, success ? 'Work explicitly completed.' : 'Work explicitly failed.'));
    this.settle(run);
    return structuredClone(run);
  }
  /**
   * Moving a task to done ends its execution: an active run is stopped, and the agent
   * process tree (including a completed run's lingering terminal) exits before the move.
   */
  async releaseForDone(task: Task): Promise<void> { await this.releaseForMove(task, 'done'); }
  /** Cancelling a task stops its active run the same way; the task ends as cancelled. */
  async releaseForCancel(task: Task): Promise<void> { await this.releaseForMove(task, 'cancelled'); }
  private async releaseForMove(task: Task, target: 'done' | 'cancelled'): Promise<void> {
    const run = task.currentRunId ? this.ctx.run(task.currentRunId) : undefined;
    if (!run || !this.ctx.busy(run)) return;
    if (!runEnded(run)) {
      this.deps.signals.ending(run.id);
      this.finish(run, 'cancelled', 130, target === 'done' ? 'Task marked done by user. The agent terminal was closed.' : 'Task cancelled by user. The agent terminal was closed.');
      // The work is accepted as finished, so a worktree is merged as it would be from review.
      if (target === 'done') { task.status = 'review'; task.updatedAt = now(); this.ctx.changed(); }
    }
    await this.release(run);
    if (this.ctx.handles.has(run.id)) throw new ControlError('The agent process is still stopping. Retry shortly.', 409);
  }
  /** Copies the answer of a completed native TUI, then stops its process and waits briefly for it to exit. */
  async release(run: Run): Promise<void> {
    const timer = this.settling.get(run.id); if (timer) clearTimeout(timer); this.settling.delete(run.id);
    await this.captureNativeAnswer(run);
    const handle = this.ctx.handles.get(run.id); if (!handle) return;
    await handle.stop().catch(() => {});
    for (let waited = 0; this.ctx.handles.get(run.id) === handle && waited < 5000; waited += 50) await delay(50);
  }
  close(): void { for (const timer of this.settling.values()) clearTimeout(timer); this.settling.clear(); }
  /**
   * The completion command is a tool call inside the provider's turn; the agent's
   * answer usually follows it. Stopping the process right away lost that answer,
   * so a stream process may end its turn on its own and a native TUI is stopped
   * once its output has gone quiet. Both are bounded.
   */
  private settle(run: Run): void {
    // Custom command providers have no answer protocol after completion; they only get a short grace.
    const started = Date.now(), limit = run.terminalMode === 'pty' ? 60_000 : 120_000, quietLimit = run.provider === 'command' ? 1000 : run.terminalMode === 'pty' ? serviceTiming.completionQuietMs : Infinity;
    const check = (): void => {
      this.settling.delete(run.id);
      if (!this.ctx.handles.has(run.id) || this.ctx.closing) return;
      const quiet = Date.now() - Math.max(started, Date.parse(run.lastActivityAt ?? '') || 0);
      if (Date.now() - started < limit && quiet < quietLimit) { this.settling.set(run.id, setTimeout(check, 200).unref()); return; }
      void this.release(run);
    };
    this.settling.set(run.id, setTimeout(check, 200).unref());
  }
  /** A native TUI answer lives only in the provider session; copy the last one into the conversation. */
  async captureNativeAnswer(run: Run): Promise<void> {
    if (run.terminalMode !== 'pty' || run.executionMode !== 'native' || !aiProviders.isHistoryProvider(run.provider) || this.ctx.closing) return;
    try {
      const task = this.ctx.task(run.taskId);
      const pointer = await runSessionPointer(this.deps.history, this.ctx.runProject(run), run, run.provider);
      if (!pointer) return;
      const started = Date.parse(run.startedAt); let answer = '';
      await readSessionPages(this.deps.history, pointer, (page) => { for (const event of page.events) if (Date.parse(event.createdAt) >= started) answer = providerAnswer(event.message) || answer; });
      answer = answer.trim();
      if (!answer || !this.ctx.state.tasks.includes(task) || this.ctx.state.messages.some((message) => message.runId === run.id && message.authorType === 'agent' && message.text.trim() === answer.slice(0, 30000).trim())) return;
      this.ctx.addMessage(task.id, 'agent', answer, run); this.ctx.changed();
    } catch { /* The provider history is optional evidence; the terminal replay remains. */ }
  }
  /** Keeps the run's tokens and only the cost its client reported; a run without stream output is read from the provider's session transcript and the session cost the client recorded. */
  private recordUsage(run: Run): void {
    const streamed = this.deps.takeUsage(run.id);
    if (streamed) {
      const before = run.usage;
      run.usage = !before ? streamed : { ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, before[key] + streamed[key]])) as unknown as TokenCounts,
        costUsd: before.costUsd === null && streamed.costUsd === null ? null : (before.costUsd ?? 0) + (streamed.costUsd ?? 0), recordedAt: streamed.recordedAt };
      return;
    }
    if (run.usage || run.provider === 'command' || !run.sessionId) return;
    const provider = aiProviders.get(run.provider); const sessionId = run.sessionId;
    if (!provider) return;
    const historyProvider = aiProviders.isHistoryProvider(run.provider) ? run.provider : undefined;
    this.ctx.background((async () => {
      const found = historyProvider ? await this.deps.history.findRunSession(historyProvider, run.workspacePath ?? this.ctx.runProject(run).repositoryPath, { sessionId, startedAt: run.startedAt }) : undefined;
      const usage = found?.pointer ? await readTranscriptUsage(found.pointer.path, (message) => provider.readTranscriptUsage(message)) : undefined;
      if (!usage || run.usage) return;
      const costUsd = await provider.readSessionCost(sessionId).catch(() => undefined);
      run.usage = costUsd === undefined ? usage : { ...usage, costUsd }; this.ctx.changed();
    })());
  }
}
