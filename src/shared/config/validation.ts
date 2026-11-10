import { z, type ZodIssue, type ZodType } from 'zod';
import { RepoConfigSchema, type RepoConfig } from './schema.js';
import { InstallationStateSchema, type InstallationState } from './installation-schema.js';

export interface FriendlyValidationIssue {
  path: string;
  message: string;
}

export class ConfigurationValidationError extends Error {
  readonly kind: string;
  readonly issues: readonly FriendlyValidationIssue[];

  constructor(kind: string, issues: readonly FriendlyValidationIssue[]) {
    super(formatValidationError(kind, issues));
    this.name = 'ConfigurationValidationError';
    this.kind = kind;
    this.issues = issues;
  }
}


export function formatZodIssues(issues: readonly ZodIssue[]): FriendlyValidationIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function formatValidationError(
  kind: string,
  issues: readonly FriendlyValidationIssue[],
): string {
  const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n');
  return `Invalid ${kind}${details.length === 0 ? '.' : `:\n${details}`}`;
}

export function parseRepoConfig(value: unknown): RepoConfig {
  return parseConfiguration(RepoConfigSchema, value, 'repository configuration');
}

export function parseInstallationState(value: unknown): InstallationState {
  return parseConfiguration(InstallationStateSchema, value, 'installation state');
}

export function parseConfiguration<T>(schema: ZodType<T>, value: unknown, kind = 'configuration'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigurationValidationError(kind, formatZodIssues(result.error.issues));
  }
  return result.data;
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: ConfigurationValidationError };

export function validateRepoConfig(value: unknown): ValidationResult<RepoConfig> {
  return validateConfiguration(RepoConfigSchema, value, 'repository configuration');
}

export function validateInstallationState(value: unknown): ValidationResult<InstallationState> {
  return validateConfiguration(InstallationStateSchema, value, 'installation state');
}

function validateConfiguration<T>(schema: z.ZodType<T>, value: unknown, kind: string): ValidationResult<T> {
  try {
    return { success: true, data: parseConfiguration(schema, value, kind) };
  } catch (error) {
    if (error instanceof ConfigurationValidationError) return { success: false, error };
    throw error;
  }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>';
  return path.reduce<string>((rendered, part) => {
    if (typeof part === 'number') return `${rendered}[${part}]`;
    const key = String(part);
    return rendered.length === 0 ? key : `${rendered}.${key}`;
  }, '');
}
