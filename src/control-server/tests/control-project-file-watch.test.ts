import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectFileWatches, changedFolder, type ProjectFilesChange } from '../project-file-watch.js';
import { searchProjectFiles } from '../project-files.js';
import { startControlServer, type RunningControlServer } from '../server.js';

const roots: string[] = [], watches: ProjectFileWatches[] = [], servers: RunningControlServer[] = [];
afterEach(async () => {
  for (const watch of watches.splice(0)) watch.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'aiws-file-watch-')); roots.push(path);
  execFileSync('git', ['-C', path, 'init', '-b', 'main'], { stdio: 'pipe' });
  mkdirSync(join(path, 'src', 'nested'), { recursive: true }); writeFileSync(join(path, 'README.md'), '');
  return path;
}
/** Collects the changes reported for a folder and waits for one that matches. */
function recorder() {
  const changes: ProjectFilesChange[] = [];
  const until = (match: (change: ProjectFilesChange) => boolean) => vi.waitFor(() => { if (!changes.some(match)) throw new Error(`No matching change in ${JSON.stringify(changes)}`); }, { timeout: 5000, interval: 25 });
  return { changes, until, notify: (change: ProjectFilesChange) => changes.push(change) };
}

describe('project file watcher', () => {
  it('maps a changed path to the folder whose listing changed and skips paths inside .git', () => {
    expect(changedFolder('README.md')).toBe('');
    expect(changedFolder('src\\nested\\a.ts')).toBe('src/nested');
    expect(changedFolder('src/nested')).toBe('src');
    expect(changedFolder('.git/index')).toBeUndefined();
    expect(changedFolder('.git')).toBeUndefined();
    expect(changedFolder('.github/workflows/ci.yml')).toBe('.github/workflows');
  });

  it('reports created, renamed and deleted files as changes of their folders', async () => {
    const path = folder(), events = recorder(), watcher = new ProjectFileWatches(events.notify); watches.push(watcher);
    expect(await watcher.lease('p1', path)).toMatchObject({ watching: true });
    writeFileSync(join(path, 'src', 'nested', 'new.ts'), 'x');
    await events.until((change) => change.projectId === 'p1' && change.folders.includes('src/nested'));
    events.changes.length = 0;
    renameSync(join(path, 'README.md'), join(path, 'GUIDE.md'));
    await events.until((change) => change.folders.includes(''));
    events.changes.length = 0;
    rmSync(join(path, 'src', 'nested', 'new.ts'));
    await events.until((change) => change.folders.includes('src/nested'));
  });

  it('batches a burst of changes into one report and lets a search see the new files at once', async () => {
    const path = folder(), events = recorder(), watcher = new ProjectFileWatches(events.notify); watches.push(watcher);
    expect((await searchProjectFiles(path, 'burst')).items).toEqual([]);
    await watcher.lease('p1', path);
    for (let index = 0; index < 5; index++) writeFileSync(join(path, `burst-${index}.txt`), '');
    await events.until((change) => change.folders.includes(''));
    expect(events.changes.length).toBeLessThan(5);
    // The search listing is cached for consecutive keystrokes; a change drops it.
    expect((await searchProjectFiles(path, 'burst')).items.map((item) => item.name)).toEqual(['burst-0.txt', 'burst-1.txt', 'burst-2.txt', 'burst-3.txt', 'burst-4.txt']);
  });

  it('notifies every project that leased the same folder and stops when the lease lapses', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    try {
      const emitter = new EventEmitter() as EventEmitter & { close: () => void }, close = vi.fn();
      emitter.close = close;
      let listener: ((event: string, name: string | null) => void) | undefined;
      const fakeWatch = ((_root: string, _options: unknown, callback: (event: string, name: string | null) => void) => { listener = callback; return emitter; }) as never;
      const events = recorder(), watcher = new ProjectFileWatches(events.notify, fakeWatch); watches.push(watcher);
      const path = folder();
      await watcher.lease('a', path); await watcher.lease('b', path);
      listener!('rename', 'docs/new.md'); listener!('change', '.git/index');
      await vi.advanceTimersByTimeAsync(200);
      expect(events.changes.map((change) => [change.projectId, change.folders])).toEqual([['a', ['docs']], ['b', ['docs']]]);
      // A change the system cannot name (null) reloads everything.
      events.changes.length = 0; listener!('rename', null);
      await vi.advanceTimersByTimeAsync(200);
      expect(events.changes[0]).toMatchObject({ all: true, folders: [] });
      await vi.advanceTimersByTimeAsync(80_000);
      expect(close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('asks the caller to poll when the folder cannot be watched', async () => {
    const failing = (() => { throw new Error('ENOSPC'); }) as never;
    const watcher = new ProjectFileWatches(() => {}, failing); watches.push(watcher);
    expect(await watcher.lease('p', folder())).toMatchObject({ watching: false });
  });

  it('leases a project folder through the API and broadcasts its changes on the event stream', async () => {
    const path = folder(), data = mkdtempSync(join(tmpdir(), 'aiws-file-watch-data-')); roots.push(data);
    const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: data }); servers.push(server);
    const project = server.service.createProject({ name: 'Watch', repositoryPath: path });
    const events = recorder(); server.service.on('files', events.notify);
    const response = await fetch(`${server.url}/api/projects/${project.id}/files/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ watching: true, leaseMs: 60_000 });
    writeFileSync(join(path, 'src', 'created.ts'), '');
    await events.until((change) => change.projectId === project.id && change.folders.includes('src'));
  });
});
