import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const mocks = vi.hoisted(() => ({
  events: new Map<string, (...args: any[]) => void>(),
  ipc: new Map<string, (...args: any[]) => Promise<unknown>>(),
  windows: [] as any[],
  start: vi.fn(), close: vi.fn(), quit: vi.fn(), external: vi.fn(), showError: vi.fn(), pickDirectory: vi.fn(),
  notifications: [] as any[], trays: [] as any[], login: { openAtLogin: false } as { openAtLogin: boolean },
}));
vi.mock('../service-host.js', () => ({ DESKTOP_SERVICE_PORT: 47317, startOwnedService: mocks.start }));
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (name: string, handler: (...args: any[]) => void) => mocks.events.set(name, handler),
    quit: mocks.quit,
    setAppUserModelId: vi.fn(),
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: mocks.login.openAtLogin }),
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => { mocks.login.openAtLogin = settings.openAtLogin; },
  },
  Tray: class {
    listeners = new Map<string, (...args: any[]) => void>(); menu: any; tooltip = '';
    constructor(public image: unknown) { mocks.trays.push(this); }
    setToolTip(value: string) { this.tooltip = value; }
    setContextMenu(menu: unknown) { this.menu = menu; }
    on(name: string, handler: (...args: any[]) => void) { this.listeners.set(name, handler); }
  },
  Menu: { buildFromTemplate: (items: unknown[]) => Object.assign(items, { popup: vi.fn() }) },
  nativeImage: { createFromBuffer: (buffer: Buffer) => ({ buffer }) },
  BrowserWindow: class {
    options: unknown;
    listeners = new Map<string, (...args: any[]) => void>();
    webContents = {
      mainFrame: { url: 'http://127.0.0.1:4319/' },
      send: vi.fn(),
      listeners: new Map<string, (...args: any[]) => void>(),
      on: (name: string, handler: (...args: any[]) => void) => this.webContents.listeners.set(name, handler),
      setWindowOpenHandler: (handler: unknown) => { (this.webContents as any).open = handler; },
      session: {
        setPermissionRequestHandler: (handler: unknown) => { (this.webContents as any).permission = handler; },
        setPermissionCheckHandler: (handler: unknown) => { (this.webContents as any).permissionCheck = handler; },
      },
    };
    constructor(options: unknown) { this.options = options; mocks.windows.push(this); }
    once(name: string, handler: (...args: any[]) => void) { this.listeners.set(name, handler); }
    on(name: string, handler: (...args: any[]) => void) { this.listeners.set(name, handler); }
    loadURL = vi.fn().mockResolvedValue(undefined);
    show = vi.fn(); hide = vi.fn(); focus = vi.fn(); restore = vi.fn(); isMinimized = () => false; isDestroyed = () => false; isVisible = () => true;
  },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => mocks.ipc.set(channel, handler) },
  Notification: class {
    static isSupported() { return true; }
    listeners = new Map<string, (...args: any[]) => void>();
    constructor(public options: unknown) { mocks.notifications.push(this); }
    on(name: string, handler: (...args: any[]) => void) { this.listeners.set(name, handler); }
    show = vi.fn();
  },
  shell: { openExternal: mocks.external }, dialog: { showErrorBox: mocks.showError, showOpenDialog: mocks.pickDirectory },
}));

describe('Electron control center boundary', () => {
  let dataDirectory: string;
  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'aiws-desktop-test-'));
    vi.stubEnv('AIWS_CONTROL_DATA_DIR', dataDirectory);
    vi.resetModules(); mocks.events.clear(); mocks.ipc.clear(); mocks.windows.length = 0; mocks.notifications.length = 0; mocks.trays.length = 0; mocks.login.openAtLogin = false;
    mocks.start.mockResolvedValue({ url: 'http://127.0.0.1:4319', close: mocks.close });
    mocks.close.mockResolvedValue(undefined); vi.stubEnv('AIWS_CONTROL_URL', '');
    mocks.pickDirectory.mockReset(); mocks.pickDirectory.mockResolvedValue({ canceled: true, filePaths: [] });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dataDirectory, { recursive: true, force: true }); });
  it('sandboxes the renderer, blocks foreign navigation and permissions, and closes its owned server', async () => {
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const window = mocks.windows[0];
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false });
    expect(isAbsolute(window.options.webPreferences.preload)).toBe(true); expect(window.options.webPreferences.preload).toMatch(/preload\.cjs$/);
    expect(mocks.start).toHaveBeenCalledWith({ host: '127.0.0.1', port: 47317 });
    const sameOrigin = { preventDefault: vi.fn() };
    window.webContents.listeners.get('will-navigate')(sameOrigin, 'http://127.0.0.1:4319/app');
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const foreign = { preventDefault: vi.fn() };
    window.webContents.listeners.get('will-navigate')(foreign, 'https://example.com');
    expect(foreign.preventDefault).toHaveBeenCalledOnce();
    const redirect = { preventDefault: vi.fn() };
    window.webContents.listeners.get('will-redirect')(redirect, 'https://example.com/login');
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.permissionCheck({}, 'clipboard-sanitized-write', 'http://127.0.0.1:4319')).toBe(true);
    expect(window.webContents.permissionCheck({}, 'geolocation', 'http://127.0.0.1:4319')).toBe(false);
    expect(window.webContents.permissionCheck({}, 'media', 'https://example.com')).toBe(false);
    expect(window.webContents.open({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(window.webContents.open({ url: 'https://github.com/owner/repository' })).toEqual({ action: 'deny' });
    expect(mocks.external).toHaveBeenCalledWith('https://github.com/owner/repository');
    const permission = vi.fn(); window.webContents.permission({}, 'camera', permission, { requestingUrl: 'http://127.0.0.1:4319/' }); expect(permission).toHaveBeenCalledWith(false);
    const copy = vi.fn(); window.webContents.permission({}, 'clipboard-sanitized-write', copy, { requestingUrl: 'http://127.0.0.1:4319/' }); expect(copy).toHaveBeenCalledWith(true);
    const foreignCopy = vi.fn(); window.webContents.permission({}, 'clipboard-sanitized-write', foreignCopy, { requestingUrl: 'https://example.com/' }); expect(foreignCopy).toHaveBeenCalledWith(false);
    const mic = vi.fn(); window.webContents.permission({}, 'media', mic, { requestingUrl: 'http://127.0.0.1:4319/', mediaTypes: ['audio'] }); expect(mic).toHaveBeenCalledWith(true);
    const video = vi.fn(); window.webContents.permission({}, 'media', video, { requestingUrl: 'http://127.0.0.1:4319/', mediaTypes: ['audio', 'video'] }); expect(video).toHaveBeenCalledWith(false);
    const foreignMic = vi.fn(); window.webContents.permission({}, 'media', foreignMic, { requestingUrl: 'https://example.com/', mediaTypes: ['audio'] }); expect(foreignMic).toHaveBeenCalledWith(false);
    const read = vi.fn(); window.webContents.permission({}, 'clipboard-read', read, { requestingUrl: 'http://127.0.0.1:4319/' }); expect(read).toHaveBeenCalledWith(false);
    const quit = { preventDefault: vi.fn() }; mocks.events.get('before-quit')!(quit);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(quit.preventDefault).toHaveBeenCalledOnce();
    mocks.events.get('before-quit')!({ preventDefault: vi.fn() }); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('keeps the owned service running in the tray when the window closes and offers start at login', async () => {
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    expect(mocks.trays).toHaveLength(1);
    const tray = mocks.trays[0]; const window = mocks.windows[0];
    expect(tray.image.buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
    const close = { preventDefault: vi.fn() }; window.listeners.get('close')(close);
    expect(close.preventDefault).toHaveBeenCalledOnce(); expect(window.hide).toHaveBeenCalledOnce();
    expect(mocks.notifications).toHaveLength(1); expect(mocks.close).not.toHaveBeenCalled();
    mocks.events.get('window-all-closed')!(); expect(mocks.quit).not.toHaveBeenCalled();
    const startAtLogin = tray.menu.find((item: any) => item.type === 'checkbox');
    startAtLogin.click({ checked: true }); expect(mocks.login.openAtLogin).toBe(true);
    tray.listeners.get('click')(); expect(window.show).toHaveBeenCalled();
    const quit = { preventDefault: vi.fn() }; mocks.events.get('before-quit')!(quit);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    const finalClose = { preventDefault: vi.fn() }; window.listeners.get('close')(finalClose);
    expect(finalClose.preventDefault).not.toHaveBeenCalled();
  });
  it('opens extra windows on the same service and only the last one falls back to the tray', async () => {
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const tray = mocks.trays[0];
    tray.menu.find((item: any) => item.label === 'Yeni pencere').click();
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(2));
    expect(mocks.start).toHaveBeenCalledOnce();
    const [first, second] = mocks.windows;
    const extraClose = { preventDefault: vi.fn() }; first.listeners.get('close')(extraClose);
    expect(extraClose.preventDefault).not.toHaveBeenCalled(); first.listeners.get('closed')();
    const lastClose = { preventDefault: vi.fn() }; second.listeners.get('close')(lastClose);
    expect(lastClose.preventDefault).toHaveBeenCalledOnce();
  });
  it('shares pending service startup with second launches and activation', async () => {
    let ready!: (service: unknown) => void;
    mocks.start.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    mocks.events.get('second-instance')!();
    mocks.events.get('activate')!();
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    ready({ url: 'http://127.0.0.1:4319', close: mocks.close });
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(3));
    expect(mocks.start).toHaveBeenCalledOnce();
    for (const window of mocks.windows) expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:4319/');
  });
  it('reports startup failure to all pending window requests without loading a failed service', async () => {
    let fail!: (error: Error) => void;
    mocks.start.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    mocks.events.get('activate')!();
    mocks.trays[0].listeners.get('click')();
    fail(new Error('Control data directory is already in use'));
    await vi.waitFor(() => expect(mocks.showError).toHaveBeenCalledTimes(3));
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.quit).toHaveBeenCalled();
  });
  it('closes a service that becomes ready while the application is quitting', async () => {
    let ready!: (service: unknown) => void;
    mocks.start.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    const quit = { preventDefault: vi.fn() }; mocks.events.get('before-quit')!(quit);
    expect(quit.preventDefault).toHaveBeenCalledOnce();
    ready({ url: 'http://127.0.0.1:4319', close: mocks.close });
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalled());
    expect(mocks.windows).toHaveLength(0);
  });
  it('supervises replacement services and handles window reload failures', async () => {
    const exits: Array<(code: number) => void> = [];
    mocks.start.mockImplementation(async () => ({ url: 'http://127.0.0.1:4319', close: mocks.close, onUnexpectedExit: (listener: (code: number) => void) => exits.push(listener) }));
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const window = mocks.windows[0];
    window.loadURL.mockRejectedValueOnce(new Error('ERR_FAILED'));
    exits[0](1);
    await vi.waitFor(() => expect(mocks.showError).toHaveBeenCalledWith('AIWS servisi yeniden başlatılamadı', 'ERR_FAILED'));
    expect(exits).toHaveLength(2);
    exits[1](1);
    await vi.waitFor(() => expect(exits).toHaveLength(3));
    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(window.loadURL).toHaveBeenCalledTimes(3);
  });
  it('opens a project in a new window from the renderer context menu', async () => {
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const window = mocks.windows[0]; const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    await mocks.ipc.get('aiws:open-project-window')!(event, 'project_1');
    await expect(mocks.ipc.get('aiws:open-project-window')!({ sender: {}, senderFrame: event.senderFrame }, 'project_1')).rejects.toThrow('Untrusted');
    // A same-origin subframe (for example a plugin iframe) cannot drive the native bridge.
    await expect(mocks.ipc.get('aiws:open-project-window')!({ sender: window.webContents, senderFrame: { url: 'http://127.0.0.1:4319/' } }, 'project_1')).rejects.toThrow('Untrusted');
  });
  it('connects to an explicit remote URL without starting or shutting down a remote service', async () => {
    vi.stubEnv('AIWS_CONTROL_URL', 'https://control.example.test');
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.windows[0].loadURL).toHaveBeenCalledWith('https://control.example.test/');
    const quit = { preventDefault: vi.fn() }; mocks.events.get('before-quit')!(quit);
    expect(quit.preventDefault).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it('rejects non-HTTP URLs before creating a window', async () => {
    vi.stubEnv('AIWS_CONTROL_URL', 'file:///tmp/page.html');
    await import('../main.js');
    await vi.waitFor(() => expect(mocks.showError).toHaveBeenCalled());
    expect(mocks.windows).toHaveLength(0); expect(mocks.quit).toHaveBeenCalled();
  });
  it('opens only a native directory picker for the trusted main frame and returns canonical paths or cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws desktop folder '));
    try {
      const actual = join(directory, 'project'); const linked = join(directory, 'project-link'); await mkdir(actual); await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await import('../main.js'); await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
      const window = mocks.windows[0]; const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
      const choose = mocks.ipc.get('aiws:choose-project-directory')!;
      mocks.pickDirectory.mockResolvedValueOnce({ canceled: false, filePaths: [linked] });
      await expect(choose(event, { defaultPath: linked })).resolves.toEqual({ canceled: false, path: await realpath(actual) });
      expect(mocks.pickDirectory).toHaveBeenCalledWith(window, { title: 'Proje klasörünü seç', properties: ['openDirectory'], defaultPath: await realpath(actual) });
      await expect(choose(event, { language: 'en' })).resolves.toEqual({ canceled: true });
      expect(mocks.pickDirectory).toHaveBeenLastCalledWith(window, { title: 'Choose project folder', properties: ['openDirectory'] });
      await expect(choose(event, { language: 'fr' })).rejects.toThrow('Unsupported directory picker language');
      mocks.pickDirectory.mockResolvedValueOnce({ canceled: true, filePaths: [] }); await expect(choose(event, {})).resolves.toEqual({ canceled: true });
      const file = join(directory, 'file.txt'); await writeFile(file, 'not a folder'); mocks.pickDirectory.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
      await expect(choose(event, {})).rejects.toThrow('not a directory');
      await expect(choose(event, { defaultPath: 'relative' })).rejects.toThrow('absolute path');
      await expect(choose(event, { properties: ['openFile'] })).rejects.toThrow('Unsupported');
      await expect(choose({ sender: {}, senderFrame: event.senderFrame }, {})).rejects.toThrow('Untrusted');
      await expect(choose({ sender: window.webContents, senderFrame: { url: event.senderFrame.url } }, {})).rejects.toThrow('Untrusted');
      event.senderFrame.url = 'https://untrusted.example/'; await expect(choose(event, {})).rejects.toThrow('Untrusted');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('requires server-side folder selection for remote backends and never opens a client picker', async () => {
    vi.stubEnv('AIWS_CONTROL_URL', 'https://control.example.test'); await import('../main.js'); await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const window = mocks.windows[0]; window.webContents.mainFrame.url = 'https://control.example.test/';
    await expect(mocks.ipc.get('aiws:choose-project-directory')!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, {})).resolves.toEqual({ canceled: false, unsupported: true, reason: 'remote-backend' });
    expect(mocks.pickDirectory).not.toHaveBeenCalled();
  });
  it('validates notification senders, deduplicates requests, and opens the task when clicked', async () => {
    await import('../main.js'); await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
    const window = mocks.windows[0], event = {sender:window.webContents,senderFrame:window.webContents.mainFrame};
    const notify = mocks.ipc.get('aiws:notify-question')!;
    const request = {id:'question_1',taskId:'task_1',title:'Onayın gerekiyor',body:'Project · Task: Allow command?'};
    await expect(notify({sender:{},senderFrame:event.senderFrame},request)).rejects.toThrow('Untrusted');
    await expect(notify(event,{...request,body:'x'.repeat(1001)})).rejects.toThrow('Invalid');
    await expect(notify(event,request)).resolves.toBe(true); await notify(event,request);
    expect(mocks.notifications).toHaveLength(1); expect(mocks.notifications[0].show).toHaveBeenCalledOnce();
    mocks.notifications[0].listeners.get('click')();
    expect(window.focus).toHaveBeenCalled(); expect(window.webContents.send).toHaveBeenCalledWith('aiws:open-question',{taskId:'task_1',questionId:'question_1'});
  });
  it('changes the zoom level in steps, applies it at once, resets it and restores it after a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-zoom-')); vi.stubEnv('AIWS_CONTROL_DATA_DIR', directory);
    try {
      await import('../main.js'); await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
      const window = mocks.windows[0]; window.webContents.setZoomFactor = vi.fn(); window.webContents.mainFrame.url = 'http://127.0.0.1:4319/';
      const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
      const change = mocks.ipc.get('aiws:zoom-change')!;
      expect(window.options.webPreferences.zoomFactor).toBe(1);
      await expect(change({ sender: {}, senderFrame: event.senderFrame }, 'in')).rejects.toThrow('Untrusted');
      await expect(change(event, 3)).rejects.toThrow('Invalid');
      await expect(change(event, 'in')).resolves.toMatchObject({ percent: 110 });
      expect(window.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.1);
      expect(window.webContents.send).toHaveBeenLastCalledWith('aiws:zoom-changed', expect.objectContaining({ percent: 110 }));
      await expect(change(event, 'reset')).resolves.toMatchObject({ percent: 100 });
      for (let press = 0; press < 12; press++) await change(event, 'out');
      await expect(mocks.ipc.get('aiws:zoom-get')!(event)).resolves.toMatchObject({ percent: 50, min: 50 });
      // Turkish Q: + is Shift+4, so the shortcut reads the produced character. AltGr (Ctrl+Alt) is not a zoom key.
      const press = (key: string, alt = false) => { const input = { preventDefault: vi.fn() }; window.webContents.listeners.get('before-input-event')(input, { type: 'keyDown', control: true, meta: false, shift: true, alt, key }); return input.preventDefault; };
      expect(press('+')).toHaveBeenCalledOnce(); expect(press('+', true)).not.toHaveBeenCalled(); expect(press('4')).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(window.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.6));
      await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'desktop-zoom.json'), 'utf8'))).toEqual({ percent: 60 }));
      vi.resetModules(); mocks.windows.length = 0;
      await import('../main.js'); await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
      expect(mocks.windows[0].options.webPreferences.zoomFactor).toBe(0.6);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('exposes only the namespaced directory-picker bridge from the sandbox-compatible CommonJS preload', async () => {
    const expose = vi.fn(); const invoke = vi.fn().mockResolvedValue({ canceled: true });
    const source = readFileSync(new URL('../preload.cts', import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const load = (platform: string) => { runInNewContext(output, { exports: {}, process: { platform }, require: (name: string) => { expect(name).toBe('electron'); return { contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }; } }); return expose.mock.calls.at(-1)!; };
    const [name, bridge] = load('win32'); expect(expose).toHaveBeenCalledOnce();
    expect(name).toBe('aiwsDesktop'); expect(Object.keys(bridge)).toEqual(['chooseDirectory','openProjectWindow','notifyQuestion','window','zoom','onOpenQuestion']); expect(Object.isFrozen(bridge)).toBe(true);
    await expect(bridge.chooseDirectory({ defaultPath: 'C:\\Projects' })).resolves.toEqual({ canceled: true });
    expect(invoke).toHaveBeenCalledWith('aiws:choose-project-directory', { defaultPath: 'C:\\Projects' });
  });
});
