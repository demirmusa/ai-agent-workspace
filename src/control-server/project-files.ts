import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { IMAGE_CONTENT_TYPES } from '../shared/core/media-types.js';
import { isPathInside, toPosixPath } from '../shared/core/paths.js';
import { ControlError } from './types.js';

export interface ProjectFileEntry { name: string; path: string; absolutePath: string; type: 'directory' | 'file'; ignored?: boolean }
export interface ProjectFileMatch { name: string; path: string; absolutePath: string; type: 'directory' | 'file' }
/**
 * A file for the editor. `version` identifies the bytes on disk; `image` (a picture as a data URL) or `unavailable` replaces `content`
 * for files the editor does not open as text.
 */
export interface ProjectFileContent { path: string; absolutePath: string; size: number; limit: number; version: string; content?: string; image?: string; unavailable?: 'large' | 'binary' }

// Mirrors VS Code's default files.exclude, so the tree reads like the Explorer view.
const hidden = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db']);
// Generated and dependency folders are not searched when Git cannot list the files.
const skippedInSearch = new Set([...hidden, 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.venv', '__pycache__', 'bin', 'obj']);
const maxEntries = 5000, maxSearchFiles = 50_000, cacheMs = 10_000;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function run(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      // check-ignore exits 1 when no path is ignored; the output is still valid.
      if (error && !(typeof error.code === 'number' && error.code === 1 && stdout !== undefined)) fail(error); else done(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
/** Resolve a project-relative path; neither `..` nor a symbolic link may leave the project folder. */
export async function resolveProjectPath(repositoryPath: string, value: unknown): Promise<{ root: string; absolute: string; path: string }> {
  if (value !== undefined && value !== null && typeof value !== 'string' || typeof value === 'string' && (value.length > 4096 || value.includes('\0'))) throw new ControlError('Select a valid project path.');
  let root: string;
  try { root = await realpath(repositoryPath); } catch { throw new ControlError('Project folder is unavailable.', 404); }
  const raw = String(value ?? '').replace(/\\/g, '/').trim();
  const requested = isAbsolute(raw) ? raw : raw.replace(/^\/+|\/+$/g, '');
  if (requested.split('/').includes('..')) throw new ControlError('Select a path inside the project folder.', 403);
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  let real: string;
  try { real = await realpath(absolute); } catch { throw new ControlError('Selected project path is unavailable.', 404); }
  if (!isPathInside(root, absolute) || !isPathInside(root, real)) throw new ControlError('Select a path inside the project folder.', 403);
  return { root, absolute, path: toPosixPath(relative(root, absolute)) };
}

async function ignoredNames(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try { return new Set((await run('git', ['-C', root, 'check-ignore', '--stdin', '-z'], paths.join('\0') + '\0')).split('\0').filter(Boolean)); }
  catch { return new Set(); }
}
/** One directory level, folders first, like the VS Code Explorer. Git-ignored entries are flagged, not hidden. */
export async function listProjectFiles(repositoryPath: string, value?: unknown): Promise<{ path: string; root: string; items: ProjectFileEntry[]; truncated: boolean }> {
  const { root, absolute, path } = await resolveProjectPath(repositoryPath, value);
  if (!(await stat(absolute)).isDirectory()) throw new ControlError('Selected project path is not a folder.');
  const items: ProjectFileEntry[] = []; let truncated = false;
  try {
    for await (const entry of await opendir(absolute)) {
      if (hidden.has(entry.name)) continue;
      if (items.length >= maxEntries) { truncated = true; break; }
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) { try { const target = await realpath(join(absolute, entry.name)); directory = isPathInside(root, target) && (await stat(target)).isDirectory(); } catch { directory = false; } }
      const relativePath = path ? `${path}/${entry.name}` : entry.name;
      items.push({ name: entry.name, path: relativePath, absolutePath: join(absolute, entry.name), type: directory ? 'directory' : 'file' });
    }
  } catch { throw new ControlError('Selected project folder cannot be listed.', 403); }
  const ignored = await ignoredNames(root, items.map((item) => item.type === 'directory' ? `${item.path}/` : item.path));
  for (const item of items) if (ignored.has(item.path) || ignored.has(`${item.path}/`)) item.ignored = true;
  items.sort((a, b) => a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'directory' ? -1 : 1);
  return { path, root, items, truncated };
}

// Short-lived: consecutive keystrokes of one search share a listing; expired listings are dropped, not kept per project.
const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();
async function walk(root: string): Promise<string[]> {
  const files: string[] = []; const pending = [''];
  while (pending.length && files.length < maxSearchFiles) {
    const current = pending.pop()!;
    try {
      for await (const entry of await opendir(join(root, current))) {
        if (skippedInSearch.has(entry.name)) continue;
        const path = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) pending.push(path); else if (entry.isFile()) files.push(path);
      }
    } catch { /* Unreadable folders are skipped. */ }
  }
  return files;
}
/** Every searchable path; folders end with "/" and are derived from the files below them. */
function withFolders(paths: string[]): string[] {
  const entries = new Set<string>();
  for (const path of paths) {
    // Git lists a nested repository it does not track as a single "folder/" entry.
    const parts = path.replace(/\/+$/, '').split('/');
    for (let depth = 1; depth < parts.length; depth++) entries.add(`${parts.slice(0, depth).join('/')}/`);
    entries.add(path.endsWith('/') ? `${parts.join('/')}/` : path);
  }
  return [...entries];
}
async function projectFileList(root: string): Promise<string[]> {
  const cached = fileCache.get(root);
  if (cached && Date.now() - cached.at < cacheMs) return cached.files;
  for (const [key, entry] of fileCache) if (Date.now() - entry.at >= cacheMs) fileCache.delete(key);
  const files = run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .then((output) => [...new Set(output.split('\0').filter(Boolean))].slice(0, maxSearchFiles), () => walk(root)).then(withFolders);
  fileCache.set(root, { at: Date.now(), files });
  files.catch(() => fileCache.delete(root));
  return files;
}
/** VS Code Quick Open style: contiguous name matches rank first, then path matches, then subsequences. */
function score(path: string, query: string): number {
  const lower = path.toLocaleLowerCase().replace(/\/$/, ''); const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (!query) return 1;
  if (name === query) return 1000;
  if (name.startsWith(query)) return 900 - name.length;
  if (name.includes(query)) return 800 - name.indexOf(query);
  if (lower.includes(query)) return 600 - lower.indexOf(query) / 10;
  let position = -1, gaps = 0;
  for (const character of query) {
    const next = lower.indexOf(character, position + 1);
    if (next < 0) return 0;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 400 - gaps);
}
export async function searchProjectFiles(repositoryPath: string, query: unknown, limit: unknown = 50): Promise<{ items: ProjectFileMatch[]; total: number }> {
  if (query !== undefined && typeof query !== 'string' || typeof query === 'string' && query.length > 512) throw new ControlError('Enter a valid file search.');
  const count = Number(limit ?? 50);
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new ControlError('Invalid file search limit.');
  const { root } = await resolveProjectPath(repositoryPath, '');
  const needle = String(query ?? '').trim().replace(/\\/g, '/').toLocaleLowerCase().replace(/\s+/g, '');
  const ranked = (await projectFileList(root)).map((path) => ({ path, score: score(path, needle) })).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || collator.compare(a.path, b.path));
  return { total: ranked.length, items: ranked.slice(0, count).map(({ path: entry }) => {
    const directory = entry.endsWith('/'), path = directory ? entry.slice(0, -1) : entry;
    return { path, name: path.slice(path.lastIndexOf('/') + 1), absolutePath: join(root, ...path.split('/')), type: directory ? 'directory' as const : 'file' as const };
  }) };
}

/** Starts a program and forgets it. */
function detached(executable: string, args: string[], options: { verbatim?: boolean } = {}): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: options.verbatim });
    child.once('error', () => fail(new ControlError('The file could not be opened on this computer.', 500)));
    child.once('spawn', () => { child.unref(); done(); });
  });
}
/** Opens a file with the operating system's default program, or reveals it in the file manager. */
export async function openProjectPath(repositoryPath: string, input: unknown): Promise<{ ok: true }> {
  const value = input as { path?: unknown; action?: unknown } | null;
  if (!value || typeof value !== 'object' || !['open', 'reveal'].includes(String(value.action))) throw new ControlError('Choose open or reveal.');
  const { absolute } = await resolveProjectPath(repositoryPath, value.path);
  return openAbsolutePath(absolute, value.action);
}

/** The caller vouches for the path: nothing here limits it to a project folder. */
export async function openAbsolutePath(absolute: string, action: unknown): Promise<{ ok: true }> {
  if (action !== 'open' && action !== 'reveal') throw new ControlError('Choose open or reveal.');
  let directory: boolean;
  try { directory = (await stat(absolute)).isDirectory(); } catch { throw new ControlError('Selected project path is unavailable.', 404); }
  if (action === 'open' && directory) throw new ControlError('Folders can only be revealed in the file manager.');
  if (process.platform === 'win32') {
    // explorer.exe parses its own command line; a Windows path cannot contain a quote.
    if (action === 'reveal') await detached('explorer.exe', [`/select,"${absolute}"`], { verbatim: true });
    // The shell opens it as a double click would: the default program, or its "Open with" dialog when none is associated.
    else await detached('explorer.exe', [`"${absolute}"`], { verbatim: true });
  } else if (process.platform === 'darwin') await detached('open', action === 'reveal' ? ['-R', absolute] : [absolute]);
  else await detached('xdg-open', [action === 'reveal' ? dirname(absolute) : absolute]);
  return { ok: true };
}

/** Opens a folder itself in the file manager (unlike `reveal`, which selects it inside its parent). */
export async function openDirectory(absolute: string): Promise<{ ok: true }> {
  if (!(await stat(absolute)).isDirectory()) throw new ControlError('Folder not found.', 404);
  if (process.platform === 'win32') await detached('explorer.exe', [`"${absolute}"`], { verbatim: true });
  else await detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [absolute]);
  return { ok: true };
}

/** Largest file the editor opens or saves. */
export const EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
/** Largest picture the editor previews. */
export const PREVIEW_IMAGE_BYTES = 16 * 1024 * 1024;
/** The content type of a picture the editor shows instead of its bytes; SVG is text and opens in the editor. */
function previewImageType(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return extension === '.svg' ? undefined : IMAGE_CONTENT_TYPES[extension];
}
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const fileVersion = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** UTF-8 text without its byte order mark, or undefined for anything else (binary data, other encodings). */
function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return undefined; }
}
/** The real location of an existing regular file inside the project folder; a symbolic link is followed only when it stays inside. */
async function projectFile(repositoryPath: string, value: unknown): Promise<{ absolute: string; real: string; path: string }> {
  const { absolute, path } = await resolveProjectPath(repositoryPath, value);
  const real = await realpath(absolute);
  if (!(await stat(real)).isFile()) throw new ControlError('Selected project path is not a file.');
  return { absolute, real, path };
}
/** A file's text for the editor. Files over the size limit and files that are not UTF-8 text come back without content. */
export async function readProjectFile(repositoryPath: string, value: unknown): Promise<ProjectFileContent> {
  const { absolute, real, path } = await projectFile(repositoryPath, value);
  const file = await open(real, 'r').catch(() => { throw new ControlError('The file cannot be read.', 403); });
  try {
    const size = (await file.stat()).size, base = { path, absolutePath: absolute, size, limit: EDITABLE_FILE_BYTES };
    const imageType = previewImageType(path);
    if (imageType) {
      if (size > PREVIEW_IMAGE_BYTES) return { ...base, limit: PREVIEW_IMAGE_BYTES, version: '', unavailable: 'large' };
      const bytes = await file.readFile();
      return { ...base, limit: PREVIEW_IMAGE_BYTES, version: fileVersion(bytes), image: `data:${imageType};base64,${bytes.toString('base64')}` };
    }
    if (size > EDITABLE_FILE_BYTES) return { ...base, version: '', unavailable: 'large' };
    const bytes = await file.readFile(), content = decodeText(bytes);
    return content === undefined ? { ...base, version: '', unavailable: 'binary' } : { ...base, version: fileVersion(bytes), content };
  } finally { await file.close(); }
}
/**
 * Saves the editor's text over an existing file. `version` is the one the editor read: when the file on disk no longer
 * matches it (an agent or another program wrote it meanwhile) nothing is written and the request fails with 409, unless
 * `overwrite` says the user chose to replace it. A byte order mark on disk is kept.
 */
export async function writeProjectFile(repositoryPath: string, input: unknown): Promise<ProjectFileContent> {
  const value = input as { path?: unknown; content?: unknown; version?: unknown; overwrite?: unknown } | null;
  if (!value || typeof value !== 'object' || typeof value.content !== 'string') throw new ControlError('File content is required.');
  if (value.overwrite !== true && (typeof value.version !== 'string' || !value.version)) throw new ControlError('The opened file version is required.');
  if (!value.path || typeof value.path !== 'string') throw new ControlError('Select a valid project path.');
  const text = Buffer.from(value.content, 'utf8');
  if (text.length > EDITABLE_FILE_BYTES || text.includes(0)) throw new ControlError('The file is too large or not text.', 413);
  const { absolute, real, path } = await projectFile(repositoryPath, value.path);
  // One handle reads the current bytes and writes the new ones, so the compared file is the written file.
  const file = await open(real, 'r+').catch(() => { throw new ControlError('The file cannot be written.', 403); });
  try {
    if ((await file.stat()).size > EDITABLE_FILE_BYTES) throw new ControlError('The file changed on disk since it was opened.', 409);
    const current = await file.readFile();
    if (value.overwrite !== true && fileVersion(current) !== value.version) throw new ControlError('The file changed on disk since it was opened.', 409);
    const bytes = current.subarray(0, 3).equals(BOM) ? Buffer.concat([BOM, text]) : text;
    await file.truncate(0); await file.write(bytes, 0, bytes.length, 0);
    return { path, absolutePath: absolute, size: bytes.length, limit: EDITABLE_FILE_BYTES, version: fileVersion(bytes), content: value.content };
  } finally { await file.close(); }
}
/**
 * Creates an empty file: `name` (with its extension) inside the project folder `folder`. Missing folders on the way are not created,
 * and an existing file is never replaced (409).
 */
export async function createProjectFile(repositoryPath: string, input: unknown): Promise<ProjectFileEntry> {
  const value = input as { folder?: unknown; name?: unknown } | null;
  const name = typeof value?.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 255 || name === '.' || name === '..' || /[\\/\0<>:"|?*]/.test(name) || basename(name) !== name) throw new ControlError('Enter a valid file name.');
  const { root, absolute: folder, path: folderPath } = await resolveProjectPath(repositoryPath, value?.folder ?? '');
  if (!(await stat(folder).catch(() => null))?.isDirectory()) throw new ControlError('Selected project path is not a folder.');
  const absolute = join(folder, name), path = folderPath ? `${folderPath}/${name}` : name;
  if (!isPathInside(root, absolute)) throw new ControlError('Select a path inside the project folder.', 403);
  const file = await open(absolute, 'wx').catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EEXIST' ? new ControlError('A file or folder with this name already exists.', 409) : new ControlError('The file cannot be created.', 403);
  });
  await file.close();
  fileCache.delete(root);
  return { name, path, absolutePath: absolute, type: 'file' };
}
