import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillDiscovery, parseSkillFrontmatter } from '../skill-discovery.js';
import { startControlServer, type RunningControlServer } from '../server.js';
import type { Project, SkillDefinition } from '../types.js';

const roots: string[] = []; const servers: RunningControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function skill(directory: string, name: string, description: string, extra: Record<string, string> = {}): void {
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  for (const [path, content] of Object.entries(extra)) { mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), content); }
}
const link = (target: string, path: string): void => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
function fixture(): { root: string; home: string; projects: Project[]; discovery: SkillDiscovery } {
  const root = mkdtempSync(join(tmpdir(), 'aiws-skill-discovery-')); roots.push(root); const home = join(root, 'home');
  skill(join(home, '.claude', 'skills', 'alpha'), 'alpha', 'Global Claude skill', { 'references/guide.md': 'guide' });
  skill(join(home, '.codex', 'skills', 'beta'), 'beta', '"Quoted: codex"');
  skill(join(home, '.codex', 'skills', '.system', 'system-skill'), 'system-skill', 'Bundled');
  skill(join(home, '.agents', 'skills', 'gamma'), 'gamma', 'Shared agents skill');
  link(join(home, '.agents', 'skills', 'gamma'), join(home, '.claude', 'skills', 'gamma'));
  skill(join(root, 'outside', 'evil'), 'evil', 'Outside');
  link(join(root, 'outside', 'evil'), join(home, '.claude', 'skills', 'evil'));
  mkdirSync(join(home, '.claude', 'skills', 'not-a-skill'));
  const plugin = join(home, '.claude', 'plugins', 'cache', 'market', 'tool', '1.0.0'); skill(join(plugin, 'skills', 'plugged'), 'plugged', 'From a plugin');
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tool@market': [{ installPath: plugin }], 'bad@market': [{ installPath: join(root, 'outside') }] } }));
  const first = join(root, 'first'), second = join(root, 'second'); mkdirSync(second, { recursive: true });
  skill(join(first, '.claude', 'skills', 'delta'), 'Delta skill', 'Project skill', { 'scripts/run.sh': 'echo run' });
  const timestamp = new Date().toISOString();
  const projects = [{ id: 'project_first', name: 'First', repositoryPath: first }, { id: 'project_second', name: 'Second', repositoryPath: second }]
    .map((value) => ({ ...value, description: '', github: null, createdAt: timestamp, updatedAt: timestamp })) as Project[];
  return { root, home, projects, discovery: new SkillDiscovery({ home }) };
}

describe('skill discovery and sharing', () => {
  it('parses plain, quoted and block frontmatter values', () => {
    expect(parseSkillFrontmatter('---\nname: api-review\ndescription: Review APIs # note\n---\nbody')).toEqual({ name: 'api-review', description: 'Review APIs' });
    expect(parseSkillFrontmatter('---\r\nname: "quoted \\"name\\""\r\ndescription: \'it\'\'s\'\r\n---\r\n')).toEqual({ name: 'quoted "name"', description: "it's" });
    expect(parseSkillFrontmatter('---\nname: folded\ndescription: >\n  first line\n  second line\nother: x\n---\n')).toEqual({ name: 'folded', description: 'first line second line' });
    expect(parseSkillFrontmatter('---\nname: plain\ndescription: starts here\n  and continues\n---\n').description).toBe('starts here and continues');
    expect(parseSkillFrontmatter('# No frontmatter\nname: ignored')).toEqual({});
  });

  it('discovers global, plugin and project skills with scopes, providers, links and safe roots', async () => {
    const { discovery, projects, home } = fixture();
    const result = await discovery.discover(projects);
    const ids = result.skills.map((value) => value.id).sort();
    expect(ids).toEqual(['global:agents/gamma', 'global:claude/alpha', 'global:claude/evil', 'global:claude/gamma', 'global:codex/beta', 'global:codex:system/system-skill', 'plugin:tool@market/plugged', 'project:project_first:claude/delta']);
    const byId = new Map(result.skills.map((value) => [value.id, value]));
    expect(byId.get('global:claude/alpha')).toMatchObject({ scope: 'global', provider: 'claude', name: 'alpha', description: 'Global Claude skill', files: 1 });
    expect(byId.get('global:codex/beta')?.description).toBe('Quoted: codex');
    expect(byId.get('project:project_first:claude/delta')).toMatchObject({ scope: 'project', projectId: 'project_first', name: 'Delta skill', key: 'delta' });
    expect(byId.get('global:claude/gamma')?.linkedTo).toBeTruthy(); expect(byId.get('global:claude/gamma')?.fingerprint).toBe(byId.get('global:agents/gamma')?.fingerprint);
    expect(byId.get('global:claude/evil')?.error).toContain('outside'); expect(byId.get('global:claude/evil')?.fingerprint).toBeNull();
    expect(result.locations.find((value) => value.id === 'global:codex:system')?.writable).toBe(false);
    expect(result.locations.find((value) => value.id === 'plugin:tool@market')?.writable).toBe(false);
    expect(result.locations.some((value) => value.id === 'plugin:bad@market')).toBe(false);
    expect(result.locations.find((value) => value.id === 'project:project_second:claude')).toMatchObject({ exists: false, writable: true });
    // Cached until refreshed; a refresh sees new folders.
    skill(join(home, '.claude', 'skills', 'late'), 'late', 'Added later');
    expect((await discovery.discover(projects)).skills.some((value) => value.key === 'late')).toBe(false);
    expect((await discovery.discover(projects, { refresh: true })).skills.some((value) => value.key === 'late')).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(discovery.discover(projects, { refresh: true, signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('shares a skill into other projects and providers, protecting different existing copies', async () => {
    const { discovery, projects, root } = fixture(); await discovery.discover(projects);
    const second = join(root, 'second');
    const shared = await discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['project:project_second:claude', 'project:project_second:codex', 'global:agents'] });
    expect(shared.applied).toBe(true); expect(shared.results.map((value) => value.status)).toEqual(['copied', 'copied', 'copied']);
    expect(readFileSync(join(second, '.claude', 'skills', 'delta', 'scripts', 'run.sh'), 'utf8')).toBe('echo run');
    expect(existsSync(join(second, '.codex', 'skills', 'delta', 'SKILL.md'))).toBe(true);
    const after = await discovery.discover(projects); expect(after.skills.filter((value) => value.key === 'delta')).toHaveLength(4);
    expect(new Set(after.skills.filter((value) => value.key === 'delta').map((value) => value.fingerprint)).size).toBe(1);
    // Identical copies are left alone; a different skill with the same folder name needs explicit overwrite.
    writeFileSync(join(second, '.claude', 'skills', 'delta', 'SKILL.md'), 'locally edited');
    const blocked = await discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['project:project_second:claude', 'project:project_second:codex'] });
    expect(blocked.applied).toBe(false); expect(blocked.results[0]).toMatchObject({ status: 'conflict', diff: { changed: ['SKILL.md'], added: [], removed: [] } }); expect(blocked.results[1]?.status).toBe('unchanged');
    expect(readFileSync(join(second, '.claude', 'skills', 'delta', 'SKILL.md'), 'utf8')).toBe('locally edited');
    const forced = await discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['project:project_second:claude'], overwrite: ['project:project_second:claude'] });
    expect(forced).toMatchObject({ applied: true, results: [{ status: 'overwritten' }] });
    expect(readFileSync(join(second, '.claude', 'skills', 'delta', 'SKILL.md'), 'utf8')).toContain('name: Delta skill');
    // Read-only, unknown and traversal targets are refused.
    await expect(discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['global:codex:system'] })).rejects.toThrow('read-only');
    await expect(discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['project:missing:claude'] })).rejects.toThrow('Unknown');
    for (const sourceId of ['project:project_first:claude/..', 'project:project_first:claude/../../x', 'global:claude/evil', '../alpha', 'global:claude/a\\b', 42]) await expect(discovery.share(projects, { sourceId, targets: ['global:agents'] })).rejects.toThrow();
    // A symlinked project skills folder is never written through.
    const third = join(root, 'third'); mkdirSync(join(third, '.codex'), { recursive: true }); link(join(root, 'outside'), join(third, '.codex', 'skills'));
    const withThird = [...projects, { ...projects[1]!, id: 'project_third', name: 'Third', repositoryPath: third }];
    await expect(discovery.share(withThird, { sourceId: 'global:claude/alpha', targets: ['project:project_third:codex'] })).rejects.toThrow('symbolic link');
    expect(existsSync(join(root, 'outside', 'alpha'))).toBe(false);
  });

  it('removes shared copies and links but keeps the only copy and linked targets', async () => {
    const { discovery, projects, root, home } = fixture();
    await expect(discovery.remove(projects, { id: 'project:project_first:claude/delta' })).rejects.toThrow('only copy');
    await discovery.share(projects, { sourceId: 'project:project_first:claude/delta', targets: ['project:project_second:claude'] });
    await discovery.remove(projects, { id: 'project:project_second:claude/delta' });
    expect(existsSync(join(root, 'second', '.claude', 'skills', 'delta'))).toBe(false); expect(existsSync(join(root, 'first', '.claude', 'skills', 'delta', 'SKILL.md'))).toBe(true);
    await expect(discovery.remove(projects, { id: 'global:agents/gamma' })).rejects.toThrow('link');
    await discovery.remove(projects, { id: 'global:claude/gamma' });
    expect(() => lstatSync(join(home, '.claude', 'skills', 'gamma'))).toThrow(); expect(existsSync(join(home, '.agents', 'skills', 'gamma', 'SKILL.md'))).toBe(true);
    await expect(discovery.remove(projects, { id: 'plugin:tool@market/plugged' })).rejects.toThrow('read-only');
    await expect(discovery.remove(projects, { id: 'global:claude/evil' })).rejects.toThrow('outside');
    expect(existsSync(join(root, 'outside', 'evil', 'SKILL.md'))).toBe(true);
  });

  it('serves discovery, sharing and catalog import over the authenticated API', async () => {
    const { root, home } = fixture();
    const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'discovery-secret', skills: { home } }); servers.push(server);
    server.service.createProject({ name: 'First', repositoryPath: join(root, 'first') }); const second = server.service.createProject({ name: 'Second', repositoryPath: join(root, 'second') });
    const request = (path: string, method = 'GET', input?: unknown): Promise<Response> => fetch(`${server.url}/api/${path}`, { method, headers: { Authorization: 'Bearer discovery-secret', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    expect((await fetch(`${server.url}/api/skill-discovery`)).status).toBe(401);
    const result = await request('skill-discovery').then((response) => response.json()) as { skills: Array<{ id: string; key: string }> };
    const delta = result.skills.find((value) => value.key === 'delta')!; expect(delta.id).toMatch(/^project:project_[^:]+:claude\/delta$/);
    const shared = await request('skill-discovery/share', 'POST', { sourceId: delta.id, targets: [`project:${second.id}:claude`] }).then((response) => response.json()) as { applied: boolean };
    expect(shared.applied).toBe(true); expect(existsSync(join(root, 'second', '.claude', 'skills', 'delta', 'SKILL.md'))).toBe(true);
    expect((await request('skill-discovery/share', 'POST', { sourceId: delta.id, targets: ['global:codex:system'] })).status).toBe(403);
    expect((await request('skill-discovery/share', 'POST', [])).status).toBe(400);
    const imported = await request('skill-discovery/import', 'POST', { id: delta.id }); expect(imported.status).toBe(201);
    const definition = await imported.json() as SkillDefinition; expect(definition).toMatchObject({ name: 'Delta skill', description: 'Project skill' }); expect(definition.files.map((file) => file.path)).toEqual(['scripts/run.sh']);
    expect((await request('skill-discovery/remove', 'POST', { id: `project:${second.id}:claude/delta` })).status).toBe(200);
    expect((await request('skill-discovery/import', 'POST', { id: 'global:claude/../../outside' })).status).toBe(404);
  });
});
