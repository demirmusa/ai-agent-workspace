import { ControlError } from './types.js';

/** A request body, or one of its fields, that must be a JSON object; `name` labels the error. */
export function jsonObject(value: unknown, name?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlError(name ? `${name} must be a JSON object.` : 'A JSON object is required.');
  return value as Record<string, unknown>;
}

/** A text field of at most `max` characters without NUL bytes; `fallback` replaces a missing or null value. */
export function jsonText(value: unknown, name: string, fallback = '', max = 20_000): string {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new ControlError(`${name} must be text, at most ${max} characters.`);
  return result;
}
