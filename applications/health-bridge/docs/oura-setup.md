# Oura connection

This adapter is a read-only Oura Cloud API v2 client. It does not contain an account, client credential, live user grant, scheduled job, webhook, public data export or clinical interpretation.

## Register the application

The Oura account holder must register an application in Oura's developer portal and review its current agreement. Use the deployed bridge's exact `/oauth/oura/callback` URL as an allowed redirect URI. Store the resulting client ID and client secret only in the bridge's runtime secret configuration. The module uses the authorization-code flow; the browser never receives the client secret.

Oura's [current member guide](https://support.ouraring.com/hc/en-us/articles/4415266939155-The-Oura-API) links its current developer portal. The legacy documentation sidebar labels Personal Access Tokens deprecated. The adapter does not support PAT configuration or the discontinued v1 API. Gen3 and later API access requires an active Oura Membership, according to that member guide.

## Authorization and refresh

1. The bridge creates a cryptographically random one-time state value and a PKCE verifier. Bind both to the signed-in Interego owner and this pending Oura connection, with a short expiry.
2. Call `ouraAuthorizationRequest` with the client ID, exact redirect URI, state, and verifier. Defaults request only `daily heartrate`. Add `spo2` only if the user chooses that information. Email and profile access are not requested.
3. The user signs into Oura and chooses which permissions to grant. Oura may omit scope from the callback; do not assume that requested scopes were granted.
4. On callback, verify and consume state before exchanging the code. Call `exchangeOuraCode` with the saved PKCE verifier and exact redirect URI. Save tokens only in the encrypted private connection vault.
5. Serialize refresh operations per connection. Oura refresh tokens are single-use. Persist the replacement refresh token returned by `refreshOuraToken` before making additional API calls. An ambiguous refresh timeout must not trigger repeated attempts with the same old token.
6. Record actual permission coverage on each sync. A denied endpoint, missing membership, or partial result is not evidence of a normal/negative measurement.

OAuth endpoints, PKCE and scopes are documented in [Oura authentication](https://cloud.ouraring.com/docs/authentication). Every API request has the required identifying `User-Agent` header. Code and token exchange requests follow no HTTP redirects.

## Data coverage

`daily` covers daily sleep, readiness and activity summaries plus detailed sleep documents. `heartrate` permits time-series heart-rate readings. `spo2`, when granted, permits daily oxygen summaries. No claim is made that these reproduce every metric visible in the Oura app.

`syncOura` processes at most 31 inclusive calendar days per run. The default is the most recent 30 days. Backfills must use smaller successive windows and explicit request budgets. API errors, page/byte/record limits, or repeated pagination cursors produce an incomplete result and retain the previous watermark. Subsequent incremental runs should overlap earlier days because Oura can revise daily records after initial synchronization. This implementation polls only when invoked; it has no hidden recurring workload.

Records preserve their Oura source, collection name, provider ID or explicitly labeled derived ID, source date and retrieval date. Proprietary readiness/sleep/activity scores remain Oura scores. The adapter never adds them to Apple Health values or treats them as clinical lab measurements. Data mirrored into Apple Health may describe the same observation; an integration must choose a preferred source or match source/time identifiers before computing totals.

## Privacy and use boundary

Raw Oura data and credentials belong in private encrypted storage. Connecting Oura does not authorize publication to the public medical Atlas. The current [Oura API and MCP Agreement](https://cloud.ouraring.com/legal/api-agreement), effective June 8, 2026, contains provisions concerning storage, onward sharing, AI use and aggregators; the application owner must review the applicable terms and obtain any required Oura authorization. The service must honor disconnection and deletion. The adapter neither accepts terms nor determines legal eligibility for a particular deployment.

The Oura-operated MCP path is a different integration. Its agreement has an express storage/cache restriction; do not assume that reading through MCP authorizes persistent Interego imports. The present adapter implements only the direct API path.

## Verified primary technical references

- [Oura authentication](https://cloud.ouraring.com/docs/authentication)
- [Oura API v2](https://cloud.ouraring.com/v2/docs)
- [OpenAPI 1.43](https://cloud.ouraring.com/v2/static/json/openapi-1.43.json), linked by the v2 documentation HTML
- [Error handling](https://cloud.ouraring.com/docs/error-handling)
- [Member API guide](https://support.ouraring.com/hc/en-us/articles/4415266939155-The-Oura-API)
- [Export/share options](https://support.ouraring.com/hc/en-us/articles/360025441594-Export-Share-Your-Oura-Data)

No live Oura account or real ring data was used during implementation tests. Registration, consent, membership status and live data coverage remain unverified until the account holder connects.
