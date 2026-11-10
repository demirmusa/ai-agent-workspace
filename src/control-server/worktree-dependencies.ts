import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isPathInside } from '../shared/core/paths.js';
import { gitQuery } from './git.js';
import { execCli } from './windows-launch.js';

/** Lockfiles whose installs are plain folders; pnpm and Yarn PnP layouts rely on links and are left to the agent. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'];

function trackedManifests(worktree: string): string[] {
  return gitQuery(worktree, ['ls-files', '-z', '--', 'package.json', '**/package.json'], 10_000).split('\0').filter(Boolean);
}
// Line endings depend on checkout settings, not on the resolved dependencies.
const contents = (path: string): string | undefined => { try { return readFileSync(path, 'utf8').replaceAll('\r\n', '\n'); } catch { return undefined; } };

/** The installed tree only fits the worktree when every lockfile matches the main checkout. */
function sameLockfiles(repository: string, worktree: string, folder: string): boolean {
  let found = false;
  for (const name of LOCKFILES) {
    const source = contents(join(repository, folder, name)); const target = contents(join(worktree, folder, name));
    if (source === undefined && target === undefined) continue;
    if (source === undefined || source !== target) return false;
    found = true;
  }
  return found;
}

/**
 * An empty or partial install (e.g. `--omit=dev`, or one emptied by an agent) would only make the agent unlink and
 * reinstall, so every regular and dev dependency of the worktree's manifest must be present in the main checkout.
 */
function missingPackages(repository: string, worktree: string, folder: string): string[] | undefined {
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { manifest = JSON.parse(contents(join(worktree, folder, 'package.json')) ?? ''); } catch { return undefined; }
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  return names.filter(name => !existsSync(join(repository, folder, 'node_modules', name, 'package.json')));
}

interface DependencyFolder {
  folder: string; /** Why the main checkout's install cannot be linked; empty when it can. */ skipped: string;
  /** The main checkout's npm install only lags behind its own lockfile, so `npm install` there makes it linkable. */ stale?: boolean;
}

/** Inspects every tracked package folder of the worktree that has no node_modules yet. */
function inspectDependencies(repository: string, worktree: string): DependencyFolder[] {
  if (resolve(repository) === resolve(worktree)) return [];
  const result: DependencyFolder[] = [];
  for (const manifest of trackedManifests(worktree)) {
    const folder = dirname(manifest) === '.' ? '' : dirname(manifest); const label = folder || '.';
    if (folder.split(/[\/]/).includes('node_modules') || !isPathInside(resolve(worktree), resolve(worktree, folder))) continue;
    try { lstatSync(join(worktree, folder, 'node_modules')); continue; } catch { /* Not installed yet. */ }
    let skipped = '';
    try { if (!lstatSync(join(repository, folder, 'node_modules')).isDirectory()) skipped = `${label}: the main checkout has no node_modules folder`; } catch { skipped = `${label}: the main checkout has no node_modules folder`; }
    if (!skipped && !sameLockfiles(repository, worktree, folder)) skipped = `${label}: the lockfile differs from the main checkout`;
    if (!skipped) {
      const missing = missingPackages(repository, worktree, folder);
      if (!missing) skipped = `${label}: package.json cannot be read`;
      else if (missing.length) skipped = `${label}: the main checkout's install lacks ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}; run npm install there`;
    }
    const stale = Boolean(skipped) && skipped.endsWith('run npm install there') && ['package-lock.json', 'npm-shrinkwrap.json'].some(name => existsSync(join(repository, folder, name)));
    result.push({ folder, skipped, ...(stale ? { stale } : {}) });
  }
  return result;
}

/**
 * New task worktrees only contain tracked files, so agents would reinstall dependencies on every task.
 * Lists the folders (relative to the worktree) whose missing node_modules the main checkout can supply.
 */
export function dependencySeedFolders(repository: string, worktree: string): string[] {
  return inspectDependencies(repository, worktree).filter(item => !item.skipped).map(item => item.folder);
}

/** Explains each folder that stays without node_modules because the main checkout's install does not fit. */
export function skippedDependencyReasons(repository: string, worktree: string): string[] {
  return inspectDependencies(repository, worktree).filter(item => item.skipped).map(item => item.skipped);
}

/** Whether a folder of the worktree waits for `npm install` in the main checkout before it can be linked. */
export function hasStaleMainInstall(repository: string, worktree: string): boolean {
  return inspectDependencies(repository, worktree).some(item => item.stale);
}

const refreshing = new Map<string, Promise<string | undefined>>();
/** One `npm install` per main checkout folder at a time; tasks starting together wait for the same install. */
function npmInstall(directory: string): Promise<string | undefined> {
  const key = resolve(directory).toLowerCase();
  let pending = refreshing.get(key);
  if (!pending) {
    const command = execCli(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--no-audit', '--no-fund'], { env: process.env, cwd: directory, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    pending = (command ?? Promise.resolve({ error: new Error('npm cannot be run safely here'), stdout: '', stderr: '' }))
      .then(({ error, stderr }) => error ? (stderr.trim().split(/\r?\n/).slice(-3).join(' ') || error.message) : undefined)
      .finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

/**
 * A main checkout whose install lags behind its lockfile (packages added to package.json but never installed there)
 * would make every task install on its own. Runs `npm install` in those main checkout folders so they can be linked.
 * Returns one line per folder: what was refreshed, or why the install failed.
 */
export async function refreshStaleMainInstalls(repository: string, worktree: string): Promise<string[]> {
  const stale = inspectDependencies(repository, worktree).filter(item => item.stale);
  return Promise.all(stale.map(async ({ folder }) => {
    const label = folder || '.'; const error = await npmInstall(join(repository, folder));
    return error ? `${label}: npm install in the main checkout failed: ${error}` : `${label}: ran npm install in the main checkout`;
  }));
}

/**
 * Links the main checkout's node_modules into the folders from dependencySeedFolders, so every task shares one
 * install without copying it. Worktree cleanup removes links before `git worktree remove`, which would otherwise
 * follow junctions into the main checkout. Never throws: a folder that cannot be linked is installed by the agent.
 */
export function linkWorktreeDependencies(repository: string, worktree: string, folders = dependencySeedFolders(repository, worktree)): string[] {
  const linked: string[] = [];
  for (const folder of folders) {
    const source = resolve(repository, folder, 'node_modules'); const target = join(worktree, folder, 'node_modules');
    // Junctions need no privileges on Windows but only take absolute targets; symlinks stay relative elsewhere.
    try { symlinkSync(process.platform === 'win32' ? source : relative(dirname(target), source), target, 'junction'); linked.push(join(folder, 'node_modules')); }
    catch { /* The agent installs this folder itself. */ }
  }
  return linked;
}
