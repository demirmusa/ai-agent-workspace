import { describe, expect, it } from 'vitest';
import {
  AgentEffortSchema,
  InstallationStateSchema,
  RepoConfigSchema,
  buildDefaultInstallationState,
  buildDefaultRepoConfig,
  parseRepoConfig,
} from '../config/index.js';

describe('repository configuration', () => {
  it('builds a schemaVersion 1 config with stable Claude and Codex profiles', () => {
    const first = buildDefaultRepoConfig({ repository: 'Example/Widget', defaultBranch: 'trunk' });
    const second = buildDefaultRepoConfig({ repository: 'example/widget', defaultBranch: 'trunk' });

    expect(RepoConfigSchema.parse(first)).toEqual(first);
    expect(first.schemaVersion).toBe(1);
    expect(first.repository.defaultBranch).toBe('trunk');
    expect(first.agents.profiles.map(({ provider }) => provider)).toEqual(['claude', 'codex']);
    expect(first.runner.labels).toEqual(second.runner.labels);
    expect(first.runner.labels.slice(0, 2)).toEqual(['self-hosted', 'linux']);
    expect(first.runner.labels).not.toContain('x64');
    expect(first.security.allowedActors).toEqual(['Example']);
  });

  it('adds usable Projects defaults when a project queue is selected', () => {
    const config = buildDefaultRepoConfig({ repository: 'owner/repo', queueMode: 'both' });

    expect(config.queue.project).toMatchObject({
      owner: 'owner',
      ownerType: 'user',
      statusField: 'Status',
      ready: 'Ready',
      inProgress: 'In progress',
      inReview: 'In review',
      done: 'Done',
    });
  });

  it('reports friendly, addressable validation paths', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.agents.profiles[1]!.id = config.agents.profiles[0]!.id;

    expect(() => parseRepoConfig(config)).toThrow(/agents\.profiles\[1\]\.id: duplicates profile id/);
  });

  it('validates effort values for each provider', () => {
    const claude = buildDefaultRepoConfig('owner/repo');
    claude.agents.profiles[0]!.effort = 'minimal';
    expect(() => parseRepoConfig(claude)).toThrow(
      /agents\.profiles\[0\]\.effort: must be low, medium, high, xhigh, or max for Claude/,
    );

    const codex = buildDefaultRepoConfig('owner/repo');
    codex.agents.profiles[1]!.effort = 'max';
    expect(() => parseRepoConfig(codex)).toThrow(
      /agents\.profiles\[1\]\.effort: must be minimal, low, medium, high, or xhigh for Codex/,
    );
  });

  it('accepts the provider-specific edge effort values', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.agents.profiles[0]!.effort = 'max';
    config.agents.profiles[1]!.effort = 'minimal';

    expect(RepoConfigSchema.safeParse(config).success).toBe(true);
    expect(AgentEffortSchema.safeParse('ultra').success).toBe(false);
  });

  it('keeps inner agent timeouts plus lifecycle overhead within GitHub job limits', () => {
    const boundary = buildDefaultRepoConfig('owner/repo');
    boundary.agent.timeouts = {
      issueMinutes: 352,
      prMinutes: 352,
      hookMinutes: 352,
      startupSeconds: 120,
      shutdownSeconds: 30,
    };
    expect(RepoConfigSchema.safeParse(boundary).success).toBe(true);

    boundary.agent.timeouts.issueMinutes = 353;
    const result = RepoConfigSchema.safeParse(boundary);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(({ path }) => path.join('.') === 'agent.timeouts.issueMinutes')).toBe(true);
    }
  });

  it('applies the GitHub job timeout limit to hook overrides', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.hooks.test = { run: 'npm test', timeoutMinutes: 353 };
    config.hooks.custom.push({ id: 'verify', command: '/verify', run: 'npm run verify', timeoutMinutes: 353 });

    const result = RepoConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(({ path }) => path.join('.'));
      expect(paths).toContain('hooks.test.timeoutMinutes');
      expect(paths).toContain('hooks.custom.0.timeoutMinutes');
    }
  });

  it('requires project settings for project-backed queues', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    const invalid = { ...config, queue: { ...config.queue, mode: 'project' as const } };

    expect(RepoConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires the repository-scoped runner labels', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.runner.labels = ['self-hosted', 'linux'];

    expect(RepoConfigSchema.safeParse(config).success).toBe(false);
  });

  it('does not allow removing mandatory control-plane protection', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.security.protectedPaths = ['src/generated/**'];

    expect(RepoConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects ambiguous queue and hook labels', () => {
    const config = buildDefaultRepoConfig('owner/repo');
    config.hooks.custom.push({
      id: 'verify',
      command: '/verify',
      label: config.queue.labels.ready,
      run: 'npm test',
    });

    expect(RepoConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('installation state', () => {
  it('builds deterministic untracked local state beneath AIWS_HOME', () => {
    const first = buildDefaultInstallationState('owner/repo', {
      env: { AIWS_HOME: 'D:\\agent-state' },
      homeDir: 'C:\\Users\\tester',
    });
    const second = buildDefaultInstallationState('OWNER/REPO', {
      env: { AIWS_HOME: 'D:\\agent-state' },
      homeDir: 'C:\\Users\\tester',
    });

    expect(InstallationStateSchema.parse(first)).toEqual(first);
    expect(first.schemaVersion).toBe(1);
    expect(first.names).toEqual(second.names);
    expect(first.runnerName).toBe(first.names.containers.runner);
    expect(first.createdLabels).toEqual([]);
    expect(first.managedSecrets).toEqual([]);
    expect(first.initPr).toBeNull();
  });

  it('requires SSH details only for SSH targets', () => {
    expect(() => buildDefaultInstallationState('owner/repo', { target: 'ssh' })).toThrow(
      /SSH settings are required/,
    );

    const state = buildDefaultInstallationState('owner/repo', {
      target: 'ssh',
      ssh: { host: 'server.example', user: 'runner', port: 22 },
    });
    expect(state.stateDir).toContain('/home/runner/.aiws/');
    expect(InstallationStateSchema.parse(state).target).toBe('ssh');
  });

  it('rejects traversal and ambiguous SSH state paths', () => {
    const state = buildDefaultInstallationState('owner/repo', {
      target: 'ssh',
      ssh: { host: 'server.example', user: 'runner', port: 22 },
    });
    for (const stateDir of ['/tmp/../runtime', '/tmp//runtime', '/tmp/runtime/']) {
      expect(InstallationStateSchema.safeParse({ ...state, stateDir }).success).toBe(false);
    }
  });
});
