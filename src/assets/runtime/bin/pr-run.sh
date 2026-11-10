#!/usr/bin/env bash
# Trusted PR conversation flow. Fork PRs are rejected before any checkout or agent invocation.
set -Eeuo pipefail
source /opt/aiws/bin/common.sh
source /opt/aiws/bin/git-ops.sh
source /opt/aiws/bin/load-config.sh
source /opt/aiws/bin/resolve-provider.sh

AIWS_REPOSITORY="${AIWS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
aiws_require_env AIWS_REPOSITORY
aiws_require_env GITHUB_WORKSPACE
aiws_require_env GITHUB_EVENT_PATH
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die "Invalid repository: $AIWS_REPOSITORY" 2
aiws_automation_token >/dev/null
aiws_unexport_tokens

pr="$(aiws_event_value '.issue.number // .pull_request.number')"
comment_id="$(aiws_event_value '.comment.id')"
comment_body="$(aiws_event_value '.comment.body')"
aiws_number_is_valid "$pr" || aiws_die 'The event does not contain a valid pull request number.' 2
aiws_number_is_valid "$comment_id" || aiws_die 'The event does not contain a valid comment id.' 2
[[ -n "$comment_body" ]] || aiws_die 'The PR command comment is empty.' 2

workspace="$(mkdir -p "$GITHUB_WORKSPACE" && cd "$GITHUB_WORKSPACE" && pwd -P)"
tmp="$(aiws_runtime_tmpdir)"
run_dir="$(aiws_runtime_run_directory)"
brief="$run_dir/input/brief.md"
agent_log="$run_dir/host/agent.jsonl"
agent_result="$run_dir/host/result.md"
trap 'aiws_git_scrub_credentials "$workspace" 2>/dev/null || true; aiws_cleanup_run_directory "$run_dir" 2>/dev/null || true; rm -rf "$tmp" 2>/dev/null || true' EXIT

aiws_git_init_workspace "$workspace" "$AIWS_REPOSITORY"
aiws_git_discard_untrusted_dirty "$workspace"
api_default="$(aiws_repo_gh api "repos/$AIWS_REPOSITORY" --jq .default_branch)"
aiws_git_checkout_remote "$workspace" "$api_default"

config_file="$tmp/config.json"
aiws_config_from_git "$workspace" HEAD "$config_file"
aiws_config_export_runtime
[[ "$AIWS_DEFAULT_BRANCH" == "$api_default" ]] || aiws_die 'Tracked default branch differs from GitHub.' 2

configured_command="$(jq -r '.commands.pr' "$AIWS_CONFIG")"
aiws_command_matches "$comment_body" "$configured_command" \
  || aiws_die 'PR comment does not exactly match the tracked command token.' 3
case "${GITHUB_EVENT_NAME:-}" in
  issue_comment)
    [[ "$(aiws_event_value '.issue.pull_request.url')" != '' ]] \
      || aiws_die 'PR agent issue_comment event does not identify a pull request.' 3
    ;;
  pull_request_review_comment) ;;
  *) aiws_die "Unsupported PR agent event: ${GITHUB_EVENT_NAME:-empty}" 3 ;;
esac

actor="${GITHUB_ACTOR:-$(aiws_event_value '.sender.login')}"
aiws_actor_allowed "$actor" || aiws_die "Actor is not allowed by tracked config: $actor" 3

pr_json="$(aiws_repo_gh api "repos/$AIWS_REPOSITORY/pulls/$pr")"
head_repo="$(jq -r '.head.repo.full_name // empty' <<<"$pr_json")"
head_branch="$(jq -r '.head.ref // empty' <<<"$pr_json")"
base_branch="$(jq -r '.base.ref // empty' <<<"$pr_json")"
[[ "$head_repo" == "$AIWS_REPOSITORY" ]] || {
  aiws_pr_comment "$pr" '⛔ AIWS refuses to run an agent on a fork pull request.' >/dev/null 2>&1 || true
  aiws_die "Fork PR rejected ($head_repo != $AIWS_REPOSITORY)." 3
}
aiws_ref_is_valid "$head_branch" || aiws_die "Unsafe PR head ref: $head_branch" 2
aiws_ref_is_valid "$base_branch" || aiws_die "Unsafe PR base ref: $base_branch" 2
[[ "$head_branch" != "$AIWS_DEFAULT_BRANCH" ]] || {
  # Agent commits are pushed to the PR head; that must never be the protected default branch.
  aiws_pr_comment "$pr" '⛔ AIWS refuses to commit agent work directly to the default branch.' >/dev/null 2>&1 || true
  aiws_die 'Refusing to commit agent work directly to the default branch.' 3
}
[[ "$base_branch" == "$AIWS_DEFAULT_BRANCH" ]] || aiws_warn "PR base is $base_branch, not configured default $AIWS_DEFAULT_BRANCH."

pr_body="$(jq -r '.body // ""' <<<"$pr_json")"
labels_json="$(aiws_repo_gh pr view "$pr" --repo "$AIWS_REPOSITORY" --json labels --jq '[.labels[].name]')"
aiws_resolve_profile "$labels_json" "$pr_body"
if [[ -n "${AIWS_PROFILE_IMAGE:-}" ]]; then AIWS_AGENT_IMAGE="$AIWS_PROFILE_IMAGE"; export AIWS_AGENT_IMAGE; fi

aiws_git_checkout_remote "$workspace" "$head_branch"
if [[ "$base_branch" != "$AIWS_DEFAULT_BRANCH" ]]; then aiws_git_fetch "$workspace" "$base_branch"; fi
branch="$head_branch"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${AIWS_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}"
aiws_pr_comment "$pr" "🤖 AIWS is reviewing the request with profile **$AIWS_PROFILE**. Run: $run_url"

aiws_prepare_run_directory "$run_dir"
export PR_NUMBER="$pr" BRANCH="$branch" COMMENT_BODY="$comment_body"
PR_TITLE="$(jq -r '.title' <<<"$pr_json")"
PR_BODY="$pr_body"
COMMENT_AUTHOR="$(aiws_event_value '.comment.user.login')"
max_comments="$(jq -r '.brief.maxPullRequestComments // 20' "$AIWS_CONFIG")"
if (( max_comments == 0 )); then
  PR_THREAD=''
else
  PR_THREAD="$(aiws_repo_gh pr view "$pr" --repo "$AIWS_REPOSITORY" --json comments \
    --jq "[.comments[] | select((.body | startswith(\"🤖\") or startswith(\"✅\") or startswith(\"❌\")) | not) | \"- @\\(.author.login): \\(.body)\"] | .[-${max_comments}:] | join(\"\\n\")")"
fi
git -C "$workspace" diff "refs/remotes/origin/$base_branch...HEAD" > "$tmp/pr.diff" || true
REVIEW_FILE=''; REVIEW_LINE=''; REVIEW_DIFF=''
if [[ "${GITHUB_EVENT_NAME:-}" == pull_request_review_comment ]]; then
  REVIEW_FILE="$(aiws_event_value '.comment.path')"
  REVIEW_LINE="$(aiws_event_value '.comment.line // .comment.original_line')"
  REVIEW_DIFF="$(aiws_event_value '.comment.diff_hunk')"
fi
max_chars="$(jq -r '.brief.maxCharacters // 120000' "$AIWS_CONFIG")"
COMMENT_BODY="${COMMENT_BODY:0:max_chars}"
remaining_chars=$((max_chars - ${#COMMENT_BODY}))
REVIEW_DIFF="${REVIEW_DIFF:0:remaining_chars}"
remaining_chars=$((remaining_chars - ${#REVIEW_DIFF}))
PR_BODY="${PR_BODY:0:remaining_chars}"
remaining_chars=$((remaining_chars - ${#PR_BODY}))
PR_THREAD="${PR_THREAD:0:remaining_chars}"
remaining_chars=$((remaining_chars - ${#PR_THREAD}))
PR_DIFF="$(head -c "$remaining_chars" "$tmp/pr.diff")"
AIWS_INSTRUCTION_FILES="$(jq -r '.brief.instructionFiles[]?' "$AIWS_CONFIG" | sed 's/^/- `/;s/$/`/')"
AIWS_RULES_FILE="$(jq -r '.brief.instructionFiles[0] // "AGENTS.md"' "$AIWS_CONFIG")"
AIWS_EXTRA_INSTRUCTIONS="$(jq -r '.brief.extra // ""' "$AIWS_CONFIG")"
export PR_TITLE PR_BODY COMMENT_AUTHOR PR_THREAD PR_DIFF AIWS_INSTRUCTION_FILES AIWS_RULES_FILE AIWS_EXTRA_INSTRUCTIONS
export REVIEW_FILE REVIEW_LINE REVIEW_DIFF
/opt/aiws/bin/build-pr-brief.sh "$brief"
chmod 0400 "$brief"
aiws_validate_run_directory "$run_dir"
aiws_validate_runtime_file "$brief" "$run_dir/input/brief.md"

export AIWS_RUN_DIR="$run_dir" AIWS_BRIEF_FILE="$brief"
export AIWS_AGENT_LOG="$agent_log" AIWS_AGENT_RESULT="$agent_result"
AIWS_AGENT_TIMEOUT_MINUTES="$AIWS_PR_TIMEOUT_MINUTES"; export AIWS_AGENT_TIMEOUT_MINUTES
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
  printf '%s\n' 'AIWS reverted an attempted modification to a protected path.' >> "$tmp/result.md"
fi

changed=false
if [[ -n "$(git -C "$workspace" status --porcelain)" ]]; then
  changed=true
  git -C "$workspace" add -A
  summary="$(tr '\n' ' ' < "$tmp/result.md" | sed 's/[[:space:]]\+/ /g;s/^ //;s/ $//' | cut -c1-72)"
  [[ -n "$summary" ]] || summary="Address PR #$pr review request"
  git -c core.hooksPath=/opt/aiws/empty-hooks -C "$workspace" commit \
    -m "$(printf '%s\n\nPR #%s review request\n\nAIWS-Profile: %s' "$summary" "$pr" "$AIWS_PROFILE")"
  if ! aiws_git_push_branch_safely "$workspace" "$branch"; then
    recovery="${branch}-run-${GITHUB_RUN_ID:-recovery}"
    aiws_git_push_ref "$workspace" HEAD "$recovery" || true
    aiws_pr_comment "$pr" "❌ The PR branch advanced and automatic rebase conflicted. Work was preserved on \`$recovery\`. Run: $run_url" || true
    exit 1
  fi
fi

answer="$(<"$tmp/result.md")"
[[ -n "$answer" ]] || answer='The agent did not produce a final message.'
if (( agent_status != 0 )); then
  header='❌ The agent exited unsuccessfully.'
elif [[ "$changed" == true ]]; then
  files="$(git -C "$workspace" diff --name-only HEAD~1 HEAD | sed -n '1,30{s/^/- `/;s/$/`/;p}')"
  header="$(printf '✅ Changes were committed to `%s`.\n\n### Changed files\n%s' "$branch" "$files")"
else
  header='💬 Answer (no files changed):'
fi
body="$(printf '%s\n\n---\n\n%s\n\n<sub>Profile: %s · Run: %s</sub>' "$header" "$answer" "$AIWS_PROFILE" "$run_url")"

if [[ "${GITHUB_EVENT_NAME:-}" == pull_request_review_comment ]]; then
  aiws_repo_gh api "repos/$AIWS_REPOSITORY/pulls/$pr/comments/$comment_id/replies" -f body="$(aiws_safe_markdown "$body")" >/dev/null 2>&1 \
    || aiws_pr_comment "$pr" "$body"
else
  aiws_pr_comment "$pr" "$body"
fi
(( agent_status == 0 ))
