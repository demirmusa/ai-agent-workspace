Tasks can start at a set time, and schedules can create tasks repeatedly. The General workspace gives scheduled and one-off work a home when it does not belong to any repository.

## One-time scheduled start

Give a single task an earliest start time:

1. In the task form open **Advanced options → Planning → Scheduled start** and pick a date and time. You can change it later in the task details.
2. Put the task in **Ready**.

How it behaves:

- Only **Ready** tasks run. A Ready task does not start before its time; when the time comes it joins the normal queue and starts when a suitable agent is free.
- A scheduled task in **Backlog** does not run. When you move it to Ready after its time has passed, it queues immediately.
- Ready tasks whose time passed while the application was closed start at the next launch, if the system is running.
- The card shows the start time and the time remaining.
- Moving the task to **Work** by hand, or `tasks run`, starts it without waiting. Clearing the field removes the condition.

```powershell
aiws control tasks create project_ID "Nightly report" --status ready --scheduled-at 2026-10-20T09:00
aiws control tasks update task_ID --scheduled-at none
```

Times are local time; ISO 8601 is also accepted.

## Recurring schedules

Recurring schedules belong to a project and are defined on its **Scheduled tasks** tab.

Each time a schedule fires it creates a new **Ready** task in the project with the same title, instructions, agent profile, provider and model, skills, tags, priority, terminal mode and workflow. From there the task follows the usual queue, agent selection, worktree and merge rules. The agent profile and provider are stored as references, so each run uses the profile as it is at that moment.

### Recurrence types

| Type | Example | Notes |
|---|---|---|
| **Once** | Oct 20, 14:00 | Does not run again once the time has passed. |
| **At intervals** | 30 minutes, 2 hours, 3 days, 1 week | Counted from the start time. Day and week intervals keep the local time. Minimum 1 minute. |
| **Every day** | 09:00, 18:00 | One or more times of day. |
| **Selected weekdays** | Mon, Wed at 09:00 | Weekday and weekend shortcuts are offered. |
| **Every month** | 1, 15, last day at 08:00 | `last` is the last day of the month, February included. |
| **Cron expression** | `0 9 * * 1-5` | Five fields; lists, ranges, steps, month and day names, and shortcuts such as `@daily`. When both day-of-month and day-of-week are restricted, either one matching is enough (standard cron). |

### Time zone

Times are read in the schedule's **Time zone** (IANA name such as `Europe/Istanbul`; the default is the control service's time zone). Across daylight-saving changes a skipped local time is not invented, and a repeated hour runs once.

Before you save, the form shows the next three run times as computed by the server.

### Limits and rules

| Setting | Behavior |
|---|---|
| Start / end | Bounds before and after which the schedule does not run. Intervals are counted from the start. |
| Maximum runs | The schedule stops after creating this many scheduled tasks. Manual runs are not counted. |
| **If the previous task is still open** | Default **Skip this run**: no new task is created while the schedule's previous task is Ready, Running, waiting for an answer or Paused, so tasks do not pile up. **Create a new task anyway** allows parallel tasks. |
| **Runs missed while the app was closed** | Default **Run once at the next launch**: all runs missed while closed collapse into a single catch-up task. Skipping instead moves on to the next time. A run found more than two minutes late counts as missed. |

No tasks are created while the system is set to **System stopped**; the missed-run rule applies when you turn it back on.

### Managing schedules

- Schedule cards show the next run, the last run and the task it created, the run count and the last result (task created, skipped, or failed with the reason).
- The switch pauses or enables a schedule. When re-enabled, the next time is computed from now.
- **Run now** creates an extra task without changing the timetable.
- Deleting a schedule does not delete the tasks it created. Deleting a project deletes its schedules.
- Tasks created by a schedule are marked on the card with the schedule's name. The agent prompt states which schedule and run time the task was created for, and that it runs unattended.
- The tab also lists one-time scheduled tasks in the project that are waiting for their time.

Because scheduled tasks run unattended, give them an agent profile with clear instructions, and consider enabling [Auto mode](AI-Providers#auto-mode) only for providers and projects you trust.

## General workspace

The **General workspace** is the first entry in the sidebar's workspace list. It is for work that is independent of a project, a chosen folder, Git and GitHub: a weekly summary, research, a reminder, maintenance, a report.

| | Project | General workspace |
|---|---|---|
| Folder | The one you choose | `workspace` inside the control data directory (default `~/.aiws/control/workspace`), created automatically |
| Tabs | Board, Terminal, Scheduled tasks, Sessions, Project settings | Board, Scheduled tasks (default tab), Terminal, Sessions |
| Git, worktrees, GitHub | Configurable | Not available; no task branches are created |
| Can be deleted | Yes | No |
| Shown in the project list | Yes | No |

Agents run in that shared folder and files persist between runs. The agent prompt says it is working in the general workspace, a shared folder without a Git repository. One-time tasks, scheduled tasks and recurring schedules all work here.

## CLI examples

```powershell
# Project schedules: every run creates a Ready task.
aiws control schedules create project_ID "Dependency report" --daily 09:00 --weekdays mon-fri --timezone Europe/Istanbul --agent agent_ID --description "List outdated packages."
aiws control schedules create project_ID "Half-hourly check" --every 30m --overlap skip --catch-up skip
aiws control schedules create project_ID "Month end" --monthly 1,last --at 08:00 --max-runs 12
aiws control schedules create project_ID "Cron" --cron "0 9 * * 1-5" --end-at 2027-01-01T00:00

# General workspace: use "general" instead of a project ID.
aiws control workspace
aiws control schedules create general "Weekly summary" --cron "0 8 * * 1" --description-file D:\Notes\weekly.md
aiws control tasks create general "One-off research" --status ready --scheduled-at 2026-10-21T14:30

# Inspect and manage.
aiws control schedules list --project general
aiws control schedules preview --daily 09:00,18:00 --weekdays sat,sun --count 5
aiws control schedules update schedule_ID --every 2h
aiws control schedules disable schedule_ID
aiws control schedules enable schedule_ID
aiws control schedules run schedule_ID
aiws control schedules delete schedule_ID
```

`schedules preview` computes upcoming run times without saving anything, which is a quick way to check a cron expression.

## Related pages

- [Core Concepts](Core-Concepts)
- [Board and Tasks](Board-and-Tasks)
- [Agents, Skills and Workflows](Agents-Skills-and-Workflows)
- [AI Providers](AI-Providers)
- [CLI Reference](CLI-Reference)
- [HTTP API](HTTP-API)
