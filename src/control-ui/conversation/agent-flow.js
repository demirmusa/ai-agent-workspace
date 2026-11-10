/* The agent hierarchy canvas (AIWSAgentConsole.agentFlow): the Agents header over a pannable, zoomable tree of agent cards. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, setAttr, providerBox, agentInfoHtml, agentHeaderHtml, agentSummary, inferAgentTree, agentName, agentElapsed, liveAgent, statusLabel } = kit;
  /** The agent hierarchy as a tree canvas read left to right: the main agent on the left, its subagents in a column to its right and
   *  theirs further right, joined by connectors that grow in as the cards rise one level after another. A card shows the agent, its model, status, latest
   *  step and time, and folds its subtree; a subagent card (or a pick from the needs/failed popover) opens it through onOpenAgent.
   *  The wheel zooms, dragging empty canvas pans and a double click fits the tree again. */
  function agentFlow(container, initial = {}) {
    const doc = container.ownerDocument, element = doc.createElement('div'); element.className = 'cv-agent-flow';
    element.innerHTML = `${agentHeaderHtml('', initial.title !== false)}<div class="cv-agent-flow-stage ui-canvas"><div class="flow-list cv-agent-flow-list" role="list" aria-label="${esc(globalThis.AIWSI18n.text('Agent ve alt agentlar'))}"><svg class="flow-links" aria-hidden="true"></svg><svg class="flow-ports" aria-hidden="true"></svg></div></div>`;
    container.append(element);
    const stage = element.querySelector('.cv-agent-flow-stage'), list = stage.firstElementChild, summary = agentSummary(element), nodes = new Map(), folded = new Set(), lines = { links: new Map(), ports: new Map(), settle: false };
    let data = initial, tree = null, layout = null, layoutKey = '', frame = 0, painted = false, free = true, destroyed = false;
    const nodeOf = key => nodes.get(key)?.node;
    // Card heights follow their text; a size change places the tree again and the connectors glide along.
    const relayout = () => { frame = 0; if (!layout || destroyed) return; lines.settle = global.AIWSUI.placeFlow(list, layout, nodeOf) && painted; global.AIWSUI.drawFlowLinks(list, layout, nodeOf, lines); if (free) fit(false); };
    const schedule = () => { if (frame || destroyed) return; if (typeof global.requestAnimationFrame !== 'function') { relayout(); return; } frame = global.requestAnimationFrame(relayout); };
    const resize = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver(schedule) : null; resize?.observe(stage);
    const camera = global.AIWSUI.panZoom(stage, { min: 0.3, max: 1.6, canPan: event => !event.target.closest('.cv-flow-node'), onUser: () => { free = false; },
      point: event => { const box = stage.getBoundingClientRect(); return [event.clientX - box.left - list.offsetLeft, event.clientY - box.top - list.offsetTop]; },
      apply: ({ x, y, scale }) => { list.style.transform = `translate(${x}px,${y}px) scale(${scale})`; stage.style.backgroundPosition = `${list.offsetLeft + x}px ${list.offsetTop + y}px`; stage.style.backgroundSize = `${18 * scale}px ${18 * scale}px`; } });
    /** Fits the whole tree into the stage without enlarging past 100%, centred; fitting hands the view back to following the tree.
     *  A placed tree is read from its layout: the list's own box may still be mid-transition. */
    function fit(ease) {
      free = true; const width = layout?.flow ? layout.width : list.offsetWidth, height = layout?.flow ? layout.height : list.offsetHeight, room = stage.clientWidth - 32; if (!width || room <= 0) return;
      const scale = Math.max(0.3, Math.min(1, room / width, height ? (stage.clientHeight - 36) / height : 1)), view = { scale, x: stage.clientWidth / 2 - list.offsetLeft - scale * width / 2, y: Math.max(18, (stage.clientHeight - scale * height) / 2) - list.offsetTop };
      if (ease && !global.AIWSUI.reducedMotion()) { list.classList.add('is-easing'); setTimeout(() => list.classList.remove('is-easing'), 460); }
      camera.set(view);
    }
    stage.addEventListener('dblclick', event => { if (!event.target.closest('.cv-flow-node')) fit(true); });
    element.addEventListener('click', event => {
      const button = event.target.closest?.('button[data-cv-action]'); if (!button) return;
      if (button.dataset.cvAction === 'agent-alerts') { summary.toggle(button); return; }
      if (button.dataset.cvAction === 'agent-fold') { const id = button.dataset.agentFold; if (!folded.delete(id)) folded.add(id); update(data); return; }
      const picked = button.dataset.agentPick, agent = tree?.agents.find(item => item.id === (picked ?? button.dataset.agent)); if (!agent) return;
      if (picked !== undefined) { summary.close(false); for (let hop = agent, hops = 0; hop && hops < 64; hops++) { folded.delete(hop.parentId); hop = tree.agents.find(item => item.id === hop.parentId); } update(data); }
      data.onOpenAgent?.(agent, nodes.get(agent.id)?.card || button);
    });
    element.addEventListener('keydown', event => { summary.keydown(event); });
    function paint(entry, agent, isRoot, own) {
      const status = agent.status || 'unknown', name = agentName(agent, isRoot), sub = [agent.role, agent.model].filter(Boolean).join(' · ') || (isRoot ? globalThis.AIWSI18n.text('Ana agent') : (globalThis.AIWSProviderNames || {})[agent.provider] || agent.provider || '');
      const detail = agentInfoHtml(agent), info = detail ? `<span class="cv-agent-activity">${detail}</span>` : `<span class="cv-flow-idle">${esc(isRoot ? globalThis.AIWSI18n.template`${own} alt agent yönetiyor` : liveAgent.includes(status) ? globalThis.AIWSI18n.text('Başlıyor…') : globalThis.AIWSI18n.text('Adım kaydı yok'))}</span>`;
      const html = `<span class="cv-flow-head">${providerBox(agent.provider)}<span class="cv-agent-name"><strong title="${esc(name)}">${esc(name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="cv-flow-state"></span></span><span class="cv-flow-info">${info}</span><span class="cv-flow-foot"><time></time></span>`;
      if (entry.html !== html) { entry.card.innerHTML = html; entry.html = html; entry.time = entry.card.querySelector('time'); entry.status = undefined; }
      // Only a real status change replaces the pill, crossfading it, and rings the card once; ticking time leaves a running spinner alone.
      if (entry.status !== status) {
        const state = entry.card.querySelector('.cv-flow-state'), changed = entry.status !== undefined && !global.AIWSUI.reducedMotion(); state.innerHTML = global.AIWSUI.statusPill(status, statusLabel(status)); state.classList.toggle('cv-swap', changed);
        if (changed) entry.card.animate?.([{ boxShadow: '0 0 0 0 color-mix(in srgb, var(--accent) 40%, transparent)' }, { boxShadow: '0 0 0 6px transparent' }], { duration: 900, easing: 'ease-out' });
        entry.status = status;
      }
      entry.agent = agent; const elapsed = agentElapsed(agent); if (entry.time.textContent !== elapsed) entry.time.textContent = elapsed;
      setAttr(entry.card, 'data-status', status); setAttr(entry.node, 'data-tone', global.AIWSUI.tone(status));
      if (!own) { entry.toggle?.remove(); entry.toggle = null; return; }
      if (!entry.toggle) { const toggle = entry.toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'cv-flow-toggle'; toggle.dataset.cvAction = 'agent-fold'; toggle.dataset.agentFold = agent.id; entry.node.prepend(toggle); }
      const closed = folded.has(agent.id), label = `<span>${closed ? '+' : ''}${own}</span>${global.AIWSUI.icon('chevron')}`; if (entry.toggle.innerHTML !== label) entry.toggle.innerHTML = label;
      setAttr(entry.toggle, 'aria-expanded', String(!closed)); setAttr(entry.toggle, 'aria-label', globalThis.AIWSI18n.text(closed ? 'Alt agentları göster' : 'Alt agentları gizle'));
    }
    function update(next = {}) {
      if (destroyed) return; data = next; tree = inferAgentTree(data);
      const byParent = new Map(), order = [], seen = new Set(), rootId = tree.rootId;
      for (const agent of tree.agents) if (agent.id !== rootId) { const siblings = byParent.get(agent.parentId); if (siblings) siblings.push(agent); else byParent.set(agent.parentId, [agent]); }
      // Depth first, so a subtree stays together; a folded card keeps its children out of the canvas.
      const walk = (agent, shown) => { if (!agent || seen.has(agent.id)) return; seen.add(agent.id); if (shown) order.push(agent); for (const child of byParent.get(agent.id) || []) walk(child, shown && !folded.has(agent.id)); };
      walk(tree.agents.find(agent => agent.id === rootId), true); for (const agent of tree.agents) walk(agent, true);
      for (const id of folded) if (!seen.has(id)) folded.delete(id);
      summary.paint(tree, painted);
      const nextLayout = global.AIWSUI.flowLayout(order, agent => agent.id, agent => agent.id === rootId ? [] : [agent.parentId], 0, true), key = [...folded, '|', ...nextLayout.keys].join(','), visible = new Set(order.map(agent => agent.id));
      const apply = () => {
        let cursor = list.firstElementChild.nextSibling;
        for (const agent of nextLayout.order) {
          let entry = nodes.get(agent.id); const isRoot = agent.id === rootId;
          if (!entry) {
            const node = doc.createElement('article'), fixed = isRoot || agent.kind === 'phase', card = doc.createElement(fixed ? 'div' : 'button'); node.className = 'cv-flow-node'; node.dataset.agentNode = agent.id; node.setAttribute('role', 'listitem');
            card.className = `cv-flow-card ui-card${isRoot ? ' cv-flow-root' : fixed ? '' : ' is-interactive'}`; if (!fixed) { card.type = 'button'; card.dataset.cvAction = 'agent'; card.dataset.agent = agent.id; card.title = globalThis.AIWSI18n.text(agent.kind === 'workflow' ? "Workflow'u aç" : 'Alt agentın kaydını aç'); }
            node.append(card); entry = { node, card, html: '' }; nodes.set(agent.id, entry); resize?.observe(node);
          }
          paint(entry, agent, isRoot, (byParent.get(agent.id) || []).length);
          if (entry.node === cursor) cursor = cursor.nextSibling; else list.insertBefore(entry.node, cursor);
        }
        // A card that leaves (its parent folded, or the agent is gone) fades where it stood while the rest glide.
        for (const [id, entry] of nodes) if (!visible.has(id)) {
          resize?.unobserve(entry.node); nodes.delete(id);
          if (painted && !global.AIWSUI.reducedMotion() && entry.node.animate) { entry.node.classList.add('is-leaving'); entry.node.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px) scale(.97)' }], { duration: 200, easing: 'ease-in' }).onfinish = () => entry.node.remove(); } else entry.node.remove();
        }
        layout = nextLayout; global.AIWSUI.placeFlow(list, layout, nodeOf);
      };
      if (key === layoutKey) { apply(); global.AIWSUI.drawFlowLinks(list, layout, nodeOf, lines); }
      else {
        // The tree builds itself left to right on first sight: a card rises once the connector from its parent has mostly grown.
        const known = new Set(nodes.keys()), delays = global.AIWSUI.flowDelays(nextLayout, id => !known.has(id));
        lines.settle = painted && !global.AIWSUI.reducedMotion(); layoutKey = key;
        global.AIWSUI.motion.flip(list, '[data-agent-node]:not(.is-leaving)', 'data-agent-node', apply, { delays });
        global.AIWSUI.drawFlowLinks(list, layout, nodeOf, lines); if (free) fit(painted);
      }
      painted = true; ticking();
    }
    // Live agents count their time every second without re-rendering anything else.
    let timer = 0;
    function ticking() {
      const live = tree?.agents.some(agent => liveAgent.includes(agent.status) && !agent.elapsedMs); if (live === Boolean(timer)) return;
      if (live) timer = setInterval(() => { for (const entry of nodes.values()) { const elapsed = agentElapsed(entry.agent); if (entry.time && entry.time.textContent !== elapsed) entry.time.textContent = elapsed; } summary.tick(); }, 1000); else { clearInterval(timer); timer = 0; }
    }
    update(initial);
    return { element, update, destroy() { destroyed = true; clearInterval(timer); summary.close(false); resize?.disconnect(); if (frame) global.cancelAnimationFrame?.(frame); element.remove(); } };
  }
  Object.assign(kit, { agentFlow });
})(globalThis);
