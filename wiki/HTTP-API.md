The control service exposes one JSON-over-HTTP API. The desktop app, the browser UI and the `aiws control` CLI are all clients of it, and third-party tools can use the same endpoints.

```text
Electron or browser / aiws control CLI
                 │  HTTP JSON + SSE (+ WebSocket for voice)
                 ▼
     ControlServer → ControlService → ControlStore
                         │               └─ control.db (SQLite) + settings.json
                         ├─ native process / Docker worker
                         └─ GitHub REST + Projects GraphQL
```

The default address is `http://127.0.0.1:4317` for `aiws control serve`. The desktop app starts its own service on a free loopback port; `aiws control` discovers it automatically.

## Authentication and request rules

| Rule | Detail |
|---|---|
| Token | When `AIWS_CONTROL_TOKEN` is set, every `/api/*` request except `/api/health` needs `Authorization: Bearer <token>` |
| Non-loopback bind | Listening on anything other than `127.0.0.1`, `localhost` or `::1` requires a token; the server refuses to start without one |
| Query token | `?token=` is accepted only on `/api/events` and `/api/voice`. Do not log or share those URLs |
| Host check | On loopback, the `Host` header must be a loopback name, the listen address or listed in `AIWS_CONTROL_ALLOWED_HOSTS` (403 otherwise) |
| Origin check | `Origin`, when present, must match the host; `Sec-Fetch-Site` must be `same-origin` or `none` |
| Body | Writes need `Content-Type: application/json` (415 otherwise); the body limit is 2 MiB (413 beyond it) |
| Errors | `{ "error": "..." }` with the matching status code; JSON responses carry `Cache-Control: no-store` |

The token grants local file and command execution on the service host. There are no per-user roles or per-task tokens. See [Security](Security).

```bash
curl http://127.0.0.1:4317/api/health

curl -H "Authorization: Bearer $AIWS_CONTROL_TOKEN" http://127.0.0.1:4317/api/projects

curl -X POST http://127.0.0.1:4317/api/tasks \
  -H "Authorization: Bearer $AIWS_CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"project_ID","title":"Fix the login redirect","description":"Add a regression test.","status":"ready"}'

curl -X POST http://127.0.0.1:4317/api/questions/question_ID/answer \
  -H "Content-Type: application/json" -d '{"answer":"Keep v1 clients working."}'
```

## Live updates (SSE)

`GET /api/events` is a Server-Sent Events stream. On connect it sends the full state, then patches.

| `type` | Content |
|---|---|
| `state` | First message: full state. Later messages: a `patch` with changed values and per-collection `upsert`, `remove` and `order` |
| `update` | Batched run output, events and messages |
| `terminal` | `{ runId, offset, data }` PTY output |
| `shells` | `{ projectId }`: the project terminal list changed |
| `draft`, `organize` | Progress of AI drafting and the backlog organizer |
| `plugins` | `{ id }`: a plugin was installed, updated or removed |

A keepalive comment is sent every 15 seconds. A client that falls more than 4 MB behind is dropped and receives the full state again when it reconnects.

## System

| Path | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Unauthenticated health check |
| `/api/state` | GET | Full state; `?journal=0` leaves out the event log |
| `/api/events` | GET | SSE stream |
| `/api/settings` | GET, PATCH | Global settings |
| `/api/providers`, `/api/providers/detect` | GET | Registered providers and installed CLIs |
| `/api/providers/:id/models/refresh` | POST | Refresh and store the provider's model list |
| `/api/providers/:id/accounts` | GET | Provider accounts (Claude Code: claude-swap) |
| `/api/token-usage` | GET | Quota usage; `?refresh=1` forces a scan |
| `/api/attachments`, `/api/attachments/:id` | POST / GET | Upload (base64 JSON) and download files |
| `/api/directories` | GET | Folder browser under the allowed roots |
| `/api/repository/detect`, `/api/repository/branches` | POST | Git remote and GitHub Projects discovery; local branches |
| `/api/github/auth`, `/api/github/authorize` | GET / POST | GitHub account state; start authorization |
| `/api/workspace` | GET | The general workspace (`project_general`) |
| `/api/agent-templates` | GET | Bundled community agent templates |
| `/api/live-sessions[/:sessionId]` | GET | Provider sessions opened outside the app, read-only |
| `/api/questions/:id`, `/api/questions/:id/answer` | GET / POST | Question record; answer with `{ "answer": "..." }` |

## Library

`agents`, `skills`, `workflows` and `schedules` share the same shape: `GET` (list), `POST` (create), `GET`/`PATCH`/`DELETE` on `/:id`.

| Path | Method | Purpose |
|---|---|---|
| `/api/agents[/:id]` | CRUD | Agent profiles |
| `/api/skills[/:id]`, `/api/skills/import` | CRUD, POST | Skill packages; import a folder on the backend |
| `/api/workflows[/:id]` | CRUD | Ordered named-agent workflows |
| `/api/schedules[/:id]` | CRUD | Schedules; list takes `?projectId=` |
| `/api/schedules/preview` | POST | Next run times without saving (`?count=`) |
| `/api/schedules/:id/run` | POST | Create the schedule's task now |
| `/api/skill-discovery` | GET | Scan skills on disk |

## Projects

| Path | Method | Purpose |
|---|---|---|
| `/api/projects`, `/api/projects/:id` | GET, POST / GET, PATCH, DELETE | Projects |
| `/api/projects/:id/connect`, `/sync` | POST | Connect to a GitHub Projects board; sync |
| `/api/projects/:id/issues/download` | POST | Download repository issues that have no task yet |
| `/api/projects/:id/labels`, `/labels/import`, `/labels/export` | PUT / POST | Project labels and GitHub label sync |
| `/api/projects/:id/milestones[/:milestoneId]`, `/milestones/current`, `/milestones/assign` | POST, PATCH, DELETE / PUT / POST | Milestones |
| `/api/projects/:id/draft`, `/plan`, `/organize` | POST | AI draft (creates nothing), planner, backlog organizer |
| `/api/projects/:id/git` | GET | Git panel: current branch, upstream state, branches, worktrees |
| `/api/projects/:id/git/fetch`, `/pull`, `/push`, `/commit`, `/merge` | POST | Git actions |
| `/api/projects/:id/files`, `/files/search`, `/files/content`, `/files/open` | GET / GET, PUT / POST | File tree, search, editor read/save, open in the OS |
| `/api/projects/:id/terminals[/:terminalId]` | GET, POST, PATCH, DELETE | Project terminals, plus `/input`, `/resize`, `/restart` |
| `/api/projects/:id/sessions[/:sessionId]` | GET | Provider session history of the project folder |
| `/api/projects/:id/sessions/:sessionId/resume`, `/import` | POST | Continue the original session; convert it to a task |
| `/api/projects/:id/sessions/:sessionId/compact` | POST | Compact the session with `summaryModel` (and optional `summaryProvider`) and continue in a new task with `provider`, `model`, `message`, `terminalMode` |

## Tasks

| Path | Method | Purpose |
|---|---|---|
| `/api/tasks` | GET, POST | List (`?projectId=`) and create |
| `/api/tasks/:id` | GET, PATCH, DELETE | Task |
| `/api/tasks/search` | GET | Blocked-by search (`projectId`, `q`) |
| `/api/tasks/archive` | POST | `{ "taskIds": [...], "archived": true }` |
| `/api/tasks/reorder` | POST | Ready column order: `{ "projectId": "...", "taskIds": [...] }` |
| `/api/tasks/:id/run`, `/restart`, `/fork` | POST | Start a run, restart, fork |
| `/api/tasks/:id/messages` | GET, POST | Task conversation; `continueSession: true` continues the verified session |
| `/api/tasks/:id/handoff`, `/transfer-session` | POST | Hand the work to another agent; move the history to another provider |
| `/api/tasks/:id/changes`, `/history` | GET | File changes; provider session history |

## Runs

| Path | Method | Purpose |
|---|---|---|
| `/api/runs/:id`, `/events`, `/prompt`, `/context` | GET | Run record, events, the prompt given to the agent, context window usage |
| `/api/runs/:id/agents[/:agentId/transcript]` | GET | Subagent tree and transcripts |
| `/api/runs/:id/terminal`, `/input`, `/resize` | GET / POST | Real PTY screen, raw input, size |
| `/api/runs/:id/pause`, `/resume`, `/stop`, `/interrupt` | POST | Process control |
| `/api/runs/:id/command` | POST | Follow-up instruction `{ "message": "..." }` |
| `/api/runs/:id/questions` | POST | Agent question `{ "text": "..." }` |
| `/api/runs/:id/complete`, `/reply`, `/session` | POST | Explicit completion, final answer, provider session ID |

## Plugins

| Path | Method | Purpose |
|---|---|---|
| `/api/plugins` | GET, POST | List; install from a folder or ZIP |
| `/api/plugins/:id` | GET, PATCH, DELETE | Info, `enabled`/`settings`, uninstall |
| `/api/plugins/:id/logs`, `/storage[/:key]` | GET / GET, PUT, DELETE | Server log and plugin storage |
| `/api/plugins/:id/routes/...` | any | Routes registered by the plugin's `server.js` |

Plugin routes never receive the `Authorization` or `Cookie` headers. See [Plugins and Themes](Plugins-and-Themes).


## Related pages

- [CLI Reference](CLI-Reference)
- [Configuration](Configuration)
- [Security](Security)
- [Docker Deployment](Docker-Deployment)
- [Development](Development)
