export const REDACTED_VALUE = '[REDACTED]' as const;

const DEFAULT_SECRET_KEY_PATTERN =
  /token|password|passwd|secret|authorization|api[_-]?key|private[_-]?key|cookie/i;

export interface RedactOptions {
  secrets?: readonly string[];
  replacement?: string;
  sensitiveKeyPattern?: RegExp;
}

/**
 * Redact explicit secret values in strings and redact values stored beneath
 * commonly-sensitive object keys. The input is not mutated.
 */
export function redactSecrets<T>(value: T, optionsOrSecrets: RedactOptions | readonly string[] = {}): T {
  const options: RedactOptions = Array.isArray(optionsOrSecrets)
    ? { secrets: optionsOrSecrets }
    : (optionsOrSecrets as RedactOptions);
  const replacement = options.replacement ?? REDACTED_VALUE;
  const sensitiveKeyPattern = options.sensitiveKeyPattern ?? DEFAULT_SECRET_KEY_PATTERN;
  const secrets = [...(options.secrets ?? [])]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  const explicitSecretPattern =
    secrets.length === 0
      ? undefined
      : new RegExp(secrets.map((secret) => escapeRegExp(secret)).join('|'), 'g');
  const visited = new WeakMap<object, unknown>();

  const redact = (current: unknown, sensitive = false): unknown => {
    if (sensitive) return replacement;
    if (typeof current === 'string') {
      return explicitSecretPattern === undefined
        ? current
        : current.replace(explicitSecretPattern, () => replacement);
    }
    if (current === null || typeof current !== 'object') return current;

    const known = visited.get(current);
    if (known !== undefined) return known;

    if (Array.isArray(current)) {
      const output: unknown[] = [];
      visited.set(current, output);
      current.forEach((item) => output.push(redact(item)));
      return output;
    }

    const output: Record<string, unknown> = {};
    visited.set(current, output);
    for (const [key, child] of Object.entries(current)) {
      sensitiveKeyPattern.lastIndex = 0;
      output[key] = redact(child, sensitiveKeyPattern.test(key));
    }
    return output;
  };

  return redact(value) as T;
}

export function redactSecretValues(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
