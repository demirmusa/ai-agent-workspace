import { Option, type Command } from 'commander';
import { resolve } from 'node:path';
import { booleanOption, print, readLocalJson, request, segment } from './client.js';

/** Local projects, provider sessions in their folders, AI planning and optional GitHub Projects links. */
export function registerProjectCommands(control: Command): void {
  const projects = control.command('projects').description('Manage local projects and optional GitHub Projects connections.');
  projects.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/projects/${segment(id)}`)));
  projects.command('list').action(async (_options, command) => print((await request(command, '/api/state')).projects));
  projects.command('create <name>').requiredOption('--path <path>', 'existing repository working directory').option('--description <text>', 'project description', '').option('--default-branch <branch>', 'default source branch for new tasks', 'main')
    .action(async (name, options, command) => print(await request(command, '/api/projects', 'POST', { name, description: options.description, defaultBranch: options.defaultBranch, ...(options.path ? { repositoryPath: resolve(options.path) } : {}) })));
  projects.command('update <id>').option('--name <name>').option('--path <path>').option('--description <text>').option('--default-branch <branch>').option('--auto-merge <boolean>', 'GitHub task PR auto-merge: true or false')
    .addOption(new Option('--use-worktree <boolean>').choices(['true', 'false'])).option('--main-branch <branch>').option('--max-concurrent <count>', 'most agents this project runs at once, or none to remove the limit')
    .action(async (id, options, command) => {
      const autoMerge = booleanOption(options.autoMerge, '--auto-merge');
      print(await request(command, `/api/projects/${segment(id)}`, 'PATCH', { ...options, ...(options.useWorktree === undefined ? {} : { useWorktree: options.useWorktree === 'true' }), ...(autoMerge === undefined ? {} : { autoMerge }), ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent === 'none' ? null : Number(options.maxConcurrent) }), ...(options.path ? { repositoryPath: resolve(options.path) } : {}) }));
    });
  projects.command('branches <id>').description('List local Git branches for a project.').action(async (id, _options, command) => { const project = await request(command, `/api/projects/${segment(id)}`); print(await request(command, '/api/repository/branches', 'POST', { path: project.repositoryPath })); });
  projects.command('delete <id>').action(async (id, _options, command) => print(await request(command, `/api/projects/${segment(id)}`, 'DELETE')));
  projects.command('detect <path>').description('Discover GitHub repository and Projects from the backend Git remote.').action(async (path, _options, command) => print(await request(command, '/api/repository/detect', 'POST', { path })));
  projects.command('plan <id> <message>').description('Converse with a real planning agent and create its validated tasks.').option('--agent <id>').option('--draft', 'plan without creating tasks', false)
    .action(async (id, message, options, command) => print(await request(command, `/api/projects/${segment(id)}/plan`, 'POST', { message, ...(options.agent ? { agentId: options.agent } : {}), createTasks: !options.draft })));
  projects.command('conversation <id>').action(async (id, _options, command) => print((await request(command, '/api/state')).plannerMessages.filter((message: any) => message.projectId === id)));
  projects.command('sessions <id>').description('Read existing Codex and Claude sessions belonging to the project directory.').addOption(new Option('--provider <provider>').choices(['codex', 'claude'])).option('--search <text>', 'match title, first user message or session ID across all pages').addOption(new Option('--sort <order>').choices(['recent', 'oldest', 'created'])).option('--limit <number>', 'page size', '20').option('--cursor <cursor>').option('--refresh', 'refresh the read-only history index', false)
    .action(async (id, options, command) => {
      const params = new URLSearchParams({ limit: options.limit });
      if (options.provider) params.set('provider', options.provider);
      if (options.search) params.set('q', options.search);
      if (options.sort) params.set('sort', options.sort);
      if (options.cursor) params.set('cursor', options.cursor);
      if (options.refresh) params.set('refresh', '1');
      print(await request(command, `/api/projects/${segment(id)}/sessions?${params}`));
    });
  projects.command('session <projectId> <sessionId>').description('Read a provider session transcript without starting a task.').option('--cursor <cursor>').option('--limit <number>', 'event page size', '100')
    .action(async (projectId, sessionId, options, command) => {
      const params = new URLSearchParams({ limit: options.limit }); if (options.cursor) params.set('cursor', options.cursor);
      print(await request(command, `/api/projects/${segment(projectId)}/sessions/${segment(sessionId)}?${params}`));
    });
  projects.command('resume <projectId> <sessionId>').description('Explicitly continue the original provider session; listing or reading never starts it.').option('--message <text>', 'new instruction; required for stream mode').addOption(new Option('--terminal <mode>').choices(['stream', 'pty']).default('pty'))
    .action(async (projectId, sessionId, options, command) => print(await request(command, `/api/projects/${segment(projectId)}/sessions/${segment(sessionId)}/resume`, 'POST', { terminalMode: options.terminal, ...(options.message === undefined ? {} : { message: options.message }) })));
  projects.command('draft <id> <message>').description('Prepare one editable task draft with a read-only AI; never creates tasks or runs.').option('--agent <id>').option('--draft-file <file>', 'current form fields as a JSON object').option('--history-file <file>', 'modal conversation as a JSON array of role/text messages')
    .action(async (id, message, options, command) => print(await request(command, `/api/projects/${segment(id)}/draft`, 'POST', {
      message, ...(options.agent ? { agentId: options.agent } : {}),
      ...(options.draftFile ? { draft: await readLocalJson(options.draftFile) } : {}),
      ...(options.historyFile ? { messages: await readLocalJson(options.historyFile) } : {}),
    })));
  projects.command('organize <id>').description('Let an AI order the backlog against the ready queue, record dependencies and move actionable tasks to Ready; no board task is created.').option('--cancel', 'stop the running organizer', false)
    .action(async (id, options, command) => print(await request(command, `/api/projects/${segment(id)}/organize${options.cancel ? '/cancel' : ''}`, 'POST', {})));
  projects.command('connect <id>').option('--repository <owner/repo>', 'manual connection override').option('--owner <owner>').option('--number <number>', 'Project number selected from discovery')
    .addOption(new Option('--owner-type <type>').choices(['user', 'organization']).default('user')).option('--status-field <name>', 'Projects status field', 'Status')
    .option('--create-project', 'create and link a GitHub Project after discovering the repository', false).option('--project-title <title>')
    .option('--create-repository', 'create a GitHub repository for a folder without a GitHub remote, then a linked Project', false).option('--repository-name <name>').option('--public', 'make the created repository public', false)
    .option('--statuses <json>', 'task status to GitHub option name mapping as a JSON object')
    .action(async (id, options, command) => {
      const statuses: unknown = options.statuses === undefined ? undefined : JSON.parse(options.statuses);
      if (statuses !== undefined && (!statuses || typeof statuses !== 'object' || Array.isArray(statuses) || Object.values(statuses).some((value) => typeof value !== 'string'))) throw new Error('--statuses must be a JSON object containing string values.');
      if (!options.repository) { print(await request(command, `/api/projects/${segment(id)}/connect`, 'POST', { ...(options.number ? { projectNumber: Number(options.number) } : {}), ...(options.owner ? { projectOwner: options.owner, projectOwnerType: options.ownerType } : {}), createProject: options.createProject, ...(options.projectTitle ? { projectTitle: options.projectTitle } : {}), ...(options.createRepository ? { createRepository: true, repositoryPrivate: !options.public, ...(options.repositoryName ? { repositoryName: options.repositoryName } : {}) } : {}) })); return; }
      if (!options.owner || !options.number) throw new Error('Manual --repository connections also require --owner and --number; omit --repository to use Git discovery.');
      print(await request(command, `/api/projects/${segment(id)}`, 'PATCH', { github: { repository: options.repository, owner: options.owner, number: Number(options.number), ownerType: options.ownerType, statusField: options.statusField, ...(statuses ? { statuses } : {}) } }));
    });
  projects.command('disconnect <id>').action(async (id, _options, command) => print(await request(command, `/api/projects/${segment(id)}`, 'PATCH', { github: null })));
  projects.command('sync <id>').action(async (id, _options, command) => print(await request(command, `/api/projects/${segment(id)}/sync`, 'POST', {})));
}
