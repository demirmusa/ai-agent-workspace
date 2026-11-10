import { isoTimestamp, jsonRow } from './source-files.js';
import { ControlError, type AgentActivity, type HistoryProvider } from './types.js';

/** Provider-neutral reading of single Codex and Claude Code transcript records; only public conversation content leaves here. */

export const HISTORY_LIMITS = { files: 3000, entries: 15000, scanBytes: 48 * 1024 * 1024, prefixBytes: 96 * 1024, firstUserBytes: 512 * 1024, pageBytes: 2 * 1024 * 1024, lineBytes: 1024 * 1024, searchCharacters: 200, searchTerms: 8, searchText: 4000, searchHydrate: 48 };

export const stamp = (value: unknown, fallback: string): string => isoTimestamp(value) ?? fallback;
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((part) => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
}
const INJECTED_BLOCK = String.raw`\s*<(system-reminder|task-notification|agent-message)\b[^>]*>(?:(?!<\/\1>)[\s\S])*<\/\1>\s*`;
const LEADING_INJECTED = new RegExp(`^(?:${INJECTED_BLOCK})+`, 'i'), TRAILING_INJECTED = new RegExp(`(?:${INJECTED_BLOCK})+$`, 'i');
/** User text without what the provider adds around it: setup records, local command echoes, session summaries, reminders, background task notifications and the reports background subagents hand back. */
export function publicUserText(value: string): string {
  if (/^\s*(?:<(?:environment_context|permissions instructions|developer_instructions|user_instructions|INSTRUCTIONS|command-name|command-message|local-command-caveat|local-command-stdout|bash-input|bash-stdout|bash-stderr)\b|# AGENTS\.md instructions for\b|This session is being continued from a previous conversation\b)/i.test(value)) return '';
  return value.replace(LEADING_INJECTED, '').replace(TRAILING_INJECTED, '').replace(/<\/?pasted_content\b[^>]*>/gi, '');
}
/** What the human typed as a slash command (`/name args`) or a shell escape (`! command`); '' for any other record. */
export function typedCommand(value: string): string {
  const shell = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/.exec(value)?.[1]?.trim();
  if (shell) return `! ${shell}`;
  const name = /^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>([^<]*)<\/command-name>/.exec(value)?.[1]?.trim();
  if (!name) return '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(value)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}
/** The small, safe facts Claude Code records about a tool result: counts, the line range read and the answers given to a question. */
export function toolResultMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, any>, meta: Record<string, unknown> = {};
  for (const key of ['numFiles', 'numLines', 'numMatches', 'totalFiles', 'totalMatches', 'durationMs', 'appliedLimit']) if (typeof source[key] === 'number') meta[key] = source[key];
  if (typeof source.mode === 'string') meta.mode = source.mode.slice(0, 40);
  if (source.truncated === true) meta.truncated = true;
  if (source.file && typeof source.file === 'object') for (const key of ['startLine', 'numLines', 'totalLines']) if (typeof source.file[key] === 'number') meta[key] = source.file[key];
  if (source.answers && typeof source.answers === 'object' && !Array.isArray(source.answers)) meta.answers = Object.fromEntries(Object.entries(source.answers).slice(0, 16).map(([question, answer]) => [question.slice(0, 2000), String(answer).slice(0, 2000)]));
  return Object.keys(meta).length ? meta : null;
}
/** A record the provider writes to continue the agent's work without a human message: a background task or subagent finished, or the session was compacted. */
export const resumesAgentTurn = (value: string): boolean => /^\s*(?:<task-notification\b|<agent-message\b|This session is being continued from a previous conversation\b)/i.test(value);
/** The text of a record the human typed, or '' for any other record. */
function userText(row: any, provider: HistoryProvider, strict = true): string {
  if (provider === 'codex') {
    if (row.type === 'event_msg' && row.payload?.type === 'user_message' && typeof row.payload.message === 'string') return row.payload.message;
    if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') return publicUserText(contentText(row.payload.content));
    return '';
  }
  return row.type === 'user' && !row.isMeta && !row.isSidechain ? strict ? publicUserText(contentText(row.message?.content)) : contentText(row.message?.content) : '';
}
export function firstPublicUser(rows: any[], provider: HistoryProvider): string {
  for (const row of rows) { const text = publicUserText(userText(row, provider)); if (text.trim()) return text; }
  return '';
}
/** True when a user record of the transcript contains `marker` (the bootstrap prompt path of an AIWS run). */
export function containsMarker(rows: any[], provider: HistoryProvider, marker: string): boolean {
  return rows.some((row) => userText(row, provider, false).includes(marker));
}
/** The session metadata record: Codex `session_meta`, or the first Claude record carrying cwd and session ID. */
export function sessionMeta(rows: any[], provider: HistoryProvider, mainOnly = true): any {
  return rows.find((row) => provider === 'codex' ? row.type === 'session_meta' : row.cwd && row.sessionId && !(mainOnly && row.isSidechain));
}
/** Session ID and working directory a metadata record names. */
export function metaIdentity(meta: any, provider: HistoryProvider): { sessionId: unknown; cwd: unknown } {
  return provider === 'codex' ? { sessionId: meta?.payload?.id ?? meta?.payload?.session_id, cwd: meta?.payload?.cwd } : { sessionId: meta?.sessionId, cwd: meta?.cwd };
}
export const titleText = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 200) : '';
export function publicContent(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content.slice(0, 16000) }];
  if (!Array.isArray(content)) return [];
  return content.slice(0, 64).flatMap((part): unknown[] => {
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text.slice(0, 16000) }];
    if (part.type === 'tool_use' && typeof part.name === 'string') return [{ type: 'tool_use', id: String(part.id ?? '').slice(0, 200), name: part.name.slice(0, 200), input: safeToolInput(part.input) }];
    if (part.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: String(part.tool_use_id ?? '').slice(0, 200), content: contentText(part.content).slice(0, 16000), is_error: part.is_error === true }];
    return []; // No thinking, signatures, encrypted reasoning, images or attachments.
  });
}
function safeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  // Actual tool arguments are visible conversation content, not provider/config metadata.
  if (JSON.stringify(input).length <= 16000) return input as Record<string, unknown>;
  // A long call stays readable: short fields such as the file path survive whole and long text is cut to the budget.
  const kept: Record<string, unknown> = { truncated: true }; let budget = 16000;
  for (const [key, value] of Object.entries(input).sort(([, left], [, right]) => JSON.stringify(left ?? '').length - JSON.stringify(right ?? '').length)) {
    if (budget <= 0) break;
    if (typeof value === 'string') { kept[key] = value.slice(0, budget); budget -= Math.min(value.length, budget); continue; }
    const size = JSON.stringify(value ?? '').length; if (size <= budget) { kept[key] = value; budget -= size; }
  }
  return kept;
}
/** A Codex function or custom tool call's arguments as the provider-neutral tool_use input. */
export function codexToolInput(item: { arguments?: unknown; input?: unknown }): Record<string, unknown> {
  const argumentsText = String(item.arguments ?? item.input ?? ''); const argumentsObject = jsonRow(argumentsText);
  return argumentsObject ? safeToolInput(argumentsObject) : { input: argumentsText.slice(0, 16000) };
}
/** A tool call reduced to the short string arguments an activity line shows. */
export function toolActivity(tool: string, input: unknown, at?: string): AgentActivity {
  const fields = Object.entries(safeToolInput(input)).flatMap(([key, value]): Array<[string, unknown]> => typeof value === 'string' ? [[key, value.slice(0, 400)]] : Array.isArray(value) && value.every((part) => typeof part === 'string') ? [[key, value.slice(0, 8).map((part) => part.slice(0, 400))]] : []);
  return { tool: tool.slice(0, 200), input: Object.fromEntries(fields.slice(0, 12)), ...(at ? { at } : {}) };
}
/** Page size and byte-offset cursor of a history request. */
export function historyPagination(limit: unknown, cursor: unknown, fallback: number, maximum: number): { count: number; offset: number } {
  const count = limit === undefined || limit === null ? fallback : Number(limit); const raw = cursor ?? '0';
  if (!Number.isInteger(count) || count < 1 || count > maximum || typeof raw !== 'string' || !/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ControlError('Invalid history pagination.');
  return { count, offset: Number(raw) };
}
