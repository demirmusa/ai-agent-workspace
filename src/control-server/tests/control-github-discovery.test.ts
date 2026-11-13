import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ControlGitHub, githubRepositoryFromRemote } from '../github.js';
import type { Project, Task } from '../types.js';
const project: Project = { id: 'p', name: 'Project', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 1 }, autoMerge: true, createdAt: '', updatedAt: '' };
const task: Task = { id: 'task_verified', projectId: 'p', title: 'Task', description: '', provider: 'codex', status: 'review', priority: 0, autoStart: false, currentRunId: null, dependsOn: [], pullRequest: { number: 9, headSha: 'head123' }, createdAt: '', updatedAt: '' };
describe('GitHub discovery and verified task pull requests', () => {
  it('recognizes GitHub HTTPS, SSH and scp remotes without returning embedded credentials', () => {
    for (const remote of ['https://github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'https://user:placeholder@github.com/owner/repo.git']) expect(githubRepositoryFromRemote(remote)).toBe('owner/repo');
    expect(githubRepositoryFromRemote('https://github.com.evil.invalid/owner/repo.git')).toBeNull();
    // A ".." segment would move every repos/<slug>/... API call to another endpoint.
    expect(githubRepositoryFromRemote('git@github.com:../user.git')).toBeNull();
    expect(githubRepositoryFromRemote('https://enterprise.example/owner/repo.git')).toBeNull();
  });
  it('prefers origin and discovers actual linked Project titles without manual owner fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-github-detect-'));
    try {
      execFileSync('git', ['init', '-q', directory]); execFileSync('git', ['-C', directory, 'remote', 'add', 'other', 'git@github.com:other/repo.git']); execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
      const request = (async (url: any, options: any) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (String(url).endsWith('repos/owner/repo')) return new Response(JSON.stringify({ full_name: 'owner/repo', default_branch: 'main', owner: { login: 'owner', type: 'User' } }));
        const connection = { nodes: [{ id: 'PVT_board', number: 12, title: 'Actual delivery board', url: 'https://github.com/users/owner/projects/12', closed: false, owner: { __typename: 'User', login: 'owner' } }], pageInfo: { hasNextPage: false } };
        return new Response(JSON.stringify({ data: body.query.includes('repository(') ? { repository: { projectsV2: connection } } : { user: { projectsV2: connection } } }));
      }) as typeof fetch;
      const result = await new ControlGitHub('test-token', request).detect(directory);
      expect(result).toMatchObject({ repository: 'owner/repo', suggestedProject: 12, projects: [{ title: 'Actual delivery board', linked: true }] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('connects a discovered board and adds missing lifecycle states while preserving existing option identities', async () => {
    let updated: any;
    const request = (async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('fields(first:100')) return new Response(JSON.stringify({ data: { node: { fields: { nodes: [{ id: 'status_field', name: 'Status', options: [{ id: 'keep_todo', name: 'Todo', color: 'PINK', description: 'Existing description' }] }], pageInfo: { hasNextPage: false } } } } }));
      updated = body.variables.input; return new Response(JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'status_field' } } } }));
    }) as typeof fetch;
    const github = new ControlGitHub('test-token', request);
    vi.spyOn(github, 'detect').mockResolvedValue({ repository: 'owner/repo', owner: 'owner', ownerType: 'user', defaultBranch: 'main', suggestedProject: 12, projects: [{ id: 'PVT_board', number: 12, title: 'Board', url: 'https://github.com/users/owner/projects/12', owner: 'owner', ownerType: 'user', linked: true }] });
    const connection = await github.connect('/fixture');
    expect(connection).toMatchObject({ repository: 'owner/repo', number: 12, statuses: { ready: 'Ready', review: 'In review' } });
    expect(updated.singleSelectOptions[0]).toEqual({ id: 'keep_todo', name: 'Todo', color: 'PINK', description: 'Existing description' });
    expect(updated.singleSelectOptions.some((option: any) => option.name === 'Ready')).toBe(true);
    await expect(github.connect('/fixture', { createProject: 'false' } as any)).rejects.toThrow('must be boolean');
  });
  function merger(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
    const mutations: Array<{ path: string; body: any }> = [];
    const request = (async (url: any, options: any) => {
      const path = String(url).replace('https://api.github.com/', ''); const body = options.body ? JSON.parse(options.body) : undefined;
      let value: any;
      if (path === 'repos/owner/repo') value = { default_branch: 'main', permissions: { push: true }, allow_auto_merge: true, allow_squash_merge: true, ...metadata };
      else if (path === 'repos/owner/repo/pulls/9') value = { number: 9, node_id: 'PR_node', html_url: 'https://github.com/owner/repo/pull/9', body: '<!-- aiws-task:task_verified -->', state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'head123', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, ...overrides };
      else { mutations.push({ path, body }); value = path === 'graphql' ? { data: { enablePullRequestAutoMerge: { pullRequest: { number: 9 } } } } : { merged: true, message: 'Pull Request successfully merged' }; }
      return new Response(JSON.stringify(value));
    }) as typeof fetch;
    return { github: new ControlGitHub('test-token', request), mutations };
  }
  it('merges only the opted-in exact task PR and pins its reviewed HEAD', async () => {
    const { github, mutations } = merger();
    await expect(github.mergePullRequest(project, task)).resolves.toMatchObject({ merged: true, number: 9, headSha: 'head123' });
    expect(mutations).toEqual([{ path: 'repos/owner/repo/pulls/9/merge', body: { sha: 'head123', merge_method: 'squash' } }]);
  });
  it('uses the configured worktree target and preserves ancestry for cleanup', async () => {
    const worktree = { mainBranch: 'develop' } as NonNullable<Task['worktree']>;
    const { github, mutations } = merger({base:{ref:'develop',repo:{full_name:'owner/repo'}}},{allow_merge_commit:true});
    await expect(github.mergePullRequest(project,{...task,worktree})).resolves.toMatchObject({merged:true});
    expect(mutations[0]?.body).toMatchObject({sha:'head123',merge_method:'merge'});
    const disabled=merger({base:{ref:'develop',repo:{full_name:'owner/repo'}}},{allow_merge_commit:false});
    await expect(disabled.github.mergePullRequest(project,{...task,worktree})).rejects.toThrow('supported merge method');
    expect(disabled.mutations).toEqual([]);
  });
  it('merges using a GitHub remote without requiring a GitHub Projects board', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-github-merge-'));
    try {
      execFileSync('git', ['init', '-q', directory]);
      execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
      const { github, mutations } = merger();
      await expect(github.mergePullRequest({ ...project, github: null, repositoryPath: directory }, task)).resolves.toMatchObject({ merged: true, number: 9 });
      expect(mutations).toHaveLength(1);
      execFileSync('git', ['-C', directory, 'remote', 'set-url', 'origin', 'https://example.com/owner/repo']);
      await expect(github.mergePullRequest({ ...project, github: null, repositoryPath: directory }, task)).rejects.toThrow('github.com remote');
      expect(mutations).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects missing opt-in, unrelated PRs, changed HEADs and fork heads before any mutation', async () => {
    const disabled = merger(); await expect(disabled.github.mergePullRequest({ ...project, autoMerge: false }, task)).rejects.toThrow('not enabled'); expect(disabled.mutations).toEqual([]);
    const unrelated = merger({ body: 'Unrelated work' }); await expect(unrelated.github.mergePullRequest(project, task)).rejects.toThrow('not linked'); expect(unrelated.mutations).toEqual([]);
    const changed = merger({ head: { sha: 'new-head', repo: { full_name: 'owner/repo' } } }); await expect(changed.github.mergePullRequest(project, task)).rejects.toThrow('HEAD changed'); expect(changed.mutations).toEqual([]);
    const fork = merger({ head: { sha: 'head123', repo: { full_name: 'other/fork' } } }); await expect(fork.github.mergePullRequest(project, task)).rejects.toThrow('same repository'); expect(fork.mutations).toEqual([]);
  });
  it('leaves pending branch protection with GitHub and never reports a queued auto-merge as merged', async () => {
    const pending = merger({ mergeable_state: 'blocked' });
    await expect(pending.github.mergePullRequest(project, task)).resolves.toMatchObject({ merged: false, message: expect.stringContaining('required checks') });
    expect(pending.mutations[0]?.body.query).toContain('enablePullRequestAutoMerge');
    expect(pending.mutations.some((mutation) => mutation.path.endsWith('/merge'))).toBe(false);
  });
});
