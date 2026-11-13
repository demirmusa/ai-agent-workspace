import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manageAgentSkills, skillTargets } from '../commands/agent-skills.js';
import { createProgram } from '../index.js';
import { syncProjectManagerSkill } from '../../shared/core/agent-skills.js';

const directories: string[] = [];
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'aiws-skills-')); directories.push(directory); return directory; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('assistant management skill installation', () => {
  it('refreshes management instructions, preserves extra files and skips unchanged files on repeated startup', async () => {
    const home = await fixture(), targets = skillTargets('all', 'user', home, home);
    await syncProjectManagerSkill(home);
    const entry = join(targets[0]!.path, 'SKILL.md'), reference = join(targets[1]!.path, 'references', 'commands.md');
    await writeFile(entry, 'Outdated instructions');
    await writeFile(reference, 'Outdated commands');
    await writeFile(join(targets[0]!.path, 'custom.txt'), 'Keep this');
    await syncProjectManagerSkill(home);
    expect(await readFile(entry, 'utf8')).toContain('name: aiws-project-manager');
    expect(await readFile(reference, 'utf8')).toContain('aiws control projects list');
    expect(await readFile(join(targets[0]!.path, 'custom.txt'), 'utf8')).toBe('Keep this');
    await utimes(entry, new Date(1000000), new Date(1000000));
    const before = (await stat(entry)).mtimeMs;
    await syncProjectManagerSkill(home);
    expect((await stat(entry)).mtimeMs).toBe(before);
    await expect(readFile(join(home, '.claude', 'skills', 'aiws-plugin-development', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs both user skills, including references, and can be repeated', async () => {
    const home = await fixture();
    const targets = skillTargets('all', 'user', '/unused', home);
    expect(targets.map((target) => target.path)).toEqual([join(home, '.agents', 'skills', 'aiws-project-manager'), join(home, '.claude', 'skills', 'aiws-project-manager')]);
    const before = await manageAgentSkills(targets, { install: false });
    expect(before.every((target) => target.files.every((file) => file.state === 'missing'))).toBe(true);
    await manageAgentSkills(targets, { install: true, dryRun: true });
    await expect(readFile(join(targets[0]!.path, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await manageAgentSkills(targets, { install: true });
    await manageAgentSkills(targets, { install: true });
    for (const target of targets) {
      expect(await readFile(join(target.path, 'SKILL.md'), 'utf8')).toContain('name: aiws-project-manager');
      expect(await readFile(join(target.path, 'references', 'commands.md'), 'utf8')).toContain('aiws control projects list');
    }
    expect((await manageAgentSkills(targets, { install: false })).every((target) => target.files.every((file) => file.state === 'current'))).toBe(true);
  });

  it('preflights both providers and preserves edits and unrelated files unless explicitly replacing bundled files', async () => {
    const home = await fixture(); const targets = skillTargets('all', 'user', home, home);
    await mkdir(targets[1]!.path, { recursive: true });
    await writeFile(join(targets[1]!.path, 'SKILL.md'), 'My local instructions');
    await writeFile(join(targets[1]!.path, 'custom.txt'), 'Keep this');
    await expect(manageAgentSkills(targets, { install: true })).rejects.toThrow('local changes');
    await expect(readFile(join(targets[0]!.path, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(targets[1]!.path, 'SKILL.md'), 'utf8')).toBe('My local instructions');
    await manageAgentSkills(targets, { install: true, force: true });
    expect(await readFile(join(targets[1]!.path, 'custom.txt'), 'utf8')).toBe('Keep this');
  });

  it('honors CLI project scope, cwd, and provider without contacting the API', async () => {
    const directory = await fixture(); const fetch = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().exitOverride().parseAsync(['node', 'aiws', '-C', directory, 'agent-skills', 'install', '--provider', 'claude', '--scope', 'project']);
    expect(await readFile(join(directory, '.claude', 'skills', 'aiws-project-manager', 'SKILL.md'), 'utf8')).toContain('aiws');
    await expect(readFile(join(directory, '.agents', 'skills', 'aiws-project-manager', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('installs the plugin development skill with every reference file when selected', async () => {
    const directory = await fixture(); vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().exitOverride().parseAsync(['node', 'aiws', '-C', directory, 'agent-skills', 'install', '--skill', 'aiws-plugin-development', '--provider', 'claude', '--scope', 'project']);
    const root = join(directory, '.claude', 'skills', 'aiws-plugin-development');
    expect(await readFile(join(root, 'SKILL.md'), 'utf8')).toContain('name: aiws-plugin-development');
    for (const reference of ['manifest', 'client-api', 'server-api', 'theme-tokens', 'recipes']) expect(await readFile(join(root, 'references', `${reference}.md`), 'utf8')).toMatch(/^# /);
    await expect(readFile(join(directory, '.claude', 'skills', 'aiws-project-manager', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a linked destination even with force', async () => {
    const directory = await fixture(); const outside = await fixture();
    const targets = skillTargets('codex', 'project', directory);
    await symlink(outside, join(directory, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manageAgentSkills(targets, { install: true, force: true })).rejects.toThrow('linked skill path');
    await expect(readFile(join(outside, 'skills', 'aiws-project-manager', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
