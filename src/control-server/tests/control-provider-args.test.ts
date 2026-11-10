import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { providerExecutionInfo, effectiveProviderArgs, emptyProviderArgs, validateProviderArgs } from '../provider-args.js';
import { prepareRuntime } from '../runner.js';
import { execCli, windowsLauncher } from '../windows-launch.js';
import type { Project, Run, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const task: Task = { id: 'task', projectId: 'project', title: 'Task', description: '', status: 'ready', priority: 0, provider: 'codex', dependsOn: [], autoStart: false, currentRunId: null, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z' };
const project: Project = { id: 'project', name: 'Project', description: '', repositoryPath: process.cwd(), github: null, createdAt: task.createdAt, updatedAt: task.updatedAt };
const run: Run = { id: 'run', taskId: task.id, status: 'running', provider: 'codex', startedAt: task.createdAt, finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'stream', pendingCommands: [], continuation: 0 };

describe('provider-scoped literal CLI argument settings', () => {
  it('migrates older settings, persists partial provider changes and clears one provider independently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiws-provider-settings-')); roots.push(directory);
    let service = new ControlService({ dataDir: directory }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
    const legacy = service.store.readPersisted() as any; delete legacy.settings.providerArgs; await service.close(); services.pop(); for (const name of ['control.db', 'control.db-wal', 'control.db-shm', 'settings.json']) rmSync(join(directory, name), { force: true }); writeFileSync(join(directory, 'state.json'), JSON.stringify(legacy));
    service = new ControlService({ dataDir: directory }); services.push(service); expect(service.snapshot().settings.providerArgs).toEqual(emptyProviderArgs());
    service.updateSettings({ providerArgs: { codex: ['--yolo', '--config', 'model_reasoning_effort="high"'], claude: ['--model', 'selected model with spaces'] } });
    service.updateSettings({ maxConcurrent: 5 }); service.updateSettings({ providerArgs: { opencode: ['--variant=high'] } });
    await service.close(); services.pop(); service = new ControlService({ dataDir: directory }); services.push(service);
    expect(service.snapshot().settings.providerArgs).toEqual({ codex: ['--yolo', '--config', 'model_reasoning_effort="high"'], claude: ['--model', 'selected model with spaces'], opencode: ['--variant=high'], agy: [], copilot: [] });
    expect(service.updateSettings({ providerArgs: { codex: [] } }).providerArgs).toEqual({ codex: [], claude: ['--model', 'selected model with spaces'], opencode: ['--variant=high'], agy: [], copilot: [] });
  });

  it('validates bounds and original session/project/protocol options before mutating settings', () => {
    expect(() => validateProviderArgs({ codex: Array(65).fill('--yolo') })).toThrow('64');
    expect(() => validateProviderArgs({ codex: ['--config', 'x'.repeat(4097)] })).toThrow('4096');
    expect(() => validateProviderArgs({ codex: ['--bad\0arg'] })).toThrow('NUL');
    expect(() => validateProviderArgs({ codex: ['--yolo\n--search'] })).toThrow('newlines');
    expect(() => validateProviderArgs({ codex: ['resume', 'another-session'] })).toThrow('options');
    for (const [provider, args] of [['codex', ['--cd', '/different']], ['codex', ['-C/different']], ['codex', ['--last']], ['codex', ['--config', 'cwd="/different"']], ['claude', ['--resume', 'another-session']], ['opencode', ['--session=another-session']], ['agy', ['--resume', 'another-session']]] as const) expect(() => validateProviderArgs({ [provider]: args })).toThrow('managed');
  });

  it('keeps explicit profile/task model precedence without duplicate long, equal or short model options', () => {
    for (const args of [['--model', 'global'], ['--model=global'], ['-m', 'global'], ['-mglobal']]) {
      const map = validateProviderArgs({ codex: ['--yolo', ...args, '--config', 'model_reasoning_effort="high"'] });
      expect(effectiveProviderArgs('codex', map, 'task-model')).toEqual(['--yolo', '--config', 'model_reasoning_effort="high"']);
      const prepared = prepareRuntime(project, { ...task, model: 'task-model' }, run, 'Only the task prompt', { image: 'worker', controlUrl: '', providerArgs: map });
      expect(prepared.args.filter((arg) => arg === '--model')).toHaveLength(1); expect(prepared.args).toContain('task-model'); expect(prepared.args.join(' ')).not.toContain('global');
    }
  });

  it('applies a task reasoning level in each provider’s own option, replacing the work-setting level', () => {
    const map = validateProviderArgs({ codex: ['--config', 'model_reasoning_effort="high"'], claude: ['--effort', 'low'], opencode: ['--variant=high'] });
    expect(effectiveProviderArgs('codex', map, undefined, false, 'minimal')).toEqual(['-c', 'model_reasoning_effort="minimal"']);
    expect(effectiveProviderArgs('claude', map, undefined, false, 'max')).toEqual(['--effort', 'max']);
    expect(effectiveProviderArgs('opencode', map, undefined, false, 'low')).toEqual(['--variant', 'low']);
    // A level the provider does not offer leaves the work settings in charge.
    expect(effectiveProviderArgs('claude', map, undefined, false, 'minimal')).toEqual(['--effort', 'low']);
    expect(providerExecutionInfo('codex', map, 'task-model', 'xhigh')).toEqual({ model: 'task-model', modelSource: 'configured', reasoningEffort: 'xhigh' });
    const codex = prepareRuntime(project, task, { ...run, executionSnapshot: { agent: null, skills: [], provider: 'codex', model: 'task-model', reasoningEffort: 'low', instructions: '', context: '', task: { title: 'Task', description: '' }, createdAt: task.createdAt } }, 'Work', { image: 'worker', controlUrl: '', providerArgs: map });
    expect(codex.args).toContain('model_reasoning_effort="low"'); expect(codex.args).not.toContain('model_reasoning_effort="high"');
    const claude = prepareRuntime(project, { ...task, provider: 'claude', reasoningEffort: 'high' }, { ...run, provider: 'claude', terminalMode: 'pty' }, 'Work', { image: 'worker', controlUrl: '' });
    expect(claude.args.slice(claude.args.indexOf('--effort'), claude.args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']); expect(claude.args.indexOf('--effort')).toBeLessThan(claude.args.indexOf('--'));
  });

  it('stores a task reasoning level for the effective provider and drops it when the provider no longer offers it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiws-task-reasoning-')); roots.push(directory);
    const service = new ControlService({ dataDir: join(directory, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
    const created = service.createProject({ name: 'Reasoning', repositoryPath: directory });
    const item = service.createTask({ projectId: created.id, title: 'Think', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'max' });
    expect(item.reasoningEffort).toBe('max');
    expect((service as any).execution.resolve(item)).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'max' });
    expect(() => service.updateTask(item.id, { reasoningEffort: 'minimal' })).toThrow(/low, medium, high, xhigh, max/);
    expect(service.updateTask(item.id, { provider: 'copilot' }).reasoningEffort).toBeUndefined();
    expect(service.updateTask(item.id, { reasoningEffort: 'high' }).reasoningEffort).toBe('high');
    expect(service.updateTask(item.id, { provider: 'codex' }).reasoningEffort).toBe('high');
    expect(service.updateTask(item.id, { reasoningEffort: null }).reasoningEffort).toBeUndefined();
  });

  it('keeps a reasoning level on agent profiles and schedules and applies it where the task does not choose one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiws-agent-reasoning-')); roots.push(directory);
    const service = new ControlService({ dataDir: join(directory, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
    const created = service.createProject({ name: 'Reasoning', repositoryPath: directory });
    const agent = service.catalog.createAgent({ name: 'Thinker', provider: 'claude', reasoningEffort: 'high' });
    expect(agent.reasoningEffort).toBe('high');
    expect(() => service.catalog.updateAgent(agent.id, { reasoningEffort: 'minimal' })).toThrow(/low, medium, high, xhigh, max/);
    const inherited = service.createTask({ projectId: created.id, title: 'Inherit', agentId: agent.id });
    expect((service as any).execution.resolve(inherited)).toMatchObject({ provider: 'claude', reasoningEffort: 'high' });
    const chosen = service.createTask({ projectId: created.id, title: 'Choose', agentId: agent.id, reasoningEffort: 'low' });
    expect((service as any).execution.resolve(chosen)).toMatchObject({ reasoningEffort: 'low' });
    // Another provider does not inherit the profile's level.
    expect((service as any).execution.resolve(service.updateTask(inherited.id, { provider: 'codex' })).reasoningEffort).toBeUndefined();
    expect(service.catalog.updateAgent(agent.id, { provider: 'copilot' }).reasoningEffort).toBe('high');
    expect(service.catalog.updateAgent(agent.id, { provider: 'agy', reasoningEffort: null }).reasoningEffort).toBeUndefined();
    const schedule = service.schedules.create({ projectId: created.id, recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'Nightly', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' } });
    expect(schedule.task.reasoningEffort).toBe('xhigh');
    expect(service.schedules.runNow(schedule.id)).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' });
  });

  it('passes runtime --yolo while retaining the separate read-only planning boundary and command isolation', () => {
    const map = validateProviderArgs({ codex: ['--yolo', '-c', 'sandbox_mode="danger-full-access"', '--config', 'model_reasoning_effort="high"'], claude: ['--dangerously-skip-permissions'], opencode: ['--variant=high'], agy: ['--effort', 'high', '--mode', 'auto'] });
    const execution = prepareRuntime(project, task, run, 'Work', { image: 'worker', controlUrl: '', providerArgs: map });
    expect(execution.args).toContain('--yolo'); expect(execution.args).not.toContain('--sandbox'); expect(execution.args).not.toContain('sandbox_mode=workspace-write'); expect(execution.args).toContain('sandbox_mode="danger-full-access"');
    const planning = prepareRuntime(project, task, run, 'Plan', { image: 'worker', controlUrl: '', providerArgs: map, readOnly: true });
    expect(planning.args).toContain('read-only'); expect(planning.args).not.toContain('--yolo'); expect(planning.args).not.toContain('sandbox_mode="danger-full-access"'); expect(planning.args).toContain('model_reasoning_effort="high"');
    const agyPlanning = prepareRuntime(project, { ...task, provider: 'agy' }, { ...run, provider: 'agy' }, 'Plan', { image: 'worker', controlUrl: '', providerArgs: map, readOnly: true });
    expect(agyPlanning.args).toContain('plan'); expect(agyPlanning.args).not.toContain('--dangerously-skip-permissions'); expect(agyPlanning.args.slice(-2)).toEqual(['--print', 'Plan']);
    const agyTerminal = prepareRuntime(project, { ...task, provider: 'agy', model: 'gemini-4-argon-medium' }, { ...run, provider: 'agy', terminalMode: 'pty' }, 'Work', { image: 'worker', controlUrl: '', providerArgs: validateProviderArgs({ agy: ['--dangerously-skip-permissions'] }) });
    expect(agyTerminal.args.slice(0, 4)).toEqual(['--mode', 'auto', '--model', 'gemini-4-argon-medium']); expect(agyTerminal.args.filter(arg => arg === '--dangerously-skip-permissions')).toHaveLength(1); expect(agyTerminal.args).toContain('--settings'); expect(agyTerminal.args.at(-2)).toBe('--prompt-interactive');
    const agyHeadless = prepareRuntime(project, { ...task, provider: 'agy', model: 'gemini-4-argon-medium' }, { ...run, provider: 'agy' }, 'Work', { image: 'worker', controlUrl: '', providerArgs: validateProviderArgs({ agy: ['--dangerously-skip-permissions'] }) });
    expect(agyHeadless.args).toEqual(['--output-format', 'stream-json', '--mode', 'auto', '--model', 'gemini-4-argon-medium', '--settings', JSON.stringify({ trustedWorkspaces: [project.repositoryPath] }), '--dangerously-skip-permissions', '--print', 'Work']);
    const command = prepareRuntime(project, { ...task, provider: 'command', command: { executable: 'custom', args: ['literal'] } }, { ...run, provider: 'command' }, 'Work', { image: 'worker', controlUrl: '', providerArgs: map });
    expect(command.args).toEqual(['literal']);
  });

  it('launches GitHub Copilot with JSON output, its own session ID, read-only denials and a prompt file for long prompts', () => {
    const copilot = { ...task, provider: 'copilot' as const }, sessionId = 'c1296dcf-ba51-4a2f-9dda-98e25d0308d0', copilotRun = { ...run, provider: 'copilot' as const, sessionId };
    const args = (prepared: ReturnType<typeof prepareRuntime>) => { expect(prepared.executable).toBe('copilot'); return prepared.args; };
    expect(args(prepareRuntime(project, copilot, copilotRun, 'Work', { image: 'worker', controlUrl: '' }))).toEqual(['--output-format', 'json', '--allow-all', '--session-id', sessionId, '-p', 'Work']);
    const planning = args(prepareRuntime(project, copilot, copilotRun, 'Plan', { image: 'worker', controlUrl: '', readOnly: true }));
    expect(planning).toEqual(['--output-format', 'json', '--allow-all-tools', '--deny-tool=shell', '--deny-tool=write', '--disable-builtin-mcps', '-p', 'Plan']);
    const configured = validateProviderArgs({ copilot: ['--allow-tool', 'shell(git:*)', '--reasoning-effort', 'high'] });
    const custom = args(prepareRuntime(project, copilot, copilotRun, 'Work', { image: 'worker', controlUrl: '', providerArgs: configured }));
    expect(custom).not.toContain('--allow-all'); expect(custom.slice(-6)).toEqual(['--allow-tool', 'shell(git:*)', '--reasoning-effort', 'high', '-p', 'Work']);
    expect(args(prepareRuntime(project, copilot, copilotRun, 'Plan', { image: 'worker', controlUrl: '', providerArgs: configured, readOnly: true }))).toContain('--deny-tool=shell');
    const inputDirectory = mkdtempSync(join(tmpdir(), 'aiws-copilot-input-')); roots.push(inputDirectory); writeFileSync(join(inputDirectory, 'prompt.md'), 'x'.repeat(9000));
    const long = args(prepareRuntime(project, copilot, { ...copilotRun, inputDirectory }, 'x'.repeat(9000), { image: 'worker', controlUrl: '' }));
    expect(long.at(-1)).toBe(`Read and follow the task instructions in ${join(inputDirectory, 'prompt.md')}. Perform the work in the current project.`);
    const terminal = args(prepareRuntime(project, copilot, { ...copilotRun, terminalMode: 'pty', inputDirectory }, 'Work', { image: 'worker', controlUrl: '' }));
    expect(terminal.slice(0, 4)).toEqual(['--allow-all', '--session-id', sessionId, '-i']); expect(terminal.at(-1)).toContain('aiws control complete --run run');
    const resumed = args(prepareRuntime(project, copilot, { ...copilotRun, historyResume: { provider: 'copilot', sessionId, initialMessage: 'Continue' } as Run['historyResume'] }, 'Continue', { image: 'worker', controlUrl: '' }));
    expect(resumed).toEqual(['--output-format', 'json', '--resume', sessionId, '--allow-all', '-p', 'Continue']);
    expect(() => validateProviderArgs({ copilot: ['--resume', 'another-session'] })).toThrow('managed');
    const map = emptyProviderArgs(); map.copilot = ['--model', 'gpt-5.5', '--reasoning-effort', 'high'];
    expect(providerExecutionInfo('copilot', map)).toEqual({ model: 'gpt-5.5', modelSource: 'configured', reasoningEffort: 'high' });
  });

  it.runIf(process.platform === 'win32')('keeps simple flags on legacy PowerShell and refuses silent literal-quote corruption', () => {
    const legacy = { executable: 'powershell.exe', standardArguments: false };
    const simple = windowsLauncher('codex', ['exec', '--yolo', '-'], {}, legacy);
    expect(simple.executable).toBe('powershell.exe'); expect(JSON.parse(simple.env.AIWS_EXEC_ARGS!)).toEqual(['exec', '--yolo', '-']);
    expect(() => windowsLauncher('codex', ['--config', 'key="literal value"'], {}, legacy)).toThrow('PowerShell 7.3');
    const native = windowsLauncher('codex.exe', ['--config', 'key="literal value"'], {}, legacy);
    expect(native.args).toEqual(['--config', 'key="literal value"']);
  });

  it.runIf(process.platform === 'win32')('never lets a batch launcher turn a quoted argument into a cmd.exe command', () => {
    const folder = mkdtempSync(join(tmpdir(), 'aiws-batch-')), marker = join(folder, 'injected.txt'), launcher = join(folder, 'agent.cmd');
    writeFileSync(launcher, '@echo off\r\necho %*\r\n');
    const command = windowsLauncher(launcher, ['--print', `a" & echo injected > "${marker}" & "`], process.env);
    const result = spawnSync(command.executable, command.args, { env: command.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('batch launcher'); expect(existsSync(marker)).toBe(false);
    expect(execCli(launcher, ['a&b'], { env: process.env, timeout: 5000, maxBuffer: 1024 })).toBeNull();
    rmSync(folder, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('lets a batch launcher found on PATH locate its own folder from another working directory', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aiws-batch-')), bin = join(folder, 'bin'), cwd = join(folder, 'project');
    mkdirSync(bin); mkdirSync(cwd); writeFileSync(join(bin, 'aiws-probe.cmd'), '@echo off\r\necho %~dp0\r\n');
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const result = await execCli('aiws-probe.cmd', ['--version'], { env: { ...process.env, [pathKey]: `${bin};${process.env[pathKey]}` }, cwd, timeout: 30_000, maxBuffer: 4096 });
    expect(result?.error).toBeNull(); expect(result?.stdout.trim().toLowerCase()).toMatch(/\\bin\\$/);
    rmSync(folder, { recursive: true, force: true });
  });
});

it('captures effective launch model and effort without leaking other config', () => {
  const args=emptyProviderArgs();args.codex=['--model=global-model','-c','model_reasoning_effort="medium"','-c','unrelated="private"'];
  expect(providerExecutionInfo('codex',args,'gpt-6.1-sol')).toEqual({model:'gpt-6.1-sol',modelSource:'configured',reasoningEffort:'medium'});
  expect(providerExecutionInfo('codex',args)).toEqual({model:'global-model',modelSource:'configured',reasoningEffort:'medium'});
  args.claude=['--model','opus','--effort','high'];
  expect(providerExecutionInfo('claude',args)).toEqual({model:'opus',modelSource:'configured',reasoningEffort:'high'});
  args.agy=['--model','gemini-4-argon-high','--effort','high'];
  expect(providerExecutionInfo('agy',args)).toEqual({model:'gemini-4-argon-high',modelSource:'configured',reasoningEffort:'high'});
  expect(providerExecutionInfo('command',args)).toEqual({});
});
