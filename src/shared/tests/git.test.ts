import { describe, expect, it } from 'vitest';
import { parseGitHubRemote } from '../git/repository.js';

describe('GitHub remote parsing', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'owner/repo',
  ])('normalizes %s', (remote) => {
    expect(parseGitHubRemote(remote)).toMatchObject({ slug: 'owner/repo', owner: 'owner', name: 'repo' });
  });

  it('rejects non-GitHub remotes', () => {
    expect(() => parseGitHubRemote('https://gitlab.com/owner/repo.git')).toThrow(/Unsupported/);
  });
});

