/**
 * THE RELAY TRANSPORT IS NOT HERE ANY MORE, AND THAT IS THE POINT.
 *
 * ★ WHAT MOVED AND WHY. `RelayMcpTransport`, `ConnectorTransport`, the `Transport` interface, the
 * credential union, `pollingWatch`, and the two refusal shapes all lived in this package — a
 * VERTICAL's client — and not one line of any of them was about workspaces. They are the relay's
 * `/mcp` endpoint, the relay's OAuth bearer and its rotating refresh token, the relay's two ways of
 * signalling a refusal, and the measurement that establishes this deployment has no push channel to
 * subscribe to. Every client in every vertical needs those, and a peer vertical reaching sideways
 * into shared-workspace to reach a relay is worse than either of them owning it. They are now in
 * `@interego/core/relay`.
 *
 * ★ WHY THIS FILE STILL EXISTS RATHER THAN EVERY CALL SITE BEING REWRITTEN. The published artifact
 * is GENERATED from this package's entry point (`tools/build-workspace-artifact.mjs`), so what this
 * package exports is what the artifact's one bundle contains. Re-exporting keeps the page pulling
 * the SUBSTRATE implementation into itself; asking forty call sites to add a second import would
 * change nothing about layering and would guarantee that some of them eventually import a copy.
 * Nothing below is defined here — `tests/core-delegate.test.ts` asserts function identity across
 * the two import paths for exactly this class of move, and a copy cannot satisfy that.
 */

export {
  ToolCallError, fail, refusal, asRefusal, pollingWatch,
  RelayMcpTransport, ConnectorTransport,
} from '@interego/core/relay';
export type {
  Credential, RelayOAuthBearer, ConnectorGrant, IdentityServerToken,
  Transport, AnyTransport, CallOptions, ConnectorMcp,
  Unsubscribe, WatchEvent,
} from '@interego/core/relay';
