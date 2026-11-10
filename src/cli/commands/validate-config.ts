import { findAssetsRoot } from '../../shared/core/assets.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { renderRepository } from '../../templates/repository.js';
import { planRepositoryWrite } from '../../templates/writer.js';
import type { AppContext } from './context.js';
import { printFilePlan } from './file-plan.js';
import { loadTrackedRepository } from './repository-context.js';

export async function runValidateConfig(context: AppContext): Promise<void> {
  // Validation is a repository operation: it must work in a clean clone where
  // this machine has never created an untracked installation state.
  const loaded = await loadTrackedRepository(context);
  const assets = await findAssetsRoot();
  const rendered = await renderRepository(loaded.config, assets, PACKAGE_VERSION);
  const { plan } = await planRepositoryWrite(loaded.info.root, rendered);
  printFilePlan(context, plan);
  const changed = plan.create.length + plan.update.length + plan.remove.length;
  if (changed > 0) {
    context.logger.warn(`Configuration is valid, but ${changed} generated file(s) need aiws sync.`);
    process.exitCode = 2;
    return;
  }
  context.logger.success('Configuration and generated workflows are valid and in sync.');
}
