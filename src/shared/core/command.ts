import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { redactSecretValues } from './redact.js';

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdio?: 'pipe' | 'inherit';
  timeoutMs?: number;
  redact?: string[];
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args?: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult, secrets: readonly string[] = []) {
    // Very short values would redact ordinary words; real tokens are long.
    const redact = secrets.filter((secret) => secret.length >= 4);
    const rendered = redactSecretValues(
      `${result.command} ${result.args.join(' ')} exited with code ${result.exitCode}${
        result.stderr.trim() ? `: ${result.stderr.trim()}` : ''
      }`,
      redact,
    );
    super(rendered);
    this.name = 'CommandError';
    this.result = {
      ...result,
      stdout: redactSecretValues(result.stdout, redact),
      stderr: redactSecretValues(result.stderr, redact),
    };
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[] = [],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const stdio = options.stdio ?? 'pipe';
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        shell: false,
        stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      if (stdio === 'pipe') {
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
      }

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }

      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
            forceKillTimer.unref();
          }, options.timeoutMs)
        : undefined;
      timer?.unref();

      child.once('error', (error) => {
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(error);
      });
      child.once('close', (code) => {
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const result: CommandResult = {
          command,
          args: [...args],
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: timedOut ? `${stderr}\nCommand timed out.`.trim() : stderr,
        };
        if (result.exitCode === 0) {
          resolve(result);
        } else {
          reject(new CommandError(result, options.redact));
        }
      });
    });
  }
}

const NATIVE_LAUNCHERS = ['.exe', '.cmd', '.bat', '.com'];
const NON_LAUNCHERS = [...NATIVE_LAUNCHERS, '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.msc', '.cpl'];

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (process.platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * Finds a command on PATH without a shell or a process start (`where`/`which` cost one each). Windows tries native
 * launchers first, then the other PATHEXT entries, then PowerShell scripts; a name with an extension is used as is.
 */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const extensions = process.platform !== 'win32' || extname(name) ? [''] : [...NATIVE_LAUNCHERS, ...(env.PATHEXT ?? env.Pathext ?? '').split(';').map((value) => value.toLowerCase()).filter((value) => value && !NON_LAUNCHERS.includes(value)), '.ps1'];
  if (isAbsolute(name) || /[\\/]/.test(name)) { for (const extension of extensions) if (await isExecutableFile(name + extension)) return name + extension; return null; }
  const pathValue = env[Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'] ?? '';
  for (const directory of pathValue.split(delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    for (const extension of extensions) { const candidate = join(directory, name + extension); if (await isExecutableFile(candidate)) return candidate; }
  }
  return null;
}

/** True when a command is on PATH; resolved in-process, so no shell sees the name. */
export async function commandExists(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
