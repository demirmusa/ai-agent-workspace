import { isIP } from 'node:net';
import type { InstallationState } from '../shared/config/installation-schema.js';
import type { CommandOptions, CommandResult, CommandRunner } from '../shared/core/command.js';
import { AiwsError } from '../shared/core/logger.js';
import { quotePosixShell } from '../shared/core/shell.js';
import { RUNTIME_SECRETS_DIRECTORY, SECRET_FILE_NAMES } from './secrets.js';

export interface TargetRunOptions extends CommandOptions {
  runtimeDirectory: string;
  tty?: boolean;
}

export async function runOnTarget(
  runner: CommandRunner,
  installation: InstallationState,
  command: string,
  args: readonly string[],
  options: TargetRunOptions,
): Promise<CommandResult> {
  if (installation.target === 'local') {
    const { runtimeDirectory, tty: _tty, ...commandOptions } = options;
    return await runner.run(command, args, { ...commandOptions, cwd: runtimeDirectory });
  }
  const ssh = requireSsh(installation);
  const remoteState = installation.stateDir.replace(/\/$/, '');
  const remoteRuntime = `${remoteState}/runtime`;
  assertRemoteChild(remoteState, remoteRuntime);
  const remoteCommand = `cd ${quotePosixShell(remoteRuntime)} && ${[command, ...args]
    .map(quotePosixShell)
    .join(' ')}`;
  return await runner.run(
    'ssh',
    [...sshArguments(ssh), ...(options.tty ? ['-t'] : []), sshDestination(ssh), remoteCommand],
    {
      ...(options.stdio ? { stdio: options.stdio } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.redact ? { redact: options.redact } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
    },
  );
}

export async function uploadRuntime(
  runner: CommandRunner,
  installation: InstallationState,
  localRuntimeDirectory: string,
): Promise<string> {
  if (installation.target === 'local') return localRuntimeDirectory;
  const ssh = requireSsh(installation);
  const remoteState = installation.stateDir.replace(/\/$/, '');
  const remoteRuntime = `${remoteState}/runtime`;
  const remoteStaging = `${remoteState}/runtime.upload-${process.pid}-${Date.now()}`;
  const remotePrevious = `${remoteState}/runtime.previous`;
  assertRemoteChild(remoteState, remoteRuntime);
  assertRemoteChild(remoteState, remoteStaging);
  assertRemoteChild(remoteState, remotePrevious);
  await runner.run('ssh', [
    ...sshArguments(ssh),
    sshDestination(ssh),
    // The state directory is owner-only so the staged secrets are never readable by other users,
    // even before their own modes are narrowed below (scp applies the remote umask).
    `umask 077 && mkdir -p ${quotePosixShell(remoteState)} && chmod 700 ${quotePosixShell(remoteState)} && rm -rf -- ${quotePosixShell(remoteStaging)}`,
  ]);
  await runner.run('scp', [
    ...scpArguments(ssh),
    '-r',
    localRuntimeDirectory,
    `${scpDestination(ssh)}:${remoteStaging}`,
  ]);
  await runner.run('ssh', [
    ...sshArguments(ssh),
    sshDestination(ssh),
    [
      'set -eu',
      `chmod 700 ${quotePosixShell(`${remoteStaging}/${RUNTIME_SECRETS_DIRECTORY}`)}`,
      `chmod 600 ${Object.values(SECRET_FILE_NAMES).map((name) => quotePosixShell(`${remoteStaging}/${RUNTIME_SECRETS_DIRECTORY}/${name}`)).join(' ')}`,
      `rm -rf -- ${quotePosixShell(remotePrevious)}`,
      `if [ -e ${quotePosixShell(remoteRuntime)} ]; then mv -- ${quotePosixShell(remoteRuntime)} ${quotePosixShell(remotePrevious)}; fi`,
      `if mv -- ${quotePosixShell(remoteStaging)} ${quotePosixShell(remoteRuntime)}; then rm -rf -- ${quotePosixShell(remotePrevious)}; else if [ -e ${quotePosixShell(remotePrevious)} ]; then mv -- ${quotePosixShell(remotePrevious)} ${quotePosixShell(remoteRuntime)}; fi; exit 1; fi`,
    ].join(' && '),
  ]);
  return remoteRuntime;
}

export async function detectDockerSocketGid(
  runner: CommandRunner,
  installation: InstallationState,
): Promise<number> {
  if (process.env.AIWS_DOCKER_GID && /^\d+$/.test(process.env.AIWS_DOCKER_GID)) {
    return Number(process.env.AIWS_DOCKER_GID);
  }
  try {
    if (installation.target === 'ssh') {
      const ssh = requireSsh(installation);
      const result = await runner.run('ssh', [
        ...sshArguments(ssh),
        sshDestination(ssh),
        "stat -c '%g' /var/run/docker.sock",
      ]);
      return Number(result.stdout.trim());
    }
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      return (await stat('/var/run/docker.sock')).gid;
    }
  } catch {
    // Docker Desktop normally exposes the socket as root-owned inside Linux containers.
  }
  return 0;
}

function requireSsh(installation: InstallationState): NonNullable<InstallationState['ssh']> {
  if (!installation.ssh) throw new AiwsError('SSH installation is missing target settings.');
  if (installation.ssh.host.includes(':') && isIP(installation.ssh.host) !== 6) {
    throw new AiwsError(`Invalid IPv6 SSH host: ${installation.ssh.host}`);
  }
  return installation.ssh;
}

function sshDestination(ssh: NonNullable<InstallationState['ssh']>): string {
  // ssh receives the destination as its own argument and the port through -p,
  // so a raw IPv6 literal has no host/path delimiter ambiguity.
  return `${ssh.user}@${ssh.host}`;
}

function scpDestination(ssh: NonNullable<InstallationState['ssh']>): string {
  // scp uses a colon to separate host and path, so an IPv6 literal must be
  // bracketed to keep its address colons unambiguous.
  const host = isIP(ssh.host) === 6 ? `[${ssh.host}]` : ssh.host;
  return `${ssh.user}@${host}`;
}

function sshArguments(ssh: NonNullable<InstallationState['ssh']>): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-p',
    String(ssh.port),
    ...(ssh.identityFile ? ['-i', ssh.identityFile] : []),
  ];
}

function scpArguments(ssh: NonNullable<InstallationState['ssh']>): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-P',
    String(ssh.port),
    ...(ssh.identityFile ? ['-i', ssh.identityFile] : []),
  ];
}

function assertRemoteChild(parent: string, candidate: string): void {
  if (
    !isNormalizedAbsoluteRemotePath(parent) ||
    !isNormalizedAbsoluteRemotePath(candidate) ||
    candidate === parent ||
    !candidate.startsWith(`${parent}/`)
  ) {
    throw new AiwsError(`Refusing to replace an unexpected remote runtime path: ${candidate}`);
  }
}

function isNormalizedAbsoluteRemotePath(value: string): boolean {
  if (!value.startsWith('/') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments[0] === '' && segments.slice(1).every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..'
  );
}
