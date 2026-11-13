import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlService } from '../service.js';
import { ControlGitHub } from '../github.js';
import { milestoneDate, validateMilestoneFields } from '../milestones.js';
import type { Project, ProjectMilestone, Task } from '../types.js';

const roots: string[] = [], services: ControlService[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-milestones-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data') }); services.push(service);
  service.updateSettings({ autoSyncSeconds: 0 });
  return { service, project: service.createProject({ name: 'Milestones', repositoryPath: workspace }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const milestoneOf = (project: Project, title: string): ProjectMilestone => project.milestones!.find((entry) => entry.title === title)!;

describe('project milestones', () => {
  it('validates GitHub milestone fields', () => {
    expect(validateMilestoneFields({ title: ' v1 ', dueOn: '2026-12-01' })).toEqual({ title: 'v1', description: '', dueOn: '2026-12-01', state: 'open' });
    expect(milestoneDate('2026-12-01T08:00:00Z')).toBe('2026-12-01');
    expect(() => validateMilestoneFields({ title: '' })).toThrow('1-255');
    expect(() => validateMilestoneFields({ title: 'x', dueOn: '2026-02-30' })).toThrow('YYYY-MM-DD');
    expect(() => validateMilestoneFields({ title: 'x', state: 'done' })).toThrow('open or closed');
  });

  it('creates new tasks in the current milestone and moves the current one on when it closes', async () => {
    const { service, project } = await setup();
    // The first open milestone becomes current; titles are unique without regard to case.
    let saved = service.createMilestone(project.id, { title: 'Sprint 2', dueOn: '2026-12-15' });
    saved = service.createMilestone(project.id, { title: 'Sprint 1', dueOn: '2026-12-01' });
    expect(() => service.createMilestone(project.id, { title: 'sprint 1' })).toThrow('already exists');
    const first = milestoneOf(saved, 'Sprint 1'), second = milestoneOf(saved, 'Sprint 2');
    expect(saved.currentMilestoneId).toBe(second.id);
    service.setCurrentMilestone(project.id, { milestoneId: first.id });
    const task = service.createTask({ projectId: project.id, title: 'Joins current' });
    expect(task.milestoneId).toBe(first.id);
    expect(service.createTask({ projectId: project.id, title: 'No milestone', milestoneId: null }).milestoneId).toBeUndefined();
    expect(service.updateTask(task.id, { milestoneId: second.id }).milestoneId).toBe(second.id);
    expect(service.updateTask(task.id, { title: 'Renamed' }).milestoneId).toBe(second.id);
    expect(() => service.updateTask(task.id, { milestoneId: 'milestone_unknown' })).toThrow('milestone of the task project');
    // Closing the current milestone hands over to the next open one by due date.
    saved = service.updateMilestone(project.id, first.id, { state: 'closed' });
    expect(milestoneOf(saved, 'Sprint 1')).toMatchObject({ state: 'closed', closedAt: expect.any(String) });
    expect(saved.currentMilestoneId).toBe(second.id);
    expect(() => service.setCurrentMilestone(project.id, { milestoneId: first.id })).toThrow('open milestone');
    // An explicit choice of no current milestone stays.
    expect(service.setCurrentMilestone(project.id, { milestoneId: null }).currentMilestoneId).toBeNull();
    expect(service.createTask({ projectId: project.id, title: 'Outside' }).milestoneId).toBeUndefined();
  });

  it('moves tasks between milestones and clears them from a deleted milestone', async () => {
    const { service, project } = await setup();
    const saved = service.createMilestone(project.id, { title: 'Alpha' }), alpha = milestoneOf(saved, 'Alpha');
    const beta = milestoneOf(service.createMilestone(project.id, { title: 'Beta' }), 'Beta');
    const a = service.createTask({ projectId: project.id, title: 'A' }), b = service.createTask({ projectId: project.id, title: 'B', milestoneId: null });
    expect(service.assignMilestone(project.id, { taskIds: [a.id, b.id], milestoneId: beta.id })).toEqual({ moved: 2 });
    expect([service.task(a.id).milestoneId, service.task(b.id).milestoneId]).toEqual([beta.id, beta.id]);
    expect(service.assignMilestone(project.id, { taskIds: [a.id], milestoneId: null })).toEqual({ moved: 1 });
    expect(service.task(a.id).milestoneId).toBeUndefined();
    service.deleteMilestone(project.id, beta.id);
    expect(service.task(b.id).milestoneId).toBeUndefined();
    expect(service.project(project.id).milestones?.map((entry) => entry.id)).toEqual([alpha.id]);
    // A task moved to another project leaves its milestone.
    const other = service.createProject({ name: 'Other', repositoryPath: service.project(project.id).repositoryPath });
    const moved = service.createTask({ projectId: project.id, title: 'Mover', milestoneId: alpha.id });
    expect(service.updateTask(moved.id, { projectId: other.id }).milestoneId).toBeUndefined();
  });

  it('keeps local edits made while a sync ran and deletes linked milestones on GitHub at the next sync', async () => {
    const { service, project } = await setup();
    service.updateProject(project.id, { github: { repository: 'owner/repo', owner: 'owner', number: 1 } });
    const local = milestoneOf(service.createMilestone(project.id, { title: 'Local' }), 'Local');
    const task = service.createTask({ projectId: project.id, title: 'Task' });
    vi.spyOn(ControlGitHub.prototype, 'comments').mockResolvedValue([]);
    vi.spyOn(ControlGitHub.prototype, 'sync').mockImplementation(async (synced) => {
      // The user renames the milestone while GitHub requests are in flight.
      service.updateMilestone(project.id, local.id, { title: 'Renamed here' });
      const linked = { ...synced.milestones![0]!, github: { number: 3, baseline: { title: 'Local', description: '', dueOn: null, state: 'open' as const } } };
      const imported: ProjectMilestone = { id: 'milestone_remote', title: 'From GitHub', description: '', dueOn: null, state: 'open', createdAt: '', updatedAt: '', github: { number: 4, baseline: { title: 'From GitHub', description: '', dueOn: null, state: 'open' } } };
      return { project: synced, tasks: [{ ...task, milestoneId: 'milestone_remote' }], labels: [], milestones: { milestones: [linked, imported], deleted: [], errors: [] } };
    });
    await service.sync(project.id);
    const after = service.project(project.id);
    expect(milestoneOf(after, 'Renamed here').github?.number).toBe(3);
    expect(milestoneOf(after, 'From GitHub').id).toBe('milestone_remote');
    expect(service.task(task.id).milestoneId).toBe('milestone_remote');
    service.deleteMilestone(project.id, local.id);
    expect(service.project(project.id).milestoneDeletions).toEqual([3]);
    // Disconnecting keeps milestones as local ones.
    service.updateProject(project.id, { github: null });
    expect(service.project(project.id).milestones?.[0]?.github).toBeUndefined();
    expect(service.project(project.id).milestoneDeletions).toBeUndefined();
  });
});

describe('GitHub milestone synchronization', () => {
  const project: Project = { id: 'p1', name: 'Demo', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 7 }, createdAt: '', updatedAt: '' };
  const base: Task = { id: 't1', projectId: 'p1', title: 'Task', description: 'Body', status: 'ready', provider: 'codex', priority: 0, dependsOn: [], autoStart: false, currentRunId: null, createdAt: '', updatedAt: '' };
  const remoteMilestone = (number: number, title: string, overrides: any = {}) => ({ number, title, description: '', due_on: null, state: 'open', html_url: `https://github.com/owner/repo/milestone/${number}`, closed_at: null, ...overrides });
  function fake(items: any[], milestones: any[]) {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      const path = String(url).replace('https://api.github.com/', ''); const body = options?.body ? JSON.parse(String(options.body)) : undefined, method = options?.method ?? 'GET';
      calls.push({ path, method, body });
      let value: any;
      if (path === 'graphql') {
        if (body.query.includes('fields(first:100')) value = { data: { user: { projectV2: { id: 'PVT', fields: { nodes: [{ id: 'f', name: 'Status', options: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }] }], pageInfo: { hasNextPage: false } } } } } };
        else if (body.query.includes('items(first:100')) value = { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false } } } } };
        else if (body.query.includes('addProjectV2ItemById')) value = { data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } };
        else value = { data: {} };
      } else if (path.startsWith('repos/owner/repo/milestones?')) value = milestones;
      else if (path === 'repos/owner/repo/milestones' && method === 'POST') value = remoteMilestone(20, body.title, { description: body.description, due_on: body.due_on, state: body.state });
      else if (path.startsWith('repos/owner/repo/milestones/')) value = method === 'DELETE' ? {} : remoteMilestone(Number(path.split('/').pop()), body.title, body);
      else if (path.includes('?state=all')) value = [];
      else value = { number: 12, node_id: 'I_new', html_url: 'https://github.com/owner/repo/issues/12', title: body?.title ?? '', body: body?.body ?? '', state: 'open', milestone: body?.milestone ? { number: body.milestone } : null };
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof fetch;
    return { calls, request };
  }
  const issue = (milestone: number | null, overrides: any = {}) => ({ id: 'PVTI_1', fieldValueByName: { name: 'Todo' }, content: { id: 'I_1', number: 4, title: 'Task', body: 'Body\n\n<!-- aiws-task:t1 -->', url: 'u', state: 'OPEN', repository: { nameWithOwner: 'owner/repo' }, labels: { nodes: [] }, milestone: milestone === null ? null : { number: milestone }, ...overrides } });
  const local = (overrides: Partial<ProjectMilestone> = {}): ProjectMilestone => ({ id: 'm_local', title: 'v1', description: '', dueOn: null, state: 'open', createdAt: '', updatedAt: '', ...overrides });

  it('creates local milestones on GitHub, imports remote ones and creates issues in their milestone', async () => {
    const remote = fake([issue(5, { number: 9, body: 'Remote' })], [remoteMilestone(5, 'Remote release', { due_on: '2026-12-01T08:00:00Z' })]);
    const result = await new ControlGitHub('token', remote.request).sync({ ...project, milestones: [local({ dueOn: '2026-11-30' })] }, [{ ...base, milestoneId: 'm_local' }]);
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/milestones' && call.method === 'POST')?.body).toEqual({ title: 'v1', description: '', due_on: '2026-11-30T12:00:00Z', state: 'open' });
    const milestones = result.milestones!.milestones, imported = milestones.find((entry) => entry.title === 'Remote release')!;
    expect(milestones.find((entry) => entry.id === 'm_local')?.github).toMatchObject({ number: 20, baseline: { title: 'v1', dueOn: '2026-11-30' } });
    expect(imported).toMatchObject({ dueOn: '2026-12-01', github: { number: 5 } });
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/issues' && call.method === 'POST')?.body.milestone).toBe(20);
    expect(result.tasks.find((task) => task.github?.issueNumber === 9)?.milestoneId).toBe(imported.id);
    expect(result.tasks.find((task) => task.id === 't1')).toMatchObject({ milestoneId: 'm_local', github: { baseline: { milestone: 20 } } });
  });

  it('pushes local milestone edits, pulls remote ones and follows deletions on both sides', async () => {
    const baseline = { title: 'v1', description: '', dueOn: null, state: 'open' as const };
    const linked = local({ title: 'v1.0', github: { number: 3, baseline } });
    const gone = local({ id: 'm_gone', title: 'Old', github: { number: 8, baseline: { ...baseline, title: 'Old' } } });
    const remote = fake([], [remoteMilestone(3, 'v1', { description: 'From GitHub', state: 'closed', closed_at: '2026-11-01T00:00:00Z' }), remoteMilestone(6, 'Deleted here')]);
    const result = await new ControlGitHub('token', remote.request).sync({ ...project, milestones: [linked, gone], milestoneDeletions: [6] }, []);
    // The local title wins; GitHub's description and closed state are taken.
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/milestones/3')).toMatchObject({ method: 'PATCH', body: { title: 'v1.0', description: 'From GitHub', state: 'closed' } });
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/milestones/6')?.method).toBe('DELETE');
    expect(result.milestones).toMatchObject({ deleted: [6], errors: [] });
    expect(result.milestones!.milestones).toEqual([expect.objectContaining({ id: 'm_local', title: 'v1.0', description: 'From GitHub', state: 'closed', closedAt: '2026-11-01T00:00:00Z' })]);
  });

  it('pushes a task milestone changed here and pulls one changed on GitHub', async () => {
    const milestones = [local({ github: { number: 3, baseline: { title: 'v1', description: '', dueOn: null, state: 'open' } } }), local({ id: 'm_two', title: 'v2', github: { number: 4, baseline: { title: 'v2', description: '', dueOn: null, state: 'open' } } })];
    const remoteMilestones = [remoteMilestone(3, 'v1'), remoteMilestone(4, 'v2')];
    const synced = { ...base, milestoneId: 'm_local', github: { issueNumber: 4, baseline: { title: 'Task', description: 'Body', status: 'ready' as const, labels: [], milestone: 3 } } };
    let remote = fake([issue(3)], remoteMilestones);
    await new ControlGitHub('token', remote.request).sync({ ...project, milestones }, [synced]);
    expect(remote.calls.some((call) => call.path.startsWith('repos/owner/repo/issues/') && call.method === 'PATCH')).toBe(false);
    remote = fake([issue(3)], remoteMilestones);
    await new ControlGitHub('token', remote.request).sync({ ...project, milestones }, [{ ...synced, milestoneId: 'm_two' }]);
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/issues/4')?.body.milestone).toBe(4);
    remote = fake([issue(3)], remoteMilestones);
    await new ControlGitHub('token', remote.request).sync({ ...project, milestones }, [{ ...synced, milestoneId: undefined as never }]);
    expect(remote.calls.find((call) => call.path === 'repos/owner/repo/issues/4')?.body.milestone).toBeNull();
    remote = fake([issue(null)], remoteMilestones);
    const pulled = await new ControlGitHub('token', remote.request).sync({ ...project, milestones }, [synced]);
    expect(pulled.tasks[0]?.milestoneId).toBeUndefined();
    expect(pulled.tasks[0]?.github?.baseline?.milestone).toBeNull();
  });
});
