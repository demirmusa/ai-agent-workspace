import { app, BrowserWindow, dialog, shell, Notification, nativeImage, type Session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorLog } from '../control-server/error-log.js';
import { defaultControlDataDir } from '../shared/core/paths.js';
import { appIcon } from './app-icon.js';
import { registerIpcHandlers } from './ipc-handlers.js';
import { DESKTOP_SERVICE_PORT, startOwnedService, type OwnedService } from './service-host.js';
import { createTray, hasTray } from './tray.js';
import { isRendererOrigin, primaryWindow, setRendererOrigin, trackWindow, untrackWindow, windows } from './window-registry.js';
import { changeZoom, loadZoom, zoomFactor, zoomShortcut } from './window-zoom.js';

let server: OwnedService | null = null;
let serviceStartup: Promise<void> | undefined;
let closing = false;
let backgroundNoticeShown = false;
const startHidden = process.argv.includes('--hidden');
const securedSessions = new WeakSet<Session>();
/** Service crashes, renderer crashes and frozen windows go to the same errors.log as the service's own errors. */
const errorLog = new ErrorLog(defaultControlDataDir());

const showError = (title: string) => (error: unknown): void => dialog.showErrorBox(title, error instanceof Error ? error.message : String(error));

function showWindow(): void {
  const window = primaryWindow();
  if (!window) { openNewWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function openNewWindow(projectId?: string): void {
  void createWindow(projectId).catch(showError('AIWS penceresi açılamadı'));
}

function controlUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('AIWS_CONTROL_URL must be an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

const sameOrigin = (value: string | undefined): boolean => {
  try { return isRendererOrigin(new URL(value ?? '').origin); } catch { return false; }
};

/**
 * Only writing to the clipboard (copy buttons) and the microphone (dictation, audio only) are granted, and only to
 * the control service's own pages. Checks compare against the current service origin, which changes after a restart.
 */
function securePermissions(session: Session): void {
  if (securedSessions.has(session)) return;
  securedSessions.add(session);
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const audioOnly = permission === 'media' && (details as { mediaTypes?: string[] } | undefined)?.mediaTypes?.every(type => type === 'audio') === true;
    callback(sameOrigin(details?.requestingUrl) && (permission === 'clipboard-sanitized-write' || audioOnly));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    sameOrigin(requestingOrigin) && (permission === 'clipboard-sanitized-write' || permission === 'media'));
}

/** The local service is started once and restarted if it crashes; every window reconnects to its new address. */
function ensureOwnedService(): Promise<void> {
  if (process.env.AIWS_CONTROL_URL || server) return Promise.resolve();
  // Extra windows can be requested before the first service is ready. They must all await the same startup.
  return serviceStartup ??= (async () => {
    const owned = await startOwnedService({ host: '127.0.0.1', port: DESKTOP_SERVICE_PORT });
    if (closing) { await owned.close(); throw new Error('AIWS is closing.'); }
    server = owned;
    owned.onUnexpectedExit?.((code) => {
      if (closing || server !== owned) return;
      errorLog.write({ source: 'desktop', message: `Control service exited unexpectedly (code ${code}); restarting it and reloading the windows.` });
      server = null;
      if (!windows.size) return;
      const current = [...windows];
      void ensureOwnedService().then(async () => {
        if (closing || !server) return;
        const url = new URL(server.url);
        setRendererOrigin(url.origin);
        await Promise.all(current.filter(item => windows.has(item) && !item.isDestroyed()).map(item => item.loadURL(url.href)));
      }).catch(showError('AIWS servisi yeniden başlatılamadı'));
    });
  })().finally(() => { serviceStartup = undefined; });
}

async function createWindow(projectId?: string): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('com.aiws.control-center');
  await ensureOwnedService();
  const url = controlUrl(process.env.AIWS_CONTROL_URL || server!.url);
  setRendererOrigin(url.origin);
  const target = new URL(url.href);
  if (projectId) target.searchParams.set('project', projectId);
  const zoom = await loadZoom();
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 620,
    minHeight: 500,
    title: 'AI Agent Workspace',
    icon: nativeImage.createFromBuffer(appIcon(256)),
    backgroundColor: '#1b1a1d',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      zoomFactor: zoomFactor(zoom),
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
  });
  trackWindow(window);
  window.once('ready-to-show', () => { if (!startHidden || !hasTray() || windows.size > 1) window.show(); });
  window.on('close', (event) => {
    // The local service owns GitHub polling and agents; closing the window keeps them running in the tray.
    // Only the last window falls back to the tray; extra windows simply close.
    if (!hasTray() || closing || windows.size > 1) return;
    event.preventDefault(); window.hide();
    if (!backgroundNoticeShown && Notification.isSupported()) {
      backgroundNoticeShown = true;
      new Notification({ title: 'AIWS arka planda çalışıyor', body: 'GitHub işleri ve agentlar devam ediyor. Çıkmak için sistem tepsisindeki menüyü kullanın.' }).show();
    }
  });
  // The page blocks its unload while the file editor holds unsaved changes; Electron shows no prompt of its own, so the window asks.
  window.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Değişiklikleri sil', 'Vazgeç'], defaultId: 1, cancelId: 1, title: 'AIWS', message: 'Kaydedilmemiş değişiklikler var', detail: 'Editörde açık dosyalardaki kaydedilmemiş değişiklikler silinsin mi?' }) === 0;
    if (leave) event.preventDefault();
  });
  window.on('maximize', () => { if (!window.isDestroyed()) window.webContents.send('aiws:window-maximized', true); });
  window.on('unmaximize', () => { if (!window.isDestroyed()) window.webContents.send('aiws:window-maximized', false); });
  window.on('closed', () => untrackWindow(window));
  // A crashed page is reloaded instead of staying blank; it resumes an unsaved task draft from the service.
  let unresponsiveSince = 0;
  window.on('unresponsive', () => { unresponsiveSince = Date.now(); errorLog.write({ source: 'desktop', message: 'Window stopped responding.' }); });
  window.on('responsive', () => { if (unresponsiveSince) errorLog.write({ source: 'desktop', message: `Window responded again after ${Date.now() - unresponsiveSince} ms.` }); unresponsiveSince = 0; });
  window.webContents.on('render-process-gone', (_event, details) => {
    errorLog.write({ source: 'desktop', message: `Window renderer ended: ${details.reason} (exit code ${details.exitCode}).` });
    if (details.reason !== 'clean-exit' && !closing && !window.isDestroyed()) window.webContents.reload();
  });
  // Neither page links nor server redirects may take the privileged window to another origin.
  const blockForeign = (event: { preventDefault(): void }, destination: string) => { if (!sameOrigin(destination)) event.preventDefault(); };
  window.webContents.on('will-navigate', blockForeign);
  window.webContents.on('will-redirect', blockForeign);
  window.webContents.setWindowOpenHandler(({ url: destination }) => {
    try {
      const external = new URL(destination);
      if (external.protocol === 'https:' && !external.username && !external.password) void shell.openExternal(external.href);
    } catch { /* Invalid destinations are blocked. */ }
    return { action: 'deny' };
  });
  securePermissions(window.webContents.session);
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.shift && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'n') { event.preventDefault(); openNewWindow(); }
    // Zoom keys replace the menu's, so the setting and the saved level always follow them.
    const change = zoomShortcut(input);
    if (change) { event.preventDefault(); void changeZoom(change); }
  });
  // A navigation (service restart, renderer reload) can reset the page's zoom; the saved level always wins.
  window.webContents.on('did-finish-load', () => { void loadZoom().then((percent) => { if (!window.isDestroyed()) window.webContents.setZoomFactor(zoomFactor(percent)); }); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadURL(target.href);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerIpcHandlers(openNewWindow);
  // A second launch opens another window on the same service rather than only focusing the first.
  app.on('second-instance', () => { if (windows.size && ![...windows].some(item => !item.isDestroyed() && item.isVisible())) showWindow(); else openNewWindow(); });
  app.whenReady().then(() => { createTray({ showWindow, openNewWindow: () => openNewWindow() }); return createWindow(); }).catch((error: unknown) => {
    showError('AIWS başlatılamadı')(error);
    app.quit();
  });
  app.on('activate', () => { if (!windows.size) openNewWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !hasTray()) app.quit(); });
  app.on('before-quit', event => {
    if ((server || serviceStartup) && !closing) {
      event.preventDefault();
      closing = true;
      const started = serviceStartup ? serviceStartup.catch(() => {}) : Promise.resolve();
      void started.then(() => server?.close()).catch(showError('AIWS servisi kapatılamadı')).finally(() => app.quit());
    }
  });
}
