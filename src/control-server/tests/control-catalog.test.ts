import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startControlServer, type RunningControlServer } from '../server.js';
import { ControlService } from '../service.js';
import { emptyControlState } from '../store.js';
import type { AgentDefinition, SkillDefinition, Task, Run } from '../types.js';
import { prepareRuntime } from '../runner.js';
import { materializeRunSkills } from '../catalog.js';

const servers: RunningControlServer[] = []; const services: ControlService[] = []; const roots: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'aiws-catalog-test-')); roots.push(path); return path; }
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error('Timed out awaiting agent catalog execution.');
}
async function setup(): Promise<{ root: string; workspace: string; server: RunningControlServer; request: (path: string, method?: string, input?: unknown) => Promise<Response> }> {
  const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'catalog-test-secret' }); servers.push(server);
  return { root, workspace, server, request: async (path, method = 'GET', input) => fetch(`${server.url}/api/${path}`, { method,
    headers: { Authorization: 'Bearer catalog-test-secret', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }) };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('reusable agent profiles and skill library', () => {
  it('migrates an existing schemaVersion 1 store without changing legacy tasks', async () => {
    const root = temp(); const state = emptyControlState() as unknown as Record<string, unknown>; delete state.agents; delete state.skills;
    writeFileSync(join(root, 'state.json'), JSON.stringify(state));
    const service = await ControlService.open({ dataDir: root }); services.push(service);
    expect(service.snapshot().agents).toEqual([]); expect(service.snapshot().skills).toEqual([]);
    const project = service.createProject({ name: 'Old project', repositoryPath: root });
    const task = service.createTask({ projectId: project.id, title: 'Legacy task' });
    expect(task.provider).toBe('codex'); expect(task.agentId).toBeNull(); expect(task.skillIds).toEqual([]);
  });

  it('authenticates catalog endpoints and validates references and safe resource payloads', async () => {
    const { request, server, workspace } = await setup();
    expect((await fetch(`${server.url}/api/agents`)).status).toBe(401);
    const invalidPaths = ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/../b', 'SKILL.md/path', 'CON.txt', 'a/'];
    for (const path of invalidPaths) expect((await request('skills', 'POST', { name: 'Bad', content: 'skill', files: [{ path, content: 'bad' }] })).status).toBe(400);
    expect((await request('skills', 'POST', { name: 'Bad', content: 'skill', files: [{ path: 'a', content: 'x' }, { path: 'A', content: 'x' }] })).status).toBe(400);
    expect((await request('skills', 'POST', { name: 'Bad', content: 'skill', files: [{ path: 'file', content: 'x' }, { path: 'file/child', content: 'x' }] })).status).toBe(400);
    expect((await request('skills', 'POST', { name: 'Bad', content: 'skill', files: [{ path: 'binary', encoding: 'base64', content: 'NOT BASE64!' }] })).status).toBe(400);
    expect((await request('skills', 'POST', { name: 'Bad', content: 'x'.repeat(256 * 1024 + 1) })).status).toBe(400);
    expect((await request('agents', 'POST', { name: 'Missing', skillIds: ['missing'] })).status).toBe(400);
    const skill = await request('skills', 'POST', { name: 'Testing', content: '# Testing\nRun checks.', files: [{ path: 'scripts/check.js', content: 'console.log("check")' }] }).then((r) => r.json()) as SkillDefinition;
    const agent = await request('agents', 'POST', { name: 'Reviewer', provider: 'codex', instructions: 'Review changes', skillIds: [skill.id] }).then((r) => r.json()) as AgentDefinition;
    expect((await request(`skills/${skill.id}`, 'DELETE')).status).toBe(409);
    const project = server.service.createProject({ name: 'Assignments', repositoryPath: workspace });
    expect((await request('tasks', 'POST', { projectId: project.id, title: 'Missing profile', agentId: 'no-profile' })).status).toBe(404);
    expect((await request('tasks', 'POST', { projectId: project.id, title: 'Missing skill', skillIds: ['missing'] })).status).toBe(400);
    const task = await request('tasks', 'POST', { projectId: project.id, title: 'Assigned', agentId: agent.id }).then((r) => r.json()) as Task;
    expect((await request(`agents/${agent.id}`, 'DELETE')).status).toBe(409);
    await request(`tasks/${task.id}`, 'PATCH', { agentId: null });
    expect((await request(`agents/${agent.id}`, 'DELETE')).status).toBe(200);
    expect((await request(`skills/${skill.id}`, 'DELETE')).status).toBe(200);
    expect((await request('agents')).status).toBe(200); expect((await request('skills')).status).toBe(200);
  });

  it('imports SKILL.md and binary support files, rejects symlinks and enforces size/count limits', async () => {
    const { request, root } = await setup(); const directory = join(root, 'skill-import'); mkdirSync(directory); mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'SKILL.md'), 'Read assets/sample.bin.'); writeFileSync(join(directory, 'assets', 'sample.bin'), Buffer.from([0, 255, 1, 33]));
    const response = await request('skills/import', 'POST', { directory, name: 'Imported' }); expect(response.status).toBe(201);
    const skill = await response.json() as SkillDefinition; expect(skill.content).toContain('sample.bin'); expect(Buffer.from(skill.files[0]!.content, 'base64')).toEqual(Buffer.from([0, 255, 1, 33]));
    const target = join(root, 'outside'); mkdirSync(target); writeFileSync(join(target, 'secret.txt'), 'must-not-import');
    symlinkSync(target, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await request('skills/import', 'POST', { directory })).status).toBe(400);
    const large = join(root, 'large'); mkdirSync(large); writeFileSync(join(large, 'SKILL.md'), 'large'); writeFileSync(join(large, 'big.bin'), Buffer.alloc(256 * 1024 + 1));
    expect((await request('skills/import', 'POST', { directory: large })).status).toBe(400);
    const many = join(root, 'many'); mkdirSync(many); writeFileSync(join(many, 'SKILL.md'), 'many');
    for (let index = 0; index < 65; index++) writeFileSync(join(many, `${index}.txt`), 'x');
    expect((await request('skills/import', 'POST', { directory: many })).status).toBe(400);
    expect((await request('skills/import', 'POST', { directory: '../relative' })).status).toBe(400);
  });

  it('delivers inherited profile instructions, context and immutable skill resources to real child continuations', async () => {
    const { request, server, root, workspace } = await setup(); const script = join(root, 'proof.cjs');
    writeFileSync(script, `const fs=require('node:fs'),p=require('node:path');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const dirs=fs.readdirSync(process.env.AIWS_SKILLS_DIR);const root=p.join(process.env.AIWS_SKILLS_DIR,dirs[0]);const count=fs.existsSync('count')?Number(fs.readFileSync('count')):0;fs.writeFileSync('count',String(count+1));fs.writeFileSync('proof-'+count+'.json',JSON.stringify({input,agentId:process.env.AIWS_AGENT_ID,skill:fs.readFileSync(p.join(root,'SKILL.md'),'utf8'),resource:fs.readFileSync(p.join(root,'resources','marker.txt'),'utf8')}));console.log('proof-ready-'+count);setTimeout(()=>process.exit(0),count?20:700)});`);
    const secret = randomUUID();
    const skill = await request('skills', 'POST', { name: 'Proof skill', content: `SKILL-${secret}`, files: [{ path: 'resources/marker.txt', content: `RESOURCE-${secret}` }] }).then((r) => r.json()) as SkillDefinition;
    const agent = await request('agents', 'POST', { name: 'Proof agent', provider: 'command', terminalMode: 'stream', model: 'initial-model', command: { executable: process.execPath, args: [script] }, instructions: `INSTRUCTIONS-${secret}`, context: `CONTEXT-${secret}`, skillIds: [skill.id] }).then((r) => r.json()) as AgentDefinition;
    const project = server.service.createProject({ name: 'Proof', repositoryPath: workspace });
    // Omitted provider/model inherit the assigned profile, including its actual executable.
    const task = await request('tasks', 'POST', { projectId: project.id, title: 'Produce proof', agentId: agent.id }).then((r) => r.json()) as Task;
    expect(task.provider).toBe('command'); expect(task.providerOverride).toBeUndefined(); expect(task.modelOverride).toBeUndefined();
    const run = await request(`tasks/${task.id}/run`, 'POST').then((r) => r.json()) as Run;
    await waitFor(() => server.service.snapshot().events, (events) => events.some((event) => event.message.includes('proof-ready-0')));
    await request(`agents/${agent.id}`, 'PATCH', { instructions: 'CHANGED', context: 'CHANGED', model: 'new-model' });
    await request(`skills/${skill.id}`, 'PATCH', { content: 'CHANGED', files: [{ path: 'resources/marker.txt', content: 'CHANGED' }] });
    await request(`runs/${run.id}/command`, 'POST', { message: 'Continue with the original assignment.' });
    await waitFor(() => server.service.run(run.id), (value) => value.status === 'completed');
    for (const index of [0, 1]) {
      const proof = JSON.parse(readFileSync(join(workspace, `proof-${index}.json`), 'utf8'));
      expect(proof.input).toContain(`INSTRUCTIONS-${secret}`); expect(proof.input).toContain(`CONTEXT-${secret}`); expect(proof.input).toContain(`SKILL-${secret}`);
      expect(proof.resource).toBe(`RESOURCE-${secret}`); expect(proof.skill).toBe(`SKILL-${secret}`); expect(proof.agentId).toBe(agent.id);
    }
    expect(server.service.run(run.id).executionSnapshot?.agent?.revision).toBe(1);
    expect(server.service.run(run.id).executionSnapshot?.model).toBe('initial-model');
    expect(server.service.run(run.id).executionSnapshot?.skills[0]?.revision).toBe(1);
    const next = await request(`tasks/${task.id}/run`, 'POST').then((r) => r.json()) as Run;
    expect(next.executionSnapshot?.instructions).toBe('CHANGED'); expect(next.executionSnapshot?.model).toBe('new-model'); expect(next.executionSnapshot?.skills[0]?.revision).toBe(2);
    await waitFor(() => server.service.run(next.id), (value) => value.status === 'completed');
  }, 30_000);

  it('applies explicit task overrides, resets them to profile defaults, and schedules assigned ready tasks', async () => {
    const { server, workspace, request } = await setup(); const service = server.service;
    const agent = service.catalog.createAgent({ name: 'Scheduled', provider: 'command', model: 'profile-model', instructions: 'SCHEDULED-INSTRUCTION', command: { executable: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(s))'] } });
    const project = service.createProject({ name: 'Scheduler', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Ready assigned work', agentId: agent.id, model: 'task-model', provider: 'command', terminalMode: 'stream' });
    expect(task.modelOverride).toBe('task-model'); expect(task.providerOverride).toBe('command');
    const cleared = await request(`tasks/${task.id}`, 'PATCH', { provider: null, model: null, command: null, status: 'ready', autoStart: true }).then((r) => r.json()) as Task;
    expect(cleared.modelOverride).toBeUndefined(); expect(cleared.model).toBe('profile-model');
    await waitFor(() => service.snapshot().runs, (runs) => runs.some((run) => run.taskId === task.id && run.status === 'completed'));
    const run = service.snapshot().runs.find((value) => value.taskId === task.id)!;
    expect(run.executionSnapshot?.agent?.id).toBe(agent.id); expect(run.executionSnapshot?.model).toBe('profile-model');
    expect(service.snapshot().events.some((event) => event.runId === run.id && event.message.includes('SCHEDULED-INSTRUCTION'))).toBe(true);
    service.catalog.updateAgent(agent.id, { enabled: false }); expect(() => service.startTask(task.id)).toThrow(/disabled/);
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('passes distinct arguments and UTF-8 stdin through a real Windows npm-style PowerShell shim', async () => {
    const { root, workspace, server } = await setup(); const script = join(root, 'capture.cjs'); const shim = join(root, 'provider.ps1');
    writeFileSync(script, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync('shim-proof.json',JSON.stringify({args:process.argv.slice(2),input}));console.log('shim-captured');process.exit(7)});`);
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    writeFileSync(shim, `& ${quote(process.execPath)} ${quote(script)} @args\nexit $LASTEXITCODE\n`);
    const project = server.service.createProject({ name: 'PowerShell launcher', repositoryPath: workspace });
    const args = ['exec', '--json', '--model', 'test-model', '-'];
    const task = server.service.createTask({ projectId: project.id, title: 'Türkçe görev', description: 'İçerik: ğüşiöç', provider: 'command', command: { executable: shim, args }, terminalMode: 'stream' });
    const run = server.service.startTask(task.id);
    await waitFor(() => server.service.run(run.id), (value) => value.status === 'failed');
    expect(server.service.run(run.id).exitCode).toBe(7);
    const proof = JSON.parse(readFileSync(join(workspace, 'shim-proof.json'), 'utf8'));
    expect(proof.args).toEqual(args); expect(proof.input).toContain('Türkçe görev'); expect(proof.input).toContain('ğüşiöç');
  }, 20_000);

  it('maps frozen resources into Docker from a Compose data volume or native host directory', async () => {
    const { server, workspace, root } = await setup(); const service = server.service;
    const skill = service.catalog.createSkill({ name: 'Docker resources', content: 'Read reference bytes.', files: [{ path: 'assets/binary.dat', content: 'AP8B', encoding: 'base64' }] });
    const agent = service.catalog.createAgent({ name: 'Docker profile', provider: 'codex', model: 'profile-model', skillIds: [skill.id] });
    const project = service.createProject({ name: 'Docker', repositoryPath: workspace }); const task = service.createTask({ projectId: project.id, title: 'Docker task', agentId: agent.id });
    const run: Run = { id: 'run_docker_contract', taskId: task.id, provider: 'codex', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'docker', pendingCommands: [], continuation: 0,
      executionSnapshot: { agent, skills: [skill], provider: 'codex', model: 'profile-model', instructions: '', context: '', task: { title: task.title, description: task.description }, createdAt: new Date().toISOString() } };
    run.skillsDirectory = materializeRunSkills(join(root, 'data'), run.id, run.executionSnapshot!)!;
    expect(readFileSync(join(run.skillsDirectory, skill.id, 'assets', 'binary.dat'))).toEqual(Buffer.from([0, 255, 1]));
    vi.stubEnv('AIWS_CONTROL_SKILLS_VOLUME', 'aiws-control_control-data');
    const options = { image: 'aiws-worker:test', controlUrl: 'http://control:4317', token: 'test-token-for-docker' };
    const namedVolume = prepareRuntime(project, task, run, 'Frozen prompt', options);
    expect(namedVolume.args).toContain('type=volume,src=aiws-control_control-data,dst=/run/aiws/skills,volume-subpath=runs/run_docker_contract/skills,readonly');
    expect(namedVolume.args).toContain('AIWS_SKILLS_DIR=/run/aiws/skills'); expect(namedVolume.args).toContain('AIWS_CONTROL_URL=http://control:4317');
    expect(namedVolume.args).toContain('profile-model'); expect(namedVolume.args).not.toContain(options.token); expect(namedVolume.env.AIWS_CONTROL_TOKEN).toBe(options.token);
    vi.stubEnv('AIWS_CONTROL_SKILLS_VOLUME', '');
    const bind = prepareRuntime(project, task, run, 'Frozen prompt', options);
    expect(bind.args).toContain(`type=bind,src=${run.skillsDirectory},dst=/run/aiws/skills,readonly`); expect(bind.input).toBe('Frozen prompt');
  });

  it('enforces provider-specific read-only planning independently of profile instructions', async () => {
    const { server, workspace } = await setup(); const service = server.service;
    const project = service.createProject({ name: 'Read-only planning', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Plan', provider: 'codex' });
    const run: Run = { id: 'planner_policy', taskId: task.id, provider: 'codex', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'stream' };
    const options = { image: 'worker:test', controlUrl: 'http://control:4317', readOnly: true };
    const codex = prepareRuntime(project, task, run, 'Planning must not write files', options);
    expect(codex.args[codex.args.indexOf('--sandbox') + 1]).toBe('read-only'); expect(codex.args).not.toContain('workspace-write');
    const claude = prepareRuntime(project, { ...task, provider: 'claude' }, { ...run, provider: 'claude' }, 'Plan', options);
    expect(claude.args[claude.args.indexOf('--permission-mode') + 1]).toBe('plan'); expect(claude.args[claude.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep'); expect(claude.args).toContain('--strict-mcp-config');
    const opencode = prepareRuntime(project, { ...task, provider: 'opencode' }, { ...run, provider: 'opencode' }, 'Plan', options);
    expect(JSON.parse(opencode.env.OPENCODE_PERMISSION!)).toMatchObject({ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow' });
    expect(() => prepareRuntime(project, { ...task, provider: 'command', command: { executable: process.execPath, args: [] } }, run, 'Plan', options)).toThrow(/arbitrary commands/);
    expect(() => prepareRuntime(project, task, { ...run, terminalMode: 'pty' }, 'Plan', options)).toThrow(/bounded provider/);
    const docker = prepareRuntime(project, task, { ...run, executionMode: 'docker' }, 'Plan', options);
    expect(docker.args).toContain(`type=bind,src=${workspace},dst=/workspace,readonly`);
  });

  it('keeps native task prompts outside variadic options and preserves each provider argument boundary', async () => {
    const { server, workspace, root } = await setup();
    const project = server.service.createProject({ name: 'Native argument boundaries', repositoryPath: workspace });
    const task = server.service.createTask({ projectId: project.id, title: 'Native task', provider: 'claude' });
    const run: Run = { id: 'native_arguments', taskId: task.id, provider: 'claude', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', inputDirectory: join(root, 'input'), pendingCommands: [], continuation: 0 };
    const options = { image: 'worker:test', controlUrl: 'http://control:4317' };
    const claude = prepareRuntime(project, task, run, 'Instructions are in the runtime file.', options);
    expect(claude.args.at(-2)).toBe('--');
    expect(claude.args.slice(claude.args.indexOf('--allowedTools') + 1, claude.args.indexOf('--'))).toEqual(['Bash,Read,Edit,Write,Glob,Grep']);
    expect(claude.args.at(-1)).toContain(join(root, 'input', 'prompt.md'));
    expect(claude.args).not.toContain('--print'); expect(claude.input).toBe('');
    const codex = prepareRuntime(project, { ...task, provider: 'codex' }, { ...run, provider: 'codex' }, 'Task', options);
    expect(codex.args).not.toContain('exec'); expect(codex.args.at(-1)).toContain(join(root, 'input', 'prompt.md')); expect(codex.args.filter((arg) => arg.startsWith('Read and follow'))).toHaveLength(1);
    const opencode = prepareRuntime(project, { ...task, provider: 'opencode' }, { ...run, provider: 'opencode' }, 'Task', options);
    expect(opencode.args[0]).toBe('--prompt'); expect(opencode.args[1]).toContain(join(root, 'input', 'prompt.md')); expect(opencode.args).not.toContain('run');
    const agy = prepareRuntime(project, { ...task, provider: 'agy' }, { ...run, provider: 'agy' }, 'Task', options);
    expect(agy.args).toEqual(['--mode', 'auto', '--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: [workspace] }), '--prompt-interactive', expect.stringContaining(join(root, 'input', 'prompt.md'))]);
  });
});
