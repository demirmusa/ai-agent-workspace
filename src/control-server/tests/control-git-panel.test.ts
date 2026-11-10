import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';

const roots: string[] = []; const services: ControlService[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, content: string, message = `Edit ${file}`) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); };
const branches = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n').filter(Boolean);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-git-panel-test-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@localhost');
  commit(repo, 'base.txt', 'original\n', 'Initial');
  const service = new ControlService({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0, taskMergeMode: 'branch' });
  const project = service.createProject({ name: 'Test', repositoryPath: repo, useWorktree: true, mainBranch: 'main', defaultBranch: 'main' });
  const commandTask = (title: string, script: string) => service.createTask({ projectId: project.id, title, provider: 'command', command: { executable: process.execPath, args: ['-e', script] } });
  return { root, repo, service, project, commandTask };
}
async function finished(service: ControlService, taskId: string, status = 'review') {
  await vi.waitFor(() => expect(service.task(taskId).status).toBe(status), { timeout: 15_000 });
}
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('footer Git panel', () => {
  it('lists the five newest commits of HEAD', async () => {
    const { repo, service, project } = setup();
    for (let index = 1; index <= 6; index += 1) commit(repo, 'base.txt', `v${index}\n`, `Commit ${index}`);
    const commits = (await service.gitOverview(project.id)).commits;
    expect(commits.map(item => item.subject)).toEqual(['Commit 6', 'Commit 5', 'Commit 4', 'Commit 3', 'Commit 2']);
    expect(commits[0]).toMatchObject({ sha: git(repo, 'rev-parse', '--short', 'HEAD'), author: 'Test' });
    expect(Number.isNaN(Date.parse(commits[0]!.date))).toBe(false);
  });
  it('lists task folders and deletes idle ones without touching the branch', async () => {
    const { repo, service, project, commandTask } = setup();
    const item = commandTask('Folder list', "require('fs').writeFileSync('feature.txt','feature')");
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    const leftover = join(resolve(tree.path, '..'), 'task_leftover'); mkdirSync(leftover);
    const folders = (await service.gitOverview(project.id)).folders;
    expect(folders.map(folder => folder.path).sort()).toEqual([resolve(tree.path), leftover].sort());
    expect(folders.find(folder => folder.path === leftover)).toMatchObject({ registered: false, active: false });
    expect(await service.deleteGitFolders(project.id, { path: leftover })).toMatchObject({ removed: [leftover], errors: [] });
    expect(existsSync(leftover)).toBe(false);
    const result = await service.deleteGitFolders(project.id, { all: true });
    expect(result.errors).toEqual([]); expect(existsSync(tree.path)).toBe(false);
    expect(branches(repo)).toContain(tree.branch);
    expect((await service.gitOverview(project.id)).folders).toEqual([]);
  }, 30_000);
  it('deletes a worktree, a branch with its worktree, or both without merging', async () => {
    const { root, repo, service, project } = setup();
    const tree = (name: string) => { const path = join(root, name); git(repo, 'worktree', 'add', '-b', name, path); commit(path, `${name}.txt`, 'unmerged\n'); writeFileSync(join(path, 'dirty.txt'), 'x'); return path; };
    const only = tree('only-tree'), withBranch = tree('with-branch'), both = tree('both');
    git(repo, 'branch', 'plain');
    await service.deleteGitTarget(project.id, { worktree: only });
    expect(existsSync(only)).toBe(false); expect(branches(repo)).toContain('only-tree');
    await service.deleteGitTarget(project.id, { branch: 'with-branch' });
    expect(existsSync(withBranch)).toBe(false); expect(branches(repo)).not.toContain('with-branch');
    await service.deleteGitTarget(project.id, { worktree: both, branch: 'both' });
    expect(existsSync(both)).toBe(false); expect(branches(repo)).not.toContain('both');
    await service.deleteGitTarget(project.id, { branch: 'plain' });
    expect(branches(repo).sort()).toEqual(['main', 'only-tree']);
    await expect(service.deleteGitTarget(project.id, { branch: 'main' })).rejects.toThrow(/main branch/);
    await expect(service.deleteGitTarget(project.id, { worktree: repo })).rejects.toThrow(/main repository/);
  });

  it('does not report old merge requests as active after integration or cleanup', async () => {
    const { repo, service, project, commandTask } = setup();
    const item = commandTask('Old merge request', "require('fs').writeFileSync('feature.txt','feature')");
    service.startTask(item.id); await finished(service, item.id);
    const task = service.task(item.id), tree = task.worktree!;
    (service as any).delivery.lastMerge.set(task.id, Date.now());
    tree.mergeRequested = true;
    expect((await service.gitOverview(project.id)).branches.find(branch => branch.name === tree.branch)?.task?.merging).toBe(true);
    tree.mergedSha = git(repo, 'rev-parse', 'main');
    expect((await service.gitOverview(project.id)).branches.find(branch => branch.name === tree.branch)?.task?.merging).toBeUndefined();
    delete tree.mergedSha;
    task.status = 'done';
    expect((await service.gitOverview(project.id)).branches.find(branch => branch.name === tree.branch)?.task?.merging).toBeUndefined();
    task.status = 'review';
    await service.mergeRepositoryBranch(project.id, { branch: tree.branch });
    await finished(service, item.id, 'done');
    expect(tree.mergeRequested).toBeUndefined();
  }, 30000);

  it('lists branches and worktrees with the tasks that own them', async () => {
    const { repo, service, project, commandTask } = setup();
    git(repo, 'branch', 'feature/plain');
    const item = commandTask('Owned work', "require('fs').writeFileSync('owned.txt','x')");
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    const overview = await service.gitOverview(project.id);
    expect(overview).toMatchObject({ mainBranch: 'main', currentBranch: 'main', changes: 0, additions: 0, deletions: 0, operation: null, remotes: [] });
    expect(overview.branches[0]).toMatchObject({ name: 'main', main: true, current: true });
    expect(overview.branches.find(branch => branch.name === 'feature/plain')).toMatchObject({ task: null, worktreePath: null, mainAhead: 0 });
    expect(overview.branches.find(branch => branch.name === tree.branch)).toMatchObject({ task: { id: item.id, title: 'Owned work', status: 'review' } });
    const owned = overview.worktrees.find(entry => entry.branch === tree.branch)!;
    expect(owned).toMatchObject({ main: false, changes: 1, conflicts: [], task: { id: item.id } });
    expect(overview.worktrees.find(entry => entry.main)).toMatchObject({ branch: 'main', task: null });
  }, 30000);

  it('lists the changed files of the main checkout and of a task branch until the branch is deleted', async () => {
    const { repo, service, project, commandTask } = setup();
    commit(repo, 'old.txt', 'one\ntwo\n', 'Add old');
    const item = commandTask('Changes', "require('fs').writeFileSync('owned.txt','x')");
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    git(tree.path, 'mv', 'old.txt', 'renamed.txt'); writeFileSync(join(tree.path, 'base.txt'), 'original\nmore\n'); git(tree.path, 'commit', '-qam', 'Task edit');
    writeFileSync(join(repo, 'base.txt'), 'changed\n'); writeFileSync(join(repo, 'new file.txt'), 'new\n'); git(repo, 'rm', '-q', 'old.txt');
    const local = await service.gitChanges(project.id);
    expect(local).toMatchObject({ branch: 'main', base: 'HEAD', additions: 1, deletions: 3, truncated: false });
    expect(local.files).toEqual([
      { path: 'base.txt', status: 'modified', additions: 1, deletions: 1 },
      { path: 'new file.txt', status: 'untracked', additions: 0, deletions: 0 },
      { path: 'old.txt', status: 'deleted', additions: 0, deletions: 2 },
    ]);
    const { changes } = await service.taskChanges(item.id);
    expect(changes).toMatchObject({ branch: tree.branch, root: resolve(tree.path), additions: 1, deletions: 0 });
    expect(changes!.files).toEqual([
      { path: 'base.txt', status: 'modified', additions: 1, deletions: 0 },
      { path: 'owned.txt', status: 'untracked', additions: 0, deletions: 0 },
      { path: 'renamed.txt', oldPath: 'old.txt', status: 'renamed', additions: 0, deletions: 0 },
    ]);
    expect((await service.gitChanges(project.id, tree.path)).files.map(file => file.path)).toEqual(['owned.txt']);
    await expect(service.gitChanges(project.id, join(repo, 'elsewhere'))).rejects.toThrow('worktree');
    git(repo, 'checkout', '-q', '--', '.'); git(repo, 'reset', '-q', '--hard'); rmSync(join(repo, 'new file.txt'));
    expect((await service.mergeRepositoryBranch(project.id, { branch: tree.branch })).status).toBe('merged');
    expect(await service.taskChanges(item.id)).toEqual({ changes: null });
  }, 30000);

  it('merges a task branch into main and removes its worktree and branch', async () => {
    const { repo, service, project, commandTask } = setup();
    const item = commandTask('Feature', "require('fs').writeFileSync('feature.txt','feature')");
    service.startTask(item.id); await finished(service, item.id);
    const tree = service.task(item.id).worktree!;
    const result = await service.mergeRepositoryBranch(project.id, { branch: tree.branch });
    expect(result).toMatchObject({ status: 'merged', branch: tree.branch, taskId: item.id });
    await finished(service, item.id, 'done');
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature');
    expect(existsSync(tree.path)).toBe(false);
    expect(branches(repo)).toEqual(['main']);
  }, 30000);

  it('shows task branch conflicts directly when no agent can resolve them', async () => {
    const { repo, service, project, commandTask } = setup();
    const item = commandTask('Conflicting', "require('fs').writeFileSync('base.txt','task\\n')");
    service.startTask(item.id); await finished(service, item.id);
    commit(repo, 'base.txt', 'main\n');
    const result = await service.mergeRepositoryBranch(project.id, { branch: service.task(item.id).worktree!.branch });
    expect(result).toMatchObject({ status: 'conflict', conflicts: ['base.txt'] });
    expect(readFileSync(join(repo, 'base.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('main\n');
    const overview = await service.gitOverview(project.id);
    expect(overview.worktrees.find(entry => entry.task?.id === item.id)?.conflicts).toEqual(['base.txt']);
  }, 30000);

  it('merges and deletes a plain branch, including its clean worktree', async () => {
    const { root, repo, service, project } = setup();
    git(repo, 'switch', '-c', 'feature'); commit(repo, 'feature.txt', 'feature\n'); git(repo, 'switch', 'main');
    const path = join(root, 'feature-tree'); git(repo, 'worktree', 'add', path, 'feature');
    const result = await service.mergeRepositoryBranch(project.id, { branch: 'feature' });
    expect(result).toMatchObject({ status: 'merged', warnings: [] });
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('feature\n');
    expect(branches(repo)).toEqual(['main']); expect(existsSync(path)).toBe(false);
    await expect(service.mergeRepositoryBranch(project.id, { branch: 'main' })).rejects.toThrow(/itself/);
    await expect(service.mergeRepositoryBranch(project.id, { branch: '--force' })).rejects.toThrow(/branch name/);
  }, 30000);

  it('switches the main checkout to main before deleting the merged branch it was on', async () => {
    const { repo, service, project } = setup();
    git(repo, 'switch', '-c', 'feature'); commit(repo, 'feature.txt', 'feature\n');
    const result = await service.mergeRepositoryBranch(project.id, { branch: 'feature' });
    expect(result).toMatchObject({ status: 'merged', warnings: [] });
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(branches(repo)).toEqual(['main']);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('feature\n');
  }, 30000);

  it('merges into main without deleting the branch when asked to keep it', async () => {
    const { repo, service, project } = setup();
    git(repo, 'switch', '-c', 'feature'); commit(repo, 'feature.txt', 'feature\n'); git(repo, 'switch', 'main');
    expect(await service.mergeRepositoryBranch(project.id, { branch: 'feature', keep: true })).toMatchObject({ status: 'merged', warnings: [] });
    expect(branches(repo)).toEqual(['feature', 'main']);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('feature\n');
  }, 30000);

  it('keeps the checked out branch when the main checkout has uncommitted changes', async () => {
    const { repo, service, project } = setup();
    git(repo, 'switch', '-c', 'feature'); commit(repo, 'feature.txt', 'feature\n'); writeFileSync(join(repo, 'base.txt'), 'dirty\n');
    const result = await service.mergeRepositoryBranch(project.id, { branch: 'feature' });
    expect(result).toMatchObject({ status: 'merged', warnings: [expect.stringMatching(/uncommitted changes/)] });
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
    expect(branches(repo)).toEqual(['feature', 'main']);
  }, 30000);

  it('queues an agent to resolve plain branch conflicts, then merges and deletes the branch', async () => {
    const { repo, service, project } = setup();
    service.updateSettings({ systemEnabled: false });
    git(repo, 'switch', '-c', 'feature'); commit(repo, 'base.txt', 'feature\n'); git(repo, 'switch', 'main'); commit(repo, 'base.txt', 'main\n');
    const result = await service.mergeRepositoryBranch(project.id, { branch: 'feature' });
    expect(result).toMatchObject({ status: 'resolving', conflicts: ['base.txt'] });
    if (result.status !== 'resolving') return;
    expect(readFileSync(join(repo, 'base.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('main\n');
    const task = service.task(result.taskId);
    expect(task).toMatchObject({ status: 'ready', autoMerge: true, baseBranch: 'feature', queuedContinuation: { mergeRecovery: true } });
    expect(task.queuedContinuation!.instruction).toContain('base.txt');
    const tree = task.worktree!;
    expect(tree).toMatchObject({ sourceBranch: 'feature', mergeRequested: true, mainBranch: 'main' });
    expect(git(tree.path, 'diff', '--name-only', '--diff-filter=U')).toBe('base.txt');
    const overview = await service.gitOverview(project.id);
    expect(overview.branches.find(branch => branch.name === 'feature')?.task).toMatchObject({ id: task.id, merging: true });
    await expect(service.mergeRepositoryBranch(project.id, { branch: 'feature' })).rejects.toThrow(/still working/);
    // What the agent does: resolve, commit. AIWS then merges the task branch.
    writeFileSync(join(tree.path, 'base.txt'), 'main and feature\n'); git(tree.path, 'add', '.'); git(tree.path, 'commit', '--no-edit');
    (service as any).delivery.mergeLocalTask(service.task(task.id));
    expect(readFileSync(join(repo, 'base.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('main and feature\n');
    await vi.waitFor(() => expect(branches(repo)).toEqual(['main']), { timeout: 10_000 });
    expect(existsSync(tree.path)).toBe(false);
  }, 30000);

  it('fetches, pulls and pushes against a remote', async () => {
    const { root, repo, service, project } = setup();
    const remote = join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    await expect(service.gitCommand(project.id, 'pull', {})).rejects.toThrow(/no upstream/);
    expect((await service.gitCommand(project.id, 'push', {})).message).toBe('Pushed main to origin.');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
    const clone = join(root, 'clone'); git(root, 'clone', remote, clone);
    git(clone, 'config', 'user.name', 'Other'); git(clone, 'config', 'user.email', 'other@localhost');
    commit(clone, 'remote.txt', 'remote\n'); git(clone, 'push');
    await service.gitCommand(project.id, 'fetch', {});
    expect(await service.gitOverview(project.id)).toMatchObject({ upstream: 'origin/main', behind: 1, ahead: 0, remotes: ['origin'] });
    await service.gitCommand(project.id, 'pull', {});
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('remote\n');
    commit(repo, 'local.txt', 'local\n');
    expect(await service.gitOverview(project.id)).toMatchObject({ ahead: 1, behind: 0 });
    await service.gitCommand(project.id, 'push', {});
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'main'));
    git(repo, 'branch', 'topic');
    expect((await service.gitCommand(project.id, 'push', { branch: 'topic' })).message).toBe('Pushed topic to origin.');
    expect(git(remote, 'rev-parse', 'topic')).toBe(git(repo, 'rev-parse', 'main'));
    await expect(service.gitCommand(project.id, 'reset', {})).rejects.toThrow(/Unknown/);
  }, 30000);

  it('commits every change of the main workspace with a summary and description', async () => {
    const { repo, service, project } = setup();
    await expect(service.gitCommand(project.id, 'commit', { summary: 'Nothing' })).rejects.toThrow(/no changes/);
    writeFileSync(join(repo, 'new.txt'), 'new\n'); writeFileSync(join(repo, 'base.txt'), 'edited\n');
    await expect(service.gitCommand(project.id, 'commit', { summary: '  ' })).rejects.toThrow(/summary is required/);
    expect((await service.gitCommand(project.id, 'commit', { summary: 'Add new file', description: 'With a body.' })).message).toMatch(/^Committed \w+: Add new file$/);
    expect(git(repo, 'log', '-1', '--format=%s|%b')).toBe('Add new file|With a body.');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect((await service.gitOverview(project.id)).changes).toBe(0);
  });
});
