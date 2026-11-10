#!/usr/bin/env bash
set -euo pipefail
source /opt/aiws/bin/common.sh

out="${1:?Usage: build-issue-brief.sh <output-file>}"
aiws_require_env ISSUE_NUMBER
aiws_require_env ISSUE_TITLE
aiws_require_env BRANCH

rules_file="${AIWS_RULES_FILE:-AGENTS.md}"
extra="${AIWS_EXTRA_INSTRUCTIONS:-}"
[[ "$rules_file" != /* && "$rules_file" != *'..'* && "$rules_file" != *$'\n'* ]] \
  || aiws_die 'brief.rulesFile must be a safe repository-relative path.' 2

umask 077
{
  cat <<'BRIEF'
# Task

## Issue number
BRIEF
  printf '%s\n' "$ISSUE_NUMBER"
  cat <<'BRIEF'

## Issue title
BRIEF
  printf '%s\n' "$ISSUE_TITLE"
  cat <<'BRIEF'

You are working in an automated, isolated development container. Implement the GitHub issue below.

## Mandatory working contract

1. Read the repository instruction files listed below first if they exist and follow them.
2. Use the working branch named below. Do not run Git commit, Git push, GitHub CLI, or change branches. The trusted runner owns Git history and GitHub operations.
3. Never read, modify, print, or create secrets, credentials, auth stores, private keys, or non-example env files.
4. Do not modify AIWS-managed workflows, the tracked AIWS config, or AIWS runtime files unless the issue explicitly asks to maintain this integration.
5. Stay within the issue scope. Do not reformat or refactor unrelated files.
6. Do not run repository hooks or deployment commands. Run ordinary local validation only when the repository rules permit it.
7. Your final message will be posted verbatim. Give a concise, complete summary and mention validation not performed.

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

## Issue body
BRIEF
  printf '%s\n' "${ISSUE_BODY:-(No body was supplied; use the title and discussion.)}"

  if [[ -n "${RESUME_NOTE:-}" ]]; then
    cat <<'BRIEF'

## Resume context

This is a continuation of preserved work. Inspect the existing branch and continue it; do not start over.
BRIEF
    printf '%s\n' "$RESUME_NOTE"
  fi

  if [[ -n "${ISSUE_COMMENTS:-}" ]]; then
    cat <<'BRIEF'

## Relevant issue discussion
BRIEF
    printf '%s\n' "$ISSUE_COMMENTS"
  fi
} > "$out"

chmod 0600 "$out"
aiws_log 'Issue brief prepared; content is intentionally not logged.'
