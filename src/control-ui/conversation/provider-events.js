/* Decodes one JSON record of a provider's stream into console nodes and agents: Codex (thread/turn/item events), Claude Code
 * (system, assistant, user and result records), GitHub Copilot CLI (dotted session events), OpenCode (text/step/tool parts) and
 * Antigravity (init/step_update/result). `tools` comes from normalize(): upsert(source, id, node), recordAgent(source, id, patch)
 * and agentStatus(status). Private reasoning is never shown. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { hash, textOf, publicToolRaw, publicToolOutput, toolPresentation, webPresentation, commandTitle, commandPresentation, commandLine, toolResult, redactToolText } = kit;
  function decodeProviderEvent(tools, source, item, event) {
    const { upsert, recordAgent, agentStatus } = tools;
    const raw = publicToolRaw(item), fingerprint = `${source.group.turn}:${JSON.stringify(item)}`;
    if (item.type !== 'turn.started' && source.jsonSeen.has(fingerprint)) return; source.jsonSeen.add(fingerprint);
    const type = item.type || 'event', timestamp = event.createdAt;
    const base = { startedAt: timestamp, raw, ...(Number.isFinite(event.sequence) ? { sequence: event.sequence } : {}) };
    if (item.parent_tool_use_id || item.agent_id) {
      const toolId = item.parent_tool_use_id && `claude:tool:${item.parent_tool_use_id}`, taskId = item.agent_id && `claude:agent:${item.agent_id}`;
      const agent = recordAgent(source, source.aliases.get(taskId) || source.aliases.get(toolId) || toolId || taskId, { aliases: [toolId, taskId].filter(Boolean), startedAt: timestamp, updatedAt: timestamp, transcriptAvailable: true }); base.agentId = agent.id;
    }
    // A message the human typed while the agent worked: it shows at once and stays marked until the agent receives it.
    if (type === 'queued_message') {
      const open = source.queued ||= new Map(), text = String(item.text || '');
      if (item.op === 'clear') { for (const key of open.values()) { const node = source.items.get(key); source.items.delete(key); if (node) source.group.nodes.splice(source.group.nodes.indexOf(node), 1); } open.clear(); return; }
      const opened = open.get(text), key = opened || `queued:${hash(text)}:${event.id || hash(raw)}`;
      if (item.op === 'enqueue') { if (!opened) { open.set(text, key); upsert(source, key, { ...base, raw: '', kind: 'user', text, queued: true }); } return; }
      open.delete(text); if (opened) upsert(source, key, { queued: false, delivered: true }); else upsert(source, key, { ...base, raw: '', kind: 'user', text, delivered: true });
      return;
    }
    if (type === 'thread.started') { source.group.sessionId = item.thread_id || source.group.sessionId; return; }
    if (type === 'turn.started') { source.group.turn++; upsert(source, `turn:${source.group.turn}`, { ...base, kind: 'turn', title: globalThis.AIWSI18n.template`${source.group.turn}. çalışma turu` }); return; }
    if (type === 'turn.completed') { source.group.usage = item.usage || source.group.usage; return; }
    if (type === 'system') {
      source.group.sessionId = item.session_id || source.group.sessionId; source.group.model = item.model || source.group.model;
      if (item.subtype === 'compact_boundary') { upsert(source, `compact:${item.uuid || hash(raw)}`, { ...base, raw: '', kind: 'lifecycle', title: globalThis.AIWSI18n.text('Konuşma özetlendi') }); return; }
      if (['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(item.subtype) && !item.ambient) {
          const taskId = item.task_id && `claude:agent:${item.task_id}`, toolId = item.tool_use_id && `claude:tool:${item.tool_use_id}`, known = source.aliases.get(taskId) || source.aliases.get(toolId), agentType = ['local_agent', 'remote_agent'].includes(item.task_type);
        if (known || agentType) {
          const parentId = item.parent_task_id ? source.aliases.get(`claude:agent:${item.parent_task_id}`) || `claude:agent:${item.parent_task_id}` : undefined;
          const previous = known && source.agents.get(known), status = item.subtype === 'task_started' || item.subtype === 'task_progress' ? 'running' : agentStatus(item.patch?.status || item.status || previous?.status);
          const patch = { aliases: [taskId, toolId].filter(Boolean), status, ...(item.run_id ? { providerRunId: item.run_id } : {}), updatedAt: timestamp, startedAt: timestamp, ...(parentId ? { parentId } : {}), ...(item.description || item.patch?.description ? { name: item.description || item.patch.description } : {}), ...(item.subagent_type ? { role: item.subagent_type } : {}), ...(item.usage?.duration_ms !== undefined ? { elapsedMs: item.usage.duration_ms } : {}), ...(['completed', 'failed', 'cancelled'].includes(status) ? { finishedAt: timestamp } : {}) };
          const agent = recordAgent(source, known || toolId || taskId, patch);
          if (item.summary && (!item.run_id || item.run_id === agent.providerRunId)) upsert(source, `agent-summary:${agent.id}:${item.uuid || hash(raw)}`, { ...base, agentId: agent.id, kind: item.subtype === 'task_notification' && status === 'failed' ? 'error' : 'assistant', text: item.summary });
        }
      }
      return;
    }
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      const value = item.item || {}, id = `item:${source.group.turn}:${value.id || hash(raw)}`, done = type === 'item.completed';
      const status = value.status === 'failed' || Number(value.exit_code || 0) !== 0 ? 'failed' : done ? 'completed' : 'running';
      if (value.type === 'agent_message') { upsert(source, id, { ...base, kind: 'assistant', text: textOf(value.text), status }); return; }
      if (value.type === 'command_execution' || value.type === 'mcp_tool_call' || value.type === 'web_search') {
        const parsed = Array.isArray(value.parsed_cmd) && value.parsed_cmd.length === 1 && typeof value.parsed_cmd[0]?.cmd === 'string' ? value.parsed_cmd[0].cmd : '';
        const command = parsed || commandLine(value.command) || value.query || `${value.server || ''} ${value.tool || ''}`.trim();
        const action=value.action||{},webInput=action.type==='open_page'||action.type==='openPage'?{open:[{ref_id:action.url||action.ref_id}]}:action.type==='find_in_page'||action.type==='findInPage'?{find:[{ref_id:action.url||action.ref_id,pattern:action.pattern}]}:{search_query:(action.queries||[action.query||value.query]).filter(Boolean).map(q=>({q}))};
        const presentation = value.type === 'mcp_tool_call' ? toolPresentation(value.tool, value.arguments || value.input || {}) : value.type==='web_search'?webPresentation([webInput]):commandPresentation(command);
        upsert(source, id, { ...base, kind: 'tool', ...presentation, ...(presentation.hideToolPayload||presentation.hideRawInput ? { raw: '' } : {}), output: presentation.hideToolPayload ? '' : publicToolOutput(value.aggregated_output ?? value.result ?? value.error), exitCode: value.exit_code, ...(Number.isFinite(value.duration_ms) ? { durationMs: value.duration_ms } : {}), status, finishedAt: done ? timestamp : null }); return;
      }
      if (value.type === 'file_change') { upsert(source, id, { ...base, kind: 'files', title: globalThis.AIWSI18n.text('Dosya değişiklikleri'), files: Array.isArray(value.changes) ? value.changes.filter(change => change && typeof change === 'object') : [], status, finishedAt: done ? timestamp : null }); return; }
      if (value.type === 'collab_tool_call') {
        const sender = value.sender_thread_id && `codex:${value.sender_thread_id}`;
        if (sender && value.sender_thread_id !== source.group.sessionId && source.agents.has(sender)) base.agentId = sender;
        for (const threadId of Array.isArray(value.receiver_thread_ids) ? value.receiver_thread_ids : []) {
          const state = value.agents_states?.[threadId] || {}, identity = value.receiver_agents?.find?.(agent => agent.thread_id === threadId), childId = `codex:${threadId}`, childStatus = agentStatus(state.status);
          const agent = recordAgent(source, childId, { parentId: sender || null, sessionId: threadId, aliases: [childId], name: identity?.agent_nickname || `Agent ${threadId.slice(-6)}`, ...(identity?.agent_role ? { role: identity.agent_role } : {}), status: childStatus, startedAt: timestamp, updatedAt: timestamp, ...(['completed', 'failed', 'closed'].includes(childStatus) ? { finishedAt: timestamp } : {}) });
          if (state.message) upsert(source, `agent-summary:${agent.id}:${hash(state.message)}`, { ...base, agentId: agent.id, kind: childStatus === 'failed' ? 'error' : 'assistant', text: textOf(state.message) });
        }
        upsert(source, id, { ...base, kind: 'tool', title: ({ spawn_agent: globalThis.AIWSI18n.text('Alt agent başlatma'), send_input: globalThis.AIWSI18n.text('Alt agenta talimat'), wait: globalThis.AIWSI18n.text('Alt agentları bekleme'), close_agent: globalThis.AIWSI18n.text('Alt agentı kapatma'), resume_agent: globalThis.AIWSI18n.text('Alt agentı sürdürme') })[value.tool] || globalThis.AIWSI18n.text('Agent koordinasyonu'), command: value.tool, status, finishedAt: done ? timestamp : null }); return;
      }
      if (value.type === 'reasoning') return; // Never synthesize or expose private chain-of-thought.
    }
    if (type === 'assistant' && Array.isArray(item.message?.content)) {
      const messageId = item.message.id || item.uuid || hash(raw);
      item.message.content.forEach((part, index) => {
        if (part?.type === 'text') upsert(source, `claude:${messageId}:${index}`, { ...base, raw: publicToolRaw(part), kind: 'assistant', text: textOf(part.text) });
        if (part?.type === 'tool_use') {
          const input = part.input || {}, presentation = toolPresentation(part.name, input);
          upsert(source, `tool:${part.id}`, { ...base, raw: publicToolRaw(part), kind: 'tool', ...presentation, ...(presentation.hideToolPayload||presentation.hideRawInput ? { raw: '' } : {}), toolName: part.name, status: 'running', output: '' });
          if (['Task', 'Agent'].includes(part.name)) { const child = recordAgent(source, `claude:tool:${part.id}`, { toolUseId: part.id, parentId: base.agentId || null, name: input.name || input.description || input.subagent_type || `Agent ${part.id.slice(-6)}`, role: input.subagent_type, status: 'running', startedAt: timestamp, updatedAt: timestamp }); if (input.prompt) upsert(source, `agent-prompt:${child.id}`, { ...base, agentId: child.id, kind: 'prompt', title: globalThis.AIWSI18n.text('Alt agent talimatı'), text: textOf(input.prompt) }); }
        }
      }); return;
    }
    if (type === 'user' && Array.isArray(item.message?.content)) {
      for (const part of item.message.content) if (part?.type === 'tool_result') {
        const previous = source.items.get(`tool:${part.tool_use_id}`), result = toolResult(publicToolOutput(part.content));
        upsert(source, `tool:${part.tool_use_id}`, { ...base, raw: publicToolRaw(part), kind: previous?.kind || 'tool', ...(previous?.hideToolPayload ? { raw: '', output: '' } : result), ...(part.meta ? { resultMeta: part.meta } : {}), ...(part.truncated?{outputTruncated:true,originalCharacters:part.original_characters,retainedCharacters:part.retained_characters}:{}), status: part.is_error ? 'failed' : 'completed', finishedAt: timestamp });
      }
      return;
    }
    // GitHub Copilot CLI JSONL: dotted session event types, and a final result carrying the session ID.
    if (/^(?:session|hook|model|assistant|tool|user|subagent|skill|permission|system)\./.test(type) || (type === 'result' && typeof item.sessionId === 'string')) { copilotEvent(tools, source, item, base, timestamp); return; }
    if (type === 'result') {
      source.group.usage = item.usage || source.group.usage;
      if (item.is_error) upsert(source, `result:${item.uuid || hash(raw)}`, { ...base, kind: 'error', title: globalThis.AIWSI18n.text('Agent hatası'), text: textOf(item.result) || textOf(item.errors) || globalThis.AIWSI18n.text('Çalışma başarısız.') });
      else if (item.result && !source.group.nodes.some(node => node.kind === 'assistant' && node.text === textOf(item.result))) upsert(source, `result:${item.uuid || hash(raw)}`, { ...base, kind: 'assistant', text: textOf(item.result) });
      return;
    }
    if (type === 'error' || type === 'turn.failed') { upsert(source, `error:${hash(raw)}`, { ...base, kind: 'error', title: globalThis.AIWSI18n.text('Agent hatası'), text: item.error?.message || item.error?.data?.message || item.message || textOf(item.error) }); return; }
    if (type === 'text' && item.part?.text) { upsert(source, `opencode:${item.part.id || hash(raw)}`, { ...base, kind: 'assistant', text: textOf(item.part.text) }); return; }
    if (type === 'step_start' || type === 'step_finish') { if (item.part?.tokens) source.group.usage = item.part.tokens; return; }
    if (type === 'tool_use' && item.part?.tool) {
      const part = item.part, state = part.state || {}, command = state.input?.command || textOf(state.input);
      upsert(source, `opencode-tool:${part.id || part.callID}`, { ...base, kind: 'tool', ...(state.input?.command ? commandPresentation(command, { description: state.input?.description }) : { title: commandTitle(command, part.tool), command }), output: textOf(state.output || state.error), status: state.status === 'error' ? 'failed' : state.status === 'completed' ? 'completed' : 'running', finishedAt: ['completed', 'error'].includes(state.status) ? timestamp : null }); return;
    }
    if (type === 'rate_limit_event') return; // Quota status is not conversation content.
    if (type === 'stream_event') return; // Claude's full assistant records are authoritative; avoid duplicate deltas.
    if (item.event === 'init') {
      source.group.sessionId = item.conversation_id || source.group.sessionId;
      source.group.model = item.init?.model || source.group.model;
      return;
    }
    if (item.event === 'step_update') {
      const step = item.step_update || {};
      source.group.sessionId = step.conversation_id || source.group.sessionId;
      if (step.usage) source.group.usage = step.usage;
      // Antigravity reports a subagent as its own step (invoke_subagent, browser_subagent, ...); each one becomes an agent card.
      if (/subagent/i.test(String(step.step_type || ''))) {
        const call = (Array.isArray(step.tool_calls) ? step.tool_calls[0] : null) || {}, args = step[step.step_type] || call.args || call.arguments || {};
        const status = String(step.status || '').toLowerCase(), failed = /error|fail/.test(status), done = failed || /done|complete|finish|success/.test(status);
        const label = [args.name, args.subagent_name, args.description, args.task_name, step.name, step.description].find(value => typeof value === 'string' && value.trim());
        recordAgent(source, `agy:step:${step.step_id ?? step.step_index ?? 0}`, { parentId: base.agentId || null, name: label || globalThis.AIWSI18n.text('Alt agent'), role: step.step_type, status: failed ? 'failed' : done ? 'completed' : 'running', startedAt: timestamp, updatedAt: timestamp, ...(done ? { finishedAt: timestamp } : {}) });
        return;
      }
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
        const stepId = `agy:step:${step.step_index ?? 0}`;
        const prev = source.items.get(stepId);
        upsert(source, stepId, { ...base, kind: 'assistant', text: `${prev?.text || ''}${step.text_delta}` });
      }
      return;
    }
    if (item.event === 'result') {
      const res = item.result || {};
      source.group.sessionId = res.conversation_id || source.group.sessionId;
      if (res.usage) source.group.usage = res.usage;
      if (res.status === 'ERROR') upsert(source, `result:${hash(raw)}`, { ...base, kind: 'error', title: globalThis.AIWSI18n.text('Agent hatası'), text: textOf(res.error) || textOf(res.response) || globalThis.AIWSI18n.text('Çalışma başarısız.') });
      else if (res.response && !source.group.nodes.some(node => node.kind === 'assistant' && node.text === textOf(res.response))) upsert(source, `result:${hash(raw)}`, { ...base, kind: 'assistant', text: textOf(res.response) });
      return;
    }
    upsert(source, `unknown:${hash(raw)}`, { ...base, kind: 'unknown', title: globalThis.AIWSI18n.template`Provider olayı · ${String(item.event || type).replace(/[_.]/g, ' ')}`, text: typeof item.message === 'string' ? item.message : '' });
  }
  function copilotEvent({ upsert, recordAgent }, source, item, base, timestamp) {
    const data = item.data && typeof item.data === 'object' ? item.data : {}, type = item.type;
    // Work of a subagent carries the tool call that started it.
    const parent = data.parentToolCallId && source.aliases.get(`copilot:tool:${data.parentToolCallId}`);
    if (parent) base = { ...base, agentId: parent };
    if (type === 'result') { source.group.sessionId = item.sessionId || source.group.sessionId; source.group.usage = item.usage || source.group.usage; return; }
    if (type === 'session.start' && typeof data.sessionId === 'string') { source.group.sessionId = data.sessionId; return; }
    if ((type === 'session.tools_updated' || type === 'session.model_change') && (data.model || data.newModel)) { source.group.model = data.model || data.newModel; return; }
    if (type === 'assistant.message') { if (typeof data.content === 'string' && data.content.trim()) upsert(source, `copilot:${data.messageId || hash(base.raw)}`, { ...base, kind: 'assistant', text: textOf(data.content) }); return; }
    if (type === 'tool.execution_start' && data.toolCallId) {
      const presentation = toolPresentation(data.mcpToolName || data.toolName, data.arguments || {});
      upsert(source, `copilot-tool:${data.toolCallId}`, { ...base, kind: 'tool', ...presentation, ...(presentation.hideToolPayload || presentation.hideRawInput ? { raw: '' } : {}), toolName: data.toolName, status: 'running', output: '' }); return;
    }
    if (type === 'tool.execution_complete' && data.toolCallId) {
      const previous = source.items.get(`copilot-tool:${data.toolCallId}`), result = data.result || {};
      upsert(source, `copilot-tool:${data.toolCallId}`, { ...base, raw: previous ? previous.raw : base.raw, kind: previous?.kind || 'tool', ...(previous ? {} : { title: String(data.toolName || globalThis.AIWSI18n.text('Araç çalıştırma')) }), output: previous?.hideToolPayload ? '' : publicToolOutput(result.content ?? result.detailedContent ?? data.error?.message), status: data.success === false ? 'failed' : 'completed', finishedAt: timestamp }); return;
    }
    if (/^subagent\.(?:started|completed|failed)$/.test(type) && data.toolCallId) {
      const done = type !== 'subagent.started';
      recordAgent(source, `copilot:tool:${data.toolCallId}`, { parentId: base.agentId || null, name: data.agentDisplayName || data.agentName || globalThis.AIWSI18n.text('Alt agent'), ...(data.agentName ? { role: data.agentName } : {}), status: type === 'subagent.failed' ? 'failed' : done ? 'completed' : 'running', startedAt: timestamp, updatedAt: timestamp, ...(done ? { finishedAt: timestamp } : {}) }); return;
    }
    if (type === 'session.error') { upsert(source, `error:${item.id || hash(base.raw)}`, { ...base, kind: 'error', title: globalThis.AIWSI18n.text('Agent hatası'), text: typeof data.message === 'string' ? data.message : textOf(data) }); return; }
    // Session lifecycle, hooks, model calls, streaming deltas, the echoed prompt and private reasoning are not conversation content.
  }
  Object.assign(kit, { decodeProviderEvent });
})(globalThis);
