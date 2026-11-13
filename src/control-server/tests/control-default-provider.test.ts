import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';
import { emptyControlState } from '../store.js';
import type { DefaultProvider } from '../types.js';

const roots: string[] = [], services: ControlService[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-default-provider-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const dataDir = join(root, 'data');
  const service = await ControlService.open({ dataDir }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0 });
  const project = service.createProject({ name: 'Provider defaults', repositoryPath: workspace });
  return { root, dataDir, workspace, service, project };
}
function installProviders(root: string): string {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const proof = join(root, 'invocations.jsonl');
  const fixture = join(bin, 'provider.cjs');
  writeFileSync(fixture, `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    const provider=process.argv[2],args=process.argv.slice(3);
    require('node:fs').appendFileSync(${JSON.stringify(proof)},JSON.stringify({provider,args,input})+'\\n');
    const reply={reply:'Prepared by '+provider,tasks:[],draft:{title:'Draft by '+provider,description:'Verify provider selection.'}};
    console.log(JSON.stringify({type:'result',result:JSON.stringify(reply)}));
  });`);
  for (const provider of ['codex', 'claude', 'opencode', 'agy']) {
    // A .cmd shim would refuse the multi-line prompt: cmd.exe cannot pass it safely (see windowsLauncher).
    const launcher = join(bin, process.platform === 'win32' ? `${provider}.ps1` : provider);
    writeFileSync(launcher, process.platform === 'win32'
      ? `& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}' ${provider} @args\nexit $LASTEXITCODE\n`
      : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fixture.replace(/'/g, "'\\''")}' ${provider} "$@"\n`, { mode: 0o755 });
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  vi.stubEnv(pathKey, `${bin}${delimiter}${process.env[pathKey] ?? ''}`);
  return proof;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('global default provider', () => {
  it('migrates old settings, persists the choice, validates it and preserves explicit task/profile choices', async () => {
    const { dataDir, service, project } = await setup();
    const inherited = service.createTask({ projectId: project.id, title: 'Inherited' });
    const explicit = service.createTask({ projectId: project.id, title: 'Explicit', provider: 'opencode' });
    const agent = service.catalog.createAgent({ name: 'Existing Codex profile', provider: 'codex' });
    const assigned = service.createTask({ projectId: project.id, title: 'Assigned', agentId: agent.id });
    service.updateSettings({ defaultProvider: 'claude' });
    expect(service.task(inherited.id).provider).toBe('claude');
    expect(service.task(explicit.id).provider).toBe('opencode');
    expect(service.task(assigned.id).provider).toBe('codex');
    expect(service.catalog.createAgent({ name: 'New profile' }).provider).toBe('claude');
    expect(service.catalog.updateAgent(agent.id, { description: 'Keep existing provider' }).provider).toBe('codex');
    expect(service.updateTask(explicit.id, { provider: null }).provider).toBe('claude');
    expect(service.task(explicit.id).providerOverride).toBeUndefined();
    expect(() => service.updateSettings({ defaultProvider: 'command' })).toThrow('defaultProvider');
    expect(() => service.updateSettings({ defaultProvider: null })).toThrow('defaultProvider');
    expect(() => service.updateSettings({ defaultProvider: 'typo' })).toThrow('defaultProvider');
    service.updateSettings({ maxConcurrent: 4 });
    await service.close(); services.splice(services.indexOf(service), 1);
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.snapshot().settings).toMatchObject({ defaultProvider: 'claude', maxConcurrent: 4 });
    expect(restored.createTask({ projectId: project.id, title: 'After restart' }).provider).toBe('claude');
    await restored.close(); services.splice(services.indexOf(restored), 1);
    const legacy = emptyControlState(); delete (legacy.settings as Partial<typeof legacy.settings>).defaultProvider;
    for (const name of ['control.db', 'control.db-wal', 'control.db-shm', 'settings.json']) rmSync(join(dataDir, name), { force: true }); writeFileSync(join(dataDir, 'state.json'), JSON.stringify(legacy));
    const migrated = await ControlService.open({ dataDir }); services.push(migrated);
    expect(migrated.snapshot().settings.defaultProvider).toBe('codex');
  });

  it.each<DefaultProvider>(['codex', 'claude', 'opencode', 'agy'])('uses %s for automatic planning, drafts and execution even when another provider has a profile', async provider => {
    const { root, service, project } = await setup(); const proof = installProviders(root);
    service.catalog.createAgent({ name: 'Other provider first', provider: provider === 'codex' ? 'claude' : 'codex' });
    service.updateSettings({ defaultProvider: provider });
    expect((await service.plan(project.id, { message: 'Plan this task.', createTasks: false })).reply).toBe(`Prepared by ${provider}`);
    expect((await service.draft(project.id, { message: 'Prepare the form.' })).draft?.title).toBe(`Draft by ${provider}`);
    const task = service.createTask({ projectId: project.id, title: 'Run with default provider', terminalMode: 'stream' });
    const run = service.startTask(task.id); expect(run.provider).toBe(provider); expect(run.executionSnapshot?.agent).toBeNull();
    await vi.waitFor(() => expect(service.run(run.id).status).toBe('completed'), { timeout: 10000 });
    const calls = readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.provider)).toEqual([provider, provider, provider]);
    for (const call of calls.slice(0, 2)) {
      if (provider === 'codex') expect(call.args).toContain('read-only');
      if (provider === 'claude') expect(call.args).toContain('plan');
      if (provider === 'agy') expect(call.args).toContain('plan');
    }
    service.updateSettings({ defaultProvider: provider === 'codex' ? 'claude' : 'codex' });
    expect(service.run(run.id).executionSnapshot?.provider).toBe(provider);
    expect(service.task(task.id).provider).toBe(provider);
  }, 20000);

  it('selects a matching profile for automatic work and honors explicitly selected profiles and providers', async () => {
    const { root, service, project } = await setup(); const proof = installProviders(root);
    const codex = service.catalog.createAgent({ name: 'Codex first', provider: 'codex' });
    const claude = service.catalog.createAgent({ name: 'Claude default', provider: 'claude' });
    service.updateSettings({ defaultProvider: 'claude' });
    const runTask = async (fields: Record<string, unknown>) => {
      const task = service.createTask({ projectId: project.id, title: 'Profile selection', terminalMode: 'stream', ...fields });
      const run = service.startTask(task.id);
      await vi.waitFor(() => expect(service.run(run.id).status).toBe('completed'), { timeout: 10000 });
      return run;
    };
    expect((await runTask({})).executionSnapshot?.agent?.id).toBe(claude.id);
    expect((await runTask({ agentId: codex.id })).provider).toBe('codex');
    expect((await runTask({ provider: 'codex' })).executionSnapshot?.agent?.id).toBe(codex.id);
    await service.draft(project.id, { message: 'Automatic profile' });
    await service.plan(project.id, { message: 'Explicit profile', agentId: codex.id, createTasks: false });
    expect(readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line).provider)).toEqual(['claude', 'codex', 'codex', 'claude', 'codex']);
  }, 20000);
  it('inherits sparse project provider settings, persists overrides and restores global defaults', async () => {
    const { service, project, workspace, dataDir } = await setup();
    service.updateSettings({ defaultProvider: 'claude', defaultModels: { claude: 'sonnet', codex: 'global-codex' }, providerArgs: { claude: ['--verbose'] } });
    const inherited = service.createTask({ projectId: project.id, title: 'Inherited' });
    const explicit = service.createTask({ projectId: project.id, title: 'Explicit', provider: 'opencode' });
    const other = service.createProject({ name: 'Other', repositoryPath: workspace });
    service.updateProject(project.id, { providerSettings: { defaultProvider: 'codex', defaultModels: { codex: 'project-codex' } } });
    expect(service.task(inherited.id).provider).toBe('codex');
    expect(service.task(explicit.id).provider).toBe('opencode');
    service.updateSettings({ defaultProvider: 'agy' });
    expect(service.task(inherited.id).provider).toBe('codex');
    expect(service.createTask({ projectId: other.id, title: 'Other default' }).provider).toBe('agy');
    expect((service as any).execution.resolve(service.task(inherited.id)).model).toBe('project-codex');
    const claude = service.createTask({ projectId: project.id, title: 'Inherited model', provider: 'claude' });
    expect((service as any).execution.resolve(claude).model).toBe('sonnet');
    expect((service as any).execution.launchProviderArgs(project.id).claude).toEqual(['--verbose']);
    expect(() => service.updateProject(project.id, { providerSettings: { defaultProvider: 'missing' } })).toThrow('defaultProvider');
    expect(() => service.updateProject(project.id, { providerSettings: { modelAutoMerge: { codex: { bad: 'yes' } } } })).toThrow('booleans');
    await service.close(); services.splice(services.indexOf(service), 1);
    const restored = await ControlService.open({ dataDir }); services.push(restored);
    expect(restored.project(project.id).providerSettings?.defaultProvider).toBe('codex');
    restored.updateProject(project.id, { providerSettings: null });
    expect(restored.task(inherited.id).provider).toBe('agy');
    expect(restored.project(project.id).providerSettings).toBeUndefined();
  });

  it('uses project provider, model and arguments for real planning, drafts and execution', async () => {
    const { root, service, project } = await setup(); const proof = installProviders(root);
    service.updateSettings({ defaultProvider: 'codex' });
    service.updateProject(project.id, { providerSettings: { defaultProvider: 'claude', defaultModels: { claude: 'project-sonnet' }, providerArgs: { claude: ['--verbose'] } } });
    await service.plan(project.id, { message: 'Plan', createTasks: false });
    await service.draft(project.id, { message: 'Draft' });
    const task = service.createTask({ projectId: project.id, title: 'Execute', terminalMode: 'stream' });
    const run = service.startTask(task.id);
    await vi.waitFor(() => expect(service.run(run.id).status).toBe('completed'), { timeout: 10000 });
    const calls = readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.provider).toBe('claude'); expect(call.args).toContain('project-sonnet'); expect(call.args).toContain('--verbose');
    }
  }, 20000);

  it.each([
    [true, undefined, null, 'done'], [false, undefined, true, 'review'], [false, true, true, 'done'], [true, false, null, 'review'],
    [false, true, null, 'done'], [false, true, false, 'review'], [false, false, true, 'review'],
  ] as const)('resolves model merge global=%s project=%s task=%s', async (global, local, explicit, status) => {
    const { service, project } = await setup();
    service.updateSettings({ defaultModels: { codex: 'strong' }, modelAutoMerge: { codex: { strong: global } } });
    if (local !== undefined) service.updateProject(project.id, { providerSettings: { modelAutoMerge: { codex: { strong: local } } } });
    vi.spyOn((service as any).launcher, 'launch').mockImplementation(() => {});
    const task = service.createTask({ projectId: project.id, title: 'Complete with recorded model', autoMerge: explicit });
    const run = service.startTask(task.id);
    service.updateSettings({ defaultModels: { codex: 'different' } });
    service.complete(run.id, { summary: 'Verified' });
    expect(service.task(task.id).status).toBe(status);
  });

});
