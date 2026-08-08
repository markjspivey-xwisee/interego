/**
 * @module relay
 * @description Talking to an Interego relay: the transport, and the client over it.
 *
 * ★ A NARROW SUBPATH, DELIBERATELY. Reached as `@interego/core/relay`, this pulls in nothing but
 * `../model/delegate.js` — which is type-only at runtime. A published Artifact, an Electron
 * renderer and a Node CLI all have to be able to call a relay tool without dragging SPARQL, SHACL
 * and `node:crypto` through the core barrel to do it, which is exactly why the delegate affordance
 * has its own subpath too.
 */

export {
  ToolCallError, fail, refusal, asRefusal, pollingWatch,
  RelayMcpTransport, ConnectorTransport,
  type Credential, type RelayOAuthBearer, type ConnectorGrant, type IdentityServerToken,
  type Transport, type AnyTransport, type CallOptions, type ConnectorMcp,
  type Unsubscribe, type WatchEvent,
} from './transport.js';

export {
  RelayClient, errorCopy, assertPod, type HeadResult,
} from './client.js';
