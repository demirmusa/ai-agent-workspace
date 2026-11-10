import { confirm } from '@inquirer/prompts';
import { AGENT_PROVIDERS, type AgentProvider } from '../../shared/config/schema.js';
import { isValidGitBranch } from '../../shared/config/primitives.js';
import { AiwsError } from '../../shared/core/logger.js';

// Validation of command-line input and interactive confirmation for destructive steps.

export async function requireConfirmation(
  message: string,
  yes: boolean,
  defaultValue = false,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AiwsError('Confirmation required in a non-interactive terminal.', 2, 'Rerun with --yes.');
  }
  const accepted = await confirm({ message, default: defaultValue });
  if (!accepted) throw new AiwsError('Cancelled.', 130);
}

export function parsePositiveInteger(value: unknown, label: string, fallback?: number): number {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new AiwsError(`${label} must be a positive integer.`);
  return parsed;
}

export function parseProviders(value: string): AgentProvider[] {
  const providers = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (providers.length === 0 || providers.some((item) => !(AGENT_PROVIDERS as readonly string[]).includes(item))) {
    throw new AiwsError('--providers must contain claude, codex, and/or opencode.');
  }
  return providers as AgentProvider[];
}

export function setupBranchName(kind: 'init' | 'sync' | 'remove', version: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `aiws/${kind}-v${version}-${timestamp}`;
}

export function requireGitBranchName(value: string, option = '--branch'): string {
  if (value !== value.trim() || value.length === 0 || value.length > 255 || !isValidGitBranch(value)) {
    throw new AiwsError(`${option} must be a valid Git branch name.`);
  }
  return value;
}

export function parsePullRequestNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:\/|$)/.exec(url);
  return match?.[1] ? Number(match[1]) : undefined;
}
