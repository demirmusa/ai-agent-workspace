import { readFile } from 'node:fs/promises';
import { AiwsError } from '../shared/core/logger.js';

const TOKEN_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  source = 'template',
): string {
  const requested = new Set<string>();
  template.replace(TOKEN_PATTERN, (_match, token: string) => {
    requested.add(token);
    return _match;
  });

  const missing = [...requested].filter((token) => values[token] === undefined);
  if (missing.length > 0) {
    throw new AiwsError(`${source} is missing template values: ${missing.join(', ')}`);
  }

  const rendered = template.replace(TOKEN_PATTERN, (_match, token: string) => values[token] ?? '');
  const unresolved = [...rendered.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new AiwsError(`${source} contains unresolved template values: ${unresolved.join(', ')}`);
  }
  return rendered.replace(/\r\n/g, '\n');
}

export async function renderTemplateFile(
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  return renderTemplate(await readFile(path, 'utf8'), values, path);
}

/**
 * A string list as JSON inside a single-quoted GitHub expression literal, e.g. `fromJSON('...')`. Quotes are doubled
 * and braces are JSON-escaped, so no value can close the literal or the surrounding `${{ }}`.
 */
export function githubExpressionJson(values: readonly string[]): string {
  return JSON.stringify(values).replace(/[{}]/g, (brace) => (brace === '{' ? '\\u007b' : '\\u007d')).replaceAll("'", "''");
}

