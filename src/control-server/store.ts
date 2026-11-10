import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, statSync, utimesSync, fsyncSync, readdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ControlEvent, ControlSettings, ControlState, ProjectLabel, Run, TaskMessage } from './types.js';
import { mergeLabels, validateLabel } from './labels.js';
import { ControlError, DEFAULT_TASK_MERGE_MODE } from './types.js';
import { defaultControlDataDir } from '../shared/core/paths.js';
import { processAlive, SERVICE_LOCK_FILE, SERVICE_LOCK_STALE_MS } from '../shared/core/control-endpoint.js';
import { emptyProviderArgs, normalizeModelPreferences, normalizeProviderSettings, validateProviderArgs } from './provider-args.js';

export function emptyControlState(): ControlState {
  return { schemaVersion: 1, projects: [], tasks: [], runs: [], terminals: [], questions: [], events: [], agents: [], skills: [], workflows: [], messages: [], plannerMessages: [], schedules: [],
    settings: { taskMergeMode: DEFAULT_TASK_MERGE_MODE, systemEnabled: true, defaultProvider: 'codex', maxConcurrent: 3, executionMode: 'native', dockerImage: 'aiws-control-worker:local', autoSyncSeconds: 30, providerArgs: emptyProviderArgs(), disabledProviders: [], defaultModels: {}, disabledModels: {}, autoModeProviders: [], customProviders: [], githubTrigger: '/ai', systemPrompt: '', voiceProvider: 'claude', usageFooter: { pins: {}, hidden: [] } } };
}
/** Terminal replay kept per run; older output is dropped from the front. */
export const TERMINAL_REPLAY_LIMIT = 1_000_000;
/** Appends a PTY chunk to the run's in-memory replay and returns the chunk's offset in the run's terminal stream. */
export function appendReplay(run: Run, previous: string, data: string): number {
  const offset = run.terminalLength ?? previous.length;
  run.terminalLength = offset + data.length;
  let output = previous + data;
  // Trim in batches; slicing a megabyte string for every PTY chunk is quadratic.
  if (output.length > TERMINAL_REPLAY_LIMIT * 1.25) output = output.slice(-TERMINAL_REPLAY_LIMIT);
  run.terminalOutput = output;
  return offset;
}
/** Journal entries kept in memory (and sent to clients); the database keeps a longer history. */
const MEMORY_EVENTS = 20_000, MEMORY_EVENT_CHARACTERS = 8_000_000, MEMORY_MESSAGES = 10_000, STORED_EVENTS = 200_000;
const lockHeartbeatMs = 10_000;

type Keyed = { id: string } & Record<string, unknown>;
// Collections stored one row per entity, in array order. parent/status are indexed for queries.
const collections = {
  projects: () => [null, null],
  tasks: (item: Keyed) => [item.projectId, item.status],
  runs: (item: Keyed) => [item.taskId, item.status],
  terminals: (item: Keyed) => [item.projectId, item.status],
  questions: (item: Keyed) => [item.taskId, item.status],
  agents: () => [null, null],
  skills: () => [null, null],
  workflows: (item: Keyed) => [item.projectId ?? null, null],
  plannerMessages: (item: Keyed) => [item.projectId, null],
  schedules: (item: Keyed) => [item.projectId, item.enabled ? 'enabled' : 'disabled'],
} as const satisfies Record<string, (item: Keyed) => unknown[]>;
type Collection = keyof typeof collections;
const collectionNames = Object.keys(collections) as Collection[];
// Top-level state values that are neither collections, journal, settings nor computed.
const listedKeys = new Set<string>([...collectionNames, 'events', 'messages', 'settings', 'systemStatus', 'agentAvailability', 'resolvedProviderSettings']);

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, parent_id TEXT, status TEXT, data TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS records_parent ON records (collection, parent_id);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT, run_id TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT, run_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_task ON messages (task_id, seq);
CREATE TABLE IF NOT EXISTS terminal_chunks (run_id TEXT NOT NULL, offset INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, offset)) WITHOUT ROWID;
`;

/** node:sqlite ships inside Node 22.13+ and Electron, so there is nothing to install or compile. */
function openDatabase(path: string): DatabaseSync {
  // Node 22 still labels the module experimental; that warning is noise for every CLI call.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (/SQLite/i.test(typeof warning === 'string' ? warning : warning.message)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    return new Database(path);
  } finally { process.emitWarning = emit; }
}
function writeAtomically(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function normalizeSettings(settings: Partial<ControlSettings> | undefined): ControlSettings {
  const normalized = { ...emptyControlState().settings, ...settings } as ControlSettings;
  // Legacy global worktree settings never enable isolation for every project.
  delete (normalized as unknown as Record<string, unknown>).useWorktree;
  delete (normalized as unknown as Record<string, unknown>).mainBranch;
  delete (normalized as unknown as Record<string, unknown>).providerEnv;
  normalized.providerArgs = validateProviderArgs(settings?.providerArgs);
  // Older settings files have neither field: every built-in provider is enabled and there are no custom ones.
  Object.assign(normalized, normalizeProviderSettings(normalized), normalizeModelPreferences(normalized));
  return normalized;
}

/**
 * One service owns a directory. The control state lives in an SQLite database
 * (control.db): one row per project, task, run and catalog entry, an append-only
 * event and message journal, and terminal replays as appended chunks. Settings
 * stay in a small, human-readable settings.json.
 *
 * The service keeps working on the in-memory state; a save writes only the rows
 * that changed since the previous save, in one transaction.
 */
export class ControlStore {
  readonly directory: string;
  /** The SQLite database file. */
  readonly path: string;
  readonly settingsPath: string;
  /** Pre-SQLite state.json; imported once and kept as state.json.pre-sqlite. */
  readonly legacyPath: string;
  state: ControlState;
  private db: DatabaseSync | undefined;
  private lockPath: string;
  private lockId = randomUUID();
  private lockTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saveDue = 0;
  private dirty = false;
  private closed = false;
  private persisted = new Map<Collection, Map<string, { position: number; json: string }>>();
  private persistedMeta = new Map<string, string>();
  private persistedSettings = '';
  private lastEventId: string | undefined;
  private lastMessageId: string | undefined;
  private terminalPending = new Map<string, { offset: number; data: string }>();
  private terminalTrimmed = new Map<string, number>();
  private importedTerminalLogs: string[] = [];
  private insertsSincePrune = 0;
  private statements: Record<string, StatementSync> = {};
  constructor(directory = defaultControlDataDir()) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'control.db'); this.settingsPath = join(this.directory, 'settings.json'); this.legacyPath = join(this.directory, 'state.json');
    this.lockPath = join(this.directory, SERVICE_LOCK_FILE);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.acquire();
    try {
      const fresh = !existsSync(this.path);
      this.db = openDatabase(this.path);
      this.db.exec(schema);
      // SQLite creates its files with the process umask; task text, prompts and terminal output stay private to the owner.
      for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) { try { chmodSync(file, 0o600); } catch { /* Not created yet, or a file system without POSIX modes. */ } }
      this.prepare();
      if (fresh && existsSync(this.legacyPath)) this.state = this.importLegacy();
      else { this.state = this.load(); this.normalize(); }
      if (fresh) { this.save(); this.finishImport(); }
      this.prune();
    } catch (error) { this.closed = true; this.close(true); throw error; }
  }
  private acquire(): void {
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, id: this.lockId })); } finally { closeSync(fd); }
      this.lockTimer = setInterval(() => { try { const now = new Date(); utimesSync(this.lockPath, now, now); } catch { /* Lock gone; close() handles it. */ } }, lockHeartbeatMs);
      this.lockTimer.unref();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number };
        if (!processAlive(lock.pid) || Date.now() - statSync(this.lockPath).mtimeMs > SERVICE_LOCK_STALE_MS) { unlinkSync(this.lockPath); this.acquire(); return; }
      } catch { /* An unreadable lock must be inspected, never silently stolen. */ }
      throw new ControlError(`Control data directory is already in use: ${this.directory}`, 409);
    }
  }
  /** Names the listening address in the lock, so `aiws control` finds this service on any port. Never includes the token. */
  advertise(url: string): void {
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, id: this.lockId, url }));
  }
  private prepare(): void {
    const db = this.db!;
    this.statements = {
      upsertRecord: db.prepare('INSERT INTO records (collection, id, position, parent_id, status, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET position = excluded.position, parent_id = excluded.parent_id, status = excluded.status, data = excluded.data'),
      deleteRecord: db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
      insertEvent: db.prepare('INSERT OR IGNORE INTO events (id, task_id, run_id, type, created_at, data) VALUES (?, ?, ?, ?, ?, ?)'),
      upsertMessage: db.prepare('INSERT INTO messages (id, task_id, run_id, created_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data'),
      deleteTaskEvents: db.prepare('DELETE FROM events WHERE task_id = ?'),
      deleteTaskMessages: db.prepare('DELETE FROM messages WHERE task_id = ?'),
      insertChunk: db.prepare('INSERT OR REPLACE INTO terminal_chunks (run_id, offset, data) VALUES (?, ?, ?)'),
      trimChunks: db.prepare('DELETE FROM terminal_chunks WHERE run_id = ? AND offset + length(data) <= ?'),
      deleteChunks: db.prepare('DELETE FROM terminal_chunks WHERE run_id = ?'),
      readChunks: db.prepare('SELECT offset, data FROM terminal_chunks WHERE run_id = ? ORDER BY offset'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      deleteMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    };
  }
  /** Reads the stored state; with track, it also becomes the baseline for the next save. */
  private load(track = true): ControlState {
    const db = this.db!, state = emptyControlState() as unknown as Record<string, unknown>;
    for (const name of collectionNames) {
      const rows = db.prepare('SELECT id, position, data FROM records WHERE collection = ? ORDER BY position').all(name) as Array<{ id: string; position: number; data: string }>;
      state[name] = rows.map((row) => JSON.parse(row.data) as unknown);
      if (track) this.persisted.set(name, new Map(rows.map((row) => [row.id, { position: row.position, json: row.data }])));
    }
    for (const row of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'state.%'").all() as Array<{ key: string; value: string }>) {
      state[row.key.slice(6)] = JSON.parse(row.value) as unknown; if (track) this.persistedMeta.set(row.key, row.value);
    }
    // The newest journal entries, bounded like the live journal.
    const events: ControlEvent[] = []; let characters = 0;
    for (const row of db.prepare('SELECT data FROM events ORDER BY seq DESC LIMIT ?').all(MEMORY_EVENTS) as Array<{ data: string }>) {
      const event = JSON.parse(row.data) as ControlEvent; characters += event.message.length;
      if (characters > MEMORY_EVENT_CHARACTERS && events.length) break; events.push(event);
    }
    state.events = events.reverse();
    state.messages = (db.prepare('SELECT data FROM messages ORDER BY seq DESC LIMIT ?').all(MEMORY_MESSAGES) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as TaskMessage).reverse();
    if (track) { this.lastEventId = (state.events as ControlEvent[]).at(-1)?.id; this.lastMessageId = (state.messages as TaskMessage[]).at(-1)?.id; }
    if (existsSync(this.settingsPath)) {
      const raw = readFileSync(this.settingsPath, 'utf8');
      try { state.settings = JSON.parse(raw) as ControlSettings; } catch { throw new Error(`Damaged control settings: ${this.settingsPath}`); }
      if (track) this.persistedSettings = raw;
    }
    return state as unknown as ControlState;
  }
  /** One-time import of the JSON state used before SQLite, including its terminal replays. */
  private importLegacy(): ControlState {
    const state = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as ControlState;
    if (state.schemaVersion !== 1 || !['projects', 'tasks', 'runs', 'questions', 'events'].every((key) => Array.isArray((state as unknown as Record<string, unknown>)[key]))) {
      throw new Error('Unsupported or damaged control state');
    }
    this.state = state; this.normalize();
    // Older versions duplicated every PTY chunk as an event.
    state.events = state.events.filter((event) => event.type !== 'terminal.output');
    for (const run of state.runs) {
      let output = typeof run.terminalOutput === 'string' ? run.terminalOutput : undefined;
      const log = join(this.directory, 'runs', run.id, 'terminal.log');
      if (output === undefined && existsSync(log)) { try { output = readFileSync(log, 'utf8'); this.importedTerminalLogs.push(log); } catch { /* Replays are best effort. */ } }
      if (!output) continue;
      const end = run.terminalLength ?? output.length;
      run.terminalOutput = output; run.terminalLength = end;
      this.terminalPending.set(run.id, { offset: end - output.length, data: output });
    }
    return state;
  }
  private finishImport(): void {
    if (existsSync(this.legacyPath)) renameSync(this.legacyPath, `${this.legacyPath}.pre-sqlite`);
    for (const log of this.importedTerminalLogs) { try { unlinkSync(log); } catch { /* Already gone. */ } }
    this.importedTerminalLogs = [];
    // Interrupted JSON saves of older versions.
    for (const name of readdirSync(this.directory)) if (/^\.state-.*\.tmp$/.test(name)) { try { unlinkSync(join(this.directory, name)); } catch { /* Keep. */ } }
  }
  private normalize(): void {
    const state = this.state;
    state.settings = normalizeSettings(state.settings);
    for (const project of [...state.projects, ...(state.generalWorkspace ? [state.generalWorkspace] : [])]) {
      if (project.providerSettings) delete (project.providerSettings as Record<string, unknown>).providerEnv;
      project.useWorktree ??= false; project.mainBranch ??= 'main';
      // Projects from before labels existed adopt the tags their tasks already use.
      if (!project.labels) { const tags: ProjectLabel[] = []; for (const task of (state.tasks ?? []).filter((item) => item.projectId === project.id)) for (const tag of task.tags ?? []) { try { tags.push(validateLabel({ name: tag })); } catch { /* Not a valid label name. */ } } project.labels = mergeLabels([], tags).labels; }
    }
    state.agents ??= []; state.skills ??= []; state.workflows ??= []; state.messages ??= []; state.plannerMessages ??= []; state.schedules ??= []; state.terminals ??= [];
    if (!Array.isArray(state.agents) || !Array.isArray(state.skills)) throw new Error('Damaged control agent or skill catalog');
  }
  /** Free-form values kept next to the state (outside the `state.` namespace, which save() owns). */
  getMeta(key: string): string | undefined { return this.db && !this.closed ? (this.statements.getMeta!.get(key) as { value: string } | undefined)?.value : undefined; }
  setMeta(key: string, value: string): void { if (this.db && !this.closed) this.statements.setMeta!.run(key, value); }
  deleteMeta(key: string): void { if (this.db && !this.closed) this.statements.deleteMeta!.run(key); }
  /** Replay for a run, loaded from the database on first use. */
  terminalOutput(run: Run): string {
    if (typeof run.terminalOutput !== 'string') {
      const chunks = this.db && !this.closed ? this.statements.readChunks!.all(run.id) as Array<{ offset: number; data: string }> : [];
      const pending = this.terminalPending.get(run.id);
      const output = (chunks.map((chunk) => chunk.data).join('') + (pending?.data ?? '')).slice(-TERMINAL_REPLAY_LIMIT);
      if (!run.finishedAt && !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) run.terminalOutput = output;
      return output;
    }
    return run.terminalOutput;
  }
  /** Appends a PTY chunk and returns its offset in the run's terminal stream. */
  appendTerminal(run: Run, data: string): number {
    const offset = appendReplay(run, this.terminalOutput(run), data);
    const pending = this.terminalPending.get(run.id);
    if (pending && pending.offset + pending.data.length === offset) pending.data += data;
    else this.terminalPending.set(run.id, { offset, data });
    this.schedule(1000);
    return offset;
  }
  private recordJson(name: Collection, item: Keyed): string {
    if (name !== 'runs' && name !== 'terminals') return JSON.stringify(item);
    // Replays are stored as chunks; the run or terminal row only keeps its metadata.
    const { terminalOutput: _output, ...run } = item;
    return JSON.stringify(run);
  }
  private unsaved<T extends { id: string }>(entries: T[], last: string | undefined): T[] {
    if (last) for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.id === last) return entries.slice(index + 1);
    return entries;
  }
  /** Writes every change since the previous save in one transaction. */
  save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.closed || !this.db) return;
    this.dirty = false;
    const db = this.db, statements = this.statements, state = this.state as unknown as Record<string, unknown>;
    const removedTasks: string[] = [], removedRuns: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of collectionNames) {
        const items = (state[name] ?? []) as Keyed[], known = this.persisted.get(name) ?? new Map<string, { position: number; json: string }>(), seen = new Set<string>();
        this.persisted.set(name, known);
        items.forEach((item, position) => {
          const json = this.recordJson(name, item), previous = known.get(item.id); seen.add(item.id);
          if (previous && previous.json === json && previous.position === position) return;
          const [parent, status] = collections[name](item) as [unknown, unknown];
          statements.upsertRecord!.run(name, item.id, position, typeof parent === 'string' ? parent : null, typeof status === 'string' ? status : null, json);
          known.set(item.id, { position, json });
        });
        for (const id of [...known.keys()]) if (!seen.has(id)) {
          statements.deleteRecord!.run(name, id); known.delete(id);
          if (name === 'tasks') removedTasks.push(id); if (name === 'runs' || name === 'terminals') removedRuns.push(id);
        }
      }
      // A deleted task takes its journal and replays with it.
      for (const taskId of removedTasks) { statements.deleteTaskEvents!.run(taskId); statements.deleteTaskMessages!.run(taskId); }
      for (const runId of removedRuns) { statements.deleteChunks!.run(runId); this.terminalPending.delete(runId); this.terminalTrimmed.delete(runId); }
      const events = this.unsaved(this.state.events, this.lastEventId);
      for (const event of events) statements.insertEvent!.run(event.id, event.taskId, event.runId, event.type, event.createdAt, JSON.stringify(event));
      if (events.length) this.lastEventId = events.at(-1)!.id;
      this.insertsSincePrune += events.length;
      const messages = this.unsaved(this.state.messages, this.lastMessageId);
      for (const message of messages) statements.upsertMessage!.run(message.id, message.taskId, message.runId, message.createdAt, JSON.stringify(message));
      if (messages.length) this.lastMessageId = messages.at(-1)!.id;
      for (const [runId, chunk] of this.terminalPending) {
        statements.insertChunk!.run(runId, chunk.offset, chunk.data);
        // Keep about one replay of history per run; trim in quarter-replay steps.
        const keepFrom = chunk.offset + chunk.data.length - TERMINAL_REPLAY_LIMIT;
        if (keepFrom - (this.terminalTrimmed.get(runId) ?? 0) > TERMINAL_REPLAY_LIMIT / 4) { statements.trimChunks!.run(runId, keepFrom); this.terminalTrimmed.set(runId, keepFrom); }
      }
      this.terminalPending.clear();
      for (const run of [...this.state.runs, ...this.state.terminals]) if (run.terminalOutput !== undefined && (run.finishedAt || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))) delete run.terminalOutput;
      const meta = new Map<string, string>();
      for (const [key, value] of Object.entries(state)) if (!listedKeys.has(key) && value !== undefined) meta.set(`state.${key}`, JSON.stringify(value));
      for (const [key, value] of meta) if (this.persistedMeta.get(key) !== value) { statements.setMeta!.run(key, value); this.persistedMeta.set(key, value); }
      for (const key of [...this.persistedMeta.keys()]) if (!meta.has(key)) { statements.deleteMeta!.run(key); this.persistedMeta.delete(key); }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* The transaction already ended. */ }
      // The next save rewrites everything that may have been lost.
      this.persisted.clear(); this.persistedMeta.clear(); this.lastEventId = undefined; this.lastMessageId = undefined; this.dirty = true;
      throw error;
    }
    const settings = JSON.stringify(this.state.settings, null, 2);
    if (settings !== this.persistedSettings) { writeAtomically(this.settingsPath, settings); this.persistedSettings = settings; }
    if (this.insertsSincePrune > 5000) this.prune();
  }
  /** The on-disk event history is bounded, though far beyond the in-memory journal. */
  private prune(): void {
    this.insertsSincePrune = 0;
    this.db?.prepare('DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)').run(STORED_EVENTS);
  }
  /** Coalesce bursts of mutations into one write. */
  scheduleSave(delay = 150): void {
    this.dirty = true; this.schedule(delay);
  }
  private schedule(delay: number): void {
    if (this.closed) return;
    const due = Date.now() + delay;
    if (this.saveTimer && this.saveDue <= due) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; try { if (!this.dirty && this.terminalPending.size) this.saveTerminal(); else this.save(); } catch (error) { process.emitWarning(`AIWS control state could not be saved: ${(error as Error).message}`); this.schedule(1000); } }, delay);
  }
  /** Writes pending terminal chunks and their run offsets without re-serializing unrelated collections. */
  private saveTerminal(): void {
    if (this.closed || !this.db || !this.terminalPending.size) return;
    const db = this.db, statements = this.statements;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [runId, chunk] of this.terminalPending) {
        statements.insertChunk!.run(runId, chunk.offset, chunk.data);
        const keepFrom = chunk.offset + chunk.data.length - TERMINAL_REPLAY_LIMIT;
        if (keepFrom - (this.terminalTrimmed.get(runId) ?? 0) > TERMINAL_REPLAY_LIMIT / 4) { statements.trimChunks!.run(runId, keepFrom); this.terminalTrimmed.set(runId, keepFrom); }
        // The chunk belongs to a task run or a project terminal; its row carries the new stream length.
        for (const name of ['runs', 'terminals'] as const) {
          const items = this.state[name] as unknown as Keyed[], known = this.persisted.get(name), position = items.findIndex((item) => item.id === runId);
          if (position < 0 || !known) continue;
          const item = items[position]!, json = this.recordJson(name, item), previous = known.get(runId);
          if (!previous || previous.json !== json || previous.position !== position) {
            const [parent, status] = collections[name](item);
            statements.upsertRecord!.run(name, runId, position, typeof parent === 'string' ? parent : null, typeof status === 'string' ? status : null, json);
            known.set(runId, { position, json });
          }
        }
      }
      this.terminalPending.clear();
      for (const run of [...this.state.runs, ...this.state.terminals]) if (run.terminalOutput !== undefined && (run.finishedAt || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))) delete run.terminalOutput;
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* The transaction already ended. */ }
      this.persisted.clear(); this.persistedMeta.clear(); this.lastEventId = undefined; this.lastMessageId = undefined; this.dirty = true;
      throw error;
    }
  }
  /** Writes pending changes now. */
  flush(): Promise<void> {
    if (this.saveTimer || this.dirty || this.terminalPending.size) this.save();
    return Promise.resolve();
  }
  /** The state as stored on disk (database and settings file). */
  readPersisted(): ControlState { if (!this.db) throw new Error('Control store is closed.'); return this.load(false); }
  /** The raw stored content, for verifying that an operation wrote nothing. */
  persistedSnapshot(): string {
    if (!this.db) return '';
    const tables = ['meta', 'records', 'events', 'messages', 'terminal_chunks'].map((table) => this.db!.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
    return JSON.stringify([tables, existsSync(this.settingsPath) ? readFileSync(this.settingsPath, 'utf8') : null]);
  }
  snapshot(): ControlState { return structuredClone(this.state); }
  close(failed = false): void {
    if (!failed && !this.closed && this.state) { try { this.save(); } catch { /* Keep releasing the lock. */ } }
    this.closed = true;
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = undefined; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    try { this.db?.close(); } catch { /* Already closed. */ }
    this.db = undefined;
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { id: string };
      if (lock.id === this.lockId) unlinkSync(this.lockPath);
    } catch { /* Already released. */ }
  }
}
