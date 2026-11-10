import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The README, license and example plugins stay in the repository root and are staged only when packaging.
const repository = new URL('../../', import.meta.url);
const application = new URL('../', import.meta.url);
for (const name of ['README.md', 'LICENSE', 'examples']) {
  const target = fileURLToPath(new URL(name, application));
  if (process.argv.includes('--clean')) {
    await rm(target, { recursive: true, force: true });
    continue;
  }
  await cp(fileURLToPath(new URL(name, repository)), target, {
    recursive: true,
    filter: source => !/[\\/](reference|screenshots)([\\/]|$)/.test(source),
  });
}
