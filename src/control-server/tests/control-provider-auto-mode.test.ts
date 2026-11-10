import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { emptyProviderArgs, validateProviderArgs, withAutoMode } from '../provider-args.js';
import { prepareRuntime } from '../runner.js';
import type { Project, Run, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const task: Task = { id: 'task', projectId: 'project', title: 'Task', description: '', status: 'ready', priority: 0, provider: 'codex', dependsOn: [], autoStart: false, currentRunId: null, createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z' };
const project: Project = { id: 'project', name: 'Project', description: '', repositoryPath: process.cwd(), github: null, createdAt: task.createdAt, updatedAt: task.updatedAt };
const run: Run = { id: 'run', taskId: task.id, status: 'running', provider: 'codex', startedAt: task.createdAt, finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', inputDirectory: '/input', pendingCommands: [], continuation: 0 };
const launch = (provider: Task['provider'], providerArgs = emptyProviderArgs(), readOnly = false) => prepareRuntime(project, { ...task, provider }, { ...run, provider, terminalMode: readOnly ? 'stream' : 'pty' }, 'Work', { image: 'worker', controlUrl: '', providerArgs: withAutoMode(providerArgs, ['codex', 'claude', 'opencode', 'agy']), readOnly });

describe('provider auto mode', () => {
  it('validates and persists the providers that start in auto mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiws-auto-mode-')); roots.push(directory);
    let service = new ControlService({ dataDir: directory }); services.push(service);
    expect(service.snapshot().settings.autoModeProviders).toEqual([]);
    expect(() => service.updateSettings({ autoModeProviders: ['bogus'] })).toThrow('autoModeProviders');
    expect(service.updateSettings({ autoModeProviders: ['codex', 'claude', 'codex'] }).autoModeProviders).toEqual(['codex', 'claude']);
    await service.close(); services.pop(); service = new ControlService({ dataDir: directory }); services.push(service);
    expect(service.snapshot().settings.autoModeProviders).toEqual(['codex', 'claude']);
  });

  it('launches each known CLI without approval prompts and keeps explicit permission choices', () => {
    const codex = launch('codex').args;
    expect(codex).toContain('--yolo'); expect(codex).not.toContain('--sandbox');
    const claude = launch('claude').args;
    expect(claude.join(' ')).toContain('--permission-mode auto'); expect(claude).not.toContain('acceptEdits');
    const agy = launch('agy').args;
    expect(agy.filter((arg) => arg === '--mode')).toHaveLength(1); expect(agy.join(' ')).toContain('--mode auto --dangerously-skip-permissions');
    expect(launch('opencode').env.OPENCODE_PERMISSION).toBe('{"*":"allow","question":"deny"}');
    const explicit = validateProviderArgs({ codex: ['--sandbox', 'workspace-write'], claude: ['--permission-mode', 'acceptEdits'] });
    expect(launch('codex', explicit).args).not.toContain('--yolo');
    expect(launch('claude', explicit).args).not.toContain('auto');
    expect(withAutoMode(explicit, [])).toEqual(explicit);
  });

  it('never weakens read-only planning', () => {
    expect(launch('codex', emptyProviderArgs(), true).args).not.toContain('--yolo');
    const claude = launch('claude', emptyProviderArgs(), true).args;
    expect(claude[claude.indexOf('--permission-mode') + 1]).toBe('plan');
  });
});
