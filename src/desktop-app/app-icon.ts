import { readFileSync } from 'node:fs';
import { packageAssetsDirectory } from '../shared/core/assets.js';

/** PNGs rendered from control-ui/icons/aiws.svg by scripts/render-app-icon.cjs. */
export function appIcon(size: 32 | 256 = 32): Buffer {
  const path = packageAssetsDirectory('..', 'control-ui', 'icons', `aiws-${size}.png`);
  if (!path) throw new Error('Packaged AIWS app icon could not be found.');
  return readFileSync(path);
}
