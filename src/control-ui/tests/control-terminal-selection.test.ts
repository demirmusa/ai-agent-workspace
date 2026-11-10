import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { expect, it, vi } from 'vitest';

it('copies a terminal selection through the browser while preserving PTY interrupt keys', async () => {
  const window = new Window();
  let selected = true;
  let keyHandler!: (event: KeyboardEvent) => boolean;
  const onInput = vi.fn();
  class Terminal {
    options = {};
    open() {}
    attachCustomKeyEventHandler(handler: typeof keyHandler) { keyHandler = handler; }
    hasSelection() { return selected; }
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    write() {}
    dispose() {}
  }
  Object.assign(window, { Terminal, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  window.eval(await readFile(new URL('../terminal.js', import.meta.url), 'utf8'));
  const host = window.document.createElement('div');window.document.body.append(host);
  const view = (window as any).AIWSTerminal.create(host, { run: { id: 'copy-test', terminalMode: 'pty', status: 'running' }, onInput, onResize: vi.fn() });
  const key = (options: KeyboardEventInit) => new window.KeyboardEvent('keydown', { key: 'c', ...options }) as unknown as KeyboardEvent;
  expect(keyHandler(key({ ctrlKey: true }))).toBe(false);
  expect(keyHandler(key({ metaKey: true }))).toBe(false);
  expect(keyHandler(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(keyHandler(key({ ctrlKey: true, altKey: true }))).toBe(true);
  expect(keyHandler(key({}))).toBe(true);
  selected = false;
  expect(keyHandler(key({ ctrlKey: true }))).toBe(true);
  // Ctrl+V is left to the browser so xterm receives the paste event.
  expect(keyHandler(key({ key: 'v', ctrlKey: true }))).toBe(false);
  expect(keyHandler(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(keyHandler(key({ key: 'v', metaKey: true }))).toBe(false);
  expect(keyHandler(key({ key: 'v' }))).toBe(true);
  view.update({ id: 'copy-test', terminalMode: 'pty', status: 'completed' });
  selected = true;
  expect(keyHandler(key({ ctrlKey: true }))).toBe(false);
  expect(onInput).not.toHaveBeenCalled();
  view.destroy();await window.happyDOM.abort();await window.happyDOM.close();
});

it('dictates into a live terminal in order with its keys, keeps the shortcut from the PTY and closes on Enter', async () => {
  const window = new Window();
  const onInput = vi.fn(async (_data: string) => {});
  let emit!: (data: string) => void, xtermKeys = 0;
  class Terminal {
    options = {};
    open(target: HTMLElement) {
      target.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
      target.querySelector('textarea')!.addEventListener('keydown', () => { xtermKeys++; });
    }
    attachCustomKeyEventHandler() {}
    onData(callback: typeof emit) { emit = callback; return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    write() {}
    dispose() {}
  }
  const sockets: Array<{ onmessage: (event: { data: string }) => void; close: () => void }> = [];
  class FakeSocket { static OPEN = 1; readyState = 1; onmessage = (_event: { data: string }) => {}; onclose = null; onerror = null; binaryType = ''; constructor() { sockets.push(this); } send() {} close() {} }
  Object.assign(window, {
    Terminal, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, WebSocket: FakeSocket,
    AudioContext: class { audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {} }; } close() { return Promise.resolve(); } },
    AudioWorkletNode: class { port = { onmessage: null }; },
    AIWSUI: { providerIcon: () => '', icon: () => '' }, AIWSI18n: { language: 'tr', text: (value: string) => value },
  });
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  for (const file of ['../terminal.js', '../voice/field-writer.js', '../voice/caret.js', '../voice.js']) window.eval(await readFile(new URL(file, import.meta.url), 'utf8'));
  const proto = (window as any).HTMLElement.prototype;
  Object.assign(proto, { showPopover() {}, hidePopover() {} });
  (window as any).AIWSVoice.setup({ provider: () => 'claude' });
  const host = window.document.createElement('div');window.document.body.append(host);
  const view = (window as any).AIWSTerminal.create(host, { run: { id: 'voice-test', terminalMode: 'pty', status: 'running' }, onInput, onResize: vi.fn() });
  const area = host.querySelector('textarea') as unknown as HTMLTextAreaElement;
  area.focus();
  const press = (init: KeyboardEventInit) => area.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as unknown as Event);
  const message = (data: unknown) => sockets[0]!.onmessage({ data: JSON.stringify(data) });
  const sent = () => onInput.mock.calls.map(call => call[0]).join('');
  const settled = () => vi.waitFor(() => expect(sent()).toContain('\r'));

  press({ code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  expect(xtermKeys).toBe(0); // Ctrl+M would reach the program as Enter.
  message({ type: 'ready' });
  emit('ls');
  message({ type: 'transcript', text: 'birinci', final: true });
  message({ type: 'transcript', text: 'ikinci', final: false });
  press({ key: 'Enter' });
  expect(xtermKeys).toBe(1); // Enter still reaches xterm...
  emit('\r'); // ...which sends it after the text that was heard.
  await settled();
  expect(sent()).toBe('ls birinci ikinci\r');
  expect((window.document.querySelector('#voice-panel') as HTMLElement).dataset.state).toBeUndefined();

  // A finished run takes no input, so dictation does not start in its terminal.
  view.update({ id: 'voice-test', terminalMode: 'pty', status: 'completed' });
  press({ code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sockets).toHaveLength(1);
  view.destroy();await window.happyDOM.abort();await window.happyDOM.close();
});

it('types the absolute path of a file dropped from the files panel, quoted when it has spaces', async () => {
  const window = new Window();
  const onInput = vi.fn();
  class Terminal {
    options = {};
    open() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    write() {}
    dispose() {}
  }
  const pathType = 'application/x-aiws-absolute-path';
  Object.assign(window, { Terminal, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, AIWSFiles: { absolutePathType: pathType } });
  window.eval(await readFile(new URL('../terminal.js', import.meta.url), 'utf8'));
  const host = window.document.createElement('div');window.document.body.append(host);
  const view = (window as any).AIWSTerminal.create(host, { run: { id: 'drop-test', terminalMode: 'pty', status: 'running' }, onInput, onResize: vi.fn() });
  const drag = (type: string, path: string) => {
    const data: Record<string, string> = { [pathType]: path, 'text/plain': 'relative' };
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as any;
    event.dataTransfer = { types: Object.keys(data), getData: (key: string) => data[key] ?? '', dropEffect: 'none' };
    view.element.dispatchEvent(event);
    return event;
  };
  expect(drag('dragover', 'C:\\repo\\a.ts').defaultPrevented).toBe(true);
  expect(view.element.classList.contains('path-drop-target')).toBe(true);
  expect(drag('drop', 'C:\\repo\\a.ts').defaultPrevented).toBe(true);
  expect(view.element.classList.contains('path-drop-target')).toBe(false);
  drag('drop', 'C:\\my repo\\b.ts');
  await vi.waitFor(() => expect(onInput.mock.calls).toEqual([['C:\\repo\\a.ts '], ['"C:\\my repo\\b.ts" ']]));
  view.update({ id: 'drop-test', terminalMode: 'pty', status: 'completed' });
  expect(drag('drop', 'C:\\repo\\c.ts').defaultPrevented).toBe(false);
  view.destroy();await window.happyDOM.abort();await window.happyDOM.close();
});

it('repaints live terminals from the theme tokens when the theme changes', async () => {
  const window = new Window();
  class Terminal {
    options: any;
    constructor(options: any) { this.options = options; }
    open() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    write() {}
    dispose() {}
  }
  const root = window.document.documentElement;
  const tokens: Record<string, Record<string, string>> = {
    dark: { '--terminal': '#000000', '--terminal-ansi-bright-red': '#ff0000', '--terminal-min-contrast': '1' },
    light: { '--terminal': '#ffffff', '--terminal-ansi-bright-red': '#aa0000', '--terminal-min-contrast': '4.5' },
  };
  root.dataset.theme = 'dark';
  Object.assign(window, { Terminal, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, getComputedStyle: () => ({ getPropertyValue: (name: string) => tokens[root.dataset.theme as string][name] || '' }) });
  window.eval(await readFile(new URL('../terminal.js', import.meta.url), 'utf8'));
  const host = window.document.createElement('div');window.document.body.append(host);
  const view = (window as any).AIWSTerminal.create(host, { run: { id: 'theme-test', terminalMode: 'pty', status: 'running' }, onInput: vi.fn(), onResize: vi.fn() });
  expect(view.terminal.options.theme.background).toBe('#000000');
  expect(view.terminal.options.minimumContrastRatio).toBe(1);
  root.dataset.theme = 'light';
  await vi.waitFor(() => expect(view.terminal.options.theme.background).toBe('#ffffff'));
  expect(view.terminal.options.theme.brightRed).toBe('#aa0000');
  expect(view.terminal.options.minimumContrastRatio).toBe(4.5);
  view.destroy();await window.happyDOM.abort();await window.happyDOM.close();
});
