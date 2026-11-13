# AIWS management commands

All examples use IDs returned by the server. Substitute actual IDs; angle brackets are placeholders. Run `aiws control <group> <command> --help` for current options. Use `aiws control --url <url>` before a group to select a server. JSON is the default output; errors exit nonzero.

## Projects across repositories

```text
aiws control projects list
aiws control projects show <project-id>
aiws control projects create "Project name" --path /absolute/backend/repository
aiws control projects update <project-id> --description "Updated description"
aiws control projects branches <project-id>
aiws control projects draft <project-id> "Prepare a task to fix the login error"
aiws control projects plan <project-id> "Plan the requested change" --draft
aiws control projects organize <project-id>
```

`projects plan` without `--draft` saves the planned tasks. `projects organize` starts an AI organizer (no board task) that orders backlog tasks against the ready queue, records dependencies and priorities and moves actionable backlog tasks to Ready; `--cancel` stops it. `projects connect`, `disconnect`, `sync`, and `detect` manage optional GitHub connections. `projects delete` removes project data; inspect its effects before use.

## Tasks and execution

```text
aiws control tasks list --project <project-id> --status backlog
aiws control tasks show <task-id>
aiws control tasks create <project-id> "Fix login" --description "Reproduce and fix the reported error" --agent <agent-id>
aiws control tasks update <task-id> --status ready --priority 3
aiws control tasks update <task-id> --blocked-by <dependency-task-id>
aiws control tasks message <task-id> "Implementation and validation update"
aiws control tasks messages <task-id>
aiws control tasks run <task-id>
aiws control runs list --project <project-id>
aiws control runs list --task <task-id> --status running
aiws control runs show <run-id>
aiws control runs events <run-id>
```

`tasks create` defaults to backlog with auto-start disabled; leave those defaults for a request to record work. Its description is passed with `--description` (there is no task `--description-file` option); use a PowerShell here-string variable for multiline instructions. Task and project commands accept IDs, not repository names or paths. Read the created task back with `tasks show`.

`ready` with auto-start enabled can start execution. Priorities: 3 high, 2 medium, 1 low. Use `tasks search <query> --project <id>` to resolve dependencies. `--blocked-by` accepts local task IDs or linked GitHub issue numbers. `--workflow <id>`, `--skills <ids>` and `--requested-actions <names>` use comma-separated selections where applicable. Use `tasks update --help` for clearing and inheritance options.

`runs pause`, `resume`, `stop`, `send`, `terminal` and `attach` operate on real provider runs. `attach` connects an interactive PTY; Ctrl+] detaches. Prefer `events` for noninteractive observation. Only the authorized coordinator should use `runs complete <id>` or `control complete --run <id>` after verification; add `--failed` for unsuccessful work.

## Milestones

```text
aiws control milestones list <project-id> --state open
aiws control milestones show <project-id> <milestone-id>
aiws control milestones create <project-id> "v1.0" --due 2026-12-31 --description "First release" --current
aiws control milestones update <project-id> <milestone-id> --title "v1.0.1" --due none
aiws control milestones update <project-id> <milestone-id> --state closed
aiws control milestones current <project-id>
aiws control milestones current <project-id> <milestone-id|none>
aiws control milestones assign <project-id> <milestone-id|none> <task-id1,task-id2>
aiws control milestones delete <project-id> <milestone-id>
aiws control tasks create <project-id> "Fix login" --milestone <milestone-id|none>
aiws control tasks list --project <project-id> --milestone <milestone-id|none>
```

New tasks join the project's current milestone unless `--milestone` names another one or `none`. `list` marks the current milestone and counts its tasks; `current` without an ID shows it. Closing the current milestone makes the open milestone with the closest due date current; `current <project-id> none` makes new tasks start without a milestone. Deleting a milestone keeps its tasks, without a milestone. Linked projects sync milestones with GitHub.

## Scheduled and recurring tasks

```text
aiws control tasks create <project-id> "Nightly report" --status ready --scheduled-at 2026-10-20T09:00
aiws control tasks update <task-id> --scheduled-at none
aiws control schedules list --project <project-id>
aiws control schedules create <project-id> "Dependency report" --daily 09:00 --weekdays mon-fri --timezone Europe/Istanbul --agent <agent-id>
aiws control schedules create <project-id> "Health check" --every 30m --overlap skip --catch-up skip
aiws control schedules create <project-id> "Month end" --monthly 1,last --at 08:00 --max-runs 12
aiws control schedules create general "Weekly digest" --cron "0 8 * * 1" --description-file /absolute/weekly.md
aiws control schedules preview --cron "0 9 * * 1-5" --count 5
aiws control schedules update <schedule-id> --every 2h
aiws control schedules disable <schedule-id>
aiws control schedules run <schedule-id>
aiws control workspace
```

A ready task with `--scheduled-at` does not start before that time; a past time (also after a restart) starts it at once, and backlog tasks never start. Each schedule occurrence creates a new Ready task with the schedule's task template; agent and provider are references resolved at each run. Times are read in the schedule time zone (IANA, defaults to the control service). `--overlap skip` (default) skips an occurrence while the previous task of the schedule is still open; `--catch-up once` (default) runs missed occurrences once after the service was closed or stopped, `skip` waits for the next time. `schedules run` creates an extra task without changing the timetable. Use `general` as the project ID for the general workspace: a folder in the control data directory with no Git or GitHub, listed under Agents in the UI. Deleting a schedule keeps the tasks it created.

## Reusable agents, workflows and skills

```text
aiws control agents directory
aiws control agents list
aiws control agents show <agent-id>
aiws control agents create "Reviewer" --provider codex --instructions-file /absolute/prompt.txt
aiws control workflows list
aiws control workflows show <workflow-id>
aiws control workflows create "Review" --project <project-id> --steps-file /absolute/steps.json
aiws control skills list
aiws control skills create "Project rules" --file /absolute/SKILL.md
aiws control agents update <agent-id> --skills <skill-id>
```

Workflow steps files contain an ordered JSON array with `name`, `agentId`, `instructions`, and optional `condition`. Discover valid values with CLI help and existing workflows. `skills import <directory>` reads the directory on the backend host; `skills create --file` reads the file locally. These server-side catalog skills are separate from the Codex/Claude management skill installed with `aiws agent-skills install`.

## Questions, history and settings

```text
aiws control questions list
aiws control questions answer <question-id> "Operator answer"
aiws control ask "Missing requirement?" --run <own-run-id>
aiws control ask "Does this screen look right?" --run <own-run-id> --image shot1.png --image shot2.png
aiws control reply "Final answer for the requester" --run <own-run-id>
aiws control session --run <own-run-id> [provider-session-id] [--model <own-model-id>]
aiws control complete --run <own-run-id> --summary "Changes and tests" --reply "Final answer"
aiws control github status
aiws control github authorize
aiws control projects sessions <project-id> --provider codex
aiws control projects session <project-id> <session-id>
aiws control settings show
```

`ask` waits for the operator unless `--no-wait` is given. `projects resume <project-id> <session-id>` explicitly continues that provider session. `settings set` affects the whole server; inspect its help and obtain the necessary scope from the user's request.

`session` records the provider session the run works in on its task (Claude Code and Codex IDs are detected from the environment; pass Antigravity, OpenCode and GitHub Copilot IDs explicitly). The task keeps these sessions as a list; follow-up messages and merge-conflict recovery resume the latest one instead of starting a new agent.

`reply` stores the run's final answer. When the task is linked to a GitHub issue, the reply (or else the agent's last message) is posted as an issue comment when the run ends, and `ask` questions are mirrored to the issue; a trusted issue comment answers them. Issue comments containing the configured trigger (`settings set --github-trigger`, default `/ai`) become new requests for the task.
