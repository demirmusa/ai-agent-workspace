import { connect } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
import { usageLimitReason } from './agent-handoff.js';
import { aiProviders } from './ai-providers/index.js';

/**
 * Notices a provider TUI prints when its turn died on the network (not a usage limit or a
 * rejected request). Only a line that starts with the notice counts, so an answer quoting it does not.
 */
const NOTICE = /^[\s●⏺⎿■•✗×│>]*(?:API Error\b|Unable to connect to API\b|stream disconnected before completion\b|error sending request for url\b)/i;
const TRANSIENT = /connection|connect\b|network|socket|timed? ?out|timeout|terminated|overloaded|\b5\d\d\b|internal server error|service unavailable|bad gateway|fetch failed|stream|disconnected|request for url|\bE(?:CONN\w+|TIMEDOUT|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH|PIPE)\b/i;
const REJECTED = /API Error:?\s*4\d\d\b/i;

/** A structured client-side API rejection shown by an interactive provider TUI. */
export function rejectedRequestReason(screen: string): string | undefined {
  for (const line of stripVTControlCharacters(screen).split(/\r?\n/)) {
    const candidate = line.trim().replace(/^[●⏺⎿■•✗×│>\s]+/, '');
    if (!candidate.startsWith('{')) continue;
    try {
      const value = JSON.parse(candidate);
      const status = value?.status;
      const error = value?.error;
      if (typeof status === 'number' && status >= 400 && status < 500 && typeof error?.message === 'string' && /(?:^|_)invalid_request_error$/.test(String(error.type))) {
        return `Provider rejected the request (${status}): ${error.message}`.slice(0, 500);
      }
    } catch { /* Other terminal lines are not structured API errors. */ }
  }
  return undefined;
}

/** The provider line reporting that its turn was cut off by a connection error, if the screen shows one. */
export function connectionErrorReason(screen: string): string | undefined {
  if (usageLimitReason(screen)) return undefined;
  for (const line of stripVTControlCharacters(screen).split(/\r?\n/).reverse()) {
    if (NOTICE.test(line) && TRANSIENT.test(line) && !REJECTED.test(line)) return line.replace(/[│┃|╭╮╰╯─●⏺⎿■•]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return undefined;
}

/** The instruction typed into the TUI to continue a turn the connection cut off. */
export const CONNECTION_CONTINUE_MESSAGE = 'Your previous response was cut off by a connection error. Check what was already done (git status, git diff) and continue the task from where you left off without repeating finished work.';

/** Whether the provider's API (or the configured HTTPS proxy) accepts a TCP connection. */
export function providerReachable(provider: string, timeoutMs = 5000): Promise<boolean> {
  let host = aiProviders.get(provider)?.apiHost ?? 'www.google.com', port = 443;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy) try { const url = new URL(proxy); host = url.hostname; port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443); } catch { /* Malformed proxy: probe the API directly. */ }
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (online: boolean): void => { socket.destroy(); resolve(online); };
    socket.once('connect', () => done(true)); socket.once('timeout', () => done(false)); socket.once('error', () => done(false));
  });
}
