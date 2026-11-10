import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlGitHub } from '../github.js';
import * as gitModule from '../git.js';
import { changeDiff, managedFolders } from '../repository-git.js';
import { cleanupTaskWorktree } from '../worktrees.js';
import { ControlService } from '../service.js';
import { removeTempRoot } from './helpers/temp-root.js';
import { prepareRuntime } from '../runner.js';
import { seedCodexAgentFamily } from './helpers/agent-history-fixture.js';
import { ControlError, type Task } from '../types.js';

const roots: string[] = []; const services: ControlService[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function setup(branch = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'aiws-worktree-test-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-b', branch);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'base.txt'), 'original\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Initial');
  git(repo, 'remote', 'add', 'github', 'https://github.com/test/repo.git'); // pull-request mode needs a github.com remote
  const service = new ControlService({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0, taskMergeMode: 'branch' });
  const project = service.createProject({ name: 'Test', repositoryPath: repo, useWorktree: true, mainBranch: branch, defaultBranch: branch });
  const task = (title: string, autoMerge = false, script = "require('fs').writeFileSync('result.txt',process.cwd())") => service.createTask({ projectId: project.id, title, autoMerge, provider: 'command', command: { executable: process.execPath, args: ['-e', script] } });
  return { root, repo, service, project, task };
}
async function finished(service: ControlService, taskId: string, status = 'review') {
  await vi.waitFor(() => expect(service.task(taskId).status).toBe(status), { timeout: 15_000 });
}
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

describe('task Git worktrees', () => {
  it('creates new task folders on the short path and still cleans up and lists legacy ones', async () => {
    const { root, repo, service, project, task } = setup();
    const item = task('Short path');
    service.startTask(item.id); await finished(service, item.id);
    const data = join(root, 'data');
    const shortPath = join(data, 'wt', project.id.replace(/^[a-z]+_/, '').slice(0, 8), item.id.replace(/^[a-z]+_/, '').slice(0, 8));
    expect(resolve(service.task(item.id).worktree!.path)).toBe(realpathSync.native(shortPath));

    const legacyId = 'task_legacy-folder', legacyPath = join(data, 'worktrees', project.id, legacyId), branch = `aiws/${legacyId}`;
    mkdirSync(join(data, 'worktrees', project.id), { recursive: true });
    git(repo, 'worktree', 'add', '-b', branch, legacyPath);
    const legacy = { id: legacyId, projectId: project.id, worktree: { path: legacyPath, branch, mainBranch: 'main', repositoryPath: repo, mergedSha: git(repo, 'rev-parse', 'HEAD') } } as unknown as Task;

    const folders = await managedFolders(project, [service.task(item.id)], data);
    expect(folders.map(folder => folder.path).sort()).toEqual([shortPath, legacyPath].sort());
    expect(folders.find(folder => folder.path === shortPath)?.task?.id).toBe(item.id);

    cleanupTaskWorktree(legacy, data);
    expect(existsSync(legacyPath)).toBe(false);
    expect(() => cleanupTaskWorktree({ ...legacy, worktree: { ...legacy.worktree!, path: join(data, 'elsewhere'), cleanedAt: undefined } } as Task, data)).toThrow(/unexpected path/);
  }, 30000);

  it('uses the selected source branch while retaining the separate merge target', async () => {
    const { repo, service, project, task } = setup();
    git(repo, 'switch', '-c', 'source');
    writeFileSync(join(repo, 'source.txt'), 'source feature\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Source feature'); git(repo, 'switch', 'main');
    service.updateProject(project.id, { defaultBranch: 'source' });
    const item = task('Selected source');
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    expect(readFileSync(join(tree.path, 'source.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('source feature\n');
    expect(tree.mainBranch).toBe('main');
    expect(service.task(item.id).baseBranch).toBe('source');
    expect(service.task(item.id).taskBranch).toBe(tree.branch);
    service.updateTask(item.id, { status: 'done' });
    expect(readFileSync(join(repo, 'source.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('source feature\n');
  }, 30000);

  it('enables worktrees by default only when main exists, lists real local branches and isolates project configuration across restarts', async () => {
    const { service, repo, root, project } = setup('develop');
    git(repo, 'branch', 'feature/test');
    const other = service.createProject({ name: 'Other', repositoryPath: repo, defaultBranch: 'develop' });
    expect(other).toMatchObject({ useWorktree: false, mainBranch: 'main' });
    expect(service.repositoryBranches({ path: repo })).toEqual({ branches: ['develop', 'feature/test'], currentBranch: 'develop' });
    expect(() => service.updateSettings({ useWorktree: true })).toThrow(/project/);
    expect(service.project(project.id)).toMatchObject({ useWorktree: true, mainBranch: 'develop' });
    vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    const task = service.createTask({ projectId: other.id, title: 'No isolation' });
    expect(service.startTask(task.id).workspacePath).toBe(repo);
    await service.store.flush(); const state = service.store.readPersisted() as any;
    await service.close();
    const statePath = join(root, 'data', 'state.json'); for (const name of ['control.db', 'control.db-wal', 'control.db-shm', 'settings.json']) rmSync(join(join(root, 'data'), name), { force: true });
    state.settings.useWorktree = true; state.settings.mainBranch = 'develop';
    delete state.projects[1].useWorktree; delete state.projects[1].mainBranch;
    writeFileSync(statePath, JSON.stringify(state));
    const reopened = new ControlService({ dataDir: join(root, 'data') }); services.push(reopened);
    expect(reopened.project(project.id)).toMatchObject({ useWorktree: true, mainBranch: 'develop' });
    expect(reopened.project(other.id).useWorktree).toBe(false);
    expect(reopened.snapshot().settings).not.toHaveProperty('useWorktree');
    expect(reopened.snapshot().settings).not.toHaveProperty('mainBranch');
  });

  it('runs parallel real children in separate branches and manually merges into the configured branch', async () => {
    const { repo, service, task } = setup('develop');
    const first = task('First'); const second = task('Second', false, "setTimeout(()=>require('fs').writeFileSync('second.txt','second'),150)");
    const a = service.startTask(first.id); const b = service.startTask(second.id);
    expect(a.workspacePath).not.toBe(repo); expect(b.workspacePath).not.toBe(a.workspacePath);
    await finished(service, first.id); await finished(service, second.id);
    const tree = service.task(first.id).worktree!;
    expect(readFileSync(join(tree.path, 'result.txt'), 'utf8')).toBe(tree.path);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    writeFileSync(join(repo, 'main-only.txt'), 'Independent main change\n');
    git(repo, 'add', 'main-only.txt'); git(repo, 'commit', '-m', 'Advance main before task merge');
    service.updateProject(service.snapshot().projects[0]!.id, { useWorktree: false });
    service.updateTask(first.id, { status: 'done' });
    expect(readFileSync(join(repo, 'result.txt'), 'utf8')).toBe(tree.path);
    expect(git(repo, 'branch', '--show-current')).toBe('develop');
    expect(service.task(second.id).status).toBe('review');
    expect(service.task(first.id).worktree?.mergedSha).toBeTruthy();
    expect(service.task(first.id).worktree?.cleanedAt).toBeTruthy();
    expect(existsSync(tree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', tree.branch)).toBe('');
    expect(existsSync(service.task(second.id).worktree!.path)).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe('Test <test@localhost>|Test <test@localhost>');
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  }, 30_000);

  it('completes a task whose agent already merged its branch and removed the worktree', async () => {
    const { repo, service, task } = setup();
    const item = task('Self merged'); service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    git(tree.path, 'add', '--all'); git(tree.path, 'commit', '-m', 'Agent work');
    git(repo, 'merge', '--ff-only', tree.branch); git(repo, 'worktree', 'remove', '--force', tree.path); git(repo, 'branch', '-D', tree.branch);
    service.updateTask(item.id, { status: 'done' });
    const done = service.task(item.id);
    await finished(service, item.id, 'done');
    expect(done.status).toBe('done');
    expect(done.worktree?.mergedSha).toBeTruthy();
    expect(done.worktree?.cleanedAt).toBeTruthy();
    expect(service.snapshot().events.some((event: { type: string; message: string }) => event.type === 'worktree.merge' && /already merged/.test(event.message))).toBe(true);
  }, 30_000);

  it('auto commits and merges successful work and preserves failed tasks', async () => {
    const { repo, service, task } = setup();
    const successful = task('Automatic', true); service.startTask(successful.id);
    await finished(service, successful.id, 'done');
    expect(readFileSync(join(repo, 'result.txt'), 'utf8')).toBe(service.task(successful.id).worktree?.path);
    const tree = service.task(successful.id).worktree!;
    expect(tree.cleanedAt).toBeTruthy();
    expect(existsSync(tree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', tree.branch)).toBe('');
    const failed = task('Failed', true, "require('fs').writeFileSync('failed.txt','keep');process.exit(1)");
    service.startTask(failed.id); await finished(service, failed.id, 'failed');
    expect(git(repo, 'ls-files', 'failed.txt')).toBe('');
    expect(readFileSync(join(service.task(failed.id).worktree!.path, 'failed.txt'), 'utf8')).toBe('keep');
  }, 30_000);

  it.each(['global', 'project'] as const)('holds the %s slot and dependencies until remote cleanup finishes', async scope => {
    const { repo, service, project, task } = setup();
    if (scope === 'global') service.updateSettings({ maxConcurrent: 1 });
    else service.updateProject(project.id, { maxConcurrent: 1 });
    let release!: () => void;
    const pending = new Promise<string>(resolve => { release = () => resolve(''); });
    const original = gitModule.gitAsync;
    vi.spyOn(gitModule, 'gitAsync').mockImplementation((cwd, args, ...rest) => args[0] === 'for-each-ref' && args.includes('refs/remotes') ? pending : original(cwd, args, ...rest));
    const first = task('Finalizing', true);
    const next = task('Next', false, "require('fs').writeFileSync('next.txt','next')");
    const dependent = service.createTask({ projectId: project.id, title: 'Dependent', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, dependsOn: [first.id] });
    try {
      service.startTask(first.id);
      await vi.waitFor(() => expect(service.task(first.id).worktree?.cleanedAt).toBeTruthy(), { timeout: 15000 });
      expect(service.task(first.id).status).toBe('completing');
      expect(git(repo, 'rev-parse', 'main')).toBe(service.task(first.id).worktree?.mergedSha);
      expect(() => service.startTask(next.id)).toThrow(/slots/);
      expect(service.updateTask(first.id, { status: 'done' }).status).toBe('completing');
      expect(() => service.updateTask(first.id, { status: 'ready' })).toThrow(/still in progress/);
      await expect(service.sendTaskMessage(first.id, { text: 'Continue', continueSession: true })).rejects.toThrow(/still in progress/);
      expect(() => service.startTask(dependent.id)).toThrow(/dependencies/);
    } finally { release(); }
    await finished(service, first.id, 'done');
    expect(() => service.startTask(dependent.id)).not.toThrow();
  }, 30000);

  it('fails delivery when remote branch cleanup fails and keeps dependents blocked', async () => {
    const { service, project, task } = setup();
    const original = gitModule.gitAsync;
    vi.spyOn(gitModule, 'gitAsync').mockImplementation((cwd, args, ...rest) => args[0] === 'for-each-ref' && args.includes('refs/remotes') ? Promise.reject(new Error('Remote unavailable')) : original(cwd, args, ...rest));
    const first = task('Cleanup failure', true); service.startTask(first.id);
    await finished(service, first.id, 'failed');
    expect(service.task(first.id).worktree?.cleanupError).toContain('Remote unavailable');
    const dependent = service.createTask({ projectId: project.id, title: 'Blocked', dependsOn: [first.id] });
    expect(() => service.startTask(dependent.id)).toThrow(/dependencies/);
    vi.restoreAllMocks(); service.updateTask(first.id, { status: 'done' });
    await finished(service, first.id, 'done');
  }, 30000);

  it('resumes final cleanup after restarting with an already removed local worktree', async () => {
    const { root, service, project, task } = setup();
    const item = task('Restart finalization', true); service.startTask(item.id);
    await finished(service, item.id, 'done');
    // Persist the state at the boundary between local cleanup and remote cleanup.
    service.task(item.id).status = 'completing';
    await service.close(); services.splice(services.indexOf(service), 1);
    const reopened = new ControlService({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') } }); services.push(reopened);
    reopened.updateSettings({ maxConcurrent: 1 });
    const next = reopened.createTask({ projectId: project.id, title: 'Next' });
    expect(reopened.task(item.id).status).toBe('completing');
    expect(() => reopened.startTask(next.id)).toThrow(/slots/);
    await finished(reopened, item.id, 'done');
  }, 30000);

  it('deletes the pushed copy of a task branch after it is merged into main', async () => {
    const { root, repo, service, task } = setup();
    const remote = join(root, 'origin.git'); execFileSync('git', ['init', '--bare', remote]);
    git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'main');
    const pushed = task('Pushed', true, "const {execSync}=require('child_process');require('fs').writeFileSync('pushed.txt','x');execSync('git add -A && git commit -m pushed && git push origin HEAD',{stdio:'ignore'})");
    service.startTask(pushed.id); await finished(service, pushed.id, 'done');
    const tree = service.task(pushed.id).worktree!;
    await vi.waitFor(() => expect(tree.cleanedAt).toBeTruthy(), { timeout: 15_000 });
    expect(git(repo, 'ls-files', 'pushed.txt')).toBe('pushed.txt');
    expect(git(repo, 'branch', '--list', tree.branch)).toBe('');
    await vi.waitFor(() => expect(git(remote, 'branch', '--list', tree.branch)).toBe(''), { timeout: 15_000 });
    expect(git(remote, 'branch', '--list', 'main')).toContain('main');
  }, 30_000);

  it('fails the task when cleanup is locked and completes it once cleanup works', async () => {
    const { repo, service, task } = setup(); const item = task('Locked cleanup');
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    git(repo, 'worktree', 'lock', tree.path);
    service.updateTask(item.id, { status: 'done' });
    expect(service.task(item.id).status).toBe('failed');
    expect(tree.mergedSha).toBe(git(repo, 'rev-parse', 'main'));
    expect(tree.mergeError).toBeUndefined();
    expect(tree.cleanupError).toContain('locked');
    expect(tree.cleanedAt).toBeUndefined();
    expect(existsSync(tree.path)).toBe(true);
    git(repo, 'worktree', 'unlock', tree.path);
    service.updateTask(item.id, { status: 'done' });
    await finished(service, item.id, 'done');
    expect(tree.cleanedAt).toBeTruthy(); expect(tree.cleanupError).toBeUndefined();
    expect(existsSync(tree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', tree.branch)).toBe('');
  }, 30_000);

  it('fails delivery and preserves user changes when main is dirty, then allows a retry', async () => {
    const { repo, service, task } = setup(); const item = task('Dirty main'); service.startTask(item.id); await finished(service, item.id);
    writeFileSync(join(repo, 'user.txt'), 'do not touch');
    expect(() => service.updateTask(item.id, { status: 'done' })).toThrow(/uncommitted/);
    expect(service.task(item.id).status).toBe('failed'); expect(readFileSync(join(repo, 'user.txt'), 'utf8')).toBe('do not touch');
    git(repo, 'add', 'user.txt'); git(repo, 'commit', '-m', 'User work');
    service.updateTask(item.id, { status: 'done' }); expect(service.task(item.id).worktree?.mergeError).toBeUndefined();
  }, 30_000);

  it('preserves conflicts in the task branch and keeps main clean for resolution', async () => {
    const { repo, service, task } = setup(); const item = task('Conflict', false, "require('fs').writeFileSync('base.txt','task change\\n')");
    service.startTask(item.id); await finished(service, item.id);
    writeFileSync(join(repo, 'base.txt'), 'main change\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Main change'); const head = git(repo, 'rev-parse', 'HEAD');
    expect(() => service.updateTask(item.id, { status: 'done' })).toThrow(/CONFLICT.*base\.txt/s);
    expect(service.task(item.id).status).toBe('failed'); expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(''); expect(service.task(item.id).worktree?.mergeError).toContain('Git:');
    const tree = service.task(item.id).worktree!;
    expect(git(tree.path, 'diff', '--name-only', '--diff-filter=U')).toBe('base.txt');
    expect(readFileSync(join(tree.path, 'base.txt'), 'utf8')).toContain('<<<<<<<');
    expect(service.task(item.id).worktree?.mergeError).not.toContain('Command failed:');
    // A manual resolution must make the same task retryable without losing either change.
    writeFileSync(join(tree.path, 'base.txt'), 'main change\ntask change\n');
    git(tree.path, 'add', 'base.txt'); git(tree.path, 'commit', '--no-edit');
    service.updateTask(item.id, { status: 'done' });
    await finished(service, item.id, 'done');
    expect(service.task(item.id).worktree?.mergeError).toBeUndefined();
    expect(readFileSync(join(repo, 'base.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('main change\ntask change\n');
  }, 30_000);

  it.each([false, true])('resolves and retries repeated conflicts through the agent (autoMerge=%s)', async (automatic) => {
    const { repo, service, task } = setup();
    const item = task('Repeated conflict', false, "require('fs').writeFileSync('base.txt','task change\\n')");
    service.startTask(item.id); await finished(service, item.id);
    const stored = service.task(item.id); const tree = stored.worktree!;
    // Stand in for a completed AI run without launching an installed provider.
    const previous = service.run(stored.currentRunId!);
    previous.provider = 'codex'; previous.executionSnapshot!.provider = 'codex'; delete previous.executionSnapshot!.command;
    stored.provider = 'codex'; stored.providerOverride = 'codex'; delete stored.command; stored.autoMerge = automatic;
    writeFileSync(join(repo, 'base.txt'), 'main change\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Advance main');
    const mainHead = git(repo, 'rev-parse', 'HEAD');
    if (automatic) await (service as any).delivery.autoMerge(stored);
    else service.updateTask(item.id, { status: 'done' });
    expect(stored.status).toBe('ready');
    expect(stored.queuedContinuation?.mergeRecovery).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(tree.path, 'diff', '--name-only', '--diff-filter=U')).toBe('base.txt');
    const launch = vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    service.updateSettings({ systemEnabled: false });
    await expect(service.startQueuedTask(item.id)).rejects.toThrow(/System is stopped/);
    expect(stored.queuedContinuation?.mergeRecovery).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    service.updateSettings({ systemEnabled: true });
    const recovery = await service.startQueuedTask(item.id);
    expect(recovery.workspacePath).toBe(tree.path);
    expect(recovery.executionSnapshot?.task.description).toContain('Resolve all conflicts');
    expect(recovery.executionSnapshot?.provider).toBe('codex');
    expect(recovery.executionSnapshot?.command).toBeUndefined();
    expect(stored.description).toBe(item.description);
    writeFileSync(join(tree.path, 'base.txt'), 'main change\ntask change\n');
    git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'Resolve first conflict');
    // Another task advances main while the resolver is running.
    writeFileSync(join(repo, 'base.txt'), 'new main change\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Advance main again');
    service.complete(recovery.id, { summary: 'Resolved first conflict' });
    expect(stored.status).toBe('ready');
    expect(stored.queuedContinuation?.mergeRecovery).toBe(true);
    const second = await service.startQueuedTask(item.id);
    expect(second.id).not.toBe(recovery.id);
    writeFileSync(join(tree.path, 'base.txt'), 'new main change\nmain change\ntask change\n');
    git(tree.path, 'add', '.'); git(tree.path, 'commit', '-m', 'Resolve second conflict');
    service.complete(second.id, { summary: 'Resolved and verified' });
    await finished(service, item.id, 'done');
    expect(stored.status).toBe('done');
    expect(stored.worktree?.mergeError).toBeUndefined();
    expect(stored.worktree?.mergeRequested).toBeUndefined();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(stored.worktree?.mergedSha);
    expect(readFileSync(join(repo, 'base.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('new main change\nmain change\ntask change\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(launch).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('merges into an unchecked-out target branch without switching the user workspace', async () => {
    const { repo, service, task } = setup(); git(repo, 'switch', '-c', 'user-branch');
    const item = task('Main elsewhere'); service.startTask(item.id); await finished(service, item.id);
    service.updateTask(item.id, { status: 'done' });
    expect(git(repo, 'show', 'main:result.txt')).toBe(service.task(item.id).worktree?.path);
    expect(git(repo, 'branch', '--show-current')).toBe('user-branch');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('merge-worktrees');
    expect(service.task(item.id).worktree?.cleanedAt).toBeTruthy();
    expect(git(repo, 'branch', '--list', service.task(item.id).worktree!.branch)).toBe('');
  }, 30_000);

  it('rejects invalid settings/missing branches and includes Git metadata mounts for Docker', () => {
    const { service, task } = setup();
    const project = service.snapshot().projects[0]!;
    expect(() => service.updateProject(project.id, { useWorktree: 'yes' })).toThrow(/boolean/);
    expect(() => service.updateProject(project.id, { mainBranch: '--help' })).toThrow(/branch/i);
    expect(() => service.updateProject(project.id, { mainBranch: 'missing' })).toThrow(/existing local branch/);
    const item = task('Missing');
    git(project.repositoryPath, 'branch', '-m', 'renamed');
    expect(() => service.startTask(item.id)).toThrow(); expect(service.task(item.id).status).toBe('backlog');
    git(project.repositoryPath, 'branch', '-m', 'main');
    service.updateSettings({ executionMode: 'docker' }); vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    const run = service.startTask(item.id); const stored = service.task(item.id);
    const runtime = prepareRuntime({ ...service.project(stored.projectId), repositoryPath: run.workspacePath! }, stored, run, '', { image: 'test', controlUrl: 'http://localhost' });
    expect(runtime.args).toContain('GIT_COMMON_DIR=/run/aiws/git-common'); expect(runtime.args).toContain('GIT_WORK_TREE=/workspace');
    expect(runtime.args.filter(argument => argument.endsWith('dst=/run/aiws/git-common'))).toHaveLength(1);
    expect(runtime.args).toContain(`type=bind,src=${run.workspacePath},dst=/workspace`);
  });

  it.each([false, true])('continues the original provider session using the persisted worktree scope (merged: %s)', async (merged) => {
    const { root, service, project } = setup();
    vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    const task = service.createTask({ projectId: project.id, title: 'Continue isolated session', provider: 'codex', terminalMode: 'stream' });
    const run = service.startTask(task.id);
    const family = seedCodexAgentFamily(join(root, 'codex'), run.workspacePath!);
    service.run(run.id).sessionId = family.rootId; service.complete(run.id, { summary: 'Ready' });
    if (merged) {
      service.updateTask(task.id, { status: 'done' });
      await finished(service, task.id, 'done');
      expect(service.task(task.id).worktree?.cleanedAt).toBeTruthy();
      expect(existsSync(run.workspacePath!)).toBe(false);
      service.task(task.id).pullRequest = {number:90,merged:true};
      writeFileSync(join(project.repositoryPath, 'later.txt'), 'Latest main');
      git(project.repositoryPath, 'add', '.'); git(project.repositoryPath, 'commit', '-m', 'Advance main after cleanup');
    }
    await service.sendTaskMessage(task.id, { text: 'Continue in this branch', continueSession: true });
    const continued = service.run(service.task(task.id).currentRunId!);
    expect(continued.id).not.toBe(run.id); expect(continued.workspacePath).toBe(run.workspacePath);
    expect(continued.historyResume?.sessionId).toBe(family.rootId);
    expect(service.task(task.id).worktree?.branch).toBe(`aiws/${task.id}`);
    expect(service.task(task.id).worktree?.cleanedAt).toBeUndefined();
    expect(service.task(task.id).worktree?.mergedSha).toBeUndefined();
    if (merged) expect(service.task(task.id).pullRequest).toBeUndefined();
    if (merged) expect(readFileSync(join(continued.workspacePath!, 'later.txt'), 'utf8')).toBe('Latest main');
  });
});


describe('task pull request integration', () => {
  it.each(['merged', 'deleted', 'unmerged', 'local-only', 'no-evidence'])('verifies shared checkout delivery after switching to main (%s)', async scenario => {
    const { root, service, project, task, repo } = setup('develop');
    service.updateProject(project.id, { useWorktree: false });
    const remote = join(root, 'origin.git');
    git(repo, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'develop');
    const item = task('Agent integrated shared checkout'); service.startTask(item.id); await finished(service, item.id);
    const stored = service.task(item.id), branch = stored.taskBranch!;
    git(repo, 'add', '--all'); git(repo, 'commit', '-m', 'Task work');
    const headSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', 'develop');
    if (scenario !== 'unmerged') git(repo, 'merge', '--ff-only', branch);
    if (scenario !== 'local-only') git(repo, 'push', 'origin', 'develop');
    if (scenario === 'deleted' || scenario === 'no-evidence') {
      git(repo, 'branch', '-D', branch);
      if (scenario === 'deleted') stored.pullRequest = { number: 42, headSha };
    }
    writeFileSync(join(repo, 'unrelated.txt'), 'Keep user changes');
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockRejectedValue(new ControlError('Task branch changed.', 409));
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest');
    vi.spyOn(ControlGitHub.prototype, 'deleteBranch').mockResolvedValue(false);
    service.updateProject(project.id, { taskMergeMode: 'pull-request' });
    service.updateTask(item.id, { status: 'done' });
    const success = scenario === 'merged' || scenario === 'deleted';
    await finished(service, item.id, success ? 'done' : 'failed');
    expect(create).toHaveBeenCalledTimes(scenario === 'unmerged' || scenario === 'no-evidence' ? 1 : 0);
    expect(merge).not.toHaveBeenCalled();
    expect(Boolean(stored.deliveryVerifiedAt)).toBe(success);
    expect(git(repo, 'branch', '--show-current')).toBe('develop');
    expect(git(repo, 'status', '--porcelain')).toContain('?? unrelated.txt');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(scenario === 'unmerged' ? git(repo, 'rev-parse', `${headSha}^`) : headSha);
    expect(git(repo, 'branch', '--list', branch)).toBe(success || scenario === 'no-evidence' ? '' : `  ${branch}`.trim());
  }, 30000);

  it.each([true, false].flatMap(useWorktree => [true, false].map(merged => ({ useWorktree, merged }))))('verifies manual merges after GitHub reports no commits ($useWorktree, $merged)', async ({ useWorktree, merged }) => {
    const { root, service, project, task, repo } = setup();
    service.updateProject(project.id, { useWorktree });
    const remote = join(root, 'origin.git');
    git(repo, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'main');
    const item = task('Manually merged'); service.startTask(item.id); await finished(service, item.id);
    const stored = service.task(item.id), workspace = stored.worktree?.path ?? repo;
    git(workspace, 'add', '--all'); git(workspace, 'commit', '-m', 'Task changes');
    const headSha = git(workspace, 'rev-parse', 'HEAD'), branch = stored.taskBranch!;
    // A user merges on the remote while the local main still needs to be updated.
    git(repo, 'push', 'origin', branch);
    if (merged) git(remote, 'update-ref', 'refs/heads/main', headSha);
    const originalGit = gitModule.gitAsync;
    let failCleanup = merged && useWorktree;
    vi.spyOn(gitModule, 'gitAsync').mockImplementation((cwd, args, ...rest) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return Promise.resolve('https://github.com/owner/repo.git');
      if (failCleanup && args[0] === 'push' && args.includes('--delete')) { failCleanup = false; return Promise.reject(new ControlError('Remote temporarily unavailable', 502)); }
      return originalGit(cwd, args, ...rest);
    });
    const github = new ControlGitHub('test-token', (async (url: any) => String(url).includes('/pulls?')
      ? new Response('[]')
      : new Response(JSON.stringify({ message: `No commits between main and ${branch}` }), { status: 422 })) as typeof fetch);
    const createPullRequest = github.createTaskPullRequest.bind(github);
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockImplementation((_project, current) => createPullRequest({ ...project, github: { repository: 'owner/repo', owner: 'owner', number: 1 } }, current));
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest');
    vi.spyOn(ControlGitHub.prototype, 'deleteBranch').mockImplementation(async (_project, name) => { git(repo, 'push', 'origin', '--delete', name); return true; });
    service.updateProject(project.id, { taskMergeMode: 'pull-request' });
    service.updateTask(item.id, { status: 'done' });
    await vi.waitFor(() => expect(['done', 'failed']).toContain(stored.status), { timeout: 15000 });
    if (merged && useWorktree) {
      expect(stored.status).toBe('failed');
      expect(stored.worktree?.cleanedAt).toBeTruthy();
      expect((service as any).delivery.dependencySatisfied(stored)).toBe(false);
      service.updateTask(item.id, { status: 'done' }); await finished(service, item.id, 'done');
    }
    expect(stored.status, JSON.stringify(service.store.state.events.filter(event => event.taskId === item.id))).toBe(merged ? 'done' : 'failed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
    const dependent = service.createTask({ projectId: project.id, title: 'Dependent', dependsOn: [item.id] });
    if (merged) {
      expect(stored.deliveryVerifiedAt).toBeTruthy();
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(git(repo, 'branch', '--list', branch)).toBe('');
      expect(git(remote, 'branch', '--list', branch)).toBe('');
      expect(readFileSync(join(repo, 'result.txt'), 'utf8')).toBe(workspace);
      if (useWorktree) expect(stored.worktree?.cleanedAt).toBeTruthy();
      expect((service as any).delivery.dependencySatisfied(stored)).toBe(true);
      expect((service as any).delivery.taskPullRequestNeedsUpdate(stored)).toBe(false);
    } else {
      expect(stored.deliveryVerifiedAt).toBeUndefined();
      expect(git(repo, 'branch', '--list', branch)).not.toBe('');
      expect(git(remote, 'branch', '--list', branch)).not.toBe('');
      if (useWorktree) expect(existsSync(workspace)).toBe(true);
      expect(() => service.startTask(dependent.id)).toThrow(/dependencies/);
    }
  }, 30000);

  it('preserves unrelated GitHub creation errors', async () => {
    const { service, project, task } = setup();
    const item = task('Permission failure'); service.startTask(item.id); await finished(service, item.id);
    service.updateProject(project.id, { taskMergeMode: 'pull-request' });
    vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockRejectedValue(new ControlError('GitHub: Resource not accessible', 502));
    const verify = vi.spyOn((service as any).delivery, 'verifyPullRequestMain');
    service.updateTask(item.id, { status: 'done' }); await finished(service, item.id, 'failed');
    expect(verify).not.toHaveBeenCalled();
    expect(service.task(item.id).worktree?.cleanedAt).toBeUndefined();
  }, 30000);

  it('pulls the local main after a pull request merge and hands a failed pull to the agent', async () => {
    const { root, repo, service, task } = setup();
    const origin = join(root, 'origin.git'), other = join(root, 'other');
    git(root, 'init', '--bare', '-b', 'main', origin); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', 'origin', 'main');
    git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Test'); git(other, 'config', 'user.email', 'test@localhost');
    const merged = (file: string, content: string) => { writeFileSync(join(other, file), content); git(other, 'add', '.'); git(other, 'commit', '-m', file); git(other, 'push', 'origin', 'main'); return git(other, 'rev-parse', 'HEAD'); };
    const contains = (sha: string) => { git(repo, 'merge-base', '--is-ancestor', sha, 'main'); };
    const delivery = (service as any).delivery, stored = service.task(task('Merged remotely').id);
    (stored as any).worktree = { repositoryPath: repo, mainBranch: 'main' };

    // Unrelated uncommitted changes stay in place.
    writeFileSync(join(repo, 'base.txt'), 'local edit\n');
    let sha = merged('first.txt', 'first\n');
    expect(await delivery.verifyPullRequestMain(stored, sha)).toBeUndefined();
    contains(sha);
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('local edit\n');

    // Overlapping changes block the pull, which is reported rather than swallowed.
    sha = merged('base.txt', 'merged\n');
    await expect(delivery.verifyPullRequestMain(stored, sha)).rejects.toThrow();
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('local edit\n');
    git(repo, 'checkout', '--', 'base.txt');

    // Local commits are merged with origin and kept.
    writeFileSync(join(repo, 'local.txt'), 'local\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Local');
    const local = git(repo, 'rev-parse', 'HEAD');
    expect(await delivery.verifyPullRequestMain(stored, sha)).toBeUndefined();
    contains(sha); contains(local);

    // A conflicting local commit leaves no merge behind.
    writeFileSync(join(repo, 'clash.txt'), 'local\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Clash');
    sha = merged('clash.txt', 'remote\n');
    await expect(delivery.verifyPullRequestMain(stored, sha)).rejects.toThrow();
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // A failed pull keeps the task open and queues the agent, a bounded number of times.
    service.updateSettings({ taskMergeMode: 'pull-request' });
    stored.currentRunId = 'run'; vi.spyOn(delivery.ctx, 'run').mockReturnValue({ provider: 'codex' });
    (stored as any).pullRequest = { number: 4, url: 'u', merged: true };
    vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number: 4, url: 'u', headSha: sha, mergeSha: sha, merged: true, message: 'Merged.' });
    stored.status = 'review';
    await delivery.autoMerge(stored, true);
    expect(stored.status).toBe('ready');
    expect(stored.deliveryVerifiedAt).toBeUndefined();
    expect(stored.queuedContinuation).toMatchObject({ mergeRecovery: true, instruction: expect.stringContaining('git pull --no-rebase origin main') });
    expect(stored.pullRequest?.mergeRequested).toBe(true);
    delete stored.queuedContinuation;
    delivery.deliveryRecoveries.set(stored.id, 3);
    await delivery.autoMerge(stored, true);
    expect(stored.status).toBe('failed');
    stored.currentRunId = null;

    // Off main the branch still fast-forwards when it can, without touching the checkout.
    git(repo, 'switch', '-c', 'feature'); git(repo, 'branch', '-f', 'main', git(repo, 'rev-parse', `${sha}^`));
    expect(await delivery.verifyPullRequestMain(stored, sha)).toBeUndefined();
    expect(git(repo, 'rev-parse', 'main')).toBe(sha);
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  }, 30000);

  it('retries a remote outage, then reopens the task for its agent a bounded number of times', async () => {
    const { service, project } = setup();
    service.updateSettings({ taskMergeMode: 'pull-request' });
    const delivery = (service as any).delivery;
    vi.spyOn(delivery, 'usesPullRequests').mockReturnValue(true);
    vi.spyOn(delivery, 'taskPullRequestNeedsUpdate').mockReturnValue(true);
    vi.spyOn(delivery.ctx, 'run').mockReturnValue({ provider: 'codex' });
    const open = (title: string) => Object.assign(service.task(service.createTask({ projectId: project.id, title }).id), { taskBranch: `aiws/${title}`, currentRunId: 'run', status: 'review' });
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest');

    const outage = open('outage'), message = 'Git: remote: Internal Server Error\n ! [remote rejected] aiws/outage -> aiws/outage (Internal Server Error)';
    create.mockRejectedValue(new ControlError(message, 409));
    for (let attempt = 0; attempt < 4; attempt++) {
      await delivery.autoMerge(outage, true);
      expect(outage.status).toBe('completing');
      expect(outage.queuedContinuation).toBeUndefined();
    }
    await delivery.autoMerge(outage, true);
    expect(outage.status).toBe('ready');
    expect(outage.queuedContinuation).toMatchObject({ mergeRecovery: true, instruction: expect.stringContaining(message) });

    const rejected = open('rejected');
    create.mockRejectedValue(new ControlError('Git: pre-receive hook declined', 409));
    for (let attempt = 0; attempt < 3; attempt++) {
      await delivery.autoMerge(rejected, true);
      expect(rejected.status).toBe('ready');
      expect(rejected.queuedContinuation.instruction).toContain('pre-receive hook declined');
      delete rejected.queuedContinuation; rejected.status = 'review';
    }
    await delivery.autoMerge(rejected, true);
    expect(rejected.status).toBe('failed');
    expect(rejected.queuedContinuation).toBeUndefined();
  }, 30000);

  it('does not read Git for finished tasks whose delivery is already settled', () => {
    const { service, project } = setup();
    service.updateSettings({ taskMergeMode: 'pull-request' });
    const delivery = (service as any).delivery;
    const task = { id: 'finished', projectId: project.id, status: 'done', taskBranch: 'aiws/finished', deliveryVerifiedAt: new Date().toISOString() };
    const usesPullRequests = vi.spyOn(delivery, 'usesPullRequests');
    expect(delivery.dependencySatisfied(task)).toBe(true);
    expect(usesPullRequests).not.toHaveBeenCalled();
    usesPullRequests.mockRestore();
    const pending = { ...task, deliveryVerifiedAt: undefined };
    expect(delivery.usesPullRequests(pending)).toBe(true);
    // A GitHub remote once found stays known, also across a task boundary.
    git(project.repositoryPath, 'remote', 'remove', 'github');
    delivery.recheckGitHubRemote(pending);
    expect(delivery.usesPullRequests(pending)).toBe(true);
    // "No remote" holds until the next boundary asks Git again, and that one question finds a remote added since.
    delivery.githubRemotes.set(project.repositoryPath, false);
    git(project.repositoryPath, 'remote', 'add', 'github', 'https://github.com/test/repo.git');
    expect(delivery.usesPullRequests(pending)).toBe(false);
    delivery.recheckGitHubRemote(pending);
    expect(delivery.usesPullRequests(pending)).toBe(true);
  });
  it('does not read Git for a pull request waiting in review', () => {
    const { service, project } = setup();
    service.updateSettings({ taskMergeMode: 'pull-request' });
    const delivery = (service as any).delivery, needsUpdate = vi.spyOn(delivery, 'taskPullRequestNeedsUpdate');
    const created = service.createTask({ projectId: project.id, title: 'Reviewed' }), stored = service.store.state.tasks.find(item => item.id === created.id)!;
    Object.assign(stored, { status: 'review', taskBranch: 'aiws/reviewed', autoMerge: false, pullRequest: { number: 5, url: 'https://github.com/test/repo/pull/5' } });
    delivery.tick();
    expect(needsUpdate).not.toHaveBeenCalled();
  });
  it('inherits global PR mode, allows project overrides and persists both settings', async () => {
    const { service, project } = setup();
    service.updateSettings({ taskMergeMode: 'pull-request' });
    expect(service.project(project.id).taskMergeMode).toBeNull();
    service.updateProject(project.id, { taskMergeMode: 'branch' });
    expect(service.project(project.id).taskMergeMode).toBe('branch');
    expect(() => service.updateSettings({ taskMergeMode: 'invalid' })).toThrow('taskMergeMode');
    expect(() => service.updateProject(project.id, { taskMergeMode: false })).toThrow('taskMergeMode');
    await service.store.flush();
    const saved = service.store.readPersisted()!;
    expect(saved.settings.taskMergeMode).toBe('pull-request');
    expect(saved.projects.find(item => item.id === project.id)?.taskMergeMode).toBe('branch');
    service.updateProject(project.id, { taskMergeMode: null });
    expect(service.project(project.id).taskMergeMode).toBeNull();
  });

  it('creates a PR with automatic merge disabled and uses that PR for a manual completion', async () => {
    const { service, project, task, repo } = setup();
    service.updateSettings({ taskMergeMode: 'pull-request' });
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockResolvedValue({ number: 17, url: 'https://github.com/owner/repo/pull/17', headSha: 'reviewed' });
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number: 17, url: 'https://github.com/owner/repo/pull/17', headSha: 'reviewed', merged: false, message: 'Checks pending' });
    const item = task('PR review');
    service.startTask(item.id);
    await vi.waitFor(() => expect(service.task(item.id).pullRequest?.number).toBe(17), { timeout: 15000 });
    expect(service.task(item.id).status).toBe('review');
    expect(service.store.state.runs.find((run) => run.id === service.task(item.id).currentRunId)?.pullRequest).toEqual({ number: 17, url: 'https://github.com/owner/repo/pull/17' });
    expect(merge).not.toHaveBeenCalled();
    expect(existsSync(join(repo, 'result.txt'))).toBe(false);
    service.updateTask(item.id, { status: 'done' });
    await vi.waitFor(() => expect(merge).toHaveBeenCalled());
    expect(service.task(item.id).status).toBe('completing');
    expect(create).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls[0]![1].autoMerge).toBe(true);
  }, 30000);

  it('creates PRs for tasks in the shared checkout too', async () => {
    const { service, project, task } = setup();
    service.updateProject(project.id, { useWorktree: false, taskMergeMode: 'pull-request' });
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockResolvedValue({ number: 19, headSha: 'reviewed' });
    const item = task('Shared checkout'); service.startTask(item.id);
    await vi.waitFor(() => expect(service.task(item.id).pullRequest?.number).toBe(19), { timeout: 15000 });
    expect(service.task(item.id).worktree).toBeUndefined();
    expect(service.task(item.id).taskBranch).toBe(`aiws/${item.id}`);
    expect(create).toHaveBeenCalledTimes(1);
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number:19, url:'https://github.com/owner/repo/pull/19', headSha:'reviewed', merged:false, message:'Checks pending' });
    service.updateTask(item.id, {status:'done'});
    await vi.waitFor(() => expect(merge).toHaveBeenCalled());
    expect(service.task(item.id).status).toBe('completing');
    expect(service.task(item.id).pullRequest?.mergeRequested).toBe(true);
    await expect(service.mergeRepositoryBranch(project.id,{branch:service.task(item.id).taskBranch,keep:true})).rejects.toThrow('Checks pending');
  }, 30000);

  it.each([true, false])('verifies main and cleans branches after a confirmed PR merge (worktree: %s)', async useWorktree => {
    const { service, project, task, repo } = setup();
    service.updateProject(project.id, { taskMergeMode:'pull-request', useWorktree });
    const create = vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockImplementation(async (_project, item) => {
      const path = item.worktree?.path ?? repo;
      gitModule.git(path, 'add', '--all'); gitModule.git(path, 'commit', '-m', 'Task');
      return {number:20,headSha:gitModule.git(path,'rev-parse','HEAD')};
    });
    vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockImplementation(async (_project, item) => {
      // Model the merge performed remotely by GitHub; fetch observes this exact merge commit.
      git(repo,'update-ref','refs/remotes/origin/main',item.pullRequest!.headSha!);
      return {number:20,url:'https://github.com/owner/repo/pull/20',headSha:item.pullRequest!.headSha!,merged:true,message:'Merged'};
    });
    const originalGit = gitModule.gitAsync;
    vi.spyOn(gitModule,'gitAsync').mockImplementation(async (cwd,args,...rest) => args[0]==='fetch' ? '' : originalGit(cwd,args,...rest));
    vi.spyOn(ControlGitHub.prototype, 'deleteBranch').mockResolvedValue(true);
    const localMerge = vi.spyOn((service as any).delivery,'mergeLocalTask');
    const item=task('Auto PR',true); service.startTask(item.id);
    await finished(service, item.id, 'done');
    if (useWorktree) expect(service.task(item.id).worktree?.cleanedAt).toBeTruthy();
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'branch', '--list', service.task(item.id).taskBranch!)).toBe('');
    expect(existsSync(join(repo, 'result.txt'))).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(localMerge).not.toHaveBeenCalled(); expect(service.task(item.id).pullRequest?.merged).toBe(true);
  },30000);

  it('keeps dependents blocked when GitHub reports merged but local main lacks the task commit', async () => {
    const { service, project, task, repo } = setup();
    service.updateProject(project.id, { taskMergeMode: 'pull-request' });
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    vi.spyOn(ControlGitHub.prototype, 'createTaskPullRequest').mockImplementation(async (_project, item) => {
      git(item.worktree!.path, 'add', '--all'); git(item.worktree!.path, 'commit', '-m', 'Task');
      return { number: 21, headSha: git(item.worktree!.path, 'rev-parse', 'HEAD') };
    });
    vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockImplementation(async (_project, item) => ({ number: 21, merged: true, message: 'Merged', headSha: item.pullRequest!.headSha! }));
    const original = gitModule.gitAsync;
    vi.spyOn(gitModule, 'gitAsync').mockImplementation((cwd, args, ...rest) => args[0] === 'fetch' ? Promise.resolve('') : original(cwd, args, ...rest));
    const item = task('Unverified main', true); service.startTask(item.id);
    await finished(service, item.id, 'failed');
    expect(service.task(item.id).worktree?.cleanedAt).toBeUndefined();
    expect(existsSync(service.task(item.id).worktree!.path)).toBe(true);
    const dependent = service.createTask({ projectId: project.id, title: 'Blocked', dependsOn: [item.id] });
    expect(() => service.startTask(dependent.id)).toThrow(/dependencies/);
  }, 30000);

  it('commits and pushes a task branch, reconciles an existing PR and retains remote patches', async () => {
    const { service, project, task } = setup();
    const item = task('Create PR'); service.startTask(item.id); await finished(service, item.id);
    const stored = service.task(item.id);
    const originalGit = gitModule.gitAsync;
    const push = vi.spyOn(gitModule, 'gitAsync').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/owner/repo.git';
      if (args[0] === 'push') return '';
      return originalGit(cwd, args, ...rest);
    });
    let created = 0, existing = false;
    const github = new ControlGitHub('test-token', (async (url: any, options: any) => {
      const path = String(url);
      if (path.includes('/files?')) return new Response(JSON.stringify([{ filename: 'result.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+saved' }]));
      if (path.includes('/pulls?')) return new Response(JSON.stringify(existing ? [{ number: 18, html_url: 'https://github.com/owner/repo/pull/18', state: 'open', body: `<!-- aiws-task:${stored.id} -->` }] : []));
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body); expect(body.base).toBe('main'); expect(body.head).toBe(stored.worktree!.branch); expect(body.body).toContain(`<!-- aiws-task:${stored.id} -->`);
      created++; existing = true;
      return new Response(JSON.stringify({ number: 18, html_url: 'https://github.com/owner/repo/pull/18' }));
    }) as typeof fetch);
    const linked = { ...project, github: { repository: 'owner/repo', owner: 'owner', number: 1 } };
    stored.pullRequest = await github.createTaskPullRequest(linked, stored);
    const firstHead = stored.pullRequest.headSha;
    writeFileSync(join(stored.worktree!.path, 'followup.txt'), 'Follow-up change');
    const updated = await github.createTaskPullRequest(linked, stored);
    expect(updated.headSha).not.toBe(firstHead);
    expect(created).toBe(1); expect(push.mock.calls.some(call => call[1][0] === 'push')).toBe(true);
    expect(git(stored.worktree!.path, 'status', '--porcelain')).toBe('');
    service.updateTask(stored.id, { status: 'done' });
    expect(service.task(stored.id).worktree?.cleanedAt).toBeTruthy();
    const changes = await github.pullRequestChanges(linked, stored);
    expect(changes.files).toMatchObject([{ path: 'result.txt', additions: 1 }]);
    expect(await changeDiff(linked, changes, 'result.txt')).toMatchObject({ diff: '@@ -0,0 +1 @@\n+saved' });
    await expect(changeDiff(linked, changes, 'other.txt')).rejects.toThrow('changed file');
  }, 30000);
});
