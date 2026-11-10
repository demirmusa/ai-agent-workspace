import type { CommandRunner } from '../core/command.js';
import { CommandError } from '../core/command.js';
import { AiwsError } from '../core/logger.js';

export interface GitHubRepositoryMetadata {
  slug: string;
  defaultBranch: string;
  visibility: 'public' | 'private' | 'internal';
  permissions: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    pull: boolean;
  };
}

export interface GitHubRunnerStatus {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: string[];
}

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export class GitHubClient {
  readonly apiVersion = process.env.AIWS_GITHUB_API_VERSION ?? '2026-03-10';
  /** Resolved once per client: every API call needs it, and `gh auth token` is a process start. */
  private resolvedToken: Promise<string> | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly token?: string,
  ) {}

  async resolveToken(): Promise<string> {
    this.resolvedToken ??= this.lookupToken();
    return await this.resolvedToken.catch((error: unknown) => { this.resolvedToken = undefined; throw error; });
  }

  private async lookupToken(): Promise<string> {
    if (this.token) return this.token;
    for (const name of ['AIWS_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    try {
      const token = (await this.runner.run('gh', ['auth', 'token'])).stdout.trim();
      if (token) return token;
    } catch {
      // The actionable error below is more useful than the gh implementation detail.
    }
    throw new AiwsError(
      'GitHub authentication is required.',
      2,
      'Run `gh auth login` or set AIWS_GITHUB_TOKEN. Use a dedicated fine-grained token when possible.',
    );
  }

  async getRepository(slug: string): Promise<GitHubRepositoryMetadata> {
    const json = await this.api<Record<string, unknown>>(`repos/${slug}`);
    const permissions = (json.permissions ?? {}) as Record<string, unknown>;
    return {
      slug: String(json.full_name ?? slug),
      defaultBranch: String(json.default_branch ?? 'main'),
      visibility: normalizeVisibility(json.visibility),
      permissions: {
        admin: Boolean(permissions.admin),
        maintain: Boolean(permissions.maintain),
        push: Boolean(permissions.push),
        pull: Boolean(permissions.pull),
      },
    };
  }

  async getViewerLogin(): Promise<string> {
    const json = await this.api<Record<string, unknown>>('user');
    return String(json.login ?? '');
  }

  async getActionsPermissions(slug: string): Promise<Record<string, unknown>> {
    return await this.api<Record<string, unknown>>(`repos/${slug}/actions/permissions/workflow`);
  }

  async ensureLabels(
    slug: string,
    definitions: readonly LabelDefinition[],
    onCreated?: (name: string) => Promise<void>,
  ): Promise<string[]> {
    const token = await this.resolveToken();
    const result = await this.runner.run(
      'gh',
      ['label', 'list', '--repo', slug, '--limit', '1000', '--json', 'name'],
      { env: { GH_TOKEN: token }, redact: [token] },
    );
    const existing = new Set(
      (JSON.parse(result.stdout) as Array<{ name: string }>).map(({ name }) => name.toLowerCase()),
    );
    const created: string[] = [];
    for (const label of definitions) {
      if (existing.has(label.name.toLowerCase())) continue;
      await this.runner.run(
        'gh',
        [
          'label',
          'create',
          label.name,
          '--repo',
          slug,
          '--color',
          label.color,
          '--description',
          label.description,
        ],
        { env: { GH_TOKEN: token }, redact: [token] },
      );
      created.push(label.name);
      existing.add(label.name.toLowerCase());
      await onCreated?.(label.name);
    }
    return created;
  }

  async deleteLabels(slug: string, labels: readonly string[]): Promise<void> {
    const token = await this.resolveToken();
    for (const label of labels) {
      try {
        await this.runner.run('gh', ['label', 'delete', label, '--repo', slug, '--yes'], {
          env: { GH_TOKEN: token },
          redact: [token],
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  async setSecret(slug: string, name: string, value: string): Promise<void> {
    const token = await this.resolveToken();
    await this.runner.run('gh', ['secret', 'set', name, '--repo', slug], {
      env: { GH_TOKEN: token },
      input: value,
      redact: [token, value],
    });
  }

  async listSecretNames(slug: string): Promise<Set<string>> {
    const names = new Set<string>();
    for (let page = 1; ; page += 1) {
      const response = await this.api<{ secrets?: Array<{ name?: unknown }> }>(
        `repos/${slug}/actions/secrets?per_page=100&page=${page}`,
      );
      const secrets = response.secrets ?? [];
      for (const { name } of secrets) {
        if (typeof name === 'string' && name.trim()) names.add(name.toUpperCase());
      }
      if (secrets.length < 100) return names;
    }
  }

  async deleteSecret(slug: string, name: string): Promise<void> {
    const token = await this.resolveToken();
    try {
      await this.runner.run('gh', ['secret', 'delete', name, '--repo', slug], {
        env: { GH_TOKEN: token },
        redact: [token],
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async createPullRequest(options: {
    slug: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<string> {
    const token = await this.resolveToken();
    const args = [
      'pr',
      'create',
      '--repo',
      options.slug,
      '--base',
      options.base,
      '--head',
      options.head,
      '--title',
      options.title,
      '--body',
      options.body,
    ];
    if (options.draft) args.push('--draft');
    const result = await this.runner.run('gh', args, {
      env: { GH_TOKEN: token },
      redact: [token],
    });
    return result.stdout.trim();
  }

  async listRunners(slug: string): Promise<GitHubRunnerStatus[]> {
    const runners: GitHubRunnerStatus[] = [];
    for (let page = 1; ; page += 1) {
      const json = await this.api<{ runners?: Array<Record<string, unknown>> }>(
        `repos/${slug}/actions/runners?per_page=100&page=${page}`,
      );
      const batch = json.runners ?? [];
      runners.push(...batch.map<GitHubRunnerStatus>((runner) => ({
        id: Number(runner.id),
        name: String(runner.name),
        status: runner.status === 'online' ? 'online' : 'offline',
        busy: Boolean(runner.busy),
        labels: Array.isArray(runner.labels)
          ? runner.labels.map((item) => String((item as Record<string, unknown>).name))
          : [],
      })));
      if (batch.length < 100) return runners;
    }
  }

  async deleteRunner(slug: string, runnerId: number): Promise<void> {
    await this.api(`repos/${slug}/actions/runners/${runnerId}`, { method: 'DELETE' });
  }

  async api<T = unknown>(endpoint: string, options: { method?: string; input?: unknown } = {}): Promise<T> {
    const token = await this.resolveToken();
    const args = [
      'api',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      `X-GitHub-Api-Version: ${this.apiVersion}`,
    ];
    if (options.method) args.push('--method', options.method);
    if (options.input !== undefined) args.push('--input', '-');
    args.push(endpoint);
    const result = await this.runner.run('gh', args, {
      env: { GH_TOKEN: token },
      ...(options.input === undefined ? {} : { input: JSON.stringify(options.input) }),
      redact: [token],
    });
    if (!result.stdout.trim()) return undefined as T;
    return JSON.parse(result.stdout) as T;
  }
}

function normalizeVisibility(value: unknown): 'public' | 'private' | 'internal' {
  if (value === 'public' || value === 'internal') return value;
  return 'private';
}

function isNotFound(error: unknown): boolean {
  return error instanceof CommandError && /(?:HTTP 404|not found)/i.test(error.result.stderr);
}
