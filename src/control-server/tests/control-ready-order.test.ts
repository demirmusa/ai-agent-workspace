import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService, readyQueue } from '../service.js';
import type { Task } from '../types.js';

const roots: string[] = []; const services: ControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.close()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('ready queue order', () => {
  const at = (minute: number) => `2026-01-01T00:0${minute}:00.000Z`;
  const item = (id: string, priority: number, minute: number, extra: Partial<Task> = {}) => ({ id, priority, createdAt: at(minute), dependsOn: [] as string[], status: 'ready' as Task['status'], ...extra });

  it('starts higher priority first, then the oldest', () => {
    const ids = readyQueue([item('medium-old', 2, 1), item('low', 1, 2), item('high-new', 3, 3), item('medium-new', 2, 4)]).map((task) => task.id);
    expect(ids).toEqual(['high-new', 'medium-old', 'medium-new', 'low']);
  });

  it('keeps manual positions and puts an unplaced task ahead of placed ones with lower priority', () => {
    const ids = readyQueue([
      item('old', 2, 1), item('high', 3, 2), item('low', 1, 5),
      item('second', 1, 3, { queueOrder: 1 }), item('first', 2, 4, { queueOrder: 0 }),
    ]).map((task) => task.id);
    expect(ids).toEqual(['high', 'first', 'old', 'second', 'low']);
  });

  it('raises a blocker to the priority of the tasks waiting on it', () => {
    const blocked = item('high-blocked', 3, 1, { status: 'backlog', dependsOn: ['chain'] });
    const chain = item('chain', 1, 2, { status: 'backlog', dependsOn: ['root'] });
    const ready = [item('medium', 2, 1), item('root', 1, 3), item('done-blocker', 1, 0)];
    const finished = item('finished', 3, 0, { status: 'done', dependsOn: ['done-blocker'] });
    expect(readyQueue(ready, [...ready, blocked, chain, finished]).map((task) => task.id)).toEqual(['root', 'medium', 'done-blocker']);
  });

  it('starts ready tasks top to bottom and skips blocked ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-ready-order-')); roots.push(root);
    const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value);
    value.updateSettings({ systemEnabled: false });
    mkdirSync(join(root, 'repo'));
    const project = value.createProject({ name: 'Ordered', repositoryPath: join(root, 'repo') });
    value.updateProject(project.id, { maxConcurrent: 1 });
    const command = { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),600)'] };
    const make = (title: string, extra: Record<string, unknown> = {}) => value.createTask({ projectId: project.id, title, provider: 'command', command, status: 'ready', ...extra });
    const blocker = value.createTask({ projectId: project.id, title: 'Blocker', provider: 'command', command, status: 'backlog' });
    const first = make('First'), blocked = make('Blocked', { dependsOn: [blocker.id] }), last = make('Last');

    expect(() => value.reorderReadyTasks({ projectId: project.id, taskIds: [blocker.id, first.id] })).toThrow(/ready tasks/);
    expect(value.reorderReadyTasks({ projectId: project.id, taskIds: [blocked.id, last.id, first.id] }).map((task) => task.id)).toEqual([blocked.id, last.id, first.id]);
    // A subset keeps the slots its tasks already hold: first and last swap around the blocked task.
    expect(value.reorderReadyTasks({ projectId: project.id, taskIds: [first.id, last.id] }).map((task) => task.id)).toEqual([blocked.id, first.id, last.id]);

    value.updateSettings({ systemEnabled: true });
    (value as unknown as { tick(): void }).tick();
    expect(value.task(blocked.id).status).toBe('ready');
    expect(value.task(first.id).status).toBe('running');
    expect(value.task(last.id).status).toBe('ready');

    (value as unknown as { tick(): void }).tick();
    expect(value.task(first.id).queueOrder).toBeUndefined();
    expect(value.task(last.id).queueOrder).toBe(2);
  });
});
