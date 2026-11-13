import { Option, type Command } from 'commander';
import { AGENT_PROVIDERS } from '../../shared/config/schema.js';
import type { RunWithContext } from './context.js';
import { runDoctor } from './doctor.js';
import { runDown } from './down.js';
import { runInit } from './init.js';
import { runLogin } from './login.js';
import { runLogs } from './logs.js';
import { runRemove } from './remove.js';
import { runStatus } from './status.js';
import { runSync } from './sync.js';
import { runUp } from './up.js';

/** Repository installation lifecycle: init/sync of generated files, runner stack up/down, logins and diagnostics. */
export function registerSetupCommands(program: Command, run: RunWithContext): void {
  program
    .command('init')
    .description('Generate the repository integration and open a setup pull request.')
    .addOption(new Option('--queue <mode>', 'queue source').choices(['label', 'project', 'both']).default('label'))
    .addOption(new Option('--default-provider <provider>', 'default agent').choices(AGENT_PROVIDERS).default('claude'))
    .option('--providers <providers>', 'enabled providers (comma-separated)', 'claude,codex')
    .option('--allowed-actor <login...>', 'GitHub users allowed to trigger the runner')
    .option('--project-owner <owner>', 'Projects v2 owner')
    .addOption(new Option('--project-owner-type <type>', 'Projects v2 owner type').choices(['user', 'organization']).default('user'))
    .option('--project-number <number>', 'Projects v2 number')
    .addOption(new Option('--target <target>', 'Docker target').choices(['local', 'ssh']).default('local'))
    .option('--ssh-host <host>', 'SSH host when --target=ssh')
    .option('--ssh-user <user>', 'SSH user')
    .option('--ssh-port <port>', 'SSH port')
    .option('--ssh-identity <path>', 'SSH private-key path')
    .option('--runner-name <name>', 'self-hosted runner name')
    .option('--allow-public', 'explicitly allow a public repository', false)
    .option('--no-secrets', 'do not install workflow secrets')
    .option('--no-pr', 'write generated files into the current working tree')
    .option('--branch <name>', 'setup PR branch name')
    .option('-y, --yes', 'accept security prompts', false)
    .option('--dry-run', 'render and validate without writing or calling GitHub', false)
    .action(async (options, command) => {
      await run(command, (context) => runInit(context, options));
    });

  program
    .command('sync')
    .description('Update generated workflows/config with a reviewable pull request.')
    .option('--no-pr', 'write updates into the current working tree')
    .option('--branch <name>', 'update PR branch name')
    .option('--force', 'replace locally modified generated files', false)
    .option('--dry-run', 'show the update without writing or calling GitHub', false)
    .action(async (options, command) => {
      await run(command, (context) => runSync(context, options));
    });

  program
    .command('up')
    .description('Build and start the local or SSH Docker runner stack.')
    .option('--pull', 'refresh base images before building', false)
    .option('--dry-run', 'show commands without executing them', false)
    .action(async (options, command) => {
      await run(command, (context) => runUp(context, options));
    });

  program
    .command('down')
    .description('Stop the stack and remove its GitHub runner registration; keep volumes.')
    .option('--dry-run', 'show commands without executing them', false)
    .action(async (options, command) => {
      await run(command, (context) => runDown(context, options));
    });

  program
    .command('status')
    .description('Show container, GitHub runner, provider-auth and recent-run state.')
    .option('--json', 'print machine-readable JSON', false)
    .action(async (options, command) => {
      await run(command, (context) => runStatus(context, options));
    });

  program
    .command('login [provider]')
    .description('Authenticate GitHub, Claude, Codex, OpenCode, or all enabled providers.')
    .addOption(new Option('--auth <method>', 'Codex authentication method').choices(['subscription', 'api-key']).default('subscription'))
    .action(async (provider, options, command) => {
      await run(command, (context) => runLogin(context, { ...options, provider: provider ?? 'all' }));
    });

  program
    .command('logs')
    .description('Read runner or Projects poller logs.')
    .addOption(new Option('--service <service>', 'service to inspect').choices(['all', 'runner', 'poller']).default('all'))
    .option('-f, --follow', 'follow log output', false)
    .option('--tail <lines>', 'number of historical lines', '200')
    .action(async (options, command) => {
      await run(command, (context) => runLogs(context, options));
    });

  program
    .command('doctor')
    .description('Check Git, GitHub, Docker, config, runtime and auth prerequisites.')
    .option('--json', 'print machine-readable JSON', false)
    .action(async (options, command) => {
      await run(command, (context) => runDoctor(context, options));
    });

  program
    .command('remove')
    .alias('uninstall')
    .description('Remove only resources owned by this installation.')
    .option('--no-pr', 'remove tracked files in the current working tree')
    .option('--keep-labels', 'do not remove labels created by init', false)
    .option('--keep-secrets', 'do not remove installed repository secrets', false)
    .option('--purge-work', 'delete the repo workspace Docker volume', false)
    .option('--purge-auth', 'delete shared Claude/Codex auth volumes', false)
    .option('--force', 'remove modified generated files too', false)
    .option('-y, --yes', 'confirm destructive cleanup', false)
    .option('--dry-run', 'show cleanup without changing anything', false)
    .action(async (options, command) => {
      await run(command, (context) => runRemove(context, options));
    });
}
