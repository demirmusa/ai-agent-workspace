How the repository is organized, how to build and test it, and the rules every change follows. The source of this wiki is the `wiki/` folder of the repository.

## Repository layout

The application is a single npm package that lives in `src/`. The root `package.json` is a private wrapper that forwards commands there.

```text
src/
  cli/              aiws CLI entry point and commands (commands/control = aiws control)
  desktop-app/      Electron main process, tray, IPC, preload
  control-server/   Control service
    http/           request guards, static assets, SSE, routes/*
    service/        tasks, runs, delivery, questions, conversations, GitHub bridge
    ai-providers/   one IAIProvider class per provider, registered in AIProvidersService
    plugins.ts      PluginManager (+ plugin-manifest, plugin-archive, plugin-runtime)
    docker/         server/worker Dockerfile and Compose
  control-ui/       Browser/Electron UI, build-free classic scripts
    index.html      load order of every script and stylesheet
    styles.css      theme tokens only
    styles/         one stylesheet per component
    app/            application shell, one file per feature, main.js last
    plugin-host/    plugin extension points
  shared/           config, core helpers, git, github (used by CLI and server)
  runtime/          Docker runtime preparation for the Actions runner
  templates/        generated repository integration files
  assets/           shipped runtime, workflows, agent skills, built-in plugins
examples/plugins/   installable example plugins
media/              demo video and screenshots used by the README and this wiki
wiki/               source of this wiki
```

Each area keeps its tests in its own `tests` folder. `src/dist` is build output; never edit it by hand.

## Build and run

Node.js 22.13 or newer is required.

```bash
cd src
npm install
npm run build          # clean + tsc
npm link               # puts aiws on PATH
npm run desktop        # build and open the Electron app
npm run control        # serve the built API + UI on http://127.0.0.1:4317
```

On Windows, `.\run.ps1` from the repository root does install, link, build and start in one step (`-NoDesktop` skips the app).

The UI has no build step: edit a file in `src/control-ui` and reload the window. Server and CLI changes need `npm run build`.

## Tests

```bash
cd src
npm run typecheck
npx vitest run control-server/tests cli/tests shared/tests
npm run test:server
npm run test:cli
npm run test:ui
```

UI tests (`src/control-ui/tests`) are slow. Run only the tests related to your change:

```bash
npx vitest run control-ui/tests -t "<test name>"
```

Checks that need a logged-in provider or Docker are separate and are not part of `npm test`: `test:provider`, `test:pty`, `test:planning`, `test:draft`, `test:history`, `test:subagents`, `test:docker`. They can consume real quota.

## Rules for changes

The full rules are in [`AGENTS.md`](https://github.com/demirmusa/ai-agent-workspace/blob/main/AGENTS.md); `CLAUDE.md` imports the same file, so coding agents follow them too. The core idea: every concept has exactly one owner, and everything else reads it from there.

| Rule | In practice |
|---|---|
| No duplicated code | Shared helpers live in `src/shared/core/*` or the owning module. If you find a second copy, move it to one place and update the callers |
| Providers come from one place | Each AI provider is a single `IAIProvider` class under `src/control-server/ai-providers/`, registered in `AIProvidersService`. No `provider === 'claude'` branches or hand-written provider lists elsewhere; add the behavior to the provider class |
| Theme comes from one place | Colors, fonts, shadows and shared sizes are defined only in the theme block at the top of `src/control-ui/styles.css` (`:root` and `:root[data-theme=light]`). Components use those tokens only: no raw hex/rgb colors, no theme-specific component rules. A new color is added to both themes. Brand colors are the only exception |
| One stylesheet per component | Change a component's rule in its own file under `styles/`; do not override it from another file |
| One look per component | All windows open with `showModal` (`app/modal.js`) and the `.app-modal` frame. Menus and popovers carry the `popup-menu` class and use `AIWSUI.menuNavigate` for keyboard navigation |
| No duplicated front-end helpers | `esc`, `copyText` and menu navigation live in `ui-common.js` (`window.AIWSUI`). Translations go through `i18n.js` and `translations-en.js`. `AIWSI18n.template` does not escape: pass every value that enters HTML through `esc` |
| Classic scripts and load order | UI files share one global scope and load in the order listed in `index.html`. A file may use only what earlier files declared; place new files accordingly and never declare the same top-level name twice |
| Plugins come from one place | Server code in `plugins.ts` and `plugin-*.ts`, UI extension points in `control-ui/plugin-host/*`. `app/*` only calls the host's hooks. When you add or change an extension point, update the [Plugins and Themes](Plugins-and-Themes) page (`wiki/Plugins-and-Themes.md`) and the `aiws-plugin-development` skill in the same change |
| Do not fix by layering | Change the original rule or behavior instead of appending an override, and delete what became dead |

If a change cannot follow one of these rules, fix it in the same change or explain why.

## Architecture in brief

| Area | Folder | Entry point |
|---|---|---|
| Control server | `src/control-server` | `startControlServer()` in `server.ts`; `http/` only wires requests to the `ControlService` facade (`service.ts`), which delegates to `service/*` |
| UI | `src/control-ui` | `index.html` loads classic scripts in order, ending with `app/main.js` |
| Desktop app | `src/desktop-app` | `main.ts` starts the control server in a utility process and opens windows on it |
| CLI | `src/cli` | `index.ts` and `program.ts`; `commands/control` is the HTTP client behind `aiws control` |
| Shared code | `src/shared` | `config/`, `core/`, `git/`, `github/` |
| Runner runtime | `src/runtime`, `src/templates`, `src/assets` | `aiws init` and `aiws up` |

State lives in SQLite (`store.ts`) plus `settings.json`; agent processes are started by `runner.ts` through a PTY helper process, directly as a stream, or as a Docker worker. The UI talks to the server over HTTP, server-sent events and one WebSocket for voice. See [HTTP API](HTTP-API) and [Configuration](Configuration).

## Adding a voice provider

Voice dictation sends microphone audio (16 kHz, mono, 16-bit PCM) from the browser to `/api/voice`, where `VoiceRelay` (`src/control-server/voice.ts`) forwards it to the selected provider's own speech service. To add a provider:

1. Find out how the provider's speech service works (address, authentication, audio format, message format) from its own client. Do not guess the protocol.
2. In `src/control-server/ai-providers/<provider>.ts`, write a `VoiceSource` (see `ai-providers/voice.ts`). `open(context, options, handlers)` connects and returns a `VoiceConnection` with `send(pcm)`, `finish()` and `close()`. Read the provider's login from `context.dir`, report text with `handlers.onTranscript(text, final)`, errors with `onError(message)` and the end with `onClose()`. Throw a `ControlError` when there is no valid login; its message is shown to the user.
3. Set `override readonly voice = voice;` on the provider class. The settings list, the UI and the relay pick it up from the provider registry; do not branch on the provider id anywhere else.
4. Test the protocol translation, for example against a fake WebSocket server. `src/control-server/tests/control-voice.test.ts` covers the relay with a fake `VoiceSource`.

The provider's credentials are read only on the server and never reach the browser.
## Adding things

- **A provider:** add one class under `src/control-server/ai-providers/` and register it; settings, model lists, detection, usage, the CLI and the UI read from the registry.
- **A UI feature:** a new file under `src/control-ui/app/` (and a stylesheet under `styles/`), placed in `index.html` after the files it depends on.
- **A built-in plugin:** a folder under `src/assets/plugins`.
- **An extension point:** `control-ui/plugin-host/*`, plus the documentation and skill updates mentioned above.

## Packaging

The publishable package is prepared from `src`:

```bash
cd src
npm pack --dry-run
npm pack
```

`prepack` copies the root `README.md`, `LICENSE` and `examples/` into `src`, builds and runs the tests; `postpack` removes the copies.

Docker images are built from the repository root:

```bash
docker compose -f src/control-server/docker/compose.control.yaml --profile build build
```

## Related pages

- [Installation](Installation)
- [CLI Reference](CLI-Reference)
- [HTTP API](HTTP-API)
- [Plugins and Themes](Plugins-and-Themes)
- [Security](Security)
