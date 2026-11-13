#!/usr/bin/env bash
# Run exactly one ephemeral provider container. No GitHub token or Docker socket is passed.
set -euo pipefail
source /opt/aiws/bin/common.sh

aiws_require_env GITHUB_WORKSPACE
aiws_require_env AIWS_REPOSITORY
aiws_require_env AIWS_PROVIDER
aiws_require_env AIWS_PROFILE
aiws_require_env AIWS_WORKSPACE_VOLUME
aiws_require_env AIWS_RUNTIME_IO_VOLUME
aiws_require_env AIWS_AGENT_IMAGE

root="$(cd "$GITHUB_WORKSPACE" && pwd -P)"
work_root="$(cd "${AIWS_RUNNER_WORK_ROOT:-/var/lib/aiws/work}" && pwd -P)"
case "$root/" in
  "$work_root"/*) relative="${root#"$work_root"/}" ;;
  *) aiws_die "GITHUB_WORKSPACE is outside the repo-scoped runner work volume: $root" 2 ;;
esac
[[ "$relative" =~ ^[A-Za-z0-9._/-]+$ && "$relative" != *'..'* ]] \
  || aiws_die 'Unsafe workspace volume subpath.' 2

run_dir="${AIWS_RUN_DIR:-}"
brief="${AIWS_BRIEF_FILE:-}"
log="${AIWS_AGENT_LOG:-}"
result="${AIWS_AGENT_RESULT:-}"
expected_run_dir="$(aiws_runtime_run_directory)"
[[ "$run_dir" == "$expected_run_dir" ]] || aiws_die 'Agent run directory is not the trusted per-run path.' 3
[[ "$brief" == "$run_dir/input/brief.md" ]] || aiws_die 'Unexpected agent brief path.' 3
[[ "$log" == "$run_dir/host/agent.jsonl" ]] || aiws_die 'Unexpected agent log path.' 3
[[ "$result" == "$run_dir/host/result.md" ]] || aiws_die 'Unexpected agent result path.' 3
provider_result="$run_dir/output/provider-result.md"
aiws_validate_run_directory "$run_dir"
aiws_validate_runtime_file "$brief" "$run_dir/input/brief.md"
[[ ! -e "$log" && ! -L "$log" && ! -e "$result" && ! -L "$result" ]] \
  || aiws_die 'Fresh runtime log/result paths already exist.' 3
umask 077
( set -o noclobber; : > "$log" ) || aiws_die 'Could not create the agent log exclusively.' 3
chmod 0500 "$run_dir/input"

case "$AIWS_PROVIDER" in
  claude)
    auth_volume="${AIWS_CLAUDE_AUTH_VOLUME:-}"
    auth_target=/home/agent/.claude
    ;;
  codex)
    auth_volume="${AIWS_CODEX_AUTH_VOLUME:-}"
    auth_target=/home/agent/.codex
    ;;
  opencode)
    auth_volume="${AIWS_OPENCODE_AUTH_VOLUME:-}"
    auth_target=/home/agent/.local/share/opencode
    ;;
  *) aiws_die "Unsupported provider: $AIWS_PROVIDER" 2 ;;
esac
aiws_name_is_valid "$AIWS_WORKSPACE_VOLUME" || aiws_die 'Unsafe workspace volume name.' 2
aiws_name_is_valid "$AIWS_RUNTIME_IO_VOLUME" || aiws_die 'Unsafe runtime I/O volume name.' 2
aiws_name_is_valid "$auth_volume" || aiws_die "Missing or unsafe $AIWS_PROVIDER auth volume name." 2
[[ "${AIWS_MODEL:-}" != *$'\n'* ]] && aiws_effort_is_valid "$AIWS_PROVIDER" "${AIWS_EFFORT:-medium}" \
  || aiws_die 'Invalid model or provider-specific effort value.' 2

workspace_mount_options=""
[[ "${AIWS_READ_ONLY:-false}" != true ]] || workspace_mount_options=",readonly"
container_root=/work
io_subpath="${run_dir#"$(aiws_runtime_io_root)"/}"
[[ "$io_subpath" =~ ^run-[1-9][0-9]*-[1-9][0-9]*$ ]] || aiws_die 'Unsafe runtime volume subpath.' 3
container_brief=/run/aiws/input/brief.md
container_result=/run/aiws/output/provider-result.md
uid="$(id -u)"; gid="$(id -g)"
memory="${AIWS_AGENT_MEMORY:-4g}"
cpus="${AIWS_AGENT_CPUS:-2}"
pids="${AIWS_AGENT_PIDS:-512}"
network="${AIWS_AGENT_NETWORK:-bridge}"
timeout_minutes="${AIWS_AGENT_TIMEOUT_MINUTES:-90}"
startup_seconds="${AIWS_AGENT_STARTUP_SECONDS:-120}"
shutdown_seconds="${AIWS_AGENT_SHUTDOWN_SECONDS:-30}"
[[ "$pids" =~ ^[1-9][0-9]*$ && "$timeout_minutes" =~ ^[1-9][0-9]*$ && "$startup_seconds" =~ ^[1-9][0-9]*$ && "$shutdown_seconds" =~ ^[1-9][0-9]*$ ]] \
  || aiws_die 'Agent pids/timeout limits must be positive integers.' 2
[[ "$memory" =~ ^[0-9]+([.][0-9]+)?[bBkKmMgG]$ && "$cpus" =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || aiws_die 'Agent memory/cpu limits are invalid.' 2
aiws_name_is_valid "$network" || aiws_die 'Unsafe agent network name.' 2
[[ "$AIWS_AGENT_IMAGE" =~ ^[a-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?$ ]] \
  || aiws_die 'Unsafe agent image reference.' 2

container_name="aiws-agent-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
aiws_name_is_valid "$container_name" || aiws_die 'Unsafe ephemeral agent container name.' 2
cleanup_container() {
  local marker repo_marker
  if ! docker container inspect "$container_name" >/dev/null 2>&1; then return 0; fi
  marker="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.ephemeral" }}' "$container_name" 2>/dev/null || true)"
  repo_marker="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.repository" }}' "$container_name" 2>/dev/null || true)"
  if [[ "$marker" == true && "$repo_marker" == "$AIWS_REPOSITORY" ]]; then
    docker rm --force "$container_name" >/dev/null 2>&1 || true
  else
    aiws_warn "Container name collision was not removed because ownership labels do not match: $container_name"
    return 1
  fi
}
if docker container inspect "$container_name" >/dev/null 2>&1; then
  cleanup_container || aiws_die 'Refusing to remove a non-AIWS container.' 2
fi
trap 'cleanup_container || true' EXIT

# This fixed command consumes only validated env and fixed paths. The prompt is stdin, never a shell arg.
read -r -d '' agent_command <<'COMMAND' || true
set -euo pipefail
if [[ "$AIWS_PROVIDER" == codex ]]; then
  args=(exec --ignore-user-config --sandbox danger-full-access --json --ephemeral --output-last-message "$AIWS_RESULT")
  [[ -z "$AIWS_MODEL" ]] || args+=(--model "$AIWS_MODEL")
  args+=(-c "model_reasoning_effort=\"$AIWS_EFFORT\"" -)
  codex "${args[@]}" < "$AIWS_BRIEF"
elif [[ "$AIWS_PROVIDER" == opencode ]]; then
  args=(run --format json)
  [[ -z "$AIWS_MODEL" ]] || args+=(--model "$AIWS_MODEL")
  export OPENCODE_PERMISSION='{"*":"allow","question":"deny"}'
  export OPENCODE_AUTO_SHARE=false
  opencode "${args[@]}" < "$AIWS_BRIEF"
else
  if [[ -s "$CLAUDE_CONFIG_DIR/aiws-api-key" ]]; then
    export ANTHROPIC_API_KEY="$(cat "$CLAUDE_CONFIG_DIR/aiws-api-key")"
  fi
  args=(--print --output-format stream-json --verbose --permission-mode bypassPermissions --effort "$AIWS_EFFORT")
  [[ -z "$AIWS_MODEL" ]] || args+=(--model "$AIWS_MODEL")
  claude "${args[@]}" < "$AIWS_BRIEF"
fi
COMMAND

aiws_group "Agent run: profile=$AIWS_PROFILE provider=$AIWS_PROVIDER model=${AIWS_MODEL:-default}"
execution_seconds=$((timeout_minutes * 60 - shutdown_seconds - 15))
(( execution_seconds >= startup_seconds )) || aiws_die 'Agent timeout is too short for configured startup/shutdown allowance.' 2
set +e
timeout --signal=TERM --kill-after="${shutdown_seconds}s" "${execution_seconds}s" \
  docker run --rm --init --pull never \
    --name "$container_name" \
    --hostname aiws-agent \
    --user "$uid:$gid" \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit "$pids" \
    --memory "$memory" \
    --cpus "$cpus" \
    --network "$network" \
    --mount "type=volume,src=$AIWS_WORKSPACE_VOLUME,dst=$container_root,volume-subpath=$relative$workspace_mount_options" \
    --mount "type=volume,src=$AIWS_WORKSPACE_VOLUME,dst=$container_root/.git,volume-subpath=$relative/.git,readonly" \
    --mount "type=volume,src=$AIWS_RUNTIME_IO_VOLUME,dst=/run/aiws/input,volume-subpath=$io_subpath/input,readonly" \
    --mount "type=volume,src=$AIWS_RUNTIME_IO_VOLUME,dst=/run/aiws/output,volume-subpath=$io_subpath/output" \
    --mount "type=volume,src=$auth_volume,dst=$auth_target" \
    --workdir "$container_root" \
    --env HOME=/home/agent \
    --env CLAUDE_CONFIG_DIR=/home/agent/.claude \
    --env CODEX_HOME=/home/agent/.codex \
    --env XDG_DATA_HOME=/home/agent/.local/share \
    --env "AIWS_PROVIDER=$AIWS_PROVIDER" \
    --env "AIWS_MODEL=${AIWS_MODEL:-}" \
    --env "AIWS_EFFORT=${AIWS_EFFORT:-medium}" \
    --env "AIWS_BRIEF=$container_brief" \
    --env "AIWS_RESULT=$container_result" \
    --env GIT_CONFIG_COUNT=1 \
    --env GIT_CONFIG_KEY_0=safe.directory \
    --env "GIT_CONFIG_VALUE_0=$container_root" \
    --label "io.aiws.ephemeral=true" \
    --label "io.aiws.repository=$AIWS_REPOSITORY" \
    --label "io.aiws.profile=$AIWS_PROFILE" \
    --entrypoint /bin/bash \
    "$AIWS_AGENT_IMAGE" -lc "$agent_command" \
    | tee "$log" \
    | jq -r --unbuffered '
        if .type == "item.completed" and .item.type == "agent_message" then .item.text
        elif .type == "text" then .part.text
        elif .type == "assistant" then (.message.content[]? | select(.type == "text") | .text)
        elif .type == "error" then "Agent error: " + (.message // (.error|tostring) // "unknown")
        else empty end' 2>/dev/null
pipeline_status=("${PIPESTATUS[@]}")
rc="${pipeline_status[0]}"
(( ${pipeline_status[1]:-1} == 0 && ${pipeline_status[2]:-1} == 0 )) || rc=1
set -e
aiws_endgroup

# The agent never sees host/result.md or host/agent.jsonl. Revalidate the trusted siblings after
# the container exits, then copy/derive the provider result into the host-only directory.
[[ -d "$run_dir/output" && ! -L "$run_dir/output" ]] \
  || aiws_die 'Agent replaced its output mount with an unsafe path.' 3
chmod 0700 "$run_dir/output"
aiws_validate_run_directory "$run_dir"
aiws_validate_runtime_file "$log" "$run_dir/host/agent.jsonl"
result_tmp="$run_dir/host/result.tmp"
[[ ! -e "$result_tmp" && ! -L "$result_tmp" ]] || aiws_die 'Unexpected temporary result path.' 3
if [[ "$AIWS_PROVIDER" == claude ]]; then
  jq -r -s '[.[] | select(.type == "result") | .result][-1] // ""' "$log" > "$result_tmp" 2>/dev/null \
    || { rm -f -- "$result_tmp"; rc=1; }
elif [[ "$AIWS_PROVIDER" == opencode ]]; then
  jq -r -s '[.[] | select(.type == "text") | .part.text] | join("\n\n")' "$log" > "$result_tmp" 2>/dev/null \
    || { rm -f -- "$result_tmp"; rc=1; }
  if jq -e -s 'any(.[]; .type == "error")' "$log" >/dev/null 2>&1; then rc=1; fi
else
  if [[ -e "$provider_result" || -L "$provider_result" ]]; then
    if [[ -f "$provider_result" && ! -L "$provider_result" ]]; then
      aiws_validate_runtime_file "$provider_result" "$run_dir/output/provider-result.md"
      cp -- "$provider_result" "$result_tmp" || { rm -f -- "$result_tmp"; rc=1; }
    else
      aiws_warn 'Provider result is not a regular file; it was ignored.'
      rc=1
    fi
  fi
  if [[ ! -f "$result_tmp" ]]; then
    jq -r -s '[.[] | select(.type == "item.completed" and .item.type == "agent_message") | .item.text][-1] // ""' \
      "$log" > "$result_tmp" 2>/dev/null || { rm -f -- "$result_tmp"; rc=1; }
  fi
fi
if [[ -f "$result_tmp" && ! -L "$result_tmp" ]]; then
  mv -- "$result_tmp" "$result"
else
  ( set -o noclobber; : > "$result" ) || aiws_die 'Could not create a trusted empty result.' 3
fi
aiws_validate_runtime_file "$result" "$run_dir/host/result.md"
chmod 0600 "$result" "$log"
aiws_summary "### AIWS agent"
aiws_summary ""
aiws_summary "- Profile: \`$AIWS_PROFILE\`"
aiws_summary "- Provider: \`$AIWS_PROVIDER\`"
aiws_summary "- Model: \`${AIWS_MODEL:-provider default}\`"
aiws_summary "- Exit code: \`$rc\`"
exit "$rc"
