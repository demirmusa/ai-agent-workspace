import type { RouteContext, RouteHandler } from './context.js';

/** Library API: workflows, schedules, agents, skills and skill discovery. */
type Crud = { list(): unknown; create(input: unknown): unknown; get(id: string): unknown; update(id: string, input: unknown): unknown; remove(id: string): void };
/** The shared list/create/read/update/delete routes of a catalog resource. */
async function crud(c: RouteContext, items: Crud): Promise<boolean> {
  if (!c.id && c.method === 'GET') return c.send(200, items.list());
  if (!c.id && c.method === 'POST') return c.send(201, items.create(await c.body()));
  if (c.id && !c.action && c.method === 'GET') return c.send(200, items.get(c.id));
  if (c.id && !c.action && c.method === 'PATCH') return c.send(200, items.update(c.id, await c.body()));
  if (c.id && !c.action && c.method === 'DELETE') { items.remove(c.id); return c.ok(); }
  return false;
}

export const catalogRoutes: Record<string, RouteHandler> = {
  async workflows(c) {
    const { workflows } = c.service;
    return crud(c, { list: () => c.service.publicState(false).workflows, create: (input) => workflows.create(input), get: (id) => workflows.workflow(id), update: (id, input) => workflows.update(id, input), remove: (id) => workflows.delete(id) });
  },
  async schedules(c) {
    const { schedules } = c.service;
    if (c.id === 'preview' && !c.action && c.method === 'POST') return c.send(200, schedules.preview(await c.body(), Number(c.query.get('count') ?? '5')));
    if (c.id && c.action === 'run' && c.method === 'POST') { await c.body(); return c.send(201, schedules.runNow(c.id)); }
    return crud(c, { list: () => schedules.list(c.query.get('projectId') ?? undefined), create: (input) => schedules.create(input), get: (id) => schedules.schedule(id), update: (id, input) => schedules.update(id, input), remove: (id) => schedules.delete(id) });
  },
  async agents(c) {
    const { catalog } = c.service;
    return crud(c, { list: () => c.service.publicState(false).agents, create: (input) => catalog.createAgent(input), get: (id) => catalog.agent(id), update: (id, input) => catalog.updateAgent(id, input), remove: (id) => catalog.deleteAgent(id) });
  },
  async 'skill-discovery'(c) {
    const { service } = c, projects = service.store.state.projects;
    if (!c.id && c.method === 'GET') {
      // A closed request cancels the scan instead of letting it walk every root for nobody.
      const aborted = new AbortController(), cancel = (): void => { if (!c.response.writableEnded) aborted.abort(); };
      c.response.once('close', cancel);
      try { return c.send(200, await service.skillDiscovery.discover(projects, { refresh: c.query.get('refresh') === '1', signal: aborted.signal })); } finally { c.response.off('close', cancel); }
    }
    if (c.id === 'share' && c.method === 'POST') return c.send(200, await service.skillDiscovery.share(projects, await c.body()));
    if (c.id === 'remove' && c.method === 'POST') return c.send(200, await service.skillDiscovery.remove(projects, await c.body()));
    if (c.id === 'import' && c.method === 'POST') return c.send(201, await service.importDiscoveredSkill(await c.body()));
    return false;
  },
  async skills(c) {
    const { catalog } = c.service;
    if (c.id === 'import' && c.method === 'POST') return c.send(201, await catalog.importSkill(await c.body()));
    return crud(c, { list: () => c.service.publicState(false).skills, create: (input) => catalog.createSkill(input), get: (id) => catalog.skill(id), update: (id, input) => catalog.updateSkill(id, input), remove: (id) => catalog.deleteSkill(id) });
  },
};
