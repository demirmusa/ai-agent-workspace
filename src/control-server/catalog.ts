import { lstatSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonObject } from './validation.js';
import { ControlError, type AgentDefinition, type AgentTemplateSource, type SkillDefinition, type SkillFile, type Provider, type ExecutionSnapshot } from './types.js';
import type { ControlStore } from './store.js';
import { aiProviders } from './ai-providers/index.js';

export const SKILL_LIMITS = { files: 64, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 };
const own = (input: object, key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);
function text(value: unknown, name: string, max: number, fallback = ''): string {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || result.length > max || result.includes('\u0000')) throw new ControlError(`${name} must be text, at most ${max} characters, without NUL bytes.`); return result;
}
export function validateSkillPath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 240 || /[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ControlError('Skill resource paths must be safe relative paths using forward slashes.');
  if (path.split('/')[0]?.toLowerCase() === 'skill.md') throw new ControlError('Use content for the root SKILL.md, not a resource file or directory.'); return path;
}
export function decodeSkillFile(file: SkillFile): Buffer {
  if (file.encoding === 'base64') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new ControlError('Invalid base64 skill resource.');
    return Buffer.from(file.content, 'base64');
  }
  return Buffer.from(file.content, 'utf8');
}
export function validateSkillFiles(content: string, input: unknown): SkillFile[] {
  let total = Buffer.byteLength(content, 'utf8'); if (total > SKILL_LIMITS.fileBytes) throw new ControlError('SKILL.md exceeds 256 KiB.');
  if (!Array.isArray(input) || input.length > SKILL_LIMITS.files) throw new ControlError('A skill may contain at most 64 resource files.');
  const paths = new Set<string>(); const files: SkillFile[] = [];
  for (const raw of input) {
    const value = jsonObject(raw); const path = validateSkillPath(value.path);
    if (paths.has(path.toLowerCase())) throw new ControlError('Skill resource paths must be unique, including case.'); paths.add(path.toLowerCase());
    const file: SkillFile = { path, content: text(value.content, 'file content', 400_000), ...(value.encoding === undefined ? {} : { encoding: value.encoding as SkillFile['encoding'] & {} }), ...(value.executable === undefined ? {} : { executable: value.executable as boolean }) };
    if (file.encoding !== undefined && file.encoding !== 'utf8' && file.encoding !== 'base64') throw new ControlError('Skill file encoding must be utf8 or base64.');
    if (file.executable !== undefined && typeof file.executable !== 'boolean') throw new ControlError('Skill executable must be a boolean.');
    const bytes = decodeSkillFile(file).byteLength; if (bytes > SKILL_LIMITS.fileBytes) throw new ControlError('A skill resource exceeds 256 KiB.'); total += bytes; files.push(file);
  }
  if (total > SKILL_LIMITS.totalBytes) throw new ControlError('Skill content and resources exceed 1 MiB.');
  for (const path of paths) for (const other of paths) if (path !== other && path.startsWith(`${other}/`)) throw new ControlError('A skill path cannot be both a file and a directory.');
  return files;
}

export class ControlCatalog {
  constructor(private store: ControlStore, private changed: () => void) {}
  agent(agentId: string): AgentDefinition {
    const item = this.store.state.agents.find((value) => value.id === agentId); if (!item) throw new ControlError('Agent profile not found.', 404); return item;
  }
  skill(skillId: string): SkillDefinition {
    const item = this.store.state.skills.find((value) => value.id === skillId); if (!item) throw new ControlError('Skill not found.', 404); return item;
  }
  skillIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string')) throw new ControlError('skillIds must contain at most 32 skill IDs.');
    for (const skillId of value as string[]) if (!this.store.state.skills.some((skill) => skill.id === skillId)) throw new ControlError(`Unknown skill: ${skillId}`);
    return [...new Set(value as string[])];
  }
  private agentFields(input: Record<string, unknown>, previous?: AgentDefinition): Omit<AgentDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
    const name = text(input.name, 'name', 200, previous?.name).trim(); if (!name) throw new ControlError('Agent name is required.');
    const provider = input.provider ?? previous?.provider ?? this.store.state.settings.defaultProvider; if (provider !== 'command' && !aiProviders.has(provider)) throw new ControlError('Invalid agent provider.');
    const model = own(input, 'model') ? input.model === null ? undefined : text(input.model, 'model', 200) : previous?.model;
    // A level kept from another provider is dropped when the provider changes; an explicit choice must fit the provider.
    const efforts = provider === 'command' ? [] : aiProviders.require(String(provider)).reasoningEfforts;
    const effortInput = own(input, 'reasoningEffort') ? input.reasoningEffort === null || input.reasoningEffort === '' ? undefined : input.reasoningEffort : previous?.reasoningEffort;
    if (own(input, 'reasoningEffort') && effortInput !== undefined && (typeof effortInput !== 'string' || !efforts.includes(effortInput))) throw new ControlError(efforts.length ? `reasoningEffort must be one of ${efforts.join(', ')}.` : 'The selected provider has no reasoning levels.');
    const reasoningEffort = typeof effortInput === 'string' && efforts.includes(effortInput) ? effortInput : undefined;
    const command = own(input, 'command') ? input.command === null ? undefined : jsonObject(input.command) : previous?.command;
    if (command && (typeof command.executable !== 'string' || !command.executable.trim() || command.executable.length > 4096 || !Array.isArray(command.args) || command.args.length > 200 || command.args.some((arg) => typeof arg !== 'string' || arg.length > 100_000))) throw new ControlError('Agent command requires executable and string args.');
    if (provider === 'command' && !command) throw new ControlError('Command agent requires a command.');
    const enabled = input.enabled ?? previous?.enabled ?? true; if (typeof enabled !== 'boolean') throw new ControlError('enabled must be a boolean.');
    const capabilities = input.capabilities ?? previous?.capabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some((item) => typeof item !== 'string' || item.length > 200)) throw new ControlError('capabilities must contain at most 32 text labels.');
    const terminalMode = input.terminalMode ?? previous?.terminalMode ?? 'pty';
    if (!['stream', 'pty'].includes(String(terminalMode))) throw new ControlError('terminalMode must be stream or pty.');
    let templateSource = previous?.templateSource;
    if (own(input, 'templateSource')) {
      if (input.templateSource === null) templateSource = undefined;
      else {
        const source = jsonObject(input.templateSource);
        const templateId = text(source.templateId, 'templateSource.templateId', 200);
        const revision = text(source.revision, 'templateSource.revision', 40);
        const repository = text(source.repository, 'templateSource.repository', 2048);
        const url = text(source.url, 'templateSource.url', 2048);
        const license = text(source.license, 'templateSource.license', 100);
        if (!/^voltagent:[a-z0-9.-]+$/.test(templateId) || !/^[a-f0-9]{40}$/.test(revision) || repository !== 'https://github.com/VoltAgent/awesome-claude-code-subagents' || !url.startsWith(`${repository}/blob/${revision}/categories/`) || /[\u0000-\u0020\u007f]/.test(url) || license !== 'MIT') throw new ControlError('Invalid community template attribution.');
        templateSource = { templateId, revision, repository, url, license } satisfies AgentTemplateSource;
      }
    }
    return { name, description: text(input.description, 'description', 20_000, previous?.description), provider: provider as Provider,
      instructions: text(input.instructions, 'instructions', 100_000, previous?.instructions), context: text(input.context, 'context', 100_000, previous?.context),
      skillIds: this.skillIds(input.skillIds ?? previous?.skillIds ?? []), enabled, capabilities: [...new Set(capabilities as string[])], terminalMode: terminalMode as 'stream' | 'pty',
      ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(command === undefined ? {} : { command: command as AgentDefinition['command'] & {} }), ...(templateSource === undefined ? {} : { templateSource }) };
  }
  createAgent(input: unknown): AgentDefinition {
    if (this.store.state.agents.length >= 200) throw new ControlError('Agent library limit is 200.');
    const timestamp = new Date().toISOString(); const value = { id: `agent_${randomUUID()}`, ...this.agentFields(jsonObject(input)), revision: 1, createdAt: timestamp, updatedAt: timestamp };
    this.store.state.agents.push(value); this.changed(); return structuredClone(value);
  }
  updateAgent(agentId: string, input: unknown): AgentDefinition {
    const value = this.agent(agentId); const fields = this.agentFields(jsonObject(input), value);
    delete value.model; delete value.reasoningEffort; delete value.command; delete value.templateSource; Object.assign(value, fields, { revision: value.revision + 1, updatedAt: new Date().toISOString() }); this.changed(); return structuredClone(value);
  }
  deleteAgent(agentId: string): void {
    this.agent(agentId); if (this.store.state.tasks.some((task) => task.agentId === agentId)) throw new ControlError('Agent is assigned to tasks. Unassign those tasks first.', 409);
    if (this.store.state.workflows.some((workflow) => workflow.steps.some((step) => step.agentId === agentId))) throw new ControlError('Agent is used by a workflow. Update that workflow first.', 409);
    this.store.state.agents = this.store.state.agents.filter((item) => item.id !== agentId); this.changed();
  }
  private skillFields(input: Record<string, unknown>, previous?: SkillDefinition): Omit<SkillDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
    const name = text(input.name, 'name', 200, previous?.name).trim(); if (!name) throw new ControlError('Skill name is required.');
    const content = text(input.content, 'content', SKILL_LIMITS.fileBytes, previous?.content); if (!content.trim()) throw new ControlError('SKILL.md content is required.');
    return { name, description: text(input.description, 'description', 20_000, previous?.description), content, files: validateSkillFiles(content, input.files ?? previous?.files ?? []) };
  }
  createSkill(input: unknown): SkillDefinition {
    if (this.store.state.skills.length >= 200) throw new ControlError('Skill library limit is 200.');
    const timestamp = new Date().toISOString(); const value = { id: `skill_${randomUUID()}`, ...this.skillFields(jsonObject(input)), revision: 1, createdAt: timestamp, updatedAt: timestamp };
    this.store.state.skills.push(value); this.changed(); return structuredClone(value);
  }
  updateSkill(skillId: string, input: unknown): SkillDefinition {
    const value = this.skill(skillId); const fields = this.skillFields(jsonObject(input), value);
    Object.assign(value, fields, { revision: value.revision + 1, updatedAt: new Date().toISOString() }); this.changed(); return structuredClone(value);
  }
  deleteSkill(skillId: string): void {
    this.skill(skillId);
    if (this.store.state.agents.some((agent) => agent.skillIds.includes(skillId)) || this.store.state.tasks.some((task) => task.skillIds?.includes(skillId))) throw new ControlError('Skill is referenced by an agent or task. Remove those references first.', 409);
    this.store.state.skills = this.store.state.skills.filter((skill) => skill.id !== skillId); this.changed();
  }
  /** Copies a skill folder of the server into the library, with the same limits as a skill written in the editor. */
  async importSkill(input: unknown): Promise<SkillDefinition> {
    const value = jsonObject(input); const directory = text(value.directory, 'directory', 4096);
    if (!isAbsolute(directory)) throw new ControlError('Skill directory must be an absolute server path.');
    try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); } catch { throw new ControlError('Skill directory must exist and cannot be a symlink.'); }
    let content: string | undefined; const files: SkillFile[] = [];
    for (const file of await readSkillTree(directory)) {
      if (file.path === 'SKILL.md') content = await readFile(file.absolute, 'utf8');
      else files.push({ path: file.path, content: (await readFile(file.absolute)).toString('base64'), encoding: 'base64', executable: file.executable });
    }
    return this.createSkill({ name: value.name ?? directory.split(/[\\/]/).filter(Boolean).pop(), description: value.description ?? '', content, files });
  }
}

export interface SkillTreeFile { path: string; absolute: string; size: number; executable: boolean }
/** Walks a skill folder with the library limits; symbolic links, .git and node_modules are refused. Sorted by path. */
export async function readSkillTree(directory: string, signal?: AbortSignal): Promise<SkillTreeFile[]> {
  const files: SkillTreeFile[] = []; let total = 0, resources = 0;
  const walk = async (root: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 12) throw new ControlError('Skill directory nesting exceeds 12 levels.');
    for await (const entry of await opendir(root)) {
      if (signal?.aborted) throw new ControlError('Skill discovery was cancelled.', 499);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = join(root, entry.name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new ControlError('Skill folders cannot contain symbolic links.');
      if (stat.isDirectory()) { if (['.git', 'node_modules'].includes(entry.name)) throw new ControlError('Skill folders cannot contain .git or node_modules.'); await walk(absolute, path, depth + 1); continue; }
      if (!stat.isFile()) throw new ControlError('Skill folders may contain only regular files.');
      if (stat.size > SKILL_LIMITS.fileBytes) throw new ControlError('A skill file exceeds 256 KiB.');
      total += stat.size; if (total > SKILL_LIMITS.totalBytes) throw new ControlError('Skill folder exceeds 1 MiB.');
      if (path !== 'SKILL.md') { validateSkillPath(path); if (++resources > SKILL_LIMITS.files) throw new ControlError('Skill folder contains more than 64 resources.'); }
      files.push({ path, absolute, size: stat.size, executable: !!(stat.mode & 0o111) });
    }
  };
  await walk(directory, '', 0);
  if (!files.some((file) => file.path === 'SKILL.md')) throw new ControlError('Skill folder must contain a root SKILL.md.');
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function materializeRunSkills(dataDir: string, runId: string, snapshot: ExecutionSnapshot): string | undefined {
  if (!snapshot.skills.length) return undefined;
  const root = join(dataDir, 'runs', runId, 'skills');
  // The service owns this fresh, uniquely named tree; provider containers get it read-only.
  for (const directory of [join(dataDir, 'runs'), join(dataDir, 'runs', runId), root]) {
    if (existsSync(directory)) { if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new ControlError('Unsafe run skill directory.'); }
    else mkdirSync(directory, { mode: 0o700 });
  }
  for (const skill of snapshot.skills) {
    if (!/^[A-Za-z0-9_-]+$/.test(skill.id)) throw new ControlError('Unsafe skill ID.');
    validateSkillFiles(skill.content, skill.files);
    const directory = join(root, skill.id); mkdirSync(directory, { mode: 0o755 });
    writeFileSync(join(directory, 'SKILL.md'), skill.content, { flag: 'wx', mode: 0o444 });
    for (const file of skill.files) {
      const path = join(directory, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      writeFileSync(path, decodeSkillFile(file), { flag: 'wx', mode: file.executable ? 0o555 : 0o444 });
    }
  }
  // A Docker worker runs as a different UID; the mount itself enforces read-only access.
  chmodSync(root, 0o755); return root;
}
