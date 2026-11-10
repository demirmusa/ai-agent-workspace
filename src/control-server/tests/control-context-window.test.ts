import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiProviders } from '../ai-providers/index.js';
import { ContextTally, ContextWindows } from '../context-window.js';

const claude = aiProviders.require('claude'), codex = aiProviders.require('codex');
const lines = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');
const tally = (provider: typeof claude, rows: Record<string, unknown>[]) => { const result = new ContextTally(); for (const row of rows) { const reading = provider.readTranscriptContext(row); if (reading) result.add(reading); } return result.snapshot(provider); };
const block = (snapshot: ReturnType<typeof tally>, id: string) => snapshot.blocks.find((entry) => entry.id === id);

const claudeRows = [
  { type: 'api-request-shape', shape: { system: [{ type: 'text', text: 'S'.repeat(4000) }], tools: [{ name: 'Read', description: 'T'.repeat(2000) }] } },
  { type: 'attachment', isSidechain: false, attachment: { type: 'instructions', files: [{ path: 'C:\\repo\\AGENTS.md', content: 'M'.repeat(800) }] } },
  { type: 'user', isSidechain: false, message: { role: 'user', content: 'Fix the checkout' } },
  { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\repo\\src\\payment.ts' } }], usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 40 } } },
  { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'P'.repeat(4000) }] } },
  { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'X'.repeat(9000) }] } },
];

describe('context windows', () => {
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

  it('splits a Claude transcript by source and files a tool result under the file it read', () => {
    const snapshot = tally(claude, claudeRows);
    expect(snapshot).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', window: 200_000, measured: true, compactions: 0 });
    expect(block(snapshot, 'file:payment.ts')).toMatchObject({ kind: 'file', label: 'payment.ts', path: 'C:\\repo\\src\\payment.ts', count: 1 });
    expect(block(snapshot, 'memory:AGENTS.md')).toMatchObject({ kind: 'memory', path: 'C:\\repo\\AGENTS.md' });
    expect(block(snapshot, 'system:')!.tokens).toBeGreaterThan(block(snapshot, 'tools:')!.tokens);
    // Subagent lines of a main transcript are not part of its context.
    expect(snapshot.blocks.some((entry) => entry.kind === 'chat' && entry.tokens > 1000)).toBe(false);
    expect(snapshot.used).toBe(snapshot.blocks.reduce((sum, entry) => sum + entry.tokens, 0));
  });

  it('reads a subagent transcript whose lines are all sidechain, and drops the conversation at a compaction', () => {
    const sidechain = tally(claude, [{ type: 'user', isSidechain: true, message: { content: 'Look around' } }, { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Found it' }] } }]);
    expect(block(sidechain, 'chat:')).toMatchObject({ count: 2 });
    const compacted = tally(claude, [...claudeRows, { type: 'system', subtype: 'compact_boundary' }, { type: 'user', isCompactSummary: true, message: { content: 'Summary '.repeat(50) } }]);
    expect(compacted.compactions).toBe(1);
    expect(block(compacted, 'file:payment.ts')).toBeUndefined();
    expect(block(compacted, 'summary:')).toBeDefined();
    expect(block(compacted, 'system:')).toBeDefined();
  });

  it('takes a Codex window from its rollout and joins patches and their output under the patched file', () => {
    const snapshot = tally(codex, [
      { type: 'event_msg', payload: { type: 'task_started', model_context_window: 475000 } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'response_item', payload: { type: 'additional_tools', tools: [{ name: 'exec', description: 'D'.repeat(3000) }] } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'B'.repeat(6000) }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for C:\\repo\n' + 'A'.repeat(900) }, { type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'Fix it' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'Success' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'O'.repeat(2000) } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 100, total_tokens: 5100 }, model_context_window: 475000 } } },
    ]);
    expect(snapshot).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', window: 475000, measured: true });
    // Block sizes are rounded one by one, so their sum may differ from the report by a token or two.
    expect(Math.abs(snapshot.used - 5100)).toBeLessThan(5);
    expect(block(snapshot, 'file:app.js')).toMatchObject({ count: 1, path: 'src/app.js' });
    expect(block(snapshot, 'shell:')).toMatchObject({ count: 1 });
    expect(block(snapshot, 'memory:AGENTS.md')).toMatchObject({ path: 'AGENTS.md' });
    expect(block(snapshot, 'chat:')).toBeDefined();
  });

  it('keeps every source up to a limit and merges the smaller ones of a kind', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${index}`, name: 'Read', input: { file_path: `src/file${index}.ts`, pad: 'x'.repeat(100 + index * 10) } }] } }));
    const snapshot = tally(claude, rows);
    expect(snapshot.blocks.filter((entry) => entry.label)).toHaveLength(24);
    expect(block(snapshot, 'file:+')).toMatchObject({ merged: true, count: 16 });
  });

  it('follows a growing transcript, reading only what was appended', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aiws-context-')); folders.push(folder); const path = join(folder, 'session.jsonl');
    const windows = new ContextWindows();
    await writeFile(path, lines(claudeRows.slice(0, 3)));
    const first = await windows.read(path, claude);
    expect(first.measured).toBe(false);
    // An unfinished last line waits for the next read.
    await appendFile(path, lines(claudeRows.slice(3, 4)) + JSON.stringify(claudeRows[4]).slice(0, 20));
    const second = await windows.read(path, claude);
    expect(second.measured).toBe(true); expect(block(second, 'file:payment.ts')!.tokens).toBeLessThan(200);
    await appendFile(path, `${JSON.stringify(claudeRows[4]).slice(20)}\n`);
    const third = await windows.read(path, claude);
    expect(block(third, 'file:payment.ts')!.tokens).toBeGreaterThan(500);
    expect(third.used).toBeGreaterThan(second.used);
  });
});
