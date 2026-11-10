import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { CommandRunner } from '../core/command.js';
import { AiwsError } from '../core/logger.js';
import { GITHUB_SLUG_PATTERN } from '../core/names.js';

export interface GitHubRemote {
  host: 'github.com';
  owner: string;
  name: string;
  slug: string;
  url: string;
}

export interface GitRepositoryInfo {
  root: string;
  remote: GitHubRemote;
  currentBranch: string;
}


export function parseGitHubRemote(value: string): GitHubRemote {
  const trimmed = value.trim();
  let ownerAndName = '';

  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (scpMatch?.[1]) {
    ownerAndName = scpMatch[1];
  } else {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== 'github.com') throw new Error('not github.com');
      ownerAndName = url.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    } catch {
      if (GITHUB_SLUG_PATTERN.test(trimmed.replace(/\.git$/, ''))) {
        ownerAndName = trimmed.replace(/\.git$/, '');
      }
    }
  }

  if (!GITHUB_SLUG_PATTERN.test(ownerAndName)) {
    throw new AiwsError(
      `Unsupported Git remote: ${trimmed || '(empty)'}`,
      2,
      'Use a GitHub.com HTTPS or SSH remote such as https://github.com/owner/repo.git.',
    );
  }
  const [owner, name] = ownerAndName.split('/') as [string, string];
  return {
    host: 'github.com',
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}.git`,
  };
}

export class GitRepository {
  constructor(
    readonly runner: CommandRunner,
    readonly cwd: string,
  ) {}

  async inspect(): Promise<GitRepositoryInfo> {
    let root: string;
    try {
      root = (await this.runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: this.cwd })).stdout.trim();
    } catch {
      throw new AiwsError('The current directory is not inside a Git repository.', 2);
    }
    const remoteValue = (
      await this.runner.run('git', ['remote', 'get-url', 'origin'], { cwd: root })
    ).stdout.trim();
    const currentBranch = (
      await this.runner.run('git', ['branch', '--show-current'], { cwd: root })
    ).stdout.trim();
    return { root, remote: parseGitHubRemote(remoteValue), currentBranch };
  }

  async isClean(root: string): Promise<boolean> {
    const result = await this.runner.run('git', ['status', '--porcelain=v1'], { cwd: root });
    return result.stdout.trim().length === 0;
  }

  async fetchDefault(root: string, defaultBranch: string): Promise<void> {
    await this.runner.run('git', ['fetch', '--prune', 'origin', defaultBranch], { cwd: root });
  }

  async withTemporaryWorktree<T>(
    root: string,
    baseRef: string,
    callback: (worktree: string) => Promise<T>,
  ): Promise<T> {
    const prefix = join(tmpdir(), 'aiws-worktree-');
    const worktree = await mkdtemp(prefix);
    let registered = false;
    try {
      await this.runner.run('git', ['worktree', 'add', '--detach', worktree, baseRef], { cwd: root });
      registered = true;
      return await callback(worktree);
    } finally {
      if (registered) {
        try {
          await this.runner.run('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
        } catch {
          // The guarded temporary-directory cleanup below handles an interrupted registration.
        }
      }
      await removeOwnedTemporaryDirectory(worktree);
    }
  }

  async createAndPushBranch(
    worktree: string,
    branch: string,
    message: string,
  ): Promise<string> {
    await this.runner.run('git', ['switch', '-c', branch], { cwd: worktree });
    await this.runner.run('git', ['add', '-A'], { cwd: worktree });
    const status = await this.runner.run('git', ['status', '--porcelain=v1'], { cwd: worktree });
    if (!status.stdout.trim()) throw new AiwsError('Generated files are already up to date.', 3);
    await this.runner.run('git', ['-c', 'user.name=ai-agent-workspace', '-c', 'user.email=noreply@github.com', 'commit', '-m', message], { cwd: worktree });
    await this.runner.run('git', ['push', '--set-upstream', 'origin', branch], { cwd: worktree });
    return (await this.runner.run('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  }
}

async function removeOwnedTemporaryDirectory(path: string): Promise<void> {
  // Compare canonical paths: the temp directory itself may be a symlink (macOS /var -> /private/var).
  const resolvedParent = await realpath(tmpdir());
  let resolvedCandidate: string;
  try { resolvedCandidate = await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !resolvedCandidate.startsWith(`${resolvedParent}${sep}`) ||
    !basename(resolvedCandidate).startsWith('aiws-worktree-')
  ) {
    throw new AiwsError(`Refusing to clean unexpected temporary path: ${resolvedCandidate}`);
  }
  await rm(resolvedCandidate, { recursive: true, force: true });
}
