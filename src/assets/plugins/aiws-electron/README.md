# Electron plugin

Dedicated cards in the chat for `electron-builder`, Forge, packager, rebuild, `electron-vite` and Playwright desktop tests, plus an analysis view that extracts IPC channels, `contextBridge` APIs and security settings from the main, preload and renderer files that are edited and read.

## What changes in the chat

- **electron-builder, Forge, packager**: packaging steps, platform, architecture, Electron version, targets and the installers produced
- **electron-rebuild**: the native Node modules that were built
- **electron . and electron-vite**: errors in the main/preload/renderer process log and build targets
- **Desktop tests (IDE Test Explorer)**: the suite and case tree for Playwright, Vitest and Jest desktop tests, passed/failed/skipped tests, `Expected` / `Actual` diffs and stack trace
- **Electron architecture and security analysis (`files` and `read`)**: `ipcMain.handle`/`on` channels, `ipcRenderer.invoke`/`send` calls, `webContents.send` events, the `window.<api>` objects and methods exposed with `contextBridge.exposeInMainWorld`, `BrowserWindow`/`Tray` windows, native operating system APIs (`Menu`, `dialog`, `shell`, `autoUpdater`, `safeStorage`, `protocol`), security hardening (`contextIsolation: true`, `sandbox: true`) and security weakening (`nodeIntegration: true`, `contextIsolation: false`, `sandbox: false`, `webSecurity: false`, a leaked raw `ipcRenderer`)
- **Status panel**: a panel that shows packaging, tests, changed processes and security warnings

## Installation

Ships with AIWS and is on by default; it can be turned off under **Settings → Plugins**. The plugin uses only the `aiws.conversation` API and has no server code. API: `src/assets/agent-skills/aiws-plugin-development`.
