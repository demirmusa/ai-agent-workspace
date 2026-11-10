import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeDiff, workingChanges } from '../repository-git.js';
import type { Project } from '../types.js';

describe('changeDiff', () => {
  it('returns the patch of a modified and an untracked file and rejects unlisted paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiws-diff-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
    git('init', '-q'); writeFileSync(join(dir, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), 'two\n'); writeFileSync(join(dir, 'b.txt'), 'new\n');
    const project = { repositoryPath: dir } as Project, changes = await workingChanges(project);
    expect((await changeDiff(project, changes, 'a.txt')).diff).toContain('-one\n+two');
    expect((await changeDiff(project, changes, 'b.txt')).diff).toContain('+new');
    await expect(changeDiff(project, changes, '../x')).rejects.toThrow();
  });
});
