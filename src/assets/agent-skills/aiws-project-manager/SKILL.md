---
name: aiws-project-manager
description: Manage projects, tasks, schedules, agents, workflows and runs in AI Agent Workspace through the aiws CLI. Use for requests to organize or operate AIWS projects across repositories, inspect progress, or configure their agents and skills.
---

Use the installed `aiws` CLI as the interface to the existing AI Agent Workspace server.
Read [commands](references/commands.md) for operational examples and command groups.
Use `aiws control <group> --help` and its subcommand help to check supported options.

This skill is maintained by AIWS from its packaged `assets/agent-skills/aiws-project-manager` directory. Each control service startup (including the desktop app's backend) refreshes the user copies for Codex and Claude Code. Make lasting changes in that packaged source, not in the installed copy.

## Connect and identify the target

- Run `aiws --version` and `aiws control projects list`. Commands return JSON and errors exit nonzero.
- Respect `AIWS_CONTROL_URL` and `AIWS_CONTROL_TOKEN` inherited from the environment. Without a URL the CLI finds the service running on this computer, including the desktop app's. A different server can be selected using `aiws control --url <url> ...`. Do not print tokens or embed them in commands, skills or project files.
- If the CLI is missing, use the repository's built `node /absolute/path/to/src/dist/cli/index.js` entrypoint, or follow its npm installation instructions. Do not fetch an unverified package or launch a second server to resolve a connection error.
- Select actual project IDs from the list, then inspect `projects show <id>` and `tasks list --project <id>`. Never infer IDs, agents, workflow names or credentials. Ask for the intended project if the request matches several.
- For "this project", match the current repository's absolute path against the listed projects' `repositoryPath`. Check existing tasks before creating one to avoid duplicates after an interrupted request.
- The same server manages all registered projects regardless of the shell's current directory. `aiws -C <path>` applies to repository commands and project-scoped skill installation; it does not select a Control project.
- Repository paths for remote servers refer to the backend host. Project create/update resolves `--path` on the CLI host; supply an absolute path meaningful on both hosts or run the CLI on the backend.

## Perform the requested work

Operate only on projects and resources covered by the user's request. Read the current resource before editing it; send only intended changes. Discover configured agents and workflows before assigning them. Creating an agent or workflow is appropriate only when requested or required by the task.

Create tasks in `backlog` unless immediate execution is requested. For work at a later time use `--status ready --scheduled-at <time>`; for recurring work create a schedule (`schedules create`) instead of many tasks. Work outside any repository belongs to the general workspace (project ID `general`). Use `--auto-start` only when automatic execution is intended; `tasks run` explicitly starts a task. `projects plan` creates tasks unless `--draft` is supplied. `projects draft` only prepares a draft. Listing or reading session history never authorizes resuming it.

For long task instructions use a correctly quoted argument; for skills, agent prompts and workflow steps prefer the supported file options. Do not concatenate untrusted titles or descriptions into shell code. Pass arguments using the terminal's quoting rules, especially on PowerShell.

For requested deployment, record intent with `tasks update <id> --requested-actions deploy` and use the configured workflow. If credentials or a deployment workflow are absent, ask the operator. Do not invent a deployment target.

Deletion, stopping runs, changing global settings or resuming a provider session must be within the user's authorized scope. If running as an AIWS task, follow the injected coordinator protocol: only the root coordinator may complete, stop or pause its run; children report to their parent. Do not complete another task just because implementation files changed.

## Verify and report

Read back changed resources using `show`, `list`, or task messages. A successful start request means execution began; inspect run status and events before reporting completion. Report affected project/task IDs, observed results, and any remaining failures. Never mark work successful without evidence.
