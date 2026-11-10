import { randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';
import { jsonObject, jsonText } from './validation.js';
import { taskTitle } from '../shared/core/task-title.js';
import { ControlError, type ScheduleOutcome, type ScheduleRecurrence, type ScheduleTaskTemplate, type Task, type TaskSchedule } from './types.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Occurrences found later than this after their time were missed (service closed or stopped). */
export const SCHEDULE_GRACE_MS = 2 * MINUTE;
/** Searching further than this for a cron match means it never matches (for example February 30). */
const SEARCH_LIMIT_MS = 5 * 366 * DAY;
const SCHEDULE_LIMIT = 500;
const OPEN_STATUSES = new Set<Task['status']>(['ready', 'running', 'waiting', 'paused']);

function instant(value: unknown, name: string): string {
  const time = typeof value === 'string' && value.length <= 100 ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new ControlError(`${name} must be an ISO 8601 date and time.`);
  return new Date(time).toISOString();
}
export function hostTimezone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
export function validateTimezone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) throw new ControlError('timezone must be an IANA time zone such as Europe/Istanbul.');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new ControlError(`Unknown time zone: ${value}.`); }
}
/** A ready task waits for this time; null clears it. */
export function validateScheduledAt(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return instant(value, 'scheduledAt');
}

// Wall-clock reading in a time zone. Formatters are expensive to build and reused.
const formatters = new Map<string, Intl.DateTimeFormat>();
interface Wall { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function wall(time: number, timezone: string): Wall {
  let format = formatters.get(timezone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); formatters.set(timezone, format); }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(time)) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: weekdayIndex[parts.weekday!] ?? 0 };
}
const wallKey = (value: Wall): string => `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** The instant a wall-clock time has in a zone; a time skipped by a DST change moves forward with it. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = wall(guess, timezone), difference = target - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (!difference) return guess;
    guess += difference;
  }
  return guess;
}

interface Matcher { minutes: Set<number>; hours: Set<number>; days: Set<number> | null; lastDay: boolean; months: Set<number> | null; weekdays: Set<number> | null }
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const macros: Record<string, string> = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
/** One cron field; null means unrestricted (`*`). */
function cronField(source: string, min: number, max: number, names: string[] = [], offset = 0): Set<number> | null {
  if (source === '*' || source === '?') return null;
  const values = new Set<number>();
  const number = (value: string): number => {
    const named = names.indexOf(value.toLowerCase());
    const result = named >= 0 ? named + offset : /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(result) || result < min || result > max) throw new ControlError(`Cron value ${value} is outside ${min}-${max}.`);
    return result;
  };
  for (const part of source.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!range || !Number.isInteger(step) || step < 1 || part.split('/').length > 2) throw new ControlError(`Invalid cron field: ${source}.`);
    const [first, last] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(number) as [number, number] : [number(range), stepText === undefined ? number(range) : max];
    if (first > last) throw new ControlError(`Invalid cron range: ${range}.`);
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return values;
}
export function parseCron(expression: string): Matcher {
  const source = macros[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = source.split(/\s+/);
  if (fields.length !== 5) throw new ControlError('A cron expression needs five fields: minute hour day-of-month month day-of-week.');
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = cronField(weekday, 0, 7, dayNames);
  if (weekdays?.delete(7)) weekdays.add(0);
  return { minutes: cronField(minute, 0, 59) ?? range(0, 59), hours: cronField(hour, 0, 23) ?? range(0, 23), days: cronField(day, 1, 31), lastDay: false, months: cronField(month, 1, 12, monthNames, 1), weekdays };
}
const range = (from: number, to: number): Set<number> => new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));
function clockTimes(times: string[]): { minutes: Set<number>; hours: Set<number>; pairs: Set<number> } {
  const pairs = new Set(times.map((value) => { const [hour, minute] = value.split(':').map(Number) as [number, number]; return hour * 60 + minute; }));
  return { pairs, hours: new Set([...pairs].map((value) => Math.floor(value / 60))), minutes: new Set([...pairs].map((value) => value % 60)) };
}
function matcher(recurrence: ScheduleRecurrence): Matcher & { pairs?: Set<number> } {
  if (recurrence.kind === 'cron') return parseCron(recurrence.expression);
  if (recurrence.kind === 'daily') { const clock = clockTimes(recurrence.times); return { ...clock, days: null, lastDay: false, months: null, weekdays: recurrence.weekdays.length && recurrence.weekdays.length < 7 ? new Set(recurrence.weekdays) : null }; }
  if (recurrence.kind === 'monthly') { const clock = clockTimes(recurrence.times); return { ...clock, days: new Set(recurrence.days.filter((day) => day > 0)), lastDay: recurrence.days.includes(-1), months: null, weekdays: null }; }
  throw new Error(`No calendar matcher for ${recurrence.kind}.`);
}
function dayMatches(rule: Matcher, value: Wall): boolean {
  if (rule.months && !rule.months.has(value.month)) return false;
  const byDay = rule.days ? rule.days.has(value.day) || (rule.lastDay && value.day === daysInMonth(value.year, value.month)) : rule.lastDay ? value.day === daysInMonth(value.year, value.month) : null;
  const byWeekday = rule.weekdays ? rule.weekdays.has(value.weekday) : null;
  // Cron semantics: when both day fields are restricted, either one matching is enough.
  if (byDay !== null && byWeekday !== null) return byDay || byWeekday;
  return byDay ?? byWeekday ?? true;
}
/** The first calendar match strictly after `after`, read in the schedule's zone. */
function nextCalendar(rule: Matcher & { pairs?: Set<number> }, timezone: string, after: number): number | null {
  const previous = wallKey(wall(after, timezone));
  let time = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let steps = 0; time - after <= SEARCH_LIMIT_MS && steps < 200_000; steps++) {
    const value = wall(time, timezone);
    if (!dayMatches(rule, value)) {
      // Jump close to the next local midnight; DST days are shorter or longer, so stop an hour early.
      const remaining = ((23 - value.hour) * 60 + (60 - value.minute)) * MINUTE;
      time += remaining > 2 * HOUR ? remaining - HOUR : (60 - value.minute) * MINUTE; continue;
    }
    if (!rule.hours.has(value.hour)) { time += (60 - value.minute) * MINUTE; continue; }
    const minute = [...rule.minutes].filter((candidate) => candidate >= value.minute && (!rule.pairs || rule.pairs.has(value.hour * 60 + candidate))).sort((a, b) => a - b)[0];
    if (minute === undefined) { time += (60 - value.minute) * MINUTE; continue; }
    if (minute !== value.minute) { time += (minute - value.minute) * MINUTE; continue; }
    // A wall time repeated when clocks go back runs once.
    if (wallKey(value) === previous) { time += MINUTE; continue; }
    return time;
  }
  return null;
}
/** The first occurrence strictly after `after`; intervals count from `anchor`. */
export function nextOccurrence(recurrence: ScheduleRecurrence, timezone: string, after: number, anchor: number): number | null {
  if (recurrence.kind === 'once') { const at = Date.parse(recurrence.at); return at > after ? at : null; }
  if (recurrence.kind === 'interval') {
    if (anchor > after) return anchor;
    if (recurrence.unit === 'minutes' || recurrence.unit === 'hours') {
      const period = recurrence.every * (recurrence.unit === 'minutes' ? MINUTE : HOUR);
      return anchor + (Math.floor((after - anchor) / period) + 1) * period;
    }
    // Days and weeks keep the wall-clock time of the anchor across DST changes.
    const days = recurrence.every * (recurrence.unit === 'weeks' ? 7 : 1), start = wall(anchor, timezone);
    let count = Math.max(0, Math.floor((after - anchor) / (days * DAY)) - 1);
    for (let guard = 0; guard < 10; guard++, count++) {
      const date = new Date(Date.UTC(start.year, start.month - 1, start.day + count * days));
      const time = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), start.hour, start.minute, timezone);
      if (time > after) return time;
    }
    return null;
  }
  return nextCalendar(matcher(recurrence), timezone, after);
}

const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
function integers(value: unknown, name: string, min: number, max: number, allow: number[] = []): number[] {
  if (!Array.isArray(value) || value.length > 62 || value.some((item) => !Number.isInteger(item) || ((item < min || item > max) && !allow.includes(item)))) throw new ControlError(`${name} must be a list of whole numbers ${min}-${max}.`);
  return [...new Set(value as number[])].sort((a, b) => a - b);
}
function times(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.length > 48 || list.some((item) => typeof item !== 'string' || !clock.test(item))) throw new ControlError('times must contain 1 to 48 HH:MM times.');
  return [...new Set(list as string[])].sort();
}
export function validateRecurrence(input: unknown): ScheduleRecurrence {
  const value = jsonObject(input, 'recurrence');
  switch (value.kind) {
    case 'once': return { kind: 'once', at: instant(value.at, 'recurrence.at') };
    case 'interval': {
      const every = value.every, unit = value.unit;
      if (!['minutes', 'hours', 'days', 'weeks'].includes(String(unit))) throw new ControlError('Interval unit must be minutes, hours, days or weeks.');
      if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 10_000) throw new ControlError('Interval must be a whole number from 1 to 10000.');
      return { kind: 'interval', every: every as number, unit: unit as 'minutes' | 'hours' | 'days' | 'weeks' };
    }
    case 'daily': return { kind: 'daily', times: times(value.times ?? value.time), weekdays: integers(value.weekdays ?? [], 'weekdays', 0, 6) };
    case 'monthly': {
      const days = integers(value.days, 'days', 1, 31, [-1]);
      if (!days.length) throw new ControlError('Choose at least one day of the month.');
      return { kind: 'monthly', times: times(value.times ?? value.time), days };
    }
    case 'cron': {
      const expression = jsonText(value.expression, 'Cron expression', '', 200).trim();
      parseCron(expression);
      return { kind: 'cron', expression };
    }
    default: throw new ControlError('recurrence.kind must be once, interval, daily, monthly or cron.');
  }
}

export interface ScheduleHost {
  /** Validates and normalizes a template against the project, as a task with that content would be. */
  template(projectId: string, input: Record<string, unknown>, previous?: ScheduleTaskTemplate): ScheduleTaskTemplate;
  /** Creates the ready task of an occurrence. */
  createTask(schedule: TaskSchedule, occurrence: string | null): Task;
  projectExists(projectId: string): boolean;
  systemEnabled(): boolean;
  event(taskId: string | null, type: string, message: string, data?: unknown): void;
  changed(): void;
}

/** Scheduled and recurring task definitions. Each occurrence creates a ready task that the normal queue starts. */
export class ScheduleCatalog {
  constructor(private readonly store: ControlStore, private readonly host: ScheduleHost) {}
  list(projectId?: string): TaskSchedule[] { return structuredClone(this.store.state.schedules.filter((item) => !projectId || item.projectId === projectId)); }
  schedule(scheduleId: string): TaskSchedule {
    const value = this.store.state.schedules.find((item) => item.id === scheduleId);
    if (!value) throw new ControlError('Schedule not found.', 404); return value;
  }
  private fields(input: unknown, previous?: TaskSchedule): Omit<TaskSchedule, 'id' | 'nextRunAt' | 'lastRunAt' | 'lastTaskId' | 'runCount' | 'lastOutcome' | 'revision' | 'createdAt' | 'updatedAt'> {
    const value = jsonObject(input, 'Schedule');
    const projectId = jsonText(value.projectId, 'projectId', previous?.projectId ?? '', 200);
    if (!this.host.projectExists(projectId)) throw new ControlError('Schedule project was not found.', 404);
    if (previous && projectId !== previous.projectId) throw new ControlError('A schedule cannot move to another project.', 409);
    const recurrence = value.recurrence === undefined && previous ? previous.recurrence : validateRecurrence(value.recurrence);
    const timezone = validateTimezone(value.timezone ?? previous?.timezone ?? hostTimezone());
    const enabled = value.enabled ?? previous?.enabled ?? true;
    if (typeof enabled !== 'boolean') throw new ControlError('enabled must be a boolean.');
    const startAt = value.startAt === undefined || value.startAt === null ? previous?.startAt ?? new Date().toISOString() : instant(value.startAt, 'startAt');
    const endAt = value.endAt === undefined ? previous?.endAt ?? null : value.endAt === null || value.endAt === '' ? null : instant(value.endAt, 'endAt');
    if (endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new ControlError('endAt must be after startAt.');
    const maxRuns = value.maxRuns === undefined ? previous?.maxRuns ?? null : value.maxRuns;
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || (maxRuns as number) < 1 || (maxRuns as number) > 1_000_000)) throw new ControlError('maxRuns must be a positive whole number or null.');
    const overlap = value.overlap ?? previous?.overlap ?? 'skip', catchUp = value.catchUp ?? previous?.catchUp ?? 'once';
    if (overlap !== 'skip' && overlap !== 'allow') throw new ControlError('overlap must be skip or allow.');
    if (catchUp !== 'once' && catchUp !== 'skip') throw new ControlError('catchUp must be once or skip.');
    const taskInput = value.task === undefined && previous ? {} : jsonObject(value.task, 'task');
    const task = this.host.template(projectId, taskInput, previous?.task);
    const name = jsonText(value.name, 'Schedule name', previous?.name ?? taskTitle(task), 200).trim();
    if (!name) throw new ControlError('Schedule name is required.');
    return { projectId, name, description: jsonText(value.description, 'Schedule description', previous?.description ?? '', 2_000), enabled, recurrence, timezone, startAt, endAt, maxRuns: maxRuns as number | null, overlap, catchUp, task };
  }
  /** The next occurrence strictly after `after`, within the schedule's start, end and run limits. */
  next(schedule: Pick<TaskSchedule, 'recurrence' | 'timezone' | 'startAt' | 'endAt' | 'maxRuns' | 'runCount'>, after: number): string | null {
    if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns) return null;
    const start = Date.parse(schedule.startAt);
    const time = nextOccurrence(schedule.recurrence, schedule.timezone, Math.max(after, start - 1), start);
    if (time === null || (schedule.endAt && time > Date.parse(schedule.endAt))) return null;
    return new Date(time).toISOString();
  }
  /** Upcoming occurrences of a draft, for previews; nothing is stored. */
  preview(input: unknown, count = 5): { timezone: string; occurrences: string[] } {
    const value = jsonObject(input, 'Schedule');
    const recurrence = validateRecurrence(value.recurrence), timezone = validateTimezone(value.timezone ?? hostTimezone());
    const startAt = value.startAt ? instant(value.startAt, 'startAt') : new Date().toISOString();
    const endAt = value.endAt ? instant(value.endAt, 'endAt') : null, maxRuns = Number.isInteger(value.maxRuns) ? value.maxRuns as number : null;
    const occurrences: string[] = []; let after = Date.now();
    for (let index = 0; index < (Number.isFinite(count) ? Math.min(Math.max(1, count), 20) : 5); index++) {
      const next = this.next({ recurrence, timezone, startAt, endAt, maxRuns, runCount: index }, after);
      if (!next) break; occurrences.push(next); after = Date.parse(next);
    }
    return { timezone, occurrences };
  }
  create(input: unknown): TaskSchedule {
    if (this.store.state.schedules.length >= SCHEDULE_LIMIT) throw new ControlError(`Schedule limit is ${SCHEDULE_LIMIT}.`);
    const timestamp = new Date().toISOString();
    const schedule: TaskSchedule = { id: `schedule_${randomUUID()}`, ...this.fields(input), nextRunAt: null, lastRunAt: null, lastTaskId: null, runCount: 0, revision: 1, createdAt: timestamp, updatedAt: timestamp };
    schedule.nextRunAt = schedule.enabled ? this.next(schedule, Date.now()) : null;
    this.store.state.schedules.push(schedule);
    this.host.event(null, 'schedule.created', `Schedule ${schedule.name} created. Next run: ${schedule.nextRunAt ?? 'none'}.`, { scheduleId: schedule.id, projectId: schedule.projectId });
    this.host.changed(); return structuredClone(schedule);
  }
  update(scheduleId: string, input: unknown): TaskSchedule {
    const previous = this.schedule(scheduleId), fields = this.fields(input, previous);
    const timing = (['recurrence', 'timezone', 'startAt', 'endAt', 'maxRuns', 'enabled'] as const).some((key) => JSON.stringify(fields[key]) !== JSON.stringify(previous[key]));
    Object.assign(previous, fields, { revision: previous.revision + 1, updatedAt: new Date().toISOString() });
    // A pending catch-up survives edits that do not touch the timing; changed timing counts from now.
    if (timing || (!previous.nextRunAt && previous.enabled)) previous.nextRunAt = previous.enabled ? this.next(previous, Date.now()) : null;
    this.host.changed(); return structuredClone(previous);
  }
  delete(scheduleId: string): void {
    const schedule = this.schedule(scheduleId);
    this.store.state.schedules = this.store.state.schedules.filter((item) => item.id !== scheduleId);
    this.host.event(null, 'schedule.deleted', `Schedule ${schedule.name} deleted; tasks it created are kept.`, { scheduleId, projectId: schedule.projectId });
    this.host.changed();
  }
  deleteProject(projectId: string): void { this.store.state.schedules = this.store.state.schedules.filter((item) => item.projectId !== projectId); }
  /** Starts an extra occurrence now; the regular timetable is unchanged. */
  runNow(scheduleId: string): Task {
    const schedule = this.schedule(scheduleId);
    const task = this.host.createTask(schedule, null);
    schedule.lastRunAt = new Date().toISOString(); schedule.lastTaskId = task.id;
    this.outcome(schedule, { status: 'created', message: 'Started manually.', taskId: task.id });
    this.host.changed(); return task;
  }
  private open(schedule: TaskSchedule): Task | undefined {
    return this.store.state.tasks.find((task) => task.scheduleId === schedule.id && !task.archivedAt && OPEN_STATUSES.has(task.status));
  }
  private outcome(schedule: TaskSchedule, value: Omit<ScheduleOutcome, 'at'>): void {
    schedule.lastOutcome = { at: new Date().toISOString(), ...value };
    this.host.event(value.taskId ?? null, `schedule.${value.status}`, `${schedule.name}: ${value.message}`, { scheduleId: schedule.id, projectId: schedule.projectId, ...(value.occurrence ? { occurrence: value.occurrence } : {}) });
  }
  /** Creates the tasks of due occurrences. Called every second; cheap when nothing is due. */
  tick(now = Date.now()): void {
    let changed = false;
    for (const schedule of this.store.state.schedules) {
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
      // A stopped system starts no work; the occurrence counts as missed once it runs again.
      if (!this.host.systemEnabled()) continue;
      const occurrence = schedule.nextRunAt, missed = now - Date.parse(occurrence) > SCHEDULE_GRACE_MS;
      changed = true;
      if (missed && schedule.catchUp === 'skip') this.outcome(schedule, { status: 'skipped', message: `Missed the run of ${occurrence} while the service was closed or stopped.`, occurrence });
      else if (schedule.overlap === 'skip' && this.open(schedule)) {
        const open = this.open(schedule)!, reason = open.status === 'ready' ? open.queueReason : undefined;
        this.outcome(schedule, { status: 'skipped', message: reason ? `The previous task of this schedule cannot start: ${reason}` : 'The previous task of this schedule is still open.', taskId: open.id, occurrence });
      } else {
        try {
          const task = this.host.createTask(schedule, occurrence);
          schedule.runCount++; schedule.lastRunAt = new Date(now).toISOString(); schedule.lastTaskId = task.id;
          this.outcome(schedule, { status: 'created', message: missed ? `Catching up the missed run of ${occurrence}.` : 'Created the scheduled task.', taskId: task.id, occurrence });
        } catch (error) {
          this.outcome(schedule, { status: 'failed', message: (error as Error).message, occurrence });
        }
      }
      // Further missed occurrences are folded into this one: the next run is the first after now.
      schedule.nextRunAt = this.next(schedule, Math.max(now, Date.parse(occurrence)));
    }
    if (changed) this.host.changed();
  }
}
