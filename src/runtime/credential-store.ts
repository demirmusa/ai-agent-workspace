import { join } from 'node:path';
import { localRepositoryStateDirectory } from '../shared/core/paths.js';
import { AiwsError } from '../shared/core/logger.js';
import { readSecretFile, secretFilePaths, validateSecret, writeSecretFile, type RuntimeSecretPaths } from './secrets.js';

export interface InstallationCredentials {
  runnerToken: string;
  projectToken?: string;
  automationToken?: string;
}

export function installationCredentialPaths(repositorySlug: string): RuntimeSecretPaths {
  return secretFilePaths(join(localRepositoryStateDirectory(repositorySlug), 'credentials'));
}

export async function saveInstallationCredentials(
  repositorySlug: string,
  credentials: InstallationCredentials,
): Promise<void> {
  validateSecret(credentials.runnerToken, 'runner token');
  if (credentials.automationToken) validateSecret(credentials.automationToken, 'automation token');
  if (credentials.projectToken) validateSecret(credentials.projectToken, 'project token');
  const paths = installationCredentialPaths(repositorySlug);
  await writeSecretFile(paths.runnerToken, credentials.runnerToken);
  if (credentials.automationToken) await writeSecretFile(paths.automationToken, credentials.automationToken);
  if (credentials.projectToken) await writeSecretFile(paths.projectToken, credentials.projectToken);
}

export async function loadInstallationCredentials(
  repositorySlug: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstallationCredentials> {
  const paths = installationCredentialPaths(repositorySlug);
  const runnerToken = (await readSecretFile(paths.runnerToken)) ?? environmentToken(environment.AIWS_RUNNER_TOKEN);
  if (!runnerToken) {
    throw new AiwsError(
      'Missing runner management token.',
      2,
      'Run `aiws init` again or set AIWS_RUNNER_TOKEN before using this command.',
    );
  }
  const projectToken = (await readSecretFile(paths.projectToken)) ?? environmentToken(environment.AIWS_PROJECT_TOKEN);
  const automationToken = (await readSecretFile(paths.automationToken)) ?? environmentToken(environment.AIWS_AUTOMATION_TOKEN) ?? runnerToken;
  validateSecret(automationToken, 'automation token');
  validateSecret(runnerToken, 'runner token');
  if (projectToken) validateSecret(projectToken, 'project token');
  return { runnerToken, automationToken, ...(projectToken ? { projectToken } : {}) };
}

function environmentToken(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
