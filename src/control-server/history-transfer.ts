import { parseJsonOrNull } from '../shared/core/json.js';
import { ControlError, type ControlEvent, type TaskMessage } from './types.js';

/** Only public conversation/tool records; never copy raw provider metadata or reasoning. */
export function transferTranscript(messages: TaskMessage[], events: ControlEvent[]): string {
  const records: Array<{ id: string; at: string; text: string }> = messages
    .filter(message => message.authorType !== 'system')
    .map(message => ({ id: message.id, at: message.createdAt, text: `[${message.authorType}] ${message.text}` }));
  for (const event of events) {
    if (event.type !== 'stdout') continue;
    for (const [index, line] of event.message.split('\n').entries()) {
      const row = parseJsonOrNull(line);
      const item = row?.item;
      let output = '';
      if (row?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') output = `[agent] ${item.text}`;
      else if (row?.type === 'item.completed' && item?.type === 'command_execution') output = `[tool] ${JSON.stringify({ command: item.command, output: item.aggregated_output, exitCode: item.exit_code })}`;
      else if (row?.type === 'item.completed' && item?.type === 'file_change') output = `[files] ${JSON.stringify(item.changes)}`;
      else if (row?.type === 'queued_message' && row.op === 'deliver' && typeof row.text === 'string') output = `[user] ${row.text}`;
      else if (['assistant', 'user'].includes(row?.type) && Array.isArray(row.message?.content)) {
        output = row.message.content.flatMap((part: any) => {
          if (part?.type === 'text' && typeof part.text === 'string') return [`[${row.type === 'assistant' ? 'agent' : 'user'}] ${part.text}`];
          if (part?.type === 'tool_use') return [`[tool call] ${JSON.stringify({ name: part.name, input: part.input })}`];
          if (part?.type === 'tool_result') return [`[tool result] ${JSON.stringify(part.content)}`];
          return [];
        }).join('\n');
      } else if (row?.type === 'result' && typeof row.result === 'string') output = `[agent] ${row.result}`;
      else if (row?.event === 'result' && typeof row.result?.response === 'string') output = `[agent] ${row.result.response}`;
      if (output) records.push({ id: `${event.id}:${index}`, at: event.createdAt, text: output });
    }
  }
  const transcript = [...new Map(records.map(record => [record.id, record])).values()]
    .sort((left, right) => left.at.localeCompare(right.at)).map(record => record.text).join('\n\n');
  if (transcript.length > 2_000_000) throw new ControlError('Conversation history exceeds the transfer limit (2000000 characters). No new session was created.', 409);
  return transcript;
}
