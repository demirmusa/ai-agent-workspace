import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startControlServer, type RunningControlServer } from '../server.js';
import { findExecutable } from '../../shared/core/command.js';
import { renderTerminalScreen } from '../terminal-screen.js';

const roots: string[] = []; const servers: RunningControlServer[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-project-terminals-')); roots.push(root); return root; }
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error('Timed out awaiting terminal state.');
}
/** Terminal output without the escape sequences ConPTY puts around text, also at the start of lines. */
const plain = (output: string): string => output.replace(/\u001b(?:\][^\u0007]*\u0007|\[[0-?]*[ -/]*[@-~])/g, '');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Puts a fake agent CLI first on PATH; the PTY helper comes from the shared test setup. */
function fixture(root: string, names: string[]): { proof: (name: string) => string } {
  const bin = join(root, 'bin'), proofs = join(root, 'proofs'); mkdirSync(bin); mkdirSync(proofs);
  const script = join(bin, 'fake-agent.cjs');
  // An interactive stand-in for an agent TUI: it records how it was started and talks over the PTY.
  writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');const [name,...args]=process.argv.slice(2);
fs.writeFileSync(path.join(${JSON.stringify(proofs)},name+'-'+process.pid+'.json'),JSON.stringify({name,args,cwd:process.cwd(),pid:process.pid,tty:process.stdin.isTTY,aiws:Object.keys(process.env).filter(key=>key.startsWith('AIWS_'))}));
process.stdin.setRawMode(true);process.stdout.write(name.toUpperCase()+'-TUI-READY\\r\\n');
process.stdin.on('data',data=>{const text=data.toString();if(text.includes('q'))process.exit(4);process.stdout.write('AGENT-HEARD:'+text.trim()+'\\r\\n');});`);
  for (const name of names) {
    if (process.platform === 'win32') writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" ${name} %*\r\n`);
    else writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  vi.stubEnv(pathKey, bin + delimiter + (process.env[pathKey] ?? ''));
  vi.stubEnv('AIWS_TERMINAL_SECRET', 'must-not-leak');
  return { proof: (name) => { const file = readdirSync(proofs).find((entry) => entry.startsWith(`${name}-`)); return file ? join(proofs, file) : ''; } };
}

describe('project agent terminals', () => {
  it('finds commands on PATH without spawning a process', async () => {
    const root = temp(); fixture(root, ['codex']);
    expect(await findExecutable('codex')).toBe(join(root, 'bin', process.platform === 'win32' ? 'codex.cmd' : 'codex'));
    expect(await findExecutable('aiws-definitely-missing-cli')).toBeNull();
  });

  it('lists agent CLIs, starts the interactive TUI in the project folder with configured arguments, and kills it on close', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const { proof } = fixture(root, ['codex']);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const api = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(server.url + '/api' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; };
    server.service.updateSettings({ providerArgs: { codex: ['--model', 'gpt-test'] } });
    const project = server.service.createProject({ name: 'Agent terminal', repositoryPath: workspace });

    const agents = (await api('/terminal-agents?refresh=1')).data as Array<{ provider: string; available: boolean; path?: string; reason?: string }>;
    expect(agents.map((agent) => agent.provider)).toEqual(['codex', 'claude', 'opencode', 'agy', 'copilot']);
    expect(agents[0]).toMatchObject({ provider: 'codex', available: true, path: join(root, 'bin', process.platform === 'win32' ? 'codex.cmd' : 'codex') });
    for (const agent of agents.filter((item) => !item.available)) expect(agent.reason).toContain('PATH');

    expect((await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'agent', provider: 'unknown' })).status).toBe(400);
    const created = await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'agent', provider: 'codex' });
    expect(created.status).toBe(201);
    const run = created.data;
    expect(run).toMatchObject({ terminalKind: 'agent', provider: 'codex', title: 'Codex', status: 'running', taskId: '', workspacePath: workspace });
    await waitFor(() => server.service.projectTerminals.terminal(project.id, run.id).output, (output) => output.includes('CODEX-TUI-READY'));
    const started = JSON.parse(readFileSync(await waitFor(() => proof('codex'), Boolean), 'utf8'));
    // Interactive mode: no exec/print subcommand or prompt, only the configured CLI arguments.
    expect(started.args).toEqual(['--model', 'gpt-test']); expect(started.cwd).toBe(workspace); expect(started.tty).toBe(true);
    expect(started.aiws.filter((key: string) => !['AIWS_EXECUTABLE', 'AIWS_EXEC_ARGS'].includes(key))).toEqual(['AIWS_CONTROL_URL']); // The service's address, besides the Windows launcher's own variables.
    expect(server.service.snapshot().tasks).toHaveLength(0); expect(server.service.snapshot().runs).toHaveLength(0);

    expect((await api(`/projects/${project.id}/terminals/${run.id}/input`, 'POST', { data: 'hello\r' })).status).toBe(200);
    await waitFor(() => server.service.projectTerminals.terminal(project.id, run.id).output, (output) => output.includes('AGENT-HEARD:hello'));
    expect((await api(`/projects/${project.id}/terminals/${run.id}`, 'PATCH', { title: 'Reviewer' })).data.title).toBe('Reviewer');
    expect((await api(`/projects/${project.id}/terminals/${run.id}`, 'PATCH', { title: '' })).status).toBe(400);
    expect((await api(`/projects/${project.id}/terminals/${run.id}/restart`, 'POST', {})).status).toBe(409);

    expect(alive(started.pid)).toBe(true);
    expect((await api(`/projects/${project.id}/terminals/${run.id}`, 'DELETE')).status).toBe(200);
    expect(server.service.projectTerminals.list(project.id)).toHaveLength(0);
    await waitFor(() => alive(started.pid), (value) => !value, 10000);
  }, 40000);

  it('kills the shell and every process it started when the terminal is closed', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    fixture(root, []);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const project = server.service.createProject({ name: 'Tree kill', repositoryPath: workspace });
    const run = await server.service.projectTerminals.create(project, { kind: 'shell' });
    const pidFile = join(root, 'child.pid'), childScript = join(root, 'child.cjs');
    writeFileSync(childScript, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
    const quoted = JSON.stringify(process.execPath.replaceAll('\\', '/')), script = JSON.stringify(childScript.replaceAll('\\', '/'));
    server.service.projectTerminals.input(project.id, run.id, { data: (process.platform === 'win32' ? `& ${quoted} ${script}` : `${quoted} ${script}`) + '\r' });
    const child = Number(await waitFor(() => existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '', Boolean));
    expect(alive(child)).toBe(true);
    await server.service.projectTerminals.remove(project.id, run.id);
    await waitFor(() => alive(child), (value) => !value, 10000);
  }, 40000);

  it('saves images pasted into a project terminal in the project work folder', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    fixture(root, []);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const project = server.service.createProject({ name: 'Images', repositoryPath: workspace });
    const run = await server.service.projectTerminals.create(project, { kind: 'shell' });
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const response = await fetch(`${server.url}/api/projects/${project.id}/terminals/${run.id}/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: png.toString('base64') }) });
    expect(response.status).toBe(201);
    const image = await response.json() as { id: string; path: string };
    expect(image.path).toBe(join(project.repositoryPath, '.aiws', 'attachments', image.id));
    expect(readFileSync(image.path)).toEqual(png);
    expect(readFileSync(join(workspace, '.aiws', '.gitignore'), 'utf8')).toContain('*');
    await server.service.projectTerminals.remove(project.id, run.id);
  }, 40000);

  it('restarts an exited agent terminal in place and keeps its output stream', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const { proof } = fixture(root, ['claude']);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const project = server.service.createProject({ name: 'Restart', repositoryPath: workspace });
    const run = await server.service.projectTerminals.create(project, { kind: 'agent', provider: 'claude', title: 'Claude review' });
    expect(run.title).toBe('Claude review');
    const output = () => server.service.projectTerminals.terminal(project.id, run.id).output;
    await waitFor(output, (value) => value.includes('CLAUDE-TUI-READY'));
    const first = JSON.parse(readFileSync(await waitFor(() => proof('claude'), Boolean), 'utf8'));
    server.service.projectTerminals.input(project.id, run.id, { data: 'q' });
    const exited = await waitFor(() => server.service.projectTerminals.list(project.id)[0]!, (item) => item.status !== 'running');
    expect(exited).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(() => server.service.projectTerminals.input(project.id, run.id, { data: 'x' })).toThrow('exited');
    const length = server.service.projectTerminals.terminal(project.id, run.id).end;
    const restarted = await server.service.projectTerminals.restart(project.id, run.id);
    expect(restarted).toMatchObject({ id: run.id, status: 'running', exitCode: null });
    await waitFor(output, (value) => value.split('CLAUDE-TUI-READY').length === 3);
    expect(output()).toContain('restarted');
    expect(server.service.projectTerminals.terminal(project.id, run.id).end).toBeGreaterThan(length);
    expect(existsSync(proof('claude'))).toBe(true);
    // Each start gets its own known session ID, so the conversation can later continue as a task.
    expect(first.args).toEqual(['--session-id', run.sessionId]); expect(restarted.sessionId).not.toBe(run.sessionId);
    await server.service.projectTerminals.remove(project.id, run.id);
  }, 40000);

  it('opens the terminals of the previous service run again: agents resume their session, shells and scripts carry on below their output', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const { proof } = fixture(root, ['claude']);
    const dataDir = join(root, 'data');
    const first = await startControlServer({ port: 0, dataDir }); servers.push(first);
    const project = first.service.createProject({ name: 'Resume', repositoryPath: workspace });
    const agent = await first.service.projectTerminals.create(project, { kind: 'agent', provider: 'claude', title: 'Claude chat' });
    const shell = await first.service.projectTerminals.create(project, { kind: 'shell', title: 'Build shell' });
    const exited = await first.service.projectTerminals.create(project, { kind: 'agent', provider: 'claude', title: 'Done' });
    await waitFor(() => first.service.projectTerminals.terminal(project.id, agent.id).output, (value) => value.includes('CLAUDE-TUI-READY'));
    first.service.projectTerminals.input(project.id, agent.id, { data: 'hello' });
    await waitFor(() => first.service.projectTerminals.terminal(project.id, agent.id).output, (value) => value.includes('AGENT-HEARD:hello'));
    first.service.projectTerminals.input(project.id, exited.id, { data: 'q' });
    await waitFor(() => first.service.projectTerminals.list(project.id).find((item) => item.id === exited.id)!, (item) => item.status !== 'running');
    // The shell moves to another directory, and a script finishes in its own shell; both should carry on from there.
    const subfolder = join(workspace, 'sub'); mkdirSync(subfolder);
    first.service.projectTerminals.input(project.id, shell.id, { data: `cd ${JSON.stringify(subfolder)}; echo BEFORE-RESTART\r` });
    await waitFor(() => first.service.projectTerminals.terminal(project.id, shell.id).output, (value) => /^BEFORE-RESTART/m.test(plain(value)) && (process.platform !== 'win32' || /PS .*sub>\s*$/.test(plain(value))));
    writeFileSync(join(workspace, 'runs.log'), '');
    const withScript = first.service.updateProject(project.id, { runScripts: [{ name: 'Count', command: process.platform === 'win32' ? 'Add-Content runs.log x; echo SCRIPT-RAN' : 'echo x >> runs.log; echo SCRIPT-RAN' }] });
    const scripted = await first.service.projectTerminals.create(withScript, { kind: 'script', scriptId: withScript.runScripts![0]!.id });
    await waitFor(() => first.service.projectTerminals.terminal(project.id, scripted.id).output, (value) => /^SCRIPT-RAN/m.test(plain(value)));
    await waitFor(() => readFileSync(join(workspace, 'runs.log'), 'utf8'), (value) => value.includes('x'));
    while (proof('claude')) rmSync(proof('claude'), { force: true });
    await first.close(); servers.splice(servers.indexOf(first), 1);

    const second = await startControlServer({ port: 0, dataDir }); servers.push(second);
    const list = () => second.service.projectTerminals.list(project.id);
    // Closing stored the still-open terminals as interrupted, with their output; the new service lists them all at once.
    expect(list().map(({ id, status }) => ({ id, status: status === 'interrupted' ? 'running' : status }))).toEqual([{ id: agent.id, status: 'running' }, { id: shell.id, status: 'running' }, { id: exited.id, status: 'failed' }, { id: scripted.id, status: 'running' }]);
    const resumed = await waitFor(() => list().find((item) => item.id === agent.id)!, (item) => item.status === 'running');
    expect(resumed).toMatchObject({ title: 'Claude chat', terminalKind: 'agent', sessionId: agent.sessionId });
    const output = () => second.service.projectTerminals.terminal(project.id, agent.id).output;
    await waitFor(output, (value) => value.split('CLAUDE-TUI-READY').length === 3);
    expect(output()).toContain('AGENT-HEARD:hello'); expect(output()).toContain('---resumed---');
    // The conversation continues in the same provider session.
    const relaunched = JSON.parse(readFileSync(await waitFor(() => proof('claude'), Boolean), 'utf8'));
    expect(relaunched.args).toEqual(['--resume', agent.sessionId]);
    expect(list().find((item) => item.id === exited.id)).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(second.service.projectTerminals.terminal(project.id, exited.id).output).not.toContain('---resumed---');
    // A shell carries on below its output without a note, and on Windows without clearing it or asking the screen for the cursor.
    await waitFor(() => list().find((item) => item.id === shell.id)!, (item) => item.status === 'running');
    const shellOutput = () => second.service.projectTerminals.terminal(project.id, shell.id).output;
    expect(shellOutput()).toContain('BEFORE-RESTART');
    second.service.projectTerminals.input(project.id, shell.id, { data: 'echo AFTER-$PWD-RESTART\r' });
    const carriedOn = await waitFor(shellOutput, (value) => /^AFTER-.*-RESTART/m.test(plain(value)));
    expect(carriedOn).not.toContain('---resumed---'); expect(carriedOn).not.toContain('AIWS:');
    if (process.platform === 'win32') {
      expect(plain(carriedOn)).toMatch(/^AFTER-.*[\\/]sub-RESTART/m); // POSIX prompts do not name the directory reliably.
      expect(carriedOn).not.toContain('\u001b[6n');
      expect(carriedOn.slice(carriedOn.indexOf('BEFORE-RESTART'))).not.toContain('\u001b[2J');
      // On the screen the old output stays where it was, with the new shell's lines below it.
      const screen = renderTerminalScreen(carriedOn, 30, 100), before = screen.findIndex((line) => line.startsWith('BEFORE-RESTART')), after = screen.findIndex((line) => line.startsWith('AFTER-'));
      expect(before).toBeGreaterThanOrEqual(0); expect(after).toBeGreaterThan(before);
    }
    // A script terminal is a live shell again, but its script is not run a second time.
    await waitFor(() => list().find((item) => item.id === scripted.id)!, (item) => item.status === 'running');
    const scriptOutput = () => second.service.projectTerminals.terminal(project.id, scripted.id).output;
    second.service.projectTerminals.input(project.id, scripted.id, { data: 'echo STILL-OPEN\r' });
    await waitFor(scriptOutput, (value) => /^STILL-OPEN/m.test(plain(value)));
    expect(readFileSync(join(workspace, 'runs.log'), 'utf8').trim()).toBe('x');
    second.service.projectTerminals.input(project.id, agent.id, { data: 'again' });
    await waitFor(output, (value) => value.includes('AGENT-HEARD:again'));
    // Closing a terminal removes it from the stored state as well.
    await second.service.projectTerminals.remove(project.id, exited.id);
    await second.service.store.flush();
    expect(second.service.store.readPersisted().terminals.map((item) => item.id)).toEqual([agent.id, shell.id, scripted.id]);
  }, 60000);

  it('reopens a finished run session in an agent terminal of its workspace', async () => {
    const root = temp(); const workspace = join(root, 'workspace'), worktree = join(root, 'worktree'); mkdirSync(workspace); mkdirSync(worktree);
    const { proof } = fixture(root, ['claude']);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const api = async (path: string) => { const response = await fetch(server.url + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: response.status, data: await response.json() as any }; };
    const project = server.service.createProject({ name: 'Session', repositoryPath: workspace });
    const task = server.service.createTask({ projectId: project.id, title: 'Ask later', provider: 'claude' });
    const run = { id: 'run_session', taskId: task.id, provider: 'claude', sessionId: 'session-1234', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', workspacePath: worktree, pendingCommands: [], continuation: 0 };
    server.service.store.state.runs.push(run as never);
    expect((await api(`/runs/${run.id}/session-terminal`)).status).toBe(409);
    run.status = 'failed';
    const opened = await api(`/runs/${run.id}/session-terminal`);
    expect(opened).toMatchObject({ status: 200, data: { terminalKind: 'agent', provider: 'claude', sessionId: 'session-1234', workspacePath: worktree } });
    const started = JSON.parse(readFileSync(await waitFor(() => proof('claude'), Boolean), 'utf8'));
    expect(started.args.slice(0, 2)).toEqual(['--resume', 'session-1234']); expect(started.args).not.toContain('--session-id');
    expect(started.cwd.toLowerCase()).toBe(worktree.toLowerCase());
    await expect(server.service.convertTerminalToTask(project.id, opened.data.id)).rejects.toThrow('existing session');
    await server.service.projectTerminals.remove(project.id, opened.data.id);
  }, 40000);

  it('stores named run scripts and runs the selected one in a terminal', async () => {
    const root = temp(); const workspace = join(root, 'workspace'); mkdirSync(join(workspace, 'tools'), { recursive: true });
    fixture(root, []);
    const windows = process.platform === 'win32', file = windows ? 'tools/hello.ps1' : 'tools/hello.sh';
    writeFileSync(join(workspace, file), windows ? 'Write-Output "SCRIPT-$($args.Count)-RAN"' : 'echo SCRIPT-0-RAN');
    writeFileSync(join(root, 'outside.ps1'), '');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { hello: 'echo NPM-RAN' } }));
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const api = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(server.url + '/api' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; };
    const project = server.service.createProject({ name: 'Scripts', repositoryPath: workspace });
    expect((await api(`/projects/${project.id}/script-candidates`)).data).toMatchObject({ files: [file], npm: [{ path: 'package.json', scripts: ['hello'] }] });

    for (const path of ['../outside.ps1', 'tools/missing.ps1', 'tools']) expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Bad', path }] })).status).toBeGreaterThanOrEqual(400);
    expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: ' ', path: file }] })).status).toBe(400);
    const saved = (await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Hello', path: file }] })).data;
    expect(saved.runScripts).toEqual([{ id: expect.any(String), name: 'Hello', path: file }]);
    expect(server.service.updateProject(project.id, { name: 'Scripts renamed' }).runScripts).toEqual(saved.runScripts);

    expect((await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'script', scriptId: 'nope' })).status).toBe(404);
    const created = await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'script', scriptId: saved.runScripts[0].id });
    expect(created.status).toBe(201); expect(created.data).toMatchObject({ terminalKind: 'script', title: 'Hello' });
    const output = () => server.service.projectTerminals.terminal(project.id, created.data.id).output;
    // The script line is typed into a normal shell, so the shell echoes it before the output.
    await waitFor(output, (value) => /hello\.(?:ps1|sh)/.test(value) && value.includes('SCRIPT-0-RAN'));
    const originalOutput = output();
    const restarted = await api(`/projects/${project.id}/terminals/${created.data.id}/restart`, 'POST', {});
    expect(restarted.status).toBe(200); expect(restarted.data).toMatchObject({ id: created.data.id, terminalKind: 'script', status: 'running' });
    await waitFor(output, (value) => value.split('SCRIPT-0-RAN').length === 3);
    expect(restarted.data.scriptArgs).toBeUndefined();
    expect(output()).toContain(originalOutput);
    expect(output()).not.toContain('---restarted---');
    await server.service.projectTerminals.remove(project.id, created.data.id);

    expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Nope', path: 'package.json', npmScript: 'missing' }] })).status).toBe(400);
    expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Nope', path: file, npmScript: 'hello' }] })).status).toBe(400);
    const npm = (await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Npm hello', path: 'package.json', npmScript: 'hello' }] })).data;
    expect(npm.runScripts[0]).toMatchObject({ path: 'package.json', npmScript: 'hello' });
    const npmRun = await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'script', scriptId: npm.runScripts[0].id });
    expect(npmRun.status).toBe(201);
    await waitFor(() => server.service.projectTerminals.terminal(project.id, npmRun.data.id).output, (value) => value.includes('NPM-RAN'));
    await server.service.projectTerminals.remove(project.id, npmRun.data.id);

    expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Empty', command: '  ' }] })).status).toBe(400);
    expect((await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Both', command: 'echo x', path: file }] })).status).toBe(400);
    const custom = (await api(`/projects/${project.id}`, 'PATCH', { runScripts: [{ name: 'Custom', command: ' echo CUSTOM-RAN ', args: 'in\nfolder' }] })).data;
    expect(custom.runScripts).toEqual([{ id: expect.any(String), name: 'Custom', command: 'echo CUSTOM-RAN', args: 'in\nfolder' }]);
    const customRun = await api(`/projects/${project.id}/terminals`, 'POST', { kind: 'script', scriptId: custom.runScripts[0].id });
    expect(customRun.status).toBe(201);
    // Windows consoles may set the window title and cursor state between the lines.
    await waitFor(() => server.service.projectTerminals.terminal(project.id, customRun.data.id).output,
      (value) => /CUSTOM-RAN\s+in\s+folder/.test(plain(value)));
    await server.service.projectTerminals.remove(project.id, customRun.data.id);
  }, 60000);
});
