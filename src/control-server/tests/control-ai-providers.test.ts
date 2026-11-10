import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIProvider, AIProvidersService, aiProviders, CodexProvider, type LaunchContext, type ModelContext, type ModelListing, type ProviderInvocation } from '../ai-providers/index.js';
import { emptyProviderArgs, providerExecutionInfo, validateAutoModeProviders, validateDisabledProviders, validateProviderArgs, withAutoMode } from '../provider-args.js';
import { ProviderDetector } from '../provider-detection.js';
import { ProviderModels } from '../provider-models.js';
import { providerInvocation } from '../runner.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import { TokenUsageMonitor } from '../token-usage.js';
import type { Task } from '../types.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'aiws-ai-providers-')); roots.push(root); return root; };
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const task = (provider: Task['provider'], model?: string): Task => ({ id: 'task_1', projectId: 'p', title: 't', description: '', status: 'ready', priority: 0, provider, ...(model ? { model } : {}), dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' });

/** A provider that exists only in this test, registered the way a real one is. */
class ExampleProvider extends AIProvider {
  readonly id = 'example' as never;
  readonly name = 'Example AI';
  readonly executable = 'example-ai';
  override readonly reasoningEfforts = ['low', 'high'];
  override readonly reasoningFlag = '--think';
  override readonly fallbackModels = ['example-1'];
  readonly args = { values: new Set(['--model', '--think']), reserved: new Set(['--print']), permission: new Set(['--trust']) };
  readonly autoMode = { args: ['--trust'], overrides: ['--trust'], label: '--trust' };
  homeDirectory(_env: NodeJS.ProcessEnv, home: string): string { return join(home, '.example'); }
  async getModels(context: ModelContext): Promise<ModelListing> { return { models: (await context.run(this.executable, ['models'])).split('\n').filter(Boolean).map((id) => ({ id })), source: 'example models' }; }
  headlessInvocation(value: Task, prompt: string): ProviderInvocation { return { executable: 'example-ai', args: ['--print', ...(value.model ? ['--model', value.model] : [])], input: prompt }; }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation { return { executable: 'example-ai', args: [...(model ? ['--model', model] : []), nativePrompt], input: '' }; }
  resumeInvocation(sessionId: string, _message: string[], context: LaunchContext): ProviderInvocation { return { executable: 'example-ai', args: ['--resume', sessionId], input: context.prompt }; }
  terminalResumeArgs(sessionId: string): string[] { return ['--resume', sessionId]; }
}

describe('AI provider registry', () => {
  it('lists every built-in provider once, with what the interface needs to show and launch it', () => {
    expect(aiProviders.ids()).toEqual(['codex', 'claude', 'opencode', 'agy', 'copilot']);
    const info = aiProviders.info();
    for (const item of info) {
      expect(item.name).toBeTruthy(); expect(item.executable).toBeTruthy(); expect(item.autoModeLabel).toBeTruthy();
      expect(item.fallbackModels.length).toBeGreaterThan(0); expect(item.reasoningEfforts.length).toBeGreaterThan(0);
      // Every icon the registry names is a file the control UI serves.
      if (item.icon) expect(existsSync(resolve(fileURLToPath(new URL('../../control-ui', import.meta.url)), `.${item.icon}`))).toBe(true);
    }
    expect(info.find((item) => item.id === 'copilot')).toMatchObject({ name: 'GitHub Copilot', icon: '/icons/copilot.svg', reasoningFlag: '--reasoning-effort', reasoningInModelId: false, autoModeLabel: '--allow-all', nativeTerminal: true, usage: true });
    // Antigravity names one model per thinking level, so the level is chosen as a model.
    expect(info.find((item) => item.id === 'agy')).toMatchObject({ reasoningInModelId: true, reasoningEfforts: ['low', 'medium', 'high'] });
    expect(info.find((item) => item.id === 'opencode')).toMatchObject({ nativeTerminal: false, usage: false });
    expect(aiProviders.names('or', 'id')).toBe('codex, claude, opencode, agy or copilot');
    expect(() => aiProviders.require('missing')).toThrow('Unknown provider');
  });

  it('registers a provider by class or instance and replaces one registered under the same ID', () => {
    const registry = new AIProvidersService().register(CodexProvider).register(ExampleProvider);
    expect(registry.ids()).toEqual(['codex', 'example']);
    const replacement = new ExampleProvider(); Object.defineProperty(replacement, 'name', { value: 'Example AI 2' });
    registry.register(replacement);
    expect(registry.ids()).toEqual(['codex', 'example']); expect(registry.get('example')?.name).toBe('Example AI 2');
    expect(registry.info()[1]).toMatchObject({ id: 'example', reasoningEfforts: ['low', 'high'], fallbackModels: [{ id: 'example-1' }], usage: false });
  });

  it('describes the model families each provider lists with relative speed, quality and cost', () => {
    const claude = aiProviders.require('claude'), codex = aiProviders.require('codex'), agy = aiProviders.require('agy'), copilot = aiProviders.require('copilot');
    expect(claude.modelProfile('claude-fable-5-1')).toEqual({ speed: 1, quality: 5, cost: 5 });
    expect(claude.modelProfile('claude-opus-5-5')).toEqual({ speed: 2, quality: 4, cost: 4 });
    expect(codex.modelProfile('gpt-6-luna')).toEqual({ speed: 5, quality: 2, cost: 1 });
    expect(codex.modelProfile('gpt-5.1-codex-mini')).toEqual({ speed: 4, quality: 2, cost: 2 });
    // A thinking level in the ID answers slower and dearer (high) or faster and cheaper (low) than its family.
    expect(agy.modelProfile('gemini-3.8-flash-high')).toEqual({ speed: 3, quality: 3, cost: 3 });
    expect(agy.modelProfile('gemini-3.8-flash-low')).toEqual({ speed: 5, quality: 3, cost: 1 });
    expect(aiProviders.require('opencode').modelProfile('anthropic/claude-haiku-5-5')).toEqual({ speed: 5, quality: 2, cost: 1 });
    // Unknown models, families a provider does not list and providers that know no families get no profile.
    for (const id of ['opencode/big-pickle', 'gpt-a', 'auto']) expect(copilot.modelProfile(id)).toBeNull();
    expect(codex.modelProfile('claude-opus-5-5')).toBeNull();
    expect(new ExampleProvider().modelProfile('claude-opus-5-5')).toBeNull();
    // Suggested models reach the interface with their profiles.
    const info = aiProviders.info(), copilotModels = info.find((item) => item.id === 'copilot')!.fallbackModels;
    expect(copilotModels[0]).toEqual({ id: 'auto' });
    expect(copilotModels.find((model) => model.id === 'gemini-4-argon')).toEqual({ id: 'gemini-4-argon', profile: { speed: 2, quality: 5, cost: 4 } });
    expect(info.find((item) => item.id === 'claude')!.fallbackModels.every((model) => model.profile)).toBe(true);
  });

  it('drives provider settings validation from the registry, including Copilot', () => {
    expect(Object.keys(emptyProviderArgs())).toEqual(aiProviders.ids());
    expect(validateProviderArgs({ copilot: ['--reasoning-effort', 'high'] }).copilot).toEqual(['--reasoning-effort', 'high']);
    expect(() => validateProviderArgs({ unknown: [] })).toThrow('codex, claude, opencode, agy and copilot');
    expect(() => validateProviderArgs({ copilot: ['--session-id', 'x'] })).toThrow('managed by the application');
    expect(validateAutoModeProviders(['copilot', 'copilot'])).toEqual(['copilot']);
    expect(() => validateDisabledProviders(aiProviders.ids())).toThrow('at least one');
    expect(withAutoMode(emptyProviderArgs(), ['copilot', 'claude'])).toMatchObject({ copilot: ['--allow-all'], claude: ['--permission-mode', 'auto'] });
    expect(withAutoMode({ ...emptyProviderArgs(), copilot: ['--yolo'] }, ['copilot']).copilot).toEqual(['--yolo']);
    expect(providerExecutionInfo('copilot', { ...emptyProviderArgs(), copilot: ['--model', 'gpt-5.5', '--reasoning-effort', 'high'] })).toEqual({ model: 'gpt-5.5', modelSource: 'configured', reasoningEffort: 'high' });
    expect(providerExecutionInfo('codex', { ...emptyProviderArgs(), codex: ['-c', 'model="gpt-6"', '-c', 'model_reasoning_effort=high'] })).toEqual({ model: 'gpt-6', modelSource: 'configured', reasoningEffort: 'high' });
  });

  it('builds each provider command line through the registry', () => {
    expect(providerInvocation(task('copilot', 'gpt-5.5'), 'Do it')).toEqual({ executable: 'copilot', args: ['--output-format', 'json', '--allow-all', '--model', 'gpt-5.5', '-p', 'Do it'], input: '' });
    expect(providerInvocation(task('opencode'), 'Do it')).toEqual({ executable: 'opencode', args: ['run', '--format', 'json'], input: 'Do it' });
    expect(providerInvocation(task('claude'), 'Plan', true).args).toContain('--strict-mcp-config');
    expect(() => providerInvocation(task('command'), 'Plan', true)).toThrow('Codex, Claude Code, OpenCode, Antigravity or GitHub Copilot');
  });

  it('reads provider-specific stream events', () => {
    const copilot = aiProviders.require('copilot');
    expect(copilot.readStreamEvent({ type: 'assistant.message', data: { content: 'Done' } })).toMatchObject({ text: 'Done', failed: false });
    expect(copilot.readStreamEvent({ type: 'assistant.message', data: { content: 'Sub', parentToolCallId: 'x' } }).text).toBeUndefined();
    expect(copilot.readStreamEvent({ type: 'session.error', data: { message: 'quota' } })).toMatchObject({ failed: true, errorDetail: 'quota' });
    expect(copilot.readStreamEvent({ type: 'result', sessionId: 's1', exitCode: 0 })).toMatchObject({ sessionId: 's1', failed: false });
    expect(aiProviders.require('claude').readStreamEvent({ type: 'system', model: 'claude-opus-5-5' }).model).toBe('claude-opus-5-5');
    expect(aiProviders.require('opencode').readStreamEvent({ type: 'step', sessionID: 'ses_1' }).sessionId).toBe('ses_1');
  });

  it('detects and lists models of every registered provider through its own implementation', async () => {
    const home = temp(); mkdirSync(join(home, '.copilot', 'session-state', 'a'), { recursive: true });
    const { writeFileSync } = await import('node:fs'); writeFileSync(join(home, '.copilot', 'session-state', 'a', 'events.jsonl'), '');
    const detector = new ProviderDetector({ home, env: {}, probe: async (executable) => ({ path: `/bin/${executable}`, version: '1.0' }) });
    const result = await detector.detect();
    expect(result.providers.map((item) => item.id)).toEqual(aiProviders.ids());
    expect(result.providers.find((item) => item.id === 'copilot')).toMatchObject({ name: 'GitHub Copilot', executable: 'copilot', installed: true, homeExists: true, sessions: 1 });
    expect(result.providers.find((item) => item.id === 'opencode')?.sessions).toBeNull();
    const run = vi.fn(async () => 'Settings:\n  `model`: Model to use\n    - "gpt-5.5"\n    - "claude-sonnet-5.5"\n  `theme`: x\n    - "dark"\n');
    expect((await new ProviderModels({ home, env: {}, run }).list('copilot')).models.map((model) => model.id)).toEqual(['gpt-5.5', 'claude-sonnet-5.5']);
    expect(run).toHaveBeenCalledWith('copilot', ['help', 'config']);
  });

  it('reads the remaining GitHub Copilot quota only on refresh and keeps the credentials private', async () => {
    const home = temp(); const now = Date.parse('2026-10-16T12:00:00Z');
    const request = vi.fn(async () => new Response(JSON.stringify({ login: 'octo', quota_reset_date_utc: '2026-11-01T00:00:00Z', quota_snapshots: {
      premium_interactions: { percent_remaining: 25, unlimited: false }, chat: { percent_remaining: 100, unlimited: true }, completions: { percent_remaining: 90, unlimited: false } } }), { status: 200 }));
    const monitor = new TokenUsageMonitor({ home, env: { GH_TOKEN: 'secret-token' }, now: () => now, fetch: request as unknown as typeof fetch });
    expect((await monitor.scan()).providers.find((item) => item.key === 'copilot')).toMatchObject({ source: 'unavailable' }); expect(request).not.toHaveBeenCalled();
    const copilot = (await monitor.scan(true)).providers.find((item) => item.key === 'copilot')!;
    expect(copilot).toMatchObject({ name: 'GitHub Copilot', account: 'octo', source: 'api', weekly: { usedPercent: 75, windowMinutes: 43200, resetsAt: '2026-11-01T00:00:00.000Z' } });
    expect(copilot.buckets?.map((bucket) => bucket.label)).toEqual(['Premium requests', 'Code completions']);
    expect(request).toHaveBeenCalledWith('https://api.github.com/copilot_internal/user', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'token secret-token' }) }));
    expect(JSON.stringify(copilot)).not.toContain('secret-token');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(home, '.aiws', 'token-usage-cache.json'), 'utf8')).not.toContain('secret-token');
    // After a restart the saved snapshot is shown without a new request.
    const restarted = new TokenUsageMonitor({ home, env: {}, now: () => now, fetch: request as unknown as typeof fetch });
    expect((await restarted.scan()).providers.find((item) => item.key === 'copilot')).toMatchObject({ source: 'cache', weekly: { usedPercent: 75 } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the existing GitHub CLI login for Copilot quota refresh when no token env var is set', async () => {
    const home = temp(); const request = vi.fn(async () => new Response(JSON.stringify({ login: 'octo', quota_reset_date_utc: '2026-11-01T00:00:00Z', quota_snapshots: { premium_interactions: { percent_remaining: 40, unlimited: false } } }), { status: 200 }));
    const githubToken = vi.fn(async () => 'gh-secret-token');
    const monitor = new TokenUsageMonitor({ home, env: {}, githubToken, fetch: request as unknown as typeof fetch });
    await monitor.scan(); expect(githubToken).not.toHaveBeenCalled();
    const copilot = (await monitor.scan(true)).providers.find((item) => item.key === 'copilot')!;
    expect(githubToken).toHaveBeenCalledOnce();
    expect(copilot).toMatchObject({ source: 'api', account: 'octo', weekly: { usedPercent: 60 } });
    expect(request).toHaveBeenCalledWith('https://api.github.com/copilot_internal/user', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'token gh-secret-token' }) }));
    expect(JSON.stringify(copilot)).not.toContain('gh-secret-token');
  });

  it('serves the registry to the interface in the state and on its own endpoint', async () => {
    const server = await startControlServer({ port: 0, dataDir: join(temp(), 'data') }); servers.push(server);
    const listed = await (await fetch(`${server.url}/api/providers`)).json() as Array<{ id: string }>;
    expect(listed.map((item) => item.id)).toEqual(aiProviders.ids());
    const state = await (await fetch(`${server.url}/api/state`)).json() as { aiProviders: Array<{ id: string; name: string }> };
    expect(state.aiProviders).toEqual(aiProviders.info());
    expect(server.service.store.state).not.toHaveProperty('aiProviders');
  });
});
