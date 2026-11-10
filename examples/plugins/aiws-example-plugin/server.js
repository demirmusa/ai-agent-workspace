/* AIWS example plugin: server side (optional).
 *
 * The "server" field in plugin.json points to this file. While the plugin is enabled, the control server loads this ES
 * module in Node.js and calls activate(context). Server code runs with full Node.js rights; install only plugins you trust.
 *
 * Routes are published under /api/plugins/aiws.example/routes/...; the browser calls them with aiws.http.route('stats').
 */
export function activate(context) {
  const { routes, aiws, log, settings, prompt, events, plugin } = context;
  const dataOf = task => task.pluginData?.[plugin.id] || {};

  // GET /api/plugins/aiws.example/routes/ping
  routes.get('/ping', () => ({ ok: true, plugin: plugin.id, version: plugin.version, time: new Date().toISOString() }));

  // GET /api/plugins/aiws.example/routes/stats?projectId=...
  routes.get('/stats', ({ query }) => {
    const tasks = aiws.tasks().filter(task => !task.archivedAt && (!query.projectId || task.projectId === query.projectId));
    const estimate = tasks.reduce((sum, task) => sum + (Number.isFinite(dataOf(task).estimate) ? dataOf(task).estimate : 0), 0);
    return { tasks: tasks.length, estimate, generatedAt: new Date().toLocaleTimeString('tr-TR') };
  });

  // POST /api/plugins/aiws.example/routes/tasks/:taskId/estimate  { "estimate": 5 }
  // An example for other tools (such as a CI script) to update a task's estimate; context.response returns a custom status code.
  routes.post('/tasks/:taskId/estimate', async ({ params, body }) => {
    const estimate = Number(body?.estimate);
    if (!Number.isFinite(estimate) || estimate < 0) return context.response(400, { error: 'estimate must be a positive number' });
    const task = aiws.task(params.taskId);
    const saved = await aiws.setTaskData(task.id, { ...dataOf(task), estimate });
    return { taskId: saved.id, estimate: dataOf(saved).estimate };
  });

  // Text added to the prompt that goes to the agent when a task starts.
  prompt.contribute(task => {
    if (!settings.get('promptContext')) return null;
    const data = dataOf(task), lines = [];
    if (Number.isFinite(data.estimate)) lines.push(`Estimated size: ${data.estimate} ${settings.get('pointUnit')}. Keep the change within this scope.`);
    if (data.risk) lines.push(`Risk level: ${data.risk}.`);
    if (data.criteria?.length) lines.push(`Acceptance criteria (all must hold before completing):\n${data.criteria.map(item => `- ${item.text}`).join('\n')}`);
    return lines.join('\n');
  });

  // Server events: task.created, task.updated, task.statusChanged, task.deleted, run.started, run.finished, state.
  events.on('task.statusChanged', ({ task, from, to }) => log.info(`${task.title}: ${from} → ${to}`));
  events.on('run.finished', ({ run }) => log.info(`Run ${run.id} finished: ${run.status}`));
  settings.onChange(values => log.info('Settings changed', values));

  log.info('Example plugin server code is ready.');
  // The returned function is called when the plugin is turned off.
  return () => log.info('Example plugin server code stopped.');
}
