import type { IncomingMessage, ServerResponse } from 'node:http';

/** The `/api/events` Server-Sent Events feed: a full state on connect, then every change as one `data:` message. */
const SLOW_CLIENT_BYTES = 4_000_000, HEARTBEAT_MS = 15_000;

export class EventStreams {
  private readonly streams = new Map<ServerResponse, NodeJS.Timeout>();

  get size(): number { return this.streams.size; }

  open(request: IncomingMessage, response: ServerResponse, initial: unknown): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`retry: 1500\ndata: ${JSON.stringify(initial)}\n\n`);
    const heartbeat = setInterval(() => { response.write(': keepalive\n\n'); }, HEARTBEAT_MS); heartbeat.unref();
    this.streams.set(response, heartbeat);
    const drop = (): void => this.drop(response);
    request.once('close', drop); response.once('close', drop); response.once('error', drop);
  }

  /** Sends one event to every client; one that cannot keep up is disconnected, reconnects and receives a fresh full state. */
  send(type: string, value: object): void {
    if (!this.streams.size) return;
    const message = `data: ${JSON.stringify({ type, ...value })}\n\n`;
    for (const stream of this.streams.keys()) {
      if (stream.writableLength > SLOW_CLIENT_BYTES) { this.drop(stream); stream.end(); } else stream.write(message);
    }
  }

  close(): void { for (const stream of [...this.streams.keys()]) { this.drop(stream); stream.end(); } }

  private drop(stream: ServerResponse): void {
    const heartbeat = this.streams.get(stream); if (!heartbeat) return;
    clearInterval(heartbeat); this.streams.delete(stream);
  }
}
