import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { packageResource } from '../shared/core/assets.js';
import { DEFAULT_CONTROL_PORT } from '../shared/core/control-endpoint.js';
import { ControlService, type ControlServiceOptions } from './service.js';
import { ControlError } from './types.js';
import { TokenUsageMonitor, type TokenUsageOptions } from './token-usage.js';
import { ProviderDetector, type ProviderDetectionOptions } from './provider-detection.js';
import { attachVoiceRelay, VoiceRelay } from './voice.js';
import { PluginManager } from './plugins.js';
import { agentSkillTargets, manageAgentSkills, syncProjectManagerSkill } from '../shared/core/agent-skills.js';
import { LOOPBACK_HOSTS, SECURITY_HEADERS, requestGuard, requestPath, sendError, sendJson, tokenMatches } from './http/request.js';
import { StaticAssets } from './http/static-assets.js';
import { EventStreams } from './http/event-stream.js';
import { StatePatches } from './http/state-patches.js';
import { RouteContext, type RouteHandler, type RouteServices } from './http/routes/context.js';
import { ErrorLog } from './error-log.js';
import { systemRoutes } from './http/routes/system.js';
import { catalogRoutes } from './http/routes/catalog.js';
import { pluginRoutes } from './http/routes/plugins.js';
import { projectRoutes } from './http/routes/projects.js';
import { taskRunRoutes } from './http/routes/tasks.js';

/** The local control server: wires the service, plugins and voice relay to HTTP, guards every request and dispatches /api routes. */
export interface ControlServerOptions extends ControlServiceOptions { host?: string; port?: number; staticDir?: string; tokenUsage?: TokenUsageOptions; providerDetection?: ProviderDetectionOptions }
export interface RunningControlServer { server: Server; service: ControlService; plugins: PluginManager; url: string; close(): Promise<void> }

/** /api/<resource> → its routes; every resource has exactly one owner module. */
const ROUTES: Record<string, RouteHandler> = { ...systemRoutes, ...catalogRoutes, ...pluginRoutes, ...projectRoutes, ...taskRunRoutes };

export async function startControlServer(options: ControlServerOptions = {}): Promise<RunningControlServer> {
  const host = options.host ?? process.env.AIWS_CONTROL_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.AIWS_CONTROL_PORT ?? DEFAULT_CONTROL_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ControlError('Invalid control server port.');
  const token = options.token ?? process.env.AIWS_CONTROL_TOKEN;
  if (!LOOPBACK_HOSTS.includes(host) && !token) throw new ControlError('AIWS_CONTROL_TOKEN is required when listening beyond loopback.');
  const service = await ControlService.open({ ...options, ...(token ? { token } : {}),
    ...(options.dataDir ? {} : process.env.AIWS_CONTROL_DATA ? { dataDir: process.env.AIWS_CONTROL_DATA } : {}),
    ...(options.githubToken ? {} : process.env.AIWS_GITHUB_TOKEN ? { githubToken: process.env.AIWS_GITHUB_TOKEN } : {}) });
  const errorLog = new ErrorLog(service.store.directory);
  try {
    await syncProjectManagerSkill(options.skills?.home);
    service.skillDiscovery.invalidate();
  } catch (error) { errorLog.error(error, 'Synchronizing the bundled AIWS project management skill'); }
  const tokenUsage = new TokenUsageMonitor(options.tokenUsage);
  // Quota triggers may ask the provider API: local data alone can hold a reset time that already passed. Providers check it only when stale.
  service.usageSource = async () => (await tokenUsage.scan(true)).providers;
  const plugins = new PluginManager(service.store.directory, { state: () => service.publicState(false), tasks: () => service.store.state.tasks, runs: () => service.store.state.runs, task: (taskId) => service.task(taskId),
    saveTask: (input, taskId) => service.saveTask(input, taskId), sendTaskMessage: (taskId, input) => service.sendTaskMessage(taskId, input),
    onChange: (listener) => { service.on('change', listener); return () => { service.off('change', listener); }; } });
  service.pluginPrompt = (task, run) => plugins.promptContributions(task, run);
  await plugins.start();
  const app: RouteServices = { service, errorLog, plugins, tokenUsage, providerDetector: new ProviderDetector(options.providerDetection),
    // The plugin development skill is installed for Codex and Claude Code at user scope, like `aiws agent-skills install --skill aiws-plugin-development`.
    async pluginSkill(install, force = false) {
      const targets = agentSkillTargets('aiws-plugin-development', 'all', 'user', process.cwd(), options.skills?.home);
      let result; try { result = await manageAgentSkills('aiws-plugin-development', targets, { install, force }); } catch (error) { throw new ControlError((error as Error).message, 409); }
      if (install) service.skillDiscovery.invalidate();
      return { skill: 'aiws-plugin-development', targets: result, installed: result.every((target) => target.files.every((file) => file.state === 'current')), modified: result.some((target) => target.files.some((file) => file.state === 'modified')) };
    } };
  const assets = new StaticAssets(resolve(options.staticDir ?? await packageResource('control-ui')), (id, path) => plugins.asset(id, path));
  const streams = new EventStreams(), patches = new StatePatches(), guard = requestGuard(host);
  const authorize = (credential: string | undefined): void => { if (token && !tokenMatches(credential, token)) throw new ControlError('Control token is required.', 401); };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    guard.host(request, url);
    const path = requestPath(url), method = request.method ?? 'GET';
    if (path === '/api/health') { sendJson(response, 200, { ok: true, service: 'aiws-control', schemaVersion: 1 }); return; }
    if (!path.startsWith('/api/')) { await assets.serve(request, response, path, url.searchParams.has('v')); return; }
    guard.origin(request);
    // EventSource cannot send headers, so only the event stream accepts the token as a query parameter.
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    authorize(bearer ?? (path === '/api/events' ? url.searchParams.get('token') ?? undefined : undefined));
    if (path === '/api/events' && method === 'GET') { patches.reset(); streams.open(request, response, { type: 'state', state: service.publicState(), revision: service.stateRevision() }); return; }
    const context = new RouteContext(request, response, url, path, method, app);
    const routes = context.resource && Object.hasOwn(ROUTES, context.resource) ? ROUTES[context.resource] : undefined;
    if (!routes || !await routes(context)) throw new ControlError('API endpoint not found.', 404);
  }
  const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => { if (!(error instanceof ControlError) || error.statusCode >= 500) errorLog.error(error, `${request.method} ${request.url}`); sendError(response, error); }); });
  const voiceRelay = new VoiceRelay({ authorize(request, url) { guard.host(request, url); guard.origin(request); authorize(url.searchParams.get('token') ?? undefined); } });
  attachVoiceRelay(server, voiceRelay);

  // Broadcasts are patches against the previous one; a client applies them to the full state it received on connect.
  service.on('change', (state: Record<string, unknown>, delta?: unknown) => { if (streams.size) streams.send('state', { ...patches.next(state), revision: service.stateRevision(), ...(delta ? { delta } : {}) }); else patches.reset(); });
  for (const type of ['terminal', 'shells', 'update', 'draft', 'organize'] as const) service.on(type, (value: object) => streams.send(type, value));
  plugins.on('plugins', (value: { id: string }) => streams.send('plugins', value));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  } catch (error) { await plugins.close(); await service.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP listening address.');
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${address.port}`;
  service.setConnection(options.controlUrl ?? url, token);
  service.store.advertise(url);
  let closing: Promise<void> | undefined;
  return { server, service, plugins, url, close: () => {
    closing ??= (async () => {
      streams.close(); voiceRelay.close();
      const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections(); await plugins.close(); await service.close(); await stopped;
    })(); return closing;
  } };
}
