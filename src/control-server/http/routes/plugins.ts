import { PLUGIN_API_VERSION, PLUGIN_INSTALL_BODY_BYTES } from '../../plugins.js';
import { jsonObject } from '../../validation.js';
import { SECURITY_HEADERS } from '../request.js';
import type { RouteHandler } from './context.js';

/** Plugin API: install/update/remove, settings, storage, logs, the plugins' own server routes and the development skill. */
// A plugin route may choose its body and content type, never weaken the headers that keep the UI isolated.
const PROTECTED_HEADERS = new Set([...Object.keys(SECURITY_HEADERS), 'Set-Cookie', 'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials'].map((name) => name.toLowerCase()));
// The control token and cookies stay with the server; plugin code sees the rest of the request headers.
const PRIVATE_REQUEST_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export const pluginRoutes: Record<string, RouteHandler> = {
  async plugins(c) {
    const { plugins } = c.app, id = c.id;
    if (!id && c.method === 'GET') return c.send(200, { apiVersion: PLUGIN_API_VERSION, directory: plugins.directory, plugins: await plugins.list() });
    if (!id && c.method === 'POST') return c.send(201, await plugins.install(await c.body(PLUGIN_INSTALL_BODY_BYTES)));
    if (!id) return false;
    if (!c.action && c.method === 'GET') return c.send(200, await plugins.info(id));
    if (!c.action && c.method === 'PATCH') return c.send(200, await plugins.update(id, await c.body()));
    if (!c.action && c.method === 'DELETE') { await plugins.uninstall(id); return c.ok(); }
    if (c.action === 'logs' && c.method === 'GET') return c.send(200, { logs: await plugins.pluginLogs(id) });
    if (c.action === 'storage') {
      const key = c.parts[4];
      if (c.method === 'GET') return c.send(200, key ? { value: await plugins.storage(id, key) } : { values: await plugins.storage(id) });
      if (key && c.method === 'PUT') { await plugins.setStorage(id, key, jsonObject(await c.body()).value); return c.ok(); }
      if (key && c.method === 'DELETE') { await plugins.setStorage(id, key, null); return c.ok(); }
    }
    if (c.action === 'routes') {
      const headers = Object.fromEntries(Object.entries(c.request.headers).filter(([name]) => !PRIVATE_REQUEST_HEADERS.has(name)));
      const result = await plugins.route(id, c.method, c.parts.slice(4).join('/'), { query: c.params(), body: ['GET', 'HEAD'].includes(c.method) ? undefined : await c.body(), headers });
      const own = Object.fromEntries(Object.entries(result.headers).filter(([name]) => !PROTECTED_HEADERS.has(name.toLowerCase())));
      const typed = Object.keys(own).some((name) => name.toLowerCase() === 'content-type');
      c.response.writeHead(result.status, { ...(typed ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), 'Cache-Control': 'no-store', ...own });
      c.response.end(result.status === 204 || c.method === 'HEAD' ? undefined : typed && (typeof result.body === 'string' || Buffer.isBuffer(result.body)) ? result.body : JSON.stringify(result.body));
      return true;
    }
    return false;
  },
  async 'plugin-skill'(c) {
    if (c.id) return false;
    if (c.method === 'GET') return c.send(200, await c.app.pluginSkill(false));
    if (c.method === 'POST') return c.send(200, await c.app.pluginSkill(true, jsonObject(await c.body()).force === true));
    return false;
  },
};
