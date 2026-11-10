import { sha256 } from './hash.js';

export interface DeterministicResourceNames {
  composeProject: string;
  containers: {
    runner: string;
    poller: string;
  };
  images: {
    runner: string;
    agent: string;
  };
  volumes: {
    runner: string;
    workspace: string;
    cache: string;
    claudeAuth: string;
    codexAuth: string;
    opencodeAuth: string;
    scheduler: string;
  };
}

/** A GitHub repository in owner/name form (GitHub's owner and repository name limits). */
export const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

// The base also becomes the default GitHub runner/container stem. Keep room
// for the longest `-runner` suffix under GitHub's 64-character runner-name cap.
const MAX_COMPOSE_NAME_LENGTH = 57;
const HASH_LENGTH = 12;

/**
 * Create stable Docker resource names from a GitHub slug. The digest is based on
 * the unsanitized, case-normalized slug, so slugs which collapse to the same
 * Docker-safe text (for example a.b and a-b) still receive distinct names.
 */
export function deterministicResourceNames(repositorySlug: string): DeterministicResourceNames {
  const { digest, readable } = slugParts(repositorySlug);
  const fixedLength = 'aiws--'.length + digest.length;
  const stemLength = Math.max(1, MAX_COMPOSE_NAME_LENGTH - fixedLength);
  const stem = readable.slice(0, stemLength).replace(/-+$/g, '') || 'r';
  const base = `aiws-${stem}-${digest}`;

  return {
    composeProject: base,
    containers: {
      runner: `${base}-runner`,
      poller: `${base}-poller`,
    },
    images: {
      runner: `${base}-runner:local`,
      agent: `${base}-agent:local`,
    },
    volumes: {
      runner: `${base}-runner`,
      workspace: `${base}-workspace`,
      cache: `${base}-cache`,
      claudeAuth: `${base}-claude-auth`,
      codexAuth: `${base}-codex-auth`,
      opencodeAuth: `${base}-opencode-auth`,
      scheduler: `${base}-scheduler`,
    },
  };
}

export function stableRunnerLabels(repositorySlug: string): string[] {
  const { digest, readable } = slugParts(repositorySlug);
  // GitHub label names are limited to 50 characters. Preserve the digest and
  // the semantic runner suffix when the human-readable portion must be cut.
  const fixedLength = 'aiws---runner'.length + digest.length;
  const stem = readable.slice(0, 50 - fixedLength).replace(/-+$/g, '') || 'r';
  return ['self-hosted', 'linux', `aiws-${stem}-${digest}-runner`];
}

export function repositoryStateKey(repositorySlug: string): string {
  return deterministicResourceNames(repositorySlug).composeProject.replace(/^aiws-/, '');
}

/** Short digest of the case-normalized slug plus its Docker/label-safe readable form. */
function slugParts(repositorySlug: string): { digest: string; readable: string } {
  const normalized = normalizeRepositorySlug(repositorySlug);
  return {
    digest: sha256(normalized).slice(0, HASH_LENGTH),
    readable: normalized.replace('/', '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repository',
  };
}

function normalizeRepositorySlug(repositorySlug: string): string {
  const normalized = repositorySlug.trim().toLowerCase();
  if (!GITHUB_SLUG_PATTERN.test(normalized)) {
    throw new TypeError('Repository slug must be in owner/name form.');
  }
  return normalized;
}
