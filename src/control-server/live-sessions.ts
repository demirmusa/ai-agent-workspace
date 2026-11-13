import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { packageResource } from '../shared/core/assets.js';
import { parseJsonOrNull } from '../shared/core/json.js';
import { aiProviders } from './ai-providers/index.js';
import { pathKey } from '../shared/core/paths.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionHistory, type HistoryPointer } from './history.js';
import { UUID } from './source-files.js';
import { ControlError, type HistoryProvider, type LiveSession, type LiveSessionPage, type Project, type Run, type SessionActivity, type Task } from './types.js';

const providerOf = (process: NativeProcess): HistoryProvider | null => (aiProviders.list().find((provider) => provider.history && provider.nativeProcess
  && (provider.nativeProcess.name.test(process.name) || provider.nativeProcess.command.test(process.command)))?.id as HistoryProvider | undefined) ?? null;
export interface NativeProcess { pid: number; name: string; command: string; startedAt?: string }
export interface ProcessEvidence { processes: NativeProcess[]; owners: Record<string, number[]> }
export interface LiveSessionOptions { evidence?: (paths: string[]) => Promise<ProcessEvidence> }
interface ScopedLive { project: Project; pointer: HistoryPointer; item: LiveSession }
interface LiveCache { expires: number; page: LiveSessionPage; scoped: Map<string, ScopedLive>; activities: Map<string, SessionActivity> }

async function names(directory: string, maximum = 256): Promise<string[]> {
  const result: string[] = [];
  try { if ((await lstat(directory)).isSymbolicLink() || pathKey(await realpath(directory)) !== pathKey(directory)) return []; const handle = await opendir(directory); for await (const entry of handle) { if (entry.isFile() && !entry.isSymbolicLink()) result.push(entry.name); if (result.length >= maximum) break; } } catch { /* Optional provider metadata. */ }
  return result;
}
async function boundedJson(path: string, maximum = 64 * 1024): Promise<any> {
  let file;
  try { if ((await lstat(path)).isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path)) return null; file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); if ((await file.stat()).size > maximum) return null; return parseJsonOrNull(await file.readFile('utf8')); } catch { return null; } finally { await file?.close(); }
}

/** OS ownership only: no lock acquisition/removal, provider control, or process mutation. */
export async function inspectNativeProcesses(paths: string[]): Promise<ProcessEvidence> {
  const owners: Record<string, number[]> = {};
  if (process.platform === 'win32') {
    const script = await packageResource('assets', 'discover-sessions-windows.ps1');
    return new Promise((resolvePromise, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Native process discovery timed out.')); }, 8000); timeout.unref();
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-2000); });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('close', (code) => { clearTimeout(timeout); const value = parseJsonOrNull(output.replace(/^\uFEFF/, '').trim()); if (code !== 0 || !Array.isArray(value?.processes) || !value.owners) reject(new Error(error || 'Native process discovery is unavailable.')); else resolvePromise(value); });
      child.stdin.end(JSON.stringify({ paths }));
    });
  }
  const processes: NativeProcess[] = [];
  if (process.platform === 'linux') {
    const handle = await opendir('/proc');
    for await (const entry of handle) {
      if (!/^\d+$/.test(entry.name) || processes.length >= 128) continue;
      try {
        const command = (await readFile(`/proc/${entry.name}/cmdline`, 'utf8')).replace(/\0/g, ' '); const name = (await readFile(`/proc/${entry.name}/comm`, 'utf8')).trim(); const proc = { pid: Number(entry.name), name, command };
        if (!providerOf(proc)) continue; processes.push(proc);
        const fds = await opendir(`/proc/${entry.name}/fd`); let count = 0;
        for await (const fd of fds) { if (++count > 1024) break; try { const path = await readlink(`/proc/${entry.name}/fd/${fd.name}`); if (paths.includes(path)) (owners[path] ??= []).push(proc.pid); } catch {} }
      } catch { /* Another user's processes and processes that exited are not evidence. */ }
    }
    return { processes, owners };
  }
  const exec = promisify(execFile); const result = await exec('ps', ['-ax', '-o', 'pid=,comm=,args='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  for (const line of result.stdout.split('\n')) { const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line); if (!match) continue; const proc = { pid: Number(match[1]), name: basename(match[2]!), command: match[3]! }; if (providerOf(proc)) processes.push(proc); }
  if (paths.length) {
    try {
      const result = await exec('lsof', ['-n', '-P', '-Fpn', '--', ...paths], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }); let pid = 0;
      for (const line of result.stdout.split('\n')) { if (line.startsWith('p')) pid = Number(line.slice(1)); else if (line.startsWith('n') && paths.includes(line.slice(1))) (owners[line.slice(1)] ??= []).push(pid); }
    } catch (error) { if (!(error as { stdout?: string }).stdout) throw error; }
  }
  return { processes, owners };
}

/** Live external sessions remain ephemeral read-only views of original provider records. */
export class LiveSessions {
  private cache: LiveCache | undefined;
  private pending: Promise<LiveCache> | undefined;
  private cacheKey = '';
  private pendingKey = '';
  private bindings = new Map<string, HistoryPointer>();
  constructor(private history: SessionHistory, private options: LiveSessionOptions = {}, private context?: () => { projects: Project[]; runs: Run[]; tasks: Task[] }) {}
  invalidate(): void { this.cache = undefined; }
  async state(projects: Project[], runs: Run[], tasks: Task[]): Promise<LiveSessionPage> { return structuredClone((await this.load(projects, runs, tasks)).page); }
  private async load(projects: Project[], runs: Run[], tasks: Task[]): Promise<LiveCache> {
    const key = JSON.stringify([projects.map((entry) => [entry.id, entry.repositoryPath]), runs.map((entry) => [entry.id, entry.sessionId, entry.status]), tasks.map((entry) => [entry.id, entry.projectId, entry.currentRunId])]);
    if (this.cache && this.cacheKey === key && this.cache.expires > Date.now()) return this.cache;
    if (this.pending) { if (this.pendingKey === key) return this.pending; await this.pending; return this.load(projects, runs, tasks); }
    this.pendingKey = key;
    this.pending = this.scan(projects, runs, tasks).then((value) => { this.cacheKey = key; this.cache = value; return value; }).finally(() => { this.pending = undefined; }); return this.pending;
  }
  async scope(id: string, projects: Project[], runs: Run[], tasks: Task[]): Promise<ScopedLive> {
    if (!/^hist_[a-f0-9]{40}$/.test(id)) throw new ControlError('Invalid live session ID.');
    const found = (await this.load(projects, runs, tasks)).scoped.get(id);
    if (!found) throw new ControlError('This external session is no longer active. Its saved transcript remains in project Sessions.', 409); return found;
  }
  async activity(project: Project, provider: HistoryProvider, sessionId: string): Promise<SessionActivity | null> {
    const context = this.context?.(); const state = await this.load(context?.projects ?? [project], context?.runs ?? [], context?.tasks ?? []); let cwd: string; try { cwd = await realpath(project.repositoryPath); } catch { return null; } return state.activities.get(`${provider}:${sessionId}:${pathKey(cwd)}`) ?? null;
  }
  private async scan(projects: Project[], runs: Run[], tasks: Task[]): Promise<LiveCache> {
    const warnings: string[] = [], items: LiveSession[] = [], scoped = new Map<string, ScopedLive>(), managedTitles: Record<string, string> = {}, activities = new Map<string, SessionActivity>();
    const codexRoot = this.history.home('codex'); const lockDirectory = join(codexRoot, 'thread-writer-locks');
    const paths = (await names(lockDirectory)).filter((name) => UUID.test(name.replace(/\.lock$/, '')) && name.endsWith('.lock')).map((name) => join(lockDirectory, name));
    let evidence: ProcessEvidence;
    try { evidence = await (this.options.evidence ?? inspectNativeProcesses)(paths); } catch { return { expires: Date.now() + 3000, page: { items, managedTitles, warnings: ['Native process ownership could not be inspected on this host. External sessions are not inferred from file timestamps.'] }, scoped, activities }; }
    const processes = new Map(evidence.processes.filter((entry) => Number.isSafeInteger(entry.pid) && entry.pid > 0 && providerOf(entry)).map((entry) => [entry.pid, entry]));
    const candidates: Array<{ provider: HistoryProvider; sessionId: string; process: NativeProcess; activity?: SessionActivity; cwd?: string }> = [];
    for (const path of paths) for (const pid of evidence.owners[path] ?? []) { const proc = processes.get(pid); if (proc && providerOf(proc) === 'codex') candidates.push({ provider: 'codex', sessionId: basename(path, '.lock'), process: proc }); }
    const claudeDirectory = join(this.history.home('claude'), 'sessions');
    for (const name of await names(claudeDirectory)) {
      if (!/^\d+\.json$/.test(name)) continue; const meta = await boundedJson(join(claudeDirectory, name)); const proc = processes.get(meta?.pid);
      if (!proc || providerOf(proc) !== 'claude' || meta.pid !== Number(name.slice(0, -5)) || !UUID.test(meta.sessionId ?? '') || typeof meta.cwd !== 'string') continue;
      // Provider process identity prevents a stale PID registry from matching a reused PID.
      const started = proc.startedAt ? Date.parse(proc.startedAt) : NaN;
      const recorded = typeof meta.procStart === 'string' && /^\d+$/.test(meta.procStart) ? Number((BigInt(meta.procStart) - 116444736000000000n) / 10000n) : meta.startedAt;
      if (Number.isFinite(started) && (!Number.isFinite(recorded) || Math.abs(started - recorded) > 2000)) continue;
      candidates.push({ provider: 'claude', sessionId: meta.sessionId, process: proc, cwd: meta.cwd, activity: ['working', 'running', 'busy'].includes(meta.status) ? 'working' : ['idle', 'waiting'].includes(meta.status) ? 'idle' : 'unknown' });
    }
    const sources = await this.history.discover(candidates);
    const projectPaths = new Map<string, Project>(); for (const project of projects) { try { projectPaths.set(pathKey(await realpath(project.repositoryPath)), project); } catch {} }
    const managed = new Map<string, Run>();
    for (const run of runs.filter((entry) => ['running', 'waiting', 'paused'].includes(entry.status) && aiProviders.isHistoryProvider(entry.provider))) {
      const task = tasks.find((entry) => entry.id === run.taskId); const project = projects.find((entry) => entry.id === task?.projectId); if (!project) continue;
      try {
        let pointer = this.bindings.get(run.id);
        const uuid = run.sessionId ?? run.historyResume?.sessionId;
        if (!pointer && uuid) pointer = await this.history.findSession(project, run.provider as HistoryProvider, uuid) ?? undefined;
        if (!pointer && run.terminalMode === 'pty' && run.inputDirectory) pointer = (await this.history.findBootstrap(project, run.provider as HistoryProvider, join(run.inputDirectory, 'prompt.md'), run.startedAt)).pointer ?? undefined;
        if (pointer) {
          this.bindings.set(run.id, pointer);
          const info = await this.history.executionInfo(pointer);
          // Git context captured at launch belongs to this run, even if the user switches branches later.
          if (run.executionInfo?.worktreePath) delete info.branch;
          run.executionInfo = { ...run.executionInfo, ...info };
          managed.set(`${run.provider}:${pointer.session.sessionId}:${pathKey(pointer.session.cwd)}`, run);
          managedTitles[run.id] = await this.history.canonicalTitle(pointer);
        }
        else if (uuid) managed.set(`${run.provider}:${uuid}:${pathKey(await realpath(project.repositoryPath))}`, run);
      } catch { /* Never guess a managed terminal's provider identity. */ }
    }
    if (this.bindings.size > 256) for (const id of this.bindings.keys()) if (!runs.some((run) => run.id === id && ['running', 'waiting', 'paused'].includes(run.status))) this.bindings.delete(id);
    for (const pointer of sources) {
      const source = pointer.session; const candidate = candidates.find((entry) => entry.provider === source.provider && entry.sessionId === source.sessionId); if (!candidate) continue;
      if (candidate.cwd) { try { if (pathKey(await realpath(candidate.cwd)) !== pathKey(source.cwd)) continue; } catch { continue; } }
      const activity = candidate.activity ?? await this.history.activity(pointer); activities.set(`${source.provider}:${source.sessionId}:${pathKey(source.cwd)}`, activity);
      if (managed.has(`${source.provider}:${source.sessionId}:${pathKey(source.cwd)}`) || scoped.has(source.id)) continue;
      const registered = projectPaths.get(pathKey(source.cwd));
      const project: Project = registered ?? { id: `external_${source.id.slice(5)}`, name: basename(source.cwd), description: '', repositoryPath: source.cwd, github: null, createdAt: source.createdAt, updatedAt: source.updatedAt };
      const item: LiveSession = { ...source, title: await this.history.canonicalTitle(pointer), canResume: false, projectId: registered?.id ?? null, projectName: project.name, processId: candidate.process.pid, active: true, activity, external: true, readOnly: true };
      items.push(item); scoped.set(item.id, { project, pointer, item });
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // Discovery starts a process scan; a few seconds of staleness is invisible, the CPU cost is not.
    return { expires: Date.now() + 5000, page: { items, managedTitles, warnings }, scoped, activities };
  }
}
