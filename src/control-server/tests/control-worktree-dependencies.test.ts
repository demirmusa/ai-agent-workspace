import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasStaleMainInstall, linkWorktreeDependencies, refreshStaleMainInstalls } from '../worktree-dependencies.js';

const npm = vi.hoisted(() => ({ calls: [] as string[], onRun: (_cwd: string): void => undefined }));
vi.mock('../windows-launch.js', async (original) => ({
  ...await original<typeof import('../windows-launch.js')>(),
  execCli: (_path: string, _args: readonly string[], options: { cwd?: string }) => { npm.calls.push(options.cwd!); return new Promise((done) => setTimeout(() => { npm.onRun(options.cwd!); done({ error: null, stdout: '', stderr: '' }); }, 20)); },
}));
import { cleanupTaskWorktree } from '../worktrees.js';
import { ControlService } from '../service.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-deps-test-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'app'), { recursive: true }); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  for (const folder of ['', 'app']) {
    writeFileSync(join(repo, folder, 'package.json'), '{"dependencies":{"pkg":"1.0.0"},"devDependencies":{"@scope/tool":"1.0.0"}}\n'); writeFileSync(join(repo, folder, 'package-lock.json'), `{"folder":"${folder}"}\n`);
    for (const name of ['pkg', '@scope/tool']) { mkdirSync(join(repo, folder, 'node_modules', name), { recursive: true }); writeFileSync(join(repo, folder, 'node_modules', name, 'package.json'), '{}\n'); }
    writeFileSync(join(repo, folder, 'node_modules', 'pkg', 'index.js'), folder);
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Initial');
  const worktree = join(root, 'tree'); git(repo, 'worktree', 'add', '-b', 'task', worktree);
  return { root, repo, worktree };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('worktree dependency linking', () => {
  it('links installed folders whose lockfiles match and keeps the worktree clean', () => {
    const { repo, worktree } = setup();
    expect(linkWorktreeDependencies(repo, worktree)).toHaveLength(2);
    expect(lstatSync(join(worktree, 'app', 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(worktree, 'app', 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('app');
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('removing the task worktree leaves the main checkout install intact', async () => {
    const { root, repo } = setup();
    const service = new ControlService({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } });
    try {
      service.updateSettings({ autoSyncSeconds: 0, taskMergeMode: 'branch' });
      const project = service.createProject({ name: 'Test', repositoryPath: repo, useWorktree: true, mainBranch: 'main', defaultBranch: 'main' });
      const task = service.createTask({ projectId: project.id, title: 'Deps', provider: 'command', command: { executable: process.execPath, args: ['-e', "require('fs').writeFileSync('result.txt',String(require('fs').existsSync('app/node_modules/pkg/index.js')))"] } });
      service.startTask(task.id);
      await vi.waitFor(() => expect(service.task(task.id).status).toBe('review'), { timeout: 15_000 });
      const worktree = service.task(task.id).worktree!.path;
      expect(readFileSync(join(worktree, 'result.txt'), 'utf8')).toBe('true');
      rmSync(join(worktree, 'result.txt'));
      service.store.state.tasks.find(item => item.id === task.id)!.worktree!.mergedSha = git(repo, 'rev-parse', 'main');
      cleanupTaskWorktree(service.task(task.id), join(root, 'data'));
      expect(existsSync(worktree)).toBe(false);
      expect(existsSync(join(repo, 'app', 'node_modules', 'pkg', 'index.js'))).toBe(true);
    } finally { await service.close(); }
  });

  it('skips folders whose lockfile changed or that already have an install', () => {
    const { repo, worktree } = setup();
    writeFileSync(join(worktree, 'app', 'package-lock.json'), '{"changed":true}\n');
    mkdirSync(join(worktree, 'node_modules', 'own'), { recursive: true });
    expect(linkWorktreeDependencies(repo, worktree)).toEqual([]);
    expect(existsSync(join(worktree, 'app', 'node_modules'))).toBe(false);
    expect(readdirSync(join(worktree, 'node_modules'))).toEqual(['own']);
  });

  it('skips main checkout installs that are empty or miss a dependency', () => {
    const { repo, worktree } = setup();
    rmSync(join(repo, 'node_modules'), { recursive: true }); mkdirSync(join(repo, 'node_modules'));
    rmSync(join(repo, 'app', 'node_modules', '@scope'), { recursive: true });
    expect(linkWorktreeDependencies(repo, worktree)).toEqual([]);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(worktree, 'app', 'node_modules'))).toBe(false);
  });

  it('runs npm install once in a main checkout that lags behind its lockfile, then links it', async () => {
    const { repo, worktree } = setup(); npm.calls.length = 0;
    rmSync(join(repo, 'app', 'node_modules', '@scope'), { recursive: true });
    npm.onRun = (cwd) => { mkdirSync(join(cwd, 'node_modules', '@scope', 'tool'), { recursive: true }); writeFileSync(join(cwd, 'node_modules', '@scope', 'tool', 'package.json'), '{}'); };
    expect(hasStaleMainInstall(repo, worktree)).toBe(true);
    const [first, second] = await Promise.all([refreshStaleMainInstalls(repo, worktree), refreshStaleMainInstalls(repo, worktree)]);
    expect(first).toEqual(['app: ran npm install in the main checkout']); expect(second).toEqual(first);
    expect(npm.calls).toEqual([join(repo, 'app')]);
    expect(hasStaleMainInstall(repo, worktree)).toBe(false);
    expect(linkWorktreeDependencies(repo, worktree)).toHaveLength(2);
  });
});
