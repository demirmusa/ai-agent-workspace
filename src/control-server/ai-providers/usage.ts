import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../../shared/core/json.js';
import type { DefaultProvider } from '../types.js';

export type RecordData = Record<string, any>;
export interface UsageWindow { usedPercent: number | null; resetsAt: string | null; windowMinutes: number }
/** An extra quota beside the main windows; `scope` names what a scoped window covers (e.g. one model), so the UI can label it in its own language. */
export interface UsageBucket { id: string; label: string; window: UsageWindow; scope?: string }
export interface UsageWindows { short: UsageWindow; weekly: UsageWindow; buckets?: UsageBucket[] }
/** A usage card: a provider's default login, or one of its other accounts as `<provider>@<account id>`. */
export type UsageKey = DefaultProvider | `${DefaultProvider}@${string}`;
export interface ProviderUsage {
  key: UsageKey; name: string; account: string; source: 'local' | 'cache' | 'api' | 'unavailable';
  updatedAt: string | null; active: boolean; short: UsageWindow; weekly: UsageWindow; retryAt: string | null;
  buckets?: UsageBucket[];
  /** Set on an account card: its provider and account ID (see ProviderAccounts). */
  provider?: DefaultProvider; accountId?: string;
}

export function usageTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? (value > 1e11 ? value : value * 1000) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) && Math.abs(result) <= 8.64e15 ? result : null;
}
export function usageWindow(percent: unknown, reset: unknown, minutes = 300): UsageWindow {
  const numeric = typeof percent === 'number' || (typeof percent === 'string' && percent.trim()) ? Number(percent) : NaN;
  const timestamp = usageTimestamp(reset);
  return { usedPercent: Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null,
    resetsAt: timestamp === null ? null : new Date(timestamp).toISOString(), windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 300 };
}
/** Buckets as `serialize` saved them in the shared cache; entries without a reading are dropped. */
export function savedBuckets(value: RecordData, minutes: number): UsageBucket[] {
  return (Array.isArray(value.buckets) ? value.buckets : [])
    .map((b: any): UsageBucket => ({ id: String(b?.id ?? ''), label: String(b?.label ?? b?.id ?? ''),
      window: usageWindow(b?.window?.usedPercent ?? b?.used_percent ?? b?.utilization, b?.window?.resetsAt ?? b?.resets_at, b?.window?.windowMinutes ?? minutes),
      ...(typeof b?.scope === 'string' && b.scope ? { scope: b.scope } : {}) }))
    .filter((b: UsageBucket) => b.label && b.window.usedPercent !== null);
}
export async function readJson(path: string): Promise<RecordData> {
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {}; } catch { return {}; }
}
export const hasUsage = (windows: UsageWindows): boolean => windows.short.usedPercent !== null || windows.weekly.usedPercent !== null;

/** What TokenUsageMonitor hands a provider: its folders, the shared cache and remote-call bookkeeping. */
export interface UsageContext {
  /** The provider's home folder (or the test override). */
  dir: string; home: string; env: NodeJS.ProcessEnv; cachePath: string;
  allowApi: boolean;
  /** A manual refresh: the remote check runs even for fresh data and skips the interval between automatic checks (a 429 still postpones it). */
  force: boolean;
  now(): number;
  /** Runs the provider CLI for usage; absent when it must not be started (tests, custom folders). */
  command?: (args: string[]) => Promise<string>;
  /** Reads the existing GitHub CLI login without exposing its token to provider processes. */
  githubToken?(): Promise<string | undefined>;
  request: typeof fetch;
  /** Earliest time a remote check may run again after a 429. */
  retryAt(): number | undefined; setRetry(at: number | undefined): void;
  /** Last remote check; automatic remote calls run at most every REMOTE_INTERVAL. */
  checkedAt(): number | undefined; markChecked(): void;
}

/** A remote result: windows to show and optionally the account it belongs to. */
export interface RemoteUsage { windows: UsageWindows; account?: string }

/** Where a provider keeps its quota: local files, the shared snapshot cache and an optional remote source. */
export interface UsageSource {
  name: string; defaultAccount: string;
  auth(context: UsageContext): Promise<RecordData>;
  account?(context: UsageContext): Promise<RecordData>;
  local(context: UsageContext): Promise<{ value: RecordData; timestamp: number | null }>;
  normalize(value: RecordData, now: number): UsageWindows;
  /** A missing weekly window is filled from older snapshots. */
  weeklyFromSnapshots?: boolean;
  /** Local files carry only the main windows, so extra buckets need a remote check even while they are fresh. */
  localPartial?: boolean;
  /** Remote checks also run without an explicit refresh (e.g. a cheap local CLI). */
  remoteWithoutApi?(context: UsageContext, source: ProviderUsage['source']): boolean;
  remote?(context: UsageContext, auth: RecordData, source: ProviderUsage['source']): Promise<RemoteUsage | undefined>;
  /** Normalized windows written to the shared cache; never credentials. */
  serialize(windows: UsageWindows): RecordData;
}

const fresh = (now: number, timestamp: number | null, age = 120000): boolean => timestamp !== null && now - timestamp >= 0 && now - timestamp <= age;
/** Least time between two automatic remote checks of one provider; a manual refresh (`force`) skips it. */
export const REMOTE_INTERVAL = 300000;

/** GET/POST JSON for usage endpoints; a 429 postpones the next check, every other failure yields undefined. */
export async function requestUsage(context: UsageContext, url: string, init: RequestInit): Promise<RecordData | undefined> {
  context.markChecked();
  try {
    const response = await context.request(url, { signal: AbortSignal.timeout(5000), redirect: 'error', ...init });
    if (response.status === 429) {
      const after = response.headers.get('retry-after'); const seconds = after && /^\d+$/.test(after) ? Number(after) * 1000 : (usageTimestamp(after) ?? context.now() + 900000) - context.now();
      context.setRetry(context.now() + Math.max(120000, seconds)); return undefined;
    }
    return response.ok ? await response.json() as RecordData : undefined;
  } catch { return undefined; /* Keep last known good values on network errors. */ }
}

/** Providers are checked in parallel; writes to one cache file run one after another so snapshots never overwrite each other. */
const cacheWrites = new Map<string, Promise<void>>();
async function saveSnapshot(context: UsageContext, key: DefaultProvider, timestamp: number, value: RecordData): Promise<void> {
  const write = (cacheWrites.get(context.cachePath) ?? Promise.resolve()).then(async () => {
    try {
      const cache = await readJson(context.cachePath); cache[key] = { updated_at: new Date(timestamp).toISOString(), value };
      await writeJsonFileAtomic(context.cachePath, cache, { spaces: 0 });
    } catch { /* Read-only cache must not hide live usage. */ }
  });
  cacheWrites.set(context.cachePath, write);
  try { await write; } finally { if (cacheWrites.get(context.cachePath) === write) cacheWrites.delete(context.cachePath); }
}

/** Local data first, then the newest saved snapshot, then (when allowed) the provider's remote source. */
export async function collectUsage(key: DefaultProvider, source: UsageSource, context: UsageContext): Promise<ProviderUsage> {
  const now = context.now();
  const auth = await source.auth(context);
  const accountInfo = source.account ? await source.account(context) : {};
  const data: ProviderUsage = { key, name: source.name,
    account: String(accountInfo.active ?? auth.user?.email ?? auth.user?.name ?? auth.email ?? auth.oauthAccount?.emailAddress ?? accountInfo.oauthAccount?.emailAddress ?? accountInfo.oauthAccount?.displayName ?? accountInfo.email ?? (typeof auth.account === 'string' ? auth.account : null) ?? source.defaultAccount),
    source: 'unavailable', updatedAt: null, active: false, ...source.normalize({}, now), retryAt: null };
  const local = await source.local(context);
  let timestamp = local.timestamp;
  const localNorm = source.normalize(local.value, now);
  if (hasUsage(localNorm)) { Object.assign(data, localNorm); data.source = 'local'; }
  const own = (await readJson(context.cachePath))[key];
  const legacy = (await readJson(join(context.home, '.windows-ai-token-viewer', 'usage-cache.json')))[key];
  const snapshots = [own, legacy].filter(Boolean).sort((a, b) => (usageTimestamp(b.updated_at) ?? 0) - (usageTimestamp(a.updated_at) ?? 0));
  for (const snapshot of snapshots) {
    const saved = usageTimestamp(snapshot.updated_at);
    const snapNorm = source.normalize(snapshot.value ?? {}, now);
    if (saved !== null && (data.source === 'unavailable' || timestamp === null || saved > timestamp) && hasUsage(snapNorm)) {
      Object.assign(data, snapNorm); timestamp = saved; data.source = 'cache'; break;
    }
  }
  if (source.weeklyFromSnapshots && data.weekly.usedPercent === null) {
    for (const snapshot of snapshots) {
      const weekly = source.normalize(snapshot.value ?? {}, now).weekly;
      if (weekly.usedPercent !== null) { data.weekly = weekly; break; }
    }
  }
  // Local files may carry only the main windows; extra buckets come from the newest snapshot until they reset.
  if (!data.buckets?.length) {
    for (const snapshot of snapshots) {
      const buckets = source.normalize(snapshot.value ?? {}, now).buckets?.filter((bucket) => (usageTimestamp(bucket.window.resetsAt) ?? Infinity) > now);
      if (buckets?.length) { data.buckets = buckets; break; }
    }
  }
  // Partial local files are fresh only for the main windows; the buckets need a recent remote snapshot.
  const savedAt = usageTimestamp(own?.updated_at);
  const stale = data.source === 'unavailable' || !fresh(now, timestamp) || (source.localPartial === true && !fresh(now, savedAt, REMOTE_INTERVAL));
  // A manual refresh (`force`) always asks; an automatic check only for stale data and at most every REMOTE_INTERVAL.
  if (source.remote && (context.allowApi || source.remoteWithoutApi?.(context, data.source)) && context.now() >= (context.retryAt() ?? 0)
    && (context.force || (stale && context.now() - (context.checkedAt() ?? -Infinity) >= REMOTE_INTERVAL))) {
    const remote = await source.remote(context, auth, data.source);
    if (remote && hasUsage(remote.windows)) {
      Object.assign(data, remote.windows); timestamp = context.now(); data.source = 'api'; context.setRetry(undefined);
      if (remote.account) data.account = remote.account;
      await saveSnapshot(context, key, timestamp, source.serialize(remote.windows));
    }
  }
  data.updatedAt = timestamp === null ? null : new Date(timestamp).toISOString(); data.active = fresh(context.now(), local.timestamp);
  const retry = context.retryAt();
  data.retryAt = retry === undefined ? null : new Date(retry).toISOString();
  return data;
}
