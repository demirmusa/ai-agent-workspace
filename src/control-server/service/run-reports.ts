import { providerUsageResetAt, USAGE_LIMIT_CONTINUE_MESSAGE, usageLimitReason, usageLimitResetAt } from '../agent-handoff.js';
import type { ProviderUsage } from '../ai-providers/usage.js';
import { ControlError, type Run, type Task, type TaskMessage, type TaskSession } from '../types.js';
import { jsonObject } from '../validation.js';
import { now, runEnded, text } from './common.js';
import type { ControlContext } from './context.js';
import { serviceTiming } from './timing.js';

export interface RunReportsDependencies {
  usageSource(): (() => Promise<ProviderUsage[]>) | undefined;
  clearPrompt(runId: string): void;
  typeIntoTerminal(runId: string, message: string): void;
  launch(run: Run): void;
  sendTaskMessage(taskId: string, input: unknown, author?: 'user' | 'system'): Promise<TaskMessage | null>;
  restartTask(taskId: string): Run;
}

interface UsageLimitWait {
  taskId: string;
  reason: string;
  resetsAt?: string;
  resumeAt?: string;
  lastLookupAt: number;
}

/** What agents and providers report about a run: its final reply, provider session and a reached usage limit. */
export class RunReports {
  /** Runs waiting for their provider's usage window to reset (+1 minute margin) before continuing. */
  readonly waits = new Map<string, UsageLimitWait>();
  private readonly lookingUp = new Set<string>();
  constructor(private readonly ctx: ControlContext, private readonly deps: RunReportsDependencies) {
    for (const task of ctx.state.tasks) {
      const req = task.handoffRequest;
      if (req && task.currentRunId === req.runId) {
        this.waits.set(req.runId, { taskId: task.id, reason: req.reason, ...(req.resetsAt ? { resetsAt: req.resetsAt } : {}), ...(req.resumeAt ? { resumeAt: req.resumeAt } : {}), lastLookupAt: 0 });
      }
    }
  }

  reply(runId: string, input: unknown): Run {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Run has already ended.', 409);
    const value = text(jsonObject(input).text, 'text', 50_000).trim(); if (!value) throw new ControlError('Reply text is required.');
    run.reply = run.reply ? `${run.reply}\n\n${value}` : value;
    this.ctx.addMessage(run.taskId, 'agent', value, run); this.ctx.event(runId, run.taskId, 'reply', value); this.ctx.changed(); return structuredClone(run);
  }
  /** An agent records the provider session it works in, so follow-ups and merge recovery resume it. */
  reportSession(runId: string, input: unknown): TaskSession {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Run has already ended.', 409);
    if (run.provider === 'command') throw new ControlError('Custom command runs have no resumable provider session.', 409);
    const value = jsonObject(input);
    const sessionId = text(value.sessionId, 'sessionId', 200).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sessionId)) throw new ControlError('sessionId must be a provider session ID.');
    const model = value.model === undefined ? undefined : text(value.model, 'model', 200).trim() || undefined;
    if (!run.historyResume) run.sessionId = sessionId;
    const session = this.recordSession(run, sessionId, 'agent', model); this.ctx.changed(); return structuredClone(session);
  }
  recordSession(run: Run, sessionId: string, source: TaskSession['source'], model?: string): TaskSession {
    const task = this.ctx.task(run.taskId); const agent = run.executionSnapshot?.agent;
    const sessions = task.sessions ??= [];
    const index = sessions.findIndex((entry) => entry.provider === run.provider && entry.sessionId.toLowerCase() === sessionId.toLowerCase());
    const previous = index < 0 ? undefined : sessions.splice(index, 1)[0];
    // A session is trusted once the agent or provider confirmed it; a preassigned ID alone is not.
    const resolved = model ?? previous?.model ?? run.executionInfo?.model;
    const session: TaskSession = { runId: run.id, provider: run.provider as TaskSession['provider'], sessionId, agentId: agent?.id ?? null, agentName: agent?.name ?? run.provider, ...(resolved ? { model: resolved } : {}), source: previous && previous.source !== 'assigned' ? previous.source : source, recordedAt: now() };
    sessions.push(session); task.sessions = sessions.slice(-20);
    if (!previous || previous.source !== session.source) this.ctx.event(run.id, task.id, 'session', `${source === 'assigned' ? 'Assigned' : 'Recorded'} ${run.provider} session ${sessionId}${session.model ? ` with model ${session.model}` : ''}.`);
    return session;
  }
  /** Whether the run is waiting for its provider's quota reset. */
  waitingForReset(runId: string): boolean {
    const wait = this.waits.get(runId);
    return Boolean(wait && (this.ctx.handles.has(runId) || wait.resumeAt || this.deps.usageSource() || this.lookingUp.has(runId)));
  }
  /** Clears an automatic quota-reset wait once the user manually continues or stops the run. */
  clearWait(runId: string): void {
    const wait = this.waits.get(runId); if (!wait) return;
    this.waits.delete(runId);
    const task = this.ctx.state.tasks.find((entry) => entry.id === wait.taskId);
    if (task?.handoffRequest?.runId === runId) delete task.handoffRequest;
  }
  /** A provider reported that the account ran out of tokens: wait for the quota reset (+1 min) and let the user hand off earlier if desired. */
  detectUsageLimit(run: Run, output: string): void {
    const task = this.ctx.state.tasks.find((entry) => entry.id === run.taskId);
    if (!task || this.waits.has(run.id) || task.handoffRequest?.runId === run.id || task.currentRunId !== run.id) return;
    const reason = usageLimitReason(output); if (!reason) return;
    const current = Date.now();
    const agentName = run.executionSnapshot?.agent?.name ?? run.provider;
    const resetMs = usageLimitResetAt(output, current);
    const times: { resetsAt?: string; resumeAt?: string } = resetMs && resetMs > current ? this.resumeTimes(resetMs) : {};
    task.handoffRequest = { runId: run.id, provider: run.provider, agentName, reason, detectedAt: new Date(current).toISOString(), ...times };
    this.waits.set(run.id, { taskId: task.id, reason, ...times, lastLookupAt: 0 });
    if (!runEnded(run) && run.status !== 'paused') { run.status = 'waiting'; task.status = 'waiting'; }
    task.updatedAt = now();
    this.ctx.event(run.id, task.id, 'agent.limit', `${agentName} reached its usage limit: ${reason}${times.resumeAt ? ` (continuing at ${times.resumeAt})` : ''}`);
    this.ctx.addMessage(task.id, 'system', times.resumeAt
      ? `${agentName} ran out of tokens (${reason}). Waiting until ${times.resumeAt} (+1 min after quota reset) to continue automatically, or choose another agent.`
      : `${agentName} ran out of tokens (${reason}). Waiting for the quota reset to continue automatically, or choose another agent to continue the task.`, run);
    this.ctx.changed();
    if (!times.resumeAt) this.lookupResetAt(run.id, current);
  }
  dismissHandoff(taskId: string): Task {
    const task = this.ctx.task(taskId); delete task.handoffRequest; task.updatedAt = now(); this.ctx.changed(); return structuredClone(task);
  }
  tick(current: number): void {
    for (const task of this.ctx.state.tasks) {
      const req = task.handoffRequest;
      if (!req || task.currentRunId !== req.runId) continue;
      const existing = this.waits.get(req.runId);
      if (!existing) this.waits.set(req.runId, { taskId: task.id, reason: req.reason, ...(req.resetsAt ? { resetsAt: req.resetsAt } : {}), ...(req.resumeAt ? { resumeAt: req.resumeAt } : {}), lastLookupAt: 0 });
      else if (req.resumeAt && req.resumeAt !== existing.resumeAt) { if (req.resetsAt) existing.resetsAt = req.resetsAt; existing.resumeAt = req.resumeAt; }
    }
    for (const [runId, wait] of this.waits) {
      const task = this.ctx.state.tasks.find((item) => item.id === wait.taskId);
      const run = this.ctx.state.runs.find((item) => item.id === runId);
      if (!task || !run || task.archivedAt || task.currentRunId !== run.id || ['completed', 'cancelled'].includes(run.status)
        || (!this.ctx.handles.has(run.id) && runEnded(run) && !wait.resumeAt && !this.deps.usageSource() && !this.lookingUp.has(runId))) {
        this.waits.delete(runId); continue;
      }
      if (run.status === 'paused') continue;
      if (!wait.resumeAt) {
        if (current - wait.lastLookupAt >= 60_000) this.lookupResetAt(runId, current);
        continue;
      }
      const dueAt = Date.parse(wait.resumeAt);
      if (!Number.isFinite(dueAt) || current < dueAt) continue;
      this.resumeAfterLimit(task, run);
    }
  }
  private resumeTimes(resetMs: number): { resetsAt: string; resumeAt: string } {
    return { resetsAt: new Date(resetMs).toISOString(), resumeAt: new Date(resetMs + serviceTiming.usageLimitGraceMs).toISOString() };
  }
  private lookupResetAt(runId: string, current: number): void {
    const source = this.deps.usageSource(), wait = this.waits.get(runId);
    if (!source || !wait || this.lookingUp.has(runId)) return;
    const run = this.ctx.state.runs.find((item) => item.id === runId);
    if (!run) return;
    wait.lastLookupAt = current;
    this.lookingUp.add(runId);
    void source().then((usage) => {
      if (this.ctx.closing || this.waits.get(runId) !== wait) return;
      const at = Date.now(), resetMs = providerUsageResetAt(run.provider, run.executionSnapshot?.account, wait.reason, usage, at);
      if (!resetMs || resetMs <= at) return;
      const times = this.resumeTimes(resetMs);
      Object.assign(wait, times);
      const task = this.ctx.state.tasks.find((item) => item.id === wait.taskId);
      if (!task || task.currentRunId !== run.id) return;
      if (task.handoffRequest?.runId === run.id) Object.assign(task.handoffRequest, times);
      if (!runEnded(run) && run.status !== 'paused') { run.status = 'waiting'; task.status = 'waiting'; }
      task.updatedAt = now();
      const agentName = run.executionSnapshot?.agent?.name ?? run.provider;
      this.ctx.event(run.id, task.id, 'agent.waiting', `${agentName} quota resets at ${times.resetsAt}; continuing automatically at ${times.resumeAt}.`);
      this.ctx.changed();
    }, () => {}).finally(() => { this.lookingUp.delete(runId); });
  }
  private resumeAfterLimit(task: Task, run: Run): void {
    this.waits.delete(run.id);
    if (task.handoffRequest?.runId === run.id) delete task.handoffRequest;
    const agentName = run.executionSnapshot?.agent?.name ?? run.provider;
    if (run.terminalMode === 'pty' && this.ctx.handles.has(run.id) && !runEnded(run)) {
      this.deps.clearPrompt(run.id);
      run.status = 'running'; task.status = 'running'; task.updatedAt = now();
      this.ctx.event(run.id, task.id, 'agent.resume', `${agentName} quota reset time reached. Continuing from where it left off.`);
      this.ctx.addMessage(task.id, 'system', `${agentName} quota reset time reached. Sent continuation request to the CLI.`, run);
      try { this.deps.typeIntoTerminal(run.id, USAGE_LIMIT_CONTINUE_MESSAGE); } catch { /* The terminal closed meanwhile. */ }
      this.ctx.changed();
      return;
    }
    if (!runEnded(run)) {
      run.status = 'running'; task.status = 'running'; task.updatedAt = now();
      this.ctx.event(run.id, task.id, 'agent.resume', `${agentName} quota reset time reached. Continuing from where it left off.`);
      this.ctx.addMessage(task.id, 'system', `${agentName} quota reset time reached. Sent continuation request to the CLI.`, run);
      run.pendingCommands.push(USAGE_LIMIT_CONTINUE_MESSAGE);
      run.continuation++;
      this.ctx.changed();
      this.deps.launch(run);
      return;
    }
    this.ctx.event(run.id, task.id, 'agent.resume', `${agentName} quota reset time reached. Continuing from where it left off.`);
    this.ctx.changed();
    this.ctx.background(this.deps.sendTaskMessage(task.id, { text: USAGE_LIMIT_CONTINUE_MESSAGE, continueSession: true, allowHistoryFallback: true }, 'system')
      .catch(() => { try { this.deps.restartTask(task.id); } catch { /* Task can no longer restart. */ } }));
  }
}
