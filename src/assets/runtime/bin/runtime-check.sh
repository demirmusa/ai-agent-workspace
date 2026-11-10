#!/usr/bin/env bash
set -euo pipefail
source /opt/aiws/bin/common.sh

actual="$(</opt/aiws/VERSION)"
expected="${AIWS_EXPECTED_RUNTIME_VERSION:-}"
if [[ -n "$expected" && "$expected" != "$actual" ]]; then
  aiws_die "Workflow/runtime version mismatch: workflow=$expected runtime=$actual. Run 'aiws sync' then 'aiws up'." 2
fi

for cmd in bash curl docker gh git jq realpath timeout; do aiws_require_command "$cmd"; done
aiws_require_env AIWS_REPOSITORY
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die "Invalid AIWS_REPOSITORY: $AIWS_REPOSITORY" 2
aiws_require_env AIWS_WORKSPACE_VOLUME
aiws_require_env AIWS_RUNTIME_IO_VOLUME
aiws_require_env AIWS_AGENT_IMAGE
aiws_name_is_valid "$AIWS_WORKSPACE_VOLUME" || aiws_die 'Unsafe workspace volume name.' 2
aiws_name_is_valid "$AIWS_RUNTIME_IO_VOLUME" || aiws_die 'Unsafe runtime I/O volume name.' 2
aiws_runtime_io_root >/dev/null

if find /opt/aiws/bin -type f -perm /022 -print -quit | grep -q .; then
  aiws_die '/opt/aiws/bin contains a group/world-writable runtime script.' 2
fi
docker info >/dev/null 2>&1 || aiws_die 'Runner cannot reach the Docker daemon.' 2
docker volume inspect "$AIWS_WORKSPACE_VOLUME" >/dev/null 2>&1 \
  || aiws_die "Workspace volume does not exist: $AIWS_WORKSPACE_VOLUME" 2
docker volume inspect "$AIWS_RUNTIME_IO_VOLUME" >/dev/null 2>&1 \
  || aiws_die "Runtime I/O volume does not exist: $AIWS_RUNTIME_IO_VOLUME" 2
docker image inspect "$AIWS_AGENT_IMAGE" >/dev/null 2>&1 \
  || aiws_die "Agent image is not built: $AIWS_AGENT_IMAGE (run 'aiws up')." 2

aiws_notice "AIWS runtime $actual is ready ($(uname -m))."
