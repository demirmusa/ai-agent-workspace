import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { launchRuntime } from '../runner.js';

vi.mock('../runner.js', async importOriginal => ({ ...await importOriginal<typeof import('../runner.js')>(), launchRuntime: vi.fn(() => ({ pid: undefined, stop: async () => {}, pause: async () => 'checkpoint', resume: async () => {}, input: vi.fn() })) }));
const roots: string[] = [], services: ControlService[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-restore-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'base.txt'), 'original\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Initial');
  const service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0, taskMergeMode: 'branch' });
  const project = service.createProject({ name: 'Restore', repositoryPath: repo, useWorktree: true, mainBranch: 'main', defaultBranch: 'main' });
  const task = service.createTask({ projectId: project.id, title: 'Original', description: 'Original request', provider: 'codex', terminalMode: 'pty' });
  const run = service.startTask(task.id);
  vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === run.id)![5].close(0);
  await vi.waitFor(() => expect(service.task(task.id).status).toBe('review'));
  return { repo, service, task, tree: service.task(task.id).worktree! };
}
async function continueTask(service: ControlService, taskId: string) {
  await service.sendTaskMessage(taskId, { text: 'Continue', continueSession: true, allowHistoryFallback: true });
  expect(launchRuntime).toHaveBeenCalledTimes(2);
}

describe('continuing a task whose worktree folder was deleted', () => {
  it('rebuilds the folder on the task branch and keeps its unmerged commits', async () => {
    const { service, task, tree } = await fixture();
    writeFileSync(join(tree.path, 'work.txt'), 'kept\n'); git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'Agent work');
    rmSync(tree.path, { recursive: true, force: true });
    await continueTask(service, task.id);
    const restored = service.task(task.id).worktree!;
    expect(restored.path).toBe(tree.path); expect(restored.cleanedAt).toBeUndefined();
    expect(readFileSync(join(restored.path, 'work.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('kept\n');
    expect(git(restored.path, 'symbolic-ref', '--short', 'HEAD')).toBe(tree.branch);
  }, 30_000);

  it('starts a merged task again from the merge target when only its folder was removed', async () => {
    const { repo, service, task, tree } = await fixture();
    writeFileSync(join(tree.path, 'merged.txt'), 'merged\n'); git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'Agent work');
    git(repo, 'merge', '--ff-only', tree.branch);
    writeFileSync(join(repo, 'later.txt'), 'later\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Later main work');
    rmSync(tree.path, { recursive: true, force: true });
    await continueTask(service, task.id);
    const restored = service.task(task.id).worktree!;
    expect(existsSync(join(restored.path, 'merged.txt'))).toBe(true);
    expect(existsSync(join(restored.path, 'later.txt'))).toBe(true);
  }, 30_000);

  it('does not re-enter completing/done when continuing a completed auto-merge task on first attempt or history fallback', async () => {
    const { repo, service, task, tree } = await fixture();
    service.updateProject(task.projectId, { autoMerge: true });
    writeFileSync(join(tree.path, 'work.txt'), 'done\n'); git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'Agent work');
    service.updateTask(task.id, { status: 'done' });
    await vi.waitFor(() => expect(service.task(task.id).status).toBe('done'));
    expect(service.task(task.id).worktree?.cleanedAt).toBeTruthy();
    expect(existsSync(tree.path)).toBe(false);

    // First continuation attempt without allowHistoryFallback throws HISTORY_FALLBACK_CONFIRMATION;
    // it must roll back the worktree state and never trigger delivery auto-merge (completing -> done).
    await expect(service.sendTaskMessage(task.id, { text: 'Continue', continueSession: true })).rejects.toThrow(/HISTORY_FALLBACK_CONFIRMATION/);
    expect(service.task(task.id).status).toBe('done');
    expect(service.task(task.id).worktree?.cleanedAt).toBeTruthy();
    expect(service.task(task.id).worktree?.mergedSha).toBeTruthy();
    expect(existsSync(tree.path)).toBe(false);
    expect((service as any).delivery.shouldAutoMerge(service.task(task.id))).toBe(false);
    (service as any).delivery.tick();
    expect(service.task(task.id).status).toBe('done');

    // Also verify that if delivery.tick() runs while session verification is in flight, it does not auto-merge.
    const findSession = vi.spyOn((service as any).history, 'findSession').mockImplementation(async () => {
      expect((service as any).delivery.shouldAutoMerge(service.task(task.id))).toBe(false);
      (service as any).delivery.tick();
      expect(service.task(task.id).status).toBe('done');
      return null;
    });
    await continueTask(service, task.id);
    findSession.mockRestore();
    expect(service.task(task.id).status).toBe('running');
    expect(existsSync(join(service.task(task.id).worktree!.path, 'work.txt'))).toBe(true);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  }, 30_000);
});
