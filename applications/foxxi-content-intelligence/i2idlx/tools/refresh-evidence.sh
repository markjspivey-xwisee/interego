#!/usr/bin/env bash
# Re-fetch the live snapshots build.py checks the crosswalk against.
set -euo pipefail
E="$(cd "$(dirname "$0")/.." && pwd)/evidence"
T="$(mktemp -d)"
curl -sSfL -H 'Accept: text/turtle' -o "$T/affordances.ttl" https://foxxi-bridge.interego.xwisee.com/affordances
python3 -I "$(dirname "$0")/foxxi_manifest.py" "$T/affordances.ttl" "$E/foxxi-affordances.json"
curl -sSfL -o "$E/relay-operations.json" https://relay.interego.xwisee.com/.well-known/operations
curl -sSfL -H 'Accept: text/turtle' -o "$E/ns_ieee-ler.ttl" https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler
curl -sSfL -H 'Accept: text/turtle' -o "$E/ns_adl-tla.ttl"  https://foxxi-bridge.interego.xwisee.com/ns/adl-tla
curl -sSfL -H 'Accept: text/turtle' -o "$E/xapi-ontology.ttl" https://w3id.org/xapi/ontology
curl -sSfL -H 'Accept: text/turtle' -o "$E/xapi-profile-ontology.ttl" https://w3id.org/xapi/profiles/ontology
curl -sSfL -o "$E/iep.ttl" https://markjspivey-xwisee.github.io/interego/ns/iep.ttl
echo "evidence refreshed in $E"
