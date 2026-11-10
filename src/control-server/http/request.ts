import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ControlError } from '../types.js';

/** HTTP plumbing shared by the control server, its routes and the voice WebSocket: guards, JSON bodies and replies. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];
export const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;

/** Every response carries these; the UI loads only its own scripts and is never framed or embedded by another site. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Constant-time token comparison. */
export function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Rejects requests a browser makes on behalf of another site. On loopback the Host must be a known name (DNS rebinding
 * points a foreign name at 127.0.0.1); API calls must come from this origin (CSRF), and a browser-reported cross-site
 * fetch is refused even for reads.
 */
export function requestGuard(listenHost: string, extraHosts = process.env.AIWS_CONTROL_ALLOWED_HOSTS ?? '') {
  const loopback = LOOPBACK_HOSTS.includes(listenHost);
  const allowed = new Set([...LOOPBACK_HOSTS, listenHost, ...extraHosts.split(',').map((value) => value.trim()).filter(Boolean)]);
  return {
    host(request: IncomingMessage, url: URL): void {
      if (loopback && !allowed.has(url.hostname.replace(/^\[|\]$/g, ''))) throw new ControlError('Unexpected Host header.', 403);
    },
    origin(request: IncomingMessage): void {
      const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) throw new ControlError('Cross-origin API requests are not allowed.', 403);
      if (site && site !== 'same-origin' && site !== 'none') throw new ControlError('Cross-site API requests are not allowed.', 403);
    },
  };
}
export type RequestGuard = ReturnType<typeof requestGuard>;

/** The request URL; a malformed percent-encoding is a client error, not a server failure. */
export function requestPath(url: URL): string {
  try { return decodeURIComponent(url.pathname); } catch { throw new ControlError('Invalid request path.', 400); }
}

/** A JSON request body of at most `maximum` bytes; `__proto__` keys are dropped so a body can never reach a prototype. */
export async function readJsonBody(request: IncomingMessage, maximum = DEFAULT_BODY_BYTES): Promise<unknown> {
  const type = request.headers['content-type'];
  if (type && !type.startsWith('application/json')) throw new ControlError('Use application/json for API requests.', 415);
  if (Number(request.headers['content-length']) > maximum) throw new ControlError('Request body is too large.', 413);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array); size += buffer.length;
    if (size > maximum) throw new ControlError('Request body is too large.', 413); chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value: unknown) => key === '__proto__' ? undefined : value) as unknown; }
  catch { throw new ControlError('Invalid JSON request body.'); }
}

export function sendJson(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value));
}

/** Replies with the error as JSON; a stream that already started is just ended. */
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  if (error instanceof ControlError) { sendJson(response, error.statusCode, { error: error.message }); return; }
  sendJson(response, 500, { error: (error as Error)?.message || 'Internal service error.' });
}
