import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFatal, isDirectEntrypoint } from '../index.js';

describe('CLI fatal error handling', () => {
  it('exits on a broken output pipe instead of reporting to the closed pipe', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exited'); });
    try {
      expect(() => handleFatal(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toThrow('exited');
      expect(exit).toHaveBeenCalledWith(1);
    } finally { exit.mockRestore(); }
  });
});

describe('CLI entrypoint detection', () => {
  it('matches a filesystem argv entry through a proper file URL', () => {
    const entry = resolve('dist', 'cli.js');

    expect(isDirectEntrypoint(pathToFileURL(entry).href, entry)).toBe(true);
    expect(isDirectEntrypoint(pathToFileURL(entry).href, undefined)).toBe(false);
  });
  it('recognizes npm link junctions and symlinks after ESM resolves the actual entry file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-cli-link-'));
    try {
      const source = join(directory, 'source'); await mkdir(source); await writeFile(join(source, 'cli.js'), '// entry');
      const linked = join(directory, 'npm-linked-package'); await symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
      const entry = join(linked, 'cli.js'); const actual = await realpath(entry);
      expect(isDirectEntrypoint(pathToFileURL(actual).href, entry)).toBe(true);
      if (process.platform === 'win32') expect(isDirectEntrypoint(pathToFileURL(actual).href.toLowerCase(), entry)).toBe(true);
      expect(isDirectEntrypoint(pathToFileURL(join(source, 'other.js')).href, entry)).toBe(false);
      expect(isDirectEntrypoint('https://example.com/cli.js', entry)).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
