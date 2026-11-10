import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService, GENERAL_WORKSPACE_ID } from '../service.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import { nextOccurrence, parseCron, validateRecurrence, zonedTime } from '../schedules.js';
import type { ScheduleRecurrence } from '../types.js';

const roots: string[] = []; const services: ControlService[] = []; const servers: RunningControlServer[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-schedules-')); roots.push(root); return root; }
function directory(root: string, name: string): string { const path = join(root, name); mkdirSync(path); return path; }
async function open(root: string): Promise<ControlService> { const value = await ControlService.open({ dataDir: join(root, 'data') }); services.push(value); return value; }
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error('Timed out awaiting schedule state.');
}
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const next = (recurrence: ScheduleRecurrence, timezone: string, after: string, anchor = after) => iso(nextOccurrence(recurrence, timezone, Date.parse(after), Date.parse(anchor)));
const command = { executable: process.execPath, args: ['-e', 'console.log("scheduled work done")'] };
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(services.splice(0).map((value) => value.close())); vi.useRealTimers(); vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('schedule recurrence', () => {
  it('reads daily, weekday and monthly times on the wall clock of the schedule time zone', () => {
    const daily: ScheduleRecurrence = { kind: 'daily', times: ['09:00', '18:30'], weekdays: [] };
    // Istanbul is UTC+3 all year.
    expect(next(daily, 'Europe/Istanbul', '2026-10-19T05:00:00.000Z')).toBe('2026-10-19T06:00:00.000Z');
    expect(next(daily, 'Europe/Istanbul', '2026-10-19T06:00:00.000Z')).toBe('2026-10-19T15:30:00.000Z');
    expect(next(daily, 'Europe/Istanbul', '2026-10-19T15:30:00.000Z')).toBe('2026-10-20T06:00:00.000Z');
    // Weekdays only: Friday 2026-10-23 → Monday 2026-10-26.
    expect(next({ kind: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }, 'Europe/Istanbul', '2026-10-23T07:00:00.000Z')).toBe('2026-10-26T06:00:00.000Z');
    // The last day of the month follows the month length, also in February.
    const monthly: ScheduleRecurrence = { kind: 'monthly', times: ['08:00'], days: [-1] };
    expect(next(monthly, 'UTC', '2027-02-01T00:00:00.000Z')).toBe('2027-02-28T08:00:00.000Z');
    expect(next(monthly, 'UTC', '2027-02-28T08:00:00.000Z')).toBe('2027-03-31T08:00:00.000Z');
    expect(next({ kind: 'monthly', times: ['10:00'], days: [31] }, 'UTC', '2026-11-01T00:00:00.000Z')).toBe('2026-12-31T10:00:00.000Z');
  });
  it('keeps local times across daylight saving changes and runs a repeated hour once', () => {
    // Berlin leaves summer time on 2026-10-25 at 03:00 → 02:00.
    const daily: ScheduleRecurrence = { kind: 'daily', times: ['09:00'], weekdays: [] };
    expect(next(daily, 'Europe/Berlin', '2026-10-24T07:00:00.000Z')).toBe('2026-10-25T08:00:00.000Z');
    const hourly: ScheduleRecurrence = { kind: 'cron', expression: '30 2 * * *' };
    const first = next(hourly, 'Europe/Berlin', '2026-10-24T12:00:00.000Z')!;
    expect(first).toBe('2026-10-25T00:30:00.000Z');
    expect(next(hourly, 'Europe/Berlin', first)).toBe('2026-10-26T01:30:00.000Z');
    // A wall time skipped in spring is not invented; the next real day runs.
    expect(next(hourly, 'Europe/Berlin', '2026-03-28T12:00:00.000Z')).toBe('2026-03-30T00:30:00.000Z');
    // Day intervals keep the anchor's wall-clock time.
    const anchor = zonedTime(2026, 10, 20, 9, 0, 'Europe/Berlin');
    expect(iso(nextOccurrence({ kind: 'interval', every: 7, unit: 'days' }, 'Europe/Berlin', anchor, anchor))).toBe('2026-10-27T08:00:00.000Z');
  });
  it('counts intervals from the anchor and returns a one-time run only once', () => {
    const every: ScheduleRecurrence = { kind: 'interval', every: 30, unit: 'minutes' };
    expect(next(every, 'UTC', '2026-10-19T10:44:00.000Z', '2026-10-19T10:00:00.000Z')).toBe('2026-10-19T11:00:00.000Z');
    expect(next(every, 'UTC', '2026-10-19T09:00:00.000Z', '2026-10-19T10:00:00.000Z')).toBe('2026-10-19T10:00:00.000Z');
    const once: ScheduleRecurrence = { kind: 'once', at: '2026-10-20T10:00:00.000Z' };
    expect(next(once, 'UTC', '2026-10-19T00:00:00.000Z')).toBe('2026-10-20T10:00:00.000Z');
    expect(next(once, 'UTC', '2026-10-20T10:00:00.000Z')).toBeNull();
  });
  it('supports cron lists, ranges, steps, names and either-day matching', () => {
    expect(next({ kind: 'cron', expression: '0 9 * * mon-fri' }, 'UTC', '2026-10-24T10:00:00.000Z')).toBe('2026-10-26T09:00:00.000Z');
    expect(next({ kind: 'cron', expression: '*/15 * * * *' }, 'UTC', '2026-10-19T10:07:00.000Z')).toBe('2026-10-19T10:15:00.000Z');
    expect(next({ kind: 'cron', expression: '0 0 1 jan *' }, 'UTC', '2026-10-19T00:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    // Day-of-month 13 or any Friday.
    expect(next({ kind: 'cron', expression: '0 12 13 * 5' }, 'UTC', '2026-10-19T00:00:00.000Z')).toBe('2026-10-23T12:00:00.000Z');
    expect(next({ kind: 'cron', expression: '@daily' }, 'UTC', '2026-10-19T00:00:00.000Z')).toBe('2026-10-20T00:00:00.000Z');
    expect(next({ kind: 'cron', expression: '0 0 30 2 *' }, 'UTC', '2026-10-19T00:00:00.000Z')).toBeNull();
    expect(parseCron('0 0 * * 7').weekdays).toEqual(new Set([0]));
  });
  it('rejects malformed timetables and accepts minute-level ones', () => {
    expect(() => validateRecurrence({ kind: 'cron', expression: '* * * *' })).toThrow(/five fields/);
    expect(validateRecurrence({ kind: 'cron', expression: '* * * * *' })).toEqual({ kind: 'cron', expression: '* * * * *' });
    expect(() => validateRecurrence({ kind: 'cron', expression: '61 * * * *' })).toThrow(/outside/);
    expect(validateRecurrence({ kind: 'interval', every: 1, unit: 'minutes' })).toEqual({ kind: 'interval', every: 1, unit: 'minutes' });
    expect(() => validateRecurrence({ kind: 'daily', times: ['25:00'] })).toThrow(/HH:MM/);
    expect(() => validateRecurrence({ kind: 'monthly', times: ['09:00'], days: [] })).toThrow(/at least one day/);
    expect(() => validateRecurrence({ kind: 'yearly' })).toThrow(/recurrence.kind/);
    expect(validateRecurrence({ kind: 'daily', time: '07:05', weekdays: [5, 1, 1] })).toEqual({ kind: 'daily', times: ['07:05'], weekdays: [1, 5] });
  });
});

describe('scheduled tasks', () => {
  it('starts a ready task only when its scheduled time arrives', async () => {
    const root = temp(); const service = await open(root);
    const project = service.createProject({ name: 'Scheduled', repositoryPath: directory(root, 'repo') });
    const later = service.createTask({ projectId: project.id, title: 'Later', provider: 'command', command, status: 'ready', scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const soon = service.createTask({ projectId: project.id, title: 'Soon', provider: 'command', command, status: 'ready', scheduledAt: new Date(Date.now() + 1_500).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(service.task(soon.id).status).toBe('ready'); expect(service.task(later.id).status).toBe('ready');
    await waitFor(() => service.task(soon.id).status, (status) => ['running', 'review', 'done'].includes(status), 8000);
    expect(service.task(later.id)).toMatchObject({ status: 'ready', currentRunId: null });
    // An explicit start does not wait; clearing the time also releases it.
    expect(() => service.updateTask(later.id, { scheduledAt: 'tomorrow-ish' })).toThrow(/ISO 8601/);
    service.updateTask(later.id, { scheduledAt: null });
    expect(service.task(later.id).scheduledAt).toBeUndefined();
  });
  it('takes overdue scheduled tasks after a restart, but never backlog ones', async () => {
    const root = temp(); let service = await open(root);
    const project = service.createProject({ name: 'Restart', repositoryPath: directory(root, 'repo') });
    service.updateSettings({ systemEnabled: false });
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    const ready = service.createTask({ projectId: project.id, title: 'Overdue', provider: 'command', command, status: 'ready', scheduledAt: past });
    const backlog = service.createTask({ projectId: project.id, title: 'Not ready', provider: 'command', command, status: 'backlog', scheduledAt: past });
    await service.close(); services.splice(services.indexOf(service), 1);
    service = await open(root); service.updateSettings({ systemEnabled: true });
    await waitFor(() => service.task(ready.id).currentRunId, Boolean, 8000);
    expect(service.task(backlog.id)).toMatchObject({ status: 'backlog', currentRunId: null, scheduledAt: past });
  });
});

describe('recurring schedules', () => {
  it('creates a ready task per occurrence, skips overlaps and keeps its timetable', async () => {
    const root = temp(); const service = await open(root);
    const project = service.createProject({ name: 'Recurring', repositoryPath: directory(root, 'repo') });
    const longCommand = { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},4000)'] };
    expect(() => service.schedules.create({ projectId: project.id, recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: '' } })).toThrow(/title is required/);
    expect(() => service.schedules.create({ projectId: 'missing', recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'x' } })).toThrow(/project was not found/);
    expect(() => service.schedules.create({ projectId: project.id, timezone: 'Mars/Base', recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'x' } })).toThrow(/Unknown time zone/);
    const schedule = service.schedules.create({ projectId: project.id, timezone: 'UTC', recurrence: { kind: 'interval', every: 1, unit: 'hours' }, task: { title: 'Nightly report', description: 'Summarize changes', provider: 'command', command: longCommand, tags: ['report'] } });
    expect(schedule).toMatchObject({ name: 'Nightly report', enabled: true, overlap: 'skip', catchUp: 'once', runCount: 0, task: { provider: 'command', priority: 2, tags: ['report'] } });
    expect(Date.parse(schedule.nextRunAt!)).toBeGreaterThan(Date.now() + 59 * 60_000);
    // Make the occurrence due now.
    service.store.state.schedules[0]!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    const created = await waitFor(() => service.snapshot().tasks.filter((task) => task.scheduleId === schedule.id), (tasks) => tasks.length === 1, 5000);
    expect(created[0]).toMatchObject({ title: 'Nightly report', description: 'Summarize changes', status: expect.stringMatching(/ready|running/), tags: ['report'] });
    const stored = service.schedules.schedule(schedule.id);
    expect(stored).toMatchObject({ runCount: 1, lastTaskId: created[0]!.id, lastOutcome: { status: 'created' } });
    expect(Date.parse(stored.nextRunAt!)).toBeGreaterThan(Date.now() + 50 * 60_000);
    await waitFor(() => service.task(created[0]!.id).status, (status) => status === 'running', 5000);
    // While that task is still open, the next occurrence is skipped instead of piling up.
    stored.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await waitFor(() => service.schedules.schedule(schedule.id).lastOutcome?.status, (status) => status === 'skipped', 5000);
    expect(service.snapshot().tasks.filter((task) => task.scheduleId === schedule.id)).toHaveLength(1);
    // A manual run is extra: it does not count against the timetable.
    const manual = service.schedules.runNow(schedule.id);
    expect(manual).toMatchObject({ scheduleId: schedule.id, status: 'ready' });
    expect(service.schedules.schedule(schedule.id).runCount).toBe(1);
    const prompt = await waitFor(() => { const run = service.snapshot().runs.find((item) => item.taskId === created[0]!.id); return run?.inputDirectory && existsSync(join(run.inputDirectory, 'prompt.md')) ? readFileSync(join(run.inputDirectory, 'prompt.md'), 'utf8') : ''; }, Boolean);
    expect(prompt).toContain(`schedule "Nightly report" (${schedule.id})`);
  });
  it('runs scheduled tasks of a Git project in their own worktree, even when the checkout is dirty', async () => {
    const root = temp(); const repo = directory(root, 'repo');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); writeFileSync(join(repo, 'README.md'), 'hello'); git('add', '.'); git('commit', '-m', 'init');
    // An earlier unattended run left the shared checkout on its branch with an uncommitted file.
    git('switch', '-c', 'aiws/earlier'); writeFileSync(join(repo, 'leftover.md'), 'uncommitted');
    const service = await open(root);
    const project = service.createProject({ useWorktree: false, name: 'Dirty', repositoryPath: repo });
    expect(project.useWorktree).toBe(false);
    const write = { executable: process.execPath, args: ['-e', 'require("fs").writeFileSync("scheduled.md","done")'] };
    const schedule = service.schedules.create({ projectId: project.id, timezone: 'UTC', recurrence: { kind: 'interval', every: 1, unit: 'hours' }, task: { title: 'Write a note', provider: 'command', command: write } });
    service.store.state.schedules[0]!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    const [created] = await waitFor(() => service.snapshot().tasks.filter((task) => task.scheduleId === schedule.id), (tasks) => tasks.length === 1, 5000);
    const task = await waitFor(() => service.task(created!.id), (value) => !['ready', 'running'].includes(value.status), 15000);
    expect(task.queueReason).toBeUndefined();
    expect(task.worktree).toMatchObject({ branch: `aiws/${task.id}`, repositoryPath: repo });
    expect(readFileSync(join(task.worktree!.path, 'scheduled.md'), 'utf8')).toBe('done');
    // The shared checkout keeps its branch and files; nothing was written there.
    expect(git('branch', '--show-current')).toBe('aiws/earlier');
    expect(existsSync(join(repo, 'scheduled.md'))).toBe(false);
    expect(readFileSync(join(repo, 'leftover.md'), 'utf8')).toBe('uncommitted');
  });
  it('names the reason when an occurrence is skipped behind a task that cannot start', async () => {
    const root = temp(); const service = await open(root);
    const project = service.createProject({ name: 'Blocked', repositoryPath: directory(root, 'repo') });
    const schedule = service.schedules.create({ projectId: project.id, timezone: 'UTC', recurrence: { kind: 'interval', every: 1, unit: 'hours' }, task: { title: 'Blocked report', provider: 'command', command } });
    // The previous occurrence is still waiting in Ready with a queue problem.
    const previous = service.schedules.runNow(schedule.id);
    const stored = service.store.state.tasks.find((task) => task.id === previous.id)!;
    stored.dependsOn = [service.createTask({ projectId: project.id, title: 'Unfinished dependency', status: 'backlog' }).id];
    await waitFor(() => service.task(previous.id).queueReason, Boolean, 5000);
    service.store.state.schedules[0]!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    const outcome = await waitFor(() => service.schedules.schedule(schedule.id).lastOutcome, (value) => value?.status === 'skipped', 5000);
    expect(outcome).toMatchObject({ taskId: previous.id, message: 'The previous task of this schedule cannot start: Task dependencies are not done.' });
  });
  it('catches up a missed occurrence once after a restart, or skips it when asked', async () => {
    const root = temp(); let service = await open(root);
    const project = service.createProject({ name: 'Catch up', repositoryPath: directory(root, 'repo') });
    service.updateSettings({ systemEnabled: false });
    const once = service.schedules.create({ projectId: project.id, recurrence: { kind: 'daily', times: ['03:00'] }, timezone: 'UTC', task: { title: 'Catch up once', provider: 'command', command } });
    const skip = service.schedules.create({ projectId: project.id, recurrence: { kind: 'daily', times: ['03:00'] }, timezone: 'UTC', catchUp: 'skip', task: { title: 'Skip missed', provider: 'command', command } });
    // Both were due three days ago: the service was closed since then.
    for (const item of service.store.state.schedules) item.nextRunAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await service.close(); services.splice(services.indexOf(service), 1);
    service = await open(root);
    // A stopped system creates nothing.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(service.snapshot().tasks).toHaveLength(0);
    service.updateSettings({ systemEnabled: true });
    await waitFor(() => service.schedules.schedule(skip.id).lastOutcome, Boolean, 5000);
    await waitFor(() => service.snapshot().tasks.filter((task) => task.scheduleId === once.id), (tasks) => tasks.length === 1, 5000);
    expect(service.snapshot().tasks.filter((task) => task.scheduleId === skip.id)).toHaveLength(0);
    expect(service.schedules.schedule(skip.id).lastOutcome).toMatchObject({ status: 'skipped', message: expect.stringContaining('Missed') });
    expect(service.schedules.schedule(once.id)).toMatchObject({ runCount: 1, lastOutcome: { status: 'created', message: expect.stringContaining('Catching up') } });
    // Missed occurrences fold into one run; the next is in the future.
    for (const id of [once.id, skip.id]) expect(Date.parse(service.schedules.schedule(id).nextRunAt!)).toBeGreaterThan(Date.now());
  });
  it('honours end time, run limits and disabling, and recomputes after timing edits', async () => {
    const root = temp(); const service = await open(root);
    const project = service.createProject({ name: 'Limits', repositoryPath: directory(root, 'repo') });
    const schedule = service.schedules.create({ projectId: project.id, recurrence: { kind: 'interval', every: 1, unit: 'days' }, maxRuns: 1, task: { title: 'Limited', provider: 'command', command } });
    expect(() => service.schedules.update(schedule.id, { endAt: '2000-01-01T00:00:00Z' })).toThrow(/after startAt/);
    service.store.state.schedules[0]!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await waitFor(() => service.schedules.schedule(schedule.id).runCount, (count) => count === 1, 5000);
    expect(service.schedules.schedule(schedule.id).nextRunAt).toBeNull();
    const disabled = service.schedules.update(schedule.id, { enabled: false, maxRuns: null });
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: null, revision: 2 });
    const enabled = service.schedules.update(schedule.id, { enabled: true, recurrence: { kind: 'daily', times: ['09:00'], weekdays: [1] }, timezone: 'Europe/Istanbul' });
    expect(new Date(enabled.nextRunAt!).getUTCDay()).toBe(1);
    expect(new Date(enabled.nextRunAt!).getUTCHours()).toBe(6);
    expect(service.schedules.preview({ recurrence: { kind: 'daily', times: ['09:00'] }, timezone: 'UTC' }, 3).occurrences).toHaveLength(3);
    service.schedules.delete(schedule.id);
    expect(service.snapshot().schedules).toHaveLength(0);
    expect(service.snapshot().tasks).toHaveLength(1);
  });
  it('keeps agent and provider references, validated like the task they create', async () => {
    const root = temp(); const service = await open(root);
    const project = service.createProject({ name: 'Templates', repositoryPath: directory(root, 'repo') });
    const agent = service.catalog.createAgent({ name: 'Reporter', provider: 'claude', instructions: 'Write reports.' });
    expect(() => service.schedules.create({ projectId: project.id, recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'x', agentId: 'agent_missing' } })).toThrow(/not found/i);
    const schedule = service.schedules.create({ projectId: project.id, recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'Agent report', agentId: agent.id } });
    expect(schedule.task).toMatchObject({ agentId: agent.id }); expect(schedule.task.provider).toBeUndefined();
    const updated = service.schedules.update(schedule.id, { task: { description: 'Only the description changes' } });
    expect(updated.task).toMatchObject({ title: 'Agent report', agentId: agent.id, description: 'Only the description changes' });
    service.deleteProject(project.id);
    expect(service.snapshot().schedules).toHaveLength(0);
  });
});

describe('general workspace', () => {
  it('is a fixed folder outside projects that runs tasks and schedules without Git', async () => {
    const root = temp(); const service = await open(root);
    const workspace = service.snapshot().generalWorkspace!;
    expect(workspace).toMatchObject({ id: GENERAL_WORKSPACE_ID, general: true, github: null, repositoryPath: join(root, 'data', 'workspace') });
    expect(existsSync(workspace.repositoryPath)).toBe(true);
    expect(service.snapshot().projects).toHaveLength(0);
    expect(() => service.deleteProject(GENERAL_WORKSPACE_ID)).toThrow(/cannot be deleted/);
    expect(() => service.updateProject(GENERAL_WORKSPACE_ID, { repositoryPath: root })).toThrow(/fixed folder/);
    expect(() => service.updateProject(GENERAL_WORKSPACE_ID, { useWorktree: true })).toThrow(/fixed folder/);
    await expect(service.connectProject(GENERAL_WORKSPACE_ID, {})).rejects.toThrow(/cannot connect/);
    expect(service.updateProject(GENERAL_WORKSPACE_ID, { name: 'Automations', systemPrompt: 'Be brief.' })).toMatchObject({ name: 'Automations', systemPrompt: 'Be brief.', general: true });
    const writer = { executable: process.execPath, args: ['-e', 'require("fs").writeFileSync("note.txt","from schedule")'] };
    const schedule = service.schedules.create({ projectId: GENERAL_WORKSPACE_ID, recurrence: { kind: 'daily', times: ['09:00'] }, task: { title: 'Write a note', provider: 'command', command: writer } });
    service.store.state.schedules[0]!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    const task = (await waitFor(() => service.snapshot().tasks.filter((item) => item.scheduleId === schedule.id), (tasks) => tasks.length === 1, 5000))[0]!;
    await waitFor(() => service.task(task.id).status, (status) => ['review', 'done'].includes(status), 10000);
    expect(readFileSync(join(workspace.repositoryPath, 'note.txt'), 'utf8')).toBe('from schedule');
    expect(service.task(task.id).taskBranch).toBeUndefined();
    const run = service.snapshot().runs.find((item) => item.taskId === task.id)!;
    expect(readFileSync(join(run.inputDirectory!, 'prompt.md'), 'utf8')).toContain('AIWS general workspace');
  });
  it('serves schedules and the workspace over HTTP', async () => {
    const root = temp(); const server = await startControlServer({ port: 0, dataDir: join(root, 'data') }); servers.push(server);
    const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${server.url}/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as any }; };
    expect((await call('/workspace')).body).toMatchObject({ id: GENERAL_WORKSPACE_ID, general: true });
    const created = await call('/schedules', 'POST', { projectId: GENERAL_WORKSPACE_ID, recurrence: { kind: 'cron', expression: '0 8 * * 1' }, task: { title: 'Weekly digest', provider: 'command', command } });
    expect(created.status).toBe(201);
    expect((await call(`/schedules?projectId=${GENERAL_WORKSPACE_ID}`)).body).toHaveLength(1);
    expect((await call('/schedules', 'POST', { projectId: GENERAL_WORKSPACE_ID, recurrence: { kind: 'cron', expression: 'bad' }, task: { title: 'x' } })).status).toBe(400);
    expect((await call(`/schedules/${created.body.id}`, 'PATCH', { enabled: false })).body).toMatchObject({ enabled: false, nextRunAt: null });
    const run = await call(`/schedules/${created.body.id}/run`, 'POST', {});
    expect(run).toMatchObject({ status: 201, body: { scheduleId: created.body.id, projectId: GENERAL_WORKSPACE_ID } });
    expect((await call('/schedules/preview?count=2', 'POST', { recurrence: { kind: 'daily', times: ['09:00'] } })).body.occurrences).toHaveLength(2);
    expect((await call(`/schedules/${created.body.id}`, 'DELETE')).body).toEqual({ ok: true });
    expect((await call(`/schedules/${created.body.id}`)).status).toBe(404);
    expect((await call('/state')).body.projects).toHaveLength(0);
  });
});
