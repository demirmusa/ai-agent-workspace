import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlService } from '../service.js';
import { launchRuntime, prepareRuntime } from '../runner.js';
import type { Provider } from '../types.js';

vi.mock('../runner.js', async importOriginal => ({ ...await importOriginal<typeof import('../runner.js')>(), launchRuntime: vi.fn(() => ({ pid: undefined, stop: async () => {}, pause: async () => 'checkpoint', resume: async () => {}, input: vi.fn() })) }));
const roots: string[] = [], services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(provider: Exclude<Provider, 'command'> = 'agy') {
  const root = mkdtempSync(join(tmpdir(), 'aiws-session-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  const project = service.createProject({ name: 'Sessions', repositoryPath: workspace });
  const agent = service.catalog.createAgent({ name: 'Builder', provider, instructions: 'Build carefully.' });
  const task = service.createTask({ projectId: project.id, title: 'Original', description: 'Original request', agentId: agent.id, terminalMode: 'pty' });
  return { service, task, project, agent };
}
function end(service: ControlService, runId: string, code = 0) { const call = vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === runId)!; call[5].close(code); }
const launched = (runId: string) => vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === runId)!;

describe('task provider sessions', () => {
  it('keeps the agent-reported sessions as a list and resumes the latest one with the message itself', async () => {
    const { service, task, project, agent } = await fixture('agy');
    const first = service.startTask(task.id);
    expect(launched(first.id)[3]).toContain(`aiws control session --run ${first.id}`);
    service.reportSession(first.id, { sessionId: 'conv-old' }); service.reportSession(first.id, { sessionId: 'conv-latest' });
    expect(service.task(task.id).sessions).toMatchObject([{ sessionId: 'conv-old', runId: first.id, agentId: agent.id, agentName: 'Builder', source: 'agent' }, { sessionId: 'conv-latest', provider: 'agy' }]);
    end(service, first.id);

    await service.sendTaskMessage(task.id, { text: 'Rename the button', continueSession: true });
    const resumed = service.run(service.task(task.id).currentRunId!);
    expect(resumed.id).not.toBe(first.id);
    expect(resumed.historyResume).toMatchObject({ provider: 'agy', sessionId: 'conv-latest', recorded: true, initialMessage: 'Rename the button' });
    expect(resumed.executionSnapshot?.agent?.id).toBe(agent.id);
    // The resumed session gets the message directly; no prompt.md is prepared for it.
    const prompt = launched(resumed.id)[3];
    expect(prompt.startsWith('Rename the button')).toBe(true); expect(prompt).toContain(`aiws control complete --run ${resumed.id}`); expect(prompt).not.toContain('Original request');
    expect(existsSync(join(resumed.inputDirectory!, 'prompt.md'))).toBe(false);
    const invocation = prepareRuntime(project, service.task(task.id), resumed, prompt, { image: 'unused', controlUrl: 'http://control' });
    expect(invocation.executable).toBe('agy');
    expect(invocation.args).toEqual(['--conversation', 'conv-latest', '--mode', 'auto', '--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: [project.repositoryPath] }), '--prompt-interactive', prompt]);
  });

  it('resumes an OpenCode session reported by the agent', async () => {
    const { service, task, project } = await fixture('opencode');
    const first = service.startTask(task.id); service.reportSession(first.id, { sessionId: 'ses_abc123' }); end(service, first.id);
    await service.sendTaskMessage(task.id, { text: 'Next step', continueSession: true });
    const resumed = service.run(service.task(task.id).currentRunId!);
    const invocation = prepareRuntime(project, service.task(task.id), resumed, launched(resumed.id)[3], { image: 'unused', controlUrl: 'http://control' });
    expect(invocation.args.slice(0, 2)).toEqual(['--session', 'ses_abc123']);
  });

  it('gives a fresh Claude session its ID up front and resumes it once confirmed', async () => {
    const { service, task, project } = await fixture('claude');
    const first = service.startTask(task.id);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.task(task.id).sessions).toMatchObject([{ sessionId: first.sessionId, source: 'assigned' }]);
    const invocation = prepareRuntime(project, service.task(task.id), service.run(first.id), launched(first.id)[3], { image: 'unused', controlUrl: 'http://control' });
    expect(invocation.args.slice(invocation.args.indexOf('--session-id'), invocation.args.indexOf('--session-id') + 2)).toEqual(['--session-id', first.sessionId]);
    expect(invocation.args.indexOf('--session-id')).toBeLessThan(invocation.args.indexOf('--'));
    // The agent confirms the same ID; the entry is upgraded instead of duplicated.
    service.reportSession(first.id, { sessionId: first.sessionId! });
    expect(service.task(task.id).sessions).toMatchObject([{ sessionId: first.sessionId, source: 'agent' }]);
    end(service, first.id);
    await service.sendTaskMessage(task.id, { text: 'Follow up', continueSession: true });
    const resumed = service.run(service.task(task.id).currentRunId!);
    expect(resumed.historyResume).toMatchObject({ provider: 'claude', sessionId: first.sessionId, recorded: true });
    const resumeArgs = prepareRuntime(project, service.task(task.id), resumed, launched(resumed.id)[3], { image: 'unused', controlUrl: 'http://control' }).args;
    expect(resumeArgs.slice(0, 2)).toEqual(['--resume', first.sessionId]); expect(resumeArgs).not.toContain('--session-id');
  });

  it('does not trust an unconfirmed preassigned ID', async () => {
    const { service, task } = await fixture('claude');
    const first = service.startTask(task.id); end(service, first.id);
    await expect(service.sendTaskMessage(task.id, { text: 'Follow up', continueSession: true })).rejects.toThrow('HISTORY_FALLBACK_CONFIRMATION');
  });

  it('lets the agent that did the work resolve its own merge conflict', async () => {
    const { service, task } = await fixture('codex');
    const first = service.startTask(task.id); const sessionId = randomUUID(); service.reportSession(first.id, { sessionId }); end(service, first.id);
    const stored = service.task(task.id);
    stored.queuedContinuation = { instruction: 'Resolve the merge conflict in a.txt.', confirmationRequired: false, mergeRecovery: true }; stored.status = 'ready';
    const run = await service.startQueuedTask(task.id);
    expect(run.id).not.toBe(first.id);
    expect(run.historyResume).toMatchObject({ provider: 'codex', sessionId, initialMessage: 'Resolve the merge conflict in a.txt.' });
    expect(service.task(task.id).queuedContinuation).toBeUndefined();
    expect(service.snapshot().messages.filter(message => message.taskId === task.id && message.authorType === 'user')).toEqual([]);
  });

  it('hands a merge conflict to a fresh run when no session can be resumed', async () => {
    const { service, task } = await fixture('codex');
    const first = service.startTask(task.id); end(service, first.id);
    const stored = service.task(task.id);
    stored.queuedContinuation = { instruction: 'Resolve the merge conflict.', confirmationRequired: false, mergeRecovery: true }; stored.status = 'ready';
    const run = await service.startQueuedTask(task.id);
    expect(run.historyResume).toBeUndefined();
    expect(run.executionSnapshot?.task.description).toContain('Resolve the merge conflict.');
  });

  it('rejects invalid session reports', async () => {
    const { service, task } = await fixture('agy');
    const run = service.startTask(task.id);
    expect(() => service.reportSession(run.id, { sessionId: 'bad id; rm -rf' })).toThrow('sessionId');
    end(service, run.id);
    expect(() => service.reportSession(run.id, { sessionId: 'conv-1' })).toThrow('ended');
  });
});
