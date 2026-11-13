import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlStore, emptyControlState } from '../store.js';
import type { Run, Task } from '../types.js';

const roots: string[] = []; const stores: ControlStore[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'aiws-store-')); roots.push(root); return root; };
const open = (root: string) => { const store = new ControlStore(root); stores.push(store); return store; };
const reopen = (store: ControlStore) => { store.close(); stores.splice(stores.indexOf(store), 1); return open(store.directory); };
const at = new Date().toISOString();
const task = (id: string): Task => ({ id, projectId: 'project_1', title: id, description: '', status: 'backlog', priority: 0, provider: 'codex', dependsOn: [], createdAt: at, updatedAt: at } as unknown as Task);
const run = (id: string, taskId: string): Run => ({ id, taskId, provider: 'codex', status: 'completed', startedAt: at, finishedAt: at, exitCode: 0, executionMode: 'native', terminalMode: 'pty', pendingCommands: [], continuation: 0 });
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('SQLite control store', () => {
  it('defaults new and legacy settings to PR mode while preserving an explicit branch choice', () => {
    expect(emptyControlState().settings.taskMergeMode).toBe('pull-request');
    const root=directory();
    writeFileSync(join(root,'settings.json'),JSON.stringify({maxConcurrent:4}));
    let store=open(root);
    expect(store.state.settings.taskMergeMode).toBe('pull-request');
    store.state.settings.taskMergeMode='branch';store.save();store=reopen(store);
    expect(store.state.settings.taskMergeMode).toBe('branch');
  });

  it('imports a legacy state.json once, with replays from the state and from terminal.log files', () => {
    const root = directory(), legacy = emptyControlState();
    legacy.tasks.push(task('task_a'), task('task_b'));
    legacy.runs.push({ ...run('run_inline', 'task_a'), terminalOutput: 'inline replay' }, run('run_file', 'task_b'));
    legacy.events.push({ id: 'event_keep', runId: 'run_inline', taskId: 'task_a', type: 'stdout', message: 'kept', createdAt: at },
      { id: 'event_drop', runId: 'run_inline', taskId: 'task_a', type: 'terminal.output', message: 'duplicate', createdAt: at });
    writeFileSync(join(root, 'state.json'), JSON.stringify(legacy));
    mkdirSync(join(root, 'runs', 'run_file'), { recursive: true }); writeFileSync(join(root, 'runs', 'run_file', 'terminal.log'), 'file replay');
    let store = open(root);
    expect(existsSync(join(root, 'state.json'))).toBe(false); expect(existsSync(join(root, 'state.json.pre-sqlite'))).toBe(true);
    expect(existsSync(join(root, 'runs', 'run_file', 'terminal.log'))).toBe(false);
    store = reopen(store);
    expect(store.state.tasks.map((item) => item.id)).toEqual(['task_a', 'task_b']);
    expect(store.state.events.map((item) => item.id)).toEqual(['event_keep']);
    expect(store.terminalOutput(store.state.runs[0]!)).toBe('inline replay'); expect(store.terminalOutput(store.state.runs[1]!)).toBe('file replay');
    expect(store.readPersisted().runs.every((item) => !('terminalOutput' in item))).toBe(true);
  });

  it('removes retired provider environment settings while preserving provider preferences', () => {
    const root = directory(), legacy = emptyControlState();
    Object.assign(legacy.settings, { providerEnv: { codex: { OLD_ENV_SETTING: 'retired' } } });
    legacy.projects.push({ id: 'project_1', name: 'Existing', description: '', repositoryPath: root, github: null, createdAt: at, updatedAt: at,
      providerSettings: { defaultProvider: 'claude', ...{ providerEnv: { claude: { OLD_ENV_SETTING: 'retired' } } } } });
    writeFileSync(join(root, 'state.json'), JSON.stringify(legacy));
    let store = open(root);
    expect(store.state.settings).not.toHaveProperty('providerEnv');
    expect(store.state.projects[0]?.providerSettings).toEqual({ defaultProvider: 'claude' });
    store = reopen(store);
    expect(JSON.stringify(store.readPersisted())).not.toContain('OLD_ENV_SETTING');
  });

  it('writes only changes, keeps order, appends terminal chunks and removes a deleted task with its journal and replay', () => {
    const root = directory(); let store = open(root);
    store.state.tasks.push(task('task_a'), task('task_b')); store.state.runs.push(run('run_b', 'task_b'));
    store.state.events.push({ id: 'event_b', runId: 'run_b', taskId: 'task_b', type: 'stdout', message: 'b', createdAt: at });
    store.appendTerminal(store.state.runs[0]!, 'hello '); store.appendTerminal(store.state.runs[0]!, 'world');
    store.save();
    expect(store.state.runs[0]!.terminalOutput).toBeUndefined();
    expect(store.terminalOutput(store.state.runs[0]!)).toBe('hello world');
    expect(store.state.runs[0]!.terminalOutput).toBeUndefined();
    store.state.tasks[0]!.title = 'renamed'; store.state.tasks.reverse(); store.save();
    store = reopen(store);
    expect(store.state.tasks.map((item) => item.title)).toEqual(['task_b', 'renamed']);
    expect(store.terminalOutput(store.state.runs[0]!)).toBe('hello world'); expect(store.state.runs[0]!.terminalLength).toBe(11);
    store.state.tasks = store.state.tasks.filter((item) => item.id !== 'task_b'); store.state.runs = []; store.state.events = []; store.save();
    store = reopen(store);
    const raw = store.persistedSnapshot();
    expect(store.state.tasks.map((item) => item.id)).toEqual(['task_a']); expect(raw).not.toContain('event_b'); expect(raw).not.toContain('hello');
  });

  it('keeps settings in a readable settings.json and the journal beyond the in-memory window', () => {
    const root = directory(); let store = open(root);
    store.state.settings.maxConcurrent = 7;
    for (let index = 0; index < 20_050; index++) store.state.events.push({ id: `event_${index}`, runId: null, taskId: null, type: 'info', message: 'x', createdAt: at });
    store.save();
    store = reopen(store);
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).maxConcurrent).toBe(7);
    expect(store.state.settings.maxConcurrent).toBe(7);
    expect(store.state.events).toHaveLength(20_000); expect(store.state.events.at(-1)!.id).toBe('event_20049');
    expect(store.persistedSnapshot()).toContain('"event_0"');
  });
});
