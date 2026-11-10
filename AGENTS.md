# Agent rules

Every agent working in this repository (Claude Code, Codex, Copilot, OpenCode, Antigravity and others) follows the
rules below. The project layout, test commands and user guide are in the repository's wiki; its source is the
`wiki/` folder (`wiki/Development.md` for contributors).

## Single responsibility, no duplication

Every concept has exactly one owner; everything else reads it from there. Before writing new code, look for the
owner. If there is none, create it and use it instead of copying.

- **No duplicated code.** Do not write the same helper function, constant, list or regex a second time.
  Shared helpers live in `src/shared/core/*` or in the module of the area they belong to; when you see a second
  copy, move it to one place and update the callers.
- **Providers come from one place.** Each AI provider is a single `IAIProvider` class under
  `src/control-server/ai-providers/`, registered in `AIProvidersService`. Settings, the command line, the model
  list, detection, usage, the CLI and the UI read from this service. Do not write branches such as
  `provider === 'claude'` or hand-written provider lists in other files; add the behavior to the provider class.
- **The theme comes from one place.** Colors, fonts, shadows and shared sizes are defined only in the theme block
  at the top of `src/control-ui/styles.css` (`:root` and `:root[data-theme=light]`). Components use only these
  tokens: do not write raw hex/rgb colors, theme-specific component rules such as
  `:root[data-theme=light] .component{...}`, or `var(--x, fallback)` for a token that is defined. If a new color is
  needed, add a token to both themes. Brand colors (such as provider icons) are the only exception. Component
  styles live under `src/control-ui/styles/`, one file per component; change a component's rule in its own file and
  do not override it from another file.
- **Components have one look.** Every window opens with `showModal` (`app/modal.js`) and the `.app-modal` frame;
  do not write a separate dialog or overlay. Dropdowns, context menus and popovers carry the `popup-menu` class and
  take their surface from the shared rule in `styles/popup-menu.css`; do not redefine the background, border,
  shadow or highlight. Use `AIWSUI.menuNavigate` for keyboard navigation. Native `select` and `option` elements
  take the theme from the form control rule.
- **No duplicated front-end code.** Helpers shared between files (`esc`, `copyText`, menu navigation) live in
  `src/control-ui/ui-common.js` (`window.AIWSUI`); do not write a copy in another file. If the same HTML fragment,
  text formatting, icon or status label is produced in more than one place, move it into a single function.
  Translated text goes through `i18n.js` and `translations-en.js`; `AIWSI18n.template` does not escape values, so
  pass every value that enters HTML through `esc`.
- **The UI is made of classic scripts.** Files in `src/control-ui` have no build step, share one global scope and
  load in the order listed in `index.html`. The application shell lives under `app/`, one file per feature
  (`app/main.js` last). While a file loads it can use only what the files loaded before it declared; place a new
  file in `index.html` accordingly and never declare the same top-level name twice.
- **Plugins come from one place.** Plugin installation, validation and server code live in
  `src/control-server/plugins.ts` and `plugin-*.ts` (manifest, archive, runtime); the extension points of the UI
  live in `src/control-ui/plugin-host/*`, and `src/control-ui/plugins.js` publishes them as `window.AIWSPlugins`.
  `app/*` only calls the hooks of this host; do not write plugin-specific branches. When you add or change an
  extension point, update `wiki/Plugins-and-Themes.md` and the references in
  `src/assets/agent-skills/aiws-plugin-development` in the same change.
- **Do not fix by adding a layer.** When you change a style or a behavior, change the original rule instead of
  appending a new rule at the end of the file that overrides it; delete the old rule that became dead.

If a change does not follow one of these rules, fix it in the same change instead of treating it as separate work,
or tell the user why.

## Tests

- Type check: `npm run typecheck` in `src`.
- Server/CLI tests: `npx vitest run control-server/tests cli/tests shared/tests` and so on.
- UI tests (`src/control-ui/tests`) are slow; unless the user asks otherwise, run only the tests related to your
  change with the `-t "<test name>"` filter, not the whole UI suite.
