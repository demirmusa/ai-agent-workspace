import { describe, expect, it } from 'vitest';
import { buildDefaultRepoConfig } from '../../shared/config/defaults.js';
import { getSetting, setSetting, parseSettingValue } from '../commands/configure.js';

describe('CLI settings', () => {
  const config = () => buildDefaultRepoConfig({ repository: 'owner/repo' });
  it('updates nested array fields without mutating the original', () => {
    const original = config();
    const updated = setSetting(original, 'agents.profiles[0].model', 'custom-model');
    expect(updated.agents.profiles[0]?.model).toBe('custom-model');
    expect(original.agents.profiles[0]?.model).not.toBe('custom-model');
    expect(getSetting(updated, 'agents.profiles.0.model')).toBe('custom-model');
  });
  it('rejects prototype traversal and unknown keys', () => {
    for (const path of ['__proto__.polluted', 'agents.constructor.foo', 'agents..defaultProfile']) {
      expect(() => setSetting(config(), path, true)).toThrow();
    }
    expect(() => setSetting(config(), 'unknown', true)).toThrow();
    expect(() => getSetting(config(), 'queue.absent')).toThrow('Unknown');
  });
  it('enforces cross-field validation on edits', () => {
    expect(() => setSetting(config(), 'agents.defaultProfile', 'missing')).toThrow();
    expect(() => setSetting(config(), 'queue.pollSeconds', 0)).toThrow();
  });
  it('accepts whole sections and preserves JSON types', () => {
    expect(parseSettingValue('true')).toBe(true);
    expect(parseSettingValue('10')).toBe(10);
    expect(parseSettingValue('null')).toBeNull();
    expect(parseSettingValue('["claude"]')).toEqual(['claude']);
    expect(parseSettingValue('openrouter/free')).toBe('openrouter/free');
    expect(setSetting(config(), 'agents.profiles', config().agents.profiles).agents.profiles).toEqual(config().agents.profiles);
  });
});
