#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { ConsoleLogger, AiwsError } from '../shared/core/logger.js';
import { createProgram } from './program.js';

export { createProgram } from './program.js';

export async function runCli(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

export function handleFatal(error: unknown): void {
  // The reader of our output is gone; reporting that would hit the same closed pipe and re-enter here forever.
  if ((error as NodeJS.ErrnoException | null)?.code === 'EPIPE') process.exit(1);
  const logger = new ConsoleLogger();
  if (error instanceof AiwsError) {
    logger.error(error.message);
    if (error.hint) logger.info(`Hint: ${error.hint}`);
    process.exitCode = error.exitCode;
    return;
  }
  logger.error(error instanceof Error ? error.message : String(error));
  if (process.env.AIWS_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
}

export function isDirectEntrypoint(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  let entry = resolve(argvEntry);
  try { entry = realpathSync.native(entry); } catch { /* Preserve normal detection for a not-yet-built path. */ }
  let modulePath: string;
  try { modulePath = fileURLToPath(moduleUrl); } catch { return false; }
  try { modulePath = realpathSync.native(modulePath); } catch { modulePath = resolve(modulePath); }
  return process.platform === 'win32' ? modulePath.toLowerCase() === entry.toLowerCase() : modulePath === entry;
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);
  await runCli();
}
