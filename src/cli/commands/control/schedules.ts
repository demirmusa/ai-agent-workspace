import { Option, type Command } from 'commander';
import { booleanOption, ids, inheritableBooleanOption, print, projectRef, readLocalText, request, segment } from './client.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `mon-fri`, `sat,sun` or `1,3,5` (0 and 7 are Sunday) as weekday numbers. */
function weekdays(value: string): number[] {
  return value.split(',').flatMap((part) => {
    const day = (name: string) => { const index = DAY_NAMES.indexOf(name.trim().toLowerCase().slice(0, 3)); const number = index >= 0 ? index : Number(name); if (!Number.isInteger(number) || number < 0 || number > 7) throw new Error(`Unknown weekday: ${name}`); return number % 7; };
    const [from, to] = part.split('-'); if (to === undefined) return [day(from!)];
    const start = day(from!), end = day(to); return Array.from({ length: ((end - start + 7) % 7) + 1 }, (_, index) => (start + index) % 7);
  });
}

/** The one timetable chosen with --once, --every, --daily, --monthly or --cron. */
function recurrence(options: Record<string, any>): Record<string, unknown> | undefined {
  const chosen = ['once', 'every', 'daily', 'monthly', 'cron'].filter((key) => options[key] !== undefined);
  if (chosen.length > 1) throw new Error('Choose one of --once, --every, --daily, --monthly or --cron.');
  if (options.once !== undefined) return { kind: 'once', at: options.once };
  if (options.every !== undefined) {
    const match = /^(\d+)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)$/i.exec(String(options.every).trim());
    if (!match) throw new Error('--every takes a number and unit, for example 30m, 2h, 1d or 1w.');
    const unit = match[2]!.toLowerCase()[0]; return { kind: 'interval', every: Number(match[1]), unit: unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : unit === 'd' ? 'days' : 'weeks' };
  }
  if (options.daily !== undefined) return { kind: 'daily', times: ids(options.daily), weekdays: options.weekdays ? weekdays(options.weekdays) : [] };
  if (options.monthly !== undefined) return { kind: 'monthly', days: ids(options.monthly).map((day) => day === 'last' ? -1 : Number(day)), times: ids(options.at ?? '09:00') };
  if (options.cron !== undefined) return { kind: 'cron', expression: options.cron };
  return undefined;
}

async function scheduleBody(options: Record<string, any>): Promise<Record<string, unknown>> {
  const enabled = booleanOption(options.enabled, '--enabled');
  const autoMerge = inheritableBooleanOption(options.autoMerge, '--auto-merge');
  const description = options.descriptionFile ? await readLocalText(options.descriptionFile) : options.description;
  const task = {
    ...(options.title !== undefined ? { title: options.title } : {}), ...(description !== undefined ? { description } : {}),
    ...(options.agent !== undefined ? { agentId: options.agent === 'none' ? null : options.agent } : {}), ...(options.provider !== undefined ? { provider: options.provider === 'inherit' ? null : options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model === 'inherit' ? null : options.model } : {}), ...(options.skills !== undefined ? { skillIds: ids(options.skills) } : {}), ...(options.tags !== undefined ? { tags: ids(options.tags) } : {}),
    ...(options.priority !== undefined ? { priority: Number(options.priority) } : {}), ...(options.terminal !== undefined ? { terminalMode: options.terminal } : {}), ...(options.workflow !== undefined ? { workflowId: options.workflow === 'none' ? null : options.workflow } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}), ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
  };
  const rule = recurrence(options);
  return {
    ...(options.name !== undefined ? { name: options.name } : {}), ...(options.note !== undefined ? { description: options.note } : {}), ...(rule ? { recurrence: rule } : {}),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}), ...(options.startAt !== undefined ? { startAt: options.startAt } : {}), ...(options.endAt !== undefined ? { endAt: options.endAt === 'none' ? null : options.endAt } : {}),
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns === 'none' ? null : Number(options.maxRuns) } : {}), ...(options.overlap !== undefined ? { overlap: options.overlap } : {}), ...(options.catchUp !== undefined ? { catchUp: options.catchUp } : {}),
    ...(enabled !== undefined ? { enabled } : {}), ...(Object.keys(task).length ? { task } : {}),
  };
}

const scheduleOptions = (command: Command): Command => command
  .option('--name <name>', 'schedule name (defaults to the task title)').option('--note <text>', 'what the schedule is for')
  .option('--title <text>', 'title of each created task').option('--description <text>', 'instructions of each created task').option('--description-file <path>', 'read task instructions from a local UTF-8 file')
  .option('--once <time>', 'run one time at this date and time').option('--every <interval>', 'repeat every 30m, 2h, 1d or 1w (1 minute minimum)')
  .option('--daily <times>', 'comma-separated HH:MM times every day').option('--weekdays <days>', 'with --daily: mon-fri, sat,sun or 1,3,5 (0 = Sunday)')
  .option('--monthly <days>', 'comma-separated days of the month, last for the last day').option('--at <times>', 'with --monthly: comma-separated HH:MM times')
  .option('--cron <expression>', 'five-field cron expression, for example "0 9 * * 1-5"').option('--timezone <zone>', 'IANA time zone; defaults to the control service time zone')
  .option('--start-at <time>', 'no run before this time; intervals count from it').option('--end-at <time>', 'no run after this time, or none').option('--max-runs <count>', 'stop after this many scheduled runs, or none')
  .addOption(new Option('--overlap <policy>', 'when the previous task is still open').choices(['skip', 'allow'])).addOption(new Option('--catch-up <policy>', 'runs missed while closed or stopped').choices(['once', 'skip']))
  .option('--enabled <boolean>', 'true or false').option('--agent <id>', 'agent definition ID, or none').option('--provider <provider>', 'provider override, or inherit').option('--model <model>', 'model override, or inherit')
  .option('--skills <ids>', 'additional comma-separated skill IDs').option('--tags <tags>').option('--priority <number>', 'High=3, Medium=2, Low=1').addOption(new Option('--terminal <mode>').choices(['stream', 'pty']))
  .option('--workflow <id>', 'workflow ID or none').option('--auto-merge <boolean>', 'true, false or inherit').option('--base-branch <branch>', 'source branch of created tasks');

export function registerScheduleCommands(control: Command): void {
  const schedules = control.command('schedules').description('Scheduled and recurring tasks of a project or of the general workspace.');
  schedules.command('list').option('--project <id>', 'project ID, or general for the general workspace').action(async (options, command) => print(await request(command, `/api/schedules${options.project ? `?projectId=${segment(projectRef(options.project))}` : ''}`)));
  schedules.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/schedules/${segment(id)}`)));
  scheduleOptions(schedules.command('create <projectId> <title>').description('Create a schedule; projectId general targets the general workspace. Each run creates a Ready task.'))
    .action(async (projectId, title, options, command) => {
      const body = await scheduleBody({ ...options, title: options.title ?? title });
      if (!body.recurrence) throw new Error('Choose when it runs: --once, --every, --daily, --monthly or --cron.');
      print(await request(command, '/api/schedules', 'POST', { projectId: projectRef(projectId), ...body }));
    });
  scheduleOptions(schedules.command('update <id>')).action(async (id, options, command) => print(await request(command, `/api/schedules/${segment(id)}`, 'PATCH', await scheduleBody(options))));
  schedules.command('delete <id>').description('Delete a schedule; tasks it created are kept.').action(async (id, _options, command) => print(await request(command, `/api/schedules/${segment(id)}`, 'DELETE')));
  schedules.command('run <id>').description('Create the schedule task now, without changing its timetable.').action(async (id, _options, command) => print(await request(command, `/api/schedules/${segment(id)}/run`, 'POST', {})));
  for (const [name, enabled] of [['enable', true], ['disable', false]] as const) schedules.command(`${name} <id>`).action(async (id, _options, command) => print(await request(command, `/api/schedules/${segment(id)}`, 'PATCH', { enabled })));
  schedules.command('preview').description('Show the next run times of a timetable without saving anything.')
    .option('--once <time>').option('--every <interval>').option('--daily <times>').option('--weekdays <days>').option('--monthly <days>').option('--at <times>', 'with --monthly').option('--cron <expression>')
    .option('--timezone <zone>').option('--start-at <time>').option('--end-at <time>').option('--count <number>', 'how many runs to show', '5')
    .action(async (options, command) => {
      const rule = recurrence(options); if (!rule) throw new Error('Choose --once, --every, --daily, --monthly or --cron.');
      print(await request(command, `/api/schedules/preview?count=${encodeURIComponent(options.count)}`, 'POST', { recurrence: rule, ...(options.timezone ? { timezone: options.timezone } : {}), ...(options.startAt ? { startAt: options.startAt } : {}), ...(options.endAt ? { endAt: options.endAt } : {}) }));
    });
}
