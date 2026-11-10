import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlStore } from '../store.js';
import { TaskDraftMemory } from '../task-draft.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('task draft memory', () => {
  it('keeps the unsaved new task across a restart and drops it when emptied or cleared', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-task-draft-')); roots.push(root);
    const store = new ControlStore(root);
    expect(new TaskDraftMemory(store).get()).toBeNull();
    new TaskDraftMemory(store).save({ projectId: 'project_1', title: 'Half written', description: 'Typed before the freeze' });
    store.close();

    const reopened = new ControlStore(root), memory = new TaskDraftMemory(reopened);
    expect(memory.get()).toMatchObject({ projectId: 'project_1', title: 'Half written', description: 'Typed before the freeze' });
    expect(memory.save({ projectId: null, title: '  ', description: '' })).toBeNull();
    expect(memory.get()).toBeNull();
    memory.save({ projectId: null, title: '', description: 'Only a description' });
    memory.clear();
    expect(memory.get()).toBeNull();
    reopened.close();
  });

  it('rejects malformed drafts', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-task-draft-')); roots.push(root);
    const store = new ControlStore(root), memory = new TaskDraftMemory(store);
    expect(() => memory.save(null)).toThrow();
    expect(() => memory.save({ title: 1, description: '' })).toThrow();
    expect(() => memory.save({ projectId: '../x', title: 'a', description: '' })).toThrow();
    expect(() => memory.save({ title: 'x'.repeat(241), description: '' })).toThrow();
    store.close();
  });
});
