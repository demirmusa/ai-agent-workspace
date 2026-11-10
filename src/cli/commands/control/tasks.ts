import { Option, type Command } from 'commander';
import { aiProviders } from '../../../control-server/ai-providers/index.js';
import { booleanOption, ids, inheritableBooleanOption, print, projectRef, request, segment } from './client.js';

/** "claude:weekly:180" starts the ready task when the weekly window resets within 180 minutes; bucket windows add their length: gemini:bucket:pro:60:1440. */
function parseUsageTrigger(spec: string): Record<string, unknown> {
  const [provider, window, ...rest] = spec.split(':');
  const bucket = window === 'bucket';
  const [id, within, length] = bucket ? rest : [undefined, ...rest];
  const defaults: Record<string, number> = { short: 300, weekly: 10080 };
  const windowMinutes = Number(length ?? (bucket ? NaN : defaults[window ?? '']));
  if (!provider || !window || (bucket && !id) || !within || !Number.isInteger(Number(within)) || !Number.isInteger(windowMinutes)) throw new Error('--usage-trigger must look like provider:short|weekly:minutes, provider:bucket:id:minutes:windowMinutes, or none.');
  return { provider, window: bucket ? `bucket:${id}` : window, windowMinutes, withinMinutes: Number(within) };
}

/** Body fields shared by `tasks create` and `tasks update`. */
function extraTaskFields(options: Record<string, any>): Record<string, unknown> {
  const autoMerge = inheritableBooleanOption(options.autoMerge, '--auto-merge');
  return { ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }), ...(options.workflow === undefined ? {} : { workflowId: options.workflow === 'none' ? null : options.workflow }), ...(options.requestedActions === undefined ? {} : { requestedActions: ids(options.requestedActions) }),
    ...(options.scheduledAt === undefined ? {} : { scheduledAt: options.scheduledAt === 'none' ? null : options.scheduledAt }),
    ...(options.usageTrigger === undefined ? {} : { usageTrigger: options.usageTrigger === 'none' ? null : parseUsageTrigger(options.usageTrigger) }),
    ...(options.account === undefined ? {} : { account: options.account === 'none' ? null : options.account }),
    ...(options.milestone === undefined ? {} : { milestoneId: options.milestone === 'none' ? null : options.milestone }),
    ...(options.tags === undefined ? {} : { tags: ids(options.tags) }), ...(options.blockedBy === undefined ? {} : { dependencyRefs: ids(options.blockedBy) }), ...(options.terminal === undefined ? {} : { terminalMode: options.terminal }), ...(autoMerge === undefined ? {} : { autoMerge }), ...(options.pullRequest === undefined ? {} : { pullRequest: { number: Number(options.pullRequest), ...(options.headSha ? { headSha: options.headSha } : {}) } }) };
}

export function registerTaskCommands(control: Command): void {
  const tasks = control.command('tasks').description('Create and manage tasks without GitHub.');
  tasks.command('search <query>').description('Search Blocked-by references server-side without importing issues.').requiredOption('--project <id>').option('--exclude <id>', 'task being edited').option('--limit <number>', 'page size', '20').option('--cursor <cursor>')
    .action(async (query, options, command) => {
      const params = new URLSearchParams({ projectId: options.project, q: query, limit: options.limit });
      if (options.exclude) params.set('excludeTaskId', options.exclude);
      if (options.cursor) params.set('cursor', options.cursor);
      print(await request(command, `/api/tasks/search?${params}`));
    });
  tasks.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/tasks/${segment(id)}`)));
  tasks.command('list').option('--project <id>').option('--status <status>', 'filter by task status').option('--milestone <id>', "filter by milestone ID; 'none' lists tasks without one").action(async (options, command) => {
    const state = await request(command, '/api/state'), projectId = options.project && projectRef(options.project), milestoneId = options.milestone === 'none' ? undefined : options.milestone;
    print(state.tasks.filter((task: any) => (!projectId || task.projectId === projectId) && (!options.status || task.status === options.status) && (options.milestone === undefined || task.milestoneId === milestoneId)));
  });
  tasks.command('create <projectId> <title>').option('--description <text>', 'task instructions', '').option('--provider <provider>', `${aiProviders.ids().join(', ')} or command`)
    .option('--agent <id>', 'agent definition ID; inherit its provider and model').option('--skills <ids>', 'additional comma-separated skill IDs')
    .option('--model <model>').option('--account <id>', "provider account to run as (Claude Code: claude-swap account number); 'none' uses the default login").option('--status <status>', 'initial status', 'backlog').option('--priority <number>', 'High=3, Medium=2, Low=1; higher values run first', '2').option('--depends-on <ids>', 'comma-separated prerequisite task IDs').option('--auto-start', 'automatically run when ready', false)
    .option('--executable <file>', 'custom command executable').option('--args <json>', 'custom command arguments as JSON array', '[]')
    .option('--workflow <id>').option('--requested-actions <names>', 'semantic follow-up actions, such as deploy').option('--tags <tags>').option('--milestone <id>', "project milestone ID; 'none' leaves the task without one (new tasks default to the current milestone)").option('--blocked-by <references>', 'comma-separated local task IDs or linked GitHub #issue numbers; empty clears').addOption(new Option('--terminal <mode>').choices(['stream', 'pty'])).option('--auto-merge <boolean>', 'true, false or inherit').option('--pull-request <number>').option('--head-sha <sha>').option('--base-branch <branch>', 'source branch for the task')
    .option('--scheduled-at <time>', 'a ready task starts at this date and time (ISO 8601, local time without an offset)')
    .option('--usage-trigger <spec>', 'start the ready task when a quota window is about to reset: provider:short|weekly:minutes, or none')
    .action(async (projectId, title, options, command) => {
      const args: unknown = JSON.parse(options.args);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('--args must be a JSON string array');
      print(await request(command, '/api/tasks', 'POST', { projectId: projectRef(projectId), title, description: options.description, ...extraTaskFields(options), ...(options.agent ? { agentId: options.agent, provider: null, model: null } : {}), ...(options.provider ? { provider: options.provider } : {}), ...(options.skills !== undefined ? { skillIds: ids(options.skills) } : {}), status: options.status, priority: Number(options.priority), autoStart: options.autoStart, dependsOn: options.dependsOn?.split(',').filter(Boolean) ?? [], ...(options.model ? { model: options.model } : {}), ...(options.executable ? { command: { executable: options.executable, args } } : {}) }));
    });
  tasks.command('update <id>').option('--title <text>').option('--description <text>').option('--status <status>').option('--provider <provider>').option('--model <model>').option('--account <id>', "provider account to run as (Claude Code: claude-swap account number); 'none' uses the default login").option('--priority <number>').option('--auto-start <boolean>', 'true or false').option('--depends-on <ids>')
    .option('--agent <id>', 'agent definition ID, or none to unassign').option('--skills <ids>', 'additional comma-separated skill IDs; empty clears selection')
    .option('--inherit-provider', 'clear task provider override').option('--inherit-model', 'clear task model override')
    .option('--workflow <id>', 'workflow ID or none').option('--requested-actions <names>').option('--tags <tags>').option('--milestone <id>', "project milestone ID; 'none' leaves the task without one (new tasks default to the current milestone)").option('--blocked-by <references>', 'comma-separated local task IDs or linked GitHub #issue numbers; empty clears').addOption(new Option('--terminal <mode>').choices(['stream', 'pty'])).option('--auto-merge <boolean>', 'true, false or inherit').option('--pull-request <number>').option('--head-sha <sha>').option('--base-branch <branch>', 'source branch for the task')
    .option('--scheduled-at <time>', 'start time for the ready task, or none to clear')
    .option('--usage-trigger <spec>', 'provider:short|weekly:minutes, or none to clear')
    .action(async (id, options, command) => {
      const autoStart = booleanOption(options.autoStart, '--auto-start');
      print(await request(command, `/api/tasks/${segment(id)}`, 'PATCH', { ...options, ...extraTaskFields(options), ...(options.agent !== undefined ? { agentId: options.agent === 'none' ? null : options.agent, provider: null, model: null } : {}), ...(options.inheritProvider ? { provider: null } : options.provider ? { provider: options.provider } : {}), ...(options.inheritModel ? { model: null } : options.model ? { model: options.model } : {}), ...(options.skills !== undefined ? { skillIds: ids(options.skills) } : {}), ...(autoStart === undefined ? {} : { autoStart }), ...(options.priority === undefined ? {} : { priority: Number(options.priority) }), ...(options.dependsOn !== undefined ? { dependsOn: options.dependsOn.split(',').filter(Boolean) } : {}) }));
    });
  tasks.command('delete <id>').option('--delete-issue', 'also delete the linked GitHub issue (requires repository admin access)').action(async (id, options, command) => print(await request(command, `/api/tasks/${segment(id)}${options.deleteIssue ? '?deleteIssue=true' : ''}`, 'DELETE')));
  tasks.command('run <id>').action(async (id, _options, command) => print(await request(command, `/api/tasks/${segment(id)}/run`, 'POST', {})));
  tasks.command('messages <id>').action(async (id, _options, command) => print(await request(command, `/api/tasks/${segment(id)}/messages`)));
  tasks.command('message <id> <text>').option('--agent <id>', 'author agent ID', process.env.AIWS_AGENT_ID).option('--run <id>', 'author run ID', process.env.AIWS_RUN_ID)
    .action(async (id, text, options, command) => print(await request(command, `/api/tasks/${segment(id)}/messages`, 'POST', { text, authorType: options.run || options.agent ? 'agent' : 'user', ...(options.agent ? { agentId: options.agent } : {}), ...(options.run ? { runId: options.run } : {}) })));
}
