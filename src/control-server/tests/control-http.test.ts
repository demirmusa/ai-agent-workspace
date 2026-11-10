import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { startControlServer, type RunningControlServer } from '../server.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function boot(token?: string): Promise<{ server: RunningControlServer; ui: string }> {
  const root = mkdtempSync(join(tmpdir(), 'aiws-http-')); roots.push(root);
  const ui = join(root, 'ui'); mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(ui, 'app.js'), `'use strict';\n${'console.log("aiws");\n'.repeat(200)}`);
  const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), staticDir: ui, ...(token ? { token } : {}) }); servers.push(server);
  return { server, ui };
}
/** A raw request, so Host and other forbidden fetch headers can be set. */
function raw(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end();
  });
}

describe('control HTTP server', () => {
  it('stamps the page\'s scripts so a reload reads them from cache, and restamps an edited one', async () => {
    const { server, ui } = await boot();
    writeFileSync(join(ui, 'index.html'), '<!doctype html><link rel="stylesheet" href="/missing.css"><script src="/app.js" defer></script><a href="https://example.com/x.js">x</a>');
    const first = await raw(`${server.url}/`, {}), html = first.body.toString(), stamped = /src="(\/app\.js\?v=[^"]+)"/.exec(html)?.[1];
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(stamped).toBeTruthy();
    expect(html).toContain('href="/missing.css"');
    expect(html).toContain('href="https://example.com/x.js"');
    const script = await raw(`${server.url}${stamped}`, {});
    expect(script.status).toBe(200);
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await raw(`${server.url}/`, { 'If-None-Match': String(first.headers.etag) })).status).toBe(304);
    writeFileSync(join(ui, 'app.js'), `'use strict';\n${'console.log("restamped");\n'.repeat(300)}`);
    const edited = await raw(`${server.url}/`, { 'If-None-Match': String(first.headers.etag) });
    expect(edited.status).toBe(200);
    expect(/src="(\/app\.js\?v=[^"]+)"/.exec(edited.body.toString())?.[1]).not.toBe(stamped);
  });
  it('revalidates UI files with ETags, answers 304 and compresses text for gzip clients', async () => {
    const { server, ui } = await boot();
    const first = await raw(`${server.url}/app.js`, { 'Accept-Encoding': 'gzip' });
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(first.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(first.body).toString()).toContain('console.log("aiws")');
    const etag = String(first.headers.etag);
    expect((await raw(`${server.url}/app.js`, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag })).status).toBe(304);
    const plain = await raw(`${server.url}/app.js`, {});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toContain('console.log("aiws")');
    // An edited file gets a new validator, so the next load sees the change.
    writeFileSync(join(ui, 'app.js'), `'use strict';\n${'console.log("edited");\n'.repeat(200)}`);
    const edited = await raw(`${server.url}/app.js`, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(edited.status).toBe(200);
    expect(gunzipSync(edited.body).toString()).toContain('edited');
    const page = await fetch(`${server.url}/`);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect((await fetch(`${server.url}/..%2f..%2fdata%2fcontrol.json`)).status).toBe(403);
    expect((await fetch(`${server.url}/%E0%A4%A`)).status).toBe(400);
  });

  it('serves the Monaco editor from its package, with a policy that lets its workers and icon font load', async () => {
    const { server } = await boot();
    const loader = await fetch(`${server.url}/vendor/monaco/vs/loader.js`);
    expect(loader.status).toBe(200); expect(loader.headers.get('content-type')).toContain('text/javascript'); expect(await loader.text()).toContain('define');
    expect((await fetch(`${server.url}/vendor/monaco/vs/editor/editor.main.css`)).headers.get('content-type')).toContain('text/css');
    expect((await fetch(`${server.url}/vendor/monaco/vs/missing.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/vendor/monaco/..%2fpackage.json`)).status).toBe(403);
    const policy = loader.headers.get('content-security-policy');
    expect(policy).toContain("script-src 'self';"); expect(policy).toContain("worker-src 'self' blob:"); expect(policy).toContain("font-src 'self' data:");
  });

  it('refuses foreign hosts, cross-origin and cross-site API calls, and missing tokens', async () => {
    const { server } = await boot();
    expect((await raw(`${server.url}/api/state`, { Host: 'attacker.example' })).status).toBe(403);
    expect((await raw(`${server.url}/api/state`, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw(`${server.url}/api/state`, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await raw(`${server.url}/api/state`, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    // Plugin ids are looked up in a null-prototype record map, so an inherited name is not an installed plugin.
    expect((await fetch(`${server.url}/api/plugins/constructor/storage`)).status).toBe(404);
    const big = await fetch(`${server.url}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) }, body: 'x'.repeat(3 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const guarded = await boot('secret-token');
    expect((await fetch(`${guarded.server.url}/api/state`)).status).toBe(401);
    expect((await fetch(`${guarded.server.url}/api/state`, { headers: { Authorization: 'Bearer secret-token' } })).status).toBe(200);
    expect((await fetch(`${guarded.server.url}/api/events?token=wrong`)).status).toBe(401);
  });
});
