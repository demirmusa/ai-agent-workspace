import { createHash } from 'node:crypto';

export type Hashable = string | Uint8Array;

/** Returns the lowercase hexadecimal SHA-256 digest of a string or byte array. */
export function sha256(value: Hashable): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * JSON.stringify with recursively sorted object keys. Arrays deliberately retain
 * their order. This is useful for reproducible manifests and state fingerprints.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value === undefined) {
    return null;
  }

  throw new TypeError(`Value of type ${typeof value} cannot be represented as canonical JSON.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
