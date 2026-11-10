import type { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { packPluginFolder } from '../../../control-server/plugins.js';
import { print, request, segment } from './client.js';

/** Plugin management through the control API (src/assets/agent-skills/aiws-plugin-development); `pack` works offline. */
export function registerPluginCommands(control: Command): void {
  const plugins = control.command('plugins').description('Install, link, configure and pack control center plugins (src/assets/agent-skills/aiws-plugin-development).');
  plugins.command('list').action(async (_options, command) => print(await request(command, '/api/plugins')));
  plugins.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/plugins/${segment(id)}`)));
  plugins.command('install <path>').description('Install a plugin folder or .zip archive; an installed plugin with the same id is replaced.').option('--link', 'link the folder instead of copying it, for development', false)
    .action(async (path, options, command) => {
      const source = resolve(path);
      print(await request(command, '/api/plugins', 'POST', source.toLowerCase().endsWith('.zip') ? { archive: (await readFile(source)).toString('base64'), fileName: basename(source) } : { path: source, mode: options.link ? 'link' : 'copy' }));
    });
  for (const [name, enabled] of [['enable', true], ['disable', false]] as const) plugins.command(`${name} <id>`).action(async (id, _options, command) => print(await request(command, `/api/plugins/${segment(id)}`, 'PATCH', { enabled })));
  plugins.command('settings <id> [json]').description('Show settings, or save the given JSON object of setting values.').action(async (id, json, _options, command) => print(json === undefined ? (await request(command, `/api/plugins/${segment(id)}`)).settings : (await request(command, `/api/plugins/${segment(id)}`, 'PATCH', { settings: JSON.parse(json) })).settings));
  plugins.command('logs <id>').description('Server code log of a plugin.').action(async (id, _options, command) => print((await request(command, `/api/plugins/${segment(id)}/logs`)).logs));
  plugins.command('remove <id>').description('Uninstall a copied plugin or unlink a linked one; a linked folder is kept.').action(async (id, _options, command) => print(await request(command, `/api/plugins/${segment(id)}`, 'DELETE')));
  plugins.command('skill').description('Install the aiws-plugin-development skill for Codex and Claude Code (user scope).').option('--force', 'replace locally changed skill files', false)
    .action(async (options, command) => print(await request(command, '/api/plugin-skill', 'POST', { force: options.force })));
  plugins.command('pack <folder>').description('Validate a plugin folder and write <id>-<version>.zip without contacting the server.').option('--out <file>', 'archive path')
    .action(async (folder, options) => {
      const packed = packPluginFolder(resolve(folder)), out = resolve(options.out ?? `${packed.manifest.id}-${packed.manifest.version}.zip`);
      await writeFile(out, packed.archive); print({ id: packed.manifest.id, version: packed.manifest.version, files: packed.files, archive: out });
    });
}
