/* The agent console: one surface for task, history and live sessions.
 * AIWSAgentConsole.create(host, {taskId,runs,events,messages,questions,readOnly,
 *   title,workspace,onContinue,onSendMessage,sendLabel,sendTitle,sendWithoutText,onAnswerQuestion,terminalRun,onMountTerminal})
 * accepts complete snapshots. update(snapshot) is idempotent, retaining open tools,
 * reply drafts and scroll position; callers merge SSE deltas by event ID first.
 * Keep controller.element mounted/reparent it across panel renders. destroy()
 * removes the view. onMountTerminal(run, stableHost) mounts the real terminal once
 * and may return {update(run),resize(),destroy()}; no JSON/ANSI terminal emulation.
 * AIWSConversation is a compatibility alias for exactly the same implementation.
 * This file assembles the parts (agent panel, timeline, request dock, composer, native terminal) and publishes the API. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, hash, holdFlag, providerBox, statusLabel, normalize, inferAgentTree, agentPanel, runTimeline, requestDock, onTerminalScreen, composer, nativeTerminal, activityStrip, insightPanels } = kit;
  function create(container, initial = {}) {
    const doc = container.ownerDocument;
    const root = doc.createElement('div'); root.className = 'aiws-conversation aiws-agent-console'; root.dataset.aiwsConversation = 'true'; root.dataset.agentConsole = 'true';
    root.innerHTML = globalThis.AIWSI18n.text('<header class="cv-console-toolbar"><div class="cv-console-context"></div><div class="cv-console-actions"><button type="button" class="icon-button" data-cv-action="float" title="Konsolu açılır pencereye al" aria-label="Konsolu açılır pencereye al">↗</button><div class="cv-console-modes view-tabs" role="group" aria-label="Console görünümü" hidden><button type="button" class="view-tab" data-cv-action="mode-terminal">Terminal</button><button type="button" class="view-tab" data-cv-action="mode-history">Geçmiş</button></div><button type="button" class="icon-button cv-follow-button" data-cv-action="follow" title="Son işleme git" aria-label="Son işleme git"></button><button type="button" class="icon-button cv-technical-toggle" data-cv-action="technical" aria-pressed="false" title="Ham provider olaylarını göster">{ }</button></div></header><div class="cv-console-body"><div class="cv-native-terminal" hidden><div class="cv-terminal-notice"></div><div class="cv-terminal-host terminal-host"></div></div><div class="cv-scroll conversation-history" tabindex="0" aria-label="Agent console geçmişi"><div class="cv-timeline" role="log" aria-live="polite" aria-relevant="additions text"></div><div class="cv-questions"></div></div></div><button class="cv-unread" type="button" hidden>Yeni işlemler ↓</button><div class="cv-history-footer" hidden><div><strong>Salt okunur oturum</strong><span>Geçmişi görüntülemek agentı çalıştırmaz.</span></div><button type="button" class="button primary small" data-cv-action="continue">Bu oturuma devam et →</button><p role="alert" hidden></p></div><form id="task-message-form" class="cv-composer"><label class="sr-only" for="task-message-input">Agenta mesaj</label><div class="cv-prompt-input"><textarea id="task-message-input" name="text" rows="1" placeholder="Agent için bir talimat yaz…" required></textarea><div class="cv-composer-footer"><span class="cv-composer-hint">Göreve kaydedilir · Anında iletilir <kbd>Ctrl ↵</kbd> · Durdurmak için <kbd>Esc</kbd></span><button type="button" class="button small cv-interrupt" data-cv-action="interrupt" title="Agentın şu anki işini durdurur; konsol açık kalır ve mesajını bekler." hidden>Durdur</button><button type="button" class="button small cv-deliver-now" data-cv-action="deliver-now" title="Sıradaki mesajı hemen işler; agentın şu anki turu bitmeden devam eder." hidden>Hemen gönder</button><button type="submit" class="button primary small">Gönder ↗</button></div></div><p class="cv-send-error" role="alert" hidden></p></form>');
    const idSuffix = initial.instanceId && !initial.instanceId.startsWith('task:') ? `-${hash(initial.instanceId)}` : '';
    if (idSuffix) { root.querySelector('form').id += idSuffix; root.querySelector('textarea').id += idSuffix; root.querySelector('label').htmlFor = root.querySelector('textarea').id; }
    root.querySelector('[data-cv-action=continue]').dataset.consoleContinue = 'true'; root.querySelector('.cv-follow-button').innerHTML = global.AIWSUI.icon('arrow-right');
    let data = initial, following = true, changes = 0, activityInitialized = false, activitySignatures = new Map(), destroyed = false, mode = 'history', toolbarSignature = '', selectedAgentId = null, currentTree = null, viewReadOnly = false, painted = false;
    const scroll = root.querySelector('.cv-scroll'), unread = root.querySelector('.cv-unread'), body = root.querySelector('.cv-console-body');
    // The parts read the console's live state through this context.
    const ctx = { root, scroll, idSuffix, get data() { return data; }, get selectedAgentId() { return selectedAgentId; }, get viewReadOnly() { return viewReadOnly; }, get painted() { return painted; }, get destroyed() { return destroyed; }, refresh: () => { if (!destroyed) update(data); }, onViewport: () => renderFollow() };
    const panel = agentPanel(ctx, body);
    const agentNotice = doc.createElement('div'); agentNotice.className = 'cv-agent-notice'; agentNotice.hidden = true; root.insertBefore(agentNotice, body);
    // Pending requests stay docked above the composer in both chat and terminal views; only a dialog the visible terminal already draws leaves the dock.
    const questionDock = doc.createElement('section'); questionDock.className = 'cv-question-dock'; questionDock.hidden = true; questionDock.setAttribute('aria-label', globalThis.AIWSI18n.text('Yanıt bekleyen istekler'));
    root.insertBefore(questionDock, root.querySelector('.cv-history-footer'));
    const activity = activityStrip(ctx, questionDock), panels = insightPanels(ctx, body);
    container.append(root);
    const timeline = runTimeline(ctx, root.querySelector('.cv-timeline')), requests = requestDock(Object.defineProperties({ dock: questionDock, list: root.querySelector('.cv-questions') }, Object.getOwnPropertyDescriptors(ctx))), input = composer(ctx), terminal = nativeTerminal(ctx);
    const childCache = new Map(), childLoading = new Set(), childLoadingShown = holdFlag(ctx.refresh), agentScroll = new Map();
    const nearBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 72;
    body.append(unread);
    const renderFollow = () => { const native = root.classList.contains('cv-native-mode'), atBottom = native ? terminal.viewport.atBottom : following, count = native ? terminal.viewport.changes : changes; unread.hidden = atBottom; unread.textContent = count ? globalThis.AIWSI18n.template`Yeni işlemler (${count}) ↓` : globalThis.AIWSI18n.text('En alta in ↓'); unread.setAttribute('aria-label', count ? globalThis.AIWSI18n.template`${count} yeni işlem. En alta in` : globalThis.AIWSI18n.text('En alta in')); };
    const follow = () => { if (root.classList.contains('cv-native-mode')) terminal.scrollToBottom(); else { following = true; scroll.scrollTop = scroll.scrollHeight; changes = 0; } renderFollow(); };
    scroll.addEventListener('scroll', () => { following = nearBottom(); if (following) changes = 0; renderFollow(); }); unread.addEventListener('click', follow);
    root.addEventListener('click', async event => {
      const button = event.target.closest('button[data-cv-action]'); if (!button) return;
      const action = button.dataset.cvAction;
      if (action === 'agent') {
        // A pick from the needs/failed popover opens the agent exactly like its card, with the card (or the pill) taking focus back later.
        const picked = button.dataset.agentPick, agent = currentTree?.agents.find(item => item.id === (picked ?? button.dataset.agent)); let opener = button;
        if (picked !== undefined) { const trigger = panel.summary.trigger; panel.summary.close(false); panel.unfoldTo(agent); const row = panel.row(picked); opener = row && !row.closest('[hidden],details:not([open])') ? row : trigger || button; }
        if (agent && agent.id !== currentTree.rootId && data.onOpenAgent) { data.onOpenAgent(agent, opener); return; }
        if (picked === undefined && agent?.id === currentTree.rootId && currentTree.agents.length > 1 && !selectedAgentId && !data.inspectedAgentId) { panel.toggleRoot(); return; }
        agentScroll.set(selectedAgentId || 'root', scroll.scrollTop); selectedAgentId = agent?.id === currentTree.rootId ? null : agent?.id || null;
        update(data); scroll.scrollTop = agentScroll.get(selectedAgentId || 'root') || 0;
        if (picked !== undefined) panel.row(picked)?.focus({ preventScroll: true });
        if (selectedAgentId && agent) void loadChild(agent); else if (agent && data.onSelectAgent) Promise.resolve(data.onSelectAgent(agent)).catch(() => {}); return;
      }
      if (action === 'agents-open') { data.onOpenAgents?.(button); return; }
      if (action === 'agent-fold') { panel.toggleFold(button.dataset.agentFold); return; }
      if (action === 'agent-alerts') { panel.summary.toggle(button); return; }
      if (action === 'agent-more' || action === 'agent-retry') { const agent = currentTree?.agents.find(agent => agent.id === selectedAgentId); if (agent) void loadChild(agent, action === 'agent-more'); return; }
      if (action === 'technical') { const enabled = root.classList.toggle('cv-show-technical'); button.setAttribute('aria-pressed', String(enabled)); return; }
      if (action === 'question') { const card = questionDock.querySelector('.cv-question'); card?.scrollIntoView?.({ block: 'nearest' }); card?.querySelector('textarea')?.focus({ preventScroll: true }); return; }
      if (action === 'follow') { follow(); return; }
      if (action === 'float') { global.AIWSUI.floatConsole?.(root, data.title || globalThis.AIWSI18n.text('Agent console')); return; }
      if (action === 'fold') { timeline.toggleStreak(button.dataset.fold); following = false; update(data); return; }
      if (action.startsWith('mode-')) { mode = action.slice(5); if (data.viewMode && data.viewMode !== mode && data.onSetView) { data.onSetView(mode); return; } update(data); return; }
      if (action === 'continue') {
        if (selectedAgentId || !data.onContinue || button.disabled) return; const error = root.querySelector('.cv-history-footer [role=alert]'); button.disabled = true; error.hidden = true;
        try { await data.onContinue(); } catch (problem) { error.textContent = problem?.message || globalThis.AIWSI18n.text('Oturum devam ettirilemedi.'); error.hidden = false; } finally { button.disabled = false; } return;
      }
      if (action === 'terminal') { try { await data.onOpenTerminal?.(button.dataset.run); } catch { button.textContent = globalThis.AIWSI18n.text('Terminal açılamadı'); } return; }
      if (action === 'session-terminal') { button.disabled = true; try { await data.onOpenSessionTerminal?.(button.dataset.run); } finally { button.disabled = false; } return; }
      await timeline.action(button);
    });
    async function loadChild(agent, more = false) {
      const callback = more ? data.onLoadAgentMore : data.onSelectAgent; if (!callback || childLoading.has(agent.id)) return;
      childLoading.add(agent.id); update(data);
      try { const snapshot = await callback(agent, more ? (data.agentTranscripts?.[agent.id] || childCache.get(agent.id))?.nextCursor : undefined); if (snapshot) childCache.set(agent.id, snapshot); }
      catch (error) { childCache.set(agent.id, { ...(childCache.get(agent.id) || {}), error: error?.message || globalThis.AIWSI18n.text('Alt agent geçmişi okunamadı.') }); }
      finally { childLoading.delete(agent.id); if (!destroyed) update(data); }
    }
    function update(next = {}) {
      if (destroyed) return; data = next; const before = scroll.scrollTop;
      const rootGroups = normalize(data); currentTree = inferAgentTree(data, rootGroups);
      if (selectedAgentId) selectedAgentId = currentTree.aliases.get(selectedAgentId) || selectedAgentId;
      const selectedAgent = selectedAgentId && currentTree.agents.find(agent => agent.id === selectedAgentId);
      if (selectedAgentId && !selectedAgent) selectedAgentId = null;
      panel.render(currentTree);
      const childSnapshot = selectedAgent && (data.agentTranscripts?.[selectedAgent.id] || childCache.get(selectedAgent.id) || selectedAgent.aliases?.map(alias => data.agentTranscripts?.[alias] || childCache.get(alias)).find(Boolean));
      let groups;
      if (selectedAgent && childSnapshot && (childSnapshot.events || childSnapshot.messages || childSnapshot.runs)) groups = normalize({ ...childSnapshot, taskId: undefined });
      else if (selectedAgent) groups = rootGroups.map(group => ({ ...group, id: `${group.id}:agent:${selectedAgent.id}`, provider: selectedAgent.provider, status: selectedAgent.status, sessionId: selectedAgent.sessionId, nodes: group.nodes.filter(node => currentTree.aliases.get(node.agentId) === selectedAgent.id || node.agentId === selectedAgent.id) })).filter(group => group.nodes.length);
      else groups = rootGroups.map(group => ({ ...group, nodes: group.nodes.filter(node => !node.agentId) }));
      viewReadOnly = Boolean(data.readOnly || selectedAgent); const displayQuestions = selectedAgent ? childSnapshot?.questions || [] : data.questions || [];
      const childPending = selectedAgent && (childLoading.has(selectedAgent.id) || childSnapshot?.loading), childError = selectedAgent && (childCache.get(selectedAgent.id)?.error || childSnapshot?.error); const childLoadingVisible = childLoadingShown(childPending && !groups.length);
      agentNotice.hidden = !selectedAgent;
      if (selectedAgent) {
        const text = childError || (childLoadingVisible ? globalThis.AIWSI18n.text('Alt agentın gerçek geçmişi yükleniyor…') : globalThis.AIWSI18n.text('Alt agent görünümü · Salt okunur. Ana agenta dönerek talimat verebilirsin.'));
        agentNotice.innerHTML = `<span>${esc(text)}</span>${childError && data.onSelectAgent ? globalThis.AIWSI18n.text('<button type="button" class="cv-text-button" data-cv-action="agent-retry">Yeniden dene</button>') : ''}${childSnapshot?.nextCursor && data.onLoadAgentMore ? globalThis.AIWSI18n.template`<button type="button" class="cv-text-button" data-cv-action="agent-more" ${childPending ? 'disabled' : ''}>Önceki mesajları yükle</button>` : ''}`;
      }
      const chosen = data.terminalRun?.terminalMode === 'pty' ? data.terminalRun : null;
      const activeGroup = (!selectedAgent && groups.find(group => group.id === chosen?.id)) || [...groups].reverse().find(group => group.id !== 'notes') || groups.at(-1);
      const provider = selectedAgent?.provider || activeGroup?.provider || data.provider || 'Agent', snapshot = activeGroup?.executionSnapshot, model = selectedAgent?.model || activeGroup?.model || snapshot?.model || snapshot?.agent?.model;
      const toolbar = `${providerBox(provider, data.providerIcons?.[provider])}<div class="cv-console-heading"><strong>${esc(selectedAgent?.name || data.title || snapshot?.agent?.name || (globalThis.AIWSProviderNames || {})[provider] || provider)}</strong><span>${model ? `${esc(model)} · ` : ''}${esc(selectedAgent ? globalThis.AIWSI18n.template`${statusLabel(selectedAgent.status)} · Salt okunur kayıt` : data.readOnly ? globalThis.AIWSI18n.text('Geçmiş kaydı · Salt okunur') : `${data.viewMode==='history'?globalThis.AIWSI18n.text('Sohbet'):chosen?globalThis.AIWSI18n.text('Gerçek CLI'):globalThis.AIWSI18n.text('Akış kaydı')} · ${statusLabel(activeGroup?.status) || globalThis.AIWSI18n.text('Görev konuşması')}`)}</span></div>${activeGroup?.sessionId ? `<code class="cv-toolbar-session ui-chip is-mono" title="${esc(activeGroup.sessionId)}">${esc(activeGroup.sessionId.slice(0, 8))}</code>` : ''}${data.onOpenSessionTerminal && !selectedAgent && activeGroup?.sessionId && !['history', 'running', 'waiting', 'paused'].includes(activeGroup.status) ? `<button type="button" class="button small" data-cv-action="session-terminal" data-run="${esc(activeGroup.id)}" title="${esc(globalThis.AIWSI18n.text('Görevi sürdürmeden bu oturumu proje terminalinde açar'))}">${esc(globalThis.AIWSI18n.text('Terminalde aç ↗'))}</button>` : ''}`;
      if (toolbarSignature !== toolbar) { root.querySelector('.cv-console-context').innerHTML = toolbar; toolbarSignature = toolbar; }
      root.dataset.readOnly = String(viewReadOnly); root.querySelector('.cv-console-context').title = data.workspace || activeGroup?.sessionId || '';
      const modeButtons = root.querySelector('.cv-console-modes');
      if (terminal.mount(chosen)) mode = chosen ? 'terminal' : 'history';
      if (data.viewMode === 'history' || data.viewMode === 'terminal') mode = data.viewMode;
      if (chosen) terminal.update(chosen, !selectedAgent && mode === 'terminal');
      terminal.pane.hidden = Boolean(selectedAgent || !chosen || mode !== 'terminal'); scroll.hidden = Boolean(!selectedAgent && chosen && mode === 'terminal'); modeButtons.hidden = Boolean(data.viewMode || selectedAgent || !chosen);
      for (const [action, pressed] of [['mode-terminal', Boolean(chosen && mode === 'terminal')], ['mode-history', !chosen || mode === 'history']]) { const tab = root.querySelector(`[data-cv-action=${action}]`); tab.setAttribute('aria-pressed', String(pressed)); tab.classList.toggle('active', pressed); }
      const terminalRunId = !selectedAgent && chosen && mode === 'terminal' ? chosen.id : null;
      if (chosen) {
        const waitingQuestions = !selectedAgent && (data.questions || []).filter(question => question.status === 'pending' && (!data.taskId || question.taskId === data.taskId) && !onTerminalScreen(question, terminalRunId)).length;
        terminal.notice.innerHTML = `<span>${esc(['running', 'waiting'].includes(chosen.status) ? globalThis.AIWSI18n.text('Gerçek CLI oturumu · Terminale tıklayarak doğrudan yazabilirsin.') : globalThis.AIWSI18n.template`${statusLabel(chosen.status)} · Terminal geçmişi`)}</span>${waitingQuestions ? globalThis.AIWSI18n.template`<button type="button" data-cv-action="question">Agent soru sordu (${waitingQuestions}) · Yanıtla →</button>` : ''}`;
      }
      root.classList.toggle('cv-native-mode', Boolean(terminalRunId));
      timeline.render(groups, currentTree);
      activity.render(selectedAgent ? null : activeGroup, Boolean(terminalRunId)); panels.render(selectedAgent ? [] : groups, Boolean(terminalRunId));
      const answering = requests.render(displayQuestions, timeline.exchanges(), terminalRunId);
      timeline.empty(groups, selectedAgent, childLoadingVisible, childError);
      input.render({ chosen, mode, answering });
      const historyFooter = root.querySelector('.cv-history-footer'); historyFooter.hidden = Boolean(!data.readOnly || selectedAgent || data.hideHistoryFooter);
      historyFooter.querySelector('button').hidden = !data.onContinue;
      const currentActivity = timeline.activity(); for (const [key, signature] of requests.signatures()) currentActivity.set(key, signature);
      let changed = 0; if (activityInitialized) for (const [key, signature] of currentActivity) if (activitySignatures.get(key) !== signature) changed++; activitySignatures = currentActivity; activityInitialized = true;
      if (following) { scroll.scrollTop = scroll.scrollHeight; changes = 0; } else { scroll.scrollTop = before; changes += changed; } renderFollow(); painted = true;
    }
    update(initial);
    return { element: root, update, destroy() { destroyed = true; activity.destroy(); global.AIWSUI.closeFloatingConsole?.(root); panel.destroy(); childLoadingShown.cancel(); terminal.destroy(); timeline.clear(); root.remove(); } };
  }
  global.AIWSAgentConsole = Object.freeze({ create, agentFlow: kit.agentFlow, normalize, inferAgentTree, workflowTree: kit.workflowTree, markdown: kit.markdown, holdFlag, statusLabel, approvalAnswer: kit.approvalAnswer, providerBox });
  global.AIWSConversation = global.AIWSAgentConsole;
})(globalThis);
