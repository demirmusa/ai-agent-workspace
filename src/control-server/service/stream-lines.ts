import { aiProviders } from '../ai-providers/index.js';
import type { UsageReading } from '../run-usage.js';
import type { Provider } from '../types.js';

/** What one stream-json output line of a provider turn reports. */
export interface StreamLine {
  model?: string;
  sessionId?: string;
  /** Set when the line reports a failed turn: the error detail. */
  failure?: string;
  /** Assistant text of the main agent. */
  text?: string;
  usage?: UsageReading;
  question?: { text: string; kind: unknown };
}

type Json = Record<string, unknown>;
const field = <T>(value: unknown, key: string): T | undefined => value && typeof value === 'object' ? (value as Json)[key] as T : undefined;

/** The JSON object an output line holds; undefined for text lines and other JSON values. */
export function parseStreamLine(line: string): Json | undefined {
  const message = JSON.parse(line) as unknown;
  return message && typeof message === 'object' && !Array.isArray(message) ? message as Json : undefined;
}
/**
 * Reads one provider output record. The provider class reads what only its format
 * says; the generic formats below are also accepted from custom command runs.
 */
export function readStreamLine(provider: Provider, message: Json): StreamLine {
  const owner = provider === 'command' ? undefined : aiProviders.get(provider);
  const reported = owner?.readStreamEvent(message) ?? {};
  const result: StreamLine = {};
  const usage = owner?.readStreamUsage(message); if (usage) result.usage = usage;
  if (typeof reported.model === 'string' && reported.model.length <= 200) result.model = reported.model;
  const sessionId = message.type === 'thread.started' && typeof message.thread_id === 'string' ? message.thread_id
    : message.type === 'system' && typeof message.session_id === 'string' ? message.session_id
    : message.event === 'init' && typeof message.conversation_id === 'string' ? message.conversation_id
    : message.event === 'result' && typeof field(message.result, 'conversation_id') === 'string' ? field<string>(message.result, 'conversation_id')
    : reported.sessionId;
  if (sessionId) result.sessionId = sessionId;
  if (reported.failed === true) {
    const error = message.error, resultError = field(message.result, 'error'), dataMessage = field(field(error, 'data'), 'message'), errorMessage = field(error, 'message');
    result.failure = reported.errorDetail ?? (typeof dataMessage === 'string' ? dataMessage : typeof errorMessage === 'string' ? errorMessage
      : typeof resultError === 'string' ? resultError
      : typeof message.message === 'string' ? message.message : typeof message.result === 'string' ? message.result : `${provider} reported a structured error.`);
  }
  if (message.type === 'aiws.question' && typeof message.text === 'string') result.question = { text: message.text, kind: message.kind };
  let text: string | undefined;
  if (message.type === 'item.completed') { const item = message.item as { type?: string; text?: string } | undefined; if (item?.type === 'agent_message') text = item.text; }
  if (message.type === 'text') text = field<string>(message.part, 'text');
  if (message.type === 'result' && typeof message.result === 'string' && message.is_error !== true) text = message.result;
  if (message.type === 'assistant') text = field<Array<{ type: string; text?: string }>>(message.message, 'content')?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  if (message.event === 'result' && field(message.result, 'status') !== 'ERROR' && typeof field(message.result, 'response') === 'string') text = field<string>(message.result, 'response');
  if (message.event === 'step_update' && field(message.step_update, 'step_type') === 'agent_response' && typeof field(message.step_update, 'text') === 'string') text = field<string>(message.step_update, 'text');
  if (reported.text !== undefined) text = reported.text;
  if (text !== undefined) result.text = text;
  return result;
}

/** Assistant text of one provider stream-json line (Codex or Claude), if any. */
export function providerAnswer(line: string): string {
  try {
    const message = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown }; message?: { content?: Array<{ type?: string; text?: unknown }> } };
    if (message.type === 'item.completed' && message.item?.type === 'agent_message' && typeof message.item.text === 'string') return message.item.text;
    if (message.type === 'assistant' && Array.isArray(message.message?.content)) return message.message.content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n');
  } catch { /* Not a provider record. */ }
  return '';
}
