import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitAsync } from './git.js';
import { ControlError } from './types.js';

/** GitHub REST/GraphQL transport: credential discovery, authenticated requests and error mapping. */
export const REQUIRED_SCOPES = ['repo', 'project'] as const;
export interface GitHubAuthStatus { authenticated: boolean; source: 'service' | 'environment' | 'gh' | null; login?: string; scopes: string[] | null; missing: string[]; message?: string }
/** The folder can still become a GitHub repository with createRepository. */
export class MissingGitHubRemote extends ControlError {}
/** GitHub answered with a server error: nothing is wrong with the request, so the same request can succeed later. */
export class GitHubUnavailable extends ControlError {}
const TRANSIENT_REMOTE_FAILURE = /internal server error|service unavailable|bad gateway|gateway time-?out|(?:returned error:|HTTP(?: error)?) 5\d\d|remote end hung up|early EOF|RPC failed|could not resolve host|failed to connect|connection (?:timed out|reset|refused)|operation timed out/i;
/** An outage or network failure of the remote (Git or GitHub API), as opposed to a problem with the work being delivered. */
export function isTransientRemoteError(error: unknown): boolean {
  if (error instanceof GitHubUnavailable || error instanceof TypeError || (error as Error)?.name === 'TimeoutError') return true;
  return TRANSIENT_REMOTE_FAILURE.test((error as Error)?.message ?? '');
}

/** The token of the GitHub CLI login, or undefined without one. Bounded so a stuck `gh` never stalls a request. */
export async function ghAuthToken(timeout = 5000): Promise<string | undefined> {
  try { return (await promisify(execFile)('gh', ['auth', 'token'], { windowsHide: true, timeout, maxBuffer: 64 * 1024 })).stdout.trim() || undefined; }
  catch { return undefined; }
}

/** An owner/name slug; "." and ".." are refused because they would move a `repos/<slug>/...` API path elsewhere. */
export const isRepositorySlug = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && value.split('/').every((part) => part !== '.' && part !== '..');
/** The REST path of a repository, `repos/<owner>/<name>`, after the slug is checked. */
export function repositoryApi(slug: string): string {
  if (!isRepositorySlug(slug)) throw new ControlError('Invalid GitHub repository.');
  return `repos/${slug}`;
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim();
  const scp = /^(?:[^@\s]+@)?github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (scp) return isRepositorySlug(scp[1]) ? scp[1] : null;
  try { const url = new URL(value); if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const slug = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, ''); return isRepositorySlug(slug) ? slug : null;
  } catch { return null; }
}

export class GitHubApi {
  protected source: GitHubAuthStatus['source'];
  constructor(private token?: string, private readonly request: typeof fetch = fetch) { this.source = token ? 'service' : null; }

  private async credential(): Promise<string> {
    if (!this.token) {
      this.token = process.env.AIWS_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      this.source = this.token ? 'environment' : null;
      if (!this.token) {
        this.token = await ghAuthToken(); this.source = this.token ? 'gh' : null;
        if (!this.token) throw new ControlError('GitHub bağlantısı için AIWS_GITHUB_TOKEN ayarlayın veya gh auth login çalıştırın.', 503);
      }
    }
    return this.token;
  }
  /** Forget a cached gh token, for example after `gh auth refresh` replaced it. Explicit service tokens stay. */
  resetCredential(): void { if (this.source !== 'service') { this.token = undefined; this.source = null; } }
  /** One authenticated request to api.github.com; `path` is relative to the API root. */
  async send(path: string, method: string, body: unknown): Promise<Response> {
    const token = await this.credential();
    const response = await this.request(`https://api.github.com/${path}`, {
      method, signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'aiws-control' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // A rejected gh token is read again next time, after the user re-authorizes.
    if (response.status === 401 && this.source === 'gh') this.resetCredential();
    return response;
  }
  /** JSON of a REST call; a failed status or GraphQL errors become a ControlError. */
  async api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.send(path, method, body);
    if (response.status >= 500) throw new GitHubUnavailable(`GitHub is unavailable (${response.status}).`, 502);
    const raw = await response.text();
    let value: any;
    try { value = raw ? JSON.parse(raw) : undefined; } catch { throw new ControlError(`GitHub geçersiz yanıt verdi (${response.status}).`, 502); }
    if (!response.ok || value?.errors?.length) throw new ControlError(`GitHub: ${value?.errors?.map((error: any) => error.message).join('; ') ?? value?.message ?? response.status}`, 502);
    return value as T;
  }
  async graphql(query: string, variables: Record<string, unknown>): Promise<any> { return (await this.api('graphql', 'POST', { query, variables })).data; }

  async authStatus(): Promise<GitHubAuthStatus> {
    if (this.source === 'gh') this.resetCredential();
    try { await this.credential(); } catch (error) { return { authenticated: false, source: null, scopes: null, missing: [...REQUIRED_SCOPES], message: (error as Error).message }; }
    const response = await this.send('user', 'GET', undefined);
    const value = await response.json().catch(() => undefined) as { login?: string; message?: string } | undefined;
    if (!response.ok) return { authenticated: false, source: this.source, scopes: null, missing: [...REQUIRED_SCOPES], message: `GitHub: ${value?.message ?? response.status}` };
    // Fine-grained tokens and GitHub Apps do not report OAuth scopes; their permissions are checked per request.
    const header = response.headers.get('x-oauth-scopes');
    const scopes = header === null ? null : header.split(',').map((scope) => scope.trim()).filter(Boolean);
    const missing = scopes ? REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : [];
    return { authenticated: true, source: this.source, ...(value?.login ? { login: value.login } : {}), scopes, missing };
  }

  /** owner/name of the repository's github.com remote, preferring origin. */
  async repositorySlug(repositoryPath: string): Promise<string> {
    let slug: string | null = null;
    try {
      const stdout = await gitAsync(repositoryPath, ['remote', '-v'], 10_000);
      const remotes = stdout.split(/\r?\n/).map((line) => /^([^\s]+)\s+([^\s]+)\s+\(fetch\)$/.exec(line)).filter((entry) => entry !== null);
      remotes.sort((a, b) => Number(b[1] === 'origin') - Number(a[1] === 'origin'));
      for (const remote of remotes) { slug = githubRepositoryFromRemote(remote[2] ?? ''); if (slug) break; }
    } catch { throw new MissingGitHubRemote('Bu klasörde okunabilir bir Git repository bulunamadı.'); }
    if (!slug) throw new MissingGitHubRemote('Bu repository içinde github.com remote bulunamadı. Yerel proje olarak kullanabilir veya Git remote ekleyebilirsiniz.');
    return slug;
  }
}
