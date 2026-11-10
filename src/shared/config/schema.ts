import { z } from 'zod';
import { stableRunnerLabels } from '../core/names.js';
import {
  dockerImagePattern, dockerNamePattern, githubActorPattern, GitHubLabelSchema, identifierPattern,
  GitHubCommandSchema, isValidGitBranch, NonEmptyStringSchema, PositiveMinutesSchema, RelativeRepositoryPathSchema,
  RepositorySlugSchema,
} from './primitives.js';

export const CONFIG_SCHEMA_VERSION = 1 as const;

export const RepositorySchema = z
  .object({
    slug: RepositorySlugSchema,
    defaultBranch: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .max(255, 'must be at most 255 characters')
      .refine(isValidGitBranch, { message: 'must be a valid Git branch name' }),
  })
  .strict();

export const SecuritySchema = z
  .object({
    allowedActors: z
      .array(z.string().trim().regex(githubActorPattern, 'must be a GitHub login or *'))
      .min(1, 'must contain at least one trusted GitHub actor')
      .superRefine((actors, context) => {
        const seen = new Set<string>();
        actors.forEach((actor, index) => {
          const key = actor.toLowerCase();
          if (seen.has(key)) {
            context.addIssue({
              code: 'custom',
              path: [index],
              message: `duplicates allowed actor ${actor}`,
            });
          }
          seen.add(key);
        });
      }),
    allowPublicRepository: z.boolean(),
    protectedPaths: z
      .array(RelativeRepositoryPathSchema)
      .max(100, 'must contain at most 100 protected paths')
      .superRefine((paths, context) => {
        const seen = new Set<string>();
        paths.forEach((path, index) => {
          const key = path.replaceAll('\\', '/');
          if (seen.has(key)) {
            context.addIssue({ code: 'custom', path: [index], message: `duplicates protected path ${path}` });
          }
          seen.add(key);
        });
      }),
  })
  .strict();

export const RunnerSchema = z
  .object({
    labels: z
      .array(GitHubLabelSchema)
      .min(1, 'must contain at least one runner label')
      .max(20, 'must contain at most 20 runner labels')
      .superRefine((labels, context) => {
        const seen = new Set<string>();
        labels.forEach((label, index) => {
          const key = label.toLowerCase();
          if (seen.has(key)) {
            context.addIssue({ code: 'custom', path: [index], message: `duplicates runner label ${label}` });
          }
          seen.add(key);
        });
      }),
  })
  .strict();

export const AgentProviderSchema = z.enum(['claude', 'codex', 'opencode']);
/** Agents the Docker runtime installs; every CLI choice and check reads this list. */
export const AGENT_PROVIDERS = AgentProviderSchema.options;
export const AgentEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const AgentProfileSchema = z
  .object({
    id: z.string().trim().regex(identifierPattern, 'must be a lowercase profile identifier'),
    provider: AgentProviderSchema,
    model: z.string().trim().min(1, 'must not be empty').nullable(),
    effort: AgentEffortSchema,
    triggerLabel: GitHubLabelSchema,
    image: z.string().trim().regex(dockerImagePattern, 'must be a valid Docker image reference').optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.provider === 'codex' && profile.effort === 'max') {
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message: 'must be minimal, low, medium, high, or xhigh for Codex',
      });
    }
    if (profile.provider === 'claude' && profile.effort === 'minimal') {
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message: 'must be low, medium, high, xhigh, or max for Claude',
      });
    }
  });

export const AgentsSchema = z
  .object({
    defaultProfile: z.string().trim().regex(identifierPattern, 'must be a lowercase profile identifier'),
    profiles: z.array(AgentProfileSchema).min(1, 'must contain at least one agent profile').max(20),
  })
  .strict()
  .superRefine((agents, context) => {
    const ids = new Set<string>();
    const labels = new Set<string>();
    agents.profiles.forEach((profile, index) => {
      if (ids.has(profile.id)) {
        context.addIssue({ code: 'custom', path: ['profiles', index, 'id'], message: `duplicates profile id ${profile.id}` });
      }
      ids.add(profile.id);

      const label = profile.triggerLabel.toLowerCase();
      if (labels.has(label)) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'triggerLabel'],
          message: `duplicates trigger label ${profile.triggerLabel}`,
        });
      }
      labels.add(label);
    });

    if (!ids.has(agents.defaultProfile)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultProfile'],
        message: 'must refer to an existing agent profile id',
      });
    }
  });

export const QueueProjectSchema = z
  .object({
    owner: NonEmptyStringSchema.max(100),
    ownerType: z.enum(['user', 'organization']),
    number: z.number().int('must be a whole number').positive(),
    statusField: NonEmptyStringSchema.max(100),
    ready: NonEmptyStringSchema.max(100),
    inProgress: NonEmptyStringSchema.max(100),
    inReview: NonEmptyStringSchema.max(100),
    done: NonEmptyStringSchema.max(100),
    organization: NonEmptyStringSchema.max(100).default('Organization'),
  })
  .strict()
  .superRefine((project, context) => {
    const seen = new Set<string>();
    for (const field of ['ready', 'inProgress', 'inReview', 'done', 'organization'] as const) {
      if (seen.has(project[field].toLowerCase())) context.addIssue({ code: 'custom', path: [field], message: 'project lifecycle states must have distinct names' });
      seen.add(project[field].toLowerCase());
    }
  });

export const QueueLabelsSchema = z
  .object({
    ready: GitHubLabelSchema,
    running: GitHubLabelSchema,
    done: GitHubLabelSchema,
    failed: GitHubLabelSchema,
    continue: GitHubLabelSchema,
    organize: GitHubLabelSchema.default('agent-organize'),
    run: GitHubLabelSchema.default('agent-run'),
    waiting: GitHubLabelSchema.default('agent:waiting'),
  })
  .strict();

export const QueueSchema = z
  .object({
    mode: z.enum(['label', 'project', 'both']),
    labels: QueueLabelsSchema,
    project: QueueProjectSchema.optional(),
    pollSeconds: z.number().int('must be a whole number').min(10).max(3600),
  })
  .strict()
  .superRefine((queue, context) => {
    if ((queue.mode === 'project' || queue.mode === 'both') && queue.project === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['project'],
        message: `is required when queue.mode is ${queue.mode}`,
      });
    }

    const labels = Object.entries(queue.labels) as Array<
      [keyof typeof queue.labels, string]
    >;
    const seen = new Map<string, string>();
    for (const [name, label] of labels) {
      const previous = seen.get(label.toLowerCase());
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['labels', name],
          message: `duplicates queue.labels.${previous}`,
        });
      }
      seen.set(label.toLowerCase(), name);
    }
  });

export const CommandsSchema = z
  .object({
    issue: GitHubCommandSchema,
    pr: GitHubCommandSchema,
    test: GitHubCommandSchema,
  })
  .strict()
  .superRefine((commands, context) => {
    const seen = new Map<string, string>();
    (Object.entries(commands) as Array<[keyof typeof commands, string]>).forEach(([name, command]) => {
      const previous = seen.get(command.toLowerCase());
      if (previous !== undefined) {
        context.addIssue({ code: 'custom', path: [name], message: `duplicates commands.${previous}` });
      }
      seen.set(command.toLowerCase(), name);
    });
  });

export const BriefSchema = z
  .object({
    instructionFiles: z.array(RelativeRepositoryPathSchema).max(20),
    extra: z.string().max(20_000, 'must be at most 20000 characters'),
    maxIssueComments: z.number().int('must be a whole number').min(0).max(1_000),
    maxPullRequestComments: z.number().int('must be a whole number').min(0).max(1_000),
    maxCharacters: z.number().int('must be a whole number').min(1_000).max(1_000_000),
  })
  .strict();

export const AgentResourcesSchema = z
  .object({
    cpus: z.number().positive().max(256),
    memory: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?[bkmg]$/i, 'must be a Docker memory value such as 4g or 512m'),
    pids: z.number().int('must be a whole number').positive().max(1_048_576),
  })
  .strict();

export const DockerNetworkSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(128)
  .regex(dockerNamePattern, 'must be bridge, host, none, or a valid Docker network name');

export const AgentTimeoutsSchema = z
  .object({
    issueMinutes: PositiveMinutesSchema,
    prMinutes: PositiveMinutesSchema,
    hookMinutes: PositiveMinutesSchema,
    startupSeconds: z.number().int('must be a whole number').min(5).max(3600),
    shutdownSeconds: z.number().int('must be a whole number').min(1).max(600),
  })
  .strict()
  .superRefine((timeouts, context) => {
    const overheadMinutes = lifecycleOverheadMinutes(timeouts);
    for (const field of ['issueMinutes', 'prMinutes', 'hookMinutes'] as const) {
      if (timeouts[field] + overheadMinutes > 360) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `plus lifecycle overhead (${overheadMinutes} minutes) must not exceed GitHub's 360-minute job limit`,
        });
      }
    }
  });

export const AgentRuntimeSchema = z
  .object({
    resources: AgentResourcesSchema,
    network: DockerNetworkSchema,
    timeouts: AgentTimeoutsSchema,
  })
  .strict();

const HookEnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
  z.string().max(8_192, 'must be at most 8192 characters'),
).superRefine((environment, context) => {
  const entries = Object.keys(environment);
  if (entries.length > 50) {
    context.addIssue({ code: 'custom', message: 'must contain at most 50 variables' });
  }
  entries.forEach((name) => {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTHORIZATION|COOKIE|API_?KEY)/i.test(name)) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: 'sensitive hook environment names are not allowed',
      });
    }
  });
});

export const DockerHookSchema = z
  .object({
    run: z.string().trim().min(1, 'must not be empty').max(8_192),
    image: z.string().trim().regex(dockerImagePattern, 'must be a valid Docker image reference').optional(),
    dockerfile: RelativeRepositoryPathSchema.optional(),
    context: RelativeRepositoryPathSchema.optional(),
    timeoutMinutes: PositiveMinutesSchema.optional(),
    network: DockerNetworkSchema.optional(),
    resources: AgentResourcesSchema.partial().optional(),
    environment: HookEnvironmentSchema.optional(),
  })
  .strict()
  .superRefine((hook, context) => {
    if (hook.image !== undefined && hook.dockerfile !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['image'],
        message: 'must be omitted when dockerfile is set',
      });
    }
    if (hook.context !== undefined && hook.dockerfile === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['context'],
        message: 'requires dockerfile',
      });
    }
  });

export const CustomDockerHookSchema = DockerHookSchema.safeExtend({
  id: z.string().trim().regex(identifierPattern, 'must be a lowercase hook identifier'),
  command: GitHubCommandSchema,
  label: GitHubLabelSchema.optional(),
}).strict();

export const HooksSchema = z
  .object({
    test: DockerHookSchema.optional(),
    custom: z.array(CustomDockerHookSchema).max(30).default([]),
  })
  .strict()
  .superRefine((hooks, context) => {
    const ids = new Set<string>();
    const commands = new Set<string>();
    hooks.custom.forEach((hook, index) => {
      if (ids.has(hook.id)) {
        context.addIssue({ code: 'custom', path: ['custom', index, 'id'], message: `duplicates hook id ${hook.id}` });
      }
      ids.add(hook.id);

      const command = hook.command.toLowerCase();
      if (commands.has(command)) {
        context.addIssue({
          code: 'custom',
          path: ['custom', index, 'command'],
          message: `duplicates hook command ${hook.command}`,
        });
      }
      commands.add(command);
    });
  });

const ProfileSelectionSchema = z.string().trim().regex(identifierPattern).nullable().default(null);
export const OrchestrationSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(50).default(6),
}).strict();
export const OrganizationSchema = z.object({
  enabled: z.boolean().default(true),
  profile: ProfileSelectionSchema,
}).strict();
export const ReviewSchema = z.object({
  enabled: z.boolean().default(false),
  profile: ProfileSelectionSchema,
  onPullRequest: z.boolean().default(true),
  profiles: z.array(z.string().trim().regex(identifierPattern)).max(10).default([]),
}).strict();

export const RepoConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    repository: RepositorySchema,
    security: SecuritySchema,
    runner: RunnerSchema,
    agents: AgentsSchema,
    queue: QueueSchema,
    commands: CommandsSchema,
    brief: BriefSchema,
    hooks: HooksSchema,
    agent: AgentRuntimeSchema,
    orchestration: OrchestrationSchema.prefault({}),
    organization: OrganizationSchema.prefault({}),
    review: ReviewSchema.prefault({}),
  })
  .strict()
  .superRefine((config, context) => {
    const reviewProfiles = new Set<string>();
    config.review.profiles.forEach((profile, index) => {
      if (reviewProfiles.has(profile) || !config.agents.profiles.some(({ id }) => id === profile)) context.addIssue({ code: 'custom', path: ['review', 'profiles', index], message: 'must be a unique, existing agent profile id' });
      reviewProfiles.add(profile);
    });
    for (const section of ['organization', 'review'] as const) {
      const profile = config[section].profile;
      if (profile !== null && !config.agents.profiles.some(({ id }) => id === profile)) {
        context.addIssue({ code: 'custom', path: [section, 'profile'], message: 'must refer to an existing agent profile id' });
      }
    }
    const reserved = new Map<string, string>([
      [config.commands.issue.toLowerCase(), 'commands.issue'],
      [config.commands.pr.toLowerCase(), 'commands.pr'],
      [config.commands.test.toLowerCase(), 'commands.test'],
    ]);
    config.hooks.custom.forEach((hook, index) => {
      const path = reserved.get(hook.command.toLowerCase());
      if (path !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['hooks', 'custom', index, 'command'],
          message: `duplicates ${path}`,
        });
      }
    });

    const requiredRunnerLabels = stableRunnerLabels(config.repository.slug);
    for (const required of requiredRunnerLabels) {
      if (!config.runner.labels.some((label) => label.toLowerCase() === required.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: ['runner', 'labels'],
          message: `must include the repository-scoped runner label ${required}`,
        });
      }
    }

    for (const requiredPath of ['.github/workflows/**', '.aiworkspace/**']) {
      if (!config.security.protectedPaths.includes(requiredPath)) {
        context.addIssue({
          code: 'custom',
          path: ['security', 'protectedPaths'],
          message: `must include the control-plane path ${requiredPath}`,
        });
      }
    }

    const triggerLabels = new Map<string, string>();
    for (const [name, label] of Object.entries(config.queue.labels)) {
      triggerLabels.set(label.toLowerCase(), `queue.labels.${name}`);
    }
    config.agents.profiles.forEach((profile, index) => {
      const key = profile.triggerLabel.toLowerCase();
      const previous = triggerLabels.get(key);
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['agents', 'profiles', index, 'triggerLabel'],
          message: `duplicates ${previous}`,
        });
      }
      triggerLabels.set(key, `agents.profiles.${index}.triggerLabel`);
    });
    config.hooks.custom.forEach((hook, index) => {
      if (hook.label === undefined) return;
      const key = hook.label.toLowerCase();
      const previous = triggerLabels.get(key);
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['hooks', 'custom', index, 'label'],
          message: `duplicates ${previous}`,
        });
      }
      triggerLabels.set(key, `hooks.custom.${index}.label`);
    });

    const overheadMinutes = lifecycleOverheadMinutes(config.agent.timeouts);
    if (Math.max(1, config.review.profiles.length) * (config.agent.timeouts.prMinutes + overheadMinutes) > 360) {
      context.addIssue({ code: 'custom', path: ['review', 'profiles'], message: 'combined reviewer timeouts exceed the 360-minute job limit; reduce agent.timeouts.prMinutes or reviewer count' });
    }
    const validateHookTimeout = (timeoutMinutes: number | undefined, path: (string | number)[]): void => {
      if (timeoutMinutes !== undefined && timeoutMinutes + overheadMinutes > 360) {
        context.addIssue({
          code: 'custom',
          path,
          message: `plus lifecycle overhead (${overheadMinutes} minutes) must not exceed GitHub's 360-minute job limit`,
        });
      }
    };
    validateHookTimeout(config.hooks.test?.timeoutMinutes, ['hooks', 'test', 'timeoutMinutes']);
    config.hooks.custom.forEach((hook, index) => {
      validateHookTimeout(hook.timeoutMinutes, ['hooks', 'custom', index, 'timeoutMinutes']);
    });
  });

export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentEffort = z.infer<typeof AgentEffortSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type QueueProject = z.infer<typeof QueueProjectSchema>;
export type DockerHook = z.infer<typeof DockerHookSchema>;
export type CustomDockerHook = z.infer<typeof CustomDockerHookSchema>;
export type AgentResources = z.infer<typeof AgentResourcesSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoConfigInput = z.input<typeof RepoConfigSchema>;

function lifecycleOverheadMinutes(timeouts: {
  startupSeconds: number;
  shutdownSeconds: number;
}): number {
  return Math.ceil((timeouts.startupSeconds + timeouts.shutdownSeconds) / 60) + 5;
}
