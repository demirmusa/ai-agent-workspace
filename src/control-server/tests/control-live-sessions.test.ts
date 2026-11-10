import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startControlServer, type RunningControlServer } from '../server.js';
import type { ProcessEvidence } from '../live-sessions.js';
import type { Run } from '../types.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-live-')); roots.push(root);
  const workspace = join(root, 'workspace'), other = join(root, 'unregistered'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  for (const path of [workspace, other, join(codexHome, 'sessions'), join(codexHome, 'thread-writer-locks'), join(claudeHome, 'sessions'), join(claudeHome, 'projects', 'encoded')]) mkdirSync(path, { recursive: true });
  const evidence: ProcessEvidence = { processes: [{ pid: 12345, name: 'codex.exe', command: 'codex --no-daemon' }], owners: {} };
  let scans = 0;
  const server = await startControlServer({ port: 0, token: 'live-test', dataDir: join(root, 'data'), history: { codexHome, claudeHome }, liveSessions: { evidence: async () => { scans++; return evidence; } } }); servers.push(server);
  server.service.updateSettings({ autoSyncSeconds: 0 });
  const project = server.service.createProject({ name: 'Registered', repositoryPath: workspace });
  const request = (path: string, method = 'GET', data?: unknown, authorized = true) => fetch(`${server.url}/api/${path}`, { method, headers: { ...(authorized ? { authorization: 'Bearer live-test' } : {}), 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  function codex(cwd = workspace, active = true, extra: unknown[] = [], id = randomUUID()) {
    const path = join(codexHome, 'sessions', `rollout-${id}.jsonl`), lock = join(codexHome, 'thread-writer-locks', `${id}.lock`);
    writeFileSync(path, jsonl([{ type: 'session_meta', timestamp: '2026-10-16T10:00:00Z', payload: { id, cwd } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'My public request' }] } }, { type: 'event_msg', timestamp: '2026-10-16T11:00:00Z', payload: { type: 'task_started' } }, ...extra]));
    writeFileSync(lock, ''); if (active) evidence.owners[lock] = [12345];
    appendFileSync(join(codexHome, 'session_index.jsonl'), jsonl([{ id, thread_name: 'Native console name', updated_at: '2026-10-16T10:00:00Z' }]));
    return { path, lock, id };
  }
  return { root, workspace, other, codexHome, claudeHome, evidence, server, project, request, codex, scans: () => scans };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('external live provider sessions', () => {
  it('requires a live provider file owner, groups exact cwd, reuses canonical names and never creates state while watching', async () => {
    const { server, project, request, codex, other } = await setup(); const current = codex(); const external = codex(other); codex(undefined, false);
    await server.service.store.flush(); const before = server.service.store.persistedSnapshot(); const source = readFileSync(current.path, 'utf8');
    const page = await request('live-sessions').then((r) => r.json()); expect(page.items).toHaveLength(2);
    const registered = page.items.find((item: any) => item.sessionId === current.id), unknown = page.items.find((item: any) => item.sessionId === external.id);
    expect(registered).toMatchObject({ title: 'Native console name', projectId: project.id, projectName: 'Registered', active: true, activity: 'working', canResume: false, readOnly: true, processId: 12345 });
    expect(unknown.projectId).toBeNull(); expect(unknown.projectName).toBe('unregistered');
    const detail = await request(`live-sessions/${registered.id}`).then((r) => r.json()); expect(detail.session.title).toBe(registered.title); expect(JSON.stringify(detail.messages)).toContain('My public request');
    const graph = await request(`live-sessions/${registered.id}/agents`).then((r) => r.json()); expect(graph.agentTree.rootId).toBe(`codex:${current.id}`);
    expect((await request(`live-sessions/${unknown.id}`)).status).toBe(200); expect((await request('live-sessions', 'GET', undefined, false)).status).toBe(401);
    await server.service.store.flush(); expect(server.service.store.persistedSnapshot()).toBe(before); expect(readFileSync(current.path, 'utf8')).toBe(source);
    expect(server.service.snapshot().tasks).toHaveLength(0); expect(server.service.snapshot().runs).toHaveLength(0); expect(server.service.snapshot().projects).toHaveLength(1);
  });

  it('drops exited owners and rejects duplicate resume without treating recent files as running', async () => {
    const { server, request, project, codex, evidence } = await setup(); const source = codex();
    const first = await request('live-sessions').then((r) => r.json()); const id = first.items[0].id;
    expect((await request(`projects/${project.id}/sessions/${id}/resume`, 'POST', { message: 'Do not fork', terminalMode: 'stream' })).status).toBe(409);
    evidence.processes = []; server.service.liveSessions.invalidate();
    expect((await request('live-sessions').then((r) => r.json())).items).toEqual([]);
    expect((await request(`live-sessions/${id}`)).status).toBe(409); expect(server.service.snapshot().tasks).toHaveLength(0);
    expect(readFileSync(source.path, 'utf8')).toContain('My public request');
  });

  it('deduplicates managed original UUID/cwd and exposes provider names independently from task business titles', async () => {
    const { server, project, codex, request, workspace } = await setup(); const source = codex(undefined,true,[{type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'medium'}}]);
    const task = server.service.createTask({ projectId: project.id, title: 'Business task title', description: '', status: 'backlog', provider: 'codex' });
    const run: Run = { id: 'run-managed', taskId: task.id, provider: 'codex', sessionId: source.id, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(run); server.service.task(task.id).currentRunId = run.id;
    const page = await request('live-sessions').then((r) => r.json()); expect(page.items).toEqual([]); expect(page.managedTitles[run.id]).toBe('Native console name'); expect(server.service.task(task.id).title).toBe('Business task title');
    expect(server.service.run(run.id).executionInfo).toMatchObject({model:'gpt-6.1-sol',reasoningEffort:'medium',modelSource:'reported',cwd:workspace});
    await server.service.store.flush(); expect(server.service.store.readPersisted().runs[0]!.executionInfo.model).toBe('gpt-6.1-sol');
    expect(await server.service.liveSessions.activity({ ...project, repositoryPath: workspace }, 'codex', source.id)).toBe('working');
  });

  it('reads latest native renames immediately and ignores hidden/command setup when finding the first real user message', async () => {
    const { server, project, codexHome, claudeHome, workspace, codex } = await setup(); const source = codex();
    let list = await server.service.history.list(project); expect(list.items[0]!.title).toBe('Native console name'); expect(list.items[0]!.firstUserMessage).toBe('My public request');
    appendFileSync(join(codexHome, 'session_index.jsonl'), jsonl([{ id: source.id, thread_name: 'Renamed in native console' }]));
    list = await server.service.history.list(project); expect(list.items[0]!.title).toBe('Renamed in native console');
    const id = randomUUID(), path = join(claudeHome, 'projects', 'encoded', `${id}.jsonl`);
    writeFileSync(path, jsonl([{ type: 'user', sessionId: id, cwd: workspace, message: { content: '<command-name>/clear</command-name>' } }, { type: 'user', isMeta: true, sessionId: id, message: { content: 'PRIVATE_META' } }, { type: 'user', sessionId: id, message: { content: 'Actual Claude user prompt' } }, { type: 'custom-title', sessionId: id, customTitle: 'First native name' }, { type: 'custom-title', sessionId: id, customTitle: 'Current native name' }]));
    await new Promise((resolve) => setTimeout(resolve, 2050));
    const claude = (await server.service.history.list(project, { refresh: true })).items.find((entry) => entry.provider === 'claude')!; expect(claude.title).toBe('Current native name'); expect(claude.firstUserMessage).toBe('Actual Claude user prompt');
    appendFileSync(path, jsonl([{ type: 'custom-title', sessionId: id, customTitle: 'Latest Claude rename' }])); expect((await server.service.history.resolve(project, claude.id)).session.title).toBe('Latest Claude rename');
  });

  it('validates Claude PID identity and registry cwd instead of using stale or mismatched session hints', async () => {
    const { server, evidence, claudeHome, workspace, request } = await setup(); const id = randomUUID(), path = join(claudeHome, 'projects', 'encoded', `${id}.jsonl`); const startedAt = '2026-10-16T10:00:00Z';
    writeFileSync(path, jsonl([{ type: 'user', sessionId: id, cwd: workspace, message: { content: 'Claude request' } }]));
    const registry = join(claudeHome, 'sessions', '23456.json'); evidence.processes.push({ pid: 23456, name: 'claude.exe', command: 'claude', startedAt });
    writeFileSync(registry, JSON.stringify({ pid: 23456, sessionId: id, cwd: workspace, startedAt: Date.parse(startedAt), status: 'idle' }));
    expect((await request('live-sessions').then((r) => r.json())).items[0]).toMatchObject({ provider: 'claude', activity: 'idle' });
    writeFileSync(registry, JSON.stringify({ pid: 23456, sessionId: id, cwd: workspace, startedAt: 0, status: 'working' })); server.service.liveSessions.invalidate(); expect((await request('live-sessions').then((r) => r.json())).items).toEqual([]);
  });

  it('single-flights bounded metadata discovery', async () => {
    const { server, request, codex, scans } = await setup(); codex(); codex(undefined, true, [], randomUUID());
    await Promise.all(Array.from({ length: 8 }, () => request('live-sessions'))); expect(scans()).toBe(1);
    expect(server.service.snapshot().events).toEqual([]);
  });

  it('keeps the full live context after project activity checks and refreshes names without recreating managed sessions', async () => {
    const { server, project, other, request, codex } = await setup(); const a = codex(), b = codex(other);
    const otherProject = server.service.createProject({ name: 'Other registered', repositoryPath: other });
    const task = server.service.createTask({ projectId: otherProject.id, title: 'Managed business task', status: 'backlog', provider: 'codex' });
    const run: Run = { id: 'run-other-context', taskId: task.id, provider: 'codex', sessionId: b.id, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(run); server.service.task(task.id).currentRunId = run.id;
    const initial = await request('live-sessions').then((r) => r.json()); expect(initial.items.map((entry: any) => entry.sessionId)).toEqual([a.id]); expect(initial.managedTitles[run.id]).toBe('Native console name');
    expect(await server.service.liveSessions.activity(project, 'codex', a.id)).toBe('working');
    const after = await request('live-sessions').then((r) => r.json()); expect(after).toEqual(initial);
    expect((await request(`live-sessions/${initial.items[0].id}`)).status).toBe(200);
    server.service.store.state.runs[0]!.status = 'completed'; server.service.liveSessions.invalidate();
    const finished = await request('live-sessions').then((r) => r.json()); expect(finished.items).toHaveLength(2); expect(finished.items.find((entry: any) => entry.sessionId === b.id).projectId).toBe(otherProject.id);
  });

  it('finds first public messages after a large setup prefix without exposing hidden context or tool results', async () => {
    const { server, project, workspace, codexHome, claudeHome, request } = await setup();
    const codexId = randomUUID(), claudeId = randomUUID();
    writeFileSync(join(codexHome, 'sessions', `rollout-${codexId}.jsonl`), jsonl([
      { type: 'session_meta', timestamp: '2026-10-16T10:00:00Z', payload: { id: codexId, cwd: workspace } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_SETUP'.repeat(12000) }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_CONTEXT</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'The real Codex request after setup.' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]));
    writeFileSync(join(claudeHome, 'projects', 'encoded', `${claudeId}.jsonl`), jsonl([
      { type: 'user', sessionId: claudeId, cwd: workspace, isMeta: true, message: { content: 'PRIVATE_META'.repeat(12000) } },
      { type: 'user', sessionId: claudeId, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'PRIVATE_RESULT' }] } },
      { type: 'user', sessionId: claudeId, message: { content: 'The real Claude request after setup.' } },
      { type: 'assistant', sessionId: claudeId, message: { stop_reason: 'end_turn', content: [] } },
    ]));
    const page = await server.service.history.list(project); expect(page.items).toHaveLength(2);
    expect(page.items.find((entry) => entry.sessionId === codexId)).toMatchObject({ title: 'The real Codex request after setup.', firstUserMessage: 'The real Codex request after setup.' });
    expect(page.items.find((entry) => entry.sessionId === claudeId)).toMatchObject({ title: 'The real Claude request after setup.', firstUserMessage: 'The real Claude request after setup.' });
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    const result = await request(`projects/${project.id}/sessions/import`, 'POST', {}).then((r) => r.json()); expect(result).toMatchObject({ imported: 2, errors: [] });
    const tasks = server.service.snapshot().tasks; expect(tasks.map((task) => task.description).sort()).toEqual(['The real Claude request after setup.', 'The real Codex request after setup.']); expect(tasks.every((task) => task.status === 'done')).toBe(true);
    await server.service.store.flush(); expect(server.service.store.persistedSnapshot()).not.toContain('PRIVATE_');
  });
});
