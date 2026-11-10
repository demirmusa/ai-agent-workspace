/* The Agents header both the console's agent panel and the hierarchy canvas wear, and its needs/failed popover. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, providerBox, agentName, agentSub, statusLabel, agentElapsed } = kit;
  /** The Agents header shared by the console's agent panel and the hierarchy canvas: title, subagent and running counts, the needs and
   *  failed pills that open a popover of those agents, the main agent's elapsed time and an optional trailing control. */
  function agentHeaderHtml(extra = '', title = true) {
    const chevron = global.AIWSUI.icon('chevron'), pill = tone => `<button type="button" class="cv-agent-alert" data-tone="${tone}" data-cv-action="agent-alerts" aria-haspopup="menu" aria-expanded="false" hidden><span></span>${chevron}</button>`;
    return `<header class="cv-agent-header">${title ? `<span class="cv-agent-title">${global.AIWSUI.sparkle('accent')}<strong>${esc(globalThis.AIWSI18n.text('Agentlar'))}</strong></span>` : ''}<span class="cv-agent-summary"><span class="cv-agent-count"></span><span class="cv-agent-running" data-tone="running" hidden></span>${pill('needs')}${pill('failed')}<time class="cv-agent-total" title="${esc(globalThis.AIWSI18n.text('Ana agentın çalışma süresi'))}" hidden></time>${extra}</span></header><div class="cv-agent-menu popup-menu" role="menu" hidden></div>`;
  }
  /** Paints an agentHeaderHtml header from a tree and owns its popover: choosing an agent there is a `data-cv-action=agent` button
   *  carrying `data-agent-pick`, which the owner handles like a card click. */
  function agentSummary(panel) {
    const doc = panel.ownerDocument, menu = panel.querySelector('.cv-agent-menu'), pills = { needs: panel.querySelector('.cv-agent-alert[data-tone=needs]'), failed: panel.querySelector('.cv-agent-alert[data-tone=failed]') };
    let open = null, html = '', tree = null;
    const outside = event => { if (open && !menu.contains(event.target) && !open.trigger.contains(event.target)) close(false); };
    function render() {
      const agents = tree.agents.filter(agent => agent.id !== tree.rootId && !agent.kind && global.AIWSUI.tone(agent.status) === open.tone); if (!agents.length) { close(false); return; }
      const next = `<p class="cv-agent-menu-title">${esc(globalThis.AIWSI18n.text(open.tone === 'failed' ? 'Başarısız alt agentlar' : 'Seni bekleyen alt agentlar'))}</p>${agents.map(agent => `<button type="button" role="menuitem" class="cv-agent-menu-item" data-cv-action="agent" data-agent-pick="${esc(agent.id)}">${providerBox(agent.provider)}<span class="cv-agent-name"><strong>${esc(agentName(agent, false))}</strong><small>${esc(agentSub(agent, false, 0))}</small></span>${global.AIWSUI.statusPill(agent.status, statusLabel(agent.status))}<time>${esc(agentElapsed(agent))}</time></button>`).join('')}`;
      if (html === next) return; const focused = doc.activeElement?.closest?.('.cv-agent-menu-item')?.dataset.agentPick; menu.innerHTML = next; html = next;
      if (focused !== undefined) [...menu.querySelectorAll('.cv-agent-menu-item')].find(item => item.dataset.agentPick === focused)?.focus({ preventScroll: true });
    }
    function show(trigger) {
      close(false); open = { trigger, tone: trigger.dataset.tone }; trigger.setAttribute('aria-expanded', 'true'); render();
      if (!open) return; menu.hidden = false; doc.addEventListener('pointerdown', outside, true); menu.querySelector('[role=menuitem]')?.focus({ preventScroll: true });
    }
    function close(restore) {
      if (!open) return; const { trigger } = open; open = null; html = ''; trigger.setAttribute('aria-expanded', 'false');
      menu.hidden = true; menu.replaceChildren(); doc.removeEventListener('pointerdown', outside, true); if (restore && !trigger.hidden) trigger.focus({ preventScroll: true });
    }
    // Counts crossfade when they change; the first paint just shows them.
    function paint(next, animate) {
      tree = next; const children = tree.agents.filter(agent => agent.id !== tree.rootId && !agent.kind), count = tone => children.filter(agent => global.AIWSUI.tone(agent.status) === tone).length, running = count('running');
      const swap = (element, text) => { if (animate) global.AIWSUI.motion.swapText(element, text); else element.textContent = text; }, show = (element, text) => { element.hidden = !text; swap(element, text); };
      show(panel.querySelector('.cv-agent-count'), children.length ? globalThis.AIWSI18n.template`${children.length} alt agent` : ''); show(panel.querySelector('.cv-agent-running'), running ? globalThis.AIWSI18n.template`${running} çalışıyor` : '');
      for (const [tone, label] of [['needs', value => globalThis.AIWSI18n.template`${value} seni bekliyor`], ['failed', value => globalThis.AIWSI18n.template`${value} başarısız`]]) { const value = count(tone); pills[tone].hidden = !value; if (value) swap(pills[tone].firstElementChild, label(value)); }
      tick(); if (open) render();
    }
    function tick() { const root = tree?.agents.find(agent => agent.id === tree.rootId), total = panel.querySelector('.cv-agent-total'), elapsed = root ? agentElapsed(root) : ''; if (total.textContent !== elapsed) total.textContent = elapsed; total.hidden = !elapsed; }
    /** Escape closes the popover and arrows move inside it; returns whether the key was the popover's. */
    function keydown(event) {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return true; }
      if (!event.target.closest?.('.cv-agent-menu')) return false;
      if (event.key === 'Tab') close(false); else global.AIWSUI.menuNavigate(event, menu); return true;
    }
    return { paint, tick, close, keydown, toggle: trigger => open?.trigger === trigger ? close(true) : show(trigger), get trigger() { return open?.trigger; } };
  }
  Object.assign(kit, { agentHeaderHtml, agentSummary });
})(globalThis);
