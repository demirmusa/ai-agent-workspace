import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('validates scheduler concurrency, recovery, dependencies and organizer plans', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'runtime/tests/scheduler_test.py'], { encoding: 'utf8' });
  expect(result.error, 'Python 3 is required for runtime tests').toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
