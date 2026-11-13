import { Option, type Command } from 'commander';
import { aiProviders } from '../../../control-server/ai-providers/index.js';
import { print, request } from './client.js';

/** Control-service settings, the GitHub account it uses and the general workspace. */
export function registerSettingsCommands(control: Command): void {
  const settings = control.command('settings').description('Configure worker execution and GitHub polling.');
  settings.command('show').action(async (_options, command) => print((await request(command, '/api/state')).settings));
  settings.command('set').addOption(new Option('--task-merge-mode <mode>').choices(['pull-request', 'branch']))
    .addOption(new Option('--execution-mode <mode>').choices(['native', 'docker']))
    .addOption(new Option('--default-provider <provider>').choices(aiProviders.ids()))
    .option('--docker-image <image>').option('--max-concurrent <count>').option('--auto-sync-seconds <seconds>').option('--github-trigger <word>', 'word that addresses the agent in GitHub issues and comments, for example /ai')
    .action(async (options, command) => print(await request(command, '/api/settings', 'PATCH', {
      ...(options.taskMergeMode ? { taskMergeMode: options.taskMergeMode } : {}),
      ...(options.defaultProvider ? { defaultProvider: options.defaultProvider } : {}),
      ...(options.executionMode ? { executionMode: options.executionMode } : {}), ...(options.dockerImage ? { dockerImage: options.dockerImage } : {}),
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: Number(options.maxConcurrent) } : {}), ...(options.autoSyncSeconds !== undefined ? { autoSyncSeconds: Number(options.autoSyncSeconds) } : {}),
      ...(options.githubTrigger !== undefined ? { githubTrigger: options.githubTrigger } : {}),
    })));
  control.command('workspace').description('Show the general workspace: a folder for automations outside any repository.').action(async (_options, command) => print(await request(command, '/api/workspace')));
  const github = control.command('github').description('GitHub access used for repositories, Projects and issue comments.');
  github.command('status').description('Show the GitHub account and missing repo/project scopes.').action(async (_options, command) => print(await request(command, '/api/github/auth')));
  github.command('authorize').description('Open gh device login on the control-center computer with repo and project scopes.').action(async (_options, command) => print(await request(command, '/api/github/authorize', 'POST', {})));
}
