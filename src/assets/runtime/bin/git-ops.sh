#!/usr/bin/env bash
# Credential-ephemeral git operations. No token is written to .git/config or a remote URL.

source /opt/aiws/bin/common.sh

aiws_git_scrub_credentials() {
  local repo="$1"
  [[ -d "$repo/.git" ]] || return 0
  git -C "$repo" config --local --unset-all credential.helper 2>/dev/null || true
  git -C "$repo" config --local --unset-all core.hooksPath 2>/dev/null || true
  git -C "$repo" config --local --unset-all core.sshCommand 2>/dev/null || true
  git -C "$repo" config --local --unset-all core.fsmonitor 2>/dev/null || true
  git -C "$repo" config --local commit.gpgSign false
  while IFS= read -r key; do
    [[ -n "$key" ]] && git -C "$repo" config --local --unset-all "$key" 2>/dev/null || true
  done < <(git -C "$repo" config --local --name-only --get-regexp '^http\..*\.extraheader$' 2>/dev/null || true)
  while IFS= read -r key; do
    [[ -n "$key" ]] && git -C "$repo" config --local --unset-all "$key" 2>/dev/null || true
  done < <(git -C "$repo" config --local --name-only --get-regexp \
    '^(include|includeIf)\.|^filter\..*\.(clean|smudge|process)$|^diff\..*\.command$|^merge\..*\.driver$|^url\..*\.insteadOf$' \
    2>/dev/null || true)
  local url
  url="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
  if [[ "$url" =~ ^https://[^/@]+@github\.com/ ]]; then
    url="https://github.com/${url#*@github.com/}"
    git -C "$repo" remote set-url origin "$url"
  fi
}

aiws_git_sparse_reset() {
  local repo="$1"
  [[ -d "$repo/.git" ]] || return 0
  git -C "$repo" config --local --unset-all core.sparseCheckout 2>/dev/null || true
  git -C "$repo" config --local --unset-all core.sparseCheckoutCone 2>/dev/null || true
  git -C "$repo" config --local --unset-all extensions.worktreeConfig 2>/dev/null || true
  rm -f "$repo/.git/info/sparse-checkout" "$repo/.git/config.worktree"
  git -C "$repo" ls-files -t 2>/dev/null \
    | awk '$1 == "S" { $1=""; sub(/^ /, ""); print }' \
    | tr '\n' '\0' \
    | xargs -0 -r git -C "$repo" update-index --no-skip-worktree -- 2>/dev/null || true
}

aiws_git_with_token() {
  local token="$1" repo="$2"; shift 2
  local ask_dir askpass rc
  ask_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/aiws-askpass.XXXXXX")"
  askpass="$ask_dir/askpass.sh"
  cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "${1:-}" in
  *sername*) printf '%s\n' 'x-access-token' ;;
  *assword*) printf '%s\n' "${AIWS_GIT_TOKEN:?}" ;;
  *) printf '\n' ;;
esac
ASKPASS
  chmod 0700 "$askpass"
  set +e
  env -u GH_TOKEN -u GITHUB_TOKEN -u AIWS_AUTOMATION_TOKEN -u AIWS_PROJECT_TOKEN \
    AIWS_GIT_TOKEN="$token" GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= -c core.askPass="$askpass" \
      -c core.hooksPath=/opt/aiws/empty-hooks -C "$repo" "$@"
  rc=$?
  set -e
  rm -rf "$ask_dir"
  unset token
  aiws_git_scrub_credentials "$repo"
  return "$rc"
}

aiws_git_init_workspace() {
  local repo="$1" repository="$2"
  aiws_repo_is_valid "$repository" || aiws_die "Unsafe repository slug: $repository" 2
  mkdir -p "$repo"
  if [[ ! -d "$repo/.git" ]]; then git -C "$repo" init --quiet; fi
  git -C "$repo" config user.name "${AIWS_GIT_AUTHOR_NAME:-aiws-agent}"
  git -C "$repo" config user.email "${AIWS_GIT_AUTHOR_EMAIL:-noreply@github.com}"
  git -C "$repo" config gc.auto 0
  local remote="https://github.com/${repository}.git"
  if git -C "$repo" remote get-url origin >/dev/null 2>&1; then
    git -C "$repo" remote set-url origin "$remote"
  else
    git -C "$repo" remote add origin "$remote"
  fi
  aiws_git_scrub_credentials "$repo"
  aiws_git_sparse_reset "$repo"
}

# Security boundary used before every trusted checkout. Uncommitted content is never promoted
# before the tracked config/protected-path policy is known. Interrupted agent work is normally
# committed by issue-run even on provider failure; an abruptly killed, uncommitted tree is dropped.
aiws_git_discard_untrusted_dirty() {
  local repo="$1"
  [[ -d "$repo/.git" ]] || return 0
  aiws_git_scrub_credentials "$repo"
  aiws_git_sparse_reset "$repo"
  if git -C "$repo" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -c core.hooksPath=/opt/aiws/empty-hooks -C "$repo" reset --hard HEAD >/dev/null
  fi
  git -C "$repo" clean -ffdx >/dev/null
}

aiws_git_fetch() {
  local repo="$1" ref="$2" token
  aiws_ref_is_valid "$ref" || aiws_die "Unsafe git ref: $ref" 2
  token="$(aiws_automation_token)"
  aiws_git_with_token "$token" "$repo" fetch --no-tags --prune origin "+refs/heads/${ref}:refs/remotes/origin/${ref}"
}

aiws_git_checkout_remote() {
  local repo="$1" ref="$2"
  aiws_git_fetch "$repo" "$ref"
  git -c core.hooksPath=/opt/aiws/empty-hooks -C "$repo" \
    switch --force-create "$ref" "refs/remotes/origin/$ref"
  git -C "$repo" reset --hard "refs/remotes/origin/$ref"
  git -C "$repo" clean -ffdx
  aiws_git_scrub_credentials "$repo"
}

aiws_git_remote_branch_exists() {
  local repo="$1" branch="$2" token output
  aiws_ref_is_valid "$branch" || return 1
  token="$(aiws_automation_token)"
  output="$(aiws_git_with_token "$token" "$repo" ls-remote --heads origin "refs/heads/$branch")" || return 2
  [[ -n "$output" ]]
}

aiws_git_push_ref() {
  local repo="$1" source="$2" branch="$3" token
  aiws_ref_is_valid "$branch" || aiws_die "Unsafe push branch: $branch" 2
  token="$(aiws_automation_token)"
  aiws_git_with_token "$token" "$repo" push origin "${source}:refs/heads/${branch}"
}

aiws_git_push_branch_safely() {
  local repo="$1" branch="$2"
  if aiws_git_push_ref "$repo" HEAD "$branch"; then return 0; fi
  aiws_warn "Remote branch advanced; rebasing without force-push: $branch"
  aiws_git_fetch "$repo" "$branch"
  if ! git -c core.hooksPath=/opt/aiws/empty-hooks -C "$repo" rebase "refs/remotes/origin/$branch"; then
    git -C "$repo" rebase --abort 2>/dev/null || true
    return 1
  fi
  aiws_git_push_ref "$repo" HEAD "$branch"
}
