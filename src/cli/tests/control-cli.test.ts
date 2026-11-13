import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlRequest } from '../commands/control.js';
import { readZipArchive } from '../../control-server/plugins.js';
import { startControlServer } from '../../control-server/index.js';
import { createProgram } from '../index.js';

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe('Control CLI', () => {
  it('finds the running service on any port without --url, and names the address when it cannot connect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-discovery-')); directories.push(directory);
    vi.stubEnv('AIWS_CONTROL_URL', ''); vi.stubEnv('AIWS_CONTROL_TOKEN', ''); vi.stubEnv('AIWS_CONTROL_DATA', ''); vi.stubEnv('AIWS_CONTROL_DATA_DIR', directory);
    try {
      const running = await startControlServer({ port: 0, dataDir: directory });
      const closed = new URL(running.url);
      try {
        running.service.createProject({ name: 'Discovered', repositoryPath: directory });
        let printed = ''; const write = vi.spyOn(process.stdout, 'write').mockImplementation((value) => { printed += String(value); return true; });
        await createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', 'projects', 'list']);
        write.mockRestore();
        expect(printed).toContain('Discovered');
      } finally { await running.close(); }
      await expect(controlRequest(closed.origin, undefined, '/api/state')).rejects.toThrow(`Cannot reach the AIWS control server at ${closed.origin} (ECONNREFUSED)`);
    } finally { vi.unstubAllEnvs(); }
  }, 30000);
  it('manages milestones and the tasks in them through a running control service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-milestones-cli-')); directories.push(directory);
    vi.stubEnv('AIWS_CONTROL_TOKEN', '');
    const running = await startControlServer({ port: 0, dataDir: directory });
    try {
      const project = running.service.createProject({ name: 'Milestones', repositoryPath: directory });
      let printed = ''; vi.spyOn(process.stdout, 'write').mockImplementation((value) => { printed = String(value); return true; });
      const run = async (...args: string[]) => { await createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', running.url, ...args]); return JSON.parse(printed); };
      await run('milestones', 'create', project.id, 'Later', '--due', '2026-12-31');
      const created = await run('milestones', 'create', project.id, 'Sooner', '--due', '2026-11-30', '--description', 'First release', '--current');
      const sooner = created.milestones.find((entry: any) => entry.title === 'Sooner'), later = created.milestones.find((entry: any) => entry.title === 'Later');
      expect(created.currentMilestoneId).toBe(sooner.id);
      const task = await run('tasks', 'create', project.id, 'Joins the current milestone');
      expect(task.milestoneId).toBe(sooner.id);
      const loose = await run('tasks', 'create', project.id, 'No milestone', '--milestone', 'none');
      expect(loose.milestoneId).toBeUndefined();
      expect((await run('milestones', 'list', project.id)).map((entry: any) => [entry.title, entry.current, entry.taskCount])).toEqual([['Sooner', true, 1], ['Later', false, 0]]);
      expect((await run('milestones', 'show', project.id, sooner.id)).tasks).toEqual([{ id: task.id, title: 'Joins the current milestone', status: 'backlog' }]);
      expect((await run('tasks', 'list', '--project', project.id, '--milestone', 'none')).map((entry: any) => entry.id)).toEqual([loose.id]);
      expect(await run('milestones', 'assign', project.id, later.id, `${task.id},${loose.id}`)).toEqual({ moved: 2 });
      expect((await run('tasks', 'update', task.id, '--milestone', 'none')).milestoneId).toBeUndefined();
      expect((await run('milestones', 'current', project.id, later.id)).currentMilestoneId).toBe(later.id);
      expect((await run('milestones', 'current', project.id)).id).toBe(later.id);
      const closed = await run('milestones', 'update', project.id, later.id, '--state', 'closed', '--due', 'none', '--title', 'Later release');
      expect(closed.milestones.find((entry: any) => entry.id === later.id)).toMatchObject({ title: 'Later release', state: 'closed', dueOn: null });
      expect(closed.currentMilestoneId).toBe(sooner.id);
      expect((await run('milestones', 'list', project.id, '--state', 'closed')).map((entry: any) => entry.id)).toEqual([later.id]);
      expect((await run('milestones', 'delete', project.id, later.id)).milestones.map((entry: any) => entry.id)).toEqual([sooner.id]);
      expect((await run('tasks', 'show', loose.id)).milestoneId).toBeUndefined();
      expect(await run('milestones', 'current', project.id, 'none')).toMatchObject({ currentMilestoneId: null });
      expect((await run('tasks', 'create', project.id, 'Without a current milestone')).milestoneId).toBeUndefined();
    } finally { await running.close(); vi.unstubAllEnvs(); }
  }, 30000);
  it('manages plugins through the control API and packs a plugin folder offline', async () => {
    const requests: { method: string; url: string; body: any }[] = [];
    const server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk;
      requests.push({ method: request.method!, url: request.url!, body: text ? JSON.parse(text) : undefined });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, settings: { pointUnit: 'h' }, logs: [] }));
    }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    const directory = await mkdtemp(join(tmpdir(), 'aiws-plugin-cli-')); directories.push(directory);
    const output: any[] = []; vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output.push(JSON.parse(String(value))); return true; });
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    const example = fileURLToPath(new URL('../../../examples/plugins/aiws-example-plugin', import.meta.url));
    await run('plugins', 'install', example, '--link');
    await run('plugins', 'disable', 'aiws.example'); await run('plugins', 'enable', 'aiws.example');
    await run('plugins', 'settings', 'aiws.example', '{"pointUnit":"h"}');
    await run('plugins', 'logs', 'aiws.example'); await run('plugins', 'remove', 'aiws.example'); await run('plugins', 'skill', '--force');
    const archive = join(directory, 'example.zip');
    await run('plugins', 'pack', example, '--out', archive);
    expect(output.at(-1)).toMatchObject({ id: 'aiws.example', version: '1.0.0', archive });
    await run('plugins', 'install', archive);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['POST /api/plugins', 'PATCH /api/plugins/aiws.example', 'PATCH /api/plugins/aiws.example', 'PATCH /api/plugins/aiws.example',
      'GET /api/plugins/aiws.example/logs', 'DELETE /api/plugins/aiws.example', 'POST /api/plugin-skill', 'POST /api/plugins']);
    expect(requests[0]!.body).toEqual({ path: example, mode: 'link' });
    expect(requests[1]!.body).toEqual({ enabled: false }); expect(requests[3]!.body).toEqual({ settings: { pointUnit: 'h' } });
    expect(requests[6]!.body).toEqual({ force: true });
    expect(readZipArchive(Buffer.from(requests[7]!.body.archive, 'base64')).has('plugin.json')).toBe(true);
    expect(requests[7]!.body.fileName).toBe('example.zip');
  });
  it('reads individual management resources and scopes task/run lists across projects', async () => {
    const paths: string[] = [];
    const state = {
      tasks: [{ id: 'task_a', projectId: 'project_a', status: 'ready' }, { id: 'task_b', projectId: 'project_b', status: 'ready' }, { id: 'task_c', projectId: 'project_a', status: 'done' }],
      runs: [{ id: 'run_a', taskId: 'task_a', status: 'running' }, { id: 'run_b', taskId: 'task_b', status: 'running' }, { id: 'run_c', taskId: 'task_c', status: 'completed' }],
    };
    const server = createServer((request, response) => {
      paths.push(request.url!); response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/state' ? state : { id: request.url!.split('/').at(-1) }));
    }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    const output: any[] = []; vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output.push(JSON.parse(String(value))); return true; });
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    await run('projects', 'show', 'project_a'); await run('tasks', 'show', 'task_a'); await run('runs', 'show', 'run_a');
    await run('tasks', 'list', '--project', 'project_a', '--status', 'ready');
    await run('runs', 'list', '--project', 'project_a', '--status', 'running');
    await run('runs', 'list', '--task', 'task_c');
    await run('runs', 'list');
    expect(paths.slice(0, 3)).toEqual(['/api/projects/project_a', '/api/tasks/task_a', '/api/runs/run_a']);
    expect(output.slice(0, 3)).toEqual([{ id: 'project_a' }, { id: 'task_a' }, { id: 'run_a' }]);
    expect(output[3]).toEqual([state.tasks[0]]); expect(output[4]).toEqual([state.runs[0]]);
    expect(output[5]).toEqual([state.runs[2]]); expect(output[6]).toEqual(state.runs);
  });
  it('registers a GitHub-independent project/task/run/question command surface', () => {
    const program = createProgram();
    const control = program.commands.find((command) => command.name() === 'control');
    expect(control?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['serve', 'state', 'agents', 'skills', 'projects', 'tasks', 'runs', 'questions', 'ask']));
  });
  it('sends JSON and a bearer token and surfaces API failures', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/bad') { response.writeHead(409); response.end(JSON.stringify({ error: 'Task already running' })); return; }
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => response.end(JSON.stringify({ authorization: request.headers.authorization, method: request.method, body: JSON.parse(body) })));
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    const base = `http://127.0.0.1:${address.port}`;
    await expect(controlRequest(base, 'test-only', '/api/tasks', 'POST', { title: 'Task' })).resolves.toEqual({ authorization: 'Bearer test-only', method: 'POST', body: { title: 'Task' } });
    await expect(controlRequest(base, undefined, '/bad')).rejects.toThrow('Task already running');
  });
  it('reads local profile/skill instructions and preserves profile inheritance and explicit task overrides', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const server = createServer((request, response) => {
      let body = ''; request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { calls.push({ path: request.url ?? '', body: JSON.parse(body) }); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'created' })); });
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    const directory = await mkdtemp(join(tmpdir(), 'aiws-cli-profiles-')); directories.push(directory);
    const file = join(directory, 'SKILL.md'); await writeFile(file, '# Review skill\nRead the supporting resources.');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    await run('agents', 'create', 'Reviewer', '--provider', 'codex', '--instructions-file', file, '--context', 'Project background', '--skills', 'skill_a,skill_b');
    await run('skills', 'create', 'Review', '--file', file);
    await run('skills', 'import', '/srv/skills/review');
    await run('tasks', 'create', 'project_a', 'Inherited task', '--agent', 'agent_a', '--skills', 'skill_b');
    await run('tasks', 'update', 'task_a', '--agent', 'agent_a', '--provider', 'claude', '--model', 'chosen-model');
    await run('settings', 'set', '--default-provider', 'claude', '--task-merge-mode', 'pull-request');
    await run('projects', 'update', 'project_a', '--use-worktree', 'true', '--main-branch', 'develop');
    await run('projects', 'update', 'project_b', '--use-worktree', 'false');
    expect(calls[0]).toMatchObject({ path: '/api/agents', body: { name: 'Reviewer', provider: 'codex', instructions: '# Review skill\nRead the supporting resources.', context: 'Project background', skillIds: ['skill_a', 'skill_b'] } });
    expect(calls[1]).toMatchObject({ path: '/api/skills', body: { name: 'Review', content: '# Review skill\nRead the supporting resources.' } });
    expect(calls[2]).toMatchObject({ path: '/api/skills/import', body: { directory: '/srv/skills/review' } });
    expect(calls[3]).toMatchObject({ path: '/api/tasks', body: { agentId: 'agent_a', provider: null, model: null, skillIds: ['skill_b'] } });
    expect(calls[4]).toMatchObject({ path: '/api/tasks/task_a', body: { agentId: 'agent_a', provider: 'claude', model: 'chosen-model' } });
    expect(calls[5]).toEqual({ path: '/api/settings', body: { defaultProvider: 'claude', taskMergeMode: 'pull-request' } });
    expect(calls[6]).toEqual({ path: '/api/projects/project_a', body: { useWorktree: true, mainBranch: 'develop' } });
    expect(calls[7]).toEqual({ path: '/api/projects/project_b', body: { useWorktree: false } });
  });
  it('rejects an invalid question timeout before making an API mutation', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    await expect(createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', 'ask', 'Question', '--run', 'run_a', '--timeout', '-1'])).rejects.toThrow('--timeout must be positive');
    expect(request).not.toHaveBeenCalled();
  });
  it('marks operator permission requests as approvals through the CLI', async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.on('end', () => { received.push(JSON.parse(body)); response.setHeader('content-type','application/json'); response.end(JSON.stringify({id:'question_permission'})); });
    });
    servers.push(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    await createProgram().exitOverride().parseAsync(['node','aiws','control','--url',`http://127.0.0.1:${address.port}`,'ask','Allow operation?','--run','run_permission','--approval','--no-wait']);
    expect(received).toEqual([{text:'Allow operation?',kind:'approval'}]);
  });
  it('keeps intake draft, search, explicit task save and delete as separate CLI operations', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const server = createServer((request, response) => {
      let text = ''; request.on('data', (chunk) => { text += chunk; }); request.on('end', () => {
        calls.push({ method: request.method ?? 'GET', path: request.url ?? '', body: text ? JSON.parse(text) : undefined });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    await run('projects', 'draft', 'project_a', 'Prepare a task, do not save it.', '--agent', 'agent_planner');
    await run('tasks', 'search', '#123', '--project', 'project_a', '--exclude', 'task_a');
    await run('tasks', 'create', 'project_a', 'Edited title', '--blocked-by', 'task_dependency,#123', '--priority', '3');
    await run('tasks', 'delete', 'task_a');
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/projects/project_a/draft', body: { message: 'Prepare a task, do not save it.', agentId: 'agent_planner' } });
    expect(calls[1]?.method).toBe('GET');
    const search = new URL(calls[1]!.path, 'http://localhost'); expect(search.pathname).toBe('/api/tasks/search'); expect(search.searchParams.get('q')).toBe('#123'); expect(search.searchParams.get('excludeTaskId')).toBe('task_a');
    expect(calls[2]).toMatchObject({ method: 'POST', path: '/api/tasks', body: { title: 'Edited title', dependencyRefs: ['task_dependency', '#123'], priority: 3 } });
    expect(calls[3]).toEqual({ method: 'DELETE', path: '/api/tasks/task_a', body: undefined });
  });
  it('lists and reads provider history without execution and uses an explicit resume endpoint', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const server = createServer((request, response) => {
      let text = ''; request.on('data', (chunk) => { text += chunk; }); request.on('end', () => { calls.push({ method: request.method ?? 'GET', path: request.url ?? '', body: text ? JSON.parse(text) : undefined }); response.setHeader('content-type', 'application/json'); response.end('{}'); });
    }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server'); vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    await run('projects', 'sessions', 'project_a', '--provider', 'codex', '--refresh');
    await run('projects', 'session', 'project_a', 'opaque_session', '--cursor', '10');
    await run('projects', 'resume', 'project_a', 'opaque_session', '--terminal', 'stream', '--message', 'Continue with this instruction.');
    expect(calls[0]?.method).toBe('GET'); expect(calls[0]?.path).toContain('/api/projects/project_a/sessions?'); expect(new URL(calls[0]!.path, 'http://localhost').searchParams.get('provider')).toBe('codex');
    expect(calls[1]?.method).toBe('GET'); expect(calls[1]?.path).toContain('/sessions/opaque_session?');
    expect(calls[2]).toEqual({ method: 'POST', path: '/api/projects/project_a/sessions/opaque_session/resume', body: { terminalMode: 'stream', message: 'Continue with this instruction.' } });
  });
  it('creates scheduled tasks and recurring schedules for projects and the general workspace', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const server = createServer((request, response) => {
      let text = ''; request.on('data', (chunk) => { text += chunk; }); request.on('end', () => { calls.push({ method: request.method ?? 'GET', path: request.url ?? '', body: text ? JSON.parse(text) : undefined }); response.setHeader('content-type', 'application/json'); response.end('{}'); });
    }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server'); vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = async (...args: string[]) => createProgram().exitOverride().parseAsync(['node', 'aiws', 'control', '--url', `http://127.0.0.1:${address.port}`, ...args]);
    await run('tasks', 'create', 'project_a', 'Later', '--status', 'ready', '--scheduled-at', '2026-10-20T09:00');
    await run('tasks', 'update', 'task_a', '--scheduled-at', 'none');
    await run('schedules', 'create', 'general', 'Weekday digest', '--daily', '09:00,17:30', '--weekdays', 'mon-fri', '--timezone', 'Europe/Istanbul', '--agent', 'agent_a', '--catch-up', 'skip', '--max-runs', '10');
    await run('schedules', 'create', 'project_a', 'Every half hour', '--every', '30m', '--overlap', 'allow');
    await run('schedules', 'update', 'schedule_a', '--monthly', '1,last', '--at', '08:00', '--provider', 'inherit', '--end-at', 'none');
    await run('schedules', 'disable', 'schedule_a');
    await run('schedules', 'run', 'schedule_a');
    await run('schedules', 'list', '--project', 'general');
    await run('schedules', 'preview', '--cron', '0 9 * * 1', '--count', '3');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/tasks', body: { projectId: 'project_a', status: 'ready', scheduledAt: '2026-10-20T09:00' } });
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: '/api/tasks/task_a', body: { scheduledAt: null } });
    expect(calls[2]).toEqual({ method: 'POST', path: '/api/schedules', body: { projectId: 'project_general', recurrence: { kind: 'daily', times: ['09:00', '17:30'], weekdays: [1, 2, 3, 4, 5] }, timezone: 'Europe/Istanbul', maxRuns: 10, catchUp: 'skip', task: { title: 'Weekday digest', agentId: 'agent_a' } } });
    expect(calls[3]?.body).toMatchObject({ projectId: 'project_a', recurrence: { kind: 'interval', every: 30, unit: 'minutes' }, overlap: 'allow' });
    expect(calls[4]).toEqual({ method: 'PATCH', path: '/api/schedules/schedule_a', body: { recurrence: { kind: 'monthly', days: [1, -1], times: ['08:00'] }, endAt: null, task: { provider: null } } });
    expect(calls[5]).toEqual({ method: 'PATCH', path: '/api/schedules/schedule_a', body: { enabled: false } });
    expect(calls[6]).toMatchObject({ method: 'POST', path: '/api/schedules/schedule_a/run' });
    expect(calls[7]).toMatchObject({ method: 'GET', path: '/api/schedules?projectId=project_general' });
    expect(calls[8]).toEqual({ method: 'POST', path: '/api/schedules/preview?count=3', body: { recurrence: { kind: 'cron', expression: '0 9 * * 1' } } });
    await expect(run('schedules', 'create', 'project_a', 'No timetable')).rejects.toThrow(/Choose when it runs/);
    await expect(run('schedules', 'create', 'project_a', 'Two', '--every', '1h', '--cron', '0 * * * *')).rejects.toThrow(/Choose one of/);
    await expect(run('schedules', 'create', 'project_a', 'Bad', '--every', 'often')).rejects.toThrow(/--every/);
  });
});
