#!/usr/bin/env bash
# Re-fetch the live snapshots build.py checks the crosswalk against.
#
# Foxxi's ontologies are not fetched here: the build reads one released version of each (config.json foxxiNs), from
# Foxxi's archive of released files, which never change (src/layer.py foxxi_ns). Inside the Interego repository that is
# the vertical's ns-releases/; elsewhere, point FOXXI_NS_ARCHIVE at a copy, which `tools/refresh-evidence.sh --foxxi <dir>`
# fills from the version IRIs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E="$ROOT/evidence"
if [ "${1:-}" = "--foxxi" ]; then
  D="${2:?usage: refresh-evidence.sh --foxxi <dir>}"
  mkdir -p "$D"
  read -r V BASE MODULES < <(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["foxxiNs"]; print(c["version"], c["base"], " ".join(c["modules"]))' "$ROOT/config.json")
  # The SHA-256 of each module comes from config.json, which pins the release, never from the bytes just fetched.
  python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["foxxiNs"]; v=c["version"]; print("".join(h + "  " + m + "/" + v + ".ttl\n" for m, h in c["sha256"].items()), end="")' "$ROOT/config.json" > "$D/SHA256SUMS"
  for m in $MODULES; do
    mkdir -p "$D/$m"
    curl -sSfL -H 'Accept: text/turtle' -o "$D/$m/$V.ttl" "$BASE/$m/$V"
  done
  (cd "$D" && sha256sum -c --quiet SHA256SUMS) || { echo "a fetched module is not the release config.json pins" >&2; exit 1; }
  echo "Foxxi $V fetched into $D and checked against config.json; build with FOXXI_NS_ARCHIVE=$D"
  exit 0
fi
T="$(mktemp -d)"
curl -sSfL -H 'Accept: text/turtle' -o "$T/affordances.ttl" https://foxxi-bridge.interego.xwisee.com/affordances
python3 -I "$(dirname "$0")/foxxi_manifest.py" "$T/affordances.ttl" "$E/foxxi-affordances.json"
curl -sSfL -o "$E/relay-operations.json" https://relay.interego.xwisee.com/.well-known/operations
curl -sSfL -H 'Accept: text/turtle' -o "$E/xapi-ontology.ttl" https://w3id.org/xapi/ontology
curl -sSfL -H 'Accept: text/turtle' -o "$E/xapi-profile-ontology.ttl" https://w3id.org/xapi/profiles/ontology
curl -sSfL -o "$E/iep.ttl" https://markjspivey-xwisee.github.io/interego/ns/iep.ttl
echo "evidence refreshed in $E"
