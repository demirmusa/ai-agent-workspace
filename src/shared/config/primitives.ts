import { z } from 'zod';
import { GITHUB_SLUG_PATTERN } from '../core/names.js';

/** Value formats shared by the tracked repository config and the local installation state. */
export const githubActorPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?|\*)$/;
const githubLabelPattern = /^[^\u0000-\u001f\u007f,]{1,50}$/;
const commandPattern = /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const identifierPattern = /^[a-z][a-z0-9_-]{0,63}$/;
export const dockerNamePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
export const dockerImagePattern = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
export const githubSecretPattern = /^[A-Z_][A-Z0-9_]*$/;

export const NonEmptyStringSchema = z.string().trim().min(1, 'must not be empty');
export const PositiveMinutesSchema = z.number().int('must be a whole number').min(1).max(360);

export const RepositorySlugSchema = z
  .string()
  .trim()
  .regex(GITHUB_SLUG_PATTERN, 'must be a GitHub repository in owner/name form');

export const GitHubCommandSchema = z
  .string()
  .trim()
  .regex(commandPattern, 'must start with / and contain only letters, numbers, - or _');

export const GitHubLabelSchema = z
  .string()
  .trim()
  .regex(githubLabelPattern, 'must be a valid GitHub label of at most 50 characters')
  // Labels are rendered into workflow `runs-on`/`if:` values, where `${{` would start an Actions expression.
  .refine((value) => !value.includes('${{'), { message: 'must not contain a GitHub Actions expression (${{)' });

export const RelativeRepositoryPathSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(512, 'must be at most 512 characters')
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value), {
    message: 'must be relative to the repository root',
  })
  .refine(
    (value) => !value.replaceAll('\\', '/').split('/').some((segment) => segment === '..'),
    { message: 'must not traverse outside the repository' },
  )
  .refine((value) => !value.includes('\0'), { message: 'must not contain NUL bytes' });

/** Git's branch-name rules (git check-ref-format --branch), without spawning git. */
export function isValidGitBranch(value: string): boolean {
  if (
    value === '@' ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}
