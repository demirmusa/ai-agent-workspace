Short answers to the questions that come up most often.

## General

**What is AI Agent Workspace?**
A local-first Kanban board and control center for coding agents. You describe work as tasks; Claude Code, Codex and other agent CLIs pick them up, run in parallel in their own branches, ask you when they need a decision and deliver the result through a merge or a pull request.

**Is it free? Does it cost anything beyond my provider subscription?**
The app is open source under the MIT license and has no account, server or fee of its own. Agents use the provider CLIs and logins you already have, so the only cost is your own subscription or API usage with those providers.

**Is it on npm?**
Not published yet. Install from source: clone the repository and run `.\run.ps1` on Windows. See [Installation](Installation).

**Which operating systems are supported?**
The control center runs natively on Windows, macOS and Linux with Node.js 22.13 or newer. Windows has the one-command `run.ps1` installer; on macOS and Linux run the npm commands in `src`. Most real-world verification so far has been done on Windows.

**Which languages does the interface support?**
Turkish and English. Switch under **Settings → General → Language**. The default is Turkish.

## Requirements

**Do I need a GitHub account?**
No. Projects, tasks and runs live on your computer and work with any folder, with or without Git. GitHub is optional and adds two-way sync with issues and Projects, pull request delivery and remote control. See [GitHub Integration](GitHub-Integration).

**Do I need Docker?**
No. Agents run as native processes by default. Docker is an optional execution mode and is required only for the server deployment and the [GitHub Actions Runner](GitHub-Actions-Runner) mode.

**Which AI providers work?**
Codex, Claude Code, OpenCode, Antigravity and GitHub Copilot CLI, plus a custom command provider for your own executable. Each CLI must be installed and logged in under the account that runs the app. See [AI Providers](AI-Providers).

**Do I need API keys?**
Not if your provider CLI is already logged in with a subscription. API keys such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` are an alternative, mainly for Docker.

## Using it

**Where is my data?**
In `~/.aiws/control` on the computer that runs the service: a SQLite database, settings, run inputs, worktrees and plugins. Nothing is sent to a service of ours. Task content reaches the AI provider you chose, and GitHub if you connect a project. See [Configuration](Configuration).

**Can several agents work on one repository at the same time?**
Yes. Enable **Run tasks in separate Git worktrees** in the project settings: every task gets its own `aiws/<task-id>` branch and folder, so agents do not touch each other's files. Without worktrees, only one agent runs in a project folder at a time. See [Git, Worktrees and Merging](Git-Worktrees-and-Merging).

**How many agents run at once?**
Three by default. Change **Concurrent agents** in Settings or run `aiws control settings set --max-concurrent 5`. A project can have its own limit.

**Can I manage work from my phone?**
Yes, through GitHub. With a connected project and the desktop app running on your computer, open an issue or move a card to Ready from the GitHub mobile app. Agents run on your computer and write their answers and questions back to the issue. Mention the trigger (default `/ai`) in a comment to send a follow-up.

**Do agents ask before doing risky things?**
That depends on the provider's permission settings. Agents can ask you questions and request approvals, which appear in the **Needs you** column and in notifications. With **Auto mode** enabled for a provider, its agents start without permission prompts.

**Can I see exactly what an agent did?**
Yes. Each task has a **Chat** tab with readable messages, commands and file changes, an **Agent Console** tab with the real CLI terminal, the subagent tree and the changed files.

**What happens when an agent runs out of tokens?**
The app detects the provider's usage-limit message and offers to continue the same task, on the same branch, with another agent or provider.

**Does closing the window stop my agents?**
No. The desktop app keeps running in the system tray, so agents and GitHub polling continue. Use the exit item in the tray menu to stop everything; exiting stops running agents.

**Can I use my existing Codex or Claude Code sessions?**
Yes. The **Sessions** tab of a project lists the sessions those CLIs already recorded for that folder. You can read them, continue one, or turn it into a task.

**Can I schedule recurring work?**
Yes: once, at an interval, daily, on selected weekdays, monthly or with a cron expression. See [Schedules and General Workspace](Schedules-and-General-Workspace).

**Can I extend the app?**
Yes, with plugins: menu items, pages, project tabs, task fields, card badges, commands, server routes, prompt context and themes. See [Plugins and Themes](Plugins-and-Themes).

**Is it safe to expose the service on my network?**
Only with a token and preferably behind an SSH tunnel or TLS reverse proxy. The token gives full control of files and commands on the host. Read [Security](Security) first.

## Related pages

- [Home](Home)
- [Quick Start](Quick-Start)
- [Core Concepts](Core-Concepts)
- [Troubleshooting](Troubleshooting)
