import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startControlServer, type RunningControlServer } from '../server.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
const SESSION = '0f4c6f9e-5b1a-4c3e-9a51-2d7f3b8c1e42';
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error('Timed out awaiting the provider answer.');
}
/** A Codex stand-in that, like a real agent, reports completion first and answers afterwards. */
function installFakeCodex(root: string): string {
  const bin = join(root, 'bin'); mkdirSync(bin); const proof = join(root, 'invocations.jsonl'); const script = join(bin, 'codex.cjs');
  writeFileSync(script, `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{
    const args=process.argv.slice(2),resume=args.includes('resume');
    require('node:fs').appendFileSync(${JSON.stringify(proof)},JSON.stringify({args,input})+'\\n');
    const line=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    line({type:'thread.started',thread_id:${JSON.stringify(SESSION)}});
    if(!resume){line({type:'item.completed',item:{type:'agent_message',text:'First answer'}});return;}
    await fetch(process.env.AIWS_CONTROL_URL+'/api/runs/'+process.env.AIWS_RUN_ID+'/complete',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AIWS_CONTROL_TOKEN},body:JSON.stringify({summary:'Greeted the user.'})});
    await new Promise(done=>setTimeout(done,600));
    line({type:'item.completed',item:{type:'agent_message',text:'Selam! Seni duyuyorum.'}});
    line({type:'turn.completed'});
  });`);
  const launcher = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  writeFileSync(launcher, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey] ?? ''}`);
  return proof;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('explicit completion before the final answer', () => {
  it('keeps a continued provider session alive until its answer reaches the conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-completion-')); roots.push(root);
    const workspace = join(root, 'workspace'); mkdirSync(workspace); const proof = installFakeCodex(root);
    const server = await startControlServer({ port: 0, token: 'completion-token', dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); servers.push(server);
    const { service } = server;
    const project = service.createProject({ name: 'Answer', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Greeting', description: 'Say hello', provider: 'codex', terminalMode: 'stream' });
    const first = service.startTask(task.id);
    await waitFor(() => service.run(first.id), (run) => run.status === 'completed');
    expect(service.run(first.id).sessionId).toBe(SESSION);
    const pointer = { session: { id: 'hist_source', sessionId: SESSION, provider: 'codex' as const, cwd: workspace }, path: '', root: '' };
    vi.spyOn(service.history, 'findSession').mockResolvedValue(pointer as any); vi.spyOn(service.history, 'assertResume').mockImplementation(() => {});

    await service.sendTaskMessage(task.id, { text: 'Beni duyuyorsan selam ver', continueSession: true });
    const resumed = service.run(service.task(task.id).currentRunId!);
    expect(resumed.id).not.toBe(first.id); expect(resumed.historyResume?.sessionId).toBe(SESSION);
    await waitFor(() => service.run(resumed.id).status, (status) => status === 'completed');
    // The completion arrived first; the answer must still be recorded, not cut off with the process.
    const messages = await waitFor(() => service.snapshot().messages.filter((message) => message.runId === resumed.id), (items) => items.some((message) => message.authorType === 'agent' && message.text === 'Selam! Seni duyuyorum.'));
    expect(messages.map((message) => message.authorType)).toEqual(expect.arrayContaining(['user', 'system', 'agent']));
    expect(service.task(task.id)).toMatchObject({ currentRunId: resumed.id, status: 'review' });
    const invocations = readFileSync(proof, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(invocations[1].args).toEqual(expect.arrayContaining(['exec', 'resume', SESSION]));
    expect(invocations[1].input).toContain('Beni duyuyorsan selam ver');
  }, 40000);

  it('copies the final native terminal answer from the provider session into the conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-completion-')); roots.push(root);
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') } }); servers.push(server);
    const { service } = server; const project = service.createProject({ name: 'Native', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Native answer', provider: 'codex', terminalMode: 'pty' });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const run = { id: 'run_native', taskId: task.id, status: 'completed', provider: 'codex', startedAt, finishedAt: new Date().toISOString(), exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', sessionId: SESSION, workspacePath: workspace } as any;
    service.store.state.runs.push(run);
    vi.spyOn(service.history, 'findSession').mockResolvedValue({ session: { id: 'hist_source', sessionId: SESSION, provider: 'codex', cwd: workspace }, path: '', root: '' } as any);
    const line = (text: string, createdAt: string) => ({ id: text, runId: 'hist_source', taskId: null, type: 'stdout', message: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`, createdAt });
    vi.spyOn(service.history, 'readPointer').mockResolvedValue({ messages: [], events: [line('Old answer', new Date(Date.now() - 120_000).toISOString()), line('Selam! Buradayım.', new Date().toISOString())], warnings: [], nextCursor: null } as any);
    await (service as any).completion.captureNativeAnswer(run); await (service as any).completion.captureNativeAnswer(run);
    expect(service.snapshot().messages.filter((message) => message.runId === run.id && message.authorType === 'agent').map((message) => message.text)).toEqual(['Selam! Buradayım.']);
  });

  it('lets a new instruction take over a completed run that is still finishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-completion-')); roots.push(root);
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const server = await startControlServer({ port: 0, token: 'completion-token', dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') } }); servers.push(server);
    const { service } = server;
    const project = service.createProject({ name: 'Takeover', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Linger', provider: 'command', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, terminalMode: 'stream' });
    const run = service.startTask(task.id);
    await waitFor(() => service.run(run.id).pid, (pid) => Boolean(pid));
    service.complete(run.id, { summary: 'Done' });
    expect(service.run(run.id).status).toBe('completed');
    await service.sendTaskMessage(task.id, { text: 'Next step', continueSession: true, allowHistoryFallback: true });
    const next = service.task(task.id).currentRunId!;
    expect(next).not.toBe(run.id); expect(service.run(next).status).toBe('running');
  }, 40000);
});
