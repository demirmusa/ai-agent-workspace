import { execFile, execFileSync } from 'node:child_process';
import { redactUrlCredentials } from '../shared/core/url-credentials.js';
import { ControlError } from './types.js';

/** Every Git command the control server runs. Asynchronous commands never wait on a credential prompt. */
const MAX_BUFFER = 16 * 1024 * 1024;
/** Windows rejects paths over 260 characters ("Filename too long") when Git checks out or removes deep worktree files. */
const LONG_PATHS = ['-c', 'core.longpaths=true'];
const diagnostics = (...output: Array<string | Buffer | undefined>): string => redactUrlCredentials(output.map((value) => value?.toString().trim()).filter(Boolean).join('\n'));
/** Git never waits on a terminal or credential-manager prompt; a command that needs credentials fails instead. */
const noPromptEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });

/** Synchronous Git for quick local commands; a failure becomes a ControlError carrying Git's own output. */
export function git(cwd: string, ...args: string[]): string {
  try { return execFileSync('git', [...LONG_PATHS, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: noPromptEnv() }).trim(); }
  catch (error) {
    const failure = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new ControlError(`Git: ${diagnostics(failure.stdout, failure.stderr) || redactUrlCredentials(failure.message)}`, 409);
  }
}

/**
 * The ref a new task branch starts from: `branch` after pulling its latest state from origin. The local branch is
 * fast-forwarded when that is safe (clean checkout, or not checked out); otherwise the fetched remote ref is returned,
 * so the task still starts from the newest commit and the user's local changes are never touched. Offline or without
 * origin it quietly falls back to what exists locally; null when neither ref exists.
 */
export function latestBaseRef(repository: string, branch: string): string | null {
  const local = `refs/heads/${branch}`, remote = `refs/remotes/origin/${branch}`;
  const sha = (ref: string) => gitQuery(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (gitQuery(repository, ['remote', 'get-url', 'origin'])) { try { git(repository, 'fetch', 'origin', `refs/heads/${branch}:${remote}`); } catch { /* Offline or unauthenticated. */ } }
  if (!sha(remote)) return sha(local) ? local : null;
  if (!sha(local)) return remote;
  if (sha(local) === sha(remote)) return local;
  try { git(repository, 'merge-base', '--is-ancestor', local, remote); } catch { return local; }
  try {
    if (gitQuery(repository, ['symbolic-ref', '--short', 'HEAD']) === branch) { if (gitQuery(repository, ['status', '--porcelain'])) return remote; git(repository, 'merge', '--ff-only', remote); }
    else git(repository, 'fetch', 'origin', `refs/heads/${branch}:${local}`);
    return local;
  } catch { return remote; }
}

/** Output of a read-only Git query, or '' when it fails (not a repository, unknown ref, Git missing). */
export function gitQuery(cwd: string, args: string[], timeout = 5000): string {
  try { return execFileSync('git', [...LONG_PATHS, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'], env: noPromptEnv() }).trim(); }
  catch { return ''; }
}

/** Asynchronous Git with its exit code, so callers can treat a non-zero exit as an answer rather than a failure. */
export function gitResult(cwd: string, args: string[], timeout = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    execFile('git', [...LONG_PATHS, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: MAX_BUFFER, env: noPromptEnv() }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') { reject(new ControlError(`Git: ${diagnostics(stderr) || redactUrlCredentials(error.message)}`, 409)); return; }
      done({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Asynchronous Git that never stalls the service event loop; a non-zero exit becomes a ControlError. */
export async function gitAsync(cwd: string, args: string[], timeout?: number): Promise<string> {
  const result = await gitResult(cwd, args, timeout);
  if (result.code) throw new ControlError(`Git: ${diagnostics(result.stdout, result.stderr) || `git ${args[0]} failed`}`, 409);
  return result.stdout.trim();
}

/** Git accepts the name for a branch, and it cannot be mistaken for an option or a reflog selector. */
export function isBranchName(value: string): boolean {
  if (!value || value.startsWith('-') || value.includes('@{')) return false;
  try { execFileSync('git', ['check-ref-format', '--branch', value], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); return true; }
  catch { return false; }
}
