import { z } from 'zod';
import { deterministicResourceNames } from '../core/names.js';
import { dockerImagePattern, dockerNamePattern, githubSecretPattern, GitHubLabelSchema, NonEmptyStringSchema, RepositorySlugSchema } from './primitives.js';

export const INSTALLATION_SCHEMA_VERSION = 1 as const;

export const SshTargetSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe SSH hostname, address, or config alias'),
    user: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'must be a safe SSH username'),
    port: z.number().int('must be a whole number').min(1).max(65_535),
    identityFile: z.string().trim().min(1, 'must not be empty').optional(),
  })
  .strict();

export const ResourceNamesSchema = z
  .object({
    composeProject: z.string().regex(dockerNamePattern, 'must be a valid Docker Compose project name'),
    containers: z
      .object({
        runner: z.string().regex(dockerNamePattern),
        poller: z.string().regex(dockerNamePattern),
      })
      .strict(),
    images: z
      .object({
        runner: z.string().regex(dockerImagePattern),
        agent: z.string().regex(dockerImagePattern),
      })
      .strict(),
    volumes: z
      .object({
        runner: z.string().regex(dockerNamePattern),
        workspace: z.string().regex(dockerNamePattern),
        cache: z.string().regex(dockerNamePattern),
        claudeAuth: z.string().regex(dockerNamePattern),
        codexAuth: z.string().regex(dockerNamePattern),
        opencodeAuth: z.string().regex(dockerNamePattern).optional(),
        scheduler: z.string().regex(dockerNamePattern).optional(),
      })
      .strict(),
  })
  .strict();

export const InitPullRequestSchema = z
  .object({
    number: z.number().int('must be a whole number').positive(),
    url: z.string().url(),
    headBranch: NonEmptyStringSchema,
    baseBranch: NonEmptyStringSchema,
    headSha: z.string().regex(/^[0-9a-f]{40}$/i, 'must be a full Git commit SHA').optional(),
  })
  .strict();

export const InstallationStateSchema = z
  .object({
    schemaVersion: z.literal(INSTALLATION_SCHEMA_VERSION),
    repository: z.object({ slug: RepositorySlugSchema }).strict(),
    target: z.enum(['local', 'ssh']),
    ssh: SshTargetSchema.optional(),
    names: ResourceNamesSchema,
    runnerName: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .max(64, 'must be at most 64 characters')
      .regex(/^[^\u0000-\u001f\u007f,]+$/, 'must not contain control characters or commas'),
    runnerSlots: z.number().int().min(1).max(50).default(1),
    stateDir: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .refine((value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value), {
        message: 'must be an absolute local or remote path',
      }),
    createdLabels: z.array(GitHubLabelSchema),
    managedSecrets: z.array(
      z.string().trim().regex(githubSecretPattern, 'must be an uppercase GitHub secret name'),
    ),
    initPr: InitPullRequestSchema.nullable(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a SHA-256 hash').optional(),
  })
  .strict()
  .transform((state) => ({
    ...state,
    names: { ...state.names, volumes: {
      ...state.names.volumes,
      opencodeAuth: state.names.volumes.opencodeAuth ?? deterministicResourceNames(state.repository.slug).volumes.opencodeAuth,
      scheduler: state.names.volumes.scheduler ?? deterministicResourceNames(state.repository.slug).volumes.scheduler,
    } },
  }))
  .superRefine((state, context) => {
    if (state.target === 'ssh' && state.ssh === undefined) {
      context.addIssue({ code: 'custom', path: ['ssh'], message: 'is required when target is ssh' });
    }
    if (state.target === 'ssh' && !isSafeAbsolutePosixPath(state.stateDir)) {
      context.addIssue({
        code: 'custom',
        path: ['stateDir'],
        message: 'must be a safe absolute POSIX path for an SSH target',
      });
    }
    if (state.target === 'local' && state.ssh !== undefined) {
      context.addIssue({ code: 'custom', path: ['ssh'], message: 'must be omitted when target is local' });
    }
    for (const [field, values] of [
      ['createdLabels', state.createdLabels],
      ['managedSecrets', state.managedSecrets],
    ] as const) {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        const key = value.toLowerCase();
        if (seen.has(key)) {
          context.addIssue({ code: 'custom', path: [field, index], message: `duplicates ${value}` });
        }
        seen.add(key);
      });
    }
  });

export type ResourceNames = z.infer<typeof ResourceNamesSchema>;
export type SshTarget = z.infer<typeof SshTargetSchema>;
export type InstallationState = z.infer<typeof InstallationStateSchema>;
export type InstallationStateInput = z.input<typeof InstallationStateSchema>;

function isSafeAbsolutePosixPath(value: string): boolean {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.endsWith('/') || value.includes('//')) return false;
  const parts = value.slice(1).split('/');
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}
