/* Plugin loading and activation from the server catalog, and the plugin events derived from state pushes. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, host = kit.host, { plugins, registry, views, clone, recordError, guard, requestRender, unmountView, api } = kit;
  // ── Loading and activation.
  async function loadCatalog() {
    try { const response = await api('/plugins'); host.catalog = response.plugins || []; host.catalogDirectory = response.directory || ''; host.catalogError = ''; }
    catch (error) { host.catalogError = error.message; }
    host.catalogLoaded = true;
  }
  function applyInfo(info) {
    const index = host.catalog.findIndex(item => item.id === info.id);
    if (index >= 0) host.catalog[index] = info; else host.catalog.push(info);
    const plugin = plugins.get(info.id);
    if (plugin) {
      const before = JSON.stringify(plugin.info.settings || {}); plugin.info = info;
      if (before !== JSON.stringify(info.settings || {})) for (const listener of plugin.settingsListeners) guard(plugin, 'settings listener', () => listener(clone(info.settings)));
    }
  }
  function linkStyles(plugin) {
    for (const path of plugin.info.manifest?.styles || []) {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `${plugin.info.assetBase}${path}`; link.dataset.plugin = plugin.id;
      document.head.append(link); plugin.disposers.push(() => link.remove());
    }
  }
  /** Activates a plugin entry: a module exporting activate(aiws) (or a default function/object with activate). */
  async function activate(info, entry) {
    if (plugins.get(info.id)?.active) return;
    const plugin = plugins.get(info.id) || { id: info.id, info, errors: [], disposers: [], listeners: new Map(), settingsListeners: new Set(), active: false, snapshot: null };
    plugin.info = info; plugin.disposers = []; plugin.listeners = new Map(); plugin.settingsListeners = new Set(); plugin.active = true;
    plugins.set(info.id, plugin);
    plugin.aiws = kit.createApi(plugin);
    linkStyles(plugin);
    for (const theme of info.manifest?.themes || []) registry.themes.set(`${plugin.id}/${theme.id}`, { plugin, def: { ...theme, declared: true } });
    plugin.disposers.push(() => { for (const theme of info.manifest?.themes || []) registry.themes.delete(`${plugin.id}/${theme.id}`); });
    if (!entry && info.manifest?.main) {
      const main = `${info.assetBase}${info.manifest.main}`;
      // Plugin modules load only from the plugin asset route of this server, never from a URL the catalog could carry.
      if (!kit.pluginAsset(main)) recordError(plugin, 'load', new Error(`Invalid plugin module path: ${main}`));
      else try { entry = await import(`${main}${host.reloadCount ? `?r=${host.reloadCount}` : ''}`); }
      catch (error) { recordError(plugin, 'load', error); }
    }
    const target = typeof entry === 'function' ? { activate: entry } : entry?.activate ? entry : entry?.default ? (typeof entry.default === 'function' ? { activate: entry.default } : entry.default) : null;
    if (target?.activate) {
      const result = await guard(plugin, 'activate', () => target.activate(plugin.aiws));
      if (typeof result === 'function') plugin.disposers.push(result);
      if (typeof target.deactivate === 'function') plugin.disposers.push(() => target.deactivate(plugin.aiws));
    }
    plugin.snapshot = taskSnapshot();
    kit.applyActiveTheme(); requestRender();
  }
  function deactivate(id) {
    const plugin = plugins.get(id); if (!plugin?.active) return;
    plugin.active = false;
    for (const [container, view] of [...views]) if (view.entry.plugin === plugin) unmountView(container);
    for (const dispose of plugin.disposers.splice(0).reverse()) guard(plugin, 'dispose', dispose);
    for (const map of Object.values(registry)) for (const [entryKey, entry] of [...map]) if (entry.plugin === plugin) map.delete(entryKey);
    kit.watchElements();
    if (String(host.bridge?.screen() || '').startsWith(`plugin:${id}/`)) host.bridge.switchScreen('board');
    kit.applyActiveTheme(); requestRender();
  }
  /** Brings the running plugins in line with the host.catalog: new or re-enabled ones start, turned-off or removed ones stop.
   * A plugin activated from code (AIWSPlugins.activate) is not in the catalog and keeps running unless the catalog lists it. */
  async function sync() {
    const wanted = new Map(host.catalog.filter(info => info.enabled && !info.error).map(info => [info.id, info])), listed = new Set(host.catalog.map(info => info.id));
    for (const [id, plugin] of plugins) {
      const info = wanted.get(id);
      if (plugin.active && !(plugin.info.bundled && !listed.has(id)) && (!info || info.assetBase !== plugin.info.assetBase)) deactivate(id);
    }
    for (const info of wanted.values()) { if (plugins.get(info.id)?.active) applyInfo(info); else await activate(info); }
    for (const info of host.catalog) if (!wanted.has(info.id) && plugins.has(info.id)) plugins.get(info.id).info = info;
    if (host.settingsHost?.isConnected) kit.renderSettings(host.settingsHost);
    requestRender();
  }
  async function reload() { await loadCatalog(); await sync(); }

  // ── Events derived from state pushes.
  function taskSnapshot() { const state = host.bridge?.state(); return state ? { tasks: new Map(state.tasks.map(task => [task.id, { status: task.status, updatedAt: task.updatedAt }])), runs: new Map(state.runs.map(run => [run.id, run.status])) } : null; }
  function emit(name, payload) {
    for (const plugin of plugins.values()) if (plugin.active) for (const listener of plugin.listeners.get(name) || []) guard(plugin, `${name} listener`, () => listener(payload));
  }
  let lastSnapshot = null;
  function stateChanged() {
    if (!host.bridge) return;
    const state = host.bridge.state(), next = taskSnapshot(), previous = lastSnapshot; lastSnapshot = next;
    if (!previous || ![...plugins.values()].some(plugin => plugin.active && plugin.listeners.size)) return;
    for (const task of state.tasks) {
      const before = previous.tasks.get(task.id);
      if (!before) emit('task:created', { task });
      else if (before.updatedAt !== task.updatedAt) { emit('task:updated', { task }); if (before.status !== task.status) emit('task:statusChanged', { task, from: before.status, to: task.status }); }
    }
    for (const id of previous.tasks.keys()) if (!next.tasks.has(id)) emit('task:deleted', { taskId: id });
    for (const run of state.runs) { const before = previous.runs.get(run.id); if (!before) emit('run:started', { run }); else if (before !== run.status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) emit('run:finished', { run }); }
    emit('state', { state });
  }
  let lastScreen = null, lastSelectedTask = null;
  function navigationChanged() {
    const screen = host.bridge.screen(), tab = host.bridge.projectTab(), task = host.bridge.task()?.id || null, screenKey = `${screen}|${host.bridge.project()?.id || ''}|${tab}`;
    if (screenKey !== lastScreen) { lastScreen = screenKey; emit('screen:changed', { screen, project: host.bridge.project() || null, projectTab: tab }); }
    if (task !== lastSelectedTask) { lastSelectedTask = task; emit('task:selected', { task: host.bridge.task() || null }); }
  }
  /** Called once by app/main.js after the first state: loads the host.catalog and activates enabled plugins. */
  async function start(appBridge) {
    host.bridge = appBridge;
    lastSnapshot = taskSnapshot();
    kit.watchThemeMode();
    await reload();
    kit.applyActiveTheme();
  }
  Object.assign(kit, { loadCatalog, applyInfo, activate, deactivate, sync, reload, taskSnapshot, emit, stateChanged, navigationChanged, start });
})(window);
