#!/usr/bin/env bash
set -euo pipefail
source /opt/aiws/bin/common.sh

out="${1:?Usage: build-pr-brief.sh <output-file>}"
aiws_require_env PR_NUMBER
aiws_require_env BRANCH
aiws_require_env COMMENT_BODY

rules_file="${AIWS_RULES_FILE:-AGENTS.md}"
extra="${AIWS_EXTRA_INSTRUCTIONS:-}"
[[ "$rules_file" != /* && "$rules_file" != *'..'* && "$rules_file" != *$'\n'* ]] \
  || aiws_die 'brief.rulesFile must be a safe repository-relative path.' 2

umask 077
{
  cat <<'BRIEF'
# Request on a pull request

## Pull request number
BRIEF
  printf '%s\n' "$PR_NUMBER"
  cat <<'BRIEF'

## Pull request title
BRIEF
  printf '%s\n' "${PR_TITLE:-(untitled)}"
  cat <<'BRIEF'

You are on the pull request branch named below. Respond to the authorized review request.

## Mandatory working contract

1. Read the repository instruction files listed below first if they exist and follow them before changing code.
2. Do not run Git commit, Git push, GitHub CLI, or change branches. The trusted runner owns Git and GitHub operations.
3. If the request is a question, do not modify any file. Read the code and answer it in your final message.
4. If it requests a change, make only that change and leave a concise final summary.
5. Never read, modify, print, or create secrets, credentials, auth stores, private keys, or non-example env files.
6. Do not modify AIWS workflow/config/runtime files unless the request explicitly concerns the integration.
7. Do not run deployment commands or repository hooks. Your final message is posted verbatim.

## Working branch
BRIEF
  printf '%s\n' "$BRANCH"
  cat <<'BRIEF'

## Repository-specific extra instructions
BRIEF
  printf '%s\n' "${extra:-(None.)}"
  cat <<'BRIEF'

## Repository instruction files
BRIEF
  printf '%s\n' "${AIWS_INSTRUCTION_FILES:-(Use ${rules_file}.)}"
  cat <<'BRIEF'

## Request author
BRIEF
  printf '%s\n' "${COMMENT_AUTHOR:-repository-owner}"
  cat <<'BRIEF'

## Request
BRIEF
  printf '%s\n' "$COMMENT_BODY"

  if [[ -n "${REVIEW_FILE:-}" ]]; then
    cat <<'BRIEF'

## Inline review location

### File
BRIEF
    printf '%s\n' "$REVIEW_FILE"
    if [[ -n "${REVIEW_LINE:-}" ]]; then
      cat <<'BRIEF'

### Line
BRIEF
      printf '%s\n' "$REVIEW_LINE"
    fi
    cat <<'BRIEF'

### Review diff
BRIEF
    printf '%s\n' "${REVIEW_DIFF:-(No diff hunk supplied.)}"
  fi

  if [[ -n "${PR_BODY:-}" ]]; then
    cat <<'BRIEF'

## Pull request description
BRIEF
    printf '%s\n' "$PR_BODY"
  fi

  if [[ -n "${PR_THREAD:-}" ]]; then
    cat <<'BRIEF'

## Recent pull request discussion
BRIEF
    printf '%s\n' "$PR_THREAD"
  fi

  if [[ -n "${PR_DIFF:-}" ]]; then
    cat <<'BRIEF'

## Current pull request diff
BRIEF
    printf '%s\n' "$PR_DIFF"
  fi
} > "$out"

chmod 0600 "$out"
aiws_log 'PR brief prepared; content is intentionally not logged.'
