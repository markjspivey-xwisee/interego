#!/bin/bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────
RESOURCE_GROUP="${CG_RESOURCE_GROUP:-context-graphs-rg}"
LOCATION="${CG_LOCATION:-eastus}"
ACR_NAME="${CG_ACR_NAME:-contextgraphsacr}"
ENV_NAME="${CG_ENV_NAME:-context-graphs-env}"
CSS_APP="interego-css"
DASHBOARD_APP="interego-dashboard"
RELAY_APP="interego-relay"

echo "=== Interego Azure Deployment ==="
echo "Resource Group: $RESOURCE_GROUP"
echo "Location: $LOCATION"
echo "ACR: $ACR_NAME"
echo ""

# ── 1. Resource Group ────────────────────────────────────────
echo ">>> Creating resource group..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

# ── 2. Container Registry ────────────────────────────────────
echo ">>> Creating container registry..."
az acr create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --sku Basic \
  --admin-enabled true \
  --output none

ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)
echo "    ACR: $ACR_LOGIN_SERVER"

# Log in to ACR
az acr login --name "$ACR_NAME"

# ── 3. Build & Push Images ───────────────────────────────────
echo ">>> Building CSS image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-css:latest \
  --file deploy/Dockerfile.css \
  . \
  --no-logs

echo ">>> Building Dashboard image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-dashboard:latest \
  --file deploy/Dockerfile.dashboard \
  . \
  --no-logs

echo ">>> Building MCP Relay image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-relay:latest \
  --file deploy/Dockerfile.relay \
  . \
  --no-logs

# ── 4. Container Apps Environment ─────────────────────────────
echo ">>> Creating Container Apps environment..."
az containerapp env create \
  --name "$ENV_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

# Get ACR credentials
ACR_USERNAME=$(az acr credential show --name "$ACR_NAME" --query username -o tsv)
ACR_PASSWORD=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

# ── 5. Deploy CSS ─────────────────────────────────────────────
echo ">>> Deploying CSS (Community Solid Server)..."
az containerapp create \
  --name "$CSS_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-css:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 3456 \
  --ingress internal \
  --min-replicas 1 \
  --max-replicas 1 \
  --cpu 0.5 \
  --memory 1Gi \
  --output none

CSS_FQDN=$(az containerapp show --name "$CSS_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
CSS_INTERNAL_URL="https://$CSS_FQDN/"
echo "    CSS internal: $CSS_INTERNAL_URL"

# Set CSS_BASE_URL so CSS recognizes requests at its internal FQDN
echo ">>> Setting CSS_BASE_URL..."
az containerapp update \
  --name "$CSS_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "CSS_BASE_URL=$CSS_INTERNAL_URL" \
  --output none

# ── 6. Deploy Dashboard ──────────────────────────────────────
echo ">>> Deploying Dashboard..."
az containerapp create \
  --name "$DASHBOARD_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-dashboard:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 4000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" \
  --output none

DASHBOARD_FQDN=$(az containerapp show --name "$DASHBOARD_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Dashboard: https://$DASHBOARD_FQDN"

# ── 7. Deploy MCP Relay ──────────────────────────────────────
echo ">>> Deploying MCP Relay..."
az containerapp create \
  --name "$RELAY_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-relay:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" \
  --output none

RELAY_FQDN=$(az containerapp show --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    MCP Relay: https://$RELAY_FQDN"

# ── 8. Deploy PGSL Browser + Observatory ──────────────────────
BROWSER_APP="interego-browser"
echo ">>> Building PGSL Browser image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-browser:latest \
  --file deploy/Dockerfile.pgsl-browser \
  . \
  --no-logs

echo ">>> Deploying PGSL Browser + Observatory..."
az containerapp create \
  --name "$BROWSER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-browser:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 5000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" "PORT=5000" "POD_NAME=markj" "CLEAN=1" \
  --output none

BROWSER_FQDN=$(az containerapp show --name "$BROWSER_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Browser:       https://$BROWSER_FQDN"
echo "    Observatory:   https://$BROWSER_FQDN/observatory"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  CSS (internal):  $CSS_INTERNAL_URL"
echo "  Dashboard:       https://$DASHBOARD_FQDN"
echo "  MCP Relay:       https://$RELAY_FQDN"
echo "  PGSL Browser:    https://$BROWSER_FQDN"
echo "  Observatory:     https://$BROWSER_FQDN/observatory"
echo ""
echo "To connect a remote agent, set:"
echo "  CG_BASE_URL=https://$RELAY_FQDN"
echo ""
echo "Or add to .mcp.json:"
echo "  {\"mcpServers\":{\"context-graphs\":{\"url\":\"https://$RELAY_FQDN/sse\"}}}"
echo ""
echo "── SOC 2 evidence (per spec/policies/03-change-management.md §4.5) ──"
echo "Publish a deploy event descriptor to your operator pod:"
echo ""
echo "  node tools/publish-ops-event.mjs deploy \\"
echo "    --component all \\"
echo "    --commit \"\$(git rev-parse HEAD)\" \\"
echo "    --deployer-did \"\${CG_OPERATOR_DID:-did:web:identity.example#operator}\" \\"
echo "    | jq"
echo ""
echo "Then feed the JSON into publish_context with compliance: true."
