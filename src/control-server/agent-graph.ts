import { opendir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseJsonOrNull } from '../shared/core/json.js';
import { aiProviders } from './ai-providers/index.js';
import { createHash } from 'node:crypto';
import { SessionHistory, type HistoryPointer } from './history.js';
import { codexToolInput, toolActivity } from './history-records.js';
import { WORKFLOW_RUN_ID, workflowEvents, workflowJournal, workflowNodeId, workflowScriptMeta, type WorkflowJournal, type WorkflowScriptMeta } from './claude-workflows.js';
import { UUID, isUnlinkedFile, isoTimestamp as timestamp, jsonRow, jsonRows, openReadOnly, readRange } from './source-files.js';
import { ControlError, type AgentExecutionNode, type AgentExecutionStatus, type AgentGraphResult, type AgentTranscript, type ControlEvent, type DefaultProvider, type HistoryProvider, type Project, type Run, type TaskMessage } from './types.js';
import type { SessionConversation } from './ai-providers/types.js';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const text = (value: unknown, max = 200): string => typeof value === 'string' ? value.slice(0, max) : '';
// Tools a provider runs for its own bookkeeping say nothing about what the agent is doing.
const BOOKKEEPING_TOOLS = new Set(['SubagentHandback', 'TodoWrite', 'TaskOutput', 'StructuredOutput']);
const canonical = (provider: HistoryProvider, id: string): string => provider === 'codex' ? `codex:${id}` : `claude:agent:${id}`;
const status = (value: unknown): AgentExecutionStatus => ({ pending_init: 'pending', initializing: 'pending', running: 'running', in_progress: 'running', async_launched: 'running', waiting: 'waiting', waiting_for_input: 'waiting', completed: 'completed', complete: 'completed', failed: 'failed', errored: 'failed', error: 'failed', interrupted: 'interrupted', shutdown: 'stopped', stopped: 'stopped', cancelled: 'stopped', killed: 'stopped', paused: 'waiting', not_found: 'unknown' } as Record<string, AgentExecutionStatus>)[String(value)] ?? 'unknown';
function streamRows(events: ControlEvent[]): any[] {
  const selected: ControlEvent[] = []; let bytes = 0;
  for (const event of [...events].reverse()) if (event.type === 'stdout') { bytes += event.message.length; if (bytes > 2 * 1024 * 1024) break; selected.unshift(event); }
  const result: any[] = []; let buffered = '';
  for (const event of selected) { buffered += event.message; const lines = buffered.split('\n'); buffered = lines.pop()?.slice(-128000) ?? ''; for (const line of lines) { const row = parseJsonOrNull(line); if (row && typeof row === 'object') result.push({ ...row, timestamp: row.timestamp ?? event.createdAt }); } }
  const tail = parseJsonOrNull(buffered); if (tail && typeof tail === 'object') result.push({ ...tail, timestamp: tail.timestamp ?? selected.at(-1)?.createdAt }); return result;
}
interface Located { pointer: HistoryPointer; parent?: string; name?: string; role?: string; toolUseId?: string; depth?: number; model?: string; finished?: boolean; workflow?: string; phase?: string }
interface LocatedWorkflow { runId: string; journal: WorkflowJournal; script: WorkflowScriptMeta; entries: Located[] }
interface Built { result: AgentGraphResult; sources: Map<string, HistoryPointer>; conversation?: SessionConversation }
export interface AgentGraphContext { sourceId?: string; run?: Run; events?: ControlEvent[] }
export const AGENT_GRAPH_LIMITS = { agents: 128, depth: 16, scanFiles: 3000, scanEntries: 15000, scanBytes: 48 * 1024 * 1024, sourceBytes: 512 * 1024, graphBytes: 12 * 1024 * 1024, cacheBytes: 32 * 1024 * 1024 };

/** Actual provider child sessions, and the Workflow tool runs of Claude Code that hold some of them; AIWS workflows are deliberately unrelated. */
export class AgentGraph {
  private discovered = new Map<string, { expires: number; entries: Located[]; warnings: string[] }>();
  private scans = new Map<string, Promise<{ entries: Located[]; warnings: string[] }>>();
  /** Parsed source windows, least recently used first; their read sizes add up to at most `windowBytes`. */
  private windows = new Map<string, { fingerprint: string; maximum: number; rows: any[] }>();
  private windowBytes = 0;
  private bindings = new Map<string, HistoryPointer>();
  constructor(private history: SessionHistory) {}
  private async rows(pointer: HistoryPointer, budget: { bytes: number }, maximum = AGENT_GRAPH_LIMITS.sourceBytes): Promise<any[]> {
    if (!await isUnlinkedFile(pointer.path, pointer.root)) return [];
    const stat = await lstat(pointer.path); const fingerprint = `${stat.size}:${stat.mtimeMs}`; const cached = this.windows.get(pointer.path);
    // A short probe of the file (child discovery) must not stand in for a full read of it.
    if (cached?.fingerprint === fingerprint && cached.maximum >= maximum) { this.windows.delete(pointer.path); this.windows.set(pointer.path, cached); return cached.rows; }
    const count = Math.min(maximum, AGENT_GRAPH_LIMITS.graphBytes - budget.bytes); if (count <= 0) return [];
    const file = await openReadOnly(pointer.path);
    try {
      const blocks: Array<{ start: number; buffer: Buffer }> = []; const head = Math.min(stat.size, Math.ceil(count / 2));
      const buffer = Buffer.alloc(head); await file.read(buffer, 0, head, 0); blocks.push({ start: 0, buffer }); budget.bytes += head;
      if (stat.size > head) { const tail = Math.min(count - head, stat.size - head); const last = Buffer.alloc(tail); const start = stat.size - tail; await file.read(last, 0, tail, start); blocks.push({ start, buffer: last }); budget.bytes += tail; }
      const records = new Map<number, any>();
      for (const block of blocks) { let offset = block.start; for (const line of block.buffer.toString('utf8').split('\n')) { const row = jsonRow(line); if (row) records.set(offset, row); offset += Buffer.byteLength(line) + 1; } }
      const rows = [...records].sort((a, b) => a[0] - b[0]).map(([, row]) => row).filter((row) => pointer.startOrdinal === undefined || typeof row.ordinal !== 'number' || row.ordinal >= pointer.startOrdinal);
      const previous = this.windows.get(pointer.path); if (previous) { this.windowBytes -= previous.maximum; this.windows.delete(pointer.path); }
      this.windows.set(pointer.path, { fingerprint, maximum: count, rows }); this.windowBytes += count;
      for (const [path, window] of this.windows) { if (this.windowBytes <= AGENT_GRAPH_LIMITS.cacheBytes || path === pointer.path) break; this.windows.delete(path); this.windowBytes -= window.maximum; }
      return rows;
    } finally { await file.close(); }
  }
  private async codexSources(): Promise<{ entries: Located[]; warnings: string[] }> {
    const root = this.history.home('codex'); const cached = this.discovered.get(root); if (cached && cached.expires > Date.now()) return cached;
    const active = this.scans.get(root); if (active) return active;
    const work = (async () => {
      const entries: Located[] = []; const warnings = new Set<string>(); let files = 0, visited = 0, bytes = 0;
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 5) return; let children;
        try { if ((await lstat(directory)).isSymbolicLink()) return; const handle = await opendir(directory); children = []; for await (const entry of handle) { children.push(entry); if (++visited >= AGENT_GRAPH_LIMITS.scanEntries) break; } } catch { return; }
        children.sort((a, b) => b.name.localeCompare(a.name));
        for (const entry of children) {
          if (files >= AGENT_GRAPH_LIMITS.scanFiles || visited >= AGENT_GRAPH_LIMITS.scanEntries || bytes >= AGENT_GRAPH_LIMITS.scanBytes) { warnings.add('Subagent discovery reached its safety limit; some source files may be omitted.'); return; }
          if (entry.isSymbolicLink()) continue; const path = join(directory, entry.name);
          if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue; files++;
          if (!await isUnlinkedFile(path, root)) continue; let file;
          try {
            file = await openReadOnly(path); const size = (await file.stat()).size; const buffer = await readRange(file, 0, Math.min(size, 96 * 1024, AGENT_GRAPH_LIMITS.scanBytes - bytes)); bytes += buffer.length;
            const payload = jsonRows(buffer.toString('utf8')).find((row) => row.type === 'session_meta')?.payload;
            const id = payload?.id ?? payload?.session_id; const spawn = payload?.source?.subagent?.thread_spawn; const parent = spawn?.parent_thread_id;
            if (typeof id !== 'string' || !UUID.test(id) || typeof payload.cwd !== 'string' || !isAbsolute(payload.cwd)) continue;
            if (payload?.source?.subagent && (!spawn || typeof parent !== 'string' || !UUID.test(parent))) continue; // Not an actual spawned worker (e.g. guardian).
            const at = timestamp(payload.timestamp) ?? new Date((await file.stat()).mtimeMs).toISOString();
            const pointer: HistoryPointer = { root, path, related: Boolean(parent), ...(typeof payload.subagent_history_start_ordinal === 'number' ? { startOrdinal: payload.subagent_history_start_ordinal } : {}), session: { id: `agent_source_${createHash('sha256').update(`${id}\0${path}`).digest('hex').slice(0, 24)}`, provider: 'codex', sessionId: id, title: 'Subagent', cwd: resolve(payload.cwd), createdAt: at, updatedAt: at, canResume: false } };
            entries.push({ pointer, ...(parent ? { parent } : {}), name: text(spawn?.agent_nickname ?? payload.agent_nickname ?? spawn?.nickname), role: text(spawn?.agent_role ?? spawn?.role ?? payload.agent_path ?? spawn?.agent_path) });
          } catch { warnings.add('Some subagent source files could not be read.'); } finally { await file?.close(); }
        }
      };
      await walk(join(root, 'sessions'), 0); await walk(join(root, 'archived_sessions'), 0);
      const value = { entries, warnings: [...warnings] }; this.discovered.set(root, { ...value, expires: Date.now() + 2000 }); return value;
    })().finally(() => this.scans.delete(root)); this.scans.set(root, work); return work;
  }
  private async claudeSources(rootPointer: HistoryPointer): Promise<Located[]> {
    return this.claudeAgentsIn(join(dirname(rootPointer.path), rootPointer.session.sessionId, 'subagents'), rootPointer);
  }
  /** Workers in one directory; `latest` lists a workflow's agents in start order, so the newest stay when a run outgrows the limit. */
  private async claudeAgentsIn(directory: string, rootPointer: HistoryPointer, latest: string[] = []): Promise<Located[]> {
    const result: Located[] = [];
    try {
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) return [];
      const names: string[] = [];
      for await (const entry of await opendir(directory)) if (entry.isFile() && !entry.isSymbolicLink() && /^agent-[a-zA-Z0-9_-]{1,200}\.jsonl$/.test(entry.name)) names.push(entry.name);
      const rank = (name: string): number => latest.indexOf(name.slice(6, -6));
      if (latest.length) names.sort((a, b) => rank(b) - rank(a));
      for (const name of names) {
        if (result.length >= AGENT_GRAPH_LIMITS.agents) break;
        const match = /^agent-(.+)\.jsonl$/.exec(name)!;
        const path = join(directory, name); if (!await isUnlinkedFile(path, rootPointer.root)) continue;
        const provisional: HistoryPointer = { ...rootPointer, path, related: true, childAgentId: match[1]! };
        const rows = await this.rows(provisional, { bytes: 0 }, 96 * 1024); const meta = rows.find((row) => row.agentId === match[1] && row.sessionId === rootPointer.session.sessionId && row.isSidechain === true);
        if (!meta) continue;
        const pointer = { ...provisional, session: { ...rootPointer.session, id: `claude_agent_${match[1]}`, title: `Agent ${match[1]}`, cwd: typeof meta.cwd === 'string' && isAbsolute(meta.cwd) ? resolve(meta.cwd) : rootPointer.session.cwd, canResume: false } };
        // Claude Code keeps the name it gave the worker beside its transcript; the launching
        // tool call may sit outside the bounded root window of a long session.
        const details = await this.claudeMeta(join(directory, `agent-${match[1]}.meta.json`), rootPointer.root);
        result.push({ pointer, ...(text(details?.description) ? { name: text(details.description) } : {}), ...(text(details?.agentType) ? { role: text(details.agentType) } : {}), ...(SAFE_ID.test(details?.toolUseId ?? '') ? { toolUseId: details.toolUseId } : {}), ...(Number.isInteger(details?.spawnDepth) ? { depth: details.spawnDepth } : {}), ...(text(details?.model) ? { model: text(details.model, 80) } : {}), ...(details?.finished === true ? { finished: true } : {}), ...(text(details?.workflowPhase) ? { phase: text(details.workflowPhase) } : {}) });
      }
    } catch { /* No child source directory is normal for a session without subagents. */ }
    return result;
  }
  /** The Workflow tool runs of a session, each with its journal, the steps its script declares and its agents. */
  private async claudeWorkflows(rootPointer: HistoryPointer): Promise<LocatedWorkflow[]> {
    const session = join(dirname(rootPointer.path), rootPointer.session.sessionId), directory = join(session, 'subagents', 'workflows'), runIds: string[] = [];
    try {
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) return [];
      for await (const entry of await opendir(directory)) if (entry.isDirectory() && !entry.isSymbolicLink() && WORKFLOW_RUN_ID.test(entry.name)) runIds.push(entry.name);
    } catch { return []; } // No directory is normal for a session that ran no workflow.
    const scripts: string[] = [];
    try { for await (const entry of await opendir(join(session, 'workflows', 'scripts'))) if (entry.isFile() && !entry.isSymbolicLink()) scripts.push(entry.name); } catch { /* A run may outlive its script. */ }
    const result: LocatedWorkflow[] = [];
    for (const runId of runIds.sort()) {
      const folder = join(directory, runId), rows = await this.rows({ ...rootPointer, path: join(folder, 'journal.jsonl'), related: true }, { bytes: 0 }, 4 * 1024 * 1024), journal = workflowJournal(rows);
      const script = scripts.find((name) => name.endsWith(`-${runId}.js`)); let meta: WorkflowScriptMeta = { phases: [] };
      if (script) { const path = join(session, 'workflows', 'scripts', script); if (await isUnlinkedFile(path, rootPointer.root)) { const file = await openReadOnly(path); try { meta = workflowScriptMeta((await readRange(file, 0, 64 * 1024)).toString('utf8')); } finally { await file.close(); } } }
      const entries = (await this.claudeAgentsIn(folder, rootPointer, journal.order)).reverse().map((entry) => { const id = entry.pointer.childAgentId!, phase = journal.phaseOf.get(id) ?? entry.phase, label = journal.labels.get(id); return { ...entry, workflow: runId, ...(phase ? { phase, role: phase } : {}), ...(!entry.name && label ? { name: text(label) } : {}) }; });
      result.push({ runId, journal, script: meta, entries });
    }
    return result;
  }
  private async claudeMeta(path: string, root: string): Promise<any> {
    if (!await isUnlinkedFile(path, root)) return null; const file = await openReadOnly(path);
    try { return jsonRow((await readRange(file, 0, 16 * 1024)).toString('utf8')); } catch { return null; } finally { await file.close(); }
  }
  async tree(project: Project, context: AgentGraphContext): Promise<AgentGraphResult> { return (await this.build(project, context)).result; }
  private async build(project: Project, context: AgentGraphContext): Promise<Built> {
    const warnings = new Set<string>(); let rootPointer: HistoryPointer | null = null;
    const provider = context.run?.provider;
    if (context.sourceId) rootPointer = await this.history.resolve(project, context.sourceId);
    else if ((provider === 'codex' || provider === 'claude') && context.run && (context.run.sessionId && UUID.test(context.run.sessionId) || context.run.terminalMode === 'pty' && context.run.inputDirectory)) {
      // Project-scoped lookup first; the run-scoped one still finds the session after its
      // worktree was removed or when the agent ended in a subfolder of the workspace.
      // Providers file a session under the directory the agent ran in: the task worktree, not the repository.
      const run = context.run; const existing = this.bindings.get(run.id); const workspace = run.workspacePath ?? project.repositoryPath;
      if (existing && await isUnlinkedFile(existing.path, existing.root)) rootPointer = existing; else this.bindings.delete(run.id);
      if (!rootPointer && run.sessionId && UUID.test(run.sessionId)) {
        rootPointer = await this.history.findSession(project, provider, run.sessionId).catch(() => null);
        rootPointer ??= (await this.history.findRunSession(provider, workspace, { sessionId: run.sessionId, startedAt: run.startedAt })).pointer;
      } else if (!rootPointer && run.inputDirectory) {
        const marker = join(run.inputDirectory, 'prompt.md');
        let bound = await this.history.findBootstrap(project, provider, marker, run.startedAt).catch(() => ({ pointer: null, ambiguous: false }));
        if (!bound.pointer && !bound.ambiguous) bound = await this.history.findRunSession(provider, workspace, { marker, startedAt: run.startedAt });
        rootPointer = bound.pointer; if (bound.ambiguous) warnings.add('More than one native session contains this exact bootstrap marker. Session identity is ambiguous; no source was attached.');
      }
      if (rootPointer && !existing) { if (this.bindings.size >= 256) this.bindings.delete(this.bindings.keys().next().value!); this.bindings.set(run.id, rootPointer); }
    }
    const effectiveProvider = rootPointer?.session.provider ?? provider;
    if (!rootPointer && context.run && context.run.provider !== 'command' && aiProviders.get(context.run.provider)?.sessionConversation) return await this.conversationRoot({ ...context.run, provider: context.run.provider });
    if (effectiveProvider !== 'codex' && effectiveProvider !== 'claude') return { result: { agentTree: { rootId: `run:${context.run?.id ?? 'unknown'}`, agents: [] }, sourceAvailable: false, warnings: ['Subagent source discovery is available for Codex and Claude Code sessions.'] }, sources: new Map() };
    const sessionId = rootPointer?.session.sessionId ?? context.run?.sessionId; const rootId = sessionId ? effectiveProvider === 'codex' ? `codex:${sessionId}` : `claude:session:${sessionId}` : `run:${context.run?.id ?? 'unknown'}`;
    const nodes = new Map<string, AgentExecutionNode>(); const sources = new Map<string, HistoryPointer>(); const aliases = new Map<string, string>(); const generations = new Map<string, string>(); const budget = { bytes: 0 };
    const root: AgentExecutionNode = { id: rootId, parentId: null, provider: effectiveProvider, ...(sessionId ? { sessionId } : {}), name: aiProviders.require(effectiveProvider).name, status: context.run ? status(context.run.status) : 'unknown', readOnly: true, transcriptAvailable: Boolean(rootPointer), ...(rootPointer ? { sourceId: rootPointer.session.id, startedAt: rootPointer.session.createdAt } : {}) };
    nodes.set(rootId, root); if (rootPointer) sources.set(rootId, rootPointer);
    if (!sessionId) warnings.add('This native terminal has not exposed a deterministic provider session ID. Subagent sources cannot be linked yet; use its native provider terminal.');
    const ensure = (id: string, parentId = rootId): AgentExecutionNode => {
      const mapped = aliases.get(id) ?? id; let node = nodes.get(mapped); if (!node) { node = { id: mapped, parentId, provider: effectiveProvider, name: 'Subagent', status: 'unknown', transcriptAvailable: false, readOnly: true }; if (nodes.size < AGENT_GRAPH_LIMITS.agents) nodes.set(mapped, node); } return node;
    };
    const linkAlias = (node: AgentExecutionNode, alias: string): void => {
      if (alias === node.id) return; const previous = nodes.get(alias);
      if (previous && previous !== node) { Object.assign(node, { ...previous, ...node, name: node.name === 'Subagent' ? previous.name : node.name }); nodes.delete(alias); for (const entry of nodes.values()) if (entry.parentId === alias) entry.parentId = node.id; }
      aliases.set(alias, node.id); node.aliases = [...new Set([...(node.aliases ?? []), alias])];
    };
    const update = (node: AgentExecutionNode, next: AgentExecutionStatus, at?: string): void => { if (at && node.updatedAt && at < node.updatedAt) return; if (next !== 'unknown') node.status = next; if (at) node.updatedAt = at; if (['completed', 'failed', 'stopped', 'interrupted'].includes(next) && at) node.finishedAt = at; else if (next === 'running') delete node.finishedAt; };
    // A subagent card shows the model and the last tool call its own transcript recorded.
    const lastRow = new Map<string, string>();
    const act = (node: AgentExecutionNode, tool: unknown, input: unknown, at?: string): void => { if (node.id === rootId || typeof tool !== 'string' || BOOKKEEPING_TOOLS.has(tool) || at && node.activity?.at && at < node.activity.at) return; node.activity = toolActivity(tool, input, at); };
    const observe = (rows: any[], actor: string): void => {
      for (const row of rows) {
        const at = timestamp(row.timestamp); const item = row.type === 'event_msg' ? row.payload : row.type === 'item.completed' || row.type === 'item.updated' || row.type === 'item.started' ? row.item : row;
        if (!item || typeof item !== 'object') continue;
        if (at && actor !== rootId && at > (lastRow.get(actor) ?? '')) lastRow.set(actor, at);
        if (effectiveProvider === 'codex') {
          if (actor !== rootId && row.type === 'turn_context' && typeof row.payload?.model === 'string') ensure(actor).model = text(row.payload.model, 80);
          if (actor !== rootId && row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(row.payload?.type)) act(ensure(actor), row.payload.name, codexToolInput(row.payload), at);
          if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted', 'error'].includes(item.type)) update(ensure(actor), ({ task_started: 'running', task_complete: 'completed', turn_aborted: 'interrupted', error: 'failed' } as const)[item.type as 'task_started'], at);
          if (item.type === 'collab_tool_call') {
            const sender = UUID.test(item.sender_thread_id ?? '') ? canonical('codex', item.sender_thread_id) : actor;
            for (const receiver of Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.slice(0, 128) : []) { if (!UUID.test(receiver)) continue; const node = ensure(canonical('codex', receiver), sender); node.sessionId = receiver; node.parentKnown = true; const snapshot = item.agents_states?.[receiver]; if (snapshot) update(node, status(snapshot.status), at); else if (item.tool === 'spawn_agent') update(node, item.status === 'failed' ? 'failed' : 'running', at); }
          }
        } else {
          let rowActor = actor;
          if (SAFE_ID.test(row.agent_id ?? '') && row.parent_tool_use_id) { const child = ensure(canonical('claude', row.agent_id), actor); if (SAFE_ID.test(row.parent_tool_use_id)) { child.toolUseId ??= row.parent_tool_use_id; linkAlias(child, `claude:tool:${row.parent_tool_use_id}`); } rowActor = child.id; }
          if (row.type === 'assistant' && rowActor !== rootId) { const node = ensure(rowActor); if (typeof row.message?.model === 'string' && !row.message.model.startsWith('<')) node.model = text(row.message.model, 80); for (const part of row.message?.content ?? []) if (part?.type === 'tool_use') act(node, part.name, part.input, at); }
          if (row.type === 'assistant') for (const part of row.message?.content ?? []) if (part?.type === 'tool_use' && ['Agent', 'Task'].includes(part.name) && SAFE_ID.test(part.id ?? '')) {
            const resume = part.input?.resume; const id = SAFE_ID.test(resume ?? '') ? canonical('claude', resume) : `claude:tool:${part.id}`; const node = ensure(id, rowActor); if (!node.parentKnown) node.parentId = rowActor; node.toolUseId ??= part.id; node.name = text(part.input?.description) || node.name; if (typeof part.input?.subagent_type === 'string') node.role = text(part.input.subagent_type); node.parentKnown = true; if (id !== `claude:tool:${part.id}`) linkAlias(node, `claude:tool:${part.id}`); update(node, 'running', at); node.startedAt ??= at ?? root.startedAt ?? '';
          }
          if (row.toolUseResult?.agentId && SAFE_ID.test(row.toolUseResult.agentId)) {
            const tool = (row.message?.content ?? []).find((part: any) => part.type === 'tool_result' && SAFE_ID.test(part.tool_use_id ?? ''));
            const node = ensure(canonical('claude', row.toolUseResult.agentId), rowActor); if (!node.parentKnown) node.parentId = rowActor; node.parentKnown = true;
            if (tool) { node.toolUseId ??= tool.tool_use_id; linkAlias(node, `claude:tool:${tool.tool_use_id}`); }
            update(node, status(row.toolUseResult.status), at);
          }
          if (row.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(row.subtype)) {
            if (row.task_type === 'local_bash' || row.task_type === 'ambient' || row.task_type && !['local_agent', 'remote_agent'].includes(row.task_type)) continue;
            const id = text(row.agent_id ?? row.task_id); if (!SAFE_ID.test(id)) continue; const canonicalId = canonical('claude', id); const known = nodes.get(canonicalId);
            if (row.subtype !== 'task_started' && !known && !row.tool_use_id) continue;
            const node = ensure(canonicalId, typeof row.parent_task_id === 'string' && SAFE_ID.test(row.parent_task_id) ? canonical('claude', row.parent_task_id) : actor);
            if (row.tool_use_id && SAFE_ID.test(row.tool_use_id)) { node.toolUseId ??= row.tool_use_id; linkAlias(node, `claude:tool:${row.tool_use_id}`); }
            const generation = typeof row.run_id === 'string' ? row.run_id : undefined;
            if (row.subtype === 'task_started') { if (generation) generations.set(node.id, generation); update(node, 'running', at); node.startedAt ??= at ?? ''; }
            else { if (generation && generations.has(node.id) && generations.get(node.id) !== generation) continue; update(node, status(row.status ?? row.patch?.status ?? (row.subtype === 'task_progress' ? 'running' : undefined)), at); }
            if (row.description) node.name = text(row.description); if (row.subagent_type) node.role = text(row.subagent_type); node.parentKnown = true;
          }
          if (row.type === 'result' && actor !== rootId) update(ensure(actor), row.is_error ? 'failed' : 'completed', at);
          if (row.type === 'assistant' && actor !== rootId && row.message?.stop_reason === 'end_turn') update(ensure(actor), 'completed', at);
        }
      }
    };
    const rootRows = rootPointer ? await this.rows(rootPointer, budget) : []; observe(rootRows, rootId);
    const liveRows = streamRows(context.events ?? []);
    observe(liveRows, rootId);
    if (sessionId && effectiveProvider === 'codex') {
      const discovery = await this.codexSources(); discovery.warnings.forEach((warning) => warnings.add(warning));
      const accepted = new Set([sessionId]); const related: Located[] = [];
      for (let depth = 0; depth < AGENT_GRAPH_LIMITS.depth; depth++) { let added = 0; for (const entry of discovery.entries) if (entry.parent && accepted.has(entry.parent) && !accepted.has(entry.pointer.session.sessionId) && accepted.size < AGENT_GRAPH_LIMITS.agents) { accepted.add(entry.pointer.session.sessionId); related.push(entry); added++; } if (!added) break; }
      for (const entry of related) { const id = canonical('codex', entry.pointer.session.sessionId); const node = ensure(id, canonical('codex', entry.parent!)); node.parentId = canonical('codex', entry.parent!); node.parentKnown = true; node.sessionId = entry.pointer.session.sessionId; node.name = entry.name || 'Codex subagent'; if (entry.role) node.role = entry.role; node.startedAt ??= entry.pointer.session.createdAt; node.sourceId = entry.pointer.session.id; node.transcriptAvailable = true; sources.set(id, entry.pointer); observe(await this.rows(entry.pointer, budget), id); }
      // Root collab observations are authoritative for child lifecycle, including
      // waiting/shutdown after its last recorded model turn.
      observe(rootRows, rootId); observe(liveRows, rootId);
    } else if (rootPointer && effectiveProvider === 'claude') {
      const workflows = await this.claudeWorkflows(rootPointer), entries = [...await this.claudeSources(rootPointer), ...workflows.flatMap((workflow) => workflow.entries)];
      const { launches, ends } = workflowEvents([...rootRows, ...liveRows], status);
      if (nodes.size + workflows.length + entries.length > AGENT_GRAPH_LIMITS.agents) warnings.add('This session has more agents than the hierarchy can show; some are omitted.');
      for (const workflow of workflows) {
        const launch = launches.get(workflow.runId), node = ensure(workflowNodeId(workflow.runId));
        node.kind = 'workflow'; node.parentId = rootId; node.parentKnown = true; node.name = workflow.script.name || launch?.name || 'Workflow';
        const description = workflow.script.description || launch?.summary; if (description) node.description = text(description, 400);
        // Steps the script declares come first and in its order; one only the journal knows follows them.
        const titles = workflow.script.phases.map((phase) => phase.title); node.phases = [...workflow.script.phases.map((phase) => ({ title: text(phase.title), ...(phase.detail ? { detail: text(phase.detail) } : {}) })), ...workflow.journal.phases.filter((title) => !titles.includes(title)).map((title) => ({ title: text(title) }))];
        if (launch?.toolUseId && SAFE_ID.test(launch.toolUseId)) { node.toolUseId = launch.toolUseId; linkAlias(node, `claude:tool:${launch.toolUseId}`); }
      }
      for (const entry of entries) { const id = canonical('claude', entry.pointer.childAgentId!); const node = ensure(id); if (entry.workflow) { node.parentId = workflowNodeId(entry.workflow); node.parentKnown = true; if (entry.phase) node.phase = entry.phase; } if (entry.toolUseId) { const launch = nodes.get(`claude:tool:${entry.toolUseId}`); node.toolUseId ??= entry.toolUseId; linkAlias(node, `claude:tool:${entry.toolUseId}`); if (launch && launch !== node && launch.parentKnown) node.parentId = launch.parentId; } if (entry.depth === 1 && !node.parentKnown) { node.parentId = rootId; node.parentKnown = true; } node.parentKnown ??= false; node.name = node.name === 'Subagent' ? entry.name || `Claude subagent ${entry.pointer.childAgentId}` : node.name; if (entry.role) node.role ??= entry.role; node.sessionId = sessionId!; node.sourceId = entry.pointer.session.id; node.transcriptAvailable = true; sources.set(id, entry.pointer); const own = await this.rows(entry.pointer, budget); observe(own, id); const began = timestamp(own.find((row) => row.timestamp)?.timestamp); if (entry.workflow && began) node.startedAt ??= began; if (entry.model) node.model ??= entry.model; }
      observe(rootRows, rootId); observe(liveRows, rootId);
      // Claude Code marks a worker finished in its meta file; a transcript that ends on a tool call never says so itself.
      for (const entry of entries) { const node = nodes.get(aliases.get(canonical('claude', entry.pointer.childAgentId!)) ?? canonical('claude', entry.pointer.childAgentId!)); if (node && entry.finished && ['running', 'waiting', 'pending', 'unknown'].includes(node.status)) { node.status = 'completed'; const at = lastRow.get(node.id) ?? node.updatedAt ?? node.startedAt; if (at) node.finishedAt ??= at; } }
      // The journal says which agents of a run have ended; the run itself lives only as long as the session that launched it, unless the session reported its end.
      // Without a run, recent writes tell: the main agent may sit idle for hours while its workflow works, so the run's own agents count too.
      const recent = (at?: number): boolean => at !== undefined && Date.now() - at < 5 * 60 * 1000, rootRecent = recent((await lstat(rootPointer.path)).mtimeMs);
      for (const workflow of workflows) {
        const node = nodes.get(workflowNodeId(workflow.runId)); if (!node) continue;
        const launch = launches.get(workflow.runId), ended = launch?.taskId ? ends.get(launch.taskId) : undefined, newest = workflow.entries.map((entry) => lastRow.get(canonical('claude', entry.pointer.childAgentId!)) ?? '').sort().at(-1), live = !ended && (context.run ? ['running', 'waiting'].includes(context.run.status) : rootRecent || recent(newest ? Date.parse(newest) : undefined)), times: string[] = [], starts: string[] = [];
        for (const entry of workflow.entries) {
          const id = canonical('claude', entry.pointer.childAgentId!), child = nodes.get(aliases.get(id) ?? id); if (!child) continue;
          const last = lastRow.get(child.id), done = workflow.journal.results.has(entry.pointer.childAgentId!) || entry.finished === true;
          if (done) { child.status = 'completed'; if (last) child.finishedAt = last; }
          else if (live) { child.status = 'running'; delete child.finishedAt; }
          else if (!['failed', 'stopped'].includes(child.status)) { child.status = ended?.status === 'stopped' ? 'stopped' : ended?.status === 'failed' ? 'failed' : 'interrupted'; if (last) child.finishedAt = last; }
          if (last) times.push(last); if (child.startedAt) starts.push(child.startedAt);
        }
        const unresolved = workflow.journal.order.some((id) => !workflow.journal.results.has(id));
        node.status = ended?.status ?? (live ? 'running' : unresolved || !workflow.journal.order.length ? 'interrupted' : 'completed');
        const startedAt = timestamp(launch?.at) ?? starts.sort()[0]; if (startedAt) node.startedAt = startedAt;
        const updatedAt = times.sort().at(-1); if (updatedAt) node.updatedAt = updatedAt;
        if (node.status === 'running') delete node.finishedAt; else { const finishedAt = timestamp(ended?.at) ?? updatedAt; if (finishedAt) node.finishedAt = finishedAt; }
      }
      // Unbound invocations are tool calls, not a second identity for a file-backed
      // worker. Keep them only when the provider has exposed no actual agent IDs.
      if (entries.length) for (const [id, node] of nodes) if (id.startsWith('claude:tool:') && !node.transcriptAvailable && !node.aliases?.length) nodes.delete(id);
    }
    if (budget.bytes >= AGENT_GRAPH_LIMITS.graphBytes) warnings.add('Subagent metadata reached its read budget; some lifecycle events may be unavailable.');
    if (context.run) root.status = status(context.run.status);
    return { result: { agentTree: { rootId, agents: [...nodes.values()] }, warnings: [...warnings], sourceAvailable: Boolean(rootPointer) }, sources };
  }
  /** The root of a run whose provider reads its conversation from its own session storage; it has no subagent sources. */
  private async conversationRoot(run: Run & { provider: DefaultProvider }): Promise<Built> {
    const provider = aiProviders.require(run.provider);
    const conversation = await provider.readSessionConversation(run).catch(() => undefined);
    const sessionId = conversation?.sessionId ?? run.sessionId; const rootId = `run:${run.id}`;
    const root: AgentExecutionNode = { id: rootId, parentId: null, provider: run.provider, ...(sessionId ? { sessionId } : {}), name: provider.name, status: status(run.status), readOnly: true, transcriptAvailable: Boolean(conversation), ...(conversation?.entries[0] ? { startedAt: conversation.entries[0].at } : {}) };
    return { result: { agentTree: { rootId, agents: [root] }, sourceAvailable: Boolean(conversation), warnings: conversation ? [] : ['The provider has not written a readable transcript for this run yet.'] }, sources: new Map(), ...(conversation ? { conversation } : {}) };
  }
  /** The readable transcript of one agent of the tree (the root when none is named), with the tree to choose another from. */
  async source(project: Project, context: AgentGraphContext, agentId?: string): Promise<{ result: AgentGraphResult; node: AgentExecutionNode; pointer: HistoryPointer | null }> {
    const built = await this.build(project, context); const tree = built.result.agentTree;
    const node = tree.agents.find((entry) => agentId ? entry.id === agentId || entry.aliases?.includes(agentId) : entry.id === tree.rootId);
    if (!node) throw new ControlError('This subagent does not belong to the selected session.', 404);
    const pointer = built.sources.get(node.id) ?? null;
    return { result: built.result, node, pointer: pointer && await isUnlinkedFile(pointer.path, pointer.root) ? pointer : null };
  }
  async transcript(project: Project, context: AgentGraphContext, agentId: string, query: { limit?: unknown; cursor?: unknown }): Promise<AgentTranscript> {
    const built = await this.build(project, context); const node = built.result.agentTree.agents.find((entry) => entry.id === agentId || entry.aliases?.includes(agentId));
    if (!node) throw new ControlError('This subagent does not belong to the selected session.', 404);
    if (built.conversation && context.run && node.id === built.result.agentTree.rootId) return conversationTranscript(context.run, built.conversation, built.result.warnings);
    const pointer = built.sources.get(node.id); if (!pointer || !await isUnlinkedFile(pointer.path, pointer.root)) throw new ControlError('This provider has not exposed a readable subagent transcript yet. Use its native terminal or try again shortly.', 409);
    const detail = await this.history.readPointer(pointer, query); const runId = `agent_transcript:${node.id}`;
    const run: Run = { id: runId, taskId: '', provider: pointer.session.provider, sessionId: pointer.session.sessionId, startedAt: node.startedAt ?? pointer.session.createdAt, finishedAt: node.finishedAt ?? null, exitCode: node.status === 'completed' ? 0 : null, executionMode: 'native', pendingCommands: [], continuation: 0, status: node.status === 'completed' ? 'completed' : node.status === 'failed' ? 'failed' : node.status === 'running' ? 'running' : node.status === 'waiting' ? 'waiting' : 'interrupted', terminalMode: 'stream' };
    return { runs: [run], events: detail.events.map((event) => ({ ...event, runId })), messages: detail.messages.map((message) => ({ ...message, runId })), questions: [], nextCursor: detail.nextCursor, truncated: detail.truncated, warnings: [...built.result.warnings, ...detail.warnings] };
  }
}

/** A provider-neutral conversation in the stream form the chat renders: messages for the user, Claude-style records for the agent and its tools. */
function conversationTranscript(run: Run, conversation: SessionConversation, warnings: string[]): AgentTranscript {
  const runId = `agent_transcript:run:${run.id}`; const events: ControlEvent[] = []; const messages: TaskMessage[] = [];
  const emit = (id: string, createdAt: string, value: unknown): void => { events.push({ id: `${runId}:${id}`, runId, taskId: null, type: 'stdout', message: `${JSON.stringify(value)}
`, createdAt }); };
  for (const entry of conversation.entries) {
    const at = entry.at || run.startedAt;
    if (entry.kind === 'user') messages.push({ id: `${runId}:${entry.id}`, taskId: '', runId, agentId: null, authorType: 'user', authorName: 'User', text: entry.text, createdAt: at });
    else if (entry.kind === 'agent' || entry.kind === 'summary') emit(entry.id, at, { type: 'assistant', message: { id: entry.id, content: [{ type: 'text', text: entry.text }] } });
    else if (entry.kind === 'notice') messages.push({ id: `${runId}:${entry.id}`, taskId: '', runId, agentId: null, authorType: 'system', authorName: 'System', text: entry.text, createdAt: at });
    else if (entry.kind === 'tool_use') emit(entry.id, at, { type: 'assistant', message: { id: entry.id, content: [{ type: 'tool_use', id: entry.callId, name: entry.name, input: entry.input }] } });
    else if (entry.kind === 'tool_result') emit(entry.id, at, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: entry.callId, content: entry.text, is_error: entry.isError }] } });
  }
  const transcriptRun: Run = { ...run, id: runId, taskId: '', terminalMode: 'stream' };
  return { runs: [transcriptRun], events, messages, questions: [], nextCursor: null, truncated: false, warnings };
}
