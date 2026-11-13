/** A system-Node helper isolates node-pty's native ABI from Electron's ABI. */
import { spawn as spawnPty, type IPty } from 'node-pty';
import { killWindowsProcessTree, windowsLauncher } from './windows-launch.js';

let terminal: IPty | undefined; let ended = false; let startedAt = 0; let killing: Promise<void> | undefined;
const send = (value: unknown): void => { if (process.connected) process.send?.(value); };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (): void => {
  if (!terminal) return;
  if (process.platform === 'win32') {
    killing ??= killWindowsProcessTree(terminal.pid, startedAt).finally(() => {
      // node-pty's own kill forks a console-list helper that crashes with "AttachConsole failed" whenever the shell exits
      // meanwhile, so the shell is ended directly; the pty is released when this host exits.
      if (ended || !terminal || !isAlive(terminal.pid)) return;
      try { process.kill(terminal.pid); } catch { /* Already exited. */ }
    });
  } else {
    try { process.kill(-terminal.pid, 'SIGCONT'); process.kill(-terminal.pid, 'SIGTERM'); } catch { terminal.kill(); }
    setTimeout(() => { if (!ended && terminal) { try { process.kill(-terminal.pid, 'SIGKILL'); } catch { terminal.kill('SIGKILL'); } } }, 3000).unref();
  }
};
process.on('disconnect', () => { kill(); setTimeout(() => process.exit(1), 4000).unref(); });
process.on('message', (raw: unknown) => {
  const message = raw as Record<string, any>;
  try {
    if (message.type === 'start' && !terminal) {
      const command = windowsLauncher(message.executable as string, message.args as string[], { ...message.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
      // A shell carrying on below earlier output: ConPTY keeps the screen instead of clearing it, and asks once where the cursor is.
      let cursor = message.cursor as { row: number; col: number } | undefined;
      // The bundled ConPTY (not the system's) honours ClearPseudoConsole, which the console's clear button relies on.
      startedAt = Date.now(); terminal = spawnPty(command.executable, command.args, { name: 'xterm-256color', cols: message.cols ?? 100, rows: message.rows ?? 30, cwd: message.cwd, env: command.env as Record<string, string>, useConpty: true, useConptyDll: true, ...(cursor ? { conptyInheritCursor: true } : {}) });
      terminal.onData((data) => {
        if (cursor && data.includes('\x1b[6n')) { terminal?.write(`\x1b[${cursor.row};${cursor.col}R`); cursor = undefined; data = data.replace('\x1b[6n', ''); }
        send({ type: 'output', data });
      });
      terminal.onExit(({ exitCode }) => { if (ended) return; ended = true; send({ type: 'exit', code: exitCode }); void Promise.race([killing, new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() => setTimeout(() => process.exit(0), 20)); });
      send({ type: 'ready', pid: terminal.pid });
    } else if (message.type === 'input') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    // ConPTY keeps its own screen; clearing only the console would leave the shell drawing at the old cursor row.
    else if (message.type === 'clear') terminal?.clear();
    else if (message.type === 'stop') kill();
    else if (message.type === 'pause') {
      if (!terminal) throw new Error('Terminal is not ready.');
      if (process.platform === 'win32') { send({ type: 'paused', mode: 'checkpoint' }); kill(); }
      else { process.kill(-terminal.pid, 'SIGSTOP'); send({ type: 'paused', mode: 'suspended' }); }
    } else if (message.type === 'resume' && terminal) { process.kill(-terminal.pid, 'SIGCONT'); send({ type: 'resumed' }); }
  } catch (error) { send({ type: 'error', message: (error as Error).message }); if (!terminal) process.exitCode = 1; }
});
