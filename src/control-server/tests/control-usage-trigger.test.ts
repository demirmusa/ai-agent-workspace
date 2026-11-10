import { describe, expect, it } from 'vitest';
import { usageTriggerState, usageWindowOptions, validateUsageTrigger } from '../usage-trigger.js';
import type { ProviderUsage, UsageWindow } from '../ai-providers/usage.js';

const at = Date.parse('2026-01-01T10:00:00Z');
const none: UsageWindow = { usedPercent: null, resetsAt: null, windowMinutes: 300 };
const win = (resetsAt: string | null, windowMinutes: number): UsageWindow => ({ usedPercent: 50, resetsAt, windowMinutes });
const usage = (short: UsageWindow, weekly: UsageWindow, buckets?: ProviderUsage['buckets']): ProviderUsage[] => [{ key: 'claude', name: 'Claude', account: '', source: 'api', updatedAt: null, active: true, retryAt: null, short, weekly, ...(buckets ? { buckets } : {}) }];

describe('usage trigger', () => {
  it('validates and clears', () => {
    const weekly = { provider: 'claude', window: 'weekly', windowMinutes: 10080, withinMinutes: 180 };
    expect(validateUsageTrigger(weekly)).toEqual(weekly);
    expect(validateUsageTrigger({ ...weekly, window: 'bucket:pro' })).toMatchObject({ window: 'bucket:pro' });
    expect(validateUsageTrigger(null)).toBeUndefined();
    expect(() => validateUsageTrigger({ ...weekly, provider: 'nope' })).toThrow(/provider/);
    expect(() => validateUsageTrigger({ ...weekly, window: 'daily' })).toThrow(/window/);
    expect(() => validateUsageTrigger({ ...weekly, windowMinutes: 0 })).toThrow(/windowMinutes/);
    expect(() => validateUsageTrigger({ ...weekly, withinMinutes: 0 })).toThrow(/withinMinutes/);
  });
  it('confirms renewal for short, weekly and bucket windows', () => {
    for (const window of ['short', 'weekly', 'bucket:argon']) {
      const trigger = { provider: 'claude', window, windowMinutes: 300, withinMinutes: 60, mode: 'reset', resetsAt: '2026-01-01T10:00:00Z' } as const;
      expect(validateUsageTrigger(trigger)).toEqual(trigger);
      const data = (reset: string | null, usedPercent: number | null = 0) => {
        const w = { ...win(reset, 300), usedPercent };
        return usage(window === 'short' ? w : none, window === 'weekly' ? w : none, [{ id: 'argon', label: 'Argon', window: w }]);
      };
      expect(usageTriggerState(trigger, data('2026-01-01T15:00:00Z'), at - 1)).toBe('waiting');
      expect(usageTriggerState(trigger, data(trigger.resetsAt), at)).toBe('waiting');
      expect(usageTriggerState(trigger, data(null), at)).toBe('waiting');
      expect(usageTriggerState(trigger, data('2026-01-01T15:00:00Z', null), at)).toBe('waiting');
      expect(usageTriggerState(trigger, data('2026-01-01T15:00:00Z', 100), at)).toBe('waiting');
      expect(usageTriggerState(trigger, data('2026-01-01T15:00:00Z'), at)).toBe('open');
      expect(usageTriggerState(trigger, [], at)).toBe('waiting');
      expect(usageTriggerState(trigger, data('2026-01-01T15:00:00Z'), at + 6 * 3600_000)).toBe('waiting');
      expect(() => validateUsageTrigger({ ...trigger, resetsAt: undefined })).toThrow(/resetsAt/);
      expect(() => validateUsageTrigger({ ...trigger, mode: 'invalid' })).toThrow(/mode/);
    }
  });
  it('lists only the windows a provider reports', () => {
    const [claude] = usage(none, win('2026-01-01T11:00:00Z', 43200), [{ id: 'gemini-5h', label: 'x', window: win(null, 300) }, { id: 'pro', label: 'Pro', window: win('2026-01-02T00:00:00Z', 1440) }]);
    expect(usageWindowOptions(claude).map(option => option.id)).toEqual(['weekly', 'bucket:pro']);
  });
  it('opens only when the window resets within the chosen time', () => {
    const trigger = { provider: 'claude', window: 'short', windowMinutes: 300, withinMinutes: 60 } as const;
    expect(usageTriggerState(trigger, usage(win('2026-01-01T10:59:00Z', 300), none), at)).toBe('open');
    expect(usageTriggerState(trigger, usage(win('2026-01-01T12:00:00Z', 300), none), at)).toBe('waiting');
    expect(usageTriggerState(trigger, usage(win('2026-01-01T09:00:00Z', 300), none), at)).toBe('waiting');
    expect(usageTriggerState(trigger, usage(win(null, 300), none), at)).toBe('waiting');
    expect(usageTriggerState(trigger, usage(none, none), at)).toBe('waiting');
    expect(usageTriggerState(trigger, [], at)).toBe('waiting');
    expect(usageTriggerState({ ...trigger, window: 'weekly', windowMinutes: 10080 }, usage(none, win('2026-01-01T11:00:00Z', 10080)), at)).toBe('open');
  });
  it('keeps waiting while the window has no quota left', () => {
    const trigger = { provider: 'claude', window: 'short', windowMinutes: 300, withinMinutes: 60 } as const;
    expect(usageTriggerState(trigger, usage({ ...win('2026-01-01T10:30:00Z', 300), usedPercent: 100 }, none), at)).toBe('waiting');
    expect(usageTriggerState(trigger, usage({ ...win('2026-01-01T10:30:00Z', 300), usedPercent: 99 }, none), at)).toBe('open');
  });
  it('reports a changed window when the provider no longer has it', () => {
    const weekly = { provider: 'claude', window: 'weekly', windowMinutes: 10080, withinMinutes: 60 } as const;
    expect(usageTriggerState(weekly, usage(none, win('2026-01-01T10:30:00Z', 43200)), at)).toBe('changed');
    expect(usageTriggerState({ ...weekly, window: 'short', windowMinutes: 300 }, usage(none, win('2026-01-01T10:30:00Z', 10080)), at)).toBe('changed');
  });
});
