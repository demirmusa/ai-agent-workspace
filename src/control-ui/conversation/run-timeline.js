/* The console timeline: one section per run (agent, model, status, token use and session) holding its keyed node cards in order.
 * Unchanged nodes keep their elements, open tool panels and selection; long tool streaks fold behind one row, long messages fold
 * until opened, and live additions rise in. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, clock, enterOnce, stripAnsi, providerBox, statusLabel, renderNode, toolFolds, markdown, viewRevision, toolView } = kit;
  /** A run's work in one line: tool calls, changed files and test runs. */
  function runDigest(nodes) {
    const tools = nodes.filter(node => ['tool', 'files'].includes(node.kind) && !node.agentId); if (!tools.length) return '';
    const files = new Set(tools.flatMap(node => (node.files || []).map(file => file.path))), tests = tools.filter(node => node.insight?.kind === 'test' && node.status !== 'running'), failed = tests.filter(node => node.status === 'failed' || toolView(node).tone === 'failed').length;
    return [globalThis.AIWSI18n.template`${tools.length} araç`, files.size ? globalThis.AIWSI18n.template`${files.size} dosya` : '', tests.length ? globalThis.AIWSI18n.template`${tests.length} test çalıştırması` : '', failed ? globalThis.AIWSI18n.template`${failed} başarısız` : ''].filter(Boolean).join(' · ');
  }
  /** Owns the timeline element inside ctx.root; `ctx` gives the live data and painted of its console. */
  function runTimeline(ctx, timeline) {
    const doc = timeline.ownerDocument, elements = new Map(), signatures = new Map(), activitySigs = new Map(), models = new Map(), openStates = new Map(), expanded = new Set(), openFolds = new Set();
    let timelineFilled = false, emptyHtml = '';
    function toggleFold(button) {
      const body = button.previousElementSibling, open = body.dataset.collapsed === 'true';
      body.dataset.collapsed = String(!open); button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? globalThis.AIWSI18n.text('Daralt') : globalThis.AIWSI18n.text('Tamamını göster');
      if (open) expanded.add(button.dataset.node); else { expanded.delete(button.dataset.node); body.closest('.cv-node')?.scrollIntoView?.({ block: 'nearest' }); }
    }

    // Clicking folded text opens it, unless the click selected text or hit a link or control.
    timeline.addEventListener('click', event => {
      const body = event.target.closest?.('.cv-collapsible[data-collapsed=true]');
      if (!body || event.target.closest('a,button') || String(doc.defaultView?.getSelection?.() || '')) return;
      const button = body.nextElementSibling; if (button?.dataset.cvAction === 'expand') toggleFold(button);
    });
    /** Draws `groups` (normalize() output) with the agent `tree` and the console's questions. */
    function render(groups, tree) {
      const questionsById = new Map((ctx.data.questions || []).map(question => [question.id, question])), created = [], keys = new Set(); let freshNodes = 0;
      for (const group of groups) {
        const headerKey = `run:${group.id}`; keys.add(headerKey);
        let section = elements.get(headerKey); const freshSection = !section; if (!section) { section = doc.createElement('section'); section.className = 'cv-run'; elements.set(headerKey, section); created.push(section); }
        const snap = group.executionSnapshot, provider = group.provider || snap?.provider || 'Agent', model = group.model || snap?.model || snap?.agent?.model;
        const usage = group.usage, tokenInfo = usage ? Object.entries({ 'Girdi': usage.input_tokens ?? usage.input, 'Önbellek': usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cache?.read, 'Çıktı': usage.output_tokens ?? usage.output }).filter(([, value]) => value !== undefined).map(([name, value]) => `${globalThis.AIWSI18n.text(name)}: ${global.AIWSUI.number(Number(value))}`).join(' · ') : '';
        const digest = runDigest(group.nodes), head = `<header class="cv-run-header">${providerBox(provider, ctx.data.providerIcons?.[provider])}<div class="cv-run-title"><strong>${esc(snap?.agent?.name || (globalThis.AIWSProviderNames || {})[provider] || provider)}</strong>${model ? `<span class="cv-model ui-chip is-mono">${esc(model)}</span>` : ''}<small>${esc(clock(group.startedAt))}${group.terminalMode === 'pty' ? globalThis.AIWSI18n.text(' · PTY terminali') : ''}</small></div>${group.status ? global.AIWSUI.statusPill(group.status, statusLabel(group.status)) : ''}${group.terminalMode === 'pty' && ctx.data.onOpenTerminal && !ctx.data.onMountTerminal ? globalThis.AIWSI18n.template`<button class="button small" type="button" data-cv-action="terminal" data-run="${esc(group.id)}">Terminali aç ↗</button>` : ''}</header><div class="cv-run-nodes"></div><footer class="cv-run-footer">${digest ? `<span class="cv-run-digest">${esc(digest)}</span>` : ''}${tokenInfo ? `<span>${esc(tokenInfo)}</span>` : ''}</footer>`;
        // Preserve node elements, open tool panels and selection when only metadata changes.
        const headSig = head.replace('<div class="cv-run-nodes"></div>', '');
        if (signatures.get(headerKey) !== headSig) {
          const oldBody = section.querySelector('.cv-run-nodes'); section.innerHTML = head;
          if (oldBody) section.querySelector('.cv-run-nodes').replaceWith(oldBody);
          signatures.set(headerKey, headSig);
        }
        const body = section.querySelector('.cv-run-nodes'), folds = toolFolds(group.nodes); let previous = null, foldedUntil = -1, revealedUntil = -1;
        for (const [index, rawNode] of group.nodes.entries()) {
          const fold = folds.get(index);
          if (fold) {
            // A long streak of tool calls hides behind one row; its latest calls stay visible.
            const foldKey = `${group.id}:fold:${rawNode.id}`, open = openFolds.has(foldKey), counts = new Map(); keys.add(foldKey);
            for (const item of group.nodes.slice(index, index + fold)) { const title = item.title || item.toolName || globalThis.AIWSI18n.text('Araç çağrısı'); counts.set(title, (counts.get(title) || 0) + 1); }
            const html = `<button type="button" class="cv-tool-fold" data-cv-action="fold" data-fold="${esc(foldKey)}" aria-expanded="false"><span class="cv-tool-icon" aria-hidden="true">⋯</span><span class="cv-tool-heading"><strong></strong><span class="cv-tool-preview">${esc([...counts].map(([title, count]) => `${title} ×${count}`).join(' · '))}</span></span><span class="cv-disclosure" aria-hidden="true">${global.AIWSUI.icon('chevron')}</span></button>`;
            let element = elements.get(foldKey); if (!element) { element = doc.createElement('div'); element.className = 'cv-node cv-fold'; elements.set(foldKey, element); }
            if (signatures.get(foldKey) !== html) { element.innerHTML = html; signatures.set(foldKey, html); }
            // Set in place so the chevron turns and focus stays on the row when it opens or closes.
            element.firstChild.setAttribute('aria-expanded', String(open)); element.querySelector('strong').textContent = open ? globalThis.AIWSI18n.template`${fold} önceki araç çağrısını gizle` : globalThis.AIWSI18n.template`${fold} önceki araç çağrısını göster`;
            const expected = previous ? previous.nextSibling : body.firstChild; if (expected !== element) body.insertBefore(element, expected); previous = element;
            foldedUntil = open ? -1 : index + fold; revealedUntil = open ? index + fold : -1;
          }
          const key = `${group.id}:${rawNode.id}`, node = { ...rawNode, author: rawNode.author || (rawNode.kind === 'assistant' ? snap?.agent?.name || (globalThis.AIWSProviderNames || {})[provider] || provider : undefined), ...(rawNode.kind === 'assistant' ? { provider } : {}), key }; keys.add(key); models.set(key, node);
          // A subagent launch shows the agent it started, so the block follows that agent's status and latest step.
          const launchedRun = node.toolName === 'Workflow' && /Run ID: (wf_[\w-]+)/.exec(String(node.output || ''))?.[1], launched = node.icon === 'agent' && rawNode.id.startsWith('tool:') && tree.agents.find(agent => agent.id === tree.aliases.get(`claude:tool:${rawNode.id.slice(5)}`) || agent.id === `claude:workflow:${launchedRun}`);
          if (launched) node.agent = { id: launched.id, name: launched.name, role: launched.role, model: launched.model, status: launched.status, activity: launched.activity, kind: launched.kind, note: launched.note };
          if (node.kind === 'exchange') { const question = questionsById.get(node.questionId); node.question = question ? { kind: question.kind, source: question.source, status: question.status, answer: question.answer, ...(question.prompt ? { prompt: question.prompt } : {}) } : null; }
          let element = elements.get(key); if (!element) { element = doc.createElement('article'); element.className = `cv-node cv-${node.kind}`; element.dataset.key = key; elements.set(key, element); freshNodes++; if (!freshSection) created.push(element); }
          const signature = `${viewRevision()}:${JSON.stringify(node)}`;
          if (signatures.get(key) !== signature) {
            const opens = element.childNodes.length ? [...element.querySelectorAll('details')].map(detail => detail.open) : openStates.get(key) || []; element.innerHTML = renderNode(node, expanded); element.querySelectorAll('details').forEach((detail, index) => detail.open = opens[index] ?? detail.open); signatures.set(key, signature); activitySigs.set(key, JSON.stringify({ kind: node.kind, text: node.text, title: node.title, command: node.command, fields: node.fields, output: node.output, files: node.files, status: node.status }));
          }
          element.hidden = index < foldedUntil || Boolean(node.covered); element.classList.toggle('cv-fold-member', index < revealedUntil);
          const expected = previous ? previous.nextSibling : body.firstChild; if (expected !== element) body.insertBefore(element, expected); previous = element;
        }
        if (section.parentNode !== timeline) timeline.append(section);
      }
      for (const [key, element] of elements) if (!keys.has(key)) { openStates.set(key, [...element.querySelectorAll('details')].map(detail => detail.open)); element.remove(); elements.delete(key); signatures.delete(key); activitySigs.delete(key); models.delete(key); }
      // Live additions rise in; the first history load and bulk loads (older pages, another agent's view) appear at once.
      if (timelineFilled && freshNodes <= 6) created.forEach((element, index) => enterOnce(element, index * 40)); if (elements.size) timelineFilled = true;
    }
    /** A node card's own buttons: expand a long message, show all output or the raw event, copy a field. Returns whether it handled one. */
    async function action(button) {
      if (button.dataset.cvAction === 'expand') { toggleFold(button); return true; }
      const node = models.get(button.dataset.node); if (!node) return false;
      if (button.dataset.cvAction === 'more' || button.dataset.cvAction === 'raw-more') { const pre = button.previousElementSibling;if(node.web&&button.dataset.cvAction==='more')pre.innerHTML=markdown(stripAnsi(node.output||''));else pre.textContent = button.dataset.cvAction === 'raw-more' ? node.raw : stripAnsi(node.output || node.text || ''); button.hidden = true; }
      if (button.dataset.cvAction === 'copy') {
        const field=button.dataset.copyField,value=field?.startsWith('field:')?node.fields?.[Number(field.slice(6))]?.value:node[field]||node.output||node.command||node.text||node.raw||'';
        button.textContent = await global.AIWSUI.copyText(String(value||'')) ? globalThis.AIWSI18n.text('Kopyalandı') : globalThis.AIWSI18n.text('Kopyalanamadı');
      }
      return true;
    }
    /** Opens or closes a folded tool streak. */
    const toggleStreak = key => { if (!openFolds.delete(key)) openFolds.add(key); };
    /** Question ids shown inline as an exchange. */
    const exchanges = () => new Set([...models.values()].filter(node => node.kind === 'exchange').map(node => node.questionId));
    /** What each node shows, for the console's new-activity count. */
    const activity = () => new Map(activitySigs);
    /** The empty view: the agent's sparkle, or a sub-agent's history loading behind shimmering lines. */
    function empty(groups, selectedAgent, loading, error) {
      let element = timeline.querySelector('.cv-empty');
      if (groups.length) { element?.remove(); return; }
      if (!element) { element = doc.createElement('div'); element.className = 'cv-empty'; timeline.append(element); emptyHtml = ''; }
      const html = selectedAgent ? `${loading ? '<span class="cv-empty-lines" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></span>' : ''}<strong>${loading ? globalThis.AIWSI18n.text('Geçmiş yükleniyor…') : globalThis.AIWSI18n.text('Bu alt agentın kayıtları bekleniyor')}</strong><p>${error ? esc(error) : globalThis.AIWSI18n.text('Yalnız sağlayıcının gerçek mesajları ve araç çıktıları burada gösterilir. Kaynak bulunduğunda bu görünüm güncellenir.')}</p>` : `<span class="ui-icon-box cv-empty-mark">${global.AIWSUI.sparkle('accent')}</span><strong>${globalThis.AIWSI18n.text('Agentın çalışma alanı')}</strong><p>${globalThis.AIWSI18n.text('Mesajlar, dosya değişiklikleri ve terminal işlemleri çalışma başladığında burada görünür.')}</p>`;
      if (emptyHtml !== html) { element.innerHTML = html; emptyHtml = html; }
    }
    return { render, action, toggleStreak, exchanges, activity, empty, clear() { elements.clear(); signatures.clear(); activitySigs.clear(); models.clear(); } };
  }
  Object.assign(kit, { runTimeline });
})(globalThis);
