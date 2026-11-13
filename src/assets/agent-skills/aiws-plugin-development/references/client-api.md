# Browser API (`aiws`) — apiVersion 1

The manifest's `main` file is loaded with `import()` as an ES module when the plugin is enabled. AIWS calls its
`activate(aiws)` export (a default-exported function or `{ activate }` object also works) once per activation:

```js
export function activate(aiws) {
  const off = aiws.sidebar.addItem({ id: 'hello', label: 'Hello', icon: 'spark', onClick: () => aiws.ui.toast('Hi') });
  // Optional: return a cleanup function. Registrations are removed automatically anyway.
  return () => {};
}
export function deactivate(aiws) {} // optional, called when the plugin is turned off
```

- Every `add*`/`register` call returns a **disposer** function; calling it removes that contribution early.
- All contributions are removed and every view's `unmount` runs when the plugin is disabled, reloaded or uninstalled.
- Exceptions thrown by plugin callbacks are caught, logged to the browser console and listed on the plugin card
  (Settings → Plugins → Details). They never break AIWS.
- Definitions are validated: `id` is required (`[A-Za-z0-9_.-]{1,64}`, unique per plugin and kind) plus the listed
  required fields; a missing field throws from the registration call.
- `order` (number, default 100) sorts contributions of the same kind; ties sort by plugin id.

## Contexts

Callbacks receive a context object. **App context** (`ctx`):

| Field | Meaning |
|---|---|
| `plugin` | This plugin's `aiws` API object. |
| `state` | The live application state (read only; see "State" below). |
| `screen` | Current screen: `board`, `overview`, `sessions`, `settings`, `agents`, `skills`, `workflows` or `plugin:<id>/<page>`. |
| `project` | Selected project object or `null`. |
| `task` | Task open in the detail panel or `null`. |

**Task context** additionally has `task`, `project` (the task's project), `run` (current run or `null`),
`data` (a copy of `task.pluginData[<your id>]`, `{}` when empty) and `saveData(values)` which replaces your data on the
task (`PATCH /api/tasks/:id { pluginData: { <id>: values } }`) and returns the saved task.

## Views: render / update / unmount

Pages, project tabs, task detail sections and tabs, settings panels use the same view protocol:

```js
render(container, ctx) {           // container: an empty <div class="plugin-view"> owned by you
  container.innerHTML = '...';
  return {
    update(ctx) {},                // called on later renders while the view stays mounted (state pushes, selection)
    unmount() {},                  // called when the view leaves the page or the plugin turns off
  };
}
```

`update`/`unmount` may also be given on the definition itself (`def.update(ctx, container)`, `def.unmount(container)`).
`update` runs often (every app render): compare with what you drew and avoid replacing inputs the user is typing in.
If the container is replaced by AIWS (e.g. the task changed), `render` runs again on a fresh container.

## Shell

### `aiws.sidebar.addItem(def)`
| Field | Notes |
|---|---|
| `id`, `label` | required; `label` is text or `{tr,en}`. |
| `icon` | Built-in name (`check alert clock triangle chevron search tool spark arrow-right expand x pin eye eye-off dot plug`), inline `<svg>` markup, an image path in the plugin (`icons/x.svg`) or 1-2 characters/emoji. |
| `section` | `'plugins'` (default: an "Eklentiler" group above Settings), `'workspace'` (after "Tüm projeler"), `'bottom'` (next to Settings). |
| `page` | Id of one of your pages; clicking opens it and the item shows as active. |
| `onClick(ctx, event)` | Used when `page` is not set. |
| `badge(ctx)` | Returns a short text/number shown as the item count, or `''`/`null`. |
| `visible(ctx)` | Return `false` to hide. |
| `title`, `order` | Tooltip, ordering. |

### `aiws.topbar.addButton(def)`
Buttons in the header, left of "Prepare with AI"/"New task". Fields: `id`, `label` (required), `icon`, `title`,
`primary` (accent button), `page` or `onClick(ctx, event)`, `visible(ctx)`, `order`.

### `aiws.pages.register(def)` / `aiws.pages.open(id)`
Full-screen pages in the main area. Fields: `id`, `title` (required, shown in the header), `summary`, `render`
(required), `update`, `unmount`. The screen key is `plugin:<plugin id>/<page id>`; open it from a sidebar item
(`page: 'id'`), `aiws.pages.open(id)` or `aiws.navigate.page(id)`. Leaving the page unmounts the view.

### `aiws.projectTabs.add(def)` / `aiws.projectTabs.open(id)`
A tab next to Board · Terminal · Scheduled tasks · Sessions · Project settings when a project is open. Fields: `id`,
`label`, `render` (required), `update`, `unmount`, `visible(ctx)` (ctx has `project`), `order`. `ctx.project` is the open
project; switching to another project unmounts the view and renders it again for that project, while state changes in
the same project call `update(ctx)`. The open tab is remembered per project like built-in tabs.

### `aiws.commands.register(def)` / `aiws.commands.execute(id, ...args)`
`{ id, title, run(ctx, ...args), shortcut? }`. `shortcut` like `Ctrl+Shift+K`, `Alt+N`, `Mod+K` (Mod = Cmd on macOS,
Ctrl elsewhere); matching keydown runs the command unless an earlier handler consumed the key. `execute` takes your own
command id or `"<plugin id>/<command id>"` for another plugin's command.

## Tasks

### `aiws.taskForm.addSection(def)` — new task and edit task dialog
| Field | Notes |
|---|---|
| `id`, `title`, `render(container, ctx)` | required. |
| `placement` | `'tab'` (default): a tab under "Advanced options". `'main'`: a titled section always visible above it. |
| `collect(container, ctx)` | Returns an object merged into your task data on save, `null` to delete your data, `undefined` to leave it. |
| `validate(container, ctx)` | Return an error text to block saving (shown in the dialog), or `null`. |
| `onSaved(task, ctx)` | Called with the saved task. |
| `visible(ctx)`, `order` | |

`render` may instead return `{ collect, validate, onSaved }` closures. The context is a task context with
`mode: 'create' | 'edit'`, `form` (the dialog's `<form>`), `task` (`null` when creating), `project` and `data` (your
existing data or `{}`). Do not give your inputs `name` attributes that collide with AIWS fields (`title`, `description`,
`status`, `priority`, `tags` ...); use ids/classes and read values in `collect`. All sections of one plugin are merged
over your existing data, so fields no section edits are kept.

### `aiws.taskDetail.addSection(def)` — "Bilgiler" (info) tab of the task panel
`{ id, title, render, update?, unmount?, placement?: 'main' | 'sidebar', visible?(ctx), order? }`. `main` appends a section
below the description and activity; `sidebar` appends a card to the right column (style rows with
`<dl class="issue-fields"><div class="issue-field"><dt>..</dt><dd>..</dd></div></dl>`). Save edits with
`ctx.saveData({...ctx.data, field: value})`; the panel re-renders with the new data (`update(ctx)`).

### `aiws.taskDetail.addTab(def)`
A tab after Bilgiler · Sohbet · Agent Console: `{ id, label, render, update?, unmount?, visible?(ctx), order? }`. Task
context. Only shown for board tasks (not for history sessions).

### `aiws.taskDetail.addAction(def)`
A button in the task panel's "⋯" menu: `{ id, label, run(ctx), icon?, danger?, visible?(ctx), order? }`.

### `aiws.taskCard.addBadge(def)`
`{ id, render(task, ctx), order? }`; `render` returns `null`, a text, `{ text, tone?, title?, icon? }` or an array of
those. `tone`: `idle` (default), `accent`, `running`, `done`, `needs`, `failed`. Keep it cheap: it runs for every card on
every board render.

### `aiws.tasks`
| Method | Notes |
|---|---|
| `list({ projectId?, status? })` | Tasks from the current state (includes archived; check `task.archivedAt`). |
| `get(id)` / `getData(id)` | A task / a copy of your data on it. |
| `create(input)` | `POST /api/tasks`, e.g. `{ projectId, title, description, status: 'backlog', priority: 2, pluginData: { [aiws.plugin.id]: {...} } }`. |
| `update(id, input)` | `PATCH /api/tasks/:id` with the fields to change. |
| `setData(id, values)` | Replace your data on the task (`null` deletes it). |
| `sendMessage(id, text)` | Send a chat message to the task's agent. |

Task fields you may read: `id, projectId, title, description, status (backlog|ready|running|waiting|paused|review|completing|done|failed|cancelled), priority (0-3), tags, agentId, provider, model, createdAt, updatedAt, archivedAt, currentRunId, dependsOn, pluginData`.

## Look and feel

### `aiws.themes`
`register({ id, name, description?, dark?, light?, css? })` adds a theme at runtime (same format as manifest themes;
`css` is a path in the plugin). `active()` returns the selected theme key (`'<plugin>/<theme>'`) or `''`.
`apply(idOrKey)` selects one of your themes by id, any theme by key, or the default with `''`.

### `aiws.styles`
`add(cssText)` injects a `<style>`; `addLink(path)` links a stylesheet from the plugin. Manifest `styles` are linked
automatically. Use AIWS tokens, never raw colours, so themes apply (see theme-tokens.md).

### `aiws.dom.onElement(selector, fn)`
Calls `fn(element, ctx)` once for every current and future element matching `selector` (MutationObserver). Use it only
where no extension point exists; AIWS re-renders often, so your additions may be replaced and re-decorated.

## Data

### `aiws.settings`
`get(key?)` (all values when no key), `set(key, value)` (validated, saved, Promise), `onChange(fn(values))`,
`addPanel({ render(container, ctx), update?, unmount? })` — a custom area under the generated settings on your plugin
card (ctx has `settings`).

### `aiws.storage`
Server-side JSON storage per plugin, shared by all windows and visible to `server.js` (≤1 MiB per plugin; keys
`[A-Za-z0-9_.:-]{1,200}`): `get(key)` → value or `null`, `all()`, `set(key, value)`, `delete(key)` (all Promises).
`aiws.storage.local.get(key, fallback)`, `.set(key, value)`, `.remove(key)` store JSON in this browser only.

### `aiws.http`
`api(path, { method, body, signal })` calls the AIWS API with the user's token (path without `/api`, e.g. `'/state'`,
`'/tasks/<id>'`). `route(path, { method, body, query })` calls your server routes
(`/api/plugins/<id>/routes/<path>`). Both return parsed JSON and throw `Error(message)` on failure.

### `aiws.events.on(name, fn)`
| Event | Payload |
|---|---|
| `state` | `{ state }` after each state update. |
| `task:created` / `task:updated` / `task:deleted` | `{ task }` / `{ task }` / `{ taskId }` |
| `task:statusChanged` | `{ task, from, to }` |
| `task:selected` | `{ task }` (`null` when the panel closes) |
| `run:started` / `run:finished` | `{ run }` (`run.status`: completed, failed, cancelled, interrupted) |
| `screen:changed` | `{ screen, project, projectTab }` |
| `theme:changed` | `{ theme, mode }` (`mode` is `dark` or `light`) |

### State and navigation
`aiws.state()` returns the live state object: `projects, tasks, runs, events, messages, questions, agents, skills,
workflows, schedules, settings, generalWorkspace`. Treat it as read-only and change data through the API.
`aiws.project()`, `aiws.task()`, `aiws.screen()` return the current selection.
`aiws.navigate.page(id)`, `.screen(name)`, `.project(id)`, `.task(id)` (opens its project and panel),
`.projectTab(id)` (your tab id, or a built-in: `board terminal schedules sessions settings`).

## UI helpers (`aiws.ui`)

| Helper | Notes |
|---|---|
| ``html`...` `` | Tagged template; escapes every substitution. Nest trusted markup with `raw(markup)`. Arrays: `raw(items.map(x => html`...`).join(''))`. |
| `esc(text)` | Escape for HTML text and attributes. |
| `icon(name)`, `sparkle(tone)`, `statusPill(value, label)` | AIWS's icons and pills as markup. |
| `markdown(text)` | Markdown → HTML with all raw HTML escaped (the renderer used for task descriptions and chat). |
| `toast(text)`, `error(text)` | Status toast / error banner. |
| `modal({ title, body, submitLabel, onSubmit(formData, form), size: 'standard'|'wide', description, render(mount) })` | Opens AIWS's single dialog. `body` is markup or a DOM node. With `onSubmit` the body is a form with Save/Cancel; throwing an `Error` shows its message in the dialog and keeps it open. |
| `confirm({ title, message, confirmLabel })` | Promise<boolean>. |
| `closeModal()`, `render()` | Close the dialog; request an app re-render (e.g. after a setting changes what badges show). |
| `menuNavigate(event, menu)` | Arrow-key navigation for popup menus (`class="popup-menu"`, items `role="menuitem"`). |

Reuse AIWS classes for a native look: buttons `button`, `button small`, `button primary`, `button ghost`, `danger`;
form `form-field`, `form-grid`, `checkbox-field`, `form-hint`, `field-info`; chips `ui-chip` (+ `data-tone`);
cards `settings-card`, `issue-panel`, `ui-card`; switch `<input type="checkbox" class="ui-switch">`; spinner `ui-spinner`.

## i18n (`aiws.i18n`)
`language` (`'tr'|'en'`), `locale` (`'tr-TR'|'en-US'`), `text(value)` resolves a `{tr,en}` object, `add({ en: { 'Türkçe': 'English' } })`
registers translations for your own strings and `t(source)` translates them. Write source strings in one language and
translate to the other.

## Chat (`aiws.conversation`)

Customizes tool calls in the task chat and adds panels above it. Full examples: the built-in plugins under `assets/plugins` (`aiws-dotnet`, `aiws-react-native`, `aiws-electron`, `aiws-angular`).

```js
aiws.conversation.addToolView({
  id: 'gradle', order: 10,
  match: node => node.kind === 'tool' && node.program === 'gradlew',
  summary: node => ({ title: 'Android build', subject: node.args[0], icon: 'RN', tone: node.status === 'failed' ? 'failed' : 'done',
    chips: [{ text: '12 tasks' }], activity: 'Building for Android', pin: true }),
  inline: node => aiws.conversation.ui.failures(['app:compileDebugKotlin'], 5), // stays under the closed row
  detail: node => aiws.ui.html`<p>${node.commandLine}</p>`,                      // leads the opened card
});
aiws.conversation.addPanel({
  id: 'status', title: 'Android', icon: 'RN', visible: ctx => ctx.nodes.some(node => node.program === 'gradlew'),
  summary: ctx => [{ text: 'OK', tone: 'done' }],
  render(container, ctx) { const paint = next => { container.textContent = `${next.nodes.length} calls`; }; paint(ctx); return { update: paint }; },
});
```

- `node`: `id`, `kind` (`tool` or `files`), `status`, `title`, `toolName`, `command`, `commandLine` (the real command without `cd` and shell wrappers), `commands`, `program`, `args`, `activityKind`, `description`, `output`, `exitCode`, `files` (`path`, `kind`, `diff`, ...), `startedAt`, `finishedAt`, `durationMs`.
- The first matching view by `order` wins. A missing or throwing part falls back to the core view; `match` runs often, keep it cheap.
- `summary.activity` is the live "what the agent is doing" line; `summary.pin` keeps the row visible when long tool streaks fold.
- Keep `inline` to what must be seen at once (failures, warnings); code structure such as `codeMap` belongs in `detail`, which stays closed until opened.
- `inline` and `detail` return HTML strings: build them with `aiws.ui.html`, which escapes values. Command output is untrusted.
- Panel `ctx` adds `nodes`, `live`, `task`, `run` to the app context. Panels are collapsed until opened unless `open: true`; the choice is remembered.
- `aiws.conversation.parse`: `stripAnsi(text)`, `baseName(path)`, `flagValue(args, ...names)`, `operands(args)`, `sourceFiles(node)`, `commandInsight(line)`, `shellWords(text)`, `testSummary(output)` → `{ passed, failed, skipped, total, duration, failures }` or `null`, `testReport(output)` → `{ passed, failed, skipped, total, duration, passRate, environment, projects, suites, failures }` or `null`, `diagnostics(output)` → `{ errors, warnings, items }`, `searchResults(output)`.
- `aiws.conversation.ui` returns themed HTML: `chips(list)`, `resultBar(summary)`, `fileName(path)`, `stats(list)`, `steps(list)`, `diagnostics(items, limit)`, `failures(names, limit)`, `testExplorer(report, options)`, `codeMap(items, limit)`, `code(rows)`, `diff(text)`.

