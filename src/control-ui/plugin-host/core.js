/* Plugin host core: the shared state of every plugin-host/*.js part (window.AIWSPluginKit), the contribution registry, guarded
 * calls into plugin code, plugin views and the context objects handed to plugin callbacks. plugins.js publishes AIWSPlugins. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit = {};
  // State the parts share: the app bridge, the server's plugin catalog and the Settings → Eklentiler page's own state.
  const host = kit.host = { bridge: null, catalog: [], catalogDirectory: '', catalogError: '', catalogLoaded: false, skillStatus: null, skillBusy: false, settingsHost: null, reloadCount: 0 };
  const API_VERSION = 1;
  const THEME_KEY = 'aiws.plugin-theme', THEME_CACHE_KEY = 'aiws.plugin-theme-cache';
  const ui = global.AIWSUI, i18n = global.AIWSI18n, t = value => i18n.text(value), esc = ui.esc;
  const plugins = new Map();
  // Contributions by kind; each entry is { plugin, def } and is listed in registration order within its `order`.
  const kinds = ['sidebar', 'topbar', 'pages', 'projectTabs', 'taskForm', 'taskDetail', 'taskDetailTabs', 'taskActions', 'cardBadges', 'commands', 'themes', 'settingsPanels', 'elements', 'toolViews', 'conversationPanels'];
  const registry = Object.fromEntries(kinds.map(kind => [kind, new Map()]));
  const views = new Map();
  const formHandles = new WeakMap();
  const panelState = { open: new Set(), logs: new Map(), busy: new Set(), installError: '', installBusy: false };
  /** Text for the interface language from a plain string or a { tr, en } object. */
  function localized(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return String(value);
    return value[i18n.language] ?? value.en ?? value.tr ?? Object.values(value)[0] ?? '';
  }
  /** An icon given as a built-in name, inline SVG markup, an image URL or a short text such as an emoji. */
  function iconHtml(icon, plugin) {
    if (!icon) return ui.icon('plug');
    const value = String(icon);
    if (value.trim().startsWith('<svg')) return value;
    if (ui.icon(value)) return ui.icon(value);
    if (/^(\/|data:image\/|blob:)/.test(value) || /\.(svg|png|webp|jpe?g|gif)$/i.test(value)) return `<img class="plugin-icon-image" src="${esc(/^(\/|data:|blob:)/.test(value) ? value : `${plugin?.info.assetBase || ''}${value}`)}" alt="" width="16" height="16">`;
    return `<span class="plugin-icon-text">${esc(value.slice(0, 2))}</span>`;
  }
  /** A tagged template that escapes every substitution; plugin markup built with it is safe from injected task text. */
  function html(parts, ...values) { return parts.reduce((result, part, index) => result + part + (index < values.length ? (values[index]?.__html ?? esc(values[index] ?? '')) : ''), ''); }
  const raw = value => ({ __html: String(value) });
  const byOrder = (a, b) => (a.def.order ?? 100) - (b.def.order ?? 100) || a.plugin.id.localeCompare(b.plugin.id);
  const entries = kind => [...registry[kind].values()].filter(entry => plugins.get(entry.plugin.id)?.active).sort(byOrder);
  const key = (plugin, id) => `plugin:${plugin.id}/${id}`;
  const domId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
  /** A deep copy of JSON data (task data, settings), so plugins cannot change AIWS's objects by accident. */
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  /** The elements under root whose data attribute equals value (no selector escaping needed). */
  const withData = (root, name, value) => [...root.querySelectorAll(`[data-${name}]`)].filter(element => element.getAttribute(`data-${name}`) === value);

  function recordError(plugin, where, error) {
    const message = `${where}: ${error?.message || error}`;
    plugin.errors.push({ at: new Date().toISOString(), message });
    if (plugin.errors.length > 50) plugin.errors.shift();
    console.error(`[plugin ${plugin.id}] ${where}`, error);
    if (host.settingsHost?.isConnected) kit.renderSettings(host.settingsHost);
  }
  /** Runs plugin code; a failure is recorded on the plugin and never breaks the application. */
  function guard(plugin, where, action, fallback) {
    try {
      const result = action();
      if (result && typeof result.then === 'function') return result.catch(error => { recordError(plugin, where, error); return fallback; });
      return result;
    } catch (error) { recordError(plugin, where, error); return fallback; }
  }
  const requestRender = () => host.bridge?.render();
  /** Whether a path lies inside the server's plugin asset route (/plugins/<id>/<stamp>/…), the only place plugin code and styles load from. */
  const pluginAsset = value => /^\/plugins\/[\w.-]+\/[\w.-]+\/[^?#\\]*$/.test(String(value)) && !/\/\.{1,2}(?:\/|$)/.test(String(value));
  // ── Views: a plugin renders into a container once and is updated on later renders until the container leaves the page.
  function mountView(container, viewKey, entry, ctx) {
    if (!container) return;
    const current = views.get(container);
    if (current?.key === viewKey && current.root.isConnected) { const update = current.handle?.update || entry.def.update; if (update) guard(entry.plugin, `${viewKey} update`, () => update.call(entry.def, ctx, current.root)); return; }
    if (current) unmountView(container);
    const root = document.createElement('div'); root.className = 'plugin-view'; root.dataset.pluginView = viewKey;
    container.replaceChildren(root);
    const handle = guard(entry.plugin, `${viewKey} render`, () => entry.def.render?.(root, ctx));
    views.set(container, { key: viewKey, root, handle: handle && typeof handle === 'object' ? handle : null, entry });
  }
  function unmountView(container) {
    const view = views.get(container); if (!view) return;
    views.delete(container);
    const unmount = view.handle?.unmount || view.entry.def.unmount;
    if (unmount) guard(view.entry.plugin, `${view.key} unmount`, () => unmount.call(view.entry.def, view.root));
  }
  /** Views whose container left the page (another screen replaced it) are unmounted. */
  function sweepViews() { for (const [container, view] of [...views]) if (!container.isConnected || !view.root.isConnected) unmountView(container); }

  // ── Context objects passed to plugin callbacks.
  function appContext(plugin) {
    return { plugin: plugin.aiws, state: host.bridge?.state(), screen: host.bridge?.screen(), project: host.bridge?.project() || null, task: host.bridge?.task() || null };
  }
  function taskContext(plugin, task, extra = {}) {
    const state = host.bridge.state();
    return { ...appContext(plugin), task, project: state.projects.find(item => item.id === task?.projectId) || (state.generalWorkspace?.id === task?.projectId ? state.generalWorkspace : null),
      run: task ? state.runs.find(run => run.id === task.currentRunId) || null : null, data: clone(task?.pluginData?.[plugin.id] || {}),
      saveData: values => plugin.aiws.tasks.setData(task.id, values), ...extra };
  }
  /** A control API request through the app host.bridge. */
  async function api(path, method, body) { return host.bridge.api(path, method, body); }
  const cache = new WeakMap();
  function put(element, markup) { if (!element || cache.get(element) === markup) return; cache.set(element, markup); element.innerHTML = markup; }
  const findEntry = (kind, value) => registry[kind].get(value) && plugins.get(registry[kind].get(value).plugin.id)?.active ? registry[kind].get(value) : null;
  const pageEntry = screen => { const match = /^plugin:([^/]+)\/(.+)$/.exec(screen || ''); return match ? findEntry('pages', `${match[1]}/${match[2]}`) : null; };
  const projectTabEntry = tab => { const match = /^plugin:([^/]+)\/(.+)$/.exec(tab || ''); return match ? findEntry('projectTabs', `${match[1]}/${match[2]}`) : null; };
  Object.assign(kit, { pluginAsset, API_VERSION, THEME_KEY, THEME_CACHE_KEY, ui, i18n, t, esc, plugins, registry, views, formHandles, panelState, localized, iconHtml, html, raw, entries, key, domId, clone, withData, recordError, guard, requestRender, mountView, unmountView, sweepViews, appContext, taskContext, api, put, findEntry, pageEntry, projectTabEntry });
})(window);
