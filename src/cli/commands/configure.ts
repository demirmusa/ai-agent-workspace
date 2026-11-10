import { input, select } from '@inquirer/prompts';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AGENT_PROVIDERS, type RepoConfig } from '../../shared/config/schema.js';
import { loadRepoConfig, saveRepoConfig } from '../../shared/config/store.js';
import { parseRepoConfig } from '../../shared/config/validation.js';
import { AiwsError } from '../../shared/core/logger.js';
import type { AppContext } from './context.js';

export async function configurationRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    try { await access(join(current, '.aiworkspace', 'config.json')); return current; } catch { /* Walk to repository root. */ }
    const parent = dirname(current);
    if (parent === current) throw new AiwsError('No .aiworkspace/config.json found.', 2, 'Run aiws init in the target repository first.');
    current = parent;
  }
}

function pathParts(path: string): string[] {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new AiwsError('Use a dotted configuration path, such as agents.profiles.0.model.');
  }
  return parts;
}

export function getSetting(value: unknown, path: string): unknown {
  for (const part of pathParts(path)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      throw new AiwsError(`Unknown configuration path: ${path}`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function setSetting(config: unknown, path: string, value: unknown): ReturnType<typeof parseRepoConfig> {
  const copy = structuredClone(config) as Record<string, unknown>;
  const parts = pathParts(path);
  const key = parts.pop()!;
  const parent = parts.length ? getSetting(copy, parts.join('.')) : copy;
  if (parent === null || typeof parent !== 'object') throw new AiwsError(`Not a configuration object: ${path}`);
  (parent as Record<string, unknown>)[key] = value;
  return parseRepoConfig(copy);
}

export function parseSettingValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export async function runConfigShow(context: AppContext, path?: string): Promise<void> {
  const config = await loadRepoConfig(await configurationRoot(context.cwd));
  context.logger.info(JSON.stringify(path ? getSetting(config, path) : config, null, 2));
}

export async function runConfigSet(context: AppContext, path: string, text: string): Promise<void> {
  const root = await configurationRoot(context.cwd);
  const config = setSetting(await loadRepoConfig(root), path, parseSettingValue(text));
  await saveRepoConfig(root, config);
  context.logger.success(`Saved ${path}.`);
  printApplyHint(context);
}

export async function runConfigImport(context: AppContext, file: string): Promise<void> {
  const config = parseRepoConfig(JSON.parse(await readFile(file, 'utf8')));
  const root = await configurationRoot(context.cwd);
  const current = await loadRepoConfig(root);
  if (config.repository.slug !== current.repository.slug) throw new AiwsError('Imported configuration must target this repository.');
  await saveRepoConfig(root, config);
  context.logger.success('Configuration imported and validated.');
  printApplyHint(context);
}

export function printApplyHint(context: AppContext): void {
  context.logger.info('Apply workflow changes with `aiws sync`, merge the PR, then run `aiws up` to apply runtime settings.');
}

export async function runConfigure(context: AppContext): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AiwsError('Interactive settings require a terminal.', 2, 'Use aiws config show/get/set/import in scripts.');
  const root = await configurationRoot(context.cwd);
  let config = await loadRepoConfig(root);
  let location = '';
  for (;;) {
    const section = location ? getSetting(config, location) : config;
    const path = await select({ message: `Settings / ${location || 'home'}`, choices: [
      ...Object.entries(section as Record<string, unknown>).filter(([key]) => key !== 'schemaVersion').map(([key, value]) => ({
        name: `${key}${value !== null && typeof value === 'object' ? ' ›' : `: ${JSON.stringify(value)}`}`,
        value: location ? `${location}.${key}` : key,
      })),
      ...(location ? [{ name: '← Back', value: '$back' }] : []),
      ...(location === 'agents.profiles' ? [{ name: '+ Add profile', value: '$profile' }] : []),
      ...(location ? [{ name: 'Edit this section as JSON (advanced)', value: '$json' }] : []),
      { name: 'Save and exit', value: '$save' }, { name: 'Discard and exit', value: '$discard' },
    ] });
    if (path === '$discard') return;
    if (path === '$save') {
      await saveRepoConfig(root, config);
      context.logger.success('Settings saved.'); printApplyHint(context); return;
    }
    if (path === '$back') { location = location.split('.').slice(0, -1).join('.'); continue; }
    try {
      if (path === '$profile' || /^agents\.profiles\.\d+$/.test(path)) {
        config = await editProfile(config, path === '$profile' ? undefined : Number(path.split('.').at(-1)));
        continue;
      }
      const key = path === '$json' ? location : path;
      const value = getSetting(config, key);
      if (path !== '$json' && value !== null && typeof value === 'object') { location = key; continue; }
      let next: unknown;
      if (typeof value === 'boolean') next = await select({ message: key, choices: [{ name: 'Enabled', value: true }, { name: 'Disabled', value: false }], default: value });
      else if (['agents.defaultProfile', 'review.profile', 'organization.profile'].includes(key)) {
        next = await select({ message: key, choices: [
          ...(key === 'agents.defaultProfile' ? [] : [{ name: 'Use default profile', value: null as string | null }]),
          ...config.agents.profiles.map(({ id, provider, model }) => ({ name: `${id} (${provider} / ${model ?? 'default model'})`, value: id as string | null })),
        ] });
      } else next = parseSettingValue(await input({ message: `${key}${typeof value === 'number' ? ' (number)' : ' (text or JSON)'}`, default: JSON.stringify(value) }));
      config = setSetting(config, key, next);
    } catch (error) { context.logger.error(error instanceof Error ? error.message : String(error)); }
  }
}

async function editProfile(config: RepoConfig, index?: number): Promise<RepoConfig> {
  const existing = index === undefined ? undefined : config.agents.profiles[index];
  if (existing) {
    const action = await select({ message: `Profile ${existing.id}`, choices: [{ name: 'Edit provider / model / effort / label', value: 'edit' }, { name: 'Remove profile', value: 'remove' }, { name: 'Back', value: 'back' }] });
    if (action === 'back') return config;
    if (action === 'remove') return setSetting(config, 'agents.profiles', config.agents.profiles.filter((_, position) => position !== index));
  }
  const id = await input({ message: 'Profile ID', default: existing?.id ?? 'opencode' });
  const provider = await select({ message: 'Provider', choices: AGENT_PROVIDERS.map((value) => ({ name: value, value })), default: existing?.provider ?? 'opencode' });
  const model = await input({ message: provider === 'opencode' ? 'Model provider/model (aiws models lists available IDs; blank = provider default)' : 'Model ID (blank = provider default)', default: existing?.model ?? '' });
  const efforts = provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : provider === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : ['medium'];
  const effort = await select({ message: provider === 'opencode' ? 'OpenCode uses model defaults for reasoning' : 'Reasoning effort', choices: efforts.map((value) => ({ name: value, value })), default: efforts.includes(existing?.effort ?? '') ? existing?.effort : 'medium' });
  const triggerLabel = await input({ message: 'Profile selection label', default: existing?.triggerLabel ?? `agent:${id}` });
  const profiles = [...config.agents.profiles];
  const profile = { ...(existing ?? {}), id, provider, model: model || null, effort, triggerLabel };
  if (index === undefined) return setSetting(config, 'agents.profiles', [...profiles, profile]);
  return setSetting(config, 'agents.profiles', profiles.map((current, position) => position === index ? profile : current));
}
