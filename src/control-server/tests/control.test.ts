import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ControlService } from '../service.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import { ControlStore } from '../store.js';
import type { ControlState, Run } from '../types.js';
import { superviseProcess } from '../runner.js';
import { ControlGitHub } from '../github.js';
import { RESTART_CONTINUE_MESSAGE } from '../service/run-prompt.js';
import { RunLauncher } from '../service/run-launcher.js';

const roots: string[] = []; const services: ControlService[] = []; const servers: RunningControlServer[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-control-test-')); roots.push(root); return root; }
function workspace(root: string, name = 'workspace'): string { const path = join(root, name); mkdirSync(path); return path; }
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error('Timed out waiting for control state');
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('local control center', () => {
  it('removes deleted tasks from dependent tasks and persists the remaining dependencies', async () => {
    const root = temp(); const dataDir = join(root, 'data');
    const service = await ControlService.open({ dataDir }); services.push(service);
    const project = service.createProject({ name: 'Dependencies', repositoryPath: workspace(root) });
    const deleted = service.createTask({ projectId: project.id, title: 'Delete me' });
    const retained = service.createTask({ projectId: project.id, title: 'Keep me' });
    const first = service.createTask({ projectId: project.id, title: 'First', dependsOn: [deleted.id, retained.id] });
    const second = service.createTask({ projectId: project.id, title: 'Second', dependsOn: [deleted.id] });
    service.deleteTask(deleted.id);
    expect(() => service.task(deleted.id)).toThrow();
    expect(service.task(first.id).dependsOn).toEqual([retained.id]);
    expect(service.task(second.id).dependsOn).toEqual([]);
    await service.close(); services.splice(services.indexOf(service), 1);
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.task(first.id).dependsOn).toEqual([retained.id]);
    expect(restored.task(second.id).dependsOn).toEqual([]);
    expect(restored.snapshot().tasks.some((task) => task.id === deleted.id)).toBe(false);
  });

  it('attaches project files dropped on a card and hands them to the agent as context', async () => {
    const root = temp();
    const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const service = server.service;
    const project = service.createProject({ name: 'Files', repositoryPath: workspace(root) });
    const task = service.createTask({ projectId: project.id, title: 'Use files', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    const patch = (body: unknown) => fetch(`${server.url}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch({ attachedFiles: ['src/app.js', 'docs/', 'src/app.js'] })).status).toBe(200);
    expect(service.task(task.id).attachedFiles).toEqual(['src/app.js', 'docs/']);
    for (const path of ['../secret.txt', '/etc/passwd', 'C:/Windows', 'a\\b', 'a//b', '']) expect((await patch({ attachedFiles: [path] })).status, path).toBe(400);
    service.updateTask(task.id, { title: 'Renamed' });
    expect(service.task(task.id).attachedFiles).toEqual(['src/app.js', 'docs/']);
    const run = service.startTask(task.id);
    expect(service.run(run.id).executionSnapshot?.context).toContain('Files attached to this task (paths relative to the project root):\n- src/app.js\n- docs/');
    await waitFor(() => service.run(run.id).status, (status) => status === 'completed');
    service.updateTask(task.id, { attachedFiles: [] });
    expect(service.task(task.id).attachedFiles).toBeUndefined();
  });
  it('archives atomically through the API, persists status, and keeps archived ready tasks out of the queue', async () => {
    const root=temp();const dataDir=join(root,'data');
    const server=await startControlServer({host:'127.0.0.1',port:0,dataDir});servers.push(server);
    const service=server.service;service.updateSettings({systemEnabled:false});
    const project=service.createProject({name:'Archive',repositoryPath:workspace(root)});
    const done=service.createTask({projectId:project.id,title:'Done',status:'done'});
    const ready=service.createTask({projectId:project.id,title:'Ready',status:'ready'});
    const request=(body:unknown)=>fetch(`${server.url}/api/tasks/archive`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    expect((await request({taskIds:[done.id,'missing'],archived:true})).status).toBe(404);
    expect(service.task(done.id).archivedAt).toBeUndefined();
    expect((await request({taskIds:[done.id],archived:'true'})).status).toBe(400);
    expect((await request({taskIds:[done.id,ready.id,done.id],archived:true})).status).toBe(200);
    expect(service.task(done.id).status).toBe('done');expect(service.task(ready.id).status).toBe('ready');
    const timestamp=service.task(done.id).archivedAt;expect(timestamp).toBeTruthy();
    service.updateTask(done.id,{title:'Still done'});expect(service.task(done.id).archivedAt).toBe(timestamp);
    service.updateSettings({systemEnabled:true});
    const start=vi.spyOn(service,'startTask');(service as any).tick();expect(start).not.toHaveBeenCalled();
    expect(()=>service.startTask(ready.id)).toThrow(/archived/);
    await service.store.flush(); const saved=service.store.readPersisted();
    expect(saved.tasks.find((task: {id:string})=>task.id===done.id)).toMatchObject({archivedAt:timestamp,status:'done'});
    expect((await request({taskIds:[ready.id],archived:false})).status).toBe(200);
    expect(service.task(ready.id).archivedAt).toBeUndefined();expect(service.task(ready.id).status).toBe('ready');
    service.updateSettings({systemEnabled:false});
  });
  it('restarts failed tasks through the API, preserves old runs and rejects duplicate restarts', async () => {
    const root = temp();
    const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const service = server.service;
    const project = service.createProject({ name: 'Retry', repositoryPath: workspace(root) });
    // The command is locked once the task leaves ready, so it fails on the first run and keeps running on the retry.
    const task = service.createTask({ projectId: project.id, title: 'Retry failure', provider: 'command', command: { executable: process.execPath, args: ['-e', "const fs=require('node:fs');if(!fs.existsSync('ran')){fs.writeFileSync('ran','');process.exit(7)}setInterval(()=>{},1000)"] } });
    const original = service.startTask(task.id);
    await waitFor(() => service.run(original.id).status, status => status === 'failed');
    const saved = structuredClone(service.run(original.id));
    const response = await fetch(`${server.url}/api/tasks/${task.id}/restart`, { method: 'POST' });
    expect(response.status).toBe(201);
    const restarted = await response.json() as Run;
    expect(restarted.id).not.toBe(original.id);
    expect(service.task(task.id).currentRunId).toBe(restarted.id);
    expect(service.run(original.id)).toEqual(saved);
    expect((await fetch(`${server.url}/api/tasks/${task.id}/restart`, { method: 'POST' })).status).toBe(409);
    await service.stop(restarted.id);
  });

  it.each(['failed', 'interrupted', 'cancelled'] as const)('explicitly restarts %s Codex runs without a saved provider session', async status => {
    const root = temp(); const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
    const project = service.createProject({ name: 'Provider retry', repositoryPath: workspace(root) });
    const task = service.createTask({ projectId: project.id, title: 'Terminal failed', provider: 'codex', terminalMode: 'pty' });
    const previous: Run = { id: 'run_previous', taskId: task.id, provider: 'codex', status, executionMode: 'native', terminalMode: 'pty', terminalOutput: 'Terminal startup failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 1, pendingCommands: [], continuation: 0 };
    service.store.state.runs.push(previous); service.task(task.id).currentRunId = previous.id; service.task(task.id).status = 'failed';
    vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    expect(() => service.startTask(task.id)).toThrow(/original provider session/);
    const restarted = service.restartTask(task.id);
    expect(restarted).toMatchObject({ provider: 'codex', status: 'running', terminalMode: 'pty' });
    expect(restarted.id).not.toBe(previous.id);
    expect(service.run(previous.id).terminalOutput).toBe('Terminal startup failed');
    expect(() => service.restartTask(task.id)).toThrow(/Only failed/);
  });

  it('retries the failed workflow stage and restores its state when restart is blocked', async () => {
    const root = temp(); const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
    const project = service.createProject({ name: 'Workflow retry', repositoryPath: workspace(root) });
    const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] };
    const agent = service.catalog.createAgent({ name: 'Worker', provider: 'command', command });
    const workflow = service.workflows.create({ name: 'Stages', steps: [{ name: 'First', agentId: agent.id }, { name: 'Second', agentId: agent.id }] });
    const task = service.createTask({ projectId: project.id, title: 'Retry second stage', provider: 'command', command });
    const previous: Run = { id: 'run_stage', taskId: task.id, provider: 'command', status: 'failed', executionMode: 'native', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 1, pendingCommands: [], continuation: 0, workflowId: workflow.id, stageIndex: 1 };
    service.store.state.runs.push(previous);
    const current = service.task(task.id); current.currentRunId = previous.id; current.status = 'failed';
    current.workflowProgress = { definition: workflow, stepIndex: 1, status: 'failed' };
    const dependency = service.createTask({ projectId: project.id, title: 'Blocked dependency' }); current.dependsOn = [dependency.id];
    const before = structuredClone(current);
    expect(() => service.restartTask(task.id)).toThrow(/dependencies/);
    expect(current).toEqual(before); expect(service.snapshot().runs).toHaveLength(1);
    current.dependsOn = [];
    vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    expect(service.restartTask(task.id)).toMatchObject({ stageIndex: 1, workflowId: workflow.id });
    expect(current.workflowProgress?.status).toBe('running');
  });

  it('persists projects/tasks, validates dependencies and excludes a second service owner', async () => {
    const root = temp(); const dataDir = join(root, 'data'); const path = workspace(root);
    const service = await ControlService.open({ dataDir }); services.push(service);
    const project = service.createProject({ name: 'Local', repositoryPath: path });
    const first = service.createTask({ projectId: project.id, title: 'First' });
    const second = service.createTask({ projectId: project.id, title: 'Second', dependsOn: [first.id] });
    expect(() => service.updateTask(first.id, { dependsOn: [second.id] })).toThrow(/cycle/);
    expect(() => service.startTask(second.id)).toThrow(/dependencies/);
    expect(() => service.createProject({ name: 'Bad path', repositoryPath: '../relative' })).toThrow(/absolute/);
    expect(() => new ControlStore(dataDir)).toThrow(/already in use/);
    service.updateTask(first.id, { status: 'done' });
    await service.close(); services.splice(services.indexOf(service), 1);
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.snapshot().tasks).toHaveLength(2);
    expect(restored.task(first.id).status).toBe('done');
    expect(restored.project(project.id).github).toBeNull();
  });

  it('resumes a task interrupted by a restart in its provider session and tells the agent what happened', async () => {
    const root = temp(); const dataDir = join(root, 'data'); const path = workspace(root);
    const service = await ControlService.open({ dataDir });
    const project = service.createProject({ name: 'Restart', repositoryPath: path });
    const task = service.createTask({ projectId: project.id, title: 'Interrupted', provider: 'claude', terminalMode: 'pty' });
    const sessionId = '0c6a5f4e-1b2d-4c3e-9f8a-7b6c5d4e3f21', at = new Date().toISOString();
    const run: Run = { id: 'run_interrupted', taskId: task.id, status: 'running', provider: 'claude', sessionId, executionMode: 'native', terminalMode: 'pty', startedAt: at, finishedAt: null, exitCode: null, pendingCommands: [], continuation: 0 };
    service.store.state.runs.push(run); Object.assign(service.task(task.id), { status: 'running', currentRunId: run.id, sessions: [{ runId: run.id, provider: 'claude', sessionId, agentId: null, agentName: 'Claude', source: 'agent', recordedAt: at }] }); service.store.save();
    service.store.close();
    // The provider process itself is not started here; what matters is the run it would start with.
    const launched: Run[] = []; vi.spyOn(RunLauncher.prototype, 'launch').mockImplementation((item: Run) => { launched.push(item); });
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.run(run.id).status).toBe('interrupted');
    const resumed = await waitFor(() => restored.task(task.id), (item) => item.status === 'running' && item.currentRunId !== run.id);
    // The agent continues the same conversation with the restart notice as its instruction, which the chat shows as a system message.
    expect(restored.run(resumed.currentRunId!)).toMatchObject({ status: 'running', sessionId, terminalMode: 'pty', historyResume: { provider: 'claude', sessionId, initialMessage: RESTART_CONTINUE_MESSAGE } });
    expect(launched.map((item) => item.id)).toEqual([resumed.currentRunId]);
    expect(restored.snapshot().messages.filter((message) => message.taskId === task.id)).toMatchObject([{ authorType: 'system', text: RESTART_CONTINUE_MESSAGE }]);
    expect(restored.snapshot().events.filter((event) => event.taskId === task.id).map((event) => event.type)).toEqual(['interrupted', 'started']);
    await service.close();
  });

  it('leaves an interrupted run without a provider session for the user to restart', async () => {
    const root = temp(); const dataDir = join(root, 'data'); const path = workspace(root);
    const service = await ControlService.open({ dataDir });
    const project = service.createProject({ name: 'Restart', repositoryPath: path });
    const task = service.createTask({ projectId: project.id, title: 'Interrupted' });
    const run: Run = { id: 'run_interrupted', taskId: task.id, status: 'running', provider: 'codex', executionMode: 'native', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, pendingCommands: [], continuation: 0 };
    service.store.state.runs.push(run); service.task(task.id).status = 'running'; service.task(task.id).currentRunId = run.id; service.store.save();
    // Emulate a dead service lock release without its normal graceful shutdown path.
    service.store.close();
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.run(run.id).status).toBe('interrupted'); expect(restored.task(task.id).status).toBe('failed');
    expect(restored.snapshot().events.some((event) => event.type === 'interrupted')).toBe(true);
    await service.close();
  });

  it('authenticates HTTP and SSE, enforces origin rules and publishes persistent state changes', async () => {
    const root = temp(); const path = workspace(root);
    const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), token: 'test-control-secret' }); servers.push(server);
    expect((await fetch(`${server.url}/api/state`)).status).toBe(401);
    const headers = { Authorization: 'Bearer test-control-secret', 'Content-Type': 'application/json' };
    expect((await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    const controller = new AbortController();
    const stream = await fetch(`${server.url}/api/events`, { headers, signal: controller.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"state"');
    const response = await fetch(`${server.url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'API project', repositoryPath: path }) });
    expect(response.status).toBe(201);
    const update = new TextDecoder().decode((await reader.read()).value); expect(update).toContain('API project');
    controller.abort(); await reader.cancel().catch(() => {});
    expect((await fetch(`${server.url}/api/settings`, { method: 'PATCH', headers, body: '{"maxConcurrent":0}' })).status).toBe(400);
    expect((await fetch(`${server.url}/api/state`, { headers }).then((result) => result.json()) as ControlState).projects).toHaveLength(1);
  });

  it('streams real child output, applies queued instructions automatically, and reports failures', async () => {
    const root = temp(); const path = workspace(root); const script = join(path, 'worker.cjs');
    writeFileSync(script, `const fs=require('node:fs'); const p='count'; const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0; fs.writeFileSync(p,String(n+1)); let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{console.log('turn-'+n);if(n)console.log(input.includes('ADD SECOND RESULT')?'instruction-delivered':'missing');setTimeout(()=>process.exit(0),n?20:600)});`);
    const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
    const project = service.createProject({ name: 'Runtime', repositoryPath: path });
    const task = service.createTask({ projectId: project.id, title: 'Run command', provider: 'command', command: { executable: process.execPath, args: [script] }, terminalMode: 'stream' });
    const run = service.startTask(task.id);
    await waitFor(() => service.snapshot().events, (events) => events.some((event) => event.runId === run.id && event.message.includes('turn-0')));
    service.command(run.id, { message: 'ADD SECOND RESULT' });
    await waitFor(() => service.run(run.id), (value) => value.status === 'completed');
    expect(service.task(task.id).status).toBe('review');
    expect(service.run(run.id).continuation).toBe(1);
    expect(service.snapshot().events.some((event) => event.runId === run.id && event.message.includes('instruction-delivered'))).toBe(true);
    const failed = service.createTask({ projectId: project.id, title: 'Fails', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.error("expected failure");process.exit(7)'] }, terminalMode: 'stream' });
    const failedRun = service.startTask(failed.id);
    await waitFor(() => service.run(failedRun.id), (value) => value.status === 'failed');
    expect(service.run(failedRun.id).exitCode).toBe(7);
  }, 30_000);

  it('routes questions and answers to the requesting live child without releasing another run', async () => {
    const root = temp();
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'child-test-token' }); servers.push(server);
    const script = join(root, 'ask.cjs');
    writeFileSync(script, `(async()=>{const base=process.env.AIWS_CONTROL_URL;const headers={'Authorization':'Bearer '+process.env.AIWS_CONTROL_TOKEN,'Content-Type':'application/json'};const q=await fetch(base+'/api/runs/'+process.env.AIWS_RUN_ID+'/questions',{method:'POST',headers,body:JSON.stringify({text:'Choose a value'})}).then(r=>r.json());console.log('question-created');for(;;){const current=await fetch(base+'/api/questions/'+q.id,{headers}).then(r=>r.json());if(current.status==='answered'){console.log('received:'+current.answer);break}await new Promise(r=>setTimeout(r,50))}})().catch(e=>{console.error(e);process.exit(1)});`);
    const create = (name: string): Run => {
      const project = server.service.createProject({ name, repositoryPath: workspace(root, name) });
      const task = server.service.createTask({ projectId: project.id, title: name, provider: 'command', command: { executable: process.execPath, args: [script] }, terminalMode: 'stream' });
      return server.service.startTask(task.id);
    };
    const first = create('one'); const second = create('two');
    await waitFor(() => server.service.snapshot().questions, (questions) => questions.length === 2);
    const question = server.service.snapshot().questions.find((item) => item.runId === first.id)!;
    server.service.answer(question.id, { answer: 'approved-one' });
    await waitFor(() => server.service.run(first.id), (run) => run.status === 'completed');
    expect(server.service.run(second.id).status).toBe('waiting');
    expect(server.service.snapshot().events.some((event) => event.runId === first.id && event.message.includes('received:approved-one'))).toBe(true);
    await server.service.stop(second.id); expect(server.service.run(second.id).status).toBe('cancelled');
  }, 30_000);

  it('pauses, resumes and stops a real process tree with explicit platform semantics', async () => {
    const root = temp(); const path = workspace(root);
    const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
    const project = service.createProject({ name: 'Controls', repositoryPath: path });
    const task = service.createTask({ projectId: project.id, title: 'Long task', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.log("ready");setInterval(()=>console.log("tick"),150)'] }, terminalMode: 'stream' });
    const run = service.startTask(task.id);
    await waitFor(() => service.snapshot().events, (events) => events.some((event) => event.runId === run.id && event.message.includes('ready')));
    expect((await service.pause(run.id)).status).toBe('paused');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await service.resume(run.id); expect(service.run(run.id).status).toBe('running');
    await service.stop(run.id); expect(service.run(run.id).status).toBe('cancelled');
    expect(service.snapshot().events.some((event) => event.type === 'paused' && event.message.includes(process.platform === 'win32' ? 'checkpoint' : 'suspended'))).toBe(true);
  }, 30_000);

  it('cleans up a provider process when its service IPC connection disappears', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore' });
    const watcher = superviseProcess(child.pid!);
    try {
      // IPC disconnect is the signal Node delivers when the owning service crashes.
      watcher.disconnect();
      await waitFor(() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } }, Boolean, 10_000);
    } finally { child.kill('SIGKILL'); watcher.kill(); }
  }, 15_000);

  it('deletes the linked GitHub issue with the task only when asked, and keeps the task when GitHub refuses', async () => {
    const root = temp();
    const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
    service.updateSettings({ autoSyncSeconds: 0 });
    const project = service.createProject({ name: 'Connected', repositoryPath: workspace(root), github: { repository: 'owner/repo', owner: 'owner', number: 1 } });
    const local = service.createTask({ projectId: project.id, title: 'Local only' });
    await expect(service.deleteTaskWithIssue(local.id)).rejects.toThrow('not linked');
    const task = service.createTask({ projectId: project.id, title: 'Remote issue' });
    service.task(task.id).github = { issueNumber: 42, issueId: 'I_42' };
    const remove = vi.spyOn(ControlGitHub.prototype, 'deleteIssue').mockRejectedValueOnce(new Error('GitHub: must have admin rights')).mockResolvedValueOnce();
    await expect(service.deleteTaskWithIssue(task.id)).rejects.toThrow('admin rights');
    expect(service.task(task.id).title).toBe('Remote issue');
    await service.deleteTaskWithIssue(task.id);
    expect(remove.mock.calls[1]?.[1]).toMatchObject({ issueNumber: 42, issueId: 'I_42' });
    expect(service.snapshot().tasks.map((item) => item.id)).toEqual([local.id]);
    remove.mockRestore();
  });

  it('keeps deleted GitHub tasks hidden across sync and restart without deleting remote issues', async () => {
    const root = temp(); const dataDir = join(root, 'data');
    const service = await ControlService.open({ dataDir }); services.push(service);
    service.updateSettings({ autoSyncSeconds: 0 });
    const project = service.createProject({ name: 'Connected', repositoryPath: workspace(root), github: { repository: 'owner/repo', owner: 'owner', number: 1 } });
    const task = service.createTask({ projectId: project.id, title: 'Remote issue' });
    service.task(task.id).github = { issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' };
    const remote = structuredClone(service.task(task.id));
    service.deleteTask(task.id);
    const sync = vi.spyOn(ControlGitHub.prototype, 'sync').mockResolvedValue({ project, tasks: [remote] });
    await service.sync(project.id); expect(service.snapshot().tasks).toHaveLength(0);
    expect(sync.mock.calls[0]?.[1]).toHaveLength(0);
    await service.close(); services.splice(services.indexOf(service), 1);
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    await restored.sync(project.id); expect(restored.snapshot().tasks).toHaveLength(0);
    restored.updateProject(project.id, { github: null });
    expect(restored.snapshot().ignoredGitHubIssues?.[project.id]).toBeUndefined();
  });
});
