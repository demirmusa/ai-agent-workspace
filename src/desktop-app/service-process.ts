/**
 * Runs the local control service in an Electron utility process. Persistence, Git,
 * provider supervision and HTTP streaming therefore never share the browser
 * process that routes window input, so heavy service work cannot freeze the UI.
 */
import { startControlServer } from '../control-server/server.js';

interface ParentPort { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data: unknown }) => void): void }
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('The control service process must be started by the desktop application.');

let closing: Promise<void> | undefined;
try {
  const host = process.env.AIWS_SERVICE_HOST ?? '127.0.0.1', port = Number(process.env.AIWS_SERVICE_PORT ?? '0');
  // The preferred port keeps the window's origin, and with it its storage and caches, across launches; when another
  // program holds it the service takes any free port.
  const server = await startControlServer({ host, port }).catch((error: NodeJS.ErrnoException) => {
    if (!port || error?.code !== 'EADDRINUSE') throw error;
    return startControlServer({ host, port: 0 });
  });
  const shutdown = (): Promise<void> => closing ??= Promise.resolve(server.close()).catch(() => {}).finally(() => { parent.postMessage({ type: 'closed' }); setTimeout(() => process.exit(0), 50); });
  parent.on('message', ({ data }) => { if ((data as { type?: unknown } | null)?.type === 'shutdown') void shutdown(); });
  // A disconnected parent can no longer show this service; release agents and files cleanly.
  process.once('disconnect', () => { void shutdown(); });
  parent.postMessage({ type: 'ready', url: server.url });
} catch (error) {
  parent.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  setTimeout(() => process.exit(1), 50);
}
