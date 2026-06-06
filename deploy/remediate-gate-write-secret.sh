#!/bin/bash
set -euo pipefail

# One-shot remediation for interego-css-gate WRITE_SECRET drift.
#
# Symptom: `az containerapp secret list --name interego-css-gate` returns
# NO `gate-write-secret`, yet the live revision has a plain env-var
# WRITE_SECRET=<hex> visible in the revision spec / ARM activity log.
# Root cause: someone ran `az containerapp update --set-env-vars
# WRITE_SECRET=<raw_value>` manually, which overwrote the secretref
# binding the IaC at deploy/azure-deploy.sh §5b sets.
#
# Fix: read the live plain value, promote it into the Container Apps
# secret store as `gate-write-secret`, then rebind WRITE_SECRET to
# `secretref:gate-write-secret`. Same value is preserved so the bridge's
# FOXXI_POD_WRITE_SECRET keeps verifying.
#
# Idempotent — re-running when already remediated is a no-op (the secret
# is already set and the env-var already binds via secretref).

RESOURCE_GROUP="${CG_RESOURCE_GROUP:-context-graphs-rg}"
CSS_GATE_APP="${CSS_GATE_APP:-interego-css-gate}"

echo "=== Remediating $CSS_GATE_APP WRITE_SECRET (plain env-var -> secretref) ==="

EXISTING_SECRET=$(az containerapp secret show \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --secret-name gate-write-secret \
  --query value -o tsv 2>/dev/null || true)

PLAIN_VALUE=$(az containerapp show \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='WRITE_SECRET'].value | [0]" \
  -o tsv 2>/dev/null || true)

EXISTING_REF=$(az containerapp show \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='WRITE_SECRET'].secretRef | [0]" \
  -o tsv 2>/dev/null || true)

if [ -n "$EXISTING_REF" ] && [ -n "$EXISTING_SECRET" ] && [ -z "$PLAIN_VALUE" ]; then
  echo "    WRITE_SECRET already bound via secretref:$EXISTING_REF; secret present; no plain value. Nothing to do."
  exit 0
fi

# Preserve the same value so the bridge's FOXXI_POD_WRITE_SECRET keeps
# verifying. Prefer the existing secret-store value if both exist (they
# should match); otherwise promote whichever is present.
if [ -n "$EXISTING_SECRET" ]; then
  VALUE="$EXISTING_SECRET"
  echo "    using existing gate-write-secret value from secret store"
elif [ -n "$PLAIN_VALUE" ]; then
  VALUE="$PLAIN_VALUE"
  echo "    promoting plain env-var WRITE_SECRET value to secret store"
else
  echo "    ERROR: no WRITE_SECRET found on $CSS_GATE_APP — cannot remediate without a value." >&2
  echo "    Run deploy/azure-deploy.sh §5b to generate + bind a fresh secret." >&2
  exit 1
fi

az containerapp secret set \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --secrets "gate-write-secret=$VALUE" \
  --output none

az containerapp update \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "WRITE_SECRET=secretref:gate-write-secret" \
  --output none

echo "    done. Verifying..."
az containerapp secret list \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "[?name=='gate-write-secret'].name" -o tsv
az containerapp show \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='WRITE_SECRET'].{name:name,secretRef:secretRef,value:value}" \
  -o json
