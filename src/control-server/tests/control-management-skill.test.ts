import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startControlServer, type RunningControlServer } from '../server.js';

const directories: string[] = [], servers: RunningControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiws-management-skill-')); directories.push(root);
  return { root, home: join(root, 'home'), dataDir: join(root, 'data') };
}

it('installs and repairs the management skill on every control service startup', async () => {
  const { home, dataDir } = await fixture();
  const options = { host: '127.0.0.1', port: 0, dataDir, skills: { home } };
  const first = await startControlServer(options); servers.push(first);
  const entry = join(home, '.agents', 'skills', 'aiws-project-manager', 'SKILL.md');
  expect(await readFile(entry, 'utf8')).toContain('name: aiws-project-manager');
  await first.close(); servers.splice(servers.indexOf(first), 1);
  await writeFile(entry, 'Stale management instructions');
  const second = await startControlServer(options); servers.push(second);
  expect(await readFile(entry, 'utf8')).toContain('name: aiws-project-manager');
  expect((await fetch(`${second.url}/api/health`)).ok).toBe(true);
});

it('logs skill sync failures and still starts the control service', async () => {
  const { root, home, dataDir } = await fixture(), outside = join(root, 'outside');
  await mkdir(home, { recursive: true }); await mkdir(outside);
  await symlink(outside, join(home, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const running = await startControlServer({ host: '127.0.0.1', port: 0, dataDir, skills: { home } }); servers.push(running);
  expect((await fetch(`${running.url}/api/health`)).ok).toBe(true);
  const log = await readFile(join(dataDir, 'logs', 'errors.log'), 'utf8');
  expect(log).toContain('linked skill path');
  expect(log).toContain('Synchronizing the bundled AIWS project management skill');
  await expect(readFile(join(outside, 'skills', 'aiws-project-manager', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
