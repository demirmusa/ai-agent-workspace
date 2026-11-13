import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { RepoConfig } from '../shared/config/schema.js';
import { createManagedManifest, type ManagedFileManifest } from '../shared/core/manifest.js';
import { deterministicResourceNames } from '../shared/core/names.js';
import { AiwsError } from '../shared/core/logger.js';
import { githubExpressionJson, renderTemplateFile } from './engine.js';

export const AUTOMATION_SECRET = 'AIWS_AUTOMATION_TOKEN';
export const PROJECT_SECRET = 'AIWS_PROJECT_TOKEN';

export interface RenderedRepository {
  files: Readonly<Record<string, string>>;
  manifest: ManagedFileManifest;
}

export async function renderRepository(
  config: RepoConfig,
  assetsRoot: string,
  generatorVersion: string,
): Promise<RenderedRepository> {
  const names = deterministicResourceNames(config.repository.slug);
  const projectEnabled = config.queue.mode === 'project' || config.queue.mode === 'both';
  const hooksEnabled = config.hooks.test !== undefined || config.hooks.custom.length > 0;
  const hookCommands = [
    ...(config.hooks.test ? [config.commands.test] : []),
    ...config.hooks.custom.map(({ command }) => command),
  ];
  const hookLabels = config.hooks.custom.flatMap(({ label }) => (label ? [label] : []));
  const agentLabels = [config.queue.labels.ready, config.queue.labels.continue, config.queue.labels.run];
  const lifecycleOverheadMinutes =
    Math.ceil(
      (config.agent.timeouts.startupSeconds + config.agent.timeouts.shutdownSeconds) / 60,
    ) + 5;
  const hookExecutionMinutes = Math.max(
    config.agent.timeouts.hookMinutes,
    config.hooks.test?.timeoutMinutes ?? 0,
    ...config.hooks.custom.map(({ timeoutMinutes }) => timeoutMinutes ?? 0),
  );
  const projectTokenLine = projectEnabled
    ? `      AIWS_PROJECT_TOKEN: \${{ secrets['${PROJECT_SECRET}'] }}`
    : '';

  const values: Record<string, string> = {
    ACTOR_ALLOWLIST_JSON: githubExpressionJson(config.security.allowedActors),
    AGENT_COMMAND: config.commands.issue,
    AGENT_LABELS_JSON: githubExpressionJson(agentLabels),
    AUTOMATION_TOKEN_SECRET: AUTOMATION_SECRET,
    CONCURRENCY_GROUP: names.composeProject,
    HOOK_COMMANDS_JSON: githubExpressionJson(hookCommands),
    HOOK_CONTENTS_PERMISSION: 'read',
    HOOK_LABELS_JSON: githubExpressionJson(hookLabels),
    HOOK_TIMEOUT_MINUTES: String(hookExecutionMinutes + lifecycleOverheadMinutes),
    ISSUE_TIMEOUT_MINUTES: String(config.agent.timeouts.issueMinutes + lifecycleOverheadMinutes),
    PR_COMMAND: config.commands.pr,
    PR_TIMEOUT_MINUTES: String(config.agent.timeouts.prMinutes + lifecycleOverheadMinutes),
    REVIEW_TIMEOUT_MINUTES: String(Math.max(1, config.review.profiles.length) * (config.agent.timeouts.prMinutes + lifecycleOverheadMinutes)),
    PROJECT_TOKEN_ENV: projectTokenLine,
    PROJECT_TOKEN_SECRET: PROJECT_SECRET,
    RUNNER_LABELS: JSON.stringify(config.runner.labels),
    RUNTIME_VERSION: generatorVersion,
    REVIEW_AUTOMATIC: String(config.review.enabled && config.review.onPullRequest),
  };

  const templateRoot = join(assetsRoot, 'repository');
  const files: Record<string, string> = {
    '.aiworkspace/config.json': `${JSON.stringify(config, null, 2)}\n`,
    '.github/workflows/aiws-agent-task.yml': await renderTemplateFile(
      join(templateRoot, 'aiws-agent-task.yml.tmpl'),
      values,
    ),
    '.github/workflows/aiws-pr-agent.yml': await renderTemplateFile(
      join(templateRoot, 'aiws-pr-agent.yml.tmpl'),
      values,
    ),
    '.github/workflows/aiws-agent-organize.yml': await renderTemplateFile(join(templateRoot, 'aiws-agent-organize.yml.tmpl'), values),
    '.github/workflows/aiws-pr-review.yml': await renderTemplateFile(join(templateRoot, 'aiws-pr-review.yml.tmpl'), values),
  };
  if (projectEnabled) {
    files['.github/workflows/aiws-agent-queue.yml'] = await renderTemplateFile(
      join(templateRoot, 'aiws-agent-queue.yml.tmpl'),
      values,
    );
  }
  if (hooksEnabled) {
    files['.github/workflows/aiws-hooks.yml'] = await renderTemplateFile(
      join(templateRoot, 'aiws-hooks.yml.tmpl'),
      values,
    );
  }

  for (const [path, contents] of Object.entries(files)) {
    if (!path.endsWith('.yml')) continue;
    const document = parseDocument(contents);
    if (document.errors.length > 0) {
      throw new AiwsError(
        `Generated workflow ${path} is invalid YAML: ${document.errors.map(({ message }) => message).join('; ')}`,
      );
    }
  }

  // config.json is intentionally user-editable. Its parsed value is fingerprinted
  // through configHash, but only workflows are byte-for-byte managed.
  const managedFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => path !== '.aiworkspace/config.json'),
  );
  const manifest = createManagedManifest(managedFiles, {
    generatorVersion,
    config,
  });
  files['.aiworkspace/manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { files, manifest };
}
