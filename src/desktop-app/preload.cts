import { contextBridge, ipcRenderer } from 'electron';

type ZoomState = { percent: number; min: number; max: number; default: number };

// Sandboxed CommonJS preload: expose narrow operations, never ipcRenderer or Node APIs.
contextBridge.exposeInMainWorld('aiwsDesktop', Object.freeze({
  chooseDirectory: (options?: { defaultPath?: string; language?: 'tr' | 'en' }): Promise<{ canceled: boolean; path?: string; unsupported?: boolean; reason?: string }> => ipcRenderer.invoke('aiws:choose-project-directory', options),
  openProjectWindow: (projectId: string): Promise<void> => ipcRenderer.invoke('aiws:open-project-window', projectId),
  notifyQuestion: (request: { id: string; taskId: string; title: string; body: string }): Promise<boolean> => ipcRenderer.invoke('aiws:notify-question', request),
  window: Object.freeze({
    minimize: (): Promise<void> => ipcRenderer.invoke('aiws:window-minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('aiws:window-toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('aiws:window-close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('aiws:window-is-maximized'),
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: unknown, maximized: boolean): void => callback(maximized);
      ipcRenderer.on('aiws:window-maximized', listener);
      return () => { ipcRenderer.removeListener('aiws:window-maximized', listener); };
    },
  }),
  zoom: Object.freeze({
    get: (): Promise<ZoomState> => ipcRenderer.invoke('aiws:zoom-get'),
    change: (change: 'in' | 'out' | 'reset'): Promise<ZoomState> => ipcRenderer.invoke('aiws:zoom-change', change),
    onChange: (callback: (state: ZoomState) => void): (() => void) => {
      const listener = (_event: unknown, state: ZoomState): void => callback(state);
      ipcRenderer.on('aiws:zoom-changed', listener);
      return () => { ipcRenderer.removeListener('aiws:zoom-changed', listener); };
    },
  }),
  onOpenQuestion: (callback: (request: { taskId: string; questionId: string }) => void): (() => void) => {
    const listener = (_event: unknown, request: { taskId: string; questionId: string }): void => callback(request);
    ipcRenderer.on('aiws:open-question', listener);
    return () => { ipcRenderer.removeListener('aiws:open-question', listener); };
  },
}));
