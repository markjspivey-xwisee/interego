#!/usr/bin/env bash
# Re-fetch the live snapshots build.py checks the crosswalk against.
# With --reasoner, fetch the pinned reasoner jar instead (see below).
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
  # Only into an empty or new directory: an archive that already holds releases (the vertical's ns-releases/ above all)
  # is never rewritten. The files are fetched and checked in a temporary directory and copied in only once all pass.
  if [ -e "$D" ] && [ -n "$(ls -A "$D")" ]; then echo "$D is not empty: give an empty or new directory" >&2; exit 1; fi
  F="$(mktemp -d)"
  trap 'rm -rf "$F"' EXIT
  read -r V BASE MODULES < <(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["foxxiNs"]; print(c["version"], c["base"], " ".join(c["modules"]))' "$ROOT/config.json")
  # The SHA-256 of each module comes from config.json, which pins the release, never from the bytes just fetched.
  python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["foxxiNs"]; v=c["version"]; print("".join(h + "  " + m + "/" + v + ".ttl\n" for m, h in c["sha256"].items()), end="")' "$ROOT/config.json" > "$F/SHA256SUMS"
  for m in $MODULES; do
    mkdir -p "$F/$m"
    curl -sSfL -H 'Accept: text/turtle' -o "$F/$m/$V.ttl" "$BASE/$m/$V"
  done
  (cd "$F" && sha256sum -c --quiet SHA256SUMS) || { echo "a fetched module is not the release config.json pins; $D left as it was" >&2; exit 1; }
  mkdir -p "$D" && cp -R "$F"/. "$D"/
  echo "Foxxi $V fetched into $D and checked against config.json; build with FOXXI_NS_ARCHIVE=$D"
  exit 0
fi
if [ "${1:-}" = "--reasoner" ]; then
  # The reasoner the build runs HermiT from (config.json reasoner), fetched from its release and checked against the
  # SHA-256 config.json pins. It is not redistributed with I2IDL-X. I2IDLX_REASONER_JAR puts it somewhere else.
  read -r URL SHA JAR < <(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["reasoner"]; print(r["url"], r["sha256"], r["jar"])' "$ROOT/config.json")
  DEST="${I2IDLX_REASONER_JAR:-$JAR}"
  # A relative path is read from the package root, as build.py reads it, wherever this is run from.
  case "$DEST" in /*) ;; *) DEST="$ROOT/$DEST" ;; esac
  mkdir -p "$(dirname "$DEST")"
  J="$(mktemp "$(dirname "$DEST")/.reasoner.XXXXXX")"
  trap 'rm -f "$J"' EXIT
  curl -sSfL -o "$J" "$URL"
  echo "$SHA  $J" | sha256sum -c --quiet || { echo "the fetched jar is not the one config.json pins; nothing written" >&2; exit 1; }
  mv "$J" "$DEST" && chmod 644 "$DEST"
  trap - EXIT
  echo "reasoner fetched into $DEST and checked against config.json"
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
