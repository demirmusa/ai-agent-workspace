import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultControlDataDir } from './paths.js';

/** The port of `aiws control serve`. The desktop app keeps its own (DESKTOP_SERVICE_PORT) and is found through the service lock. */
export const DEFAULT_CONTROL_PORT = 4317;
export const DEFAULT_CONTROL_URL = `http://127.0.0.1:${DEFAULT_CONTROL_PORT}`;
/** Held by the one service using a data directory; once it listens, the lock also names its address. */
export const SERVICE_LOCK_FILE = 'service.lock';
/** The owner touches its lock regularly; a reused PID never does, so a lock left by a crash goes stale. */
export const SERVICE_LOCK_STALE_MS = 60_000;

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** The address of the service running on this data directory, if there is one. */
export function localServiceUrl(directory = process.env.AIWS_CONTROL_DATA || defaultControlDataDir()): string | undefined {
  try {
    const path = join(directory, SERVICE_LOCK_FILE), lock = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; url?: unknown };
    if (typeof lock.url !== 'string' || typeof lock.pid !== 'number' || !processAlive(lock.pid)) return undefined;
    return Date.now() - statSync(path).mtimeMs > SERVICE_LOCK_STALE_MS ? undefined : lock.url;
  } catch { return undefined; }
}

/** Which service `aiws control` talks to: the given URL, AIWS_CONTROL_URL, the running local service, then the default. */
export function resolveControlUrl(explicit?: string): string {
  return explicit || process.env.AIWS_CONTROL_URL || localServiceUrl() || DEFAULT_CONTROL_URL;
}
