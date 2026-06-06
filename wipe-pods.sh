#!/usr/bin/env bash
# Recursive POD container wipe via CSS allow-all REST.
# Walks ldp:contains depth-first, DELETEs children before parents.
set -u

CSS="${CSS:-https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io}"
PODS=(${WIPE_PODS:-markj foxxi foxxi-bridge-svc demos svc-440673 u-pk-250bb96aae52 u-pk-9051bf9f68f0 u-pk-bf9f5fc511d9 u-pk-d0e766c8c1d3})

if [[ -z "${WRITE_SECRET:-}" ]]; then
  echo "ERROR: WRITE_SECRET env var is required (css-gate operator bearer)." >&2
  exit 1
fi
AUTH_HDR="Authorization: Bearer ${WRITE_SECRET}"

# Per-target final status
declare -A FINAL_CODE
DELETED_COUNT=0
ERROR_COUNT=0

walk_container() {
  # $1 = absolute URL ending with /
  local c="$1"
  local body
  body=$(curl -sS -H "Accept: text/turtle" -H "$AUTH_HDR" --max-time 30 "$c" 2>/dev/null)
  local rc=$?
  if [[ $rc -ne 0 || -z "$body" ]]; then
    return 0
  fi
  # Extract refs that are children: lines like "ldp:contains <foo/>, <bar>;" or split lines.
  # Simpler: grab every <...> token AFTER the substring 'ldp:contains' until the next '.' terminator,
  # but we need to be careful because the turtle has multiple statements. We'll grep all <..> tokens
  # only on the ldp:contains predicate region using a multiline-aware sed.
  local contains_block
  contains_block=$(printf '%s\n' "$body" | awk '
    BEGIN{cap=0}
    {
      line=$0
      if (cap==0) {
        idx=index(line,"ldp:contains")
        if (idx>0) { line=substr(line,idx+length("ldp:contains")); cap=1 }
      }
      if (cap==1) {
        print line
        if (index(line,".")>0) { cap=0 }
      }
    }')
  # Pull <...> tokens from that block
  local refs
  refs=$(printf '%s' "$contains_block" | grep -oE '<[^>]+>' | sed 's/^<//;s/>$//')
  # Recurse + delete each
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    # Resolve relative URL against $c
    local target
    if [[ "$ref" == http*://* ]]; then
      target="$ref"
    else
      target="${c}${ref}"
    fi
    if [[ "$target" == */ ]]; then
      walk_container "$target"
      local code
      code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$target" 2>/dev/null)
      echo "DEL $code $target"
      [[ "$code" == "204" || "$code" == "200" || "$code" == "404" || "$code" == "205" ]] && DELETED_COUNT=$((DELETED_COUNT+1)) || ERROR_COUNT=$((ERROR_COUNT+1))
    else
      local code
      code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$target" 2>/dev/null)
      echo "DEL $code $target"
      [[ "$code" == "204" || "$code" == "200" || "$code" == "404" || "$code" == "205" ]] && DELETED_COUNT=$((DELETED_COUNT+1)) || ERROR_COUNT=$((ERROR_COUNT+1))
    fi
  done <<< "$refs"
}

for p in "${PODS[@]}"; do
  echo "============================================================"
  echo ">>> wiping /$p/"
  echo "============================================================"
  walk_container "$CSS/$p/"
  # Final delete of the pod container itself
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$CSS/$p/" 2>/dev/null)
  echo "FINAL DEL $code $CSS/$p/"
  FINAL_CODE[$p]="$code"
done

echo "============================================================"
echo "SUMMARY"
for p in "${PODS[@]}"; do
  echo "  /$p/ -> ${FINAL_CODE[$p]}"
done
echo "  deleted_ok=$DELETED_COUNT errors=$ERROR_COUNT"
