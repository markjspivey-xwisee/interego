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
# Maintainer pod slug — pod path the browser/observatory open by default.
# Defaults to the reference deployment's seeded `markj` user; operators
# override CG_POD_NAME to point the surfaces at their own seeded pod.
POD_NAME="${CG_POD_NAME:-markj}"

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
  .

echo ">>> Building Dashboard image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-dashboard:latest \
  --file deploy/Dockerfile.dashboard \
  .

echo ">>> Building MCP Relay image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-relay:latest \
  --file deploy/Dockerfile.relay \
  .

# Build the remaining images up front so every `az containerapp create`
# below has a `:latest` tag to pull. Mirrors the per-image matrix in
# .github/workflows/deploy-azure.yml (same Dockerfile paths + NODE_BASE).
echo ">>> Building Identity image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-identity:latest \
  --file deploy/Dockerfile.identity \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building CSS Gate image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-css-gate:latest \
  --file deploy/Dockerfile.css-gate \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-alpine \
  .

echo ">>> Building Foxxi Bridge image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-foxxi-bridge:latest \
  --file deploy/Dockerfile.foxxi-bridge \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building Foxxi Dashboard image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-foxxi-dashboard:latest \
  --file deploy/Dockerfile.foxxi-dashboard \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building Foxxi Microsite image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-foxxi-microsite:latest \
  --file deploy/Dockerfile.foxxi-microsite \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building Foxxi SCORM Player image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-foxxi-scorm-player:latest \
  --file deploy/Dockerfile.foxxi-scorm-player \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building Acme ID image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-acme-id:latest \
  --file deploy/Dockerfile.acme-id \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

echo ">>> Building Interego Main image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-main:latest \
  --file deploy/Dockerfile.interego-main \
  --build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim \
  .

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

# CSS is now internal-only. Its ingress FQDN resolves only inside the
# Container Apps environment. All external writes MUST go through
# interego-css-gate, which enforces per-user bearer authz (see Fix A
# / commit history). The CSS public FQDN is gone — the anon-write hole
# is closed at the network boundary, not at the CSS ACL layer.
#
# CSS_FQDN here is the internal-form hostname returned by Azure for
# `--ingress internal` containers (looks like
# `<app>.internal.<envDomain>`). CSS_INTERNAL_URL is used by every
# server-side caller (relay, identity) AND by the gate as its
# upstream; browser-facing apps must instead point at CSS_GATE_URL.
CSS_FQDN=$(az containerapp show --name "$CSS_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
CSS_INTERNAL_URL="https://$CSS_FQDN/"
echo "    CSS internal: $CSS_INTERNAL_URL"

# ── 5a. Deploy Identity ───────────────────────────────────────
# Identity must come up before the relay (relay's OAuth flow calls
# IDENTITY_URL/tokens/verify) and before the css-gate (the gate's
# per-user bearer verifier hits IDENTITY_URL/tokens/verify too).
IDENTITY_APP="${IDENTITY_APP:-interego-identity}"
echo ">>> Deploying Identity..."
az containerapp create \
  --name "$IDENTITY_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-identity:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8090 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.5 \
  --memory 1Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" \
  --output none

IDENTITY_FQDN=$(az containerapp show --name "$IDENTITY_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
IDENTITY_URL="https://$IDENTITY_FQDN"
echo "    Identity: $IDENTITY_URL"

# Wire identity self-referential env vars + a stable 32-byte HMAC
# TOKEN_SIGNING_KEY so sessions survive restarts. Stored as a Container
# Apps secret (not a plain env var) so the HMAC key never appears in the
# revision spec or ARM activity logs — forgery of this key means minting
# valid identity-server tokens for any user.
TOKEN_SIGNING_KEY=$(openssl rand -base64 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
az containerapp secret set \
  --name "$IDENTITY_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --secrets "token-signing-key=$TOKEN_SIGNING_KEY" \
  --output none
az containerapp update \
  --name "$IDENTITY_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "BASE_URL=$IDENTITY_URL" \
    "WEBAUTHN_RP_ID=$IDENTITY_FQDN" \
    "WEBAUTHN_RP_ORIGIN=$IDENTITY_URL" \
    "WEBAUTHN_RP_ORIGINS=$IDENTITY_URL" \
    "TOKEN_SIGNING_KEY=secretref:token-signing-key" \
    "IDENTITY_TIMING=1" \
  --output none

# ── 5b. Deploy CSS Gate ───────────────────────────────────────
# The css-gate is the only public face of CSS (CSS itself runs with
# `--ingress internal`). Browser-facing apps point CSS_URL at the gate;
# the gate proxies to CSS_INTERNAL_URL and gates writes by bearer authz.
CSS_GATE_APP="${CSS_GATE_APP:-interego-css-gate}"
echo ">>> Deploying CSS Gate..."
# Idempotent on WRITE_SECRET: reuse the existing operator bearer if the
# app + secret already exist so re-runs don't rotate the gate's write
# credential. Falls back to a legacy plaintext env var on older revisions
# so the value can be migrated into the secret store on this deploy.
GATE_WRITE_SECRET=$(az containerapp secret show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" --secret-name gate-write-secret --query value -o tsv 2>/dev/null || true)
if [ -z "$GATE_WRITE_SECRET" ]; then
  GATE_WRITE_SECRET=$(az containerapp show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" --query "properties.template.containers[0].env[?name=='WRITE_SECRET'].value | [0]" -o tsv 2>/dev/null || true)
fi
if [ -z "$GATE_WRITE_SECRET" ]; then
  GATE_WRITE_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fi
az containerapp create \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-css-gate:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --cpu 0.5 \
  --memory 1Gi \
  --env-vars \
    "CSS_INTERNAL_URL=$CSS_INTERNAL_URL" \
    "IDENTITY_URL=$IDENTITY_URL" \
  --output none

# Store WRITE_SECRET as a Container Apps secret (not a plain env var) so
# the operator bearer — which bypasses the css-gate to write to any pod
# path — never appears in the revision spec or ARM activity logs.
az containerapp secret set \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --secrets "gate-write-secret=$GATE_WRITE_SECRET" \
  --output none
az containerapp update \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "WRITE_SECRET=secretref:gate-write-secret" \
  --output none

# Second pass: set PUBLIC_BASE_URL once the gate's own FQDN exists.
CSS_GATE_FQDN_TMP=$(az containerapp show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
az containerapp update \
  --name "$CSS_GATE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=https://$CSS_GATE_FQDN_TMP" \
  --output none

# CSS_GATE_URL is the gate's public FQDN — the only external face of
# CSS. CSS_BASE_URL gets set to this so issued WebIDs / Solid OIDC
# issuer metadata remain externally dereferenceable.
CSS_GATE_FQDN=$(az containerapp show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || true)
if [ -n "$CSS_GATE_FQDN" ]; then
  CSS_GATE_URL="https://$CSS_GATE_FQDN/"
  echo "    CSS gate (public): $CSS_GATE_URL"
else
  echo "    WARNING: $CSS_GATE_APP not deployed yet — falling back to internal URL for browser-facing apps. Deploy the gate, then re-run this script."
  CSS_GATE_URL="$CSS_INTERNAL_URL"
fi

# Set CSS_BASE_URL to the CSS internal FQDN.
#
# History: we previously set this to CSS_GATE_URL so issued WebIDs would
# externally dereference. That broke every server-side write path —
# relay /oauth/verify, identity manifest writes, federation-store
# writes — because the gate's reverse-proxy code path (raw https.request
# with a public Host header override) is hitting ECONNRESET under load
# (no ALPN h2, fragile keep-alive). CSS then rejects incoming requests
# whose Host doesn't match its configured baseUrl with "outside the
# configured identifier space", and server-side callers fail.
#
# Single-base CSS has no knob for "issue identifiers at FQDN A but
# accept requests from FQDN B" — a multi-base IdentifierStrategy
# would require a custom Components.js shim + a CSS image rebuild.
# Reverting to the internal FQDN restores every server-side caller
# immediately. The anon-write hole stays closed because CSS still runs
# with `--ingress internal` — there is no public CSS endpoint for
# anonymous traffic to reach, so baseUrl value is irrelevant to that.
#
# Cost: WebIDs minted while CSS_BASE_URL was pointing at the gate FQDN
# remain externally dereferenceable; new WebIDs issued from this point
# resolve only inside the Container Apps environment. Once the gate's
# upstream code path is hardened (replace raw https.request with
# undici.request to get ALPN h2 + Host-header override on a pooled
# Dispatcher), we can flip CSS_BASE_URL back to CSS_GATE_URL and
# re-issue any internal-FQDN WebIDs minted during this window.
echo ">>> Setting CSS_BASE_URL to CSS internal FQDN..."
az containerapp update \
  --name "$CSS_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "CSS_BASE_URL=$CSS_INTERNAL_URL" \
  --output none

# ── CSS ingress transport: explicit HTTP/1.1 ──
# Container Apps' default ingress transport is "Auto", which ALPN-advertises
# h2 alongside h1 on the public 443 side. Against this envoy, pooled h2
# produced sustained ECONNRESET storms in the gate's undici Pool, while the
# relay (Node fetch, h1) stayed healthy against the same upstream. Pinning
# the ingress to Http makes envoy advertise http/1.1 only, matching the
# relay's working path. Safe for the relay (it already speaks h1). The gate
# also defaults to allowH2=false in server.mjs; if that knob is ever
# flipped on (UPSTREAM_ALLOW_H2=1), revisit this transport pin first.
echo ">>> Pinning CSS ingress transport to HTTP/1.1..."
az containerapp ingress update \
  --name "$CSS_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --transport http \
  --output none

# ── Gate CSS_HOST_HEADER: match the upstream SNI ──
# The gate dials CSS at the internal hostname over TLS; envoy on the CSS
# side terminates that TLS and routes by SNI. The Host header forwarded to
# envoy/CSS MUST also match the internal hostname, otherwise envoy resets
# the stream (SNI ≠ Host mismatch) before CSS sees the request — observed
# as ECONNRESET on every gate forward. CSS_BASE_URL is the internal FQDN
# (see the long comment above that decision), so issuing a public-FQDN
# Host here is also the opposite of what CSS wants. Once CSS_BASE_URL
# flips back to the gate's public FQDN, this needs to flip too.
if [ -n "$CSS_GATE_FQDN" ]; then
  CSS_INTERNAL_HOST="${CSS_INTERNAL_URL#https://}"
  CSS_INTERNAL_HOST="${CSS_INTERNAL_HOST%/}"
  echo ">>> Setting gate CSS_HOST_HEADER to internal CSS host ($CSS_INTERNAL_HOST)..."
  az containerapp update \
    --name "$CSS_GATE_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "CSS_HOST_HEADER=$CSS_INTERNAL_HOST" \
    --output none
fi

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
  --env-vars "CSS_URL=$CSS_GATE_URL" \
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
  --cpu 1.0 \
  --memory 2.0Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" "RELAY_OAUTH_STORE_POD=${CSS_INTERNAL_URL%/}/svc-relay-dcr/" \
  --output none

RELAY_FQDN=$(az containerapp show --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    MCP Relay: https://$RELAY_FQDN"

# Wire the relay env vars the CI's "Wire relay env vars" step sets that
# couldn't be supplied at create time — PUBLIC_BASE_URL (OAuth issuer +
# hydra:target on every affordance + security.txt body + authorize
# redirect; defaults to http://localhost:8080 when unset, breaking
# OAuth) and IDENTITY_URL (/tokens/verify, /me, /agents/me, identity-
# token mint; defaults to http://localhost:8090 when unset). Identity
# isn't created by this script; tolerate its absence the same way the
# dashboard step does.
RELAY_IDENTITY_FQDN=$(az containerapp show --name interego-identity --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || true)
RELAY_ENV_VARS=("PUBLIC_BASE_URL=https://$RELAY_FQDN")
if [ -n "$RELAY_IDENTITY_FQDN" ]; then
  RELAY_ENV_VARS+=("IDENTITY_URL=https://$RELAY_IDENTITY_FQDN")
else
  echo "    WARNING: interego-identity not deployed yet — relay IDENTITY_URL left unset; re-run after identity is up."
fi
az containerapp update \
  --name "$RELAY_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "${RELAY_ENV_VARS[@]}" \
  --output none

# Wire the four extra dashboard env vars the CI's "Wire dashboard env vars"
# step sets — IDENTITY_URL (/api/identity proxy), RELAY_URL (OAuth code
# exchange + /identity-token), PUBLIC_RELAY_URL (browser-side /authorize
# redirect), PUBLIC_BASE_URL (OAuth redirect_uri). Without these, the
# dashboard can never complete OAuth on a fresh-cluster bootstrap that
# hasn't yet been touched by a CI deploy. Identity isn't created by this
# script; tolerate its absence so the bootstrap doesn't hard-fail before
# the identity app exists.
IDENTITY_FQDN=$(az containerapp show --name interego-identity --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || true)
DASHBOARD_ENV_VARS=("CSS_URL=$CSS_GATE_URL" "RELAY_URL=https://$RELAY_FQDN" "PUBLIC_RELAY_URL=https://$RELAY_FQDN" "PUBLIC_BASE_URL=https://$DASHBOARD_FQDN")
if [ -n "$IDENTITY_FQDN" ]; then
  DASHBOARD_ENV_VARS+=("IDENTITY_URL=https://$IDENTITY_FQDN")
else
  echo "    WARNING: interego-identity not deployed yet — dashboard IDENTITY_URL left unset; re-run after identity is up."
fi
echo ">>> Wiring dashboard env vars (CSS_URL, RELAY_URL, PUBLIC_RELAY_URL, PUBLIC_BASE_URL${IDENTITY_FQDN:+, IDENTITY_URL})..."
az containerapp update \
  --name "$DASHBOARD_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "${DASHBOARD_ENV_VARS[@]}" \
  --output none

# ── 8. Deploy PGSL Browser + Observatory ──────────────────────
BROWSER_APP="interego-pgsl-browser"
echo ">>> Building PGSL Browser image..."
az acr build \
  --registry "$ACR_NAME" \
  --image interego-pgsl-browser:latest \
  --file deploy/Dockerfile.pgsl-browser \
  .

echo ">>> Deploying PGSL Browser + Observatory..."
az containerapp create \
  --name "$BROWSER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-pgsl-browser:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 5000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" "PORT=5000" "POD_NAME=$POD_NAME" "CLEAN=1" \
  --output none

BROWSER_FQDN=$(az containerapp show --name "$BROWSER_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Browser:       https://$BROWSER_FQDN"
echo "    Observatory:   https://$BROWSER_FQDN/observatory"

# ── 9. Gate↔Relay token-introspection shared secret ────────────
#
# FIX B: the relay's OAuth flow mints opaque random-hex access tokens
# the identity server has never seen and cannot verify. When a browser
# / MCP client presents one of those tokens directly to the css-gate
# (e.g. a curl PUT to <pod>/<userId>/foo), the gate's existing
# identity-only verifier rejects it with 401 "identity returned 401".
#
# To fix that without sharing the relay's signing key or stuffing
# tokens into a shared store, we add POST /verify-token on the relay
# (token introspection RPC) and a fallback in the gate that hits it
# when identity returns 200+valid:false. Both sides authenticate the
# RPC itself with a shared secret carried in Authorization: Bearer.
#
# This block generates a fresh secret if either app is missing one
# (and they don't already share the same value), then sets the same
# value on BOTH apps. Idempotent — re-running with both env vars
# already aligned is a no-op (`az containerapp update` is convergent).
if [ -n "$CSS_GATE_FQDN" ]; then
  echo ">>> Configuring gate↔relay introspection secret..."
  # Read existing values from Container Apps secrets (preferred) with a
  # fallback to legacy plain env vars so re-deploys against an older
  # revision still align rather than rotating unnecessarily.
  GATE_SECRET=$(az containerapp secret show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" \
    --secret-name relay-introspection-secret --query value -o tsv 2>/dev/null || true)
  if [ -z "$GATE_SECRET" ]; then
    GATE_SECRET=$(az containerapp show --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" \
      --query "properties.template.containers[0].env[?name=='RELAY_INTROSPECTION_SECRET'].value | [0]" -o tsv 2>/dev/null || true)
  fi
  RELAY_SECRET=$(az containerapp secret show --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" \
    --secret-name relay-introspection-secret --query value -o tsv 2>/dev/null || true)
  if [ -z "$RELAY_SECRET" ]; then
    RELAY_SECRET=$(az containerapp show --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" \
      --query "properties.template.containers[0].env[?name=='RELAY_INTROSPECTION_SECRET'].value | [0]" -o tsv 2>/dev/null || true)
  fi
  if [ -n "$GATE_SECRET" ] && [ "$GATE_SECRET" = "$RELAY_SECRET" ]; then
    INTROSPECT_SECRET="$GATE_SECRET"
    echo "    introspection secret already aligned on both apps (no change)"
  else
    # Generate a 64-char hex secret. openssl is available on the build
    # image; node fallback in case it isn't.
    INTROSPECT_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo "    generated new 64-char introspection secret; syncing to both apps"
  fi

  # Store as a Container Apps secret (not a plain env var) so the value
  # never appears in the revision spec or ARM activity logs, then bind
  # the env var by secretref.
  az containerapp secret set --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" \
    --secrets "relay-introspection-secret=$INTROSPECT_SECRET" \
    --output none
  az containerapp update --name "$RELAY_APP" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "RELAY_INTROSPECTION_SECRET=secretref:relay-introspection-secret" \
    --output none
  az containerapp secret set --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" \
    --secrets "relay-introspection-secret=$INTROSPECT_SECRET" \
    --output none
  az containerapp update --name "$CSS_GATE_APP" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "RELAY_INTROSPECTION_SECRET=secretref:relay-introspection-secret" "RELAY_VERIFY_URL=https://$RELAY_FQDN" \
    --output none
  echo "    relay     : RELAY_INTROSPECTION_SECRET set (secretref)"
  echo "    css-gate  : RELAY_INTROSPECTION_SECRET (secretref) + RELAY_VERIFY_URL=https://$RELAY_FQDN set"
else
  echo ">>> Skipping gate↔relay introspection secret config — $CSS_GATE_APP not deployed."
fi

# ── Identity env wiring ───────────────────────────────────────
# Mirrors the CI workflow's "Wire identity env vars" step
# (.github/workflows/deploy-azure.yml) so a bootstrap deploy ends in
# the same configured state as a CI deploy. Without this, the identity
# server falls back to an ephemeral TOKEN_SIGNING_KEY (sessions die on
# every restart) and WEBAUTHN_RP_* is unset (passkey enrollment fails
# with rpID-mismatch). Guarded on the identity app existing because
# the identity-create step is handled separately.
IDENTITY_APP="${IDENTITY_APP:-interego-identity}"
IDENTITY_FQDN=$(az containerapp show --name "$IDENTITY_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || true)
if [ -n "$IDENTITY_FQDN" ]; then
  echo ">>> Wiring identity env vars..."
  # Idempotent on TOKEN_SIGNING_KEY: only generate a new HMAC key if
  # one isn't already configured, so existing user sessions survive
  # this deploy. Same check the CI workflow uses. Check the Container
  # Apps secret first, then fall back to a plaintext env var on older
  # deployments that pre-date the secretref migration.
  EXISTING_TOKEN_KEY=$(az containerapp secret show --name "$IDENTITY_APP" --resource-group "$RESOURCE_GROUP" \
    --secret-name token-signing-key --query value -o tsv 2>/dev/null || true)
  if [ -z "$EXISTING_TOKEN_KEY" ]; then
    EXISTING_TOKEN_KEY=$(az containerapp show --name "$IDENTITY_APP" --resource-group "$RESOURCE_GROUP" --query "properties.template.containers[0].env[?name=='TOKEN_SIGNING_KEY'].value | [0]" -o tsv 2>/dev/null || true)
  fi
  if [ -z "$EXISTING_TOKEN_KEY" ]; then
    echo "    TOKEN_SIGNING_KEY not yet configured — generating fresh 32-byte HMAC key."
    NEW_TOKEN_KEY=$(openssl rand -base64 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
    az containerapp secret set \
      --name "$IDENTITY_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --secrets "token-signing-key=$NEW_TOKEN_KEY" \
      --output none
    az containerapp update \
      --name "$IDENTITY_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --set-env-vars \
        "BASE_URL=https://$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ID=$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ORIGIN=https://$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ORIGINS=https://$IDENTITY_FQDN,https://$RELAY_FQDN" \
        "RELAY_URL=https://$RELAY_FQDN" \
        "TOKEN_SIGNING_KEY=secretref:token-signing-key" \
        "IDENTITY_TIMING=1" \
      --output none
  else
    echo "    TOKEN_SIGNING_KEY already configured — preserving so sessions survive this deploy."
    # Ensure the key is stored as a secret + bound by secretref even if
    # the prior deploy stored it as a plaintext env var.
    az containerapp secret set \
      --name "$IDENTITY_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --secrets "token-signing-key=$EXISTING_TOKEN_KEY" \
      --output none
    az containerapp update \
      --name "$IDENTITY_APP" \
      --resource-group "$RESOURCE_GROUP" \
      --set-env-vars \
        "BASE_URL=https://$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ID=$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ORIGIN=https://$IDENTITY_FQDN" \
        "WEBAUTHN_RP_ORIGINS=https://$IDENTITY_FQDN,https://$RELAY_FQDN" \
        "RELAY_URL=https://$RELAY_FQDN" \
        "TOKEN_SIGNING_KEY=secretref:token-signing-key" \
        "IDENTITY_TIMING=1" \
      --output none
  fi
else
  echo ">>> Skipping identity env wiring — $IDENTITY_APP not deployed."
fi

# ── 10. Deploy Foxxi Bridge ───────────────────────────────────
FOXXI_BRIDGE_APP="${FOXXI_BRIDGE_APP:-interego-foxxi-bridge}"
echo ">>> Deploying Foxxi Bridge..."
az containerapp create \
  --name "$FOXXI_BRIDGE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-foxxi-bridge:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 6080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.5 \
  --memory 1Gi \
  --env-vars "CSS_URL=$CSS_INTERNAL_URL" "IDENTITY_URL=$IDENTITY_URL" "RELAY_URL=https://$RELAY_FQDN" \
  --output none

FOXXI_BRIDGE_FQDN=$(az containerapp show --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Foxxi Bridge: https://$FOXXI_BRIDGE_FQDN"

# Foxxi bridge env wiring — mirrors the CI workflow's
# "Wire foxxi-bridge env vars" step. The bridge revision carries 19
# vertical-specific vars (tenant pod URL, audience, admin WebID,
# federation pod list, LRS basic-auth pairs, LLM API key, key seeds,
# bridge private key, write secret, ...). The create above only sets
# CSS_URL/IDENTITY_URL/RELAY_URL, so on any subsequent re-run the
# create call would no-op while the bridge boots half-configured —
# same trap as the old CSS_URL pattern. We read each var off the live
# revision and re-assert it, promoting the five sensitive values to
# Container Apps secrets. Vars unset on the live revision are skipped
# with a warning; the operator must seed them once before the next
# redeploy.
echo ">>> Wiring foxxi-bridge env vars..."
fb_read_env() {
  az containerapp show --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.template.containers[0].env[?name=='$1'].value | [0]" -o tsv 2>/dev/null || true
}
fb_read_secretref() {
  az containerapp show --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" \
    --query "properties.template.containers[0].env[?name=='$1'].secretRef | [0]" -o tsv 2>/dev/null || true
}
fb_read_secret_value() {
  az containerapp secret show --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" \
    --secret-name "$1" --query value -o tsv 2>/dev/null || true
}
FB_PLAIN_VARS=(FOXXI_TENANT_POD_URL FOXXI_AUTHORITATIVE_SOURCE FOXXI_AUDIENCE FOXXI_DASHBOARD_ORIGIN BRIDGE_DEPLOYMENT_URL FOXXI_ADMIN_WEB_ID FOXXI_REQUIRE_AUTH FOXXI_TENANT_PROFILE_NAME FOXXI_LEARNING_ENGINEER_WEB_IDS FOXXI_LRS_BASIC_AUTH_PAIRS FOXXI_FEDERATION_PODS FOXXI_AGENTIC_RATE_LIMIT_PER_IP FOXXI_LRS_BACKEND)
FB_SECRET_VARS=(FOXXI_LLM_API_KEY FOXXI_ADMIN_KEY_SEED FOXXI_ISSUER_KEY_SEED FOXXI_BRIDGE_PRIVATE_KEY FOXXI_POD_WRITE_SECRET)
FB_SET_ARGS=()
for v in "${FB_PLAIN_VARS[@]}"; do
  val=$(fb_read_env "$v")
  if [ -n "$val" ]; then
    FB_SET_ARGS+=("$v=$val")
    echo "    preserve $v (plain)"
  else
    echo "    WARN: $v unset on live $FOXXI_BRIDGE_APP revision — skipping; seed it once before the next redeploy"
  fi
done
for v in "${FB_SECRET_VARS[@]}"; do
  sname=$(echo "$v" | tr 'A-Z_' 'a-z-')
  existing_ref=$(fb_read_secretref "$v")
  if [ -n "$existing_ref" ]; then
    FB_SET_ARGS+=("$v=secretref:$existing_ref")
    echo "    preserve $v (secretref:$existing_ref)"
    continue
  fi
  val=$(fb_read_env "$v")
  if [ -n "$val" ]; then
    az containerapp secret set --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" \
      --secrets "$sname=$val" --output none
    FB_SET_ARGS+=("$v=secretref:$sname")
    echo "    promote $v plain->secretref:$sname"
    continue
  fi
  existing_secret=$(fb_read_secret_value "$sname")
  if [ -n "$existing_secret" ]; then
    FB_SET_ARGS+=("$v=secretref:$sname")
    echo "    bind $v->secretref:$sname (secret already configured)"
  else
    echo "    WARN: $v unset on live $FOXXI_BRIDGE_APP revision — skipping; seed it once before the next redeploy"
  fi
done
if [ "${#FB_SET_ARGS[@]}" -gt 0 ]; then
  az containerapp update --name "$FOXXI_BRIDGE_APP" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "${FB_SET_ARGS[@]}" --output none
fi

# ── 11. Deploy Foxxi Dashboard ────────────────────────────────
FOXXI_DASHBOARD_APP="${FOXXI_DASHBOARD_APP:-interego-foxxi-dashboard}"
echo ">>> Deploying Foxxi Dashboard..."
az containerapp create \
  --name "$FOXXI_DASHBOARD_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-foxxi-dashboard:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "BRIDGE_URL=https://$FOXXI_BRIDGE_FQDN" \
  --output none

FOXXI_DASHBOARD_FQDN=$(az containerapp show --name "$FOXXI_DASHBOARD_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Foxxi Dashboard: https://$FOXXI_DASHBOARD_FQDN"

# ── 12. Deploy Foxxi Microsite ────────────────────────────────
FOXXI_MICROSITE_APP="${FOXXI_MICROSITE_APP:-interego-foxxi-microsite}"
echo ">>> Deploying Foxxi Microsite..."
az containerapp create \
  --name "$FOXXI_MICROSITE_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-foxxi-microsite:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "BRIDGE_URL=https://$FOXXI_BRIDGE_FQDN" \
  --output none

FOXXI_MICROSITE_FQDN=$(az containerapp show --name "$FOXXI_MICROSITE_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Foxxi Microsite: https://$FOXXI_MICROSITE_FQDN"

# ── 13. Deploy Foxxi SCORM Player ─────────────────────────────
FOXXI_SCORM_APP="${FOXXI_SCORM_APP:-interego-foxxi-scorm-player}"
echo ">>> Deploying Foxxi SCORM Player..."
az containerapp create \
  --name "$FOXXI_SCORM_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-foxxi-scorm-player:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --env-vars "BRIDGE_URL=https://$FOXXI_BRIDGE_FQDN" \
  --output none

FOXXI_SCORM_FQDN=$(az containerapp show --name "$FOXXI_SCORM_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Foxxi SCORM Player: https://$FOXXI_SCORM_FQDN"

# ── 14. Deploy Acme ID ────────────────────────────────────────
ACME_ID_APP="${ACME_ID_APP:-interego-acme-id}"
echo ">>> Deploying Acme ID..."
az containerapp create \
  --name "$ACME_ID_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-acme-id:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --output none

ACME_ID_FQDN=$(az containerapp show --name "$ACME_ID_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Acme ID: https://$ACME_ID_FQDN"

# ── 15. Deploy Interego Main ──────────────────────────────────
INTEREGO_MAIN_APP="${INTEREGO_MAIN_APP:-interego-main}"
echo ">>> Deploying Interego Main..."
az containerapp create \
  --name "$INTEREGO_MAIN_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --image "$ACR_LOGIN_SERVER/interego-main:latest" \
  --registry-server "$ACR_LOGIN_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --output none

INTEREGO_MAIN_FQDN=$(az containerapp show --name "$INTEREGO_MAIN_APP" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "    Interego Main: https://$INTEREGO_MAIN_FQDN"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Services:"
echo "  CSS (internal):       $CSS_INTERNAL_URL"
echo "  CSS Gate:             https://$CSS_GATE_FQDN_TMP"
echo "  Identity:             $IDENTITY_URL"
echo "  Dashboard:            https://$DASHBOARD_FQDN"
echo "  MCP Relay:            https://$RELAY_FQDN"
echo "  PGSL Browser:         https://$BROWSER_FQDN"
echo "  Observatory:          https://$BROWSER_FQDN/observatory"
echo "  Foxxi Bridge:         https://$FOXXI_BRIDGE_FQDN"
echo "  Foxxi Dashboard:      https://$FOXXI_DASHBOARD_FQDN"
echo "  Foxxi Microsite:      https://$FOXXI_MICROSITE_FQDN"
echo "  Foxxi SCORM Player:   https://$FOXXI_SCORM_FQDN"
echo "  Acme ID:              https://$ACME_ID_FQDN"
echo "  Interego Main:        https://$INTEREGO_MAIN_FQDN"
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
