import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControlError } from '../../types.js';
import { MAX_ATTACHMENT_BODY } from '../../attachments.js';
import type { RouteContext, RouteHandler } from './context.js';

/** Task and run API: task CRUD, runs and their terminals, history, changes, messages and agent graphs. */
async function taskSearch(c: RouteContext): Promise<boolean> {
  const query = c.query, optional = (name: string) => query.has(name) ? { [name]: query.get(name)! } : {};
  return c.send(200, await c.service.searchTasks({ projectId: query.get('projectId') ?? '', q: query.get('q') ?? '', ...optional('excludeTaskId'), ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}), ...optional('cursor') }));
}

async function taskRoutes(c: RouteContext): Promise<boolean> {
  const { service } = c, id = c.id, action = c.action, step = c.parts[4];
  if (id === 'archive' && c.method === 'POST') return c.send(200, service.setTasksArchived(await c.body()));
  if (id === 'reorder' && c.method === 'POST') return c.send(200, service.reorderReadyTasks(await c.body()));
  if (id === 'search' && c.method === 'GET') return taskSearch(c);
  if (!id) {
    if (c.method === 'GET') { const projectId = c.query.get('projectId'); return c.send(200, service.publicState(false).tasks.filter((task) => projectId === null || task.projectId === projectId)); }
    if (c.method === 'POST') return c.send(201, await service.saveTask(await c.body()));
    return false;
  }
  switch (action) {
    case undefined:
      if (c.method === 'GET') return c.send(200, service.task(id));
      if (c.method === 'PATCH') return c.send(200, await service.saveTask(await c.body(), id));
      if (c.method === 'DELETE') { if (c.query.get('deleteIssue') === 'true') await service.deleteTaskWithIssue(id); else service.deleteTask(id); return c.ok(); }
      return false;
    case 'history': {
      if (c.method !== 'GET') return false;
      const { project, sourceId } = service.taskHistoryContext(id);
      if (!step) return c.send(200, await service.history.detail(project, sourceId, c.params()));
      if (step === 'agents' && !c.parts[5]) return c.send(200, await service.agentGraph.tree(project, { sourceId }));
      if (step === 'agents' && c.parts[5] && c.parts[6] === 'transcript') return c.send(200, await service.agentGraph.transcript(project, { sourceId }, c.parts[5], c.params()));
      return false;
    }
    case 'fork': return c.method === 'POST' && c.send(201, await service.forkTask(id, await c.body()));
    case 'run': {
      if (c.method !== 'POST') return false;
      const input = await c.body() as { queueIfBusy?: unknown };
      return c.send(201, input?.queueIfBusy === true ? await service.startTaskOrQueue(id, input) : await service.startQueuedTask(id, input));
    }
    case 'restart': return c.method === 'POST' && c.send(201, service.restartTask(id));
    case 'transfer-session': return c.method === 'POST' && c.send(201, await service.transferTaskSession(id, await c.body()));
    case 'handoff':
      if (step === 'dismiss' && c.method === 'POST') { await c.body(); return c.send(200, service.dismissHandoff(id)); }
      return !step && c.method === 'POST' && c.send(201, await service.handoffTask(id, await c.body()));
    case 'resume-session': return c.method === 'POST' && c.send(201, await service.resumeTaskSession(id, await c.body()));
    case 'changes':
      if (step) return false;
      if (c.method === 'GET' && c.query.has('file')) return c.send(200, await service.changeFile({ taskId: id }, c.query.get('file')));
      if (c.method === 'POST') { const input = await c.body() as { file?: unknown; action?: unknown }; return c.send(200, await service.changeFile({ taskId: id }, input?.file, input?.action)); }
      return c.method === 'GET' && c.send(200, await service.taskChanges(id));
    case 'messages':
      if (c.method === 'GET') { service.task(id); return c.send(200, service.store.state.messages.filter((message) => message.taskId === id)); }
      return c.method === 'POST' && c.send(201, await service.sendTaskMessage(id, await c.body()));
    default: return false;
  }
}

/** Run actions answered with the service's result; the body is passed on where the action takes input. */
const RUN_ACTIONS: Record<string, (c: RouteContext, runId: string) => Promise<unknown>> = {
  complete: async (c, runId) => c.service.complete(runId, await c.body()),
  reply: async (c, runId) => c.service.reply(runId, await c.body()),
  session: async (c, runId) => c.service.reportSession(runId, await c.body()),
  pause: (c, runId) => c.service.pause(runId),
  resume: (c, runId) => c.service.resume(runId),
  stop: (c, runId) => c.service.stop(runId),
  interrupt: async (c, runId) => c.service.interrupt(runId),
  'deliver-now': async (c, runId) => c.service.deliverNow(runId),
  command: async (c, runId) => c.service.command(runId, await c.body()),
  'session-terminal': async (c, runId) => { await c.body(); return c.service.openRunSessionTerminal(runId); },
};

async function runRoutes(c: RouteContext): Promise<boolean> {
  const { service } = c, id = c.id, action = c.action;
  if (!id) return false;
  if (action === 'images' && c.method === 'POST') {
    const run = service.run(id);
    if (!run.inputDirectory || run.terminalMode !== 'pty' || !['running', 'waiting'].includes(run.status)) throw new ControlError('An active terminal is required.', 409);
    const image = await service.attachments.upload(await c.body(MAX_ATTACHMENT_BODY));
    await service.attachments.materialize(image.url, run.inputDirectory, run.executionMode === 'docker');
    return c.send(201, { ...image, path: run.executionMode === 'docker' ? `/run/aiws/input/images/${image.id}` : resolve(run.inputDirectory, 'images', image.id) });
  }
  if (action === 'agents' && c.method === 'GET') {
    const run = service.run(id), project = service.runProject(run);
    const context = { run, events: service.store.state.events.filter((event) => event.runId === run.id) };
    if (!c.parts[4]) return c.send(200, await service.agentGraph.tree(project, context));
    if (c.parts[5] === 'transcript') return c.send(200, await service.agentGraph.transcript(project, context, c.parts[4], c.params()));
  }
  if (action === 'context' && !c.parts[4] && c.method === 'GET') return c.send(200, await service.runContext(id, c.query.get('agent') || undefined));
  if (action === 'context' && !c.parts[4] && c.method === 'POST') return c.send(200, await service.openRunContextFile(id, await c.body()));
  if (!action && c.method === 'GET') return c.send(200, service.run(id));
  // The bootstrap message only names the prompt file; this lets the console show what the agent was given.
  if (action === 'prompt' && c.method === 'GET') {
    const run = service.run(id); if (!run.inputDirectory) throw new ControlError('This run has no prompt file.', 404);
    const path = resolve(run.inputDirectory, 'prompt.md'); const text = await readFile(path, 'utf8').catch(() => { throw new ControlError('Prompt file not found.', 404); });
    return c.send(200, { runId: run.id, path, text });
  }
  if (action === 'events' && c.method === 'GET') { service.run(id); return c.send(200, service.store.state.events.filter((event) => event.runId === id)); }
  if (action === 'terminal' && !c.parts[4] && c.method === 'GET') return c.send(200, service.terminal(id));
  if (c.method !== 'POST') return false;
  const terminalAction = action === 'terminal' ? c.parts[4] : action;
  if (terminalAction === 'input') { service.input(id, await c.body()); return c.ok(); }
  if (terminalAction === 'clear') { service.clearTerminal(id); return c.ok(); }
  if (terminalAction === 'resize') { service.resize(id, await c.body()); return c.ok(); }
  if (action === 'questions') return c.send(201, service.ask(id, await c.body()));
  const run = action && Object.hasOwn(RUN_ACTIONS, action) ? RUN_ACTIONS[action] : undefined;
  return Boolean(run) && c.send(200, await run!(c, id));
}

export const taskRunRoutes: Record<string, RouteHandler> = { tasks: taskRoutes, runs: runRoutes };
