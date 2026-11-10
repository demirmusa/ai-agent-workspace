import { access } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiwsError } from './logger.js';

function assetRootCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.AIWS_ASSET_ROOT,
    resolve(moduleDir, '../../../assets'),
    resolve(moduleDir, '../../assets'),
    resolve(moduleDir, '../assets'),
    resolve(process.cwd(), 'assets'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** A folder under the packaged assets for code that starts synchronously; null when there is none. */
export function packageAssetsDirectory(...parts: string[]): string | null {
  const root = assetRootCandidates().find((candidate) => existsSync(join(candidate, 'runtime')) && existsSync(join(candidate, 'repository')));
  return root && existsSync(join(root, ...parts)) ? join(root, ...parts) : null;
}

export async function findAssetsRoot(): Promise<string> {
  for (const candidate of assetRootCandidates()) {
    try {
      await access(join(candidate, 'runtime'), constants.R_OK);
      await access(join(candidate, 'repository'), constants.R_OK);
      return candidate;
    } catch {
      // Try the next package/development layout.
    }
  }
  throw new AiwsError('Packaged assets could not be found.', 2, 'Reinstall the npm package or set AIWS_ASSET_ROOT.');
}

/** Resolve resources shared by the source checkout and the compiled npm package. */
export async function packageResource(...parts: string[]): Promise<string> {
  return resolve(await findAssetsRoot(), '..', ...parts);
}

