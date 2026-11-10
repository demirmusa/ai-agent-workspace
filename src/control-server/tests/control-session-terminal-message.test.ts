import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service.js';

describe('a task message while its session is open in a project terminal', () => {
  const delay = ControlService.terminalSubmitDelayMs;
  let root: string, service: ControlService;
  afterEach(async () => { ControlService.terminalSubmitDelayMs = delay; await service.close(); rmSync(root, { recursive: true, force: true }); });

  it('is typed into that terminal without starting a run', async () => {
    ControlService.terminalSubmitDelayMs = 0;
    root = mkdtempSync(join(tmpdir(), 'aiws-session-terminal-')); service = await ControlService.open({ dataDir: join(root, 'data') });
    const project = service.createProject({ name: 'Open session', repositoryPath: root });
    const task = service.createTask({ projectId: project.id, title: 'Ended task', provider: 'claude', terminalMode: 'pty' });
    const state = service.store.state;
    state.runs.push({ id: 'run_ended', taskId: task.id, provider: 'claude', status: 'completed', sessionId: 'SESSION-1', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty' } as never);
    const stored = state.tasks.find((item) => item.id === task.id)!; stored.currentRunId = 'run_ended'; stored.status = 'done';
    const typed: string[] = [];
    (service.projectTerminals as unknown as { entries: Map<string, unknown> }).entries.set('shell_1', { projectId: project.id, project, run: { id: 'shell_1', terminalKind: 'agent', status: 'running', sessionId: 'session-1' }, handle: { input: (data: string) => typed.push(data), stop: async () => {} } });
    const runs = state.runs.length;
    const message = await service.sendTaskMessage(task.id, { text: 'go on', continueSession: true });
    expect(message?.text ?? (message as unknown as { body?: string })?.body).toBe('go on');
    expect(state.runs).toHaveLength(runs);
    await vi.waitFor(() => expect(typed).toEqual(['\u001b', 'go on', '\r']));
  });
});
