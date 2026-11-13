import type { FilePlan } from '../../templates/writer.js';
import type { AppContext } from './context.js';

/** Prints the generated-file changes of an init/sync/remove plan. */
export function printFilePlan(context: AppContext, plan: FilePlan): void {
  for (const path of plan.create) context.logger.info(`create  ${path}`);
  for (const path of plan.update) context.logger.info(`update  ${path}`);
  for (const path of plan.remove) context.logger.info(`remove  ${path}`);
  if (plan.create.length + plan.update.length + plan.remove.length === 0) {
    context.logger.info('No generated-file changes.');
  }
}
