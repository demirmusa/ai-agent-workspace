import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlError } from './types.js';
import { ghAuthToken } from './github-api.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Uploaded files have no product limit; this ceiling only keeps one request from exhausting the server's memory. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;
/** The JSON request body of an upload: base64 grows the file by a third, plus room for the other fields. */
export const MAX_ATTACHMENT_BODY = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024;
const validId = /^[a-f0-9]{64}\.[a-z0-9]{1,16}$/;
const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Images are recognised by content; any other file keeps a sanitized extension from its name. */
function extension(data: Buffer, name?: string): string {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return /\.([A-Za-z0-9]{1,16})$/.exec(name ?? '')?.[1]?.toLowerCase() ?? 'bin';
}
/** Project images live in the repository's own `.aiws` work folder, which ignores itself in Git. */
export const PROJECT_ATTACHMENTS = join('.aiws', 'attachments');
export interface ImageStore { exists(id: string): Promise<boolean>; read(id: string): Promise<{ data: Buffer; type: string }> }
export class Attachments implements ImageStore {
  private checkedToken = false;
  constructor(private directory: string, private token?: string, private request: typeof fetch = fetch, private repositories: () => string[] = () => []) {}
  async save(data: Buffer, repositoryPath?: string, name?: string): Promise<{ id: string; url: string; path: string }> {
    if (!data.length) throw new ControlError('File must not be empty.', 400);
    if (data.length > MAX_ATTACHMENT_BYTES) throw new ControlError(`File exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB.`, 413);
    const id = `${createHash('sha256').update(data).digest('hex')}.${extension(data, name)}`;
    const target = repositoryPath ? join(repositoryPath, PROJECT_ATTACHMENTS) : join(this.directory, 'attachments');
    await mkdir(target, { recursive: true });
    if (repositoryPath) await writeFile(join(repositoryPath, '.aiws', '.gitignore'), '# AIWS work folder; never committed.\n*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(join(target, id), data, { mode: 0o600 });
    return { id, url: `/api/attachments/${id}`, path: join(target, id) };
  }
  /** Content-addressed IDs make every copy identical, so the first location found wins. */
  private async locate(id: string): Promise<string> {
    if (!validId.test(id)) throw new ControlError('Invalid attachment ID.');
    for (const directory of [join(this.directory, 'attachments'), ...this.repositories().map(path => join(path, PROJECT_ATTACHMENTS))]) {
      try { await access(join(directory, id)); return join(directory, id); } catch { /* Try the next location. */ }
    }
    throw new ControlError('Attachment not found.', 404);
  }
  async exists(id: string): Promise<boolean> {
    try { await this.locate(id); return true; } catch { return false; }
  }
  async read(id: string): Promise<{ data: Buffer; type: string }> {
    const path = await this.locate(id);
    try { return { data: await readFile(path), type: mime[id.split('.').at(-1)!] ?? 'application/octet-stream' }; }
    catch { throw new ControlError('Attachment not found.', 404); }
  }
  async upload(input: unknown, repositoryPath?: string): Promise<{ id: string; url: string; path: string }> {
    const { data, name } = (input ?? {}) as { data?: unknown; name?: unknown };
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) throw new ControlError('File data must be base64.');
    return this.save(Buffer.from(data, 'base64'), repositoryPath, typeof name === 'string' ? name : undefined);
  }
  async download(source: string): Promise<{ id: string; url: string }> {
    let url = new URL(source);
    const signal = AbortSignal.timeout(20_000);
    for (let redirects = 0; redirects < 5; redirects++) {
      if (!allowedImageUrl(url)) throw new ControlError('Unsupported GitHub image URL.');
      if (url.hostname === 'github.com' && !this.token && !this.checkedToken) {
        this.checkedToken = true;
        // Public images remain downloadable without GitHub authentication.
        this.token = await ghAuthToken(3000);
      }
      const response = await this.request(url, { redirect: 'manual', signal, headers: {
        'user-agent': 'aiws-control', ...(url.hostname === 'github.com' && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { await response.body?.cancel(); url = new URL(response.headers.get('location')!, url); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new ControlError(`GitHub image download failed (${response.status}).`); }
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new ControlError('GitHub image exceeds 10 MiB.'); }
      const chunks: Buffer[] = []; let size = 0;
      if (!response.body) throw new ControlError('Empty GitHub image response.');
      const reader = response.body.getReader();
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_IMAGE_BYTES) throw new ControlError('GitHub image exceeds 10 MiB.'); chunks.push(Buffer.from(next.value)); } }
      finally { await reader.cancel(); }
      return this.save(Buffer.concat(chunks));
    }
    throw new ControlError('Too many GitHub image redirects.');
  }
  async materialize(description: string, inputDirectory: string, docker: boolean): Promise<string> {
    const sources = imageSources(description);
    if (sources.length > 20) throw new ControlError('At most 20 images can be supplied to one run.');
    let text = description;
    for (const source of sources) {
      const local = /^\/api\/attachments\/([^/?#]+)$/.exec(source);
      const image = local ? { id: local[1]! } : await this.download(source);
      const path = await this.locate(image.id);
      await mkdir(join(inputDirectory, 'images'), { recursive: true });
      await copyFile(path, join(inputDirectory, 'images', image.id));
      // The read-only input mount may be opened by a different worker UID.
      await chmod(join(inputDirectory, 'images', image.id), 0o644);
      const localPath = docker ? '/run/aiws/input/images/' + image.id : join(inputDirectory, 'images', image.id);
      // Each image appears once, as its local path, in place of the markdown/HTML reference.
      for (const variant of new Set([source, source.replace(/&/g, '&amp;')])) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)|<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, 'g'), () => localPath).split(variant).join(localPath);
      }
    }
    return text;
  }
}
export function allowedImageUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
    ['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname)
    || (url.hostname === 'raw.githubusercontent.com' && /^\/[^/]+\/[^/]+\/aiws-attachments\/\.aiws\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(url.pathname))
    || (url.hostname === 'github.com' && /^\/(?:user-attachments\/assets\/|[^/]+\/[^/]+\/assets\/|[^/]+\/[^/]+\/(?:blob|raw)\/aiws-attachments\/\.aiws\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$)/.test(url.pathname)));
}
export function imageSources(description: string): string[] {
  const matches = description.match(/\/api\/attachments\/[a-f0-9]{64}\.[a-z0-9]{1,16}|https:\/\/[^\s<>"')]+/g) ?? [];
  return [...new Set(matches.map(value => value.replace(/&amp;/g, '&')).filter(value => {
    if (value.startsWith('/api/attachments/')) return true;
    try { return allowedImageUrl(new URL(value)); } catch { return false; }
  }))];
}
