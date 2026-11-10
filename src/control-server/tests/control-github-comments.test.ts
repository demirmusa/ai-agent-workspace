import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { removeTempRoot } from './helpers/temp-root.js';
import { ControlGitHub, COMMENT_MARKER, triggeredRequest, type IssueComment } from '../github.js';
import type { Project, Task } from '../types.js';

const roots: string[] = []; const services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeTempRoot(root); });
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) { const value = read(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('Timed out waiting for condition.'); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-github-comments-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = new ControlService({ dataDir: join(root, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
  const project = service.createProject({ useWorktree: false, name: 'Phone', repositoryPath: workspace, github: { repository: 'owner/repo', owner: 'owner', number: 3 } });
  vi.spyOn(ControlGitHub.prototype, 'sync').mockImplementation(async (value, tasks) => ({ project: value, tasks }));
  const posted: Array<{ issue: number; body: string }> = [];
  vi.spyOn(ControlGitHub.prototype, 'comment').mockImplementation(async (_project, issue, body) => { posted.push({ issue, body }); return { id: posted.length, url: `https://github.com/owner/repo/issues/${issue}#c${posted.length}` }; });
  const reactions: string[] = [];
  vi.spyOn(ControlGitHub.prototype, 'react').mockImplementation(async (_project, _id, content) => { reactions.push(content); });
  const comments = vi.spyOn(ControlGitHub.prototype, 'comments').mockResolvedValue([]);
  return { service, project, posted, reactions, comments };
}
const later = () => new Date(Date.now() + 120_000).toISOString();
const remoteComment = (id: number, body: string, association = 'OWNER', issueNumber = 5): IssueComment => ({ id, issueNumber, body, author: 'musa', association, createdAt: later(), url: `https://github.com/owner/repo/issues/${issueNumber}#issuecomment-${id}` });
const longRunning = { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] };

describe('GitHub issue conversation', () => {
  it('recognizes the trigger only as a word outside quoted replies', () => {
    expect(triggeredRequest('/ai fix the login page', '/ai')).toBe('fix the login page');
    expect(triggeredRequest('Please /AI, summarize.', '/ai')).toBe('Please , summarize.');
    expect(triggeredRequest('> /ai earlier request\nthanks', '/ai')).toBeNull();
    expect(triggeredRequest('/aid is not a trigger', '/ai')).toBeNull();
    expect(triggeredRequest('ask @aiws-bot?', '@aiws-bot')).toBe('ask ?');
  });

  it('auto-syncs only projects connected to GitHub Projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-github-autosync-')); roots.push(root); mkdirSync(join(root, 'local')); mkdirSync(join(root, 'linked'));
    const sync = vi.spyOn(ControlGitHub.prototype, 'sync').mockImplementation(async (value, tasks) => ({ project: value, tasks }));
    vi.spyOn(ControlGitHub.prototype, 'comments').mockResolvedValue([]);
    vi.spyOn(ControlGitHub.prototype, 'changeMark').mockResolvedValue('mark');
    const service = new ControlService({ dataDir: join(root, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 30 });
    service.createProject({ name: 'Local', repositoryPath: join(root, 'local') });
    (service as any).tick();
    expect(sync).not.toHaveBeenCalled();
    const linked = service.createProject({ name: 'Linked', repositoryPath: join(root, 'linked'), github: { repository: 'owner/repo', owner: 'owner', number: 3 } });
    (service as any).tick();
    await waitFor(() => sync.mock.calls.length, (count) => count > 0);
    expect(sync.mock.calls.map(([project]) => project.id)).toEqual([linked.id]);
  });

  it('runs the full sync only when GitHub or the local tasks changed since the last one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-github-poll-')); roots.push(root); mkdirSync(join(root, 'linked'));
    const sync = vi.spyOn(ControlGitHub.prototype, 'sync').mockImplementation(async (value, tasks) => ({ project: value, tasks }));
    vi.spyOn(ControlGitHub.prototype, 'comments').mockResolvedValue([]);
    let mark = 'board-1';
    const probe = vi.spyOn(ControlGitHub.prototype, 'changeMark').mockImplementation(async () => mark);
    const service = new ControlService({ dataDir: join(root, 'data') }); services.push(service); service.updateSettings({ autoSyncSeconds: 0 });
    const project = service.createProject({ name: 'Linked', repositoryPath: join(root, 'linked'), github: { repository: 'owner/repo', owner: 'owner', number: 3 } });
    const bridge = (service as any).githubBridge;
    const poll = async () => { const probes = probe.mock.calls.length; await bridge.poll(project.id); expect(probe.mock.calls.length).toBe(probes + 1); };
    await poll(); expect(sync).toHaveBeenCalledTimes(1);
    await poll(); expect(sync).toHaveBeenCalledTimes(1);
    mark = 'board-2';
    await poll(); expect(sync).toHaveBeenCalledTimes(2);
    await poll(); expect(sync).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    service.createTask({ projectId: project.id, title: 'Local edit' });
    await poll(); expect(sync).toHaveBeenCalledTimes(3);
    await poll(); expect(sync).toHaveBeenCalledTimes(3);
    // A probe that fails cannot prove nothing changed.
    probe.mockRejectedValueOnce(new Error('offline'));
    await bridge.poll(project.id); expect(sync).toHaveBeenCalledTimes(4);
  });

  it('reads the board, issue and milestone change times in one query', async () => {
    const queries: any[] = [];
    const request = (async (_url: string | URL | Request, options?: RequestInit) => {
      queries.push(JSON.parse(String(options?.body)));
      return new Response(JSON.stringify({ data: { repository: { issues: { nodes: [{ updatedAt: '2026-11-10T10:00:00Z' }] }, milestones: { nodes: [] } }, organization: { projectV2: { updatedAt: '2026-11-10T09:00:00Z' } } } }));
    }) as typeof fetch;
    const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'acme/repo', owner: 'acme', ownerType: 'organization', number: 7 }, createdAt: '', updatedAt: '' };
    expect(await new ControlGitHub('token', request).changeMark(project)).toBe('2026-11-10T09:00:00Z|2026-11-10T10:00:00Z|');
    expect(queries).toHaveLength(1);
    expect(queries[0].variables).toEqual({ repositoryOwner: 'acme', repositoryName: 'repo', owner: 'acme', number: 7 });
    expect(queries[0].query).toContain('organization(login:$owner){projectV2(number:$number){updatedAt}}');
  });

  it('adds trusted new issues to the board and makes trigger issues ready', async () => {
    const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
    const mutations: any[] = [];
    const issue = (number: number, body: string, association = 'OWNER', created = '2026-10-17T10:00:00Z') => ({ number, node_id: `I_${number}`, title: `Issue ${number}`, body, html_url: `https://github.com/owner/repo/issues/${number}`, created_at: created, author_association: association });
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', ''); const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      let value: any = { number: 1, node_id: 'x', html_url: '', title: '', body: '', state: 'open' };
      if (path === 'graphql') {
        if (body.query.includes('fields(first:100')) value = { data: { user: { projectV2: { id: 'PVT', fields: { nodes: [{ id: 'field', name: 'Status', options: [{ id: 'todo', name: 'Todo' }, { id: 'ready', name: 'Ready' }, { id: 'done', name: 'Done' }] }], pageInfo: { hasNextPage: false } } } } } };
        else if (body.query.includes('items(first:100')) value = { data: { node: { items: { nodes: [], pageInfo: { hasNextPage: false } } } } };
        else { mutations.push(body); value = { data: { addProjectV2ItemById: { item: { id: `PVTI_${body.variables.content}` } }, updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } } } }; }
      } else if (path.startsWith('repos/owner/repo/issues?state=open')) {
        expect(path).toContain('since=2026-10-17T09%3A00%3A00Z');
        value = [issue(8, '/ai build the settings page'), issue(9, 'Plain idea'), issue(10, '/ai run this', 'NONE'), issue(11, 'Old', 'OWNER', '2026-10-01T00:00:00Z'), { ...issue(12, ''), pull_request: {} }];
      }
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof fetch;
    const result = await new ControlGitHub('token', request).sync(project, [], 'codex', { intakeSince: '2026-10-17T09:00:00Z', connectedAt: '2026-10-17T09:00:00Z', trigger: '/ai' });
    expect(result.tasks.map((task) => [task.github?.issueNumber, task.status])).toEqual([[8, 'ready'], [9, 'backlog']]);
    expect(mutations.filter((entry) => entry.query.includes('addProjectV2ItemById')).map((entry) => entry.variables.content)).toEqual(['I_8', 'I_9']);
    expect(mutations.find((entry) => entry.query.includes('updateProjectV2ItemFieldValue') && entry.variables.item === 'PVTI_I_8')?.variables.option).toBe('ready');
  });

  it('reads comments and reports OAuth scopes', async () => {
    const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
    const calls: string[] = [];
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', ''); calls.push(`${options?.method} ${path}`);
      if (path === 'user') return new Response(JSON.stringify({ login: 'musa' }), { status: 200, headers: { 'x-oauth-scopes': 'repo, read:org' } });
      if (path.includes('/comments?')) return new Response(JSON.stringify([
        { id: 1, issue_url: 'https://api.github.com/repos/owner/repo/issues/5', body: 'hi', user: { login: 'musa' }, author_association: 'OWNER', created_at: '2026-10-17T10:00:00Z', html_url: 'u' },
        { id: 2, issue_url: 'https://api.github.com/repos/owner/repo/issues/6', body: 'edited old', user: { login: 'x' }, author_association: 'NONE', created_at: '2026-10-01T10:00:00Z', html_url: 'u' },
      ]));
      return new Response(JSON.stringify({ id: 99, html_url: 'https://github.com/owner/repo/issues/5#issuecomment-99' }), { status: 201 });
    }) as typeof fetch;
    const github = new ControlGitHub('token', request);
    expect(await github.comments(project, '2026-10-17T09:00:00Z')).toMatchObject([{ id: 1, issueNumber: 5, author: 'musa', association: 'OWNER' }]);
    expect(await github.authStatus()).toMatchObject({ authenticated: true, login: 'musa', scopes: ['repo', 'read:org'], missing: ['project'] });
    const created = await github.comment(project, 5, 'Answer');
    expect(created.id).toBe(99); expect(calls.at(-1)).toBe('POST repos/owner/repo/issues/5/comments');
  });

  it('mirrors agent questions to the issue and accepts the answer from a trusted comment', async () => {
    const { service, project, posted, reactions, comments } = setup();
    const task = service.createTask({ projectId: project.id, title: 'Linked', provider: 'command', command: longRunning });
    service.task(task.id).github = { issueNumber: 5 };
    await service.sync(project.id);
    const run = service.startTask(task.id);
    const question = service.ask(run.id, { text: 'Which database should I use?' });
    await waitFor(() => posted, (items) => items.length === 1);
    expect(posted[0]).toMatchObject({ issue: 5 }); expect(posted[0]!.body).toContain('Which database should I use?');
    comments.mockResolvedValueOnce([remoteComment(1, 'Use Postgres', 'NONE'), remoteComment(2, 'Use Postgres'), remoteComment(2, 'duplicate'), remoteComment(3, `bot ${COMMENT_MARKER}`)]);
    await service.sync(project.id);
    expect(service.store.state.questions.find((item) => item.id === question.id)).toMatchObject({ status: 'answered', answer: 'Use Postgres' });
    expect(service.store.state.events.some((event) => event.type === 'github.comment.ignored')).toBe(true);
    expect(reactions).toEqual(['eyes']);
    expect(service.run(run.id).status).toBe('running');
    await service.stop(run.id);
  });

  it('posts the final reply when a linked run completes and queues trigger requests for unstarted tasks', async () => {
    const { service, project, posted, comments } = setup();
    const task = service.createTask({ projectId: project.id, title: 'Answer me', provider: 'command', command: longRunning });
    service.task(task.id).github = { issueNumber: 5 };
    await service.sync(project.id);
    const run = service.startTask(task.id);
    service.complete(run.id, { summary: 'Checked.', reply: 'The cache was stale; cleared it.' });
    const reply = await waitFor(() => posted, (items) => items.length === 1);
    expect(reply[0]!.body).toContain('finished'); expect(reply[0]!.body).toContain('The cache was stale; cleared it.');
    expect(service.store.state.messages.some((message) => message.authorType === 'agent' && message.text === 'The cache was stale; cleared it.')).toBe(true);

    service.updateSettings({ systemEnabled: false });
    const fresh = service.createTask({ projectId: project.id, title: 'Unstarted', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    service.task(fresh.id).github = { issueNumber: 6 };
    comments.mockResolvedValueOnce([remoteComment(10, 'No trigger here', 'OWNER', 6), remoteComment(11, '/ai add a dark mode toggle', 'OWNER', 6)]);
    await service.sync(project.id);
    expect(service.task(fresh.id)).toMatchObject({ status: 'ready' });
    expect(service.task(fresh.id).githubInstructions).toHaveLength(1);
    service.updateSettings({ systemEnabled: true });
    const started = await waitFor(() => service.task(fresh.id), (value: Task) => Boolean(value.currentRunId));
    const prompt = readFileSync(join(service.run(started.currentRunId!).inputDirectory!, 'prompt.md'), 'utf8');
    expect(prompt).toContain('add a dark mode toggle'); expect(prompt).toContain('aiws control reply');
    expect(service.task(fresh.id).githubInstructions).toBeUndefined();
    await waitFor(() => posted, (items) => items.some((item) => item.issue === 6));
  });

  it('creates a private repository for a folder without a GitHub remote, adds origin and pushes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-create-repo-')); roots.push(root);
    const folder = join(root, 'my app'); mkdirSync(folder); const bare = join(root, 'remote.git');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--bare', bare]); git(folder, 'init'); writeFileSync(join(folder, 'README.md'), 'hello');
    git(folder, 'add', '.'); git(folder, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-m', 'init');
    const created: any[] = [];
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', '');
      if (path === 'user') return new Response(JSON.stringify({ login: 'musa' }));
      if (path === 'user/repos') { created.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ full_name: 'musa/my-app', html_url: 'https://github.com/musa/my-app', clone_url: bare }), { status: 201 }); }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const result = await new ControlGitHub('token', request).createRepository(folder);
    expect(created).toEqual([{ name: 'my-app', private: true }]);
    expect(result).toMatchObject({ repository: 'musa/my-app', remote: 'origin', pushed: true });
    expect(git(folder, 'remote', 'get-url', 'origin')).toBe(bare);
    expect(git(bare, 'log', '--oneline')).toContain('init');
    await expect(new ControlGitHub('token', request).createRepository(folder, { name: 'bad name!' })).rejects.toThrow('Repository name');
  });

  it('deletes merged pull request branches on GitHub but never the default branch', async () => {
    const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
    const deleted: string[] = [];
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', '');
      if (options?.method === 'DELETE') { deleted.push(path); return new Response(null, { status: path.endsWith('gone') ? 422 : 204 }); }
      return new Response(JSON.stringify({ default_branch: 'main' }));
    }) as typeof fetch;
    const github = new ControlGitHub('token', request);
    expect(await github.deleteBranch(project, 'aiws/task_1')).toBe(true);
    expect(await github.deleteBranch(project, 'gone')).toBe(false);
    expect(await github.deleteBranch(project, 'main')).toBe(false);
    expect(deleted).toEqual(['repos/owner/repo/git/refs/heads/aiws/task_1', 'repos/owner/repo/git/refs/heads/gone']);
  });

  it('removes the pull request branch after GitHub confirms the merge', async () => {
    const { service, project } = setup();
    vi.spyOn(ControlGitHub.prototype, 'mergePullRequest').mockResolvedValue({ number: 4, url: 'https://github.com/owner/repo/pull/4', headSha: 'a'.repeat(40), merged: true, message: 'Merged.', headRef: 'feature/phone' });
    // The workspace is not a Git repository, so there is no origin/main to verify the merge against.
    vi.spyOn((service as unknown as { delivery: { verifyPullRequestMain(): Promise<undefined> } }).delivery, 'verifyPullRequestMain').mockResolvedValue(undefined);
    const removed = vi.spyOn(ControlGitHub.prototype, 'deleteBranch').mockResolvedValue(true);
    const task = service.createTask({ projectId: project.id, title: 'PR task', autoMerge: true, provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    service.task(task.id).github = { issueNumber: 5 };
    service.startTask(task.id);
    await waitFor(() => removed.mock.calls, (calls) => calls.length === 1);
    expect(removed.mock.calls[0]![1]).toBe('feature/phone');
    await waitFor(() => service.store.state.events, (events) => events.some((event) => event.type === 'github.branch.deleted'));
  });

  it('validates the trigger setting', () => {
    const { service } = setup();
    expect(service.store.state.settings.githubTrigger).toBe('/ai');
    expect(() => service.updateSettings({ githubTrigger: 'a b' })).toThrow('githubTrigger');
    expect(service.updateSettings({ githubTrigger: '@aiws-bot' }).githubTrigger).toBe('@aiws-bot');
  });
});
