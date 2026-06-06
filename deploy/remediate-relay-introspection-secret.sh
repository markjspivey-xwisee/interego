#!/bin/bash
set -euo pipefail

# One-shot remediation for RELAY_INTROSPECTION_SECRET drift on BOTH
# interego-relay and interego-css-gate.
#
# Symptom: `az containerapp secret list` on either app returns NO
# `relay-introspection-secret`, yet both live revisions have a plain
# env-var RELAY_INTROSPECTION_SECRET=<hex> visible in the revision spec
# / ARM activity log. Same drift shape as the gate-write-secret case.
# Root cause: someone ran `az containerapp update --set-env-vars
# RELAY_INTROSPECTION_SECRET=<raw_value>` manually, which overwrote the
# secretref binding the IaC at deploy/azure-deploy.sh §9 sets on both
# apps.
#
# Fix: read the live plain value (preferring the relay's, falling back
# to the gate's — they must be identical for the introspection RPC to
# work), promote it into each app's Container Apps secret store as
# `relay-introspection-secret`, then rebind RELAY_INTROSPECTION_SECRET
# to `secretref:relay-introspection-secret` on both. Identical value
# preserved across both apps so the gate↔relay token-introspection RPC
# keeps working.
#
# Idempotent — re-running when already remediated is a no-op.

RESOURCE_GROUP="${CG_RESOURCE_GROUP:-context-graphs-rg}"
RELAY_APP="${RELAY_APP:-interego-relay}"
CSS_GATE_APP="${CSS_GATE_APP:-interego-css-gate}"

echo "=== Remediating RELAY_INTROSPECTION_SECRET on $RELAY_APP + $CSS_GATE_APP (plain env-var -> secretref) ==="

read_secret() {
  az containerapp secret show \
    --name "$1" --resource-group "$RESOURCE_GROUP" \
    --secret-name relay-introspection-secret \
    --query value -o tsv 2>/dev/null || true
}

read_plain() {
  az containerapp show \
    --name "$1" --resource-group "$RESOURCE_GROUP" \
    --query "properties.template.containers[0].env[?name=='RELAY_INTROSPECTION_SECRET'].value | [0]" \
    -o tsv 2>/dev/null || true
}

read_ref() {
  az containerapp show \
    --name "$1" --resource-group "$RESOURCE_GROUP" \
    --query "properties.template.containers[0].env[?name=='RELAY_INTROSPECTION_SECRET'].secretRef | [0]" \
    -o tsv 2>/dev/null || true
}

RELAY_SECRET=$(read_secret "$RELAY_APP")
RELAY_PLAIN=$(read_plain "$RELAY_APP")
RELAY_REF=$(read_ref "$RELAY_APP")

GATE_SECRET=$(read_secret "$CSS_GATE_APP")
GATE_PLAIN=$(read_plain "$CSS_GATE_APP")
GATE_REF=$(read_ref "$CSS_GATE_APP")

if [ -n "$RELAY_REF" ] && [ -n "$RELAY_SECRET" ] && [ -z "$RELAY_PLAIN" ] \
   && [ -n "$GATE_REF" ] && [ -n "$GATE_SECRET" ] && [ -z "$GATE_PLAIN" ]; then
  if [ "$RELAY_SECRET" = "$GATE_SECRET" ]; then
    echo "    RELAY_INTROSPECTION_SECRET already bound via secretref on both apps; secrets aligned; no plain values. Nothing to do."
    exit 0
  fi
  echo "    WARNING: both apps bound via secretref but secret values DIFFER — introspection RPC will fail until aligned." >&2
fi

# Choose the value to promote. Prefer the relay's (it's the issuer of
# the secret in the IaC §9 flow). Fall back to the gate's only if the
# relay has nothing. The value MUST be identical across both apps for
# the bearer-auth check on POST /verify-token to succeed.
if [ -n "$RELAY_SECRET" ]; then
  VALUE="$RELAY_SECRET"
  echo "    using existing relay-introspection-secret from $RELAY_APP secret store"
elif [ -n "$RELAY_PLAIN" ]; then
  VALUE="$RELAY_PLAIN"
  echo "    promoting plain env-var RELAY_INTROSPECTION_SECRET from $RELAY_APP to secret store"
elif [ -n "$GATE_SECRET" ]; then
  VALUE="$GATE_SECRET"
  echo "    using existing relay-introspection-secret from $CSS_GATE_APP secret store"
elif [ -n "$GATE_PLAIN" ]; then
  VALUE="$GATE_PLAIN"
  echo "    promoting plain env-var RELAY_INTROSPECTION_SECRET from $CSS_GATE_APP to secret store"
else
  echo "    ERROR: no RELAY_INTROSPECTION_SECRET found on either app — cannot remediate without a value." >&2
  echo "    Run deploy/azure-deploy.sh §9 to generate + bind a fresh secret on both." >&2
  exit 1
fi

for APP in "$RELAY_APP" "$CSS_GATE_APP"; do
  az containerapp secret set \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --secrets "relay-introspection-secret=$VALUE" \
    --output none
  az containerapp update \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "RELAY_INTROSPECTION_SECRET=secretref:relay-introspection-secret" \
    --output none
  echo "    $APP: relay-introspection-secret set + RELAY_INTROSPECTION_SECRET rebound to secretref"
done

echo "    done. Verifying..."
for APP in "$RELAY_APP" "$CSS_GATE_APP"; do
  echo "  --- $APP ---"
  az containerapp secret list \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "[?name=='relay-introspection-secret'].name" -o tsv
  az containerapp show \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.template.containers[0].env[?name=='RELAY_INTROSPECTION_SECRET'].{name:name,secretRef:secretRef,value:value}" \
    -o json
done
