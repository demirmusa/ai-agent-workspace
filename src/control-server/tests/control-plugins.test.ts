import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControlServer, type RunningControlServer } from '../server.js';
import { mergeTaskPluginData, packPluginFolder, readZipArchive, validatePluginManifest, writeZipArchive } from '../plugins.js';
import type { Run } from '../types.js';

const example = fileURLToPath(new URL('../../../examples/plugins/aiws-example-plugin', import.meta.url));
const themeExample = fileURLToPath(new URL('../../../examples/plugins/aiws-theme-sunset', import.meta.url));
const roots: string[] = []; const servers: RunningControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'aiws-plugins-')); roots.push(root); return root; }
async function server(root = temp()): Promise<{ running: RunningControlServer; root: string; call: (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: any; headers: Headers }> }> {
  const running = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), skills: { home: join(root, 'home') } });
  servers.push(running);
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed: unknown = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* Not JSON. */ }
    return { status: response.status, body: parsed as any, headers: response.headers };
  };
  return { running, root, call };
}
function plugin(root: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const directory = join(root, String(manifest.id ?? 'plugin')); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), content); }
  return directory;
}

describe('plugin manifests', () => {
  it('accepts the bundled examples and rejects unsafe or unsupported manifests', () => {
    const manifest = validatePluginManifest(JSON.parse(readFileSync(join(example, 'plugin.json'), 'utf8')));
    expect(manifest).toMatchObject({ id: 'aiws.example', main: 'plugin.js', server: 'server.js', styles: ['style.css'] });
    expect(manifest.themes.map((theme) => theme.id)).toEqual(['midnight', 'forest']);
    expect(manifest.settings.find((field) => field.key === 'pointUnit')).toMatchObject({ type: 'select', default: 'SP' });
    expect(validatePluginManifest(JSON.parse(readFileSync(join(themeExample, 'plugin.json'), 'utf8'))).themes[0]?.dark?.accent).toBe('#ff8a4c');
    const base = { id: 'acme.ok', name: 'OK', version: '1.0.0' };
    expect(() => validatePluginManifest({ ...base, id: 'Bad Id' })).toThrow('plugin.json id');
    expect(() => validatePluginManifest({ ...base, apiVersion: 99 })).toThrow('Update AIWS');
    expect(() => validatePluginManifest({ ...base, main: '../escape.js' })).toThrow('inside the plugin folder');
    expect(() => validatePluginManifest({ ...base, styles: ['C:/abs.css'] })).toThrow();
    expect(() => validatePluginManifest({ ...base, themes: [{ id: 'x', name: 'X', dark: { surface: 'red;}body{display:none' } }] })).toThrow('CSS value');
    expect(() => validatePluginManifest({ ...base, themes: [{ id: 'x', name: 'X' }] })).toThrow('dark or light');
    expect(() => validatePluginManifest({ ...base, settings: [{ key: 'mode', type: 'select' }] })).toThrow('needs options');
    expect(() => validatePluginManifest({ ...base, settings: [{ key: 'n', type: 'number', min: 1, default: 0 }] })).toThrow('between');
    expect(validatePluginManifest({ ...base, themes: [{ id: 'x', name: { tr: 'X', en: 'X' }, light: { '--ground': '#fff' } }] }).themes[0]?.light).toEqual({ ground: '#fff' });
  });

  it('merges task plugin data per plugin and enforces its size', () => {
    const merged = mergeTaskPluginData({ 'acme.one': { a: 1 }, 'acme.two': { b: 2 } }, { 'acme.one': { a: 3 }, 'acme.three': { c: 4 } });
    expect(merged).toEqual({ 'acme.one': { a: 3 }, 'acme.two': { b: 2 }, 'acme.three': { c: 4 } });
    expect(mergeTaskPluginData(merged, { 'acme.one': null, 'acme.two': null, 'acme.three': null })).toBeUndefined();
    expect(() => mergeTaskPluginData(undefined, { 'Not An Id': {} })).toThrow('not a plugin id');
    expect(() => mergeTaskPluginData(undefined, { 'acme.big': { text: 'x'.repeat(70_000) } })).toThrow('64 KiB');
  });

  it('packs folders into ZIP archives that read back identically and refuses escaping entries', () => {
    const packed = packPluginFolder(example);
    expect(packed.manifest.id).toBe('aiws.example');
    const files = readZipArchive(packed.archive);
    expect([...files.keys()].sort()).toEqual(['README.md', 'icon.svg', 'package.json', 'plugin.js', 'plugin.json', 'server.js', 'style.css']);
    expect(files.get('plugin.js')!.toString('utf8')).toBe(readFileSync(join(example, 'plugin.js'), 'utf8'));
    // A ZIP of a folder (one top-level directory) is unwrapped.
    const nested = readZipArchive(writeZipArchive(new Map([['my-plugin/plugin.json', Buffer.from('{}')], ['my-plugin/a.js', Buffer.from('x')]])));
    expect([...nested.keys()].sort()).toEqual(['a.js', 'plugin.json']);
    expect(() => readZipArchive(writeZipArchive(new Map([['../evil.js', Buffer.from('x')], ['plugin.json', Buffer.from('{}')]])))).toThrow('inside the plugin folder');
    expect(() => readZipArchive(writeZipArchive(new Map([['readme.txt', Buffer.from('x')]])))).toThrow('plugin.json');
    expect(() => readZipArchive(Buffer.from('not a zip'))).toThrow('not a ZIP');
  });
});

describe('plugin manager through the control API', () => {
  it('ships the technology plugins on by default: they can be turned off, not removed, and an installed copy takes over', async () => {
    const { call } = await server();
    const bundled = (await call('/api/plugins')).body.plugins.filter((plugin: { mode: string }) => plugin.mode === 'bundled');
    expect(bundled.map((plugin: { id: string }) => plugin.id)).toEqual(['aiws.angular', 'aiws.dotnet', 'aiws.electron', 'aiws.react-native']);
    for (const plugin of bundled) {
      expect(plugin).toMatchObject({ enabled: true, assetBase: `/plugins/${plugin.id}/1.0.1/`, manifest: { main: 'plugin.js', styles: ['style.css'] } });
      expect(plugin.error).toBeUndefined();
      const script = await call(`${plugin.assetBase}plugin.js`); expect(script.status).toBe(200); expect(script.body).toContain('export function activate');
      expect((await call(`${plugin.assetBase}style.css`)).status).toBe(200);
    }
    expect((await call('/api/plugins/aiws.dotnet', 'DELETE')).status).toBe(409);
    expect((await call('/api/plugins/aiws.dotnet', 'PATCH', { enabled: false })).body).toMatchObject({ enabled: false, mode: 'bundled' });
    expect((await call('/api/plugins/aiws.dotnet')).body.enabled).toBe(false);
    expect((await call('/api/plugins/aiws.dotnet', 'PATCH', { enabled: true })).body.enabled).toBe(true);
  });
  it('installs the example from a folder, serves its files, runs its server routes and keeps settings and storage', async () => {
    const { running, call } = await server();
    const added = (plugins: Array<{ mode: string }>) => plugins.filter((plugin) => plugin.mode !== 'bundled');
    expect((await call('/api/plugins')).body).toMatchObject({ apiVersion: 1 }); expect(added((await call('/api/plugins')).body.plugins)).toEqual([]);
    const installed = await call('/api/plugins', 'POST', { path: example });
    expect(installed.status).toBe(201);
    expect(installed.body).toMatchObject({ id: 'aiws.example', mode: 'copy', enabled: true, server: { declared: true, status: 'active' } });
    expect(installed.body.server.routes).toEqual(expect.arrayContaining(['GET /ping', 'GET /stats', 'POST /tasks/:taskId/estimate']));
    expect(existsSync(join(running.plugins.directory, 'aiws.example', 'plugin.js'))).toBe(true);

    const script = await call(`${installed.body.assetBase}plugin.js`);
    expect(script.status).toBe(200); expect(script.headers.get('content-type')).toContain('text/javascript'); expect(script.body).toContain('export function activate');
    expect((await call(`${installed.body.assetBase}icon.svg`)).headers.get('content-type')).toBe('image/svg+xml');
    expect((await call('/plugins/aiws.example/x/..%2F..%2Fplugins.json')).status).toBeGreaterThanOrEqual(400);
    expect((await call('/plugins/aiws.example/x/missing.js')).status).toBe(404);

    expect((await call('/api/plugins/aiws.example/routes/ping')).body).toMatchObject({ ok: true, plugin: 'aiws.example', version: '1.0.0' });
    expect((await call('/api/plugins/aiws.example/routes/nope')).status).toBe(404);

    expect((await call('/api/plugins/aiws.example', 'PATCH', { settings: { pointUnit: 'h', highlight: '#123456' } })).body.settings).toMatchObject({ pointUnit: 'h', highlight: '#123456', showBadges: true });
    expect((await call('/api/plugins/aiws.example', 'PATCH', { settings: { pointUnit: 'days' } })).status).toBe(400);
    expect((await call('/api/plugins/aiws.example', 'PATCH', { settings: { highlight: 'red' } })).status).toBe(400);
    expect((await call('/api/plugins/aiws.example', 'PATCH', { settings: { unknown: 1 } })).status).toBe(400);
    expect((await call('/api/plugins/aiws.example/storage/notes:p1', 'PUT', { value: [{ text: 'merhaba' }] })).status).toBe(200);
    expect((await call('/api/plugins/aiws.example/storage/notes:p1')).body).toEqual({ value: [{ text: 'merhaba' }] });
    expect((await call('/api/plugins/aiws.example/storage')).body).toEqual({ values: { 'notes:p1': [{ text: 'merhaba' }] } });
    expect((await call('/api/plugins/aiws.example/logs')).body.logs.some((entry: { message: string }) => entry.message.includes('ready'))).toBe(true);

    // Reinstalling the same id replaces the files and keeps settings and storage.
    expect((await call('/api/plugins', 'POST', { path: example })).body.settings.pointUnit).toBe('h');
    expect((await call('/api/plugins/aiws.example/storage/notes:p1')).body.value).toHaveLength(1);

    // Disabling stops the server code; enabling starts it again.
    expect((await call('/api/plugins/aiws.example', 'PATCH', { enabled: false })).body).toMatchObject({ enabled: false, server: { status: 'inactive' } });
    expect((await call('/api/plugins/aiws.example/routes/ping')).status).toBe(404);
    expect((await call('/api/plugins/aiws.example', 'PATCH', { enabled: true })).body.server.status).toBe('active');
    expect((await call('/api/plugins/aiws.example', 'DELETE')).status).toBe(200);
    expect(existsSync(join(running.plugins.directory, 'aiws.example'))).toBe(false);
    expect(added((await call('/api/plugins')).body.plugins)).toEqual([]);
  });

  it('stores task plugin data, lets server code edit it and adds plugin context to agent prompts', async () => {
    const { running, root, call } = await server();
    await call('/api/plugins', 'POST', { path: example });
    const repository = join(root, 'repo'); mkdirSync(repository);
    const project = (await call('/api/projects', 'POST', { name: 'Plugins', repositoryPath: repository })).body;
    const created = await call('/api/tasks', 'POST', { projectId: project.id, title: 'Estimate me', description: '', pluginData: { 'aiws.example': { estimate: 3, criteria: [{ text: 'Tests pass', done: false }] }, 'acme.other': { keep: true } } });
    expect(created.status).toBe(201);
    expect(created.body.pluginData).toEqual({ 'aiws.example': { estimate: 3, criteria: [{ text: 'Tests pass', done: false }] }, 'acme.other': { keep: true } });
    const patched = await call(`/api/tasks/${created.body.id}`, 'PATCH', { pluginData: { 'aiws.example': { estimate: 3, risk: 'high', criteria: [{ text: 'Tests pass', done: false }] } } });
    expect(patched.body.pluginData['acme.other']).toEqual({ keep: true });
    expect(patched.body.pluginData['aiws.example'].risk).toBe('high');
    expect((await call(`/api/tasks/${created.body.id}`, 'PATCH', { title: 'Renamed' })).body.pluginData['aiws.example'].risk).toBe('high');

    const routed = await call(`/api/plugins/aiws.example/routes/tasks/${created.body.id}/estimate`, 'POST', { estimate: 8 });
    expect(routed.body).toEqual({ taskId: created.body.id, estimate: 8 });
    expect((await call(`/api/plugins/aiws.example/routes/tasks/${created.body.id}/estimate`, 'POST', { estimate: -1 })).status).toBe(400);
    expect((await call('/api/plugins/aiws.example/routes/stats')).body).toMatchObject({ tasks: 1, estimate: 8 });

    const task = running.service.task(created.body.id);
    const context = running.plugins.promptContributions(task, { id: 'run_test', taskId: task.id } as Run);
    expect(context).toContain('[aiws.example] Estimated size: 8 SP');
    expect(context).toContain('Risk level: high.');
    expect(context).toContain('- Tests pass');
    await call('/api/plugins/aiws.example', 'PATCH', { settings: { promptContext: false } });
    expect(running.plugins.promptContributions(task, { id: 'run_test', taskId: task.id } as Run)).toBe('');

    expect((await call(`/api/tasks/${created.body.id}`, 'PATCH', { pluginData: { 'aiws.example': null } })).body.pluginData).toEqual({ 'acme.other': { keep: true } });
    expect((await call(`/api/tasks/${created.body.id}`, 'PATCH', { pluginData: { 'Bad Id': {} } })).status).toBe(400);
  });

  it('installs ZIP archives and linked development folders and reports broken plugins without loading them', async () => {
    const { running, root, call } = await server();
    const zipped = await call('/api/plugins', 'POST', { archive: packPluginFolder(themeExample).archive.toString('base64'), fileName: 'sunset.zip' });
    expect(zipped.status).toBe(201);
    expect(zipped.body).toMatchObject({ id: 'aiws.theme-sunset', mode: 'copy', server: { declared: false } });
    expect(zipped.body.manifest.themes[0].id).toBe('sunset');

    const source = join(root, 'dev'); cpSync(example, join(source, 'aiws.example'), { recursive: true });
    const linked = await call('/api/plugins', 'POST', { path: join(source, 'aiws.example'), mode: 'link' });
    expect(linked.body).toMatchObject({ id: 'aiws.example', mode: 'link', directory: join(source, 'aiws.example') });
    writeFileSync(join(source, 'aiws.example', 'extra.css'), '.x{}');
    expect((await call(`${linked.body.assetBase}extra.css`)).body).toBe('.x{}');
    expect((await call('/api/plugins/aiws.example', 'DELETE')).status).toBe(200);
    expect(existsSync(join(source, 'aiws.example', 'plugin.js'))).toBe(true);

    const broken = plugin(join(root, 'broken'), { id: 'acme.broken', name: 'Broken', version: '1.0.0', main: 'missing.js' });
    expect((await call('/api/plugins', 'POST', { path: broken })).body.error).toContain('missing.js');
    // A plugin folder copied by hand with a bad manifest is listed with its error and stays off.
    mkdirSync(join(running.plugins.directory, 'acme.manual')); writeFileSync(join(running.plugins.directory, 'acme.manual', 'plugin.json'), '{ nope');
    const listed = (await call('/api/plugins')).body.plugins.find((item: { id: string }) => item.id === 'acme.manual');
    expect(listed).toMatchObject({ enabled: false }); expect(listed.error).toContain('not valid JSON');

    const failing = plugin(join(root, 'failing'), { id: 'acme.failing', name: 'Failing', version: '1.0.0', server: 'server.js' }, { 'server.js': 'export function activate() { throw new Error("boom"); }' });
    const failed = (await call('/api/plugins', 'POST', { path: failing })).body;
    expect(failed.server).toMatchObject({ status: 'error', error: 'boom' });
    expect((await call('/api/plugins/acme.failing/logs')).body.logs.at(-1).message).toContain('boom');
    expect((await call('/api/plugins', 'POST', { path: 'relative/path' })).status).toBe(400);
    expect((await call('/api/plugins', 'POST', { archive: Buffer.from('nope').toString('base64') })).status).toBe(400);
  });

  it('installs the plugin development skill on request only', async () => {
    const { root, call } = await server();
    const before = (await call('/api/plugin-skill')).body;
    expect(before).toMatchObject({ skill: 'aiws-plugin-development', installed: false, modified: false });
    expect(existsSync(join(root, 'home', '.claude', 'skills', 'aiws-plugin-development'))).toBe(false);
    const installed = (await call('/api/plugin-skill', 'POST', {})).body;
    expect(installed.installed).toBe(true);
    for (const base of [join(root, 'home', '.claude'), join(root, 'home', '.agents')]) {
      expect(readFileSync(join(base, 'skills', 'aiws-plugin-development', 'SKILL.md'), 'utf8')).toContain('name: aiws-plugin-development');
      expect(existsSync(join(base, 'skills', 'aiws-plugin-development', 'references', 'client-api.md'))).toBe(true);
    }
    writeFileSync(join(root, 'home', '.claude', 'skills', 'aiws-plugin-development', 'SKILL.md'), 'local edit');
    expect((await call('/api/plugin-skill')).body).toMatchObject({ installed: false, modified: true });
    expect((await call('/api/plugin-skill', 'POST', {})).status).toBe(409);
    expect((await call('/api/plugin-skill', 'POST', { force: true })).body.installed).toBe(true);
  });
});
