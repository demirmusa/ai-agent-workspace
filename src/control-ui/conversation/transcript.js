/* The console's message model: normalize(snapshot) turns runs, journal events and task messages into one group per run with its
 * ordered nodes (user and agent messages, prompts AIWS wrote, tools, file changes, question exchanges, lifecycle notes) and the
 * subagents the provider reported. Streamed stdout is buffered into JSON lines and handed to decodeProviderEvent; duplicates
 * recorded by several sources are shown once. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { hash, decodeProviderEvent } = kit;
  // Prompts AIWS writes for the agent are system messages, never the user's own words.
  const SYSTEM_PROMPTS = [
    [/^\s*Read and follow the task instructions in /i, 'Görev talimatı'],
    [/^\s*Finish the requested merge\./, 'Birleştirme talimatı'],
    [/^\s*Request from @[\w.-]+ on GitHub issue #\d+/, 'GitHub isteği'],
  ];
  const systemPrompt = text => SYSTEM_PROMPTS.find(([pattern]) => pattern.test(String(text || '')))?.[1];
  // AIWS appends its continuation notice to the user's message when resuming a session; the notice is not the user's.
  const CONTINUATION_NOTICE = /\s*\[AIWS\] Continuation of the same session\.[\s\S]*$/;
  const splitContinuation = text => { const match = CONTINUATION_NOTICE.exec(String(text || '')); return match ? { user: text.slice(0, match.index).trim(), notice: match[0].trim() } : { user: String(text || '') }; };
  function normalize(data = {}) {
    const runs = [...(data.runs || (data.run ? [data.run] : []))].filter(run => !data.taskId || run.taskId === data.taskId);
    const events = [...(data.events || [])].filter(event => !data.taskId || event.taskId === data.taskId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const runIds = new Set(runs.map(run => run.id));
    for (const event of events) if (event.runId && !runIds.has(event.runId)) { runIds.add(event.runId); runs.push({ id: event.runId, provider: data.provider || 'agent', startedAt: event.createdAt, status: 'unknown' }); }
    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const groups = runs.map(run => ({ ...run, nodes: [], agents: [], usage: null, sessionId: run.sessionId || '', turn: 0 }));
    const loose = { id: 'notes', provider: globalThis.AIWSI18n.text('Görev konuşması'), nodes: [], turn: 0 };
    const sources = new Map();
    const groupById = new Map(groups.map(group => [group.id, group]));
    const sourceFor = id => { if (!sources.has(id)) sources.set(id, { group: groupById.get(id) || loose, items: new Map(), agents: new Map(), aliases: new Map(), seen: new Set(), jsonSeen: new Set(), buffer: '', bufferAt: '', sequence: 0 }); return sources.get(id); };
    const agentStatus = status => ({ pending_init: 'starting', pending: 'starting', errored: 'failed', interrupted: 'paused', shutdown: 'closed', not_found: 'unavailable', stopped: 'cancelled', killed: 'cancelled' })[status] || status || 'unknown';
    function recordAgent(source, proposedId, patch) {
      const aliases = [proposedId, ...(patch.aliases || [])].filter(Boolean), found = aliases.map(alias => source.aliases.get(alias)).find(Boolean), id = found || proposedId;
      let agent = source.agents.get(id); if (!agent) { agent = { id, provider: source.group.provider, parentId: null, name: globalThis.AIWSI18n.text('Alt agent'), status: 'unknown', readOnly: true, aliases: [] }; source.agents.set(id, agent); (source.group.agents ||= []).push(agent); }
      // Claude SDK task run_id (not session UUID) is documented as sortable by
      // run-start order: https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage
      if (patch.providerRunId && agent.providerRunId && patch.providerRunId < agent.providerRunId) return agent;
      for (const alias of aliases) { source.aliases.set(alias, id); if (!agent.aliases.includes(alias)) agent.aliases.push(alias); }
      const newExecution = patch.providerRunId && agent.providerRunId && patch.providerRunId > agent.providerRunId;
      if (newExecution) { delete agent.finishedAt; delete agent.elapsedMs; }
      const beforeStarted = newExecution ? undefined : agent.startedAt, beforeAliases = agent.aliases; Object.assign(agent, patch, { id, aliases: beforeAliases, startedAt: beforeStarted || patch.startedAt });
      return agent;
    }
    function upsert(source, id, node) {
      const previous = source.items.get(id);
      if (previous) { Object.assign(previous, node, { id, startedAt: previous.startedAt || node.startedAt }); return previous; }
      const next = { id, turn: source.group.turn, ...node }; source.items.set(id, next); source.group.nodes.push(next); return next;
    }
    function plain(source, event, content) {
      if (!content.trim()) return;
      const id = `event:${event.id || hash(event.createdAt + content)}:${hash(content)}`, stream = ['stdout', 'stderr'].includes(event.type), failed = event.type === 'stderr' || /error|failed/.test(event.type);
      // Instructions AIWS hands to the agent (queued commands, merge recovery) are system prompts.
      const prompt = !stream && (event.type === 'command' ? globalThis.AIWSI18n.text('Talimat') : systemPrompt(content) && globalThis.AIWSI18n.text(systemPrompt(content)));
      if (prompt) { upsert(source, id, { kind: 'prompt', title: prompt, text: content, startedAt: event.createdAt }); return; }
      // Short AIWS status events read as quiet notes, not as program output.
      if (!stream && !failed && content.length <= 280 && !content.includes('\n')) { upsert(source, id, { kind: 'lifecycle', text: content, startedAt: event.createdAt }); return; }
      upsert(source, id, { kind: failed ? 'error' : 'output', title: event.type === 'stderr' ? globalThis.AIWSI18n.text('Hata çıktısı') : failed ? (/merge/.test(event.type) ? globalThis.AIWSI18n.text('Birleştirme hatası') : globalThis.AIWSI18n.text('Hata')) : stream ? globalThis.AIWSI18n.text('Çıktı') : globalThis.AIWSI18n.text('Sistem notu'), text: content, startedAt: event.createdAt, raw: content, ...(!stream && !failed ? { systemNote: true } : {}) });
    }
    const tools = { upsert, recordAgent, agentStatus };
    function consume(source, event, final = false) {
      while (source.buffer.length) {
        const newline = source.buffer.indexOf('\n');
        if (newline < 0) {
          try { const json = JSON.parse(source.buffer); if (json && typeof json === 'object') decodeProviderEvent(tools, source, json, { ...event, createdAt: source.bufferAt || event.createdAt }); else plain(source, event, source.buffer); source.buffer = ''; }
          catch { if (final || !/^\s*[\[{]/.test(source.buffer)) { plain(source, event, source.buffer); source.buffer = ''; } }
          break;
        }
        const line = source.buffer.slice(0, newline).replace(/\r$/, ''); source.buffer = source.buffer.slice(newline + 1);
        if (line.trim()) { try { const json = JSON.parse(line); if (json && typeof json === 'object') decodeProviderEvent(tools, source, json, event); else plain(source, event, line); } catch { plain(source, event, line); } }
        source.bufferAt = event.createdAt;
      }
    }
    // A chat instruction is stored both as a user message and as the run's command event; show it once.
    const userInstructions = new Set((data.messages || []).filter(message => message.authorType === 'user').map(message => `${message.runId}:${String(message.text || '').trim()}`));
    for (const event of events) {
      if (event.type === 'terminal.output') continue;
      if (event.type === 'command' && userInstructions.has(`${event.runId}:${String(event.message || '').trim()}`)) continue;
      const source = sourceFor(event.runId || 'notes');
      if (source.group.terminalMode === 'pty' && ['stdout', 'stderr'].includes(event.type)) continue;
      const eventKey = event.id || hash(`${event.createdAt}:${event.type}:${event.message}`), eventFingerprint = hash(`${event.createdAt}:${event.type}:${event.message}`);
      if (source.seen.has(eventKey) || source.seen.has(eventFingerprint)) continue; source.seen.add(eventKey); source.seen.add(eventFingerprint);
      if (event.type === 'stdout') { if (!source.buffer) source.bufferAt = event.createdAt; source.buffer += event.message || ''; consume(source, event); continue; }
      // A question and its answer form one exchange in the timeline instead of two loose outputs.
      if (['question', 'answer'].includes(event.type) && event.data?.questionId) {
        const key = `question:${event.data.questionId}`;
        if (event.type === 'question') upsert(source, key, { kind: 'exchange', questionId: event.data.questionId, text: event.message || '', startedAt: event.createdAt });
        else if (source.items.has(key)) upsert(source, key, { answer: event.message || '' });
        continue;
      }
      if (['started', 'completed', 'paused', 'resumed', 'cancelled', 'interrupted', 'waiting'].includes(event.type)) {
        if (event.type === 'completed') continue;
        upsert(source, `lifecycle:${eventKey}`, { kind: 'lifecycle', title: ({ started: globalThis.AIWSI18n.text('Çalışma başladı'), paused: globalThis.AIWSI18n.text('Duraklatıldı'), resumed: globalThis.AIWSI18n.text('Devam ediyor'), cancelled: globalThis.AIWSI18n.text('İptal edildi'), interrupted: globalThis.AIWSI18n.text('Bağlantı kesildi'), waiting: globalThis.AIWSI18n.text('Yanıt bekleniyor') })[event.type], text: event.message, startedAt: event.createdAt });
      } else plain(source, event, event.message || '');
    }
    for (const source of sources.values()) {
      if (source.buffer && !['running', 'waiting', 'paused'].includes(source.group.status)) consume(source, { id: `tail:${source.group.id}`, createdAt: source.bufferAt, type: 'stdout' }, true);
      const terminal = !['running', 'waiting', 'paused', 'unknown'].includes(source.group.status);
      if (terminal) for (const node of source.group.nodes) if (['tool', 'files'].includes(node.kind) && node.status === 'running') node.status = 'incomplete';
    }
    const messages = (data.messages || []).filter(message => !data.taskId || message.taskId === data.taskId), seenMessages = new Set();
    // Assistant texts per group, so duplicate agent messages are found without rescanning every node.
    const assistantTexts = new Map(), textsOf = group => { let texts = assistantTexts.get(group); if (!texts) { texts = new Set(group.nodes.filter(node => node.kind === 'assistant').map(node => node.text?.trim())); assistantTexts.set(group, texts); } return texts; };
    for (const message of messages) {
      if (seenMessages.has(message.id)) continue; seenMessages.add(message.id);
      const group = groupById.get(message.runId) || loose;
      if (message.authorType === 'agent' && textsOf(group).has(message.text?.trim())) continue;
      if (message.authorType !== 'user' && message.authorType !== 'system') textsOf(group).add(message.text?.trim());
      if (/^\[Request interrupted by user[^\]]*\]$/.test(String(message.text || '').trim())) { group.nodes.push({ id: `message:${message.id}`, kind: 'lifecycle', title: globalThis.AIWSI18n.text('Agent durduruldu'), startedAt: message.createdAt, turn: group.turn, ...(Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}) }); continue; }
      const { user: userText, notice } = message.authorType === 'user' ? splitContinuation(message.text) : {};
      if (notice) {
        const alreadyShown = group.nodes.some(node => node.kind === 'user' && node.text?.trim() === userText);
        if (userText && !alreadyShown) group.nodes.push({ id: `message:${message.id}`, kind: 'user', author: message.authorName, text: userText, startedAt: message.createdAt, turn: group.turn, ...(Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}) });
        group.nodes.push({ id: `message:${message.id}:notice`, kind: 'prompt', title: globalThis.AIWSI18n.text('Oturum devam talimatı'), text: notice, startedAt: message.createdAt, turn: group.turn, ...(Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}) });
        continue;
      }
      const prompt = message.authorType === 'user' && systemPrompt(message.text);
      group.nodes.push({ id: `message:${message.id}`, kind: prompt ? 'prompt' : message.authorType === 'user' ? 'user' : message.authorType === 'system' ? 'lifecycle' : 'assistant', ...(prompt ? { title: globalThis.AIWSI18n.text(prompt) } : {}), author: message.authorName, text: message.text, startedAt: message.createdAt, turn: group.turn, ...(Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}) });
    }
    // A system note that repeats an agent message word for word is the same text twice; keep the agent message.
    for (const group of [...groups, loose]) {
      const texts = textsOf(group);
      group.nodes = group.nodes.filter(node => !(node.systemNote && texts.has(node.text?.trim())));
    }
    for (const group of [...groups, loose]) group.nodes.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER));
    // A Codex exec wrapper only names its script once the commands and file changes it ran are recorded on their own.
    for (const group of [...groups, loose]) if (group.nodes.some(node => node.wrapper)) group.nodes = group.nodes.filter(node => {
      if (!node.wrapper) return true;
      const from = Date.parse(node.startedAt), to = Date.parse(node.finishedAt);
      return !group.nodes.some(other => String(other.id).startsWith('item:') && ['tool', 'files'].includes(other.kind) && Date.parse(other.startedAt) >= from && !(Date.parse(other.startedAt) > to));
    });
    // A dialog of the provider's own question tool is that tool's card already; the exchange recorded from the screen stays out of sight.
    const questionsById = new Map((data.questions || []).map(question => [question.id, question]));
    for (const group of [...groups, loose]) {
      const asks = group.nodes.filter(node => node.view === 'question');
      if (asks.length) for (const node of group.nodes) if (node.kind === 'exchange' && questionsById.get(node.questionId)?.source === 'terminal') {
        const at = Date.parse(node.startedAt);
        if (asks.some(ask => at >= Date.parse(ask.startedAt) - 5000 && !(at > Date.parse(ask.finishedAt) + 5000))) node.covered = true;
      }
    }
    // The same instruction recorded by the control center and by the provider's session history is one message.
    const sentAt = new Map(), queuedTexts = new Set();
    for (const group of [...groups, loose]) for (const node of group.nodes) if (node.kind === 'user' && (node.queued || node.delivered)) queuedTexts.add(String(node.text || '').trim());
    for (const group of [...groups, loose]) group.nodes = group.nodes.filter(node => {
      if (node.kind !== 'user') return true;
      const key = String(node.text || '').trim(), time = Date.parse(node.startedAt), last = sentAt.get(key);
      // A queued message may wait for minutes; when it finally arrives as a plain record it is still the same message.
      if (queuedTexts.has(key) && !node.queued && !node.delivered && last !== undefined) return false;
      if (last !== undefined && Math.abs(time - last) < 120000) return false;
      sentAt.set(key, time); return true;
    });
    return loose.nodes.length ? [...groups, loose] : groups;
  }
  Object.assign(kit, { normalize });
})(globalThis);
