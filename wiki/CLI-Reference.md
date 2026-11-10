The `aiws` command drives everything the desktop app can do: projects, tasks, runs, agents, schedules, plugins and settings. The same binary also contains the older GitHub Actions runner commands.

`aiws`, `ai-agent-workspace` and `mycli` are three names for the same program. A source install puts them on your `PATH` with `npm link` (the Windows `run.ps1` script does this for you).

```bash
aiws --help
aiws control --help
aiws control tasks create --help
```

Every command accepts `--help`; that output is the authoritative list of options for your version.

## Global options

| Option | Meaning |
|---|---|
| `-C, --cwd <path>` | Target repository directory (runner commands and project-scoped skill installs) |
| `-v, --verbose` | Show diagnostic details |
| `-V, --version` | Print the version |

Set `AIWS_DEBUG=1` to see full error stacks. Failed commands exit with a non-zero code.

## How `aiws control` finds the service

`aiws control` is an HTTP client for a running control service (the desktop app or `aiws control serve`).

1. `--url <url>` on the command line: `aiws control --url http://10.0.0.5:4317 projects list`
2. The `AIWS_CONTROL_URL` environment variable
3. The service running on this computer, including the desktop app (discovered automatically)
4. `http://127.0.0.1:4317`

If the service is protected by a token, set `AIWS_CONTROL_TOKEN`. Tokens are never accepted as command-line arguments, so they do not end up in shell history or process lists.

`aiws control --json <command>` prints machine-readable JSON. IDs such as `project_...`, `task_...` and `run_...` come from that output.

## Service

```bash
aiws control serve                       # API + web UI on http://127.0.0.1:4317
aiws control serve --host 127.0.0.1 --port 4317 --data-dir D:\AIWS\control-data
aiws control state                       # full local state
aiws control workspace                   # the general workspace (folder outside any repository)
```

## Projects

| Command | Purpose |
|---|---|
| `projects list` / `show <id>` | List or read projects |
| `projects create <name> --path <dir>` | Register an existing folder (`--description`, `--default-branch`) |
| `projects update <id>` | `--name`, `--path`, `--default-branch`, `--auto-merge`, `--use-worktree`, `--main-branch`, `--max-concurrent` |
| `projects delete <id>` | Remove the project record |
| `projects branches <id>` | List local Git branches |
| `projects detect <path>` | Discover the GitHub repository and Projects boards from the Git remote |
| `projects connect <id>` / `disconnect <id>` / `sync <id>` | GitHub Projects connection and manual sync |
| `projects draft <id> <message>` | Prepare an editable task draft with a read-only AI; creates nothing |
| `projects plan <id> <message>` | Planning conversation that creates validated tasks |
| `projects organize <id> [--cancel]` | Let an AI order the backlog, record dependencies and move actionable tasks to Ready |
| `projects sessions <id>` / `session <projectId> <sessionId>` | Read existing Codex and Claude sessions of the project folder |
| `projects resume <projectId> <sessionId>` | Explicitly continue an original provider session |

```bash
aiws control projects create "My web app" --path D:\GitHub\my-app
aiws control projects update project_ID --use-worktree true --main-branch main
aiws control projects connect project_ID --number 12
aiws control projects connect project_ID --create-repository --repository-name my-app
```

See [GitHub Integration](GitHub-Integration) for the connection options (`--repository`, `--owner`, `--owner-type`, `--status-field`, `--statuses`, `--create-project`, `--project-title`, `--public`).

## Tasks

| Command | Purpose |
|---|---|
| `tasks list` / `show <id>` | `list` filters with `--project`, `--status`, `--milestone` |
| `tasks create <projectId> <title>` | Create a task (options below) |
| `tasks update <id>` | Change any field, including `--status` |
| `tasks delete <id>` | Delete the local task |
| `tasks run <id>` | Start an agent run now |
| `tasks search <query> --project <id>` | Server-side search for Blocked-by references |
| `tasks message <id> <text>` / `messages <id>` | Task conversation |

Common `tasks create` / `tasks update` options:

| Option | Meaning |
|---|---|
| `--description <text>` | Task instructions |
| `--provider <id>` | `codex`, `claude`, `opencode`, `agy`, `copilot` or `command` |
| `--agent <id>` | Agent profile; its provider and model are inherited |
| `--model <model>`, `--account <id>` | Model override; Claude Code account (claude-swap number) |
| `--skills <ids>` | Extra comma-separated skill IDs |
| `--status <status>` | Initial status, default `backlog`; `ready` queues it |
| `--priority <n>` | High=3, Medium=2, Low=1 |
| `--depends-on <ids>`, `--blocked-by <refs>` | Prerequisite task IDs; local IDs or linked `#issue` numbers |
| `--workflow <id>`, `--requested-actions <names>` | Workflow and semantic follow-ups such as `deploy` |
| `--tags <tags>`, `--milestone <id\|none>` | Labels and milestone |
| `--terminal <stream\|pty>` | Output mode |
| `--base-branch <branch>` | Source branch for the task |
| `--auto-merge <true\|false\|inherit>`, `--pull-request <n>`, `--head-sha <sha>` | Delivery |
| `--scheduled-at <time>` | A Ready task starts at this time (ISO 8601, local time without offset) |
| `--usage-trigger <spec>` | Start when a quota window is about to reset: `provider:short\|weekly:minutes` |
| `--executable <file>`, `--args <json>` | Custom command provider |

```bash
aiws control tasks create project_ID "Fix empty search results" --provider claude --status ready --description "Reproduce, fix, and add a regression test."
aiws control tasks create project_ID "Main change" --depends-on task_FIRST --status ready
aiws control tasks update task_ID --status done
```

## Runs

| Command | Purpose |
|---|---|
| `runs list` / `show <id>` / `events <id>` | Inspect runs (`list --task <id> --status running`) |
| `runs pause <id>` / `resume <id>` / `stop <id>` | Process control |
| `runs send <id> <message>` | Queue a follow-up instruction |
| `runs attach <id>` | Attach to the real PTY; `Ctrl+]` detaches without stopping the agent |
| `runs terminal <id>` / `input <id> <data>` / `resize <id> <cols> <rows>` | Raw terminal access |
| `runs complete <id>` | Complete a run explicitly |

## Commands agents call

Each run receives `AIWS_RUN_ID`, `AIWS_TASK_ID`, `AIWS_CONTROL_URL` and, if needed, `AIWS_CONTROL_TOKEN`, so these work without arguments inside a run.

```bash
aiws control ask "Should the API response stay backward compatible?"
aiws control ask "Do you approve this migration?" --approval
aiws control ask "Which version?" --run run_ID --timeout 3600
aiws control ask "Waiting for approval" --run run_ID --no-wait
aiws control reply "Apple Pay is now available at checkout."
aiws control complete --summary "Change and test summary"
aiws control complete --failed --summary "Could not finish"
aiws control session                       # record the provider session on the task
aiws control questions list
aiws control questions answer question_ID "Version 2; keep v1 clients working."
```

`ask` waits up to 86400 seconds by default. `reply` (or `complete --reply`) leaves the final answer; a linked GitHub issue receives it as a comment.

## Agents, skills and workflows

```bash
aiws control skills create "Code review" --file D:\Skills\review\SKILL.md
aiws control skills import D:\Skills\review          # folder on the backend host
aiws control agents create "Backend developer" --provider codex --instructions "Follow the repo rules." --skills skill_ID
aiws control agents update agent_ID --instructions-file notes.txt --context-file context.txt
aiws control agents directory                        # colleagues, capabilities, availability
aiws control workflows create "Build and deploy" --project project_ID --trigger always --steps-file steps.json
```

`agents`, `skills` and `workflows` each support `list`, `show`, `create`, `update` and `delete`. Details: [Agents, Skills and Workflows](Agents-Skills-and-Workflows).

## Schedules and milestones

```bash
aiws control schedules create project_ID "Dependency report" --daily 09:00 --weekdays mon-fri --timezone Europe/Istanbul
aiws control schedules create general "Weekly summary" --cron "0 8 * * 1"
aiws control schedules preview --daily 09:00,18:00 --weekdays sat,sun --count 5
aiws control schedules list --project general
aiws control schedules run schedule_ID          # also: show, update, enable, disable, delete

aiws control milestones create project_ID "v1.0" --due 2026-12-31 --current
aiws control milestones assign project_ID milestone_ID task_A,task_B
aiws control milestones current project_ID none  # also: list, show, update, delete
```

Details: [Schedules and General Workspace](Schedules-and-General-Workspace).

## Settings, GitHub and plugins

```bash
aiws control settings show
aiws control settings set --max-concurrent 3 --default-provider claude
aiws control settings set --task-merge-mode pull-request   # or branch
aiws control settings set --execution-mode docker --docker-image aiws-control-worker:local
aiws control settings set --auto-sync-seconds 60 --github-trigger /ai

aiws control github status       # account and missing repo/project scopes
aiws control github authorize    # open gh login with repo and project scopes

aiws control plugins install examples/plugins/aiws-example-plugin   # folder or .zip; --link for development
aiws control plugins list        # also: show, enable, disable, settings, logs, remove, pack, skill
```

See [Configuration](Configuration) and [Plugins and Themes](Plugins-and-Themes).

## Agent skills for Codex and Claude Code

`aiws agent-skills` installs the bundled skills that teach your own Codex or Claude Code sessions to operate AIWS.

```bash
aiws agent-skills install                                  # aiws-project-manager, both assistants, user scope
aiws agent-skills install --skill aiws-plugin-development
aiws agent-skills install --provider claude --dry-run
aiws -C <repo> agent-skills install --scope project
aiws agent-skills status
```

Modified files are kept unless you pass `--force`. Afterwards use `$aiws-project-manager` in Codex or `/aiws-project-manager` in Claude Code.

## Runner commands

These belong to the separate self-hosted runner mode described in [GitHub Actions Runner](GitHub-Actions-Runner).

| Command | Purpose |
|---|---|
| `init`, `sync` | Generate or update the repository integration through a pull request |
| `up`, `down` | Start or stop the Docker runner stack |
| `status`, `logs`, `doctor` | Inspect state, logs and prerequisites |
| `login [provider]` | Authenticate GitHub, Claude, Codex or OpenCode for the runner |
| `config`, `configure`, `menu` | Read and edit repository settings |
| `models [provider]`, `review`, `queue`, `project-setup`, `target` | Models, PR review, queue, Projects states, Docker host |
| `remove` (`uninstall`) | Remove only resources owned by this installation |

## Related pages

- [Quick Start](Quick-Start)
- [HTTP API](HTTP-API)
- [Configuration](Configuration)
- [GitHub Actions Runner](GitHub-Actions-Runner)
- [Troubleshooting](Troubleshooting)
