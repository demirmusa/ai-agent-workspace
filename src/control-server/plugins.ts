import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { writeJsonFileAtomic } from '../shared/core/json.js';
import { isPathInside } from '../shared/core/paths.js';
import { packageAssetsDirectory } from '../shared/core/assets.js';
import type { Run, Task } from './types.js';
import { jsonObject } from './validation.js';
import { PLUGIN_ID, PLUGIN_LIMITS, exists, fail, loadManifest, pluginRelativePath, readManifest, settingValue, type PluginManifest } from './plugin-manifest.js';
import { readZipArchive, walkFolder } from './plugin-archive.js';
import { PluginServerRuntimes, type PluginLogEntry, type PluginRouteRequest, type PluginResponse, type PluginServerHost, type PluginServerStatus } from './plugin-runtime.js';

/**
 * Plugins extend the control center: browser modules, styles and themes, task data and optional server code. This
 * module installs and lists them and keeps their settings and storage; plugin-manifest.ts validates plugin.json,
 * plugin-archive.ts reads and writes packages, plugin-runtime.ts runs server code. Docs: src/assets/agent-skills/aiws-plugin-development.
 */
export * from './plugin-manifest.js';
export * from './plugin-archive.js';
export * from './plugin-runtime.js';

interface PluginRecord { enabled: boolean; settings: Record<string, unknown>; storage: Record<string, unknown>; installedAt: string; updatedAt: string; linkedPath?: string }
export interface PluginInfo {
  id: string; directory: string; mode: PluginMode; enabled: boolean; installedAt?: string; updatedAt?: string; error?: string;
  manifest?: PluginManifest; settings: Record<string, unknown>; assetBase: string; server: PluginServerStatus;
}

/** copy: installed into the data folder; link: read from a development folder; bundled: ships with AIWS under assets/plugins. */
export type PluginMode = 'copy' | 'link' | 'bundled';

/** Plugins that ship with AIWS by id. They are on by default, can be turned off, and an installed copy of the same id takes over. */
function bundledPlugins(): Map<string, string> {
  const root = packageAssetsDirectory('plugins'), found = new Map<string, string>();
  if (!root) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { const directory = join(root, entry.name); found.set(readManifest(directory).id, directory); } catch { /* A broken bundled folder is a packaging fault, not a reason to stop the server. */ }
  }
  return found;
}

export class PluginManager extends EventEmitter {
  readonly directory: string;
  private readonly statePath: string;
  /** Keyed by plugin id; a null prototype keeps an id such as "constructor" from resolving to an inherited value. */
  private readonly records: Record<string, PluginRecord> = Object.create(null) as Record<string, PluginRecord>;
  private readonly server: PluginServerRuntimes;
  private readonly bundled = bundledPlugins();
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, host?: PluginServerHost) {
    super();
    this.directory = join(dataDir, 'plugins'); this.statePath = join(dataDir, 'plugins.json');
    try { const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { plugins?: Record<string, PluginRecord> }; if (saved.plugins && typeof saved.plugins === 'object') Object.assign(this.records, saved.plugins); }
    catch { /* No saved plugin state yet. */ }
    this.server = new PluginServerRuntimes(host, { settings: (id, manifest) => this.settingsOf(id, manifest), storage: (id, key) => this.storage(id, key), setStorage: (id, key, value) => this.setStorage(id, key, value) });
  }
  /** Starts the server code of enabled plugins and the task/run event feed. */
  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.server.watch();
    for (const info of await this.list()) if (info.enabled && info.manifest?.server) await this.server.activate(info.id, info.directory, info.manifest);
  }
  async close(): Promise<void> { await this.server.close(); await this.writing; }

  private folder(id: string): { directory: string; mode: PluginMode } {
    const linked = this.records[id]?.linkedPath, copied = join(this.directory, id), bundled = this.bundled.get(id);
    return linked ? { directory: linked, mode: 'link' } : bundled && !existsSync(copied) ? { directory: bundled, mode: 'bundled' } : { directory: copied, mode: 'copy' };
  }
  private async ids(): Promise<string[]> {
    const copied = (await readdir(this.directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && PLUGIN_ID.test(entry.name)).map((entry) => entry.name);
    return [...new Set([...this.bundled.keys(), ...copied, ...Object.keys(this.records).filter((id) => this.records[id]?.linkedPath)])].sort();
  }
  /** Installed plugins, re-read from disk so a folder copied by hand appears without a restart. */
  async list(): Promise<PluginInfo[]> { return Promise.all((await this.ids()).map((id) => this.info(id))); }
  /** Fails with 404 unless the plugin is installed: it has a record or a folder. */
  private async known(id: string): Promise<void> {
    if (!PLUGIN_ID.test(id) || !this.records[id] && !await exists(this.folder(id).directory)) fail('Plugin not found.', 404);
  }
  async info(id: string): Promise<PluginInfo> {
    await this.known(id);
    const { directory, mode } = this.folder(id); const record = this.records[id];
    let manifest: PluginManifest | undefined, error: string | undefined;
    try { manifest = await loadManifest(directory); if (manifest.id !== id) fail(`plugin.json id "${manifest.id}" does not match its folder "${id}".`); }
    catch (cause) { error = (cause as Error).message; manifest = undefined; }
    // A bundled plugin changes with AIWS's own updates, so its address follows its version.
    const stamp = mode === 'bundled' && manifest ? manifest.version : record?.updatedAt ? Date.parse(record.updatedAt).toString(36) : '0';
    return { id, directory, mode, enabled: Boolean(manifest) && (record?.enabled ?? true), ...(record ? { installedAt: record.installedAt, updatedAt: record.updatedAt } : {}), ...(error ? { error } : {}),
      ...(manifest ? { manifest } : {}), settings: manifest ? this.settingsOf(id, manifest) : {}, assetBase: `/plugins/${id}/${stamp}/`, server: this.server.status(id, Boolean(manifest?.server)) };
  }
  private async manifestOf(id: string): Promise<PluginManifest> { const info = await this.info(id); return info.manifest ?? fail(info.error ?? 'Plugin is not valid.'); }
  private settingsOf(id: string, manifest: PluginManifest): Record<string, unknown> {
    const saved = this.records[id]?.settings ?? {};
    return Object.fromEntries(manifest.settings.map((field) => [field.key, Object.hasOwn(saved, field.key) ? saved[field.key] : field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? field.min ?? 0 : field.type === 'select' ? field.options?.[0]?.value ?? '' : '')]));
  }
  private record(id: string): PluginRecord {
    const timestamp = new Date().toISOString();
    return this.records[id] ??= { enabled: true, settings: {}, storage: {}, installedAt: timestamp, updatedAt: timestamp };
  }
  private save(): Promise<void> {
    const value = { version: 1, plugins: this.records };
    this.writing = this.writing.catch(() => undefined).then(() => writeJsonFileAtomic(this.statePath, value));
    return this.writing;
  }
  private changed(id: string): void { this.emit('plugins', { id }); }
  private async activate(id: string): Promise<void> { const info = await this.info(id); if (info.manifest) await this.server.activate(id, info.directory, info.manifest); }

  /** Installs from a folder (copied, or linked for development) or from a base64 ZIP archive. An installed id is replaced in place. */
  async install(input: unknown): Promise<PluginInfo> {
    const value = jsonObject(input);
    const staging = join(this.directory, `.staging-${randomUUID()}`);
    let manifest: PluginManifest; let linkedPath: string | undefined;
    await mkdir(this.directory, { recursive: true });
    try {
      if (typeof value.archive === 'string') {
        const files = readZipArchive(Buffer.from(value.archive, 'base64'));
        for (const [path, content] of files) { const target = join(staging, ...path.split('/')); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
        manifest = readManifest(staging);
      } else {
        const source = typeof value.path === 'string' && isAbsolute(value.path) ? resolve(value.path) : fail('path must be an absolute folder path, or send a ZIP archive.');
        let info; try { info = lstatSync(source); } catch { return fail(`Folder not found: ${source}`, 404); }
        if (!info.isDirectory() || info.isSymbolicLink()) fail('path must be a real folder, not a file or link.');
        manifest = readManifest(source); walkFolder(source);
        if (value.mode === 'link') linkedPath = source;
        else await cp(source, staging, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes('.git') });
      }
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    const id = manifest.id;
    await this.server.deactivate(id);
    const target = join(this.directory, id);
    await rm(target, { recursive: true, force: true });
    if (linkedPath) await rm(staging, { recursive: true, force: true }); else await rename(staging, target);
    const record = this.record(id); record.updatedAt = new Date().toISOString();
    if (linkedPath) record.linkedPath = linkedPath; else delete record.linkedPath;
    await this.save();
    if (record.enabled && manifest.server) await this.activate(id);
    this.changed(id); return this.info(id);
  }
  async uninstall(id: string): Promise<void> {
    const info = await this.info(id);
    if (info.mode === 'bundled') fail('This plugin ships with AIWS and cannot be removed. Turn it off instead.', 409);
    await this.server.deactivate(id);
    if (info.mode === 'copy') await rm(info.directory, { recursive: true, force: true });
    delete this.records[id]; this.server.forget(id);
    await this.save(); this.changed(id);
  }
  /** Turns a plugin on or off and saves its settings; values are checked against the manifest's fields. */
  async update(id: string, input: unknown): Promise<PluginInfo> {
    const value = jsonObject(input), manifest = await this.manifestOf(id), record = this.record(id);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('enabled must be true or false.');
    if (value.settings !== undefined) {
      const settings = { ...record.settings };
      for (const [key, raw] of Object.entries(jsonObject(value.settings, 'settings'))) {
        const field = manifest.settings.find((item) => item.key === key) ?? fail(`Unknown setting ${key}.`);
        if (raw === null) delete settings[key]; else settings[key] = settingValue(field, raw);
      }
      if (Buffer.byteLength(JSON.stringify(settings)) > PLUGIN_LIMITS.settingsBytes) fail('Plugin settings are too large.');
      record.settings = settings;
    }
    if (typeof value.enabled === 'boolean') record.enabled = value.enabled;
    await this.save();
    if (manifest.server) { if (record.enabled && !this.server.active(id)) await this.activate(id); else if (!record.enabled) await this.server.deactivate(id); }
    if (value.settings !== undefined) this.server.settingsChanged(id, this.settingsOf(id, manifest));
    this.changed(id); return this.info(id);
  }
  async storage(id: string, key?: string): Promise<unknown> {
    await this.known(id); const storage = this.records[id]?.storage ?? {};
    return key === undefined ? structuredClone(storage) : structuredClone(Object.hasOwn(storage, key) ? storage[key] : null);
  }
  async setStorage(id: string, key: string, value: unknown): Promise<void> {
    await this.known(id);
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(key) || key === '__proto__') fail('Storage keys are 1-200 letters, digits, dots, colons, dashes or underscores.');
    const storage = { ...this.record(id).storage };
    if (value === undefined || value === null) delete storage[key]; else storage[key] = structuredClone(value);
    if (Buffer.byteLength(JSON.stringify(storage)) > PLUGIN_LIMITS.storageBytes) fail(`Plugin storage is limited to ${PLUGIN_LIMITS.storageBytes / 1024} KiB.`);
    this.record(id).storage = storage; await this.save();
  }
  /** A file of an installed plugin; neither the path nor a symbolic link (in a linked folder) can leave the plugin folder. */
  async asset(id: string, path: string): Promise<string> {
    if (!PLUGIN_ID.test(id)) fail('Plugin not found.', 404);
    const root = resolve(this.folder(id).directory), file = resolve(root, pluginRelativePath(path, 'Plugin file'));
    if (!isPathInside(root, file) || file === root) fail('Invalid plugin file path.', 403);
    let real: string;
    try { real = await realpath(file); if (!(await stat(real)).isFile()) throw new Error(); } catch { return fail('Plugin file not found.', 404); }
    if (!isPathInside(await realpath(root), real)) fail('Invalid plugin file path.', 403);
    return file;
  }
  async pluginLogs(id: string): Promise<PluginLogEntry[]> { await this.known(id); return this.server.logsOf(id); }
  /** Runs a plugin's own API route: /api/plugins/:id/routes/... */
  route(id: string, method: string, path: string, request: Omit<PluginRouteRequest, 'method' | 'path' | 'params'>): Promise<PluginResponse> { return this.server.route(id, method, path, request); }
  /** Text server plugins add to an agent's task prompt. */
  promptContributions(task: Task, run: Run): string { return this.server.promptContributions(task, run); }
}
