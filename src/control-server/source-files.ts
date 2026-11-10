import { constants } from 'node:fs';
import { open, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonOrNull } from '../shared/core/json.js';
import { isPathInside, pathKey } from '../shared/core/paths.js';

/** Reading provider-owned files (session transcripts, subagent metadata, skill files) without following links. */

/** A provider session ID (Codex thread, Claude Code session). */
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Opens a file read-only; a symbolic link as the last path segment is refused where the platform supports it. */
export const openReadOnly = (path: string): Promise<FileHandle> => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
/** An ISO timestamp of a parsable date string, or undefined. */
export const isoTimestamp = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
/** JSON object of one JSONL line, or null for anything else. */
export function jsonRow(line: string): any | null { const value: unknown = parseJsonOrNull(line); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
/** The JSON object lines of a text; `partialFirst` drops the first line, which a read from the middle of a file cuts. */
export function jsonRows(text: string, partialFirst = false): any[] { return text.split('\n').slice(partialFirst ? 1 : 0).map(jsonRow).filter(Boolean); }

/** Up to `length` bytes of an open file from `start`. */
export async function readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length)); if (!buffer.length) return buffer;
  const { bytesRead } = await file.read(buffer, 0, buffer.length, start); return buffer.subarray(0, bytesRead);
}
/** The first and/or last `bytes` of a file as JSON rows; a tail read drops its cut first line. */
export async function readJsonWindow(path: string, bytes: number, from: 'head' | 'tail'): Promise<any[]> {
  const file = await openReadOnly(path);
  try {
    const size = (await file.stat()).size, length = Math.min(size, bytes), start = from === 'tail' ? size - length : 0;
    return jsonRows((await readRange(file, start, length)).toString('utf8'), start > 0);
  } finally { await file.close(); }
}
/** At most `bytes` of a text file, so an oversized file is never read whole. */
export async function readTextHead(path: string, bytes: number): Promise<string> {
  const file = await openReadOnly(path);
  try { return (await readRange(file, 0, bytes)).toString('utf8'); } finally { await file.close(); }
}

/** A regular file inside `root` whose path and every parent up to `root` are real folders, not links. */
export async function isUnlinkedFile(path: string, root: string): Promise<boolean> {
  try {
    if (!isPathInside(root, path) || pathKey(await realpath(path)) !== pathKey(path) || !(await lstat(path)).isFile()) return false;
    for (let current = path; isPathInside(root, current); current = dirname(current)) { if ((await lstat(current)).isSymbolicLink()) return false; if (current === root || dirname(current) === current) break; }
    return true;
  } catch { return false; }
}
