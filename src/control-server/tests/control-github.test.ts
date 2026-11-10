import { describe, expect, it } from 'vitest';
import { ATTACHMENT_BRANCH, ControlGitHub, githubImageUrl } from '../github.js';
import type { Project, Task } from '../types.js';

const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
const task: Task = { id: 't1', projectId: 'p1', title: 'Local task', description: 'Instructions', status: 'ready', provider: 'codex', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' };
function mock(remote: any[] = [], issues: any[] = []) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url).replace('https://api.github.com/', '');
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method: options?.method ?? 'GET', body });
    let value: any;
    if (path === 'graphql') {
      if (body.query.includes('fields(first:100')) value = { data: { user: { projectV2: { id: 'PVT_1', fields: { nodes: [{ id: 'field', name: 'Status', options: [{ id: 'todo', name: 'Todo' }, { id: 'doing', name: 'In Progress' }, { id: 'done', name: 'Done' }] }], pageInfo: { hasNextPage: false } } } } } };
      else if (body.query.includes('items(first:100')) value = { data: { node: { items: { nodes: remote, pageInfo: { hasNextPage: false } } } } };
      else if (body.query.includes('addProjectV2ItemById')) value = { data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } };
      else value = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new' } } } };
    } else if (path.includes('/milestones')) value = [];
    else if (path.includes('?state=all')) value = issues;
    else value = { number: 12, node_id: 'I_new', html_url: 'https://github.com/owner/repo/issues/12', title: body?.title ?? 'Local task', body: body?.body ?? '', state: 'open' };
    return new Response(JSON.stringify(value), { status: 200 });
  }) as typeof fetch;
  return { calls, request };
}
const remoteIssue = (overrides: any = {}) => ({ id: 'PVTI_1', fieldValueByName: { name: 'In Progress' }, content: { id: 'I_1', number: 4, title: 'Remote task', body: 'Remote description', url: 'https://github.com/owner/repo/issues/4', state: 'OPEN', repository: { nameWithOwner: 'owner/repo' }, ...overrides } });

describe('Control GitHub synchronization', () => {
  it('reads existing blocker issues without importing or claiming their execution ownership', async () => {
    const fake = mock([remoteIssue()], []);
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith('repos/owner/repo/issues/4')) {
        fake.calls.push({ path: 'repos/owner/repo/issues/4', method: options?.method ?? 'GET', body: undefined });
        return new Response(JSON.stringify({ number: 4, title: 'External blocker', body: 'Owned by another team.', html_url: 'https://github.com/owner/repo/issues/4', state: 'closed', node_id: 'I_1' }));
      }
      return fake.request(url, options);
    }) as typeof fetch;
    const external = { ...task, id: 'external_4', externalDependency: true, github: { issueNumber: 4 } };
    const result = await new ControlGitHub('test-token', request).sync(project, [external]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ id: external.id, externalDependency: true, title: 'External blocker', status: 'done', description: 'Owned by another team.' });
    expect(fake.calls.filter((call) => call.path !== 'graphql').map((call) => `${call.method} ${call.path}`)).toEqual(['GET repos/owner/repo/milestones?state=all&per_page=100&page=1', 'GET repos/owner/repo/issues/4']);
    expect(fake.calls.filter((call) => call.path === 'graphql').every((call) => call.body.query.startsWith('query'))).toBe(true);
    expect(fake.calls.some((call) => JSON.stringify(call.body)?.includes('aiws-task'))).toBe(false);
  });
  it('rejects pull requests and invalid issue references during read-only lookup', async () => {
    const github = new ControlGitHub('test-token', (async () => new Response(JSON.stringify({ number: 4, pull_request: {} }))) as typeof fetch);
    await expect(github.lookupIssue(project, 4)).rejects.toThrow('not pull requests');
    await expect(github.lookupIssue(project, 0)).rejects.toThrow('positive integer');
    await expect(github.lookupIssue({ ...project, github: null }, 4)).rejects.toThrow('linked GitHub');
  });
  it('deletes an issue through GraphQL, looking up its node ID when the task does not store it', async () => {
    const fake = mock();
    const github = new ControlGitHub('test-token', fake.request);
    await github.deleteIssue(project, { issueNumber: 4, issueId: 'I_4' });
    await github.deleteIssue(project, { issueNumber: 12 });
    const deletes = fake.calls.filter((call) => call.path === 'graphql' && call.body.query.includes('deleteIssue'));
    expect(deletes.map((call) => call.body.variables.issueId)).toEqual(['I_4', 'I_new']);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toContain('GET repos/owner/repo/issues/12');
  });
  it('creates a real issue, attaches it to the Project, and writes the mapped status', async () => {
    const fake = mock();
    const result = await new ControlGitHub('test-token', fake.request).sync(project, [task]);
    expect(result.tasks[0]?.github?.issueNumber).toBe(12);
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/issues')?.body.body).toContain('<!-- aiws-task:t1 -->');
    expect(fake.calls.find((call) => call.body?.query?.includes('addProjectV2ItemById'))?.body.variables.content).toBe('I_new');
    expect(fake.calls.find((call) => call.body?.query?.includes('updateProjectV2ItemFieldValue'))?.body.variables.option).toBe('todo');
  });
  it('imports remote work and ignores other repositories in the same project', async () => {
    const fake = mock([remoteIssue(), remoteIssue({ number: 5, repository: { nameWithOwner: 'other/repo' } })]);
    const result = await new ControlGitHub('test-token', fake.request).sync(project, [], 'claude');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ title: 'Remote task', description: 'Remote description', status: 'running', autoStart: false, provider: 'claude' });
    expect(fake.calls.find((call) => call.method === 'PATCH')?.body.body).toContain(`<!-- aiws-task:${result.tasks[0]?.id} -->`);
  });
  it('pulls remote fields while preserving a simultaneous local title edit', async () => {
    const fake = mock([remoteIssue()]);
    const existing: Task = { ...task, title: 'New local title', description: 'Old description', status: 'ready', github: { issueNumber: 4, baseline: { title: 'Old title', description: 'Old description', status: 'ready' } } };
    const result = await new ControlGitHub('test-token', fake.request).sync(project, [existing]);
    expect(result.tasks[0]).toMatchObject({ title: 'New local title', description: 'Remote description', status: 'running' });
    const update = fake.calls.find((call) => call.method === 'PATCH');
    expect(update?.body).toMatchObject({ title: 'New local title', state: 'open' });
    expect(update?.body.body).toContain('Remote description');
  });
  it('reuses a previously created issue after a partial sync failure', async () => {
    const fake = mock([], [{ number: 12, node_id: 'I_new', html_url: 'https://github.com/owner/repo/issues/12', title: task.title, body: `${task.description}\n\n<!-- aiws-task:t1 -->`, state: 'open' }]);
    await new ControlGitHub('test-token', fake.request).sync(project, [task]);
    expect(fake.calls.some((call) => call.path === 'repos/owner/repo/issues' && call.method === 'POST')).toBe(false);
  });
  it('publishes local task images to the attachment branch and keeps local links in AIWS', async () => {
    const id = 'b'.repeat(64) + '.png', local = `![shot](/api/attachments/${id})`, remoteUrl = githubImageUrl('owner/repo', id);
    const images = { exists: async (value: string) => value === id, read: async () => ({ data: Buffer.from('image'), type: 'image/png' }) };
    const fake = mock(); let branch = false;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', ''), method = options?.method ?? 'GET';
      const reply = (value: unknown, status = 200) => { fake.calls.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : undefined }); return new Response(JSON.stringify(value), { status }); };
      if (path === `repos/owner/repo/git/ref/heads/${ATTACHMENT_BRANCH}`) return branch ? reply({ object: { sha: 'c1' } }) : reply({ message: 'Not Found' }, 404);
      if (path.startsWith('repos/owner/repo/contents/')) return reply({ message: 'Not Found' }, 404);
      if (path === 'repos/owner/repo/git/commits/c1') return reply({ tree: { sha: 'tree0' } });
      if (path === 'repos/owner/repo/git/blobs') return reply({ sha: 'blob1' });
      if (path === 'repos/owner/repo/git/trees') return reply({ sha: 'tree1' });
      if (path === 'repos/owner/repo/git/commits') return reply({ sha: 'c2' });
      if (path.startsWith('repos/owner/repo/git/refs')) { branch = true; return reply({ ref: `refs/heads/${ATTACHMENT_BRANCH}` }); }
      return fake.request(url, options);
    }) as typeof fetch;
    const result = await new ControlGitHub('test-token', request).sync(project, [{ ...task, description: local }], 'codex', { images });
    const created = fake.calls.find((call) => call.path === 'repos/owner/repo/issues' && call.method === 'POST');
    expect(created?.body.body).toContain(`![shot](${remoteUrl})`);
    expect(created?.body.body).not.toContain('/api/attachments/');
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/git/blobs')?.body).toEqual({ content: Buffer.from('image').toString('base64'), encoding: 'base64' });
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/git/trees')?.body.tree[0]).toMatchObject({ path: `.aiws/attachments/${id}`, sha: 'blob1' });
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/git/commits' && call.method === 'POST')?.body.parents).toEqual([]);
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/git/refs')?.body).toEqual({ ref: `refs/heads/${ATTACHMENT_BRANCH}`, sha: 'c2' });
    expect(result.tasks[0]).toMatchObject({ description: local, github: { baseline: { description: local } } });
    // Remote issues that reference published images map back to local attachments.
    const imported = await new ControlGitHub('test-token', mock([remoteIssue({ body: `See ![shot](${remoteUrl})` })]).request).sync(project, [], 'codex', { images });
    expect(imported.tasks[0]?.description).toBe(local.replace('![shot]', 'See ![shot]'));
    // Without the local file the GitHub link is kept so materialization can download it.
    const missing = await new ControlGitHub('test-token', mock([remoteIssue({ body: `![shot](${remoteUrl})` })]).request).sync(project, [], 'codex', { images: { ...images, exists: async () => false } });
    expect(missing.tasks[0]?.description).toBe(`![shot](${remoteUrl})`);
  });
  it('keeps a local image link when the image cannot be published', async () => {
    const id = 'c'.repeat(64) + '.png', fake = mock();
    const request = (async (url: string | URL | Request, options?: RequestInit) => String(url).includes('/git/') ? new Response('{"message":"Git Repository is empty."}', { status: 409 }) : fake.request(url, options)) as typeof fetch;
    await new ControlGitHub('test-token', request).sync(project, [{ ...task, description: `![x](/api/attachments/${id})` }], 'codex', { images: { exists: async () => true, read: async () => ({ data: Buffer.from('i'), type: 'image/png' }) } });
    expect(fake.calls.find((call) => call.path === 'repos/owner/repo/issues' && call.method === 'POST')?.body.body).toContain(`/api/attachments/${id}`);
  });
  it('reports GraphQL authorization errors without leaking credentials', async () => {
    const request = (async () => new Response(JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }] }), { status: 200 })) as typeof fetch;
    await expect(new ControlGitHub('secret-token', request).sync(project, [task])).rejects.toThrow('Resource not accessible by integration');
  });
});
