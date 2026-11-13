#!/usr/bin/env bash
# Root supervisor: initialize volumes/register, then run the actual Actions listener as non-root.
set -euo pipefail
source /opt/aiws/bin/common.sh

[[ "$(id -u)" == 0 ]] || aiws_die 'runner-entrypoint.sh must start as root so it can initialize named volumes.' 2
AIWS_REPOSITORY="${AIWS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
aiws_require_env AIWS_REPOSITORY
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die "Invalid repository slug: $AIWS_REPOSITORY" 2

state="${AIWS_RUNNER_STATE_DIR:-/var/lib/aiws/runner}"
work="${AIWS_RUNNER_WORK_ROOT:-/var/lib/aiws/work}"
io="${AIWS_RUNTIME_IO_ROOT:-/var/lib/aiws/io}"
[[ "$state" == /var/lib/aiws/runner && "$work" == /var/lib/aiws/work && "$io" == /var/lib/aiws/io ]] \
  || aiws_die 'Runner state/work/runtime paths must use the immutable image mount points.' 2
name="${AIWS_RUNNER_NAME:-aiws-$(hostname)}"
labels="${AIWS_RUNNER_LABELS:-self-hosted,linux,aiws}"
pat="$(aiws_read_secret AIWS_RUNNER_PAT_FILE AIWS_RUNNER_PAT)"
repo_url="https://github.com/${AIWS_REPOSITORY}"
api="https://api.github.com/repos/${AIWS_REPOSITORY}/actions/runners"
api_version="${AIWS_GITHUB_API_VERSION:-2026-03-10}"
[[ "$api_version" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || aiws_die 'Invalid AIWS_GITHUB_API_VERSION.' 2

mkdir -p "$state" "$work" "$io"
if [[ ! -f "$state/.aiws-runner-version" ]] \
   || ! cmp -s /opt/actions-runner-dist/.aiws-runner-version "$state/.aiws-runner-version"; then
  aiws_log 'Installing the Actions runner distribution into persistent state.'
  find "$state" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a /opt/actions-runner-dist/. "$state/"
fi
chown -R runner:runner "$state"
chmod -R u+rwX "$state"
chown runner:runner "$work" "$io"
chmod 0750 "$state" "$work"
chmod 0700 "$io"
# Runtime I/O is per-job and never a recovery source. Clear stale directories only from the
# exact, immutable named-volume mount before the listener can accept work.
find "$io" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} +

api_token() {
  local endpoint="$1"
  # The PAT header is read from stdin so it never appears in the process list.
  printf 'Authorization: Bearer %s\n' "$pat" | curl -fsSL --retry 3 -X POST \
    -H @- \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: ${api_version}" \
    "${api}/${endpoint}" | jq -er '.token'
}

cd "$state"
remove_registration() {
  [[ -f .runner ]] || return 0
  local token
  token="$(api_token remove-token 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    env HOME=/home/runner USER=runner LOGNAME=runner gosu runner:runner \
      ./config.sh remove --token "$token" >/dev/null 2>&1 || true
  fi
  rm -f .runner .credentials .credentials_rsaparams .path .env
}

# A recreated/rebooted container may retain local registration state. Remove it with the
# dedicated removal token, then --replace the same runner name server-side.
if [[ -f .runner ]]; then
  aiws_log 'Removing stale local runner registration before restart.'
  remove_registration
fi
registration="$(api_token registration-token)" \
  || aiws_die 'Could not obtain a runner registration token; check PAT repository administration permission.' 2

aiws_log "Registering repository-scoped runner '$name'."
env HOME=/home/runner USER=runner LOGNAME=runner gosu runner:runner ./config.sh \
  --unattended --replace --disableupdate \
  --url "$repo_url" --token "$registration" \
  --name "$name" --labels "$labels" --work "$work"
unset registration

child=''
stopping=0
shutdown() {
  (( stopping == 0 )) || return 0
  stopping=1
  trap - INT TERM
  if [[ -n "$child" ]]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  aiws_log 'Removing GitHub runner registration.'
  remove_registration
}
trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

# The long-lived listener receives neither the PAT nor any Compose secret path/value.
env -u AIWS_RUNNER_PAT -u AIWS_RUNNER_PAT_FILE -u GH_TOKEN -u GITHUB_TOKEN \
  -u AIWS_AUTOMATION_TOKEN -u AIWS_PROJECT_TOKEN \
  HOME=/home/runner USER=runner LOGNAME=runner \
  gosu runner:runner ./run.sh &
child=$!
set +e
wait "$child"
rc=$?
set -e
child=''
shutdown
exit "$rc"
