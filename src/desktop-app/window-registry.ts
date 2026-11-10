import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/** Every open window shares the one owned service; each is an independent view of it. */
export const windows = new Set<BrowserWindow>();
let lastFocused: BrowserWindow | null = null;
/** Origin of the control service the windows show; IPC is accepted only from it. */
let rendererOrigin: string | null = null;

export function setRendererOrigin(origin: string): void { rendererOrigin = origin; }
export function isRendererOrigin(origin: string): boolean { return rendererOrigin !== null && origin === rendererOrigin; }

export function trackWindow(window: BrowserWindow): void {
  windows.add(window); lastFocused = window;
  window.on('focus', () => { lastFocused = window; });
}
export function untrackWindow(window: BrowserWindow): void {
  windows.delete(window);
  if (lastFocused === window) lastFocused = null;
}

export function primaryWindow(): BrowserWindow | null {
  return lastFocused && windows.has(lastFocused) && !lastFocused.isDestroyed() ? lastFocused : [...windows].find(item => !item.isDestroyed()) ?? null;
}

/**
 * The window whose main frame, on the control service origin, sent this IPC request. Subframes (plugin
 * iframes, embedded content) and foreign origins are rejected, so only the trusted page can use the bridge.
 */
export function trustedSender(event: IpcMainInvokeEvent, label: string): BrowserWindow {
  const owner = [...windows].find(candidate => !candidate.isDestroyed() && event.sender === candidate.webContents);
  let origin = '';
  try { origin = new URL(event.senderFrame?.url ?? '').origin; } catch { /* Rejected below. */ }
  if (!owner || event.senderFrame !== owner.webContents.mainFrame || !isRendererOrigin(origin)) throw new Error(`Untrusted ${label} request.`);
  return owner;
}
