import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import type { InstallationState } from '../shared/config/installation-schema.js';
import type { RepoConfig } from '../shared/config/schema.js';
import { localRepositoryStateDirectory } from '../shared/core/paths.js';
import { AiwsError } from '../shared/core/logger.js';
import { renderTemplate } from '../templates/engine.js';
import { PACKAGE_VERSION } from '../shared/version.js';
import { CLAUDE_CODE_VERSION, CODEX_CLI_VERSION, GITHUB_RUNNER_VERSION, OPENCODE_VERSION } from './constants.js';

export interface MaterializeRuntimeOptions {
  dockerGid: number;
  remoteRuntimeDirectory?: string;
}

export async function materializeRuntime(
  config: RepoConfig,
  installation: InstallationState,
  assetsRoot: string,
  options: MaterializeRuntimeOptions,
): Promise<string> {
  const controlState = localRepositoryStateDirectory(config.repository.slug);
  const runtimeDirectory = join(controlState, 'runtime');
  const source = join(assetsRoot, 'runtime');
  await mkdir(controlState, { recursive: true, mode: 0o700 });
  const resolvedControlState = resolve(controlState);
  const resolvedRuntime = resolve(runtimeDirectory);
  if (!resolvedRuntime.startsWith(`${resolvedControlState}${sep}`) || resolvedRuntime === resolvedControlState) {
    throw new AiwsError(`Refusing to replace unexpected runtime path: ${resolvedRuntime}`);
  }
  await rm(resolvedRuntime, { recursive: true, force: true });
  await cp(source, runtimeDirectory, { recursive: true, force: true });

  const templatePath = join(runtimeDirectory, 'compose.yaml.template');
  const template = await readFile(templatePath, 'utf8');
  const runtimePathForCompose = options.remoteRuntimeDirectory ?? runtimeDirectory;
  const composeRuntimePath = posixPath(runtimePathForCompose);
  const projectEnabled = config.queue.mode === 'project' || config.queue.mode === 'both';
  const runnerName = installation.runnerName;
  const quotedValues: Record<string, string> = {
    AGENT_IMAGE: installation.names.images.agent,
    CLAUDE_AUTH_VOLUME: installation.names.volumes.claudeAuth,
    CLAUDE_CODE_VERSION,
    CODEX_AUTH_VOLUME: installation.names.volumes.codexAuth,
    CODEX_CLI_VERSION,
    OPENCODE_VERSION,
    OPENCODE_AUTH_VOLUME: installation.names.volumes.opencodeAuth,
    SCHEDULER_STATE_VOLUME: installation.names.volumes.scheduler,
    AUTOMATION_TOKEN_FILE: posix.join(composeRuntimePath, 'secrets', 'automation-token'),
    COMPOSE_PROJECT_NAME: installation.names.composeProject,
    DEFAULT_BRANCH: config.repository.defaultBranch,
    DOCKER_GID: safeUnsignedInteger(options.dockerGid, 'Docker socket GID'),
    GITHUB_RUNNER_VERSION,
    POLLER_CONTAINER_NAME: installation.names.containers.poller,
    POLLER_CPUS: '0.25',
    POLLER_MEMORY: '256m',
    POLL_SECONDS: safeUnsignedInteger(config.queue.pollSeconds, 'Project poll interval', 1),
    PROJECT_TOKEN_FILE: posix.join(composeRuntimePath, 'secrets', 'project-token'),
    QUEUE_WORKFLOW: 'aiws-agent-queue.yml',
    REPOSITORY: config.repository.slug,
    RUNNER_CONTAINER_NAME: installation.names.containers.runner,
    RUNNER_CPUS: '1.0',
    RUNNER_IMAGE: installation.names.images.runner,
    RUNNER_LABELS: config.runner.labels.join(','),
    RUNNER_MEMORY: '2g',
    RUNNER_NAME: runnerName,
    RUNNER_STATE_VOLUME: installation.names.volumes.runner,
    RUNNER_TOKEN_FILE: posix.join(composeRuntimePath, 'secrets', 'runner-token'),
    RUNTIME_DIR: composeRuntimePath,
    RUNTIME_GID: '10001',
    RUNTIME_IO_VOLUME: installation.names.volumes.cache,
    RUNTIME_UID: '10001',
    RUN_WORKFLOW: 'aiws-agent-task.yml',
    WORKSPACE_VOLUME: installation.names.volumes.workspace,
  };
  const numericValues: Record<string, string> = {
    POLLER_PIDS: safeUnsignedInteger(128, 'Poller PID limit', 1),
    RUNNER_PIDS: safeUnsignedInteger(1024, 'Runner PID limit', 1),
  };
  assertTemplateValueContexts(template, quotedValues, numericValues, templatePath);
  const rendered = renderTemplate(
    template,
    {
      ...Object.fromEntries(
        Object.entries(quotedValues).map(([name, value]) => [name, escapeComposeYamlDoubleQuoted(value)]),
      ),
      ...numericValues,
    },
    templatePath,
  );
  validateComposeYaml(rendered, templatePath);
  await writeFile(join(runtimeDirectory, 'compose.yaml'), expandRunnerPool(rendered, config, installation), 'utf8');
  await writeFile(join(runtimeDirectory, 'VERSION'), `${PACKAGE_VERSION}\n`, 'utf8');
  await rm(templatePath, { force: true });

  // A Windows checkout may carry CRLF endings, which bash in the Linux image rejects.
  await Promise.all((await listRuntimeScripts(runtimeDirectory)).map(async (script) => {
    await writeFile(script, (await readFile(script, 'utf8')).replaceAll('\r\n', '\n'), 'utf8');
    await chmod(script, 0o755);
  }));
  if (projectEnabled && !config.queue.project) {
    throw new AiwsError('Project queue is enabled but queue.project is missing.');
  }
  return runtimeDirectory;
}

export function runnerPoolSize(config: RepoConfig): number {
  return config.orchestration.enabled ? config.orchestration.maxConcurrent : 1;
}

export function runnerServiceNames(config: RepoConfig): string[] {
  return Array.from({ length: runnerPoolSize(config) }, (_, index) => index === 0 ? 'runner' : `runner-${index + 1}`);
}

export function poolRunnerName(base: string, slot: number): string {
  return slot === 1 ? base : `${base.slice(0, 60)}-${slot}`;
}

function expandRunnerPool(rendered: string, config: RepoConfig, installation: InstallationState): string {
  const document = parseDocument(rendered);
  const compose = document.toJS() as { services: Record<string, any>; volumes: Record<string, { name: string }> };
  const base = compose.services.runner;
  for (let slot = 2; slot <= runnerPoolSize(config); slot += 1) {
    const runner = structuredClone(base);
    delete runner.build;
    runner.container_name = `${installation.names.containers.runner}-${slot}`;
    runner.environment.AIWS_RUNNER_NAME = poolRunnerName(installation.runnerName, slot).replaceAll('$', () => '$$');
    for (const [logical, field, mount] of [
      ['runner_state', 'runner', '/var/lib/aiws/runner'],
      ['workspace', 'workspace', '/var/lib/aiws/work'],
      ['runtime_io', 'cache', '/var/lib/aiws/io'],
    ] as const) {
      const name = `${installation.names.volumes[field]}-${slot}`;
      compose.volumes[`${logical}_${slot}`] = { name };
      runner.volumes = runner.volumes.map((value: string) => value === `${logical}:${mount}` ? `${logical}_${slot}:${mount}` : value);
      if (field === 'workspace') runner.environment.AIWS_WORKSPACE_VOLUME = name;
      if (field === 'cache') runner.environment.AIWS_RUNTIME_IO_VOLUME = name;
    }
    compose.services[`runner-${slot}`] = runner;
  }
  return stringify(compose, { lineWidth: 0 });
}

async function listRuntimeScripts(runtimeDirectory: string): Promise<string[]> {
  const bin = join(runtimeDirectory, 'bin');
  const entries = await readdir(bin, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sh')).map((entry) => join(bin, entry.name));
}

function posixPath(value: string): string {
  const normalized = value.startsWith('/') ? value : resolve(value).replaceAll('\\', '/');
  return normalized;
}

function escapeComposeYamlDoubleQuoted(value: string): string {
  // YAML 1.2 accepts JSON's double-quoted escape sequences. Compose performs
  // variable interpolation after YAML parsing, so preserve literal dollars by
  // doubling them for Compose as well.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AiwsError('Could not encode a Compose template value.');
  return encoded.slice(1, -1).replaceAll('$', () => '$$');
}

function safeUnsignedInteger(value: number, label: string, minimum = 0): string {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AiwsError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return String(value);
}

function assertTemplateValueContexts(
  template: string,
  quotedValues: Readonly<Record<string, string>>,
  numericValues: Readonly<Record<string, string>>,
  source: string,
): void {
  const tokenPattern = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  for (const match of template.matchAll(tokenPattern)) {
    const name = match[1] ?? '';
    const start = match.index;
    const end = start + match[0].length;
    if (Object.hasOwn(quotedValues, name)) {
      if (template[start - 1] !== '"' || template[end] !== '"') {
        throw new AiwsError(`${source} must place string template value ${name} in double quotes.`);
      }
      continue;
    }
    if (Object.hasOwn(numericValues, name)) {
      if (!/^\d+$/.test(numericValues[name] ?? '')) {
        throw new AiwsError(`${source} contains an unsafe numeric template value for ${name}.`);
      }
      if (template[start - 1] === '"' || template[end] === '"') {
        throw new AiwsError(`${source} must keep numeric template value ${name} unquoted.`);
      }
      continue;
    }
    throw new AiwsError(`${source} contains an unclassified template value: ${name}.`);
  }
}

function validateComposeYaml(rendered: string, source: string): void {
  const document = parseDocument(rendered);
  if (document.errors.length > 0) {
    throw new AiwsError(
      `Rendered Compose template ${source} is invalid YAML: ${document.errors
        .map(({ message }) => message)
        .join('; ')}`,
    );
  }
}
