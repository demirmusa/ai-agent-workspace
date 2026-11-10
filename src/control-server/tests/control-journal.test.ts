import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../service/journal.js';
import type { ControlStore } from '../store.js';
import type { ControlEvent, TaskMessage } from '../types.js';

const saved = process.env.GEMINI_API_KEY;
afterEach(() => { if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved; });
const journal = () => {
  const state = { events: [] as ControlEvent[], messages: [] as TaskMessage[] };
  return { state, journal: new Journal({ state } as unknown as ControlStore, () => 'control-token-1234') };
};

describe('control journal', () => {
  it('redacts the control token and provider credentials from events, their data and conversations', () => {
    process.env.GEMINI_API_KEY = 'gemini-secret-5678';
    const { state, journal: log } = journal();
    log.event(null, 'task_1', 'stdout', 'token control-token-1234 and gemini-secret-5678', { url: 'https://x/?key=gemini-secret-5678' });
    log.message('task_1', 'agent', 'printed control-token-1234');
    expect(state.events[0]).toMatchObject({ message: 'token [redacted] and [redacted]', data: { url: 'https://x/?key=[redacted]' } });
    expect(state.messages[0]!.text).toBe('printed [redacted]');
    expect(log.redact('plain output')).toBe('plain output');
  });
  it('keeps the conversation log bounded in place', () => {
    const { state, journal: log } = journal(); const messages = state.messages;
    for (let index = 0; index < 10_005; index++) log.message('task_1', 'user', `message ${index}`);
    expect(state.messages).toBe(messages); expect(messages).toHaveLength(10_000); expect(messages[0]!.text).toBe('message 5');
  });
});
