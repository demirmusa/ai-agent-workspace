import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findExecutable } from '../shared/core/command.js';
import { aiProviders, type IAIProvider } from './ai-providers/index.js';
import { SESSION_CAP } from './ai-providers/support.js';
import { execCli } from './windows-launch.js';
import type { CustomProvider, DefaultProvider } from './types.js';

export interface ExecutableProbe { path: string | null; version: string | null; error?: string }
export interface ProviderDetection {
  id: string; kind: 'builtin' | 'custom'; name: string; executable: string;
  installed: boolean; path: string | null; version: string | null; error?: string;
  home: string | null; homeExists: boolean; sessions: number | null; sessionsCapped: boolean;
}
export interface ProviderDetectionResult { providers: ProviderDetection[]; checkedAt: string }
export interface ProviderDetectionOptions {
  home?: string; env?: NodeJS.ProcessEnv;
  /** Replaces PATH lookup and `--version` for tests. */
  probe?: (executable: string) => Promise<ExecutableProbe>;
  ttlMs?: number; timeoutMs?: number; now?: () => number;
}

export const PROVIDER_EXECUTABLES = Object.fromEntries(aiProviders.list().map((provider) => [provider.id, provider.executable])) as Record<DefaultProvider, string>;

async function isDirectory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }

async function runVersion(path: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string | null> {
  const result = await execCli(path, ['--version'], { env, timeout, maxBuffer: 64 * 1024 });
  if (!result) return null;
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line && !result.error?.killed ? line.slice(0, 160) : null;
}

/** Detects provider CLIs installed on this computer and their local configuration and session history. */
export class ProviderDetector {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly probeExecutable: (executable: string) => Promise<ExecutableProbe>;
  private cache: { key: string; at: number; result: ProviderDetectionResult } | undefined;
  private inFlight: { key: string; promise: Promise<ProviderDetectionResult> } | undefined;

  constructor(options: ProviderDetectionOptions = {}) {
    this.env = options.env ?? process.env; this.home = options.home ?? homedir();
    this.ttlMs = options.ttlMs ?? 30_000; this.timeoutMs = options.timeoutMs ?? 6000; this.now = options.now ?? Date.now;
    this.probeExecutable = options.probe ?? (async (executable) => {
      const path = await findExecutable(executable, this.env);
      if (!path) return { path: null, version: null };
      try { return { path, version: await runVersion(path, this.env, this.timeoutMs) }; } catch (error) { return { path, version: null, error: (error as Error).message }; }
    });
  }

  private async builtin(provider: IAIProvider): Promise<ProviderDetection> {
    const home = provider.homeDirectory(this.env, this.home);
    const [probe, homeExists] = await Promise.all([this.probeExecutable(provider.executable).catch((error: Error) => ({ path: null, version: null, error: error.message })), isDirectory(home)]);
    // A missing folder counts as no sessions, except for providers whose sessions are never counted.
    const sessions = await provider.countSessions(home);
    return { id: provider.id, kind: 'builtin', name: provider.name, executable: provider.executable, installed: Boolean(probe.path), path: probe.path, version: probe.version, ...(probe.error ? { error: probe.error } : {}), home, homeExists, sessions, sessionsCapped: sessions !== null && sessions >= SESSION_CAP };
  }

  private async custom(provider: CustomProvider): Promise<ProviderDetection> {
    const probe = await this.probeExecutable(provider.executable).catch((error: Error) => ({ path: null, version: null, error: error.message }));
    return { id: provider.id, kind: 'custom', name: provider.name, executable: provider.executable, installed: Boolean(probe.path), path: probe.path, version: probe.version, ...(probe.error ? { error: probe.error } : {}), home: null, homeExists: false, sessions: null, sessionsCapped: false };
  }

  /** Cached briefly; concurrent callers share one scan. Probes run in parallel and never block the event loop. */
  detect(customProviders: CustomProvider[] = [], refresh = false): Promise<ProviderDetectionResult> {
    const key = JSON.stringify(customProviders.map((provider) => [provider.id, provider.name, provider.executable]));
    if (!refresh && this.cache?.key === key && this.now() - this.cache.at < this.ttlMs) return Promise.resolve(structuredClone(this.cache.result));
    if (this.inFlight?.key === key) return this.inFlight.promise.then((result) => structuredClone(result));
    const promise = Promise.all([...aiProviders.list().map((provider) => this.builtin(provider)), ...customProviders.map((provider) => this.custom(provider))])
      .then((providers) => { const result = { providers, checkedAt: new Date(this.now()).toISOString() }; this.cache = { key, at: this.now(), result }; return result; })
      .finally(() => { if (this.inFlight?.promise === promise) this.inFlight = undefined; });
    this.inFlight = { key, promise };
    return promise.then((result) => structuredClone(result));
  }
}
