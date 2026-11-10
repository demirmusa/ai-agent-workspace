/**
 * Turns the compact state broadcasts of the event stream into patches: only the records and top-level values that changed
 * since the previous broadcast travel, so a busy server sends kilobytes per change instead of the whole state.
 *
 * Every connected client receives the same broadcasts in order, so one baseline serves them all. A client that connects
 * gets a full state at that moment, which may be newer than the baseline; the next broadcast is then sent in full again so
 * that no client keeps a record that appeared and disappeared between two broadcasts.
 */

/** State keys holding records with an `id`; they are patched record by record, every other key as a whole. */
const COLLECTIONS = new Set(['projects', 'tasks', 'runs', 'questions', 'agents', 'skills', 'workflows', 'plannerMessages', 'schedules']);
/** The journal arrives as deltas or with a full state; it is never part of a patch. */
const JOURNAL = new Set(['events', 'messages']);

export interface CollectionPatch { upsert?: unknown[]; remove?: string[]; order?: string[] }
export interface StatePatch { values?: Record<string, unknown>; collections?: Record<string, CollectionPatch> }

interface Baseline { values: Map<string, string>; records: Map<string, Map<string, string>>; orders: Map<string, string> }

export class StatePatches {
  private baseline: Baseline | null = null;

  /** Forgets the baseline: the next broadcast goes out in full. */
  reset(): void { this.baseline = null; }

  /**
   * The message for one broadcast: `{ state }` in full (the first one, after a reset, and whenever the state carries the
   * journal), otherwise `{ patch }` with what changed since the previous broadcast.
   */
  next(state: Record<string, unknown>): { state: Record<string, unknown> } | { patch: StatePatch } {
    const previous = this.baseline, current: Baseline = { values: new Map(), records: new Map(), orders: new Map() };
    const values: Record<string, unknown> = {}, collections: Record<string, CollectionPatch> = {};
    for (const [key, value] of Object.entries(state)) {
      if (JOURNAL.has(key)) continue;
      if (COLLECTIONS.has(key) && Array.isArray(value)) {
        const records = new Map<string, string>(), before = previous?.records.get(key), upsert: unknown[] = [], ids: string[] = [];
        for (const record of value as Array<{ id?: unknown }>) {
          const id = String(record?.id), text = JSON.stringify(record);
          ids.push(id); records.set(id, text);
          if (before?.get(id) !== text) upsert.push(record);
        }
        const order = ids.join('\n'), patch: CollectionPatch = {};
        current.records.set(key, records); current.orders.set(key, order);
        if (upsert.length) patch.upsert = upsert;
        if (before) { const remove = [...before.keys()].filter((id) => !records.has(id)); if (remove.length) patch.remove = remove; }
        if (previous?.orders.get(key) !== order) patch.order = ids;
        if (patch.upsert || patch.remove || patch.order) collections[key] = patch;
        continue;
      }
      const text = JSON.stringify(value) ?? 'undefined';
      current.values.set(key, text);
      if (previous?.values.get(key) !== text) values[key] = value;
    }
    this.baseline = current;
    if (!previous || 'events' in state || 'messages' in state) return { state };
    // A key the state no longer has is sent as null, as a full state without it would leave the client's copy behind.
    for (const key of previous.values.keys()) if (!current.values.has(key)) values[key] = null;
    for (const key of previous.records.keys()) if (!current.records.has(key)) collections[key] = { order: [] };
    const patch: StatePatch = {};
    if (Object.keys(values).length) patch.values = values;
    if (Object.keys(collections).length) patch.collections = collections;
    return { patch };
  }
}
