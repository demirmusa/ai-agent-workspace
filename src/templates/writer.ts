import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  findManifestFile,
  manifestFileMatches,
  parseManagedManifest,
  type ManagedFileManifest,
} from '../shared/core/manifest.js';
import { AiwsError } from '../shared/core/logger.js';
import type { RenderedRepository } from './repository.js';

export interface FilePlan {
  create: string[];
  update: string[];
  remove: string[];
  unchanged: string[];
}

const CONFIG_PATH = '.aiworkspace/config.json';
const MANIFEST_PATH = '.aiworkspace/manifest.json';
const MANAGED_WORKFLOW_PATHS = new Set([
  '.github/workflows/aiws-agent-task.yml',
  '.github/workflows/aiws-pr-agent.yml',
  '.github/workflows/aiws-agent-queue.yml',
  '.github/workflows/aiws-agent-organize.yml',
  '.github/workflows/aiws-pr-review.yml',
  '.github/workflows/aiws-hooks.yml',
]);

export async function planRepositoryWrite(
  root: string,
  rendered: RenderedRepository,
  force = false,
  updateConfig = false,
): Promise<{ plan: FilePlan; previous?: ManagedFileManifest }> {
  const previous = await readManifestIfPresent(root);
  const plan: FilePlan = { create: [], update: [], remove: [], unchanged: [] };
  const nextPaths = new Set(Object.keys(rendered.files));

  for (const [relativePath, desired] of Object.entries(rendered.files)) {
    const absolute = await ownedPath(root, relativePath);
    const current = await readIfPresent(absolute);
    if (current === undefined) {
      plan.create.push(relativePath);
      continue;
    }
    if (current === desired) {
      plan.unchanged.push(relativePath);
      continue;
    }
    if (relativePath === CONFIG_PATH && !updateConfig) {
      // Tracked configuration is user-owned after init; sync validates and
      // fingerprints it but never normalizes or overwrites its formatting.
      plan.unchanged.push(relativePath);
      continue;
    }
    if (relativePath === CONFIG_PATH) {
      // A PR sync starts from the remote default branch. In that isolated
      // worktree the explicitly requested config update must travel with the
      // workflows rendered from it. Config remains user-owned and is never
      // subject to the generated-file ownership checks below.
      plan.update.push(relativePath);
      continue;
    }
    const previousEntry = previous ? findManifestFile(previous, relativePath) : undefined;
    if (relativePath !== MANIFEST_PATH && !force) {
      if (!previousEntry) {
        throw new AiwsError(
          `Refusing to overwrite unmanaged file: ${relativePath}`,
          2,
          'Move the file, choose different commands, or rerun with --force after reviewing it.',
        );
      }
      if (!manifestFileMatches(previousEntry, current)) {
        throw new AiwsError(
          `Generated file was modified locally: ${relativePath}`,
          2,
          'Preserve your changes elsewhere or rerun sync with --force.',
        );
      }
    }
    plan.update.push(relativePath);
  }

  for (const entry of previous?.files ?? []) {
    if (nextPaths.has(entry.path)) continue;
    const current = await readIfPresent(await ownedPath(root, entry.path));
    if (current === undefined) continue;
    if (!force && !manifestFileMatches(entry, current)) {
      throw new AiwsError(
        `Generated file was modified locally and cannot be removed: ${entry.path}`,
        2,
        'Preserve your changes elsewhere or rerun with --force.',
      );
    }
    plan.remove.push(entry.path);
  }
  return { plan: sortPlan(plan), ...(previous ? { previous } : {}) };
}

export async function writeRenderedRepository(
  root: string,
  rendered: RenderedRepository,
  options: { force?: boolean; dryRun?: boolean; updateConfig?: boolean } = {},
): Promise<FilePlan> {
  const { plan } = await planRepositoryWrite(
    root,
    rendered,
    options.force,
    options.updateConfig,
  );
  if (options.dryRun) return plan;

  for (const path of plan.remove) await unlink(await ownedPath(root, path));
  const manifestPath = MANIFEST_PATH;
  for (const path of [...plan.create, ...plan.update]) {
    if (path === manifestPath) continue;
    await writeTextAtomic(await ownedPath(root, path), rendered.files[path] ?? '');
  }
  if (plan.create.includes(manifestPath) || plan.update.includes(manifestPath)) {
    await writeTextAtomic(await ownedPath(root, manifestPath), rendered.files[manifestPath] ?? '');
  }
  return plan;
}

export async function planManagedRemoval(
  root: string,
  force = false,
): Promise<{ manifest?: ManagedFileManifest; files: string[] }> {
  const manifest = await readManifestIfPresent(root);
  if (!manifest) return { files: [] };
  const files: string[] = [];
  for (const entry of manifest.files) {
    const current = await readIfPresent(await ownedPath(root, entry.path));
    if (current === undefined) continue;
    if (!force && !manifestFileMatches(entry, current)) {
      throw new AiwsError(
        `Refusing to remove modified generated file: ${entry.path}`,
        2,
        'Use --force only after reviewing and preserving the file.',
      );
    }
    files.push(entry.path);
  }
  if (await readIfPresent(await ownedPath(root, MANIFEST_PATH))) files.push(MANIFEST_PATH);
  if (await readIfPresent(await ownedPath(root, CONFIG_PATH))) files.push(CONFIG_PATH);
  return { manifest, files: [...new Set(files)].sort() };
}

export async function removeManagedFiles(root: string, force = false, dryRun = false): Promise<string[]> {
  const { files } = await planManagedRemoval(root, force);
  if (!dryRun) {
    // The manifest is deleted last so an interrupted removal remains recoverable.
    const ordered = [...files].sort((left, right) =>
      left === MANIFEST_PATH ? 1 : right === MANIFEST_PATH ? -1 : 0,
    );
    for (const path of ordered) {
      try {
        await unlink(await ownedPath(root, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return files;
}

async function readManifestIfPresent(root: string): Promise<ManagedFileManifest | undefined> {
  const source = await readIfPresent(await ownedPath(root, MANIFEST_PATH));
  if (source === undefined) return undefined;
  try {
    return parseManagedManifest(JSON.parse(source) as unknown, MANAGED_WORKFLOW_PATHS);
  } catch (error) {
    throw new AiwsError(`Invalid managed-file manifest: ${(error as Error).message}`);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeTextAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `.aiws-${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  await rename(temporary, path);
}

async function ownedPath(root: string, relativePath: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new AiwsError(`Managed path escapes the repository: ${relativePath}`);
  }
  let current = resolvedRoot;
  const components = relative(resolvedRoot, candidate).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = resolve(current, components[index]!);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new AiwsError(`Managed path contains a symbolic link: ${relativePath}`);
      }
      if (index < components.length - 1 && !metadata.isDirectory()) {
        throw new AiwsError(`Managed path parent is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return candidate;
}

function sortPlan(plan: FilePlan): FilePlan {
  return Object.fromEntries(
    Object.entries(plan).map(([key, values]) => [key, [...values].sort()]),
  ) as unknown as FilePlan;
}
