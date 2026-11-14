import { compactedContext, handoffBrief, handoffTranscript, validateHandoffMode } from '../agent-handoff.js';
import { aiProviders } from '../ai-providers/index.js';
import type { ControlCatalog } from '../catalog.js';
import type { HistoryPointer, SessionHistory } from '../history.js';
import { compactConversation } from '../history-compact.js';
import { transferTranscript } from '../history-transfer.js';
import type { LiveSessions } from '../live-sessions.js';
import { ControlError, type AgentHandoffMode, type ControlEvent, type DefaultProvider, type Run, type Task, type TaskMessage, type TaskSession } from '../types.js';
import { jsonObject } from '../validation.js';
import { discardRestoredWorktree, prepareTaskWorktree, worktreeNeedsRestore } from '../worktrees.js';
import { continuationQueuedAt, delay, now, restoreTask, runEnded, terminalTranscript, text } from './common.js';
import type { ControlContext } from './context.js';
import { bootstrapPointer, readSessionPages, readSessionTranscript, runSessionPointer } from './provider-history.js';
import { CONTINUE_MESSAGE } from './run-prompt.js';
import type { RunSignals } from './run-controls.js';

const HISTORY_LIMIT = 16_000_000;
const tooLong = (): ControlError => new ControlError('Conversation history exceeds the transfer read limit. No new session was created.', 409);
const CONVERSATION_EVENTS = new Set(['stdout', 'stderr', 'command', 'answer', 'completed', 'failed']);

export interface ConversationDependencies {
  history: SessionHistory;
  liveSessions: LiveSessions;
  catalog: ControlCatalog;
  signals: RunSignals;
  /** Public entry points used for nested calls, so service overrides apply to them as well. */
  startTask(taskId: string): Run;
  sendTaskMessage(taskId: string, input: unknown, author?: 'user' | 'system'): Promise<TaskMessage | null>;
  postMessage(taskId: string, input: unknown): TaskMessage;
  /** Starts a run of the task; `mergeRecovery` reuses the previous execution snapshot for a merge-conflict instruction. */
  startRun(taskId: string, restarting: boolean, mergeRecovery?: string): Run;
  createTask(input: unknown): Task;
  answer(questionId: string, input: unknown): unknown;
  command(runId: string, input: unknown): Run;
  finish(run: Run, status: Run['status'], code: number, message?: string): void;
  isSettling(runId: string): boolean;
  /** Stops a completed run's process after copying its last native answer. */
  release(run: Run): Promise<void>;
  assertDeliveryIdle(task: Task): void;
  /** Why the task cannot take an execution slot now. */
  capacityError(task: Task): ControlError | undefined;
  /** Types the message into a running project terminal of one of these provider sessions; false when none is open. */
  typeIntoSessionTerminal(projectId: string, sessionIds: readonly string[], message: string): boolean;
}

/**
 * Task conversations: messages, continuing the provider session of a task, queued
 * continuations, forks, conversation transfers to a new session and agent handoffs.
 */
export class Conversations {
  /** Tasks with a session operation in progress; each task runs one at a time. */
  private continuingTasks = new Set<string>();
  constructor(private readonly ctx: ControlContext, private readonly deps: ConversationDependencies) {}

  continuing(taskId: string): boolean { return this.continuingTasks.has(taskId); }
  postMessage(taskId: string, input: unknown): TaskMessage {
    const { ctx } = this, task = ctx.task(taskId); const value = jsonObject(input); const message = text(value.text, 'text', 30000).trim(); if (!message) throw new ControlError('Message is required.');
    const authorType = value.authorType ?? 'user'; if (!['user', 'agent'].includes(String(authorType))) throw new ControlError('authorType must be user or agent.');
    const run = typeof value.runId === 'string' ? ctx.run(value.runId) : task.currentRunId ? ctx.run(task.currentRunId) : undefined;
    if (run && run.taskId !== taskId) throw new ControlError('Message run belongs to another task.');
    const agent = value.agentId !== undefined && value.agentId !== null ? this.deps.catalog.agent(String(value.agentId)) : undefined;
    const open = authorType === 'user' && run && !runEnded(run) ? ctx.state.questions.filter((question) => question.runId === run.id && question.status === 'pending' && question.source !== 'terminal') : [];
    // A reply typed in the conversation answers the agent's open question; otherwise the card keeps waiting.
    if (open.length) for (const question of open) this.deps.answer(question.id, { answer: message });
    else if (authorType === 'user' && run && !runEnded(run)) this.deps.command(run.id, { message });
    const result = ctx.addMessage(taskId, authorType as 'user' | 'agent', message, run);
    if (agent) { result.agentId = agent.id; if (authorType === 'agent') result.authorName = agent.name; }
    ctx.changed(); return structuredClone(result);
  }
  /**
   * Reopens the task's provider session in a native terminal without a new turn, so
   * the user can keep talking to the same agent from Agent Console or the chat.
   */
  async resumeTaskSession(taskId: string, input: unknown = {}): Promise<{ task: Task; run?: Run }> {
    const value = jsonObject(input);
    await this.deps.sendTaskMessage(taskId, { text: value.message ?? '', continueSession: true, openSession: true });
    const task = this.ctx.task(taskId);
    return { task: structuredClone(task), ...(task.queuedContinuation ? {} : { run: structuredClone(this.ctx.run(task.currentRunId!)) }) };
  }
  async startQueuedTask(taskId: string, input: unknown = {}): Promise<Run> {
    const task = this.ctx.task(taskId); const value = jsonObject(input);
    if (!task.queuedContinuation) return this.deps.startTask(taskId);
    if (value.allowHistoryFallback !== undefined && typeof value.allowHistoryFallback !== 'boolean') throw new ControlError('allowHistoryFallback must be boolean.');
    if (task.status !== 'ready') throw new ControlError('The task is no longer ready.', 409);
    const queued = task.queuedContinuation;
    if (queued.mergeRecovery) {
      // The session that did the work resolves its own conflicts; a new agent takes over only when it cannot be resumed.
      const previousRunId = task.currentRunId;
      try { await this.deps.sendTaskMessage(taskId, { text: queued.instruction, continueSession: true }, 'system'); }
      catch { /* Fall back to a fresh run with the previous execution snapshot. */ }
      if (task.currentRunId && task.currentRunId !== previousRunId) return structuredClone(this.ctx.run(task.currentRunId));
      return this.deps.startRun(taskId, true, task.queuedContinuation?.instruction ?? queued.instruction);
    }
    try {
      await this.deps.sendTaskMessage(taskId, { text: queued.instruction, continueSession: true, allowHistoryFallback: value.allowHistoryFallback === true || queued.allowHistoryFallback === true, ...(queued.openSession ? { openSession: true } : {}) });
      delete task.queuedContinuation; this.ctx.changed();
      return structuredClone(this.ctx.run(task.currentRunId!));
    } catch (error) {
      if (task.queuedContinuation === queued && error instanceof ControlError && error.message.startsWith('HISTORY_FALLBACK_CONFIRMATION:')) {
        queued.confirmationRequired = true; task.queueReason = error.message; this.ctx.changed();
      }
      throw error;
    }
  }
  async sendTaskMessage(taskId: string, input: unknown, author: 'user' | 'system' = 'user'): Promise<TaskMessage | null> {
    const { ctx, deps } = this;
    const value = jsonObject(input);
    if (value.allowHistoryFallback !== undefined && typeof value.allowHistoryFallback !== 'boolean') throw new ControlError('allowHistoryFallback must be boolean.');
    if (value.continueSession !== true) return deps.postMessage(taskId, value);
    if (value.authorType !== undefined && value.authorType !== 'user') throw new ControlError('Only an explicit user instruction may continue a provider session.');
    const openSession = value.openSession === true;
    const task = ctx.task(taskId); let message = text(value.text, 'text', task.queuedContinuation ? 100_000 : 30000, openSession ? '' : undefined).trim(); if (!message && !openSession) throw new ControlError('Message is required.');
    deps.assertDeliveryIdle(task);
    const queuedContinuation = task.queuedContinuation;
    if (task.archivedAt) throw new ControlError('Restore the archived task before continuing it.', 409);
    const previousRun = ctx.lastRun(task);
    if (previousRun && !runEnded(previousRun)) {
      if (!message) throw new ControlError('This session is already open. Continue it in Agent Console.', 409);
      return deps.postMessage(taskId, { text: message, authorType: 'user' });
    }
    if (this.continuingTasks.has(taskId)) throw new ControlError('This session continuation is already being started.', 409);
    // Resuming without a new instruction tells the agent to carry on by itself.
    if (!message) { message = CONTINUE_MESSAGE; author = 'system'; }
    // The session is open in one of AIWS's own terminals, so the message goes there instead of starting another process on it.
    if (message && !queuedContinuation) {
      const sessionIds = [...(task.sessions ?? []).map((entry) => entry.sessionId), previousRun?.sessionId, task.historyResume?.sessionId, task.externalHistory?.sessionId].filter((id): id is string => Boolean(id));
      if (deps.typeIntoSessionTerminal(task.projectId, sessionIds, message)) {
        ctx.event(previousRun?.id ?? null, taskId, 'command', message);
        const result = ctx.addMessage(taskId, author, message, previousRun); ctx.changed(); return structuredClone(result);
      }
    }
    if (ctx.closing) throw new ControlError('The service is shutting down.', 409);
    if (previousRun && ctx.handles.has(previousRun.id) && !deps.isSettling(previousRun.id)) throw new ControlError('The previous provider process is still stopping. Wait for it to exit before continuing.', 409);
    // Without a free slot the continuation waits in Ready and takes the next one, ahead of other ready tasks.
    const capacity = queuedContinuation ? undefined : deps.capacityError(task);
    if (capacity) {
      task.queuedContinuation = { instruction: message, confirmationRequired: false, queuedAt: continuationQueuedAt(ctx.state.tasks), awaitingSlot: true, ...(value.allowHistoryFallback === true ? { allowHistoryFallback: true } : {}), ...(openSession ? { openSession: true } : {}) };
      task.status = 'ready'; task.queueReason = capacity.message; task.updatedAt = now();
      ctx.event(previousRun?.id ?? null, taskId, 'queued', 'All execution slots are occupied. The continuation starts when a slot frees up.'); ctx.changed(); return null;
    }
    const before = structuredClone(task);
    this.continuingTasks.add(taskId);
    try {
      // A completed run may still be finishing its answer; a new instruction takes over now.
      if (previousRun && deps.isSettling(previousRun.id)) await deps.release(previousRun);
      if (previousRun && ctx.handles.has(previousRun.id)) throw new ControlError('The previous provider process is still stopping. Wait for it to exit before continuing.', 409);
      if (worktreeNeedsRestore(task)) task.worktree = prepareTaskWorktree(ctx.project(task.projectId), task, ctx.store.directory, task.worktree.mainBranch);
      const project = ctx.taskWorkspace(task); const source = task.externalHistory ?? task.historyResume;
      const provider = source?.provider ?? previousRun?.provider;
      if (!provider) throw new ControlError('No previous provider session exists.', 409);
      const native = ctx.state.settings.executionMode === 'native';
      const resumeSupported = aiProviders.isHistoryProvider(provider) && native;
      if (task.provider !== provider || task.providerOverride && task.providerOverride !== provider || task.agentId && deps.catalog.agent(task.agentId).provider !== provider) throw new ControlError('The selected agent/provider differs from the original conversation. Restore its original provider before continuing.', 409);
      // The latest session recorded for the task is the one to continue; earlier runs are fallbacks.
      const latest = task.sessions?.filter((entry) => entry.provider === provider).at(-1);
      const sessionId = latest?.sessionId ?? previousRun?.sessionId;
      const sourceRecorded = !task.externalHistory && Boolean(task.historyResume?.recorded);
      let pointer = !resumeSupported ? null : source && !sourceRecorded ? await deps.history.resolve(project, source.sourceId).catch(() => null) : sessionId ? await deps.history.findSession(project, provider as 'codex' | 'claude', sessionId) : null;
      if (resumeSupported && !pointer && previousRun?.terminalMode === 'pty' && previousRun.inputDirectory && !latest) pointer = await bootstrapPointer(deps.history, project, previousRun, provider);
      if (pointer) { try { deps.history.assertResume(project, pointer.session.id, pointer.session.sessionId); } catch { pointer = null; } }
      deps.liveSessions.invalidate();
      if (pointer && await deps.liveSessions.activity(project, pointer.session.provider, pointer.session.sessionId) !== null) throw new ControlError('This conversation is open in another native terminal. Watch Live Sessions or send the instruction in that terminal.', 409);
      // Without a readable history file, a session the agent or provider confirmed is resumed by its ID.
      const recorded = !pointer && native && (!source || sourceRecorded) && provider !== 'command' && latest && latest.source !== 'assigned' && !(previousRun?.historyResume && previousRun.status === 'failed') ? latest : undefined;
      if (!recorded && (!pointer || pointer.session.provider !== provider || source && !sourceRecorded && pointer.session.sessionId !== source.sessionId || previousRun?.historyResume && previousRun.status === 'failed')) {
        if (!message) throw new ControlError('The original provider session could not be verified or its resume failed. Send a message to continue in a new conversation with the saved history.', 409);
        if (value.allowHistoryFallback !== true) throw new ControlError('HISTORY_FALLBACK_CONFIRMATION: The original provider session could not be verified or its resume failed. Start a new conversation with the available chat history?', 409);
        const context = await this.conversationHistory(task);
        this.assertUnchanged(task, previousRun, queuedContinuation, 'Task changed while its history was being read.');
        delete task.historyResume; delete task.externalHistory; delete task.workflowProgress;
        if (aiProviders.isHistoryProvider(provider)) task.agentId = null;
        task.provider = provider; task.providerOverride = provider;
        task.conversationContext = context; task.description = message;
        const run = deps.startTask(taskId);
        const result = ctx.addMessage(taskId, 'user', message, ctx.run(run.id)); ctx.changed(); return structuredClone(result);
      }
      const resumeId = pointer?.session.sessionId ?? recorded!.sessionId;
      if (ctx.state.tasks.some((entry) => entry.id !== taskId && entry.historyResume?.provider === provider && entry.historyResume.sessionId === resumeId && ctx.project(entry.projectId).repositoryPath === project.repositoryPath && (entry.status === 'ready' || ctx.running(entry)))) throw new ControlError('This provider session is already queued or open in another task.', 409);
      // Recheck after asynchronous source/process inspection, before any mutation.
      this.assertUnchanged(task, previousRun, queuedContinuation, 'Task changed while its session was being verified. Retry from the current task.');
      task.historyResume = pointer ? { provider: pointer.session.provider, sessionId: pointer.session.sessionId, sourceId: pointer.session.id, initialMessage: message } : { provider: provider as TaskSession['provider'], sessionId: resumeId, sourceId: '', initialMessage: message, recorded: true };
      task.terminalMode = task.terminalMode ?? previousRun?.terminalMode ?? 'pty';
      task.agentId = null; delete task.command; delete task.model; delete task.providerOverride; delete task.modelOverride; delete task.reasoningEffort; delete task.workflowProgress;
      const run = deps.startTask(taskId); deps.liveSessions.invalidate();
      const result = ctx.addMessage(taskId, author, message, ctx.run(run.id)); ctx.changed(); return structuredClone(result);
    } catch (error) {
      if (ctx.state.tasks.includes(task) && task.currentRunId === previousRun?.id && task.queuedContinuation === queuedContinuation) {
        if (before.worktree?.cleanedAt && !task.worktree?.cleanedAt) discardRestoredWorktree(task);
        restoreTask(task, before);
        // Callers recognise the queued continuation by identity.
        if (queuedContinuation) task.queuedContinuation = queuedContinuation;
      }
      ctx.changed(); throw error;
    } finally { this.continuingTasks.delete(taskId); }
  }
  async forkTask(taskId: string, input: unknown): Promise<Task> {
    const { ctx } = this, source = ctx.task(taskId); const value = jsonObject(input);
    const message = text(value.text, 'text', 30000).trim(); if (!message) throw new ControlError('A fork instruction is required.');
    if (source.externalDependency) throw new ControlError('An external dependency has no agent conversation.', 409);
    const context = await this.conversationHistory(source);
    const task = this.deps.createTask({ projectId: source.projectId, title: `Fork: ${source.title}`.slice(0, 240), description: message, provider: source.provider, model: source.model, command: source.command, agentId: source.agentId ?? null, skillIds: source.skillIds ?? [], terminalMode: source.terminalMode ?? 'pty', status: 'backlog', workflowId: null, autoMerge: false });
    const stored = ctx.task(task.id); stored.conversationContext = context; stored.forkedFromTaskId = source.id;
    ctx.addMessage(stored.id, 'user', message); ctx.changed(); return structuredClone(stored);
  }
  async transferTaskSession(taskId: string, input: unknown): Promise<{ task: Task; run?: Run; warnings: string[] }> {
    const { ctx, deps } = this, state = ctx.state;
    const value = jsonObject(input); const source = ctx.task(taskId); const project = ctx.project(source.projectId);
    const provider = value.provider ?? source.provider;
    if (!aiProviders.isHistoryProvider(provider)) throw new ControlError('Select Codex or Claude for the new conversation.');
    const message = text(value.message, 'message', 30000).trim(); if (!message) throw new ControlError('A new instruction is required.');
    const terminalMode = value.terminalMode ?? source.terminalMode ?? 'pty';
    if (terminalMode !== 'pty' && terminalMode !== 'stream') throw new ControlError('terminalMode must be stream or pty.');
    if (ctx.closing || this.continuingTasks.has(taskId)) throw new ControlError('A session operation is already in progress or the service is shutting down.', 409);
    const runs = state.runs.filter((run) => run.taskId === taskId);
    if (runs.some((run) => ctx.busy(run))) throw new ControlError('Stop the current provider process before transferring its conversation.', 409);
    if (source.externalDependency) throw new ControlError('External dependency records have no conversation to transfer.', 409);
    if (source.externalHistory && !source.currentRunId && ['running', 'waiting', 'paused'].includes(source.status)) throw new ControlError('Close the external provider terminal before transferring this conversation.', 409);
    const sourceVersion = JSON.stringify(source); const repositoryPath = project.repositoryPath;
    this.continuingTasks.add(taskId);
    try {
      const messages: TaskMessage[] = [];
      const events: ControlEvent[] = [];
      const warnings = new Set(source.historyTransfer?.warnings ?? []);
      let readCharacters = 0;
      const count = (items: TaskMessage[], entries: ControlEvent[]): void => {
        readCharacters += items.reduce((sum, entry) => sum + entry.text.length, 0) + entries.reduce((sum, entry) => sum + entry.message.length, 0);
        if (readCharacters > HISTORY_LIMIT) throw tooLong();
      };
      const pointers = new Map<string, HistoryPointer>();
      const providerTranscripts: string[] = [];
      const link = source.externalHistory ?? source.historyResume;
      if (link && !(link === source.historyResume && source.historyResume.recorded)) {
        try { const pointer = await deps.history.resolve(project, link.sourceId); pointers.set(pointer.session.id, pointer); }
        catch { warnings.add('Original provider history could not be read; only available control-center history was transferred.'); }
      }
      for (const run of runs) {
        if (aiProviders.isHistoryProvider(run.provider)) {
          try {
            const pointer = await runSessionPointer(deps.history, project, run, run.provider);
            if (pointer) pointers.set(pointer.session.id, pointer);
            else warnings.add('Some provider history was unavailable; retained control-center messages were used.');
          } catch { warnings.add('Some provider history was unavailable; retained control-center messages were used.'); }
        } else if (run.provider !== 'command') {
          const sessionId = run.sessionId ?? source.sessions?.filter((entry) => entry.runId === run.id || entry.provider === run.provider).at(-1)?.sessionId;
          const transcript = await aiProviders.get(run.provider)?.readSessionTranscript({ ...run, ...(sessionId ? { sessionId } : {}) }).catch(() => undefined);
          if (transcript) {
            readCharacters += transcript.length;
            if (readCharacters > HISTORY_LIMIT) throw tooLong();
            providerTranscripts.push(transcript);
          } else warnings.add('Some provider history was unavailable; retained control-center messages were used.');
        }
      }
      for (const pointer of pointers.values()) {
        if (await deps.liveSessions.activity(project, pointer.session.provider, pointer.session.sessionId) !== null) throw new ControlError('Close the external provider terminal before transferring this conversation.', 409);
        const complete = await readSessionPages(deps.history, pointer, (page) => {
          count(page.messages, page.events);
          messages.push(...page.messages); events.push(...page.events); page.warnings.forEach((warning) => warnings.add(warning));
          if (page.truncated && !page.nextCursor) warnings.add('Provider history contains omitted or shortened records.');
        });
        if (!complete) throw tooLong();
      }
      // Read local records after asynchronous provider reads so notes arriving while
      // history loads are included in the new conversation as well.
      const localMessages = state.messages.filter((entry) => entry.taskId === taskId);
      const localEvents = state.events.filter((entry) => entry.taskId === taskId);
      count(localMessages, localEvents);
      messages.push(...localMessages); events.push(...localEvents);
      const answers = state.questions.filter((question) => question.taskId === taskId && question.status === 'answered').map((question) => `[Agent question] ${question.text}\n[User answer] ${question.answer}`).join('\n\n');
      const transcript = [source.historyTransfer?.transcript, `[Original task]\n${source.title}\n${source.description}`, ...providerTranscripts, transferTranscript(messages, events), answers].filter(Boolean).join('\n\n');
      if (transcript.length > 2_000_000) throw new ControlError('Conversation history exceeds the transfer limit (2000000 characters). No new session was created.', 409);
      if (ctx.closing || JSON.stringify(ctx.task(taskId)) !== sourceVersion || ctx.project(source.projectId).repositoryPath !== repositoryPath || runs.length !== state.runs.filter((run) => run.taskId === taskId).length || state.runs.some((run) => run.taskId === taskId && ctx.busy(run))) throw new ControlError('Source conversation changed while reading history. Retry the transfer.', 409);
      const task = deps.createTask({ projectId: source.projectId, title: source.title, description: message, provider, agentId: null, terminalMode, workflowId: null, autoMerge: false, status: 'backlog' });
      const stored = ctx.task(task.id); stored.historyTransfer = { sourceTaskId: taskId, transcript, warnings: [...warnings] }; stored.status = 'ready';
      ctx.changed();
      const started = this.startOrQueue(stored);
      return { ...started, warnings: [...warnings] };
    } finally { this.continuingTasks.delete(taskId); }
  }
  /**
   * Continues a task with another agent on the same branch and workspace, after the
   * current one ran out of tokens. 'transcript' copies the whole conversation into the
   * new agent; 'fresh' gives a clean agent the task and a brief to inspect the Git changes;
   * 'summary' has a (smaller) summary model compact the conversation first and gives the brief and that summary.
   */
  async handoffTask(taskId: string, input: unknown): Promise<{ task: Task; run: Run }> {
    const { ctx, deps } = this;
    const value = jsonObject(input); const task = ctx.task(taskId); const project = ctx.project(task.projectId);
    deps.assertDeliveryIdle(task);
    if (task.archivedAt) throw new ControlError('Restore the archived task before continuing it.', 409);
    if (task.externalDependency) throw new ControlError('This record only tracks an external GitHub dependency and cannot run an agent.', 409);
    const previous = ctx.lastRun(task);
    if (!previous) throw new ControlError('This task has no agent run to hand off.', 409);
    const agentId = value.agentId === undefined || value.agentId === null || value.agentId === '' ? null : text(value.agentId, 'agentId', 200);
    const agent = agentId ? deps.catalog.agent(agentId) : null;
    if (agent && !agent.enabled) throw new ControlError('The selected agent profile is disabled.', 409);
    const provider = agent?.provider ?? value.provider;
    if (!agent && !aiProviders.has(provider)) throw new ControlError('Select an agent or a provider to continue with.');
    if (!agent && ctx.providerSettings(task.projectId).disabledProviders.includes(provider as DefaultProvider)) throw new ControlError('The selected provider is disabled in work settings.', 409);
    const mode: AgentHandoffMode = value.mode === undefined ? project.agentHandoffMode ?? 'fresh' : validateHandoffMode(value.mode, 'mode');
    const model = value.model === undefined || value.model === null || value.model === '' ? undefined : text(value.model, 'model', 200).trim() || undefined;
    const efforts = (agent?.provider ?? provider) === 'command' ? [] : aiProviders.require(String(agent?.provider ?? provider)).reasoningEfforts;
    const reasoningEffort = value.reasoningEffort === undefined || value.reasoningEffort === null || value.reasoningEffort === '' ? undefined : String(value.reasoningEffort);
    if (reasoningEffort !== undefined && !efforts.includes(reasoningEffort)) throw new ControlError(efforts.length ? `reasoningEffort must be one of ${efforts.join(', ')}.` : 'The selected provider has no reasoning levels.');
    if (ctx.closing || this.continuingTasks.has(taskId)) throw new ControlError('A session operation is already in progress or the service is shutting down.', 409);
    const summaryModel = value.summaryModel === undefined || value.summaryModel === null || value.summaryModel === '' ? undefined : text(value.summaryModel, 'summaryModel', 200).trim() || undefined;
    const summaryProvider = String(agent?.provider ?? provider);
    if (mode === 'summary' && summaryProvider === 'command') throw new ControlError('Summary handoff needs an AI provider to write the summary.');
    const reason = task.handoffRequest?.runId === previous.id ? task.handoffRequest.reason : undefined;
    const previousAgent = previous.executionSnapshot?.agent?.name ?? previous.provider;
    const target = agent?.name ?? String(provider);
    const before = structuredClone(task);
    this.continuingTasks.add(taskId);
    try {
      // Compacting only reads the history, so it runs before the previous agent is stopped; a failure leaves it untouched.
      const summarizer = `${summaryProvider}${summaryModel ? ` (${summaryModel})` : ''}`;
      const summary = mode === 'summary' ? await compactConversation({ provider: summaryProvider, ...(summaryModel ? { model: summaryModel } : {}), workspacePath: task.worktree?.path ?? previous.workspacePath ?? project.repositoryPath, transcript: await this.conversationHistory(task) }) : '';
      if (!runEnded(previous)) {
        deps.signals.ending(previous.id);
        deps.finish(previous, 'cancelled', 130, `Handed off to ${target}.`);
        await ctx.handles.get(previous.id)?.stop();
      }
      // The new agent works in the same workspace; wait for the old process to release it.
      for (let waited = 0; ctx.handles.has(previous.id) && waited < 15_000; waited += 100) await delay(100);
      if (ctx.handles.has(previous.id)) throw new ControlError('The previous provider process is still stopping. Retry shortly.', 409);
      if (worktreeNeedsRestore(task)) task.worktree = prepareTaskWorktree(project, task, ctx.store.directory, task.worktree.mainBranch);
      const workspacePath = task.worktree?.path ?? previous.workspacePath ?? project.repositoryPath;
      const mainBranch = task.worktree?.mainBranch ?? project.mainBranch ?? project.defaultBranch;
      const brief = mode === 'transcript' ? '' : await handoffBrief({ previousAgent, previousProvider: previous.provider, previousRunId: previous.id, ...(reason ? { reason } : {}), workspacePath, ...(mainBranch ? { mainBranch } : {}), messages: ctx.state.messages.filter((message) => message.taskId === taskId) });
      const context = mode === 'transcript' ? handoffTranscript(previousAgent, previous.provider, reason, await this.conversationHistory(task))
        : mode === 'summary' ? compactedContext(brief, summarizer, summary) : brief;
      if (!ctx.state.tasks.includes(task) || (task.currentRunId && task.currentRunId !== previous.id)) throw new ControlError('Task changed while the handoff was being prepared.', 409);
      delete task.historyResume; delete task.externalHistory; delete task.workflowProgress; delete task.queuedContinuation; delete task.handoffRequest; delete task.historyTransfer;
      delete task.command; delete task.model; delete task.providerOverride; delete task.modelOverride; delete task.reasoningEffort;
      task.agentId = agent?.id ?? null; if (!agent) task.provider = provider as Task['provider'];
      if (model) { if (agent) task.modelOverride = model; task.model = model; }
      if (reasoningEffort) task.reasoningEffort = reasoningEffort;
      task.conversationContext = context;
      const run = deps.startTask(taskId);
      const stored = ctx.run(run.id); stored.handoff = { fromRunId: previous.id, fromProvider: previous.provider, fromAgentName: previousAgent, mode, ...(reason ? { reason } : {}), ...(mode === 'summary' && summaryModel ? { summaryModel } : {}) };
      ctx.event(run.id, taskId, 'handoff', `Continuing with ${target} after ${previousAgent} (${mode === 'transcript' ? 'full conversation copied' : mode === 'summary' ? `conversation compacted by ${summarizer}` : 'clean agent reviewing the Git changes'}).`);
      ctx.addMessage(taskId, 'system', `Handed off from ${previousAgent} to ${target}.`, stored);
      ctx.changed(); return { task: structuredClone(task), run: structuredClone(stored) };
    } catch (error) {
      if (ctx.state.tasks.includes(task) && task.currentRunId === previous.id) {
        if (before.worktree?.cleanedAt && !task.worktree?.cleanedAt) discardRestoredWorktree(task);
        restoreTask(task, before);
      }
      ctx.changed(); throw error;
    } finally { this.continuingTasks.delete(taskId); }
  }
  /**
   * Starts a newly created session task; when capacity or the workspace is busy (409),
   * it stays ready with the reason, any other failure marks it failed.
   */
  startOrQueue(task: Task): { task: Task; run?: Run } {
    try { const run = this.deps.startTask(task.id); return { task: structuredClone(this.ctx.task(task.id)), run }; }
    catch (error) {
      if (!(error instanceof ControlError && error.statusCode === 409)) { task.status = 'failed'; task.queueReason = (error as Error).message; this.ctx.changed(); throw error; }
      task.queueReason = error.message; this.ctx.changed(); return { task: structuredClone(task) };
    }
  }
  /** Everything known about the task's conversation, as reference context for a new provider session. */
  async conversationHistory(task: Task): Promise<string> {
    const { ctx, deps } = this, state = ctx.state;
    const parts = [task.conversationContext ?? '', task.historyTransfer?.transcript ?? '', `Original task: ${task.title}\n${task.description}`];
    let characters = parts.reduce((sum, part) => sum + part.length, 0);
    const append = (part: string) => {
      characters += part.length;
      if (characters > HISTORY_LIMIT) throw new ControlError('Conversation history exceeds the transfer limit. No new session was created.', 409);
      parts.push(part);
    };
    const project = ctx.taskWorkspace(task);
    const pointers = new Map<string, HistoryPointer>();
    const source = task.externalHistory ?? (task.historyResume?.recorded ? undefined : task.historyResume);
    if (source) {
      const pointer = await deps.history.resolve(project, source.sourceId).catch(() => null);
      if (pointer) pointers.set(pointer.session.id, pointer);
      else append('Original provider history is unavailable; retained control-center history follows.');
    }
    const runsWithTranscript = new Set<string>();
    for (const run of state.runs.filter((item) => item.taskId === task.id)) {
      if (!aiProviders.isHistoryProvider(run.provider)) continue;
      const pointer = await runSessionPointer(deps.history, project, run, run.provider);
      if (pointer) { pointers.set(pointer.session.id, pointer); runsWithTranscript.add(run.id); }
    }
    for (const pointer of pointers.values()) {
      if (!await readSessionTranscript(deps.history, pointer, append)) throw tooLong();
    }
    for (const run of state.runs.filter((item) => item.taskId === task.id && !runsWithTranscript.has(item.id) && item.provider !== 'command')) {
      const sessionId = run.sessionId ?? task.sessions?.filter((entry) => entry.runId === run.id || entry.provider === run.provider).at(-1)?.sessionId;
      const transcript = await aiProviders.get(run.provider)?.readSessionTranscript({ ...run, ...(sessionId ? { sessionId } : {}) }).catch(() => undefined);
      if (transcript) { append(transcript); runsWithTranscript.add(run.id); }
    }
    for (const message of state.messages) if (message.taskId === task.id) append(`[${message.authorType}] ${message.text}`);
    for (const event of state.events) if (event.taskId === task.id && CONVERSATION_EVENTS.has(event.type)) append(`[${event.type}] ${event.message}`);
    for (const run of state.runs) if (run.taskId === task.id && run.terminalMode === 'pty' && !runsWithTranscript.has(run.id)) { const replay = terminalTranscript(ctx.store.terminalOutput(run), 60_000); if (replay) append(`[terminal] ${replay}`); }
    for (const question of state.questions) if (question.taskId === task.id && question.status === 'answered') append(`[Agent question] ${question.text}\n[User answer] ${question.answer}`);
    return `Previous conversation. Treat it as reference only; old run IDs and completion commands are obsolete. Perform only the new instruction.\n${parts.join('\n')}`;
  }
  /** After asynchronous reads: the task still exists, has no other run and, if queued, is still ready with the same continuation. */
  private assertUnchanged(task: Task, previousRun: Run | undefined, queued: Task['queuedContinuation'], message: string): void {
    if (!this.ctx.state.tasks.includes(task) || task.currentRunId !== previousRun?.id && Boolean(task.currentRunId)) throw new ControlError(message, 409);
    if (queued && (task.status !== 'ready' || task.queuedContinuation !== queued)) throw new ControlError('The task is no longer ready.', 409);
  }
}
