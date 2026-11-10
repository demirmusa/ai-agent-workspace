import { escapeRegExp } from '../shared/core/redact.js';
import { repositoryApi, type GitHubApi } from './github-api.js';
import { ControlError } from './types.js';
import type { ImageStore } from './attachments.js';

// Task images on GitHub: published to an orphan branch so issue bodies can show them, and mapped back to local attachments.
/** Task images are committed to this orphan-history branch, never to the project's working branches. */
export const ATTACHMENT_BRANCH = 'aiws-attachments';
const localImage = /\/api\/attachments\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))/g;
export const githubImageUrl = (repository: string, id: string) => `https://github.com/${repository}/blob/${ATTACHMENT_BRANCH}/.aiws/attachments/${id}?raw=true`;
/** Published images remembered per process; content-addressed IDs never change, so the set only saves GitHub calls. */
const PUBLISHED_LIMIT = 5000;

export class GitHubImages {
  private published = new Set<string>();
  constructor(private readonly api: GitHubApi) {}

  /** Commits one content-addressed image to the attachment branch unless it is already there. */
  async publish(repository: string, id: string, data: Buffer): Promise<string> {
    const url = githubImageUrl(repository, id), base = repositoryApi(repository), key = `${repository}:${id}`;
    if (this.published.has(key)) return url;
    const path = `.aiws/attachments/${id}`, ref = `heads/${ATTACHMENT_BRANCH}`;
    const head = await this.api.send(`${base}/git/ref/${ref}`, 'GET', undefined);
    let parent: string | undefined, baseTree: string | undefined;
    if (head.ok) {
      parent = String((await head.json() as any).object.sha);
      const existing = await this.api.send(`${base}/contents/${path}?ref=${ATTACHMENT_BRANCH}`, 'GET', undefined); await existing.body?.cancel();
      if (existing.ok) { this.remember(key); return url; }
      baseTree = String((await this.api.api<any>(`${base}/git/commits/${parent}`)).tree.sha);
    } else { await head.body?.cancel(); if (head.status !== 404) throw new ControlError(`GitHub image branch could not be read (${head.status}).`, 502); }
    const blob = await this.api.api<any>(`${base}/git/blobs`, 'POST', { content: data.toString('base64'), encoding: 'base64' });
    const tree = await this.api.api<any>(`${base}/git/trees`, 'POST', { ...(baseTree ? { base_tree: baseTree } : {}), tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await this.api.api<any>(`${base}/git/commits`, 'POST', { message: `Add AIWS task image ${id}`, tree: tree.sha, parents: parent ? [parent] : [] });
    if (parent) await this.api.api(`${base}/git/refs/${ref}`, 'PATCH', { sha: commit.sha });
    else await this.api.api(`${base}/git/refs`, 'POST', { ref: `refs/${ref}`, sha: commit.sha });
    this.remember(key); return url;
  }
  private remember(key: string): void { if (this.published.size >= PUBLISHED_LIMIT) this.published.clear(); this.published.add(key); }

  /** The issue body links images on GitHub; an image that cannot be published keeps its local link and is retried next sync. */
  async toRemote(repository: string, description: string, images?: ImageStore): Promise<string> {
    if (!images) return description;
    let result = description;
    for (const id of new Set([...description.matchAll(localImage)].map((match) => match[1]!))) {
      try { result = result.split(`/api/attachments/${id}`).join(await this.publish(repository, id, (await images.read(id)).data)); }
      catch { /* Missing files or a repository without commits keep the local reference. */ }
    }
    return result;
  }
  /** Images AIWS published come back as local attachments when this machine still has them. */
  async toLocal(repository: string, description: string, images?: ImageStore): Promise<string> {
    if (!images) return description;
    let result = description;
    const pattern = new RegExp(`${escapeRegExp(`https://github.com/${repository}/blob/${ATTACHMENT_BRANCH}/.aiws/attachments/`)}([a-f0-9]{64}\\.(?:png|jpg|gif|webp))\\?raw=true`, 'g');
    for (const id of new Set([...description.matchAll(pattern)].map((match) => match[1]!))) {
      if (await images.exists(id)) result = result.split(githubImageUrl(repository, id)).join(`/api/attachments/${id}`);
    }
    return result;
  }
}
