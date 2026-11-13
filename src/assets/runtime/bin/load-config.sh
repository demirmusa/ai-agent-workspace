#!/usr/bin/env bash
# Load and validate a committed .aiworkspace/config.json without evaluating its contents.

source /opt/aiws/bin/common.sh

AIWS_CONFIG=''

aiws_config_validate() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || aiws_die "Config must be a regular, non-symlink file: $file" 2
  jq -e '
    def posint: type == "number" and . > 0 and floor == .;
    def relpath:
      type == "string" and length > 0 and
      (startswith("/") | not) and (test("^[A-Za-z]:") | not) and
      (gsub("\\\\"; "/") | split("/") | all(. != ".."));
    type == "object" and
    (.schemaVersion == 1) and
    (.repository.slug | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
    (.repository.defaultBranch | type == "string" and length > 0 and
      (startswith("-") | not) and (test("[[:space:]~^:?*\\[\\]\\\\]") | not) and (contains("..") | not)) and
    (.security.allowedActors | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)) and
    (.security.allowPublicRepository | type == "boolean") and
    (.security.protectedPaths | type == "array" and all(.[]; relpath)) and
    (.runner.labels | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)) and
    (.agents | type == "object") and
    (.agents.defaultProfile | type == "string" and test("^[a-z][a-z0-9_-]*$")) and
    (.agents.profiles | type == "array" and length > 0 and length <= 20) and
    (.agents.defaultProfile as $default | [.agents.profiles[].id] | index($default) != null) and
    (all(.agents.profiles[];
      (.id | type == "string" and test("^[a-z][a-z0-9_-]*$")) and
      (.provider == "claude" or .provider == "codex" or .provider == "opencode") and
      (.model == null or (.model | type == "string" and length > 0)) and
      (if .provider == "codex" then
         (.effort | type == "string" and test("^(minimal|low|medium|high|xhigh)$"))
       elif .provider == "opencode" then
         (.effort | type == "string" and test("^(minimal|low|medium|high|xhigh|max)$"))
       else
         (.effort | type == "string" and test("^(low|medium|high|xhigh|max)$"))
       end) and
      (.triggerLabel | type == "string" and length > 0))) and
    (.queue.mode as $m | ($m == "label" or $m == "project" or $m == "both")) and
    (.queue.labels | type == "object" and all([.ready,.running,.done,.failed,.continue][]; type == "string" and length > 0)) and
    (.queue.pollSeconds | posint and . >= 10 and . <= 3600) and
    (if .orchestration == null then true else
      (.orchestration.enabled | type == "boolean") and
      (.orchestration.maxConcurrent | posint and . <= 50) end) and
    (all([.organization, .review][]; . == null or
      ((.enabled | type == "boolean") and (.profile == null or (.profile | type == "string" and test("^[a-z][a-z0-9_-]*$")))))) and
    ((.agents.profiles | map(.id)) as $profiles |
      all([.organization.profile, .review.profile][]; . == null or (. as $id | $profiles | index($id) != null))) and
    (.review.onPullRequest == null or (.review.onPullRequest | type == "boolean")) and
    ((.agents.profiles | map(.id)) as $profiles | (.review.profiles // []) |
      type == "array" and length <= 10 and (length == (unique | length)) and all(.[]; . as $id | $profiles | index($id) != null)) and
    (if (.queue.mode == "project" or .queue.mode == "both") then
       (.queue.project | type == "object") and
       (.queue.project.owner | type == "string" and length > 0) and
       (.queue.project.number | posint) and
       (.queue.project.ownerType == "user" or .queue.project.ownerType == "organization") and
       (all([.queue.project.statusField,.queue.project.ready,.queue.project.inProgress,.queue.project.inReview,.queue.project.done][];
         type == "string" and length > 0))
     else true end) and
    (.commands | all([.issue,.pr,.test][]; type == "string" and test("^/[A-Za-z0-9][A-Za-z0-9_-]*$"))) and
    (.brief.instructionFiles | type == "array" and length <= 20 and all(.[]; relpath)) and
    (.brief.extra | type == "string" and length <= 20000) and
    (.brief.maxIssueComments | type == "number" and . >= 0 and . <= 1000 and floor == .) and
    (.brief.maxPullRequestComments | type == "number" and . >= 0 and . <= 1000 and floor == .) and
    (.brief.maxCharacters | posint and . >= 1000 and . <= 1000000) and
    (.hooks.custom | type == "array" and length <= 30) and
    (all(.hooks.custom[]; (.id | type == "string" and test("^[a-z][a-z0-9_-]*$")) and
      (.command | type == "string" and test("^/")) and (.run | type == "string" and length > 0))) and
    (all([.hooks.test.timeoutMinutes?, .hooks.custom[].timeoutMinutes?][]; . == null or posint)) and
    (.agent.resources.cpus | type == "number" and . > 0 and . <= 256) and
    (.agent.resources.memory | type == "string" and test("^[0-9]+([.][0-9]+)?[bBkKmMgG]$")) and
    (.agent.resources.pids | posint and . <= 1048576) and
    (.agent.network | type == "string" and test("^[a-z0-9][a-z0-9_.-]*$")) and
    (all([.agent.timeouts.issueMinutes,.agent.timeouts.prMinutes,.agent.timeouts.hookMinutes,
          .agent.timeouts.startupSeconds,.agent.timeouts.shutdownSeconds][]; posint)) and
    (.agent.timeouts.startupSeconds >= 5 and .agent.timeouts.startupSeconds <= 3600) and
    (.agent.timeouts.shutdownSeconds <= 600) and
    (.agent.timeouts as $timeouts |
      (((($timeouts.startupSeconds + $timeouts.shutdownSeconds + 59) / 60) | floor) + 5) as $overhead |
       all([$timeouts.issueMinutes,$timeouts.prMinutes,$timeouts.hookMinutes][]; . + $overhead <= 360) and
       (([(.review.profiles // [] | length), 1] | max) * ($timeouts.prMinutes + $overhead) <= 360) and
       all([.hooks.test.timeoutMinutes?, .hooks.custom[].timeoutMinutes?][];
         . == null or . + $overhead <= 360))
  ' "$file" >/dev/null || aiws_die "Invalid or unsupported tracked config: $file" 2
}

aiws_config_load() {
  local file="$1"
  aiws_config_validate "$file"
  AIWS_CONFIG="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  export AIWS_CONFIG
  if [[ -n "${AIWS_REPOSITORY:-}" ]]; then
    local configured
    configured="$(jq -r '.repository.slug' "$AIWS_CONFIG")"
    [[ "$configured" == "$AIWS_REPOSITORY" ]] || aiws_die "Config repository ($configured) does not match runtime repository ($AIWS_REPOSITORY)." 2
  fi
}

aiws_config_from_git() {
  local repo_dir="$1" ref="$2" output="$3"
  aiws_ref_is_valid "$ref" || aiws_die "Unsafe config ref: $ref" 2
  git -C "$repo_dir" show "${ref}:.aiworkspace/config.json" > "$output" \
    || aiws_die "Tracked .aiworkspace/config.json is missing at $ref." 2
  chmod 0600 "$output"
  aiws_config_load "$output"
}

aiws_config_export_runtime() {
  # One jq pass; values are NUL-separated because labels may contain any printable text.
  local -a values=()
  mapfile -d '' -t values < <(jq -j '[
    .repository.defaultBranch,
    (.agent.resources.memory // "4g"), (.agent.resources.cpus // 2), (.agent.resources.pids // 512),
    (.agent.network // "bridge"),
    (.agent.timeouts.issueMinutes // 90), (.agent.timeouts.prMinutes // 60), (.agent.timeouts.hookMinutes // 60),
    (.agent.timeouts.startupSeconds // 120), (.agent.timeouts.shutdownSeconds // 30),
    (.queue.labels.ready // "agent:go"), (.queue.labels.running // "agent:running"),
    (.queue.labels.done // "agent:done"), (.queue.labels.failed // "agent:failed"),
    (.queue.labels.continue // "agent:continue")
  ][] | tostring + "\u0000"' "$AIWS_CONFIG")
  (( ${#values[@]} == 15 )) || aiws_die 'Could not read runtime settings from the tracked config.' 2
  AIWS_DEFAULT_BRANCH="${values[0]}"
  AIWS_AGENT_MEMORY="${values[1]}" AIWS_AGENT_CPUS="${values[2]}" AIWS_AGENT_PIDS="${values[3]}"
  AIWS_AGENT_NETWORK="${values[4]}"
  AIWS_AGENT_TIMEOUT_MINUTES="${values[5]}" AIWS_PR_TIMEOUT_MINUTES="${values[6]}" AIWS_HOOK_TIMEOUT_MINUTES="${values[7]}"
  AIWS_AGENT_STARTUP_SECONDS="${values[8]}" AIWS_AGENT_SHUTDOWN_SECONDS="${values[9]}"
  AIWS_LABEL_GO="${values[10]}" AIWS_LABEL_RUNNING="${values[11]}" AIWS_LABEL_DONE="${values[12]}"
  AIWS_LABEL_FAILED="${values[13]}" AIWS_LABEL_CONTINUE="${values[14]}"
  export AIWS_DEFAULT_BRANCH AIWS_AGENT_MEMORY AIWS_AGENT_CPUS AIWS_AGENT_PIDS
  export AIWS_AGENT_NETWORK AIWS_AGENT_TIMEOUT_MINUTES AIWS_PR_TIMEOUT_MINUTES AIWS_HOOK_TIMEOUT_MINUTES
  export AIWS_AGENT_STARTUP_SECONDS AIWS_AGENT_SHUTDOWN_SECONDS
  export AIWS_LABEL_GO AIWS_LABEL_RUNNING AIWS_LABEL_DONE
  export AIWS_LABEL_FAILED AIWS_LABEL_CONTINUE
}

# The workflow actor must be listed in the tracked config (case-insensitive); "*" allows anyone.
aiws_actor_allowed() {
  local actor="${1,,}"
  [[ -n "$actor" && "$actor" != *$'\n'* ]] || return 1
  [[ "$(jq -r --arg actor "$actor" \
    '[.security.allowedActors[] | ascii_downcase] | index("*") != null or index($actor) != null' "$AIWS_CONFIG")" == true ]]
}

# Remove one concrete repository-relative path without ever following an attacker-created
# symlink in an intermediate component. Git supplies the concrete path; config globs are never
# passed to rm.
aiws_remove_repo_path_safely() {
  local repo="$1" relative="$2" current="$1" next index
  local -a parts=()
  [[ -n "$relative" && "$relative" != /* ]] \
    || aiws_die 'Git returned an unsafe changed path.' 3
  IFS='/' read -r -a parts <<<"$relative"
  for index in "${!parts[@]}"; do
    [[ -n "${parts[$index]}" && "${parts[$index]}" != . && "${parts[$index]}" != .. ]] \
      || aiws_die 'Git returned a path with an unsafe component.' 3
    next="$current/${parts[$index]}"
    if (( index == ${#parts[@]} - 1 )); then
      if [[ -e "$next" || -L "$next" ]]; then rm -rf --one-file-system -- "$next"; fi
      return 0
    fi
    if [[ -L "$next" || ( -e "$next" && ! -d "$next" ) ]]; then
      rm -f -- "$next"
      return 0
    fi
    [[ -d "$next" ]] || return 0
    current="$next"
  done
}

# Revert runtime-protected paths if an agent touched them. Control-plane paths are immutable
# regardless of repository config; validated custom entries can only add protection.
aiws_restore_protected_changes() {
  local repo="$1" changed protected hit=0
  local -a changed_files=()
  local -A restored_files=()
  local -a protected_paths=(
    '.github/workflows' '.github/workflows/**'
    '.aiworkspace' '.aiworkspace/**'
    '.aiws-runtime' '.aiws-runtime/**'
  )
  while IFS= read -r -d '' changed; do changed_files+=("$changed"); done \
    < <({
      git -C "$repo" diff --name-only -z HEAD
      git -C "$repo" ls-files --others --exclude-standard -z
      git -C "$repo" ls-files --others --ignored --exclude-standard -z -- \
        .github/workflows .aiworkspace .aiws-runtime
    })
  while IFS= read -r protected; do [[ -n "$protected" ]] && protected_paths+=("$protected"); done \
    < <(jq -r '.security.protectedPaths[]?' "$AIWS_CONFIG")
  for protected in "${protected_paths[@]}"; do
    [[ -n "$protected" ]] || continue
    protected="${protected#./}"
    [[ "$protected" != /* && "$protected" != *'..'* ]] || continue
    for changed in "${changed_files[@]}"; do
      # The right-hand side is intentionally an unquoted [[ pattern ]]; config paths may use
      # reviewed globs such as .github/workflows/**.
      if [[ -z "${restored_files[$changed]+present}" ]] \
         && [[ $changed == $protected || "$changed" == "${protected%/}/"* ]]; then
        aiws_warn "Agent change to protected path was reverted: $changed"
        aiws_remove_repo_path_safely "$repo" "$changed"
        if git -C "$repo" ls-files --error-unmatch -- "$changed" >/dev/null 2>&1; then
          git -C "$repo" restore --source=HEAD --staged --worktree -- "$changed"
        fi
        restored_files["$changed"]=1
        hit=1
      fi
    done
  done

  # Also remove ignored/untracked content hidden from normal status output in the mandatory
  # control roots. Restore their target-branch baseline only after every symlink component has
  # been removed safely. This does not erase legitimate pre-existing PR changes.
  local control_root
  for control_root in .github/workflows .aiworkspace .aiws-runtime; do
    aiws_remove_repo_path_safely "$repo" "$control_root"
    if [[ -n "$(git -C "$repo" ls-tree -r --name-only HEAD -- "$control_root")" ]]; then
      git -C "$repo" restore --source=HEAD --staged --worktree -- "$control_root"
    fi
  done
  return "$hit"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -eq 1 ]] || aiws_die 'Usage: load-config.sh <config.json>' 2
  aiws_config_load "$1"
  aiws_config_export_runtime
  jq -n --arg repository "$AIWS_REPOSITORY" --arg branch "$AIWS_DEFAULT_BRANCH" \
    '{valid:true, repository:$repository, defaultBranch:$branch}'
fi
