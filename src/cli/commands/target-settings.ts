import { input, select } from '@inquirer/prompts';
import { InstallationStateSchema } from '../../shared/config/installation-schema.js';
import { defaultSshStateDirectory } from '../../shared/config/defaults.js';
import { saveInstallationState } from '../../shared/config/store.js';
import { AiwsError } from '../../shared/core/logger.js';
import type { AppContext } from './context.js';
import { loadRepository } from './repository-context.js';

export async function runTargetSettings(context: AppContext, options: { show?: boolean; target?: string; host?: string; user?: string; port?: string; identity?: string; stateDir?: string }): Promise<void> {
  const loaded = await loadRepository(context);
  if (options.show) {
    const { target, ssh, stateDir } = loaded.installation;
    context.logger.info(JSON.stringify({ target, ssh, stateDir }, null, 2)); return;
  }
  let target = options.target;
  if (!target) {
    if (!process.stdin.isTTY) throw new AiwsError('Use --target local|ssh, or --show in a non-interactive terminal.');
    target = await select({ message: 'Docker host', choices: [{ name: 'This machine', value: 'local' }, { name: 'Remote host over SSH', value: 'ssh' }], default: loaded.installation.target });
    if (target === 'ssh') {
      options.host = await input({ message: 'SSH host / config alias', default: loaded.installation.ssh?.host ?? '' });
      options.user = await input({ message: 'SSH user', default: loaded.installation.ssh?.user ?? '' });
      options.port = await input({ message: 'SSH port', default: String(loaded.installation.ssh?.port ?? 22) });
      options.identity = await input({ message: 'Private key path (blank = SSH default)', default: loaded.installation.ssh?.identityFile ?? '' });
    }
  }
  if (target !== 'local' && target !== 'ssh') throw new AiwsError('Target must be local or ssh.');
  if (loaded.installation.manifestHash) throw new AiwsError('Stop the existing runtime with aiws down before changing its host.', 2, 'This keeps its runner registrations and credentials on the old host under your control.');
  const ssh = target === 'ssh' ? {
    host: options.host ?? loaded.installation.ssh?.host,
    user: options.user ?? loaded.installation.ssh?.user,
    port: Number(options.port ?? loaded.installation.ssh?.port ?? 22),
    ...(options.identity ? { identityFile: options.identity } : {}),
  } : undefined;
  const stateDir = options.stateDir ?? (target === 'local' ? loaded.localRuntimeDirectory.replace(/[\\/]runtime$/, '') : defaultSshStateDirectory(loaded.config.repository.slug, { user: ssh?.user ?? '' }));
  const { ssh: _oldSsh, ...previous } = loaded.installation;
  const updated = InstallationStateSchema.parse({ ...previous, target, ...(ssh ? { ssh } : {}), stateDir });
  await saveInstallationState(updated);
  context.logger.success('Docker host settings saved locally. Authenticate on this host with aiws login all, then aiws up.');
}
