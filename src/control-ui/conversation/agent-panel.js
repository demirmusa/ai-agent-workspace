/* The console's agent panel: the Agents header and every agent as a keyed, persistent card in one flat list per group (the live tree
 * and the finished group). Subtrees fold, the main agent's row folds them all, and arrow keys move between visible cards. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, holdFlag, enterOnce, setAttr, setProp, providerBox, agentInfoHtml, agentHeaderHtml, agentSummary, agentName, agentSub, agentElapsed, statusLabel, endedAgent } = kit;
  /** Builds the panel before `before` in ctx.root. `ctx` gives the live data, selectedAgentId and painted of its console and refresh(). */
  function agentPanel(ctx, before) {
    const doc = ctx.root.ownerDocument, agentPanel = doc.createElement('section'); agentPanel.className = 'cv-agent-panel'; agentPanel.setAttribute('aria-label', globalThis.AIWSI18n.text('Agent ve alt agentlar'));
    // The tree's chrome is built once; renderAgents only moves keyed cards and updates their text.
    const chevron = global.AIWSUI.icon('chevron');
    agentPanel.innerHTML = `${agentHeaderHtml(`<button type="button" class="button small ghost cv-agent-open" data-cv-action="agents-open" hidden>${esc(globalThis.AIWSI18n.text('Hiyerarşi'))}${chevron}</button>`)}<div class="cv-agent-scroll"><div class="cv-agent-list cv-agent-tree"></div><details class="cv-finished-agents"><summary>${chevron}<span></span></summary><div class="cv-agent-finished cv-agent-tree"></div></details><p class="cv-agent-source"></p></div>`;
    ctx.root.insertBefore(agentPanel, before);
    const agentScrollArea = agentPanel.querySelector('.cv-agent-scroll'), activeList = agentPanel.querySelector('.cv-agent-list'), finished = agentPanel.querySelector('.cv-finished-agents'), finishedList = agentPanel.querySelector('.cv-agent-finished'), summary = agentSummary(agentPanel);
    const agentNodes = new Map(), foldedAgents = new Set(), sourceLoadingShown = holdFlag(() => ctx.refresh());
    let current = null, agentsExpanded = false, agentsRendered = false, agentLayout = '';
    // Agent tree: every agent is a keyed, persistent card in one flat list per group (the live tree and the finished group). A card
    // draws its own elbow, the rails of ancestors that continue past it (--g1…--g4) and its branch circle, so connectors stay right
    // at any depth and glide with the card when the list is reordered.
    // Rendered cards only: hidden ones, closed groups and empty lists would measure as zero boxes.
    const visibleAgents = '.cv-agent-list:not([hidden])>.cv-agent-node:not([hidden]),.cv-finished-agents[open]:not([hidden])>.cv-agent-finished>.cv-agent-node:not([hidden])';
    function renderAgents(tree) {
      current = tree;
      const children = tree.agents.filter(agent => agent.id !== tree.rootId), root = tree.agents.find(agent => agent.id === tree.rootId), byParent = new Map(), under = new Map(), placed = new Map(), order = [];
      for (const agent of children) { const list = byParent.get(agent.parentId); if (list) list.push(agent); else byParent.set(agent.parentId, [agent]); }
      // Each agent is placed once, depth first in tree order; agents a parent cycle keeps out of the walk hang under the root.
      const place = (agent, parent) => { if (placed.has(agent.id)) return; placed.set(agent.id, parent); order.push(agent); if (parent !== null) { const list = under.get(parent); if (list) list.push(agent); else under.set(parent, [agent]); } for (const child of byParent.get(agent.id) || []) place(child, agent.id); };
      if (root) place(root, null); for (const agent of children) place(agent, tree.rootId);
      const inspected = ctx.data.inspectedAgentId || ctx.selectedAgentId, expanded = agentsExpanded || Boolean(inspected && inspected !== tree.rootId), collapsed = Boolean(children.length) && !expanded;
      // An agent joins the finished group once it and everything below it have ended, unless it is the one being inspected.
      const settled = new Set();
      for (let index = order.length - 1; index >= 0; index--) { const agent = order[index]; if (agent.id !== tree.rootId && agent.id !== inspected && endedAgent.includes(agent.status) && (under.get(agent.id) || []).every(child => settled.has(child.id))) settled.add(agent.id); }
      const rows = [], walk = (agent, finishedGroup, depth, rails, more, visible) => {
        const own = (under.get(agent.id) || []).filter(child => finishedGroup || !settled.has(child.id)), folded = agent.id === tree.rootId ? collapsed : foldedAgents.has(agent.id);
        rows.push({ agent, finishedGroup, depth, levels: depth ? [...rails, more] : [], own: own.length, folded, visible, branch: visible && !folded && own.length > 0 });
        own.forEach((child, index) => walk(child, finishedGroup, depth + 1, depth ? [...rails, more] : [], index < own.length - 1, visible && !folded));
      };
      if (root) walk(root, false, 0, [], false, true);
      for (const agent of order) if (settled.has(agent.id) && !settled.has(placed.get(agent.id))) walk(agent, true, 0, [], false, !collapsed);
      const finishedCount = settled.size;
      const source = ctx.data.agentSource, sourceText = source?.error || (sourceLoadingShown(source?.loading && !children.length) ? globalThis.AIWSI18n.text('Agent kaynakları okunuyor…') : ''), sourceNotice = agentPanel.querySelector('.cv-agent-source');
      agentPanel.classList.toggle('cv-agent-empty', !children.length); agentPanel.classList.toggle('cv-agents-collapsed', collapsed); agentPanel.classList.toggle('cv-agent-source-issue', Boolean(source?.error));
      // The task console keeps only the summary; the hierarchy opens in its own side panel.
      agentPanel.classList.toggle('cv-agent-compact', Boolean(ctx.data.onOpenAgents)); agentPanel.querySelector('.cv-agent-open').hidden = !ctx.data.onOpenAgents;
      sourceNotice.textContent = sourceText; sourceNotice.hidden = !sourceText;
      const panelHidden = agentPanel.hidden; agentPanel.hidden = !children.length && !sourceText; if (ctx.painted && panelHidden && !agentPanel.hidden) enterOnce(agentPanel);
      summary.paint(tree, agentsRendered);
      const layout = rows.map(row => `${row.agent.id}${row.finishedGroup ? '~' : ':'}${row.visible ? 1 : 0}`).join(','), appearing = [], alive = new Set();
      const apply = () => {
        activeList.hidden = !children.length; finished.hidden = !finishedCount || collapsed; finished.querySelector('summary>span').textContent = globalThis.AIWSI18n.template`Biten alt agentlar (${finishedCount})`;
        let lastActive = null, lastFinished = null;
        for (const row of rows) {
          const { agent } = row; let entry = agentNodes.get(agent.id); const created = !entry; alive.add(agent.id);
          if (!entry) { const node = doc.createElement('div'), button = doc.createElement('button'); node.className = 'cv-agent-node'; node.dataset.agentNode = agent.id; button.type = 'button'; button.className = 'cv-agent-row cv-agent-card ui-card is-interactive'; button.dataset.cvAction = 'agent'; button.dataset.agent = agent.id; node.append(button); entry = { node, row: button }; agentNodes.set(agent.id, entry); }
          const host = row.finishedGroup ? finishedList : activeList, previous = row.finishedGroup ? lastFinished : lastActive, expected = previous ? previous.nextSibling : host.firstChild;
          const shown = !created && !entry.node.hidden && !(entry.node.parentNode === finishedList && !finished.open);
          if (expected !== entry.node) host.insertBefore(entry.node, expected);
          if (row.finishedGroup) lastFinished = entry.node; else lastActive = entry.node;
          entry.node.hidden = !row.visible;
          if (agentsRendered && row.visible && !shown && !(row.finishedGroup && !finished.open)) appearing.push(entry.node);
          paintAgent(entry, row, agent.id === tree.rootId, children.length, inspected);
        }
        for (const [id, entry] of agentNodes) if (!alive.has(id)) { entry.node.remove(); agentNodes.delete(id); }
        for (const id of foldedAgents) if (!alive.has(id)) foldedAgents.delete(id);
      };
      // Cards glide to their new place when the tree changes shape; the first render and text-only updates skip measuring.
      // The glide's own entrance is pointed at a class every card already has: new cards enter below, never on the first load.
      if (agentsRendered && layout !== agentLayout) global.AIWSUI.motion.flip(agentScrollArea, visibleAgents, 'data-agent-node', apply, { className: 'cv-agent-node' }); else apply();
      agentLayout = layout; appearing.forEach((node, index) => enterOnce(node, Math.min(index, 8) * 36)); agentsRendered = true;
    }
    function paintAgent(entry, { agent, depth, levels, own, folded, branch }, isRoot, total, inspected) {
      const { row } = entry, name = agentName(agent, isRoot), status = agent.status || 'unknown';
      const shape = `${depth ? `<span class="cv-agent-branch" aria-hidden="true">${agent.parentKnown === false ? '?' : ''}</span>` : ''}<span class="cv-agent-dot" aria-hidden="true"></span>${providerBox(agent.provider)}<span class="cv-agent-name"><strong title="${esc(name)}">${esc(name)}</strong><small>${esc(agentSub(agent, isRoot, total))}</small></span><span class="cv-agent-state"></span><span class="cv-agent-meta"><time class="cv-agent-time"></time>${isRoot && total ? `<span class="cv-agent-fold" aria-hidden="true">${total}${global.AIWSUI.icon('chevron')}</span>` : ''}</span>${isRoot ? '' : '<span class="cv-agent-activity" hidden></span>'}`;
      if (entry.shape !== shape) { row.innerHTML = shape; entry.shape = shape; entry.state = row.querySelector('.cv-agent-state'); entry.time = row.querySelector('.cv-agent-time'); entry.activity = row.querySelector('.cv-agent-activity'); entry.activityHtml = ''; entry.status = undefined; }
      const activity = isRoot ? '' : agentInfoHtml(agent); if (entry.activity && entry.activityHtml !== activity) { entry.activity.innerHTML = activity; entry.activity.hidden = !activity; entry.activityHtml = activity; }
      // Only a real status change replaces the pill (and crossfades it); ticking time leaves a running spinner untouched.
      if (entry.status !== status) { const state = doc.createElement('span'); state.className = entry.status !== undefined && !global.AIWSUI.reducedMotion() ? 'cv-agent-state cv-swap' : 'cv-agent-state'; state.innerHTML = global.AIWSUI.statusPill(status, statusLabel(status)); entry.state.replaceWith(state); entry.state = state; entry.status = status; }
      const elapsed = agentElapsed(agent); if (entry.time.textContent !== elapsed) entry.time.textContent = elapsed;
      setAttr(row, 'aria-pressed', String(inspected ? agent.id === inspected : isRoot)); setAttr(row, 'data-status', status); setAttr(row, 'data-parent-known', String(isRoot || agent.parentKnown !== false)); row.classList.toggle('cv-agent-root', isRoot);
      setAttr(row, 'aria-expanded', isRoot && total ? String(!folded) : null); setAttr(row, 'data-branch', branch ? '' : null); setAttr(row, 'data-children', !isRoot && own ? String(own) : null);
      setProp(row, '--agent-depth', depth); for (let level = 1; level <= 4; level++) setProp(row, `--g${level}`, (level < 4 ? levels[level - 1] : levels.slice(3).some(Boolean)) ? 1 : null);
      if (isRoot || !own) { entry.toggle?.remove(); entry.toggle = entry.toggleHtml = null; return; }
      if (!entry.toggle) { const toggle = entry.toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'cv-agent-toggle'; toggle.dataset.cvAction = 'agent-fold'; toggle.dataset.agentFold = agent.id; entry.node.append(toggle); }
      const label = `<span>${folded ? '+' : ''}${own}</span>${global.AIWSUI.icon('chevron')}`; if (entry.toggleHtml !== label) { entry.toggle.innerHTML = label; entry.toggleHtml = label; }
      setAttr(entry.toggle, 'aria-expanded', String(!folded)); setAttr(entry.toggle, 'aria-label', globalThis.AIWSI18n.text(folded ? 'Alt agentları göster' : 'Alt agentları gizle'));
    }
    function foldAgent(id, fold) {
      if (id === current?.rootId) { if (ctx.selectedAgentId || ctx.data.inspectedAgentId || current.agents.length < 2 || agentsExpanded !== fold) return; agentsExpanded = !fold; }
      else if (!agentNodes.get(id)?.toggle || foldedAgents.has(id) === fold) return; else if (fold) foldedAgents.add(id); else foldedAgents.delete(id);
      renderAgents(current);
    }
    // Opening an agent from the popover unfolds the subtrees that hide its card.
    function unfoldTo(agent) { for (let hops = 0; agent && hops < 64; hops++) { foldedAgents.delete(agent.parentId); agent = current.agents.find(item => item.id === agent.parentId); } }
    // Arrow keys move between visible cards (and popover items); Left and Right fold or unfold a card's subtree.
    agentPanel.addEventListener('keydown', event => {
      if (summary.keydown(event) || !event.target.matches?.('.cv-agent-row')) return;
      if (global.AIWSUI.menuNavigate(event, agentPanel, [...agentPanel.querySelectorAll('.cv-agent-row')].filter(row => !row.closest('[hidden],details:not([open])')))) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); foldAgent(event.target.dataset.agent, event.key === 'ArrowLeft'); }
    });
    /** The main agent's row opens or closes the whole tree. */
    function toggleRoot() { agentsExpanded = !agentsExpanded; renderAgents(current); }
    return { element: agentPanel, summary, render: renderAgents, toggleFold: id => foldAgent(id, !foldedAgents.has(id)), unfoldTo, toggleRoot, row: id => agentNodes.get(id)?.row, destroy() { summary.close(false); sourceLoadingShown.cancel(); } };
  }
  Object.assign(kit, { agentPanel });
})(globalThis);
