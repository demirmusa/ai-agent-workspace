import { app, Menu, nativeImage, Tray } from 'electron';
import { fileURLToPath } from 'node:url';
import { appIcon } from './app-icon.js';

let tray: Tray | null = null;

/** True while the tray icon exists: the local service then keeps running with every window closed. */
export const hasTray = (): boolean => tray !== null;

/** Login launches reopen this exact entry point hidden, so GitHub work keeps flowing while the computer is on. */
function loginItem(): { path: string; args: string[] } {
  const entry = fileURLToPath(new URL('./main.js', import.meta.url));
  return { path: process.execPath, args: app.isPackaged ? ['--hidden'] : [entry, '--hidden'] };
}

export function createTray(actions: { showWindow: () => void; openNewWindow: () => void }): void {
  if (tray || process.env.AIWS_CONTROL_URL) return;
  try {
    tray = new Tray(nativeImage.createFromBuffer(appIcon()));
    tray.setToolTip('AI Agent Workspace · GitHub işleri arka planda alınır');
    const menu = () => Menu.buildFromTemplate([
      { label: 'AI Agent Workspace\'i göster', click: actions.showWindow },
      { label: 'Yeni pencere', click: actions.openNewWindow },
      { label: 'Bilgisayar açılınca başlat', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin,
        click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, ...loginItem() }); tray?.setContextMenu(menu()); } },
      { type: 'separator' },
      { label: 'Çıkış (agentları durdurur)', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu());
    tray.on('click', actions.showWindow);
  } catch { tray = null; }
}
