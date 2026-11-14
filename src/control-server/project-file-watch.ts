import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { toPosixPath } from '../shared/core/paths.js';
import { invalidateProjectFileSearch } from './project-files.js';

/**
 * Watches the project folders that an open files panel shows. A panel leases its folder (`lease`) and renews the lease while it is
 * open; changes below the folder are batched and reported as the folders whose listing changed, so the panel reloads only those.
 * Created, deleted and renamed entries all change their parent folder's listing.
 */
/** `folders` lists the changed folders (`''` is the root); `all` means every folder may have changed. Git status is reloaded either way. */
export interface ProjectFilesChange { projectId: string; root: string; folders: string[]; all?: boolean }

export const FILE_WATCH_LEASE_MS = 60_000;
const BATCH_MS = 150, MAX_FOLDERS = 200;

interface Watch { watcher: FSWatcher | undefined; projectIds: Set<string>; expires: number; folders: Set<string>; all: boolean; timer: NodeJS.Timeout | undefined }

/** The folder whose listing a changed path belongs to; `undefined` for paths inside `.git`. */
export function changedFolder(path: string): string | undefined {
  const posix = toPosixPath(path).replace(/^\/+|\/+$/g, '');
  if (posix === '.git' || posix.startsWith('.git/')) return undefined;
  return posix.includes('/') ? posix.slice(0, posix.lastIndexOf('/')) : '';
}

export class ProjectFileWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly notify: (change: ProjectFilesChange) => void, private readonly watchFolder: typeof watch = watch) {
    this.sweep = setInterval(() => this.expire(), 10_000); this.sweep.unref();
  }

  /** Starts or renews watching a project folder. `watching` is false when the system cannot watch it, so the caller polls instead. */
  async lease(projectId: string, folder: string): Promise<{ watching: boolean; leaseMs: number }> {
    const root = await realpath(folder);
    let entry = this.watches.get(root);
    if (!entry) {
      entry = { watcher: undefined, projectIds: new Set(), expires: 0, folders: new Set(), all: false, timer: undefined };
      try {
        entry.watcher = this.watchFolder(root, { recursive: true, persistent: false }, (_event, name) => this.record(root, name == null ? undefined : String(name)));
        // A watcher that fails (the folder was removed, the system ran out of watches) leaves the caller to poll.
        entry.watcher.on('error', () => { const failed = this.watches.get(root); try { failed?.watcher?.close(); } catch { /* Already closed. */ } if (failed) failed.watcher = undefined; this.record(root, undefined); });
      } catch { entry.watcher = undefined; }
      this.watches.set(root, entry);
    }
    entry.projectIds.add(projectId); entry.expires = Date.now() + FILE_WATCH_LEASE_MS;
    return { watching: Boolean(entry.watcher), leaseMs: FILE_WATCH_LEASE_MS };
  }

  close(): void { clearInterval(this.sweep); for (const root of [...this.watches.keys()]) this.stop(root); }

  private record(root: string, name: string | undefined): void {
    const entry = this.watches.get(root); if (!entry) return;
    if (name === undefined) entry.all = true;
    else {
      const folder = changedFolder(name);
      if (folder === undefined) { /* Inside .git: only the Git status changed. */ }
      else if (entry.folders.size >= MAX_FOLDERS) entry.all = true;
      else entry.folders.add(folder);
    }
    entry.timer ??= setTimeout(() => this.flush(root), BATCH_MS);
  }

  private flush(root: string): void {
    const entry = this.watches.get(root); if (!entry) return;
    entry.timer = undefined;
    const folders = entry.all ? [] : [...entry.folders].sort(), all = entry.all;
    entry.folders.clear(); entry.all = false;
    if (all || folders.length) invalidateProjectFileSearch(root);
    for (const projectId of entry.projectIds) this.notify({ projectId, root, folders, ...(all ? { all } : {}) });
  }

  private expire(): void { const now = Date.now(); for (const [root, entry] of this.watches) if (entry.expires < now) this.stop(root); }

  private stop(root: string): void {
    const entry = this.watches.get(root); if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.watcher?.close(); } catch { /* Already closed. */ }
    this.watches.delete(root);
  }
}
