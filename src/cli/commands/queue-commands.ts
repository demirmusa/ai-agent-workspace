import type { Command } from 'commander';
import type { RunWithContext } from './context.js';
import { runQueueAdd, runQueueBlock, runQueueRetry, runQueueStatus } from './queue.js';

/** Queue inspection, retries and dependencies of the GitHub runner queue. */
export function registerQueueCommands(program: Command, run: RunWithContext): void {
  const queue = program.command('queue').description('Inspect and manage queued work and dependencies.');
  queue.command('status').option('--json', 'machine-readable snapshot', false)
    .action(async (options, command) => run(command, (context) => runQueueStatus(context, options)));
  queue.command('add <number>').description('Queue an issue for execution.')
    .action(async (number, _options, command) => run(command, (context) => runQueueAdd(context, number, false)));
  queue.command('organize <number>').description('Ask the AI organizer to order an issue with the current queue.')
    .action(async (number, _options, command) => run(command, (context) => runQueueAdd(context, number, true)));
  queue.command('retry <number>').description('Recover/requeue an issue, resuming its existing branch when possible.')
    .option('--force', 'recover an uncertain dispatch after checking GitHub for active runs', false)
    .action(async (number, options, command) => run(command, (context) => runQueueRetry(context, number, options.force)));
  queue.command('block <number> <blocker>').description('Make an issue wait for a prerequisite issue.')
    .action(async (number, blocker, _options, command) => run(command, (context) => runQueueBlock(context, number, blocker)));
  queue.command('unblock <number> <blocker>').description('Remove a prerequisite relationship.')
    .action(async (number, blocker, _options, command) => run(command, (context) => runQueueBlock(context, number, blocker, true)));
}
