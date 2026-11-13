You can run the control center as a container on a server and let each task run in its own short-lived worker container. This page covers the Compose setup shipped in the repository. For a single workstation the native install in [Installation](Installation) is simpler.

## What gets built

`src/control-server/docker/Dockerfile.control` produces two images. Both are built from a source checkout, not from the npm package.

| Target | Contains | Role |
|---|---|---|
| `server` | Control API and web UI | The long-running service |
| `worker` | Codex, Claude Code, OpenCode and the `aiws` CLI | One container per task run, removed when the run ends |

The desktop app is not containerized. It runs on your machine and can connect to the containerized service through `AIWS_CONTROL_URL`.

## Start the service

Run the commands from the repository root on a Linux Docker host. The Compose build context is the repository root.

```bash
export AIWS_CONTROL_TOKEN="$(openssl rand -hex 32)"
export AIWS_WORKSPACE_ROOT=/srv/projects
mkdir -p "$AIWS_WORKSPACE_ROOT"
docker compose -f src/control-server/docker/compose.control.yaml --profile build build
docker compose -f src/control-server/docker/compose.control.yaml up -d control
```

Compose refuses to start without a token and a workspace root. Put the variables in the shell or in a `.env` file at the repository root.

The UI is then at `http://127.0.0.1:4317` on the host and asks for the token.

## Environment variables

| Variable | Purpose |
|---|---|
| `AIWS_CONTROL_TOKEN` | API token. Required |
| `AIWS_WORKSPACE_ROOT` | Absolute host path that holds your project folders. Required |
| `AIWS_GITHUB_TOKEN` | GitHub access. The image has no `gh`, so a token is the only way |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Provider credentials, forwarded to workers |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot (fine-grained token with Copilot Requests permission) |
| `AIWS_CONTROL_DOCKER_NETWORK` | Network the workers join |
| `AIWS_CONTROL_AGENT_URL` | URL workers use to reach the control API |
| `AIWS_CONTROL_SKILLS_VOLUME` | Volume that carries skill snapshots to workers |
| `AIWS_CONTROL_BROWSE_ROOTS` | Roots of the folder picker. Limit it to the project roots you mean to expose |

The sample Compose file forwards API keys to workers. It does not mount subscription sign-in files from the host. OpenCode credentials depend on the provider you select; `OPENCODE_API_KEY` is not a universal key.

## Create a project

On first start the Compose environment selects Docker execution and the worker image. For existing data or a custom setup, set them explicitly:

```bash
export AIWS_CONTROL_URL=http://127.0.0.1:4317
aiws control settings set --execution-mode docker --docker-image aiws-control-worker:local
aiws control projects create 'Server project' --path /srv/projects/my-app
```

Without `aiws` on the host, run the same command inside the service container, which already has the token:

```bash
docker compose -f src/control-server/docker/compose.control.yaml exec control aiws control settings set --execution-mode docker --docker-image aiws-control-worker:local
```

## Paths must match

The project folder must be visible **at the same absolute path** on the Docker host and inside the service container. Workers are sibling containers, so their bind mounts are resolved by the Docker daemon on the host, not inside the service container.

- `/srv/projects` on the host must be `/srv/projects` in the service container.
- Inside the worker the project is mounted at `/workspace`.
- Workers run as the `node` user. On Linux the project folder must be writable for that UID/GID.
- Host paths containing a comma, a quote or a line break are rejected.

## Network

Workers join the Compose network `aiws-control_default` and reach the API at `http://control:4317` to ask questions and report completion.

- If you rename the network, update `AIWS_CONTROL_DOCKER_NETWORK` and `AIWS_CONTROL_AGENT_URL` together.
- With a native service that starts Docker workers, the agent URL can be `http://host.docker.internal:4317`, but the service must really listen on an address the container can reach. A port bound only to `127.0.0.1` on the host is not reachable from a container.

## Skills volume

Skill snapshots reach the worker through a read-only mount at `/run/aiws/skills`. `AIWS_CONTROL_SKILLS_VOLUME` names the service's data volume (default `aiws-control_control-data`); the worker mounts the `runs/<runId>/skills` subfolder of it. If you rename the data volume, set this variable to the new name.

With a native service and Docker workers and no volume variable, the local skills folder is bind mounted, so Docker Desktop must share that folder.

## How a worker runs

Each run is one container:

- named `aiws-control-<runId>` and removed on exit (`--rm`),
- `--cap-drop=ALL` and `no-new-privileges`,
- limited to 2 CPUs, 4 GB memory and 512 PIDs,
- no Docker socket,
- project at `/workspace`, read-only during planning and AI drafting,
- skills and run input mounted read-only.

Pause maps to `docker pause` and `docker unpause`; stop removes the container. If the control service dies, a watchdog removes the worker.

## Security

- The HTTP port is published on the host's **127.0.0.1** only. For remote access use SSH port forwarding or a TLS reverse proxy.
- The service container has access to the Docker socket, which is effectively high privilege on the host. Use a trusted, preferably dedicated host.
- The control token grants file access and command execution. Give it only to operators you trust. There are no roles and no per-task tokens.
- The API token is passed to workers so agents can ask questions. It is not scoped to a single run.

More in [Security](Security).

## Limits

- Provider session history lives on the machine where the provider ran. Resuming a host session from a Docker worker is not supported.
- Multiple Claude Code accounts work only with native execution.
- The Compose example assumes a Linux Docker host. On Windows, a native service or the desktop app with Docker workers is the more direct start; verify Docker Desktop's path sharing and container permissions yourself.

## Logs, stop and backup

```bash
docker compose -f src/control-server/docker/compose.control.yaml logs -f control
docker compose -f src/control-server/docker/compose.control.yaml down
```

`down` does not delete the persistent `control-data` volume. Back up the data directory while the service is stopped and include its `runs/` folder.

## Troubleshooting

| Symptom | Check |
|---|---|
| Mount error when a task starts | Are host and service paths identical? Does the folder exist on the daemon host? Can the worker UID write to it? |
| Worker cannot reach the question API | Docker network and `AIWS_CONTROL_AGENT_URL`; a host loopback address belongs to the container itself |
| `aiws control ask` not found in a task | The worker image must be `aiws-control-worker:local` |
| GitHub errors | `AIWS_GITHUB_TOKEN` is set on the service and has repository and Projects access |

## Related pages

- [Installation](Installation)
- [Configuration](Configuration)
- [Security](Security)
- [AI Providers](AI-Providers)
- [GitHub Integration](GitHub-Integration)
- [Troubleshooting](Troubleshooting)
