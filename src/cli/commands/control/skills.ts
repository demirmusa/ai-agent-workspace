import type { Command } from 'commander';
import { print, readLocalJson, readLocalText, request, segment } from './client.js';

export function registerSkillCommands(control: Command): void {
  const skills = control.command('skills').description('Manage SKILL.md content and import bundled supporting resources.');
  skills.command('list').action(async (_options, command) => print(await request(command, '/api/skills')));
  skills.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/skills/${segment(id)}`)));
  skills.command('import <directory>').description('Import an absolute directory on the backend host, including its SKILL.md and resources.')
    .option('--name <name>', 'override imported skill name')
    .action(async (directory, options, command) => print(await request(command, '/api/skills/import', 'POST', { directory, ...(options.name ? { name: options.name } : {}) })));
  for (const operation of ['create', 'update']) {
    skills.command(`${operation} <${operation === 'create' ? 'name' : 'id'}>`)
      .option('--name <name>', 'skill display name (update)').option('--description <text>')
      .option('--content <text>', 'SKILL.md body').option('--file <path>', 'read SKILL.md from a local UTF-8 file')
      .option('--files <path>', 'local JSON supporting resources array: [{path,content,encoding}]')
      .action(async (value, options, command) => {
        if (operation === 'create' && options.content === undefined && !options.file) throw new Error('Use --file or --content for the skill instructions.');
        const files = options.files ? await readLocalJson(options.files) : undefined;
        if (files !== undefined && !Array.isArray(files)) throw new Error('--files must contain a JSON array.');
        print(await request(command, operation === 'create' ? '/api/skills' : `/api/skills/${segment(value)}`, operation === 'create' ? 'POST' : 'PATCH', {
          ...(operation === 'create' ? { name: value } : options.name ? { name: options.name } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.file || options.content !== undefined ? { content: options.file ? await readLocalText(options.file) : options.content } : {}),
          ...(files === undefined ? {} : { files }),
        }));
      });
  }
  skills.command('delete <id>').action(async (id, _options, command) => print(await request(command, `/api/skills/${segment(id)}`, 'DELETE')));
}
