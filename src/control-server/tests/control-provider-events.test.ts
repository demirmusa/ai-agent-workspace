import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { ControlService } from '../service.js';
import type { Provider, Run } from '../types.js';

const roots: string[] = []; const services: ControlService[] = [];
async function fixture(): Promise<{ service: ControlService; root: string; workspace: string }> {
  const root = mkdtempSync(join(tmpdir(), 'aiws-provider-events-')); roots.push(root);
  const bin = join(root, 'bin'); const workspace = join(root, 'workspace'); mkdirSync(bin); mkdirSync(workspace);
  const source = 'process.stdin.resume();process.stdout.write(require("node:fs").readFileSync("event.json","utf8"));';
  const script = join(bin, 'emit.cjs'); writeFileSync(script, source);
  for (const provider of ['codex', 'claude', 'opencode', 'copilot']) {
    const launcher = join(bin, process.platform === 'win32' ? `${provider}.ps1` : provider);
    writeFileSync(launcher, process.platform === 'win32' ? `& '${process.execPath.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}' @args\nexit $LASTEXITCODE\n` : `#!/usr/bin/env node\n${source}\n`);
    if (process.platform !== 'win32') chmodSync(launcher, 0o755);
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey] ?? ''}`);
  const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service); return { service, root, workspace };
}
async function finished(service: ControlService, runId: string): Promise<Run> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const run = service.run(runId); if (['completed', 'failed'].includes(run.status)) return run; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('Provider fixture did not finish.');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close())); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('provider stream failures', () => {
  it('captures the actual managed branch in an existing worktree, including a detached source checkout', async () => {
    const {service,workspace,root}=await fixture();
    const git=(...args:string[])=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',windowsHide:true});
    git('init','-b','main');git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','Initial');
    const worktree=join(root,'task-worktree');git('worktree','add','-b','feature/details',worktree);
    writeFileSync(join(worktree,'event.json'),'{}\n');
    execFileSync('git',['add','event.json'],{cwd:worktree,windowsHide:true});
    execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','Provider fixture'],{cwd:worktree,windowsHide:true});
    const project=service.createProject({useWorktree:false,name:'Worktree',repositoryPath:worktree,defaultBranch:'feature/details'});
    const first=service.createTask({projectId:project.id,title:'Inspect branch',provider:'codex',terminalMode:'stream',model:'gpt-6.1-sol'});
    const run=await finished(service,service.startTask(first.id).id);
    expect(run.executionInfo).toMatchObject({branch:`aiws/${first.id}`,detached:false,cwd:worktree,worktreePath:worktree.replaceAll('\\','/'),model:'gpt-6.1-sol'});
    execFileSync('git',['checkout','--detach'],{cwd:worktree,windowsHide:true,stdio:'ignore'});
    const second=service.createTask({projectId:project.id,title:'Inspect detached HEAD',provider:'codex',terminalMode:'stream'});
    const detached=await finished(service,service.startTask(second.id).id);
    expect(detached.executionInfo).toMatchObject({branch:`aiws/${second.id}`,detached:false});
  }, 20000);

  it('records the actual Claude model rather than the configured alias', async () => {
    const { service, workspace } = await fixture();
    writeFileSync(join(workspace, 'event.json'), JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'fixture-session' }) + '\n');
    const project = service.createProject({ name: 'Model labels', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Resolve model', provider: 'claude', terminalMode: 'stream', model: 'opus' });
    const run = await finished(service, service.startTask(task.id).id);
    expect(run.executionInfo).toMatchObject({ model: 'claude-opus-5-5', modelSource: 'reported', cwd: workspace });
    expect(run.executionInfo?.branch).toBeUndefined();
  });

  it('marks actual OpenCode structured auth errors as failed even when its process exits zero', async () => {
    const { service, workspace } = await fixture();
    // Shape captured from OpenCode 1.14.31 during the genuine provider acceptance run.
    writeFileSync(join(workspace, 'event.json'), JSON.stringify({ type: 'error', error: { name: 'UnknownError', data: { message: 'Token refresh failed: 401' } } }));
    const project = service.createProject({ name: 'OpenCode auth', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Provider failure', provider: 'opencode', terminalMode: 'stream' });
    const run = await finished(service, service.startTask(task.id).id);
    expect(run.exitCode).toBe(0); expect(run.status).toBe('failed'); expect(service.task(task.id).status).toBe('failed');
    expect(service.snapshot().events.some((event) => event.runId === run.id && event.type === 'provider.error' && event.message === 'Token refresh failed: 401')).toBe(true);
  });

  it('records GitHub Copilot messages, the reported model and a quota error that offers a handoff', async () => {
    const { service, workspace } = await fixture(); const project = service.createProject({ name: 'Copilot', repositoryPath: workspace });
    // Event shapes captured from GitHub Copilot CLI 1.0.100 (--output-format json).
    const line = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: type, timestamp: '2026-10-20T10:00:00Z' });
    const success = [line('session.tools_updated', { model: 'claude-sonnet-5.5' }), line('assistant.message', { messageId: 'm1', content: 'Updated the README.' }), JSON.stringify({ type: 'result', sessionId: 'c1296dcf-ba51-4a2f-9dda-98e25d0308d0', exitCode: 0 })];
    writeFileSync(join(workspace, 'event.json'), `${success.join('\n')}\n`);
    const done = service.createTask({ projectId: project.id, title: 'Copilot work', provider: 'copilot', terminalMode: 'stream' });
    const run = await finished(service, service.startTask(done.id).id);
    expect(run.status).toBe('completed'); expect(run.executionInfo).toMatchObject({ model: 'claude-sonnet-5.5', modelSource: 'reported' });
    expect(service.snapshot().messages.some((message) => message.runId === run.id && message.authorType === 'agent' && message.text === 'Updated the README.')).toBe(true);
    const quota = [line('session.error', { errorType: 'quota', message: 'You have exceeded your monthly quota (Request ID: 2885:30E838)', statusCode: 402 }), JSON.stringify({ type: 'result', sessionId: 'c1296dcf-ba51-4a2f-9dda-98e25d0308d0', exitCode: 1 })];
    writeFileSync(join(workspace, 'event.json'), `${quota.join('\n')}\n`);
    const limited = service.createTask({ projectId: project.id, title: 'Copilot quota', provider: 'copilot', terminalMode: 'stream' });
    const failed = await finished(service, service.startTask(limited.id).id);
    expect(failed.status).toBe('failed');
    expect(service.snapshot().events.some((event) => event.runId === failed.id && event.type === 'provider.error' && event.message.includes('exceeded your monthly quota'))).toBe(true);
    expect(service.task(limited.id).handoffRequest).toMatchObject({ runId: failed.id, provider: 'copilot' });
  }, 20000);

  it('detects Codex and Claude structured errors and never infers failure from assistant prose', async () => {
    const { service, workspace } = await fixture(); const project = service.createProject({ name: 'Provider protocols', repositoryPath: workspace });
    const scenarios: Array<{ provider: Provider; event: unknown; failed: boolean }> = [
      { provider: 'codex', event: { type: 'turn.failed', error: { message: 'Provider unavailable' } }, failed: true },
      { provider: 'codex', event: { type: 'error', message: 'Structured fatal error' }, failed: true },
      { provider: 'claude', event: { type: 'result', is_error: true, result: 'Provider unavailable' }, failed: true },
      { provider: 'codex', event: { type: 'item.completed', item: { type: 'agent_message', text: 'Fixed error handling successfully.' } }, failed: false },
      { provider: 'claude', event: { type: 'result', is_error: false, result: 'No error remains.' }, failed: false },
      { provider: 'opencode', event: { type: 'text', part: { text: 'I fixed the error.' } }, failed: false },
    ];
    for (const scenario of scenarios) {
      writeFileSync(join(workspace, 'event.json'), `${JSON.stringify(scenario.event)}\n`);
      const task = service.createTask({ projectId: project.id, title: 'Protocol fixture', provider: scenario.provider, terminalMode: 'stream' });
      const run = await finished(service, service.startTask(task.id).id);
      expect(run.exitCode).toBe(0); expect(run.status).toBe(scenario.failed ? 'failed' : 'completed');
      expect(service.task(task.id).status).toBe(scenario.failed ? 'failed' : 'review');
    }
  }, 20000);
});
