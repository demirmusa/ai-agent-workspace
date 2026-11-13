#!/usr/bin/env bash
# Run one exact, tracked hook command in an isolated container. No token/auth/socket is mounted.
set -Eeuo pipefail
source /opt/aiws/bin/common.sh
source /opt/aiws/bin/git-ops.sh
source /opt/aiws/bin/load-config.sh

AIWS_REPOSITORY="${AIWS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
aiws_require_env AIWS_REPOSITORY
aiws_require_env GITHUB_WORKSPACE
aiws_require_env GITHUB_EVENT_PATH
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die "Invalid repository: $AIWS_REPOSITORY" 2
aiws_automation_token >/dev/null
aiws_unexport_tokens

workspace="$(mkdir -p "$GITHUB_WORKSPACE" && cd "$GITHUB_WORKSPACE" && pwd -P)"
tmp="$(aiws_runtime_tmpdir)"
built_image=''
hook_container=''
cleanup_hook_runtime() {
  aiws_git_scrub_credentials "$workspace" 2>/dev/null || true
  if [[ -n "$hook_container" ]] && docker container inspect "$hook_container" >/dev/null 2>&1; then
    marker="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.ephemeral-hook" }}' "$hook_container" 2>/dev/null || true)"
    repo_marker="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.repository" }}' "$hook_container" 2>/dev/null || true)"
    if [[ "$marker" == true && "$repo_marker" == "$AIWS_REPOSITORY" ]]; then docker rm --force "$hook_container" >/dev/null 2>&1 || true; fi
  fi
  if [[ -n "$built_image" ]] && docker image inspect "$built_image" >/dev/null 2>&1; then
    marker="$(docker image inspect --format '{{ index .Config.Labels "io.aiws.temporary-hook" }}' "$built_image" 2>/dev/null || true)"
    repo_marker="$(docker image inspect --format '{{ index .Config.Labels "io.aiws.repository" }}' "$built_image" 2>/dev/null || true)"
    if [[ "$marker" == true && "$repo_marker" == "$AIWS_REPOSITORY" ]]; then docker image rm --force "$built_image" >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup_hook_runtime EXIT
aiws_git_init_workspace "$workspace" "$AIWS_REPOSITORY"
aiws_git_discard_untrusted_dirty "$workspace"
api_default="$(aiws_repo_gh api "repos/$AIWS_REPOSITORY" --jq .default_branch)"
aiws_git_checkout_remote "$workspace" "$api_default"

config_file="$tmp/config.json"
aiws_config_from_git "$workspace" HEAD "$config_file"
aiws_config_export_runtime
actor="${GITHUB_ACTOR:-$(aiws_event_value '.sender.login')}"
aiws_actor_allowed "$actor" || aiws_die "Actor is not allowed by tracked config: $actor" 3

event_name="${GITHUB_EVENT_NAME:-}"
comment="$(aiws_event_value '.comment.body')"
event_label="$(aiws_event_value '.label.name')"
hook_json=''
test_command="$(jq -r '.commands.test' "$AIWS_CONFIG")"
if [[ -n "$comment" && "$comment" == "$test_command" ]]; then
  hook_json="$(jq -c --arg command "$test_command" 'if .hooks.test then .hooks.test + {id:"test",command:$command} else empty end' "$AIWS_CONFIG")"
fi
if [[ -z "$hook_json" ]]; then
  matches="$(jq -c --arg command "$comment" --arg trigger_label "$event_label" '
    [.hooks.custom[] | select(($command != "" and .command == $command) or ($trigger_label != "" and (.label // "") == $trigger_label))]
  ' "$AIWS_CONFIG")"
  count="$(jq -r 'length' <<<"$matches")"
  [[ "$count" == 1 ]] || aiws_die "Hook trigger resolved to $count hooks; refusing ambiguous execution." 2
  hook_json="$(jq -c '.[0]' <<<"$matches")"
fi
[[ -n "$hook_json" && "$hook_json" != null ]] || aiws_die 'No configured hook matches this event exactly.' 2

if [[ "$(jq -r '.release // false' <<<"$hook_json")" == true || -n "$(jq -r '.artifact // empty' <<<"$hook_json")" ]]; then
  aiws_die 'Artifact/release hooks are not enabled in this runtime version; the command was not executed.' 2
fi

hook_id="$(jq -r '.id' <<<"$hook_json")"
hook_run="$(jq -r '.run' <<<"$hook_json")"
aiws_name_is_valid "$hook_id" || aiws_die 'Unsafe hook id.' 2
[[ -n "$hook_run" && ${#hook_run} -le 8192 ]] || aiws_die 'Hook run command is empty or too long.' 2

memory="$(jq -r --arg fallback "$AIWS_AGENT_MEMORY" '.resources.memory // $fallback' <<<"$hook_json")"
cpus="$(jq -r --argjson fallback "$AIWS_AGENT_CPUS" '.resources.cpus // $fallback' <<<"$hook_json")"
pids="$(jq -r --argjson fallback "$AIWS_AGENT_PIDS" '.resources.pids // $fallback' <<<"$hook_json")"
network="$(jq -r --arg fallback "$AIWS_AGENT_NETWORK" '.network // $fallback' <<<"$hook_json")"
timeout_minutes="$(jq -r --argjson fallback "$AIWS_HOOK_TIMEOUT_MINUTES" '.timeoutMinutes // $fallback' <<<"$hook_json")"
startup_seconds="${AIWS_AGENT_STARTUP_SECONDS:-120}"
shutdown_seconds="${AIWS_AGENT_SHUTDOWN_SECONDS:-30}"
aiws_name_is_valid "$network" || aiws_die 'Unsafe hook network.' 2
aiws_name_is_valid "$AIWS_WORKSPACE_VOLUME" || aiws_die 'Unsafe workspace volume name.' 2
[[ "$pids" =~ ^[1-9][0-9]*$ && "$timeout_minutes" =~ ^[1-9][0-9]*$ && "$startup_seconds" =~ ^[1-9][0-9]*$ && "$shutdown_seconds" =~ ^[1-9][0-9]*$ ]] || aiws_die 'Invalid hook pids/timeout.' 2
[[ "$memory" =~ ^[0-9]+([.][0-9]+)?[bBkKmMgG]$ && "$cpus" =~ ^[0-9]+([.][0-9]+)?$ ]] || aiws_die 'Invalid hook memory/cpu limits.' 2
hook_budget_seconds=$((timeout_minutes * 60 - shutdown_seconds - 15))
(( hook_budget_seconds >= startup_seconds )) || aiws_die 'Hook timeout is too short for configured startup/shutdown allowance.' 2
hook_deadline=$((SECONDS + hook_budget_seconds))

issue="$(aiws_event_value '.issue.number')"
aiws_number_is_valid "$issue" || aiws_die 'Hook event has no issue/PR number.' 2
target_branch="$AIWS_DEFAULT_BRANCH"
if [[ "$(aiws_event_value '.issue.pull_request.url')" != '' ]]; then
  pr_json="$(aiws_repo_gh api "repos/$AIWS_REPOSITORY/pulls/$issue")"
  head_repo="$(jq -r '.head.repo.full_name // empty' <<<"$pr_json")"
  [[ "$head_repo" == "$AIWS_REPOSITORY" ]] || aiws_die 'Hooks never run against fork pull requests.' 3
  target_branch="$(jq -r '.head.ref' <<<"$pr_json")"
fi
aiws_ref_is_valid "$target_branch" || aiws_die 'Unsafe hook target branch.' 2
if [[ "$target_branch" != "$AIWS_DEFAULT_BRANCH" ]]; then aiws_git_checkout_remote "$workspace" "$target_branch"; fi

image="$(jq -r '.image // empty' <<<"$hook_json")"
dockerfile="$(jq -r '.dockerfile // empty' <<<"$hook_json")"
context="$(jq -r '.context // "."' <<<"$hook_json")"
if [[ -n "$dockerfile" ]]; then
  [[ "$dockerfile" != /* && "$dockerfile" != *'..'* ]] || aiws_die 'Unsafe hook Dockerfile path.' 2
  [[ "$context" != /* && "$context" != *'..'* ]] || aiws_die 'Unsafe hook build context path.' 2
  [[ ! -L "$workspace/$dockerfile" && ! -L "$workspace/$context" ]] || aiws_die 'Hook build paths may not be symlinks.' 2
  dockerfile_real="$(realpath -e -- "$workspace/$dockerfile")" || aiws_die 'Hook Dockerfile does not exist.' 2
  context_real="$(realpath -e -- "$workspace/$context")" || aiws_die 'Hook build context does not exist.' 2
  [[ -f "$dockerfile_real" && ! -L "$dockerfile_real" ]] || aiws_die 'Hook Dockerfile must resolve to a regular file.' 2
  [[ -d "$context_real" ]] || aiws_die 'Hook context must resolve to a directory.' 2
  case "$dockerfile_real" in "$workspace"/*) ;; *) aiws_die 'Hook Dockerfile resolves outside the repository.' 2 ;; esac
  case "$context_real/" in "$workspace/"|"$workspace"/*) ;; *) aiws_die 'Hook context resolves outside the repository.' 2 ;; esac
  built_image="aiws-hook-${GITHUB_RUN_ID:-local}-${hook_id}:local"
  [[ "$built_image" =~ ^[a-z0-9][a-z0-9_.:-]+$ ]] || aiws_die 'Unsafe temporary hook image name.' 2
  if docker image inspect "$built_image" >/dev/null 2>&1; then
    old_marker="$(docker image inspect --format '{{ index .Config.Labels "io.aiws.temporary-hook" }}' "$built_image" 2>/dev/null || true)"
    old_repo="$(docker image inspect --format '{{ index .Config.Labels "io.aiws.repository" }}' "$built_image" 2>/dev/null || true)"
    [[ "$old_marker" == true && "$old_repo" == "$AIWS_REPOSITORY" ]] || aiws_die 'Temporary hook image name collides with an unowned image.' 2
    docker image rm --force "$built_image" >/dev/null
  fi
  image="$built_image"
  remaining_seconds=$((hook_deadline - SECONDS))
  (( remaining_seconds >= startup_seconds )) || aiws_die 'Hook timeout expired before its image could be built.' 1
  timeout --signal=TERM --kill-after="${shutdown_seconds}s" "${remaining_seconds}s" \
    docker build --pull=false --network "$network" \
    --label io.aiws.temporary-hook=true --label "io.aiws.repository=$AIWS_REPOSITORY" \
    --file "$dockerfile_real" --tag "$image" "$context_real"
fi
[[ -n "$image" ]] || image="$AIWS_AGENT_IMAGE"
[[ "$image" =~ ^[a-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?$ ]] || aiws_die 'Unsafe hook image reference.' 2
docker image inspect "$image" >/dev/null 2>&1 || aiws_die "Hook image is not present locally: $image" 2

root="$(cd "$workspace" && pwd -P)"
work_root="$(cd "${AIWS_RUNNER_WORK_ROOT:-/var/lib/aiws/work}" && pwd -P)"
case "$root/" in "$work_root"/*) relative="${root#"$work_root"/}" ;; *) aiws_die 'Workspace is outside runner volume.' 2 ;; esac
[[ "$relative" =~ ^[A-Za-z0-9._/-]+$ && "$relative" != *'..'* ]] || aiws_die 'Unsafe workspace volume subpath.' 2
container_root=/work
env_args=()
env_count="$(jq -r '.environment // {} | length' <<<"$hook_json")"
[[ "$env_count" =~ ^[0-9]+$ ]] && (( env_count <= 50 )) \
  || aiws_die 'Hook environment may contain at most 50 variables.' 2
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || aiws_die 'Unsafe hook environment key.' 2
  (( ${#value} <= 8192 )) || aiws_die "Hook environment value is too long: $key" 2
  key_upper="$(tr '[:lower:]' '[:upper:]' <<<"$key" | tr -d '\n')"
  [[ ! "$key_upper" =~ (TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTHORIZATION|COOKIE|API_?KEY) ]] \
    || aiws_die "Sensitive hook environment names are forbidden: $key" 2
  env_args+=(--env "$key=$value")
done < <(jq -j '.environment // {} | to_entries[] | .key, "\u0000", (.value | tostring), "\u0000"' <<<"$hook_json")

run_url="${GITHUB_SERVER_URL:-https://github.com}/${AIWS_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}"
aiws_issue_comment "$issue" "🧪 AIWS hook **$hook_id** started on \`$target_branch\`. Run: $run_url"
hook_container="aiws-hook-${GITHUB_RUN_ID:-local}-${hook_id}"
aiws_name_is_valid "$hook_container" || aiws_die 'Unsafe hook container name.' 2
if docker container inspect "$hook_container" >/dev/null 2>&1; then
  old_marker="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.ephemeral-hook" }}' "$hook_container" 2>/dev/null || true)"
  old_repo="$(docker container inspect --format '{{ index .Config.Labels "io.aiws.repository" }}' "$hook_container" 2>/dev/null || true)"
  [[ "$old_marker" == true && "$old_repo" == "$AIWS_REPOSITORY" ]] || aiws_die 'Hook container name collides with an unowned container.' 2
  docker rm --force "$hook_container" >/dev/null
fi
remaining_seconds=$((hook_deadline - SECONDS))
(( remaining_seconds >= 1 )) || aiws_die 'Hook timeout expired before container start.' 1
set +e
timeout --signal=TERM --kill-after="${shutdown_seconds}s" "${remaining_seconds}s" \
  docker run --rm --init --pull never \
    --name "$hook_container" \
    --user "$(id -u):$(id -g)" \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit "$pids" --memory "$memory" --cpus "$cpus" --network "$network" \
    --mount "type=volume,src=$AIWS_WORKSPACE_VOLUME,dst=$container_root,volume-subpath=$relative" \
    --mount "type=volume,src=$AIWS_WORKSPACE_VOLUME,dst=$container_root/.git,volume-subpath=$relative/.git,readonly" \
    --workdir "$container_root" \
    --env CI=1 \
    "${env_args[@]}" \
    --label io.aiws.ephemeral-hook=true \
    --label "io.aiws.repository=$AIWS_REPOSITORY" \
    --entrypoint /bin/sh \
    "$image" -lc "$hook_run"
rc=$?
set -e

# Hook side effects in the worktree are never committed or pushed by the hook workflow.
git -C "$workspace" reset --hard HEAD >/dev/null
git -C "$workspace" clean -ffdx >/dev/null
if (( rc == 0 )); then
  aiws_issue_comment "$issue" "✅ AIWS hook **$hook_id** completed successfully. Run: $run_url"
else
  aiws_issue_comment "$issue" "❌ AIWS hook **$hook_id** failed with exit code $rc. See the run log: $run_url"
fi
exit "$rc"
