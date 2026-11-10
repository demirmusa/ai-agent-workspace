import { ControlError } from './types.js';
import type { ControlStore } from './store.js';

const META_KEY = 'task-draft';
const MAX_TITLE = 240, MAX_DESCRIPTION = 200_000;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface TaskDraft { projectId: string | null; title: string; description: string; updatedAt: string }

/** The unsaved new-task form, kept in the control database so a crash, reload or restart never loses what was typed. */
export class TaskDraftMemory {
  constructor(private readonly store: ControlStore) {}

  get(): TaskDraft | null {
    const stored = this.store.getMeta(META_KEY);
    if (!stored) return null;
    try { const value = JSON.parse(stored) as { updatedAt?: unknown }; const draft = this.clean(value); return draft && typeof value.updatedAt === 'string' ? { ...draft, updatedAt: value.updatedAt } : draft; } catch { return null; }
  }

  /** Saves the draft; an empty title and description removes it. */
  save(value: unknown): TaskDraft | null {
    const draft = this.clean(value);
    if (draft) this.store.setMeta(META_KEY, JSON.stringify(draft));
    else this.clear();
    return draft;
  }

  clear(): void { this.store.deleteMeta(META_KEY); }

  private clean(value: unknown): TaskDraft | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlError('Task draft must be an object.');
    const { projectId, title, description } = value as Record<string, unknown>;
    if (typeof title !== 'string' || typeof description !== 'string') throw new ControlError('Task draft needs a title and a description.');
    if (title.length > MAX_TITLE || description.length > MAX_DESCRIPTION) throw new ControlError('Task draft is too large.');
    if (projectId != null && (typeof projectId !== 'string' || !ID.test(projectId))) throw new ControlError('Invalid task draft project.');
    if (!title.trim() && !description.trim()) return null;
    return { projectId: projectId ?? null, title, description, updatedAt: new Date().toISOString() };
  }
}
