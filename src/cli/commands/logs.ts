import { AiwsError } from '../../shared/core/logger.js';
import { composeLogs } from '../../runtime/compose.js';
import type { AppContext } from './context.js';
import { parsePositiveInteger } from './input.js';
import { loadRepository, runtimeExists } from './repository-context.js';

export interface LogsOptions {
  service: 'all' | 'runner' | 'poller';
  follow: boolean;
  tail: string;
}

export async function runLogs(context: AppContext, options: LogsOptions): Promise<void> {
  const loaded = await loadRepository(context);
  if (options.service === 'poller' && loaded.config.queue.mode === 'label') {
    throw new AiwsError('This repository does not have a Projects poller.');
  }
  if (loaded.installation.target === 'local' && !(await runtimeExists(loaded.localRuntimeDirectory))) {
    throw new AiwsError('The local runtime is not prepared.', 2, 'Run `aiws up` first.');
  }
  await composeLogs(context.runner, loaded.installation, loaded.targetRuntimeDirectory, {
    follow: options.follow,
    tail: parsePositiveInteger(options.tail, '--tail'),
    service: options.service,
  });
}

