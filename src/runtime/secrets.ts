import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AiwsError } from '../shared/core/logger.js';

export interface RuntimeSecretPaths {
  directory: string;
  runnerToken: string;
  projectToken: string;
  automationToken: string;
}

/** File names of the token files in a secrets directory; local credentials and the runtime copy share them. */
export const SECRET_FILE_NAMES = { runnerToken: 'runner-token', projectToken: 'project-token', automationToken: 'automation-token' } as const;
/** Directory of the secrets inside a runtime directory (also its relative path on an SSH target). */
export const RUNTIME_SECRETS_DIRECTORY = 'secrets';

export function secretFilePaths(directory: string): RuntimeSecretPaths {
  return {
    directory,
    runnerToken: join(directory, SECRET_FILE_NAMES.runnerToken),
    projectToken: join(directory, SECRET_FILE_NAMES.projectToken),
    automationToken: join(directory, SECRET_FILE_NAMES.automationToken),
  };
}

export function runtimeSecretPaths(runtimeDirectory: string): RuntimeSecretPaths {
  return secretFilePaths(join(runtimeDirectory, RUNTIME_SECRETS_DIRECTORY));
}

export function validateSecret(value: string, label: string): void {
  if (!value.trim() || /[\r\n\0]/.test(value)) {
    throw new AiwsError(`Invalid ${label}; secrets must be a single non-empty line.`);
  }
}

/**
 * Writes one secret file with owner-only permissions. `mode` applies only when a file is created, so an existing
 * file or directory is narrowed explicitly as well (POSIX; on Windows this is best effort, see the wiki Security page).
 */
export async function writeSecretFile(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, value ? `${value}\n` : '', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

/** The trimmed contents of a secret file, or undefined when it is missing or empty. */
export async function readSecretFile(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeRuntimeSecrets(
  runtimeDirectory: string,
  values: { runnerToken: string; projectToken?: string; automationToken?: string },
): Promise<RuntimeSecretPaths> {
  const automationToken = values.automationToken ?? values.runnerToken;
  validateSecret(values.runnerToken, 'runner token');
  if (values.projectToken) validateSecret(values.projectToken, 'project token');
  validateSecret(automationToken, 'automation token');
  const paths = runtimeSecretPaths(runtimeDirectory);
  await writeSecretFile(paths.runnerToken, values.runnerToken);
  await writeSecretFile(paths.automationToken, automationToken);
  // Compose requires every declared secret file to exist, so a disabled project token is an empty file.
  await writeSecretFile(paths.projectToken, values.projectToken ?? '');
  return paths;
}
