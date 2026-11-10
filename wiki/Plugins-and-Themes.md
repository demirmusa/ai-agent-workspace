AI Agent Workspace can be extended with plugins. A plugin is a folder with a `plugin.json`, an optional browser module, CSS, color themes and optional Node.js code that runs in the control server.

This page is an overview. The full API reference is in the plugin development skill, [src/assets/agent-skills/aiws-plugin-development](https://github.com/demirmusa/ai-agent-workspace/tree/main/src/assets/agent-skills/aiws-plugin-development) (`references/client-api.md`, `server-api.md`, `manifest.md`, `theme-tokens.md`, `recipes.md`), and working examples are in [examples/plugins](https://github.com/demirmusa/ai-agent-workspace/tree/main/examples/plugins).

## What a plugin can do

| Capability | Where it appears | API |
|---|---|---|
| Change colors and fonts | The whole UI, dark and light | `themes` in plugin.json, `aiws.themes`, `aiws.styles` |
| Add a sidebar item | Sidebar | `aiws.sidebar.addItem` |
| Add a top bar button | Header, left of **Prepare with AI** / **New task** | `aiws.topbar.addButton` |
| Add a full page | Main area | `aiws.pages.register` |
| Add a project tab | Next to Board, Terminal, Scheduled tasks, Sessions, Project settings | `aiws.projectTabs.add` |
| Add fields to the task window | Below the description or as a tab | `aiws.taskForm.addSection` |
| Add sections, tabs and actions to the task panel | Information tab, a new tab, the "⋯" menu | `aiws.taskDetail.*` |
| Add badges to task cards | Board and list | `aiws.taskCard.addBadge` |
| Customize tool calls in the chat | Task chat rows and cards | `aiws.conversation.addToolView` |
| Add a panel above the chat | Task chat | `aiws.conversation.addPanel` |
| Commands and keyboard shortcuts | Everywhere | `aiws.commands.register` |
| Store its own data on a task | `task.pluginData[<plugin id>]` | `ctx.saveData`, `aiws.tasks.setData` |
| A settings form | Settings → Plugins → the plugin's card | `settings` in plugin.json, `aiws.settings` |
| React to events | Task created, status changed, run finished | `aiws.events.on`, `events.on` on the server |
| Server routes and calls to outside services | `/api/plugins/<id>/routes/...` | `server.js` → `routes.get/post...` |
| Add context to the agent prompt | When a task run starts | `server.js` → `prompt.contribute` |

Everything a plugin registers belongs to it. Disable, reload or remove the plugin and its menus, pages, tabs, badges, styles, listeners and routes are removed. A failing plugin does not break the app; the error is listed on its card.

## Built-in plugins

Four plugins ship with AIWS and are on without installation. They make the task chat understand the commands of a technology.

| Plugin | In the chat |
|---|---|
| `aiws.dotnet` | `dotnet test`, `build`, `publish`, `run`, EF Core: test projects, failures with stack traces, build errors |
| `aiws.react-native` | Expo, EAS, Metro, Gradle, CocoaPods, Xcode, adb, Detox, Maestro |
| `aiws.electron` | electron-builder, Forge, rebuild: packaging steps and outputs, warnings about weakened security settings |
| `aiws.angular` | `ng` and `nx`: bundle sizes, budget warnings, build errors, Karma and Jest results |

They can be turned off under **Settings → Plugins** but not removed. Installing a plugin with the same `id` replaces the built-in one until you remove it.

## Install a plugin

Open **Settings → Plugins** and use the **Install a plugin** card.

| Way | How |
|---|---|
| Folder | Enter the full folder path (or **Choose folder…** in the desktop app) and click **Install from folder**. The folder is copied. |
| ZIP | **Upload ZIP file** |
| CLI | `aiws control plugins install <folder or file.zip>` |

An installed plugin is active immediately in every open window, without a restart. Reinstalling the same `id` replaces the version and keeps its settings and stored data. **Scan again** picks up plugins you copied into the install folder by hand.

Try it with the bundled example:

```text
aiws control plugins install examples/plugins/aiws-example-plugin
```

Each card under **Installed plugins** has an on/off switch, **Details** (id, folder, routes, contributions, errors), the generated settings form, **Show server logs**, **Reload** and remove.

```text
aiws control plugins list
aiws control plugins show <id>
aiws control plugins enable <id>
aiws control plugins disable <id>
aiws control plugins settings <id> '{"key":"value"}'
aiws control plugins logs <id>
aiws control plugins remove <id>
```

Installed plugins live in `<data directory>/plugins/<id>/` (default `~/.aiws/control/plugins`). Enabled state, settings and plugin storage are in `<data directory>/plugins.json`.

## Themes

The **Theme** card on the same page lists the default theme and every theme that plugins bring. The choice is stored on this device. The light/dark switch in the sidebar changes the mode of the selected theme.

A theme redefines the design tokens of the app for dark mode, light mode or both. A plugin can consist of nothing but themes, with no code:

```json
{
  "id": "acme.midnight",
  "name": "Midnight",
  "version": "1.0.0",
  "themes": [{
    "id": "midnight",
    "name": { "tr": "Gece Yarısı", "en": "Midnight" },
    "dark":  { "ground": "#0f1222", "surface": "#151935", "ink": "#dfe3f5", "accent": "#8b7bff" },
    "light": { "ground": "#f6f7fc", "surface": "#ffffff", "ink": "#1b1f3a", "accent": "#5b47e0" }
  }]
}
```

- A mode the theme does not define keeps the built-in values.
- An optional `css` file is loaded only while the theme is selected, for things tokens cannot express, such as fonts. Ship fonts inside the plugin; external addresses are blocked.
- Keep text-to-background contrast at 4.5:1 or better.

`examples/plugins/aiws-theme-sunset` is a complete theme-only plugin.

## Write a plugin

### Folder layout

```text
acme.task-timer/
  plugin.json        required manifest
  plugin.js          browser ES module ("main")
  style.css          styles loaded while the plugin is on ("styles")
  server.js          optional Node.js module ("server")
  package.json       for server.js: { "type": "module", "private": true }
  icon.svg           card icon ("icon")
  themes/x.css       optional theme stylesheet
```

### plugin.json

```json
{
  "id": "acme.task-timer",
  "name": { "tr": "Görev Zamanlayıcı", "en": "Task Timer" },
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Tracks time spent on tasks.",
  "main": "plugin.js",
  "styles": ["style.css"],
  "server": "server.js",
  "settings": [
    { "key": "roundTo", "type": "number", "label": "Round to (min)", "min": 1, "max": 60, "default": 5 }
  ]
}
```

`id`, `name` and `version` are required. The `id` (3 to 64 characters: lowercase letters, digits, `.`, `-`, `_`) is permanent; task data, storage, settings and URLs depend on it. Text fields accept a plain string or `{ "tr": "...", "en": "..." }`. Setting types are `text`, `textarea`, `password`, `number`, `boolean`, `select` and `color`.

### Browser module

```js
export function activate(aiws) {
  aiws.sidebar.addItem({ id: 'hello', label: 'Hello', icon: 'spark', page: 'hello' });
  aiws.pages.register({
    id: 'hello',
    title: 'Hello',
    render(container) { container.innerHTML = '<p>Hello world</p>'; },
  });
}
```

Task text is user and agent content. Build HTML with ``aiws.ui.html`...` ``, which escapes every value.

### Server module

```js
export async function activate(context) {
  const { routes, events, prompt, log, plugin } = context;
  routes.get('/ping', () => ({ ok: true, version: plugin.version }));
  events.on('task.statusChanged', ({ task, from, to }) => log.info(`${task.title}: ${from} -> ${to}`));
  prompt.contribute(task => task.pluginData?.[plugin.id]?.note ?? null);
}
```

Routes are served under `/api/plugins/<id>/routes/`. Text returned by `prompt.contribute` is added to the agent prompt under `Plugin context:` when a run starts.

### Development loop

1. Create the folder outside the AIWS sources.
2. Link it instead of copying: `aiws control plugins install <folder> --link`, or tick **Developer mode: link the folder without copying** before **Install from folder**. Files are served straight from your folder.
3. After changing browser code, click **Reload** on the card. After changing `server.js`, disable and enable the plugin.
4. Read errors under **Details** and **Show server logs**, and in the browser console (prefixed `[plugin <id>]`).
5. Package with `aiws control plugins pack <folder>`, which writes `<id>-<version>.zip`. Raise `version` for each release.

### Let an agent write it

**Install skill** on the **Plugin development skill** card copies the `aiws-plugin-development` skill into your Codex (`~/.agents/skills`) and Claude Code (`~/.claude/skills`) user skills. It is not installed by default. After that, asking an agent to "build this plugin for AIWS" is enough: the skill contains the plugin system, the whole API, the theme tokens, examples and verification steps.

```text
aiws control plugins skill [--force]
aiws agent-skills install --skill aiws-plugin-development [--provider codex|claude|all] [--scope user|project]
```

## Limits and security

| Limit | Value |
|---|---|
| Files per plugin | 1000 |
| File size | 10 MiB |
| Total size | 50 MiB |
| Plugin data per task, all plugins | 64 KiB |
| Plugin storage | 1 MiB JSON per plugin |
| Themes, style files | 20 each |
| Settings fields | 50 |

- **Plugin code runs with your permissions.** Browser code runs in the app page; `server.js` runs inside the control server's Node.js process with file system, network and process access. Install only plugins you trust. Plugins with server code are marked on their card.
- The page's content security policy allows only same-origin scripts, styles, images and connections. A plugin cannot call outside addresses from the browser; do that in a `server.js` route.
- Folders and ZIPs are validated on install: relative paths only, no `..`, no symbolic links, size and file limits.
- `password` settings are stored as plain text. Keep real secrets in environment variables or the operating system's store.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "plugin.json was not found" / "is not valid JSON" | A valid `plugin.json` must be in the root folder. A ZIP may contain one top-level folder. |
| "plugin.json names X, but the file is missing" | Check the `main`, `server`, `styles`, `icon` and theme `css` paths. |
| "needs plugin API 2" | Update AIWS or set `apiVersion` to 1. |
| Menu or page does not appear | Is the plugin enabled? Check **Details** and the browser console. |
| Server route returns 404 | The plugin is off or `server.js` failed: `aiws control plugins show <id>`, then `logs`. |
| Change is not visible | Linked install: **Reload**. Copied install: install again. For `server.js`: disable and enable. |

## Related pages

- [Configuration](Configuration)
- [HTTP API](HTTP-API)
- [Security](Security)
- [Agents, Skills and Workflows](Agents-Skills-and-Workflows)
- [Development](Development)
