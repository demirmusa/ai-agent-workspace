import { dialog, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { trustedSender, windows } from './window-registry.js';
import { changeZoom, loadZoom, zoomState } from './window-zoom.js';

/** Main-process side of the preload bridge (preload.cts); every channel validates its sender and input. */
export function registerIpcHandlers(openProjectWindow: (projectId: string) => void): void {
  const notifiedQuestions = new Set<string>();
  const notifications = new Set<Notification>();
  let pickerBusy = false;

  ipcMain.handle('aiws:notify-question', async (event: IpcMainInvokeEvent, input: unknown) => {
    const owner = trustedSender(event, 'notification');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid notification.');
    const fields = input as Record<string, unknown>;
    for (const [key, limit] of [['id', 160], ['taskId', 160], ['title', 240], ['body', 1000]] as const) {
      if (typeof fields[key] !== 'string' || !fields[key] || fields[key].length > limit) throw new Error('Invalid notification.');
    }
    if (!Notification.isSupported()) return false;
    const id = fields.id as string;
    if (notifiedQuestions.has(id)) return true;
    const notification = new Notification({ title: fields.title as string, body: fields.body as string });
    notifiedQuestions.add(id);
    if (notifiedQuestions.size > 1000) notifiedQuestions.delete(notifiedQuestions.values().next().value!);
    notifications.add(notification);
    notification.on('click', () => {
      if (owner.isDestroyed() || !windows.has(owner)) return;
      if (owner.isMinimized()) owner.restore();
      owner.show(); owner.focus(); owner.webContents.send('aiws:open-question', { taskId: fields.taskId, questionId: id });
    });
    notification.on('close', () => notifications.delete(notification));
    notification.on('failed', () => { notifications.delete(notification); notifiedQuestions.delete(id); });
    notification.show();
    return true;
  });

  ipcMain.handle('aiws:choose-project-directory', async (event: IpcMainInvokeEvent, input: unknown) => {
    const owner = trustedSender(event, 'directory picker');
    // A client folder is not necessarily available on a remote/Docker backend.
    if (process.env.AIWS_CONTROL_URL) return { canceled: false, unsupported: true, reason: 'remote-backend' };
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('Directory picker options must be an object.');
    const options = (input ?? {}) as Record<string, unknown>;
    if (Object.keys(options).some((key) => !['defaultPath', 'language'].includes(key))) throw new Error('Unsupported directory picker option.');
    if (options.language !== undefined && options.language !== 'tr' && options.language !== 'en') throw new Error('Unsupported directory picker language.');
    let defaultPath: string | undefined;
    if (options.defaultPath !== undefined && options.defaultPath !== '') {
      if (typeof options.defaultPath !== 'string' || options.defaultPath.length > 4096 || options.defaultPath.includes('\0') || !isAbsolute(options.defaultPath)) throw new Error('Default directory must be an absolute path.');
      defaultPath = await realpath(options.defaultPath);
      if (!(await stat(defaultPath)).isDirectory()) throw new Error('Default path must be a directory.');
    }
    if (pickerBusy) throw new Error('Directory picker is already open.');
    pickerBusy = true;
    try {
      const result = await dialog.showOpenDialog(owner, { title: options.language === 'en' ? 'Choose project folder' : 'Proje klasörünü seç', properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
      if (result.canceled || !result.filePaths.length || !windows.has(owner)) return { canceled: true };
      const selected = result.filePaths[0]!;
      if (!isAbsolute(selected)) throw new Error('The selected directory must be an absolute path.');
      const path = await realpath(selected);
      if (!(await stat(path)).isDirectory()) throw new Error('The selected path is not a directory.');
      return { canceled: false, path };
    } finally { pickerBusy = false; }
  });

  ipcMain.handle('aiws:open-project-window', async (event: IpcMainInvokeEvent, input: unknown) => {
    trustedSender(event, 'menu');
    if (typeof input !== 'string' || !input || input.length > 160) throw new Error('Invalid project.');
    openProjectWindow(input);
  });

  ipcMain.handle('aiws:window-minimize', (event: IpcMainInvokeEvent) => { trustedSender(event, 'window').minimize(); });
  ipcMain.handle('aiws:window-toggle-maximize', (event: IpcMainInvokeEvent) => {
    const owner = trustedSender(event, 'window');
    if (owner.isMaximized()) owner.unmaximize(); else owner.maximize();
    return owner.isMaximized();
  });
  ipcMain.handle('aiws:window-close', (event: IpcMainInvokeEvent) => { trustedSender(event, 'window').close(); });
  ipcMain.handle('aiws:window-is-maximized', (event: IpcMainInvokeEvent) => trustedSender(event, 'window').isMaximized());
  ipcMain.handle('aiws:zoom-get', async (event: IpcMainInvokeEvent) => { trustedSender(event, 'zoom'); return zoomState(await loadZoom()); });
  ipcMain.handle('aiws:zoom-change', async (event: IpcMainInvokeEvent, input: unknown) => {
    trustedSender(event, 'zoom');
    if (input !== 'in' && input !== 'out' && input !== 'reset') throw new Error('Invalid zoom change.');
    return changeZoom(input);
  });
}
