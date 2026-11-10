import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { RunUsage, TokenCounts } from './types.js';

/** What a provider's output line says about tokens: added to the run, or the provider's own running total. */
export interface UsageReading { tokens: TokenCounts; costUsd?: number; /** Same ID again replaces the earlier reading (a message streamed in parts). */ id?: string; total?: boolean }

const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Token counts from the field names providers use; undefined when the object holds none. */
export function readTokenCounts(usage: unknown, names: { input: string; output: string; cacheRead?: string; cacheWrite?: string; total?: string; /** The input count already includes cached tokens. */ cacheInInput?: boolean }): TokenCounts | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as Record<string, unknown>;
  const counts = { inputTokens: num(raw[names.input]), outputTokens: num(raw[names.output]), cacheReadTokens: names.cacheRead ? num(raw[names.cacheRead]) : 0, cacheWriteTokens: names.cacheWrite ? num(raw[names.cacheWrite]) : 0, totalTokens: 0 };
  counts.totalTokens = (names.total ? num(raw[names.total]) : 0) || counts.inputTokens + counts.outputTokens + counts.cacheWriteTokens + (names.cacheInInput ? 0 : counts.cacheReadTokens);
  return counts.totalTokens > 0 ? counts : undefined;
}

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;

/** Collects readings of one run into the numbers kept on the task; the cost here is only what the client reported. */
export class UsageTally {
  private readonly parts = new Map<string, UsageReading>(); private anonymous = 0;
  private reported: UsageReading | undefined; private cost: number | undefined;
  add(reading: UsageReading): void {
    if (reading.costUsd !== undefined) this.cost = (this.cost ?? 0) + reading.costUsd;
    if (reading.total) this.reported = reading; else this.parts.set(reading.id ?? `#${this.anonymous++}`, reading);
  }
  result(): RunUsage | undefined {
    const tokens: TokenCounts | undefined = this.reported?.tokens ?? (this.parts.size ? [...this.parts.values()].reduce<TokenCounts>((sum, part) => Object.fromEntries(KEYS.map((key) => [key, sum[key] + part.tokens[key]])) as unknown as TokenCounts, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }) : undefined);
    if (!tokens) return undefined;
    return { ...tokens, costUsd: this.cost ?? null, recordedAt: new Date().toISOString() };
  }
}

/** Reads a provider's session transcript (JSON lines) for the tokens it recorded. */
export async function readTranscriptUsage(path: string, read: (message: Record<string, unknown>) => UsageReading | undefined): Promise<RunUsage | undefined> {
  const tally = new UsageTally();
  try { if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return undefined; } catch { return undefined; }
  // Line by line, so a long transcript never sits in memory as one string.
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('usage') && !line.includes('token')) continue;
      try { const message = JSON.parse(line) as unknown; if (message && typeof message === 'object' && !Array.isArray(message)) { const reading = read(message as Record<string, unknown>); if (reading) tally.add(reading); } } catch { /* Not a JSON line. */ }
    }
  } catch { return undefined; } finally { lines.close(); }
  return tally.result();
}
