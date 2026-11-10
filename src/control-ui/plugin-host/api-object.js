/* The `aiws` object each plugin receives (src/assets/agent-skills/aiws-plugin-development) and the modal helpers on top of the app's one modal. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, host = kit.host, { API_VERSION, ui, i18n, t, esc, plugins, registry, localized, html, raw, entries, key, clone, guard, requestRender, appContext, api } = kit;
  // ── The API object each plugin receives.
  function createApi(plugin) {
    const own = fn => { plugin.disposers.push(fn); return fn; };
    const register = (kind, def, required = ['id']) => {
      if (!def || typeof def !== 'object') throw new Error(`${kind}: a definition object is required.`);
      for (const field of required) if (def[field] === undefined || def[field] === null || def[field] === '') throw new Error(`${kind}: "${field}" is required.`);
      if (def.id !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(String(def.id))) throw new Error(`${kind}: id must be 1-64 letters, digits, dots, dashes or underscores.`);
      const entryKey = `${plugin.id}/${def.id ?? Math.random().toString(36).slice(2)}`;
      registry[kind].set(entryKey, { plugin, def });
      if (kit.conversationKinds.has(kind)) kit.conversationChanged();
      if (kind === 'themes') kit.applyActiveTheme();
      if (kind === 'elements') kit.watchElements();
      requestRender();
      return own(() => { if (registry[kind].get(entryKey)?.def === def) { registry[kind].delete(entryKey); if (kit.conversationKinds.has(kind)) kit.conversationChanged(); if (kind === 'themes') kit.applyActiveTheme(); if (kind === 'elements') kit.watchElements(); requestRender(); } });
    };
    const http = async (path, options = {}) => host.bridge.api(path, options.method || 'GET', options.body, options.signal ? { signal: options.signal } : {});
    const dictionary = {};
    const api = {
      apiVersion: API_VERSION,
      plugin: { id: plugin.id, get version() { return plugin.info.manifest?.version; }, get manifest() { return clone(plugin.info.manifest); }, assetUrl: path => `${plugin.info.assetBase}${String(path).replace(/^\.?\//, '')}` },
      onDispose: fn => own(fn),
      sidebar: { addItem: def => register('sidebar', def, ['id', 'label']) },
      topbar: { addButton: def => register('topbar', def, ['id', 'label']) },
      pages: { register: def => register('pages', def, ['id', 'title', 'render']), open: id => host.bridge.switchScreen(key(plugin, id)) },
      projectTabs: { add: def => register('projectTabs', def, ['id', 'label', 'render']), open: id => host.bridge.selectProjectTab(key(plugin, id)) },
      taskForm: { addSection: def => register('taskForm', def, ['id', 'title', 'render']) },
      taskDetail: {
        addSection: def => register('taskDetail', def, ['id', 'title', 'render']),
        addTab: def => register('taskDetailTabs', def, ['id', 'label', 'render']),
        addAction: def => register('taskActions', def, ['id', 'label', 'run']),
      },
      taskCard: { addBadge: def => register('cardBadges', def, ['id', 'render']) },
      conversation: kit.conversationApi(register),
      commands: {
        register: def => register('commands', def, ['id', 'title', 'run']),
        execute: (id, ...args) => { const entry = [...registry.commands.values()].find(item => item.def.id === id && item.plugin.id === plugin.id) || entries('commands').find(item => `${item.plugin.id}/${item.def.id}` === id); if (!entry) throw new Error(`Command ${id} not found.`); return guard(entry.plugin, `command ${entry.def.id}`, () => entry.def.run(appContext(entry.plugin), ...args)); },
      },
      themes: { register: def => register('themes', def, ['id', 'name']), active: () => kit.activeThemeKey(), apply: id => kit.applyTheme(id ? (String(id).includes('/') ? id : `${plugin.id}/${id}`) : '') },
      styles: {
        add: css => { const style = document.createElement('style'); style.dataset.plugin = plugin.id; style.textContent = String(css); document.head.append(style); return own(() => style.remove()); },
        addLink: path => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = api.plugin.assetUrl(path); link.dataset.plugin = plugin.id; document.head.append(link); return own(() => link.remove()); },
      },
      settings: {
        get: name => { const values = plugin.info.settings || {}; return name === undefined ? clone(values) : values[name]; },
        set: async (name, value) => { const saved = await http(`/plugins/${encodeURIComponent(plugin.id)}`, { method: 'PATCH', body: { settings: { [name]: value } } }); kit.applyInfo(saved); return saved.settings; },
        onChange: fn => { plugin.settingsListeners.add(fn); return own(() => plugin.settingsListeners.delete(fn)); },
        addPanel: def => register('settingsPanels', { id: 'panel', ...def }, ['render']),
      },
      storage: {
        get: async name => (await http(`/plugins/${encodeURIComponent(plugin.id)}/storage/${encodeURIComponent(name)}`)).value,
        all: async () => (await http(`/plugins/${encodeURIComponent(plugin.id)}/storage`)).values,
        set: (name, value) => http(`/plugins/${encodeURIComponent(plugin.id)}/storage/${encodeURIComponent(name)}`, { method: 'PUT', body: { value } }),
        delete: name => http(`/plugins/${encodeURIComponent(plugin.id)}/storage/${encodeURIComponent(name)}`, { method: 'DELETE' }),
        local: {
          get: (name, fallback = null) => { try { const value = localStorage.getItem(`aiws.plugin.${plugin.id}.${name}`); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
          set: (name, value) => { try { localStorage.setItem(`aiws.plugin.${plugin.id}.${name}`, JSON.stringify(value)); } catch { /* Storage may be disabled. */ } },
          remove: name => { try { localStorage.removeItem(`aiws.plugin.${plugin.id}.${name}`); } catch { /* Storage may be disabled. */ } },
        },
      },
      http: {
        api: http,
        route: (path, options = {}) => http(`/plugins/${encodeURIComponent(plugin.id)}/routes/${String(path).replace(/^\//, '')}${options.query ? `?${new URLSearchParams(options.query)}` : ''}`, options),
      },
      events: { on: (name, fn) => { let set = plugin.listeners.get(name); if (!set) plugin.listeners.set(name, set = new Set()); set.add(fn); return own(() => set.delete(fn)); } },
      tasks: {
        list: (filter = {}) => host.bridge.state().tasks.filter(task => (!filter.projectId || task.projectId === filter.projectId) && (!filter.status || task.status === filter.status)),
        get: id => host.bridge.state().tasks.find(task => task.id === id) || null,
        create: input => http('/tasks', { method: 'POST', body: input }),
        update: (id, input) => http(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
        setData: (id, values) => http(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { pluginData: { [plugin.id]: values } } }),
        getData: id => clone(host.bridge.state().tasks.find(task => task.id === id)?.pluginData?.[plugin.id] || null),
        sendMessage: (id, text) => http(`/tasks/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text } }),
      },
      state: () => host.bridge.state(),
      project: () => host.bridge.project() || null,
      task: () => host.bridge.task() || null,
      screen: () => host.bridge.screen(),
      navigate: {
        page: id => host.bridge.switchScreen(String(id).startsWith('plugin:') ? id : key(plugin, id)),
        screen: name => host.bridge.switchScreen(name),
        project: id => host.bridge.openProject(id),
        task: id => host.bridge.openTask(id),
        projectTab: id => host.bridge.selectProjectTab(String(id).startsWith('plugin:') || ['board', 'terminal', 'schedules', 'sessions', 'settings'].includes(id) ? id : key(plugin, id)),
      },
      ui: {
        esc, html, raw, icon: name => ui.icon(name), sparkle: tone => ui.sparkle(tone), statusPill: (value, label) => ui.statusPill(value, label),
        markdown: text => host.bridge.markdown(text), toast: message => host.bridge.toast(String(message)), error: message => host.bridge.error(String(message)),
        modal: options => openModal(plugin, options), confirm: options => confirmModal(plugin, options), closeModal: () => host.bridge.closeModal(),
        render: requestRender, menuNavigate: ui.menuNavigate,
      },
      dom: { onElement: (selector, fn) => register('elements', { id: `element-${registry.elements.size + 1}-${Math.random().toString(36).slice(2, 6)}`, selector, fn }, ['selector', 'fn']) },
      i18n: {
        get language() { return i18n.language; }, get locale() { return i18n.locale; },
        text: localized,
        add: translations => { for (const [language, values] of Object.entries(translations || {})) Object.assign(dictionary[language] ||= {}, values); },
        t: value => dictionary[i18n.language]?.[value] ?? value,
      },
    };
    return Object.freeze(api);
  }

  // ── Modal helpers on top of the app's one modal (showModal).
  function openModal(plugin, { title, body = '', submitLabel, onSubmit, size, description, render } = {}) {
    const markup = typeof body === 'string' ? body : '';
    const content = onSubmit ? `<form>${markup}<div class="plugin-modal-mount"></div>${host.bridge.formFooter(submitLabel || t('Kaydet'))}</form>` : `${markup}<div class="plugin-modal-mount"></div>`;
    host.bridge.showModal(localized(title), content, onSubmit ? (data, form) => onSubmit(data, form) : undefined, { ...(size ? { size } : {}), ...(description ? { description: localized(description) } : {}) });
    const mount = document.querySelector('#modal .plugin-modal-mount');
    if (body instanceof Node) mount?.append(body);
    if (render && mount) guard(plugin, 'modal render', () => render(mount));
    return document.querySelector('#modal');
  }
  function confirmModal(plugin, { title, message = '', confirmLabel } = {}) {
    return new Promise(resolve => {
      let answered = false;
      openModal(plugin, { title: title || t('Emin misin?'), body: `<p class="form-hint">${esc(localized(message))}</p>`, submitLabel: confirmLabel || t('Onayla'), onSubmit: () => { answered = true; resolve(true); } });
      document.querySelector('#modal').addEventListener('close', () => { if (!answered) resolve(false); }, { once: true });
    });
  }
  Object.assign(kit, { createApi, openModal, confirmModal });
})(window);
