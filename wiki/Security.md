AI Agent Workspace runs coding agents with real access to your files, your shell and your provider accounts. This page explains what is trusted, what the built-in protections cover and which risks remain yours to manage.

## Trust boundaries

| Boundary | Trusted | Not trusted |
|---|---|---|
| Control service | The operator holding the token, the service process, server code of installed plugins | Other websites (through your browser), agent output, task and issue content, provider transcripts |
| Agent run | The provider CLI you selected | Repository content, prompt injection |
| Desktop app | The main process and the origin of its own service | Other origins, subframes, webviews |
| Actions runner | The scripts shipped in `/opt/aiws/bin`, workflows on the default branch | Issue and PR comments, fork PRs, the agent container |

## Control center

The service listens on `127.0.0.1` by default. The desktop app starts its own service on a free loopback port.

| Threat | Control |
|---|---|
| Remote access without authorization | Listening on a non-loopback address requires `AIWS_CONTROL_TOKEN`; the server will not start without it. Tokens are compared in constant time |
| DNS rebinding | On loopback the `Host` header must be a known name or listed in `AIWS_CONTROL_ALLOWED_HOSTS` |
| Cross-site requests | `Origin` must match the host; `Sec-Fetch-Site` must be `same-origin` or `none`, for reads too |
| Token leaking through URLs or logs | The token travels in the `Authorization` header (`?token=` only for `/api/events` and `/api/voice`). The UI keeps it in the tab's `sessionStorage`. Control and GitHub tokens and provider credentials are redacted in events, task messages and GitHub comments |
| Framing and foreign scripts | `X-Frame-Options: DENY` and a strict Content Security Policy (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`) |
| Memory exhaustion | 2 MiB JSON bodies, upload cap, early `Content-Length` rejection, slow SSE clients are dropped |
| Path traversal | Static files, plugin files and project files are checked against their root; `..` and escaping symlinks are rejected |
| Data files read by other users | Data directory `0700`; `control.db`, `settings.json` and the lock `0600` |
| Renderer gaining privileges (Electron) | `sandbox`, `contextIsolation`, no Node integration, navigation limited to the service origin, IPC only from the main frame |

### What the token grants

The control token is equivalent to local file access and command execution on the service host: whoever holds it can create tasks, open terminals, read and write project files and start agents. There are no operator accounts, roles, per-task tokens or approval policies. In Docker mode the same API token is passed to workers so they can ask questions.

For remote access, keep the service on loopback and use an SSH port forward or a TLS reverse proxy. Never put the token in a URL you share or log.

## Provider credentials and prompt injection

Native agents run as the account that started the service. They can read the repository, use the provider login of that account and inherit the service's environment variables. Repository files, issue text and web pages an agent reads may contain instructions that try to make it read, change or exfiltrate credentials. AIWS cannot prevent that.

- Use the app with repositories and tasks you trust.
- Start the service from an environment that holds only the credentials agents need.
- **Auto mode** (per provider, in Settings) starts agents without permission prompts. Turn it on deliberately.
- Planning and AI drafting run in a read-only provider mode and do not receive the control API credentials.
- Agents see only identity metadata about each other (name, provider, description, capabilities), never another agent's instructions, context, skills or credentials.
- Skills are text and files handed to the agent. Scripts inside a skill are not executed at import time, but an agent may run them. Install only skills you trust and never put secrets in them.

## Work triggered from GitHub

With a connected repository, issues and comments can start agents on your computer.

- Only the repository owner, organization members and collaborators (`author_association` OWNER, MEMBER or COLLABORATOR) can create work, answer questions or trigger the AI. Other comments are ignored and logged.
- AIWS marks its own comments, so they are never read as requests.
- Issues and comments that existed before the connection are not processed.
- The GitHub token stays in the backend environment; it is never entered in the UI. Resolution order: service option, `AIWS_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`.
- Auto-merge never bypasses branch protection, required checks or reviews.

See [GitHub Integration](GitHub-Integration).

## Plugins

| Threat | Control |
|---|---|
| Malicious archive | ZIP64, encrypted entries, symlinks, unsupported compression and oversized contents are rejected; Windows reserved names and `..` are refused |
| Plugin reading the control token | Plugin routes do not receive `Authorization`, `Cookie` or `Proxy-Authorization` headers |
| Plugin weakening security headers | Security, `Set-Cookie` and CORS headers returned by a plugin route are dropped |
| Browser code calling external services | CSP `connect-src 'self'`; external calls must go through the plugin's `server.js` |

**Accepted risk:** plugin server code runs inside the control service process with all of its privileges (file system, network, starting processes). Install only plugins you trust. Plugins with server code are marked on their card. `password` settings of plugins are stored as plain text in `plugins.json`.

## Docker

- In Docker mode the control service has access to the Docker socket, which is high privilege on the host.
- Workers do not mount the socket. They start with `--cap-drop=ALL`, `no-new-privileges` and CPU, memory and PID limits.
- Compose publishes the HTTP port on the host's `127.0.0.1` only and refuses to start without a token and a workspace root.

See [Docker Deployment](Docker-Deployment).

## GitHub Actions runner

The runner mode separates two privilege levels: the trusted runner runtime, which sees the Docker socket and manages Git and GitHub, and ephemeral agent or hook containers, which see only the repository workspace.

| Threat | Control |
|---|---|
| Outsider triggers the runner with a comment | Actor allowlist; public repositories rejected by default |
| Shell injection through a comment | Text is never interpolated into a shell; it is read from the event JSON file |
| PR modifies the orchestration scripts | Repository scripts are not executed; the runtime is immutable |
| Agent steals the GitHub token | The token is not passed to the agent container; Git credentials are not persisted |
| Agent controls the Docker host | No Docker socket in the agent container |
| Access to another provider's credentials | Only the selected provider's auth volume is mounted |
| Resource exhaustion | CPU, memory, PID and workflow timeouts |
| Runtime and workflow drift | Fail-closed version check |
| Agent writes directly to the default branch | PR runs are refused when the head branch is the default branch; no force pushes |

Use separate tokens for runner registration, repository automation and Projects. Details: [GitHub Actions Runner](GitHub-Actions-Runner).

## Remaining risks

- A runner with the Docker socket is equivalent to root on its host. A malicious workflow merged by a human becomes trusted on the next run.
- Agents need outbound network access to reach their provider. Egress is not filtered by default, so credential exfiltration through prompt injection remains possible.
- The selected provider's credentials are readable and writable by the agent.
- Build, install and test hooks execute arbitrary project code; container isolation does not replace host or VM isolation.
- The control token is not scoped per task.
- The file API can open any file inside a project with the operating system's default application, and read or save existing text files there.
- On Windows, POSIX file modes are best effort. Protect `~/.aiws` with NTFS permissions, disk encryption and a separate account where it matters.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on the repository (**Security → Report a vulnerability**) if it is enabled, or contact the maintainer directly.

## Related pages

- [Configuration](Configuration)
- [HTTP API](HTTP-API)
- [GitHub Integration](GitHub-Integration)
- [Plugins and Themes](Plugins-and-Themes)
- [GitHub Actions Runner](GitHub-Actions-Runner)
