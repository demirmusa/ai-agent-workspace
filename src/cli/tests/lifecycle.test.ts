import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runValidateConfig } from '../commands/validate-config.js';
import { requireGitBranchName } from '../commands/input.js';
import { buildDefaultRepoConfig } from '../../shared/config/defaults.js';
import type { CommandResult, CommandRunner } from '../../shared/core/command.js';
import type { Logger } from '../../shared/core/logger.js';
import { renderRepository } from '../../templates/repository.js';
import { writeRenderedRepository } from '../../templates/writer.js';
import { PACKAGE_VERSION } from '../../shared/version.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('repository-only lifecycle commands', () => {
  it('rejects option-like and malformed setup branch names', () => {
    expect(() => requireGitBranchName('--delete')).toThrow(/valid Git branch name/);
    expect(() => requireGitBranchName('feature/../main')).toThrow(/valid Git branch name/);
    expect(requireGitBranchName('aiws/sync-safe')).toBe('aiws/sync-safe');
  });

  it('validates a clean clone without any machine-local installation state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-clean-clone-'));
    temporaryDirectories.push(directory);
    const config = buildDefaultRepoConfig({ repository: 'owner/repo', defaultBranch: 'main' });
    const rendered = await renderRepository(config, resolve('assets'), PACKAGE_VERSION);
    await writeRenderedRepository(directory, rendered);

    const messages: string[] = [];
    await runValidateConfig({
      cwd: directory,
      verbose: false,
      runner: new GitInspectionRunner(directory),
      logger: collectingLogger(messages),
    });

    expect(messages).toContain('Configuration and generated workflows are valid and in sync.');
    expect(process.exitCode).toBeUndefined();
  });
});

class GitInspectionRunner implements CommandRunner {
  constructor(private readonly root: string) {}

  async run(command: string, args: readonly string[] = []): Promise<CommandResult> {
    const invocation = args.join(' ');
    const stdout = invocation === 'rev-parse --show-toplevel'
      ? `${this.root}\n`
      : invocation === 'remote get-url origin'
        ? 'https://github.com/owner/repo.git\n'
        : invocation === 'branch --show-current'
          ? 'main\n'
          : '';
    if (command !== 'git' || !stdout) throw new Error(`Unexpected command: ${command} ${invocation}`);
    return { command, args: [...args], exitCode: 0, stdout, stderr: '' };
  }
}

function collectingLogger(messages: string[]): Logger {
  return {
    info: (message) => messages.push(message),
    success: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
    detail: (message) => messages.push(message),
  };
}
