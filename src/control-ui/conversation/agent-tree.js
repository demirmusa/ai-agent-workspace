/* The agent hierarchy of a console snapshot: inferAgentTree merges the server's agent tree with the subagents the transcript
 * reported into one keyed list under the main agent, plus the status, elapsed-time and naming rules agent cards share. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { toolPresentation, normalize } = kit;
  const statusLabel = status => ({ history: globalThis.AIWSI18n.text('Geçmiş oturum'), starting: globalThis.AIWSI18n.text('Başlıyor'), pending: globalThis.AIWSI18n.text('Başlamayı bekliyor'), stopped: globalThis.AIWSI18n.text('Durduruldu'), unknown: globalThis.AIWSI18n.text('Bilgi bekleniyor'), unavailable: globalThis.AIWSI18n.text('Kaynak bulunamadı'), closed: globalThis.AIWSI18n.text('Kapatıldı'), running: globalThis.AIWSI18n.text('Çalışıyor'), completed: globalThis.AIWSI18n.text('Tamamlandı'), failed: globalThis.AIWSI18n.text('Başarısız'), incomplete: globalThis.AIWSI18n.text('Tamamlanmadı'), paused: globalThis.AIWSI18n.text('Duraklatıldı'), waiting: globalThis.AIWSI18n.text('Yanıt bekleniyor'), cancelled: globalThis.AIWSI18n.text('İptal edildi'), interrupted: globalThis.AIWSI18n.text('Kesildi') })[status] || status || '';
  function inferAgentTree(data = {}, normalized = normalize(data)) {
    const supplied = data.agentTree, roots = normalized.filter(group => group.id !== 'notes'), latest = roots.at(-1), provider = latest?.provider || data.provider || 'agent';
    const sessionId = latest?.sessionId, rootId = supplied?.rootId || (sessionId ? provider === 'claude' ? `claude:session:${sessionId}` : `${provider}:${sessionId}` : `root:${data.taskId || latest?.id || 'session'}`);
    const rows = new Map(), aliases = new Map();
    const root = { id: rootId, parentId: null, provider, sessionId, name: latest?.executionSnapshot?.agent?.name || globalThis.AIWSI18n.text('Ana agent'), status: latest?.status || 'unknown', startedAt: latest?.startedAt, finishedAt: latest?.finishedAt, readOnly: Boolean(data.readOnly), aliases: [] };
    rows.set(rootId, root); aliases.set(rootId, rootId);
    for (const group of roots) if (group.sessionId) { const alias = group.provider === 'claude' ? `claude:session:${group.sessionId}` : `${group.provider}:${group.sessionId}`; aliases.set(alias, rootId); root.aliases.push(alias); }
    for (const agent of supplied?.agents || []) {
      if (!agent || !agent.id) continue;
      const activity = agent.activity?.tool && { kind: 'tool', ...toolPresentation(agent.activity.tool, agent.activity.input), startedAt: agent.activity.at, status: liveAgent.includes(agent.status) ? 'running' : 'completed' };
      rows.set(agent.id, { ...agent, aliases: [...(agent.aliases || [])], activity: activity || undefined });
      for (const alias of [agent.id, ...(agent.aliases || [])]) aliases.set(alias, agent.id);
    }
    for (const group of normalized) for (const candidate of group.agents || []) {
      const resolved = [candidate.id, ...(candidate.aliases || [])].map(alias => aliases.get(alias)).find(Boolean), id = resolved || candidate.id;
      if (id === rootId) continue;
      // An unbound Claude Agent invocation is not another identity beside an
      // authoritative child-file record. Only merge a proved tool/task alias.
      if (supplied && !resolved && candidate.id.startsWith('claude:tool:') && !candidate.aliases?.some(alias => alias.startsWith('claude:agent:'))) continue;
      const existing = rows.get(id), merged = existing ? { ...candidate, ...existing, aliases: [...new Set([candidate.id, ...(candidate.aliases || []), ...(existing.aliases || [])])] } : { ...candidate, aliases: [...(candidate.aliases || [])] };
      rows.set(id, { ...merged, id }); for (const alias of [id, ...(merged.aliases || [])]) aliases.set(alias, id);
    }
    // A subagent's own streamed tool calls replace an older activity from its transcript file.
    for (const group of normalized) for (const node of group.nodes || []) if (node.agentId && (node.kind === 'tool' || node.kind === 'files')) { const agent = rows.get(aliases.get(node.agentId) || node.agentId); if (agent && agent.id !== rootId && !(String(agent.activity?.startedAt || '') > String(node.startedAt || ''))) agent.activity = node; }
    for (const agent of rows.values()) if (agent.id !== rootId) { const parent = aliases.get(agent.parentId) || agent.parentId; agent.parentId = rows.has(parent) && parent !== agent.id ? parent : rootId; }
    // A workflow card reports its progress and its current step, and every view draws it from these.
    for (const agent of rows.values()) if (agent.kind === 'workflow') {
      const steps = [...rows.values()].filter(child => child.parentId === agent.id), done = steps.filter(child => endedAgent.includes(child.status)).length, current = steps.filter(child => liveAgent.includes(child.status)).at(-1)?.phase;
      agent.role = globalThis.AIWSI18n.template`Workflow · ${done}/${steps.length} agent`; agent.note = current ? globalThis.AIWSI18n.template`Şu anki adım: ${current}` : agent.description;
    }
    return { rootId, agents: [...rows.values()], aliases };
  }
  /** One workflow as a tree of its own for the hierarchy canvas: the workflow, its steps in order and each step's agents. */
  function workflowTree(tree, workflowId) {
    const workflow = tree.agents.find(agent => agent.id === workflowId); if (!workflow) return null;
    const below = new Set([workflowId]), members = []; for (let grown = true; grown;) { grown = false; for (const agent of tree.agents) if (!below.has(agent.id) && below.has(agent.parentId)) { below.add(agent.id); members.push(agent); grown = true; } }
    const steps = (workflow.phases || []).map((phase, index) => ({ phase, id: `${workflowId}:phase:${index}` })), stepOf = new Map(steps.map(step => [step.phase.title, step.id]));
    const placed = members.map(agent => agent.parentId === workflowId && stepOf.has(agent.phase) ? { ...agent, parentId: stepOf.get(agent.phase) } : agent);
    const nodes = steps.map(({ phase, id }) => {
      const own = placed.filter(agent => agent.parentId === id), starts = own.map(agent => agent.startedAt).filter(Boolean).sort(), ends = own.map(agent => agent.finishedAt).filter(Boolean).sort();
      const status = own.some(agent => agent.status === 'failed') ? 'failed' : own.some(agent => liveAgent.includes(agent.status)) ? 'running' : !own.length ? 'pending' : own.every(agent => agent.status === 'completed') ? 'completed' : own.at(-1).status;
      return { id, parentId: workflowId, kind: 'phase', provider: workflow.provider, name: phase.title, role: globalThis.AIWSI18n.template`${own.filter(agent => endedAgent.includes(agent.status)).length}/${own.length} agent`, note: phase.detail, status, startedAt: starts[0], ...(status === 'running' ? {} : { finishedAt: ends.at(-1) }), updatedAt: ends.at(-1) };
    });
    return { rootId: workflowId, agents: [{ ...workflow, kind: undefined, parentId: null, note: workflow.description }, ...nodes, ...placed] };
  }
  // Ended agents move to the finished group; live ones count their elapsed time up to now.
  const endedAgent = ['completed', 'failed', 'cancelled', 'closed', 'interrupted', 'stopped'], liveAgent = ['running', 'starting', 'waiting'];
  /** Elapsed time as m:ss, or h:mm:ss from an hour on; '' when unknown. */
  const elapsedClock = ms => { if (!Number.isFinite(ms) || ms < 0) return ''; const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), rest = String(seconds % 60).padStart(2, '0'); return hours ? `${hours}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${rest}` : `${Math.floor(seconds / 60)}:${rest}`; };
  const agentElapsed = agent => elapsedClock(agent.elapsedMs ?? (agent.finishedAt ? Date.parse(agent.finishedAt) : liveAgent.includes(agent.status) ? Date.now() : Date.parse(agent.updatedAt)) - Date.parse(agent.startedAt));
  const agentName = (agent, isRoot) => agent.name || (isRoot ? globalThis.AIWSI18n.text('Ana agent') : agent.id);
  const agentSub = (agent, isRoot, total) => isRoot ? (total ? globalThis.AIWSI18n.template`Ana agent · ${total} alt agent` : globalThis.AIWSI18n.text('Ana agent')) : agent.parentKnown === false ? globalThis.AIWSI18n.text('Üst agent doğrulanamadı') : [agent.role || (globalThis.AIWSProviderNames || {})[agent.provider] || agent.provider || globalThis.AIWSI18n.text('Alt agent'), agent.model].filter(Boolean).join(' · ');
  Object.assign(kit, { inferAgentTree, workflowTree, statusLabel, endedAgent, liveAgent, agentElapsed, agentName, agentSub });
})(globalThis);
