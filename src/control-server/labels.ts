import { createHash } from 'node:crypto';
import { ControlError, type ProjectLabel } from './types.js';

/** GitHub's limits: names up to 50 characters, six-digit hex colors, descriptions up to 100 characters. */
export const LABEL_NAME_LIMIT = 50, LABEL_DESCRIPTION_LIMIT = 100, LABEL_LIMIT = 500;
const palette = ['d73a4a', '0075ca', 'cfd3d7', 'a2eeef', '7057ff', '008672', 'e4e669', 'd876e3', 'fbca04', '0e8a16', 'b60205', '5319e7', '1d76db', 'c5def5', 'f9d0c4', 'bfdadc'];

export const labelKey = (name: string): string => name.trim().toLocaleLowerCase('en-US');
/** A stable color per name, so a label created from a task tag looks the same everywhere. */
export function defaultLabelColor(name: string): string { return palette[createHash('sha256').update(labelKey(name)).digest()[0]! % palette.length]!; }

export function validateLabel(input: unknown): ProjectLabel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ControlError('Each label must be an object with a name.');
  const value = input as Record<string, unknown>;
  if (typeof value.name !== 'string') throw new ControlError('Label name must be text.');
  const name = value.name.trim();
  if (!name || name.length > LABEL_NAME_LIMIT) throw new ControlError(`Label names must be 1-${LABEL_NAME_LIMIT} characters.`);
  if (name.includes(',')) throw new ControlError('Label names cannot contain commas.');
  const color = value.color === undefined || value.color === '' ? defaultLabelColor(name) : String(value.color).replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(color)) throw new ControlError('Label color must be a six-digit hex color, for example d73a4a.');
  const description = value.description ?? '';
  if (typeof description !== 'string' || description.length > LABEL_DESCRIPTION_LIMIT) throw new ControlError(`Label descriptions must be text, at most ${LABEL_DESCRIPTION_LIMIT} characters.`);
  return { name, color, description };
}

/** Validates a whole catalog; names are unique without regard to case, as on GitHub. */
export function validateLabels(input: unknown): ProjectLabel[] {
  if (!Array.isArray(input) || input.length > LABEL_LIMIT) throw new ControlError(`labels must be an array of at most ${LABEL_LIMIT} labels.`);
  const labels = input.map(validateLabel), seen = new Set<string>();
  for (const label of labels) { if (seen.has(labelKey(label.name))) throw new ControlError(`Label '${label.name}' is listed more than once.`); seen.add(labelKey(label.name)); }
  return labels;
}

/** Adds `incoming` labels; existing ones keep their spelling and take the incoming color and description when `overwrite` is set. */
export function mergeLabels(current: ProjectLabel[], incoming: ProjectLabel[], overwrite = false): { labels: ProjectLabel[]; added: string[]; updated: string[] } {
  const labels = current.map((label) => ({ ...label })), added: string[] = [], updated: string[] = [];
  for (const label of incoming) {
    const existing = labels.find((entry) => labelKey(entry.name) === labelKey(label.name));
    if (!existing) { if (labels.length >= LABEL_LIMIT) break; labels.push({ ...label }); added.push(label.name); continue; }
    if (overwrite && (existing.color !== label.color || existing.description !== label.description)) { existing.color = label.color; existing.description = label.description; updated.push(existing.name); }
  }
  return { labels, added, updated };
}

/** Task tags spelled like their project label, without duplicates. */
export function canonicalTags(tags: string[], labels: ProjectLabel[]): string[] {
  const result: string[] = [], seen = new Set<string>();
  for (const tag of tags.map((value) => value.trim()).filter(Boolean)) {
    const key = labelKey(tag); if (seen.has(key)) continue; seen.add(key);
    result.push(labels.find((label) => labelKey(label.name) === key)?.name ?? tag);
  }
  return result;
}

export const sameLabels = (left: string[], right: string[]): boolean => {
  const a = [...new Set(left.map(labelKey))].sort(), b = [...new Set(right.map(labelKey))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
