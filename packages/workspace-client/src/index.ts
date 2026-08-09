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
  BAD_IRI, WSP, IEP, PROV,
  scanTurtle, maskFill, masked, maskComments, literalAt, unescapeLiteral,
  forms, nsOf, readLiteral, readIri, readIriAll, readIriList, readInt, hasTrue, hasType,
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
  ToolCallError, fail, refusal, asRefusal, pollingWatch,
  RelayMcpTransport, ConnectorTransport,
  type Credential, type RelayOAuthBearer, type ConnectorGrant, type IdentityServerToken,
  type Transport, type AnyTransport, type CallOptions, type ConnectorMcp,
  type Unsubscribe, type WatchEvent,
} from './transport.js';

export {
  REQUIRED_TOOLS, PROBE_TOOL, errorCopy, assertPod, WorkspaceClient,
  type HeadResult, type WorkspaceRecord, type MemberDocLookup,
} from './substrate.js';

export { RESPOND_AS_MEMBER, actionUrl, actionUrn, actionKey, sameAction } from './actions.js';

export { orderChain, toChainRow, type ChainRow, type ChainWalk } from './chain.js';

export { shortRef } from './format.js';

export {
  entryTurtle, preconditionLine, entryShapeAnswer, postEntry,
  type PostOutcome, type EntryAuthor,
} from './entry.js';

export {
  foldRoster, grantPodFor, GRANT_LIMIT, GRANT_READ_CAP, type Seat, type RosterFold,
} from './seats.js';

export {
  turtleIri, shapesTurtle, rolesTurtle, workspaceTurtle, grantTurtle, acceptanceTurtle, canvasTurtle,
} from './documents.js';

export {
  readViewer, composedHandle, checkOwnHandle, checkWriteEligibility,
  createWorkspace, resolveInvitee, sendInvite,
  GRANT_IRI_RX, verifyGrantIri, acceptGrant, revokeGrant,
  INBOX_LIMIT, readInbox, verifyInvitation,
  SEAT_SCAN_LIMIT, SEAT_READ_CAP, findSeat,
  listWorkspaces, verifyWorkspaceEntry,
  roleName, roleWhy, roleKnown, checkRoleForWorkspace,
  type Check, type Viewer, type WriteVerdict, type CreateStep, type CreateOutcome,
  type InviteeResolution, type NotifyReport, type InviteOutcome, type GrantVerdict,
  type AcceptOutcome, type RevokeOutcome, type Invitation, type InboxRead,
  type WorkspaceEntry, type WorkspaceList, type RoleTable,
} from './membership.js';

export {
  readCanvas, awaitHead, staleDetail, saveCanvas, mergeForward,
  type CanvasRead, type HeadWait, type StaleDetail, type CanvasSave,
} from './canvas.js';

export {
  readMember, checkDelegation, readAuthorship,
  type DelegationVerdict, type AuthorshipReading,
} from './delegation.js';

/**
 * The delegate surface. ★ EVERY NAME HERE EXCEPT THE TWO WORKSPACE ONES IS DEFINED IN
 * `@interego/core/delegate` AND RE-EXPORTED THROUGH `./delegates.js` — a delegate is an Interego
 * concept, and this vertical composes it rather than owning it. Re-exporting rather than asking
 * consumers to add a second import is what keeps the generated artifact bundle pulling the
 * substrate's implementation into itself instead of a copy.
 *
 * The two that are genuinely this vertical's: `delegateCeiling` (the substrate's scope ceiling
 * composed with a workspace ROLE ceiling) and `readEntryAuthorship` (a Turtle adapter over the
 * substrate's `judgeAuthorship`).
 */
export {
  DELEGATE_SURFACE, DELEGATE_LABEL_PREFIX, DELEGATE_NAME_MAX,
  DELEGATION_SCOPES, WRITE_ELIGIBLE_SCOPES, isDelegationScope, scopeWriteEligible, AGENT_ID_RX,
  delegateLabel, parseDelegateLabel, delegateNameProblem, delegateAgentId, isDelegateRow,
  readDelegates, delegatePlan, publishDelegation, revokeDelegation,
  scopeCeiling, judgeAuthorship, authorshipLine, footingLine, signerLine, verifiedSigner,
  footingTurtle, footingActivityIri, footingDelegationIri,
  delegateCeiling, readEntryAuthorship, delegatePort,
  type DelegateRow, type DelegateRoster, type DelegateRegistryPort,
  type DelegateField, type DelegateProblem, type DelegatePlan, type DelegateOutcome,
  type DelegationScope, type CeilingVerdict, type EntryAuthorship,
  type EntryFooting, type StatedFooting, type AuthorshipStatements,
} from './delegates.js';

export {
  BRIEF_ENTRIES, DRAFT_MAX, NOTHING_TO_ADD, decideTurn, briefPrompt, checkDraft,
  type SeenEntry, type TurnInput, type ChannelBrief, type TurnDecision, type DraftVerdict,
  type SpeakingDelegate,
} from './localagent.js';

/**
 * The AGENT surface. ★ EVERY NAME HERE EXCEPT `agentPort` AND `admitSeatedIn` IS DEFINED IN
 * `@interego/core/agent` and re-exported through these two adapters, for the same reason the
 * delegate surface above is: an agent's identity, whether its host is running, what it can be
 * asked, and whether an inbox pointer is a real request are Interego concepts. A workspace only
 * ever REFERENCES agents that already exist — it does not get to say what one is.
 *
 * The two that are genuinely this vertical's are the two adapters: `agentPort` binds this package's
 * transport to the substrate's port, and `admitSeatedIn` is a workspace's own answer to "may this
 * party put work to me", which is the one question the substrate cannot answer for it.
 */
export {
  PRESENCE_RENEW_MS, PRESENCE_LEASE_MS, PRESENCE_MAX_LEASE_MS,
  agentPort, agentPodOf, delegatePodOf, agentNsIri, agentDocName, agentDocIri, agentIdHash,
  presenceIri, capabilitiesIri,
  presenceTurtle, publishPresence, readPresence, isPresent, presenceLine, describeSpan,
  capabilityProblem, capabilityTurtle, publishCapability, readCapabilities,
  type AgentPort, type Presence, type PresencePublish,
  type CapabilityDraft, type CapabilityRoute, type CapabilityPublish, type CapabilityRead,
} from './presence.js';

export {
  REQUEST_INBOX_LIMIT, readRequests, verifyRequest, admitAnyVerifiedSigner, admitSeatedIn, agentInbox,
  type RequestNotice, type RequestVerdict, type AdmissionPredicate,
} from './request.js';
