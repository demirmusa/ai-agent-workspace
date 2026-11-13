import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { killWindowsProcessTree, windowsLauncher } from './windows-launch.js';
import { ghAuthToken } from './github-api.js';
import { aiProviders, usageWindow, type IAIProvider, type ProviderUsage, type UsageContext, type UsageKey } from './ai-providers/index.js';
import type { DefaultProvider } from './types.js';

export { usageTimestamp, usageWindow, type ProviderUsage, type UsageBucket, type UsageKey, type UsageWindow } from './ai-providers/index.js';
export interface TokenUsageOptions {
  home?: string; cachePath?: string; env?: NodeJS.ProcessEnv;
  /** Provider home folders, replacing each provider's default. */
  dirs?: Partial<Record<DefaultProvider, string>>;
  codexDir?: string; claudeDir?: string; agyDir?: string;
  fetch?: typeof fetch; now?: () => number;
  /** Replaces running a provider CLI for usage. */
  commands?: Partial<Record<DefaultProvider, (args: string[]) => Promise<string>>>;
  agyCommand?: (args: string[]) => Promise<string>;
  githubToken?: () => Promise<string | undefined>;
  /** Lists the accounts of providers that have several; by default only for the real home folder. */
  accounts?: boolean;
}

const MAX_OUTPUT = 1024 * 1024;
function runCli(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = windowsLauncher(executable, args, process.env);
    const startedAt = Date.now();
    const child = spawn(command.executable, command.args, { env: command.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // On Windows the CLI runs below a PowerShell launcher; killing only the launcher would leave the CLI running.
    const kill = (): void => { if (process.platform === 'win32' && child.pid) void killWindowsProcessTree(child.pid, startedAt); else child.kill(); };
    let stdout = '';
    const timer = setTimeout(() => { kill(); reject(new Error(`${executable} timeout`)); }, 15000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > MAX_OUTPUT) { clearTimeout(timer); kill(); reject(new Error(`${executable} printed too much output`)); } });
    child.stderr?.resume();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); if (code === 0 && stdout.trim()) resolve(stdout); else reject(new Error(`${executable} exited with ${code}`)); });
  });
}

/** Native port of windows-ai-token-viewer over every registered provider. Credentials never leave this service. */
export class TokenUsageMonitor {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dirs: Partial<Record<DefaultProvider, string>>;
  private readonly commands: Partial<Record<DefaultProvider, (args: string[]) => Promise<string>>>;
  private readonly cachePath: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly retry = new Map<DefaultProvider, number>();
  private readonly remoteChecked = new Map<DefaultProvider, number>();
  private readonly inFlight = new Map<string, Promise<ProviderUsage | null>>();
  private scanFlight: Promise<{ providers: ProviderUsage[]; timestamp: string }> | undefined;
  private lastScan: { providers: ProviderUsage[]; timestamp: string } | undefined;
  private lastSkip = '';
  private lastScanAt = -Infinity;
  constructor(private readonly options: TokenUsageOptions = {}) {
    this.home = options.home ?? homedir();
    // Tests with their own home folder never see the real environment's tokens or folders.
    this.env = options.env ?? (options.home ? {} : process.env);
    this.dirs = { ...(options.codexDir ? { codex: options.codexDir } : {}), ...(options.claudeDir ? { claude: options.claudeDir } : {}), ...(options.agyDir ? { agy: options.agyDir } : {}), ...options.dirs };
    this.commands = { ...(options.agyCommand ? { agy: options.agyCommand } : {}), ...options.commands };
    this.cachePath = options.cachePath ?? join(this.home, '.aiws', 'token-usage-cache.json');
    this.request = options.fetch ?? fetch; this.now = options.now ?? Date.now;
  }
  /**
   * Skipped providers and accounts (hidden in the usage dialog) are listed without any local, CLI or API lookup.
   * `force` (a manual refresh) skips the interval between remote checks; `provider` limits the scan to one provider and its
   * accounts, so the dialog can show each provider as soon as it answers. Providers are checked in parallel.
   */
  async scan(allowApi = false, skip: readonly UsageKey[] = [], options: { force?: boolean; provider?: DefaultProvider } = {}): Promise<{ providers: ProviderUsage[]; timestamp: string }> {
    const force = allowApi && options.force === true;
    if (options.provider) {
      const provider = aiProviders.list().find((item) => item.id === options.provider);
      return { providers: provider ? await this.cards(provider, allowApi, force, skip) : [], timestamp: new Date(this.now()).toISOString() };
    }
    const skipKey = [...skip].sort().join(',');
    if (this.scanFlight) { await this.scanFlight; if (!allowApi && this.lastSkip === skipKey) return this.lastScan!; }
    if (!allowApi && this.lastScan && this.lastSkip === skipKey && this.now() - this.lastScanAt < 5000) return this.lastScan;
    this.scanFlight = (async () => {
      const cards = await Promise.all(aiProviders.list().map((provider) => this.cards(provider, allowApi, force, skip)));
      // A provider's own card first, then every provider's other accounts, as before.
      const providers = [...cards.map((list) => list.filter((card) => !card.accountId)).flat(), ...cards.map((list) => list.filter((card) => card.accountId)).flat()];
      this.lastSkip = skipKey; this.lastScanAt = this.now(); return this.lastScan = { providers, timestamp: new Date(this.now()).toISOString() };
    })();
    try { return await this.scanFlight; } finally { this.scanFlight = undefined; }
  }
  /** One provider's card (or its skipped placeholder) followed by its other accounts' cards. */
  private async cards(provider: IAIProvider, allowApi: boolean, force: boolean, skip: readonly UsageKey[]): Promise<ProviderUsage[]> {
    const [own, accounts] = await Promise.all([
      skip.includes(provider.id) ? this.skipped(provider) : this.provider(provider, allowApi, force),
      this.accounts(provider, allowApi, skip),
    ]);
    return [...(own ? [own] : []), ...accounts];
  }
  /**
   * A card per account of a provider that runs several, except the default login's account (the provider's own card).
   * The account manager's listing is cached; an older one is shown at once while a new one loads.
   */
  private async accounts(provider: IAIProvider, allowApi: boolean, skip: readonly UsageKey[]): Promise<ProviderUsage[]> {
    // Only the real home folder has an account manager; tests and custom folders have none.
    if (!provider.accounts || !(this.options.accounts ?? (!this.options.home && !this.dirs[provider.id]))) return [];
    const status = await provider.accounts.status(allowApi ? 30_000 : 120_000, true).catch(() => undefined);
    return (status?.accounts ?? []).filter((account) => !account.active).map((account): ProviderUsage => {
      const card = { key: `${provider.id}@${account.id}` as UsageKey, provider: provider.id, accountId: account.id, account: account.label };
      if (skip.includes(card.key)) return { ...this.skipped(provider), ...card };
      return { ...card, name: provider.name, source: account.status === 'ok' ? 'api' : account.updatedAt ? 'cache' : 'unavailable', updatedAt: account.updatedAt, active: false, short: account.short, weekly: account.weekly, retryAt: null };
    });
  }
  private skipped(provider: IAIProvider): ProviderUsage {
    return { key: provider.id, name: provider.name, account: '', source: 'unavailable', updatedAt: null, active: false, short: usageWindow(null, null), weekly: usageWindow(null, null, 10080), retryAt: null };
  }
  private context(provider: IAIProvider, allowApi: boolean, force: boolean): UsageContext {
    const key = provider.id, dir = this.dirs[key];
    // The real CLI runs only for the real home folder; tests and custom folders pass their own command.
    const command = this.commands[key] ?? (!this.options.home && !dir ? (args: string[]) => runCli(provider.executable, args) : undefined);
    return {
      dir: dir ?? provider.homeDirectory(this.env, this.home), home: this.home, env: this.env, cachePath: this.cachePath,
      allowApi, force, now: this.now, request: this.request, ...(command ? { command } : {}),
      ...(this.options.githubToken ? { githubToken: this.options.githubToken } : !this.options.home ? { githubToken: () => ghAuthToken() } : {}),
      retryAt: () => this.retry.get(key), setRetry: (at) => { if (at === undefined) this.retry.delete(key); else this.retry.set(key, at); },
      checkedAt: () => this.remoteChecked.get(key), markChecked: () => { this.remoteChecked.set(key, this.now()); },
    };
  }
  /** Concurrent lookups of one provider share a single run per mode, so a manual refresh never gets a local-only answer. */
  private async provider(provider: IAIProvider, allowApi: boolean, force: boolean): Promise<ProviderUsage | null> {
    const key = `${provider.id}:${force ? 'force' : allowApi ? 'api' : 'local'}`;
    const pending = this.inFlight.get(key); if (pending) return pending;
    const task = provider.getRemainingTokensAllDetailed(this.context(provider, allowApi, force)); this.inFlight.set(key, task);
    try { return await task; } finally { this.inFlight.delete(key); }
  }
}
