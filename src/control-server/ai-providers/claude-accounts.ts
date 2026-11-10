import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandError, findExecutable, NodeCommandRunner, type CommandOptions, type CommandResult } from '../../shared/core/command.js';
import { aiwsHomePath } from '../../shared/core/paths.js';
import { ControlError } from '../types.js';
import { windowsLauncher } from '../windows-launch.js';
import { readJson, usageWindow, type RecordData } from './usage.js';
import type { ProviderAccount, ProviderAccountLogin, ProviderAccounts, ProviderAccountsStatus } from './types.js';

const TOOL = { name: 'claude-swap', command: 'cswap', url: 'https://github.com/realiti4/claude-swap' };
/** cswap slot numbers; the only account reference AIWS passes to cswap. */
const SLOT = /^\d{1,4}$/;
/** Claude Code prefers these to its own login, so `cswap run` and AIWS's account launches drop them. */
const OVERRIDE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'];
const LOGIN_INTRO = 'AIWS: Claude Code opens in a separate profile for the new account. Sign in with /login (or the first-run sign-in).\r\nAIWS adds the account to claude-swap as soon as the sign-in finishes and closes this terminal. Your current login is not changed.\r\n\r\n';

export interface ClaudeAccountsOptions {
  home?: string; env?: NodeJS.ProcessEnv;
  /** Runs a command and collects its output; tests replace it. */
  run?(command: string, args: string[], options: CommandOptions): Promise<CommandResult>;
  /** Finds a command on PATH; tests replace it. */
  find?(name: string): Promise<string | null>;
  /** Claude Code's history folder; account sessions write their transcripts there so AIWS finds them. */
  historyHome?(): string;
}

/** The last line cswap printed about a failure, else the error itself. */
function failure(error: unknown): string {
  if (error instanceof CommandError) {
    const lines = `${error.result.stderr}\n${error.result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `cswap list --json` rows as provider accounts. A row without fresh usage shows its last known reading. */
export function parseClaudeAccounts(stdout: string): ProviderAccount[] {
  const start = stdout.indexOf('{'), end = stdout.lastIndexOf('}');
  const value = start < 0 ? null : JSON.parse(stdout.slice(start, end + 1)) as RecordData | null;
  if (!value || typeof value !== 'object') throw new Error('claude-swap returned no account list.');
  if (value.error) throw new Error(String(value.error.message ?? 'claude-swap failed.'));
  return (Array.isArray(value.accounts) ? value.accounts : []).flatMap((row: RecordData): ProviderAccount[] => {
    if (!Number.isInteger(row?.number) || typeof row.email !== 'string') return [];
    const usage: RecordData = row.usage ?? row.lastGoodUsage ?? {};
    const alias = typeof row.alias === 'string' && row.alias ? row.alias : undefined;
    return [{ id: String(row.number), email: row.email, label: alias ?? row.email, ...(alias ? { alias } : {}),
      ...(typeof row.organizationName === 'string' && row.organizationName ? { organization: row.organizationName } : {}),
      active: row.active === true, disabled: row.disabled === true, status: typeof row.usageStatus === 'string' ? row.usageStatus : 'unavailable',
      short: usageWindow(usage.fiveHour?.pct, usage.fiveHour?.resetsAt, 300), weekly: usageWindow(usage.sevenDay?.pct, usage.sevenDay?.resetsAt, 10080),
      updatedAt: typeof (row.usageFetchedAt ?? row.lastGoodFetchedAt) === 'string' ? row.usageFetchedAt ?? row.lastGoodFetchedAt : null,
      ...(typeof row.loginExpiresAt === 'string' ? { loginExpiresAt: row.loginExpiresAt } : {}) }];
  });
}

/**
 * Claude Code accounts through claude-swap (cswap): AIWS installs the tool, lists its accounts with their quota,
 * signs new accounts in from a terminal and launches runs with `cswap run`'s per-account profile
 * (CLAUDE_CONFIG_DIR). Credentials stay in claude-swap's store; AIWS only reads its JSON output.
 */
export class ClaudeAccounts implements ProviderAccounts {
  readonly overrideEnv = OVERRIDE_ENV;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner = new NodeCommandRunner();
  private cached: { at: number; value: ProviderAccountsStatus } | undefined;
  private flight: Promise<ProviderAccountsStatus> | undefined;
  /** cswap's data folder, which holds the session profiles. */
  private root: string | undefined;
  constructor(private readonly options: ClaudeAccountsOptions = {}) {
    this.home = options.home ?? homedir(); this.env = options.env ?? process.env;
  }

  private find(name: string): Promise<string | null> { return this.options.find ? this.options.find(name) : findExecutable(name, this.env); }
  /** A command on PATH, else in the folders uv and pipx install tools into. */
  private async locate(name: string): Promise<string | null> {
    const found = await this.find(name); if (found) return found;
    for (const directory of [this.env.UV_TOOL_BIN_DIR, this.env.PIPX_BIN_DIR, this.env.XDG_BIN_HOME, join(this.home, '.local', 'bin')]) {
      const path = directory ? await this.find(join(directory, name)) : null;
      if (path) return path;
    }
    return null;
  }
  private exec(path: string, args: string[], timeoutMs: number, env: Record<string, string> = {}, input?: string): Promise<CommandResult> {
    const launch = windowsLauncher(path, args, { ...this.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', ...env });
    const options: CommandOptions = { env: launch.env, timeoutMs, ...(input === undefined ? {} : { input }) };
    return this.options.run ? this.options.run(launch.executable, launch.args, options) : this.runner.run(launch.executable, launch.args, options);
  }
  private async cswap(): Promise<string> {
    const path = await this.locate(TOOL.command);
    if (!path) throw new ControlError('claude-swap is not installed. Install it from Settings → Providers → Claude Code accounts.', 409);
    return path;
  }

  async status(maxAgeMs = 60_000, background = false): Promise<ProviderAccountsStatus> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return this.cached.value;
    this.flight ??= this.read().then((value) => { this.cached = { at: Date.now(), value }; return value; }).finally(() => { this.flight = undefined; });
    return background && this.cached ? this.cached.value : this.flight;
  }
  private async read(): Promise<ProviderAccountsStatus> {
    const [path, uv, pipx] = await Promise.all([this.locate(TOOL.command), this.locate('uv'), this.locate('pipx')]);
    const tool = { ...TOOL, installed: Boolean(path), ...(path ? { path } : {}), installer: uv ? 'uv' : pipx ? 'pipx' : null }, checkedAt = new Date().toISOString();
    if (!path) return { tool, accounts: [], checkedAt };
    try { return { tool, accounts: parseClaudeAccounts((await this.exec(path, ['list', '--json'], 90_000)).stdout), checkedAt }; }
    catch (error) { return { tool, accounts: this.cached?.value.accounts ?? [], checkedAt, error: failure(error) }; }
  }
  private forget(): void { this.cached = undefined; }

  /** `uv tool install claude-swap`, or pipx when uv is missing; uv brings the Python it needs. */
  async install(): Promise<ProviderAccountsStatus> {
    const uv = await this.locate('uv'), pipx = uv ? null : await this.locate('pipx');
    if (!uv && !pipx) throw new ControlError('Installing claude-swap needs uv or pipx. Install uv (https://docs.astral.sh/uv/) and try again.', 409);
    try { await this.exec(uv ?? pipx!, uv ? ['tool', 'install', 'claude-swap'] : ['install', 'claude-swap'], 600_000); }
    catch (error) { throw new ControlError(`claude-swap could not be installed: ${failure(error)}`, 502); }
    this.forget(); this.root = undefined;
    const status = await this.status(0);
    if (!status.tool.installed) throw new ControlError('claude-swap was installed, but cswap is not on PATH. Add the uv tool folder (uv tool dir --bin) to PATH and restart AIWS.', 409);
    return status;
  }

  /** `cswap add` with the default environment: stores the account Claude Code is signed in with. */
  addCurrent(): Promise<ProviderAccountsStatus> { return this.change(['add'], 'add the current login'); }
  async remove(id: string): Promise<ProviderAccountsStatus> {
    if (!SLOT.test(id)) throw new ControlError('Choose a claude-swap account number.');
    // cswap asks before removing; the UI already confirmed.
    return this.change(['remove', id], 'remove the account', 'y\n');
  }
  private async change(args: string[], action: string, input?: string): Promise<ProviderAccountsStatus> {
    const cswap = await this.cswap();
    try { await this.exec(cswap, args, 60_000, {}, input); }
    catch (error) { throw new ControlError(`claude-swap could not ${action}: ${failure(error)}`, 409); }
    finally { this.forget(); }
    return this.status(0);
  }

  /**
   * Claude Code in a fresh profile of its own: the user signs in there, `cswap add` (which reads the profile
   * CLAUDE_CONFIG_DIR names) stores the account, and the profile is deleted so only claude-swap keeps the login.
   */
  async login(): Promise<ProviderAccountLogin> {
    const cswap = await this.cswap(), claude = await this.find('claude');
    if (!claude) throw new ControlError('Claude Code CLI was not found on PATH.', 409);
    const directory = join(aiwsHomePath({ env: this.env, homeDir: this.home }), 'claude-logins', randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const account = async (): Promise<string | undefined> => {
      const email = (await readJson(join(directory, '.claude.json'))).oauthAccount?.emailAddress;
      // macOS keeps the token in the keychain; elsewhere it must be on disk before cswap can read it.
      const token = process.platform === 'darwin' || Boolean((await readJson(join(directory, '.credentials.json'))).claudeAiOauth?.accessToken);
      return typeof email === 'string' && email && token ? email : undefined;
    };
    let finished: Promise<{ added: boolean; message: string }> | undefined;
    return {
      executable: claude, args: [], env: { CLAUDE_CONFIG_DIR: directory }, intro: LOGIN_INTRO,
      ready: async () => Boolean(await account()),
      finish: () => finished ??= (async () => {
        try {
          const email = await account();
          if (!email) return { added: false, message: 'No account signed in; nothing was added.' };
          await this.exec(cswap, ['add'], 60_000, { CLAUDE_CONFIG_DIR: directory });
          return { added: true, message: `Added ${email} to claude-swap.` };
        } catch (error) { return { added: false, message: `claude-swap could not add the account: ${failure(error)}` }; }
        finally { this.forget(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}); }
      })(),
    };
  }

  /**
   * Prepares the account's `cswap run` profile (seeding or refreshing its login and shared settings) by letting
   * cswap start `claude --version` in it, then returns the profile for AIWS to launch Claude Code in. The account
   * that is the default login runs as plain claude, as `cswap run` does.
   */
  async launchEnv(id: string): Promise<Record<string, string>> {
    if (!SLOT.test(id)) throw new ControlError('Choose a claude-swap account number.');
    const cswap = await this.cswap();
    const account = (await this.status(30_000)).accounts.find((item) => item.id === id) ?? (await this.status(0)).accounts.find((item) => item.id === id);
    if (!account) throw new ControlError(`Claude account ${id} is no longer in claude-swap. Choose another account.`, 409);
    if (account.active) return {};
    // POSIX shares history through cswap's links; Windows gets a junction below.
    const posix = process.platform !== 'win32';
    try { await this.exec(cswap, ['run', id, '--require-session', ...(posix ? ['--share-history'] : []), '--', '--version'], 180_000); }
    catch (error) {
      // It became the default login since the last listing.
      if ((await this.status(0)).accounts.find((item) => item.id === id)?.active) return {};
      throw new ControlError(`claude-swap could not prepare ${account.label}: ${failure(error)}`, 409);
    }
    const profile = await this.profile(cswap, id);
    if (!posix && this.options.historyHome) await shareHistory(profile, this.options.historyHome());
    return { CLAUDE_CONFIG_DIR: profile };
  }
  /** `<cswap data>/sessions/<slot>-<email>`, the profile `cswap run` keeps for the account. */
  private async profile(cswap: string, id: string): Promise<string> {
    this.root ??= dirname((await this.exec(cswap, ['config', 'path'], 30_000)).stdout.trim());
    const sessions = join(this.root, 'sessions');
    const entry = (await readdir(sessions, { withFileTypes: true }).catch(() => [])).find((item) => item.isDirectory() && item.name.startsWith(`${id}-`));
    if (!entry) throw new ControlError(`claude-swap did not create a session profile for account ${id}.`, 409);
    return join(sessions, entry.name);
  }
}

/**
 * Links the profile's `projects` folder to Claude Code's default one, so transcripts of account runs land where
 * AIWS reads history (`cswap run --share-history` does the same on macOS and Linux). A profile that already has
 * its own non-empty history is left alone.
 */
async function shareHistory(profile: string, home: string): Promise<void> {
  const link = join(profile, 'projects'), target = join(home, 'projects');
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink()) return;
  if (existing) { if (!existing.isDirectory() || (await readdir(link)).length) return; await rmdir(link); }
  await mkdir(target, { recursive: true });
  await symlink(target, link, 'junction');
}
