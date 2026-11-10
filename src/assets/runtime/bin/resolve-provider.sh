#!/usr/bin/env bash
# Resolve one reviewed profile from issue/PR labels or a PR marker.

source /opt/aiws/bin/common.sh
source /opt/aiws/bin/load-config.sh

AIWS_PROFILE=''
AIWS_PROVIDER=''
AIWS_MODEL=''
AIWS_EFFORT=''
AIWS_PROFILE_LABEL=''

aiws_resolve_profile() {
  local labels_json="${1:-[]}" pr_body="${2:-}" marker='' matches count
  jq -e 'type == "array" and all(.[]; type == "string")' <<<"$labels_json" >/dev/null \
    || aiws_die 'Profile labels must be a JSON string array.' 2

  if [[ "$pr_body" =~ \<\!--[[:space:]]*aiws:profile=([A-Za-z0-9._-]+)[[:space:]]*--\> ]]; then
    marker="${BASH_REMATCH[1]}"
  fi

  matches="$(jq -r --argjson labels "$labels_json" '
    .agents.profiles[] |
    .triggerLabel as $trigger_label |
    select(($labels | index($trigger_label)) != null) | .id
  ' "$AIWS_CONFIG")" || aiws_die 'Could not match profile labels.' 2
  count="$(sed '/^$/d' <<<"$matches" | wc -l | tr -d ' ')"
  (( count <= 1 )) || aiws_die "Multiple agent profile labels matched: $(paste -sd ', ' <<<"$matches")" 2

  if [[ -n "$marker" ]]; then
    AIWS_PROFILE="$marker"
  elif (( count == 1 )); then
    AIWS_PROFILE="$(head -n 1 <<<"$matches")"
  else
    AIWS_PROFILE="$(jq -r '.agents.defaultProfile' "$AIWS_CONFIG")"
  fi
  aiws_name_is_valid "$AIWS_PROFILE" || aiws_die "Unsafe profile name: $AIWS_PROFILE" 2

  local profile_json
  profile_json="$(jq -cer --arg profile "$AIWS_PROFILE" '.agents.profiles[] | select(.id == $profile)' "$AIWS_CONFIG")" \
    || aiws_die "Unknown agent profile: $AIWS_PROFILE" 2
  AIWS_PROVIDER="$(jq -r '.provider' <<<"$profile_json")"
  AIWS_MODEL="$(jq -r '.model // ""' <<<"$profile_json")"
  AIWS_EFFORT="$(jq -r '.effort // "medium"' <<<"$profile_json")"
  AIWS_PROFILE_LABEL="$(jq -r '.triggerLabel' <<<"$profile_json")"
  AIWS_PROFILE_IMAGE="$(jq -r '.image // ""' <<<"$profile_json")"
  [[ "$AIWS_PROVIDER" == claude || "$AIWS_PROVIDER" == codex || "$AIWS_PROVIDER" == opencode ]] \
    || aiws_die "Unsupported provider in profile $AIWS_PROFILE: $AIWS_PROVIDER" 2
  [[ "$AIWS_MODEL" != *$'\n'* ]] && aiws_effort_is_valid "$AIWS_PROVIDER" "$AIWS_EFFORT" \
    || aiws_die "Invalid model/effort for $AIWS_PROVIDER profile: $AIWS_PROFILE" 2
  export AIWS_PROFILE AIWS_PROVIDER AIWS_MODEL AIWS_EFFORT AIWS_PROFILE_LABEL AIWS_PROFILE_IMAGE
}

aiws_profile_marker() { printf '<!-- aiws:profile=%s -->' "$AIWS_PROFILE"; }

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -ge 2 && $# -le 3 ]] || aiws_die 'Usage: resolve-provider.sh <config.json> <labels-json> [pr-body]' 2
  aiws_config_load "$1"
  aiws_resolve_profile "$2" "${3:-}"
  jq -n --arg profile "$AIWS_PROFILE" --arg provider "$AIWS_PROVIDER" \
    --arg model "$AIWS_MODEL" --arg effort "$AIWS_EFFORT" \
    '{profile:$profile,provider:$provider,model:$model,effort:$effort}'
fi
