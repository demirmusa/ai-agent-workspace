import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { opendir, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { aiProviders } from './ai-providers/index.js';
import { isPathInside, pathKey } from '../shared/core/paths.js';
import { HISTORY_LIMITS, containsMarker, contentText, firstPublicUser, historyPagination, metaIdentity, publicUserText, resumesAgentTurn, sessionMeta, stamp, titleText } from './history-records.js';
import { readTranscriptPage } from './history-transcript.js';
import { UUID, isUnlinkedFile, jsonRows, openReadOnly, readRange } from './source-files.js';
import { ControlError, type AgentExecutionStatus, type HistoricalSession, type HistoryProvider, type Project, type RunExecutionInfo, type SessionHistoryPage, type SessionHistoryDetail, type SessionHistorySort } from './types.js';

export { HISTORY_LIMITS, codexToolInput, toolActivity } from './history-records.js';
export interface HistoryOptions { codexHome?: string; claudeHome?: string }
/** `managed`: a session AIWS launched for one of its runs, read without the project cwd filter. */
export interface HistoryPointer { session: HistoricalSession; path: string; root: string; related?: boolean; managed?: boolean; childAgentId?: string; startOrdinal?: number }
type Pointer = HistoryPointer;
interface Index { expires: number; pointers: Pointer[]; warnings: string[] }
const SORTS: readonly SessionHistorySort[] = ['recent', 'oldest', 'created'];
/** A source verified this recently and unchanged since (same size and times) is not re-read by the next check. */
const VERIFIED_MS = 5000;
const CHANGED = 'Session source changed, moved outside this project, or became unavailable. Refresh Sessions before continuing.';
/** Case, accent and Turkish dotted/dotless i insensitive; search terms are matched as substrings. */
const searchable = (value: string): string => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').toLowerCase().replace(/\s+/g, ' ');
function searchTerms(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > HISTORY_LIMITS.searchCharacters) throw new ControlError(`History search must be at most ${HISTORY_LIMITS.searchCharacters} characters.`);
  return [...new Set(searchable(value).split(' ').filter(Boolean))].slice(0, HISTORY_LIMITS.searchTerms);
}
const historyId = (provider: HistoryProvider, sessionId: string, cwd: string): string => `hist_${createHash('sha256').update(`${provider}\0${sessionId}\0${pathKey(cwd)}`).digest('hex').slice(0, 40)}`;
const rowCwd = (row: any): unknown => row.cwd ?? (row.type === 'turn_context' ? row.payload?.cwd : undefined);
/** Every folder a source names: its metadata cwd and the cwd of each tail record. */
function sourceFolders(pointer: Pointer, head: any[], tail: any[]): string[] {
  const folders = [metaIdentity(sessionMeta(head, pointer.session.provider, false), pointer.session.provider).cwd, ...tail.map(rowCwd)];
  return [...new Set(folders.filter((value): value is string => typeof value === 'string'))];
}
/**
 * A source belongs to `cwd` when its metadata names the session and that folder, and every later record's folder lies
 * inside it. Working in a project subfolder is normal; folders are compared as real paths so /cd and links cannot
 * restore another project. `real` maps each folder to its real path (null when it is unavailable).
 */
function sourceMatches(pointer: Pointer, cwd: string, head: any[], tail: any[], real: Map<string, string | null>): boolean {
  const { sessionId, cwd: sourceCwd } = metaIdentity(sessionMeta(head, pointer.session.provider, false), pointer.session.provider);
  if (sessionId !== pointer.session.sessionId || typeof sourceCwd !== 'string' || pathKey(real.get(sourceCwd) ?? '') !== pathKey(cwd)) return false;
  return tail.every((row) => { const path = rowCwd(row); if (typeof path !== 'string') return true; const folder = real.get(path); return Boolean(folder) && isPathInside(pathKey(cwd), pathKey(folder!)); });
}

/** Read-only adapters for installed CLI JSONL transcripts. Never reads auth/config files. */
export class SessionHistory {
  private roots: Record<HistoryProvider, string>;
  private indexes = new Map<string, Index>();
  private pending = new Map<string, Promise<Index>>();
  private titles: { fingerprint: string; values: Map<string, string> } | undefined;
  private titleLoading: Promise<Map<string, string>> | undefined;
  private hydrated = new WeakSet<Pointer>();
  private haystacks = new WeakMap<Pointer, { source: string; text: string }>();
  private verified = new WeakMap<Pointer, { fingerprint: string; cwd: string; at: number }>();
  constructor(options: HistoryOptions = {}) {
    this.roots = { codex: resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')), claude: resolve(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) };
  }
  home(provider: HistoryProvider): string { return this.roots[provider]; }
  /** Opens a verified source; `read` receives the open file and its size. */
  private async withSource<T>(pointer: Pointer, read: (file: FileHandle, size: number) => Promise<T>): Promise<T> {
    await this.verify(pointer, pointer.session.cwd);
    const file = await openReadOnly(pointer.path);
    try { return await read(file, (await file.stat()).size); } finally { await file.close(); }
  }
  /** Hydrate only visible/selected sources; large provider setup records need not fit the metadata prefix. */
  private async hydrateFirstUser(pointer: HistoryPointer): Promise<void> {
    if (pointer.session.firstUserMessage) return;
    await this.withSource(pointer, async (file, size) => {
      const message = firstPublicUser(jsonRows((await readRange(file, 0, Math.min(size, HISTORY_LIMITS.firstUserBytes))).toString('utf8')), pointer.session.provider);
      if (message) { pointer.session.firstUserMessage = message.slice(0, 100000); pointer.session.title = titleText(message); }
    });
  }
  /** Only execution labels are exposed; prompts, config and reasoning content stay private. */
  async executionInfo(pointer: HistoryPointer): Promise<RunExecutionInfo> {
    const info: RunExecutionInfo = { cwd: pointer.session.cwd };
    return this.withSource(pointer, async (file, size) => {
      const read = async (start: number, length: number) => jsonRows((await readRange(file, start, length)).toString('utf8'), start > 0);
      const budget = 2 * 1024 * 1024;
      const rows = await read(0, Math.min(size, budget));
      if (size > budget) rows.push(...await read(Math.max(budget, size - budget), Math.min(size - budget, budget)));
      for (const row of rows) {
        if (row.sessionId && row.sessionId !== pointer.session.sessionId) continue;
        if (pointer.session.provider === 'codex' && row.type === 'session_meta' && row.payload?.id === pointer.session.sessionId && typeof row.payload?.git?.branch === 'string') info.branch = row.payload.git.branch.slice(0, 500);
        const context = pointer.session.provider === 'codex' && row.type === 'turn_context' ? row.payload : undefined;
        const model = context?.model ?? (pointer.session.provider === 'claude' && row.type === 'assistant' && !row.isSidechain ? row.message?.model : undefined);
        if (typeof model === 'string' && model.length <= 200) { info.model = model; info.modelSource = 'reported'; }
        const effort = context?.effort ?? context?.reasoning_effort;
        if (typeof effort === 'string' && effort.length <= 100) info.reasoningEffort = effort;
      }
      return info;
    });
  }
  /** Native Codex thread names (/rename); null when the index is missing or unsafe. */
  private async codexTitles(): Promise<Map<string, string> | null> {
    const path = join(this.roots.codex, 'session_index.jsonl'); let fingerprint = '';
    try { const stat = await lstat(path); if (stat.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path)) return null; fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; } catch { return null; }
    if (this.titles?.fingerprint === fingerprint) return this.titles.values;
    if (!this.titleLoading) this.titleLoading = (async () => {
      const values = new Map<string, string>(); let file;
      try {
        file = await openReadOnly(path); const size = (await file.stat()).size; const length = Math.min(size, 4 * 1024 * 1024);
        for (const row of jsonRows((await readRange(file, size - length, length)).toString('utf8'), size > length)) { const name = titleText(row.thread_name); if (UUID.test(row.id ?? '') && name) values.set(row.id, name); }
        this.titles = { fingerprint, values };
      } catch { /* Older provider installs may not have a session-name index. */ } finally { await file?.close(); }
      return values;
    })().finally(() => { this.titleLoading = undefined; });
    return this.titleLoading;
  }
  /**
   * Canonical provider names, never raw TUI escape sequences: a native /rename first, then the title the provider
   * generated itself (Claude Code `ai-title`), and only then the first user message. Read fresh on every call so a
   * rename made outside AIWS shows up the next time the list loads.
   */
  async canonicalTitle(pointer: HistoryPointer): Promise<string> {
    await this.hydrateFirstUser(pointer);
    if (pointer.session.provider === 'codex') return (await this.codexTitles())?.get(pointer.session.sessionId) ?? pointer.session.title;
    try {
      return await this.withSource(pointer, async (file, size) => {
        const length = Math.min(size, 2 * 1024 * 1024); let custom = '', generated = '';
        for (const row of jsonRows((await readRange(file, size - length, length)).toString('utf8'), size > length)) {
          if (row.sessionId !== pointer.session.sessionId) continue;
          if (row.type === 'custom-title') custom = titleText(row.customTitle) || custom;
          else if (row.type === 'ai-title') generated = titleText(row.aiTitle) || generated;
        }
        return custom || generated || pointer.session.title;
      });
    } catch { return pointer.session.title; }
  }
  // A task's removed worktree keeps its sessions under the recorded folder, so only the project listing requires the folder.
  private async scope(project: Project, strict = false): Promise<string> {
    try { return await realpath(project.repositoryPath); } catch { if (strict) throw new ControlError('Project folder is unavailable. Restore it before opening its sessions.', 409); return resolve(project.repositoryPath); }
  }
  private async index(project: Project, refresh = false, strict = false): Promise<Index> {
    const cwd = await this.scope(project, strict); const cacheKey = pathKey(cwd); const previous = this.indexes.get(cacheKey);
    if (previous && previous.expires > Date.now() && (!refresh || previous.expires - 28000 > Date.now())) return previous;
    const active = this.pending.get(cacheKey); if (active) return active;
    const promise = this.scan(cwd).then((index) => { if (this.indexes.size >= 100) this.indexes.delete(this.indexes.keys().next().value!); this.indexes.set(cacheKey, index); return index; }).finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, promise); return promise;
  }
  /**
   * Search covers every indexed root session of the project, not only loaded pages:
   * title (including native Codex names), the first public user message and the session ID.
   * Order is fixed at scan time so cursors stay stable while visible rows are hydrated.
   */
  async list(project: Project, query: { provider?: unknown; limit?: unknown; cursor?: unknown; refresh?: unknown; q?: unknown; sort?: unknown } = {}, options: { subagents?: (pointer: HistoryPointer) => Promise<number> } = {}): Promise<SessionHistoryPage> {
    if (query.provider !== undefined && query.provider !== '' && !aiProviders.isHistoryProvider(query.provider)) throw new ControlError('History provider must be codex or claude.');
    const sort = query.sort === undefined || query.sort === '' ? 'recent' : String(query.sort) as SessionHistorySort;
    if (!SORTS.includes(sort)) throw new ControlError('History sort must be recent, oldest or created.');
    const terms = searchTerms(query.q); const { count, offset } = historyPagination(query.limit, query.cursor, 30, 100); const index = await this.index(project, query.refresh === '1' || query.refresh === true, true);
    const matched = terms.length ? await this.search(index.pointers, terms) : index.pointers;
    const counts: Record<HistoryProvider, number> = { codex: 0, claude: 0 }; for (const item of matched) counts[item.session.provider]++;
    const filtered = matched.filter((item) => !query.provider || item.session.provider === query.provider);
    const items = sort === 'oldest' ? [...filtered].reverse() : sort === 'created' ? [...filtered].sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt) || a.session.id.localeCompare(b.session.id)) : filtered;
    const page = await Promise.all(items.slice(offset, offset + count).map(async (pointer) => { const status = await this.sourceStatus(pointer); const title = await this.canonicalTitle(pointer); const subagents = options.subagents ? await options.subagents(pointer).catch(() => 0) : 0; return { ...pointer.session, title, status, ...(subagents ? { subagentCount: subagents } : {}) }; }));
    return { items: structuredClone(page), nextCursor: offset + count < items.length ? String(offset + count) : null, total: items.length, counts, warnings: [...index.warnings] };
  }
  private async search(pointers: Pointer[], terms: string[]): Promise<Pointer[]> {
    // Large provider setup records can push the first request past the scan prefix.
    // Read those once per index generation, in small bounded batches.
    const missing = pointers.filter((pointer) => !pointer.session.firstUserMessage && !this.hydrated.has(pointer)).slice(0, HISTORY_LIMITS.searchHydrate);
    for (let start = 0; start < missing.length; start += 8) await Promise.all(missing.slice(start, start + 8).map(async (pointer) => { this.hydrated.add(pointer); try { await this.hydrateFirstUser(pointer); } catch { /* Unreadable sources stay searchable by title and ID. */ } }));
    const names = pointers.some((pointer) => pointer.session.provider === 'codex') ? await this.codexTitles() : null;
    return pointers.filter((pointer) => {
      const title = (pointer.session.provider === 'codex' ? names?.get(pointer.session.sessionId) : undefined) ?? pointer.session.title;
      let cached = this.haystacks.get(pointer);
      const source = `${title}\0${pointer.session.firstUserMessage?.length ?? 0}`;
      if (!cached || cached.source !== source) { cached = { source, text: searchable(`${title}\n${(pointer.session.firstUserMessage ?? '').slice(0, HISTORY_LIMITS.searchText)}\n${pointer.session.sessionId}`) }; this.haystacks.set(pointer, cached); }
      const text = cached.text; return terms.every((term) => text.includes(term));
    });
  }
  async resolve(project: Project, sourceId: string): Promise<Pointer> {
    if (!/^hist_[a-f0-9]{40}$/.test(sourceId)) throw new ControlError('Invalid historical session ID.');
    const index = await this.index(project); let pointer = index.pointers.find((item) => item.session.id === sourceId);
    if (!pointer) pointer = (await this.index(project, true)).pointers.find((item) => item.session.id === sourceId);
    if (!pointer) throw new ControlError('Session not found in this project. Refresh sessions or restore the original history file.', 404);
    await this.verify(pointer, await this.scope(project)); pointer.session.title = await this.canonicalTitle(pointer); pointer.session.status = await this.sourceStatus(pointer); return pointer;
  }
  async findSession(project: Project, provider: HistoryProvider, sessionId: string): Promise<Pointer | null> {
    let index = await this.index(project); let pointer = index.pointers.find((item) => item.session.provider === provider && item.session.sessionId === sessionId);
    if (!pointer) { index = await this.index(project, true); pointer = index.pointers.find((item) => item.session.provider === provider && item.session.sessionId === sessionId); }
    if (!pointer) return null;
    // A cached source can disappear or leave the project between scans. Match a
    // fresh scan's missing result so callers can use their continuation fallback.
    try { await this.verify(pointer, await this.scope(project)); return pointer; } catch { return null; }
  }
  async findBootstrap(project: Project, provider: HistoryProvider, marker: string, startedAt: string): Promise<{ pointer: HistoryPointer | null; ambiguous: boolean }> {
    const index = await this.index(project, true); const matches: Pointer[] = []; const cwd = await this.scope(project);
    const candidates = index.pointers.filter((entry) => entry.session.provider === provider && Date.parse(entry.session.createdAt) >= Date.parse(startedAt) - 5000);
    // Never declare a unique identity after examining only a budget-limited subset.
    if (candidates.length > 32) return { pointer: null, ambiguous: true };
    for (const pointer of candidates) {
      let file;
      try {
        await this.verify(pointer, cwd); file = await openReadOnly(pointer.path);
        if (containsMarker(jsonRows((await readRange(file, 0, 512 * 1024)).toString('utf8')), provider, marker)) matches.push(pointer);
      } catch { /* Only a complete exact marker match can bind a managed run. */ } finally { await file?.close(); }
      if (matches.length > 1) return { pointer: null, ambiguous: true };
    }
    return { pointer: matches[0] ?? null, ambiguous: false };
  }
  /**
   * Locates the native session AIWS launched for one of its own runs. Unlike project
   * history this still works after the run's worktree was removed or the agent changed
   * into a subfolder: identity is proven by the session ID, or by the run's unique
   * bootstrap marker, in a file directly under the provider's session store.
   */
  async findRunSession(provider: HistoryProvider, workspace: string, identity: { sessionId?: string; marker?: string; startedAt: string }): Promise<{ pointer: HistoryPointer | null; ambiguous: boolean }> {
    const root = this.roots[provider]; const cwd = resolve(workspace); const sessionId = identity.sessionId && UUID.test(identity.sessionId) ? identity.sessionId : undefined;
    if (!sessionId && !identity.marker) return { pointer: null, ambiguous: false };
    const since = Date.parse(identity.startedAt) - 5000; const candidates: string[] = [];
    const listing = async (directory: string): Promise<Array<{ name: string; directory: boolean }>> => {
      try { if ((await lstat(directory)).isSymbolicLink()) return []; const handle = await opendir(directory); const entries = []; for await (const entry of handle) { if (!entry.isSymbolicLink()) entries.push({ name: entry.name, directory: entry.isDirectory() }); if (entries.length >= HISTORY_LIMITS.entries) break; } return entries; } catch { return []; }
    };
    const recent = async (path: string): Promise<boolean> => { try { return (await lstat(path)).mtimeMs >= since; } catch { return false; } };
    if (provider === 'claude') {
      // Claude names a project folder after its cwd with every non-alphanumeric character replaced; long paths get a suffix.
      const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-'); const projects = join(root, 'projects');
      const folders = (await listing(projects)).filter((entry) => entry.directory && (sessionId || pathKey(entry.name) === pathKey(folder) || folder.length > 200 && pathKey(entry.name).startsWith(pathKey(folder.slice(0, 200))))).map((entry) => entry.name);
      folders.sort((a, b) => Number(pathKey(b) === pathKey(folder)) - Number(pathKey(a) === pathKey(folder)));
      for (const name of folders) {
        if (sessionId) { const path = join(projects, name, `${sessionId}.jsonl`); try { if ((await lstat(path)).isFile()) candidates.push(path); } catch { /* Not in this folder. */ } continue; }
        for (const entry of await listing(join(projects, name))) if (!entry.directory && entry.name.endsWith('.jsonl') && UUID.test(entry.name.slice(0, -6)) && await recent(join(projects, name, entry.name))) candidates.push(join(projects, name, entry.name));
      }
    } else {
      // Codex rollouts live under sessions/YYYY/MM/DD (local date); check the days around the run start.
      const start = Number.isFinite(since) ? since : Date.now(); const days = new Set<string>();
      for (let offset = -1; offset <= 2; offset++) { const day = new Date(start + offset * 86_400_000); days.add(join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))); }
      for (const folder of ['sessions', 'archived_sessions']) for (const day of days) for (const entry of await listing(join(root, folder, day))) {
        const path = join(root, folder, day, entry.name);
        if (!entry.directory && entry.name.endsWith('.jsonl') && (sessionId ? entry.name.includes(sessionId) : await recent(path))) candidates.push(path);
      }
    }
    // Never declare a unique identity after examining only a budget-limited subset.
    if (!sessionId && candidates.length > 32) return { pointer: null, ambiguous: true };
    const matches: HistoryPointer[] = [];
    for (const path of candidates) {
      let file;
      try {
        if (!await isUnlinkedFile(path, root)) continue;
        file = await openReadOnly(path); const stat = await file.stat();
        const rows = jsonRows((await readRange(file, 0, Math.min(stat.size, HISTORY_LIMITS.firstUserBytes))).toString('utf8'));
        const meta = sessionMeta(rows, provider); const { sessionId: id, cwd: sourceCwd } = metaIdentity(meta, provider);
        if (typeof id !== 'string' || !UUID.test(id) || sessionId && id.toLowerCase() !== sessionId.toLowerCase() || typeof sourceCwd !== 'string' || !isAbsolute(sourceCwd) || !isPathInside(pathKey(cwd), pathKey(resolve(sourceCwd)))) continue;
        if (provider === 'codex' && meta?.payload?.source?.subagent) continue;
        if (!sessionId && !containsMarker(rows, provider, identity.marker!)) continue;
        const title = firstPublicUser(rows, provider); const updatedAt = stat.mtime.toISOString();
        const session: HistoricalSession = { id: historyId(provider, id, cwd), provider, sessionId: id, title: titleText(title) || `${aiProviders.require(provider).name} · ${id.slice(0, 8)}`, cwd, createdAt: stamp(meta.timestamp ?? meta.payload?.timestamp, updatedAt), updatedAt, canResume: false };
        matches.push({ session, path, root, managed: true });
      } catch { /* Unreadable candidates cannot prove identity. */ } finally { await file?.close(); }
      if (sessionId && matches.length) break;
      if (matches.length > 1) return { pointer: null, ambiguous: true };
    }
    return { pointer: matches[0] ?? null, ambiguous: false };
  }
  /** Synchronous proof, at the moment a run starts, that a session the user picked can still be resumed. */
  assertResume(project: Project, sourceId: string, sessionId: string): void {
    let cwd: string; try { cwd = realpathSync.native(project.repositoryPath); } catch { cwd = resolve(project.repositoryPath); }
    const pointer = this.indexes.get(pathKey(cwd))?.pointers.find((item) => item.session.id === sourceId && item.session.sessionId === sessionId);
    if (!pointer) { void this.index(project, true).catch(() => {}); throw new ControlError('Session index is refreshing. Wait a moment or refresh Sessions before continuing.', 409); }
    try {
      if (pathKey(realpathSync.native(pointer.path)) !== pathKey(pointer.path) || !isPathInside(pointer.root, pointer.path)) throw new Error();
      for (let current = pointer.path; isPathInside(pointer.root, current); current = resolve(current, '..')) { if (lstatSync(current).isSymbolicLink()) throw new Error(); if (current === pointer.root) break; }
      if (!lstatSync(pointer.path).isFile() || pathKey(pointer.session.cwd) !== pathKey(cwd)) throw new Error();
      const fd = openSync(pointer.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const size = fstatSync(fd).size, read = (start: number, length: number): any[] => { const buffer = Buffer.alloc(length); return jsonRows(buffer.subarray(0, readSync(fd, buffer, 0, length, start)).toString('utf8')); };
        const head = read(0, Math.min(size, HISTORY_LIMITS.firstUserBytes)), tail = read(Math.max(0, size - HISTORY_LIMITS.prefixBytes), Math.min(size, HISTORY_LIMITS.prefixBytes));
        const real = new Map(sourceFolders(pointer, head, tail).map((folder): [string, string | null] => { try { return [folder, realpathSync.native(folder)]; } catch { return [folder, null]; } }));
        if (!sourceMatches(pointer, cwd, head, tail, real)) throw new Error();
      } finally { closeSync(fd); }
    } catch { throw new ControlError(CHANGED, 409); }
  }
  /** Proves a source still is an unlinked file of its provider store that belongs to `cwd`; `head` reuses rows already read from its start. */
  private async verify(pointer: Pointer, cwd: string, head?: any[]): Promise<void> {
    if (pathKey(pointer.session.cwd) !== pathKey(cwd) || !await isUnlinkedFile(pointer.path, pointer.root)) throw new ControlError(CHANGED, 409);
    let file: FileHandle | undefined;
    try {
      file = await openReadOnly(pointer.path); const stat = await file.stat(); const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, key = pathKey(cwd);
      const known = this.verified.get(pointer); if (known && known.fingerprint === fingerprint && known.cwd === key && Date.now() - known.at < VERIFIED_MS) return;
      const first = head ?? jsonRows((await readRange(file, 0, Math.min(stat.size, HISTORY_LIMITS.firstUserBytes))).toString('utf8'));
      const tailLength = Math.min(stat.size, HISTORY_LIMITS.prefixBytes); const tail = jsonRows((await readRange(file, stat.size - tailLength, tailLength)).toString('utf8'));
      const real = new Map(await Promise.all(sourceFolders(pointer, first, tail).map(async (folder): Promise<[string, string | null]> => [folder, await realpath(folder).catch(() => null)])));
      if (!sourceMatches(pointer, cwd, first, tail, real)) throw new Error();
      this.verified.set(pointer, { fingerprint, cwd: key, at: Date.now() });
    } catch { throw new ControlError(CHANGED, 409); } finally { await file?.close(); }
  }
  /** Source lookup for a proven live process; no arbitrary source file path is accepted. */
  async discover(identities: Array<{ provider: HistoryProvider; sessionId: string }>): Promise<HistoryPointer[]> {
    const selected = new Set(identities.filter((item) => UUID.test(item.sessionId)).map((item) => `${item.provider}:${item.sessionId}`));
    if (!selected.size) return [];
    const index = await this.scan(undefined, selected); return index.pointers;
  }
  async activity(pointer: HistoryPointer): Promise<'working' | 'idle' | 'unknown'> {
    const status = await this.sourceStatus(pointer); return status === 'running' ? 'working' : ['completed', 'interrupted', 'failed', 'stopped'].includes(status) ? 'idle' : 'unknown';
  }
  /** Last explicit provider turn lifecycle; process ownership is a separate fact. */
  async sourceStatus(pointer: HistoryPointer): Promise<AgentExecutionStatus> {
    return this.withSource(pointer, async (file, size) => {
      const length = Math.min(size, 2 * 1024 * 1024); const rows = jsonRows((await readRange(file, size - length, length)).toString('utf8'), size > length);
      const lastTimestamp = rows.map((row) => stamp(row.timestamp, '')).filter(Boolean).at(-1); if (lastTimestamp && lastTimestamp > pointer.session.updatedAt) pointer.session.updatedAt = lastTimestamp;
      for (const row of rows.reverse()) {
        if (pointer.session.provider === 'codex') {
          if (row.type === 'turn.completed' || row.type === 'event_msg' && row.payload?.type === 'task_complete') return 'completed';
          if (row.type === 'turn.started' || row.type === 'event_msg' && row.payload?.type === 'task_started') return 'running';
          if (row.type === 'turn.failed' || row.type === 'event_msg' && row.payload?.type === 'error') return 'failed';
          if (row.type === 'event_msg' && row.payload?.type === 'turn_aborted') return 'interrupted';
        } else {
          if (row.type === 'result') return row.is_error ? 'failed' : 'completed';
          if (row.type === 'assistant' && ['end_turn', 'stop_sequence', 'max_tokens'].includes(row.message?.stop_reason)) return 'completed';
          if (row.type === 'system' && row.subtype === 'turn_duration') return 'completed';
          if (row.type === 'user' && !row.isMeta && !row.isSidechain) { const text = contentText(row.message?.content); if (publicUserText(text).trim() || resumesAgentTurn(text)) return 'running'; }
        }
      }
      return 'unknown';
    });
  }
  private async scan(cwd?: string, selected?: Set<string>): Promise<Index> {
    const pointers: Pointer[] = []; const warnings = new Set<string>(); let files = 0, entries = 0, bytes = 0;
    const visit = async (directory: string, root: string, provider: HistoryProvider, depth: number): Promise<void> => {
      if (depth > 5 || entries >= HISTORY_LIMITS.entries || files >= HISTORY_LIMITS.files || bytes >= HISTORY_LIMITS.scanBytes) { warnings.add('History scan reached its safety limit; some older sessions may be omitted.'); return; }
      let children; try { const handle = await opendir(directory); children = []; for await (const entry of handle) { children.push(entry); if (children.length >= HISTORY_LIMITS.entries) break; } } catch { return; }
      children.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of children) {
        if (++entries > HISTORY_LIMITS.entries || files >= HISTORY_LIMITS.files || bytes >= HISTORY_LIMITS.scanBytes) { warnings.add('History scan reached its safety limit; some older sessions may be omitted.'); break; }
        if (entry.isSymbolicLink()) continue; const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (provider === 'codex' || depth === 0) await visit(path, root, provider, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue; files++;
        if (selected && ![...selected].some((identity) => identity.startsWith(`${provider}:`) && entry.name.includes(identity.slice(provider.length + 1)))) continue;
        let file;
        try {
          if (await realpath(path) !== path) continue;
          const stat = await lstat(path); const amount = Math.min(stat.size, HISTORY_LIMITS.prefixBytes, HISTORY_LIMITS.scanBytes - bytes); if (!amount) continue;
          file = await openReadOnly(path); let head = await readRange(file, 0, amount); bytes += head.length;
          let rows = jsonRows(head.toString('utf8')); let meta = sessionMeta(rows, provider);
          // Claude can put cwd/session metadata on a large initial setup record;
          // Codex base instructions can also exceed the normal metadata prefix.
          if (!meta && stat.size > head.length && head.length < HISTORY_LIMITS.firstUserBytes && bytes < HISTORY_LIMITS.scanBytes) {
            const rest = await readRange(file, head.length, Math.min(stat.size - head.length, HISTORY_LIMITS.firstUserBytes - head.length, HISTORY_LIMITS.scanBytes - bytes)); bytes += rest.length;
            head = Buffer.concat([head, rest]); rows = jsonRows(head.toString('utf8')); meta = sessionMeta(rows, provider);
          }
          if (provider === 'codex' && meta?.payload?.source?.subagent) continue;
          const { sessionId, cwd: sourceCwd } = metaIdentity(meta, provider);
          if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof sourceCwd !== 'string') continue;
          if (selected && !selected.has(`${provider}:${sessionId}`)) continue;
          let actualCwd: string; try { actualCwd = await realpath(sourceCwd); } catch { continue; } if (cwd && pathKey(actualCwd) !== pathKey(cwd)) continue;
          const title = firstPublicUser(rows, provider);
          const timestamp = stat.mtime.toISOString(); const id = historyId(provider, sessionId, actualCwd);
          const session: HistoricalSession = { id, provider, sessionId, title: titleText(title) || `${aiProviders.require(provider).name} · ${sessionId.slice(0, 8)}`, ...(title.trim() ? { firstUserMessage: title.slice(0, 100000) } : {}), cwd: actualCwd, createdAt: stamp(meta.timestamp ?? meta.payload?.timestamp, timestamp), updatedAt: timestamp, canResume: true };
          const pointer = { session, path, root }; try { await this.verify(pointer, actualCwd, rows); } catch { continue; }
          if (selected) session.title = await this.canonicalTitle(pointer);
          const duplicate = pointers.findIndex((item) => item.session.id === id); if (duplicate < 0) pointers.push(pointer); else if (pointers[duplicate]!.session.updatedAt < timestamp) pointers[duplicate] = pointer;
        } catch { warnings.add('Some unreadable or unsupported history files were skipped.'); } finally { await file?.close(); }
      }
    };
    for (const provider of ['codex', 'claude'] as const) {
      const root = this.roots[provider];
      try { if ((await lstat(root)).isSymbolicLink() || pathKey(await realpath(root)) !== pathKey(root)) { warnings.add(`${provider} history root cannot be a symbolic link.`); continue; } } catch { continue; }
      for (const folder of provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']) {
        const directory = join(root, folder); try { if ((await lstat(directory)).isSymbolicLink()) continue; } catch { continue; }
        await visit(directory, root, provider, 0);
      }
    }
    pointers.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt) || a.session.id.localeCompare(b.session.id));
    return { pointers, warnings: [...warnings], expires: Date.now() + 30000 };
  }
  async detail(project: Project, sourceId: string, query: { limit?: unknown; cursor?: unknown } = {}): Promise<SessionHistoryDetail> {
    return this.readPointer(await this.resolve(project, sourceId), query);
  }
  readPointer(pointer: HistoryPointer, query: { limit?: unknown; cursor?: unknown } = {}): Promise<SessionHistoryDetail> { return readTranscriptPage(pointer, query); }
}
