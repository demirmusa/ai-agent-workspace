#!/usr/bin/env bash
# Trusted issue lifecycle: checkout -> profile -> ephemeral agent -> commit/push -> PR/status.
set -Eeuo pipefail
source /opt/aiws/bin/common.sh
source /opt/aiws/bin/git-ops.sh
source /opt/aiws/bin/load-config.sh
source /opt/aiws/bin/resolve-provider.sh

AIWS_REPOSITORY="${AIWS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
aiws_require_env AIWS_REPOSITORY
aiws_require_env GITHUB_WORKSPACE
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die "Invalid repository: $AIWS_REPOSITORY" 2
aiws_automation_token >/dev/null
aiws_unexport_tokens

workspace="$(mkdir -p "$GITHUB_WORKSPACE" && cd "$GITHUB_WORKSPACE" && pwd -P)"
tmp="$(aiws_runtime_tmpdir)"
run_dir="$(aiws_runtime_run_directory)"
brief="$run_dir/input/brief.md"
agent_log="$run_dir/host/agent.jsonl"
agent_result="$run_dir/host/result.md"
issue=''
item_id=''
branch=''
finalized=0
started=0
report_written=0

project_cmd() {
  local -a project_env=(env AIWS_CONFIG="$AIWS_CONFIG" AIWS_REPOSITORY="$AIWS_REPOSITORY"
    AIWS_AUTOMATION_TOKEN="$(aiws_automation_token)")
  if [[ -n "${AIWS_PROJECT_TOKEN:-}" ]]; then project_env+=(AIWS_PROJECT_TOKEN="$AIWS_PROJECT_TOKEN"); fi
  "${project_env[@]}" /opt/aiws/bin/project.sh "$@"
}

finalize() {
  local rc=$?
  trap - EXIT
  aiws_git_scrub_credentials "$workspace" 2>/dev/null || true
  aiws_cleanup_run_directory "$run_dir" 2>/dev/null || true
  rm -rf "$tmp" 2>/dev/null || true
  if [[ -n "$issue" && "$started" == 1 ]]; then
    aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --remove-label "$AIWS_LABEL_RUNNING" >/dev/null 2>&1 || true
    if [[ "$finalized" != 1 ]]; then
      aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --add-label "$AIWS_LABEL_FAILED" >/dev/null 2>&1 || true
      if [[ "$report_written" != 1 ]]; then
        aiws_issue_comment "$issue" "❌ AIWS run stopped before it could finish safely. Existing committed work was not force-pushed. Run: ${GITHUB_SERVER_URL:-https://github.com}/${AIWS_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}" >/dev/null 2>&1 || true
      fi
    fi
  fi
  exit "$rc"
}
trap finalize EXIT

aiws_git_init_workspace "$workspace" "$AIWS_REPOSITORY"
aiws_git_discard_untrusted_dirty "$workspace"

api_default="$(aiws_repo_gh api "repos/$AIWS_REPOSITORY" --jq .default_branch)"
aiws_ref_is_valid "$api_default" || aiws_die "GitHub returned an unsafe default branch: $api_default" 2
aiws_group "Checkout trusted default branch $api_default"
aiws_git_checkout_remote "$workspace" "$api_default"
aiws_endgroup

config_file="$tmp/config.json"
aiws_config_from_git "$workspace" HEAD "$config_file"
aiws_config_export_runtime
[[ "$AIWS_DEFAULT_BRANCH" == "$api_default" ]] \
  || aiws_die "Tracked defaultBranch '$AIWS_DEFAULT_BRANCH' differs from GitHub '$api_default'." 2

# Workflow filters are only an optimization. Re-authorize the event from the exact tracked
# command/labels before any target branch is selected.
event_name="${GITHUB_EVENT_NAME:-}"
if [[ "${AIWS_QUEUE_MODE:-}" == project || "${AIWS_QUEUE_MODE:-}" == scheduled ]]; then
  [[ "$event_name" == workflow_dispatch ]] \
    || aiws_die 'Project queue mode is only valid for workflow_dispatch.' 3
else
  [[ -z "${AIWS_QUEUE_MODE:-}" ]] || aiws_die 'Unsupported AIWS_QUEUE_MODE.' 2
  case "$event_name" in
    issues)
      event_label="$(aiws_event_value '.label.name')"
      label_allowed="$(jq -r --arg trigger_label "$event_label" \
        '$trigger_label == .queue.labels.ready or $trigger_label == .queue.labels.continue or $trigger_label == (.queue.labels.run // "agent-run")' "$AIWS_CONFIG")"
      [[ "$label_allowed" == true ]] || aiws_die 'Issue label does not exactly match a tracked agent trigger.' 3
      ;;
    issue_comment)
      [[ "$(aiws_event_value '.issue.pull_request.url')" == '' ]] \
        || aiws_die 'Issue agent commands cannot target pull requests.' 3
      event_command="$(aiws_event_value '.comment.body')"
      configured_command="$(jq -r '.commands.issue' "$AIWS_CONFIG")"
      aiws_command_matches "$event_command" "$configured_command" \
        || aiws_die 'Issue comment does not exactly match the tracked command token.' 3
      ;;
    *) aiws_die "Unsupported issue agent event: ${event_name:-empty}" 3 ;;
  esac
fi

actor="${GITHUB_ACTOR:-$(aiws_event_value '.sender.login')}"
aiws_actor_allowed "$actor" || aiws_die "Actor is not allowed by tracked config: $actor" 3

if [[ "${AIWS_QUEUE_MODE:-}" == project ]]; then
  [[ -n "${AIWS_PROJECT_TOKEN:-}" ]] || aiws_die 'Project queue run requires AIWS_PROJECT_TOKEN.' 2
  next="$(project_cmd next)"
  [[ -n "$next" ]] || { aiws_log 'No unblocked Ready issue is currently queued.'; finalized=1; exit 0; }
  IFS=$'\t' read -r item_id issue <<<"$next"
else
  issue="${AIWS_ISSUE_NUMBER:-$(aiws_event_value '.issue.number // .inputs.issue_number // .client_payload.issue_number')}"
fi
aiws_number_is_valid "$issue" || aiws_die 'The event does not contain a valid issue number.' 2

issue_json="$(aiws_repo_gh issue view "$issue" --repo "$AIWS_REPOSITORY" --json number,title,body,labels,comments,state)"
if jq -e '(.body // "") | contains("<!-- aiws-task:")' <<<"$issue_json" >/dev/null; then
  aiws_log "Issue #$issue is owned by the Control Center; skipping the legacy runner."
  finalized=1
  exit 0
fi
[[ "$(jq -r '.state' <<<"$issue_json")" == OPEN ]] || { aiws_log "Issue #$issue is not open; skipping."; finalized=1; exit 0; }
labels_json="$(jq -c '[.labels[].name]' <<<"$issue_json")"
if [[ "$event_name" == issues ]] && [[ "$(jq -r --arg trigger_label "$event_label" 'index($trigger_label) != null' <<<"$labels_json")" != true ]]; then
  aiws_log 'Trigger label was removed; skipping this stale event.'
  finalized=1; exit 0
fi
if [[ "${AIWS_QUEUE_MODE:-}" != scheduled && "$(jq -r '.orchestration.enabled != false' "$AIWS_CONFIG")" == true ]]; then
  # Event jobs only enqueue. The durable scheduler owns capacity and dependencies.
  aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" \
    --add-label "$AIWS_LABEL_GO" --remove-label "$AIWS_LABEL_FAILED" --remove-label "$AIWS_LABEL_DONE"
  aiws_log "Issue #$issue is queued; the scheduler will start it when dependencies and capacity allow."
  finalized=1; exit 0
fi
if [[ "${AIWS_QUEUE_MODE:-}" == scheduled ]]; then
  # Recheck queue membership at execution time: it may have changed while Actions queued.
  AIWS_AUTOMATION_TOKEN="$(aiws_automation_token)" AIWS_PROJECT_TOKEN="${AIWS_PROJECT_TOKEN:-}" \
    python3 /opt/aiws/bin/scheduler.py check --issue "$issue" || { finalized=1; exit 0; }
fi
if [[ "$event_name" == issues ]] \
   && [[ "$(jq -r --arg trigger_label "$event_label" 'index($trigger_label) != null' <<<"$labels_json")" != true ]]; then
  aiws_log "Trigger label '$event_label' is no longer present; skipping the stale queued event."
  finalized=1
  exit 0
fi
aiws_resolve_profile "$labels_json"
if [[ -n "${AIWS_PROFILE_IMAGE:-}" ]]; then AIWS_AGENT_IMAGE="$AIWS_PROFILE_IMAGE"; export AIWS_AGENT_IMAGE; fi

if [[ -z "$item_id" ]]; then
  queue_mode="$(jq -r '.queue.mode' "$AIWS_CONFIG")"
  if [[ "$queue_mode" == project || "$queue_mode" == both ]]; then
    item_id="$(project_cmd item "$issue")"
  fi
fi

blockers="$(project_cmd blockers "$issue")"
if [[ -n "$blockers" ]]; then
  waiting_label="$(jq -r '.queue.labels.waiting // "agent:waiting"' "$AIWS_CONFIG")"
  aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --add-label "$waiting_label" >/dev/null
  aiws_log "Issue #$issue is waiting for dependencies: $blockers. It stays queued."
  finalized=1
  exit 0
fi

title="$(jq -r '.title' <<<"$issue_json")"
slug="$(aiws_slug "$title")"
prefix="agent/issue-${issue}-"
existing="$(git -C "$workspace" for-each-ref --format='%(refname:short)' "refs/remotes/origin/${prefix}*" \
  | sed 's|^origin/||' | grep -v -- '-salvage-' | head -n 1 || true)"
# Fetch matching refs because the default checkout fetches only one branch.
token="$(aiws_automation_token)"
remote_matches="$(aiws_git_with_token "$token" "$workspace" ls-remote --heads origin "refs/heads/${prefix}*")"
unset token
if [[ -n "$remote_matches" ]]; then existing="$(sed 's|.*refs/heads/||' <<<"$remote_matches" | grep -v -- '-salvage-' | sed -n '1p')"; fi
continue_requested="$(jq -r --arg trigger_label "$AIWS_LABEL_CONTINUE" 'index($trigger_label) != null' <<<"$labels_json")"

mode=fresh
existing_pr=''
if [[ "$continue_requested" == true && -n "$existing" ]]; then
  branch="$existing"
  aiws_git_checkout_remote "$workspace" "$branch"
  mode=continue
  existing_pr="$(aiws_repo_gh pr list --repo "$AIWS_REPOSITORY" --head "$branch" --state open --json number --jq '.[0].number // empty')"
  if [[ -n "$existing_pr" ]]; then
    existing_pr_body="$(aiws_repo_gh pr view "$existing_pr" --repo "$AIWS_REPOSITORY" --json body --jq '.body // ""')"
    aiws_resolve_profile "$labels_json" "$existing_pr_body"
    if [[ -n "${AIWS_PROFILE_IMAGE:-}" ]]; then AIWS_AGENT_IMAGE="$AIWS_PROFILE_IMAGE"; export AIWS_AGENT_IMAGE; fi
  fi
else
  branch="${prefix}${slug}"
  revision=2
  while :; do
    set +e
    aiws_git_remote_branch_exists "$workspace" "$branch"
    branch_status=$?
    set -e
    if (( branch_status == 1 )); then break; fi
    (( branch_status == 0 )) || aiws_die 'Could not determine whether the remote branch exists.' 1
    branch="${prefix}${slug}-r${revision}"
    revision=$((revision + 1))
  done
  git -c core.hooksPath=/opt/aiws/empty-hooks -C "$workspace" \
    switch --force-create "$branch" "refs/remotes/origin/$AIWS_DEFAULT_BRANCH"
fi
aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --remove-label "$AIWS_LABEL_CONTINUE" >/dev/null 2>&1 || true

started=1
run_label="$(jq -r '.queue.labels.run // "agent-run"' "$AIWS_CONFIG")"
waiting_label="$(jq -r '.queue.labels.waiting // "agent:waiting"' "$AIWS_CONFIG")"
aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" \
  --remove-label "$AIWS_LABEL_GO" --remove-label "$AIWS_LABEL_DONE" --remove-label "$AIWS_LABEL_FAILED" \
  --remove-label "$run_label" --remove-label "$waiting_label" --add-label "$AIWS_LABEL_RUNNING" >/dev/null
if [[ -n "$item_id" ]]; then
  in_progress="$(jq -r '.queue.project.inProgress // "In progress"' "$AIWS_CONFIG")"
  project_cmd status "$item_id" "$in_progress"
fi
run_url="${GITHUB_SERVER_URL:-https://github.com}/${AIWS_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}"
aiws_issue_comment "$issue" "🤖 AIWS started with profile **$AIWS_PROFILE** ($AIWS_PROVIDER / ${AIWS_MODEL:-provider default}). Run: $run_url"

aiws_prepare_run_directory "$run_dir"
export ISSUE_NUMBER="$issue" ISSUE_TITLE="$title" BRANCH="$branch"
ISSUE_BODY="$(jq -r '.body // ""' <<<"$issue_json")"
max_comments="$(jq -r '.brief.maxIssueComments // 30' "$AIWS_CONFIG")"
if (( max_comments == 0 )); then
  ISSUE_COMMENTS=''
else
  ISSUE_COMMENTS="$(jq -r --argjson max "$max_comments" '
    [.comments[] | select((.body | startswith("🤖") or startswith("✅") or startswith("❌")) | not)
     | "- @\(.author.login): \(.body)"] | .[-$max:] | join("\n")
  ' <<<"$issue_json")"
fi
max_chars="$(jq -r '.brief.maxCharacters // 120000' "$AIWS_CONFIG")"
ISSUE_BODY="${ISSUE_BODY:0:max_chars}"
remaining_chars=$((max_chars - ${#ISSUE_BODY}))
ISSUE_COMMENTS="${ISSUE_COMMENTS:0:remaining_chars}"
AIWS_INSTRUCTION_FILES="$(jq -r '.brief.instructionFiles[]?' "$AIWS_CONFIG" | sed 's/^/- `/;s/$/`/')"
AIWS_RULES_FILE="$(jq -r '.brief.instructionFiles[0] // "AGENTS.md"' "$AIWS_CONFIG")"
AIWS_EXTRA_INSTRUCTIONS="$(jq -r '.brief.extra // ""' "$AIWS_CONFIG")"
export ISSUE_BODY ISSUE_COMMENTS AIWS_INSTRUCTION_FILES AIWS_RULES_FILE AIWS_EXTRA_INSTRUCTIONS
if [[ "$mode" == continue ]]; then
  RESUME_NOTE="$(git -C "$workspace" diff --stat "refs/remotes/origin/$AIWS_DEFAULT_BRANCH...HEAD" | tail -n 50)"
  export RESUME_NOTE
fi
AIWS_RUN_DIR="$run_dir" AIWS_BRIEF_FILE="$brief" /opt/aiws/bin/build-issue-brief.sh "$brief"
chmod 0400 "$brief"
aiws_validate_run_directory "$run_dir"
aiws_validate_runtime_file "$brief" "$run_dir/input/brief.md"

export AIWS_RUN_DIR="$run_dir" AIWS_BRIEF_FILE="$brief"
export AIWS_AGENT_LOG="$agent_log" AIWS_AGENT_RESULT="$agent_result"
set +e
/opt/aiws/bin/run-agent.sh
agent_status=$?
set -e
aiws_validate_run_directory "$run_dir"
if [[ -f "$agent_result" && ! -L "$agent_result" ]]; then
  aiws_validate_runtime_file "$agent_result" "$run_dir/host/result.md"
  cp -f -- "$agent_result" "$tmp/result.md"
else
  : > "$tmp/result.md"
  agent_status=1
fi
aiws_cleanup_run_directory "$run_dir"

protected_hit=0
aiws_restore_protected_changes "$workspace" || protected_hit=1
if (( protected_hit )); then
  agent_status=1
  printf '%s\n' 'The agent attempted to modify a protected path; AIWS reverted that part of the change.' >> "$tmp/result.md"
fi

changed=false
if [[ -n "$(git -C "$workspace" status --porcelain)" ]]; then
  git -C "$workspace" add -A
  git -c core.hooksPath=/opt/aiws/empty-hooks -C "$workspace" commit -m "$(printf '%s\n\nCloses #%s\n\nAIWS-Profile: %s' "$title" "$issue" "$AIWS_PROFILE")"
fi
if ! git -C "$workspace" diff --quiet "refs/remotes/origin/$AIWS_DEFAULT_BRANCH...HEAD"; then
  changed=true
  if ! aiws_git_push_branch_safely "$workspace" "$branch"; then
    recovery="${branch}-run-${GITHUB_RUN_ID:-recovery}"
    aiws_git_push_ref "$workspace" HEAD "$recovery" || true
    aiws_die "Branch advanced and rebase conflicted; work was preserved on $recovery." 1
  fi
fi

answer="$(<"$tmp/result.md")"
[[ -n "$answer" ]] || answer='The agent did not produce a final message.'
marker="$(aiws_profile_marker)"
files="$(git -C "$workspace" diff --name-only "refs/remotes/origin/$AIWS_DEFAULT_BRANCH...HEAD" | sed -n '1,40{s/^/- `/;s/$/`/;p}')"
pr_url=''
if [[ "$changed" == true ]]; then
  if [[ -n "$existing_pr" ]]; then
    pr_url="$(aiws_repo_gh pr view "$existing_pr" --repo "$AIWS_REPOSITORY" --json url --jq .url)"
    if (( agent_status == 0 )); then aiws_repo_gh pr ready "$existing_pr" --repo "$AIWS_REPOSITORY" >/dev/null 2>&1 || true; fi
    aiws_repo_gh pr edit "$existing_pr" --repo "$AIWS_REPOSITORY" --body "$(printf '%s\n\nCloses #%s\n\nContinued automated work. Run: %s' "$marker" "$issue" "$run_url")" >/dev/null 2>&1 || true
  else
    draft_args=()
    (( agent_status == 0 )) || draft_args+=(--draft)
    pr_url="$(aiws_repo_gh pr create --repo "$AIWS_REPOSITORY" --base "$AIWS_DEFAULT_BRANCH" --head "$branch" \
      "${draft_args[@]}" --title "$title (#$issue)" \
      --body "$(printf '%s\n\nCloses #%s\n\nAutomated AIWS run: %s\nProfile: **%s** (%s / %s)' "$marker" "$issue" "$run_url" "$AIWS_PROFILE" "$AIWS_PROVIDER" "${AIWS_MODEL:-provider default}")")"
  fi
fi

if (( agent_status == 0 )) && [[ "$changed" == true ]]; then
  if [[ -n "$item_id" ]]; then
    in_review="$(jq -r '.queue.project.inReview // "In review"' "$AIWS_CONFIG")"
    project_cmd status "$item_id" "$in_review"
  fi
  aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --remove-label "$AIWS_LABEL_RUNNING" --remove-label "$AIWS_LABEL_FAILED" --add-label "$AIWS_LABEL_DONE" >/dev/null 2>&1 || true
  aiws_issue_comment "$issue" "$(printf '✅ AIWS completed.\n\nPR: %s\n\n### Changed files\n%s\n\n### Agent result\n%s\n\nRun: %s' "$pr_url" "${files:-_(none)_}" "$answer" "$run_url")"
  finalized=1; report_written=1
  exit 0
fi

aiws_repo_gh issue edit "$issue" --repo "$AIWS_REPOSITORY" --remove-label "$AIWS_LABEL_RUNNING" --add-label "$AIWS_LABEL_FAILED" >/dev/null 2>&1 || true
if [[ "$changed" == true ]]; then
  detail="Partial work is preserved in draft PR: $pr_url. Add \`$AIWS_LABEL_CONTINUE\` to resume it."
else
  detail='No repository changes were produced.'
fi
aiws_issue_comment "$issue" "$(printf '❌ AIWS did not complete successfully. %s\n\n### Agent result\n%s\n\nRun: %s' "$detail" "$answer" "$run_url")"
report_written=1
exit 1
