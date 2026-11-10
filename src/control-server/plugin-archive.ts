import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { PLUGIN_LIMITS, fail, pluginRelativePath, readManifest, type PluginManifest } from './plugin-manifest.js';

/** Plugin packages: ZIP archives in and out, and the checked file list of a plugin folder. */
/** Reads a ZIP archive (stored or deflated entries) into path → content. Symbolic links and encrypted entries are refused. */
export function readZipArchive(data: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset--) if (data.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  if (end < 0) fail('The file is not a ZIP archive.');
  const count = data.readUInt16LE(end + 10), directoryOffset = data.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) fail('ZIP64 archives are not supported.');
  if (count > PLUGIN_LIMITS.files) fail(`A plugin may contain at most ${PLUGIN_LIMITS.files} files.`);
  const files = new Map<string, Buffer>(); let offset = directoryOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) fail('The ZIP central directory is damaged.');
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10), compressed = data.readUInt32LE(offset + 20), size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32), attributes = data.readUInt32LE(offset + 38), local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (flags & 1) fail('Encrypted ZIP entries are not supported.');
    if (((attributes >>> 16) & 0o170000) === 0o120000) fail(`ZIP entry ${name} is a symbolic link.`);
    const path = pluginRelativePath(name, 'ZIP entry');
    if (size > PLUGIN_LIMITS.fileBytes) fail(`${path} is larger than ${PLUGIN_LIMITS.fileBytes / 1024 / 1024} MiB.`);
    total += size; if (total > PLUGIN_LIMITS.totalBytes) fail(`A plugin may hold at most ${PLUGIN_LIMITS.totalBytes / 1024 / 1024} MiB.`);
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) fail('A ZIP entry header is damaged.');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28), raw = data.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) fail(`ZIP entry ${path} uses an unsupported compression method.`);
    let content: Buffer;
    // The declared size caps inflation, so a ZIP bomb stops at the per-file limit.
    try { content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }); } catch { return fail(`ZIP entry ${path} is damaged.`); }
    if (content.length !== size) fail(`ZIP entry ${path} is damaged.`);
    files.set(path, content);
  }
  // Zipping a folder puts everything under that folder's name; such a single top folder is the plugin root.
  if (files.has('plugin.json')) return files;
  const roots = new Set([...files.keys()].map((path) => path.split('/')[0]));
  const root = roots.size === 1 ? [...roots][0] : undefined;
  if (!root || !files.has(`${root}/plugin.json`)) fail('The archive must contain plugin.json at its root or in one top-level folder.');
  return new Map([...files].map(([path, content]) => [path.slice(root!.length + 1), content]));
}

/** Writes files as a ZIP archive with deflated entries; readZipArchive reads it back. */
export function writeZipArchive(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, content] of files) {
    const name = Buffer.from(path, 'utf8'), data = deflateRawSync(content), checksum = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
/** Validates a plugin folder and packs it as a ZIP that the Plugins page or `aiws control plugins install` accepts. */
export function packPluginFolder(directory: string): { manifest: PluginManifest; archive: Buffer; files: number } {
  const root = resolve(directory), manifest = readManifest(root), paths = walkFolder(root);
  return { manifest, archive: writeZipArchive(new Map(paths.map((path) => [path, readFileSync(join(root, ...path.split('/')))]))), files: paths.length };
}
/** The files of a plugin folder; symbolic links and oversized folders are refused. */
export function walkFolder(root: string): string[] {
  const files: string[] = []; let total = 0;
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name, absolute = join(root, path), info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`Plugins cannot contain symbolic links: ${path}`);
      if (info.isDirectory()) { if (entry.name !== '.git') visit(path); continue; }
      if (!info.isFile()) continue;
      if (info.size > PLUGIN_LIMITS.fileBytes) fail(`${path} is larger than ${PLUGIN_LIMITS.fileBytes / 1024 / 1024} MiB.`);
      total += info.size; files.push(path);
      if (files.length > PLUGIN_LIMITS.files || total > PLUGIN_LIMITS.totalBytes) fail(`A plugin may hold at most ${PLUGIN_LIMITS.files} files and ${PLUGIN_LIMITS.totalBytes / 1024 / 1024} MiB.`);
    }
  };
  visit(''); return files;
}
