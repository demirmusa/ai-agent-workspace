import { randomUUID } from 'node:crypto';
import { pathKey } from '../shared/core/paths.js';
import { HISTORY_LIMITS, SessionHistory } from './history.js';
import { ControlStore } from './store.js';
import { ControlError, type AgentExecutionStatus, type HistoricalSession, type HistoryProvider, type Project, type Task, type TaskStatus } from './types.js';

/** An observation of an existing provider session, never an executable AIWS run. */
export interface HistoryTaskSource {
  sourceId: string; provider: HistoryProvider; sessionId: string; importedAt: string;
  status: AgentExecutionStatus; syncedStatus: TaskStatus;
}
export interface HistoryTaskImportResult {
  imported: number; skipped: number; taskIds: string[];
  errors: Array<{ sourceId: string; message: string }>; warnings: string[];
}
export type SessionActivity = (project: Project, provider: HistoryProvider, sessionId: string) => Promise<'working' | 'idle' | 'unknown' | null>;

export function historyTaskStatus(status: AgentExecutionStatus): TaskStatus {
  return ({ running: 'running', waiting: 'waiting', completed: 'done', failed: 'failed', interrupted: 'cancelled', stopped: 'cancelled', pending: 'backlog', unknown: 'backlog' } as const)[status];
}
const validStatus = (value: unknown): value is AgentExecutionStatus => ['running', 'waiting', 'completed', 'failed', 'interrupted', 'stopped', 'pending', 'unknown'].includes(String(value));

/** Explicit, bounded archive import. Browsing never calls this mutation. */
export class HistoryTaskImporter {
  private pending = new Map<string, Promise<HistoryTaskImportResult>>();
  constructor(private history: SessionHistory, private store: ControlStore, private changed: () => void, private activity?: SessionActivity) {}

  import(project: Project): Promise<HistoryTaskImportResult> {
    const active = this.pending.get(project.id); if (active) return active;
    const operation = this.perform(structuredClone(project)).finally(() => this.pending.delete(project.id));
    this.pending.set(project.id, operation); return operation;
  }
  /** Explicit single-session conversion. The mutation-time link check prevents duplicates. */
  async importSession(project: Project, sourceId: string): Promise<HistoryTaskImportResult> {
    const session = (await this.history.resolve(project, sourceId)).session;
    const result = await this.perform(structuredClone(project), [session]);
    const linked = this.existing(project, session); if (linked && !result.taskIds.includes(linked.id)) result.taskIds.push(linked.id);
    return result;
  }
  private assertProject(project: Project): void {
    const current = this.store.state.projects.find((entry) => entry.id === project.id);
    if (!current || pathKey(current.repositoryPath) !== pathKey(project.repositoryPath)) throw new ControlError('Project changed while sessions were loading. Refresh Sessions and retry.', 409);
  }
  private existing(project: Project, session: HistoricalSession): Task | undefined {
    const tasks = this.store.state.tasks.filter((task) => task.projectId === project.id);
    const identity = (source: { provider: string; sessionId: string } | undefined): boolean => source?.provider === session.provider && source.sessionId.toLowerCase() === session.sessionId.toLowerCase();
    return tasks.find((task) => identity(task.externalHistory) || identity(task.historyResume) || this.store.state.runs.some((run) => run.taskId === task.id && run.provider === session.provider && (run.sessionId?.toLowerCase() === session.sessionId.toLowerCase() || identity(run.historyResume))));
  }
  private async sourceStatus(project: Project, session: HistoricalSession): Promise<AgentExecutionStatus> {
    const activity = await this.activity?.(project, session.provider, session.sessionId);
    // A resident native terminal can be waiting for its next request after a
    // completed turn. Only exact working evidence overrides the archive state.
    if (activity === 'working') return 'running';
    const source = (session as HistoricalSession & { status?: unknown }).status;
    if (validStatus(source)) {
      // An unfinished turn in an old file can belong to a crashed process.
      // A live-process adapter must confirm it before an active card is made.
      if (this.activity && (source === 'running' || source === 'waiting')) return activity === 'idle' ? 'waiting' : 'unknown';
      if ((source === 'unknown' || source === 'pending') && activity === 'idle') return 'waiting';
      return source;
    }
    return activity === 'idle' ? 'waiting' : 'unknown';
  }
  private async firstUser(project: Project, session: HistoricalSession): Promise<{ text: string; truncated: boolean }> {
    const message = (session as HistoricalSession & { firstUserMessage?: string }).firstUserMessage;
    if (typeof message === 'string' && message.trim()) return { text: message.slice(0, 100000), truncated: message.length > 100000 };
    // Compatibility with older provider records: use the same public adapter as
    // the console, never scrape raw tool results or provider metadata here.
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const detail = await this.history.detail(project, session.id, { limit: 200, ...(cursor ? { cursor } : {}) });
      const user = detail.messages.find((entry) => entry.authorType === 'user' && entry.text.trim());
      if (user) return { text: user.text.slice(0, 100000), truncated: user.text.length > 100000 };
      cursor = detail.nextCursor; if (!cursor) return { text: '', truncated: false };
    }
    return { text: '', truncated: true };
  }
  private async perform(project: Project, selected?: HistoricalSession[]): Promise<HistoryTaskImportResult> {
    this.assertProject(project);
    const result: HistoryTaskImportResult = { imported: 0, skipped: 0, taskIds: [], errors: [], warnings: [] };
    const warnings = new Set<string>(); const sources: HistoricalSession[] = [...selected ?? []];
    let cursor: string | null = null;
    if (!selected) do {
      const page = await this.history.list(project, { limit: 100, ...(cursor ? { cursor } : { refresh: true }) });
      page.warnings.forEach((warning) => warnings.add(warning)); sources.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && sources.length < HISTORY_LIMITS.files);
    if (cursor) warnings.add('Session import reached its safety limit. Some older sessions were not imported.');

    let mutated = false;
    try {
      for (const candidate of sources.slice(0, HISTORY_LIMITS.files)) {
        try {
          this.assertProject(project);
          // Revalidate project/source membership at mutation time. A source
          // may have moved or been replaced since the list was produced.
          const session = (await this.history.resolve(project, candidate.id)).session;
          if (this.existing(project, session)) { result.skipped++; continue; }
          const firstUser = await this.firstUser(project, session);
          const sourceStatus = await this.sourceStatus(project, session); const status = historyTaskStatus(sourceStatus);
          this.assertProject(project);
          // Another request (or an explicit resume) may have added a link while
          // the public transcript and native activity were being inspected.
          if (this.existing(project, session)) { result.skipped++; continue; }
          if (!firstUser.text.trim()) warnings.add('Some sessions have no public first user message; their task descriptions are empty.');
          if (firstUser.truncated) warnings.add('Some first user messages reached the history read limit.');
          if (sourceStatus === 'unknown' || sourceStatus === 'pending') warnings.add('Sessions without a proven completion or active state were imported into Backlog.');
          const timestamp = new Date().toISOString();
          const task: Task = {
            id: `task_${randomUUID()}`, projectId: project.id, title: session.title.slice(0, 500), description: firstUser.text,
            status, priority: 0, provider: session.provider, agentId: null, skillIds: [], dependsOn: [], tags: [], requestedActions: [],
            autoStart: false, autoMerge: false, workflowId: null, workflowRequested: false, terminalMode: 'pty', currentRunId: null,
            externalHistory: { sourceId: session.id, provider: session.provider, sessionId: session.sessionId, importedAt: timestamp, status: sourceStatus, syncedStatus: status },
            createdAt: session.createdAt, updatedAt: timestamp,
          };
          this.store.state.tasks.push(task); mutated = true; result.imported++; result.taskIds.push(task.id);
        } catch (error) { result.errors.push({ sourceId: candidate.id, message: error instanceof Error ? error.message : 'Session could not be imported.' }); }
      }
    } finally { if (mutated) this.changed(); }
    result.warnings = [...warnings]; return result;
  }

  /** Refresh only explicitly linked archive tasks, preserving operator edits. */
  async reconcile(project: Project, sessions: HistoricalSession[]): Promise<void> {
    let mutated = false;
    try { for (const session of sessions) {
      const task = this.existing(project, session); const source = task?.externalHistory;
      if (!task || !source || task.currentRunId) continue;
      const observed = await this.sourceStatus(project, session); this.assertProject(project);
      if (observed === 'unknown' || observed === 'pending') continue; // Absence is not completion or a regression.
      const next = historyTaskStatus(observed);
      const stillPresent = this.store.state.tasks.includes(task); if (!stillPresent) continue;
      if (task.status !== source.syncedStatus) continue; // The user deliberately moved this imported card.
      if (source.status === observed && task.status === next) continue;
      task.status = next; source.status = observed; source.syncedStatus = next; task.updatedAt = new Date().toISOString(); mutated = true;
    } } finally { if (mutated) this.changed(); }
  }
}
