import type { InstallationState } from '../shared/config/installation-schema.js';
import type { RepoConfig } from '../shared/config/schema.js';
import type { CommandRunner } from '../shared/core/command.js';
import { runOnTarget } from './target.js';
import { runnerServiceNames } from './materialize.js';

export function composeBaseArgs(installation: InstallationState): string[] {
  return [
    'compose',
    '--project-name',
    installation.names.composeProject,
    '--file',
    'compose.yaml',
  ];
}

export async function composeBuild(
  runner: CommandRunner,
  config: RepoConfig,
  installation: InstallationState,
  runtimeDirectory: string,
  pull: boolean,
  dryRun: boolean,
): Promise<string[]> {
  const args = [...composeBaseArgs(installation), 'build', ...(pull ? ['--pull'] : []), 'runner', 'agent-image'];
  if (!dryRun) await runOnTarget(runner, installation, 'docker', args, { runtimeDirectory, stdio: 'inherit' });
  return ['docker', ...args];
}

export async function composeUp(
  runner: CommandRunner,
  config: RepoConfig,
  installation: InstallationState,
  runtimeDirectory: string,
  dryRun: boolean,
): Promise<string[]> {
  const project = config.queue.mode === 'project' || config.queue.mode === 'both';
  const args = [
    ...composeBaseArgs(installation),
    'up',
    '--detach',
    '--remove-orphans',
    ...runnerServiceNames(config),
    ...(config.orchestration.enabled || project ? ['queue-poller'] : []),
  ];
  if (!dryRun) await runOnTarget(runner, installation, 'docker', args, { runtimeDirectory, stdio: 'inherit' });
  return ['docker', ...args];
}

export async function composeDown(
  runner: CommandRunner,
  installation: InstallationState,
  runtimeDirectory: string,
  dryRun: boolean,
): Promise<string[]> {
  const args = [...composeBaseArgs(installation), 'down', '--remove-orphans'];
  if (!dryRun) await runOnTarget(runner, installation, 'docker', args, { runtimeDirectory, stdio: 'inherit' });
  return ['docker', ...args];
}

export async function composeLogs(
  runner: CommandRunner,
  installation: InstallationState,
  runtimeDirectory: string,
  options: { follow: boolean; tail: number; service: 'all' | 'runner' | 'poller' },
): Promise<void> {
  const services = options.service === 'all' ? [] : [options.service === 'poller' ? 'queue-poller' : 'runner'];
  const args = [
    ...composeBaseArgs(installation),
    'logs',
    '--tail',
    String(options.tail),
    ...(options.follow ? ['--follow'] : []),
    ...services,
  ];
  await runOnTarget(runner, installation, 'docker', args, { runtimeDirectory, stdio: 'inherit' });
}
