#!/usr/bin/env bash
# Projects v2 adapter with user/organization support and cursor pagination.
set -euo pipefail
source /opt/aiws/bin/common.sh
config_path="${AIWS_CONFIG_PATH:-${AIWS_CONFIG:-${GITHUB_WORKSPACE:-}/.aiworkspace/config.json}}"
source /opt/aiws/bin/load-config.sh

if [[ -z "${AIWS_CONFIG:-}" ]]; then
  aiws_config_load "$config_path"
fi
aiws_config_export_runtime

# Dependency checks also serve label-only queues and therefore do not require project settings.
if [[ "${1:-}" == blockers ]]; then
  issue="${2:-}"; aiws_number_is_valid "$issue" || aiws_die 'A valid issue number is required.' 2
  token="$(aiws_automation_token)"
  aiws_gh "$token" api "repos/${AIWS_REPOSITORY}/issues/${issue}/dependencies/blocked_by" \
    --paginate --jq '.[] | select(.state == "open") | .number'
  exit 0
fi

owner="$(jq -r '.queue.project.owner // empty' "$AIWS_CONFIG")"
owner_type="$(jq -r '.queue.project.ownerType // "user"' "$AIWS_CONFIG")"
number="$(jq -r '.queue.project.number // empty' "$AIWS_CONFIG")"
status_field="$(jq -r '.queue.project.statusField // "Status"' "$AIWS_CONFIG")"
ready_status="$(jq -r '.queue.project.ready // .queue.project.statuses.ready // "Ready"' "$AIWS_CONFIG")"
[[ "$owner_type" == org ]] && owner_type=organization
[[ -n "$owner" && "$number" =~ ^[1-9][0-9]*$ ]] || aiws_die 'Project queue configuration is incomplete.' 2
[[ "$owner_type" == user || "$owner_type" == organization ]] || aiws_die "Unsupported project ownerType: $owner_type" 2

if [[ "$owner_type" == user ]]; then
  fields_query='query($login:String!,$number:Int!,$after:String){user(login:$login){projectV2(number:$number){id fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name}}} pageInfo{hasNextPage endCursor}}}}}'
  items_query='query($login:String!,$number:Int!,$after:String,$statusField:String!){user(login:$login){projectV2(number:$number){id items(first:100,after:$after){nodes{id fieldValueByName(name:$statusField){... on ProjectV2ItemFieldSingleSelectValue{name}} content{... on Issue{number state repository{nameWithOwner} labels(first:100){nodes{name}}}}} pageInfo{hasNextPage endCursor}}}}}'
  root='.data.user.projectV2'
else
  fields_query='query($login:String!,$number:Int!,$after:String){organization(login:$login){projectV2(number:$number){id fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name}}} pageInfo{hasNextPage endCursor}}}}}'
  items_query='query($login:String!,$number:Int!,$after:String,$statusField:String!){organization(login:$login){projectV2(number:$number){id items(first:100,after:$after){nodes{id fieldValueByName(name:$statusField){... on ProjectV2ItemFieldSingleSelectValue{name}} content{... on Issue{number state repository{nameWithOwner} labels(first:100){nodes{name}}}}} pageInfo{hasNextPage endCursor}}}}}'
  root='.data.organization.projectV2'
fi

project_graphql() {
  local query="$1" after="${2:-}" with_status="${3:-0}"
  local args=(api graphql -f query="$query" -f login="$owner" -F number="$number")
  [[ -z "$after" ]] || args+=(-f after="$after")
  [[ "$with_status" == 0 ]] || args+=(-f statusField="$status_field")
  aiws_project_gh "${args[@]}"
}

project_pages() {
  local kind="$1" after='' response has_more
  while :; do
    if [[ "$kind" == fields ]]; then
      response="$(project_graphql "$fields_query" "$after")"
      has_more="$(jq -r "$root.fields.pageInfo.hasNextPage // false" <<<"$response")"
      jq -c "$root.fields.nodes[]?" <<<"$response"
      after="$(jq -r "$root.fields.pageInfo.endCursor // empty" <<<"$response")"
    else
      response="$(project_graphql "$items_query" "$after" 1)"
      has_more="$(jq -r "$root.items.pageInfo.hasNextPage // false" <<<"$response")"
      jq -c "$root.items.nodes[]?" <<<"$response"
      after="$(jq -r "$root.items.pageInfo.endCursor // empty" <<<"$response")"
    fi
    [[ "$has_more" == true && -n "$after" ]] || break
  done
}

project_id() {
  local response
  response="$(project_graphql "$fields_query")"
  jq -er "$root.id" <<<"$response"
}

open_blockers() {
  local issue="$1" token
  token="$(aiws_automation_token)"
  aiws_gh "$token" api "repos/${AIWS_REPOSITORY}/issues/${issue}/dependencies/blocked_by" \
    --paginate --jq '.[] | select(.state == "open") | .number'
}

case "${1:-}" in
  items)
    project_pages items
    ;;
  fields)
    project_pages fields
    ;;
  next)
    items_file="$(mktemp "${RUNNER_TEMP:-/tmp}/aiws-project-items.XXXXXX")"
    trap 'rm -f "$items_file"' EXIT
    project_pages items > "$items_file"
    while IFS=$'\t' read -r item issue; do
      aiws_number_is_valid "$issue" || continue
      blockers="$(open_blockers "$issue")"
      if [[ -n "$blockers" ]]; then
        aiws_log "Skipping blocked issue #$issue."
        continue
      fi
      printf '%s\t%s\n' "$item" "$issue"
      break
    done < <(jq -r --arg ready "$ready_status" --arg repo "$AIWS_REPOSITORY" '
      select(.fieldValueByName.name == $ready) |
      select(.content.state == "OPEN" and .content.repository.nameWithOwner == $repo) |
      select(([.content.labels.nodes[].name] | any(. == env.AIWS_LABEL_RUNNING or . == env.AIWS_LABEL_DONE or . == env.AIWS_LABEL_FAILED)) | not) |
      "\(.id)\t\(.content.number)"
    ' "$items_file")
    ;;
  item)
    issue="${2:-}"; aiws_number_is_valid "$issue" || aiws_die 'A valid issue number is required.' 2
    # Process substitution: jq may stop early without failing the pager through SIGPIPE.
    jq -nr --argjson issue "$issue" --arg repo "$AIWS_REPOSITORY" '
      first(inputs | select(.content.number == $issue and .content.repository.nameWithOwner == $repo) | .id) // empty
    ' < <(project_pages items)
    ;;
  status)
    item_id="${2:-}"; target="${3:-}"
    [[ "$item_id" =~ ^PVTI_[A-Za-z0-9_-]+$ ]] || aiws_die 'Invalid Project item id.' 2
    [[ -n "$target" && "$target" != *$'\n'* ]] || aiws_die 'A valid target status is required.' 2
    field_json="$(jq -nc --arg name "$status_field" 'first(inputs | select(.name == $name)) // empty' < <(project_pages fields))"
    [[ -n "$field_json" ]] || aiws_die "Project field not found: $status_field" 2
    field_id="$(jq -r '.id' <<<"$field_json")"
    option_id="$(jq -r --arg target "$target" 'first(.options[] | select(.name == $target) | .id) // empty' <<<"$field_json")"
    [[ -n "$option_id" ]] || aiws_die "Project status option not found: $target" 2
    mutation='mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}'
    aiws_project_gh api graphql -f query="$mutation" -f project="$(project_id)" \
      -f item="$item_id" -f field="$field_id" -f option="$option_id" >/dev/null
    aiws_log "Project item moved to '$target'."
    ;;
  *)
    aiws_die 'Usage: project.sh {next|item ISSUE|status ITEM STATUS|blockers ISSUE|fields}' 2
    ;;
esac
