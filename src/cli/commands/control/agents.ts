import { Option, type Command } from 'commander';
import { aiProviders } from '../../../control-server/ai-providers/index.js';
import { booleanOption, ids, print, readLocalText, request, segment } from './client.js';

/** Body fields shared by `agents create` and `agents update`. */
async function agentFields(options: Record<string, any>): Promise<Record<string, unknown>> {
  const args: unknown = JSON.parse(options.args ?? '[]');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('--args must be a JSON string array.');
  const enabled = booleanOption(options.enabled, '--enabled');
  return {
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model === 'null' ? null : options.model } : {}),
    ...(options.instructions !== undefined || options.instructionsFile ? { instructions: options.instructionsFile ? await readLocalText(options.instructionsFile) : options.instructions } : {}),
    ...(options.context !== undefined || options.contextFile ? { context: options.contextFile ? await readLocalText(options.contextFile) : options.context } : {}),
    ...(options.skills !== undefined ? { skillIds: ids(options.skills) } : {}),
    ...(options.capabilities !== undefined ? { capabilities: ids(options.capabilities) } : {}),
    ...(options.terminal !== undefined ? { terminalMode: options.terminal } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(options.executable ? { command: { executable: options.executable, args } } : {}),
  };
}

export function registerAgentCommands(control: Command): void {
  const agents = control.command('agents').description('Define reusable agents with instructions, background context and skills.');
  agents.command('list').action(async (_options, command) => print(await request(command, '/api/agents')));
  agents.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/agents/${segment(id)}`)));
  for (const operation of ['create', 'update']) {
    agents.command(`${operation} <${operation === 'create' ? 'name' : 'id'}>`)
      .option('--name <name>', 'agent display name (update)')
      .option('--description <text>').addOption(new Option('--provider <provider>').choices([...aiProviders.ids(), 'command']))
      .option('--model <model>', 'model identifier, or null to clear')
      .option('--instructions <text>').option('--instructions-file <path>', 'read agent instructions from a local UTF-8 file')
      .option('--context <text>').option('--context-file <path>', 'read background context from a local UTF-8 file')
      .option('--skills <ids>', 'comma-separated skill IDs; empty clears the selection').option('--enabled <boolean>', 'true or false')
      .option('--capabilities <names>', 'comma-separated capabilities visible to other agents').addOption(new Option('--terminal <mode>').choices(['stream', 'pty']))
      .option('--executable <file>', 'command provider executable').option('--args <json>', 'command argument JSON array')
      .action(async (value, options, command) => {
        const fields = await agentFields(options);
        print(await request(command, operation === 'create' ? '/api/agents' : `/api/agents/${segment(value)}`, operation === 'create' ? 'POST' : 'PATCH', { ...fields, ...(operation === 'create' ? { name: value } : options.name ? { name: options.name } : {}) }));
      });
  }
  agents.command('delete <id>').action(async (id, _options, command) => print(await request(command, `/api/agents/${segment(id)}`, 'DELETE')));
  agents.command('directory').description('Show configured colleagues, capabilities and live availability.').action(async (_options, command) => {
    const state = await request(command, '/api/state'); print(state.agents.map((agent: any) => ({ id: agent.id, name: agent.name, provider: agent.provider, capabilities: agent.capabilities ?? [], enabled: agent.enabled, ...(state.agentAvailability?.[agent.id] ?? {}) })));
  });
}
