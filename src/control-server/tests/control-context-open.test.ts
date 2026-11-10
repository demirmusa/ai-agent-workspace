import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service.js';

const launched = vi.hoisted(() => [] as string[]);
// The default-program launcher is replaced, so these tests open nothing on the computer running them.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (_executable: string, args: string[]) => {
    launched.push(args.at(-1)!.replace(/^"|"$/g, ''));
    const child = Object.assign(new EventEmitter(), { unref() {} });
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 0); });
    return child;
  },
}));

const roots: string[] = []; const services: ControlService[] = [];
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aiws-context-open-'))); roots.push(root);
  const repo = join(root, 'repo'), outside = join(root, 'outside.md'), secret = join(root, 'secret.md');
  mkdirSync(join(repo, 'src'), { recursive: true }); writeFileSync(join(repo, 'src', 'a.js'), ''); writeFileSync(outside, ''); writeFileSync(secret, '');
  const service = new ControlService({ dataDir: join(root, 'data') }); services.push(service);
  const project = service.createProject({ name: 'Test', repositoryPath: repo });
  const task = service.createTask({ projectId: project.id, title: 'Task' });
  const removed = join(root, 'removed-worktree');
  service.store.state.runs.push({ id: 'run_open', taskId: task.id, provider: 'claude', status: 'completed', workspacePath: removed, pendingCommands: [] } as never);
  vi.spyOn(service, 'runContext').mockResolvedValue({ agents: [], agentId: '', warnings: [], snapshot: { blocks: [{ id: 'memory:outside.md', kind: 'memory', label: 'outside.md', path: outside, tokens: 1, count: 1 }] } } as never);
  return { service, repo, removed, outside, secret };
}
afterEach(async () => {
  launched.length = 0; vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('opening a file from the context window', () => {
  it('finds a file of a removed worktree in the repository', async () => {
    const { service, repo, removed } = setup();
    await service.openRunContextFile('run_open', { path: join(removed, 'src', 'a.js') });
    expect(launched).toEqual([join(repo, 'src', 'a.js')]);
  });
  it('opens a file outside the project that the context window records', async () => {
    const { service, outside } = setup();
    await service.openRunContextFile('run_open', { path: outside });
    expect(launched).toEqual([outside]);
  });
  it('refuses a file outside the project that the context window does not record', async () => {
    const { service, secret } = setup();
    await expect(service.openRunContextFile('run_open', { path: secret })).rejects.toThrow();
    expect(launched).toEqual([]);
  });
});
