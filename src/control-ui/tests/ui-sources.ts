import { readFile } from 'node:fs/promises';
import { Script, type Context } from 'node:vm';

// The interface's own scripts and stylesheets, in the order index.html loads them. Tests read them from here
// so splitting a file only changes index.html.
const root = new URL('../', import.meta.url);

async function indexHtml(): Promise<string> {
  return readFile(new URL('index.html', root), 'utf8');
}

function localPaths(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map(match => match[1]!).filter(path => !path.startsWith('/vendor/')).map(path => path.slice(1));
}

async function joined(paths: string[], separator: string): Promise<string> {
  return (await Promise.all(paths.map(path => readFile(new URL(path, root), 'utf8')))).join(separator);
}

/** Relative paths of the local scripts index.html loads, in order. */
export async function uiScriptPaths(): Promise<string[]> {
  return localPaths(await indexHtml(), /<script[^>]*\ssrc="([^"]+)"/g);
}

/** Relative paths of the local stylesheets index.html loads, in order. */
export async function uiStylePaths(): Promise<string[]> {
  return localPaths(await indexHtml(), /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g);
}

/** The application shell's scripts: the files under app/. */
export const isAppScript = (path: string): boolean => path.startsWith('app/');

/**
 * The local scripts as one program. Classic scripts share one global scope, so evaluating them together behaves like
 * the browser loading them one after another. `filter` limits the program to some of them (in index.html order).
 */
export async function uiScriptSource(filter: (path: string) => boolean = () => true): Promise<string> {
  return joined((await uiScriptPaths()).filter(filter), '\n;\n');
}

/** Every local stylesheet, concatenated in load order. */
export async function uiStyleSource(): Promise<string> {
  return joined(await uiStylePaths(), '\n');
}

/**
 * Runs the local scripts in a happy-dom window one by one, as the browser does: each is its own classic script in the
 * window's global scope, so top-level declarations are shared but a script cannot use what a later one declares.
 */
export async function runUiScripts(window: object, filter: (path: string) => boolean = () => true): Promise<void> {
  for (const path of (await uiScriptPaths()).filter(filter)) {
    new Script(await readFile(new URL(path, root), 'utf8'), { filename: path }).runInContext(window as Context);
  }
}

/**
 * Closes a test window for good. happy-dom keeps every window's frame in a shared browser context until
 * `happyDOM.close()`; `window.close()` leaves it there, so a long test file would keep every window in memory.
 * `idle` reports whether the page still has requests in flight: closing empties the document, so the page's
 * own responses must land before that or their renders fail on a closed window.
 */
export async function closeWindow(window: { happyDOM: { abort(): Promise<void>; close(): Promise<void> }; dispatchEvent(event: unknown): boolean; Event: new (type: string) => unknown }, idle: () => boolean = () => true): Promise<void> {
  window.dispatchEvent(new window.Event('pagehide'));
  for (const end = Date.now() + 5000; Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (idle()) break;
  }
  await window.happyDOM.abort();
  await window.happyDOM.close();
}
