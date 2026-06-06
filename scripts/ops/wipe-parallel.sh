#!/usr/bin/env bash
# Operator-only. Parallel POD wipe. Args: pod URL(s) ending with /.
# Invoke via:   npm run ops:wipe-parallel -- <pod-url> [<pod-url>...]
# Requires CSS (css-gate base URL) and WRITE_SECRET (operator bearer) in env.
# For each pod: list direct children, fork wipe-pod-one.sh per child container, wait.
# Finally DELETE the pod root itself.

CSS="${CSS:-}"
WIPE_ONE="$(cd "$(dirname "$0")" && pwd)/wipe-pod-one.sh"

if [ -z "${WRITE_SECRET:-}" ]; then
  echo "ERROR: WRITE_SECRET env var is required (css-gate operator bearer)." >&2
  exit 1
fi
export WRITE_SECRET
AUTH_HDR="Authorization: Bearer ${WRITE_SECRET}"
JOBS_MAX="${JOBS_MAX:-12}"
LOGDIR="${LOGDIR:-$(dirname "$0")/wipe-logs/parallel}"
mkdir -p "$LOGDIR"

parse_children() {
  awk '
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
  '
}

wait_for_slot() {
  while [ "$(jobs -r | wc -l)" -ge "$JOBS_MAX" ]; do
    sleep 1
  done
}

wipe_pod() {
  local POD_URL="$1"
  local podname; podname=$(basename "${POD_URL%/}")
  echo "=== $POD_URL ==="
  local body; body=$(curl -sS -H "Accept: text/turtle" -H "$AUTH_HDR" --max-time 30 "$POD_URL")
  local refs; refs=$(printf '%s\n' "$body" | parse_children)
  if [ -z "$refs" ]; then
    echo "  (empty)"
  else
    while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      local child_url
      case "$ref" in
        http://*|https://*) child_url="$ref" ;;
        *) child_url="${POD_URL}${ref}" ;;
      esac
      case "$child_url" in
        */)
          # container — fork wipe-pod-one in background
          wait_for_slot
          local safe; safe=$(echo "$ref" | tr -c '[:alnum:]._-' '_')
          bash "$WIPE_ONE" "$child_url" > "$LOGDIR/${podname}__${safe}.log" 2>&1 &
          echo "  fork wipe $child_url"
          ;;
        *)
          # leaf — delete directly
          code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$child_url")
          echo "  DEL $code $child_url"
          ;;
      esac
    done <<EOF
$refs
EOF
  fi
  wait
  # Final DELETE on the pod root
  final=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$POD_URL")
  echo "FINAL DEL $final $POD_URL"
  echo "FINAL_CODE=$final"
}

for pod in "$@"; do
  wipe_pod "$pod"
done
