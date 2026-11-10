import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ErrorLog } from '../error-log.js';

let directory = '';
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

test('writes the message, context and full stack trace to logs/errors.log', () => {
  directory = mkdtempSync(join(tmpdir(), 'aiws-errorlog-'));
  const log = new ErrorLog(directory);
  log.error(new TypeError('boom'), 'POST /x');
  log.write({ source: 'ui', message: 'ui failure', stack: 'at somewhere (a.js:1:1)' });
  const text = readFileSync(join(directory, 'logs', 'errors.log'), 'utf8');
  expect(text).toContain('server boom');
  expect(text).toContain('at POST /x');
  expect(text).toContain('TypeError: boom');
  expect(text).toContain('ui ui failure');
  expect(text).toContain('at somewhere (a.js:1:1)');
});
