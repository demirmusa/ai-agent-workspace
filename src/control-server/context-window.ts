import { open } from 'node:fs/promises';
import { parseJsonOrNull } from '../shared/core/json.js';
import type { IAIProvider } from './ai-providers/types.js';
import type { ContextBlock, ContextKind, ContextWindowSnapshot } from './types.js';

/** Text one transcript line puts into the context; its size estimates tokens. */
export interface ContextPart {
  kind: ContextKind; label?: string; path?: string; chars: number;
  /** A tool call: its result joins the same block. */
  call?: string;
  /** A tool result: joins the block of the call with this ID. */
  resultOf?: string;
  /** Content the provider sends whole with every request (system prompt, tool list): replaces the block instead of adding to it. */
  replace?: boolean;
}
/** What one line of a provider's session transcript says about its context window. */
export interface ContextReading {
  parts?: ContextPart[];
  /** Tokens the model's context held at its latest request, as the provider reported. */
  used?: number;
  window?: number; model?: string;
  /** The provider compacted the conversation: only the system prompt and tool list stay. */
  compacted?: boolean;
  /** Subagent line; a main transcript skips these, a subagent's own transcript holds nothing else. */
  sidechain?: boolean;
  at?: string;
}

export const CONTEXT_LIMITS = { chunkBytes: 8 * 1024 * 1024, sources: 64, calls: 4096, labeledBlocks: 24, blocks: 2048 };
const CHARS_PER_TOKEN = 4;
/** Base kinds stay through a compaction. */
const BASE_KINDS: ReadonlySet<ContextKind> = new Set(['system', 'tools']);

/** Characters of a message content: a string, text parts or any other JSON value. */
export function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, part) => sum + (part && typeof part === 'object' && typeof part.text === 'string' ? part.text.length : textLength(part)), 0);
  if (value === null || value === undefined) return 0;
  return JSON.stringify(value)?.length ?? 0;
}
/** The file name of a path a tool received, used as a block label. */
export function fileLabel(path: unknown): string | undefined {
  return typeof path === 'string' && path.trim() ? path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)!.slice(0, 120) : undefined;
}

export function filePath(path: unknown): string | undefined {
  return typeof path === 'string' && path.trim() && !path.includes('\0') ? path.trim().slice(0, 4096) : undefined;
}

interface Tally { kind: ContextKind; label?: string; path?: string; chars: number; count: number }

/** Builds one agent's context window from its transcript lines, in order. */
export class ContextTally {
  private readonly blocks = new Map<string, Tally>();
  private readonly calls = new Map<string, { kind: ContextKind; label: string | undefined; path: string | undefined }>();
  private used: number | undefined; private window: number | undefined; private model: string | undefined; private at: string | undefined;
  private charsAtReport = 0; private compactions = 0; private sidechainFile: boolean | undefined;

  add(reading: ContextReading): void {
    if (reading.sidechain !== undefined) this.sidechainFile ??= reading.sidechain;
    if (reading.sidechain && !this.sidechainFile) return;
    if (reading.model) this.model = reading.model;
    if (reading.window) this.window = reading.window;
    if (reading.at) this.at = reading.at;
    if (reading.compacted) {
      for (const [id, block] of this.blocks) if (!BASE_KINDS.has(block.kind)) this.blocks.delete(id);
      this.calls.clear(); this.compactions++; this.used = undefined;
    }
    for (const part of reading.parts ?? []) {
      let { kind, label, path } = part;
      const call = part.resultOf ? this.calls.get(part.resultOf) : undefined; if (call) ({ kind, label, path } = call);
      if (part.call) { if (this.calls.size >= CONTEXT_LIMITS.calls) this.calls.delete(this.calls.keys().next().value!); this.calls.set(part.call, { kind, label, path }); }
      // Past the block limit new sources join their kind's unlabeled block, so a transcript cannot grow the map without bound.
      if (label && this.blocks.size >= CONTEXT_LIMITS.blocks && !this.blocks.has(`${kind}:${label}`)) { label = undefined; path = undefined; }
      const id = `${kind}:${label ?? ''}`; let block = this.blocks.get(id);
      if (!block) { block = { kind, ...(label ? { label } : {}), ...(path ? { path } : {}), chars: 0, count: 0 }; this.blocks.set(id, block); }
      else if (path && !block.path) block.path = path;
      if (part.replace) { block.chars = part.chars; block.count = 1; } else { block.chars += part.chars; if (!call) block.count++; }
    }
    if (reading.used) { this.used = reading.used; this.charsAtReport = this.chars(); }
  }
  private chars(): number { let sum = 0; for (const block of this.blocks.values()) sum += block.chars; return sum; }

  /**
   * Block sizes are estimated from text length and scaled so they add up to the provider's last report; content written
   * since then is added on top. A transcript that does not record the system prompt or tool list shows the unrecorded
   * part of the report as the system prompt.
   */
  snapshot(provider: IAIProvider): ContextWindowSnapshot {
    const base = [...this.blocks.values()].some((block) => BASE_KINDS.has(block.kind) && block.chars > 0);
    const reported = this.charsAtReport / CHARS_PER_TOKEN; let scale = 1; let unrecorded = 0;
    if (this.used && base && reported > 0) scale = Math.min(4, Math.max(0.25, this.used / reported));
    else if (this.used) unrecorded = Math.max(0, Math.round(this.used - reported));
    const sized = [...this.blocks.entries()].map(([id, block]): ContextBlock => ({ id, kind: block.kind, ...(block.label ? { label: block.label } : {}), ...(block.path ? { path: block.path } : {}), tokens: Math.round(block.chars / CHARS_PER_TOKEN * scale), count: block.count }));
    if (unrecorded) { const system = sized.find((block) => block.id === 'system:'); if (system) system.tokens += unrecorded; else sized.push({ id: 'system:', kind: 'system', tokens: unrecorded, count: 1 }); }
    // Every source keeps its own block up to a limit; the smaller ones of each kind are merged so the map stays readable.
    const blocks: ContextBlock[] = []; const merged = new Map<ContextKind, ContextBlock>(); let labeled = 0;
    for (const block of sized.filter((entry) => entry.tokens > 0).sort((a, b) => b.tokens - a.tokens)) {
      if (!block.label || labeled++ < CONTEXT_LIMITS.labeledBlocks) { blocks.push(block); continue; }
      let rest = merged.get(block.kind); if (!rest) { rest = { id: `${block.kind}:+`, kind: block.kind, tokens: 0, count: 0, merged: true }; merged.set(block.kind, rest); blocks.push(rest); }
      rest.tokens += block.tokens; rest.count += 1;
    }
    const used = blocks.reduce((sum, block) => sum + block.tokens, 0);
    return { provider: provider.id as ContextWindowSnapshot['provider'], ...(this.model ? { model: this.model } : {}), window: this.window ?? provider.contextWindow(this.model, used), used, measured: this.used !== undefined, blocks, compactions: this.compactions, ...(this.at ? { updatedAt: this.at } : {}) };
  }
}

interface Source { offset: number; tally: ContextTally; provider: string; partial: boolean }

/** Follows session transcripts while they grow: each request reads only the lines written since the previous one. */
export class ContextWindows {
  private readonly sources = new Map<string, Source>();

  async read(path: string, provider: IAIProvider): Promise<ContextWindowSnapshot> {
    let source = this.sources.get(path);
    const file = await open(path, 'r');
    try {
      const size = (await file.stat()).size;
      // A shorter file was rewritten; start over.
      if (!source || source.provider !== provider.id || size < source.offset) {
        source = { offset: 0, tally: new ContextTally(), provider: provider.id, partial: false };
        if (this.sources.size >= CONTEXT_LIMITS.sources) this.sources.delete(this.sources.keys().next().value!);
      }
      this.sources.delete(path); this.sources.set(path, source);
      while (source.offset < size) {
        const buffer = Buffer.alloc(Math.min(CONTEXT_LIMITS.chunkBytes, size - source.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, source.offset); if (!bytesRead) break;
        const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (end < 0) {
          // A line longer than a chunk is skipped; an unfinished last line waits for the next read.
          if (bytesRead < CONTEXT_LIMITS.chunkBytes) break;
          source.offset += bytesRead; source.partial = true; continue;
        }
        const lines = buffer.subarray(0, end).toString('utf8').split('\n'); if (source.partial) { lines.shift(); source.partial = false; }
        for (const line of lines) {
          if (!line.trim()) continue;
          const message: unknown = parseJsonOrNull(line);
          if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
          const reading = provider.readTranscriptContext(message as Record<string, unknown>); if (reading) source.tally.add(reading);
        }
        source.offset += end + 1;
      }
    } finally { await file.close(); }
    return source.tally.snapshot(provider);
  }
}
