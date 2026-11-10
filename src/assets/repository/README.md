# Repository workflow templates

These files are rendered into `.github/workflows/` by the CLI. They are intentionally thin:
GitHub evaluates the trusted event gate, then the selected self-hosted runner calls only the
versioned runtime installed below `/opt/aiws/bin`. The workflows never check out repository code,
execute repository-owned scripts, or place comment/issue text into a shell command.

## Rendering contract

Rendering is literal `{{TOKEN}}` replacement. GitHub expressions (`${{ ... }}`) must remain byte
for byte intact. A render is invalid if any token matching `{{[A-Z0-9_]+}}` remains afterwards.

| Token | Required value |
| --- | --- |
| `ACTOR_ALLOWLIST_JSON` | Compact JSON string array of allowed GitHub logins; `"*"` explicitly allows any actor. |
| `AGENT_COMMAND` | Validated issue command token, such as `/agent`. |
| `AGENT_LABELS_JSON` | Compact JSON array of exact issue labels that start agent work. |
| `AUTOMATION_TOKEN_SECRET` | GitHub Actions secret name for repository automation. |
| `CONCURRENCY_GROUP` | One repository-specific group shared by every rendered workflow. |
| `HOOK_COMMANDS_JSON` | Compact JSON array of exact enabled test/custom hook commands. |
| `HOOK_CONTENTS_PERMISSION` | `read`, or `write` only when an enabled hook requires it. |
| `HOOK_LABELS_JSON` | Compact JSON array of exact enabled hook labels; `[]` is valid. |
| `HOOK_TIMEOUT_MINUTES` | Positive, bounded integer baked from configuration. |
| `ISSUE_TIMEOUT_MINUTES` | Positive, bounded integer baked from configuration. |
| `PR_COMMAND` | Validated PR command token, such as `/aiws`. |
| `PR_TIMEOUT_MINUTES` | Positive, bounded integer baked from configuration. |
| `PROJECT_TOKEN_ENV` | Six-space-indented `AIWS_PROJECT_TOKEN` env line, or empty when project support is disabled. |
| `PROJECT_TOKEN_SECRET` | GitHub Actions secret name for Projects access. Queue template only. |
| `RUNNER_LABELS` | JSON/YAML flow array including `self-hosted` and the repository-unique runner label. |
| `RUNTIME_VERSION` | Exact runtime compatibility version expected below `/opt/aiws`. |

Values placed inside a GitHub expression string must be expression-safe. The renderer must validate
commands and secret names, validate runner labels and timeouts, and JSON-encode arrays. Before a JSON
array is inserted between expression single quotes, every apostrophe must be doubled for GitHub's
expression-string syntax. This prevents a configured label from escaping the expression literal.

Agent and PR commands match either the command by itself or the command followed by one ASCII space
and a request. Thus `/agent fix this` is accepted while `/agent-admin` is not. Hook commands remain
exact whole-body matches. Request bodies are consumed from `GITHUB_EVENT_PATH` only.

`PROJECT_TOKEN_ENV`, when enabled, renders exactly as an independently named project credential:

```yaml
      AIWS_PROJECT_TOKEN: ${{ secrets['PROJECTS_PAT'] }}
```

It must never reuse or fall back to `AIWS_AUTOMATION_TOKEN`. The queue workflow is omitted entirely
when project mode is disabled. The hooks workflow is likewise omitted when there are no enabled
test/custom hooks.
