import {
  installationStatePath,
  repositoryConfigPath,
  type AiwsPathOptions,
} from '../core/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../core/json.js';
import type { RepoConfig } from './schema.js';
import type { InstallationState } from './installation-schema.js';
import { parseInstallationState, parseRepoConfig } from './validation.js';

export async function loadRepoConfig(repositoryRoot: string): Promise<RepoConfig> {
  return loadRepoConfigFile(repositoryConfigPath(repositoryRoot));
}

export async function loadRepoConfigFile(filePath: string): Promise<RepoConfig> {
  return parseRepoConfig(await readJsonFile(filePath));
}

export async function saveRepoConfig(repositoryRoot: string, config: RepoConfig): Promise<void> {
  return saveRepoConfigFile(repositoryConfigPath(repositoryRoot), config);
}

export async function saveRepoConfigFile(filePath: string, config: RepoConfig): Promise<void> {
  await writeJsonFileAtomic(filePath, parseRepoConfig(config), { mode: 0o644 });
}

export async function loadInstallationState(
  repositorySlug: string,
  options: AiwsPathOptions = {},
): Promise<InstallationState> {
  return loadInstallationStateFile(installationStatePath(repositorySlug, options));
}

export async function loadInstallationStateFile(filePath: string): Promise<InstallationState> {
  return parseInstallationState(await readJsonFile(filePath));
}

export async function saveInstallationState(
  state: InstallationState,
  options: AiwsPathOptions = {},
): Promise<void> {
  return saveInstallationStateFile(installationStatePath(state.repository.slug, options), state);
}

export async function saveInstallationStateFile(
  filePath: string,
  state: InstallationState,
): Promise<void> {
  await writeJsonFileAtomic(filePath, parseInstallationState(state), { mode: 0o600 });
}

