import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlService } from '../service.js';
import { launchRuntime, prepareRuntime, type RuntimeHandle } from '../runner.js';
import type { Project, ProviderArgs, Run, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [], handles: RuntimeHandle[] = [];
const empty = (): ProviderArgs => ({ codex: [], claude: [], opencode: [] });
const waitFor = async (predicate: () => boolean, timeout = 15000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for the local provider fixture.');
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-provider-argv-')); roots.push(root);
  const workspace = join(root, 'workspace'), bin = join(root, 'bin'); mkdirSync(workspace); mkdirSync(bin);
  return { root, workspace, bin };
}
function providerShim(bin: string, source: string): void {
  const child = join(bin, 'capture.cjs'); writeFileSync(child, source);
  const launcher = join(bin, process.platform === 'win32' ? 'codex.ps1' : 'codex');
  writeFileSync(launcher, process.platform === 'win32'
    ? `& '${process.execPath.replace(/'/g, "''")}' '${child.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n`
    : `#!/usr/bin/env node\nimport(${JSON.stringify(child)});\n`);
  if (process.platform !== 'win32') chmodSync(launcher, 0o755);
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  vi.stubEnv(key, `${bin}${delimiter}${process.env[key] ?? ''}`);
}
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(handle => handle.stop()));
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('provider CLI argument execution', () => {
  it('keeps literal stream argv, persists provider isolation and uses current settings for the same original session resume', async () => {
    const { root, workspace, bin } = fixture(), sessionId = randomUUID(), home = join(root, 'codex');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'original.jsonl'), [
      { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: sessionId, cwd: workspace } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Original public request.' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const proof = join(workspace, 'argv.jsonl'), release = join(workspace, 'release-first');
    providerShim(bin, `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const file=${JSON.stringify(proof)},first=!fs.existsSync(file);fs.appendFileSync(file,JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),home:process.env.CODEX_HOME,runId:process.env.AIWS_RUN_ID})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sessionId)}}));const finish=()=>{console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)};if(!first)return finish();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);finish()}},20)});`);
    let service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: home, claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
    const literal = 'qa_note="  spaced \\"quote\\" ; $(not_a_command)  "';
    service.updateSettings({ autoSyncSeconds: 0, providerArgs: { codex: ['--yolo', '-c', literal], claude: ['--verbose'], opencode: ['--log-level', 'debug'] } });
    const project = service.createProject({ name: 'Argument fixture', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Initial argv', description: 'INITIAL_ONLY', provider: 'codex', terminalMode: 'stream' });
    const run = service.startTask(task.id); await waitFor(() => existsSync(proof));
    const first = JSON.parse(readFileSync(proof, 'utf8').trim()); const pid = service.run(run.id).pid;
    expect(first.args).toContain('--yolo'); expect(first.args.find((value: string) => value.startsWith('qa_note='))).toBe(literal); expect(first.args).not.toContain('--sandbox'); expect(first.args.join(' ')).not.toContain('sandbox_mode='); expect(first.args).not.toContain('--verbose'); expect(first.args).not.toContain('--log-level');
    service.updateSettings({ providerArgs: { codex: ['--yolo', '--config', 'qa_note="NEW_ARG_VALUE"'] } });
    expect(service.run(run.id).pid).toBe(pid); expect(service.snapshot().runs).toHaveLength(1);
    writeFileSync(release, 'finish'); await waitFor(() => service.run(run.id).status === 'completed');
    await service.close(); services.splice(services.indexOf(service), 1);
    service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: home, claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
    expect(service.snapshot().settings.providerArgs.claude).toEqual(['--verbose']); expect(service.snapshot().settings.providerArgs.opencode).toEqual(['--log-level', 'debug']);
    await service.sendTaskMessage(task.id, { text: 'RESUME_ONLY', authorType: 'user', continueSession: true });
    await waitFor(() => service.snapshot().runs.at(-1)?.status === 'completed');
    const rows = readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line)); expect(rows).toHaveLength(2);
    expect(rows[1].args.slice(0, 2)).toEqual(['exec', 'resume']); expect(rows[1].args).toContain(sessionId); expect(rows[1].args).toContain('qa_note="NEW_ARG_VALUE"'); expect(rows[1].args).not.toContain(literal); expect(rows[1]).toMatchObject({ cwd: workspace, home, runId: service.snapshot().runs.at(-1)!.id });
    expect(rows[1].input).toContain('RESUME_ONLY'); expect(rows[1].input).not.toContain('INITIAL_ONLY'); expect(service.snapshot().tasks).toHaveLength(1); expect(existsSync(join(workspace, 'not_a_command'))).toBe(false);
  }, 20000);

  it('passes configured arguments through a real native PTY and keeps terminal input interactive', async () => {
    const { root, workspace, bin } = fixture(), proof = join(workspace, 'pty.json');
    providerShim(bin, `require('node:fs').writeFileSync(${JSON.stringify(proof)},JSON.stringify({args:process.argv.slice(2),inputTTY:process.stdin.isTTY,outputTTY:process.stdout.isTTY}));process.stdin.setRawMode(true);process.stdout.write('ARG-PTY-READY\\r\\n');process.stdin.on('data',data=>{if(data.toString().includes('q'))process.exit(0)});setInterval(()=>{},1000);`);
    const at = new Date().toISOString(), project: Project = { id: 'project-pty', name: 'PTY', description: '', repositoryPath: workspace, github: null, createdAt: at, updatedAt: at };
    const task: Task = { id: 'task-pty', projectId: project.id, title: 'PTY', description: '', provider: 'codex', status: 'ready', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: at, updatedAt: at };
    const run: Run = { id: 'run-pty', taskId: task.id, provider: 'codex', terminalMode: 'pty', status: 'running', startedAt: at, finishedAt: null, exitCode: null, executionMode: 'native', inputDirectory: root, pendingCommands: [], continuation: 0 };
    let output = '', exit: number | undefined;
    const handle = launchRuntime(project, task, run, 'fixture prompt', { image: 'unused', controlUrl: 'http://127.0.0.1:1', providerArgs: { ...empty(), codex: ['--yolo', '--config', 'qa_note="PTY literal value"'] } }, { output: (_stream, text) => { output += text; }, close: code => { exit = code; } }); handles.push(handle);
    await waitFor(() => existsSync(proof) && output.includes('ARG-PTY-READY'), 20000); const captured = JSON.parse(readFileSync(proof, 'utf8'));
    expect(captured).toMatchObject({ inputTTY: true, outputTTY: true }); expect(captured.args).toContain('--yolo'); expect(captured.args.find((value: string) => value.startsWith('qa_note='))).toBe('qa_note="PTY literal value"'); expect(captured.args).not.toContain('--sandbox'); expect(captured.args.at(-2)).toBe('--');
    handle.resize?.(110, 35); handle.input?.('q'); await waitFor(() => exit !== undefined); expect(exit).toBe(0);
  }, 25000);

  it('keeps provider extras after the Docker image, preserves original resume identity and leaves command argv separate', () => {
    const { workspace } = fixture(), at = new Date().toISOString(), id = randomUUID();
    const project: Project = { id: 'project', name: 'Offline', description: '', repositoryPath: workspace, github: null, createdAt: at, updatedAt: at };
    const task: Task = { id: 'task', projectId: project.id, title: 'Task', description: '', provider: 'codex', status: 'ready', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: at, updatedAt: at };
    const run: Run = { id: 'run', taskId: task.id, provider: 'codex', terminalMode: 'stream', status: 'running', startedAt: at, finishedAt: null, exitCode: null, executionMode: 'docker', pendingCommands: [], continuation: 0 };
    const options = { image: 'fixture-worker:local', controlUrl: 'http://control:4317', providerArgs: { codex: ['--yolo'], claude: ['--verbose'], opencode: ['--log-level', 'debug'] } };
    const docker = prepareRuntime(project, task, run, 'prompt', options), boundary = docker.args.indexOf(options.image);
    expect(docker.executable).toBe('docker'); expect(docker.args.slice(boundary + 1, boundary + 3)).toEqual(['codex', 'exec']); expect(docker.args.slice(0, boundary)).not.toContain('--yolo'); expect(docker.args.slice(boundary + 1)).toContain('--yolo'); expect(docker.args).not.toContain('--verbose');
    const resumed = prepareRuntime(project, task, { ...run, executionMode: 'native', terminalMode: 'pty', historyResume: { provider: 'codex', sessionId: id, sourceId: 'source', initialMessage: '' } }, '', options);
    expect(resumed.args.slice(0, 2)).toEqual(['resume', id]); expect(resumed.args).toContain('--yolo'); expect(resumed.args).not.toContain('--sandbox'); expect(resumed.args.slice(resumed.args.indexOf('--cd'), resumed.args.indexOf('--cd') + 2)).toEqual(['--cd', workspace]);
    const command = prepareRuntime(project, { ...task, provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }, { ...run, provider: 'command', executionMode: 'native' }, '', options);
    expect(command.args).toEqual(['-e', 'process.exit(0)']);
  });
});
