import { aiProviders, hasOption, isAccountId, OPENCODE_AUTO_PERMISSION, parseProviderArguments } from './ai-providers/index.js';
import { ControlError, type CustomProvider, type DefaultProvider, type Provider, type ProviderArgs, type UsageFooterSettings } from './types.js';
import type { UsageKey } from './ai-providers/usage.js';

export const PROVIDER_ARG_LIMITS = { count: 64, argument: 4096, total: 32768 };
export const emptyProviderArgs = (): ProviderArgs => Object.fromEntries(aiProviders.ids().map((id) => [id, []])) as unknown as ProviderArgs;
const isBuiltin = (value: unknown): value is DefaultProvider => aiProviders.has(value);
/** A usage card key: a provider ID, or `<provider>@<account id>` for one of its accounts. */
const isUsageKey = (value: unknown): value is UsageKey => typeof value === 'string' && (isBuiltin(value) || isBuiltin(value.slice(0, value.indexOf('@'))) && isAccountId(value.slice(value.indexOf('@') + 1)));
const argumentsOf = (provider: DefaultProvider, args: string[]) => parseProviderArguments(aiProviders.require(provider), args);

/** Arrays are argv entries, never shell commands. Partial settings updates preserve other providers. */
export function validateProviderArgs(input: unknown, previous: ProviderArgs = emptyProviderArgs()): ProviderArgs {
  if (input === undefined) return { ...emptyProviderArgs(), ...structuredClone(previous) };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ControlError('providerArgs must contain provider argument arrays.');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !isBuiltin(key))) throw new ControlError(`providerArgs supports ${aiProviders.names('and', 'id')}.`);
  const result = { ...emptyProviderArgs(), ...structuredClone(previous) };
  for (const provider of aiProviders.ids()) {
    if (record[provider] === undefined) continue;
    const args = record[provider];
    if (!Array.isArray(args) || args.length > PROVIDER_ARG_LIMITS.count || args.some((arg) => typeof arg !== 'string' || !arg.trim() || arg.length > PROVIDER_ARG_LIMITS.argument || /[\0\r\n]/.test(arg)) || args.reduce((sum, arg) => sum + String(arg).length, 0) > PROVIDER_ARG_LIMITS.total) throw new ControlError(`${provider} accepts at most 64 arguments, 4096 characters each and 32768 characters total; empty arguments and NUL/newlines are not supported.`);
    argumentsOf(provider, args); result[provider] = [...args];
  }
  return result;
}

/** Explicit task/profile models and task reasoning levels take precedence; planning retains its read-only permission boundary. */
export function effectiveProviderArgs(provider: Provider, map: ProviderArgs | undefined, model: string | undefined, readOnly = false, reasoningEffort?: string): string[] {
  if (provider === 'command') return [];
  const definition = aiProviders.require(provider);
  const effort = reasoningEffort && definition.reasoningEfforts.includes(reasoningEffort) ? reasoningEffort : undefined;
  return [...parseProviderArguments(definition, validateProviderArgs(map)[provider] ?? []).filter((arg) => {
    if (model && ['--model', '-m'].includes(arg.flag)) return false;
    if (effort && definition.reasoningEffortOf(arg)) return false;
    return !readOnly || !definition.isPermissionArgument(arg);
  }).flatMap((arg) => arg.parts), ...(effort ? definition.reasoningArgs(effort) : [])];
}

export function hasProviderOption(provider: keyof ProviderArgs, args: string[], flags: string[]): boolean {
  return hasOption(aiProviders.require(provider), args, flags);
}

/** Capture effective launch options without retaining unrelated provider configuration. */
export function providerExecutionInfo(provider: Provider, map: ProviderArgs, model?: string, reasoningEffort?: string): import('./types.js').RunExecutionInfo {
  const info: import('./types.js').RunExecutionInfo = model ? { model, modelSource: 'configured' } : {};
  if (provider === 'command') return info;
  const definition = aiProviders.require(provider);
  for (const arg of argumentsOf(provider, effectiveProviderArgs(provider, map, model, false, reasoningEffort))) {
    const configured = model ? undefined : definition.modelOf(arg);
    if (configured) { info.model = configured; info.modelSource = 'configured'; }
    const effort = definition.reasoningEffortOf(arg);
    if (effort) info.reasoningEffort = effort;
  }
  return info;
}

/** Options that let each CLI act without approval prompts. OpenCode has no such flag; OPENCODE_PERMISSION is used instead. */
export const AUTO_MODE_ARGS = Object.fromEntries(aiProviders.list().map((provider) => [provider.id, [...provider.autoMode.args]])) as unknown as Record<keyof ProviderArgs, string[]>;
export { OPENCODE_AUTO_PERMISSION };
export function validateAutoModeProviders(input: unknown): DefaultProvider[] {
  if (!Array.isArray(input) || input.some((value) => !isBuiltin(value))) throw new ControlError(`autoModeProviders may only contain ${aiProviders.names('and', 'id')}.`);
  return [...new Set(input as DefaultProvider[])];
}
/** Auto-mode options go first; a permission choice already written in the provider's arguments wins. */
export function withAutoMode(map: ProviderArgs, autoModeProviders: DefaultProvider[] | undefined): ProviderArgs {
  const result = { ...emptyProviderArgs(), ...structuredClone(map) };
  for (const provider of autoModeProviders ?? []) {
    const definition = aiProviders.get(provider);
    if (!definition) continue;
    const args = result[provider] ?? [];
    if (!definition.overridesAutoMode(args)) result[provider] = [...definition.autoMode.args, ...args];
  }
  return result;
}

export const CUSTOM_PROVIDER_LIMIT = 20;
/** Custom providers are argv presets for the command provider; no shell, so no shell syntax to escape. */
export function validateCustomProviders(input: unknown): CustomProvider[] {
  if (!Array.isArray(input) || input.length > CUSTOM_PROVIDER_LIMIT) throw new ControlError(`customProviders must be an array of at most ${CUSTOM_PROVIDER_LIMIT} providers.`);
  const ids = new Set<string>(); const names = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ControlError('Each custom provider must be an object.');
    const value = raw as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 60 || /[\0\r\n]/.test(name)) throw new ControlError('Custom provider name must be 1 to 60 characters.');
    const id = typeof value.id === 'string' && value.id ? value.id : name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || (isBuiltin(id) || id === 'command')) throw new ControlError(`Invalid custom provider id: ${id}.`);
    if (ids.has(id) || names.has(name.toLowerCase())) throw new ControlError(`Custom provider ${name} is defined twice.`);
    ids.add(id); names.add(name.toLowerCase());
    const executable = typeof value.executable === 'string' ? value.executable.trim() : '';
    if (!executable || executable.length > 1024 || /[\0\r\n]/.test(executable)) throw new ControlError(`Custom provider ${name} requires an executable (at most 1024 characters).`);
    const args = value.args ?? [];
    if (!Array.isArray(args) || args.length > PROVIDER_ARG_LIMITS.count || args.some((arg) => typeof arg !== 'string' || arg.length > PROVIDER_ARG_LIMITS.argument || /[\0\r\n]/.test(arg))) throw new ControlError(`Custom provider ${name} accepts at most 64 string arguments without NUL or newlines.`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new ControlError('Custom provider enabled must be a boolean.');
    return { id, name, executable, args: [...args] as string[], enabled: value.enabled !== false };
  });
}
/** At least one built-in provider stays enabled so there is always a usable default. */
export function validateDisabledProviders(input: unknown): DefaultProvider[] {
  if (!Array.isArray(input) || input.some((value) => !isBuiltin(value))) throw new ControlError(`disabledProviders may only contain ${aiProviders.names('and', 'id')}.`);
  const result = [...new Set(input as DefaultProvider[])];
  if (result.length >= aiProviders.ids().length) throw new ControlError('Keep at least one built-in provider enabled.');
  return result;
}
/** Footer usage choices: pinned row keys per provider and providers hidden from the footer. Anything absent means "defaults, nothing hidden". */
export function validateUsageFooter(input: unknown): UsageFooterSettings {
  if (input === undefined || input === null) return { pins: {}, hidden: [] };
  if (typeof input !== 'object' || Array.isArray(input)) throw new ControlError('usageFooter must be an object.');
  const { pins = {}, hidden = [] } = input as { pins?: unknown; hidden?: unknown };
  if (typeof pins !== 'object' || pins === null || Array.isArray(pins) || Object.keys(pins).some((key) => !isUsageKey(key))) throw new ControlError('usageFooter.pins must map provider ids to row keys.');
  if (!Array.isArray(hidden) || hidden.some((value) => !isUsageKey(value))) throw new ControlError('usageFooter.hidden may only contain provider ids.');
  const result: UsageFooterSettings = { pins: {}, hidden: [...new Set(hidden as UsageKey[])] };
  for (const [key, rows] of Object.entries(pins)) {
    if (!Array.isArray(rows) || rows.length > 50 || rows.some((row) => typeof row !== 'string' || !row || row.length > 200)) throw new ControlError('usageFooter.pins rows must be short strings.');
    if (rows.length) result.pins[key as UsageKey] = [...new Set(rows as string[])];
  }
  return result;
}
/** Lenient form for settings files: drops what no longer validates instead of refusing to start. */
export function normalizeProviderSettings(settings: { defaultProvider: DefaultProvider; disabledProviders?: unknown; autoModeProviders?: unknown; customProviders?: unknown }): { defaultProvider: DefaultProvider; disabledProviders: DefaultProvider[]; autoModeProviders: DefaultProvider[]; customProviders: CustomProvider[] } {
  // Unknown names are dropped and the saved default stays usable by re-enabling it.
  const listed = Array.isArray(settings.disabledProviders) ? (settings.disabledProviders as unknown[]).filter((value): value is DefaultProvider => isBuiltin(value) && value !== settings.defaultProvider) : [];
  let disabledProviders: DefaultProvider[] = [];
  try { disabledProviders = validateDisabledProviders(listed); } catch { disabledProviders = []; }
  let customProviders: CustomProvider[] = [];
  if (Array.isArray(settings.customProviders)) for (const item of settings.customProviders.slice(0, CUSTOM_PROVIDER_LIMIT)) { try { customProviders = validateCustomProviders([...customProviders, item]); } catch { /* skip invalid entry */ } }
  const defaultProvider = isBuiltin(settings.defaultProvider) && !disabledProviders.includes(settings.defaultProvider) ? settings.defaultProvider : aiProviders.ids().find((provider) => !disabledProviders.includes(provider))!;
  const autoModeProviders = Array.isArray(settings.autoModeProviders) ? [...new Set((settings.autoModeProviders as unknown[]).filter(isBuiltin))] : [];
  return { defaultProvider, disabledProviders, autoModeProviders, customProviders };
}

export const MODEL_LIST_LIMIT = 500;
export const isModelId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
/** A provider's default model is always selectable, so it is dropped from that provider's disabled list. */
export function normalizeModelPreferences(settings: { defaultModels?: unknown; disabledModels?: unknown }): { defaultModels: Partial<Record<DefaultProvider, string>>; disabledModels: Partial<Record<DefaultProvider, string[]>> } {
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const defaults = record(settings.defaultModels), disabled = record(settings.disabledModels);
  const defaultModels: Partial<Record<DefaultProvider, string>> = {}, disabledModels: Partial<Record<DefaultProvider, string[]>> = {};
  for (const provider of aiProviders.ids()) {
    const chosen = isModelId(defaults[provider]) ? defaults[provider].trim() : undefined;
    if (chosen) defaultModels[provider] = chosen;
    const hidden = Array.isArray(disabled[provider]) ? [...new Set((disabled[provider] as unknown[]).filter(isModelId).map((value) => value.trim()))].filter((value) => value !== chosen).slice(0, MODEL_LIST_LIMIT) : [];
    if (hidden.length) disabledModels[provider] = hidden;
  }
  return { defaultModels, disabledModels };
}
/** Strict form for settings updates: unknown providers or malformed lists are refused; omitted fields keep their saved value. */
export function validateModelPreferences(input: { defaultModels?: unknown; disabledModels?: unknown }, previous: { defaultModels: Partial<Record<DefaultProvider, string>>; disabledModels: Partial<Record<DefaultProvider, string[]>> }) {
  for (const key of ['defaultModels', 'disabledModels'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((name) => !isBuiltin(name))) throw new ControlError(`${key} must map ${aiProviders.names('and', 'id')} to model values.`);
    for (const item of Object.values(value as Record<string, unknown>)) if (key === 'defaultModels' ? item !== '' && !isModelId(item) : !Array.isArray(item) || item.length > MODEL_LIST_LIMIT || !item.every(isModelId)) throw new ControlError(`${key} contains an invalid model value.`);
  }
  return normalizeModelPreferences({ defaultModels: input.defaultModels ?? previous.defaultModels, disabledModels: input.disabledModels ?? previous.disabledModels });
}
