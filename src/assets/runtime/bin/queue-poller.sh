#!/usr/bin/env bash
# API-only dependency-aware dispatcher, without Docker/provider credentials.
set -euo pipefail
source /opt/aiws/bin/common.sh
AIWS_REPOSITORY="${AIWS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
aiws_require_env AIWS_REPOSITORY
aiws_repo_is_valid "$AIWS_REPOSITORY" || aiws_die 'Invalid repository.' 2
export AIWS_REPOSITORY
exec python3 /opt/aiws/bin/scheduler.py run
