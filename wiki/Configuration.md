AI Agent Workspace keeps all of its state in one data directory on the computer that runs the control service. This page covers that directory, the environment variables the service reads and the global settings.

## Data directory

The default is `~/.aiws/control` (`C:\Users\<you>\.aiws\control` on Windows). Change it with `aiws control serve --data-dir <path>` or the `AIWS_CONTROL_DATA_DIR` environment variable.

```text
<data dir>/
  control.db (+ -wal, -shm)     SQLite database: projects, tasks, runs, agents, skills,
                                workflows, schedules, questions, events, messages
  settings.json                 global settings
  service.lock                  single-writer lock
  runs/<runId>/skills/...       skill snapshot of each run
  runs/<runId>/input/           prompt.md, agents.json, images/
  attachments/                  uploaded files that do not belong to a project
  wt/<project>/<task>           task worktrees
  workspace/                    the general workspace folder
  plugins/<id>/, plugins.json   installed plugins, their state, settings and storage
  logs/errors.log               service errors with stack traces
```

Outside the data directory:

| Location | Content |
|---|---|
| `<repository>/.aiws/attachments/` | Attachments of that project (a `.aiws/.gitignore` keeps them out of Git) |
| `~/.aiws/token-usage-cache.json` | Cached quota data for the usage indicator |
| `~/.aiws/repositories/<hash>/` | Installation state of the [GitHub Actions Runner](GitHub-Actions-Runner) mode |

Only one service may open a data directory at a time. A second one fails with "Control data directory is already in use". Do not delete `service.lock` while a service is running; a stale lock left by a crashed process is reclaimed automatically.

### Backup

Stop the service (exit the desktop app from its tray menu), then copy the whole data directory. Include `runs/` if you want to keep skill snapshots. Runs that were active when the service stopped show up as interrupted after a restart.

## Environment variables

| Variable | Effect |
|---|---|
| `AIWS_CONTROL_HOST`, `AIWS_CONTROL_PORT` | Listen address, default `127.0.0.1:4317` |
| `AIWS_CONTROL_TOKEN` | API token; required when listening on a non-loopback address |
| `AIWS_CONTROL_ALLOWED_HOSTS` | Extra allowed `Host` names on loopback (comma-separated), for example behind a reverse proxy |
| `AIWS_CONTROL_DATA_DIR` | Data directory |
| `AIWS_CONTROL_URL` | Service the CLI and the desktop app connect to. When set, the desktop app does not start its own service |
| `AIWS_CONTROL_AGENT_URL` | Address agents (for example Docker workers) use to reach the service |
| `AIWS_CONTROL_BROWSE_ROOTS` | Roots of the server-side folder browser (`;` on Windows, `:` elsewhere) |
| `AIWS_CONTROL_EXECUTION_MODE`, `AIWS_CONTROL_DOCKER_IMAGE`, `AIWS_CONTROL_DOCKER_NETWORK`, `AIWS_CONTROL_SKILLS_VOLUME` | Docker execution, see [Docker Deployment](Docker-Deployment) |
| `AIWS_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | GitHub access, tried in this order; without them the current `gh auth token` is used |
| `AIWS_NODE_BINARY` | Absolute path of the Node binary that hosts terminals, if `node` is not on `PATH` |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR` | Where provider session history and usage data are read from (defaults `~/.codex`, `~/.claude`) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN` | Provider credentials, read from the service environment only |
| `AIWS_HOME` | Root of the CLI installation state, default `~/.aiws` |
| `AIWS_DEBUG=1` | Show CLI error stacks |

Agent processes inherit the environment of the service. Start the service from an account and shell that only hold credentials you are willing to give to agents.

Each run additionally receives `AIWS_RUN_ID`, `AIWS_TASK_ID`, `AIWS_CONTROL_URL` and, when needed, `AIWS_CONTROL_TOKEN`.

## Global settings

Open **Settings** at the bottom of the sidebar, or use `aiws control settings show` and `aiws control settings set`.

| Setting | Default | CLI flag | Notes |
|---|---|---|---|
| Default provider | `codex` | `--default-provider` | Used by new tasks, GitHub imports, new agents, planning and AI drafts. An explicit provider on a task or agent wins |
| Concurrent agents | `3` | `--max-concurrent` | Global limit; a project can set its own with `projects update --max-concurrent` |
| Task merge method | `pull-request` | `--task-merge-mode` | `pull-request` or `branch`; projects can inherit or override it |
| Execution mode | `native` | `--execution-mode` | `native` or `docker` |
| Docker image | `aiws-control-worker:local` | `--docker-image` | Worker image for Docker mode |
| GitHub sync interval (seconds) | `30` | `--auto-sync-seconds` | `0` turns automatic sync off |
| GitHub AI trigger | `/ai` | `--github-trigger` | Word that addresses the agent in issues and comments |
| Voice typing provider | `claude` | | Settings only; see [Terminals, Files and Voice](Terminals-Files-and-Voice) |

```bash
aiws control settings set --max-concurrent 5 --default-provider claude
aiws control settings set --task-merge-mode branch
aiws control settings set --auto-sync-seconds 0
```

### Provider settings

Each built-in provider has its own card in Settings with extra CLI arguments (one argument per line, no shell), an **Auto mode** switch and **Refresh models**. Saving does not restart running agents; the next process picks up the change. See [AI Providers](AI-Providers).

### Per-browser preferences

Interface language (Turkish or English, default Turkish), light or dark theme, the selected plugin theme and panel sizes are stored in the browser or desktop window, not on the server. Changing the language reloads the page, so save open forms first. Task content, chat messages and terminal output stay in their original language.

## Project settings

Each project has its own settings tab: folder, default branch, Git worktree and main branch, auto merge, merge method override, concurrent agent limit, the handoff method for agents that run out of tokens, labels, milestones and the GitHub connection. See [Git, Worktrees and Merging](Git-Worktrees-and-Merging) and [GitHub Integration](GitHub-Integration).

## Limits worth knowing

| Limit | Value |
|---|---|
| Event history kept in memory | 20,000 events, about 8 million characters; long provider output can be truncated |
| Skill package | 64 files, 256 KiB per file, 1 MiB total |
| Images prepared per run | 20 |
| File editor | UTF-8 text files up to 2 MiB |
| JSON request body | 2 MiB |

## Related pages

- [Installation](Installation)
- [CLI Reference](CLI-Reference)
- [HTTP API](HTTP-API)
- [Docker Deployment](Docker-Deployment)
- [Security](Security)
