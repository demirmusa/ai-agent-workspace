import type { ControlStore } from '../store.js';
import type { ControlEvent, ControlState, TaskMessage } from '../types.js';
import { activeMs, runEnded } from './common.js';

export type ChangeEmitter = (event: 'change' | 'update' | 'terminal', ...args: unknown[]) => void;

/**
 * Persists state changes in the background and publishes them to clients: the compact
 * state at most once per frame interval, journal deltas, run output and PTY chunks.
 */
export class StateBroadcaster {
  private broadcastTimer: NodeJS.Timeout | undefined;
  private outputTimer: NodeJS.Timeout | undefined;
  private terminalTimer: NodeJS.Timeout | undefined;
  private fullBroadcast = false;
  private lastBroadcast = 0;
  private publishedEventId: string | undefined;
  private publishedMessageId: string | undefined;
  private terminalPending = new Map<string, { offset: number; data: string }>();
  private closed = false;
  /** Grows with every change and across restarts, so clients can tell which of two state copies is newer. */
  private changes = Date.now();

  constructor(private readonly store: ControlStore, private readonly emit: ChangeEmitter, private readonly view: (includeJournal: boolean) => ControlState) { this.markPublished(); }

  /**
   * Persist in the background and publish at most once per frame interval. Clients
   * receive the compact state plus only the journal entries they have not seen yet.
   */
  changed(options: { full?: boolean } = {}): void {
    this.changes++;
    this.store.scheduleSave();
    if (options.full) this.fullBroadcast = true;
    if (this.broadcastTimer || this.closed) return;
    // Leading edge: an isolated change goes out on the next turn (batching this turn's
    // mutations); bursts are throttled to one broadcast per 40 ms.
    const wait = Math.max(0, this.lastBroadcast + 40 - Date.now());
    this.broadcastTimer = setTimeout(() => { this.broadcastTimer = undefined; if (!this.closed) this.broadcast(); }, wait);
  }
  /**
   * Publishes a scheduled broadcast now. Callers about to block the event loop (synchronous Git work)
   * use it so clients see the current state, such as a just-created task, before the work starts.
   */
  flush(): void {
    if (!this.broadcastTimer || this.closed) return;
    clearTimeout(this.broadcastTimer); this.broadcastTimer = undefined; this.broadcast();
  }
  /** The revision of the state as it is right now. */
  get revision(): number { return this.changes; }
  /** Run output is published at most once a second, unless a state broadcast carries it first. */
  scheduleOutput(): void {
    if (!this.outputTimer) this.outputTimer = setTimeout(() => { this.outputTimer = undefined; if (!this.closed) this.publishOutput(); }, 1000);
  }
  /** A small run change (such as terminal dimensions) that clients apply at once. */
  updateRun(run: Record<string, unknown> & { id: string }): void { this.emit('update', { events: [], messages: [], runs: [run] }); }
  /** PTY chunks are batched per run and carry their offset, so clients can join a live stream exactly. */
  terminal(runId: string, offset: number, data: string): void {
    const pending = this.terminalPending.get(runId);
    if (pending && pending.offset + pending.data.length === offset && pending.data.length < 256_000) pending.data += data;
    else { if (pending) this.emit('terminal', { runId, offset: pending.offset, data: pending.data }); this.terminalPending.set(runId, { offset, data }); }
    this.terminalTimer ??= setTimeout(() => {
      this.terminalTimer = undefined;
      for (const [id, chunk] of this.terminalPending) this.emit('terminal', { runId: id, offset: chunk.offset, data: chunk.data });
      this.terminalPending.clear();
    }, 16);
  }
  close(): void {
    this.closed = true;
    for (const timer of [this.outputTimer, this.broadcastTimer, this.terminalTimer]) if (timer) clearTimeout(timer);
  }
  private broadcast(): void {
    this.lastBroadcast = Date.now();
    const delta = this.fullBroadcast ? null : this.journalDelta();
    this.fullBroadcast = false; this.markPublished();
    if (delta) this.emit('change', this.view(false), delta); else this.emit('change', this.view(true));
  }
  /** Entries journaled so far count as delivered; clients load them with the full state. */
  markPublished(): void { this.publishedEventId = this.store.state.events.at(-1)?.id; this.publishedMessageId = this.store.state.messages.at(-1)?.id; }
  /** Unpublished journal entries, or null when a client must reload the full journal. */
  private journalDelta(): { events: ControlEvent[]; messages: TaskMessage[] } | null {
    const since = <T extends { id: string; text?: string; message?: string }>(entries: T[], published: string | undefined): T[] | null => {
      if (!published) return entries.length > 2000 ? null : entries.slice();
      let characters = 0;
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]!.id === published) return entries.slice(index + 1);
        characters += (entries[index]!.text ?? entries[index]!.message ?? '').length;
        if (entries.length - index > 2000 || characters > 2_000_000) return null;
      }
      return null;
    };
    const events = since(this.store.state.events, this.publishedEventId), messages = since(this.store.state.messages, this.publishedMessageId);
    return events && messages ? { events, messages } : null;
  }
  private publishOutput(): void {
    if (this.broadcastTimer) return; // A state broadcast with the same entries is due.
    const delta = this.journalDelta();
    if (!delta) { this.changed({ full: true }); return; }
    const current = Date.now();
    const runs = this.store.state.runs.filter((run) => !runEnded(run)).map((run) => ({ id: run.id, status: run.status, executionInfo: run.executionInfo, lastActivityAt: run.lastActivityAt, activeMs: activeMs(run, current) }));
    this.markPublished();
    this.emit('update', { ...delta, runs });
  }
}
