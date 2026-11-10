# Server code, HTTP API and CLI

## server.js (optional)

For an ES module in `server.js`, include `{"type":"module","private":true}` in a `package.json` at the plugin root
to avoid Node's `MODULE_TYPELESS_PACKAGE_JSON` warning. Alternatively, use a `.mjs` file and set the manifest's
`server` path accordingly.

When the manifest has `"server": "server.js"` and the plugin is enabled, the control server imports the file as an
ES module inside its own Node.js (≥22) process and calls `activate(context)`. It runs with the same rights as AIWS:
file system, network, child processes. Use it for things the browser cannot do: call external APIs (the browser page's
CSP blocks cross-origin requests), read files, react to task events while no window is open, add agent prompt context.

```js
export async function activate(context) {
  const { routes, aiws, log, settings, storage, events, prompt, plugin } = context;
  routes.get('/ping', () => ({ ok: true, version: plugin.version }));
  return () => { /* cleanup on disable */ };
}
export function deactivate() {} // optional
```

- Turning the plugin off (or uninstalling/updating it) calls the returned cleanup function, `deactivate()` and every
  `context.onDispose` callback, and removes its routes, listeners and prompt contributors.
- Each activation imports the file with a new URL, so disable → enable reloads edited server code. Node caches imported
  dependencies by URL; restart AIWS after changing helper modules imported by `server.js`.
- An exception in `activate` marks the server code `error` (see `aiws control plugins show <id>` → `server.error` and
  `aiws control plugins logs <id>`); the browser part still loads.
- Plain dependencies: put them next to `server.js` (relative imports) or bundle them. A `node_modules` folder is copied
  with the plugin but counts against the 50 MiB / 1000 file limit.

### `context`

| Member | Description |
|---|---|
| `apiVersion` | `1` |
| `plugin` | `{ id, version, directory, manifest }` — `directory` is the installed (or linked) folder. |
| `log.info/warn/error(...parts)` | Keeps the last 200 lines; shown by `aiws control plugins logs <id>` and the plugin card. |
| `settings.get(key?)`, `settings.onChange(fn(values))` | Values of the manifest settings (with defaults). |
| `storage.get(key?)`, `storage.set(key, value)`, `storage.delete(key)` | The same JSON storage the browser sees through `aiws.storage` (Promise-based). |
| `routes.get/post/put/patch/delete(pattern, handler)` | Adds an HTTP route (below). |
| `events.on(name, fn)` | Server-side events (below); returns a disposer. |
| `prompt.contribute(fn(task, run))` | Text added to the agent prompt when a task run starts (below); returns a disposer. |
| `aiws.state()` | Snapshot of the public state (projects, tasks, runs, settings, ...). |
| `aiws.tasks()`, `aiws.runs()`, `aiws.task(id)` | Copies of tasks/runs; `task(id)` throws a 404 error for unknown ids. |
| `aiws.createTask(input)`, `aiws.updateTask(id, input)` | Same validation as `POST/PATCH /api/tasks`. Returns the saved task. |
| `aiws.setTaskData(id, values)` | Replaces this plugin's `pluginData` on the task (`null` deletes). |
| `aiws.sendMessage(id, text)` | Sends a chat message to the task's agent. |
| `response(status, body, headers?)` | Return from a route for a custom status, headers or a non-JSON body. |
| `onDispose(fn)` | Extra cleanup. |

### Routes

```js
routes.get('/items', ({ query }) => list(query.filter));
routes.get('/items/:id', ({ params }) => find(params.id));
routes.post('/items', async ({ body }) => { if (!body?.name) return context.response(400, { error: 'name is required' }); return create(body); });
routes.get('/files/*', ({ params }) => read(params['*']));            // '*' captures the rest of the path
routes.get('/report.csv', () => context.response(200, 'a,b\n1,2\n', { 'Content-Type': 'text/csv; charset=utf-8' }));
```

- Served at `/api/plugins/<plugin id>/routes/<pattern>` with the same authentication as the AIWS API (the browser helper
  `aiws.http.route('items/42')` adds the token; external callers send `Authorization: Bearer $AIWS_CONTROL_TOKEN` when the
  server has a token).
- Pattern segments: literal, `:name` (one segment) and a final `*`. Methods: GET, POST, PUT, PATCH, DELETE.
- Handler request: `{ method, path, params, query, body, headers }`. Bodies must be JSON (`Content-Type: application/json`).
  `headers` never contains `Authorization` or `Cookie`.
- Response headers may set `Content-Type` and similar, but not the security headers (CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, cross-origin policies), `Set-Cookie` or CORS headers; those are dropped.
- Return a JSON-serializable value (200), `undefined` (204) or `context.response(...)`. A thrown error becomes a
  500 `{ "error": "Plugin route failed: <message>" }` and is logged.
- Disabled plugins have no routes (404 "This plugin has no running server code").

### Events

| Event | Payload |
|---|---|
| `task.created` | `{ task }` |
| `task.updated` | `{ task }` (any field change, including other plugins' data) |
| `task.statusChanged` | `{ task, from, to }` |
| `task.deleted` | `{ taskId }` |
| `run.started` | `{ run }` |
| `run.finished` | `{ run }` with `run.status` `completed`, `failed`, `cancelled` or `interrupted` |
| `state` | `{}` after every state change (avoid heavy work here) |

Listeners run synchronously after the change; do slow work asynchronously and catch your own errors (uncaught ones are
logged). Updating a task inside `task.updated` triggers another `task.updated` — guard against loops.

### Agent prompt context

```js
prompt.contribute((task, run) => {
  const data = task.pluginData?.[context.plugin.id];
  return data?.criteria?.length ? `Acceptance criteria:\n${data.criteria.map(c => `- ${c.text}`).join('\n')}` : null;
});
```

Non-empty results of all plugins are added to the task prompt under `Plugin context:` as `[<plugin id>] <text>` (max
20 000 characters per contribution). The function must be synchronous and fast; it runs when a run starts.

## HTTP API (control server)

All paths are under the AIWS server (default `http://127.0.0.1:4317`); send `Authorization: Bearer <token>` when
`AIWS_CONTROL_TOKEN` is set. Bodies are JSON.

| Method & path | Description |
|---|---|
| `GET /api/plugins` | `{ apiVersion, directory, plugins: PluginInfo[] }` — re-scans the plugin folder. |
| `POST /api/plugins` | Install: `{ "path": "<absolute folder>", "mode": "copy" \| "link" }` or `{ "archive": "<base64 zip>", "fileName": "x.zip" }`. Same id replaces the installed version (settings/storage kept). |
| `GET /api/plugins/:id` | One `PluginInfo`. |
| `PATCH /api/plugins/:id` | `{ "enabled": true \| false, "settings": { "key": value \| null } }` (null resets to default). |
| `DELETE /api/plugins/:id` | Uninstall (a linked folder is only unlinked). Task `pluginData` is kept. |
| `GET /api/plugins/:id/logs` | `{ logs: [{ at, level, message }] }` |
| `GET /api/plugins/:id/storage[/:key]` | `{ values }` or `{ value }` |
| `PUT /api/plugins/:id/storage/:key` | `{ "value": any }` |
| `DELETE /api/plugins/:id/storage/:key` | |
| `* /api/plugins/:id/routes/...` | The plugin's own routes. |
| `GET /plugins/:id/:stamp/<file>` | Static plugin files (the browser uses `PluginInfo.assetBase`). |
| `GET/POST /api/plugin-skill` | Status / install of this skill (`{ "force": true }` overwrites local edits). |
| `PATCH /api/tasks/:id` | `{ "pluginData": { "<id>": {...} \| null } }` changes only the named plugins' data. |

`PluginInfo`: `{ id, directory, mode: 'copy'|'link', enabled, installedAt, updatedAt, error?, manifest?, settings,
assetBase, server: { declared, status: 'inactive'|'active'|'error', error?, routes: ['GET /ping', ...] } }`.

Installed plugins live in `<AIWS data>/plugins/<id>/` (default `~/.aiws/control/plugins`); enabled state, settings and
storage in `<AIWS data>/plugins.json`. Changes are pushed to open windows, which load or unload plugins live.

## CLI

```text
aiws control plugins list
aiws control plugins show <id>
aiws control plugins install <folder|file.zip> [--link]   # --link: development mode, no copy
aiws control plugins enable <id> | disable <id>
aiws control plugins settings <id> ['{"key":"value"}']
aiws control plugins logs <id>
aiws control plugins remove <id>
aiws control plugins pack <folder> [--out file.zip]        # validates plugin.json, writes <id>-<version>.zip
aiws control plugins skill [--force]                       # installs this skill for Codex and Claude Code
aiws agent-skills install --skill aiws-plugin-development  # same, with --provider/--scope options
```

`aiws control --url <url>` targets another server. Commands print JSON and exit non-zero on errors.
