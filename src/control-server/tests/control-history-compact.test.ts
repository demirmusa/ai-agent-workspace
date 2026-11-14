import { describe, expect, it } from 'vitest';
import { compactedContext } from '../agent-handoff.js';
import { compactChunks, compactConversation, finalAgentText } from '../history-compact.js';
import type { ProviderInvocation } from '../ai-providers/index.js';

describe('history compaction', () => {
  it('splits a long transcript at line breaks', () => {
    const transcript = Array.from({ length: 50 }, (_, index) => `[user] line ${index} ${'x'.repeat(20)}`).join('\n');
    const chunks = compactChunks(transcript, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks.join('\n')).toBe(transcript);
  });

  it('reads the final answer from stream output', () => {
    const claude = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }), JSON.stringify({ type: 'result', result: '## Task\nFinal summary' })].join('\n');
    expect(finalAgentText(claude)).toBe('## Task\nFinal summary');
    expect(finalAgentText(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex summary' } }))).toBe('codex summary');
    expect(finalAgentText('plain summary\n')).toBe('plain summary');
  });

  it('folds every piece into a running summary with the chosen model', async () => {
    const calls: ProviderInvocation[] = [];
    const transcript = Array.from({ length: 4000 }, (_, index) => `[agent] step ${index} ${'y'.repeat(100)}`).join('\n');
    const summary = await compactConversation({
      provider: 'claude', model: 'claude-haiku-5-5', workspacePath: process.cwd(), transcript,
      runner: async (invocation) => { calls.push(invocation); return JSON.stringify({ type: 'result', result: `summary ${calls.length}` }); },
    });
    expect(calls.length).toBe(compactChunks(transcript).length);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.args.includes('claude-haiku-5-5'))).toBe(true);
    expect(calls[1]!.input).toContain('summary 1');
    expect(summary).toBe(`summary ${calls.length}`);
    await expect(compactConversation({ provider: 'claude', workspacePath: process.cwd(), transcript: 'x', runner: async () => '' })).rejects.toThrow('returned no summary');
  });

  it('wraps the summary for the continuing agent', () => {
    const context = compactedContext('LEAD', 'claude (claude-haiku-5-5)', 'S');
    expect(context).toContain('LEAD');
    expect(context).toContain('written by claude (claude-haiku-5-5)');
    expect(context).toContain('<conversation-summary>\nS\n</conversation-summary>');
  });
});
