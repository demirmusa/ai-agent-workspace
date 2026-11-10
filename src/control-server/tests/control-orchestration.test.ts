import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import { ControlGitHub } from '../github.js';
import type { Task } from '../types.js';

const roots: string[] = []; const services: ControlService[] = []; const servers: RunningControlServer[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-orchestration-')); roots.push(root); return root; }
function directory(root: string, name: string): string { const path = join(root, name); mkdirSync(path); return path; }
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error('Timed out awaiting orchestration state.');
}
async function service(root: string): Promise<ControlService> { const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value); return value; }
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(services.splice(0).map((value) => value.close())); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('automatic agent orchestration', () => {
  it('drains active tasks, blocks new work, persists off and resumes the queue when enabled', async () => {
    const root = temp(); const value = await service(root);
    value.updateSettings({ maxConcurrent: 1 });
    const project = value.createProject({ name: 'Drain', repositoryPath: directory(root, 'drain') });
    const command = { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),600)'] };
    const first = value.createTask({ projectId: project.id, title: 'Active', provider: 'command', command });
    const run = value.startTask(first.id);
    const queued = value.createTask({ projectId: project.id, title: 'Queued', provider: 'command', command, status: 'ready' });
    expect(() => value.updateSettings({ systemEnabled: 'false' })).toThrow(/boolean/);
    value.updateSettings({ systemEnabled: false });
    expect(value.snapshot().systemStatus).toBe('draining');
    expect(() => value.startTask(queued.id)).toThrow(/System is stopped/);
    await waitFor(() => value.snapshot().systemStatus, status => status === 'stopped');
    expect(value.run(run.id).status).toBe('completed');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(value.task(queued.id).currentRunId).toBeNull();
    await value.close(); services.splice(services.indexOf(value), 1);
    const reopened = await service(root);
    expect(reopened.snapshot().settings.systemEnabled).toBe(false);
    expect(reopened.snapshot().systemStatus).toBe('stopped');
    reopened.updateSettings({ systemEnabled: true });
    await waitFor(() => reopened.task(queued.id).status, status => status === 'review');
  }, 15000);

  it('finishes the active workflow while leaving other ready tasks queued during shutdown', async () => {
    const root = temp(); const value = await service(root);
    const project = value.createProject({ name: 'Workflow drain', repositoryPath: directory(root, 'workflow-drain') });
    const agent = value.catalog.createAgent({ name: 'Worker', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),150)'] } });
    const workflow = value.workflows.create({ name: 'Two stages', steps: [{ name: 'First', agentId: agent.id }, { name: 'Second', agentId: agent.id }] });
    const active = value.createTask({ projectId: project.id, title: 'Active workflow', workflowId: workflow.id });
    value.startTask(active.id);
    value.updateSettings({ systemEnabled: false });
    const queued = value.createTask({ projectId: project.id, title: 'Next workflow', workflowId: workflow.id, status: 'ready' });
    await waitFor(() => value.snapshot().systemStatus, status => status === 'stopped');
    expect(value.task(active.id).workflowProgress?.status).toBe('completed');
    expect(value.snapshot().runs.filter(run => run.taskId === active.id)).toHaveLength(2);
    expect(value.task(queued.id).currentRunId).toBeNull();
  }, 15000);

  it('automatically releases a ready dependency chain after successful local runs reach review', async () => {
    const root = temp(); const value = await service(root);
    value.updateSettings({ maxConcurrent: 1 });
    const project = value.createProject({ name: 'Dependency chain', repositoryPath: directory(root, 'chain') });
    const command = { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),100)'] };
    const first = value.createTask({ projectId: project.id, title: 'First', provider: 'command', command, terminalMode: 'stream' });
    const second = value.createTask({ projectId: project.id, title: 'Second', provider: 'command', command, terminalMode: 'stream', dependsOn: [first.id], status: 'ready', autoStart: false });
    const third = value.createTask({ projectId: project.id, title: 'Third', provider: 'command', command, terminalMode: 'stream', dependsOn: [second.id], status: 'ready' });
    await waitFor(() => value.task(second.id).queueReason, (reason) => !!reason);
    expect(value.task(second.id).queueReason).toContain('dependencies');
    expect(value.task(second.id).currentRunId).toBeNull();
    value.updateTask(first.id, { status: 'ready' });
    // Review is not merged yet, so each link only releases the next one once it is done.
    for (const [task, next] of [[first, second], [second, third]] as const) {
      await waitFor(() => value.task(task.id), (item) => item.status === 'review');
      expect(value.task(next.id).currentRunId).toBeNull();
      value.updateTask(task.id, { status: 'done' });
    }
    await waitFor(() => value.task(third.id), (task) => task.status === 'review');
    for (const task of [first, second, third]) {
      expect(value.task(task.id).queueReason).toBeUndefined();
      expect(value.snapshot().runs.filter((run) => run.taskId === task.id)).toHaveLength(1);
    }
  }, 20000);

  it('keeps incomplete, failed and remote dependencies blocked until they are done', async () => {
    const root = temp(); const value = await service(root);
    const project = value.createProject({ name: 'Blockers', repositoryPath: directory(root, 'blockers') });
    const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] };
    const blocker = value.createTask({ projectId: project.id, title: 'Blocker', provider: 'command', command });
    const dependent = value.createTask({ projectId: project.id, title: 'Dependent', provider: 'command', command, dependsOn: [blocker.id] });
    value.updateTask(blocker.id, { status: 'review' });
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    const run = value.startTask(blocker.id);
    await waitFor(() => value.run(run.id).status, (status) => status === 'completed');
    for (const status of ['backlog', 'ready', 'failed', 'cancelled'] as const) {
      value.updateTask(blocker.id, { status });
      expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    }
    value.updateTask(blocker.id, { status: 'review' });
    value.task(blocker.id).pullRequest = { number: 42 };
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    delete value.task(blocker.id).pullRequest;
    value.task(blocker.id).externalDependency = true;
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    delete value.task(blocker.id).externalDependency;
    value.task(blocker.id).github = { issueNumber: 42 } as Task['github'];
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    delete value.task(blocker.id).github;
    const agent = value.catalog.createAgent({ name: 'Workflow agent', provider: 'command', command });
    const definition = value.workflows.create({ name: 'Unfinished workflow', steps: [{ name: 'Next stage', agentId: agent.id }] });
    for (const status of ['running', 'failed'] as const) {
      value.task(blocker.id).workflowProgress = { definition, stepIndex: 0, status };
      expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    }
    value.task(blocker.id).workflowProgress!.status = 'completed';
    value.run(run.id).status = 'failed';
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    value.run(run.id).status = 'completed';
    // A finished run in Review is not merged into main yet, so the dependent keeps waiting.
    expect(() => value.startTask(dependent.id)).toThrow(/dependencies/);
    value.updateTask(blocker.id, { status: 'done' });
    expect(value.startTask(dependent.id).status).toBe('running');
  });

  it('dispatches ready tasks without autoStart, respects assigned command profiles and exposes actual wait reasons', async () => {
    const root = temp(); const value = await service(root);
    const command = { executable: process.execPath, args: ['-e', 'console.log("working");setInterval(()=>{},1000)'] };
    const frontend = value.catalog.createAgent({ name: 'Frontend', provider: 'command', capabilities: ['frontend'], command });
    const backend = value.catalog.createAgent({ name: 'Backend', provider: 'command', capabilities: ['backend'], command });
    const firstProject = value.createProject({ useWorktree: false, name: 'Front one', repositoryPath: directory(root, 'front-one') });
    const secondProject = value.createProject({ useWorktree: false, name: 'Front two', repositoryPath: directory(root, 'front-two') });
    const backProject = value.createProject({ useWorktree: false, name: 'Back', repositoryPath: directory(root, 'back') });
    const front = value.createTask({ projectId: firstProject.id, title: 'Frontend layout', provider: 'command', agentId: frontend.id, tags: ['frontend'], status: 'ready', autoStart: false });
    await waitFor(() => value.task(front.id), (task) => task.status === 'running');
    expect(value.task(front.id).agentId).toBe(frontend.id);
    const waiting = value.createTask({ projectId: secondProject.id, title: 'Frontend navigation', provider: 'command', agentId: frontend.id, tags: ['frontend'], status: 'ready' });
    const back = value.createTask({ projectId: backProject.id, title: 'Backend API', provider: 'command', agentId: backend.id, tags: ['backend'], status: 'ready' });
    await waitFor(() => value.task(back.id), (task) => task.status === 'running'); expect(value.task(back.id).agentId).toBe(backend.id);
    await waitFor(() => value.task(waiting.id), (task) => !!task.queueReason);
    expect(value.task(waiting.id).queueReason).toContain('busy');
    const workspaceLock = value.createTask({ projectId: firstProject.id, title: 'Same directory', provider: 'command', command, status: 'ready' });
    await waitFor(() => value.task(workspaceLock.id), (task) => !!task.queueReason); expect(value.task(workspaceLock.id).queueReason).toContain('workspace');
    const dependency = value.createTask({ projectId: firstProject.id, title: 'Prerequisite' });
    const blocked = value.createTask({ projectId: firstProject.id, title: 'Depends', dependsOn: [dependency.id], status: 'ready' });
    await waitFor(() => value.task(blocked.id), (task) => !!task.queueReason); expect(value.task(blocked.id).queueReason).toContain('dependencies');
    expect(value.snapshot().agentAvailability?.[frontend.id]?.available).toBe(false);
    expect(() => value.updateTask(front.id, { agentId: backend.id, provider: null, model: null })).toThrow(/run controls/);
    await value.stop(value.task(front.id).currentRunId!);
    // The execution profile stays locked once the task has left backlog and ready.
    expect(() => value.updateTask(front.id, { agentId: null, provider: 'command', command })).toThrow(/backlog or ready/);
    value.updateTask(front.id, { title: 'Edited', description: 'New instructions', priority: 10, tags: [], autoMerge: false, terminalMode: 'stream' });
    expect(value.task(front.id).title).toBe('Edited');
  }, 20000);

  it('runs mandatory ordered named stages, conditionally deploys, freezes workflow order and stops on failure', async () => {
    const root = temp(); const value = await service(root); const workspace = directory(root, 'workflow');
    const script = join(root, 'stage.cjs');
    writeFileSync(script, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const fs=require('node:fs');fs.appendFileSync('stages.txt',process.argv[2]+'\\n');const directory=JSON.parse(fs.readFileSync(process.env.AIWS_AGENT_DIRECTORY_FILE,'utf8'));fs.writeFileSync(process.argv[2]+'-proof.json',JSON.stringify({input,directory}));setTimeout(()=>process.exit(process.argv[2]==='bad'?7:0),process.argv[2]==='front'?350:10)});`);
    const make = (name: string) => value.catalog.createAgent({ name, provider: 'command', capabilities: [name], command: { executable: process.execPath, args: [script, name] } });
    const front = make('front'); const build = make('build'); const deploy = make('deploy'); const bad = make('bad');
    value.catalog.updateAgent(deploy.id, { context: 'PRIVATE-DEPLOY-CONTEXT', instructions: 'PRIVATE-DEPLOY-INSTRUCTIONS' });
    const project = value.createProject({ name: 'Workflow project', repositoryPath: workspace });
    const workflow = value.workflows.create({ name: 'Frontend to delivery', projectId: project.id, trigger: 'always', steps: [
      { name: 'Implement', agentId: front.id, instructions: 'FIRST-STAGE' }, { name: 'Build', agentId: build.id, instructions: 'SECOND-STAGE' }, { name: 'Deploy', agentId: deploy.id, instructions: 'DEPLOY-STAGE', condition: 'deploy_requested' },
    ] });
    const task = value.createTask({ projectId: project.id, title: 'Build without deploy', status: 'ready', terminalMode: 'stream' });
    await waitFor(() => value.task(task.id), (item) => item.status === 'running');
    value.workflows.update(workflow.id, { steps: [{ name: 'Changed configuration', agentId: bad.id }] });
    await waitFor(() => value.task(task.id), (item) => item.status === 'review');
    expect(readFileSync(join(workspace, 'stages.txt'), 'utf8')).toBe('front\nbuild\n');
    const proof = JSON.parse(readFileSync(join(workspace, 'build-proof.json'), 'utf8'));
    expect(proof.input).toContain('SECOND-STAGE'); expect(proof.input).toContain('Configured agent directory'); expect(proof.directory.some((agent: any) => agent.id === deploy.id && agent.capabilities.includes('deploy'))).toBe(true);
    expect(proof.input).not.toContain('PRIVATE-DEPLOY-CONTEXT'); expect(proof.input).not.toContain('PRIVATE-DEPLOY-INSTRUCTIONS'); expect(proof.input).not.toContain('DEPLOY-STAGE');
    expect(value.task(task.id).workflowProgress?.status).toBe('completed');
    value.workflows.update(workflow.id, { steps: workflow.steps });
    const withDeploy = value.createTask({ projectId: project.id, title: 'Build and ship', requestedActions: ['deploy'], status: 'ready', terminalMode: 'stream' });
    await waitFor(() => value.task(withDeploy.id), (item) => item.status === 'review');
    expect(readFileSync(join(workspace, 'stages.txt'), 'utf8')).toBe('front\nbuild\nfront\nbuild\ndeploy\n');
    const runs = value.snapshot().runs.filter((run) => run.taskId === withDeploy.id); expect(runs.map((run) => run.stageIndex)).toEqual([0, 1, 2]);
    value.workflows.update(workflow.id, { steps: [{ name: 'Fails', agentId: bad.id }, { name: 'Must not run', agentId: deploy.id }] });
    const failed = value.createTask({ projectId: project.id, title: 'Failure stops chain', status: 'ready', terminalMode: 'stream' });
    await waitFor(() => value.task(failed.id), (item) => item.status === 'failed');
    expect(value.snapshot().runs.filter((run) => run.taskId === failed.id)).toHaveLength(1); expect(value.task(failed.id).workflowProgress?.status).toBe('failed');
  }, 30000);

  it('persists card conversations and routes user messages to actual provider continuations', async () => {
    const root = temp(); const value = await service(root); const workspace = directory(root, 'messages'); const script = join(root, 'messages.cjs');
    writeFileSync(script, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Agent progress on the card'}}));if(input.includes('USER-FOLLOWUP'))require('node:fs').writeFileSync('received.txt','yes');setTimeout(()=>process.exit(0),400)});`);
    const project = value.createProject({ name: 'Messages', repositoryPath: workspace });
    const task = value.createTask({ projectId: project.id, title: 'Converse', provider: 'command', command: { executable: process.execPath, args: [script] }, terminalMode: 'stream' });
    const run = value.startTask(task.id);
    await waitFor(() => value.snapshot().messages, (messages) => messages.some((message) => message.taskId === task.id && message.authorType === 'agent'));
    value.postMessage(task.id, { text: 'USER-FOLLOWUP', authorType: 'user' });
    await waitFor(() => value.run(run.id), (item) => item.status === 'completed'); expect(readFileSync(join(workspace, 'received.txt'), 'utf8')).toBe('yes');
    expect(value.run(run.id).activeMs).toBeGreaterThan(0); expect(value.run(run.id).lastActivityAt).toBeTruthy();
    const messages = value.snapshot().messages.filter((message) => message.taskId === task.id); expect(messages.some((message) => message.authorType === 'user')).toBe(true);
    expect(messages.some((message) => message.authorType === 'system')).toBe(true);
  }, 20000);

  it('activates a configured delivery workflow when the working agent records semantic deployment intent', async () => {
    const root = temp(); const value = await service(root); const workspace = directory(root, 'delivery'); const script = join(root, 'delivery.cjs');
    writeFileSync(script, `process.stdin.resume();require('node:fs').appendFileSync('delivery.txt',process.argv[2]+'\\n');console.log('stage-started');setTimeout(()=>process.exit(0),process.argv[2]==='front'?500:10);`);
    const front = value.catalog.createAgent({ name: 'Implementer', provider: 'command', command: { executable: process.execPath, args: [script, 'front'] } });
    const deploy = value.catalog.createAgent({ name: 'Configured delivery', provider: 'command', command: { executable: process.execPath, args: [script, 'deploy'] } });
    const project = value.createProject({ name: 'Delivery', repositoryPath: workspace });
    value.workflows.create({ name: 'Requested delivery', trigger: 'requested', projectId: project.id, steps: [{ name: 'Implement', agentId: front.id }, { name: 'Configured deployment', agentId: deploy.id, condition: 'deploy_requested' }] });
    const task = value.createTask({ projectId: project.id, title: 'Implement and send to the server', agentId: front.id, terminalMode: 'stream' });
    const run = value.startTask(task.id);
    await waitFor(() => value.snapshot().events, (events) => events.some((event) => event.runId === run.id && event.message.includes('stage-started')));
    value.updateTask(task.id, { requestedActions: ['deploy'] });
    await waitFor(() => value.task(task.id), (item) => item.status === 'review');
    expect(readFileSync(join(workspace, 'delivery.txt'), 'utf8')).toBe('front\ndeploy\n');
    expect(value.task(task.id).workflowProgress?.status).toBe('completed');
  }, 20000);

  it.each([false, true])('skips GitHub merge for a local task without a PR or issue (linked project: %s)', async (linked) => {
    const root = temp(); const value = await service(root);
    const project = value.createProject({ name: 'Local completion', repositoryPath: directory(root, 'local'), autoMerge: true,
      ...(linked ? { github: { repository: 'example/repo', owner: 'example', number: 1 } } : {}) });
    value.updateSettings({ autoSyncSeconds: 0 });
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockRejectedValue(new Error('No verified task pull request is available.'));
    const task = value.createTask({ projectId: project.id, title: 'Local task', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    const run = value.startTask(task.id);
    await waitFor(() => value.run(run.id), item => item.status === 'completed');
    expect(value.task(task.id).status).toBe('done');
    for (let i = 0; i < 3; i++) { (value as any).delivery.lastMerge.clear(); (value as any).tick(); }
    expect(merge).not.toHaveBeenCalled();
    expect(value.task(task.id).pullRequest).toBeUndefined();
    expect(value.snapshot().events.filter(event => event.taskId === task.id && event.type === 'github.merge.error')).toEqual([]);
    expect(value.snapshot().events.filter(event => event.taskId === task.id && event.type === 'merge.skipped')).toHaveLength(1);
    // Adding an explicit PR later makes the completed task eligible on the next poll.
    merge.mockResolvedValue({ number: 42, url: 'https://github.com/example/repo/pull/42', headSha: 'a'.repeat(40), merged: true, message: 'Merged' });
    value.updateTask(task.id, { pullRequest: { number: 42 } });
    (value as any).tick();
    await waitFor(() => value.task(task.id), item => item.pullRequest?.merged === true);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('holds auto-merge tasks pending and fails when merged main cannot be verified', async () => {
    const root = temp(); const value = await service(root); const workspace = directory(root, 'merge');
    const project = value.createProject({ name: 'Merge', repositoryPath: workspace, autoMerge: true });
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number: 42, url: 'https://github.com/example/repo/pull/42', headSha: 'a'.repeat(40), merged: false, message: 'Checks pending' });
    const create = (): Task => value.createTask({ projectId: project.id, title: 'Merge candidate', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, pullRequest: { number: 42 } });
    const task = create(); const run = value.startTask(task.id); await waitFor(() => value.run(run.id), (item) => item.status === 'completed');
    await waitFor(() => value.task(task.id), (item) => !!item.pullRequest?.mergeStatus); expect(value.task(task.id).status).toBe('completing');
    expect(value.task(task.id).pullRequest?.merged).toBe(false);
    value.updateSettings({ maxConcurrent: 1 });
    const next = create();
    expect(() => value.startTask(next.id)).toThrow(/slots/);
    expect(value.updateTask(task.id, { status: 'done' }).status).toBe('completing');
    merge.mockResolvedValueOnce({ number: 42, url: 'https://github.com/example/repo/pull/42', headSha: 'a'.repeat(40), merged: true, message: 'Merged by GitHub' });
    (value as any).delivery.lastMerge.clear(); (value as any).tick();
    await waitFor(() => value.task(task.id), (item) => item.pullRequest?.merged === true);
    await waitFor(() => value.task(task.id).status, status => status === 'failed');
    const calls = merge.mock.calls.length;
    (value as any).delivery.lastMerge.clear(); (value as any).tick();
    expect(merge).toHaveBeenCalledTimes(calls);
  });

  it.each([
    [false, true, 'done'], [true, null, 'done'], [true, false, 'review'], [false, null, 'review'],
  ] as const)('uses project autoMerge=%s and task autoMerge=%s on explicit completion', async (projectAutoMerge, autoMerge, status) => {
    const root = temp(); const value = await service(root);
    const project = value.createProject({ name: 'Completion', repositoryPath: directory(root, 'completion'), autoMerge: projectAutoMerge });
    vi.spyOn((value as any).launcher, 'launch').mockImplementation(() => {});
    vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockRejectedValue(new Error('No GitHub remote'));
    const task = value.createTask({ projectId: project.id, title: 'Complete', autoMerge });
    const run = value.startTask(task.id);
    const observed: string[] = [];
    value.on('change', () => observed.push(value.task(task.id).status));
    value.complete(run.id, { summary: 'Verified' });
    expect(value.task(task.id).status).toBe(status);
    if (status === 'done') expect(observed).not.toContain('review');
    await Promise.resolve();
    expect(value.task(task.id).status).toBe(status);
  });

  it('finishes all workflow stages before completing an auto-merge task', async () => {
    const root = temp(); const value = await service(root);
    const project = value.createProject({ name: 'Workflow', repositoryPath: directory(root, 'auto-workflow'), autoMerge: true });
    const agent = value.catalog.createAgent({ name: 'Worker', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    const workflow = value.workflows.create({ name: 'Two stages', steps: [{ name: 'First', agentId: agent.id }, { name: 'Last', agentId: agent.id }] });
    vi.spyOn((value as any).launcher, 'launch').mockImplementation(() => {});
    const merge = vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number: 42, merged: false, message: 'Pending' });
    const task = value.createTask({ projectId: project.id, title: 'Workflow completion', workflowId: workflow.id, pullRequest: { number: 42 } });
    const first = value.startTask(task.id);
    const observed: string[] = [];
    value.on('change', () => observed.push(value.task(task.id).status));
    value.complete(first.id, {});
    expect(value.task(task.id).status).toBe('ready');
    expect(observed).not.toContain('done'); expect(merge).not.toHaveBeenCalled();
    const last = value.startTask(task.id); value.complete(last.id, {});
    expect(value.task(task.id).status).toBe('completing');
    expect(value.task(task.id).workflowProgress?.status).toBe('completed');
    expect(observed).not.toContain('review'); expect(merge).toHaveBeenCalledTimes(1);
  });

  it('exposes a true PTY with ANSI output, keyboard input, resize and explicit task completion', async () => {
    const root = temp(); const workspace = directory(root, 'terminal');
    const server = await startControlServer({ port: 0, token: 'terminal-test-token', dataDir: join(root, 'data') }); servers.push(server);
    const script = join(root, 'terminal.cjs');
    writeFileSync(script, `const fs=require('node:fs');process.stdin.setRawMode(true);process.stdout.write('\\x1b[32mPTY-READY\\x1b[0m\\r\\n');process.stdin.on('data',async data=>{fs.writeFileSync('terminal-proof.json',JSON.stringify({tty:process.stdin.isTTY,outputTTY:process.stdout.isTTY,input:data.toString(),cols:process.stdout.columns,rows:process.stdout.rows}));process.stdout.write('KEY:'+data.toString()+'\\r\\n');if(data.toString()==='b')process.stdout.write('B'.repeat(200000));if(data.toString().includes('q')){await fetch(process.env.AIWS_CONTROL_URL+'/api/runs/'+process.env.AIWS_RUN_ID+'/complete',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AIWS_CONTROL_TOKEN},body:JSON.stringify({summary:'Verified native terminal completion'})})}});setInterval(()=>{},1000);`);
    const project = server.service.createProject({ name: 'Terminal', repositoryPath: workspace });
    const task = server.service.createTask({ projectId: project.id, title: 'Actual terminal', provider: 'command', command: { executable: process.execPath, args: [script] }, terminalMode: 'pty' });
    const run = server.service.startTask(task.id);
    await waitFor(() => server.service.terminal(run.id), (item) => item.output.includes('PTY-READY'), 20000);
    server.service.resize(run.id, { cols: 120, rows: 40 }); server.service.input(run.id, { data: 'x' });
    await waitFor(() => server.service.terminal(run.id), (item) => item.output.includes('KEY:x'));
    const proof = JSON.parse(readFileSync(join(workspace, 'terminal-proof.json'), 'utf8'));
    expect(proof.tty).toBe(true); expect(proof.outputTTY).toBe(true); expect(proof.input).toBe('x'); expect(proof.cols).toBe(120); expect(proof.rows).toBe(40);
    expect(server.service.terminal(run.id).output).toContain('\u001b[');
    expect(server.service.run(run.id).status).toBe('running'); // Silence/native TUI remaining open is never success.
    let fullSnapshots = 0; let update: any;
    server.service.on('change', () => { fullSnapshots++; }); server.service.on('update', (value) => { update = value; });
    server.service.input(run.id, { data: 'b' });
    await waitFor(() => server.service.terminal(run.id).output, (output) => output.length > 100000);
    await waitFor(() => update, (value) => !!value);
    expect(fullSnapshots).toBe(0); expect(JSON.stringify(update).length).toBeLessThan(3000);
    expect(update.runs[0]).not.toHaveProperty('terminalOutput'); expect(update.runs[0]).not.toHaveProperty('executionSnapshot');
    expect(update.events.some((event: any) => event.type === 'terminal.output')).toBe(false);
    server.service.input(run.id, { data: 'q' }); await waitFor(() => server.service.run(run.id), (item) => item.status === 'completed');
    expect(server.service.task(task.id).status).toBe('review');
  }, 30000);
});
