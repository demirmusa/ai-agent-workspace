#!/usr/bin/env bash
# Runs only inside the disposable Docker smoke-test container; no GitHub/provider calls.
set -euo pipefail
source /opt/aiws/bin/common.sh
mkdir -p /var/lib/aiws/work/repo/repo /var/lib/aiws/io /tmp/aiws-mocks
git -C /var/lib/aiws/work/repo/repo init -q
cat > /tmp/aiws-mocks/docker <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  container) exit 1 ;;
  run)
    printf '%s\n' "$@" > /tmp/aiws-docker-arguments
    if [[ "${AIWS_MOCK_ERROR:-}" == 1 ]]; then
      printf '%s\n' '{"type":"error","error":{"message":"mock provider failure"}}'
      exit 0
    fi
    case "$AIWS_PROVIDER" in
      claude) printf '%s\n' '{"type":"result","result":"verified"}' ;;
      codex) printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"verified"}}' ;;
      opencode) printf '%s\n' '{"type":"text","part":{"text":"verified"}}' ;;
    esac
    ;;
  *) exit 1 ;;
esac
MOCK
chmod 0755 /tmp/aiws-mocks/docker
export PATH="/tmp/aiws-mocks:$PATH"
export GITHUB_WORKSPACE=/var/lib/aiws/work/repo/repo AIWS_REPOSITORY=owner/repo
export GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 AIWS_PROFILE=test AIWS_EFFORT=medium
export AIWS_WORKSPACE_VOLUME=aiws-test-work AIWS_RUNTIME_IO_VOLUME=aiws-test-io
export AIWS_CLAUDE_AUTH_VOLUME=aiws-test-claude AIWS_CODEX_AUTH_VOLUME=aiws-test-codex AIWS_OPENCODE_AUTH_VOLUME=aiws-test-opencode
export AIWS_AGENT_IMAGE=aiws-test-agent AIWS_READ_ONLY=true
export AIWS_AUTOMATION_TOKEN=must-not-reach-provider
run_dir="$(aiws_runtime_run_directory)"
for provider in claude codex opencode; do
  export AIWS_PROVIDER="$provider"
  aiws_prepare_run_directory "$run_dir"
  printf 'test prompt\n' > "$run_dir/input/brief.md"
  export AIWS_RUN_DIR="$run_dir" AIWS_BRIEF_FILE="$run_dir/input/brief.md"
  export AIWS_AGENT_LOG="$run_dir/host/agent.jsonl" AIWS_AGENT_RESULT="$run_dir/host/result.md"
  /opt/aiws/bin/run-agent.sh
  [[ "$(cat "$AIWS_AGENT_RESULT")" == verified ]]
  grep -F 'volume-subpath=repo/repo,readonly' /tmp/aiws-docker-arguments >/dev/null
  if grep -F 'must-not-reach-provider' /tmp/aiws-docker-arguments; then exit 1; fi
  if grep -E 'AIWS_(AUTOMATION|PROJECT|RUNNER)_TOKEN=' /tmp/aiws-docker-arguments; then exit 1; fi
done
aiws_prepare_run_directory "$run_dir"
printf 'test failure\n' > "$run_dir/input/brief.md"
export AIWS_MOCK_ERROR=1
if /opt/aiws/bin/run-agent.sh; then echo 'OpenCode error event was incorrectly accepted'; exit 1; fi
echo 'Runtime adapter smoke passed for all three providers and error handling.'
