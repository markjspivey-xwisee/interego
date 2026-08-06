/**
 * `@interego/workspace-client` — the transport-agnostic half of the shared-workspace client.
 *
 * ★ THIS PACKAGE EXISTS SO THERE IS EXACTLY ONE COPY OF IT.
 * The published artifact and the desktop shell differ in ONE thing: how a tool call reaches
 * the relay. Everything else — the Turtle readers and their comment/literal masking, the
 * region locator, the naming scheme, the seat fold, the chain walk, the compare-and-swap
 * append, the honesty rules about absence — is the same logic, and when it existed twice it
 * drifted every single time. The artifact's script is GENERATED from this package
 * (`tools/build-workspace-artifact.mjs`) and a test fails when the generated block in the
 * published file differs from a fresh build.
 *
 * What is NOT here, deliberately: anything that touches a DOM. A shell draws; this decides.
 */

export {
  BAD_IRI, WSP, IEP,
  scanTurtle, maskFill, masked, maskComments, literalAt, unescapeLiteral,
  forms, nsOf, readLiteral, readIri, readIriList, readInt, hasTrue, hasType,
  graphRegion, escapeTurtleLiteral, parseRoleProfile,
  type SpanKind, type RoleProfile,
} from './turtle.js';

export {
  POD_RX, SLUG_RX, slugProblem, nsIri, qualifiedName, legacyName, memberDocIris,
  parseAcceptanceIri, podOfWebid, podOfNsIri, podOfDescriptorUrl, podBaseOfDescriptorUrl,
  podClaimVsServed, assignPodMarks, parseWorkspaceIri,
  type MemberDocKind, type Naming, type ParsedAcceptance, type PodClaimCheck,
} from './naming.js';

export {
  ToolCallError, fail, refusal, asRefusal,
  RelayMcpTransport, ConnectorTransport,
  type Credential, type RelayOAuthBearer, type ConnectorGrant, type IdentityServerToken,
  type Transport, type AnyTransport, type CallOptions, type ConnectorMcp,
  type Unsubscribe, type WatchEvent,
} from './transport.js';

export {
  REQUIRED_TOOLS, PROBE_TOOL, errorCopy, assertPod, WorkspaceClient,
  type HeadResult, type WorkspaceRecord, type MemberDocLookup,
} from './substrate.js';

export { orderChain, toChainRow, type ChainRow, type ChainWalk } from './chain.js';

export {
  entryTurtle, preconditionLine, entryShapeAnswer, postEntry, type PostOutcome,
} from './entry.js';

export { foldRoster, GRANT_LIMIT, GRANT_READ_CAP, type Seat, type RosterFold } from './seats.js';
