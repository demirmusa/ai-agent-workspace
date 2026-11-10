import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELD = 16_000;

export interface ErrorLogEntry { source: 'server' | 'ui' | 'desktop'; message: string; stack?: string | undefined; context?: string }

/** Appends errors with their full stack traces to `<data dir>/logs/errors.log`; the previous file is kept as `errors.log.1`. */
export class ErrorLog {
  readonly path: string;
  constructor(directory: string) {
    const logs = join(directory, 'logs');
    this.path = join(logs, 'errors.log');
    try { mkdirSync(logs, { recursive: true, mode: 0o700 }); } catch { /* Logging must never break the service. */ }
  }
  write(entry: ErrorLogEntry): void {
    const clip = (value: string | undefined): string => (value ?? '').slice(0, MAX_FIELD);
    const lines = [`[${new Date().toISOString()}] ${entry.source} ${clip(entry.message)}`];
    if (entry.context) lines.push(`  at ${clip(entry.context)}`);
    if (entry.stack) lines.push(clip(entry.stack));
    try {
      try { if (statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`); } catch { /* No file yet. */ }
      appendFileSync(this.path, `${lines.join('\n')}\n\n`, { mode: 0o600 });
    } catch { /* Logging must never break the service. */ }
  }
  /** Records an unexpected exception of the server itself. */
  error(error: unknown, context?: string): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.write({ source: 'server', message: failure.message, stack: failure.stack, ...(context ? { context } : {}) });
  }
}
