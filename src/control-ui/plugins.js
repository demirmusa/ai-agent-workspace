/* Plugin host: loads enabled plugins and hands each one the `aiws` API to extend the control center — menus, pages, project
 * tabs, task editor and task detail sections, card badges, commands, styles and themes. the app shell (app/*) calls the render hooks
 * below; everything a plugin registers is owned by that plugin and removed when it is turned off. Contract: src/assets/agent-skills/aiws-plugin-development.
 * The parts live in plugin-host/: core (registry, guarded calls, views), api-object (the `aiws` object), themes, lifecycle
 * (catalog, activation, events), extension-points (the hooks below) and settings-page. This file publishes window.AIWSPlugins. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit;
  /** The app shell calls these hooks while rendering; a fault in the host is logged and never interrupts the app. collectTaskForm
   * is not wrapped: its validation error must reach the task dialog. */
  const safe = (name, fn, fallback) => (...args) => { try { return fn(...args); } catch (error) { console.error(`[plugins] ${name}`, error); return fallback; } };
  global.AIWSPlugins = Object.freeze({
    apiVersion: kit.API_VERSION, start: kit.start, reload: kit.reload, stateChanged: safe('stateChanged', kit.stateChanged), renderShell: safe('renderShell', kit.renderShell), renderPage: safe('renderPage', kit.renderPage), renderProjectTab: safe('renderProjectTab', kit.renderProjectTab), pageInfo: safe('pageInfo', kit.pageInfo, { title: '', summary: '' }),
    isPage: screen => /^plugin:[^/]+\/.+$/.test(screen || ''), hasProjectTab: tab => Boolean(kit.projectTabEntry(tab)),
    taskFormTabs: safe('taskFormTabs', kit.taskFormTabs, []), mountTaskForm: safe('mountTaskForm', kit.mountTaskForm), collectTaskForm: kit.collectTaskForm, taskSaved: safe('taskSaved', kit.taskSaved), detailTabs: safe('detailTabs', kit.detailTabs, []), mountDetailTab: safe('mountDetailTab', kit.mountDetailTab),
    mountTaskDetail: safe('mountTaskDetail', kit.mountTaskDetail), taskActionsHtml: safe('taskActionsHtml', kit.taskActionsHtml, ''), cardBadgesHtml: safe('cardBadgesHtml', kit.cardBadgesHtml, ''), renderSettings: safe('renderSettings', kit.renderSettings),
    conversationToolView: safe('conversationToolView', kit.conversationToolView, null), mountConversationPanels: safe('mountConversationPanels', kit.mountConversationPanels, 0), conversationRevision: kit.conversationRevision,
    /** Activates a plugin from code instead of its main file; used by tests and by plugins bundled into a page. */
    activate: (info, entry) => kit.activate({ enabled: true, bundled: true, settings: {}, assetBase: `/plugins/${info.id}/0/`, server: { declared: false, status: 'inactive', routes: [] }, ...info, manifest: { name: info.id, version: '0.0.0', styles: [], themes: [], settings: [], ...(info.manifest || {}) } }, entry),
    deactivate: kit.deactivate,
    list: () => [...kit.plugins.values()].map(plugin => ({ id: plugin.id, active: plugin.active, errors: [...plugin.errors] })),
  });
})(window);
