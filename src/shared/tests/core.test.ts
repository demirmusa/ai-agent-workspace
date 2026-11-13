import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  changedManifestPaths,
  createManagedManifest,
  deterministicResourceNames,
  hashManifest,
  aiwsHomePath,
  installationStatePath,
  joinPosixShellArgs,
  quotePosixShell,
  readJsonFile,
  redactSecrets,
  repositoryConfigPath,
  sha256,
  writeJsonFileAtomic,
} from '../core/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('deterministic names and paths', () => {
  it('keeps names stable while retaining collision resistance after sanitization', () => {
    const first = deterministicResourceNames('Owner/a.b');
    const again = deterministicResourceNames('owner/A.B');
    const punctuationCollision = deterministicResourceNames('owner/a-b');

    expect(first).toEqual(again);
    expect(first.composeProject).not.toBe(punctuationCollision.composeProject);
    expect(first.composeProject).toMatch(/^aiws-[a-z0-9-]+-[0-9a-f]{12}$/);
    expect(first.images.agent).toMatch(/:local$/);
  });

  it('keeps the repository-specific runner label within GitHub limits', async () => {
    const { stableRunnerLabels } = await import('../core/names.js');
    const labels = stableRunnerLabels(`owner/${'very-long-repository-name-'.repeat(3)}`);

    expect(labels).toHaveLength(3);
    expect(labels[2]).toHaveLength(50);
    expect(labels[2]).toMatch(/-[0-9a-f]{12}-runner$/);
  });

  it('keeps the default runner name within GitHub limits', () => {
    const names = deterministicResourceNames(`owner/${'very-long-repository-name-'.repeat(3)}`);

    expect(names.containers.runner.length).toBeLessThanOrEqual(64);
  });

  it('uses tracked repository paths and honors AIWS_HOME for untracked state', () => {
    const repositoryRoot = resolve('workspace', 'repo');
    const testHome = resolve('users', 'tester');
    const stateHome = resolve('var', 'lib', 'aiws');
    expect(repositoryConfigPath(repositoryRoot)).toBe(join(repositoryRoot, '.aiworkspace', 'config.json'));
    expect(aiwsHomePath({ env: { AIWS_HOME: '.custom' }, homeDir: testHome })).toBe(
      join(testHome, '.custom'),
    );
    expect(
      installationStatePath('owner/repo', {
        env: { AIWS_HOME: stateHome },
        homeDir: resolve('ignored'),
      }),
    ).toContain(join(stateHome, 'repositories'));
  });
});

describe('hashes and manifests', () => {
  it('creates standard SHA-256 and canonical JSON hashes', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('builds deterministic manifests and identifies changed paths', () => {
    const first = createManagedManifest(
      { 'z.txt': 'z', 'a.sh': '#!/bin/sh\n' },
      { generatorVersion: '1.0.0', config: { b: 2, a: 1 }, executablePaths: ['a.sh'] },
    );
    const reordered = createManagedManifest(
      { 'a.sh': '#!/bin/sh\n', 'z.txt': 'z' },
      { generatorVersion: '1.0.0', config: { a: 1, b: 2 }, executablePaths: ['a.sh'] },
    );
    const changed = createManagedManifest(
      { 'a.sh': '#!/bin/sh\necho changed\n', 'z.txt': 'z' },
      { generatorVersion: '1.0.0', config: { a: 1, b: 2 }, executablePaths: ['a.sh'] },
    );

    expect(hashManifest(first)).toBe(hashManifest(reordered));
    expect(changedManifestPaths(first, changed)).toEqual(['a.sh']);
  });
});

describe('safe serialization helpers', () => {
  it('writes JSON atomically without leaving sibling temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-json-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'state.json');

    await writeJsonFileAtomic(path, { ready: true });

    expect(await readJsonFile(path)).toEqual({ ready: true });
    expect(await readFile(path, 'utf8')).toBe('{\n  "ready": true\n}\n');
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('redacts key-based and explicit secrets without mutating input', () => {
    const source = {
      githubToken: 'ghp_value',
      message: 'Authorization used ghp_value',
      nested: { safe: 'visible' },
    };
    const redacted = redactSecrets(source, ['ghp_value']);

    expect(redacted).toEqual({
      githubToken: '[REDACTED]',
      message: 'Authorization used [REDACTED]',
      nested: { safe: 'visible' },
    });
    expect(source.githubToken).toBe('ghp_value');
  });

  it('quotes arbitrary POSIX shell arguments', () => {
    expect(quotePosixShell('')).toBe("''");
    expect(quotePosixShell("it's safe")).toBe("'it'\"'\"'s safe'");
    expect(joinPosixShellArgs(['echo', '$HOME'])).toBe("'echo' '$HOME'");
  });
});
