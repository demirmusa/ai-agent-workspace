import { describe, expect, it } from 'vitest';
import { StatePatches } from '../http/state-patches.js';

describe('state patches', () => {
  const task = (id: string, title = id) => ({ id, title });

  it('sends the first state in full, then only changed records, removals, order and values', () => {
    const patches = new StatePatches();
    expect(patches.next({ tasks: [task('a'), task('b')], settings: { x: 1 } })).toEqual({ state: { tasks: [task('a'), task('b')], settings: { x: 1 } } });
    expect(patches.next({ tasks: [task('a'), task('b')], settings: { x: 1 } })).toEqual({ patch: {} });
    expect(patches.next({ tasks: [task('a', 'renamed'), task('b')], settings: { x: 2 } })).toEqual({ patch: { values: { settings: { x: 2 } }, collections: { tasks: { upsert: [task('a', 'renamed')] } } } });
    expect(patches.next({ tasks: [task('c'), task('a', 'renamed')], settings: { x: 2 } })).toEqual({ patch: { collections: { tasks: { upsert: [task('c')], remove: ['b'], order: ['c', 'a'] } } } });
  });

  it('sends a state carrying the journal in full and a full state again after a reset', () => {
    const patches = new StatePatches();
    patches.next({ tasks: [task('a')] });
    expect(patches.next({ tasks: [task('a')], events: [] })).toHaveProperty('state');
    expect(patches.next({ tasks: [task('a')] })).toEqual({ patch: {} });
    patches.reset();
    expect(patches.next({ tasks: [task('a')] })).toHaveProperty('state');
  });

  it('clears values and collections the state no longer has', () => {
    const patches = new StatePatches();
    patches.next({ tasks: [task('a')], generalWorkspace: { id: 'g' } });
    expect(patches.next({})).toEqual({ patch: { values: { generalWorkspace: null }, collections: { tasks: { order: [] } } } });
  });
});
