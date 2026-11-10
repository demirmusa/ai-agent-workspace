import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startControlServer, type RunningControlServer } from '../server.js';
import { prepareRuntime } from '../runner.js';
import type { Project, Run, Task } from '../types.js';
import { CONTINUE_MESSAGE } from '../service/run-prompt.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-history-')); roots.push(root);
  const workspace = join(root, 'workspace'), other = join(root, 'other'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  for (const path of [workspace, other, join(codexHome, 'sessions', '2026', '10', '16'), join(claudeHome, 'projects', 'encoded-project')]) mkdirSync(path, { recursive: true });
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'history-test', history: { codexHome, claudeHome }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); servers.push(server); server.service.updateSettings({ autoSyncSeconds: 0 });
  const project = server.service.createProject({ useWorktree: false, name: 'History', repositoryPath: workspace }); const otherProject = server.service.createProject({ name: 'Other', repositoryPath: other });
  const request = (path: string, method = 'GET', input?: unknown) => fetch(`${server.url}/api/${path}`, { method, headers: { authorization: 'Bearer history-test', 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  function codex(cwd = workspace, sessionId = randomUUID(), extra: unknown[] = []) {
    const path = join(codexHome, 'sessions', '2026', '10', '16', `rollout-${sessionId}.jsonl`);
    writeFileSync(path, jsonl([{ type: 'session_meta', timestamp: '2026-10-15T12:00:00Z', payload: { id: sessionId, cwd, base_instructions: 'PRIVATE_SYSTEM_INSTRUCTIONS', creator_account_id: 'PRIVATE_ACCOUNT' } }, { type: 'event_msg', timestamp: '2026-10-15T12:00:01Z', payload: { type: 'user_message', message: 'Continue my public work' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue my public work' }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Public assistant reply' }] } }, ...extra]));
    return { path, sessionId };
  }
  function claude(cwd = workspace, sessionId = randomUUID()) {
    const path = join(claudeHome, 'projects', 'encoded-project', `${sessionId}.jsonl`);
    writeFileSync(path, jsonl([{ type: 'mode', sessionId, mode: 'default' }, { type: 'user', sessionId, cwd, timestamp: '2026-10-15T10:00:00Z', message: { role: 'user', content: 'Claude user request' } }, { type: 'assistant', sessionId, cwd, message: { id: 'message-one', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }, { type: 'text', text: 'Claude visible reply' }, { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: 'src/main.ts' } }] } }, { type: 'user', sessionId, cwd, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'Visible file content' }] } }]));
    return { path, sessionId };
  }
  return { root, workspace, other, codexHome, claudeHome, server, project, otherProject, request, codex, claude };
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('read-only scoped provider session history', () => {
  it.each(['codex', 'claude'] as const)('keeps a %s session resumable after working in a project subfolder', async provider => {
    const { server, project, workspace, other, codex, claude } = await setup();
    const nested = join(workspace, 'src'); mkdirSync(nested);
    const source = provider === 'codex' ? codex() : claude();
    const historical = (await server.service.history.list(project)).items[0]!;
    const original = readFileSync(source.path, 'utf8');
    const context = (cwd: string) => provider === 'codex'
      ? { type: 'turn_context', payload: { cwd } }
      : { type: 'assistant', sessionId: source.sessionId, cwd, message: { content: 'Working in src' } };
    writeFileSync(source.path, original + jsonl([context(nested)]));
    expect(() => server.service.history.assertResume(project, historical.id, source.sessionId)).not.toThrow();
    expect((await server.service.history.resolve(project, historical.id)).session.sessionId).toBe(source.sessionId);
    writeFileSync(source.path, original + jsonl([context(other)]));
    expect(() => server.service.history.assertResume(project, historical.id, source.sessionId)).toThrow('Session source changed');
    const linked = join(workspace, 'linked-outside'); symlinkSync(other, linked, 'junction');
    writeFileSync(source.path, original + jsonl([context(linked)]));
    expect(() => server.service.history.assertResume(project, historical.id, source.sessionId)).toThrow('Session source changed');
  });

  it('reads a task continuation from its worktree without exposing it through another project', async () => {
    const { server, project, otherProject, workspace, other, request, codex } = await setup();
    const source = codex(other), imported = codex();
    const pointer = await server.service.history.findSession({ ...project, repositoryPath: other }, 'codex', source.sessionId);
    const task = server.service.createTask({ projectId: project.id, title: 'Continued work', provider: 'codex' });
    const stored = server.service.task(task.id);
    stored.worktree = { path: other, repositoryPath: workspace, branch: 'task', mainBranch: 'main' };
    stored.historyResume = { provider: 'codex', sessionId: source.sessionId, sourceId: pointer!.session.id, initialMessage: 'Continue' };
    expect((await request(`projects/${project.id}/sessions/${pointer!.session.id}`)).status).toBe(404);
    const response = await request(`tasks/${task.id}/history`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: { sessionId: source.sessionId }, messages: [expect.objectContaining({ text: 'Continue my public work' })] });
    expect((await request(`tasks/${task.id}/history/agents`)).status).toBe(200);
    const unrelated = server.service.createTask({ projectId: otherProject.id, title: 'Unrelated', provider: 'codex' });
    expect((await request(`tasks/${unrelated.id}/history`)).status).toBe(404);
    // An imported source remains scoped to the original project even if the task has a worktree.
    const original = await server.service.history.findSession(project, 'codex', imported.sessionId);
    stored.externalHistory = { provider: 'codex', sessionId: imported.sessionId, sourceId: original!.session.id, importedAt: task.createdAt, status: 'unknown', syncedStatus: 'done' };
    expect(await (await request(`tasks/${task.id}/history`)).json()).toMatchObject({ session: { sessionId: imported.sessionId } });
  });

  it('reads the latest model and effort labels without exposing session instructions', async () => {
    const { server, project, codex } = await setup();
    const session=codex(undefined,undefined,[{type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'low',developer_instructions:'PRIVATE'}},{type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'medium'}}]);
    const pointer=await server.service.history.findSession(project,'codex',session.sessionId);
    expect(pointer).not.toBeNull();
    expect(await server.service.history.executionInfo(pointer!)).toEqual({cwd:project.repositoryPath,model:'gpt-6.1-sol',modelSource:'reported',reasoningEffort:'medium'});
  });

  it('discovers exact canonical project sessions with bounded pagination and opaque cross-project protection without writes', async () => {
    const { server, project, otherProject, request, codex, claude, other } = await setup(); const a = codex(), b = claude(); codex(other);
    await server.service.store.flush(); const before = JSON.stringify(server.service.snapshot()), disk = readFileSync(server.service.store.path, 'utf8'), aSource = readFileSync(a.path, 'utf8'), bSource = readFileSync(b.path, 'utf8');
    expect((await fetch(`${server.url}/api/projects/${project.id}/sessions`)).status).toBe(401);
    const list = await request(`projects/${project.id}/sessions?limit=1`).then((r) => r.json()); expect(list.items).toHaveLength(1); expect(list.nextCursor).toBe('1'); expect(list.items[0].id).toMatch(/^hist_[a-f0-9]{40}$/);
    const next = await request(`projects/${project.id}/sessions?limit=1&cursor=1`).then((r) => r.json()); expect(next.items).toHaveLength(1); expect(next.items[0].provider).not.toBe(list.items[0].provider);
    expect((await request(`projects/${project.id}/sessions?provider=codex`).then((r) => r.json())).items[0].sessionId).toBe(a.sessionId);
    expect((await request(`projects/${otherProject.id}/sessions/${list.items[0].id}`)).status).toBe(404);
    expect((await request(`projects/${project.id}/sessions?limit=1000`)).status).toBe(400); expect((await request(`projects/${project.id}/sessions?provider=command`)).status).toBe(400);
    await server.service.store.flush(); expect(JSON.stringify(server.service.snapshot())).toBe(before); expect(readFileSync(server.service.store.path, 'utf8')).toBe(disk); expect(readFileSync(a.path, 'utf8')).toBe(aSource); expect(readFileSync(b.path, 'utf8')).toBe(bSource);
  });

  it('searches every indexed project session with stable pages, sort orders, provider counts and bounded input', async () => {
    const { server, project, request, codexHome, claudeHome, workspace, other } = await setup(); const folder = join(codexHome, 'sessions', '2026', '10', '16'); const ids: string[] = [];
    const write = (index: number, message: string, cwd = workspace, rows: unknown[] = []) => {
      const sessionId = `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`; const path = join(folder, `rollout-search-${index}.jsonl`); if (cwd === workspace) ids.push(sessionId);
      writeFileSync(path, jsonl([{ type: 'session_meta', timestamp: new Date(Date.UTC(2026, 0, 1 + (index * 7) % 40)).toISOString(), payload: { id: sessionId, cwd } }, ...rows, { type: 'event_msg', payload: { type: 'user_message', message } }]));
      const time = new Date(Date.UTC(2026, 5, 1, 0, index)); utimesSync(path, time, time); return sessionId;
    };
    for (let index = 0; index < 40; index++) write(index, index % 6 === 0 ? `Repair the Needle cache ${index}` : `Regular work item ${index}`);
    const turkish = write(40, 'İşlem kuyruğunu düzelt'), renamed = write(41, 'Plain request'), deep = write(42, 'Deep needle hidden after setup', workspace, [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x'.repeat(120 * 1024) }] } }]);
    write(43, 'Needle from another project', other); writeFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: renamed, thread_name: 'Quarterly Ledger migration' })}\n`);
    const claudeId = randomUUID(); writeFileSync(join(claudeHome, 'projects', 'encoded-project', `${claudeId}.jsonl`), jsonl([{ type: 'user', sessionId: claudeId, cwd: workspace, timestamp: '2026-01-01T00:00:00Z', message: { content: 'Claude needle review' } }]));
    const page = (query: string) => request(`projects/${project.id}/sessions?${query}`).then((response) => response.json());

    const first = await page('q=needle&limit=4'); expect(first.total).toBe(9); expect(first.counts).toEqual({ codex: 8, claude: 1 }); expect(first.items).toHaveLength(4); expect(first.nextCursor).toBe('4');
    const rest = [first]; let cursor = first.nextCursor; while (cursor) { const next = await page(`q=needle&limit=4&cursor=${cursor}`); rest.push(next); cursor = next.nextCursor; }
    const found = rest.flatMap((entry) => entry.items); expect(found).toHaveLength(9); expect(new Set(found.map((item: { id: string }) => item.id)).size).toBe(9);
    expect(found.map((item: { sessionId: string }) => item.sessionId)).toContain(deep); expect(JSON.stringify(found)).not.toContain('another project');
    expect((await page('q=NEEDLE%20cache&provider=codex')).total).toBe(7); expect((await page('q=needle&provider=claude')).items.map((item: { sessionId: string }) => item.sessionId)).toEqual([claudeId]);
    expect((await page('q=islem%20KUYRUGU')).items.map((item: { sessionId: string }) => item.sessionId)).toEqual([turkish]);
    expect((await page('q=ledger')).items.map((item: { sessionId: string; title: string }) => [item.sessionId, item.title])).toEqual([[renamed, 'Quarterly Ledger migration']]);
    expect((await page(`q=${ids[5]!.slice(-12)}`)).items.map((item: { sessionId: string }) => item.sessionId)).toEqual([ids[5]]);
    expect(await page('q=nothing%20matches%20this')).toMatchObject({ items: [], total: 0, nextCursor: null, counts: { codex: 0, claude: 0 } });

    const all = await page('limit=100'); expect(all.total).toBe(44); expect(all.counts).toEqual({ codex: 43, claude: 1 });
    const oldest = await page('limit=100&sort=oldest'); expect(oldest.items.map((item: { id: string }) => item.id)).toEqual([...all.items].reverse().map((item: { id: string }) => item.id));
    const created = (await page('limit=100&sort=created')).items.map((item: { createdAt: string }) => item.createdAt); expect(created).toEqual([...created].sort().reverse());
    expect((await request(`projects/${project.id}/sessions?q=${'x'.repeat(201)}`)).status).toBe(400); expect((await request(`projects/${project.id}/sessions?sort=random`)).status).toBe(400); expect((await request(`projects/${project.id}/sessions?q=needle&limit=101`)).status).toBe(400);
    expect(server.service.snapshot().tasks).toHaveLength(0);
  });

  it('converts one historical session into a linked task idempotently without starting it', async () => {
    const { server, project, otherProject, request, codex } = await setup(); const a = codex(), b = codex();
    const items = (await request(`projects/${project.id}/sessions`).then((response) => response.json())).items as Array<{ id: string; sessionId: string }>; const source = items.find((item) => item.sessionId === a.sessionId)!;
    const first = await request(`projects/${project.id}/sessions/${source.id}/import`, 'POST', {}).then((response) => response.json()); expect(first).toMatchObject({ imported: 1, skipped: 0, errors: [] }); expect(first.taskIds).toHaveLength(1);
    const task = server.service.snapshot().tasks.find((entry) => entry.id === first.taskIds[0])!; expect(task.externalHistory).toMatchObject({ sourceId: source.id, sessionId: a.sessionId }); expect(task.description).toBe('Continue my public work'); expect(server.service.snapshot().runs).toHaveLength(0);
    const again = await request(`projects/${project.id}/sessions/${source.id}/import`, 'POST', {}).then((response) => response.json()); expect(again).toMatchObject({ imported: 0, skipped: 1, taskIds: [task.id] });
    expect((await request(`projects/${otherProject.id}/sessions/${source.id}/import`, 'POST', {})).status).toBe(404); expect((await request(`projects/${project.id}/sessions/not-a-source/import`, 'POST', {})).status).toBe(400);
    const bulk = await request(`projects/${project.id}/sessions/import`, 'POST', {}).then((response) => response.json()); expect(bulk).toMatchObject({ imported: 1, skipped: 1 }); expect(server.service.snapshot().tasks.map((entry) => entry.externalHistory?.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
  });

  it('projects only public messages/tools, deduplicates user records and excludes internal reasoning/config metadata', async () => {
    const { project, request, codex, claude } = await setup(); codex(undefined, undefined, [{ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'PRIVATE_ENCRYPTED_REASONING' } }, { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_DEVELOPER' }] } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'codex-call-123', name: 'exec_command', arguments: '{"command":"npm test"}' } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'codex-call-123', output: 'Tests passed' } }]); claude();
    const list = await request(`projects/${project.id}/sessions`).then((r) => r.json());
    for (const item of list.items) {
      const detail = await request(`projects/${project.id}/sessions/${item.id}`).then((r) => r.json()); const serialized = JSON.stringify(detail);
      expect(serialized).not.toMatch(/PRIVATE_|base_instructions|encrypted_content|creator_account_id|signature/); expect(detail.messages).toHaveLength(1);
      if (item.provider === 'codex') { expect(detail.messages[0].text).toBe('Continue my public work'); expect(detail.events).toHaveLength(3); expect(detail.events[0].message).toContain('Public assistant reply'); expect(serialized).toContain('codex-call-123'); expect(serialized).toContain('npm test'); expect(serialized).toContain('Tests passed'); }
      else { expect(serialized).toContain('Claude visible reply'); expect(serialized).toContain('tool-123'); expect(serialized).toContain('Visible file content'); expect(detail.events).toHaveLength(2); }
    }
  });

  it('reads what the human typed while the agent worked, typed commands and real Codex work', async () => {
    const { project, request, claudeHome, codex, workspace } = await setup(); const sessionId = randomUUID();
    const row = (fields: Record<string, unknown>) => ({ sessionId, cwd: workspace, timestamp: '2026-10-15T10:00:00Z', ...fields });
    writeFileSync(join(claudeHome, 'projects', 'encoded-project', `${sessionId}.jsonl`), jsonl([
      row({ type: 'user', message: { role: 'user', content: 'First request' } }),
      row({ type: 'queue-operation', operation: 'enqueue', content: 'Typed while working' }),
      row({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>background</task-notification>' }),
      row({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'Typed while working', origin: { kind: 'human' } } }),
      row({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'From a hook', origin: { kind: 'task-notification' } } }),
      row({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['PRIVATE_SYSTEM'] } }),
      row({ type: 'queue-operation', operation: 'popAll' }),
      row({ type: 'user', message: { role: 'user', content: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>' } }),
      row({ type: 'user', message: { role: 'user', content: '<bash-input>git status</bash-input>' } }),
      row({ type: 'user', message: { role: 'user', content: '<bash-stdout>PRIVATE_NOT_A_MESSAGE</bash-stdout><bash-stderr></bash-stderr>' } }),
      row({ type: 'user', message: { role: 'user', content: '<pasted_content id="1">Pasted words</pasted_content>' } }),
      row({ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', content: 'Conversation compacted' }),
      row({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'x', long: 'y'.repeat(40000), path: 'src' } }] } }),
      row({ type: 'user', toolUseResult: { numFiles: 2, numLines: 5, mode: 'content', filenames: ['PRIVATE_LIST'] }, message: { content: [{ type: 'tool_result', tool_use_id: 'grep-1', content: 'src/a.ts:1:x' }] } }),
    ]));
    codex(undefined, undefined, [{ type: 'event_msg', timestamp: '2026-10-15T12:00:02Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['pwsh.exe', '-Command', 'npm test'], parsed_cmd: [{ type: 'unknown', cmd: 'npm test' }], aggregated_output: 'ok', exit_code: 0, status: 'completed', duration: { secs: 1, nanos: 500000000 }, cwd: 'PRIVATE_CWD' } } }, { type: 'event_msg', timestamp: '2026-10-15T12:00:03Z', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'exec-2', status: 'completed', changes: { 'a.txt': { type: 'add', content: 'one\ntwo' } } } } }, { type: 'event_msg', timestamp: '2026-10-15T12:00:03Z', payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'r', summary_text: ['PRIVATE_REASONING'] } } }]);
    const list = await request(`projects/${project.id}/sessions`).then((r) => r.json());
    const read = (provider: string) => request(`projects/${project.id}/sessions/${list.items.find((item: any) => item.provider === provider).id}`).then((r) => r.json());
    const claude = await read('claude'), rows = claude.events.map((event: any) => JSON.parse(event.message));
    expect(JSON.stringify(claude)).not.toMatch(/PRIVATE_|task-notification|From a hook/);
    expect(rows.filter((item: any) => item.type === 'queued_message').map((item: any) => [item.op, item.text])).toEqual([['enqueue', 'Typed while working'], ['deliver', 'Typed while working'], ['clear', undefined]]);
    expect(claude.messages.map((message: any) => message.text)).toEqual(['First request', '/review 123', '! git status', 'Pasted words']);
    expect(rows.some((item: any) => item.type === 'system' && item.subtype === 'compact_boundary')).toBe(true);
    const call = rows.find((item: any) => item.type === 'assistant').message.content[0], result = rows.find((item: any) => item.type === 'user').message.content[0];
    expect(call.input).toMatchObject({ pattern: 'x', path: 'src', truncated: true }); expect(JSON.stringify(call.input).length).toBeLessThan(17000);
    expect(result.meta).toEqual({ numFiles: 2, numLines: 5, mode: 'content' });
    const codexDetail = await read('codex'), codexRows = codexDetail.events.map((event: any) => JSON.parse(event.message)).filter((item: any) => ['command_execution', 'file_change'].includes(item.item?.type));
    expect(JSON.stringify(codexDetail)).not.toMatch(/PRIVATE_/);
    expect(codexRows[0].item).toMatchObject({ id: 'exec-1', command: ['pwsh.exe', '-Command', 'npm test'], aggregated_output: 'ok', exit_code: 0, duration_ms: 1500 });
    expect(codexRows[1].item.changes).toEqual([{ path: 'a.txt', kind: 'add', diff: '+one\n+two' }]);
  });
  it('handles malformed/incomplete tails and byte cursors without crashes and rejects source symlinks or moved sessions', async () => {
    const { project, request, codex, codexHome, other } = await setup(); const source = codex();
    writeFileSync(source.path, `${readFileSync(source.path, 'utf8')}{"type":"broken"\n{"incomplete":`);
    const moved = codex(undefined, undefined, [{ type: 'turn_context', payload: { cwd: other } }]);
    const link = join(codexHome, 'sessions', 'linked.jsonl');
    // Windows directory junctions need no administrator/developer-mode privilege.
    symlinkSync(process.platform === 'win32' ? dirname(source.path) : source.path, link, process.platform === 'win32' ? 'junction' : 'file');
    const list = await request(`projects/${project.id}/sessions`).then((r) => r.json()); expect(list.items).toHaveLength(1); expect(list.items[0].sessionId).not.toBe(moved.sessionId);
    const first = await request(`projects/${project.id}/sessions/${list.items[0].id}?limit=1`).then((r) => r.json()); expect(first.messages).toHaveLength(1); expect(first.nextCursor).toMatch(/^\d+$/);
    const second = await request(`projects/${project.id}/sessions/${list.items[0].id}?cursor=${first.nextCursor}`).then((r) => r.json()); expect(second.events).toHaveLength(1); expect(second.warnings.length).toBeGreaterThan(0);
    expect((await request(`projects/${project.id}/sessions/${list.items[0].id}?cursor=1`)).status).toBe(400);
    writeFileSync(source.path, readFileSync(moved.path, 'utf8')); expect((await request(`projects/${project.id}/sessions/${list.items[0].id}`)).status).toBe(409);
  });

  it('uses scoped directory roots, pagination and canonical paths while refusing traversal and symlink escapes', async () => {
    const { root, workspace, request } = await setup(); vi.stubEnv('AIWS_CONTROL_BROWSE_ROOTS', workspace); mkdirSync(join(workspace, 'alpha')); mkdirSync(join(workspace, 'beta')); writeFileSync(join(workspace, 'file.txt'), 'not a directory'); symlinkSync(root, join(workspace, 'escape'), 'junction');
    const initial = await request('directories').then((r) => r.json()); expect(initial.roots.map((item: any) => item.path)).toEqual([workspace]); expect(initial.path).toBeNull();
    const page = await request(`directories?path=${encodeURIComponent(workspace)}&limit=1`).then((r) => r.json()); expect(page.items[0].name).toBe('alpha'); expect(page.parent).toBeNull(); expect(page.nextCursor).toBe('1');
    const next = await request(`directories?path=${encodeURIComponent(workspace)}&limit=1&cursor=1`).then((r) => r.json()); expect(next.items.map((item: any) => item.name)).toEqual(['beta']);
    expect((await request(`directories?path=${encodeURIComponent(root)}`)).status).toBe(403); expect((await request(`directories?path=${encodeURIComponent(join(workspace, 'escape'))}`)).status).toBe(403);
  });

  it('builds original-provider native resume without a new turn and bounded stream resume with only the new message', async () => {
    const { server, project, codex, claude } = await setup(); codex(); claude();
    const items = (await server.service.history.list(project)).items;
    for (const item of items) {
      const task: Task = { id: 'fixture', projectId: project.id, title: 'Never repeat historical task', description: '', provider: item.provider, priority: 0, status: 'ready', dependsOn: [], autoStart: false, currentRunId: null, createdAt: item.createdAt, updatedAt: item.updatedAt };
      const run: Run = { id: 'run_fixture', taskId: task.id, status: 'running', provider: item.provider, startedAt: item.createdAt, finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', inputDirectory: 'C:/bridge-input', historyResume: { sourceId: item.id, sessionId: item.sessionId, provider: item.provider, initialMessage: '' } };
      const native = prepareRuntime(project, task, run, 'SHOULD_NOT_BE_SENT', { image: 'fixture', controlUrl: 'http://localhost', providerHome: server.service.history.home(item.provider) });
      expect(native.args).toContain(item.sessionId); expect(native.args).toContain(item.provider === 'codex' ? 'resume' : '--resume'); expect(native.input).toBe(''); expect(native.args.join(' ')).not.toMatch(/SHOULD_NOT_BE_SENT|prompt\.md|Never repeat/); expect(native.args).not.toContain('--model');
      run.terminalMode = 'stream'; run.historyResume!.initialMessage = 'Only this new turn'; const stream = prepareRuntime(project, task, run, 'Only this new turn with bridge', { image: 'fixture', controlUrl: 'http://localhost' });
      expect(stream.args).toContain(item.sessionId); expect(stream.input).toBe('Only this new turn with bridge'); expect(stream.args).not.toContain('--fork-session');
    }
  });

  it('keeps the provider default home implicit so a resumed Claude CLI finds its own configuration', async () => {
    const { project } = await setup(); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); delete process.env.CLAUDE_CONFIG_DIR;
    const sessionId = randomUUID();
    const task: Task = { id: 'fixture', projectId: project.id, title: 'Resume', description: '', provider: 'claude', priority: 0, status: 'ready', dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' };
    const run: Run = { id: 'run_fixture', taskId: task.id, status: 'running', provider: 'claude', startedAt: '', finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', historyResume: { sourceId: 'hist_x', sessionId, provider: 'claude', initialMessage: '' } };
    expect(prepareRuntime(project, task, run, '', { image: 'fixture', controlUrl: 'http://localhost', providerHome: join(homedir(), '.claude') }).env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(prepareRuntime(project, task, run, '', { image: 'fixture', controlUrl: 'http://localhost', providerHome: join(project.repositoryPath, 'claude-home') }).env.CLAUDE_CONFIG_DIR).toBe(join(project.repositoryPath, 'claude-home'));
  });

  it('continues a history session off the board, reuses its record and reopens a finished task session without a new turn', async () => {
    const { server, project, request, codex } = await setup(); const source = codex(); const historical = (await server.service.history.list(project)).items[0]!;
    const service = server.service as unknown as { launcher: { launch: (run: Run) => void }; ctx: { handles: Map<string, { input?: (data: string) => void }> } };
    const launched: string[] = []; vi.spyOn(service.launcher, 'launch').mockImplementation((run: Run) => { launched.push(run.id); });
    const opened = await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'pty', message: '' }).then((r) => r.json());
    expect(opened.task.sessionContinuation).toBe(true); expect(opened.run).toMatchObject({ terminalMode: 'pty', sessionId: source.sessionId });
    // Chat instructions interrupt the native TUI with Escape, then arrive as typed text followed by a separate Enter.
    const typed: string[] = []; service.ctx.handles.set(opened.run.id, { input: (data) => typed.push(data) });
    expect((await request(`tasks/${opened.task.id}/messages`, 'POST', { text: 'ONE_MORE_QUESTION', continueSession: true })).status).toBe(201);
    expect(typed).toEqual(['\u001b']); await vi.waitFor(() => expect(typed).toEqual(['\u001b', 'ONE_MORE_QUESTION', '\r']));
    service.ctx.handles.delete(opened.run.id); await server.service.stop(opened.run.id);
    const again = await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'pty', message: '' }).then((r) => r.json());
    expect(again.task.id).toBe(opened.task.id); expect(again.run.id).not.toBe(opened.run.id); expect(server.service.snapshot().tasks).toHaveLength(1);
    expect(server.service.task(opened.task.id).status).toBe('running'); expect(again.run.sessionId).toBe(source.sessionId);
    expect((await request(`tasks/${opened.task.id}/resume-session`, 'POST', {})).status).toBe(409);
    await server.service.stop(again.run.id);
    // A finished task with a regular provider run resumes the same session in a terminal on demand.
    const task = server.service.createTask({ projectId: project.id, title: 'Finished task', description: 'NEVER_REPEAT', status: 'done', provider: 'codex', terminalMode: 'stream' });
    const previous: Run = { id: 'run_finished', taskId: task.id, provider: 'codex', sessionId: source.sessionId, status: 'completed', startedAt: historical.createdAt, finishedAt: historical.updatedAt, exitCode: 0, executionMode: 'native', terminalMode: 'stream', pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(previous); server.service.task(task.id).currentRunId = previous.id;
    const resumed = await request(`tasks/${task.id}/resume-session`, 'POST', {}).then((r) => r.json());
    // Resuming without a message tells the agent to carry on by itself; the notice is a system message, not the user's.
    expect(resumed.task.status).toBe('running'); expect(resumed.run).toMatchObject({ terminalMode: 'stream', sessionId: source.sessionId, historyResume: { initialMessage: CONTINUE_MESSAGE } });
    expect(server.service.snapshot().messages.filter((message) => message.taskId === task.id).map((message) => message.authorType)).toEqual(['system']);
    expect(launched).toEqual([opened.run.id, again.run.id, resumed.run.id]);
  });

  it('turns an agent terminal into a running task that resumes the same provider session', async () => {
    const { server, project, request, claude, codex } = await setup(); const source = claude();
    const service = server.service as unknown as { launcher: { launch: (run: Run) => void }; promptBuilder: { build: (run: Run) => string } };
    const launched: Run[] = []; vi.spyOn(service.launcher, 'launch').mockImplementation((run: Run) => { launched.push(run); });
    const terminals = server.service.projectTerminals as unknown as { entries: Map<string, unknown> }; const stopped: string[] = [];
    const open = (id: string, provider: string, extra: Partial<Run> & { terminalKind?: string } = {}) => terminals.entries.set(id, { projectId: project.id, project, handle: { stop: async () => { stopped.push(id); } },
      run: { id, taskId: '', provider, terminalKind: 'agent', title: provider, status: 'running', startedAt: '2026-10-15T09:00:00Z', finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', workspacePath: project.repositoryPath, pendingCommands: [], continuation: 0, ...extra } });
    open('shell_plain', 'command', { terminalKind: 'shell' }); open('shell_unsaved', 'claude', { sessionId: randomUUID() });
    expect((await request(`projects/${project.id}/terminals/shell_plain/task`, 'POST', {})).status).toBe(409);
    const unsaved = await request(`projects/${project.id}/terminals/shell_unsaved/task`, 'POST', {}); expect(unsaved.status).toBe(409); expect((await unsaved.json()).error).toContain('Send it a message first');
    expect(stopped).toEqual([]);

    open('shell_claude', 'claude', { sessionId: source.sessionId });
    const converted = await request(`projects/${project.id}/terminals/shell_claude/task`, 'POST', {});
    expect(converted.status).toBe(201); const body = await converted.json();
    expect(body.task).toMatchObject({ title: 'Claude user request', status: 'running', sessionContinuation: true });
    expect(body.run).toMatchObject({ terminalMode: 'pty', sessionId: source.sessionId, historyResume: { provider: 'claude', sessionId: source.sessionId } });
    expect(stopped).toEqual(['shell_claude']); expect(server.service.projectTerminals.list(project.id).map((item) => item.id)).not.toContain('shell_claude');
    const prompt = service.promptBuilder.build(launched[0]!);
    expect(prompt).toContain('turned this terminal conversation into an AIWS task'); expect(prompt).toContain(`aiws control complete --run ${body.run.id}`); expect(prompt).toContain(`aiws control ask "Your question" --run ${body.run.id}`);

    await server.service.stop(body.run.id);

    // A CLI that cannot be given a session ID: the only new session of that provider in the project.
    // The session index rescans at most every two seconds.
    const rollout = codex(); open('shell_codex', 'codex', { startedAt: '2026-10-15T11:59:00Z' }); await new Promise((resolve) => setTimeout(resolve, 2100));
    const fromCodex = await request(`projects/${project.id}/terminals/shell_codex/task`, 'POST', {}).then((r) => r.json());
    expect(fromCodex.run).toMatchObject({ provider: 'codex', historyResume: { sessionId: rollout.sessionId } });
    codex(); codex(); open('shell_codex_many', 'codex', { startedAt: '2026-10-15T11:59:00Z' }); await new Promise((resolve) => setTimeout(resolve, 2100));
    expect((await request(`projects/${project.id}/terminals/shell_codex_many/task`, 'POST', {})).status).toBe(409);
  });

  it('resumes via a real provider child, preserves UUID/provider over default profiles and rejects duplicate queued/active resumes', async () => {
    const { root, workspace, codexHome, server, project, request, codex } = await setup(); const source = codex(); const original = readFileSync(source.path, 'utf8');
    const bin = join(root, 'bin'); mkdirSync(bin); const proof = join(root, 'proof.json'); const child = join(bin, 'capture.cjs');
    writeFileSync(child, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),home:process.env.CODEX_HOME}));console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(source.sessionId)}}));setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:'Continued original session'}})),500)});`);
    const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex'); writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${child.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\nimport(${JSON.stringify(child)});`); if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const pathKey = Object.keys(process.env).find((item) => item.toLowerCase() === 'path') ?? 'PATH'; vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey]}`);
    server.service.catalog.createAgent({ name: 'Unrelated Claude default', provider: 'claude', instructions: 'PRIVATE_UNRELATED_CONTEXT' });
    const historical = (await server.service.history.list(project)).items[0]!;
    expect((await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'stream' })).status).toBe(400);
    const response = await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'stream', message: 'Perform only NEW_REQUEST_MARKER.' }); expect(response.status).toBe(201); const resumed = await response.json();
    expect(resumed.task.provider).toBe('codex'); expect(resumed.task.agentId).toBeNull(); expect(resumed.run.sessionId).toBe(source.sessionId);
    const duplicate = await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'stream', message: 'duplicate' }); expect(duplicate.status).toBe(409); expect(server.service.snapshot().tasks).toHaveLength(1);
    const end = Date.now() + 10000; while (server.service.run(resumed.run.id).status === 'running' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.service.run(resumed.run.id).status).toBe('completed'); const received = JSON.parse(readFileSync(proof, 'utf8'));
    expect(received.args).toContain(source.sessionId); expect(received.input).toContain('NEW_REQUEST_MARKER'); expect(received.input).not.toContain('Continue my public work'); expect(received.input).not.toContain('PRIVATE_UNRELATED_CONTEXT'); expect(received.cwd).toBe(workspace); expect(received.home).toBe(codexHome);
    expect(readFileSync(source.path, 'utf8')).toBe(original); // Fake provider intentionally does not append; adapters never write it.
    expect((await request(`tasks/${resumed.task.id}`, 'PATCH', { provider: 'claude' })).status).toBe(409);
    writeFileSync(child, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(randomUUID())}})));`);
    const changed = await request(`projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'stream', message: 'A new explicit turn' }).then((r) => r.json());
    const deadline = Date.now() + 10000; while (server.service.run(changed.run.id).status === 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.service.run(changed.run.id).status).toBe('failed'); expect(server.service.run(changed.run.id).sessionId).toBe(source.sessionId);
    expect(server.service.snapshot().events.some((event) => event.runId === changed.run.id && event.type === 'provider.error' && event.message.includes('different session'))).toBe(true);
    expect((await request(`projects/${project.id}`, 'DELETE')).status).toBe(200); expect(readFileSync(source.path, 'utf8')).toBe(original);
  }, 15000);

  it('queues behind a workspace lock and refuses Docker host-session resume without creating a task', async () => {
    const { server, project, request, codex } = await setup(); codex(); const source = (await server.service.history.list(project)).items[0]!;
    server.service.updateSettings({ executionMode: 'docker' }); const before = server.service.snapshot().tasks.length;
    expect((await request(`projects/${project.id}/sessions/${source.id}/resume`, 'POST', { terminalMode: 'pty', message: '' })).status).toBe(409); expect(server.service.snapshot().tasks).toHaveLength(before);
    server.service.updateSettings({ executionMode: 'native' }); const blocker = server.service.createTask({ projectId: project.id, title: 'Workspace lock', provider: 'command', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } }); server.service.startTask(blocker.id);
    const queued = await request(`projects/${project.id}/sessions/${source.id}/resume`, 'POST', { terminalMode: 'pty', message: '' }).then((r) => r.json()); expect(queued.task.status).toBe('ready'); expect(queued.task.queueReason).toMatch(/workspace/); expect(queued.run).toBeUndefined();
    expect((await request(`projects/${project.id}/sessions/${source.id}/resume`, 'POST', { terminalMode: 'pty' })).status).toBe(409);
  });

  it('continues a completed task for a human instruction or requeue, keeping its UUID and refreshing the run-control context', async () => {
    const { root, workspace, codexHome, server, project, request, codex } = await setup(); const source = codex();
    const historical = (await server.service.history.list(project)).items[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Original business task', description: 'NEVER_REPEAT_OLD_TASK', status: 'done', provider: 'codex', terminalMode: 'stream' });
    const previous: Run = { id: 'run_old_completion', taskId: task.id, provider: 'codex', sessionId: source.sessionId, status: 'completed', startedAt: historical.createdAt, finishedAt: historical.updatedAt, exitCode: 0, executionMode: 'native', terminalMode: 'stream', pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(previous); server.service.task(task.id).currentRunId = previous.id;
    server.service.task(task.id).historyResume = { provider: 'codex', sessionId: source.sessionId, sourceId: historical.id, initialMessage: 'NEVER_REPEAT_OLD_REQUEST' };
    expect((await request(`tasks/${task.id}/messages`, 'POST', { authorType: 'agent', text: 'Progress update after completion.' })).status).toBe(201);
    expect((await request(`tasks/${task.id}/messages`, 'POST', { authorType: 'agent', text: 'Agent may not restart its parent.', continueSession: true })).status).toBe(400);
    expect(server.service.snapshot().runs).toHaveLength(1);
    expect(server.service.updateTask(task.id, { status: 'ready' }).queuedContinuation).toBeDefined();
    server.service.updateTask(task.id, { status: 'backlog' });
    server.service.task(task.id).status = 'ready'; // A stale persisted/manual state must also be safe at scheduler time.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(server.service.snapshot().runs).toHaveLength(1); expect(server.service.task(task.id).queueReason).toContain('Send a new instruction');

    const bin = join(root, 'continue-bin'); mkdirSync(bin); const proof = join(root, 'continue-proof.json'); const child = join(bin, 'capture.cjs');
    writeFileSync(child, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),home:process.env.CODEX_HOME,runId:process.env.AIWS_RUN_ID,taskId:process.env.AIWS_TASK_ID}));console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(source.sessionId)}}));setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),250)});`);
    const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex'); writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${child.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\nimport(${JSON.stringify(child)});`); if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const pathKey = Object.keys(process.env).find((item) => item.toLowerCase() === 'path') ?? 'PATH'; vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey]}`);
    const [first, duplicate] = await Promise.all([request(`tasks/${task.id}/messages`, 'POST', { authorType: 'user', text: 'ONLY_NEW_HUMAN_INSTRUCTION', continueSession: true }), request(`tasks/${task.id}/messages`, 'POST', { authorType: 'user', text: 'DUPLICATE_SEND', continueSession: true })]);
    expect(first.status).toBe(201); expect(duplicate.status).toBe(409);
    const current = server.service.snapshot().runs.at(-1)!; const deadline = Date.now() + 10000;
    while (server.service.run(current.id).status === 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.service.run(current.id)).toMatchObject({ taskId: task.id, sessionId: source.sessionId, status: 'completed' }); expect(current.id).not.toBe(previous.id);
    const received = JSON.parse(readFileSync(proof, 'utf8'));
    expect(received.args.slice(0, 2)).toEqual(['exec', 'resume']); expect(received.args).toContain(source.sessionId); expect(received).toMatchObject({ cwd: workspace, home: codexHome, runId: current.id, taskId: task.id });
    expect(received.input).toContain('ONLY_NEW_HUMAN_INSTRUCTION'); expect(received.input).toContain(`The current run is ${current.id} and task is ${task.id}`); expect(received.input).toContain(`aiws control ask "Your question" --run ${current.id}`); expect(received.input).not.toMatch(/NEVER_REPEAT_|run_old_completion|DUPLICATE_SEND/);
    expect(server.service.snapshot().tasks).toHaveLength(1); expect(server.service.snapshot().runs).toHaveLength(2);
    expect(server.service.updateTask(task.id, { status: 'ready' }).queuedContinuation).toBeDefined();
    server.service.updateTask(task.id, { status: 'backlog' });
    await new Promise((resolve) => setTimeout(resolve, 1100)); expect(server.service.snapshot().runs).toHaveLength(2);
  }, 15000);

  it('refuses an unverified original UUID or an externally open session without starting a fresh conversation', async () => {
    const { server, project, codex, request } = await setup(); const source = codex();
    const task = server.service.createTask({ projectId: project.id, title: 'No fallback', description: '', provider: 'codex', status: 'done' });
    const previous: Run = { id: 'run_unknown_session', taskId: task.id, provider: 'codex', status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, executionMode: 'native', terminalMode: 'stream', pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(previous); server.service.task(task.id).currentRunId = previous.id;
    const before = structuredClone(server.service.task(task.id));
    expect((await request(`tasks/${task.id}/messages`, 'POST', { text: 'Do not create a new conversation', continueSession: true })).status).toBe(409); expect(server.service.task(task.id)).toEqual(before); expect(server.service.snapshot().runs).toHaveLength(1);
    previous.sessionId = source.sessionId; vi.spyOn(server.service.liveSessions, 'activity').mockResolvedValue('idle');
    expect((await request(`tasks/${task.id}/messages`, 'POST', { text: 'Do not duplicate the open native conversation', continueSession: true })).status).toBe(409); expect(server.service.task(task.id)).toEqual(before); expect(server.service.snapshot().runs).toHaveLength(1);
  });
});
