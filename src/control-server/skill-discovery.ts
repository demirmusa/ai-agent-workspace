import { opendir, lstat, realpath, readFile, mkdir, rename, rm, unlink, rmdir, writeFile, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { isPathInside } from '../shared/core/paths.js';
import { SKILL_LIMITS, readSkillTree as readTree, type SkillTreeFile as TreeFile } from './catalog.js';
import { readTextHead } from './source-files.js';
import { jsonObject } from './validation.js';
import { ControlError, type Project } from './types.js';

export type SkillScope = 'global' | 'project' | 'plugin';
export type SkillProvider = 'claude' | 'codex' | 'agents';
export interface SkillDiscoveryOptions { home?: string; claudeHome?: string; codexHome?: string; agentsHome?: string; cacheMs?: number }
export interface SkillLocation { id: string; scope: SkillScope; provider: SkillProvider; projectId?: string; label: string; path: string; exists: boolean; writable: boolean; error?: string }
export interface DiscoveredSkill {
  id: string; key: string; name: string; description: string; locationId: string; scope: SkillScope; provider: SkillProvider; projectId?: string;
  path: string; linkedTo?: string; files: number; bytes: number; fingerprint: string | null; error?: string;
}
export interface SkillDiscoveryResult { scannedAt: string; locations: SkillLocation[]; skills: DiscoveredSkill[]; warnings: string[] }
export interface SkillShareResult { locationId: string; path: string; status: 'copy' | 'copied' | 'unchanged' | 'conflict' | 'overwritten'; diff?: { added: string[]; removed: string[]; changed: string[] } }
interface LocationSpec extends SkillLocation { base: string; parts: string[] }
interface ResolvedSkill { location: LocationSpec; key: string; path: string; real: string; linked: boolean }

export const DISCOVERY_LIMITS = { skillsPerRoot: 200, entriesPerRoot: 5000, plugins: 64, projects: 200, scanBytes: 64 * 1024 * 1024, targets: 64 };
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const same = (left: string, right: string): boolean => caseless ? left.toLowerCase() === right.toLowerCase() : left === right;
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** Reads `name` and `description` from a SKILL.md YAML frontmatter block (plain, quoted and block scalars). */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content); if (!match) return {};
  const lines = match[1]!.split(/\r?\n/); const result: { name?: string; description?: string } = {};
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description)[ \t]*:[ \t]*(.*)$/.exec(lines[index]!); if (!field) continue;
    let value = field[2]!.replace(/[ \t]+#.*$/, '').trim();
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = []; while (index + 1 < lines.length && (/^[ \t]+\S/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) block.push(lines[++index]!.trim());
      value = value.startsWith('|') ? block.join('\n').trim() : block.filter(Boolean).join(' ');
    } else if (/^"(?:[^"\\]|\\.)*"$/.test(field[2]!.trim())) { const raw = field[2]!.trim(); try { value = JSON.parse(raw) as string; } catch { value = raw.slice(1, -1); } }
    else if (/^'(?:[^']|'')*'$/.test(field[2]!.trim())) value = field[2]!.trim().slice(1, -1).replace(/''/g, "'");
    else while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]!)) value += ` ${lines[++index]!.trim()}`;
    result[field[1] as 'name' | 'description'] = value.slice(0, 2000);
  }
  return result;
}

async function digests(files: TreeFile[]): Promise<Map<string, string>> {
  const result = new Map<string, string>(); for (const file of files) result.set(file.path, createHash('sha256').update(await readFile(file.absolute)).digest('hex')); return result;
}
function fingerprint(hashes: Map<string, string>): string {
  const hash = createHash('sha256'); for (const [path, digest] of [...hashes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) hash.update(`${path}\0${digest}\n`); return hash.digest('hex');
}

/**
 * Finds skills in their well-known provider folders (global homes, installed Claude plugins and every
 * registered project) and copies them between those folders. Only these roots are ever read or written.
 */
export class SkillDiscovery {
  private readonly roots: { claude: string; codex: string; agents: string };
  private readonly cacheMs: number;
  private cache: { key: string; at: number; value: SkillDiscoveryResult } | undefined;
  private flight: { key: string; generation: number; promise: Promise<SkillDiscoveryResult> } | undefined;
  private generation = 0;
  constructor(options: SkillDiscoveryOptions = {}) {
    const home = options.home ?? homedir();
    this.roots = { claude: resolve(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')), codex: resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex')), agents: resolve(options.agentsHome ?? join(home, '.agents')) };
    this.cacheMs = options.cacheMs ?? 5 * 60_000;
  }
  invalidate(): void { this.cache = undefined; this.generation++; }
  private async plugins(): Promise<LocationSpec[]> {
    const pluginRoot = join(this.roots.claude, 'plugins'); let manifest: unknown;
    try { manifest = JSON.parse(await readFile(join(pluginRoot, 'installed_plugins.json'), 'utf8')); } catch { return []; }
    const plugins = (manifest as { plugins?: unknown } | null)?.plugins; if (!plugins || typeof plugins !== 'object') return [];
    let realRoot: string; try { realRoot = await realpath(pluginRoot); } catch { return []; }
    const result: LocationSpec[] = [];
    for (const [name, installs] of Object.entries(plugins as Record<string, unknown>).slice(0, DISCOVERY_LIMITS.plugins)) {
      const install = Array.isArray(installs) ? installs[0] as { installPath?: unknown } | undefined : undefined;
      if (typeof install?.installPath !== 'string' || !isAbsolute(install.installPath) || !/^[A-Za-z0-9@._-]{1,200}$/.test(name)) continue;
      let base: string; try { base = await realpath(install.installPath); } catch { continue; }
      // Installed plugin paths come from a provider file; only folders inside the Claude plugin store are trusted.
      if (!isPathInside(realRoot, base)) continue;
      result.push({ id: `plugin:${name}`, scope: 'plugin', provider: 'claude', label: name, path: join(base, 'skills'), exists: false, writable: false, base, parts: ['skills'] });
    }
    return result;
  }
  private async specs(projects: Project[]): Promise<LocationSpec[]> {
    const global = (provider: SkillProvider, base: string, parts = ['skills'], writable = true, suffix = ''): LocationSpec =>
      ({ id: `global:${provider}${suffix}`, scope: 'global', provider, label: suffix ? `${provider} system` : provider, path: join(base, ...parts), exists: false, writable, base, parts });
    const result = [global('claude', this.roots.claude), global('codex', this.roots.codex), global('codex', this.roots.codex, ['skills', '.system'], false, ':system'), global('agents', this.roots.agents)];
    for (const project of projects.slice(0, DISCOVERY_LIMITS.projects)) {
      if (!/^[A-Za-z0-9_-]+$/.test(project.id) || !isAbsolute(project.repositoryPath)) continue;
      for (const provider of ['claude', 'codex', 'agents'] as const) result.push({ id: `project:${project.id}:${provider}`, scope: 'project', provider, projectId: project.id, label: project.name, path: join(project.repositoryPath, `.${provider}`, 'skills'), exists: false, writable: true, base: resolve(project.repositoryPath), parts: [`.${provider}`, 'skills'] });
    }
    return [...result, ...await this.plugins()];
  }
  /** Resolves a location folder below its trusted base without following symbolic links. */
  private async root(spec: LocationSpec, create = false): Promise<string | null> {
    let current: string; try { current = await realpath(spec.base); } catch { return null; }
    for (const part of spec.parts) {
      current = join(current, part);
      try { const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ControlError(`Skill folder ${current} is a symbolic link or not a folder.`, 409); }
      catch (error) {
        if (error instanceof ControlError) throw error;
        if (errorCode(error) !== 'ENOENT' || !create) return null;
        await mkdir(current);
      }
    }
    return current;
  }
  private projectsKey(projects: Project[]): string { return JSON.stringify(projects.map((project) => [project.id, project.name, project.repositoryPath])); }
  async discover(projects: Project[], options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<SkillDiscoveryResult> {
    const key = this.projectsKey(projects);
    if (!options.refresh && this.cache?.key === key && Date.now() - this.cache.at < this.cacheMs) return this.cache.value;
    if (this.flight?.key !== key || this.flight.generation !== this.generation) {
      const generation = this.generation;
      const promise = this.scan(projects).then((value) => { if (generation === this.generation) this.cache = { key, at: Date.now(), value }; return value; })
        .finally(() => { if (this.flight?.promise === promise) this.flight = undefined; });
      this.flight = { key, generation, promise };
    }
    const { promise } = this.flight; const signal = options.signal; if (!signal) return promise;
    // A cancelled request stops waiting; the bounded scan still completes and warms the cache.
    return new Promise((resolvePromise, reject) => {
      const abort = (): void => reject(new ControlError('Skill discovery was cancelled.', 499));
      if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true });
      promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private async scan(projects: Project[]): Promise<SkillDiscoveryResult> {
    const specs = await this.specs(projects); const warnings: string[] = []; const skills: DiscoveredSkill[] = []; const roots = new Map<string, string>(); let budget = DISCOVERY_LIMITS.scanBytes;
    for (const spec of specs) { try { const root = await this.root(spec); if (root) { roots.set(spec.id, await realpath(root)); spec.exists = true; } } catch (error) { spec.error = (error as Error).message; spec.writable = false; } }
    for (const spec of specs) {
      const root = roots.get(spec.id); if (!root) continue; let visited = 0, found = 0;
      try {
        for await (const entry of await opendir(root)) {
          if (++visited > DISCOVERY_LIMITS.entriesPerRoot) { warnings.push(`${spec.path}: too many entries; the rest was skipped.`); break; }
          if (!KEY.test(entry.name)) continue;
          const resolved = await this.entry(spec, root, entry.name, roots); if (!resolved) continue;
          if (++found > DISCOVERY_LIMITS.skillsPerRoot) { warnings.push(`${spec.path}: more than ${DISCOVERY_LIMITS.skillsPerRoot} skills; the rest was skipped.`); break; }
          const skill: DiscoveredSkill = { id: `${spec.id}/${entry.name}`, key: entry.name, name: entry.name, description: '', locationId: spec.id, scope: spec.scope, provider: spec.provider,
            ...(spec.projectId ? { projectId: spec.projectId } : {}), path: join(root, entry.name), ...(resolved.linked ? { linkedTo: resolved.real } : {}), files: 0, bytes: 0, fingerprint: null };
          if (resolved.error) { skill.error = resolved.error; skills.push(skill); continue; }
          try {
            const head = parseSkillFrontmatter(await readTextHead(join(resolved.real, 'SKILL.md'), SKILL_LIMITS.fileBytes));
            if (head.name) skill.name = head.name; if (head.description) skill.description = head.description;
            const files = await readTree(resolved.real); skill.files = files.length - 1; skill.bytes = files.reduce((sum, file) => sum + file.size, 0);
            if (budget >= skill.bytes) { budget -= skill.bytes; skill.fingerprint = fingerprint(await digests(files)); }
          } catch (error) { skill.error = error instanceof ControlError ? error.message : 'SKILL.md cannot be read.'; }
          skills.push(skill);
        }
      } catch (error) { spec.error = error instanceof ControlError ? error.message : 'Skill folder cannot be listed.'; }
    }
    return { scannedAt: new Date().toISOString(), locations: specs.map(({ base: _base, parts: _parts, ...location }) => location), skills, warnings };
  }
  /** A skill is a folder (or a link to a skill folder in another known root) containing SKILL.md. */
  private async entry(spec: LocationSpec, root: string, key: string, roots: Map<string, string>): Promise<{ real: string; linked: boolean; error?: string } | null> {
    const path = join(root, key); let stat; try { stat = await lstat(path); } catch { return null; }
    let real = path, linked = false;
    if (stat.isSymbolicLink()) {
      linked = true; try { real = await realpath(path); } catch { return null; }
      const target = [...roots.values()].some((value) => same(dirname(real), value));
      if (!target) return { real, linked, error: 'Linked outside the known skill folders; skipped.' };
      try { if (!(await lstat(real)).isDirectory()) return null; } catch { return null; }
    } else if (!stat.isDirectory()) return null;
    try { const manifest = await lstat(join(real, 'SKILL.md')); if (!manifest.isFile()) return null; } catch { return null; }
    return { real, linked };
  }
  private async known(projects: Project[]): Promise<{ specs: LocationSpec[]; roots: Map<string, string> }> {
    const specs = await this.specs(projects); const roots = new Map<string, string>();
    for (const spec of specs) { try { const root = await this.root(spec); if (root) roots.set(spec.id, await realpath(root)); } catch { /* Unsafe roots stay unavailable. */ } }
    return { specs, roots };
  }
  /** Maps a discovery ID back to its folder; only known roots and direct child folder names are accepted. */
  async resolve(projects: Project[], id: unknown): Promise<ResolvedSkill> {
    if (typeof id !== 'string' || id.length > 512 || id.includes('\0')) throw new ControlError('A discovered skill ID is required.');
    const slash = id.lastIndexOf('/'); const locationId = id.slice(0, slash), key = id.slice(slash + 1);
    if (slash < 1 || !KEY.test(key)) throw new ControlError('Invalid discovered skill ID.');
    const { specs, roots } = await this.known(projects); const location = specs.find((spec) => spec.id === locationId); const root = roots.get(locationId);
    if (!location || !root) throw new ControlError('Skill folder not found.', 404);
    const entry = await this.entry(location, root, key, roots); if (!entry) throw new ControlError('Skill not found.', 404);
    if (entry.error) throw new ControlError(entry.error, 409);
    return { location, key, path: join(root, key), real: entry.real, linked: entry.linked };
  }
  async share(projects: Project[], raw: unknown): Promise<{ applied: boolean; results: SkillShareResult[] }> {
    const input = jsonObject(raw);
    const source = await this.resolve(projects, input.sourceId);
    const targets = input.targets, overwrite = input.overwrite ?? [];
    if (!Array.isArray(targets) || !targets.length || targets.length > DISCOVERY_LIMITS.targets || targets.some((value) => typeof value !== 'string')) throw new ControlError('Choose between 1 and 64 target folders.');
    if (!Array.isArray(overwrite) || overwrite.some((value) => typeof value !== 'string')) throw new ControlError('overwrite must list target folder IDs.');
    const files = await readTree(source.real); const hashes = await digests(files); const sourcePrint = fingerprint(hashes);
    const specs = await this.specs(projects); const plan: Array<SkillShareResult & { spec: LocationSpec }> = [];
    for (const targetId of new Set(targets as string[])) {
      const spec = specs.find((value) => value.id === targetId); if (!spec) throw new ControlError(`Unknown skill folder: ${targetId}`, 404);
      if (!spec.writable) throw new ControlError(`${spec.path} is read-only.`, 403);
      if (spec.id === source.location.id) continue;
      const root = await this.root(spec); const path = join(root ?? spec.path, source.key); const result: SkillShareResult & { spec: LocationSpec } = { spec, locationId: spec.id, path, status: 'copy' };
      let existing; try { existing = root ? await lstat(path) : undefined; } catch { existing = undefined; }
      if (existing) {
        let real = path; if (existing.isSymbolicLink()) { try { real = await realpath(path); } catch { real = ''; } }
        if (real && same(real, source.real)) result.status = 'unchanged';
        else {
          let other = new Map<string, string>(); try { if (real) other = await digests(await readTree(real)); } catch { /* An unreadable folder still counts as a different skill. */ }
          if (other.size && fingerprint(other) === sourcePrint) result.status = 'unchanged';
          else {
            result.status = 'conflict';
            result.diff = { added: [...hashes.keys()].filter((key) => !other.has(key)).slice(0, 20), removed: [...other.keys()].filter((key) => !hashes.has(key)).slice(0, 20), changed: [...hashes].filter(([key, value]) => other.has(key) && other.get(key) !== value).map(([key]) => key).slice(0, 20) };
          }
        }
      }
      plan.push(result);
    }
    const blocked = plan.some((item) => item.status === 'conflict' && !(overwrite as string[]).includes(item.locationId));
    if (!blocked) {
      const contents = new Map<string, Buffer>(); for (const file of files) contents.set(file.path, await readFile(file.absolute));
      for (const item of plan.filter((value) => value.status !== 'unchanged')) {
        const root = await this.root(item.spec, true); if (!root) throw new ControlError(`Project folder for ${item.spec.label} is unavailable.`, 404);
        const target = join(root, source.key), staging = join(root, `.${source.key}.aiws-${randomUUID()}`);
        await mkdir(staging);
        try {
          for (const file of files) {
            const destination = join(staging, ...file.path.split('/')); if (!isPathInside(staging, destination)) throw new ControlError('Unsafe skill resource path.');
            await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, contents.get(file.path)!, { flag: 'wx' }); if (file.executable) await chmod(destination, 0o755);
          }
          if (item.status === 'conflict') { await this.discard(target); item.status = 'overwritten'; } else item.status = 'copied';
          await rename(staging, target);
        } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
      }
      this.invalidate();
    }
    return { applied: !blocked, results: plan.map(({ spec: _spec, ...item }) => item) };
  }
  /** Removes a link itself, or a plain folder after confirming that nothing inside it links elsewhere. */
  private async discard(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) { try { await unlink(path); } catch { await rmdir(path); } return; }
    let count = 0; const check = async (directory: string, depth: number): Promise<void> => {
      if (depth > 16) throw new ControlError('Skill folder is nested too deeply to remove safely.');
      for await (const entry of await opendir(directory)) {
        if (++count > 5000) throw new ControlError('Skill folder is too large to remove safely.');
        const child = join(directory, entry.name); const info = await lstat(child);
        if (info.isSymbolicLink()) throw new ControlError('Skill folder contains symbolic links; remove it manually.', 409);
        if (info.isDirectory()) await check(child, depth + 1);
      }
    };
    await check(path, 0);
    const trash = join(dirname(path), `.${randomUUID()}.aiws-removed`); await rename(path, trash); await rm(trash, { recursive: true, force: true });
  }
  async remove(projects: Project[], raw: unknown): Promise<{ removed: string }> {
    const target = await this.resolve(projects, jsonObject(raw).id);
    if (!target.location.writable) throw new ControlError('This skill folder is read-only.', 403);
    // Removing a link never loses content; a real folder must have another independent copy left.
    const current = target.linked ? undefined : await this.discover(projects, { refresh: true });
    const copies = !current ? [true] : current.skills.filter((skill) => skill.key === target.key && skill.id !== `${target.location.id}/${target.key}` && !skill.error && !same(skill.linkedTo ?? skill.path, target.real));
    if (current?.skills.some((skill) => skill.linkedTo && same(skill.linkedTo, target.real))) throw new ControlError('Other skill folders link to this copy. Remove those links first.', 409);
    if (!copies.length) throw new ControlError('This is the only copy of the skill. Remove it manually if you really want to delete it.', 409);
    await this.discard(target.path); this.invalidate(); return { removed: target.path };
  }
}
