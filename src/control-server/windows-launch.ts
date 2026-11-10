import { execFile, spawn, spawnSync, type ExecFileException } from 'node:child_process';

export interface PowerShellHost { executable: string; standardArguments: boolean }
let cachedHost: PowerShellHost | undefined;
function hostFrom(status: number | null, stdout: string): PowerShellHost {
  const version = /PowerShell\s+(\d+)\.(\d+)/i.exec(stdout);
  const standardArguments = status === 0 && Boolean(version && (Number(version[1]) > 7 || Number(version[1]) === 7 && Number(version[2]) >= 3));
  return { executable: standardArguments ? 'pwsh.exe' : 'powershell.exe', standardArguments };
}
function powerShellHost(): PowerShellHost {
  if (cachedHost) return cachedHost;
  const probe = spawnSync('pwsh.exe', ['--version'], { windowsHide: true, timeout: 2500, maxBuffer: 1024, encoding: 'utf8' });
  return cachedHost = hostFrom(probe.status, probe.stdout ?? '');
}
/** Probe PowerShell in the background at startup, so the first launch does not wait for it. */
export function warmPowerShellHost(): void {
  if (process.platform !== 'win32' || cachedHost) return;
  execFile('pwsh.exe', ['--version'], { windowsHide: true, timeout: 2500, maxBuffer: 1024, encoding: 'utf8' }, (error, stdout) => {
    cachedHost ??= hostFrom(error ? 1 : 0, stdout ?? '');
  });
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => resolve()); killer.once('close', () => resolve());
  });
}
/**
 * taskkill /T only sees the children that exist when it runs, so a launcher killed while it starts can
 * leave behind the process it creates a moment later. Such orphans keep the dead launcher as their parent
 * and are swept up afterwards; the creation time excludes unrelated processes of a recycled parent ID.
 */
export async function killWindowsProcessTree(pid: number, startedAt: number): Promise<void> {
  await taskkill(pid);
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Where-Object { $_.CreationDate -ge [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAt) - 1000}).LocalDateTime } | ForEach-Object { $_.ProcessId }`;
  const orphans = await new Promise<number[]>((resolve) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
    (error, stdout) => resolve(error ? [] : stdout.split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 0))));
  await Promise.all(orphans.map(taskkill));
}

/** cmd.exe re-parses a batch launcher's command line: these characters can end a quoted argument, expand a variable or start a new command. */
const CMD_UNSAFE = /["%^&|<>()!\r\n]/;
/**
 * Runs a CLI found on PATH and collects its output. Batch launchers need cmd.exe, so the arguments must be fixed
 * words and the path must not contain cmd metacharacters; null when they do and the CLI cannot be run safely.
 */
export function execCli(path: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; cwd?: string }): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> | null {
  const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(path);
  if (batch && (/["%^&|<>]/.test(path) || args.some((arg) => !arg || /\s/.test(arg) || CMD_UNSAFE.test(arg)))) return null;
  // cmd.exe resolves %~dp0 of a quoted bare name to the working directory, where npm.cmd then fails to find its own files.
  const launcher = /[\\/\s]/.test(path) ? `"${path}"` : path;
  const [file, argv] = batch ? [options.env.ComSpec ?? options.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', `"${launcher} ${args.join(' ')}"`]] : [path, [...args]];
  return new Promise((resolve) => {
    execFile(file, argv, { ...options, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: batch }, (error, stdout, stderr) => resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

const BATCH_GUARD = String.raw`$aiwsCommand = Get-Command -Name $env:AIWS_EXECUTABLE -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1; if ($aiwsCommand -and $aiwsCommand.Path -match '\.(cmd|bat)$' -and @($aiwsArgs | Where-Object { $_ -match '["%\r\n]' }).Count) { [Console]::Error.WriteLine("$($aiwsCommand.Path) is a batch launcher; cmd.exe cannot pass an argument containing a quote, % or a line break safely. Install the native or PowerShell launcher of this CLI."); exit 1 }; `;
/**
 * No user argument becomes PowerShell source; PS 7.3+ preserves native argv quotes. A command that resolves to a
 * .cmd/.bat launcher runs through cmd.exe, which cannot keep an argument holding a quote, % or a line break intact
 * (a prompt such as `a" & calc` would start another command), so such arguments are refused for batch launchers.
 */
export function windowsLauncher(executable: string, args: string[], env: NodeJS.ProcessEnv, host?: PowerShellHost): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform !== 'win32' || /\.(?:exe|com)$/i.test(executable)) return { executable, args, env };
  const shell = host ?? powerShellHost();
  if (!shell.standardArguments && args.some((arg) => arg.includes('"') || arg === '' || /\s/.test(arg) && /\\$/.test(arg))) throw new Error('This Windows launcher requires PowerShell 7.3 or newer to preserve quoted or empty CLI arguments. Install PowerShell 7.3+ or use a native .exe launcher. Plain flags such as --yolo remain supported by Windows PowerShell.');
  return { executable: shell.executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `${shell.standardArguments ? "$PSNativeCommandArgumentPassing = 'Standard'; " : ''}[string[]]$aiwsArgs = ConvertFrom-Json $env:AIWS_EXEC_ARGS; ${BATCH_GUARD}& $env:AIWS_EXECUTABLE @aiwsArgs; if ($null -eq $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE`],
    env: { ...env, AIWS_EXECUTABLE: executable, AIWS_EXEC_ARGS: JSON.stringify(args) } };
}
