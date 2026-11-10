import { localRepositoryStateDirectory } from '../core/paths.js';
import {
  deterministicResourceNames,
  repositoryStateKey,
  stableRunnerLabels,
} from '../core/names.js';
import { CONFIG_SCHEMA_VERSION, RepoConfigSchema, type QueueProject, type RepoConfig } from './schema.js';
import {
  INSTALLATION_SCHEMA_VERSION,
  InstallationStateSchema,
  type InstallationState,
  type SshTarget,
} from './installation-schema.js';

export interface DefaultRepoConfigOptions {
  repository?: string;
  slug?: string;
  defaultBranch?: string;
  queueMode?: 'label' | 'project' | 'both';
  project?: Omit<QueueProject, 'organization'> & { organization?: string };
  projectOwnerType?: 'user' | 'organization';
}

export interface DefaultInstallationStateOptions {
  target?: 'local' | 'ssh';
  ssh?: SshTarget;
  runnerName?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function buildDefaultRepoConfig(repository: string): RepoConfig;
export function buildDefaultRepoConfig(options: DefaultRepoConfigOptions): RepoConfig;
export function buildDefaultRepoConfig(
  repositoryOrOptions: string | DefaultRepoConfigOptions,
): RepoConfig {
  const options =
    typeof repositoryOrOptions === 'string'
      ? { repository: repositoryOrOptions }
      : repositoryOrOptions;
  const repository = options.repository ?? options.slug;
  if (repository === undefined) {
    throw new TypeError('A repository slug is required to build the default configuration.');
  }
  const owner = repository.trim().split('/')[0] ?? '';
  const mode = options.queueMode ?? 'label';

  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    repository: {
      slug: repository,
      defaultBranch: options.defaultBranch ?? 'main',
    },
    security: {
      allowedActors: [owner],
      allowPublicRepository: false,
      protectedPaths: ['.github/workflows/**', '.aiworkspace/**'],
    },
    runner: {
      labels: stableRunnerLabels(repository),
    },
    agents: {
      defaultProfile: 'claude',
      profiles: [
        {
          id: 'claude',
          provider: 'claude',
          model: null,
          effort: 'high',
          triggerLabel: 'agent:claude',
        },
        {
          id: 'codex',
          provider: 'codex',
          model: null,
          effort: 'high',
          triggerLabel: 'agent:codex',
        },
      ],
    },
    queue: {
      mode,
      labels: {
        ready: 'agent:go',
        running: 'agent:running',
        done: 'agent:done',
        failed: 'agent:failed',
        continue: 'agent:continue',
      },
      ...(options.project === undefined ? {} : { project: options.project }),
      pollSeconds: 60,
    },
    commands: {
      issue: '/agent',
      pr: '/aiws',
      test: '/test',
    },
    brief: {
      instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
      extra: '',
      maxIssueComments: 100,
      maxPullRequestComments: 100,
      maxCharacters: 120_000,
    },
    hooks: {
      custom: [],
    },
    agent: {
      resources: {
        cpus: 2,
        memory: '4g',
        pids: 512,
      },
      network: 'bridge',
      timeouts: {
        issueMinutes: 90,
        prMinutes: 90,
        hookMinutes: 30,
        startupSeconds: 120,
        shutdownSeconds: 30,
      },
    },
  };

  if ((mode === 'project' || mode === 'both') && config.queue.project === undefined) {
    config.queue.project = {
      owner,
      ownerType: options.projectOwnerType ?? 'user',
      number: 1,
      statusField: 'Status',
      ready: 'Ready',
      inProgress: 'In progress',
      inReview: 'In review',
      done: 'Done',
      organization: 'Organization',
    };
  }

  return RepoConfigSchema.parse(config);
}

export function buildDefaultInstallationState(
  repository: string | Pick<RepoConfig, 'repository'>,
  options: DefaultInstallationStateOptions = {},
): InstallationState {
  const repositorySlug = typeof repository === 'string' ? repository : repository.repository.slug;
  const target = options.target ?? 'local';
  const names = deterministicResourceNames(repositorySlug);
  const stateDir =
    options.stateDir ??
    (target === 'local'
      ? localRepositoryStateDirectory(repositorySlug, {
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        })
      : defaultSshStateDirectory(repositorySlug, options.ssh));

  return InstallationStateSchema.parse({
    schemaVersion: INSTALLATION_SCHEMA_VERSION,
    repository: { slug: repositorySlug },
    target,
    ...(target === 'ssh' && options.ssh !== undefined ? { ssh: options.ssh } : {}),
    names,
    runnerName: options.runnerName ?? names.containers.runner,
    stateDir,
    createdLabels: [],
    managedSecrets: [],
    initPr: null,
  });
}

/** Default AIWS state directory of a repository on an SSH Docker host: under the SSH user's home. */
export function defaultSshStateDirectory(repositorySlug: string, ssh: Pick<SshTarget, 'user'> | undefined): string {
  if (ssh === undefined) {
    throw new TypeError('SSH settings are required when the installation target is ssh.');
  }
  const home = ssh.user === 'root' ? '/root' : `/home/${ssh.user}`;
  return `${home}/.aiws/repositories/${repositoryStateKey(repositorySlug)}`;
}
