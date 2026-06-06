#!/usr/bin/env bash
# Wipe one POD container recursively. Args: $1 = pod URL ending with /
# No set -e/-u — transient failures must not abort the tree walk.

CSS="${CSS:-https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io}"
POD_URL="$1"

if [ -z "${WRITE_SECRET:-}" ]; then
  echo "ERROR: WRITE_SECRET env var is required (css-gate operator bearer)." >&2
  exit 1
fi
AUTH_HDR="Authorization: Bearer ${WRITE_SECRET}"

# Extract child refs (relative or absolute) from an LDP container's Turtle body.
# Parser strategy: feed the body to awk in record-separator-by-statement mode,
# isolate the record whose predicate is ldp:contains, then emit each <…> token.
parse_children() {
  # Read the whole document, find the ldp:contains predicate(s), walk forward
  # collecting <…> tokens until the statement terminator. The terminator is a
  # '.' that appears OUTSIDE a <…> token AND is followed by whitespace or EOF.
  awk '
    {
      doc = doc $0 "\n"
    }
    END {
      pos = 1
      while ((idx = index(substr(doc, pos), "ldp:contains")) > 0) {
        start = pos + idx - 1 + length("ldp:contains")
        # scan forward emitting <…> tokens until we see a stmt-terminator dot
        i = start
        in_uri = 0
        uri = ""
        while (i <= length(doc)) {
          ch = substr(doc, i, 1)
          if (in_uri) {
            if (ch == ">") {
              print uri
              uri = ""
              in_uri = 0
            } else {
              uri = uri ch
            }
            i++
            continue
          }
          if (ch == "<") {
            in_uri = 1
            uri = ""
            i++
            continue
          }
          if (ch == ".") {
            # statement terminator only if followed by whitespace or EOF
            nxt = substr(doc, i+1, 1)
            if (nxt == "" || nxt ~ /[ \t\r\n]/) {
              break
            }
          }
          i++
        }
        pos = i + 1
      }
    }
  '
}

walk_container() {
  local c="$1"
  local body
  body=$(curl -sS -H "Accept: text/turtle" -H "$AUTH_HDR" --max-time 30 "$c" 2>/dev/null)
  if [ -z "$body" ]; then
    return 0
  fi
  local refs
  refs=$(printf '%s\n' "$body" | parse_children)
  if [ -z "$refs" ]; then
    return 0
  fi
  local ref
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    local target
    case "$ref" in
      http://*|https://*) target="$ref" ;;
      *) target="${c}${ref}" ;;
    esac
    case "$target" in
      */) walk_container "$target" ;;
    esac
    code=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$target" 2>/dev/null)
    echo "DEL $code $target"
  done <<EOF
$refs
EOF
}

echo "============================================================"
echo ">>> wiping $POD_URL"
echo "============================================================"
walk_container "$POD_URL"
final=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH_HDR" --max-time 30 "$POD_URL" 2>/dev/null)
echo "FINAL DEL $final $POD_URL"
echo "FINAL_CODE=$final"
