import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicUserText, resumesAgentTurn } from '../history-records.js';
import { readTranscriptPage } from '../history-transcript.js';

const NOTIFICATION = '<task-notification>\n<task-id>bty7p4r0u</task-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>';
const HANDBACK = '<agent-message from="a4b6b5e7">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\nTests added.\n</agent-message>';
const REMINDER = '<system-reminder>\nProject instructions\n</system-reminder>';
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('public user text of provider transcripts', () => {
  it('hides records the provider wrote and keeps what the human typed around injected blocks', () => {
    expect(publicUserText(NOTIFICATION)).toBe('');
    expect(publicUserText(`${NOTIFICATION}\n${NOTIFICATION}`)).toBe('');
    expect(publicUserText(SUMMARY)).toBe('');
    expect(publicUserText(HANDBACK)).toBe('');
    expect(publicUserText(`${REMINDER}\n\nFix the checkout`)).toBe('Fix the checkout');
    expect(publicUserText(`Fix the checkout\n${REMINDER}`)).toBe('Fix the checkout');
    expect(publicUserText(`Keep ${REMINDER} this mention`)).toBe(`Keep ${REMINDER} this mention`);
    expect(publicUserText(`a ${REMINDER} b ${REMINDER}`)).toBe(`a ${REMINDER} b`);
  });
  it('still treats a notification or a compaction summary as the start of agent work', () => {
    expect(resumesAgentTurn(NOTIFICATION)).toBe(true); expect(resumesAgentTurn(SUMMARY)).toBe(true); expect(resumesAgentTurn(HANDBACK)).toBe(true);
    expect(resumesAgentTurn('Fix the checkout')).toBe(false);
  });
  it('does not show background task notifications or subagent hand-backs as user messages in a Claude transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-records-')); roots.push(root); const path = join(root, 'session.jsonl');
    const row = (content: unknown) => ({ type: 'user', sessionId: 's1', timestamp: '2026-11-02T10:00:00Z', message: { role: 'user', content } });
    writeFileSync(path, [row([{ type: 'text', text: REMINDER }, { type: 'text', text: 'Run the tests' }]), row(NOTIFICATION), row(HANDBACK), row(SUMMARY), row('Thanks')].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const pointer = { path, managed: true, session: { id: 'history_1', sessionId: 's1', cwd: root, provider: 'claude', createdAt: '2026-11-02T10:00:00Z' } } as any;
    const page = await readTranscriptPage(pointer);
    expect(page.messages.map((message) => message.text)).toEqual(['Run the tests', 'Thanks']);
  });
});
