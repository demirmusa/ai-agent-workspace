import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { startControlServer, type RunningControlServer } from '../server.js';
import { ControlGitHub } from '../github.js';
import { TASK_PRIORITY, type Task } from '../types.js';

const servers: RunningControlServer[] = []; const roots: string[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-intake-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'intake-test-token' }); servers.push(server); server.service.updateSettings({ autoSyncSeconds: 0 });
  const project = server.service.createProject({ name: 'Intake', repositoryPath: workspace });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}/api/${path}`, { method, headers: { authorization: 'Bearer intake-test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, workspace, server, project, request };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

describe('task intake, dependency search and deletion', () => {
  it('searches by issue number, local ID prefix and title with project scope, exclusion and bounded pages', async () => {
    const { server, project, request, root } = await setup(); const service = server.service;
    const first = service.createTask({ projectId: project.id, title: 'Alpha first', priority: -22 });
    const second = service.createTask({ projectId: project.id, title: 'Alpha second', priority: 120 });
    const third = service.createTask({ projectId: project.id, title: 'Alpha third' }); service.task(first.id).github = { issueNumber: 42 };
    const otherProject = service.createProject({ name: 'Other', repositoryPath: root }); const other = service.createTask({ projectId: otherProject.id, title: 'Alpha elsewhere' }); service.task(other.id).github = { issueNumber: 42 };
    const issue = await request(`tasks/search?projectId=${project.id}&q=%2342`).then((response) => response.json());
    expect(issue.items.map((item: any) => item.id)).toEqual([first.id]); expect(issue.items[0].code).toBe('#42');
    const prefix = await request(`tasks/search?projectId=${project.id}&q=${second.id.slice(0, 22)}`).then((response) => response.json()); expect(prefix.items[0].id).toBe(second.id); expect(prefix.items[0].reference).toBe(second.id);
    const shortKey = second.id.replace(/^[a-z]+_/, '').slice(0, 6).toUpperCase();
    for (const q of [shortKey, `AIWS-${shortKey}`, shortKey.toLowerCase()]) expect((await request(`tasks/search?projectId=${project.id}&q=${q}`).then((response) => response.json())).items.map((item: { id: string }) => item.id)).toContain(second.id);
    const page = await request(`tasks/search?projectId=${project.id}&q=Alpha&limit=1&excludeTaskId=${first.id}`).then((response) => response.json()); expect(page.items).toHaveLength(1); expect(page.nextCursor).toBe('1');
    const next = await request(`tasks/search?projectId=${project.id}&q=Alpha&limit=1&excludeTaskId=${first.id}&cursor=${page.nextCursor}`).then((response) => response.json()); expect(next.items[0].id).not.toBe(page.items[0].id); expect(new Set([next.items[0].id, page.items[0].id])).toEqual(new Set([second.id, third.id]));
    expect((await request(`tasks/search?projectId=${project.id}&q=Alpha&limit=100`)).status).toBe(400);
    expect((await request(`tasks/search?projectId=${project.id}&q=`).then((response) => response.json())).items).toEqual([]);
    expect((await fetch(`${server.url}/api/tasks/search?projectId=${project.id}&q=Alpha`)).status).toBe(401);
    const done = service.createTask({ projectId: project.id, title: 'Alpha done' }); service.task(done.id).status = 'done';
    const cancelled = service.createTask({ projectId: project.id, title: 'Alpha cancelled' }); service.task(cancelled.id).status = 'cancelled';
    const archived = service.createTask({ projectId: project.id, title: 'Alpha archived' }); service.task(archived.id).archivedAt = new Date().toISOString();
    const active = await request(`tasks/search?projectId=${project.id}&q=Alpha`).then((response) => response.json());
    expect(new Set(active.items.map((item: any) => item.id))).toEqual(new Set([first.id, second.id, third.id]));
    service.task(first.id).status = 'done'; expect((await request(`tasks/search?projectId=${project.id}&q=%2342`).then((response) => response.json())).items).toEqual([]); service.task(first.id).status = 'backlog';
    expect(TASK_PRIORITY).toEqual({ high: 3, medium: 2, low: 1 }); expect(service.task(first.id).priority).toBe(-22); expect(service.task(second.id).priority).toBe(120);
  });

  it('normalizes selected references, rejects ambiguous/self/cyclic blockers and drops a deleted blocker from its dependents', async () => {
    const { server, project, request } = await setup(); const service = server.service;
    const first = service.createTask({ projectId: project.id, title: 'Parent' }); service.createTask({ projectId: project.id, title: 'Another' });
    expect((await request('tasks', 'POST', { projectId: project.id, title: 'Ambiguous', dependencyRefs: ['task_'] })).status).toBe(400);
    expect((await request(`tasks/${first.id}`, 'PATCH', { dependencyRefs: [first.id] })).status).toBe(400);
    const child = await request('tasks', 'POST', { projectId: project.id, title: 'Child', dependencyRefs: [first.id], priority: 3 }).then((response) => response.json()) as Task;
    expect(child.dependsOn).toEqual([first.id]);
    expect((await request(`tasks/${first.id}`, 'PATCH', { dependencyRefs: [child.id] })).status).toBe(400);
    expect((await request(`tasks/${first.id}`, 'DELETE')).status).toBe(200); expect(service.task(child.id).dependsOn).toEqual([]);
    expect((await request(`tasks/${first.id}`)).status).toBe(404);
    const projectParent = service.createTask({ projectId: project.id, title: 'Project parent' });
    service.createTask({ projectId: project.id, title: 'Project leaf', dependsOn: [projectParent.id] });
    expect((await request(`projects/${project.id}`, 'DELETE')).status).toBe(200);
  });

  it('rejects active deletion and removes all runtime records after the actual process has stopped', async () => {
    const { server, project, request } = await setup();
    const task = server.service.createTask({ projectId: project.id, title: 'Running deletion guard', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.log("running");setInterval(()=>{},1000)'] } });
    const run = server.service.startTask(task.id);
    expect((await request(`tasks/${task.id}`, 'DELETE')).status).toBe(409); expect(server.service.task(task.id)).toBeTruthy();
    await request(`runs/${run.id}/stop`, 'POST');
    const end = Date.now() + 6000; let status = 409;
    while (status === 409 && Date.now() < end) { status = (await request(`tasks/${task.id}`, 'DELETE')).status; if (status === 409) await new Promise((resolve) => setTimeout(resolve, 35)); }
    expect(status).toBe(200); expect(server.service.snapshot().runs.some((item) => item.taskId === task.id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100)); expect(server.service.snapshot().events.some((item) => item.taskId === task.id)).toBe(false);
  });

  it('looks up remote issues without side effects and imports only read-only blockers on a valid explicit Save', async () => {
    const { server, project, request } = await setup(); const service = server.service;
    service.updateProject(project.id, { github: { repository: 'owner/repo', owner: 'owner', number: 1 } });
    const lookup = vi.spyOn(ControlGitHub.prototype, 'lookupIssue').mockResolvedValue({ number: 77, title: 'Existing external issue', body: 'Owned by another workflow', url: 'https://github.com/owner/repo/issues/77', state: 'open', nodeId: 'I_77' });
    const before = service.snapshot().tasks.length;
    const search = await request(`tasks/search?projectId=${project.id}&q=%2377`).then((response) => response.json()); expect(search.items[0]).toMatchObject({ id: null, reference: '#77', remote: true }); expect(service.snapshot().tasks).toHaveLength(before);
    expect((await request('tasks', 'POST', { projectId: project.id, title: '', dependencyRefs: ['#77'] })).status).toBe(400); expect(service.snapshot().tasks).toHaveLength(before);
    const saved = await request('tasks', 'POST', { projectId: project.id, title: 'Explicitly saved task', dependencyRefs: ['#77'] }).then((response) => response.json()) as Task;
    expect(service.snapshot().tasks).toHaveLength(before + 2); const blocker = service.task(saved.dependsOn[0]!);
    expect(blocker.externalDependency).toBe(true); expect(blocker.status).toBe('backlog'); expect(blocker.github?.issueNumber).toBe(77);
    expect(() => service.startTask(blocker.id)).toThrow(/only tracks an external/); expect(() => service.startTask(saved.id)).toThrow(/dependencies/);
    expect((await request(`tasks/${blocker.id}`, 'DELETE')).status).toBe(200); expect(service.task(saved.id).dependsOn).toEqual([]);
    expect(service.snapshot().ignoredGitHubIssues?.[project.id]).toBeUndefined(); expect(lookup).toHaveBeenCalled();
  });

  it('uses a real read-only provider process to fill a draft while leaving task/run/chat state and disk unchanged until Save', async () => {
    const { server, project, request, root } = await setup(); const service = server.service;
    const blocker = service.createTask({ projectId: project.id, title: 'Existing blocker' }); const bin = join(root, 'bin'); mkdirSync(bin);
    const proof = join(root, 'provider-proof.json'); const fixture = join(bin, 'emit.cjs');
    const reply = { reply: 'I filled an editable draft; please review and save.', draft: { title: 'AI-generated title', description: 'Complete actionable instructions and acceptance checks.', priority: 3, status: 'ready', dependsOn: [blocker.id] } };
    writeFileSync(fixture, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),hasToken:!!process.env.AIWS_CONTROL_TOKEN,hasUrl:!!process.env.AIWS_CONTROL_URL,input}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(reply)})}}))});`);
    const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex');
    writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)});\n`); if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'; vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey]}`); vi.stubEnv('AIWS_CONTROL_TOKEN', 'must-not-leak-to-readonly-planner');
    await service.store.flush(); const before = JSON.stringify(service.snapshot()); const disk = readFileSync(service.store.path, 'utf8');
    const response = await request(`projects/${project.id}/draft`, 'POST', { message: 'Prepare a clear task draft.', draft: { title: 'My rough title' } }); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.draft.title).toBe('AI-generated title'); expect(result.draft.status).toBe('backlog'); expect(result.draft.dependsOn).toEqual([blocker.id]);
    await service.store.flush(); expect(JSON.stringify(service.snapshot())).toBe(before); expect(readFileSync(service.store.path, 'utf8')).toBe(disk);
    const invocation = JSON.parse(readFileSync(proof, 'utf8')); expect(invocation.args[invocation.args.indexOf('--sandbox') + 1]).toBe('read-only'); expect(invocation.hasToken).toBe(false); expect(invocation.hasUrl).toBe(false); expect(invocation.input).toContain('My rough title');
    const save = await request('tasks', 'POST', { ...result.draft, projectId: project.id }); expect(save.status).toBe(201); expect(service.snapshot().tasks).toHaveLength(2); expect(service.snapshot().runs).toHaveLength(0);
  }, 15000);

  it('streams transient workspace progress, sends user-edited drafts to the provider and cancels only the named request', async () => {
    const { server, project, request, root } = await setup(); const service = server.service; const bin = join(root, 'bin'); mkdirSync(bin);
    const proof = join(root, 'workspace-proof.txt'); const fixture = join(bin, 'slow.cjs');
    writeFileSync(fixture, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(proof)},input);console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'**Inspecting the router**'}}));setInterval(()=>{},1000);});`);
    const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex');
    writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)});\n`); if (process.platform !== 'win32') chmodSync(launcher, 0o755);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'; vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey]}`);
    const activity: unknown[] = []; service.on('draft', (value) => activity.push(value));
    await service.store.flush(); const before = JSON.stringify(service.snapshot());
    const pending = request(`projects/${project.id}/draft`, 'POST', { mode: 'workspace', requestId: 'request-1', message: 'Split the work.', drafts: [{ key: 'd1', title: 'My edited title', userEdited: ['title'] }] });
    await vi.waitFor(() => expect(activity).toEqual([{ projectId: project.id, requestId: 'request-1', activity: 'Inspecting the router' }]), { timeout: 10_000, interval: 25 });
    expect(readFileSync(proof, 'utf8')).toContain('My edited title'); expect(readFileSync(proof, 'utf8')).toContain('"userEdited":["title"]');
    expect(await request(`projects/${project.id}/draft/cancel`, 'POST', { requestId: 'another' }).then((response) => response.json())).toEqual({ cancelled: false });
    expect(await request(`projects/${project.id}/draft/cancel`, 'POST', { requestId: 'request-1' }).then((response) => response.json())).toEqual({ cancelled: true });
    const response = await pending; expect(response.status).toBe(409); expect((await response.json()).error).toContain('cancelled');
    await service.store.flush(); expect(JSON.stringify(service.snapshot())).toBe(before);
    expect(service.snapshot().events.some((event) => event.message.includes('Inspecting the router'))).toBe(false);
  }, 20000);
});
