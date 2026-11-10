import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiProviders } from '../ai-providers/index.js';
import { readTranscriptUsage, UsageTally } from '../run-usage.js';

describe('run token usage', () => {
  it('takes a session cost only from what the client recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiws-claude-config-')); const previous = process.env.CLAUDE_CONFIG_DIR;
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: { 'D:/a': { lastSessionId: 's1', lastCost: 1.5 }, 'D:\b': { lastSessionId: 's2' } } }));
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const claude = aiProviders.get('claude')!;
      expect(await claude.readSessionCost('s1')).toBe(1.5);
      expect(await claude.readSessionCost('s2')).toBeUndefined();
      expect(await claude.readSessionCost('missing')).toBeUndefined();
      expect(await aiProviders.get('codex')!.readSessionCost('s1')).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  });
  it('reads tokens and the reported cost from a Claude result line, and no cost from its transcript', async () => {
    const claude = aiProviders.get('claude')!;
    const reading = claude.readStreamUsage({ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } });
    expect(reading?.costUsd).toBe(0.25);
    expect(reading?.tokens).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100 });
    const dir = await mkdtemp(join(tmpdir(), 'aiws-usage-')); const file = join(dir, 's.jsonl');
    const row = (id: string, input: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, output_tokens: 1 } } });
    await writeFile(file, [row('a', 5), row('a', 5), row('b', 7), '{"type":"user"}'].join('\n'));
    const usage = await readTranscriptUsage(file, (message) => claude.readTranscriptUsage(message));
    expect(usage).toMatchObject({ inputTokens: 12, outputTokens: 2, totalTokens: 14, costUsd: null });
  });

  it('counts Codex cached input once and takes the transcript total', () => {
    const codex = aiProviders.get('codex')!;
    expect(codex.readStreamUsage({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 } })?.tokens.totalTokens).toBe(105);
    const tally = new UsageTally();
    for (const total of [50, 120]) tally.add(codex.readTranscriptUsage({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } } })!);
    expect(tally.result()?.totalTokens).toBe(120);
    expect(new UsageTally().result()).toBeUndefined();
  });
});
