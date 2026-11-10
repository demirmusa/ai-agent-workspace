import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repositoryStateKey } from './names.js';

export const REPOSITORY_CONFIG_DIRECTORY = '.aiworkspace';
export const REPOSITORY_CONFIG_FILENAME = 'config.json';
export const REPOSITORY_MANIFEST_FILENAME = 'manifest.json';
export const INSTALLATION_STATE_FILENAME = 'installation.json';

export interface AiwsPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** True when `candidate` is `root` itself or lies beneath it; both should already be resolved. */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** A relative path written with forward slashes, as the UI and Git show it. */
export const toPosixPath = (path: string): string => path.split(sep).join('/');

/** Comparison key of a file-system path: Windows paths are case-insensitive. */
export const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;

export function repositoryConfigDirectory(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), REPOSITORY_CONFIG_DIRECTORY);
}

export function repositoryConfigPath(repositoryRoot: string): string {
  return join(repositoryConfigDirectory(repositoryRoot), REPOSITORY_CONFIG_FILENAME);
}

export function repositoryManifestPath(repositoryRoot: string): string {
  return join(repositoryConfigDirectory(repositoryRoot), REPOSITORY_MANIFEST_FILENAME);
}

/** The control service's data directory (database, settings, logs); `AIWS_CONTROL_DATA_DIR` overrides it. */
export function defaultControlDataDir(): string { return resolve(process.env.AIWS_CONTROL_DATA_DIR ?? join(homedir(), '.aiws', 'control')); }

export function aiwsHomePath(options: AiwsPathOptions = {}): string {
  const configured = (options.env ?? process.env).AIWS_HOME;
  const baseHome = options.homeDir ?? homedir();
  if (configured === undefined || configured.trim() === '') {
    return join(baseHome, '.aiws');
  }
  return isAbsolute(configured) ? resolve(configured) : resolve(baseHome, configured);
}

export function localRepositoryStateDirectory(
  repositorySlug: string,
  options: AiwsPathOptions = {},
): string {
  return join(aiwsHomePath(options), 'repositories', repositoryStateKey(repositorySlug));
}

export function installationStatePath(repositorySlug: string, options: AiwsPathOptions = {}): string {
  return join(localRepositoryStateDirectory(repositorySlug, options), INSTALLATION_STATE_FILENAME);
}
