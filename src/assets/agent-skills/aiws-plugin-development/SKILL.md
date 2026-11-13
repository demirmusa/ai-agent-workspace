---
name: aiws-plugin-development
description: Build, theme, debug and package plugins for the AI Agent Workspace (the local Kanban/agent desktop app). Use when the user wants to add menus, pages, project tabs, task editor fields, task detail sections or tabs, card badges, commands, colour themes, server routes or agent prompt context to AIWS through its plugin system, or asks to create/fix/install an AIWS plugin or theme.
---

# AIWS plugin development

AI Agent Workspace has a plugin system. A plugin is a folder with a `plugin.json` manifest and optional browser code,
CSS, themes and Node.js server code. Plugins are installed from the Settings → Plugins page, from a ZIP, or
with `aiws control plugins install`. Everything a plugin registers is removed again when it is turned off.

Read these references before writing code; they are the contract:

- [manifest](references/manifest.md) – `plugin.json` fields, settings schema, theme declarations, limits.
- [client API](references/client-api.md) – the `aiws` object passed to `activate(aiws)` in the browser: every extension point.
- [server API](references/server-api.md) – optional `server.js`: routes, events, storage, agent prompt context; HTTP endpoints and CLI.
- [theme tokens](references/theme-tokens.md) – every CSS token a theme may re-value, with dark and light defaults.
- [recipes](references/recipes.md) – complete, copyable solutions for common requests and a minimal skeleton.

## Workflow

1. **Clarify the goal and where it appears.** Map the request to extension points (sidebar item, page, top bar button,
   project tab, task form section/tab, task detail section/tab/action, card badge, command, theme, settings panel, server
   route, prompt context, DOM decoration). Prefer a dedicated extension point; use `aiws.dom.onElement` only when none fits.
2. **Choose a plugin id** like `acme.task-timer` (3-64 chars: lowercase letters, digits, `.`, `-`, `_`). It is permanent:
   task data, storage, settings and URLs are keyed by it. Never reuse another plugin's id.
3. **Create a separate folder** outside the AIWS source tree unless the user says otherwise, e.g. `<workspace>/aiws-plugins/<id>/`:
   `plugin.json`, `plugin.js` (browser ES module), optional `style.css`, `server.js`, `icon.svg`, `README.md`.
   Start from the skeleton in [recipes](references/recipes.md). Do not edit AIWS's own files to build a plugin.
4. **Write the manifest**, then the browser module exporting `activate(aiws)`. Keep all UI text localizable:
   `name`/`label`/`description` accept `{ "tr": "...", "en": "..." }`; in code use `aiws.i18n.add()` + `aiws.i18n.t()`.
5. **Build markup safely.** Task titles, descriptions and other state are user/agent content. Build HTML with
   the tagged template ``aiws.ui.html`...` `` (escapes every substitution) and wrap trusted nested markup in `aiws.ui.raw()`. Never put state into
   `innerHTML` unescaped.
6. **Style with AIWS tokens only** (`var(--surface)`, `var(--ink)`, `var(--accent)`, `var(--tone-done)` ...), prefix plugin
   classes (e.g. `ts-`), and reuse AIWS classes (`button small primary`, `form-field`, `ui-chip`, `settings-card`,
   `issue-panel`). This keeps light/dark mode and other themes working. A theme changes colours by re-valuing tokens.
7. **Install for development** with a link so edits apply on reload:
   `aiws control plugins install <folder> --link` (or Settings → Plugins → "Developer mode"). After editing browser
   code press "Yeniden yükle" on the plugin card (or reload the window). After editing `server.js`, disable and enable the
   plugin (`aiws control plugins disable <id>` then `enable <id>`).
8. **Verify** (see below), then **package**: `aiws control plugins pack <folder>` writes `<id>-<version>.zip`, which anyone
   can install from the Plugins page. Bump `version` for every release.

## Rules

- Plugin code runs with the user's full rights: browser code in the app page, `server.js` inside the control server's
  Node.js process. Do not add network calls, telemetry, credential access or file writes the user did not ask for.
  The page's Content Security Policy only allows same-origin requests: browser code cannot call external URLs; do that in
  `server.js` and expose a route.
- Never block the UI: keep `activate` fast, load data asynchronously, guard against missing state (`task?.pluginData`).
- Task data belongs under `task.pluginData[<your id>]` only (max 64 KiB per task, all plugins). Read it with
  `ctx.data`, write it with `ctx.saveData(values)`, `aiws.tasks.setData(id, values)` or a task form section's `collect()`.
- Use `aiws.storage` (server, ≤1 MiB per plugin) for shared data and `aiws.storage.local` for per-device preferences.
  Use declared `settings` in `plugin.json` for user configuration; they render automatically on the Plugins page.
- Return `{ update(ctx), unmount() }` from `render()` when a view must react to new state; AIWS calls `update` on every
  render while the view stays mounted, so make it cheap and idempotent and keep user input (focus, typed text) intact.
- Do not monkey-patch AIWS globals (`window.AIWSUI`, `AIWSPlugins`, app functions) or depend on undocumented DOM ids;
  only the documented slots and `aiws.*` API are stable (`apiVersion: 1`).
- Keep themes complete for each mode they declare (at least `ground`, `sidebar`, `surface`, `surface-hover`, `raised`,
  `ink`, `ink-strong`, `muted`, `faint`, `line`, `line-strong`, `accent`, `accent-hover`, `accent-ink`, `link`, `primary`,
  `primary-hover`, `primary-ink`) and keep text contrast at least 4.5:1 against its surface.

## Verify before reporting success

- `aiws control plugins show <id>`: `error` must be absent, `enabled: true`; with `server.js`, `server.status` must be
  `active` and `server.routes` must list your routes. `aiws control plugins logs <id>` shows server log lines and errors.
- In the app, open Settings → Plugins → the plugin card → "Details": browser errors from `activate`/`render` are
  listed there together with a summary of registered contributions.
- Exercise each extension point you added (open the page, create a task with your fields and reopen it, check the card
  badge, switch theme in light and dark mode). Call server routes with `aiws.http.route()` or `curl`.
- If something cannot be verified (no running AIWS, no browser), say so explicitly instead of claiming it works.
