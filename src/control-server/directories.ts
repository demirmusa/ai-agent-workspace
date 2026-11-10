import { opendir, realpath, lstat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isPathInside } from '../shared/core/paths.js';
import { ControlError } from './types.js';

export async function browseDirectories(projectPaths: string[], query: { path?: unknown; cursor?: unknown; limit?: unknown } = {}): Promise<{ roots: Array<{ name: string; path: string }>; path: string | null; parent: string | null; items: Array<{ name: string; path: string }>; nextCursor: string | null }> {
  const configured = process.env.AIWS_CONTROL_BROWSE_ROOTS?.split(delimiter).filter(Boolean);
  const candidates = configured?.length ? configured : [homedir(), dirname(process.cwd()), ...projectPaths];
  const roots: Array<{ name: string; path: string }> = [];
  for (const candidate of candidates.slice(0, 64)) {
    try { const path = await realpath(candidate); if ((await lstat(candidate)).isSymbolicLink() || !(await lstat(path)).isDirectory()) continue; if (!roots.some((root) => root.path === path)) roots.push({ name: basename(path) || path, path }); } catch { /* Unavailable configured roots are omitted. */ }
  }
  if (query.path === undefined || query.path === null || query.path === '') return { roots, path: null, parent: null, items: [], nextCursor: null };
  if (typeof query.path !== 'string' || query.path.length > 4096 || query.path.includes('\0') || !isAbsolute(query.path)) throw new ControlError('Select a valid absolute server directory.');
  const count = query.limit === undefined ? 50 : Number(query.limit); const rawCursor = query.cursor ?? '0';
  if (!Number.isInteger(count) || count < 1 || count > 100 || typeof rawCursor !== 'string' || !/^\d{1,8}$/.test(rawCursor)) throw new ControlError('Invalid directory pagination.');
  let path: string; try { path = await realpath(query.path); } catch { throw new ControlError('Selected server folder is unavailable.', 404); }
  const root = roots.find((item) => isPathInside(item.path, path)); if (!root) throw new ControlError('Select a folder within a listed root. Configure AIWS_CONTROL_BROWSE_ROOTS to expose additional server folders.', 403);
  if (resolve(query.path) !== path) throw new ControlError('Symbolic-link folder navigation is not supported.', 403);
  const items: Array<{ name: string; path: string }> = []; let handle;
  try {
    handle = await opendir(path); let visited = 0;
    for await (const entry of handle) { if (++visited > 10000) throw new ControlError('Folder has too many entries. Choose a smaller configured browse root.', 413); if (entry.isDirectory() && !entry.isSymbolicLink()) items.push({ name: entry.name, path: resolve(path, entry.name) }); }
  } catch (error) { if (error instanceof ControlError) throw error; throw new ControlError('Selected server folder cannot be listed.', 403); }
  items.sort((a, b) => a.name.localeCompare(b.name)); const offset = Number(rawCursor); const parent = dirname(path);
  return { roots, path, parent: parent !== path && isPathInside(root.path, parent) ? parent : null, items: items.slice(offset, offset + count), nextCursor: offset + count < items.length ? String(offset + count) : null };
}
