import { serviceTiming } from './service/timing.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findExecutable } from '../shared/core/command.js';
import { launchPty, type PtyPlacement, type RuntimeHandle } from './runner.js';
import { TerminalScreen } from './terminal-screen.js';
import { effectiveProviderArgs, emptyProviderArgs, withAutoMode } from './provider-args.js';
import { aiProviders, isAccountId, type ProviderAccountLogin } from './ai-providers/index.js';
import { ControlError, type ControlSettings, type Project, type ProjectTerminal, type ProviderArgs, type Run } from './types.js';
import { appendReplay } from './store.js';
export type { ProjectTerminal } from './types.js';
import { resolveScriptPath, scriptLine } from './run-scripts.js';

type TerminalPublisher = (runId: string, offset: number, data: string) => void;
type ShellChange = (projectId: string) => void;
export type TerminalAgentProvider = keyof ProviderArgs;
export interface TerminalAgent { provider: TerminalAgentProvider; label: string; available: boolean; path?: string; reason?: string }
/** Where terminals and their replays are kept: the control store, or memory alone when there is none. */
export interface TerminalStore { terminals: ProjectTerminal[]; appendTerminal(run: Run, data: string): number; terminalOutput(run: Run): string; scheduleSave(): void }
const memoryStore = (): TerminalStore => ({ terminals: [], appendTerminal: (run, data) => appendReplay(run, run.terminalOutput ?? '', data), terminalOutput: (run) => run.terminalOutput ?? '', scheduleSave: () => {} });
/** Separates the output of a terminal opened again by a restarted service from what the previous process wrote. */
const TERMINAL_RESUMED_SEPARATOR = '\r\n---resumed---\r\n';
/** A PowerShell prompt at the start of a line, which names the shell's directory. */
const POWERSHELL_PROMPT = /^PS (.+?)>/;
interface Command { executable: string; args: string[]; env?: NodeJS.ProcessEnv; unset?: readonly string[]; login?: ProviderAccountLogin; placement?: PtyPlacement }
interface Entry { projectId: string; project: Project; run: ProjectTerminal; handle?: RuntimeHandle; login?: ProviderAccountLogin; watch?: NodeJS.Timeout }

/** The first message of a terminal conversation that the user turned into a task; the run's AIWS commands follow it. */
export const TERMINAL_TASK_MESSAGE = 'The user turned this terminal conversation into an AIWS task. You now run as that task and its status is already running. Do not wait for a new message: continue and finish what the user asked earlier in this conversation, without repeating work you already completed. Verify before claiming success. Only you, not subagents, may run aiws control commands for this run. When the work is finished, follow the AIWS instructions below.';
const agentLabel = (provider: TerminalAgentProvider): string => aiProviders.require(provider).name;
const AGENT_CACHE_MS = 30_000;
/** How often a sign-in terminal checks for a finished login, and how long it then lets the CLI finish writing it. */
const LOGIN_POLL_MS = 2_000, LOGIN_SETTLE_MS = 1_500;
function providerAccounts(provider: TerminalAgentProvider) {
  const accounts = aiProviders.require(provider).accounts;
  if (!accounts) throw new ControlError(`${agentLabel(provider)} has no accounts to choose from.`);
  return accounts;
}


/**
 * User shells and agent terminals never participate in agent task scheduling. They are stored with the state: a restarted
 * service shows every terminal again with its output, and opens the ones that were still running (restore()).
 */
export class ProjectTerminals {
  private entries = new Map<string, Entry>();
  private agentCache: { at: number; value: Promise<TerminalAgent[]> } | undefined;
  private closing = false;
  constructor(private publish: TerminalPublisher = () => {}, private changed: ShellChange = () => {}, private settings: () => Pick<ControlSettings, 'providerArgs' | 'autoModeProviders'> = () => ({ providerArgs: emptyProviderArgs(), autoModeProviders: [] }), private store: TerminalStore = memoryStore(), private connection: () => { url: string; token?: string } | undefined = () => undefined) {}
  /** Shell metadata; output streams live and is replayed through terminal(). */
  list(projectId: string): ProjectTerminal[] {
    return [...this.entries.values()].filter(entry => entry.projectId === projectId).map(({ run: { terminalOutput: _output, ...run } }) => ({ ...run }));
  }
  get(projectId: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.projectId !== projectId) throw new ControlError('Terminal not found.', 404);
    return entry;
  }
  /** Agent CLIs found on PATH. Lookups are cached so opening the Terminal tab never waits on disk scans twice. */
  agents(refresh = false): Promise<TerminalAgent[]> {
    if (!refresh && this.agentCache && Date.now() - this.agentCache.at < AGENT_CACHE_MS) return this.agentCache.value;
    const value = Promise.all(aiProviders.list().map(async ({ id: provider, name: label, executable }): Promise<TerminalAgent> => {
      const path = await findExecutable(executable);
      return path ? { provider, label, available: true, path } : { provider, label, available: false, reason: `${executable} was not found on PATH. Install the CLI or add it to PATH, then refresh.` };
    }));
    this.agentCache = { at: Date.now(), value };
    value.catch(() => { if (this.agentCache?.value === value) this.agentCache = undefined; });
    return value;
  }
  terminal(projectId: string, id: string): { output: string; end: number; cols: number; rows: number; status: Run['status'] } {
    const { run } = this.get(projectId, id), output = this.store.terminalOutput(run);
    return { output, end: run.terminalLength ?? output.length, cols: run.cols ?? 100, rows: run.rows ?? 30, status: run.status };
  }
  private append(run: Run, data: string): void {
    this.publish(run.id, this.store.appendTerminal(run, data), data);
  }
  /** Terminal metadata changed (status, title, size, session): the store writes it with the next save. */
  private update(projectId: string): void { this.store.scheduleSave(); this.changed(projectId); }
  private summary(run: ProjectTerminal): ProjectTerminal {
    const { terminalOutput: _output, ...summary } = run;
    return { ...summary };
  }
  /** The command a terminal runs: a login shell, the agent CLI's interactive TUI with the configured provider arguments, or an account sign-in. */
  private async command(run: ProjectTerminal, project: Project): Promise<Command> {
    if (run.terminalKind === 'login') { const login = await providerAccounts(run.provider as TerminalAgentProvider).login(); return { executable: login.executable, args: login.args, env: login.env, login }; }
    if (run.terminalKind !== 'agent') return { executable: process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh', args: process.platform === 'win32' ? ['-NoLogo'] : ['-l'] };
    const provider = run.provider as TerminalAgentProvider;
    const agent = (await this.agents()).find((item) => item.provider === provider);
    const path = agent?.path ?? await findExecutable(aiProviders.require(provider).executable);
    if (!path) throw new ControlError(`${agentLabel(provider)} CLI was not found on PATH.`, 409);
    // No exec/print mode, prompt or task credentials: the user talks to the CLI directly.
    const { providerArgs, autoModeProviders } = this.settings(), auto = autoModeProviders.includes(provider);
    const accounts = run.account ? providerAccounts(provider) : undefined;
    const env = { ...aiProviders.require(provider).terminalEnv(auto), ...accounts ? await accounts.launchEnv(run.account!) : {} };
    // A known session ID lets the conversation continue later as a task (see convertToTask in service.ts); a resumed session keeps its own.
    const resumed = run.resumeSessionId, sessionId = resumed ?? randomUUID(), sessionArgs = resumed ? [] : aiProviders.require(provider).terminalSessionArgs(sessionId);
    if (resumed || sessionArgs.length) run.sessionId = sessionId; else delete run.sessionId;
    return { executable: path, args: [...resumed ? aiProviders.require(provider).terminalResumeArgs(resumed) : [], ...effectiveProviderArgs(provider, withAutoMode(providerArgs, autoModeProviders), undefined), ...sessionArgs], ...(Object.keys(env).length ? { env } : {}), ...(accounts ? { unset: accounts.overrideEnv } : {}) };
  }
  /** The line a script terminal types into its shell, as if the user had entered it. */
  private async scriptInput(run: ProjectTerminal, project: Project): Promise<string> {
    const script = project.runScripts?.find((item) => item.id === run.scriptId);
    if (!script) throw new ControlError('Run script no longer exists in the project settings.', 409);
    const args = run.scriptArgs ?? script.args;
    if (script.command !== undefined) return scriptLine({ command: script.command }, args);
    const { absolute } = resolveScriptPath(project.repositoryPath, script.path ?? '', script.npmScript !== undefined);
    if (script.npmScript !== undefined || !/\.sh$|\.bash$/i.test(absolute)) return scriptLine({ absolute, ...(script.npmScript !== undefined ? { npmScript: script.npmScript } : {}) }, args);
    const gitBash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '';
    const bash = gitBash && await stat(gitBash).then((item) => item.isFile(), () => false) ? gitBash : process.platform === 'win32' ? await findExecutable('bash') : undefined;
    if (process.platform === 'win32' && !bash) throw new ControlError('bash was not found on PATH. Install Git for Windows or add bash to PATH to run .sh scripts.', 409);
    return scriptLine({ absolute, ...(bash ? { bash } : {}) }, args);
  }
  private launch(entry: Entry, command: Command, line?: string): void {
    const { run, project } = entry, login = command.login;
    // A regular user terminal, without agent prompts, task branches or run identity. Shells and agent CLIs the user
    // opens here may use `aiws control` on this service; scripts and sign-ins get no access to it.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AIWS_') || command.unset?.includes(key)) delete env[key];
    const connection = run.terminalKind === 'agent' || run.terminalKind === 'shell' ? this.connection() : undefined;
    if (connection) { env.AIWS_CONTROL_URL = connection.url; if (connection.token) env.AIWS_CONTROL_TOKEN = connection.token; }
    Object.assign(env, command.env);
    if (login) this.append(run, login.intro);
    const handle = launchPty(project, run, command.executable, command.args, env, {
      output: (_stream, data) => this.append(run, data),
      close: (code, error) => {
        if (entry.handle !== handle) return;
        clearInterval(entry.watch);
        // A terminal the service shut down is interrupted: the next start opens it again.
        run.status = this.closing ? 'interrupted' : code === 0 ? 'completed' : 'failed'; run.exitCode = code; run.finishedAt = new Date().toISOString();
        if (error) this.append(run, `\r\n${error}\r\n`);
        this.update(project.id);
        // The account is registered once the CLI has exited, whether AIWS or the user closed it.
        if (login) void login.finish().then(({ added, message }) => { if (entry.handle === handle && run.status !== 'running') run.status = added ? 'completed' : 'failed'; this.append(run, `\r\n\r\nAIWS: ${message}\r\n`); this.update(project.id); });
      },
    }, command.placement);
    entry.handle = handle;
    if (login) { entry.login = login; entry.watch = setInterval(() => void this.watchLogin(entry, handle), LOGIN_POLL_MS); }
    if (line !== undefined) handle.input?.(`${line}\r`);
  }
  /** Closes a sign-in terminal once the CLI saved the new login; the close handler then registers the account. */
  private async watchLogin(entry: Entry, handle: RuntimeHandle): Promise<void> {
    if (entry.handle !== handle || entry.run.status !== 'running' || !await entry.login?.ready().catch(() => false)) return;
    clearInterval(entry.watch);
    await new Promise((resolve) => setTimeout(resolve, LOGIN_SETTLE_MS));
    if (entry.handle === handle && entry.run.status === 'running') await handle.stop().catch(() => {});
  }
  /** `resume` reopens a provider session from its own workspace (see ProviderSessions.openRunSessionTerminal). */
  async create(project: Project, value: unknown = {}, resume?: { sessionId: string; workspacePath: string }): Promise<ProjectTerminal> {
    const input = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as { kind?: unknown; provider?: unknown; title?: unknown; scriptId?: unknown; args?: unknown; account?: unknown };
    const kind = input.kind === undefined || input.kind === 'shell' ? 'shell' : input.kind === 'agent' ? 'agent' : input.kind === 'script' ? 'script' : input.kind === 'login' ? 'login' : null;
    if (!kind) throw new ControlError('Terminal kind must be shell, agent, script or login.');
    const script = kind === 'script' ? project.runScripts?.find((item) => item.id === input.scriptId) : undefined;
    if (kind === 'script' && !script) throw new ControlError('Choose one of the project run scripts.', 404);
    if (input.args !== undefined && (kind !== 'script' || typeof input.args !== 'string' || input.args.length > 1_000)) throw new ControlError('Script arguments must be text (maximum 1000 characters).');
    if ((kind === 'agent' || kind === 'login') && !aiProviders.has(input.provider)) throw new ControlError(`Choose ${aiProviders.names('or', 'id')} for an agent terminal.`);
    if (kind === 'login') providerAccounts(input.provider as TerminalAgentProvider);
    if (input.account !== undefined && (kind !== 'agent' || !isAccountId(input.account))) throw new ControlError('A terminal account must be an account ID of an agent terminal.');
    const account = input.account as string | undefined, accounts = account ? providerAccounts(input.provider as TerminalAgentProvider) : undefined;
    const accountLabel = account ? (await accounts!.status().catch(() => undefined))?.accounts.find((item) => item.id === account)?.label ?? account : undefined;
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 80)) throw new ControlError('Terminal title must be text (maximum 80 characters).');
    if (this.list(project.id).length >= 8) throw new ControlError('Close a terminal before opening another (maximum 8 per project).', 409);
    const provider = kind === 'agent' || kind === 'login' ? input.provider as TerminalAgentProvider : 'command';
    const defaultTitle = kind === 'login' ? `${agentLabel(provider as TerminalAgentProvider)} sign-in` : kind === 'agent' ? [agentLabel(provider as TerminalAgentProvider), accountLabel].filter(Boolean).join(' · ') : 'Terminal';
    const run: ProjectTerminal = { id: `shell_${randomUUID()}`, projectId: project.id, taskId: '', provider, terminalKind: kind, title: ((input.title as string | undefined)?.trim() || script?.name || defaultTitle).slice(0, 80), ...(script ? { scriptId: script.id } : {}), ...(account ? { account } : {}), ...(script && typeof input.args === 'string' ? { scriptArgs: input.args.trim() } : {}), ...(resume ? { resumeSessionId: resume.sessionId } : {}),
      status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, executionMode: 'native', terminalMode: 'pty', workspacePath: resume?.workspacePath ?? project.repositoryPath, pendingCommands: [], continuation: 0, terminalOutput: '', terminalLength: 0, cols: 100, rows: 30 };
    const command = await this.command(run, project), line = kind === 'script' ? await this.scriptInput(run, project) : undefined;
    if (this.list(project.id).length >= 8) throw new ControlError('Close a terminal before opening another (maximum 8 per project).', 409);
    const entry: Entry = { projectId: project.id, project: { ...project, repositoryPath: run.workspacePath! }, run };
    this.entries.set(run.id, entry); this.store.terminals.push(run);
    try { this.launch(entry, command, line); } catch (error) { this.entries.delete(run.id); this.forget(run.id); throw error; }
    this.update(project.id);
    return this.summary(run);
  }
  /** Starts a terminal again in place; its output continues after a separator. A script terminal whose shell is still open gets the script line typed again, like a user repeating the command. */
  async restart(projectId: string, id: string): Promise<ProjectTerminal> {
    const entry = this.get(projectId, id), { run } = entry;
    if (run.status === 'running' && run.terminalKind !== 'script') throw new ControlError('Terminal is still running.', 409);
    const command = await this.command(run, entry.project), line = run.terminalKind === 'script' ? await this.scriptInput(run, entry.project) : undefined;
    if (run.status === 'running') {
      // Ctrl+C ends a script still running in the shell (or just redraws an idle prompt), then the line is entered again.
      entry.handle?.input?.('\x03'); await new Promise((resolve) => setTimeout(resolve, 200));
      if (this.entries.get(id) !== entry || run.status !== 'running') throw new ControlError('Terminal is no longer available.', 409);
      entry.handle?.input?.(`${line}\r`);
      this.changed(projectId);
      return this.summary(run);
    }
    this.append(run, '\r\n---restarted---\r\n');
    this.relaunch(entry, command, line);
    return this.summary(run);
  }
  /** Starts the process of an exited terminal again on the same output stream. */
  private relaunch(entry: Entry, command: Command, line: string | undefined): void {
    const { run } = entry;
    Object.assign(run, { status: 'running', exitCode: null, finishedAt: null, startedAt: new Date().toISOString() });
    try { this.launch(entry, command, line); } catch (error) { Object.assign(run, { status: 'failed', exitCode: 127, finishedAt: new Date().toISOString() }); this.update(entry.projectId); throw error; }
    this.update(entry.projectId);
  }
  /**
   * Opens the stored terminals of a previous service run again: an exited terminal is shown as it ended. A terminal still
   * running at shutdown (or when the service crashed) carries on: an agent terminal resumes its provider session after a
   * separator; a shell or script terminal gets a new shell below its output, in the same directory, without a note and
   * without its script being entered again. Only a sign-in cannot continue: it is shown as interrupted.
   */
  async restore(project: (projectId: string) => Project | undefined): Promise<void> {
    const kept: ProjectTerminal[] = [], resumed: Entry[] = [];
    for (const run of this.store.terminals) {
      const owner = typeof run.projectId === 'string' ? project(run.projectId) : undefined;
      if (!owner || this.entries.has(run.id)) continue;
      const entry: Entry = { projectId: owner.id, project: { ...owner, repositoryPath: run.workspacePath ?? owner.repositoryPath }, run };
      this.entries.set(run.id, entry); kept.push(run);
      if (run.status === 'running' || run.status === 'interrupted') resumed.push(entry);
    }
    if (kept.length !== this.store.terminals.length) { this.store.terminals.splice(0, this.store.terminals.length, ...kept); this.store.scheduleSave(); }
    await Promise.all(resumed.map(async (entry) => {
      const { run } = entry;
      if (run.terminalKind === 'login') {
        Object.assign(run, { status: 'interrupted', finishedAt: run.finishedAt ?? new Date().toISOString() });
        this.append(run, `${TERMINAL_RESUMED_SEPARATOR}AIWS: the sign-in did not finish before the service stopped. Close this terminal and sign in again.\r\n`);
        this.update(entry.projectId); return;
      }
      try {
        if (run.terminalKind !== 'agent') {
          this.append(run, '\r\n');
          this.relaunch(entry, { ...await this.command(run, entry.project), placement: await this.continuation(entry) }, undefined);
          return;
        }
        this.append(run, TERMINAL_RESUMED_SEPARATOR);
        // The conversation so far lives in the provider session; a manual restart later starts a fresh one as before.
        const ownSession = run.resumeSessionId ? undefined : run.sessionId;
        if (ownSession) run.resumeSessionId = ownSession;
        const command = await this.command(run, entry.project);
        if (ownSession) delete run.resumeSessionId;
        this.relaunch(entry, command, undefined);
      } catch (error) {
        Object.assign(run, { status: 'failed', exitCode: run.exitCode ?? 127, finishedAt: new Date().toISOString() });
        this.append(run, `AIWS: the terminal could not be opened again: ${error instanceof Error ? error.message : String(error)}\r\n`); this.update(entry.projectId);
      }
    }));
  }
  /** Where a shell opened again by restore() carries on, read from what the previous one wrote: the directory of its last prompt that still exists, and on Windows the cursor, since ConPTY would otherwise clear the screen. */
  private async continuation({ run }: Entry): Promise<PtyPlacement> {
    const screen = new TerminalScreen(run.rows ?? 30);
    screen.resize(run.cols ?? 100, run.rows ?? 30);
    screen.write(this.store.terminalOutput(run));
    const prompts = screen.logicalText(true).flatMap((line) => POWERSHELL_PROMPT.exec(line)?.[1] ?? []);
    const cwd = prompts.at(-1), exists = cwd && await stat(cwd).then((item) => item.isDirectory(), () => false);
    return { ...(exists ? { cwd } : {}), ...(process.platform === 'win32' ? { cursor: screen.cursor() } : {}) };
  }
  private forget(id: string): void {
    const index = this.store.terminals.findIndex((item) => item.id === id);
    if (index >= 0) this.store.terminals.splice(index, 1);
    this.store.scheduleSave();
  }
  rename(projectId: string, id: string, value: unknown): ProjectTerminal {
    const title = (value as { title?: unknown } | null)?.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new ControlError('Terminal title must be 1-80 characters.');
    const { run } = this.get(projectId, id); run.title = title.trim();
    this.update(projectId);
    return this.summary(run);
  }
  input(projectId: string, id: string, value: unknown): void {
    const data = (value as { data?: unknown } | null)?.data;
    if (typeof data !== 'string' || data.length > 65536) throw new ControlError('Terminal input must be text (maximum 65536 characters).');
    const entry = this.get(projectId, id);
    if (entry.run.status !== 'running') throw new ControlError('Terminal has exited.', 409);
    entry.handle?.input?.(data);
  }
  /** The user cleared the console: the PTY clears its screen too, so the shell keeps drawing from the top. */
  clear(projectId: string, id: string): void {
    const entry = this.get(projectId, id);
    if (entry.run.status === 'running') entry.handle?.clear?.();
  }
  /** Sends a user's message to the running agent terminal of one of these provider sessions, like the instruction of a running task: Escape cuts a turn under way so it is read now. Returns whether such a terminal is open. */
  typeIntoSession(projectId: string, sessionIds: readonly string[], message: string): boolean {
    const ids = new Set(sessionIds.map((id) => id.toLowerCase()));
    const entry = [...this.entries.values()].find(({ projectId: owner, run }) => owner === projectId && run.terminalKind === 'agent' && run.status === 'running' && run.sessionId && ids.has(run.sessionId.toLowerCase()));
    if (!entry?.handle?.input) return false;
    const type = (data: string): void => { if (entry.run.status === 'running') entry.handle?.input?.(data); };
    type('\u001b');
    setTimeout(() => { type(message); setTimeout(() => type('\r'), serviceTiming.terminalSubmitDelayMs).unref(); }, serviceTiming.terminalSubmitDelayMs).unref();
    return true;
  }
  resize(projectId: string, id: string, value: unknown): void {
    const { cols, rows } = (value ?? {}) as { cols?: number; rows?: number };
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 2 || cols! > 500 || rows! < 2 || rows! > 300) throw new ControlError('Invalid terminal dimensions.');
    const entry = this.get(projectId, id);
    if (entry.run.cols === cols && entry.run.rows === rows) return;
    if (entry.run.status === 'running') entry.handle?.resize?.(cols!, rows!);
    entry.run.cols = cols!; entry.run.rows = rows!; this.store.scheduleSave();
  }
  /** Closing a terminal ends its whole process tree (the shell or agent CLI and anything it started). */
  async remove(projectId: string, id: string): Promise<void> {
    const entry = this.get(projectId, id);
    this.entries.delete(id); this.forget(id); this.changed(projectId); clearInterval(entry.watch);
    await entry.handle?.stop();
  }
  /** Stops every terminal process; the terminals stay stored as interrupted so the next service start opens them again. */
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.entries.values()) clearInterval(entry.watch);
    await Promise.allSettled([...this.entries.values()].map(entry => entry.handle?.stop())); this.entries.clear();
  }
}
