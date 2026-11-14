import { ControlError } from '../../types.js';
import { aiProviders } from '../../ai-providers/index.js';
import { listAgentTemplates } from '../../agent-templates.js';
import { browseDirectories } from '../../directories.js';
import { MAX_ATTACHMENT_BODY } from '../../attachments.js';
import type { RouteContext, RouteHandler } from './context.js';

/** Control-center wide API: state, settings, providers, attachments, live sessions, GitHub, repository and questions. */
const refresh = (c: RouteContext): boolean => c.query.get('refresh') === '1';

/** /api/providers/:id/accounts: the provider's accounts, installing and uninstalling their account manager, adding the current login and removing one. */
async function providerAccounts(c: RouteContext, providerId: string): Promise<boolean> {
  const provider = aiProviders.require(providerId), accounts = provider.accounts, account = c.parts[4];
  if (!accounts) throw new ControlError(`${provider.name} has no accounts to manage.`, 404);
  if (c.parts[5]) return false;
  if (!account && c.method === 'GET') return c.send(200, await accounts.status(refresh(c) ? 0 : 60_000));
  if (account === 'install' && c.method === 'POST') { await c.body(); return c.send(200, await accounts.install()); }
  if (account === 'uninstall' && c.method === 'POST') { await c.body(); return c.send(200, await accounts.uninstall()); }
  if (account === 'current' && c.method === 'POST') { await c.body(); return c.send(200, await accounts.addCurrent()); }
  if (account && c.method === 'DELETE') return c.send(200, await accounts.remove(account));
  return false;
}

export const systemRoutes: Record<string, RouteHandler> = {
  /** ?refresh=1 allows a throttled remote check, ?refresh=force (the dialog's Yenile) skips the throttle; ?provider= scans one provider. */
  async 'token-usage'(c) {
    if (c.id || c.method !== 'GET') return false;
    const mode = c.query.get('refresh'), provider = aiProviders.list().find((item) => item.id === c.query.get('provider'))?.id;
    return c.send(200, await c.app.tokenUsage.scan(mode === '1' || mode === 'force', c.service.store.state.settings.usageFooter?.hidden ?? [], { force: mode === 'force', ...(provider ? { provider } : {}) }));
  },
  async providers(c) {
    if (!c.id && c.method === 'GET') return c.send(200, aiProviders.info());
    if (c.id === 'detect' && !c.action && c.method === 'GET') return c.send(200, await c.app.providerDetector.detect(c.service.store.state.settings.customProviders, refresh(c)));
    if (c.id && /^[a-z]+$/.test(c.id) && c.action === 'accounts') return providerAccounts(c, c.id);
    if (c.id && /^[a-z]+$/.test(c.id) && c.action === 'models' && c.parts[4] === 'refresh' && !c.parts[5] && c.method === 'POST') { await c.body(); return c.send(200, await c.service.refreshProviderModels(c.id)); }
    return false;
  },
  /** The control UI reports its uncaught errors and error banners here so their stack traces reach the log file. */
  async 'client-errors'(c) {
    if (c.id || c.method !== 'POST') return false;
    const body = await c.body() as Record<string, unknown>, text = (value: unknown): string => typeof value === 'string' ? value : '';
    c.app.errorLog.write({ source: 'ui', message: text(body.message), stack: text(body.stack), context: text(body.context) });
    return c.ok();
  },
  /** The unsaved new-task form, so it survives a crash or restart of the app. */
  async 'task-draft'(c) {
    if (c.id) return false;
    if (c.method === 'GET') return c.send(200, { draft: c.service.taskDraft.get() });
    if (c.method === 'PUT') return c.send(200, { draft: c.service.taskDraft.save(await c.body()) });
    if (c.method === 'DELETE') { c.service.taskDraft.clear(); return c.ok(); }
    return false;
  },
  async state(c) { return !c.id && c.method === 'GET' && c.send(200, { ...c.service.publicState(c.query.get('journal') !== '0'), revision: c.service.stateRevision() }); },
  async settings(c) {
    if (c.id) return false;
    if (c.method === 'GET') return c.send(200, c.service.publicState(false).settings);
    if (c.method === 'PATCH') return c.send(200, c.service.updateSettings(await c.body()));
    return false;
  },
  async attachments(c) {
    if (!c.id && c.method === 'POST') return c.send(201, await c.service.uploadAttachment(await c.body(MAX_ATTACHMENT_BODY)));
    if (c.id && !c.action && c.method === 'GET') {
      const file = await c.service.attachments.read(c.id);
      c.response.writeHead(200, { 'Content-Type': file.type, ...(file.type.startsWith('image/') ? {} : { 'Content-Disposition': 'attachment' }), 'Cache-Control': 'private, no-store' }); c.response.end(file.data); return true;
    }
    return false;
  },
  async 'live-sessions'(c) {
    if (c.method !== 'GET') return false;
    const { service } = c;
    if (!c.id) return c.send(200, await service.liveSessionsPage());
    const state = service.store.state, source = await service.liveSessions.scope(c.id, state.projects, state.runs, state.tasks);
    if (!c.action) return c.send(200, { ...await service.history.readPointer(source.pointer, c.params()), session: source.item });
    if (c.action === 'agents' && !c.parts[4]) return c.send(200, await service.agentGraph.tree(source.project, { sourceId: c.id }));
    if (c.action === 'agents' && c.parts[5] === 'transcript') return c.send(200, await service.agentGraph.transcript(source.project, { sourceId: c.id }, c.parts[4]!, c.params()));
    return false;
  },
  async directories(c) { return !c.id && c.method === 'GET' && c.send(200, await browseDirectories(c.service.store.state.projects.map((project) => project.repositoryPath), c.params())); },
  async 'terminal-agents'(c) { return !c.id && c.method === 'GET' && c.send(200, await c.service.projectTerminals.agents(refresh(c))); },
  async 'agent-templates'(c) { return !c.id && c.method === 'GET' && c.send(200, await listAgentTemplates()); },
  async repository(c) {
    if (c.id === 'branches' && c.method === 'POST') return c.send(200, c.service.repositoryBranches(await c.body()));
    if (c.id === 'detect' && c.method === 'POST') return c.send(200, await c.service.detectRepository(await c.body()));
    return false;
  },
  async github(c) {
    if (c.id === 'auth' && !c.action && c.method === 'GET') return c.send(200, await c.service.githubAuth());
    if (c.id === 'authorize' && !c.action && c.method === 'POST') { await c.body(); return c.send(200, await c.service.authorizeGitHub()); }
    return false;
  },
  async workspace(c) { return !c.id && c.method === 'GET' && c.send(200, c.service.project('project_general')); },
  async questions(c) {
    if (!c.id) return false;
    if (!c.action && c.method === 'GET') return c.send(200, c.service.publicState(false).questions.find((item) => item.id === c.id) ?? (() => { throw new ControlError('Question not found.', 404); })());
    if (c.action === 'answer' && c.method === 'POST') return c.send(200, c.service.answer(c.id, await c.body()));
    return false;
  },
};
