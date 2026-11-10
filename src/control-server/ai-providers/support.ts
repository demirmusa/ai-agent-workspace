import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlError, type ProviderModel } from '../types.js';
import type { IAIProvider, ParsedArgument } from './types.js';

export const SESSION_CAP = 5000;

/** Counts session files under a directory, depth-limited and capped so a huge history stays cheap. */
export async function countFiles(root: string, match: (name: string) => boolean, depth: number, budget = { left: SESSION_CAP }): Promise<number> {
  let count = 0; let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (budget.left <= 0) break;
    if (entry.isFile() && match(entry.name)) { count++; budget.left--; }
    else if (entry.isDirectory() && depth > 0) count += await countFiles(join(root, entry.name), match, depth - 1, budget);
  }
  return count;
}

const MODEL_LIMIT = 200;
export const uniqueModels = (models: ProviderModel[]): ProviderModel[] => {
  const seen = new Set<string>();
  return models.filter((model) => model.id && model.id.length <= 200 && !seen.has(model.id) && seen.add(model.id)).slice(0, MODEL_LIMIT);
};

/** Splits argv entries into options with their values, enforcing the provider's argument policy. */
export function parseProviderArguments(provider: IAIProvider, args: string[]): ParsedArgument[] {
  const { values, reserved } = provider.args;
  const result: ParsedArgument[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--' || !argument.startsWith('-') || argument === '-') throw new ControlError(`${provider.id} arguments must be options, not prompts or session IDs. Use --option=value for an option not listed by this application.`);
    const short = [...values, ...reserved].find((flag) => /^-[A-Za-z]$/.test(flag) && argument.startsWith(flag) && argument.length > 2);
    const flag = short ?? argument.split('=', 1)[0]!;
    if (reserved.has(flag)) throw new ControlError(`${provider.id} ${flag} is managed by the application to preserve the project, session and console protocol.`);
    let value = short ? argument.slice(2).replace(/^=/, '') : argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : undefined;
    const parts = [argument];
    if (value === undefined && values.has(flag)) {
      value = args[++index]; if (value === undefined || value.startsWith('-')) throw new ControlError(`${provider.id} ${flag} requires a separate value or --option=value.`);
      parts.push(value);
    }
    const parsed = { flag, parts, ...(value === undefined ? {} : { value }) };
    provider.checkArgument(parsed);
    result.push(parsed);
  }
  return result;
}

export function hasOption(provider: IAIProvider, args: string[], flags: readonly string[]): boolean {
  return parseProviderArguments(provider, args).some((arg) => flags.includes(arg.flag));
}

/** Removes generated options and the value after each boolean-incompatible flag; `booleanFlags` take no separate value. */
export function withoutOptions(args: string[], flags: readonly string[], booleanFlags: readonly string[] = []): string[] {
  const valueFlags = flags.filter((flag) => !booleanFlags.includes(flag));
  return args.filter((argument, index, original) => !flags.includes(argument) && !valueFlags.includes(original[index - 1] ?? ''));
}

/** Longer messages are written to prompt.md, keeping the command line within Windows limits. */
export const DIRECT_PROMPT_LIMIT = 8000;
/** A provider account reference (see ProviderAccounts) as tasks, terminals and usage cards store it. */
export const isAccountId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._@+-]{1,200}$/.test(value);
