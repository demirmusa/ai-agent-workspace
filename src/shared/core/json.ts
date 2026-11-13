import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface AtomicJsonWriteOptions {
  mode?: number;
  spaces?: number;
}

export class JsonFileError extends Error {
  readonly filePath: string;
  override readonly cause?: unknown;

  constructor(message: string, filePath: string, cause?: unknown) {
    super(`${message}: ${filePath}`, cause === undefined ? undefined : { cause });
    this.name = 'JsonFileError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new JsonFileError('Could not read JSON file', filePath, error);
  }

  try {
    const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    return JSON.parse(withoutBom) as T;
  } catch (error) {
    throw new JsonFileError('File contains invalid JSON', filePath, error);
  }
}

/** Parsed JSON text, or null when it is not valid JSON (one line of a JSONL log, a provider event). */
export function parseJsonOrNull(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Write JSON through an fsynced sibling temporary file and atomically rename it
 * into place. A failed write never leaves a partially-written destination.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const directory = dirname(filePath);
  const mode = options.mode ?? 0o600;
  const spaces = options.spaces ?? 2;
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let contents: string;
  try {
    const serialized = JSON.stringify(value, null, spaces);
    if (serialized === undefined) throw new TypeError('Value is not JSON serializable.');
    contents = `${serialized}\n`;
  } catch (error) {
    throw new JsonFileError('Could not serialize JSON file', filePath, error);
  }

  await mkdir(directory, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new JsonFileError('Could not atomically write JSON file', filePath, error);
  }
}
