import { rmSync } from 'node:fs';

/** Removes a test's temporary folder; a Windows PTY console host can hold a workspace for a moment after its program exits. */
export async function removeTempRoot(root: string): Promise<void> {
  for (const end = Date.now() + 10_000; ;) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch (error) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() > end) throw error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
}
