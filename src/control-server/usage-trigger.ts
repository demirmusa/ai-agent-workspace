import { ControlError, type DefaultProvider, type Task } from './types.js';
import type { ProviderUsage, UsageWindow } from './ai-providers/usage.js';
import { aiProviders } from './ai-providers/index.js';

export type UsageTrigger = NonNullable<Task['usageTrigger']>;
export type UsageTriggerState = 'open' | 'waiting' | 'changed';
const MAX_MINUTES = 60 * 24 * 31;
/** Antigravity repeats its main windows as buckets; they are already listed as short and weekly. */
const MIRRORED_BUCKETS = new Set(['gemini-5h', 'gemini-weekly']);

/** A window id is `short`, `weekly` or `bucket:<id>`; the same keys the quota dialog uses. */
export interface UsageWindowOption { id: string; label?: string; window: UsageWindow }

const known = (window: UsageWindow): boolean => window.usedPercent !== null || window.resetsAt !== null;

/** The windows a provider really reports right now; placeholders for windows it does not have are left out. */
export function usageWindowOptions(usage: ProviderUsage): UsageWindowOption[] {
  const options: UsageWindowOption[] = [];
  if (known(usage.short)) options.push({ id: 'short', window: usage.short });
  if (known(usage.weekly)) options.push({ id: 'weekly', window: usage.weekly });
  for (const bucket of usage.buckets ?? []) if (!MIRRORED_BUCKETS.has(bucket.id) && known(bucket.window)) options.push({ id: `bucket:${bucket.id}`, label: bucket.label, window: bucket.window });
  return options;
}

/** Validates a quota trigger before reset or after its saved renewal; null clears it. */
export function validateUsageTrigger(value: unknown): UsageTrigger | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ControlError('usageTrigger must be an object.');
  const { provider, window, windowMinutes, withinMinutes, mode, resetsAt } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !aiProviders.has(provider)) throw new ControlError('usageTrigger.provider must be a known AI provider.');
  if (typeof window !== 'string' || !/^(short|weekly|bucket:.+)$/.test(window)) throw new ControlError("usageTrigger.window must be 'short', 'weekly' or 'bucket:<id>'.");
  if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1) throw new ControlError('usageTrigger.windowMinutes must be a positive integer.');
  if (typeof withinMinutes !== 'number' || !Number.isInteger(withinMinutes) || withinMinutes < 1 || withinMinutes > MAX_MINUTES) throw new ControlError(`usageTrigger.withinMinutes must be an integer between 1 and ${MAX_MINUTES}.`);
  if (mode !== undefined && mode !== 'reset') throw new ControlError('usageTrigger.mode must be reset.');
  if (mode === 'reset' && (typeof resetsAt !== 'string' || !Number.isFinite(Date.parse(resetsAt)))) throw new ControlError('usageTrigger.resetsAt must be a valid reset timestamp.');
  return { provider: provider as DefaultProvider, window, windowMinutes, withinMinutes, ...(mode === 'reset' ? { mode, resetsAt: resetsAt as string } : {}) };
}

/** The trigger's window as the provider reports it now: null without any quota data, undefined when that window is gone or changed. */
function currentWindow(trigger: UsageTrigger, usage: ProviderUsage[]): UsageWindow | undefined | null {
  const provider = usage.find(item => item.key === trigger.provider);
  const options = provider ? usageWindowOptions(provider) : [];
  if (!options.length) return null;
  const found = options.find(option => option.id === trigger.window)?.window;
  return found && (trigger.windowMinutes === undefined || found.windowMinutes === trigger.windowMinutes) ? found : undefined;
}

/**
 * `open` once the window resets within the trigger's remaining time and still has quota left,
 * `changed` when the provider no longer has the window the trigger was made for (the plan changed),
 * otherwise `waiting` (also while no quota data is known or the window is used up).
 */
export function usageTriggerState(trigger: UsageTrigger, usage: ProviderUsage[], at: number): UsageTriggerState {
  const window = currentWindow(trigger, usage);
  if (window === null) return 'waiting';
  if (window === undefined) return 'changed';
  if (window.usedPercent !== null && window.usedPercent >= 100) return 'waiting';
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (trigger.mode === 'reset') {
    const target = Date.parse(trigger.resetsAt ?? '');
    return Number.isFinite(target) && at >= target && reset > target && reset > at && window.usedPercent !== null ? 'open' : 'waiting';
  }
  return Number.isFinite(reset) && reset > at && reset - at <= trigger.withinMinutes * 60_000 ? 'open' : 'waiting';
}

/** Why a task left the queue after its quota window changed. */
export const usageTriggerChangedMessage = (provider: string): string => `The quota window this task waits on no longer exists for ${provider} (the plan or its windows changed). Edit the quota trigger and choose a current window.`;
