# Oura connection

## Status: retained Interego imports are disabled

The read-only Oura Cloud API v2 adapter and its tests exist as technical reference code behind a disabled activation gate. This bridge has no authorized live Oura connection. App registration, client credentials and the ring user's OAuth consent are **not sufficient** to activate the intended retained-record and agent-access flow.

The current [Oura API and MCP Agreement](https://cloud.ouraring.com/legal/api-agreement), effective June 8, 2026, places two direct constraints on that flow:

- **Section 4(d):** Oura API data may not be supplied as input to AI models or AI platforms. For permitted non-aggregator LLM use, the agreement specifies Oura's own MCP server instead.
- **Section 3(m):** storing or caching data obtained through Oura's MCP server requires separate written Oura authorization. It also imposes additional retention restrictions, including a storage/cache prohibition for aggregators.

Private hosting and patient OAuth consent do not remove these conditions. Before activation, obtain Oura's written authorization for the specific Interego storage and agent-access use and implement an approved retention, opt-out and deletion design. The agreement's Section 5(f) requires processing to stop when consent is revoked and requested deletion within 72 hours. Do not treat disconnecting a source while leaving its records agent-readable as a completed opt-out/deletion workflow.

No Oura-operated MCP connection or on-demand proxy is implemented here. Neither an MCP proxy nor an Apple Health mirror is offered as a workaround for Oura's conditions. Public Atlas publication is not implemented or authorized by connecting a source.

## Technical registration reference — inactive

After the activation conditions above are resolved, the account holder would register an application in Oura's developer portal and review its current agreement. The adapter's redirect URI is the deployed bridge's exact `/oauth/oura/callback` URL. Resulting client credentials belong only in runtime secret configuration. The authorization-code flow keeps the client secret out of the browser. These configuration details do not establish permission to activate this bridge.

Oura's [current member guide](https://support.ouraring.com/hc/en-us/articles/4415266939155-The-Oura-API) links its current developer portal. The legacy documentation sidebar labels Personal Access Tokens deprecated. The adapter does not support PAT configuration or the discontinued v1 API. Gen3 and later API access requires an active Oura Membership, according to that member guide.

## Authorization and refresh reference — inactive

1. The bridge creates a cryptographically random one-time state value and a PKCE verifier. Bind both to the signed-in Interego owner and this pending Oura connection, with a short expiry.
2. Call `ouraAuthorizationRequest` with the client ID, exact redirect URI, state, and verifier. Defaults request only `daily heartrate`. Add `spo2` only if the user chooses that information. Email and profile access are not requested.
3. The user signs into Oura and chooses which permissions to grant. Oura may omit scope from the callback; do not assume that requested scopes were granted.
4. On callback, verify and consume state before exchanging the code. Call `exchangeOuraCode` with the saved PKCE verifier and exact redirect URI. Save tokens only in the encrypted private connection vault.
5. Serialize refresh operations per connection. Oura refresh tokens are single-use. Persist the replacement refresh token returned by `refreshOuraToken` before making additional API calls. An ambiguous refresh timeout must not trigger repeated attempts with the same old token.
6. Record actual permission coverage on each sync. A denied endpoint, missing membership, or partial result is not evidence of a normal/negative measurement.

OAuth endpoints, PKCE and scopes are documented in [Oura authentication](https://cloud.ouraring.com/docs/authentication). Every API request has the required identifying `User-Agent` header. Code and token exchange requests follow no HTTP redirects.

## Adapter coverage reference — inactive

`daily` covers daily sleep, readiness and activity summaries plus detailed sleep documents. `heartrate` permits time-series heart-rate readings. `spo2`, when granted, permits daily oxygen summaries. No claim is made that these reproduce every metric visible in the Oura app.

`syncOura` processes at most 31 inclusive calendar days per run. The default is the most recent 30 days. Backfills must use smaller successive windows and explicit request budgets. API errors, page/byte/record limits, or repeated pagination cursors produce an incomplete result and retain the previous watermark. Subsequent incremental runs should overlap earlier days because Oura can revise daily records after initial synchronization. This implementation polls only when invoked; it has no hidden recurring workload.

Records preserve their Oura source, collection name, provider ID or explicitly labeled derived ID, source date and retrieval date. Proprietary readiness/sleep/activity scores remain Oura scores. The adapter never adds them to Apple Health values or treats them as clinical lab measurements. Data mirrored into Apple Health may describe the same observation; an integration must choose a preferred source or match source/time identifiers before computing totals.

## Storage and use boundary

Encryption is a security control, not authorization for retention or AI access. The adapter does not accept Oura's terms or determine that this deployment qualifies for any permitted-use category. It must remain disabled until the specific authorization and data-lifecycle conditions above are resolved.

No live Oura data should be imported or retained while that gate is disabled. The technical API implementation below it does not establish a working or approved Oura connection.

## Verified primary technical references

- [Oura authentication](https://cloud.ouraring.com/docs/authentication)
- [Oura API v2](https://cloud.ouraring.com/v2/docs)
- [OpenAPI 1.43](https://cloud.ouraring.com/v2/static/json/openapi-1.43.json), linked by the v2 documentation HTML
- [Error handling](https://cloud.ouraring.com/docs/error-handling)
- [Member API guide](https://support.ouraring.com/hc/en-us/articles/4415266939155-The-Oura-API)
- [Export/share options](https://support.ouraring.com/hc/en-us/articles/360025441594-Export-Share-Your-Oura-Data)

No live Oura account or real ring data was used during implementation tests. Written authorization, retention/deletion behavior, registration, consent, membership status and live data coverage remain unresolved or unverified. Passing adapter tests does not satisfy these activation requirements.
