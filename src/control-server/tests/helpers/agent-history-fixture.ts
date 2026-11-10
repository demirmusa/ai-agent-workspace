import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const historyJsonl = (rows: unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
/** Shapes verified against actual installed Codex rollouts and official exec events. */
export function seedCodexAgentFamily(home: string, cwd: string, childCwd = cwd) {
  const directory = join(home, 'sessions', '2026', '10', '16'); mkdirSync(directory, { recursive: true });
  const rootId = randomUUID(), childIds = Array.from({ length: 5 }, () => randomUUID()); const at = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString();
  const children = childIds.map((id, index) => {
    const path = join(directory, `rollout-${id}.jsonl`); const parent = index === 4 ? childIds[0]! : rootId;
    writeFileSync(path, historyJsonl([{ timestamp: at(), type: 'session_meta', payload: { id, cwd: childCwd, timestamp: at(), source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: index === 4 ? 2 : 1, agent_nickname: `Worker ${index + 1}`, agent_role: 'reviewer' } } }, subagent_history_start_ordinal: 10 } }, { ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FORKED_PARENT_CONTEXT_MUST_NOT_APPEAR' }] } }, { ordinal: 10, timestamp: at(), type: 'event_msg', payload: { type: 'task_started' } }, { ordinal: 11, timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `CHILD_PUBLIC_${index + 1}` }] } }, { ordinal: 12, type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'PRIVATE_REASONING_NOT_PUBLIC' } }]));
    return { id, parent, path };
  });
  const states = ['running', 'waiting', 'completed', 'errored', 'interrupted'];
  const rootPath = join(directory, `rollout-${rootId}.jsonl`);
  writeFileSync(rootPath, historyJsonl([{ timestamp: at(), type: 'session_meta', payload: { id: rootId, cwd, timestamp: at(), source: 'cli', base_instructions: 'PRIVATE_BASE_INSTRUCTIONS' } }, { timestamp: at(), type: 'event_msg', payload: { type: 'user_message', message: 'Delegate five independent checks.' } }, { timestamp: at(1), type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: rootId, receiver_thread_ids: childIds, agents_states: Object.fromEntries(childIds.map((id, index) => [id, { status: states[index], message: 'PRIVATE_CHILD_STATUS_MESSAGE_NOT_EXPOSED' }])) } }, { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ROOT_PUBLIC_ONLY' }] } }]));
  return { rootId, childIds, children, rootPath, at, directory };
}
