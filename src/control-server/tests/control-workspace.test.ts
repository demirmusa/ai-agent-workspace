import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareTaskBranch, projectBranches, validateBranch } from '../workspace.js';
import { ControlService } from '../service.js';
import type { Project, Task } from '../types.js';
const roots: string[] = [];
const services: ControlService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'aiws-task-branch-')); roots.push(path);
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial');
  const project: Project = { id: 'p', name: 'P', description: '', repositoryPath: path, github: null, createdAt: '', updatedAt: '' };
  const task: Task = { id: 'task_one', projectId: 'p', title: 'T', description: '', status: 'backlog', provider: 'command', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' };
  return { path, git, project, task };
}
describe('task branches in an existing workspace', () => {
  it('starts from main rather than the currently checked out branch and reuses its own work', () => {
    const { git, project, task, path } = setup(); const main = git('rev-parse', 'HEAD');
    git('switch', '-c', 'other'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Other');
    prepareTaskBranch(project, task);
    expect(git('branch', '--show-current')).toBe('aiws/task_one'); expect(git('rev-parse', 'HEAD')).toBe(main);
    expect(task).toMatchObject({ baseBranch: 'main', taskBranch: 'aiws/task_one' });
    writeFileSync(join(path, 'work.txt'), 'unfinished'); prepareTaskBranch(project, task);
    expect(git('status', '--porcelain')).toContain('work.txt');
    rmSync(join(path, 'work.txt')); git('switch', 'main'); prepareTaskBranch(project, task);
    expect(git('branch', '--show-current')).toBe('aiws/task_one');
    git('switch', 'main'); git('branch', '-D', 'aiws/task_one'); prepareTaskBranch(project, task);
    expect(git('branch', '--show-current')).toBe('aiws/task_one'); expect(git('rev-parse', 'HEAD')).toBe(main);
  });
  it('supports configured and explicitly selected branches, remote-only sources and existing worktrees', async () => {
    const { git, project, task, path } = setup();
    git('branch', 'release'); git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
    expect((await projectBranches(project)).branches).toEqual(['main', 'release', 'remote-only']);
    project.defaultBranch = 'release'; prepareTaskBranch(project, task); expect(task.baseBranch).toBe('release');
    const worktree = join(path, 'checkout'); git('worktree', 'add', '--detach', worktree, 'main');
    const next = { ...task, id: 'task_two', taskBranch: undefined, baseBranch: 'remote-only' };
    prepareTaskBranch({ ...project, repositoryPath: worktree }, next);
    expect(execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('aiws/task_two');
    expect(next.baseBranch).toBe('remote-only'); expect(git('branch', '--show-current')).toBe('aiws/task_one');
  });
  it('carries uncommitted work onto the task branch and fails without changing branches when sources are unavailable', () => {
    const { git, project, task, path } = setup();
    writeFileSync(join(path, 'work.txt'), 'keep'); prepareTaskBranch(project, task);
    expect(git('branch', '--show-current')).toBe('aiws/task_one'); expect(git('status', '--porcelain')).toContain('work.txt');
    git('switch', 'main'); const missing = { ...task, taskBranch: undefined, baseBranch: 'missing' };
    rmSync(join(path, 'work.txt')); expect(() => prepareTaskBranch(project, missing)).toThrow('Cannot prepare');
    expect(git('branch', '--show-current')).toBe('main'); expect(missing.taskBranch).toBeUndefined();
    for (const name of ['--delete', 'bad..ref', '@{-1}', 'HEAD', '']) expect(() => validateBranch(name)).toThrow();
  });
  it('persists the configured default, starts the runtime on its task branch, and retains plain directory support', async () => {
    const { path, git } = setup();
    const service = await ControlService.open({ dataDir: join(path, 'data') }); services.push(service);
    // Ignore service state so the workspace stays clean.
    writeFileSync(join(path, '.git', 'info', 'exclude'), 'data/\n');
    const project = service.createProject({ useWorktree: false, name: 'P', repositoryPath: path, defaultBranch: 'main' });
    const task = service.createTask({ projectId: project.id, title: 'T', provider: 'command', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    expect(task.baseBranch).toBe('main'); const run = service.startTask(task.id);
    expect(git('branch', '--show-current')).toBe(`aiws/${task.id}`);
    expect(service.task(task.id).taskBranch).toBe(`aiws/${task.id}`);
    expect(() => service.updateTask(task.id, { baseBranch: 'other' })).toThrow('cannot change');
    await service.stop(run.id);
    const plain = mkdtempSync(join(tmpdir(), 'aiws-plain-')); roots.push(plain);
    prepareTaskBranch({ ...project, repositoryPath: plain }, { ...task, taskBranch: undefined });
    expect(() => service.createTask({ projectId: project.id, title: 'Bad', baseBranch: '--delete' })).toThrow();
  });
  it('starts a ready task on a dirty workspace and keeps the uncommitted work', async () => {
    const { path, git } = setup();
    const service = await ControlService.open({ dataDir: join(path, 'data') }); services.push(service);
    writeFileSync(join(path, '.git', 'info', 'exclude'), 'data/\n'); writeFileSync(join(path, 'work.txt'), 'unfinished');
    const project = service.createProject({ useWorktree: false, name: 'P', repositoryPath: path });
    const task = service.createTask({ projectId: project.id, title: 'T', provider: 'command', status: 'ready', command: { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},200)'] } });
    const deadline = Date.now() + 9000;
    while (!service.task(task.id).currentRunId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.task(task.id).currentRunId).toBeTruthy(); expect(service.task(task.id).queueReason).toBeUndefined();
    expect(git('branch', '--show-current')).toBe(`aiws/${task.id}`); expect(git('status', '--porcelain')).toContain('work.txt');
  }, 20000);
});
