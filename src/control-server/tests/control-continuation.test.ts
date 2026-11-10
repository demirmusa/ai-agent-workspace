import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlService } from '../service.js';
import { launchRuntime } from '../runner.js';

vi.mock('../runner.js', async importOriginal => ({ ...await importOriginal<typeof import('../runner.js')>(), launchRuntime: vi.fn(() => ({ pid: undefined, stop: async () => {}, pause: async () => 'checkpoint', resume: async () => {}, input: vi.fn() })) }));
const roots: string[] = [], services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-continue-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  const project = service.createProject({ name: 'Continue', repositoryPath: workspace });
  const task = service.createTask({ projectId: project.id, title: 'Original', description: 'Original request', provider: 'codex', terminalMode: 'pty' });
  return { service, task, project };
}
function end(service: ControlService, runId: string, code = 0) { const call = vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === runId)!; call[5].close(code); }
describe('closed task continuation and forks', () => {
  it('delivers directly to an existing CLI without starting a second process', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id);
    await service.sendTaskMessage(task.id, { text: 'Continue here', continueSession: true });
    expect(launchRuntime).toHaveBeenCalledTimes(1);
    const input = vi.mocked(launchRuntime).mock.results[0]!.value.input;
    // Escape cuts the running turn first; Enter follows the text separately so the TUI does not take it as part of a paste.
    expect(input.mock.calls).toEqual([['\u001b']]);
    await vi.waitFor(() => expect(input.mock.calls).toEqual([['\u001b'], ['Continue here'], ['\r']]));
    expect(service.task(task.id).currentRunId).toBe(run.id);
  });
  it('requires explicit consent when the original chat is missing and carries saved history into the new chat', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id);
    service.postMessage(task.id, { text: 'Previous answer', authorType: 'agent' }); end(service, run.id);
    await expect(service.sendTaskMessage(task.id, { text: 'New work', continueSession: true })).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
    expect(launchRuntime).toHaveBeenCalledTimes(1);
    await service.sendTaskMessage(task.id, { text: 'New work', continueSession: true, allowHistoryFallback: true });
    expect(launchRuntime).toHaveBeenCalledTimes(2);
    const next = service.run(service.task(task.id).currentRunId!);
    expect(next.historyResume).toBeUndefined(); expect(next.executionSnapshot?.context).toContain('Previous answer');
    expect(next.executionSnapshot?.task.description).toBe('New work');
  });
  it.each([
    { confirmed: false, change: 'removed' }, { confirmed: false, change: 'moved' },
    { confirmed: true, change: 'removed' }, { confirmed: true, change: 'moved' },
  ])('continues after a cached session is $change (confirmed: $confirmed)', async ({ confirmed, change }) => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id);
    const sessionId = randomUUID();
    if (confirmed) service.reportSession(run.id, { sessionId });
    else service.run(run.id).sessionId = sessionId;
    service.postMessage(task.id, { text: 'Retained answer', authorType: 'agent' }); end(service, run.id);
    const directory = join(service.history.home('codex'), 'sessions', '2026', '10', '23'); mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-${sessionId}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: project.repositoryPath } }) + '\n');
    const pointer = await service.history.findSession(project, 'codex', sessionId); expect(pointer).not.toBeNull();
    if (change === 'removed') rmSync(path);
    else appendFileSync(path, JSON.stringify({ type: 'turn_context', payload: { cwd: service.history.home('codex') } }) + '\n');
    // Explicit history access must still reject the changed source.
    await expect(service.history.resolve(project, pointer!.session.id)).rejects.toThrow('Session source changed');
    if (!confirmed) {
      await expect(service.sendTaskMessage(task.id, { text: 'Follow up', continueSession: true })).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
      expect(launchRuntime).toHaveBeenCalledTimes(1);
    }
    await service.sendTaskMessage(task.id, { text: 'Follow up', continueSession: true, ...(!confirmed ? { allowHistoryFallback: true } : {}) });
    expect(launchRuntime).toHaveBeenCalledTimes(2);
    const next = service.run(service.task(task.id).currentRunId!);
    if (confirmed) expect(next.historyResume).toMatchObject({ sessionId, recorded: true, initialMessage: 'Follow up' });
    else { expect(next.historyResume).toBeUndefined(); expect(next.executionSnapshot?.context).toContain('Retained answer'); }
  });
  it('resumes a verified original session automatically and asks before replacing a failed resume', async () => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id); service.run(run.id).sessionId = randomUUID(); end(service, run.id);
    const pointer = { session: { id: 'hist_source', sessionId: service.run(run.id).sessionId!, provider: 'codex' as const, cwd: project.repositoryPath }, path: '', root: '' };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(pointer as any); vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});
    await service.sendTaskMessage(task.id, { text: 'Resume', continueSession: true });
    const resumed = service.run(service.task(task.id).currentRunId!); expect(resumed.historyResume?.sessionId).toBe(pointer.session.sessionId);
    end(service, resumed.id, 1); vi.spyOn(service.history, 'resolve').mockResolvedValue(pointer as any);
    await expect(service.sendTaskMessage(task.id, { text: 'Try again', continueSession: true })).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
    expect(launchRuntime).toHaveBeenCalledTimes(2);
  });
  it.each(['review', 'done'] as const)('requeues a %s task and resumes the verified provider session', async status => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id);
    service.run(run.id).sessionId = randomUUID(); end(service, run.id);
    if (status === 'done') service.updateTask(task.id, { status });
    const pointer = { session: { id: 'hist_source', sessionId: service.run(run.id).sessionId!, provider: 'codex' as const, cwd: project.repositoryPath }, path: '', root: '' };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(pointer as any); vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});
    const queued = service.updateTask(task.id, { status: 'ready', description: 'Apply the requested follow-up' });
    expect(queued.queuedContinuation?.confirmationRequired).toBe(false);
    expect(launchRuntime).toHaveBeenCalledTimes(1);
    const resumed = await service.startQueuedTask(task.id);
    expect(resumed.historyResume).toMatchObject({ sessionId: pointer.session.sessionId, initialMessage: 'Apply the requested follow-up' });
    expect(service.task(task.id).queuedContinuation).toBeUndefined();
  });
  it('continues the original session when a task that already ran returns from backlog to ready', async () => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id);
    service.run(run.id).sessionId = randomUUID(); end(service, run.id);
    service.updateTask(task.id, { status: 'backlog' });
    const pointer = { session: { id: 'hist_source', sessionId: service.run(run.id).sessionId!, provider: 'codex' as const, cwd: project.repositoryPath }, path: '', root: '' };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(pointer as any); vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});
    const queued = service.updateTask(task.id, { status: 'ready' });
    expect(queued.queuedContinuation).toMatchObject({ confirmationRequired: false, instruction: expect.stringContaining('Continue the task from its current state') });
    const resumed = await service.startQueuedTask(task.id);
    expect(resumed.historyResume).toMatchObject({ sessionId: pointer.session.sessionId });
    expect(launchRuntime).toHaveBeenCalledTimes(2);
  });
  it('queues continuations while every slot is busy and gives freed slots to them first-in, first-out before ready tasks', async () => {
    const { service, task: first } = await fixture(); service.updateSettings({ maxConcurrent: 1 });
    vi.spyOn(service.history, 'findSession').mockImplementation(async (project: any, provider: any, sessionId: string) => ({ session: { id: `hist_${sessionId}`, sessionId, provider, cwd: project.repositoryPath }, path: '', root: '' }) as any);
    vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});
    // Separate workspaces, so only the slot limit keeps the tasks apart.
    const make = (title: string, extra: Record<string, unknown> = {}) => {
      const directory = join(roots.at(-1)!, title); mkdirSync(directory);
      const project = service.createProject({ name: title, repositoryPath: directory });
      return service.createTask({ projectId: project.id, title, provider: 'codex', terminalMode: 'pty', ...extra });
    };
    const closed = [first, make('Second'), make('Third')];
    for (const task of closed) { const run = service.startTask(task.id); service.run(run.id).sessionId = randomUUID(); end(service, run.id); service.updateTask(task.id, { status: 'review' }); }
    const busy = service.startTask(make('Busy').id);
    for (const task of closed) await expect(service.sendTaskMessage(task.id, { text: `Continue ${task.title}`, continueSession: true })).resolves.toBeNull();
    const waiting = make('Waiting', { status: 'ready' });
    for (const task of closed) expect(service.task(task.id)).toMatchObject({ status: 'ready', queueReason: expect.stringContaining('slots'), queuedContinuation: { instruction: `Continue ${task.title}`, awaitingSlot: true } });
    const running = () => service.snapshot().tasks.filter(task => task.status === 'running').map(task => task.title);
    let current = busy.id;
    for (const next of [...closed.map(task => task.title), 'Waiting']) {
      end(service, current);
      (service as any).tick();
      await vi.waitFor(() => expect(running()).toEqual([next]));
      (service as any).tick(); await new Promise(resolve => setTimeout(resolve, 20));
      expect(running()).toEqual([next]);
      current = service.snapshot().tasks.find(task => task.title === next)!.currentRunId!;
    }
    expect(service.task(closed[2]!.id).historyResume?.initialMessage).toBe('Continue Third');
    expect(service.task(waiting.id).status).toBe('running');
  });
  it('keeps a missing session queued until consent and copies history beyond the former truncation limit', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id);
    service.postMessage(task.id, { text: 'EARLIEST_MESSAGE', authorType: 'agent' });
    for (let index = 0; index < 10; index++) service.postMessage(task.id, { text: `${index}:` + 'x'.repeat(29000), authorType: 'agent' });
    end(service, run.id); service.updateTask(task.id, { status: 'ready' });
    await expect(service.startQueuedTask(task.id)).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
    expect(service.task(task.id)).toMatchObject({ status: 'ready', queuedContinuation: { confirmationRequired: true } });
    expect(launchRuntime).toHaveBeenCalledTimes(1);
    const next = await service.startQueuedTask(task.id, { allowHistoryFallback: true });
    expect(next.historyResume).toBeUndefined();
    expect(next.executionSnapshot?.context).toContain('EARLIEST_MESSAGE');
    expect(next.executionSnapshot!.context.length).toBeGreaterThan(290000);
  });
  it('automatically attempts a queued resume once and waits for fallback approval', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id); end(service, run.id);
    service.updateTask(task.id, { status: 'ready' });
    const send = vi.spyOn(service, 'sendTaskMessage');
    (service as any).tick();
    await vi.waitFor(() => expect(service.task(task.id).queuedContinuation?.confirmationRequired).toBe(true));
    (service as any).tick();
    expect(send).toHaveBeenCalledTimes(1); expect(launchRuntime).toHaveBeenCalledTimes(1);
    service.updateTask(task.id, { status: 'backlog' });
    expect(service.task(task.id).queuedContinuation).toBeUndefined();
  });
  it('does not start a task moved out of ready while its original session is checked', async () => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id); service.run(run.id).sessionId = randomUUID(); end(service, run.id);
    service.updateTask(task.id, { status: 'ready' });
    let resolve!: (value: any) => void;
    vi.spyOn(service.history, 'findSession').mockImplementation(() => new Promise(done => { resolve = done; }));
    vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});
    const starting = service.startQueuedTask(task.id);
    service.updateTask(task.id, { status: 'backlog' });
    resolve({ session: { id: 'hist_source', sessionId: service.run(run.id).sessionId!, provider: 'codex', cwd: project.repositoryPath }, path: '', root: '' });
    await expect(starting).rejects.toThrow('no longer ready');
    expect(launchRuntime).toHaveBeenCalledTimes(1);
  });
  it('requires consent for providers without supported resume and retains their execution profile', async () => {
    const { service, task } = await fixture();
    service.updateTask(task.id, { provider: 'opencode' });
    const run = service.startTask(task.id); end(service, run.id);
    service.updateTask(task.id, { status: 'ready' });
    await expect(service.startQueuedTask(task.id)).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
    expect(launchRuntime).toHaveBeenCalledTimes(1);
    const next = await service.startQueuedTask(task.id, { allowHistoryFallback: true });
    expect(next.provider).toBe('opencode'); expect(next.historyResume).toBeUndefined();
    expect(next.executionSnapshot?.context).toContain('Original request');
  });
  it('copies every provider history page and earlier runs without dropping the first messages', async () => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id); service.run(run.id).sessionId = randomUUID(); end(service, run.id);
    const pointer = { session: { id: 'hist_source', sessionId: service.run(run.id).sessionId!, provider: 'codex' as const, cwd: project.repositoryPath }, path: '', root: '' };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(pointer as any);
    vi.spyOn(service.history, 'assertResume').mockImplementation(() => { throw new Error('Cannot resume'); });
    const read = vi.spyOn(service.history, 'readPointer').mockResolvedValueOnce({ messages: [{ authorType: 'user', text: 'FIRST_PROVIDER_PAGE' }], events: [], warnings: [], nextCursor: 'page2' } as any).mockResolvedValueOnce({ messages: [{ authorType: 'agent', text: 'LAST_PROVIDER_PAGE' }], events: [], warnings: [], nextCursor: null } as any);
    service.updateTask(task.id, { status: 'ready' });
    const next = await service.startQueuedTask(task.id, { allowHistoryFallback: true });
    expect(read).toHaveBeenCalledTimes(2);
    expect(next.executionSnapshot?.context).toContain('FIRST_PROVIDER_PAGE');
    expect(next.executionSnapshot?.context).toContain('LAST_PROVIDER_PAGE');
  });
  it('forks a closed task into an independent backlog task with history and leaves the original untouched', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id); service.postMessage(task.id, { text: 'Saved answer', authorType: 'agent' }); end(service, run.id);
    const before = structuredClone(service.task(task.id));
    const fork = await service.forkTask(task.id, { text: 'Alternate approach' });
    expect(fork).toMatchObject({ forkedFromTaskId: task.id, status: 'backlog', currentRunId: null, description: 'Alternate approach' });
    expect(fork.conversationContext).toContain('Saved answer'); expect(service.task(task.id)).toEqual(before); expect(launchRuntime).toHaveBeenCalledTimes(1);
    const started = service.startTask(fork.id); expect(started.executionSnapshot?.context).toContain('Saved answer');
  });
  it('moves an active continuation to done and stops its agent process tree', async () => {
    const { service, task } = await fixture();
    const stop = vi.fn(async () => { call()[5].close(1); });
    vi.mocked(launchRuntime).mockImplementationOnce(() => ({ pid: undefined, stop, pause: async () => 'checkpoint' as const, resume: async () => {}, input: vi.fn() }));
    const run = service.startTask(task.id); const call = () => vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === run.id)!;
    expect(service.task(task.id).status).toBe('running');
    expect(() => service.updateTask(task.id, { status: 'done' })).toThrow('Use run controls');
    const done = await service.saveTask({ status: 'done' }, task.id);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(done.status).toBe('done'); expect(service.run(run.id).status).toBe('cancelled');
    expect(service.run(run.id).pid).toBeUndefined();
  });
  it('closes a completed run terminal that is still open when its task moves to done', async () => {
    const { service, task } = await fixture();
    const stop = vi.fn(async () => { vi.mocked(launchRuntime).mock.calls[0]![5].close(0); });
    vi.mocked(launchRuntime).mockImplementationOnce(() => ({ pid: undefined, stop, pause: async () => 'checkpoint' as const, resume: async () => {}, input: vi.fn() }));
    const run = service.startTask(task.id); service.complete(run.id, { summary: 'Finished' });
    expect(service.task(task.id).status).toBe('review');
    await service.saveTask({ status: 'done' }, task.id);
    expect(stop).toHaveBeenCalled(); expect(service.task(task.id).status).toBe('done'); expect(service.run(run.id).status).toBe('completed');
  });
});
