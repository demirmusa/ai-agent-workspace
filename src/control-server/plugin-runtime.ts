import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlError, type Run, type Task } from './types.js';
import { PLUGIN_API_VERSION, PLUGIN_LIMITS, fail, type PluginManifest } from './plugin-manifest.js';

/**
 * Server code of enabled plugins: activation with its context API, plugin routes, task/run events, prompt contributions
 * and per-plugin logs. Server code runs inside the control server with its rights. Docs: src/assets/agent-skills/aiws-plugin-development.
 */
export interface PluginLogEntry { at: string; level: 'info' | 'warn' | 'error'; message: string }
export interface PluginServerStatus { declared: boolean; status: 'inactive' | 'active' | 'error'; error?: string; routes: string[] }
/** What server plugins may call; the server wires it to ControlService. */
export interface PluginServerHost {
  state(): unknown;
  tasks(): Task[];
  runs(): Run[];
  task(taskId: string): Task;
  saveTask(input: unknown, taskId?: string): Promise<Task>;
  sendTaskMessage(taskId: string, input: unknown): Promise<unknown>;
  onChange(listener: () => void): () => void;
}
/** The saved plugin data the context API reads and writes; PluginManager provides it. */
export interface PluginDataStore {
  settings(id: string, manifest: PluginManifest): Record<string, unknown>;
  storage(id: string, key?: string): Promise<unknown>;
  setStorage(id: string, key: string, value: unknown): Promise<void>;
}
export type PluginRouteHandler = (request: PluginRouteRequest) => unknown;
export interface PluginRouteRequest { method: string; path: string; params: Record<string, string>; query: Record<string, string>; body: unknown; headers: Record<string, string | string[] | undefined> }
/** A route result with its own status, body and headers; any other value is sent as 200 JSON. */
export class PluginResponse { constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {} }
type PromptContributor = (task: Task, run: Run) => string | undefined | null;
interface ServerRuntime { routes: { method: string; pattern: string; parts: string[]; handler: PluginRouteHandler }[]; listeners: Map<string, Set<(payload: unknown) => void>>; disposers: (() => unknown)[]; prompts: PromptContributor[]; settingsListeners: Set<(settings: Record<string, unknown>) => void> }

function routeParts(pattern: string): string[] {
  if (typeof pattern !== 'string' || !/^\/[A-Za-z0-9/_:.*-]*$/.test(pattern) || pattern.length > 200) fail(`Plugin route ${String(pattern)} must start with / and use letters, digits, :params and *.`);
  return pattern.split('/').filter(Boolean);
}
function matchRoute(parts: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === '*') { params['*'] = path.slice(index).join('/'); return params; }
    const segment = path[index]; if (segment === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = segment; else if (part !== segment) return null;
  }
  return parts.length === path.length ? params : null;
}
const logText = (part: unknown): string => { try { return typeof part === 'string' ? part : part instanceof Error ? part.stack ?? part.message : JSON.stringify(part) ?? String(part); } catch { return String(part); } };

export class PluginServerRuntimes {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly errors = new Map<string, string>();
  private readonly logs = new Map<string, PluginLogEntry[]>();
  private snapshot = new Map<string, { status: string; updatedAt: string }>();
  private runSnapshot = new Map<string, string>();
  private stopWatching: (() => void) | undefined;

  constructor(private readonly host: PluginServerHost | undefined, private readonly data: PluginDataStore) {}

  /** Starts the task/run event feed. */
  watch(): void { if (this.host && !this.stopWatching) { this.captureSnapshot(); this.stopWatching = this.host.onChange(() => this.emitStateEvents()); } }
  async close(): Promise<void> { this.stopWatching?.(); this.stopWatching = undefined; for (const id of [...this.runtimes.keys()]) await this.deactivate(id); }
  active(id: string): boolean { return this.runtimes.has(id); }
  status(id: string, declared: boolean): PluginServerStatus {
    const runtime = this.runtimes.get(id), error = this.errors.get(id);
    return { declared, status: runtime ? 'active' : error ? 'error' : 'inactive', ...(error ? { error } : {}), routes: runtime?.routes.map((route) => `${route.method} ${route.pattern}`) ?? [] };
  }
  logsOf(id: string): PluginLogEntry[] { return [...(this.logs.get(id) ?? [])]; }
  /** Drops what is kept for an uninstalled plugin. */
  forget(id: string): void { this.logs.delete(id); this.errors.delete(id); }
  settingsChanged(id: string, settings: Record<string, unknown>): void {
    for (const listener of this.runtimes.get(id)?.settingsListeners ?? []) this.guard(id, 'settings listener', () => listener(settings));
  }

  private log(id: string, level: PluginLogEntry['level'], parts: unknown[]): void {
    const entries = this.logs.get(id) ?? []; entries.push({ at: new Date().toISOString(), level, message: parts.map(logText).join(' ').slice(0, 4_000) });
    if (entries.length > PLUGIN_LIMITS.logs) entries.splice(0, entries.length - PLUGIN_LIMITS.logs);
    this.logs.set(id, entries);
  }
  private guard<T>(id: string, where: string, action: () => T): T | undefined {
    try { const result = action(); if (result instanceof Promise) result.catch((error: unknown) => this.log(id, 'error', [`${where}:`, error])); return result; }
    catch (error) { this.log(id, 'error', [`${where}:`, error]); return undefined; }
  }

  /** Imports the plugin's server module and calls its activate(context); a failure is kept as the plugin's server error. */
  async activate(id: string, directory: string, manifest: PluginManifest): Promise<void> {
    if (!manifest.server || !this.host || this.runtimes.has(id)) return;
    const runtime: ServerRuntime = { routes: [], listeners: new Map(), disposers: [], prompts: [], settingsListeners: new Set() };
    const host = this.host, data = this.data, log = (level: PluginLogEntry['level']) => (...parts: unknown[]) => this.log(id, level, parts);
    const route = (method: string) => (pattern: string, handler: PluginRouteHandler) => {
      if (typeof handler !== 'function') fail('A route handler must be a function.');
      runtime.routes.push({ method, pattern, parts: routeParts(pattern), handler });
    };
    const context = {
      apiVersion: PLUGIN_API_VERSION, plugin: { id, version: manifest.version, directory, manifest: structuredClone(manifest) },
      log: { info: log('info'), warn: log('warn'), error: log('error') },
      settings: { get: (key?: string) => { const values = data.settings(id, manifest); return key === undefined ? values : values[key]; }, onChange: (listener: (settings: Record<string, unknown>) => void) => { runtime.settingsListeners.add(listener); return () => runtime.settingsListeners.delete(listener); } },
      storage: { get: async (key?: string) => data.storage(id, key), set: (key: string, value: unknown) => data.setStorage(id, key, value), delete: (key: string) => data.setStorage(id, key, null) },
      routes: { get: route('GET'), post: route('POST'), put: route('PUT'), patch: route('PATCH'), delete: route('DELETE') },
      events: { on: (event: string, listener: (payload: unknown) => void) => { if (!this.snapshot.size && !this.runSnapshot.size) this.captureSnapshot(); const set = runtime.listeners.get(event) ?? new Set(); set.add(listener); runtime.listeners.set(event, set); return () => set.delete(listener); } },
      prompt: { contribute: (contributor: PromptContributor) => { runtime.prompts.push(contributor); return () => { runtime.prompts = runtime.prompts.filter((item) => item !== contributor); }; } },
      aiws: {
        state: () => structuredClone(host.state()), tasks: () => structuredClone(host.tasks()), runs: () => structuredClone(host.runs()), task: (taskId: string) => structuredClone(host.task(taskId)),
        createTask: (input: unknown) => host.saveTask(input), updateTask: (taskId: string, input: unknown) => host.saveTask(input, taskId),
        setTaskData: (taskId: string, value: Record<string, unknown> | null) => host.saveTask({ pluginData: { [id]: value } }, taskId),
        sendMessage: (taskId: string, text: string) => host.sendTaskMessage(taskId, { text }),
      },
      response: (status: number, body: unknown, headers?: Record<string, string>) => new PluginResponse(status, body, headers),
      onDispose: (dispose: () => unknown) => { runtime.disposers.push(dispose); },
    };
    try {
      // A fresh URL per activation reloads edited server code after the plugin is turned off and on.
      const module = await import(`${pathToFileURL(join(directory, manifest.server)).href}?v=${Date.now()}`) as { activate?: (value: typeof context) => unknown; deactivate?: () => unknown; default?: { activate?: (value: typeof context) => unknown; deactivate?: () => unknown } };
      const entry = module.activate ? module : module.default ?? {};
      if (typeof entry.activate !== 'function') fail(`${manifest.server} must export an activate(context) function.`);
      this.runtimes.set(id, runtime);
      const result = await entry.activate!(context);
      if (typeof result === 'function') runtime.disposers.push(result as () => unknown);
      if (typeof entry.deactivate === 'function') runtime.disposers.push(entry.deactivate);
      this.errors.delete(id); this.log(id, 'info', ['Server code activated.']);
    } catch (error) {
      this.runtimes.delete(id); for (const dispose of runtime.disposers.reverse()) this.guard(id, 'dispose', dispose);
      this.errors.set(id, (error as Error).message); this.log(id, 'error', ['Activation failed:', error]);
    }
  }
  async deactivate(id: string): Promise<void> {
    const runtime = this.runtimes.get(id); if (!runtime) return;
    this.runtimes.delete(id);
    for (const dispose of runtime.disposers.reverse()) { try { await dispose(); } catch (error) { this.log(id, 'error', ['Dispose failed:', error]); } }
    this.log(id, 'info', ['Server code stopped.']);
  }
  /** Runs a plugin's own API route: /api/plugins/:id/routes/... */
  async route(id: string, method: string, path: string, request: Omit<PluginRouteRequest, 'method' | 'path' | 'params'>): Promise<PluginResponse> {
    const runtime = this.runtimes.get(id) ?? fail('This plugin has no running server code. Enable it or check its logs.', 404);
    const segments = path.split('/').filter(Boolean);
    for (const route of runtime.routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route.parts, segments); if (!params) continue;
      try {
        const result = await route.handler({ ...request, method, path: `/${segments.join('/')}`, params });
        return result instanceof PluginResponse ? result : new PluginResponse(result === undefined ? 204 : 200, result ?? null);
      } catch (error) {
        if (error instanceof ControlError) throw error;
        this.log(id, 'error', [`${method} ${path}:`, error]); return fail(`Plugin route failed: ${(error as Error).message}`, 500);
      }
    }
    return fail(`Plugin route ${method} /${segments.join('/')} not found.`, 404);
  }
  /** Text server plugins add to an agent's task prompt. */
  promptContributions(task: Task, run: Run): string {
    const parts: string[] = [];
    for (const [id, runtime] of this.runtimes) for (const contributor of runtime.prompts) {
      const text = this.guard(id, 'prompt contributor', () => contributor(structuredClone(task), structuredClone(run)));
      if (typeof text === 'string' && text.trim()) parts.push(`[${id}] ${text.trim().slice(0, 20_000)}`);
    }
    return parts.join('\n\n');
  }
  private captureSnapshot(): void {
    if (!this.host) return;
    this.snapshot = new Map(this.host.tasks().map((task) => [task.id, { status: task.status, updatedAt: task.updatedAt }]));
    this.runSnapshot = new Map(this.host.runs().map((run) => [run.id, run.status]));
  }
  private emitStateEvents(): void {
    if (!this.host || ![...this.runtimes.values()].some((runtime) => runtime.listeners.size)) { if (this.snapshot.size || this.runSnapshot.size) { this.snapshot.clear(); this.runSnapshot.clear(); } return; }
    const previous = this.snapshot, previousRuns = this.runSnapshot, tasks = this.host.tasks();
    this.captureSnapshot();
    const emit = (event: string, payload: unknown): void => { for (const [id, runtime] of this.runtimes) for (const listener of runtime.listeners.get(event) ?? []) this.guard(id, `${event} listener`, () => listener(structuredClone(payload))); };
    for (const task of tasks) {
      const before = previous.get(task.id);
      if (!before) emit('task.created', { task });
      else if (before.updatedAt !== task.updatedAt) { emit('task.updated', { task }); if (before.status !== task.status) emit('task.statusChanged', { task, from: before.status, to: task.status }); }
    }
    const current = new Set(tasks.map((task) => task.id));
    for (const id of previous.keys()) if (!current.has(id)) emit('task.deleted', { taskId: id });
    for (const run of this.host.runs()) {
      const before = previousRuns.get(run.id);
      if (!before) emit('run.started', { run });
      else if (before !== run.status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) emit('run.finished', { run });
    }
    emit('state', {});
  }
}
