import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import type { Run } from '../types.js';
import { transferTranscript } from '../history-transfer.js';

let service: ControlService; let root: string;
afterEach(async () => { vi.restoreAllMocks(); if (service) await service.close(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
async function setup(provider: 'codex' | 'claude' = 'codex') {
  root = mkdtempSync(join(tmpdir(), 'aiws-transfer-')); mkdirSync(join(root, 'project'));
  service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') } });
  const project = service.createProject({ name: 'Transfer', repositoryPath: join(root, 'project') });
  const task = service.createTask({ projectId: project.id, title: 'Existing conversation', description: 'Original objective', provider });
  const run: Run = { id: 'previous', taskId: task.id, provider, status: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', exitCode: 0, executionMode: 'native', continuation: 0, pendingCommands: [] };
  service.store.state.runs.push(run); service.task(task.id).currentRunId = run.id; service.task(task.id).status = 'done';
  service.postMessage(task.id, { text: 'Keep the previous requirement' });
  service.postMessage(task.id, { text: 'Previous implementation result', authorType: 'agent' });
  vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
  return { task, run, project };
}

describe('conversation transfer', () => {
  it.each(['codex', 'claude'] as const)('transfers real %s history files into a fresh conversation', async provider => {
    const { task, run, project } = await setup(provider);
    const sessionId = randomUUID(); service.run(run.id).sessionId = sessionId;
    vi.spyOn(service.liveSessions, 'activity').mockResolvedValue(null);
    const directory = provider === 'codex' ? join(root, 'codex', 'sessions') : join(root, 'claude', 'projects', 'project');
    mkdirSync(directory, { recursive: true });
    const rows = provider === 'codex' ? [
      { type: 'session_meta', payload: { id: sessionId, cwd: project.repositoryPath, base_instructions: 'PRIVATE_SYSTEM' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Native user requirement' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native public reply' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'Read', arguments: '{"file":"main.ts"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'Native tool result' } },
    ] : [
      { type: 'user', sessionId, cwd: project.repositoryPath, message: { content: 'Native user requirement' } },
      { type: 'assistant', sessionId, cwd: project.repositoryPath, message: { content: [{ type: 'text', text: 'Native public reply' }, { type: 'thinking', thinking: 'PRIVATE_SYSTEM' }, { type: 'tool_use', id: 'call', name: 'Read', input: { file: 'main.ts' } }] } },
      { type: 'user', sessionId, cwd: project.repositoryPath, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Native tool result' }] } },
    ];
    writeFileSync(join(directory, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await service.transferTaskSession(task.id, { provider: provider === 'codex' ? 'claude' : 'codex', message: 'Next', terminalMode: 'stream' });
    const context = result.run?.executionSnapshot?.context;
    for (const text of ['Native user requirement', 'Native public reply', 'main.ts', 'Native tool result']) expect(context).toContain(text);
    expect(context).not.toContain('PRIVATE_SYSTEM'); expect(result.warnings).toEqual([]);
    // A fresh Claude conversation gets its own preassigned session ID; the source session is never resumed.
    expect(result.run?.historyResume).toBeUndefined(); expect(result.run?.sessionId).not.toBe(sessionId);
    if (result.run?.provider === 'codex') expect(result.run.sessionId).toBeUndefined();
  });

  it('includes notes added while provider history is loading', async () => {
    const { task } = await setup(); service.run('previous').sessionId = 'uuid';
    let release!: (value: any) => void;
    vi.spyOn(service.history, 'findSession').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' });
    service.postMessage(task.id, { text: 'Requirement added during history loading' });
    release(null);
    expect((await pending).task.historyTransfer?.transcript).toContain('Requirement added during history loading');
  });

  it.each([['codex', 'codex'], ['codex', 'claude'], ['claude', 'codex'], ['claude', 'claude']] as const)('starts a fresh %s → %s conversation with retained history', async (from, to) => {
    const { task, run } = await setup(from); const before = structuredClone(service.task(task.id));
    const result = await service.transferTaskSession(task.id, { provider: to, message: 'Continue with the next step', terminalMode: 'stream' });
    expect(result.task.id).not.toBe(task.id); expect(service.task(task.id)).toEqual(before); expect(service.run(run.id)).toEqual(run);
    expect(result.run).toMatchObject({ provider: to, terminalMode: 'stream', status: 'running' });
    expect(result.run?.historyResume).toBeUndefined();
    if (to === 'claude') expect(result.run?.sessionId).toMatch(/^[0-9a-f-]{36}$/); else expect(result.run?.sessionId).toBeUndefined();
    expect(result.run?.executionSnapshot?.task.description).toBe('Continue with the next step');
    expect(result.run?.executionSnapshot?.context).toContain('Keep the previous requirement');
    expect(result.run?.executionSnapshot?.context).toContain('Previous implementation result');
    expect(result.run?.executionSnapshot?.context).toContain('Original objective');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reads every public history page and retains explicit source warnings', async () => {
    const { task, project } = await setup();
    const session = { id: 'history', provider: 'codex' as const, sessionId: 'uuid', title: 'Source', cwd: project.repositoryPath, createdAt: task.createdAt, updatedAt: task.updatedAt, canResume: false };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(null);
    service.task(task.id).externalHistory = { sourceId: session.id, provider: 'codex', sessionId: session.sessionId, importedAt: task.createdAt, status: 'completed', syncedStatus: 'done' };
    vi.spyOn(service.history, 'resolve').mockResolvedValue({ session, path: 'unused' } as any);
    vi.spyOn(service.liveSessions, 'activity').mockResolvedValue(null);
    const read = vi.spyOn(service.history, 'readPointer').mockResolvedValueOnce({ session, events: [], messages: [{ id: 'first', taskId: '', runId: null, agentId: null, authorType: 'user', authorName: 'User', text: 'First page', createdAt: task.createdAt }], nextCursor: '200', truncated: false, warnings: [] }).mockResolvedValueOnce({ session, events: [{ id: 'last', taskId: null, runId: null, type: 'stdout', message: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Last page' }, { type: 'thinking', thinking: 'PRIVATE REASONING' }] } }), createdAt: task.updatedAt }], messages: [], nextCursor: null, truncated: true, warnings: ['Shortened record'] });
    const result = await service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' });
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]?.[1]).toEqual({ limit: 200, cursor: '200' });
    expect(result.task.historyTransfer?.transcript).toContain('First page'); expect(result.task.historyTransfer?.transcript).toContain('Last page');
    expect(result.task.historyTransfer?.transcript).not.toContain('PRIVATE REASONING'); expect(result.warnings).toContain('Shortened record');
    expect(result.run?.historyResume).toBeUndefined();
  });

  it('keeps the context queued when capacity is occupied and reuses it on start', async () => {
    const { task } = await setup(); service.store.state.settings.maxConcurrent = 0;
    const result = await service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' });
    expect(result.task.status).toBe('ready'); expect(result.run).toBeUndefined(); expect(result.task.queueReason).toMatch(/slots/);
    service.store.state.settings.maxConcurrent = 1;
    expect(service.startTask(result.task.id).executionSnapshot?.context).toContain('Previous implementation result');
  });

  it('rejects active sessions and invalid inputs without creating a task', async () => {
    const { task, run } = await setup(); service.run(run.id).status = 'running';
    await expect(service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' })).rejects.toThrow(/Stop/);
    service.run(run.id).status = 'completed';
    await expect(service.transferTaskSession(task.id, { provider: 'command', message: 'Next' })).rejects.toThrow(/Codex or Claude/);
    await expect(service.transferTaskSession(task.id, { provider: 'codex', message: ' ' })).rejects.toThrow(/instruction/);
    expect(service.snapshot().tasks).toHaveLength(1);
  });

  it('rejects overlapping transfer requests and preserves earlier transferred context', async () => {
    const { task, project } = await setup();
    service.task(task.id).historyTransfer = { sourceTaskId: 'ancestor', transcript: 'Original ancestor discussion', warnings: [] };
    service.run('previous').sessionId = 'uuid';
    let release!: (value: any) => void;
    vi.spyOn(service.history, 'findSession').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' });
    await expect(service.transferTaskSession(task.id, { provider: 'claude', message: 'Next' })).rejects.toThrow(/in progress/);
    release(null); const result = await first;
    expect(result.task.historyTransfer?.transcript).toContain('Original ancestor discussion');
    expect(result.task.projectId).toBe(project.id);
  });

  it('copies public tools but excludes metadata, system messages and reasoning', () => {
    const transcript = transferTranscript([], [
      { id: 'a', taskId: null, runId: null, createdAt: '', type: 'stdout', message: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Public answer', reasoning: 'secret' } }) },
      { id: 'b', taskId: null, runId: null, createdAt: '', type: 'stdout', message: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'app.ts' } }, { type: 'thinking', thinking: 'secret' }] } }) },
      { id: 'c', taskId: null, runId: null, createdAt: '', type: 'stdout', message: JSON.stringify({ type: 'system', text: 'secret' }) },
    ]);
    expect(transcript).toContain('Public answer'); expect(transcript).toContain('app.ts'); expect(transcript).not.toContain('secret');
  });

  it('does not apply an automatic workflow or change the chosen provider', async () => {
    const { task } = await setup();
    const agent = service.catalog.createAgent({ name: 'Automatic worker', provider: 'codex' });
    service.workflows.create({ name: 'Automatic workflow', trigger: 'always', steps: [{ name: 'First', agentId: agent.id }] });
    const result = await service.transferTaskSession(task.id, { provider: 'claude', message: 'Continue' });
    expect(result.run?.provider).toBe('claude'); expect(result.run?.workflowId).toBeUndefined(); expect(result.run?.executionSnapshot?.agent).toBeNull();
  });

  it('does not create a partial transfer when history exceeds the context limit', async () => {
    const { task } = await setup();
    service.task(task.id).historyTransfer = { sourceTaskId: 'ancestor', transcript: 'x'.repeat(2_000_000), warnings: [] };
    await expect(service.transferTaskSession(task.id, { provider: 'claude', message: 'Continue' })).rejects.toThrow(/transfer limit/);
    expect(service.snapshot().tasks).toHaveLength(1);
  });

  it('rejects a source edit made while provider history is loading', async () => {
    const { task } = await setup(); service.run('previous').sessionId = 'uuid';
    let release!: (value: any) => void;
    vi.spyOn(service.history, 'findSession').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = service.transferTaskSession(task.id, { provider: 'claude', message: 'Continue' });
    service.task(task.id).description = 'Edited while reading'; release(null);
    await expect(pending).rejects.toThrow(/changed while reading/); expect(service.snapshot().tasks).toHaveLength(1);
  });
});
