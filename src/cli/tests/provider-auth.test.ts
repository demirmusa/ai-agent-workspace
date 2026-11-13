import { describe, expect, it } from 'vitest';
import { buildDefaultInstallationState, buildDefaultRepoConfig } from '../../shared/config/index.js';
import { providerDockerArgs, providerMount } from '../commands/login.js';
import { providerAuthStatus } from '../commands/status.js';
import { parseProviders } from '../commands/input.js';
import { readFile } from 'node:fs/promises';

function fixture() {
  const config = buildDefaultRepoConfig('owner/repo');
  const installation = buildDefaultInstallationState(config);
  return { config, installation, targetRuntimeDirectory: '/runtime' } as Parameters<typeof providerMount>[0];
}

describe('provider authentication and execution', () => {
  it('accepts OpenCode alongside other providers and rejects typos', () => {
    expect(parseProviders('claude,codex,opencode,opencode')).toEqual(['claude', 'codex', 'opencode']);
    expect(() => parseProviders('open-code')).toThrow();
  });
  it('shares the persisted OpenCode auth volume without exposing other providers', () => {
    const loaded = fixture();
    const args = providerDockerArgs(loaded, 'opencode', true);
    expect(args).toContain(`${loaded.installation.names.volumes.opencodeAuth}:/home/agent/.local/share/opencode`);
    expect(args).toContain('XDG_DATA_HOME=/home/agent/.local/share');
    expect(args).toContain('-it');
    expect(args.join(' ')).not.toContain(loaded.installation.names.volumes.codexAuth);
    expect(args.join(' ')).not.toContain('docker.sock');
  });
  it('reports explicit Claude unauthenticated status even when CLI exits successfully', async () => {
    const logger = { info() {}, success() {}, warn() {}, error() {}, detail() {} };
    const context = { cwd: '/', verbose: false, logger, runner: { async run(command: string, args: readonly string[] = []) {
      return { command, args: [...args], exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' };
    } } };
    expect(await providerAuthStatus(context, fixture(), 'claude')).toBe('missing');
  });
  it('runs OpenCode headless, propagates provider errors, and supports read-only reviews', async () => {
    const script = await readFile('assets/runtime/bin/run-agent.sh', 'utf8');
    expect(script).toContain('args=(run --format json)');
    expect(script).toContain('opencode "${args[@]}" < "$AIWS_BRIEF"');
    expect(script).toContain('select(.type == "text") | .part.text');
    expect(script).toContain('any(.[]; .type == "error")');
    expect(script).toContain('AIWS_READ_ONLY');
  });
});

