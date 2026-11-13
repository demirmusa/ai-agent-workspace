import { utilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OwnedService {
  url: string;
  close(): Promise<void>;
  /** Called once when the service process ends without being asked to close. */
  onUnexpectedExit(listener: (code: number) => void): void;
}

/**
 * The port the desktop service asks for first. A fixed port keeps the window's origin the same on every launch, so its
 * settings in browser storage, the HTTP cache of the interface files and their compiled code survive a restart.
 */
export const DESKTOP_SERVICE_PORT = 47317;

/** Starts the local control service outside the Electron main process. */
export function startOwnedService(options: { host: string; port: number }): Promise<OwnedService> {
  const child = utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'service-process.js'), [], {
    serviceName: 'AI Agent Workspace Service', stdio: 'inherit',
    env: { ...process.env, AIWS_SERVICE_HOST: options.host, AIWS_SERVICE_PORT: String(options.port) },
  });
  let exited = false, closing: Promise<void> | undefined, unexpected: ((code: number) => void) | undefined;
  const exit = new Promise<number>((resolve) => child.once('exit', (code) => { exited = true; resolve(code); }));
  void exit.then((code) => { if (!closing) unexpected?.(code); });
  return new Promise<OwnedService>((resolve, reject) => {
    const failed = (code: number): void => reject(new Error(`Control service exited during startup (code ${code}).`));
    void exit.then(failed);
    child.on('message', (message: { type?: string; url?: string; message?: string }) => {
      if (message?.type === 'error') reject(new Error(message.message ?? 'Control service failed to start.'));
      if (message?.type !== 'ready' || typeof message.url !== 'string') return;
      resolve({
        url: message.url,
        onUnexpectedExit: (listener) => { unexpected = listener; },
        close: () => closing ??= (async () => {
          if (exited) return;
          child.postMessage({ type: 'shutdown' });
          // Stopping agents can take a few seconds; never leave a stuck service behind.
          const timeout = new Promise<void>((done) => setTimeout(() => { if (!exited) child.kill(); done(); }, 20_000));
          await Promise.race([exit.then(() => {}), timeout]);
        })(),
      });
    });
  });
}
