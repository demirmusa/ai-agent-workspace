import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiProviders, ClaudeAccounts, parseClaudeAccounts, type ProviderAccountLogin } from '../ai-providers/index.js';
import type { CommandOptions, CommandResult } from '../../shared/core/command.js';
import { ProjectTerminals } from '../project-terminals.js';
import { validateUsageFooter } from '../provider-args.js';
import { prepareRuntime } from '../runner.js';
import { TokenUsageMonitor } from '../token-usage.js';
import { ControlService } from '../service.js';
import type { Project, Run, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [], terminals: ProjectTerminals[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-provider-accounts-')); roots.push(root); return root; }
async function waitFor(predicate: () => boolean, timeout = 15000): Promise<void> {
  for (const end = Date.now() + timeout; !predicate();) { if (Date.now() > end) throw new Error('Timed out.'); await new Promise((resolve) => setTimeout(resolve, 30)); }
}
afterEach(async () => {
  await Promise.allSettled(terminals.splice(0).map((item) => item.close()));
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const listing = { schemaVersion: 1, activeAccountNumber: 1, accounts: [
  { number: 1, email: 'a@example.com', organizationName: '', active: true, usageStatus: 'ok', usage: { fiveHour: { pct: 25, resetsAt: '2026-10-26T12:00:00Z' }, sevenDay: { pct: 40, resetsAt: '2026-10-30T12:00:00Z' } }, usageFetchedAt: '2026-10-26T09:00:00Z' },
  { number: 2, email: 'b@example.com', organizationName: 'Team', alias: 'work', active: false, disabled: true, usageStatus: 'token_expired', usage: null, lastGoodUsage: { fiveHour: { pct: 90, resetsAt: '2026-10-26T11:00:00Z' } }, lastGoodFetchedAt: '2026-10-26T08:00:00Z', loginExpiresAt: '2027-01-01T00:00:00Z' },
] };

/** claude-swap stand-in: answers by subcommand and records every call. */
function fakeCswap(root: string, tools: Record<string, string> = { cswap: 'cswap.exe', uv: 'uv.exe', claude: 'claude.exe' }) {
  const calls: Array<{ command: string; args: string[]; options: CommandOptions }> = [], data = join(root, 'cswap-data');
  const run = async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
    calls.push({ command, args, options });
    let stdout = '';
    if (args[0] === 'list') stdout = `notice\n${JSON.stringify(listing)}\n`;
    if (args[0] === 'config') stdout = `${join(data, 'settings.json')}\n`;
    if (args[0] === 'run') mkdirSync(join(data, 'sessions', `${args[1]}-b_example.com`), { recursive: true });
    return { command, args, exitCode: 0, stdout, stderr: '' };
  };
  const find = async (name: string): Promise<string | null> => tools[name] ? join(root, 'bin', tools[name]) : null;
  return { calls, data, run, find };
}

describe('Claude Code accounts through claude-swap', () => {
  it('reads cswap list rows with their last known usage', () => {
    const [first, second] = parseClaudeAccounts(JSON.stringify(listing));
    expect(first).toMatchObject({ id: '1', email: 'a@example.com', label: 'a@example.com', active: true, disabled: false, status: 'ok', updatedAt: '2026-10-26T09:00:00Z' });
    expect(first!.short).toEqual({ usedPercent: 25, resetsAt: '2026-10-26T12:00:00.000Z', windowMinutes: 300 });
    expect(first!.weekly.usedPercent).toBe(40);
    expect(second).toMatchObject({ id: '2', label: 'work', alias: 'work', organization: 'Team', disabled: true, status: 'token_expired', updatedAt: '2026-10-26T08:00:00Z', loginExpiresAt: '2027-01-01T00:00:00Z' });
    expect(second!.short.usedPercent).toBe(90); expect(second!.weekly.usedPercent).toBeNull();
    expect(() => parseClaudeAccounts(JSON.stringify({ schemaVersion: 1, error: { message: 'locked' } }))).toThrow('locked');
  });

  it('installs with uv, lists, adds the current login and removes after confirming', async () => {
    const root = temp(), missing = fakeCswap(root, { uv: 'uv.exe' });
    const before = await new ClaudeAccounts({ home: root, env: {}, run: missing.run, find: missing.find }).status();
    expect(before.tool).toMatchObject({ name: 'claude-swap', installed: false, installer: 'uv' }); expect(before.accounts).toEqual([]);
    expect(missing.calls).toEqual([]);
    await expect(new ClaudeAccounts({ home: root, env: {}, run: missing.run, find: async () => null }).install()).rejects.toThrow('uv or pipx');
    const tool = fakeCswap(root), accounts = new ClaudeAccounts({ home: root, env: {}, run: tool.run, find: tool.find });
    await accounts.install();
    expect(tool.calls[0]!.args).toEqual(['tool', 'install', 'claude-swap']); expect(tool.calls[0]!.command).toBe(join(root, 'bin', 'uv.exe'));
    const status = await accounts.status();
    expect(status.tool.installed).toBe(true); expect(status.accounts.map((account) => account.id)).toEqual(['1', '2']);
    const listed = tool.calls.length; await accounts.status(); expect(tool.calls).toHaveLength(listed);
    await accounts.addCurrent(); await accounts.remove('2');
    const changes = tool.calls.filter((call) => call.args[0] !== 'list' && call.args[0] !== 'tool');
    expect(changes.map((call) => call.args)).toEqual([['add'], ['remove', '2']]);
    expect(changes[1]!.options.input).toBe('y\n'); expect(changes[0]!.options.env?.NO_COLOR).toBe('1');
    await expect(accounts.remove('2; rm -rf /')).rejects.toThrow('account number');
  });

  it('uninstalls claude-swap with the installer that holds it and leaves Claude Code alone', async () => {
    const root = temp(), tools: Record<string, string> = { cswap: 'cswap.exe', uv: 'uv.exe', pipx: 'pipx.exe', claude: 'claude.exe' }, tool = fakeCswap(root, tools);
    // uv did not install it here, so it fails and pipx removes it.
    const run = async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
      if (command.endsWith('uv.exe') && args[1] === 'uninstall') { tool.calls.push({ command, args, options }); throw new Error('claude-swap is not installed'); }
      if (args[0] === 'uninstall') delete tools.cswap;
      return tool.run(command, args, options);
    };
    const accounts = new ClaudeAccounts({ home: root, env: {}, run, find: tool.find });
    expect((await accounts.status()).accounts).toHaveLength(2);
    const after = await accounts.uninstall();
    expect(after.tool.installed).toBe(false); expect(after.accounts).toEqual([]);
    const removals = tool.calls.filter((call) => call.args.includes('uninstall'));
    expect(removals.map((call) => [call.command, call.args])).toEqual([[join(root, 'bin', 'uv.exe'), ['tool', 'uninstall', 'claude-swap']], [join(root, 'bin', 'pipx.exe'), ['uninstall', 'claude-swap']]]);
    expect(tool.calls.some((call) => call.command.endsWith('claude.exe') || call.args.includes('claude-code'))).toBe(false);
    await expect(accounts.uninstall()).rejects.toThrow('not installed');
  });

  it('reports a failed uninstall and a cswap that is still on PATH', async () => {
    const root = temp(), failing = fakeCswap(root);
    const broken = new ClaudeAccounts({ home: root, env: {}, run: async (command, args, options) => { if (args[1] === 'uninstall') throw new Error('locked'); return failing.run(command, args, options); }, find: failing.find });
    await expect(broken.uninstall()).rejects.toThrow('could not be uninstalled: locked');
    const stays = fakeCswap(root);
    await expect(new ClaudeAccounts({ home: root, env: {}, run: stays.run, find: stays.find }).uninstall()).rejects.toThrow('still found');
  });

  it('prepares the cswap run profile of an account and shares history with the default folder', async () => {
    const root = temp(), tool = fakeCswap(root), history = join(root, 'claude-home');
    const accounts = new ClaudeAccounts({ home: root, env: {}, run: tool.run, find: tool.find, historyHome: () => history });
    expect(await accounts.launchEnv('1')).toEqual({});
    expect(tool.calls.some((call) => call.args[0] === 'run')).toBe(false);
    const env = await accounts.launchEnv('2'), profile = join(tool.data, 'sessions', '2-b_example.com');
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: profile });
    const prepare = tool.calls.find((call) => call.args[0] === 'run')!;
    expect(prepare.args).toEqual(['run', '2', '--require-session', ...(process.platform === 'win32' ? [] : ['--share-history']), '--', '--version']);
    if (process.platform === 'win32') {
      expect(lstatSync(join(profile, 'projects')).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(profile, 'projects')).toLowerCase()).toBe(realpathSync(join(history, 'projects')).toLowerCase());
    }
    await expect(accounts.launchEnv('7')).rejects.toThrow('no longer in claude-swap');
    expect(accounts.overrideEnv).toContain('ANTHROPIC_API_KEY');
  });

  it('signs a new account in from its own profile and registers it with cswap add', async () => {
    const root = temp(), tool = fakeCswap(root), accounts = new ClaudeAccounts({ home: root, env: { AIWS_HOME: join(root, 'aiws') }, run: tool.run, find: tool.find });
    const login = await accounts.login(), directory = login.env.CLAUDE_CONFIG_DIR!;
    expect(login.executable).toBe(join(root, 'bin', 'claude.exe')); expect(directory.startsWith(join(root, 'aiws', 'claude-logins'))).toBe(true);
    expect(existsSync(directory)).toBe(true); expect(await login.ready()).toBe(false);
    expect(await login.finish()).toEqual({ added: false, message: 'No account signed in; nothing was added.' });
    expect(existsSync(directory)).toBe(false);
    const second = await accounts.login(), folder = second.env.CLAUDE_CONFIG_DIR!;
    writeFileSync(join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com' } }));
    writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }));
    expect(await second.ready()).toBe(true);
    expect(await second.finish()).toEqual({ added: true, message: 'Added new@example.com to claude-swap.' });
    const add = tool.calls.find((call) => call.args[0] === 'add')!;
    expect(add.options.env?.CLAUDE_CONFIG_DIR).toBe(folder); expect(existsSync(folder)).toBe(false);
  });

  it('keeps the chosen account on tasks of providers that have accounts and drops it with the provider', async () => {
    const root = temp(), workspace = join(root, 'workspace'); mkdirSync(workspace);
    const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
    const project = service.createProject({ name: 'Accounts', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'As account two', provider: 'claude', account: '2' });
    expect(task.account).toBe('2');
    expect(service.updateTask(task.id, { title: 'Renamed' }).account).toBe('2');
    expect(service.updateTask(task.id, { provider: 'codex' }).account).toBeUndefined();
    expect(() => service.createTask({ projectId: project.id, title: 'Codex', provider: 'codex', account: '2' })).toThrow('no accounts');
    expect(() => service.createTask({ projectId: project.id, title: 'Bad', provider: 'claude', account: 'two words' })).toThrow('account');
    expect(service.updateTask(task.id, { provider: 'claude', account: '3' }).account).toBe('3');
    expect(aiProviders.info().find((item) => item.id === 'claude')?.accounts).toBe(true);
    expect(aiProviders.info().find((item) => item.id === 'codex')?.accounts).toBe(false);
  });

  it('runs the provider with the account environment and without overriding credentials', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'service-key');
    const root = temp(), at = new Date().toISOString();
    const project: Project = { id: 'project', name: 'Accounts', description: '', repositoryPath: root, github: null, createdAt: at, updatedAt: at };
    const task: Task = { id: 'task', projectId: project.id, title: 'Task', description: '', provider: 'claude', account: '2', status: 'ready', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: at, updatedAt: at };
    const run: Run = { id: 'run', taskId: task.id, provider: 'claude', terminalMode: 'stream', status: 'running', startedAt: at, finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0 };
    const options = { image: 'unused', controlUrl: 'http://127.0.0.1:1', accountEnv: { CLAUDE_CONFIG_DIR: join(root, 'profile') } };
    const prepared = prepareRuntime(project, task, run, 'prompt', options);
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'profile')); expect(prepared.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(prepareRuntime(project, task, run, 'prompt', { image: 'unused', controlUrl: 'http://127.0.0.1:1' }).env.ANTHROPIC_API_KEY).toBe('service-key');
    expect(() => prepareRuntime(project, task, { ...run, executionMode: 'docker' }, 'prompt', options)).toThrow('native execution mode');
  });

  it('shows a usage card for each account other than the default login', async () => {
    const root = temp(), accounts = aiProviders.require('claude').accounts!;
    const status = vi.spyOn(accounts, 'status').mockResolvedValue({ tool: { name: 'claude-swap', command: 'cswap', url: '', installed: true, installer: 'uv' }, accounts: parseClaudeAccounts(JSON.stringify(listing)), checkedAt: new Date().toISOString() });
    const scan = await new TokenUsageMonitor({ home: root, cachePath: join(root, 'cache.json'), accounts: true }).scan(false);
    const cards = scan.providers.filter((item) => item.accountId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'claude@2', provider: 'claude', accountId: '2', name: 'Claude Code', account: 'work', source: 'cache', updatedAt: '2026-10-26T08:00:00Z' });
    expect(cards[0]!.short.usedPercent).toBe(90);
    expect(status).toHaveBeenCalledWith(120_000, true);
    const hidden = await new TokenUsageMonitor({ home: root, cachePath: join(root, 'cache.json'), accounts: true }).scan(true, ['claude@2']);
    expect(hidden.providers.find((item) => item.key === 'claude@2')).toMatchObject({ account: 'work', source: 'unavailable' });
    expect(status).toHaveBeenLastCalledWith(30_000, true);
    expect((await new TokenUsageMonitor({ home: root, cachePath: join(root, 'cache.json') }).scan(false)).providers.some((item) => item.accountId)).toBe(false);
  });

  it('accepts account cards in the usage footer settings', () => {
    expect(validateUsageFooter({ pins: { 'claude@2': ['weekly'] }, hidden: ['claude@2', 'codex'] })).toEqual({ pins: { 'claude@2': ['weekly'] }, hidden: ['claude@2', 'codex'] });
    expect(() => validateUsageFooter({ pins: {}, hidden: ['nope@2'] })).toThrow('usageFooter');
    expect(() => validateUsageFooter({ pins: {}, hidden: ['claude@'] })).toThrow('usageFooter');
  });

  it('closes a sign-in terminal once the login is saved and reports the added account', async () => {
    const root = temp(), at = new Date().toISOString(), script = join(root, 'fake-claude.cjs');
    writeFileSync(script, `process.stdout.write('LOGIN-'+process.env.CLAUDE_CONFIG_DIR+'\\r\\n');setInterval(()=>{},1000);`);
    let signedIn = false;
    const finish = vi.fn(async () => ({ added: true, message: 'Added new@example.com to claude-swap.' }));
    const login: ProviderAccountLogin = { executable: process.execPath, args: [script], env: { CLAUDE_CONFIG_DIR: join(root, 'login') }, intro: 'SIGN-IN-INTRO\r\n', ready: async () => signedIn, finish };
    vi.spyOn(aiProviders.require('claude').accounts!, 'login').mockResolvedValue(login);
    const shells = new ProjectTerminals(); terminals.push(shells);
    const project: Project = { id: 'project', name: 'Accounts', description: '', repositoryPath: root, github: null, createdAt: at, updatedAt: at };
    await expect(shells.create(project, { kind: 'login', provider: 'codex' })).rejects.toThrow('no accounts');
    await expect(shells.create(project, { kind: 'shell', account: '2' })).rejects.toThrow('account');
    const terminal = await shells.create(project, { kind: 'login', provider: 'claude' });
    expect(terminal).toMatchObject({ terminalKind: 'login', provider: 'claude', title: 'Claude Code sign-in' });
    const output = () => shells.terminal(project.id, terminal.id).output;
    await waitFor(() => output().includes(`LOGIN-${join(root, 'login')}`));
    expect(output().startsWith('SIGN-IN-INTRO')).toBe(true); expect(finish).not.toHaveBeenCalled();
    signedIn = true;
    await waitFor(() => output().includes('AIWS: Added new@example.com to claude-swap.'), 20000);
    expect(finish).toHaveBeenCalledTimes(1); expect(shells.terminal(project.id, terminal.id).status).toBe('completed');
  }, 30000);
});
