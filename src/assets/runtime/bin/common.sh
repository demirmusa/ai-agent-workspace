#!/usr/bin/env bash
# Shared helpers for immutable AIWS runtime scripts.

if [[ -n "${AIWS_COMMON_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
readonly AIWS_COMMON_SH_LOADED=1

aiws_timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
aiws_log() { printf '%s [aiws] %s\n' "$(aiws_timestamp)" "$*" >&2; }
aiws_warn() { printf '%s [aiws] WARNING: %s\n' "$(aiws_timestamp)" "$*" >&2; }
aiws_die() { printf '%s [aiws] ERROR: %s\n' "$(aiws_timestamp)" "$*" >&2; exit "${2:-1}"; }

aiws_group() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::group::%s\n' "$1"; else aiws_log "$1"; fi
}
aiws_endgroup() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::endgroup::\n'; fi
}
aiws_notice() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::notice::%s\n' "$1"; else aiws_log "$1"; fi
}
aiws_summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
}

aiws_require_command() { command -v "$1" >/dev/null 2>&1 || aiws_die "Required command is missing: $1" 2; }
aiws_require_env() { [[ -n "${!1:-}" ]] || aiws_die "Required environment variable is empty: $1" 2; }

aiws_read_secret() {
  local file_var="$1" value_var="$2" file value
  file="${!file_var:-}"
  value="${!value_var:-}"
  if [[ -n "$file" ]]; then
    [[ -f "$file" ]] || aiws_die "Secret file does not exist: $file" 2
    value="$(<"$file")"
  fi
  value="${value%$'\n'}"
  [[ -n "$value" ]] || aiws_die "A secret must be supplied through $file_var (preferred) or $value_var" 2
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || aiws_die 'Secret values must be one line.' 2
  printf '%s' "$value"
}

aiws_repo_is_valid() { [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; }
aiws_ref_is_valid() {
  [[ -n "$1" && "$1" != -* && "$1" != *'..'* && "$1" != *' '* && "$1" != *'~'* && "$1" != *'^'* && "$1" != *':'* && "$1" != *'?'* && "$1" != *'*'* && "$1" != *'['* && "$1" != *'\\'* ]] \
    && git check-ref-format --branch "$1" >/dev/null 2>&1
}
aiws_name_is_valid() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }
aiws_number_is_valid() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
aiws_effort_is_valid() {
  local provider="$1" effort="$2"
  case "$provider" in
    codex) [[ "$effort" =~ ^(minimal|low|medium|high|xhigh)$ ]] ;;
    opencode) [[ "$effort" =~ ^(minimal|low|medium|high|xhigh|max)$ ]] ;;
    claude) [[ "$effort" =~ ^(low|medium|high|xhigh|max)$ ]] ;;
    *) return 1 ;;
  esac
}

# A command event is accepted only when it is the exact configured token, optionally followed
# by one ASCII space and arguments. Matching is intentionally case-sensitive.
aiws_command_matches() {
  local body="$1" command="$2"
  [[ "$body" == "$command" || "$body" == "$command "* ]]
}

# Agent prompt/output control files live in a dedicated named volume, never in a target branch.
# The fixed mount point prevents a workflow or repository from redirecting trusted writes.
aiws_runtime_io_root() {
  local configured="${AIWS_RUNTIME_IO_ROOT:-/var/lib/aiws/io}" resolved
  [[ "$configured" == /var/lib/aiws/io ]] || aiws_die 'Unexpected runtime I/O mount point.' 2
  [[ -d "$configured" && ! -L "$configured" ]] || aiws_die 'Runtime I/O root is not a real directory.' 2
  resolved="$(realpath -e -- "$configured")" || aiws_die 'Runtime I/O root cannot be resolved.' 2
  [[ "$resolved" == /var/lib/aiws/io ]] || aiws_die 'Runtime I/O root failed containment validation.' 2
  printf '%s' "$resolved"
}

aiws_runtime_run_directory() {
  local run_id="${GITHUB_RUN_ID:-}" attempt="${GITHUB_RUN_ATTEMPT:-}"
  aiws_number_is_valid "$run_id" || aiws_die 'GITHUB_RUN_ID must be a positive integer.' 2
  aiws_number_is_valid "$attempt" || aiws_die 'GITHUB_RUN_ATTEMPT must be a positive integer.' 2
  printf '%s/run-%s-%s' "$(aiws_runtime_io_root)" "$run_id" "$attempt"
}

aiws_validate_run_directory() {
  local run_dir="$1" expected resolved part
  expected="$(aiws_runtime_run_directory)"
  [[ "$run_dir" == "$expected" && -d "$run_dir" && ! -L "$run_dir" ]] \
    || aiws_die 'Runtime run directory is missing or has an unexpected path/type.' 3
  resolved="$(realpath -e -- "$run_dir")" || aiws_die 'Runtime run directory cannot be resolved.' 3
  [[ "$resolved" == "$expected" ]] || aiws_die 'Runtime run directory escaped its named volume.' 3
  for part in input host output; do
    [[ -d "$run_dir/$part" && ! -L "$run_dir/$part" ]] \
      || aiws_die "Runtime $part directory is missing or unsafe." 3
    resolved="$(realpath -e -- "$run_dir/$part")" || aiws_die "Runtime $part directory cannot be resolved." 3
    [[ "$resolved" == "$run_dir/$part" ]] || aiws_die "Runtime $part directory escaped containment." 3
  done
}

aiws_prepare_run_directory() {
  local run_dir="$1" expected
  expected="$(aiws_runtime_run_directory)"
  [[ "$run_dir" == "$expected" ]] || aiws_die 'Refusing to prepare an unexpected runtime path.' 3
  if [[ -e "$run_dir" || -L "$run_dir" ]]; then
    rm -rf --one-file-system -- "$run_dir"
  fi
  mkdir -m 0700 -- "$run_dir"
  mkdir -m 0700 -- "$run_dir/input" "$run_dir/host" "$run_dir/output"
  aiws_validate_run_directory "$run_dir"
}

aiws_cleanup_run_directory() {
  local run_dir="$1" expected
  expected="$(aiws_runtime_run_directory)"
  [[ "$run_dir" == "$expected" ]] || { aiws_warn 'Skipped cleanup of an unexpected runtime path.'; return 1; }
  if [[ -d "$run_dir" && ! -L "$run_dir" ]]; then chmod -R u+rwX -- "$run_dir" 2>/dev/null || true; fi
  if [[ -e "$run_dir" || -L "$run_dir" ]]; then rm -rf --one-file-system -- "$run_dir"; fi
}

aiws_validate_runtime_file() {
  local file="$1" expected="$2" resolved
  [[ "$file" == "$expected" && -f "$file" && ! -L "$file" ]] \
    || aiws_die "Runtime file is missing or unsafe: $expected" 3
  resolved="$(realpath -e -- "$file")" || aiws_die "Runtime file cannot be resolved: $expected" 3
  [[ "$resolved" == "$expected" ]] || aiws_die "Runtime file escaped containment: $expected" 3
}

aiws_automation_token() {
  local token="${AIWS_AUTOMATION_TOKEN:-${GH_TOKEN:-}}"
  [[ -n "$token" ]] || aiws_die 'AIWS_AUTOMATION_TOKEN is required for repository automation.' 2
  [[ "$token" != *$'\n'* && "$token" != *$'\r'* ]] || aiws_die 'Automation token must be one line.' 2
  printf '%s' "$token"
}
aiws_project_token() {
  local token="${AIWS_PROJECT_TOKEN:-}"
  if [[ -z "$token" && -n "${AIWS_PROJECT_TOKEN_FILE:-}" ]]; then
    token="$(<"$AIWS_PROJECT_TOKEN_FILE")"
    token="${token%$'\n'}"
  fi
  [[ -n "$token" ]] || aiws_die 'AIWS_PROJECT_TOKEN is required for Projects operations.' 2
  [[ "$token" != *$'\n'* && "$token" != *$'\r'* ]] || aiws_die 'Project token must be one line.' 2
  printf '%s' "$token"
}

# Tokens are passed only to the one gh process that needs them. Never export one globally.
aiws_gh() {
  local token="$1"; shift
  env -u AIWS_RUNNER_PAT -u AIWS_AUTOMATION_TOKEN -u AIWS_PROJECT_TOKEN \
    GH_TOKEN="$token" GITHUB_TOKEN= gh "$@"
}
aiws_repo_gh() { local token; token="$(aiws_automation_token)"; aiws_gh "$token" "$@"; }
aiws_project_gh() { local token; token="$(aiws_project_token)"; aiws_gh "$token" "$@"; }

aiws_event_value() {
  local filter="$1"
  aiws_require_env GITHUB_EVENT_PATH
  [[ -f "$GITHUB_EVENT_PATH" ]] || aiws_die "GITHUB_EVENT_PATH is not a file: $GITHUB_EVENT_PATH" 2
  jq -er "$filter // empty" "$GITHUB_EVENT_PATH" 2>/dev/null || true
}

aiws_safe_markdown() {
  # Avoid accidentally creating a gigantic GitHub comment.
  local value="$1" max="${2:-60000}"
  if (( ${#value} > max )); then printf '%s\n\n_(truncated by AIWS)_' "${value:0:max}"; else printf '%s' "$value"; fi
}

aiws_issue_comment() {
  local number="$1" body="$2"
  aiws_repo_gh issue comment "$number" --repo "$AIWS_REPOSITORY" --body "$(aiws_safe_markdown "$body")"
}
aiws_pr_comment() {
  local number="$1" body="$2"
  aiws_repo_gh pr comment "$number" --repo "$AIWS_REPOSITORY" --body "$(aiws_safe_markdown "$body")"
}

aiws_runtime_tmpdir() {
  local base="${RUNNER_TEMP:-/tmp}"
  mkdir -p "$base"
  mktemp -d "$base/aiws.XXXXXX"
}

aiws_slug() {
  local slug
  slug="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/^-*//;s/-*$//')"
  printf '%s' "${slug:-task}"
}

# Keep workflow tokens available to trusted shell functions, but do not let ordinary child
# processes inherit them. aiws_gh/aiws_git_with_token opt in one process at a time.
aiws_unexport_tokens() {
  export -n GH_TOKEN GITHUB_TOKEN AIWS_AUTOMATION_TOKEN AIWS_PROJECT_TOKEN AIWS_RUNNER_PAT \
    ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN 2>/dev/null || true
}
