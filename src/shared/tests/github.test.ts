import { describe, expect, it } from 'vitest';
import type { CommandOptions, CommandResult, CommandRunner } from '../core/command.js';
import { GitHubClient } from '../github/client.js';

describe('GitHub resource ownership helpers', () => {
  it('reports only labels created by this call and checkpoints each creation', async () => {
    const runner = new ScriptedRunner([
      JSON.stringify([{ name: 'agent:go' }]),
      '',
    ]);
    const checkpointed: string[] = [];
    const github = new GitHubClient(runner, 'test-token');

    const created = await github.ensureLabels(
      'owner/repo',
      [
        { name: 'Agent:Go', color: '000000', description: 'existing' },
        { name: 'agent:done', color: 'ffffff', description: 'new' },
      ],
      async (name) => {
        checkpointed.push(name);
      },
    );

    expect(created).toEqual(['agent:done']);
    expect(checkpointed).toEqual(created);
    expect(runner.calls).toHaveLength(2);
  });

  it('lists repository secret names without reading their values', async () => {
    const runner = new ScriptedRunner([
      JSON.stringify({ secrets: [{ name: 'existing_secret' }] }),
    ]);
    const github = new GitHubClient(runner, 'test-token');

    await expect(github.listSecretNames('owner/repo')).resolves.toEqual(
      new Set(['EXISTING_SECRET']),
    );
    expect(runner.calls[0]?.args.at(-1)).toContain('/actions/secrets?per_page=100&page=1');
  });
});

class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];

  constructor(private readonly stdout: string[]) {}

  async run(
    command: string,
    args: readonly string[] = [],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], ...(options ? { options } : {}) });
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: this.stdout.shift() ?? '',
      stderr: '',
    };
  }
}
