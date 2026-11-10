Agents, skills and workflows let you define a role once and reuse it: who does the work, what they know, which instructions they follow and in what order a task passes between them.

## Agent profiles

An agent is defined on the **Agents** screen. It is a local working profile of the control center; creating one does not create a model account or a cloud agent.

| Field | Purpose |
|---|---|
| Name, description | How the agent appears on cards and in the agent directory. |
| Provider, model | Which CLI and model run the work. |
| **Instructions** | How the agent works: conventions, checks, style. |
| **Context** | What it should know: product rules, terminology, project background. |
| **Default skills** | Skill packages attached to every run of this agent. |
| Terminal mode | Stream or the real CLI terminal. New Codex and Claude Code profiles suggest the real CLI terminal. |

The task description then only has to describe the work for that run.

### Inheritance

- A task that selects an **Agent profile** inherits the agent's provider, model and terminal mode.
- Setting a provider or model on the task overrides that field for the task only.
- A disabled agent does not start new runs.
- Unassigned Ready tasks are given an idle agent that matches their provider and capability tags.

```powershell
aiws control agents create "Backend developer" --provider codex --instructions "Follow the repo instructions; review the related tests first." --context "The service uses TypeScript ESM; the API must stay backward compatible." --skills skill_ID
aiws control agents update agent_ID --instructions-file D:\Notes\agent-instructions.txt --context-file D:\Notes\project-context.txt
aiws control agents update agent_ID --skills skill_A,skill_B --enabled true
aiws control agents list

aiws control tasks create project_ID "Fix the search service" --agent agent_ID --description "Fix the empty result error and test it."
aiws control tasks update task_ID --provider claude --model chosen-model
aiws control tasks update task_ID --inherit-provider --inherit-model
aiws control tasks update task_ID --agent none
```

### The execution snapshot

When a run starts, the agent definition, instructions, context, skill texts and resource files are frozen as an **executionSnapshot**.

- Editing a profile or skill later does not change a running or past run, nor its continuation turns. A new run uses the current definition.
- Skill resources are written per run under `<data-dir>/runs/<runId>/skills/<skillId>/`, and the prompt contains those real paths.
- Your global `~/.codex`, `~/.claude` and OpenCode skill folders are not modified.

### What agents see of each other

Running agents can list a directory of other agents (`aiws control agents directory`). It contains only ID, name, provider, description and capability metadata. Another agent's instructions, context, skill resources and credentials are never shared.

## Agent templates

**Agents → Agent templates** offers 163 community profiles for frontend, backend, .NET and other specialties, served from the local package.

- Source: [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents), pinned revision, MIT license. The license ships in `src/assets/agent-templates/LICENSE`.
- They are community profiles, not Anthropic's built-in subagents, and nothing is enabled automatically.
- Preview a template, choose **Create from template**, review the **New agent from template** form and click **Create agent**. The result is an independent, editable profile under **My agents**.
- The upstream `model` and `tools` hints are not copied into provider settings. MCP servers, plugins, skills, external tools and credentials are not installed; set up what the instructions assume yourself.
- Opening the library makes no network request.

## Skill packages

A skill is a `SKILL.md` plus optional resource files such as `references/`, `scripts/` and `assets/`. The library starts empty; no hidden or automatic skills are added.

Create one on the **Skills** screen with **New skill**:

- Write the `SKILL.md` text or upload the file.
- Add supporting files or a folder from your computer.
- **Import from server** imports a folder that exists on the machine running the control service, with its resources.

```powershell
# The file is read on this computer and sent to the API.
aiws control skills create "Code review" --file D:\Skills\review\SKILL.md

# The folder must exist on the backend machine.
aiws control skills import D:\Skills\review
aiws control skills list
aiws control tasks update task_ID --skills skill_EXTRA
```

### How skills reach a run

The agent's skills and the task's extra skills are merged; a duplicate is included once. `--skills ""` clears the task's extra list and keeps the agent's own skills. A skill or agent that is still referenced cannot be deleted until the reference is removed.

### Limits and safety

| Limit | Value |
|---|---|
| Resource files per skill | 64 |
| Size per file and per `SKILL.md` | 256 KiB |
| Size per package | 1 MiB |

- Paths outside the package, absolute resource paths and symlinks are rejected.
- Scripts are not executed on import. The agent may run them during a run.
- Only load skills you trust, and do not put tokens or secrets in them: their content reaches the prompt, the stored snapshot and the operator API.

## Workflows

A workflow is a reusable, named sequence of stages. Each stage is assigned to a configured agent.

```json
[
  {"name": "Frontend development", "agentId": "agent_FRONTEND", "instructions": "Implement and run the related tests.", "condition": "always"},
  {"name": "Build and deploy", "agentId": "agent_DEPLOY", "instructions": "Build, deploy to the configured target and verify health. Ask if access is missing.", "condition": "deploy_requested"}
]
```

```powershell
aiws control workflows create "Frontend and deploy" --project project_ID --trigger always --steps-file D:\Notes\workflow-steps.json
aiws control tasks update task_ID --workflow workflow_ID --requested-actions deploy
aiws control tasks update task_ID --status ready
```

How they behave:

- A workflow is global or belongs to one project.
- Trigger `always` defines a mandatory default chain; `requested` defines a flow used only when asked for. If more than one default matches, nothing is picked at random: select the task's workflow explicitly.
- A successful stage hands the same task to the next named agent **automatically**, without waiting for review in between. After the last stage the task moves to Review (or Done with automatic merge).
- A failure, a stop or a failed explicit completion does not start the next stage. Restarting retries only the failed stage.
- The workflow definition is snapshotted at the start. Stage index and state are stored on disk; after a service restart an in-flight stage is shown as interrupted, never assumed successful.

### Conditional stages and requested actions

A stage with a condition such as `deploy_requested` runs only when the task carries the matching requested action.

- In AI planning, a request like "ship it to the server when it is done" becomes `requestedActions: ["deploy"]`.
- A running agent that understands the request can enable the stage itself with `aiws control tasks update ... --requested-actions deploy`.
- AIWS does not create deployment credentials. If the server or access is missing, the deploy agent should ask a question or report failure.

AIWS workflow stages are separate from a provider's own subagents, which are shown in the [Agent Console](Agent-Console-and-Sessions).

## Managing AIWS from your own agent

AIWS ships an agent skill, `aiws-project-manager`, that teaches Codex and Claude Code to manage projects, tasks, agents, workflows and runs through the `aiws` CLI.

```powershell
aiws agent-skills install
aiws agent-skills status
```

- It installs into `~/.agents/skills/` for Codex and `~/.claude/skills/` for Claude Code. User scope is the default, so it works from any repository.
- Call it with `$aiws-project-manager` in Codex or `/aiws-project-manager` in Claude Code.
- `--provider codex|claude` limits the install to one provider. `aiws -C <repo-path> agent-skills install --scope project` installs into one repository.
- `--dry-run` shows the targets without writing. Modified files are kept unless you pass `--force`.

The control center must be running. The CLI uses `AIWS_CONTROL_URL` (and `AIWS_CONTROL_TOKEN` if needed), and otherwise finds the local service on its own. This local skill is separate from the catalog skills managed with `aiws control skills`.

## Related pages

- [Core Concepts](Core-Concepts)
- [AI Providers](AI-Providers)
- [Planning with AI](Planning-with-AI)
- [Agent Console and Sessions](Agent-Console-and-Sessions)
- [Plugins and Themes](Plugins-and-Themes)
- [CLI Reference](CLI-Reference)
