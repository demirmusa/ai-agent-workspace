import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { latestBaseRef } from '../git.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-latest-base-')); roots.push(root);
  const remote = join(root, 'remote.git'), local = join(root, 'local'), other = join(root, 'other');
  git(root, 'init', '--bare', '-b', 'main', remote); git(root, 'clone', remote, local); git(root, 'clone', remote, other);
  for (const dir of [local, other]) { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@localhost'); git(dir, 'checkout', '-B', 'main'); }
  writeFileSync(join(local, 'a.txt'), '1'); git(local, 'add', '.'); git(local, 'commit', '-m', 'one'); git(local, 'push', '-u', 'origin', 'main'); git(other, 'pull', 'origin', 'main');
  const publish = () => { writeFileSync(join(other, 'b.txt'), '2'); git(other, 'add', '.'); git(other, 'commit', '-m', 'two'); git(other, 'push', 'origin', 'main'); return git(other, 'rev-parse', 'HEAD'); };
  return { local, publish };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('latestBaseRef', () => {
  it('fast-forwards a clean local main to origin', () => {
    const { local, publish } = setup(); const sha = publish();
    expect(latestBaseRef(local, 'main')).toBe('refs/heads/main');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(sha);
  });
  it('starts from origin without touching a dirty local main', () => {
    const { local, publish } = setup(); const before = git(local, 'rev-parse', 'HEAD'); const sha = publish();
    writeFileSync(join(local, 'a.txt'), 'dirty');
    expect(latestBaseRef(local, 'main')).toBe('refs/remotes/origin/main');
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before); expect(git(local, 'rev-parse', 'refs/remotes/origin/main')).toBe(sha);
  });
  it('falls back to the local branch without an origin', () => {
    const { local } = setup(); git(local, 'remote', 'remove', 'origin');
    expect(latestBaseRef(local, 'main')).toBe('refs/heads/main');
    expect(latestBaseRef(local, 'missing')).toBeNull();
  });
});
