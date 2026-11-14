import { compactedContext } from '../agent-handoff.js';
import { aiProviders } from '../ai-providers/index.js';
import { compactConversation } from '../history-compact.js';
import type { HistoricalSession, HistoryProvider, Project, Run, Task, TerminalMode } from '../types.js';
import { ControlError } from '../types.js';
import type { HistoryTaskImporter } from '../history-import.js';
import type { SessionHistory } from '../history.js';
import type { LiveSessions } from '../live-sessions.js';
import { TERMINAL_TASK_MESSAGE, type ProjectTerminal, type ProjectTerminals } from '../project-terminals.js';
import { jsonObject } from '../validation.js';
import { text } from './common.js';
import type { ControlContext } from './context.js';
import { readSessionTranscript } from './provider-history.js';
import type { Conversations } from './conversations.js';

export interface ProviderSessionDependencies {
  history: SessionHistory;
  liveSessions: LiveSessions;
  historyImporter: HistoryTaskImporter;
  projectTerminals: ProjectTerminals;
  conversations: Conversations;
  createTask(input: unknown): Task;
  sendTaskMessage(taskId: string, input: unknown): Promise<unknown>;
  resumeTaskSession(taskId: string, input: unknown): Promise<{ task: Task; run?: Run }>;
}

/** Provider sessions outside AIWS tasks: live sessions, resuming a session from history, and agent terminals that become tasks. */
export class ProviderSessions {
  constructor(private readonly ctx: ControlContext, private readonly deps: ProviderSessionDependencies) {}

  taskHistoryContext(taskId: string): { project: Project; sourceId: string } {
    const task = this.ctx.task(taskId), source = task.externalHistory ?? task.historyResume;
    if (!source?.sourceId) throw new ControlError('This task has no source session history.', 404);
    // Imported history belongs to the original project; a managed continuation
    // belongs to the workspace where its provider session was verified.
    return { project: task.externalHistory ? this.ctx.project(task.projectId) : this.ctx.taskWorkspace(task), sourceId: source.sourceId };
  }
  async liveSessionsPage(): Promise<Awaited<ReturnType<LiveSessions['state']>>> {
    const state = this.ctx.state, { history, historyImporter } = this.deps;
    const before = JSON.stringify(state.runs.map((run) => run.executionInfo));
    const page = await this.deps.liveSessions.state(state.projects, state.runs, state.tasks);
    if (before !== JSON.stringify(state.runs.map((run) => run.executionInfo))) this.ctx.changed();
    const imported = (task: Task, project: Project): boolean => task.projectId === project.id && Boolean(task.externalHistory) && !task.currentRunId;
    for (const project of state.projects.filter((entry) => state.tasks.some((task) => imported(task, entry)))) {
      const sessions: HistoricalSession[] = [];
      for (const task of state.tasks.filter((entry) => imported(entry, project)).slice(0, 100)) { try { sessions.push((await history.resolve(project, task.externalHistory!.sourceId)).session); } catch { /* A removed session file is reconciled as missing. */ } }
      await historyImporter.reconcile(project, sessions);
    }
    return page;
  }
  async resumeSession(projectId: string, sourceId: string, input: unknown): Promise<{ task: Task; run?: Run }> {
    const { ctx, deps } = this, state = ctx.state;
    const value = jsonObject(input); const project = ctx.project(projectId); const pointer = await deps.history.resolve(project, sourceId);
    if (ctx.closing) throw new ControlError('Service is shutting down.', 409);
    if (state.settings.executionMode === 'docker') throw new ControlError('Historical host sessions can currently resume in native execution mode. Switch execution mode to native on the machine that owns this provider history.', 409);
    const message = text(value.message, 'message', 100000, '').trim(); const terminalMode = value.terminalMode ?? 'pty';
    if (!['pty', 'stream'].includes(String(terminalMode))) throw new ControlError('terminalMode must be stream or pty.');
    if (terminalMode === 'stream' && !message) throw new ControlError('A new message is required to continue a session in stream mode. Use native terminal mode to open it without starting a new turn.');
    const { provider, sessionId } = pointer.session;
    if (await deps.liveSessions.activity(project, provider, sessionId) !== null) throw new ControlError('This provider session is open in another native terminal. Watch it in Live Sessions and continue there until that terminal closes.', 409);
    const duplicate = state.tasks.find((task) => task.historyResume?.provider === provider && task.historyResume.sessionId === sessionId && ctx.project(task.projectId).repositoryPath === project.repositoryPath && (task.status === 'ready' || Boolean(task.currentRunId && ctx.busy(ctx.run(task.currentRunId)))));
    if (duplicate) throw new ControlError(`This session is already queued or open in task ${duplicate.id}${duplicate.currentRunId ? `, run ${duplicate.currentRunId}` : ''}. Open that task instead.`, 409);
    // Continuing the same session again reuses its record, so its runs stay together.
    const previous = state.tasks.find((task) => task.sessionContinuation && !task.archivedAt && task.projectId === projectId && task.historyResume?.provider === provider && task.historyResume.sessionId.toLowerCase() === sessionId.toLowerCase());
    // A terminal opened as one of the provider's accounts continues as that account.
    const account = typeof value.account === 'string' && value.account ? value.account : undefined;
    if (previous) {
      previous.terminalMode = terminalMode as TerminalMode;
      if (account) previous.account = account; else delete previous.account;
      return deps.resumeTaskSession(previous.id, { message });
    }
    const title = text(value.title, 'title', 500, '').trim() || `Continue ${aiProviders.require(provider).name} session ${sessionId.slice(0, 8)}`;
    const task = deps.createTask({ projectId, title, description: message, provider, agentId: null, terminalMode, workflowId: null, autoMerge: false, status: 'backlog', ...(account ? { account } : {}) });
    const stored = ctx.task(task.id); stored.historyResume = { provider, sessionId, sourceId, initialMessage: message }; stored.sessionContinuation = true; stored.status = 'ready';
    ctx.changed();
    return deps.conversations.startOrQueue(stored);
  }
  /**
   * Compacts a past provider session with a (smaller) summary model and continues it in a new
   * session: the new task starts with the summary instead of resuming the long conversation.
   */
  async compactSession(projectId: string, sourceId: string, input: unknown): Promise<{ task: Task; run?: Run }> {
    const { ctx, deps } = this;
    const value = jsonObject(input); const project = ctx.project(projectId); const pointer = await deps.history.resolve(project, sourceId);
    if (ctx.closing) throw new ControlError('Service is shutting down.', 409);
    const session = pointer.session;
    const optional = (field: string): string | undefined => value[field] === undefined || value[field] === null || value[field] === '' ? undefined : text(value[field], field, 200).trim() || undefined;
    const provider = optional('provider') ?? session.provider;
    if (!aiProviders.has(provider)) throw new ControlError('Select a provider to continue with.');
    const summaryProvider = optional('summaryProvider') ?? provider, summaryModel = optional('summaryModel'), model = optional('model');
    if (!aiProviders.has(summaryProvider)) throw new ControlError('Select a provider to write the summary.');
    const message = text(value.message, 'message', 100000, '').trim();
    const terminalMode = value.terminalMode ?? 'stream';
    if (!['pty', 'stream'].includes(String(terminalMode))) throw new ControlError('terminalMode must be stream or pty.');
    const records: string[] = [];
    if (!await readSessionTranscript(deps.history, pointer, (record) => records.push(record))) throw new ControlError('The session history is too long to read completely.', 409);
    const summary = await compactConversation({ provider: summaryProvider, ...(summaryModel ? { model: summaryModel } : {}), workspacePath: session.cwd || project.repositoryPath, transcript: records.join('\n') });
    const summarizer = `${summaryProvider}${summaryModel ? ` (${summaryModel})` : ''}`;
    const title = text(value.title, 'title', 500, '').trim() || `Continue: ${(session.title || session.sessionId).slice(0, 200)}`;
    const description = message || 'Continue the work from the compacted conversation summary: check the current state of the repository first, then finish what is left without repeating completed work.';
    const task = deps.createTask({ projectId, title, description, provider, agentId: null, terminalMode, workflowId: null, autoMerge: false, status: 'backlog', ...(model ? { model } : {}), ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) });
    const stored = ctx.task(task.id);
    stored.conversationContext = compactedContext(`CONTINUED SESSION: This task continues the ${aiProviders.require(session.provider).name} session ${session.sessionId}${session.cwd ? ` that worked in ${session.cwd}` : ''}. Its conversation is not included.`, summarizer, summary);
    stored.status = 'ready'; ctx.changed();
    return deps.conversations.startOrQueue(stored);
  }
  /** Continues an agent terminal's conversation as a running task: the terminal closes and AIWS resumes the same provider session. */
  /** Reopens a run's provider session in an agent terminal of its workspace, so the user can talk to it without continuing the task. */
  async openRunSessionTerminal(runId: string): Promise<ProjectTerminal> {
    const { ctx, deps } = this, run = ctx.run(runId), task = ctx.task(run.taskId);
    if (!run.sessionId || !aiProviders.has(run.provider)) throw new ControlError('This run has no provider session to open.', 409);
    if (['running', 'waiting', 'paused'].includes(run.status)) throw new ControlError('The agent is still using this session. Stop the run first.', 409);
    if (ctx.state.settings.executionMode === 'docker') throw new ControlError('Sessions open in a terminal in native execution mode only.', 409);
    const title = `${aiProviders.require(run.provider).name} · ${run.sessionId.slice(0, 8)}`;
    return deps.projectTerminals.create(ctx.project(task.projectId), { kind: 'agent', provider: run.provider, title, ...(task.account ? { account: task.account } : {}) }, { sessionId: run.sessionId, workspacePath: ctx.runProject(run).repositoryPath });
  }
  async convertTerminalToTask(projectId: string, terminalId: string): Promise<{ task: Task; run?: Run }> {
    const { ctx, deps } = this;
    const project = ctx.project(projectId), { run: terminal } = deps.projectTerminals.get(projectId, terminalId), provider = terminal.provider;
    if (terminal.terminalKind !== 'agent' || !aiProviders.isHistoryProvider(provider)) throw new ControlError(`Only ${aiProviders.list().filter((item) => item.history).map((item) => item.name).join(' or ')} terminals can become tasks.`, 409);
    if (terminal.resumeSessionId) throw new ControlError('This terminal reopens an existing session; continue its task instead.', 409);
    if (terminal.status !== 'running') throw new ControlError('The agent in this terminal has exited. Restart it or continue the session from project Sessions.', 409);
    if (ctx.state.settings.executionMode === 'docker') throw new ControlError('Terminal sessions can become tasks in native execution mode only.', 409);
    const pointer = await this.terminalSession(project, terminal, provider);
    await deps.projectTerminals.remove(projectId, terminalId); deps.liveSessions.invalidate();
    return this.resumeSession(projectId, pointer.session.id, { message: TERMINAL_TASK_MESSAGE, terminalMode: 'pty', title: pointer.session.title.slice(0, 200), ...(terminal.account ? { account: terminal.account } : {}) });
  }
  /** The provider session an agent terminal writes: its assigned ID, or the only new session of that provider in the project. */
  private async terminalSession(project: Project, terminal: ProjectTerminal, provider: HistoryProvider) {
    const { history } = this.deps;
    const missing = new ControlError('The agent has not saved this conversation yet. Send it a message first, then turn it into a task.', 409);
    if (terminal.sessionId) { const pointer = await history.findSession(project, provider, terminal.sessionId); if (!pointer) throw missing; return history.resolve(project, pointer.session.id); }
    const known = new Set(this.ctx.state.runs.map((run) => run.sessionId?.toLowerCase()).filter(Boolean)), since = Date.parse(terminal.startedAt) - 5000;
    const page = await history.list(project, { provider, refresh: true, sort: 'created', limit: 100 });
    const candidates = page.items.filter((item) => Date.parse(item.createdAt) >= since && !known.has(item.sessionId.toLowerCase()));
    if (candidates.length > 1) throw new ControlError(`Several ${aiProviders.require(provider).name} sessions started in this project after the terminal opened, so its conversation cannot be identified. Continue it from project Sessions instead.`, 409);
    if (!candidates[0]) throw missing;
    return history.resolve(project, candidates[0].id);
  }
}
