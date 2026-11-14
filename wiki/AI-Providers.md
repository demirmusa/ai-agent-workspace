AIWS does not contain a model. It starts the coding-agent CLIs already installed on your machine and manages their runs. This page lists the supported providers and the settings that control how they are launched.

## Supported providers

| Provider | Program | How a stream run is launched |
|---|---|---|
| Codex | `codex` | `codex exec --json`, with a workspace-write sandbox |
| Claude Code | `claude` | `claude --print --output-format stream-json --verbose`, accepting edits |
| OpenCode | `opencode` | `opencode run --format json`, instruction on stdin |
| Antigravity | `agy` | `agy --output-format stream-json --print` |
| GitHub Copilot | `copilot` | `copilot --output-format json -p` |
| Custom command | the task's own executable | A separate executable with an argument array |

In terminal (PTY) mode the provider's real interactive CLI is started instead. See [Core Concepts](Core-Concepts#stream-and-terminal-modes).

Some features depend on what a provider records locally. Session history, live external sessions and the subagent tree are read for Codex and Claude Code; file-based subagent discovery is not implemented for OpenCode.

## Prerequisites

In native mode, for each provider you want to use:

1. **The CLI is on `PATH`** of the account that starts the control service. Restart the service after installing a CLI so it picks up the new `PATH`.
2. **You are logged in** with the provider's own login command, in that same account. AIWS does not log you in. (The older `aiws login` command manages the Docker runtime of the [GitHub Actions Runner](GitHub-Actions-Runner), not the control center.)
3. **`aiws` is on `PATH`** so agents can call `aiws control ask` and `aiws control complete`. In a source install, `run.ps1` or `npm link` does this.

Provider processes can inherit the service's environment variables, and they run with permissions prepared for unattended execution. Use the backend account and its tokens only with tasks you trust. See [Security](Security).

To try the run pipeline without any provider account, use a custom command:

```powershell
aiws control tasks create project_ID "Local smoke" --provider command --executable node --args '["-e","console.log(process.env.AIWS_TASK_ID)"]'
```

## Default provider

**Settings → Default provider** stores one choice for all projects. A fresh install uses Codex.

It is used for new tasks, work imported from GitHub, new agents (including ones created from templates), automatic agent assignment, planning and AI task drafts. Tasks that have not started and have no explicit provider or agent follow the setting when it changes. An explicit provider on the task, or the provider of its assigned agent or workflow stage, takes precedence. Runs that have started and past sessions keep their provider.

```powershell
aiws control settings set --default-provider claude
```

## Provider CLI arguments

**Settings → Provider CLI arguments** stores extra arguments per provider.

- One argument per line. Empty lines are skipped; spaces and quotes inside a value are preserved. No shell is involved.
- An option and its value that are separate arguments go on two lines, for example `--config` and then `key="value with spaces"`.
- Clearing the field and saving removes that provider's extra arguments.
- Limits: 64 arguments per provider, 4096 characters per argument, 32768 in total.
- For options AIWS does not recognize, give the value as `--option=value`.

Precedence and limits:

- A model chosen on the task or agent wins over a model in the global arguments.
- The project folder, the original session ID and the output protocol are managed by AIWS; arguments that change them are rejected.
- Read-only planning and drafting never use arguments that widen permissions.
- Saving does not restart running processes. Provider processes started afterwards use the new settings.

On Windows, PowerShell 7.3 or newer is used for exact argument passing when available. With only Windows PowerShell 5, plain arguments such as `--yolo` work; values that cannot be passed without loss produce a clear error.

## Auto mode

Each built-in provider card has an **Auto mode** checkbox that starts the provider without asking for approvals:

| Provider | What Auto mode applies |
|---|---|
| Codex | `--yolo` |
| Claude Code | `--permission-mode auto` |
| Antigravity | `--mode auto --dangerously-skip-permissions` |
| GitHub Copilot | `--allow-all` |
| OpenCode | All permissions via `OPENCODE_PERMISSION` |

It applies to task runs and to agent CLIs opened in the project terminal. If your provider arguments contain an explicit permission option (`--sandbox`, `--permission-mode`, `--mode` and similar), that option is used instead. The read-only planning limit is not affected.

## Refresh models

Model pickers show a list per provider. The list is read only when you click **Refresh models** on the provider card, and is kept until the next refresh.

| Provider | Source |
|---|---|
| Codex | `~/.codex/models_cache.json` |
| Claude Code | `~/.claude/cache/model-catalog/*-cc.json`, or Anthropic `/v1/models` with `ANTHROPIC_API_KEY` |
| OpenCode | `opencode models` |
| Antigravity | `agy models` |
| GitHub Copilot | `copilot help config` |

A provider that was never refreshed shows a short suggested list. **Custom model…** always accepts any model ID.

## Multiple Claude Code accounts

**Settings → Providers → Claude Code · Accounts** lets you use several Claude accounts at the same time. Accounts are stored by [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`); AIWS installs it and runs its commands for you.

1. **Install claude-swap** runs `uv tool install claude-swap` (or `pipx install claude-swap`; uv is installed first if neither exists).
2. **Add account** opens a terminal where Claude Code starts in a separate, empty profile. Log in there with `/login`; AIWS then registers the account and closes the terminal. Your existing default login is not changed. **Add current login** registers the login Claude Code already has.
3. Pick the account per task in the **Account** field of the task form or task details. Leave it empty to use the default login.
4. In the project terminal's **+** menu each account appears as its own Claude Code entry.

Notes:

- Each run prepares the account's session profile (refreshing its login and carrying over settings, skills and MCP servers) and starts Claude Code in that profile. Variables that would override the login, such as `ANTHROPIC_API_KEY`, are not passed to these runs.
- Accounts are supported in native execution only.
- Conversation records of account sessions are written to the default Claude folder, so Sessions, live monitoring, token counts and resume work for them too.
- A terminal opened with an account and later converted to a task keeps that account.

## Usage and quota indicator

The status bar at the bottom right shows the remaining short-term and weekly quota percentages for your providers and the time until they reset. Click it for the account, data source, usage bars and reset dates; **Refresh** checks again.

- Data comes from the operating-system account running the control center: recent Codex rollout records under `CODEX_HOME` or `~/.codex`, and Claude's `usage-cache.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`.
- Local records are scanned every 10 seconds. When data is stale and you open the details, the existing CLI OAuth login is used for an API fallback, limited to one request per two minutes.
- Only quota data is cached, in `~/.aiws/token-usage-cache.json`. Credentials stay on the server side.
- Unknown quota is shown as `--`. On connection errors the last known data is kept.
- Each additional Claude account has its own card (`claude@<n>`), refreshed every two minutes.

The indicator shows subscription quota percentages, not absolute token counts. Per-run tokens and cost are on the cards and the [Dashboard](Board-and-Tasks#dashboard).

## When an agent runs out of tokens

If a running agent's provider reports a usage limit (for example "usage limit reached" or `insufficient_quota`), the Agent Console asks whether another agent should continue.

1. Choose the agent profile or provider that continues.
2. Choose the method:
   - **New clean agent** (default): the new agent gets the task prompt, the previous agent's last messages and a summary of `git status`, commits and the diff at handoff time. It is told to inspect the Git changes first and finish what is missing.
   - **Copy the whole session**: the previous agent's accessible conversation is transferred into the new agent's context.
   - **Compact and transfer history**: a smaller, cheaper summary model (for example `claude-haiku-5-5`, typed in the **Summary model** field; empty uses the provider's default model) first reads the whole conversation in pieces and writes a compact summary of the goal, decisions, completed work, open problems and next steps. The new agent (for example Opus) starts with that summary and the Git brief instead of the full conversation, so the expensive model does not reload old tokens.
3. Continue. The open process is stopped and the new agent starts on the **same task, worktree and branch**.

**Continue with another agent** in the task menu opens the same choice at any time. A past provider session that is not a task can be compacted the same way: in **Project → Sessions**, open the session's **Continue** menu and choose **Compact history and continue in a new session**, then pick the summary model and the agent that continues. The default method is set under **Project settings → Git and worktree → Handoff when an agent runs out of tokens**. When several agents have worked on a task, the Agent Console lists them; earlier ones open read-only.

## When the connection drops

In a terminal (PTY) run, if a provider turn ends with a connection error (for example a lost connection mid-response, a request timeout, `529 overloaded`) and the terminal stays silent for 10 seconds, AIWS checks whether the provider API is reachable.

- **Reachable:** it writes a message into the terminal asking the agent to check its work and continue where it stopped.
- **Not reachable:** the run and task become **waiting**, you get a notification, and the check repeats every 15 seconds. Work continues automatically when the connection returns.
- If 5 continue attempts within 10 minutes also end in a connection error, the run is closed as **failed**, so a task never looks as if it is running forever.

4xx request errors and usage-limit messages do not trigger this path.

## Related pages

- [Installation](Installation)
- [Core Concepts](Core-Concepts)
- [Agents, Skills and Workflows](Agents-Skills-and-Workflows)
- [Agent Console and Sessions](Agent-Console-and-Sessions)
- [Configuration](Configuration)
- [Security](Security)
- [Troubleshooting](Troubleshooting)
