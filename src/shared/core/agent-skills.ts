import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, parse, dirname } from 'node:path';
import { findAssetsRoot } from './assets.js';

/** Skills bundled under assets/agent-skills that the CLI and the control center can install for assistants. */
export const BUNDLED_AGENT_SKILLS = ['aiws-project-manager', 'aiws-plugin-development'] as const;
export type BundledAgentSkill = typeof BUNDLED_AGENT_SKILLS[number];
export type AgentSkillTarget = { provider: string; path: string };
export type AgentSkillFileState = 'missing' | 'current' | 'modified';
export interface AgentSkillPlan { provider: string; path: string; files: { file: string; state: AgentSkillFileState }[] }

export function agentSkillTargets(skillName: BundledAgentSkill, provider: string, scope: string, cwd: string, home = homedir()): AgentSkillTarget[] {
  if (!['codex', 'claude', 'all'].includes(provider)) throw new Error('Unknown skill provider.');
  if (!['user', 'project'].includes(scope)) throw new Error('Unknown skill scope.');
  const base = scope === 'user' ? home : resolve(cwd);
  return (provider === 'all' ? ['codex', 'claude'] : [provider]).map((name) => ({
    provider: name, path: join(base, name === 'codex' ? '.agents' : '.claude', 'skills', skillName),
  }));
}

// Do not follow existing junctions/symlinks while installing into user-controlled paths.
async function assertNoLinks(path: string): Promise<void> {
  let current = resolve(path);
  while (current !== parse(current).root) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing linked skill path: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
}

/** Every file of a bundled skill, as forward-slash paths relative to the skill folder. */
async function bundledFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await bundledFiles(root, path)); else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export async function manageAgentSkills(skillName: BundledAgentSkill, targets: AgentSkillTarget[], options: { install: boolean; force?: boolean; dryRun?: boolean }): Promise<AgentSkillPlan[]> {
  const root = join(await findAssetsRoot(), 'agent-skills', skillName);
  const bundled = await Promise.all((await bundledFiles(root)).map(async (file) => ({ file, content: await readFile(join(root, file), 'utf8') })));
  const plans = [];
  for (const target of targets) {
    const files = [];
    for (const resource of bundled) {
      const path = join(target.path, resource.file);
      await assertNoLinks(path);
      let content: string | undefined;
      try { content = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      files.push({ ...resource, path, state: (content === undefined ? 'missing' : content === resource.content ? 'current' : 'modified') as AgentSkillFileState });
    }
    plans.push({ ...target, files });
  }
  // Check every destination before writing either provider's files.
  if (options.install && !options.force && plans.some((plan) => plan.files.some((file) => file.state === 'modified'))) {
    throw new Error('A skill file has local changes. Inspect agent-skills status; use --force to replace bundled files.');
  }
  if (options.install && !options.dryRun) for (const plan of plans) for (const file of plan.files) {
    if (file.state === 'current') continue;
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { flag: file.state === 'missing' ? 'wx' : 'w' });
  }
  return plans.map((plan) => ({ provider: plan.provider, path: plan.path,
    files: plan.files.map(({ file, state }) => ({ file, state: options.install && !options.dryRun ? 'current' : state })),
  }));
}

/** Refresh AIWS-owned management instructions from the packaged source on each service startup. */
export async function syncProjectManagerSkill(home = homedir()): Promise<AgentSkillPlan[]> {
  const skill = 'aiws-project-manager';
  const targets = agentSkillTargets(skill, 'all', 'user', process.cwd(), home);
  return await manageAgentSkills(skill, targets, { install: true, force: true });
}
