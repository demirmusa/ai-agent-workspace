AIWS is installed from source: clone the repository and start it. On Windows one script does everything; on macOS and Linux it is four commands.

## Requirements

| Requirement | Notes |
| --- | --- |
| [Node.js](https://nodejs.org/) 22.13 or newer | Includes npm. Check with `node --version`. |
| [Git](https://git-scm.com/) | Needed for cloning and for task branches and worktrees. |
| At least one agent CLI, signed in | For example Claude Code (`claude`) or Codex (`codex`). See [AI Providers](AI-Providers). |
| [GitHub CLI](https://cli.github.com/) (`gh`), optional | Only for the [GitHub integration](GitHub-Integration). |
| Build tools, Linux only | Python 3, `make` and a C++ compiler, for the native terminal module (`node-pty`). |

AIWS runs the agent CLI that is installed on your machine under your own account. Sign in to it once in a normal terminal (run `claude` or `codex` and follow its login) before you start your first task.

## Windows

```powershell
git clone https://github.com/demirmusa/ai-agent-workspace.git
cd ai-agent-workspace
.\run.ps1
```

`run.ps1` does the following, in order:

1. Checks that Node.js 22.13+ and npm are available.
2. Installs dependencies (`npm install` in `src`).
3. Links the `aiws` command globally (`npm link`), so agents can ask you questions and report results.
4. Builds the project.
5. Opens the desktop app. The first start downloads the Electron binary.

Run the same script again after `git pull` to update. It can be called from any directory and does not touch your Git history or application data.

| Command | Effect |
| --- | --- |
| `.\run.ps1` | Install, link, build and open the desktop app |
| `.\run.ps1 -NoDesktop` | Install, link and build only |
| `powershell -ExecutionPolicy Bypass -File .\run.ps1` | Use this if PowerShell refuses to run scripts |

## macOS and Linux

```bash
git clone https://github.com/demirmusa/ai-agent-workspace.git
cd ai-agent-workspace/src
npm install
npm link
npm run desktop
```

`npm run desktop` downloads Electron on first use, compiles the sources and opens the window. `npm link` is not needed to open the window; it puts `aiws` on your `PATH` so that agents can call `aiws control ask` and `aiws control complete`.

## Browser instead of the desktop app

The same interface runs in a browser against a local server:

```bash
cd src
npm install
npm run build
npm link
npm run control
```

Open <http://127.0.0.1:4317>. You can also start the server directly and choose the address and data directory:

```bash
aiws control serve --host 127.0.0.1 --port 4317 --data-dir /path/to/control-data
```

Differences from the desktop app:

- The desktop app starts its own private server on a free port and stops it (and its agents) when you quit. The browser server keeps running until you stop the command.
- Closing the desktop window minimizes the app to the system tray, where agents and GitHub polling continue. Use the exit item in the tray menu to stop everything, including running agents.
- In the browser, the folder picker lists folders of the machine that runs the server, not of the machine running the browser.

To point the desktop app at an already running server, set `AIWS_CONTROL_URL` before starting it:

```powershell
$env:AIWS_CONTROL_URL = 'http://127.0.0.1:4317'
npm run desktop
```

## Docker

The control server and agent workers can also run in containers on a Linux host. See [Docker Deployment](Docker-Deployment).

## Verify the installation

```bash
aiws --help
aiws control projects list
```

The second command needs the app (or `aiws control serve`) to be running; it finds the local service on its own.

## Optional: let your agents manage AIWS

AIWS ships a skill that teaches Claude Code and Codex to manage projects and tasks through the CLI:

```bash
aiws agent-skills install
aiws agent-skills status
```

See [Agents, Skills and Workflows](Agents-Skills-and-Workflows).

## Updating

```bash
git pull
```

Then run `.\run.ps1` again on Windows, or `npm install && npm run desktop` in `src` on other systems. Your data in `~/.aiws` is kept.

## Uninstalling

Quit the app, run `npm unlink -g ai-agent-workspace`, and delete the cloned folder. Your projects' own folders are never modified by uninstalling. Application data lives in `~/.aiws`; delete that folder too if you want to remove tasks, settings and history. See [Configuration](Configuration).

## Related pages

- [Quick Start](Quick-Start)
- [AI Providers](AI-Providers)
- [Troubleshooting](Troubleshooting)
- [Configuration](Configuration)
