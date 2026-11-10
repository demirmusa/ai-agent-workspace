import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../index.js';
import { buildDefaultRepoConfig } from '../../shared/config/defaults.js';
import { saveRepoConfig } from '../../shared/config/store.js';
import { ConsoleLogger } from '../../shared/core/logger.js';

describe('CLI settings commands', () => {
  it('persists valid commands, rejects invalid writes atomically, and exposes review controls', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiws-cli-'));
    try {
      await saveRepoConfig(cwd, buildDefaultRepoConfig({ repository: 'owner/repo' }));
      const command = () => createProgram(() => ({ cwd, verbose: false, logger: new ConsoleLogger(), runner: {
        run: async () => { throw new Error('Settings must not call external commands'); },
      } })).exitOverride();
      await command().parseAsync(['node', 'aiws', 'config', 'set', 'queue.pollSeconds', '90']);
      const file = join(cwd, '.aiworkspace', 'config.json');
      expect(JSON.parse(await readFile(file, 'utf8')).queue.pollSeconds).toBe(90);
      const before = await readFile(file, 'utf8');
      await expect(command().parseAsync(['node', 'aiws', 'config', 'set', 'queue.pollSeconds', '-1'])).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(before);
      await command().parseAsync(['node', 'aiws', 'review', 'enable']);
      expect(JSON.parse(await readFile(file, 'utf8')).review.enabled).toBe(true);
      await command().parseAsync(['node', 'aiws', 'review', 'disable']);
      expect(JSON.parse(await readFile(file, 'utf8')).review.enabled).toBe(false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
