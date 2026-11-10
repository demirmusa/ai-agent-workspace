import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isPathInside } from '../../shared/core/paths.js';
import { ControlError } from '../types.js';

/** Serves the control UI, its vendor libraries and plugin files with validators, so a reload costs only 304 replies. */
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const VENDOR: Record<string, string> = { '/vendor/easymde.js': 'easymde/dist/easymde.min.js', '/vendor/easymde.css': 'easymde/dist/easymde.min.css', '/vendor/purify.js': 'dompurify/dist/purify.min.js', '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js' };
/** Monaco loads its own modules, workers and stylesheet by name, so its whole browser build (the package's `min` folder) is served under one prefix. */
const MONACO = { prefix: '/vendor/monaco/', entry: 'monaco-editor' };
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.md', '.txt', '.svg']);
const CACHE_LIMITS = { entries: 512, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, compressMin: 1024 };
const gzipAsync = promisify(gzip);

/** `bytes` reserves room for the gzip copy made on first compressed request. */
interface CachedAsset { tag: string; body: Buffer; gzip?: Buffer; bytes: number }

export class StaticAssets {
  private readonly cache = new Map<string, CachedAsset>();
  private cachedBytes = 0;
  private readonly vendor = new Map<string, string>();
  private readonly require = createRequire(import.meta.url);

  /** `pluginAsset` maps an installed plugin's id and relative path to its file. */
  constructor(private readonly root: string, private readonly pluginAsset: (id: string, path: string) => Promise<string>) {}

  private async file(path: string): Promise<string> {
    const vendor = VENDOR[path];
    if (vendor) { let file = this.vendor.get(path); if (!file) { file = this.require.resolve(vendor); this.vendor.set(path, file); } return file; }
    if (path.startsWith(MONACO.prefix)) {
      let root = this.vendor.get(MONACO.prefix); if (!root) { root = resolve(dirname(this.require.resolve(MONACO.entry)), '..'); this.vendor.set(MONACO.prefix, root); }
      const file = resolve(root, path.slice(MONACO.prefix.length));
      if (!isPathInside(root, file)) throw new ControlError('Invalid asset path.', 403);
      return file;
    }
    // Plugin files: /plugins/<id>/<version stamp>/<path>; the stamp only changes the URL so updated modules are not served from cache.
    const plugin = /^\/plugins\/([^/]+)\/[^/]+\/(.+)$/.exec(path);
    if (plugin) return this.pluginAsset(plugin[1]!, plugin[2]!);
    const file = resolve(this.root, path === '/' ? 'index.html' : path.slice(1));
    if (!isPathInside(this.root, file)) throw new ControlError('Invalid asset path.', 403);
    return file;
  }

  /**
   * Files are revalidated (`no-cache`), so edited UI files show on the next load; unchanged ones answer 304. The page itself
   * names every local script, stylesheet and icon with a `?v=` stamp of its size and modification time, and a stamped URL
   * is cached for good: a reload reads them from the browser cache instead of waiting for hundreds of 304s.
   */
  async serve(request: IncomingMessage, response: ServerResponse, path: string, versioned = false): Promise<void> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') throw new ControlError('Method not allowed.', 405);
    const file = await this.file(path);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new ControlError('UI asset not found. Build/install the control center assets.', 404);
    const page = path === '/' || path === '/index.html', pageBody = page ? await this.stampedPage(file) : undefined;
    const extension = extname(file).toLowerCase(), size = pageBody?.length ?? info.size;
    const compress = COMPRESSIBLE.has(extension) && size >= CACHE_LIMITS.compressMin && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
    // The page follows the files it stamps, so only its content validates it.
    const version = pageBody ? `p${createHash('sha1').update(pageBody).digest('base64url').slice(0, 16)}` : `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}`;
    const tag = `W/"${version}${compress ? '-gz' : ''}"`;
    const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream', 'Cache-Control': versioned && !page ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: tag,
      ...(page ? {} : { 'Last-Modified': info.mtime.toUTCString() }), ...(COMPRESSIBLE.has(extension) ? { Vary: 'Accept-Encoding' } : {}) };
    if (fresh(request, tag, page ? Number.NaN : info.mtimeMs)) { response.writeHead(304, headers); response.end(); return; }
    const asset: CachedAsset = pageBody ? { tag, body: pageBody, bytes: pageBody.length } : await this.load(file, tag.replace(/-gz"$/, '"'), info.size);
    let body = asset.body;
    if (compress) { asset.gzip ??= await gzipAsync(asset.body); body = asset.gzip; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = String(body.length);
    response.writeHead(200, headers); response.end(method === 'HEAD' ? undefined : body);
  }

  /** The page with a `?v=<size>-<mtime>` stamp on every local script, stylesheet and icon it names. */
  private async stampedPage(file: string): Promise<Buffer> {
    const html = (await readFile(file)).toString('utf8'), pattern = /\b(src|href)="(\/(?!\/)[^"?#]+\.(?:js|css|svg))"/g;
    const urls = [...new Set([...html.matchAll(pattern)].map((match) => match[2]!))];
    const stamps = new Map(await Promise.all(urls.map(async (url): Promise<[string, string]> => {
      const info = await this.file(url).then((path) => stat(path)).catch(() => undefined);
      return [url, info?.isFile() ? `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}` : ''];
    })));
    return Buffer.from(html.replace(pattern, (all, attribute: string, url: string) => stamps.get(url) ? `${attribute}="${url}?v=${stamps.get(url)}"` : all));
  }

  /** File contents, kept in a small LRU cache keyed by the file's size and modification time. */
  private async load(file: string, tag: string, size: number): Promise<CachedAsset> {
    const cached = this.cache.get(file);
    if (cached?.tag === tag) { this.cache.delete(file); this.cache.set(file, cached); return cached; }
    if (cached) this.forget(file, cached);
    let body: Buffer;
    try { body = await readFile(file); } catch { throw new ControlError('UI asset not found. Build/install the control center assets.', 404); }
    const asset: CachedAsset = { tag, body, bytes: body.length * 2 };
    if (size > CACHE_LIMITS.fileBytes) return asset;
    this.cache.set(file, asset); this.cachedBytes += asset.bytes;
    for (const [key, entry] of this.cache) { if (this.cache.size <= CACHE_LIMITS.entries && this.cachedBytes <= CACHE_LIMITS.bytes) break; this.forget(key, entry); }
    return asset;
  }
  private forget(file: string, entry: CachedAsset): void { this.cache.delete(file); this.cachedBytes -= entry.bytes; }
}

/** True when the browser's copy is current: a matching ETag, or (without one) a Last-Modified that is not older. */
function fresh(request: IncomingMessage, tag: string, modifiedMs: number): boolean {
  const match = request.headers['if-none-match'];
  if (match) return match.split(',').some((value) => value.trim() === tag || value.trim() === '*');
  const since = Date.parse(String(request.headers['if-modified-since'] ?? ''));
  return Number.isFinite(since) && Math.floor(modifiedMs / 1000) * 1000 <= since;
}
