Symptoms you are likely to meet, and what to check first. If your problem is not listed, look at the logs described at the bottom of the page and open an issue with what you find.

## Installation and startup

| Symptom | Check |
|---|---|
| `run.ps1 cannot be loaded because running scripts is disabled` | PowerShell execution policy blocks the script. Run `powershell -ExecutionPolicy Bypass -File .\run.ps1` |
| `Run failed: Node.js is not installed or is not on PATH` | Install Node.js 22.13 or newer, open a new terminal and retry |
| `Run failed: Node.js X is too old` | Upgrade to Node.js 22.13 or newer (`node --version`) |
| `Run failed: npm is not installed or is not on PATH` | Reinstall Node.js with npm included |
| `npm install failed` while building `node-pty` (Linux) | Install Python 3, `make` and a C++ compiler, then run `npm install` again in `src` |
| Electron download fails | Run `npm run desktop:install` in `src`; check proxy, access to GitHub release downloads and disk space |
| `npm link` fails with a permission error | Use a terminal that may write to the global npm folder, or fix the npm prefix |
| Window opens but terminals stay empty | The terminal host runs on the system Node. Make sure `node` is on `PATH`, or set `AIWS_NODE_BINARY` to its absolute path |
| "Control data directory is already in use" | Another service or desktop app uses the same data directory. Exit it from the tray menu. Do not delete the lock of a live process |

To rebuild without opening the app: `.\run.ps1 -NoDesktop`.

## Connecting to the service

| Symptom | Check |
|---|---|
| UI cannot reach the API | `AIWS_CONTROL_URL`, service port, token, and reverse proxy settings for Server-Sent Events |
| 401 from the API | `AIWS_CONTROL_TOKEN` is set on the service; send `Authorization: Bearer <token>` or set the same variable for the CLI |
| 403 "Unexpected Host header" | You reach a loopback service through another name; add it to `AIWS_CONTROL_ALLOWED_HOSTS` |
| `aiws` is not recognized | Run `npm link` in `src` (or run `.\run.ps1` again) and open a new terminal |
| `aiws control` talks to the wrong service | Pass `--url`, or check `AIWS_CONTROL_URL` |
| Project path is rejected | The path must be absolute, exist and be readable by the backend account. With a remote backend it is a path on that machine |

## Agents and runs

| Symptom | Check |
|---|---|
| Provider not found / exit code 127 | The provider CLI (`codex`, `claude`, `opencode`, ...) must be on the `PATH` of the account that started the service. Restart the service after installing it |
| Agent fails immediately with an auth error | Log in with the provider's own command (for example `claude` then `/login`, or `codex login`) under the same account |
| Agent waits for permission | Answer in the real terminal (**Agent Console**), or review the provider's permission settings and **Auto mode** in Settings |
| `aiws control ask` not found inside a run | `npm link` for a source install; the correct `aiws-control-worker:local` image for Docker |
| Question is visible in the UI but the agent does not continue | The agent process must still be waiting on `aiws control ask`; check `AIWS_CONTROL_URL` and the token inside the run |
| A Ready task does not start | The card shows the queue reason. Usual causes: all execution slots occupied (**Concurrent agents**), an unfinished dependency, the same working folder in use, or the **System running** switch is off |
| Two tasks never run in parallel in one repository | Enable **Run tasks in separate Git worktrees** in the project settings so each task gets its own branch and folder |
| Task shows usage limit reached | The provider quota is exhausted. Use the handoff prompt to continue with another agent or provider |
| Run fails after "Connection lost" | The service retries while the provider API is unreachable; after 5 failed attempts in 10 minutes the run is marked failed. Restart it when the connection is back |
| Runs are "interrupted" after a restart | Runs that were active when the service stopped are marked interrupted. Inspect the workspace, then restart the task |

## Git and merging

| Symptom | Check |
|---|---|
| Pull fails | Pull is fast-forward only; resolve a diverged branch in your own terminal |
| Push or fetch hangs or fails | Git commands never prompt. Authenticate Git beforehand (credential manager, SSH key or `gh auth login`) |
| Merge reports a conflict | The task's agent is started to resolve it on the task branch; if that fails, the Git panel lists the conflicting files |
| Worktree is not removed | Worktrees with uncommitted changes and remote branches containing commits not in main are kept and reported |

## GitHub

| Symptom | Check |
|---|---|
| 403 or access error | Token permissions for the repository and Projects, organization SSO or policy, correct owner type. Run `aiws control github status` |
| Missing scopes | `aiws control github authorize`, or **Grant GitHub access** in the project settings |
| Status error on sync | The Projects board needs a single-select Status field with matching options, or a custom `--statuses` mapping |
| A deleted task comes back from GitHub | It should not: a permanent ignore record prevents it. Changing the connection configuration resets that list |
| Issue comment does not trigger the agent | The comment must contain the trigger (default `/ai`) and come from an owner, member or collaborator. The desktop app must be running |

## Docker

| Symptom | Check |
|---|---|
| Mount error | The project path must be the same absolute path in the backend container and on the Docker host, and writable for the worker user |
| Worker cannot reach the question API | Docker network and `AIWS_CONTROL_AGENT_URL`; a host port bound to `127.0.0.1` is not reachable from a container |
| Compose refuses to start | `AIWS_CONTROL_TOKEN` and `AIWS_WORKSPACE_ROOT` are required |

## Where to look

| What | Where |
|---|---|
| Service errors with stack traces | `<data dir>/logs/errors.log` (default `~/.aiws/control/logs/errors.log`) |
| Run output and events | The task's **Chat** and **Agent Console** tabs, or `aiws control runs events <id>` |
| Prompt given to the agent | `<data dir>/runs/<runId>/input/prompt.md` |
| Plugin errors | **Settings → Plugins**, the plugin card; `aiws control plugins logs <id>` |
| CLI error stacks | Set `AIWS_DEBUG=1` |
| Runner mode | `aiws doctor`, `aiws status`, `aiws logs --follow` |

## Related pages

- [Installation](Installation)
- [Configuration](Configuration)
- [AI Providers](AI-Providers)
- [Docker Deployment](Docker-Deployment)
- [FAQ](FAQ)
