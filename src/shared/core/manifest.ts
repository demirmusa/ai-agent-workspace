import { canonicalJson, sha256, sha256Json, type Hashable } from './hash.js';

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface ManifestFile {
  path: string;
  sha256: string;
  executable?: boolean;
}

export interface ManagedFileManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  generatorVersion: string;
  configHash: string;
  files: ManifestFile[];
}

export type ManifestContentMap = Readonly<Record<string, Hashable>>;

export interface CreateManifestOptions {
  generatorVersion: string;
  config: unknown;
  executablePaths?: readonly string[];
}

export function hashManagedContent(content: Hashable): string {
  return sha256(content);
}

export function createManifestFile(
  path: string,
  content: Hashable,
  executable = false,
): ManifestFile {
  return executable
    ? { path: normalizeManifestPath(path), sha256: hashManagedContent(content), executable: true }
    : { path: normalizeManifestPath(path), sha256: hashManagedContent(content) };
}

export function createManagedManifest(
  contents: ManifestContentMap,
  options: CreateManifestOptions,
): ManagedFileManifest {
  const executable = new Set((options.executablePaths ?? []).map(normalizeManifestPath));
  const filesByPath = new Map<string, ManifestFile>();
  for (const [path, content] of Object.entries(contents)) {
    const normalized = normalizeManifestPath(path);
    if (filesByPath.has(normalized)) {
      throw new TypeError(`Multiple managed files normalize to the same path: ${normalized}`);
    }
    filesByPath.set(normalized, createManifestFile(normalized, content, executable.has(normalized)));
  }
  const files = [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatorVersion: options.generatorVersion,
    configHash: sha256Json(options.config),
    files,
  };
}

/** Hash the full canonical manifest. File ordering does not affect this digest. */
export function hashManifest(manifest: ManagedFileManifest): string {
  return sha256(canonicalJson(normalizeManifest(manifest)));
}

export function manifestFileMatches(entry: ManifestFile, content: Hashable): boolean {
  return entry.sha256.toLowerCase() === hashManagedContent(content);
}

export function findManifestFile(
  manifest: ManagedFileManifest,
  path: string,
): ManifestFile | undefined {
  const normalized = normalizeManifestPath(path);
  return manifest.files.find((file) => file.path === normalized);
}

export function changedManifestPaths(
  previous: ManagedFileManifest | undefined,
  next: ManagedFileManifest,
): string[] {
  if (previous === undefined) return next.files.map((file) => file.path);

  const oldFiles = new Map(previous.files.map((file) => [file.path, file]));
  const nextFiles = new Map(next.files.map((file) => [file.path, file]));
  const paths = new Set([...oldFiles.keys(), ...nextFiles.keys()]);
  return [...paths]
    .filter((path) => {
      const oldFile = oldFiles.get(path);
      const nextFile = nextFiles.get(path);
      return (
        oldFile === undefined ||
        nextFile === undefined ||
        oldFile.sha256 !== nextFile.sha256 ||
        Boolean(oldFile.executable) !== Boolean(nextFile.executable)
      );
    })
    .sort((left, right) => left.localeCompare(right));
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Validates a manifest read from a repository. Only `allowedPaths` may be listed, so a hand-edited manifest can
 * never make AIWS treat (and later overwrite or delete) an arbitrary repository file as generated.
 */
export function parseManagedManifest(value: unknown, allowedPaths: ReadonlySet<string>): ManagedFileManifest {
  const isRecord = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error('unsupported schema');
  if (typeof value.generatorVersion !== 'string' || value.generatorVersion.length === 0) {
    throw new Error('generatorVersion must be a non-empty string');
  }
  if (typeof value.configHash !== 'string' || !SHA256_PATTERN.test(value.configHash)) {
    throw new Error('configHash must be a SHA-256 hash');
  }
  if (!Array.isArray(value.files)) throw new Error('files must be an array');

  const seen = new Set<string>();
  const files: ManifestFile[] = value.files.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`files[${index}] must be an object`);
    if (typeof entry.path !== 'string' || !allowedPaths.has(entry.path)) {
      throw new Error(`files[${index}].path is not a recognized AIWS-managed workflow`);
    }
    const normalizedPath = entry.path.toLowerCase();
    if (seen.has(normalizedPath)) throw new Error(`files[${index}].path duplicates ${entry.path}`);
    seen.add(normalizedPath);
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`files[${index}].sha256 must be a SHA-256 hash`);
    }
    if (entry.executable !== undefined && typeof entry.executable !== 'boolean') {
      throw new Error(`files[${index}].executable must be a boolean`);
    }
    return entry.executable === undefined
      ? { path: entry.path, sha256: entry.sha256 }
      : { path: entry.path, sha256: entry.sha256, executable: entry.executable };
  });

  return { schemaVersion: MANIFEST_SCHEMA_VERSION, generatorVersion: value.generatorVersion, configHash: value.configHash, files };
}

function normalizeManifest(manifest: ManagedFileManifest): ManagedFileManifest {
  return {
    ...manifest,
    files: [...manifest.files]
      .map((file) => ({ ...file, path: normalizeManifestPath(file.path) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function normalizeManifestPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`Manifest path must be repository-relative: ${path}`);
  }
  return normalized;
}
