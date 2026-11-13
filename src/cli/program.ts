import process from 'node:process';
import { Command } from 'commander';
import { ConsoleLogger } from '../shared/core/logger.js';
import { NodeCommandRunner } from '../shared/core/command.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { registerAgentSkillCommands } from './commands/agent-skills.js';
import { registerConfigCommands } from './commands/config-commands.js';
import type { ContextFactory, RunWithContext } from './commands/context.js';
import { registerControlCommands } from './commands/control.js';
import { registerQueueCommands } from './commands/queue-commands.js';
import { registerSetupCommands } from './commands/setup-commands.js';

/** The complete `aiws` command tree; each command group registers itself from its own module. */
export function createProgram(contextFactory: ContextFactory = defaultContext): Command {
  const program = new Command();
  program
    .name('ai-agent-workspace')
    .description('Run repo-scoped Claude Code, Codex and OpenCode GitHub agents on your Docker host.')
    .version(PACKAGE_VERSION)
    .option('-C, --cwd <path>', 'target repository directory', process.cwd())
    .option('-v, --verbose', 'show diagnostic details', false)
    .showHelpAfterError();

  const run: RunWithContext = async (command, action) => {
    const global = command.optsWithGlobals<{ cwd: string; verbose: boolean }>();
    await action(contextFactory(global.cwd, global.verbose));
  };
  registerSetupCommands(program, run);
  registerConfigCommands(program, run);
  registerQueueCommands(program, run);
  registerControlCommands(program);
  registerAgentSkillCommands(program);
  return program;
}

function defaultContext(cwd: string, verbose: boolean) {
  return { cwd, verbose, logger: new ConsoleLogger(verbose), runner: new NodeCommandRunner() };
}
