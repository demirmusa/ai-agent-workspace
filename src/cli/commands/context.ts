import type { Command } from 'commander';
import type { CommandRunner } from '../../shared/core/command.js';
import type { Logger } from '../../shared/core/logger.js';

export interface AppContext {
  cwd: string;
  verbose: boolean;
  runner: CommandRunner;
  logger: Logger;
}

/** Builds the context of one command from the global `--cwd` and `--verbose` options. */
export type ContextFactory = (cwd: string, verbose: boolean) => AppContext;
/** Runs a command action with a context built from that command's global options. */
export type RunWithContext = (command: Command, action: (context: AppContext) => Promise<void>) => Promise<void>;
