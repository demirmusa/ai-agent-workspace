import { parseJsonOrNull } from '../shared/core/json.js';
import { ControlError } from './types.js';

/** Reading a planning or organizer provider's structured stdout: its final answer, its JSON payload and progress lines. */

/** The first balanced top-level JSON object in `text`, for providers that wrap the answer in prose or fences. */
function firstJsonObject(text: string): string | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true; else if (char === '{') depth++; else if (char === '}' && --depth === 0) { const candidate = text.slice(start, index + 1); try { JSON.parse(candidate); return candidate; } catch { break; } }
    }
  }
  return null;
}

export function parsePlanningJson(stdout: string): unknown {
  const value = providerFinalText(stdout, 'Planning').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); }
  catch {
    const extracted = firstJsonObject(value);
    if (extracted) return JSON.parse(extracted);
    throw new ControlError('Planning provider did not return valid structured task data. No tasks were created.', 502);
  }
}

/** The provider's final answer text from its structured stdout; structured provider errors are raised. */
export function providerFinalText(stdout: string, subject: string): string {
  let final = ''; const fragments: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseJsonOrNull(line); if (!event || typeof event !== 'object') continue;
    // Records of an unexpected shape are skipped; only explicit provider errors stop the turn.
    try {
      if (event.type === 'error' || event.type === 'turn.failed' || (event.type === 'result' && event.is_error === true) || (event.event === 'result' && event.result?.status === 'ERROR')) throw new ControlError(`${subject} provider failed: ${event.error?.data?.message ?? event.error?.message ?? event.result?.error ?? event.result ?? event.message ?? 'provider error'}`, 502);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text ?? final;
      if (event.type === 'result' && typeof event.result === 'string') final = event.result;
      if (event.type === 'assistant') { const text = event.message?.content?.filter((entry: any) => entry.type === 'text').map((entry: any) => entry.text).join('\n'); if (text) fragments.push(text); }
      if (event.type === 'text' && typeof event.part?.text === 'string') fragments.push(event.part.text);
      if (event.event === 'result' && typeof event.result?.response === 'string') final = event.result.response;
      if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && typeof event.step_update?.text_delta === 'string') fragments.push(event.step_update.text_delta);
      // GitHub Copilot: the last message of the main agent (subagent messages carry a parent tool call).
      if (event.type === 'session.error') throw new ControlError(`${subject} provider failed: ${event.data?.message ?? 'provider error'}`, 502);
      if (event.type === 'assistant.message' && typeof event.data?.content === 'string' && event.data.content.trim() && !event.data.parentToolCallId) final = event.data.content;
    } catch (error) { if (error instanceof ControlError) throw error; }
  }
  return (final || fragments.join('\n') || stdout).trim();
}

/** A short human-readable line for provider progress (reasoning, commands, tools); null when a line carries none. */
export function planningActivity(line: string): string | null {
  const event = parseJsonOrNull(line);
  const clip = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 240) : null;
  const item = event?.item;
  if (event?.type === 'item.completed' && item?.type === 'reasoning') return clip(item.text);
  if (event?.type === 'item.started' && item?.type === 'command_execution') return clip(`$ ${item.command}`);
  if (event?.type === 'item.started' && item?.type === 'web_search') return clip(`⌕ ${item.query}`);
  if (event?.type === 'tool.execution_start') { const input = event.data?.arguments ?? {}; return clip(`${input.command ? '$ ' : `${event.data?.toolName ?? ''} `}${[input.command, input.path, input.pattern, input.query].find((value) => typeof value === 'string') ?? ''}`); }
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const entry of event.message.content) {
      if (entry?.type === 'thinking') return clip(entry.thinking);
      if (entry?.type === 'tool_use') { const input = entry.input ?? {}; return clip(`${entry.name} ${[input.command, input.file_path, input.pattern, input.query].find((value) => typeof value === 'string') ?? ''}`); }
    }
  }
  return null;
}
