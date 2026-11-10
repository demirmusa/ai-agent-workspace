/* The chat's extension points: aiws.conversation.addToolView turns matching tool calls into a plugin's own row and card, and
 * aiws.conversation.addPanel pins a collapsible panel above the timeline. Plugin code runs guarded: when it fails, the core view shows. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, { entries, guard, localized, iconHtml, esc, mountView, unmountView, appContext, host } = kit;
  // Registrations of these kinds change how existing cards look, so consoles redraw on each change.
  const conversationKinds = new Set(['toolViews', 'conversationPanels']);
  let revision = 0;
  const changed = () => { revision++; };
  /** What a plugin sees of a tool call: a frozen copy without the raw provider record. */
  function publicNode(node) {
    const insight = node.insight || null, durationMs = node.durationMs ?? (Date.parse(node.finishedAt) - Date.parse(node.startedAt));
    return Object.freeze({ id: node.id, kind: node.kind, title: node.title, toolName: node.toolName, status: node.status, command: node.command || '', commandLine: insight?.line || node.command || '', commands: insight?.commands || [], program: insight?.program || '', args: insight?.args || [], activityKind: insight?.kind || node.view || '', description: node.description || '', output: node.output || '', exitCode: node.exitCode, files: node.files || [], startedAt: node.startedAt, finishedAt: node.finishedAt, durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null });
  }
  /** The first plugin view matching a tool call, with its parts already rendered; null when none does. */
  function toolView(node) {
    let shared = null;
    for (const { plugin, def } of entries('toolViews')) {
      shared ||= publicNode(node);
      if (!guard(plugin, `toolView ${def.id} match`, () => def.match(shared), false)) continue;
      const summary = def.summary ? guard(plugin, `toolView ${def.id} summary`, () => def.summary(shared), null) : null;
      const part = (name, render) => { if (!render) return undefined; const html = guard(plugin, `toolView ${def.id} ${name}`, () => render.call(def, shared), undefined); return typeof html === 'string' ? html : undefined; };
      return { plugin: plugin.id, summary: summary ? { ...summary, ...(summary.title ? { title: localized(summary.title) } : {}), ...(summary.subject ? { subject: localized(summary.subject) } : {}), ...(summary.activity ? { activity: localized(summary.activity) } : {}), ...(summary.icon ? { icon: iconHtml(summary.icon, plugin) } : {}), ...(summary.chips ? { chips: summary.chips.filter(Boolean).map(chip => ({ ...chip, text: localized(chip.text), ...(chip.title ? { title: localized(chip.title) } : {}) })) } : {}) } : null, inline: part('inline', def.inline), detail: part('detail', def.detail) };
    }
    return null;
  }
  const openKey = id => `aiws.cv-panel.${id}`;
  const isOpen = (id, fallback) => { try { const saved = localStorage.getItem(openKey(id)); return saved === null ? Boolean(fallback) : saved === '1'; } catch { return Boolean(fallback); } };
  const wired = new WeakSet();
  /** Draws the panels that apply to these nodes into `container`; returns how many there are. */
  function mountPanels(container, data) {
    const state = host.bridge?.state(), task = state?.tasks?.find(item => item.id === data.taskId) || null, run = task ? state.runs.find(item => item.id === task.currentRunId) || null : null;
    const nodes = Object.freeze(data.nodes.map(publicNode));
    const contextOf = plugin => ({ ...appContext(plugin), task, run, nodes, live: data.live });
    const wanted = entries('conversationPanels').filter(entry => !entry.def.visible || guard(entry.plugin, `panel ${entry.def.id} visible`, () => entry.def.visible(contextOf(entry.plugin)), false));
    const ids = wanted.map(entry => `${entry.plugin.id}/${entry.def.id}`);
    if (!wired.has(container)) {
      wired.add(container);
      container.addEventListener('click', event => {
        const head = event.target.closest?.('.cv-insight-head'); if (!head) return;
        const open = head.getAttribute('aria-expanded') !== 'true';
        try { localStorage.setItem(openKey(head.parentElement.dataset.panel), open ? '1' : '0'); } catch { /* Storage may be disabled. */ }
        head.setAttribute('aria-expanded', String(open)); head.nextElementSibling.hidden = !open;
        if (open) container.dispatchEvent(new CustomEvent('cv-insight-open'));
      });
      container.addEventListener('cv-insight-open', () => container.aiwsRemount?.());
    }
    for (const section of [...container.children]) if (!ids.includes(section.dataset.panel)) { unmountView(section.lastElementChild); section.remove(); }
    const draw = () => {
      wanted.forEach((entry, index) => {
        const id = ids[index], { plugin, def } = entry, ctx = contextOf(plugin);
        let section = [...container.children].find(child => child.dataset.panel === id);
        if (!section) { section = document.createElement('section'); section.className = 'cv-insight'; section.dataset.panel = id; const open = isOpen(id, def.open); section.innerHTML = `<button type="button" class="cv-insight-head" aria-expanded="${open}"><span class="cv-insight-icon" aria-hidden="true">${iconHtml(def.icon, plugin)}</span><strong>${esc(localized(def.title))}</strong><span class="cv-insight-summary"></span><span class="cv-disclosure" aria-hidden="true">${kit.ui.icon('chevron')}</span></button><div class="cv-insight-body"${open ? '' : ' hidden'}></div>`; }
        if (container.children[index] !== section) container.insertBefore(section, container.children[index] || null);
        const summary = def.summary ? guard(plugin, `panel ${def.id} summary`, () => def.summary(ctx), []) : [];
        const line = global.AIWSConversationKit.viewUi.chips((summary || []).filter(Boolean).map(chip => ({ ...chip, text: localized(chip.text) }))), slot = section.querySelector('.cv-insight-summary');
        if (slot.innerHTML !== line) slot.innerHTML = line;
        const body = section.lastElementChild;
        if (!body.hidden) mountView(body, `panel:${id}|${data.key}`, entry, ctx); else unmountView(body);
      });
    };
    container.aiwsRemount = draw; draw();
    return wanted.length;
  }
  /** `aiws.conversation` of one plugin; `register` is that plugin's owned registration. */
  function conversationApi(register) {
    const conversation = global.AIWSConversationKit;
    return {
      addToolView: def => register('toolViews', def, ['id', 'match']),
      addPanel: def => register('conversationPanels', def, ['id', 'title', 'render']),
      parse: Object.freeze({ stripAnsi: conversation.stripAnsi, baseName: conversation.baseName, flagValue: conversation.flagValue, operands: conversation.operands, sourceFiles: conversation.sourceFiles, commandInsight: conversation.commandInsight, shellWords: conversation.shellWords, testSummary: conversation.testSummary, testReport: conversation.testReport, diagnostics: conversation.diagnostics, searchResults: conversation.searchResults }),
      ui: conversation.viewUi,
    };
  }
  Object.assign(kit, { conversationKinds, conversationToolView: toolView, mountConversationPanels: mountPanels, conversationApi, conversationRevision: () => revision, conversationChanged: changed });
})(window);
