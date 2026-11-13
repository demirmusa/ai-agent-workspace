import { describe, expect, it } from 'vitest';
import { StateBroadcaster } from '../service/broadcaster.js';
import type { ControlContext } from '../service/context.js';
import { ReadyQueueDispatcher } from '../service/ready-queue.js';
import type { ControlStore } from '../store.js';
import type { Run, Task } from '../types.js';

describe('ready task publication', () => {
  it('publishes a just-created ready task before its start blocks on workspace preparation', () => {
    const order: string[] = [];
    const task = { id: 'task_new', status: 'ready', priority: 0, createdAt: '2026-01-01T00:00:00.000Z', dependsOn: [] } as unknown as Task;
    const ctx = { state: { tasks: [task], settings: { systemEnabled: true } }, changed: () => {} } as unknown as ControlContext;
    const queue = new ReadyQueueDispatcher(ctx, {
      publish: () => order.push('publish'), startTask: () => { order.push('start'); return {} as Run; }, startQueuedTask: async () => ({} as Run),
      continuing: () => false, usageWaiting: () => false, retryAt: () => 0, runtimeError: (error) => { throw error; },
    });
    queue.tick(Date.now());
    expect(order).toEqual(['publish', 'start']);
  });

  it('flushes a scheduled state broadcast immediately', () => {
    const emitted: string[] = [];
    const store = { state: { events: [], messages: [] }, scheduleSave: () => {} } as unknown as ControlStore;
    const broadcaster = new StateBroadcaster(store, (event) => { emitted.push(event); }, () => ({}) as never);
    broadcaster.flush();
    expect(emitted).toEqual([]);
    broadcaster.changed();
    broadcaster.flush();
    expect(emitted).toEqual(['change']);
    broadcaster.flush();
    expect(emitted).toEqual(['change']);
    broadcaster.close();
  });
});
