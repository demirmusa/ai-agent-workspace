import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDefaultRepoConfig } from '../../shared/config/defaults.js';
import { githubExpressionJson } from '../engine.js';
import { renderRepository } from '../repository.js';
import { planManagedRemoval, writeRenderedRepository } from '../writer.js';

const temporaryDirectories: string[] = [];
const assetsRoot = resolve('assets');

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('repository rendering', () => {
  it('renders thin credential-safe workflows for both providers', async () => {
    const config = buildDefaultRepoConfig({ repository: 'owner/repo', defaultBranch: 'trunk' });
    const rendered = await renderRepository(config, assetsRoot, '0.1.0');

    expect(Object.keys(rendered.files)).toEqual([
      '.aiworkspace/config.json',
      '.github/workflows/aiws-agent-task.yml',
      '.github/workflows/aiws-pr-agent.yml',
      '.github/workflows/aiws-agent-organize.yml',
      '.github/workflows/aiws-pr-review.yml',
      '.aiworkspace/manifest.json',
    ]);
    const task = rendered.files['.github/workflows/aiws-agent-task.yml'] ?? '';
    const pr = rendered.files['.github/workflows/aiws-pr-agent.yml'] ?? '';
    expect(task).toContain('/opt/aiws/bin/issue-run.sh');
    expect(pr).toContain('/opt/aiws/bin/pr-run.sh');
    expect(pr).toContain("startsWith(github.event.comment.body, '/aiws ')");
    expect(`${task}${pr}`).not.toContain('actions/checkout');
    expect(`${task}${pr}`).not.toContain('docker.sock');
    expect(`${task}${pr}`).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it('keeps every value inside the GitHub expression string literal', () => {
    const literal = githubExpressionJson(["it's", 'a}} || true ${{ x']);
    expect(literal).not.toMatch(/[{}]/);
    expect(JSON.parse(literal.replaceAll("''", "'"))).toEqual(["it's", 'a}} || true ${{ x']);
  });
  it('emits queue and hooks workflows only when enabled', async () => {
    const config = buildDefaultRepoConfig({ repository: 'owner/repo', queueMode: 'project' });
    config.hooks.test = { run: 'npm test', image: 'node:22-bookworm' };
    const rendered = await renderRepository(config, assetsRoot, '0.1.0');

    expect(rendered.files['.github/workflows/aiws-agent-queue.yml']).toContain('AIWS_PROJECT_TOKEN');
    expect(rendered.files['.github/workflows/aiws-hooks.yml']).toContain('/opt/aiws/bin/hook-run.sh');
  });

  it('keeps workflow jobs alive for runtime startup, execution, and shutdown', async () => {
    const config = buildDefaultRepoConfig({ repository: 'owner/repo', queueMode: 'project' });
    config.agent.timeouts = {
      issueMinutes: 11,
      prMinutes: 17,
      hookMinutes: 13,
      startupSeconds: 61,
      shutdownSeconds: 60,
    };
    config.hooks.test = { run: 'npm test', timeoutMinutes: 21 };
    config.hooks.custom = [
      {
        id: 'slow-check',
        command: '/slow-check',
        run: 'npm run slow-check',
        timeoutMinutes: 27,
      },
    ];

    const rendered = await renderRepository(config, assetsRoot, '0.1.0');

    // Lifecycle overhead is ceil((61 + 60) / 60) + 5 = 8 minutes.
    expect(rendered.files['.github/workflows/aiws-agent-task.yml']).toContain(
      'timeout-minutes: 19',
    );
    expect(rendered.files['.github/workflows/aiws-agent-queue.yml']).toContain(
      'timeout-minutes: 19',
    );
    expect(rendered.files['.github/workflows/aiws-pr-agent.yml']).toContain(
      'timeout-minutes: 25',
    );
    expect(rendered.files['.github/workflows/aiws-hooks.yml']).toContain(
      'timeout-minutes: 35',
    );
  });
});

describe('managed-file ownership', () => {
  it('is idempotent and preserves user-edited config formatting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-template-test-'));
    temporaryDirectories.push(directory);
    const config = buildDefaultRepoConfig('owner/repo');
    const rendered = await renderRepository(config, assetsRoot, '0.1.0');
    await writeRenderedRepository(directory, rendered);

    const configPath = join(directory, '.aiworkspace', 'config.json');
    const customFormatting = JSON.stringify(config);
    await writeFile(configPath, customFormatting, 'utf8');
    const plan = await writeRenderedRepository(directory, rendered);

    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(await readFile(configPath, 'utf8')).toBe(customFormatting);
  });

  it('explicitly carries a locally edited config into an isolated PR worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-template-test-'));
    temporaryDirectories.push(directory);
    const original = buildDefaultRepoConfig('owner/repo');
    await writeRenderedRepository(
      directory,
      await renderRepository(original, assetsRoot, '0.1.0'),
    );

    const edited = buildDefaultRepoConfig('owner/repo');
    edited.security.allowedActors = ['authenticated-viewer'];
    const rendered = await renderRepository(edited, assetsRoot, '0.1.0');
    const plan = await writeRenderedRepository(directory, rendered, { updateConfig: true });

    expect(plan.update).toContain('.aiworkspace/config.json');
    expect(JSON.parse(await readFile(join(directory, '.aiworkspace', 'config.json'), 'utf8'))).toEqual(edited);
  });

  it('refuses to overwrite a modified managed workflow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-template-test-'));
    temporaryDirectories.push(directory);
    const config = buildDefaultRepoConfig('owner/repo');
    const rendered = await renderRepository(config, assetsRoot, '0.1.0');
    await writeRenderedRepository(directory, rendered);

    const workflow = join(directory, '.github', 'workflows', 'aiws-agent-task.yml');
    await writeFile(workflow, '# user edit\n', 'utf8');
    await expect(writeRenderedRepository(directory, rendered)).rejects.toThrow(/modified locally/);
  });

  it('refuses to follow a managed-directory symbolic link outside the repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-template-test-'));
    const outside = await mkdtemp(join(tmpdir(), 'aiws-template-outside-'));
    temporaryDirectories.push(directory, outside);
    await symlink(outside, join(directory, '.aiworkspace'), process.platform === 'win32' ? 'junction' : 'dir');

    const rendered = await renderRepository(buildDefaultRepoConfig('owner/repo'), assetsRoot, '0.1.0');
    await expect(writeRenderedRepository(directory, rendered)).rejects.toThrow(/symbolic link/);
  });

  it.each([
    {
      name: 'an arbitrary repository path',
      mutate: (manifest: Record<string, unknown>) => {
        (manifest.files as unknown[]).push({ path: 'README.md', sha256: '0'.repeat(64) });
      },
      error: /not a recognized AIWS-managed workflow/,
    },
    {
      name: 'an invalid content hash',
      mutate: (manifest: Record<string, unknown>) => {
        (manifest.files as Array<Record<string, unknown>>)[0]!.sha256 = 'not-a-hash';
      },
      error: /sha256 must be a SHA-256 hash/,
    },
    {
      name: 'a duplicate workflow path',
      mutate: (manifest: Record<string, unknown>) => {
        (manifest.files as unknown[]).push({
          ...(manifest.files as Array<Record<string, unknown>>)[0],
        });
      },
      error: /path duplicates/,
    },
  ])('rejects a manifest containing $name', async ({ mutate, error }) => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-template-test-'));
    temporaryDirectories.push(directory);
    const rendered = await renderRepository(buildDefaultRepoConfig('owner/repo'), assetsRoot, '0.1.0');
    await writeRenderedRepository(directory, rendered);

    const manifestPath = join(directory, '.aiworkspace', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    mutate(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await expect(planManagedRemoval(directory)).rejects.toThrow(error);
  });
});
