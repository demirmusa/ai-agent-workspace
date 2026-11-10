import { findAssetsRoot } from '../../shared/core/assets.js';
import { saveInstallationState } from '../../shared/config/store.js';
import { hashManifest } from '../../shared/core/manifest.js';
import { AiwsError } from '../../shared/core/logger.js';
import { GitHubClient } from '../../shared/github/client.js';
import { composeBuild, composeUp, deployRuntime, loadInstallationCredentials } from '../../runtime/index.js';
import { renderRepository } from '../../templates/repository.js';
import { planRepositoryWrite } from '../../templates/writer.js';
import { PACKAGE_VERSION } from '../../shared/version.js';
import { runnerPoolSize } from '../../runtime/materialize.js';
import type { AppContext } from './context.js';
import { labelsForConfig } from './labels.js';
import { loadRepository } from './repository-context.js';

export interface UpOptions {
  pull: boolean;
  dryRun: boolean;
}

export async function runUp(context: AppContext, options: UpOptions): Promise<void> {
  const loaded = await loadRepository(context);
  const projectEnabled = loaded.config.queue.mode === 'project' || loaded.config.queue.mode === 'both';
  const assetsRoot = await findAssetsRoot();
  const rendered = await renderRepository(loaded.config, assetsRoot, PACKAGE_VERSION);
  const { plan } = await planRepositoryWrite(loaded.info.root, rendered);
  const staleFiles = plan.create.length + plan.update.length + plan.remove.length;
  if (staleFiles > 0) {
    throw new AiwsError(
      `Refusing to start with ${staleFiles} stale or missing generated file${staleFiles === 1 ? '' : 's'}.`,
      2,
      'Run `aiws sync`, review/merge its changes, and retry from the updated default branch.',
    );
  }
  if (options.dryRun) {
    context.logger.info(`Would materialize trusted runtime: ${loaded.localRuntimeDirectory}`);
    if (loaded.installation.target === 'ssh') {
      context.logger.info(`Would upload it to: ${loaded.targetRuntimeDirectory}`);
    }
    context.logger.info(`Would build images: ${loaded.installation.names.images.runner}, ${loaded.installation.names.images.agent}`);
    context.logger.info(`Would start runner: ${loaded.installation.runnerName}`);
    context.logger.info(`Runner pool: ${runnerPoolSize(loaded.config)} isolated workers.`);
    if (loaded.config.orchestration.enabled || projectEnabled) context.logger.info('Would start the dependency-aware queue scheduler.');
    context.logger.info('Dry run complete; Docker, SSH and GitHub were not called.');
    return;
  }

  const credentials = await loadInstallationCredentials(loaded.config.repository.slug);
  if (projectEnabled && !credentials.projectToken) {
    throw new AiwsError(
      'Project queue requires a project token.',
      2,
      'Set AIWS_PROJECT_TOKEN and rerun `aiws init`, or change queue.mode to label and run `aiws sync`.',
    );
  }
  const repository = await new GitHubClient(context.runner, credentials.runnerToken).getRepository(
    loaded.config.repository.slug,
  );
  if (repository.visibility === 'public' && !loaded.config.security.allowPublicRepository) {
    throw new AiwsError(
      'Refusing to start a self-hosted runner for a public repository.',
      2,
      'Review the public-runner threat model, set security.allowPublicRepository to true, run `aiws sync`, and retry.',
    );
  }
  // New labels introduced by an upgrade/config edit must exist before dispatch.
  const github = new GitHubClient(context.runner, credentials.automationToken ?? credentials.runnerToken);
  const createdLabels = [...loaded.installation.createdLabels];
  await github.ensureLabels(loaded.config.repository.slug, labelsForConfig(loaded.config), async (label) => {
    if (!createdLabels.includes(label)) createdLabels.push(label);
    await saveInstallationState({ ...loaded.installation, createdLabels });
  });
  const targetRuntime = await deployRuntime(context.runner, loaded.config, loaded.installation, assetsRoot, credentials, loaded.targetRuntimeDirectory);

  context.logger.info('Building the pinned runner and agent images...');
  // Runtime scripts are baked into the runner image. Rebuilding on every up is
  // intentional: workflow/runtime version skew fails closed.
  await composeBuild(
    context.runner,
    loaded.config,
    loaded.installation,
    targetRuntime,
    options.pull,
    false,
  );
  await composeUp(context.runner, loaded.config, loaded.installation, targetRuntime, false);
  await saveInstallationState({
    ...loaded.installation,
    createdLabels,
    runnerSlots: Math.max(loaded.installation.runnerSlots, runnerPoolSize(loaded.config)),
    manifestHash: hashManifest(rendered.manifest),
  });
  context.logger.success(`Runner stack started: ${runnerPoolSize(loaded.config)} workers (${loaded.installation.runnerName}).`);
  context.logger.info('Saved provider logins are reused automatically. Use `aiws login all` for new or expired sessions.');
}
