#!/usr/bin/env bash
set -euo pipefail

# Rebuild prompts.db and hydrate missing `messages` payloads from show-prompt offsets.
# Usage:
#   scripts/prompt-analysis-refresh.sh [git-ai prompts flags...]
# Example:
#   scripts/prompt-analysis-refresh.sh --since 30
#   MAX_OFFSETS=8 scripts/prompt-analysis-refresh.sh --all-authors

MAX_OFFSETS="${MAX_OFFSETS:-5}"

if ! command -v git-ai >/dev/null 2>&1; then
  echo "[prompt-analysis-refresh] git-ai not found in PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[prompt-analysis-refresh] sqlite3 not found in PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[prompt-analysis-refresh] jq not found in PATH" >&2
  exit 1
fi

echo "[prompt-analysis-refresh] rebuilding prompts.db via git-ai prompts $*"
rm -f prompts.db
git-ai prompts "$@"

if [[ ! -f prompts.db ]]; then
  echo "[prompt-analysis-refresh] prompts.db was not created" >&2
  exit 1
fi

hydrated=0
missing=0

while IFS= read -r id; do
  [[ -z "$id" ]] && continue

  found=""
  for ((offset = 0; offset < MAX_OFFSETS; offset++)); do
    json="$(git-ai show-prompt "$id" --offset "$offset" 2>/dev/null || true)"
    [[ -z "$json" ]] && continue

    messages="$(printf '%s' "$json" | jq -c '.prompt.messages // []' 2>/dev/null || echo "[]")"
    if [[ "$messages" != "[]" ]]; then
      found="$messages"
      break
    fi
  done

  if [[ -n "$found" ]]; then
    tmp_payload="$(mktemp)"
    printf '%s' "$found" > "$tmp_payload"
    sqlite3 prompts.db "UPDATE prompts SET messages=CAST(readfile('$tmp_payload') AS TEXT) WHERE id='$id';"
    rm -f "$tmp_payload"
    hydrated=$((hydrated + 1))
  else
    missing=$((missing + 1))
  fi
done < <(sqlite3 prompts.db "SELECT id FROM prompts WHERE messages='[]' ORDER BY seq_id;")

echo "[prompt-analysis-refresh] hydrated=$hydrated missing=$missing"

sqlite3 -header -column prompts.db "
SELECT
  COUNT(*) AS total_prompts,
  SUM(CASE WHEN commit_sha IS NOT NULL THEN 1 ELSE 0 END) AS committed_prompts,
  SUM(CASE WHEN accepted_rate IS NOT NULL THEN 1 ELSE 0 END) AS prompts_with_acceptance,
  SUM(
    CASE
      WHEN json_valid(messages)=1 AND json_type(messages)='array' AND json_array_length(messages)>0 THEN 1
      WHEN json_valid(messages)=1 AND json_type(messages)='object'
       AND json_type(json_extract(messages,'$.messages'))='array'
       AND json_array_length(json_extract(messages,'$.messages'))>0 THEN 1
      ELSE 0
    END
  ) AS prompts_with_messages
FROM prompts;
"
