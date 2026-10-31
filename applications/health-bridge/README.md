# Private health connections for Interego

An isolated source bridge for Duke MyChart (SMART on FHIR R4), selected Apple Health samples and Oura. Imported source records and refresh tokens stay encrypted in a private operational store. An Interego agent reads them through signed, owner-bound affordances. Nothing is automatically published to the public Health Atlas.

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

Oura requires an Oura OAuth app. Set `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET`; register `${HEALTH_PUBLIC_URL}/oauth/oura/callback`. The wearer approves the requested scopes on Oura's own page.

Apple Health uses a selected-sample Shortcut upload. Sign in, enable private imports, create an upload-only pairing token, then follow [the iPhone recipe](docs/apple-shortcut.md). The bridge cannot read HealthKit directly from a cloud server. XML export import and a native HealthKit companion are possible later transports, not implemented readers.

## Agent interface

Read `/profile` for the current action targets and schemas. Sign the exact `{action,target,params,nonce}` payload with Interego `sign_request`, then pass the returned envelope unchanged to `POST /actions`. Records are limited to the verified signer's own account. Read results preserve raw source evidence and do not establish clinical truth. No action publishes patient data to the public web.

Private import consent is explicit and revocable. Source refresh is user-triggered unless a deployment operator configures a separate, explicitly authorized schedule. This service creates no timer or always-running polling task by default.

## Validation boundaries

Tests use synthetic fixtures only. Provider metadata discovery can be verified without patient data. Real Duke, Oura and iPhone receipt tests require their actual consent flows. A configured app or successful deployment is not proof that a patient's records have synced.
