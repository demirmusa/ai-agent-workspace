import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlService } from '../../service.js';
import type { PluginManager } from '../../plugins.js';
import type { TokenUsageMonitor } from '../../token-usage.js';
import type { ProviderDetector } from '../../provider-detection.js';
import type { ErrorLog } from '../../error-log.js';
import { readJsonBody, sendJson } from '../request.js';

/** What the API routes work with; built once by the server. */
export interface RouteServices {
  service: ControlService; plugins: PluginManager; tokenUsage: TokenUsageMonitor; providerDetector: ProviderDetector; errorLog: ErrorLog;
  /** Reports, or with `install` installs, the bundled plugin development skill. */
  pluginSkill(install: boolean, force?: boolean): Promise<unknown>;
}

/** One API request split as /api/<resource>/<id>/<action>/<parts[4]>/... */
export class RouteContext {
  readonly parts: string[]; readonly resource: string | undefined; readonly id: string | undefined; readonly action: string | undefined;
  readonly query: URLSearchParams;
  constructor(readonly request: IncomingMessage, readonly response: ServerResponse, readonly url: URL, readonly path: string, readonly method: string, readonly app: RouteServices) {
    this.parts = path.split('/').filter(Boolean); this.resource = this.parts[1]; this.id = this.parts[2]; this.action = this.parts[3]; this.query = url.searchParams;
  }
  get service(): ControlService { return this.app.service; }
  /** The JSON body; `maximum` raises the default 2 MiB limit for uploads. */
  body(maximum?: number): Promise<unknown> { return readJsonBody(this.request, maximum); }
  /** Query parameters as a plain object, for list and page options. */
  params(): Record<string, string> { return Object.fromEntries(this.query); }
  /** Sends a JSON reply; returns true so a route can `return c.send(...)`. */
  send(code: number, value: unknown): true { sendJson(this.response, code, value); return true; }
  ok(): true { return this.send(200, { ok: true }); }
}

/** Handles the request and returns true, or returns false when no route of this resource matches. */
export type RouteHandler = (c: RouteContext) => Promise<boolean>;
