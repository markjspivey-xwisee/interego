# Private health connections for Interego

An isolated source bridge for Duke MyChart (SMART on FHIR R4) and selected Apple Health samples. An Oura adapter is present but retained Oura imports and reads are hard-disabled pending provider authorization and a separately reviewed design. Imported source records and refresh tokens stay encrypted in a private operational store. An Interego agent reads them through signed, owner-bound affordances. Source authorization alone does not publish records; a separately linked browser publisher reviews the first public Atlas snapshot and can opt into later structured updates after Duke syncs.

The bridge does not claim that a medication order proves a dose was administered. It preserves provider resources, sample origin, clinical date, retrieval date and source-specific coverage. Oura and mirrored Apple Health readings remain separate observations and are never added together.

## Start

Use Node 22 or later. Install the bridge's one runtime dependency with `npm install`, then run `npm test`. Set the configuration below and run `npm start`.

Required deployment settings:

* `HEALTH_PUBLIC_URL`: the bridge's HTTPS origin.
* `HEALTH_RECORD_KEY`: 32 cryptographically random bytes encoded as 64 hexadecimal characters. Keep this stable and backed up; losing it loses access to encrypted records.
* `HEALTH_STORE_URL`: a dedicated, operator-controlled Solid container. Only encrypted records are written here. Alternatively use `HEALTH_DATA_DIRECTORY` on a durable local volume for local deployments; never an ephemeral container directory for live imports.
* `INTEREGO_RELAY_URL`: the existing Interego relay origin.
* `INTEREGO_IDENTITY_HOST`: its identity host.
* `INTEREGO_TRUSTED_RELAY_ADDRESSES`: verified relay delegation signing addresses.

Optional server settings: `HEALTH_STORE_BEARER`, `PORT`, `HOST`. Raw records, access tokens, refresh tokens, authorization codes and pairing tokens must never be logged or committed.

Duke requires an Epic-registered patient-facing application. Set `DUKE_CLIENT_ID` and either `DUKE_CLIENT_SECRET` or a configured `DUKE_PRIVATE_KEY_PEM` plus `DUKE_KEY_ID`. The callback is `${HEALTH_PUBLIC_URL}/oauth/duke/callback`; the public signing-key document is `${HEALTH_PUBLIC_URL}/.well-known/jwks.json`. Registration, production distribution and patient/proxy approval remain external prerequisites. No fabricated client ID, consent or source connection is supplied by this code.

Oura retained imports need provider authorization; app registration and user OAuth alone are insufficient. The service reports `authorization_required` and blocks Oura connection starts, callbacks, sync, imports and source-record reads even when credentials are configured. No runtime flag enables the adapter. A future provider-authorized implementation requires a separately reviewed code change. Existing private Oura records, if any, are excluded from general record listings; disconnection remains available for credential cleanup.

Apple Health uses a selected-sample Shortcut upload. Sign in, enable private imports, create an upload-only pairing token, then follow [the iPhone recipe](docs/apple-shortcut.md). The bridge cannot read HealthKit directly from a cloud server. XML export import and a native HealthKit companion are possible later transports, not implemented readers.

Browser sign-in exchanges the Interego OAuth code on the server, then uses that credential for a stateless MCP `tools/call` of `sign_request` at the relay's `/mcp` resource. It accepts bounded JSON or SSE responses for the matching request ID and verifies the returned signature, account, destination and fresh challenge before issuing an HttpOnly bridge session. The relay's `/tool/sign_request` shortcut takes identity-server credentials and cannot verify the opaque OAuth credential this flow receives. The bridge discards the Interego credential after this proof; it does not exchange it for an identity token or require an introspection secret.

## Agent interface

Read `/profile` for the JSON action targets and signing instructions. Its `turtle` property and HTTP alternate link point to `/profile.ttl`, the same declarations as native `iep:Affordance` / Hydra operations. Interego's `dereference` and generic affordance follower can discover all eight actions there, including the signed-envelope input shape.

Sign `{action,target,params,nonce}` with Interego `sign_request`: `action` is the selected action IRI, `target` is the bridge origin, `params` contains that action's arguments, and `nonce` is a fresh random string at least 16 characters long. Then call Interego `act` with `descriptor_url: "<bridge-origin>/profile.ttl"`, the selected `action_iri`, and the returned `{_signed_payload,_signature}` envelope passed unchanged as `payload`. The descriptor resolves the `POST /actions` transport target; do not replace the signed `target` origin with that endpoint or parse/reserialize the signed payload string.

Records are limited to the verified signer's own account. Read results preserve raw source evidence and do not establish clinical truth. No action publishes patient data to the public web. Native extractor/follower verification can run separately with the repository's root `tsx` development tool; the standalone bridge suite and production serving require no TypeScript runtime.

Private import consent is explicit and revocable. Source refresh is user-triggered unless a deployment operator configures a separate, explicitly authorized schedule. This service creates no timer or always-running polling task by default.

## Public Atlas publishing

Set `ATLAS_ADMIN_PRINCIPAL`, `ATLAS_EXPECTED_NAME` and `ATLAS_EXPECTED_BIRTH_DATE` to enable the fixed Mayya Atlas integration. The curated public baseline is `atlas-base.json`. The configured administrator can use the signed `atlas/link` action to create a single-use, 30-minute browser enrollment link. It does not read another account's source records or publish anything. The signed-in browser claims that link only after its imported Duke Patient record matches the configured subject; the stored publisher is then pinned to that verified principal and chart. No MCP account switch is required. Subsequent chart changes or relinking attempts are refused.

The browser's Atlas panel prepares an immutable preview, shows its structured clinical contents, source dates and exclusions, and submits the exact draft/digest/base revision with CSRF and Origin checks. Raw FHIR, identifiers, demographics, free-text notes, PDFs and attachments never enter the public projection. Patient-bound coded findings, numeric results, orders, procedures and coded document metadata can supplement the curated history without rewriting its dates or FAQ. Orders do not establish administered doses. This named record with clinical dates is a sanitized public snapshot, not an anonymous dataset or a complete chart.

The publisher may opt into updates of those same supported fields after future Duke syncs, and pause that behavior separately from imports. Failed public updates do not erase successful private imports. No public GET reads live private records: `/public/atlas/mayya/record.json`, `.md`, `.jsonld` and `.ttl` serve only the approved copy at one revision, with `Cache-Control: no-store`. Before the first publication they return404. The public Atlas Worker reads these anonymous endpoints for both its human view and agent formats; unavailable publications have an explicitly labeled curated baseline fallback. Signing in, importing, or issuing an enrollment link does not create a public release.

## Validation boundaries

Tests use synthetic fixtures only. The browser login regression exercises PKCE, the callback cookie, the MCP signed challenge and the resulting owner-bound session against an in-process relay with a generated signing key; it does not replace a live passkey sign-in. Provider metadata discovery can be verified without patient data. Real Duke, Oura and iPhone receipt tests require their actual consent flows. A configured app or successful deployment is not proof that a patient's records have synced.
