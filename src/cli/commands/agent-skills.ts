import { Command, Option } from 'commander';
import { agentSkillTargets, BUNDLED_AGENT_SKILLS, manageAgentSkills as manageBundledSkills, type AgentSkillTarget, type BundledAgentSkill } from '../../shared/core/agent-skills.js';

const defaultSkill: BundledAgentSkill = 'aiws-project-manager';

export function skillTargets(provider: string, scope: string, cwd: string, home?: string, skill: BundledAgentSkill = defaultSkill): AgentSkillTarget[] {
  return agentSkillTargets(skill, provider, scope, cwd, home);
}
export function manageAgentSkills(targets: AgentSkillTarget[], options: { install: boolean; force?: boolean; dryRun?: boolean }, skill: BundledAgentSkill = defaultSkill) {
  return manageBundledSkills(skill, targets, options);
}

export function registerAgentSkillCommands(program: Command): void {
  const skills = program.command('agent-skills').description('Install the bundled AIWS skills (project management, plugin development) for Codex and Claude Code.');
  for (const operation of ['install', 'status']) {
    const command = skills.command(operation)
      .addOption(new Option('--skill <skill>', 'bundled skill').choices([...BUNDLED_AGENT_SKILLS]).default(defaultSkill))
      .addOption(new Option('--provider <provider>', 'assistant to configure').choices(['codex', 'claude', 'all']).default('all'))
      .addOption(new Option('--scope <scope>', 'user: all projects; project: --cwd only').choices(['user', 'project']).default('user'));
    if (operation === 'install') command.option('--force', 'replace modified bundled skill files', false).option('--dry-run', 'show destinations without writing', false);
    command.action(async (options, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd: string }>();
      const result = await manageAgentSkills(skillTargets(options.provider, options.scope, globals.cwd, undefined, options.skill), { install: operation === 'install', force: options.force, dryRun: options.dryRun }, options.skill);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  }
}
