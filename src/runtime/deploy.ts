import type { InstallationState } from '../shared/config/installation-schema.js';
import type { RepoConfig } from '../shared/config/schema.js';
import type { CommandRunner } from '../shared/core/command.js';
import type { InstallationCredentials } from './credential-store.js';
import { materializeRuntime } from './materialize.js';
import { writeRuntimeSecrets } from './secrets.js';
import { detectDockerSocketGid, uploadRuntime } from './target.js';

/**
 * Renders the trusted runtime with its secrets locally and places it on the Docker target (uploaded over SSH when
 * remote). Returns the runtime directory as seen by the target.
 */
export async function deployRuntime(
  runner: CommandRunner,
  config: RepoConfig,
  installation: InstallationState,
  assetsRoot: string,
  credentials: InstallationCredentials,
  targetRuntimeDirectory: string,
): Promise<string> {
  const localRuntime = await materializeRuntime(config, installation, assetsRoot, {
    dockerGid: await detectDockerSocketGid(runner, installation),
    ...(installation.target === 'ssh' ? { remoteRuntimeDirectory: targetRuntimeDirectory } : {}),
  });
  await writeRuntimeSecrets(localRuntime, credentials);
  return await uploadRuntime(runner, installation, localRuntime);
}
