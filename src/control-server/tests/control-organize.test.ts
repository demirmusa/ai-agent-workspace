import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { startControlServer, type RunningControlServer } from '../server.js';
import { organizePrompt } from '../assistant.js';
import type { Project, Task } from '../types.js';

const servers: RunningControlServer[] = []; const roots: string[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-organize-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'organize-test-token' }); servers.push(server); server.service.updateSettings({ autoSyncSeconds: 0 });
  const project = server.service.createProject({ name: 'Organize', repositoryPath: workspace });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}/api/${path}`, { method, headers: { authorization: 'Bearer organize-test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, workspace, server, project, request };
}
/** Installs a fake `codex` on PATH running the given Node script body; `input` holds the prompt from stdin. */
function fakeCodex(root: string, script: string): void {
  const bin = join(root, 'bin'); mkdirSync(bin); const fixture = join(bin, 'organizer.cjs');
  writeFileSync(fixture, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{${script}});`);
  const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex');
  writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)});\n`); if (process.platform !== 'win32') chmodSync(launcher, 0o755);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'; vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey]}`);
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

describe('AI task queue organizer', () => {
  it('builds a self-contained prompt: backlog to organize, ready tasks read-only, no code access', () => {
    const project = { id: 'project_a', name: 'Shop', description: '' } as Project;
    const task = (id: string, status: Task['status'], extra: Partial<Task> = {}) => ({ id, projectId: project.id, title: `Title ${id}`, description: `Body ${id}`, status, priority: 2, dependsOn: [], ...extra }) as Task;
    const prompt = organizePrompt(project, [task('task_ready', 'ready'), task('task_backlog', 'backlog', { description: 'x'.repeat(5_000) }), task('task_running', 'running'), task('task_done', 'done'), task('task_archived', 'backlog', { archivedAt: 'now' }), { ...task('task_elsewhere', 'backlog'), projectId: 'project_b' }]);
    const section = (name: string) => JSON.parse(prompt.split(`${name}: `)[1]!.split('\n')[0]!);
    expect(section('READY tasks (context only, DO NOT CHANGE)').map((item: Task) => item.id)).toEqual(['task_ready']);
    expect(section('BACKLOG tasks (organize these)').map((item: Task) => item.id)).toEqual(['task_backlog']);
    expect(section('BACKLOG tasks (organize these)')[0].description).toMatch(/… \[truncated\]$/);
    expect(section('Other unfinished tasks (context only, DO NOT CHANGE)')).toEqual([{ id: 'task_running', title: 'Title task_running', status: 'running' }]);
    expect(prompt).not.toContain('task_done'); expect(prompt).not.toContain('task_archived'); expect(prompt).not.toContain('task_elsewhere');
    expect(prompt).toContain('Do NOT read, search, list, open, write or edit any project file or code');
    expect(prompt).toContain('NEVER change a READY task'); expect(prompt).toContain('aiws control tasks update <taskId> --depends-on');
    expect(prompt).toContain('never run aiws control complete');
  });

  it('runs the organizer in the project with control access, applies its CLI changes and reports without creating a task', async () => {
    const { server, project, request, root, workspace } = await setup(); const service = server.service;
    // Keep ready tasks queued: with only a disabled Codex agent the scheduler cannot start them.
    service.catalog.createAgent({ name: 'Unavailable worker', provider: 'codex', enabled: false });
    const ready = service.createTask({ projectId: project.id, title: 'Queued API', status: 'ready' });
    const backlog = service.createTask({ projectId: project.id, title: 'UI on top of the API' });
    const proof = join(root, 'organizer-proof.json');
    fakeCodex(root, `require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),url:process.env.AIWS_CONTROL_URL,hasToken:process.env.AIWS_CONTROL_TOKEN==='organize-test-token',input}));
      console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'aiws control tasks update ${backlog.id} --depends-on ${ready.id} --status ready'}}));
      const response=await fetch(process.env.AIWS_CONTROL_URL+'/api/tasks/${backlog.id}',{method:'PATCH',headers:{authorization:'Bearer '+process.env.AIWS_CONTROL_TOKEN,'content-type':'application/json'},body:JSON.stringify({dependsOn:['${ready.id}'],priority:3,status:'ready'})});
      if(!response.ok)process.exit(3);
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'1. ${ready.id} – Queued API\\n   2. ${backlog.id} – UI on top of the API'}}));`);
    const activity: unknown[] = []; service.on('organize', (value) => activity.push(value));
    const started = await request(`projects/${project.id}/organize`, 'POST', {}); expect(started.status).toBe(202);
    const organization = await started.json(); expect(organization).toMatchObject({ status: 'running', provider: 'codex' });
    expect((await request(`projects/${project.id}/organize`, 'POST', {})).status).toBe(409);
    await vi.waitFor(() => expect(service.snapshot().organizations?.[project.id]?.status).toBe('completed'), { timeout: 15_000, interval: 25 });
    expect(service.snapshot().organizations?.[project.id]?.report).toContain(`${backlog.id} – UI on top of the API`);
    expect(activity).toContainEqual({ projectId: project.id, requestId: organization.requestId, activity: `$ aiws control tasks update ${backlog.id} --depends-on ${ready.id} --status ready` });
    expect(service.task(backlog.id)).toMatchObject({ status: 'ready', dependsOn: [ready.id], priority: 3 });
    expect(service.task(ready.id)).toMatchObject({ status: 'ready', dependsOn: [] });
    const snapshot = service.snapshot(); expect(snapshot.tasks).toHaveLength(2); expect(snapshot.runs).toHaveLength(0);
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(['organize.started', 'organize.completed']));
    const invocation = JSON.parse(readFileSync(proof, 'utf8'));
    expect(invocation.args[invocation.args.indexOf('--sandbox') + 1]).toBe('workspace-write'); expect(invocation.hasToken).toBe(true); expect(invocation.url).toBeTruthy();
    expect(invocation.cwd.toLowerCase()).toBe(workspace.toLowerCase());
    expect(invocation.input).toContain('Queued API'); expect(invocation.input).toContain('UI on top of the API');
  }, 30_000);

  it('refuses an empty backlog and cancels a running organizer while keeping its changes', async () => {
    const { server, project, request, root } = await setup(); const service = server.service;
    expect((await request(`projects/${project.id}/organize`, 'POST', {})).status).toBe(409);
    service.createTask({ projectId: project.id, title: 'Pending work' });
    fakeCodex(root, `console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'Comparing tasks'}}));setInterval(()=>{},1000);`);
    const organization = await (await request(`projects/${project.id}/organize`, 'POST', {})).json();
    expect(await request(`projects/${project.id}/organize/cancel`, 'POST', { requestId: 'another' }).then((response) => response.json())).toEqual({ cancelled: false });
    expect(await request(`projects/${project.id}/organize/cancel`, 'POST', { requestId: organization.requestId }).then((response) => response.json())).toEqual({ cancelled: true });
    await vi.waitFor(() => expect(service.snapshot().organizations?.[project.id]?.status).toBe('cancelled'), { timeout: 15_000, interval: 25 });
    expect(service.snapshot().tasks.map((task) => task.status)).toEqual(['backlog']);
  }, 30_000);
});
