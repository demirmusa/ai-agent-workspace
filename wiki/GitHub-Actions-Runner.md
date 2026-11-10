AI Agent Workspace has a second, older mode that is independent of the desktop control center: a self-hosted GitHub Actions pipeline that runs Claude Code, Codex and OpenCode in isolated Docker containers and turns issues into pull requests.

Most people only need the control center ([Quick Start](Quick-Start)). Use this mode when you want work to be triggered and executed entirely through GitHub Actions on a dedicated Docker host.

```text
GitHub issue / Projects v2 / PR comment
                  │
                  ▼
        thin, trusted workflow
                  │
                  ▼
   repository-specific runner in Docker
                  │
                  ▼
 parallel, ephemeral agent containers
                  │
                  ▼
        branch + commit + PR
```

> [!CAUTION]
> The self-hosted runner has access to the Docker socket, which in practice means high privileges on the runner host. Use it only with private repositories that trusted people can write to, preferably on a dedicated machine or VM. Public repositories are rejected by default.

## Prerequisites

- Node.js and the `aiws` CLI ([Installation](Installation))
- Git
- GitHub CLI (`gh`) with a valid session
- Docker Engine and Docker Compose v2 on the host that runs the runner
- For an SSH target: local `ssh` and `scp`
- A trusted, preferably private GitHub repository (GitHub.com; GitHub Enterprise Server is not supported)

### Tokens

| Purpose | Variable | Minimum permission |
|---|---|---|
| CLI bootstrap / init PR | `AIWS_GITHUB_TOKEN` or `gh auth token` | Contents, Workflows, Issues, Pull requests |
| Runner registration | `AIWS_RUNNER_TOKEN` | Repository Administration: write |
| Agent branch/PR operations | `AIWS_AUTOMATION_TOKEN` | Contents, Issues, Pull requests: write |
| Projects v2 | `AIWS_PROJECT_TOKEN` | Projects read/write and repository access |

If these are not set, the CLI can fall back to the current `gh auth token`; `aiws login github` requests the needed scopes. For production, split runner management, repository automation and Projects access into separate fine-grained tokens or GitHub App identities. Tokens are never accepted as command-line arguments.

## Quick start

```bash
cd /path/to/my-project
aiws login github
aiws init
```

`aiws init`:

1. Finds `owner/repo` and the default branch from `origin`.
2. Generates `.aiworkspace/config.json` and thin `.github/workflows/aiws-*.yml` files.
3. Uses a temporary Git worktree, so your working tree is untouched.
4. Pushes an `aiws/init-*` branch and opens a setup pull request.
5. Creates only the missing AIWS labels.
6. Stores machine-specific information outside the repository, under `~/.aiws/`.

Review and merge the setup PR, then:

```bash
git pull
aiws login all
aiws up
aiws status
```

`up` builds the images and starts the runner (and the optional Projects poller) on the local Docker host, or on a remote host over SSH if you chose `--target ssh`.

## Giving work to agents

1. Open an issue.
2. Optionally add a profile label such as `agent:claude` or `agent:codex`. A profile label only selects the provider; it does not queue the work.
3. Add the `agent:go` label, or comment `/agent` on the issue. Text after the command is the task instruction: `/agent Add the regression test first`.
4. Watch the Actions run and the PR the agent opens.

On a pull request, continue the conversation with:

```text
/aiws Handle the null case in this function too.
```

If the message is a question, the agent answers without changing files. If it produces changes, the trusted runtime commits and pushes to the same PR branch. `/test` runs the configured test hook.

Only actors on the allowlist (`security.allowedActors`) can schedule work.

## Commands

| Command | Behavior |
|---|---|
| `aiws init` | Generates the integration and opens a PR; does not start the runner |
| `aiws sync` | Opens an update PR with the current CLI templates |
| `aiws up` | Builds images and starts the runner/poller stack |
| `aiws down` | Stops containers and removes the runner registration; keeps volumes |
| `aiws login [claude\|codex\|opencode\|github\|all]` | Authenticates the selected provider inside the agent image |
| `aiws status` | Containers, GitHub runner, auth and recent workflow runs |
| `aiws logs [--follow]` | Runner and poller logs |
| `aiws doctor` | Checks Git, GitHub, Docker, config and runtime |
| `aiws menu` / `aiws configure` | Interactive control menu and settings editor |
| `aiws config show/get/set/import/validate` | Read and validate repository settings from the terminal |
| `aiws target` | Local or SSH Docker host; `--show` prints it |
| `aiws models opencode` | Current provider/model list |
| `aiws review enable/disable/profile/profiles/run` | PR review and reviewer models |
| `aiws queue status/add/organize/retry/block/unblock` | Queue and dependencies |
| `aiws project-setup` | Adds missing Projects states, organizations included |
| `aiws remove` | Removes only what this installation owns; `uninstall` is an alias |

```bash
aiws init --no-pr                 # write files into the working tree instead of a PR
aiws init --dry-run               # show the plan, change nothing
aiws init --target ssh --ssh-host runner.example --ssh-user runner
aiws init --queue both --project-owner my-user --project-number 12
```

## Config model

`.aiworkspace/config.json` is tracked with the repository and is machine independent. A shortened example:

```json
{
  "schemaVersion": 1,
  "repository": { "slug": "owner/repo", "defaultBranch": "main" },
  "security": {
    "allowedActors": ["owner"],
    "allowPublicRepository": false,
    "protectedPaths": [".github/workflows/**", ".aiworkspace/**"]
  },
  "agents": {
    "defaultProfile": "claude",
    "profiles": [
      { "id": "claude", "provider": "claude", "model": null, "effort": "high", "triggerLabel": "agent:claude" },
      { "id": "codex", "provider": "codex", "model": null, "effort": "high", "triggerLabel": "agent:codex" }
    ]
  },
  "queue": {
    "mode": "label",
    "labels": { "ready": "agent:go", "running": "agent:running", "done": "agent:done", "failed": "agent:failed" },
    "pollSeconds": 60
  },
  "commands": { "issue": "/agent", "pr": "/aiws", "test": "/test" },
  "agent": {
    "resources": { "cpus": 2, "memory": "4g", "pids": 512 },
    "timeouts": { "issueMinutes": 90, "prMinutes": 90, "hookMinutes": 30 }
  }
}
```

Machine-specific data (target, SSH host, Docker resource names, created labels and secrets) lives in `~/.aiws/repositories/<repo-hash>/installation.json`. Token values are stored in separate credential files and never written to the repository.

After changing the config:

```bash
aiws config validate
aiws sync        # merge the PR, git pull
aiws up
```

The workflows and the trusted runtime expect the same version; on a mismatch the workflow fails closed.

Supported `effort` values are `low`, `medium`, `high`, `xhigh`, `max` for Claude and `minimal`, `low`, `medium`, `high`, `xhigh` for Codex.

## Projects v2 queue

GitHub Actions has no workflow event for a Projects card moving to `Ready`. A small poller container queries GraphQL without opening any inbound port and calls `workflow_dispatch` when it finds work.

```bash
aiws init --queue both --project-owner owner --project-owner-type user --project-number 12
```

The GitHub actor of that dispatch is the owner of the project token; that login (or bot login for a GitHub App) must be in `security.allowedActors`.

## Test and custom hooks

Project-specific build, test and deploy logic is defined as Docker hooks in the config. Hooks run in a temporary container without agent credentials, tokens or the Docker socket.

```json
{
  "hooks": {
    "test": { "run": "npm ci && npm test", "image": "node:22-bookworm", "timeoutMinutes": 30, "network": "bridge" },
    "custom": []
  }
}
```

Run `aiws sync`, merge, then comment `/test` on a PR. Hook commands match exactly; comment text is never interpolated into a shell.

## Parallel work and dependencies

```bash
aiws config set orchestration.maxConcurrent 10
aiws queue add 9
aiws queue block 9 10      # 9 waits for 10
aiws queue status
aiws queue retry 9
```

Each slot has its own runner, Git checkout and agent container (default 6 runners, at most 50). A dependent issue waits until the prerequisite PR is merged and its issue closed, then starts from the updated default branch. The optional AI organizer (`aiws queue organize`) proposes an order and dependencies; the trusted runtime rejects unknown references, cycles and changes to running work.

## PR review

```bash
aiws review enable
aiws review profiles claude codex
aiws sync
aiws review run 42
```

Reviews are read-only: the provider gets a trusted base checkout and the diff as data, never a GitHub token. The result is posted as a review comment bound to the reviewed commit; it does not approve or merge. Draft and fork PRs are not reviewed automatically.

## `down` and `remove`

| | `aiws down` | `aiws remove` |
|---|---|---|
| Containers and runner registration | Stopped and removed | Stopped and removed |
| Workspace and provider auth volumes | Kept | Kept unless `--purge-work` / `--purge-auth` |
| Tracked integration files | Kept | Removed through a removal PR |
| Labels and secrets | Kept | Only those the CLI created are deleted |

```bash
aiws remove --dry-run
aiws remove --yes --purge-work --purge-auth
```

## Limitations

- GitHub.com only.
- Public repositories are blocked unless you explicitly accept the risk (`--allow-public`, not recommended).
- Projects uses outbound polling, not webhooks.
- Rootless Docker and VM-per-job isolation are not implemented.
- Issues owned by the control center (marked `<!-- aiws-task:... -->`) are skipped, so the same task never runs in both modes.

## Related pages

- [Security](Security)
- [CLI Reference](CLI-Reference)
- [GitHub Integration](GitHub-Integration)
- [Docker Deployment](Docker-Deployment)
- [Troubleshooting](Troubleshooting)
