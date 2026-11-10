import { aiProviders } from './ai-providers/index.js';
import { MODEL_LIST_LIMIT, isModelId, validateAutoModeProviders, validateCustomProviders, validateDisabledProviders, validateModelPreferences, normalizeModelPreferences, validateProviderArgs } from './provider-args.js';
import { jsonObject } from './validation.js';
import { ControlError, type ControlSettings, type DefaultProvider, type Project, type ProviderSettings } from './types.js';

/** Project maps override individual providers; model merge choices override individual models. */
export function effectiveProviderSettings(global: ControlSettings, project?: Project): ControlSettings {
  const local = project?.providerSettings;
  if (!local) return global;
  const result: ControlSettings = { ...global, ...local,
    providerArgs: { ...global.providerArgs, ...local.providerArgs },
    defaultModels: { ...global.defaultModels, ...local.defaultModels },
    disabledModels: { ...global.disabledModels, ...local.disabledModels } };

  result.modelAutoMerge = { ...global.modelAutoMerge };
  for (const provider of aiProviders.ids()) if (local.modelAutoMerge?.[provider]) result.modelAutoMerge[provider] = { ...global.modelAutoMerge?.[provider], ...local.modelAutoMerge[provider] };
  // A project may keep its chosen default enabled independently of the global switch.
  result.disabledProviders = result.disabledProviders.filter(provider => provider !== result.defaultProvider);
  Object.assign(result, normalizeModelPreferences(result));
  return result;
}

export function validateModelAutoMerge(input: unknown): NonNullable<ProviderSettings['modelAutoMerge']> {
  const result: NonNullable<ProviderSettings['modelAutoMerge']> = {};
  for (const [provider, models] of Object.entries(jsonObject(input, 'modelAutoMerge'))) {
    if (!aiProviders.has(provider)) throw new ControlError('Invalid modelAutoMerge provider.');
    const entries = Object.entries(jsonObject(models, 'modelAutoMerge models'));
    if (entries.length > MODEL_LIST_LIMIT || entries.some(([model, enabled]) => !isModelId(model) || typeof enabled !== 'boolean')) throw new ControlError('modelAutoMerge must map model IDs to booleans.');
    result[provider as DefaultProvider] = Object.fromEntries(entries) as Record<string, boolean>;
  }
  return result;
}


/** A project update replaces its sparse override object; null restores global inheritance. */
export function validateProjectProviderSettings(input: unknown, global: ControlSettings): ProviderSettings | undefined {
  if (input === null) return undefined;
  const value = jsonObject(input, 'providerSettings'), result: ProviderSettings = {};
  const keys = ['defaultProvider', 'providerArgs', 'disabledProviders', 'autoModeProviders', 'customProviders', 'defaultModels', 'disabledModels', 'modelAutoMerge'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ControlError('Unknown project provider setting.');
  if (value.defaultProvider !== undefined) {
    if (!aiProviders.has(value.defaultProvider)) throw new ControlError('Invalid defaultProvider.');
    result.defaultProvider = value.defaultProvider as DefaultProvider;
  }
  if (value.providerArgs !== undefined) {
    const args = validateProviderArgs(value.providerArgs);
    result.providerArgs = Object.fromEntries(Object.keys(jsonObject(value.providerArgs, 'providerArgs')).map(key => [key, args[key as DefaultProvider]]));
  }
  if (value.disabledProviders !== undefined) result.disabledProviders = validateDisabledProviders(value.disabledProviders);
  if (value.autoModeProviders !== undefined) result.autoModeProviders = validateAutoModeProviders(value.autoModeProviders);
  if (value.customProviders !== undefined) result.customProviders = validateCustomProviders(value.customProviders);
  const preferences = validateModelPreferences(value, { defaultModels: {}, disabledModels: {} });
  if (value.defaultModels !== undefined) result.defaultModels = Object.fromEntries(Object.keys(jsonObject(value.defaultModels, 'defaultModels')).map(key => [key, preferences.defaultModels[key as DefaultProvider] ?? '']));
  if (value.disabledModels !== undefined) result.disabledModels = Object.fromEntries(Object.keys(jsonObject(value.disabledModels, 'disabledModels')).map(key => [key, preferences.disabledModels[key as DefaultProvider] ?? []]));
  if (value.modelAutoMerge !== undefined) result.modelAutoMerge = validateModelAutoMerge(value.modelAutoMerge);
  if (result.disabledProviders?.includes(result.defaultProvider ?? global.defaultProvider)) throw new ControlError('The default provider cannot be disabled.');
  return result;
}
