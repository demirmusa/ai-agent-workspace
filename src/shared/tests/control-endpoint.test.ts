import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTROL_URL, localServiceUrl, resolveControlUrl, SERVICE_LOCK_FILE } from '../core/control-endpoint.js';

describe('control endpoint', () => {
  let directory: string;
  const lock = (value: unknown): void => writeFileSync(join(directory, SERVICE_LOCK_FILE), JSON.stringify(value));
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aiws-endpoint-'));
    vi.stubEnv('AIWS_CONTROL_URL', ''); vi.stubEnv('AIWS_CONTROL_DATA', ''); vi.stubEnv('AIWS_CONTROL_DATA_DIR', directory);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

  it('prefers the given URL, then the environment, then the running service, then the default', () => {
    expect(resolveControlUrl()).toBe(DEFAULT_CONTROL_URL);
    lock({ pid: process.pid, id: 'x', url: 'http://127.0.0.1:47317' });
    expect(resolveControlUrl()).toBe('http://127.0.0.1:47317');
    vi.stubEnv('AIWS_CONTROL_URL', 'http://env.test');
    expect(resolveControlUrl()).toBe('http://env.test');
    expect(resolveControlUrl('http://flag.test')).toBe('http://flag.test');
  });

  it('ignores a lock without an address, from a dead process, stale or damaged', () => {
    lock({ pid: process.pid, id: 'x' });
    expect(localServiceUrl()).toBeUndefined();
    lock({ pid: 2 ** 30, id: 'x', url: 'http://127.0.0.1:1' });
    expect(localServiceUrl()).toBeUndefined();
    lock({ pid: process.pid, id: 'x', url: 'http://127.0.0.1:1' });
    const old = new Date(Date.now() - 120_000); utimesSync(join(directory, SERVICE_LOCK_FILE), old, old);
    expect(localServiceUrl()).toBeUndefined();
    writeFileSync(join(directory, SERVICE_LOCK_FILE), '{');
    expect(localServiceUrl()).toBeUndefined();
  });
});
