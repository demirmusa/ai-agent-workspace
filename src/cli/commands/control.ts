import type { Command } from 'commander';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { startControlServer } from '../../control-server/index.js';
import { DEFAULT_CONTROL_PORT, DEFAULT_CONTROL_URL } from '../../shared/core/control-endpoint.js';
import { registerAgentCommands } from './control/agents.js';
import { print, request } from './control/client.js';
import { registerMilestoneCommands } from './control/milestones.js';
import { registerPluginCommands } from './control/plugins.js';
import { registerProjectCommands } from './control/projects.js';
import { registerQuestionCommands } from './control/questions.js';
import { registerRunCommands } from './control/runs.js';
import { registerScheduleCommands } from './control/schedules.js';
import { registerSettingsCommands } from './control/settings.js';
import { registerSkillCommands } from './control/skills.js';
import { registerTaskCommands } from './control/tasks.js';
import { registerWorkflowCommands } from './control/workflows.js';

export { controlRequest } from './control/client.js';

/** `aiws control`: runs the local control service, and is a thin JSON client of its API (control/*.ts). */
export function registerControlCommands(program: Command): void {
  const control = program.command('control').description('Local-first Kanban, agent runs and the desktop backend.');
  control.option('--url <url>', `control server URL (default: AIWS_CONTROL_URL, the running local service, then ${DEFAULT_CONTROL_URL})`)
    .option('--json', 'machine-readable JSON', false);
  control.command('serve').description('Start the API and web UI; no GitHub account is required.')
    .option('--host <host>', 'listen address', process.env.AIWS_CONTROL_HOST ?? '127.0.0.1')
    .option('--port <port>', 'listen port', process.env.AIWS_CONTROL_PORT ?? String(DEFAULT_CONTROL_PORT))
    .option('--data-dir <path>', 'persistent control data directory', process.env.AIWS_CONTROL_DATA_DIR ?? process.env.AIWS_CONTROL_DATA ?? resolve(homedir(), '.aiws', 'control'))
    .action(async (options) => {
      const running = await startControlServer({ host: options.host, port: Number(options.port), dataDir: resolve(options.dataDir), ...(process.env.AIWS_CONTROL_TOKEN ? { token: process.env.AIWS_CONTROL_TOKEN } : {}) });
      process.stdout.write(`AI Agent Workspace: ${running.url}\n`);
      const close = () => { void running.close().then(() => { process.exitCode = 0; }); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
    });
  control.command('state').action(async (_options, command) => print(await request(command, '/api/state')));
  registerAgentCommands(control);
  registerWorkflowCommands(control);
  registerSkillCommands(control);
  registerSettingsCommands(control);
  registerProjectCommands(control);
  registerPluginCommands(control);
  registerTaskCommands(control);
  registerMilestoneCommands(control);
  registerScheduleCommands(control);
  registerRunCommands(control);
  registerQuestionCommands(control);
}
