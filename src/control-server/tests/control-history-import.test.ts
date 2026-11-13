import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../store.js';
import { SessionHistory } from '../history.js';
import { HistoryTaskImporter, historyTaskStatus } from '../history-import.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import type { AgentExecutionStatus, HistoricalSession, Project, Run, Task } from '../types.js';

const roots: string[] = [], stores: ControlStore[] = [], servers: RunningControlServer[] = [];
const at = '2026-10-16T10:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-history-import-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const project: Project = { id: 'project-one', name: 'One', description: '', repositoryPath: workspace, github: null, createdAt: at, updatedAt: at };
  const store = new ControlStore(join(root, 'data')); stores.push(store); store.state.projects.push(project); store.save();
  const changed = vi.fn(() => store.save());
  return { root, workspace, project, store, changed };
}
function session(index: number, status: AgentExecutionStatus = 'completed'): HistoricalSession {
  return { id: `hist_${String(index).padStart(40, '0')}`, provider: index % 2 ? 'claude' : 'codex', sessionId: randomUUID(), title: `Native console title ${index}`, cwd: '/fixture', createdAt: at, updatedAt: at, canResume: true, firstUserMessage: `First public request ${index}\nwith details.`, status };
}
function fakeHistory(items: HistoricalSession[]) {
  const list = vi.fn(async (_project: Project, query: { cursor?: string; limit?: number } = {}) => {
    const offset = Number(query.cursor ?? 0), limit = query.limit ?? 100;
    return { items: structuredClone(items.slice(offset, offset + limit)), nextCursor: offset + limit < items.length ? String(offset + limit) : null, warnings: [] };
  });
  const resolve = vi.fn(async (_project: Project, sourceId: string) => {
    const found = items.find((item) => item.id === sourceId); if (!found) throw new Error('Wrong project source.');
    return { session: structuredClone(found), path: '/never-read', root: '/never-read' };
  });
  const detail = vi.fn(async () => ({ messages: [], nextCursor: null, warnings: [], events: [], truncated: false, session: items[0]! }));
  return { value: { list, resolve, detail } as unknown as SessionHistory, list, resolve, detail };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); stores.splice(0).forEach((store) => store.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); });

describe('explicit provider history to task import', () => {
  it('imports every root page using canonical titles and first user messages without executable runs', async () => {
    const { project, store, changed } = fixture(); const items = Array.from({ length: 135 }, (_, index) => session(index)); const history = fakeHistory(items);
    const importer = new HistoryTaskImporter(history.value, store, changed, async (_project, _provider, uuid) => uuid === items[0]!.sessionId ? 'working' : null);
    const result = await importer.import(project);
    expect(result).toMatchObject({ imported: 135, skipped: 0, errors: [], warnings: [] }); expect(result.taskIds).toHaveLength(135);
    expect(history.list.mock.calls.map(([, query]) => query?.cursor ?? null)).toEqual([null, '100']); expect(changed).toHaveBeenCalledTimes(1);
    for (const [index, task] of store.state.tasks.entries()) {
      expect(task).toMatchObject({ title: items[index]!.title, description: items[index]!.firstUserMessage, status: index === 0 ? 'running' : 'done', autoStart: false, currentRunId: null, autoMerge: false, workflowId: null });
      expect(task.externalHistory).toMatchObject({ sourceId: items[index]!.id, provider: items[index]!.provider, sessionId: items[index]!.sessionId }); expect(task.historyResume).toBeUndefined();
    }
    expect(store.state.runs).toEqual([]); expect(history.detail).not.toHaveBeenCalled();
    expect(store.readPersisted().tasks).toHaveLength(135);
  });

  it('coalesces concurrent imports and skips existing imported, resumed and managed native UUIDs', async () => {
    const { project, store, changed } = fixture(); const items = Array.from({ length: 4 }, (_, index) => session(index)); const history = fakeHistory(items);
    const base: Task = { id: 'managed', projectId: project.id, title: 'Existing app task', description: '', status: 'done', provider: items[1]!.provider, priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: at, updatedAt: at };
    store.state.tasks.push({ ...base, id: 'resumed', historyResume: { sourceId: items[0]!.id, sessionId: items[0]!.sessionId.toUpperCase(), provider: items[0]!.provider, initialMessage: 'Continue' } }, base);
    store.state.runs.push({ id: 'managed-run', taskId: base.id, provider: items[1]!.provider, sessionId: items[1]!.sessionId, status: 'completed', startedAt: at, finishedAt: at, exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0 } as Run);
    const importer = new HistoryTaskImporter(history.value, store, changed);
    const [first, same] = await Promise.all([importer.import(project), importer.import(project)]);
    expect(first).toEqual(same); expect(first).toMatchObject({ imported: 2, skipped: 2, errors: [] }); expect(history.list).toHaveBeenCalledTimes(1);
    const repeated = await importer.import(project); expect(repeated).toMatchObject({ imported: 0, skipped: 4, taskIds: [] });
    expect(store.state.tasks).toHaveLength(4); expect(store.state.runs).toHaveLength(1); expect(changed).toHaveBeenCalledTimes(1);
  });

  it('maps only proven provider states and reports unknown histories without claiming completion', async () => {
    const { project, store, changed } = fixture(); const states: AgentExecutionStatus[] = ['completed', 'running', 'waiting', 'failed', 'interrupted', 'stopped', 'pending', 'unknown'];
    const items = states.map((status, index) => session(index, status)); const result = await new HistoryTaskImporter(fakeHistory(items).value, store, changed).import(project);
    expect(store.state.tasks.map((task) => task.status)).toEqual(['done', 'running', 'waiting', 'failed', 'cancelled', 'cancelled', 'backlog', 'backlog']);
    expect(result.warnings).toEqual(['Sessions without a proven completion or active state were imported into Backlog.']);
    expect(historyTaskStatus('completed')).toBe('done');
  });

  it('does not call an abandoned turn live and distinguishes an idle terminal from a working turn', async () => {
    const { project, store, changed } = fixture(); const items = [session(0, 'running'), session(1, 'completed'), session(2, 'completed'), session(3, 'unknown')];
    const activity = vi.fn(async (_project: Project, _provider: unknown, uuid: string) => uuid === items[1]!.sessionId ? 'working' as const : uuid === items[2]!.sessionId || uuid === items[3]!.sessionId ? 'idle' as const : null);
    const result = await new HistoryTaskImporter(fakeHistory(items).value, store, changed, activity).import(project);
    expect(store.state.tasks.map((task) => task.status)).toEqual(['backlog', 'running', 'done', 'waiting']); expect(result.warnings).toHaveLength(1);
  });

  it('keeps per-session errors separate and validates current project ownership before mutation', async () => {
    const { project, store, changed } = fixture(); const items = [session(0), session(1)]; const history = fakeHistory(items);
    history.resolve.mockRejectedValueOnce(new Error('Session moved to another project.'));
    const result = await new HistoryTaskImporter(history.value, store, changed).import(project);
    expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [{ sourceId: items[0]!.id, message: 'Session moved to another project.' }] });
    expect(store.state.tasks[0]!.externalHistory!.sessionId).toBe(items[1]!.sessionId);
    await expect(new HistoryTaskImporter(history.value, store, changed).import({ ...project, id: 'different-project' })).rejects.toThrow('Project changed');
    expect(store.state.tasks).toHaveLength(1);
  });

  it('uses only the shared public transcript adapter as compatibility fallback and persists no transcript or tool events', async () => {
    const { project, store, changed } = fixture(); const item = session(0); delete item.firstUserMessage; const history = fakeHistory([item]);
    history.detail.mockResolvedValue({ session: item, messages: [{ id: 'public-user', taskId: '', runId: item.id, agentId: null, authorType: 'user', authorName: 'User', text: 'The first real public user request.', createdAt: at }], events: [{ id: 'private-unused', message: 'SHOULD_NOT_COPY_TRANSCRIPT', data: { secret: 'PRIVATE_UNUSED_TOOL' } }] as any, nextCursor: null, warnings: [], truncated: false });
    const result = await new HistoryTaskImporter(history.value, store, changed).import(project);
    expect(result.imported).toBe(1); expect(store.state.tasks[0]!.description).toBe('The first real public user request.');
    expect(store.persistedSnapshot()).not.toMatch(/SHOULD_NOT_COPY_TRANSCRIPT|PRIVATE_UNUSED_TOOL/); expect(store.state.events).toEqual([]); expect(store.state.messages).toEqual([]);
  });

  it('reconciles linked source progress while preserving manually moved cards and ignoring disappearance', async () => {
    const { project, store, changed } = fixture(); const items = [session(0, 'running'), session(1, 'running'), session(2, 'completed')]; const history = fakeHistory(items); const importer = new HistoryTaskImporter(history.value, store, changed);
    await importer.import(project); store.state.tasks[1]!.status = 'backlog';
    await importer.reconcile(project, [{ ...items[0]!, status: 'completed' }, { ...items[1]!, status: 'completed' }, { ...items[2]!, status: 'unknown' }]);
    expect(store.state.tasks.map((task) => task.status)).toEqual(['done', 'backlog', 'done']); expect(changed).toHaveBeenCalledTimes(2);
    await importer.reconcile(project, []); expect(store.state.tasks).toHaveLength(3); expect(changed).toHaveBeenCalledTimes(2);
  });

  it('uses actual scoped Codex history without modifying its source or creating tasks for native children', async () => {
    const { root, workspace, project, store, changed } = fixture(); const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'); mkdirSync(join(codexHome, 'sessions'), { recursive: true }); mkdirSync(claudeHome);
    const uuid = randomUUID(), child = randomUUID(), other = join(root, 'other'); mkdirSync(other);
    const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const path = join(codexHome, 'sessions', `rollout-${uuid}.jsonl`);
    writeFileSync(path, jsonl([
      { type: 'session_meta', timestamp: at, payload: { id: uuid, cwd: workspace, base_instructions: 'PRIVATE_SYSTEM' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_DEVELOPER' }] } },
      { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: '<environment_context>PRIVATE_CONTEXT</environment_context>' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'Create the public report.\nUse the existing files.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_UNUSED_TRANSCRIPT' }] } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
    ]));
    writeFileSync(join(codexHome, 'session_index.jsonl'), jsonl([{ id: uuid, thread_name: 'Exact terminal title', updated_at: at }]));
    writeFileSync(join(codexHome, 'sessions', `rollout-${child}.jsonl`), jsonl([{ type: 'session_meta', timestamp: at, payload: { id: child, cwd: workspace, source: { subagent: { thread_spawn: { parent_thread_id: uuid } } } } }]));
    writeFileSync(join(codexHome, 'sessions', 'other.jsonl'), jsonl([{ type: 'session_meta', timestamp: at, payload: { id: randomUUID(), cwd: other } }]));
    const original = readFileSync(path, 'utf8'); const history = new SessionHistory({ codexHome, claudeHome });
    const result = await new HistoryTaskImporter(history, store, changed).import(project);
    expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] }); expect(store.state.tasks[0]).toMatchObject({ title: 'Exact terminal title', description: 'Create the public report.\nUse the existing files.', status: 'done', currentRunId: null });
    expect(readFileSync(path, 'utf8')).toBe(original); expect(store.persistedSnapshot()).not.toMatch(/PRIVATE_|base_instructions|role.*developer/);
  });

  it('imports Claude custom titles and the first real user request while excluding meta prompts and tool results', async () => {
    const { root, workspace, project, store, changed } = fixture(); const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'); mkdirSync(codexHome); const directory = join(claudeHome, 'projects', 'encoded-project'); mkdirSync(directory, { recursive: true });
    const uuid = randomUUID(), path = join(directory, `${uuid}.jsonl`);
    writeFileSync(path, [
      { type: 'user', sessionId: uuid, cwd: workspace, timestamp: at, isMeta: true, message: { content: 'PRIVATE_META_PROMPT' } },
      { type: 'user', sessionId: uuid, cwd: workspace, timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'PRIVATE_INITIAL_TOOL_OUTPUT' }] } },
      { type: 'user', sessionId: uuid, cwd: workspace, timestamp: at, message: { content: 'Prepare the invoice page.\nKeep the filters.' } },
      { type: 'custom-title', sessionId: uuid, customTitle: 'Old native title' },
      { type: 'custom-title', sessionId: uuid, customTitle: 'Invoice console session' },
      { type: 'assistant', sessionId: uuid, cwd: workspace, timestamp: at, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE_UNUSED_TRANSCRIPT' }, { type: 'thinking', thinking: 'PRIVATE_REASONING' }] } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const original = readFileSync(path, 'utf8');
    const result = await new HistoryTaskImporter(new SessionHistory({ codexHome, claudeHome }), store, changed).import(project);
    expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] }); expect(store.state.tasks[0]).toMatchObject({ title: 'Invoice console session', description: 'Prepare the invoice page.\nKeep the filters.', status: 'done' });
    expect(readFileSync(path, 'utf8')).toBe(original); expect(store.persistedSnapshot()).not.toContain('PRIVATE_');
  });

  it('exposes authenticated bulk import and requires explicit requeue before scheduling a source-linked card', async () => {
    const { root, workspace, project, store } = fixture(); const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude'); mkdirSync(join(codexHome, 'sessions'), { recursive: true }); mkdirSync(claudeHome); const uuid = randomUUID();
    writeFileSync(join(codexHome, 'sessions', 'source.jsonl'), [
      { type: 'session_meta', timestamp: at, payload: { id: uuid, cwd: workspace } },
      { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'Import this existing work.' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    store.close(); const server = await startControlServer({ port: 0, dataDir: store.directory, token: 'import-test', history: { codexHome, claudeHome } }); servers.push(server); server.service.updateSettings({ autoSyncSeconds: 0 });
    vi.spyOn(server.service.liveSessions, 'activity').mockResolvedValue(null);
    const request = (path: string, method = 'POST', input: unknown = {}) => fetch(`${server.url}/api/${path}`, { method, headers: { authorization: 'Bearer import-test', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect((await fetch(`${server.url}/api/projects/${project.id}/sessions/import`, { method: 'POST' })).status).toBe(401);
    expect((await request('projects/wrong-project/sessions/import')).status).toBe(404);
    const imported = await request(`projects/${project.id}/sessions/import`); expect(imported.status).toBe(200); const result = await imported.json(); expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
    const task = server.service.task(result.taskIds[0]); expect(task).toMatchObject({ title: 'Import this existing work.', description: 'Import this existing work.', status: 'done', currentRunId: null, autoStart: false });
    expect((await request(`projects/${project.id}/sessions/import`).then((response) => response.json()))).toMatchObject({ imported: 0, skipped: 1 });
    expect((await request(`tasks/${task.id}/run`)).status).toBe(409); expect(server.service.snapshot().runs).toEqual([]);
    server.service.updateSettings({ systemEnabled: false });
    server.service.updateTask(task.id, { status: 'ready' });
    expect(server.service.task(task.id).queuedContinuation).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(server.service.task(task.id)).toMatchObject({ status: 'ready', currentRunId: null }); expect(server.service.task(task.id).queueReason).toBeUndefined(); expect(server.service.snapshot().runs).toEqual([]);
  });
});
