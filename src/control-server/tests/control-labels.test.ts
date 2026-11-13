import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';
import { ControlGitHub } from '../github.js';
import { ControlStore } from '../store.js';
import { canonicalTags, defaultLabelColor, mergeLabels, validateLabels } from '../labels.js';
import { ProviderModels } from '../provider-models.js';
import type { Project, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-labels-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0 });
  return { root, service, project: service.createProject({ name: 'Labels', repositoryPath: workspace }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project labels', () => {
  it('validates GitHub label rules and keeps names unique without regard to case', () => {
    expect(validateLabels([{ name: ' bug ', color: '#D73A4A' }])).toEqual([{ name: 'bug', color: 'd73a4a', description: '' }]);
    expect(validateLabels([{ name: 'docs' }])[0]!.color).toBe(defaultLabelColor('DOCS'));
    expect(() => validateLabels([{ name: 'a'.repeat(51) }])).toThrow('1-50');
    expect(() => validateLabels([{ name: 'x', color: 'red' }])).toThrow('hex');
    expect(() => validateLabels([{ name: 'x', description: 'd'.repeat(101) }])).toThrow('100');
    expect(() => validateLabels([{ name: 'Bug' }, { name: 'bug' }])).toThrow('more than once');
    expect(canonicalTags(['BUG', ' bug', 'new'], [{ name: 'bug', color: 'd73a4a', description: '' }])).toEqual(['bug', 'new']);
    expect(mergeLabels([{ name: 'bug', color: '000000', description: '' }], [{ name: 'Bug', color: 'ffffff', description: 'x' }, { name: 'docs', color: '0075ca', description: '' }], true))
      .toEqual({ labels: [{ name: 'bug', color: 'ffffff', description: 'x' }, { name: 'docs', color: '0075ca', description: '' }], added: ['docs'], updated: ['bug'] });
  });

  it('learns labels from task tags, follows renames and removes deleted labels from tasks', async () => {
    const { service, project } = await setup();
    const task = service.createTask({ projectId: project.id, title: 'Tagged', tags: ['bug', 'ui'] });
    expect(service.project(project.id).labels?.map((label) => label.name)).toEqual(['bug', 'ui']);
    // Later tags reuse the label's spelling.
    expect(service.updateTask(task.id, { tags: ['BUG', 'ui'] }).tags).toEqual(['bug', 'ui']);
    service.setProjectLabels(project.id, { labels: [{ previousName: 'bug', name: 'defect', color: 'b60205', description: 'Broken' }, { name: 'docs' }] });
    expect(service.task(task.id).tags).toEqual(['defect']);
    expect(service.project(project.id).labels).toEqual([{ name: 'defect', color: 'b60205', description: 'Broken' }, { name: 'docs', color: defaultLabelColor('docs'), description: '' }]);
    expect(() => service.setProjectLabels(project.id, { labels: [{ name: 'a,b' }] })).toThrow('commas');
  });

  it('runs tasks with labels that no agent declares as a capability', async () => {
    const { service, project } = await setup();
    // Labels used to demand a matching agent even when no agent profile existed at all.
    const task = service.createTask({ projectId: project.id, title: 'Fix it', provider: 'command', tags: ['bug'], command: { executable: process.execPath, args: ['-e', ''] } });
    const run = service.startTask(task.id);
    expect(run.executionSnapshot?.agent).toBeNull();
    await service.stop(run.id);
  });

  it('imports and exports GitHub labels and imports them while connecting', async () => {
    const { service, project } = await setup();
    service.updateProject(project.id, { github: { repository: 'owner/repo', owner: 'owner', number: 1 } });
    service.setProjectLabels(project.id, { labels: [{ name: 'bug', color: '000000', description: '' }, { name: 'local', color: '0e8a16', description: 'Only here' }] });
    vi.spyOn(ControlGitHub.prototype, 'labels').mockResolvedValue([{ name: 'Bug', color: 'd73a4a', description: 'Something is wrong' }, { name: 'help wanted', color: '008672', description: '' }]);
    const imported = await service.importGitHubLabels(project.id, { overwrite: true });
    expect(imported).toMatchObject({ added: ['help wanted'], updated: ['bug'] });
    expect(service.project(project.id).labels).toEqual([{ name: 'bug', color: 'd73a4a', description: 'Something is wrong' }, { name: 'local', color: '0e8a16', description: 'Only here' }, { name: 'help wanted', color: '008672', description: '' }]);
    const exported = vi.spyOn(ControlGitHub.prototype, 'exportLabels').mockResolvedValue({ created: ['local'], updated: [] });
    expect(await service.exportGitHubLabels(project.id)).toEqual({ created: ['local'], updated: [] });
    expect(exported.mock.calls[0]![1].map((label) => label.name)).toEqual(['bug', 'local', 'help wanted']);
    vi.spyOn(ControlGitHub.prototype, 'connect').mockResolvedValue({ repository: 'owner/other', owner: 'owner', number: 2 });
    const second = service.createProject({ name: 'Second', repositoryPath: service.project(project.id).repositoryPath });
    const connected = await service.connectProject(second.id, { projectNumber: 2, importLabels: true });
    expect(connected.labels?.map((label) => label.name)).toEqual(['Bug', 'help wanted']);
  });

  it('adopts existing task tags as labels for projects saved before labels existed', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-labels-store-')); roots.push(root);
    const store = new ControlStore(root);
    const project = { id: 'p', name: 'Old', description: '', repositoryPath: root, github: null, createdAt: '', updatedAt: '' } as Project;
    store.state.projects.push(project);
    store.state.tasks.push({ id: 't', projectId: 'p', title: 'Old', description: '', status: 'backlog', provider: 'codex', priority: 0, tags: ['frontend', 'Frontend', 'x'.repeat(80)], dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' } as Task);
    store.save(); store.close();
    const reopened = new ControlStore(root);
    expect(reopened.state.projects[0]!.labels?.map((label) => label.name)).toEqual(['frontend']);
    reopened.close();
  });
});

describe('GitHub label synchronization', () => {
  const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
  const base: Task = { id: 't1', projectId: 'p1', title: 'Task', description: 'Body', status: 'ready', provider: 'codex', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' };
  function fake(remote: any[], labels: any[] = []) {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', ''); const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path, method: options?.method ?? 'GET', body });
      let value: any;
      if (path === 'graphql') {
        if (body.query.includes('fields(first:100')) value = { data: { user: { projectV2: { id: 'PVT', fields: { nodes: [{ id: 'f', name: 'Status', options: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }] }], pageInfo: { hasNextPage: false } } } } } };
        else if (body.query.includes('items(first:100')) value = { data: { node: { items: { nodes: remote, pageInfo: { hasNextPage: false } } } } };
        else if (body.query.includes('addProjectV2ItemById')) value = { data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } };
        else value = { data: {} };
      } else if (path.startsWith('repos/owner/repo/labels?')) value = labels;
      else if (path.includes('?state=all')) value = [];
      else value = { number: 12, node_id: 'I_new', html_url: 'https://github.com/owner/repo/issues/12', title: body?.title ?? '', body: body?.body ?? '', state: 'open', labels: (body?.labels ?? []).map((name: string) => ({ name, color: 'ededed' })) };
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof fetch;
    return { calls, request };
  }
  const issue = (labels: any[], overrides: any = {}) => ({ id: 'PVTI_1', fieldValueByName: { name: 'Todo' }, content: { id: 'I_1', number: 4, title: 'Task', body: 'Body\n\n<!-- aiws-task:t1 -->', url: 'u', state: 'OPEN', repository: { nameWithOwner: 'owner/repo' }, labels: { nodes: labels }, ...overrides } });

  it('imports remote labels with their definitions and creates issues with local labels', async () => {
    const remote = fake([issue([{ name: 'bug', color: 'd73a4a', description: 'Broken' }], { number: 9, body: 'Remote' })]);
    const result = await new ControlGitHub('token', remote.request).sync(project, [{ ...base, tags: ['ui'] }]);
    expect(result.tasks.find((task) => task.github?.issueNumber === 9)?.tags).toEqual(['bug']);
    expect(result.labels).toEqual(expect.arrayContaining([{ name: 'bug', color: 'd73a4a', description: 'Broken' }]));
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/issues' && call.method === 'POST')?.body.labels).toEqual(['ui']);
    expect(result.tasks.find((task) => task.id === 't1')?.github?.baseline?.labels).toEqual(['ui']);
  });

  it('pushes local label edits, pulls remote ones, and leaves unchanged labels alone', async () => {
    const synced = { ...base, tags: ['bug'], github: { issueNumber: 4, baseline: { title: 'Task', description: 'Body', status: 'ready' as const, labels: ['bug'] } } };
    let remote = fake([issue([{ name: 'bug', color: 'd73a4a' }])]);
    await new ControlGitHub('token', remote.request).sync(project, [synced]);
    expect(remote.calls.some((call) => call.method === 'PATCH')).toBe(false);
    remote = fake([issue([{ name: 'bug', color: 'd73a4a' }])]);
    await new ControlGitHub('token', remote.request).sync(project, [{ ...synced, tags: ['bug', 'ui'] }]);
    expect(remote.calls.find((call) => call.method === 'PATCH')?.body.labels).toEqual(['bug', 'ui']);
    remote = fake([issue([{ name: 'bug', color: 'd73a4a' }, { name: 'p1', color: 'b60205' }])]);
    const pulled = await new ControlGitHub('token', remote.request).sync(project, [synced]);
    expect(pulled.tasks[0]?.tags).toEqual(['bug', 'p1']);
    expect(remote.calls.some((call) => call.method === 'PATCH')).toBe(false);
    // Tasks linked before labels existed take the remote labels.
    remote = fake([issue([{ name: 'p1', color: 'b60205' }])]);
    const legacy = await new ControlGitHub('token', remote.request).sync(project, [{ ...base, github: { issueNumber: 4, baseline: { title: 'Task', description: 'Body', status: 'ready' } } }]);
    expect(legacy.tasks[0]?.tags).toEqual(['p1']);
  });

  it('creates missing repository labels and updates differing ones on export', async () => {
    const remote = fake([], [{ name: 'Bug', color: 'd73a4a', description: '' }, { name: 'same', color: '0075ca', description: '' }]);
    const result = await new ControlGitHub('token', remote.request).exportLabels(project, [{ name: 'bug', color: 'b60205', description: 'Broken' }, { name: 'same', color: '0075ca', description: '' }, { name: 'new one', color: '0e8a16', description: '' }]);
    expect(result).toEqual({ created: ['new one'], updated: ['bug'] });
    expect(remote.calls.find((call) => call.method === 'PATCH')).toMatchObject({ path: 'repos/owner/repo/labels/Bug', body: { new_name: 'bug', color: 'b60205', description: 'Broken' } });
    expect(remote.calls.find((call) => call.method === 'POST')).toMatchObject({ path: 'repos/owner/repo/labels', body: { name: 'new one', color: '0e8a16' } });
  });
});

describe('provider models', () => {
  it('reads the Codex and Claude Code caches and the OpenCode and Antigravity model commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aiws-models-')); roots.push(home);
    mkdirSync(join(home, '.codex')); mkdirSync(join(home, '.claude', 'cache', 'model-catalog'), { recursive: true });
    writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-b', display_name: 'GPT B', visibility: 'list', priority: 9 }, { slug: 'hidden', visibility: 'hide', priority: 1 }, { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list', priority: 4, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'unknown' }] }] }));
    const catalog = (fetchedAt: number, ids: string[]) => JSON.stringify({ fetchedAt, catalog: { config: { models: ids.map((id) => ({ id, name: id.toUpperCase() })) } } });
    writeFileSync(join(home, '.claude', 'cache', 'model-catalog', 'old-cc.json'), catalog(1, ['claude-old']));
    writeFileSync(join(home, '.claude', 'cache', 'model-catalog', 'new-cc.json'), catalog(2, ['claude-opus-5-5', 'claude-sonnet-5-5']));
    writeFileSync(join(home, '.claude', 'cache', 'model-catalog', 'desktop-ccd.json'), catalog(3, ['desktop-only']));
    // Copilot lists its model IDs under the `model` setting of `copilot help config` (format of CLI 1.0.100).
    const copilotConfig = '  `log_level`: Logging level.\n    - "info"\n  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.\n    - "claude-sonnet-5.5"\n    - "gpt-6.1-sol"\n\n  `theme`: Color theme.\n    - "dark"\n';
    const run = vi.fn(async (executable: string) => executable === 'opencode' ? 'opencode/big-pickle\nnot a model\ngoogle/gemini-2.5-pro\n' : executable === 'copilot' ? copilotConfig : 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\n');
    const models = new ProviderModels({ home, env: {}, run, now: () => new Date('2026-10-18T00:00:00Z') });
    expect(await models.list('codex')).toEqual({ models: [{ id: 'gpt-a', name: 'GPT A', efforts: ['low', 'high'] }, { id: 'gpt-b', name: 'GPT B' }], refreshedAt: '2026-10-18T00:00:00.000Z', source: 'Codex model cache' });
    // Refreshed models carry the profile their provider knows for the family; unknown models stay plain.
    expect((await models.list('claude')).models).toEqual([{ id: 'claude-opus-5-5', name: 'CLAUDE-OPUS-5-5', profile: { speed: 2, quality: 4, cost: 4 } }, { id: 'claude-sonnet-5-5', name: 'CLAUDE-SONNET-5-5', profile: { speed: 4, quality: 3, cost: 3 } }]);
    expect((await models.list('opencode')).models).toEqual([{ id: 'opencode/big-pickle' }, { id: 'google/gemini-2.5-pro', profile: { speed: 2, quality: 4, cost: 3 } }]);
    expect((await models.list('agy')).models).toEqual([{ id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)', profile: { speed: 1, quality: 5, cost: 5 } }]);
    expect(await models.list('copilot')).toMatchObject({ models: [{ id: 'claude-sonnet-5.5' }, { id: 'gpt-6.1-sol' }], source: 'copilot help config' });
    await expect(new ProviderModels({ home: join(home, 'missing'), env: {} }).list('codex')).rejects.toThrow('cached');
  });

  it('stores refreshed models in the state only when asked', async () => {
    const { service } = await setup();
    expect(service.snapshot().providerModels).toBeUndefined();
    vi.spyOn(service.providerModels, 'list').mockResolvedValue({ models: [{ id: 'm1' }], refreshedAt: '2026-10-18T00:00:00.000Z', source: 'test' });
    await service.refreshProviderModels('claude');
    expect(service.snapshot().providerModels?.claude?.models).toEqual([{ id: 'm1' }]);
    await expect(service.refreshProviderModels('command')).rejects.toThrow('Unknown provider');
  });
});
