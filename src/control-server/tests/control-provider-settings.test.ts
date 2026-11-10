import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import { ProviderDetector } from '../provider-detection.js';
import { findExecutable } from '../../shared/core/command.js';

const roots: string[] = [], services: ControlService[] = [], servers: RunningControlServer[] = [];
function root(): string { const value = mkdtempSync(join(tmpdir(), 'aiws-provider-settings-')); roots.push(value); return value; }
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('provider settings', () => {
  it('keeps per-provider default and disabled models, never disabling the default model', async () => {
    const directory = root();
    const service = await ControlService.open({ dataDir: join(directory, 'data') }); services.push(service);
    expect(() => service.updateSettings({ defaultModels: { typo: 'x' } })).toThrow('defaultModels');
    expect(() => service.updateSettings({ disabledModels: { codex: 'x' } })).toThrow('disabledModels');
    const saved = service.updateSettings({ defaultModels: { codex: 'gpt-a' }, disabledModels: { codex: ['gpt-a', 'gpt-b'] } });
    expect(saved).toMatchObject({ defaultModels: { codex: 'gpt-a' }, disabledModels: { codex: ['gpt-b'] } });
    expect(service.updateSettings({ maxConcurrent: 2 })).toMatchObject({ defaultModels: { codex: 'gpt-a' }, disabledModels: { codex: ['gpt-b'] } });
    expect(service.updateSettings({ defaultModels: { codex: '' } }).defaultModels).toEqual({});
  });

  it('validates enabled providers, the default and custom providers, and blocks disabled providers for new tasks', async () => {
    const directory = root(); const workspace = join(directory, 'workspace'); mkdirSync(workspace);
    const service = await ControlService.open({ dataDir: join(directory, 'data') }); services.push(service);
    expect(service.snapshot().settings).toMatchObject({ disabledProviders: [], customProviders: [] });
    expect(() => service.updateSettings({ disabledProviders: ['codex'] })).toThrow('cannot be disabled');
    expect(() => service.updateSettings({ disabledProviders: ['typo'] })).toThrow('disabledProviders');
    expect(() => service.updateSettings({ defaultProvider: 'claude', disabledProviders: ['codex', 'claude', 'opencode', 'agy', 'copilot'] })).toThrow('at least one');
    expect(() => service.updateSettings({ customProviders: [{ name: '', executable: 'x' }] })).toThrow('name');
    expect(() => service.updateSettings({ customProviders: [{ name: 'A', executable: '' }] })).toThrow('executable');
    expect(() => service.updateSettings({ customProviders: [{ name: 'Codex', id: 'codex', executable: 'x' }] })).toThrow('Invalid custom provider id');
    expect(() => service.updateSettings({ customProviders: [{ name: 'Same', executable: 'x' }, { name: 'same', executable: 'y' }] })).toThrow('twice');
    expect(() => service.updateSettings({ customProviders: [{ name: 'A', executable: 'x', args: ['a\nb'] }] })).toThrow('arguments');
    const settings = service.updateSettings({ defaultProvider: 'claude', disabledProviders: ['codex', 'codex'], customProviders: [{ name: 'My Agent', executable: 'aider', args: ['--yes'] }] });
    expect(settings).toMatchObject({ defaultProvider: 'claude', disabledProviders: ['codex'], customProviders: [{ id: 'my-agent', name: 'My Agent', executable: 'aider', args: ['--yes'], enabled: true }] });
    expect(() => service.updateSettings({ defaultProvider: 'codex' })).toThrow('cannot be disabled');
    const project = service.createProject({ name: 'Providers', repositoryPath: workspace });
    expect(() => service.createTask({ projectId: project.id, title: 'Disabled', provider: 'codex' })).toThrow('disabled in work settings');
    const inherited = service.createTask({ projectId: project.id, title: 'Inherited' });
    expect(inherited.provider).toBe('claude');
    expect(service.updateTask(inherited.id, { title: 'Renamed' }).provider).toBe('claude');
  });

  it('loads settings files written before providers could be disabled and repairs invalid provider settings', async () => {
    const directory = root(); const dataDir = join(directory, 'data'); mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ systemEnabled: true, defaultProvider: 'opencode', maxConcurrent: 2, executionMode: 'native', dockerImage: 'aiws-control-worker:local', autoSyncSeconds: 0, providerArgs: { codex: [], claude: [], opencode: [], agy: [] }, githubTrigger: '/ai' }));
    let service = await ControlService.open({ dataDir }); services.push(service);
    expect(service.snapshot().settings).toMatchObject({ defaultProvider: 'opencode', maxConcurrent: 2, disabledProviders: [], customProviders: [] });
    await service.close(); services.splice(services.indexOf(service), 1);
    const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...saved, defaultProvider: 'opencode', disabledProviders: ['claude', 'opencode', 'bogus'], customProviders: [{ name: 'Good', executable: 'good' }, { name: '', executable: 'bad' }] }));
    service = await ControlService.open({ dataDir }); services.push(service);
    expect(service.snapshot().settings).toMatchObject({ defaultProvider: 'opencode', disabledProviders: ['claude'], customProviders: [{ id: 'good', name: 'Good', executable: 'good', args: [], enabled: true }] });
  });

  it('detects provider CLIs, configuration homes and session counts through a cached endpoint', async () => {
    const directory = root(); const probed: string[] = [];
    mkdirSync(join(directory, '.codex', 'sessions', '2026', '10'), { recursive: true });
    writeFileSync(join(directory, '.codex', 'sessions', '2026', '10', 'a.jsonl'), '{}'); writeFileSync(join(directory, '.codex', 'sessions', '2026', '10', 'b.jsonl'), '{}');
    mkdirSync(join(directory, '.claude', 'projects', 'p'), { recursive: true }); writeFileSync(join(directory, '.claude', 'projects', 'p', 'c.jsonl'), '{}');
    for (const session of ['s1', 's2', 's3']) { mkdirSync(join(directory, '.copilot', 'session-state', session), { recursive: true }); if (session !== 's3') writeFileSync(join(directory, '.copilot', 'session-state', session, 'events.jsonl'), '{}'); }
    const server = await startControlServer({ port: 0, dataDir: join(directory, 'data'), token: 'detect-test', providerDetection: { home: directory, env: {}, probe: async (executable) => { probed.push(executable); return executable === 'claude' ? { path: '/bin/claude', version: '2.0.0 (Claude Code)' } : { path: null, version: null }; } } });
    servers.push(server); server.service.updateSettings({ autoSyncSeconds: 0, customProviders: [{ name: 'Aider', executable: 'aider' }] });
    const get = async (query = '') => { const response = await fetch(`${server.url}/api/providers/detect${query}`, { headers: { Authorization: 'Bearer detect-test' } }); expect(response.status).toBe(200); return response.json() as Promise<{ providers: Array<Record<string, unknown>>; checkedAt: string }>; };
    const result = await get();
    expect(result.providers.map((item) => item.id)).toEqual(['codex', 'claude', 'opencode', 'agy', 'copilot', 'aider']);
    expect(result.providers.find((item) => item.id === 'claude')).toMatchObject({ installed: true, version: '2.0.0 (Claude Code)', homeExists: true, sessions: 1 });
    expect(result.providers.find((item) => item.id === 'codex')).toMatchObject({ installed: false, homeExists: true, sessions: 2 });
    expect(result.providers.find((item) => item.id === 'opencode')).toMatchObject({ installed: false, homeExists: false, sessions: null });
    expect(result.providers.find((item) => item.id === 'copilot')).toMatchObject({ installed: false, homeExists: true, sessions: 2 });
    expect(result.providers.find((item) => item.id === 'aider')).toMatchObject({ kind: 'custom', executable: 'aider', installed: false });
    await get(); expect(probed).toHaveLength(6);
    await get('?refresh=1'); expect(probed).toHaveLength(12);
    expect((await fetch(`${server.url}/api/providers/detect`)).status).toBe(401);
  });

  it('finds executables on PATH without a shell and reads their version asynchronously', async () => {
    const directory = root(); const bin = join(directory, 'bin'); mkdirSync(bin);
    const script = join(bin, 'fake.cjs'); writeFileSync(script, "console.log('fake-cli 1.2.3')");
    const launcher = join(bin, process.platform === 'win32' ? 'fakecli.cmd' : 'fakecli');
    writeFileSync(launcher, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${join(directory, 'missing')}${delimiter}${bin}`, PATHEXT: '.EXE;.CMD', ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    expect((await findExecutable('fakecli', env))?.toLowerCase()).toBe(launcher.toLowerCase());
    expect(await findExecutable('not-installed-cli', env)).toBeNull();
    const detector = new ProviderDetector({ home: directory, env });
    const result = await detector.detect([{ id: 'fake', name: 'Fake', executable: 'fakecli', args: [], enabled: true }]);
    expect(result.providers.find((item) => item.id === 'fake')).toMatchObject({ installed: true, version: 'fake-cli 1.2.3' });
  });
});
