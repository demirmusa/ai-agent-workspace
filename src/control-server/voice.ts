import { homedir } from 'node:os';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { aiProviders } from './ai-providers/index.js';
import type { VoiceConnection } from './ai-providers/voice.js';
import { ControlError } from './types.js';

export const VOICE_PATH = '/api/voice';
/** One PCM chunk from the browser is about 100 ms; anything far larger is not audio from our client. */
const MAX_CHUNK = 256 * 1024;
/** Audio held while the provider connection opens; about 30 s of PCM. A client that sends more is cut off. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/**
 * Relays a browser's microphone audio to the speech service of one provider and the transcripts back.
 * Browser to server: binary PCM frames and `{"type":"finish"}`. Server to browser: `ready`, `transcript`, `error`, `closed`.
 */
export class VoiceRelay {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CHUNK });

  constructor(private readonly options: { authorize(request: IncomingMessage, url: URL): void; env?: NodeJS.ProcessEnv; home?: string }) {}

  /** Accepts the upgrade when it is for the voice path; returns false to let other upgrades through. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== VOICE_PATH) return false;
    try {
      this.options.authorize(request, url);
      const provider = aiProviders.get(url.searchParams.get('provider') ?? '');
      if (!provider?.voice) throw new ControlError('This provider has no voice input.', 404);
      const language = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(url.searchParams.get('language') ?? '') ? url.searchParams.get('language')! : 'en';
      this.sockets.handleUpgrade(request, socket, head, (client) => { void this.serve(client, provider.id, language); });
    } catch (error) {
      const code = error instanceof ControlError ? error.statusCode : 500;
      socket.end(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Error'}\r\nConnection: close\r\n\r\n`);
    }
    return true;
  }

  close(): void { for (const client of this.sockets.clients) client.terminate(); this.sockets.close(); }

  private async serve(client: WebSocket, providerId: string, language: string): Promise<void> {
    const provider = aiProviders.require(providerId);
    const tell = (message: object): void => { if (client.readyState === client.OPEN) client.send(JSON.stringify(message)); };
    let upstream: VoiceConnection | undefined, closed = false;
    const queue: Buffer[] = []; let finish = false, queued = 0;
    client.on('message', (data, binary) => {
      if (binary) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (upstream) upstream.send(chunk);
        else if ((queued += chunk.length) > MAX_QUEUED_BYTES) { tell({ type: 'error', message: 'Too much audio before the speech service was ready.' }); client.close(); }
        else queue.push(chunk);
        return;
      }
      try { if ((JSON.parse(String(data)) as { type?: unknown }).type === 'finish') { if (upstream) upstream.finish(); else finish = true; } } catch { /* Not a control message. */ }
    });
    client.on('close', () => { closed = true; upstream?.close(); });
    try {
      const env = this.options.env ?? process.env, home = this.options.home ?? homedir();
      upstream = await provider.voice!.open({ home, env, dir: provider.homeDirectory(env, home) }, { language }, {
        onReady: () => { tell({ type: 'ready' }); for (const chunk of queue.splice(0)) upstream?.send(chunk); if (finish) upstream?.finish(); },
        onTranscript: (text, final) => tell({ type: 'transcript', text, final }),
        onError: (message) => tell({ type: 'error', message }),
        onClose: () => { tell({ type: 'closed' }); client.close(); },
      });
      if (closed) upstream.close();
    } catch (error) {
      tell({ type: 'error', message: (error as Error).message }); client.close();
    }
  }
}

/** Routes WebSocket upgrades of the control server to the voice relay; other upgrades are refused. */
export function attachVoiceRelay(server: Server, relay: VoiceRelay): void {
  server.on('upgrade', (request, socket, head) => { if (!relay.upgrade(request, socket, head)) socket.destroy(); });
}
