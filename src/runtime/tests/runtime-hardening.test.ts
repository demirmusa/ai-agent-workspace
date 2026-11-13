import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDefaultInstallationState,
  buildDefaultRepoConfig,
  type InstallationState,
} from '../../shared/config/index.js';
import type { CommandOptions, CommandResult, CommandRunner } from '../../shared/core/command.js';
import { materializeRuntime } from '../materialize.js';
import { uploadRuntime } from '../target.js';

const temporaryDirectories: string[] = [];
const originalAiwsHome = process.env.AIWS_HOME;

afterEach(async () => {
  if (originalAiwsHome === undefined) delete process.env.AIWS_HOME;
  else process.env.AIWS_HOME = originalAiwsHome;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.sequential('runtime materialization hardening', () => {
  it('maps the runtime I/O volume and safely quotes Compose string values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-runtime-hardening-'));
    temporaryDirectories.push(directory);
    process.env.AIWS_HOME = join(directory, 'state-$home');

    const config = buildDefaultRepoConfig('owner/repo');
    config.runner.labels.push('literal${NOT_INTERPOLATED}"\\label');
    const installation = buildDefaultInstallationState(config);
    installation.runnerName = 'runner${NAME}"\\value';
    const runtime = await materializeRuntime(config, installation, resolve('assets'), {
      dockerGid: 0,
      remoteRuntimeDirectory: '/srv/${RUNTIME}/"quoted\\path',
    });

    const compose = parse(await readFile(join(runtime, 'compose.yaml'), 'utf8')) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, { name: string }>;
    };
    const runner = compose.services.runner as {
      build: { context: string; args: Record<string, string> };
      environment: Record<string, string>;
      pids_limit: number;
    };

    expect(compose.volumes.runtime_io?.name).toBe(installation.names.volumes.cache);
    expect(runner.environment.AIWS_RUNTIME_IO_VOLUME).toBe(installation.names.volumes.cache);
    expect(runner.environment.AIWS_RUNNER_NAME).toBe('runner$${NAME}"\\value');
    expect(runner.environment.AIWS_RUNNER_LABELS).toContain('$${NOT_INTERPOLATED}');
    expect(runner.build.context).toBe('/srv/$${RUNTIME}/"quoted\\path');
    expect(runner.build.args.DOCKER_GID).toBe('0');
    expect(runner.pids_limit).toBe(1024);
  });
});

describe('SSH target hardening', () => {
  it('uses unambiguous IPv6 destinations for ssh and scp', async () => {
    const runner = new RecordingRunner();
    const installation = buildDefaultInstallationState('owner/repo', {
      target: 'ssh',
      ssh: { host: '2001:db8::10', user: 'runner', port: 2222 },
    });

    await uploadRuntime(runner, installation, resolve('runtime-source'));

    expect(runner.calls[0]).toMatchObject({ command: 'ssh' });
    expect(runner.calls[0]?.args).toContain('runner@2001:db8::10');
    expect(runner.calls[1]).toMatchObject({ command: 'scp' });
    expect(runner.calls[1]?.args.at(-1)).toMatch(
      /^runner@\[2001:db8::10\]:\/home\/runner\/\.aiws\/repositories\/.+\/runtime\.upload-\d+-\d+$/,
    );
  });

  it.each([
    '/home/runner/../victim',
    '/home/runner/./state',
    '/home//runner/state',
  ])('rejects non-normalized remote state path %s before issuing a command', async (stateDir) => {
    const runner = new RecordingRunner();
    const base = buildDefaultInstallationState('owner/repo', {
      target: 'ssh',
      ssh: { host: 'server.example', user: 'runner', port: 22 },
    });
    const installation: InstallationState = { ...base, stateDir };

    await expect(uploadRuntime(runner, installation, resolve('runtime-source'))).rejects.toThrow(
      /unexpected remote runtime path/,
    );
    expect(runner.calls).toEqual([]);
  });
});

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], ...(options ? { options } : {}) });
    return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
  }
}
