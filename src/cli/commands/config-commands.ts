import type { Command } from 'commander';
import { runConfigImport, runConfigSet, runConfigShow, runConfigure } from './configure.js';
import type { RunWithContext } from './context.js';
import { runModels } from './login.js';
import { runMenu } from './menu.js';
import { runProjectSetup } from './project-setup.js';
import { runReview, runReviewProfile } from './review.js';
import { runTargetSettings } from './target-settings.js';
import { runValidateConfig } from './validate-config.js';

/** Tracked repository settings, review settings, the Docker host target and the Projects board setup. */
export function registerConfigCommands(program: Command, run: RunWithContext): void {
  const config = program.command('config').description('Inspect repository configuration.');
  config
    .command('validate')
    .description('Validate tracked configuration and generated-file ownership.')
    .action(async (_options, command) => {
      await run(command, runValidateConfig);
    });

  config.command('show').description('Print all validated settings as JSON.')
    .action(async (_options, command) => run(command, (context) => runConfigShow(context)));
  config.command('get <path>').description('Read a dotted setting path, e.g. agents.profiles.0.model.')
    .action(async (path, _options, command) => run(command, (context) => runConfigShow(context, path)));
  config.command('set <path> <value>').description('Atomically set a string or JSON value after full validation.')
    .action(async (path, value, _options, command) => run(command, (context) => runConfigSet(context, path, value)));
  config.command('import <file>').description('Validate and replace all settings from a JSON file.')
    .action(async (file, _options, command) => run(command, (context) => runConfigImport(context, file)));
  program.command('configure').description('Interactively edit all repository settings.')
    .action(async (_options, command) => run(command, runConfigure));
  program.command('menu').description('Open the interactive control center.')
    .action(async (_options, command) => run(command, runMenu));
  program.command('models [provider]').description('List available provider models (OpenCode includes free models).')
    .action(async (provider, _options, command) => run(command, (context) => runModels(context, { provider: provider ?? 'opencode' })));
  const review = program.command('review').description('Configure and request read-only PR reviews.');
  for (const [name, value] of [['enable', 'true'], ['disable', 'false']] as const) {
    review.command(name).description(`${name} PR review in repository settings.`)
      .action(async (_options, command) => run(command, (context) => runConfigSet(context, 'review.enabled', value)));
  }
  review.command('profile <id>').description('Choose a configured agent profile for reviews (null uses default).')
    .action(async (id, _options, command) => run(command, (context) => runReviewProfile(context, id)));
  review.command('profiles <ids...>').description('Review with several configured profiles, in order.')
    .action(async (ids, _options, command) => run(command, (context) => runConfigSet(context, 'review.profiles', JSON.stringify(ids))));
  review.command('run <number>').description('Dispatch a PR review using the committed default-branch settings.')
    .action(async (number, _options, command) => run(command, (context) => runReview(context, number)));
  review.command('show').description('Show review settings.')
    .action(async (_options, command) => run(command, (context) => runConfigShow(context, 'review')));
  program.command('target').description('Show or configure the local/SSH Docker host.')
    .option('--show', 'show current host settings').option('--target <target>', 'local or ssh')
    .option('--host <host>', 'SSH host').option('--user <user>', 'SSH user').option('--port <port>', 'SSH port')
    .option('--identity <path>', 'SSH identity file').option('--state-dir <path>', 'absolute host state directory')
    .action(async (options, command) => run(command, (context) => runTargetSettings(context, options)));
  program.command('project-setup').description('Add missing configured Projects states while preserving existing cards.')
    .option('--dry-run', 'show missing states without changing the project', false)
    .action(async (options, command) => run(command, (context) => runProjectSetup(context, options)));
}
