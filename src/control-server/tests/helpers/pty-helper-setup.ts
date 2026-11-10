import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const transpile = (file: string): string => ts.transpileModule(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

/**
 * Tasks run in a PTY by default, and the runner starts the compiled pty-host.js next to it, which only exists in dist.
 * Compiles the production helper once per test run so tests started from source use the real PTY path.
 */
export function compilePtyHelper(root: string): string {
  const windowsHelper = join(root, 'windows-launch.mjs'), helper = join(root, 'pty-host.mjs'), nativeModule = createRequire(import.meta.url).resolve('node-pty');
  writeFileSync(windowsHelper, transpile('windows-launch.ts'));
  writeFileSync(helper, transpile('pty-host.ts')
    .replace(/from ['"]node-pty['"]/, `from ${JSON.stringify(pathToFileURL(nativeModule).href)}`).replace(/from ['"]\.\/windows-launch\.js['"]/, `from ${JSON.stringify(pathToFileURL(windowsHelper).href)}`));
  return helper;
}

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'aiws-pty-helper-'));
  process.env.AIWS_CONTROL_PTY_HELPER ??= compilePtyHelper(root);
  process.env.AIWS_NODE_BINARY ??= process.execPath;
  return () => rmSync(root, { recursive: true, force: true });
}
