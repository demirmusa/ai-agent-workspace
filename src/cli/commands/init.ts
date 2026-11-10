import { access } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultInstallationState,
  buildDefaultRepoConfig,
  InstallationStateSchema,
  loadInstallationState,
  RepoConfigSchema,
  saveInstallationState,
  type InstallationState,
} from '../../shared/config/index.js';
import { findAssetsRoot } from '../../shared/core/assets.js';
import { AiwsError } from '../../shared/core/logger.js';
import { installationStatePath } from '../../shared/core/paths.js';
import { GitRepository } from '../../shared/git/repository.js';
import { GitHubClient } from '../../shared/github/client.js';
import { saveInstallationCredentials } from '../../runtime/credential-store.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { renderRepository, type RenderedRepository } from '../../templates/repository.js';
import { writeRenderedRepository } from '../../templates/writer.js';
import type { AppContext } from './context.js';
import { printFilePlan } from './file-plan.js';
import { parsePositiveInteger, parseProviders, parsePullRequestNumber, requireGitBranchName, requireConfirmation, setupBranchName } from './input.js';
import { labelsForConfig } from './labels.js';

export interface InitOptions {
  queue: 'label' | 'project' | 'both';
  defaultProvider: 'claude' | 'codex';
  providers: string;
  allowedActor?: string[];
  projectOwner?: string;
  projectOwnerType: 'user' | 'organization';
  projectNumber?: string;
  target: 'local' | 'ssh';
  sshHost?: string;
  sshUser?: string;
  sshPort?: string;
  sshIdentity?: string;
  runnerName?: string;
  allowPublic: boolean;
  secrets: boolean;
  pr: boolean;
  branch?: string;
  yes: boolean;
  dryRun: boolean;
}

export async function runInit(context: AppContext, options: InitOptions): Promise<void> {
  const git = new GitRepository(context.runner, context.cwd);
  const info = await git.inspect();
  if (await pathExists(join(info.root, '.aiworkspace', 'config.json'))) {
    throw new AiwsError('This repository is already initialized.', 2, 'Use `aiws sync` to update it.');
  }

  const github = new GitHubClient(context.runner);
  const metadata = options.dryRun
    ? {
        slug: info.remote.slug,
        defaultBranch: await localDefaultBranch(context, info.root),
        visibility: 'private' as const,
        permissions: { admin: true, maintain: true, push: true, pull: true },
      }
    : await github.getRepository(info.remote.slug);

  if (!metadata.permissions.admin && !metadata.permissions.maintain && !metadata.permissions.push) {
    throw new AiwsError('Your GitHub account does not have write access to this repository.');
  }
  if (metadata.visibility === 'public' && !options.allowPublic) {
    throw new AiwsError(
      'Public repositories are refused by default because self-hosted runners execute repository work.',
      2,
      'Only on a dedicated disposable host, review the risk and rerun with --allow-public.',
    );
  }

  const providers = parseProviders(options.providers);
  if (!providers.includes(options.defaultProvider)) {
    throw new AiwsError('--default-provider must also be listed in --providers.');
  }
  const projectEnabled = options.queue === 'project' || options.queue === 'both';
  const projectNumber = projectEnabled
    ? parsePositiveInteger(options.projectNumber, '--project-number')
    : undefined;
  const config = buildDefaultRepoConfig({
    repository: metadata.slug,
    defaultBranch: metadata.defaultBranch,
    queueMode: options.queue,
    ...(projectEnabled
      ? {
          project: {
            owner: options.projectOwner ?? info.remote.owner,
            ownerType: options.projectOwnerType,
            number: projectNumber as number,
            statusField: 'Status',
            ready: 'Ready',
            organization: 'Organization',
            inProgress: 'In progress',
            inReview: 'In review',
            done: 'Done',
          },
        }
      : {}),
  });
  if (providers.includes('opencode') && !config.agents.profiles.some(({ provider }) => provider === 'opencode')) {
    config.agents.profiles.push({ id: 'opencode', provider: 'opencode', model: null, effort: 'medium', triggerLabel: 'agent:opencode' });
  }
  config.agents.profiles = config.agents.profiles.filter(({ provider }) => providers.includes(provider));
  config.agents.defaultProfile = options.defaultProvider;
  config.security.allowedActors = options.allowedActor?.length
    ? uniqueCaseInsensitive(options.allowedActor)
    : [await resolveDefaultActor(github, options.dryRun)];
  config.security.allowPublicRepository = metadata.visibility === 'public' && options.allowPublic;
  const validatedConfig = RepoConfigSchema.parse(config);

  const desiredInstallation = buildInstallation(validatedConfig, options);
  let installation = options.dryRun
    ? desiredInstallation
    : await reuseInstallationState(desiredInstallation);
  const assetsRoot = await findAssetsRoot();
  const rendered = await renderRepository(validatedConfig, assetsRoot, PACKAGE_VERSION);

  context.logger.warn(
    'Security boundary: trusted default-branch workflows can control Docker on the runner host. Use a dedicated host and trusted actors only.',
  );
  if (!options.dryRun) {
    await requireConfirmation(
      `Install AIWS for ${metadata.slug} with actors ${validatedConfig.security.allowedActors.join(', ')}?`,
      options.yes,
    );
  }

  if (options.dryRun) {
    const plan = await writeRenderedRepository(info.root, rendered, { dryRun: true });
    printFilePlan(context, plan);
    context.logger.info('Dry run complete; no files, GitHub resources, credentials, containers, or runner registrations were changed.');
    return;
  }

  // Persist the recovery information before the first remote mutation. An
  // interrupted init can therefore be retried without losing ownership data.
  const bootstrapToken = await github.resolveToken();
  const runnerToken = process.env.AIWS_RUNNER_TOKEN?.trim() || bootstrapToken;
  const projectToken = projectEnabled ? (process.env.AIWS_PROJECT_TOKEN?.trim() || bootstrapToken) : undefined;
  if (projectEnabled && !projectToken) {
    throw new AiwsError(
      'Project queue mode requires a dedicated AIWS_PROJECT_TOKEN.',
      2,
      'Set AIWS_PROJECT_TOKEN with the required Projects v2 scope and rerun `aiws init`.',
    );
  }
  const automationToken = process.env.AIWS_AUTOMATION_TOKEN?.trim() || bootstrapToken;
  await saveInstallationCredentials(metadata.slug, {
    automationToken,
    runnerToken,
    ...(projectToken ? { projectToken } : {}),
  });
  await saveInstallationState(installation);

  await github.ensureLabels(
    metadata.slug,
    labelsForConfig(validatedConfig),
    async (label) => {
      installation = InstallationStateSchema.parse({
        ...installation,
        createdLabels: uniqueCaseInsensitive([...installation.createdLabels, label]),
      });
      await saveInstallationState(installation);
    },
  );

  if (options.secrets) {
    installation = await installWorkflowSecrets(context, github, installation, [
      { name: 'AIWS_AUTOMATION_TOKEN', value: automationToken },
      ...(projectToken ? [{ name: 'AIWS_PROJECT_TOKEN', value: projectToken }] : []),
    ]);
  } else {
    context.logger.warn('Workflow secrets were skipped; GitHub_TOKEN fallback may not trigger downstream CI for agent-created PRs.');
  }

  const branch = options.branch
    ? requireGitBranchName(options.branch)
    : setupBranchName('init', PACKAGE_VERSION);
  let pullRequestUrl = installation.initPr?.url;
  let headSha: string | undefined;
  if (!options.pr) {
    const plan = await writeRenderedRepository(info.root, rendered);
    printFilePlan(context, plan);
    context.logger.success('Generated files were written to the current working tree.');
  } else if (installation.initPr) {
    context.logger.info(`Reusing existing setup pull request: ${installation.initPr.url}`);
  } else {
    ({ url: pullRequestUrl, headSha } = await openSetupPullRequest(context, git, github, info.root, metadata, branch, rendered));
  }

  const prNumber = pullRequestUrl ? parsePullRequestNumber(pullRequestUrl) : undefined;
  installation = InstallationStateSchema.parse({
    ...installation,
    initPr:
      installation.initPr ?? (pullRequestUrl && prNumber
        ? {
            number: prNumber,
            url: pullRequestUrl,
            headBranch: branch,
            baseBranch: metadata.defaultBranch,
            ...(headSha ? { headSha } : {}),
          }
        : null),
  });
  await saveInstallationState(installation);
  context.logger.success('Local installation state and permission-restricted runner credentials were prepared.');
  context.logger.info('No runner was started. Merge the setup PR (if used), then run `aiws up` when ready.');
}

/** Installs missing workflow secrets; existing ones are never overwritten. Each creation is recorded at once. */
async function installWorkflowSecrets(
  context: AppContext,
  github: GitHubClient,
  initial: InstallationState,
  desiredSecrets: ReadonlyArray<{ name: string; value: string }>,
): Promise<InstallationState> {
  let installation = initial;
  const slug = installation.repository.slug;
  const existingSecrets = await github.listSecretNames(slug);
  for (const secret of desiredSecrets) {
    if (existingSecrets.has(secret.name)) {
      if (!installation.managedSecrets.some((name) => name === secret.name)) {
        context.logger.warn(`Repository secret ${secret.name} already exists and was left unchanged.`);
      }
      continue;
    }
    await github.setSecret(slug, secret.name, secret.value);
    installation = InstallationStateSchema.parse({
      ...installation,
      managedSecrets: [...new Set([...installation.managedSecrets, secret.name])],
    });
    await saveInstallationState(installation);
    existingSecrets.add(secret.name);
  }
  return installation;
}

/** Commits the generated files on a fresh branch from the remote default branch and opens the setup PR. */
async function openSetupPullRequest(
  context: AppContext,
  git: GitRepository,
  github: GitHubClient,
  root: string,
  metadata: { slug: string; defaultBranch: string },
  branch: string,
  rendered: RenderedRepository,
): Promise<{ url: string; headSha?: string }> {
  let headSha: string | undefined;
  await git.fetchDefault(root, metadata.defaultBranch);
  await git.withTemporaryWorktree(root, `origin/${metadata.defaultBranch}`, async (worktree) => {
    const plan = await writeRenderedRepository(worktree, rendered);
    printFilePlan(context, plan);
    headSha = await git.createAndPushBranch(worktree, branch, `Install ai-agent-workspace v${PACKAGE_VERSION}`);
  });
  const url = await github.createPullRequest({
    slug: metadata.slug,
    base: metadata.defaultBranch,
    head: branch,
    title: `Install ai-agent-workspace v${PACKAGE_VERSION}`,
    body: [
      'Installs the repository-side workflows and configuration for the Docker-hosted AIWS runner.',
      '',
      'The runtime itself is not stored in this repository. After reviewing and merging this PR, run:',
      '',
      '```sh',
      'aiws up',
      'aiws login all',
      '```',
      '',
      '<!-- generated-by: ai-agent-workspace -->',
    ].join('\n'),
  });
  context.logger.success(`Setup pull request opened: ${url}`);
  return { url, ...(headSha ? { headSha } : {}) };
}

function buildInstallation(config: ReturnType<typeof RepoConfigSchema.parse>, options: InitOptions): InstallationState {
  if (options.target === 'local') {
    return buildDefaultInstallationState(config, {
      target: 'local',
      ...(options.runnerName === undefined ? {} : { runnerName: options.runnerName }),
    });
  }
  if (!options.sshHost) throw new AiwsError('--ssh-host is required when --target=ssh.');
  const sshUser = options.sshUser ?? safeLocalUsername();
  return buildDefaultInstallationState(config, {
    target: 'ssh',
    ...(options.runnerName === undefined ? {} : { runnerName: options.runnerName }),
    ssh: {
      host: options.sshHost,
      user: sshUser,
      port: parsePositiveInteger(options.sshPort, '--ssh-port', 22),
      ...(options.sshIdentity ? { identityFile: options.sshIdentity } : {}),
    },
  });
}

async function localDefaultBranch(context: AppContext, root: string): Promise<string> {
  try {
    const ref = (
      await context.runner.run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })
    ).stdout.trim();
    return ref.replace(/^origin\//, '') || 'main';
  } catch {
    return 'main';
  }
}

function safeLocalUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'runner';
  }
}

async function resolveDefaultActor(github: GitHubClient, dryRun: boolean): Promise<string> {
  if (dryRun) {
    const actor = process.env.GITHUB_ACTOR?.trim();
    if (actor) return actor;
    throw new AiwsError(
      'Dry-run mode cannot infer the authenticated GitHub viewer without calling GitHub.',
      2,
      'Pass --allowed-actor <login>, or set GITHUB_ACTOR for the dry run.',
    );
  }
  const viewer = (await github.getViewerLogin()).trim();
  if (!viewer) throw new AiwsError('GitHub returned an empty authenticated viewer login.');
  return viewer;
}

async function reuseInstallationState(desired: InstallationState): Promise<InstallationState> {
  if (!(await pathExists(installationStatePath(desired.repository.slug)))) return desired;
  const existing = await loadInstallationState(desired.repository.slug);
  const incompatible =
    existing.target !== desired.target ||
    existing.runnerName !== desired.runnerName ||
    existing.stateDir !== desired.stateDir ||
    JSON.stringify(existing.ssh ?? null) !== JSON.stringify(desired.ssh ?? null);
  if (incompatible) {
    throw new AiwsError(
      'An incomplete init state already exists with different target settings.',
      2,
      'Retry with the original target options, or inspect and remove this repository’s untracked state under AIWS_HOME.',
    );
  }
  return existing;
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
