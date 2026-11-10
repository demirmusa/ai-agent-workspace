import { realpath } from 'node:fs/promises';
import { isPathInside, pathKey } from '../shared/core/paths.js';
import { HISTORY_LIMITS, codexToolInput, contentText, historyPagination, publicContent, publicUserText, stamp, toolResultMeta, typedCommand } from './history-records.js';
import { jsonRow, openReadOnly } from './source-files.js';
import { ControlError, type ControlEvent, type SessionHistoryDetail, type TaskMessage } from './types.js';
import type { HistoryPointer } from './history.js';

/**
 * One page of a native transcript as console events and messages, starting at a byte cursor on a record boundary.
 * Only public conversation and tool records are returned; turns recorded in another project folder are left out.
 */
export async function readTranscriptPage(pointer: HistoryPointer, query: { limit?: unknown; cursor?: unknown } = {}): Promise<SessionHistoryDetail> {
  const sourceId = pointer.session.id;
  const { count, offset } = historyPagination(query.limit, query.cursor, 100, 200);
  const events: ControlEvent[] = []; const messages: TaskMessage[] = []; const warnings = new Set<string>(); let skipped = false, outputTruncated = false; let lastUser = { text: '', source: '' };
  // Each recorded cwd is resolved once per page: real folders decide membership, so /cd and links cannot pull in another project.
  const inside = new Map<string, Promise<boolean>>();
  const insideSession = (cwd: string): Promise<boolean> => {
    let known = inside.get(cwd);
    if (!known) { known = realpath(cwd).then((real) => isPathInside(pathKey(pointer.session.cwd), pathKey(real)), () => false); inside.set(cwd, known); }
    return known;
  };
  let file; try { file = await openReadOnly(pointer.path); } catch { throw new ControlError('Session transcript is no longer readable. Refresh Sessions and retry.', 409); }
  let position = offset, consumed = 0, oversized = false, pending = Buffer.alloc(0), lineStart = offset, stop = false;
  try {
    const size = (await file.stat()).size;
    if (offset > size) throw new ControlError('History cursor is outside the session file.');
    if (offset) { const previous = Buffer.alloc(1); await file.read(previous, 0, 1, offset - 1); if (previous[0] !== 10) throw new ControlError('History cursor must identify a record boundary.'); }
    const consume = async (line: Buffer, start: number): Promise<void> => {
      const row = jsonRow(line.toString('utf8')); if (!row) { if (line.length) skipped = true; return; }
      if (pointer.startOrdinal !== undefined && typeof row.ordinal === 'number' && row.ordinal < pointer.startOrdinal) return;
      if (typeof row.sessionId === 'string' && row.sessionId !== pointer.session.sessionId) return;
      if (pointer.childAgentId && typeof row.agentId === 'string' && row.agentId !== pointer.childAgentId) return;
      if (row.isMeta === true) return;
      const cwd = row.cwd ?? (row.type === 'turn_context' ? row.payload?.cwd : undefined);
      // A shell `cd` into a subfolder moves the recorded cwd; those turns still belong to the session.
      if (!pointer.related && !pointer.managed && typeof cwd === 'string' && !await insideSession(cwd)) return;
      const at = stamp(row.timestamp, pointer.session.createdAt); const uid = `history_${sourceId}_${start}`;
      const emit = (value: unknown): void => { events.push({ id: uid, runId: sourceId, taskId: null, type: 'stdout', message: `${JSON.stringify(value)}\n`, createdAt: at }); };
      const user = (value: string, source = ''): void => { const output = typedCommand(value) || publicUserText(value); if (!output.trim()) return; if (pointer.session.provider === 'codex' && lastUser.text === output && lastUser.source !== source) return; messages.push({ id: `${uid}_user`, taskId: '', runId: sourceId, agentId: null, authorType: 'user', authorName: 'User', text: output.slice(0, 16000), createdAt: at }); lastUser = { text: output, source }; };
      if (pointer.session.provider === 'claude') {
        if (!pointer.related && row.isSidechain) return;
        // A message typed while the agent works is not a user record: it waits in a queue and reaches the agent as an attachment.
        if (row.type === 'queue-operation') {
          if (row.operation === 'popAll') emit({ type: 'queued_message', op: 'clear', at });
          else if (row.operation === 'enqueue' && typeof row.content === 'string') { const queued = publicUserText(row.content).trim(); if (queued) emit({ type: 'queued_message', op: 'enqueue', text: queued.slice(0, 16000), at }); }
          return;
        }
        if (row.type === 'attachment') {
          const attachment = row.attachment;
          if (attachment?.type === 'queued_command' && attachment.origin?.kind === 'human' && typeof attachment.prompt === 'string') { const queued = publicUserText(attachment.prompt).trim(); if (queued) emit({ type: 'queued_message', op: 'deliver', text: queued.slice(0, 16000), at }); }
          return;
        }
        if (row.type === 'system' && row.subtype === 'compact_boundary') { emit({ type: 'system', subtype: 'compact_boundary', uuid: row.uuid }); return; }
        if (!['user', 'assistant'].includes(row.type)) return;
        const content = publicContent(row.message?.content);
        if (row.type === 'user') {
          user(contentText(content));
          const meta = toolResultMeta(row.toolUseResult), tools = content.filter((part: any) => part.type === 'tool_result');
          if (tools.length) emit({ type: 'user', message: { content: tools.map((part: any) => meta && tools.length === 1 ? { ...part, meta } : part) } });
        }
        else if (content.length) emit({ type: 'assistant', message: { id: String(row.message?.id ?? uid), content } });
      } else if (row.type === 'event_msg' && row.payload?.type === 'user_message') user(typeof row.payload.message === 'string' ? row.payload.message : '', 'event');
      else if (row.type === 'event_msg' && row.payload?.type === 'item_completed') {
        const item = row.payload.item, id = String(item?.id ?? uid).slice(0, 200);
        // The exec wrapper only names a script; these items hold the commands it really ran and the files it really changed.
        if (item?.type === 'CommandExecution') {
          const output = String(item.aggregated_output ?? ''), truncated = output.length > 16000; if (truncated) { outputTruncated = true; warnings.add('Some public tool results were limited to 16000 characters.'); }
          emit({ type: 'item.completed', item: { type: 'command_execution', id, command: Array.isArray(item.command) ? item.command.map(String).slice(0, 64) : String(item.command ?? ''), parsed_cmd: Array.isArray(item.parsed_cmd) ? item.parsed_cmd.slice(0, 8) : undefined, aggregated_output: output.slice(0, 16000), exit_code: item.exit_code, status: item.status, duration_ms: typeof item.duration?.secs === 'number' ? item.duration.secs * 1000 + Math.round((item.duration.nanos ?? 0) / 1e6) : undefined } });
        } else if (item?.type === 'FileChange' && item.changes && typeof item.changes === 'object') {
          emit({ type: 'item.completed', item: { type: 'file_change', id, status: item.status, changes: Object.entries(item.changes).slice(0, 64).map(([path, change]: [string, any]) => ({ path, kind: String(change?.type ?? 'update'), diff: String(change?.unified_diff ?? (change?.type === 'add' && typeof change.content === 'string' ? change.content.split('\n').map((line: string) => `+${line}`).join('\n') : '')).slice(0, 8000) })) } });
        }
      } else if (row.type === 'response_item') {
        const item = row.payload;
        if (item?.type === 'message' && item.role === 'user') user(contentText(item.content), 'response');
        else if (item?.type === 'message' && item.role === 'assistant') { const output = contentText(item.content); if (output) emit({ type: 'item.completed', item: { type: 'agent_message', id: uid, text: output.slice(0, 16000) } }); }
        else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
          // Reuse the renderer's provider-neutral linked tool-use/result form.
          // Keeping the same call ID preserves input when its result arrives.
          emit({ type: 'assistant', message: { id: uid, content: [{ type: 'tool_use', id: String(item.call_id ?? uid).slice(0, 200), name: String(item.name ?? 'Tool').slice(0, 200), input: codexToolInput(item) }] } });
        } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
          // Native Codex can store results as typed content blocks. String(array)
          // loses every public result by turning them into [object Object].
          // Reuse the public text allowlist; images, reasoning and metadata stay out.
          const output = contentText(item.output); const truncated = output.length > 16000;
          if (truncated) { outputTruncated = true; warnings.add('Some public tool results were limited to 16000 characters.'); }
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(item.call_id ?? uid).slice(0, 200), content: output.slice(0, 16000), ...(truncated ? { truncated: true, original_characters: output.length, retained_characters: 16000 } : {}) }] } });
        }
      }
    };
    while (position < size && consumed < HISTORY_LIMITS.pageBytes && !stop) {
      const buffer = Buffer.alloc(Math.min(65536, size - position, HISTORY_LIMITS.pageBytes - consumed)); const read = await file.read(buffer, 0, buffer.length, position); if (!read.bytesRead) break;
      position += read.bytesRead; consumed += read.bytesRead; const chunk = buffer.subarray(0, read.bytesRead); let from = 0;
      for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) {
        if (!oversized) { const line = Buffer.concat([pending, chunk.subarray(from, index)]); if (line.length <= HISTORY_LIMITS.lineBytes) await consume(line, lineStart); else skipped = true; }
        pending = Buffer.alloc(0); oversized = false; lineStart = position - chunk.length + index + 1; from = index + 1;
        if (events.length + messages.length >= count) { position = lineStart; stop = true; break; }
      }
      if (!stop) { if (!oversized) { pending = Buffer.concat([pending, chunk.subarray(from)]); if (pending.length > HISTORY_LIMITS.lineBytes) { pending = Buffer.alloc(0); oversized = true; skipped = true; } } }
    }
    if (!stop && position === size && pending.length && !oversized) await consume(pending, lineStart);
    // A budget exhausted halfway through a record must resume at its start.
    if (!stop && position < size) {
      if (lineStart === offset) { skipped = true; position = size; warnings.add('A transcript record exceeded the page safety limit; remaining content was omitted.'); }
      else position = lineStart;
    }
    if (skipped || oversized) warnings.add('Malformed, incomplete or oversized transcript records were skipped.');
    const more = position < size;
    return { session: structuredClone(pointer.session), events, messages, nextCursor: more ? String(position) : null, truncated: more || skipped || oversized || outputTruncated, warnings: [...warnings] };
  } catch (error) { if (error instanceof ControlError) throw error; throw new ControlError('Session transcript changed or could not be read. Refresh Sessions and retry.', 409); }
  finally { await file.close(); }
}
