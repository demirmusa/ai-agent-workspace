/* Extension points the app shell (app/*) renders: sidebar and topbar entries, plugin pages and project tabs, task editor and task detail sections, task actions, card badges, command shortcuts and dom.onElement. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, host = kit.host, { ui, t, esc, plugins, formHandles, localized, iconHtml, entries, key, domId, withData, guard, mountView, unmountView, sweepViews, appContext, taskContext, put, findEntry, pageEntry, projectTabEntry } = kit;
  // ── Shell hooks called by render() in app/render.js.
  function navButton(entry) {
    const { plugin, def } = entry, pageKey = def.page ? key(plugin, def.page) : '', active = pageKey && host.bridge.screen() === pageKey;
    const badge = def.badge ? guard(plugin, `sidebar ${def.id} badge`, () => def.badge(appContext(plugin)), '') : '';
    return `<button type="button" class="nav-item plugin-nav-item${active ? ' active' : ''}" data-plugin-nav="${esc(`${plugin.id}/${def.id}`)}" title="${esc(localized(def.title || def.label))}"${active ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${iconHtml(def.icon, plugin)}</span><span class="nav-label">${esc(localized(def.label))}</span>${badge !== '' && badge !== null && badge !== undefined ? `<span class="nav-count">${esc(badge)}</span>` : ''}</button>`;
  }
  function renderShell() {
    if (!host.bridge) return;
    sweepViews();
    const visible = entry => !entry.def.visible || guard(entry.plugin, `${entry.def.id} visible`, () => entry.def.visible(appContext(entry.plugin)), false);
    const sidebar = entries('sidebar').filter(visible), section = name => sidebar.filter(entry => (entry.def.section || 'plugins') === name).map(navButton).join('');
    put(document.getElementById('plugin-nav-workspace'), section('workspace'));
    put(document.getElementById('plugin-nav-bottom'), section('bottom'));
    const list = section('plugins'); put(document.getElementById('plugin-nav'), list);
    for (const id of ['plugin-nav', 'plugin-nav-label']) { const element = document.getElementById(id); if (element) element.hidden = !list; }
    put(document.getElementById('plugin-topbar'), entries('topbar').filter(visible).map(({ plugin, def }) => `<button type="button" class="button small${def.primary ? ' primary' : ''} plugin-topbar-button" data-plugin-topbar="${esc(`${plugin.id}/${def.id}`)}" title="${esc(localized(def.title || def.label))}">${def.icon ? iconHtml(def.icon, plugin) : ''}<span>${esc(localized(def.label))}</span></button>`).join(''));
    const tabs = document.getElementById('project-view-tabs');
    if (tabs) {
      const current = host.bridge.projectTab(), project = host.bridge.project();
      let slot = document.getElementById('plugin-project-tabs');
      if (!slot) { slot = document.createElement('span'); slot.id = 'plugin-project-tabs'; slot.className = 'plugin-slot'; tabs.querySelector('.project-tabs-indicator')?.before(slot); }
      put(slot, entries('projectTabs').filter(entry => !entry.def.visible || guard(entry.plugin, `${entry.def.id} visible`, () => entry.def.visible({ ...appContext(entry.plugin), project }), false)).map(({ plugin, def }) => { const tabKey = key(plugin, def.id), active = current === tabKey; return `<button type="button" id="project-tab-${esc(domId(tabKey))}" class="view-tab${active ? ' active' : ''}" role="tab" aria-selected="${active}" aria-controls="workspace-scroll" tabindex="${active ? 0 : -1}" data-plugin-project-tab="${esc(tabKey)}">${esc(localized(def.label))}</button>`; }).join(''));
    }
    kit.navigationChanged();
  }
  function renderPage(board, screen) {
    const entry = pageEntry(screen);
    if (!entry) { put(board, `<div class="plugin-empty"><p>${esc(t('Bu eklenti sayfası artık yok.'))}</p></div>`); return; }
    board.className = 'board plugin-page-board';
    if (board.firstElementChild && !board.firstElementChild.classList.contains('plugin-view')) board.replaceChildren();
    mountView(board, screen, entry, appContext(entry.plugin));
  }
  function renderProjectTab(board, tab, project) {
    const entry = projectTabEntry(tab);
    board.className = 'board plugin-page-board';
    if (!entry) { board.innerHTML = `<div class="plugin-empty"><p>${esc(t('Bu eklenti sekmesi artık yok.'))}</p></div>`; return; }
    if (board.firstElementChild && !board.firstElementChild.classList.contains('plugin-view')) board.replaceChildren();
    mountView(board, `${tab}|${project?.id || ''}`, entry, { ...appContext(entry.plugin), project });
  }
  function pageInfo(screen) { const entry = pageEntry(screen); return entry ? { title: localized(entry.def.title), summary: localized(entry.def.summary || '') } : { title: t('Eklenti'), summary: '' }; }

  // ── Task editor (new task and edit dialog).
  function taskFormTabs(ctx) { return entries('taskForm').filter(entry => (entry.def.placement || 'tab') === 'tab' && (!entry.def.visible || guard(entry.plugin, 'taskForm visible', () => entry.def.visible(ctx), false))).map(({ plugin, def }) => ({ id: domId(`plugin-${plugin.id}-${def.id}`), label: localized(def.title) })); }
  function mountTaskForm(form, { task = null, projectId } = {}) {
    if (!form || !host.bridge) return;
    const state = host.bridge.state(), handles = [];
    formHandles.set(form, handles);
    for (const entry of entries('taskForm')) {
      const { plugin, def } = entry, base = task || { projectId, pluginData: {} };
      const ctx = { ...taskContext(plugin, base), task, mode: task ? 'edit' : 'create', form, project: state.projects.find(item => item.id === projectId) || (state.generalWorkspace?.id === projectId ? state.generalWorkspace : null) };
      if (def.visible && !guard(plugin, 'taskForm visible', () => def.visible(ctx), false)) continue;
      const placement = def.placement || 'tab';
      let container;
      if (placement === 'tab') container = form.querySelector(`#task-options-${domId(`plugin-${plugin.id}-${def.id}`)}`);
      else {
        const slot = form.querySelector('[data-plugin-slot="task-form-main"]'); if (!slot) continue;
        container = document.createElement('section'); container.className = 'plugin-form-section'; container.innerHTML = `<h3 class="form-section">${esc(localized(def.title))}</h3>`;
        const body = document.createElement('div'); container.append(body); slot.append(container); container = body;
      }
      if (!container) continue;
      const handle = guard(plugin, `taskForm ${def.id} render`, () => def.render(container, ctx));
      handles.push({ entry, ctx, container, handle: handle && typeof handle === 'object' ? handle : {} });
    }
  }
  /** Values of the plugin sections for the task request: { pluginId: data }. A section's validate() message stops the save. */
  function collectTaskForm(form) {
    const handles = formHandles.get(form); if (!handles?.length) return null;
    const result = {};
    for (const { entry, ctx, container, handle } of handles) {
      const validate = handle.validate || entry.def.validate;
      const problem = validate ? guard(entry.plugin, `taskForm ${entry.def.id} validate`, () => validate.call(entry.def, container, ctx), null) : null;
      if (problem) throw new Error(`${localized(entry.def.title)}: ${localized(problem)}`);
      const collect = handle.collect || entry.def.collect;
      if (!collect) continue;
      const value = guard(entry.plugin, `taskForm ${entry.def.id} collect`, () => collect.call(entry.def, container, ctx));
      if (value === undefined) continue;
      // Sections of one plugin merge into its existing task data, so fields no section edits are kept.
      result[entry.plugin.id] = value === null ? null : { ...(result[entry.plugin.id] ?? ctx.data), ...value };
    }
    return Object.keys(result).length ? result : null;
  }
  function taskSaved(form, task) { for (const { entry, ctx, handle } of formHandles.get(form) || []) { const saved = handle.onSaved || entry.def.onSaved; if (saved) guard(entry.plugin, `taskForm ${entry.def.id} onSaved`, () => saved.call(entry.def, task, ctx)); } }

  // ── Task detail panel.
  function detailTabs(task) { return task ? entries('taskDetailTabs').filter(entry => !entry.def.visible || guard(entry.plugin, 'taskDetail tab visible', () => entry.def.visible(taskContext(entry.plugin, task)), false)).map(({ plugin, def }) => ({ key: key(plugin, def.id), label: localized(def.label) })) : []; }
  function mountDetailTab(host, tab, task) {
    const match = /^plugin:([^/]+)\/(.+)$/.exec(tab || ''), entry = match && findEntry('taskDetailTabs', `${match[1]}/${match[2]}`);
    if (!host || !entry) return;
    mountView(host, `${tab}|${task.id}`, entry, taskContext(entry.plugin, task));
  }
  function mountTaskDetail(panel, task) {
    if (!panel || !task) return;
    for (const placement of ['main', 'sidebar']) {
      const slot = panel.querySelector(`[data-plugin-slot="task-detail-${placement}"]`); if (!slot) continue;
      const wanted = entries('taskDetail').filter(entry => (entry.def.placement || 'main') === placement && (!entry.def.visible || guard(entry.plugin, 'taskDetail visible', () => entry.def.visible(taskContext(entry.plugin, task)), false)));
      const ids = wanted.map(({ plugin, def }) => `${plugin.id}/${def.id}`).join('|');
      if (slot.dataset.sections !== ids) {
        for (const child of slot.querySelectorAll('.plugin-detail-body')) unmountView(child);
        slot.dataset.sections = ids;
        slot.innerHTML = wanted.map(({ plugin, def }) => placement === 'main'
          ? `<section class="issue-section plugin-detail-section" data-plugin-section="${esc(`${plugin.id}/${def.id}`)}"><header class="issue-section-header"><h3>${esc(localized(def.title))}</h3></header><div class="plugin-detail-body"></div></section>`
          : `<section class="issue-panel plugin-detail-section" data-plugin-section="${esc(`${plugin.id}/${def.id}`)}"><header><h3>${esc(localized(def.title))}</h3></header><div class="plugin-detail-body"></div></section>`).join('');
      }
      for (const entry of wanted) {
        const body = withData(slot, 'plugin-section', `${entry.plugin.id}/${entry.def.id}`)[0]?.querySelector('.plugin-detail-body');
        mountView(body, `detail:${entry.plugin.id}/${entry.def.id}|${task.id}`, entry, taskContext(entry.plugin, task));
      }
    }
  }
  function taskActionsHtml(task) {
    return entries('taskActions').filter(entry => !entry.def.visible || guard(entry.plugin, 'taskAction visible', () => entry.def.visible(taskContext(entry.plugin, task)), false))
      .map(({ plugin, def }) => `<button type="button" class="button small ghost${def.danger ? ' danger' : ''}" data-plugin-task-action="${esc(`${plugin.id}/${def.id}`)}" data-task-id="${esc(task.id)}">${def.icon ? iconHtml(def.icon, plugin) : ''}${esc(localized(def.label))}</button>`).join('');
  }
  /** Card badges: render(task) returns null, a text, or { text, tone, title, icon }. */
  function cardBadgesHtml(task) {
    const badges = [];
    for (const { plugin, def } of entries('cardBadges')) {
      const value = guard(plugin, `taskCard ${def.id}`, () => def.render(task, taskContext(plugin, task)), null);
      for (const badge of Array.isArray(value) ? value : [value]) {
        if (badge === null || badge === undefined || badge === false || badge === '') continue;
        const item = typeof badge === 'object' ? badge : { text: badge };
        badges.push(`<span class="ui-chip plugin-card-badge" data-tone="${esc(['running', 'done', 'needs', 'failed', 'idle', 'accent'].includes(item.tone) ? item.tone : 'idle')}" title="${esc(localized(item.title || ''))}">${item.icon ? iconHtml(item.icon, plugin) : ''}${esc(localized(item.text ?? ''))}</span>`);
      }
    }
    return badges.length ? `<div class="plugin-card-badges">${badges.join('')}</div>` : '';
  }

  // ── Delegated events for every plugin-rendered control.
  document.addEventListener('click', event => {
    const target = event.target.closest?.('[data-plugin-nav],[data-plugin-topbar],[data-plugin-project-tab],[data-plugin-task-action]');
    if (!target || !host.bridge) return;
    if (target.dataset.pluginProjectTab) { host.bridge.selectProjectTab(target.dataset.pluginProjectTab); return; }
    if (target.dataset.pluginTaskAction) {
      const entry = findEntry('taskActions', target.dataset.pluginTaskAction), task = host.bridge.state().tasks.find(item => item.id === target.dataset.taskId);
      target.closest('details')?.removeAttribute('open');
      if (entry && task) guard(entry.plugin, `taskAction ${entry.def.id}`, () => entry.def.run(taskContext(entry.plugin, task)));
      return;
    }
    const entry = findEntry(target.dataset.pluginNav ? 'sidebar' : 'topbar', target.dataset.pluginNav || target.dataset.pluginTopbar);
    if (!entry) return;
    if (entry.def.page) host.bridge.switchScreen(key(entry.plugin, entry.def.page));
    else if (entry.def.onClick) guard(entry.plugin, `${entry.def.id} click`, () => entry.def.onClick(appContext(entry.plugin), event));
  });
  // Commands: shortcuts such as "Ctrl+Shift+K" or "Mod+K" (Mod is Cmd on macOS, Ctrl elsewhere).
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  function shortcutMatches(shortcut, event) {
    const parts = String(shortcut).toLowerCase().split('+').map(part => part.trim()), key = parts.pop();
    const want = { ctrl: parts.includes('ctrl') || (!mac && parts.includes('mod')), meta: parts.includes('meta') || parts.includes('cmd') || (mac && parts.includes('mod')), shift: parts.includes('shift'), alt: parts.includes('alt') };
    return event.key.toLowerCase() === key && event.ctrlKey === want.ctrl && event.metaKey === want.meta && event.shiftKey === want.shift && event.altKey === want.alt;
  }
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || !host.bridge) return;
    const entry = entries('commands').find(item => item.def.shortcut && shortcutMatches(item.def.shortcut, event));
    if (!entry) return;
    event.preventDefault();
    guard(entry.plugin, `command ${entry.def.id}`, () => entry.def.run(appContext(entry.plugin)));
  });
  // dom.onElement: decorate any element as it appears, for places without a dedicated extension point.
  const decorated = new WeakMap();
  function decorate(root) {
    for (const { plugin, def } of entries('elements')) {
      const matches = [...(root.matches?.(def.selector) ? [root] : []), ...(root.querySelectorAll?.(def.selector) || [])];
      for (const element of matches) {
        let seen = decorated.get(element); if (!seen) decorated.set(element, seen = new Set());
        if (seen.has(def)) continue; seen.add(def);
        guard(plugin, `dom.onElement ${def.selector}`, () => def.fn(element, appContext(plugin)));
      }
    }
  }
  // The body observer runs only while some plugin decorates elements; otherwise every app render would queue mutation records.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) decorate(node); }) : null;
  let observing = false;
  function watchElements() {
    const wanted = entries('elements').length > 0;
    if (wanted && !observing && observer) { observer.observe(document.body, { childList: true, subtree: true }); observing = true; decorate(document.body); }
    else if (!wanted && observing) { observer.disconnect(); observing = false; }
  }
  Object.assign(kit, { renderShell, renderPage, renderProjectTab, pageInfo, taskFormTabs, mountTaskForm, collectTaskForm, taskSaved, detailTabs, mountDetailTab, mountTaskDetail, taskActionsHtml, cardBadgesHtml, watchElements });
})(window);
