import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';

const roots: string[] = []; const services: ControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.close()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('project concurrency limit', () => {
  it.each(['global', 'project'])('queues board starts at the %s limit and starts after capacity is released', async (limit) => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-board-limit-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    value.updateSettings({ maxConcurrent: limit === 'global' ? 1 : 6 });
    const project = value.createProject({ name: 'Limited', repositoryPath: root, ...(limit === 'project' ? { maxConcurrent: 1 } : {}) });
    const occupied = value.createTask({ projectId: project.id, title: 'Delivering' });
    value.task(occupied.id).status = 'completing';
    const task = value.createTask({ projectId: project.id, title: 'Next', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.log("queued start")'] } });
    await expect(value.startTaskOrQueue(task.id)).resolves.toMatchObject({ queued: true, task: { id: task.id, status: 'ready', queueReason: expect.stringContaining('slots') } });
    expect(value.snapshot().runs).toHaveLength(0);
    expect(() => value.startTask(task.id)).toThrow(/slots/);
    value.task(occupied.id).status = 'done';
    await vi.waitFor(() => expect(value.snapshot().runs.some(run => run.taskId === task.id)).toBe(true), { timeout: 5000 });
    expect(value.task(task.id).queueReason).toBeUndefined();
  });

  it.each(['global', 'project'])('ignores archived delivery reservations at the %s limit', async (limit) => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-archived-limit-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    value.updateSettings({ maxConcurrent: limit === 'global' ? 1 : 6 });
    const project = value.createProject({ name: 'Project', repositoryPath: root, ...(limit === 'project' ? { maxConcurrent: 1 } : {}) });
    for (const status of ['review', 'completing', 'ready'] as const) {
      const task = value.createTask({ projectId: project.id, title: status });
      const stored = value.task(task.id); stored.status = status;
      if (status === 'review') stored.taskBranch = 'archived-branch';
      if (status === 'ready') stored.queuedContinuation = { instruction: 'Resolve conflicts', confirmationRequired: false, mergeRecovery: true };
      value.setTasksArchived({ taskIds: [task.id], archived: true });
    }
    const next = value.createTask({ projectId: project.id, title: 'Start now', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.log("started")'] } });
    expect(value.startTask(next.id).taskId).toBe(next.id);
  });

  it('still counts an archived task while its agent is active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-archived-agent-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    value.updateSettings({ maxConcurrent: 1 });
    const project = value.createProject({ name: 'Project', repositoryPath: root });
    const active = value.createTask({ projectId: project.id, title: 'Active', provider: 'command', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    const run = value.startTask(active.id);
    value.setTasksArchived({ taskIds: [active.id], archived: true });
    const next = value.createTask({ projectId: project.id, title: 'Next' });
    expect(() => value.startTask(next.id)).toThrow(/slots/);
    await value.stop(run.id);
  });

  it('does not queue invalid starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-invalid-start-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    const project = value.createProject({ name: 'Project', repositoryPath: root });
    const task = value.createTask({ projectId: project.id, title: 'Archived' });
    value.setTasksArchived({ taskIds: [task.id], archived: true });
    await expect(value.startTaskOrQueue(task.id)).rejects.toThrow(/archived/);
    expect(value.task(task.id).status).toBe('backlog');
  });

  it('limits agents per project while other projects still use the global limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-project-limit-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    value.updateSettings({ maxConcurrent: 6 });
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b'));
    const limited = value.createProject({ name: 'Limited', repositoryPath: join(root, 'a') });
    const free = value.createProject({ name: 'Free', repositoryPath: join(root, 'b') });
    expect(() => value.updateProject(limited.id, { maxConcurrent: 0 })).toThrow(/between 1 and 50/);
    expect(value.updateProject(limited.id, { maxConcurrent: 1 }).maxConcurrent).toBe(1);
    const command = { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),600)'] };
    const make = (projectId: string, title: string) => value.createTask({ projectId, title, provider: 'command', command, status: 'ready' });
    value.startTask(make(limited.id, 'One').id);
    expect(() => value.startTask(make(limited.id, 'Two').id)).toThrow(/slots of this project/);
    expect(() => value.startTask(make(free.id, 'Other').id)).not.toThrow();
    expect(value.updateProject(limited.id, { maxConcurrent: null }).maxConcurrent).toBeUndefined();
  });
});
