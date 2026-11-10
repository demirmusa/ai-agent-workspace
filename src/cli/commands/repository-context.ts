import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoConfig } from '../../shared/config/schema.js';
import type { InstallationState } from '../../shared/config/installation-schema.js';
import { loadInstallationState, loadRepoConfig } from '../../shared/config/store.js';
import { GitRepository, type GitRepositoryInfo } from '../../shared/git/repository.js';
import { localRepositoryStateDirectory } from '../../shared/core/paths.js';
import { AiwsError } from '../../shared/core/logger.js';
import type { AppContext } from './context.js';

export interface LoadedRepository {
  git: GitRepository;
  info: GitRepositoryInfo;
  config: RepoConfig;
  installation: InstallationState;
  localRuntimeDirectory: string;
  targetRuntimeDirectory: string;
}

export interface LoadedTrackedRepository {
  git: GitRepository;
  info: GitRepositoryInfo;
  config: RepoConfig;
}

export async function loadTrackedRepository(context: AppContext): Promise<LoadedTrackedRepository> {
  const git = new GitRepository(context.runner, context.cwd);
  const info = await git.inspect();
  const config = await loadRepoConfig(info.root);
  if (config.repository.slug.toLowerCase() !== info.remote.slug.toLowerCase()) {
    throw new AiwsError(
      `Config targets ${config.repository.slug}, but origin is ${info.remote.slug}.`,
      2,
    );
  }
  return { git, info, config };
}

export async function loadRepository(context: AppContext): Promise<LoadedRepository> {
  const tracked = await loadTrackedRepository(context);
  const { git, info, config } = tracked;
  const installation = await loadInstallationState(config.repository.slug);
  const localRuntimeDirectory = join(localRepositoryStateDirectory(config.repository.slug), 'runtime');
  const targetRuntimeDirectory =
    installation.target === 'local'
      ? localRuntimeDirectory
      : `${installation.stateDir.replace(/\/$/, '')}/runtime`;
  return { git, info, config, installation, localRuntimeDirectory, targetRuntimeDirectory };
}

/** True when a materialized runtime (its compose.yaml) exists in the directory. */
export async function runtimeExists(path: string): Promise<boolean> {
  try {
    await access(join(path, 'compose.yaml'));
    return true;
  } catch {
    return false;
  }
}
