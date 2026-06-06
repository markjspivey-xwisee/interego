#!/usr/bin/env bash
# Operator-only. Recursive POD container wipe via CSS allow-all REST.
# Invoke via:   npm run ops:wipe-pods         (auto-discovers pods at $CSS/)
#         or:   WIPE_PODS="a b c" npm run ops:wipe-pods   (override list)
# Requires CSS (css-gate base URL) and WRITE_SECRET (operator bearer) in env.
# Walks ldp:contains depth-first, DELETEs children before parents.
set -u

if [[ -z "${CSS:-}" ]]; then
  echo "ERROR: CSS env var is required (css-gate base URL, no trailing slash)." >&2
  exit 1
fi
if [[ -z "${WRITE_SECRET:-}" ]]; then
  echo "ERROR: WRITE_SECRET env var is required (css-gate operator bearer)." >&2
  exit 1
fi
AUTH_HDR="Authorization: Bearer ${WRITE_SECRET}"

# Reuse the parser from wipe-pod-one.sh shape — list direct children of $CSS/
# and treat each container child (ref ending in '/') as a pod slug.
list_pods_from_root() {
  local body
  body=$(curl -sS -H "Accept: text/turtle" -H "$AUTH_HDR" --max-time 30 "$CSS/" 2>/dev/null)
  [ -z "$body" ] && return 0
  printf '%s\n' "$body" | awk '
    { doc = doc $0 "\n" }
    END {
      pos = 1
      while ((idx = index(substr(doc, pos), "ldp:contains")) > 0) {
        start = pos + idx - 1 + length("ldp:contains")
        i = start; in_uri = 0; uri = ""
        while (i <= length(doc)) {
          ch = substr(doc, i, 1)
          if (in_uri) { if (ch == ">") { print uri; uri=""; in_uri=0 } else { uri = uri ch }; i++; continue }
          if (ch == "<") { in_uri = 1; uri=""; i++; continue }
          if (ch == ".") { nxt = substr(doc, i+1, 1); if (nxt == "" || nxt ~ /[ \t\r\n]/) break }
          i++
        }
        pos = i + 1
      }
    }
  ' | sed -n 's:/$::p'
}

if [[ -n "${WIPE_PODS:-}" ]]; then
  PODS=(${WIPE_PODS})
else
  mapfile -t PODS < <(list_pods_from_root)
fi

if [[ ${#PODS[@]} -eq 0 ]]; then
  echo "ERROR: no pods to wipe (CSS root listing returned no ldp:contains children)." >&2
  exit 1
fi

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
