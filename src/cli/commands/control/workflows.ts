import { Option, type Command } from 'commander';
import { booleanOption, print, readLocalText, request, segment } from './client.js';

export function registerWorkflowCommands(control: Command): void {
  const workflows = control.command('workflows').description('Manage ordered stages that hand work to named agents.');
  workflows.command('list').action(async (_options, command) => print(await request(command, '/api/workflows')));
  workflows.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/workflows/${segment(id)}`)));
  for (const operation of ['create', 'update']) workflows.command(`${operation} <${operation === 'create' ? 'name' : 'id'}>`)
    .option('--name <name>').option('--description <text>').option('--project <id>', 'project ID, or global')
    .addOption(new Option('--trigger <trigger>').choices(['always', 'requested'])).option('--enabled <boolean>', 'true or false')
    .option('--steps <json>', 'ordered [{name,agentId,instructions,condition}] array').option('--steps-file <path>', 'local JSON steps array file')
    .action(async (value, options, command) => {
      const enabled = booleanOption(options.enabled, '--enabled');
      const raw = options.stepsFile ? await readLocalText(options.stepsFile) : options.steps;
      const steps = raw === undefined ? undefined : JSON.parse(raw);
      if (steps !== undefined && !Array.isArray(steps)) throw new Error('Workflow steps must be a JSON array.');
      print(await request(command, operation === 'create' ? '/api/workflows' : `/api/workflows/${segment(value)}`, operation === 'create' ? 'POST' : 'PATCH', {
        ...(operation === 'create' ? { name: value } : options.name ? { name: options.name } : {}), ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.project === undefined ? {} : { projectId: options.project === 'global' ? null : options.project }), ...(options.trigger ? { trigger: options.trigger } : {}),
        ...(enabled === undefined ? {} : { enabled }), ...(steps === undefined ? {} : { steps }),
      }));
    });
  workflows.command('delete <id>').action(async (id, _options, command) => print(await request(command, `/api/workflows/${segment(id)}`, 'DELETE')));
}
