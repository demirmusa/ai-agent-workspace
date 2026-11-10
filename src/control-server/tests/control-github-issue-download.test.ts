import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';
import { ControlGitHub } from '../github.js';

const roots: string[] = [], services: ControlService[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-issue-download-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0 });
  return { service, project: service.createProject({ name: 'Issues', repositoryPath: workspace }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const issue = (number: number, overrides: Record<string, unknown> = {}) => ({ number, node_id: `I_${number}`, title: `Issue ${number}`, body: `Body ${number}`, html_url: `https://github.com/owner/repo/issues/${number}`, state: 'open', labels: [], milestone: null, ...overrides });

describe('downloading GitHub issues', () => {
  it('lists every repository issue without pull requests', async () => {
    const paths: string[] = [];
    const request = (async (url: string | URL | Request) => {
      const path = String(url).replace('https://api.github.com/', ''); paths.push(path);
      return new Response(JSON.stringify([issue(1), { ...issue(2), pull_request: {} }]), { status: 200 });
    }) as typeof fetch;
    expect((await new ControlGitHub('token', request).issues('owner/repo')).map((entry) => entry.number)).toEqual([1]);
    expect(paths).toEqual(['repos/owner/repo/issues?state=all&sort=created&direction=asc&per_page=100&page=1']);
  });

  it('imports only the issues the project has no task for, without a GitHub Project and without writing to GitHub', async () => {
    const { service, project } = await setup();
    const linked = service.createTask({ projectId: project.id, title: 'Linked' });
    service.store.state.tasks.find((task) => task.id === linked.id)!.github = { issueNumber: 1 };
    const deleted = service.createTask({ projectId: project.id, title: 'Deleted' });
    service.store.state.tasks.find((task) => task.id === deleted.id)!.github = { issueNumber: 4 };
    service.deleteTask(deleted.id);
    const slug = vi.spyOn(ControlGitHub.prototype, 'repositorySlug').mockResolvedValue('owner/repo');
    vi.spyOn(ControlGitHub.prototype, 'issues').mockResolvedValue([
      issue(1),
      issue(2, { body: `Marked\n\n<!-- aiws-task:${linked.id} -->` }),
      issue(3, { labels: [{ name: 'bug', color: 'd73a4a', description: 'Broken' }], body: 'Text\n\n<!-- aiws-task:gone -->' }),
      issue(4, { state: 'closed', state_reason: 'not_planned' }),
      issue(5, { state: 'closed', state_reason: 'completed' }),
    ]);
    const api = vi.spyOn(ControlGitHub.prototype, 'api');
    expect(await service.downloadIssues(project.id)).toEqual({ imported: 3, repository: 'owner/repo' });
    expect(slug).toHaveBeenCalledWith(project.repositoryPath);
    expect(api).not.toHaveBeenCalled();
    const tasks = service.store.state.tasks.filter((task) => task.projectId === project.id && task.id !== linked.id);
    expect(tasks.map((task) => [task.github?.issueNumber, task.status, task.description])).toEqual([[3, 'backlog', 'Text'], [4, 'cancelled', 'Body 4'], [5, 'done', 'Body 5']]);
    expect(tasks[0]).toMatchObject({ title: 'Issue 3', tags: ['bug'], github: { issueUrl: 'https://github.com/owner/repo/issues/3', issueId: 'I_3', baseline: { title: 'Issue 3', description: 'Text', status: 'backlog', labels: ['bug'], milestone: null } } });
    expect(service.project(project.id).labels).toEqual([{ name: 'bug', color: 'd73a4a', description: 'Broken' }]);
    expect(service.store.state.ignoredGitHubIssues?.[project.id]).toEqual([]);
    expect(await service.downloadIssues(project.id)).toMatchObject({ imported: 0 });
  });

  it('uses the connected repository', async () => {
    const { service, project } = await setup();
    service.updateProject(project.id, { github: { repository: 'owner/linked', owner: 'owner', number: 1 } });
    const slug = vi.spyOn(ControlGitHub.prototype, 'repositorySlug');
    const issues = vi.spyOn(ControlGitHub.prototype, 'issues').mockResolvedValue([issue(7)]);
    expect(await service.downloadIssues(project.id)).toEqual({ imported: 1, repository: 'owner/linked' });
    expect(issues).toHaveBeenCalledWith('owner/linked');
    expect(slug).not.toHaveBeenCalled();
  });
});
