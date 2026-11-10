import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { isPathInside, toPosixPath } from '../shared/core/paths.js';
import { quotePosixShell } from '../shared/core/shell.js';
import { ControlError, type RunScript } from './types.js';

const extensions = new Set(['.ps1', '.sh', '.bash', '.bat', '.cmd']);
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'venv', '.venv', '__pycache__', 'target', '.next']);
const MAX_SCRIPTS = 50, MAX_CANDIDATES = 200, MAX_DEPTH = 5;

/** Resolves a script path against the repository and rejects anything that escapes it or is not a supported script file. */
export function resolveScriptPath(repositoryPath: string, path: string, npm = false): { absolute: string; relative: string } {
  const absolute = resolve(repositoryPath, path);
  const inside = relative(repositoryPath, absolute);
  if (!inside || !isPathInside(resolve(repositoryPath), absolute)) throw new ControlError('Run scripts must be files inside the project folder.');
  if (npm ? basename(absolute) !== 'package.json' : !extensions.has(extname(absolute).toLowerCase())) throw new ControlError(npm ? 'npm scripts must come from a package.json file.' : 'Run scripts must be .ps1, .sh, .bash, .bat or .cmd files.');
  let real: string;
  try { real = realpathSync.native(absolute); if (!statSync(real).isFile()) throw new Error(); } catch { throw new ControlError(`Script not found: ${toPosixPath(inside)}`, 404); }
  if (!isPathInside(realpathSync.native(repositoryPath), real)) throw new ControlError('Run scripts must be files inside the project folder.');
  return { absolute: real, relative: toPosixPath(inside) };
}

/** The scripts of a package.json; unreadable or malformed files have none. */
function packageScripts(file: string): Record<string, unknown> {
  try { const scripts = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: unknown }).scripts; return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts as Record<string, unknown> : {}; } catch { return {}; }
}

/** Validates the settings list: named scripts that exist in the repository. Unchanged entries keep their id. */
export function validateRunScripts(value: unknown, repositoryPath: string, previous: RunScript[] = []): RunScript[] {
  if (!Array.isArray(value)) throw new ControlError('runScripts must be a list.');
  if (value.length > MAX_SCRIPTS) throw new ControlError(`At most ${MAX_SCRIPTS} run scripts are allowed.`);
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ControlError('Each run script needs a name and a path or command.');
    const { id, name, path, npmScript, command, args, askArgs } = item as Record<string, unknown>;
    if (askArgs !== undefined && typeof askArgs !== 'boolean') throw new ControlError('askArgs must be true or false.');
    if (args !== undefined && (typeof args !== 'string' || args.length > 1_000)) throw new ControlError('Script arguments must be text (maximum 1000 characters).');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 80) throw new ControlError('Run script names must be 1-80 characters.');
    const known = typeof id === 'string' && previous.some((entry) => entry.id === id) ? id : `script_${randomUUID()}`;
    if (ids.has(known)) throw new ControlError('Run script ids must be unique.');
    ids.add(known);
    const extra = { ...(typeof args === 'string' && args.trim() ? { args: args.trim() } : {}), ...(askArgs ? { askArgs: true } : {}) };
    if (command !== undefined) {
      if (typeof command !== 'string' || !command.trim() || command.length > 2_000) throw new ControlError('Custom commands must be 1-2000 characters.');
      if (path !== undefined || npmScript !== undefined) throw new ControlError('A run script is either a custom command or a script file, not both.');
      return { id: known, name: trimmed, command: command.trim(), ...extra };
    }
    if (npmScript !== undefined && (typeof npmScript !== 'string' || !npmScript || npmScript.length > 200)) throw new ControlError('npmScript must be a script name.');
    if (typeof path !== 'string' || !path.trim() || path.length > 1_000) throw new ControlError('Each run script needs a path or a command.');
    const kept = previous.find((entry) => entry.id === known && entry.path === path.trim() && entry.npmScript === npmScript);
    // A saved script whose file was since deleted stays as it is, so the rest of the settings can still be saved or it can be removed.
    if (kept && !existsSync(resolve(repositoryPath, kept.path!))) return { id: known, name: trimmed, path: kept.path!, ...(typeof npmScript === 'string' ? { npmScript } : {}), ...extra };
    const resolved = resolveScriptPath(repositoryPath, path.trim(), npmScript !== undefined);
    if (typeof npmScript === 'string' && !(npmScript in packageScripts(resolved.absolute))) throw new ControlError(`package.json has no "${npmScript}" script.`);
    return { id: known, name: trimmed, path: resolved.relative, ...(typeof npmScript === 'string' ? { npmScript } : {}), ...extra };
  });
}

/** Script files found in the repository, for the picker in project settings. */
export async function findScriptCandidates(repositoryPath: string): Promise<{ files: string[]; npm: Array<{ path: string; scripts: string[] }> }> {
  const found: string[] = [], npm: Array<{ path: string; scripts: string[] }> = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= MAX_CANDIDATES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_CANDIDATES) return;
      if (entry.isFile() && entry.name === 'package.json') {
        const scripts = Object.keys(await readFile(join(directory, entry.name), 'utf8').then((text) => { const value = (JSON.parse(text) as { scripts?: unknown }).scripts; return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }, () => ({})));
        if (scripts.length) npm.push({ path: toPosixPath(relative(repositoryPath, join(directory, entry.name))), scripts });
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) found.push(toPosixPath(relative(repositoryPath, join(directory, entry.name))));
      else if (entry.isDirectory() && depth < MAX_DEPTH && !skippedDirectories.has(entry.name)) await walk(join(directory, entry.name), depth + 1);
    }
  };
  await walk(repositoryPath, 0);
  return { files: found, npm };
}

export interface PowerShellParameter { name: string; type: string; switch: boolean; defaultValue: string }
/** Finds the top-level param block and extracts its declared parameters for the run form. */
export function parsePowerShellParameters(source: string): PowerShellParameter[] {
  const searchable = [...source]; let scanQuote = '', scanLineComment = false, scanBlockComment = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!, next = source[index + 1];
    if (scanLineComment) { if (char === '\n') scanLineComment = false; else searchable[index] = ' '; continue; }
    if (scanBlockComment) { searchable[index] = char === '\n' ? '\n' : ' '; if (char === '#' && next === '>') { searchable[index + 1] = ' '; index++; scanBlockComment = false; } continue; }
    if (scanQuote) { searchable[index] = char === '\n' ? '\n' : ' '; if (scanQuote === "'" && char === "'" && next === "'") { searchable[index + 1] = ' '; index++; continue; } if (char === '`' && scanQuote === '"') { searchable[index + 1] = ' '; index++; continue; } if (char === scanQuote) scanQuote = ''; continue; }
    if (char === '#') { searchable[index] = ' '; scanLineComment = true; continue; }
    if (char === '<' && next === '#') { searchable[index] = ' '; searchable[index + 1] = ' '; index++; scanBlockComment = true; continue; }
    if (char === "'" || char === '"') { searchable[index] = ' '; scanQuote = char; }
  }
  const marker = /\bparam\s*\(/ig; let match: RegExpExecArray | null, block = '';
  while ((match = marker.exec(searchable.join('')))) {
    let depth = 1, quote = '', lineComment = false, blockComment = false, end = match.index + match[0].length;
    for (; end < source.length && depth; end++) {
      const char = source[end]!, next = source[end + 1];
      if (lineComment) { if (char === '\n') lineComment = false; continue; }
      if (blockComment) { if (char === '#' && next === '>') { blockComment = false; end++; } continue; }
      if (quote) { if (quote === "'" && char === "'" && next === "'") { end++; continue; } if (char === '`' && quote === '"') { end++; continue; } if (char === quote) quote = ''; continue; }
      if (char === '#' ) { lineComment = true; continue; }
      if (char === '<' && next === '#') { blockComment = true; end++; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '(') depth++; else if (char === ')') depth--;
    }
    if (!depth) { block = source.slice(match.index + match[0].length, end - 1); break; }
  }
  if (!block) return [];
  const declarations: string[] = []; let start = 0, round = 0, square = 0, brace = 0, quote = '', lineComment = false;
  for (let index = 0; index < block.length; index++) {
    const char = block[index]!, next = block[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (quote) { if (quote === "'" && char === "'" && next === "'") { index++; continue; } if (char === '`' && quote === '"') { index++; continue; } if (char === quote) quote = ''; continue; }
    if (char === '#') { lineComment = true; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') round++; else if (char === ')') round--;
    else if (char === '[') square++; else if (char === ']') square--;
    else if (char === '{') brace++; else if (char === '}') brace--;
    else if (char === ',' && !round && !square && !brace) { declarations.push(block.slice(start, index)); start = index + 1; }
  }
  declarations.push(block.slice(start));
  const parsed = declarations.flatMap((declaration) => {
    let variable: RegExpExecArray | null = null, square = 0, quote = '', lineComment = false, blockComment = false;
    for (let index = 0; index < declaration.length; index++) {
      const char = declaration[index]!, next = declaration[index + 1];
      if (lineComment) { if (char === '\n') lineComment = false; continue; }
      if (blockComment) { if (char === '#' && next === '>') { blockComment = false; index++; } continue; }
      if (quote) { if (quote === "'" && char === "'" && next === "'") { index++; continue; } if (char === '`' && quote === '"') { index++; continue; } if (char === quote) quote = ''; continue; }
      if (char === '#') { lineComment = true; continue; }
      if (char === '<' && next === '#') { blockComment = true; index++; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '[') square++; else if (char === ']') square--; else if (char === '$' && !square) { const found = /^\$([A-Za-z_]\w*)/.exec(declaration.slice(index)); if (found) { variable = Object.assign(found, { index }); break; } }
    }
    if (!variable) return [];
    const prefix = declaration.slice(0, variable.index), attributes = [...prefix.matchAll(/\[([A-Za-z_][\w.]*(?:\[\])?(?:\([^)]*\))?)\]/g)].map((item) => item[1]!.trim());
    const aliases = attributes.flatMap((item) => [...item.matchAll(/\bAlias\s*\(\s*['"]([^'"]+)['"]/ig)].map(alias => alias[1]!));
    const type = attributes.map(item=>item.replace(/\(.*$/,'')).find((item) => /^[A-Za-z_][\w.]*(?:\[\])?$/.test(item) && !/^(?:Parameter|Validate\w*|Alias|Allow\w*|PSDefaultValue|Obsolete|OutputType|Credential)(?:Attribute)?$/i.test(item)) || 'Object';
    const tail = declaration.slice(variable.index + variable[0].length), defaultValue = /^\s*=\s*([^\r\n,]+)/.exec(tail)?.[1]?.trim() || '';
    return [{ name: aliases[0] || variable[1]!, type, switch: /(?:^|\.)Switch(?:Parameter)?$/i.test(type), defaultValue, aliased: aliases.length > 0 }];
  });
  return parsed.map(({ aliased: _aliased, ...parameter })=>parameter);
}
/** Reads the parameter metadata from a repository-local PowerShell file. */
export async function powerShellScriptParameters(repositoryPath: string, path: string): Promise<PowerShellParameter[]> {
  const resolved = resolveScriptPath(repositoryPath, path);
  if (extname(resolved.absolute).toLowerCase() !== '.ps1') throw new ControlError('Parameters can only be scanned from .ps1 files.');
  const contents = await readFile(resolved.absolute, 'utf8');
  if (contents.length > 1_000_000) throw new ControlError('PowerShell script is too large to scan.');
  return parsePowerShellParameters(contents);
}

/** Splits an argument line into words; single and double quotes group words, a backslash escapes a double quote inside double quotes. */
export function splitScriptArgs(line = ''): string[] {
  const words: string[] = [];
  let current = '', quote = '', started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\' && line[index + 1] === '"') current += line[++index];
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started || current) words.push(current); current = ''; started = false; }
    else current += char;
  }
  if (started || current) words.push(current);
  return words;
}

// PowerShell also ends a single-quoted string at the typographic quotes ‘ ’ ‚ ‛, so each is doubled like '.
const psQuote = (value: string): string => `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
const shQuote = quotePosixShell;

/** The command line a run script types into its terminal, written for that platform's interactive shell (PowerShell on Windows, sh elsewhere). */
export function scriptLine(target: { command: string } | { absolute: string; npmScript?: string; bash?: string }, args = '', platform = process.platform): string {
  if ('command' in target) return [target.command, ...args.split(/\r?\n/)].map((part) => part.trim()).filter(Boolean).join(' ');
  const windows = platform === 'win32', quote = windows ? psQuote : shQuote, words = (list: string[]): string => list.map(quote).join(' ');
  const list = splitScriptArgs(args), { absolute } = target, tail = list.length ? ` ${words(list)}` : '';
  if (target.npmScript !== undefined) return `npm --prefix ${quote(dirname(absolute))} run ${quote(target.npmScript)}${list.length ? ` -- ${words(list)}` : ''}`;
  const extension = extname(absolute).toLowerCase();
  if (extension === '.ps1') return `${windows ? 'powershell -ExecutionPolicy Bypass' : 'pwsh'} -File ${quote(absolute)}${tail}`;
  if (extension === '.bat' || extension === '.cmd') return `${windows ? '& ' : ''}${quote(absolute)}${tail}`;
  const script = quote(windows ? absolute.replaceAll('\\', '/') : absolute);
  return `${target.bash ? `${windows ? '& ' : ''}${quote(target.bash)}` : 'bash'} ${script}${tail}`;
}
