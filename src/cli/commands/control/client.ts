import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveControlUrl } from '../../../shared/core/control-endpoint.js';

/** Longest API error body quoted in a CLI error; a proxy or crash page can be huge. */
const MAX_ERROR_TEXT = 2_000;

/** One JSON request to the control API; the token, when set, travels only as a bearer header. */
export async function controlRequest(base: string, token: string | undefined, path: string, method = 'GET', body?: unknown): Promise<any> {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(180_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error: Error & { cause?: { code?: string } }) => {
    const reason = error.cause?.code ?? (error.name === 'TimeoutError' ? 'timed out' : error.message);
    throw new Error(`Cannot reach the AIWS control server at ${base} (${reason}). Open the desktop app or run "aiws control serve", or set its address with --url or AIWS_CONTROL_URL.`);
  });
  const value = await response.text();
  let parsed: any;
  try { parsed = value ? JSON.parse(value) : null; } catch { parsed = value; }
  if (!response.ok) throw new Error(typeof parsed?.error === 'string' ? parsed.error : `Control API ${response.status}: ${value.slice(0, MAX_ERROR_TEXT)}`);
  return parsed;
}

/** Calls the control API of the `--url` given to `aiws control`, authenticated by AIWS_CONTROL_TOKEN. */
export async function request(command: Command, path: string, method?: string, body?: unknown): Promise<any> {
  const options = command.optsWithGlobals<{ url?: string }>();
  return await controlRequest(resolveControlUrl(options.url), process.env.AIWS_CONTROL_TOKEN, path, method, body);
}

export const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
/** Comma-separated option values; an empty string clears the selection. */
export const ids = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
/** `general` addresses the general workspace project. */
export const projectRef = (value: string): string => value === 'general' ? 'project_general' : value;
export const readLocalText = async (path: string): Promise<string> => await readFile(resolve(path), 'utf8');
export const readLocalJson = async (path: string): Promise<unknown> => JSON.parse(await readLocalText(path));
/** Path segment for an ID typed by the user. */
export const segment = (value: string): string => encodeURIComponent(value);

/** Validates a textual boolean option; undefined stays undefined. */
export function booleanOption(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new Error(`${flag} must be true or false.`);
  return value === 'true';
}
/** `true`, `false` or `inherit` (null: use the project setting). */
export function inheritableBooleanOption(value: string | undefined, flag: string): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (!['true', 'false', 'inherit'].includes(value)) throw new Error(`${flag} must be true, false or inherit.`);
  return value === 'inherit' ? null : value === 'true';
}
