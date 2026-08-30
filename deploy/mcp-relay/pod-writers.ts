/**
 * The pod-side writers — every byte this relay PUTs into a user's pod on its own credentials.
 *
 * The WAC `.acl` writer, the `/profile/card` writer, the `iep:PodBootstrap` descriptor writer,
 * and `bootstrapPod`, which sequences the three and merges the agent registry.
 *
 * ── WHY THIS IS A MODULE ───────────────────────────────────────────────────────
 *
 * This was 758 lines in the middle of server.ts, which is 18k lines and calls app.listen() at
 * module scope — so it cannot be imported, so none of it could be unit-tested. The same reason
 * ns-dereference.ts, action-authority.ts, pod-authorization.ts and shapes-declared.ts left.
 *
 * What stood in for coverage here was a source-TEXT match. tests/turtle-iri-args.test.ts asked
 * whether `writePublicReadAcl`'s signature still SPELLED `TurtleIriRef`, and whether its body
 * still CONTAINED the substring "acl:agent ${ownerRef}". Neither question can see the document
 * that is actually PUT, and this function PUTs an access-control policy as the relay. That
 * suite now calls it and reads the policy back.
 *
 * Nothing here changed behaviour when it moved. The pure builders are module-scope exports
 * (importable and callable with no server, no pod, no network); everything that needs relay
 * runtime state is closed over by `createPodWriters`.
 *
 * ── ★ ONE ORDERING PRECONDITION, AND THE TYPECHECKER IS WHAT ENFORCES IT ─────────────────
 *
 * `createPodWriters(...)` reads `solidFetch`, `identityUrl`, `publicBaseUrl` and `port` out of
 * server.ts EAGERLY, at construction. Inline, all four were read inside function bodies that
 * only run once the process is serving, so the inline code had no ordering constraint at all;
 * the extraction creates one. `solidFetch` is the lowest of the four (server.ts's
 * `createEgress(...)` destructure, well below PORT / IDENTITY_URL / PUBLIC_BASE_URL), so the
 * whole precondition is: construct BELOW that destructure.
 *
 * ★ MEASURED, NOT REASONED ABOUT. The dep object literal is itself at module scope, so a
 * `createPodWriters({ solidFetch, ... })` moved above that destructure is a module-scope
 * reference to a `const` in its temporal dead zone. Moving the call to immediately above the
 * egress block and running `npx tsc --noEmit -p deploy/mcp-relay/tsconfig.json` gives exactly
 * one error and nothing else:
 *
 *     deploy/mcp-relay/server.ts(994,3): error TS2448: Block-scoped variable 'solidFetch'
 *                                        used before its declaration.
 *
 * with rc=2, and the relay's own `npm test` runs that typecheck as its FIRST segment. Worth
 * stating plainly because no test in this suite imports server.ts — a runtime-only hazard here
 * would have had no coverage at all.
 *
 * The two deps that are NOT read eagerly are thunks, and the reason is not tidiness: a thunk
 * is what the inline code WAS. `relayAgentPublicKey()` and `invalidateRelayProfile()` read
 * `relayAgentKey.publicKey` and `relayProfileCache` at CALL time, which is when the inline
 * comparison and the inline `relayProfileCache.delete(podUrl)` read them. Passing the key as a
 * string would be equal in value, unequal in shape, and would add two more module-scope consts
 * to the set this construction has to sit below.
 *
 * ── ★★ WHAT THIS MODULE DELIBERATELY DID NOT FIX ────────────────────────────────
 *
 * `ensurePodAcls` and `putRelayProfileCard` call the GLOBAL `fetch`. `writePublicReadAcl` and
 * `publishPodBootstrapDescriptor` call the injected `solidFetch`, which is the screened,
 * credentialed egress. All four write to the same pod on the same first-touch path. That
 * asymmetry travelled here unchanged and is NOT endorsed by having been moved: changing it
 * would be a behaviour change to a live write path running on relay credentials, inside a
 * refactor whose whole claim is that it is not one. It is written up in the lift's report
 * instead, which is where a thing you noticed but must not touch belongs.
 */

import type { FetchFn, IRI, ManifestEntry } from '@interego/core';
import {
  ContextDescriptor,
  addAuthorizedAgent,
  createOwnerProfile,
  turtleIriRef,
  validate,
} from '@interego/core';
import {
  publish,
  predictDescriptorUrl,
  readAgentRegistry,
  writeAgentRegistry,
} from '@interego/solid';
// The one way in to the descriptor-overwrite refusal — see the note beside this import in
// server.ts for why its two component predicates are deliberately not reachable separately.
import { descriptorWriteCollisionRefusal } from './supersession-frontier.js';
import { normalizeCssUrl } from './url-rewrite.js';
import { createLazyPodInit, type LazyPodInitAuthContext } from './lazy-pod-init.js';
// Erased at runtime; its whole job is to make `writePublicReadAcl(url, ownerWebId)` — the
// call that shipped — a compile error. See turtle-iri-args.ts.
import type { TurtleIriRef } from './turtle-iri-args.js';

// ── The pure half: builders that need no relay state ──────────────
//
// Module scope rather than closure scope because none of them reads a dep, and a test that
// wants a policy document to assert on should not have to stand up a fetch to get one.

// Maximum number of re-merge attempts when the post-write verify
// observes that our surface agent isn't in the registry (concurrent
// writer clobbered us between our read and our write). Three attempts
// is enough for any reasonable burst — beyond that we surface an
// error rather than spinning indefinitely.
export const POD_BOOTSTRAP_MAX_ATTEMPTS = 3;

// Pod-root WAC: public Read; owner full control. Default policy applies
// to children via `acl:default <root>` so the whole pod inherits unless
// a child container overrides.
export function buildRootAcl(podUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${podUrl}> ;`,
    `    acl:default <${podUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${podUrl}> ;`,
    `    acl:default <${podUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Generic policy: public Read, owner Read+Write+Control. Used for
// /profile/ + /agents.
export function buildPublicReadOwnerWriteAcl(targetUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Owner-only policy. Used for /credentials/.
export function buildOwnerOnlyAcl(targetUrl: string, ownerWebId: IRI): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
  ].join('\n');
}

// Context-graphs policy: owner full control + delegated surface agent
// Read+Write within the container + public Read. The surface agent
// authorization is what lets the relay's per-user/per-surface agent
// publish descriptors on the user's behalf when the user is signed in
// through that surface (claude.ai, ChatGPT, etc.). Additional authorized
// agents added via `register_agent` extend the registry but do NOT
// implicitly grant write here — they must be added to this .acl too
// when CSS is moved off allow-all. (Until then, the css-gate per-user
// bearer check is the live enforcement; this .acl is forward-looking.)
export function buildContextGraphsAcl(
  targetUrl: string,
  ownerWebId: IRI,
  surfaceAgentIri: IRI,
): string {
  return [
    `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    ``,
    `<#owner>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${ownerWebId}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write, acl:Control .`,
    ``,
    `<#surface-agent>`,
    `    a acl:Authorization ;`,
    `    acl:agent <${surfaceAgentIri}> ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read, acl:Write .`,
    ``,
    `<#public>`,
    `    a acl:Authorization ;`,
    `    acl:agentClass foaf:Agent ;`,
    `    acl:accessTo <${targetUrl}> ;`,
    `    acl:default <${targetUrl}> ;`,
    `    acl:mode acl:Read .`,
    ``,
  ].join('\n');
}

// Renamed from `bootstrapPodForOAuth` — the helper is now ingress-agnostic
// and called from BOTH /oauth/verify AND the lazy CallTool middleware
// (ensurePodInitialized). Behavior is unchanged; only the name changed
// to drop the misleading "ForOAuth" suffix.
/**
 * The canonical did:web identity for a surface agent. Prefer an explicit
 * `agentDid` from the identity server; otherwise DERIVE it from the public
 * WebID host so it matches `did:web:<identity host>:agents:<id>` exactly (the
 * form the identity server mints and the registry stores). Never returns a bare
 * short id — that produced short-id-keyed duplicate registry entries. Falls
 * back to the bare id only if neither a did nor a parseable WebID is available.
 */
export function canonicalSurfaceAgentDid(agentDid: string | undefined, agentId: string | undefined, webId: string | undefined): IRI {
  if (agentDid && /^did:/.test(agentDid)) return agentDid as IRI;
  if (agentId && /^did:/.test(agentId)) return agentId as IRI;
  if (agentId && webId) {
    try {
      const host = new URL(webId).host; // e.g. identity.interego.xwisee.com
      if (host) return `did:web:${host}:agents:${agentId}` as IRI;
    } catch { /* unparseable WebID — fall through */ }
  }
  return (agentDid ?? agentId ?? 'urn:agent:unknown') as IRI;
}

// Minimal Turtle string escape — escape backslashes, double quotes,
// and the control characters that Turtle long-string literals reject.
export function escapeTurtleString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Relay runtime state these writers read. Injected rather than imported back out of
 * server.ts, so there is no cycle and a test can stand the whole surface up with fakes.
 */
export interface PodWritersDeps {
  /** The relay's screened, credentialed outbound fetch (server.ts's `solidFetch`). */
  readonly solidFetch: FetchFn;
  /** server.ts's `log`. */
  readonly log: (message: string) => void;
  /** The identity server's origin (server.ts's `IDENTITY_URL`) — the card's `solid:oidcIssuer`. */
  readonly identityUrl: string;
  /** The relay's public origin (server.ts's `PUBLIC_BASE_URL`); '' when unset. */
  readonly publicBaseUrl: string;
  /** The port the relay listens on (server.ts's `PORT`) — only the local-dev fallback target. */
  readonly port: number;
  /**
   * The relay's own X25519 public key, READ AT CALL TIME.
   *
   * A thunk rather than a string because that is what the inline code was: the comparison
   * inside `bootstrapPod` read `relayAgentKey.publicKey` when it ran, not when the module
   * loaded. Handing over the string instead would be equal in value and unequal in shape,
   * and would add this key to the set of module-scope consts construction has to sit below.
   */
  readonly relayAgentPublicKey: () => string;
  /** server.ts's `encryptionKeyToRecord` — the one rule for what key an agent is recorded with. */
  readonly encryptionKeyToRecord: (supplied: unknown, existing?: string | null) => string;
  /** server.ts's per-pod unfiltered-manifest cache read. */
  readonly getCachedManifest: (podUrl: string) => Promise<ManifestEntry[]>;
  /** Drop server.ts's `relayProfileCache` entry for this pod. Called, like the key above, late. */
  readonly invalidateRelayProfile: (podUrl: string) => void;
  /** server.ts's per-pod write mutex. */
  readonly withPodMutex: <T>(podUrl: string, fn: () => Promise<T>) => Promise<T>;
}

/** Parameters `bootstrapPod` takes. Named so `createLazyPodInit` and a test agree on them. */
export interface BootstrapPodParams {
  podUrl: string;
  ownerWebId: IRI;
  surfaceAgentIri: IRI;
  userName: string;
  agentLabel: string;
  userId: string;
  identityWebId: string;
  identityDid?: string | undefined;
}

export interface PodWriters {
  /** Per-resource public-read WAC writer. `publish_context`'s `visibility: "public"` path. */
  writePublicReadAcl(targetUrl: string, ownerRef: TurtleIriRef): Promise<void>;
  /** The container-level WAC policy set, written once on first touch. */
  ensurePodAcls(params: { podUrl: string; userId: string; ownerWebId: IRI; surfaceAgentIri: IRI }): Promise<void>;
  /** The `<pod>/profile/card` writer. */
  putRelayProfileCard(params: {
    podUrl: string; userId: string; userName: string; ownerWebId: IRI;
    identityWebId: string; identityDid?: string | undefined;
  }): Promise<void>;
  /** The `iep:PodBootstrap` descriptor writer. */
  publishPodBootstrapDescriptor(params: {
    podUrl: string; ownerWebId: IRI; userId: string; surfaceAgentIri: IRI;
  }): Promise<void>;
  /** Sequences the three above and merges `<pod>/agents`. */
  bootstrapPod(params: BootstrapPodParams): Promise<void>;
  /** Layer-1 idempotency set (see lazy-pod-init.ts). */
  bootstrappedPods: Set<string>;
  /** Self-heal on the first pod-aware tool call. */
  ensurePodInitialized: (authContext: LazyPodInitAuthContext) => Promise<void>;
}

/**
 * Build the writers over one relay's runtime state. Pure: it performs no I/O and writes
 * nothing until one of the returned functions is called. See the ordering note in the file
 * header for the one constraint on WHERE this may be called from.
 */
export function createPodWriters(deps: PodWritersDeps): PodWriters {
  const {
    solidFetch,
    log,
    identityUrl,
    publicBaseUrl,
    port,
    relayAgentPublicKey,
    encryptionKeyToRecord,
    getCachedManifest,
    invalidateRelayProfile,
    withPodMutex,
  } = deps;
  // ── Pod-side WAC .acl writer ──────────────────────────────────────
  //
  // On first-touch pod init we PUT proper WAC turtle to `<container>.acl`
  // for every container that needs a policy distinct from the parent.
  //
  // Policy summary (WAC inheritance handles unspecified children):
  //
  //   /                — public Read, owner Read+Write+Control
  //   /profile/        — public Read, owner Read+Write+Control (profile
  //                      card MUST be world-readable for federation
  //                      discovery + DID/WebID resolution)
  //   /agents          — owner Read+Write+Control. Public READ is
  //                      intentional: cross-pod agents resolve a recipient
  //                      pod's authorized-agent registry to find encryption
  //                      keys for envelope sharing. The contents themselves
  //                      are non-sensitive metadata (agent IRIs + public
  //                      keys + scopes).
  //   /credentials/    — owner Read+Write+Control ONLY. No public read.
  //                      Delegation credentials carry the relay's signed
  //                      attestation that a surface agent acts on behalf
  //                      of this user; they are NOT secrets but also do
  //                      not belong in public discovery.
  //   /context-graphs/ — owner Read+Write+Control; authorized agents
  //                      (currently the relay's per-surface agent on this
  //                      pod) Read+Write within their delegation scope;
  //                      anonymous Read allowed so descriptors remain
  //                      world-discoverable. Field-level confidentiality
  //                      is handled by JOSE envelope encryption at the
  //                      content layer, NOT by WAC at the storage layer.
  //
  // This is belt-and-suspenders: even if CSS is taken off allow-all (or
  // the css-gate is bypassed), WAC alone still rejects anonymous writes
  // from anywhere on the public internet. Once CSS is moved off allow-all
  // the .acl files become the storage-side authority and the gate's
  // per-user check becomes a redundant verifier layer — which is the
  // desired defense-in-depth posture.
  //
  // Idempotency: each .acl write is a full PUT (replace-semantics). The
  // content is a deterministic function of (podUrl, ownerWebId,
  // surfaceAgentIri) so re-runs against the same inputs produce the same
  // document. Re-runs that change the surface agent simply overwrite the
  // previous policy — historical surface agents stay in the agent
  // registry (revoked / superseded), but new writes are authorized only
  // against the currently-named surface agent.
  //
  // Failure mode: best-effort. WAC writes log + continue on failure;
  // the gate remains the authoritative authz boundary until CSS is moved
  // off allow-all. We don't want a transient CSS .acl PUT failure to
  // block the rest of the pod init (agent registry, profile card,
  // bootstrap descriptor).
  /**
   * ★ WHY THE FOUR BUILDERS BELOW STILL INTERPOLATE THEIR IRIs RAW, AND `writePublicReadAcl`
   * DOES NOT. They look alike and their inputs do not come from the same place.
   *
   * These four are reached only from here, and `ensurePodAcls` is reached only from
   * `bootstrapPod`, whose `podUrl` / `ownerWebId` / `surfaceAgentIri` are the identity
   * server's answer to /auth — `${BASE_URL}/users/<userId>/profile#me` over a derived
   * userId, and a `did:web:` built from a surface slug that `surfaceAgentFromClient` has
   * already squeezed through `^[a-z][a-z0-9-]{1,31}$`. No `tools/call` argument reaches
   * them. `writePublicReadAcl` is the odd one out: its owner is `publish_context`'s
   * `owner_webid`, which the dispatchers only DEFAULT, so a caller-supplied value wins —
   * see the gate at the top of that handler.
   */
  async function ensurePodAcls(params: {
    podUrl: string;
    userId: string;
    ownerWebId: IRI;
    surfaceAgentIri: IRI;
  }): Promise<void> {
    const { podUrl, userId, ownerWebId, surfaceAgentIri } = params;
    void userId; // referenced only by callers' logging; podUrl already encodes it.

    // Containers needing distinct policy + the WAC turtle for each.
    // Keys are container URLs; CSS exposes their .acl at `${container}.acl`.
    const aclSpecs: Array<{ targetUrl: string; aclBody: string }> = [
      {
        // Pod root — public READ (so anyone can dereference profile/card
        // + the manifest + published descriptors); owner full control.
        targetUrl: podUrl,
        aclBody: buildRootAcl(podUrl, ownerWebId),
      },
      {
        // Profile container — explicit public READ. (Inherits from root,
        // but pinning the policy locally keeps it stable if root's policy
        // ever tightens.)
        targetUrl: `${podUrl}profile/`,
        aclBody: buildPublicReadOwnerWriteAcl(`${podUrl}profile/`, ownerWebId),
      },
      {
        // Authorized-agents registry — public READ for cross-pod agent
        // resolution; owner-only WRITE.
        targetUrl: `${podUrl}agents`,
        aclBody: buildPublicReadOwnerWriteAcl(`${podUrl}agents`, ownerWebId),
      },
      {
        // Delegation credentials — owner-only READ + WRITE.
        targetUrl: `${podUrl}credentials/`,
        aclBody: buildOwnerOnlyAcl(`${podUrl}credentials/`, ownerWebId),
      },
      {
        // Context-graphs manifest + descriptor container. Anonymous READ
        // allowed (federation discovery); owner + delegated surface agent
        // WRITE. The surface agent's WebID is the relay-minted
        // `surfaceAgentIri` registered in `<pod>/agents`.
        targetUrl: `${podUrl}context-graphs/`,
        aclBody: buildContextGraphsAcl(
          `${podUrl}context-graphs/`,
          ownerWebId,
          surfaceAgentIri,
        ),
      },
    ];

    for (const { targetUrl, aclBody } of aclSpecs) {
      // CSS / WAC convention: the ACL for a container `<c>/` lives at
      // `<c>/.acl`; the ACL for a leaf resource `<r>` lives at `<r>.acl`.
      // Both reduce to `${targetUrl}.acl` because we keep container URLs
      // trailing-slashed and leaf URLs un-slashed.
      const aclUrl = `${targetUrl}.acl`;
      try {
        const resp = await fetch(aclUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/turtle' },
          body: aclBody,
        });
        if (!resp.ok && resp.status !== 205) {
          log(`[pod-acl] warn: PUT ${aclUrl} returned ${resp.status} ${resp.statusText}; gate remains the authoritative authz boundary`);
        }
      } catch (err) {
        log(`[pod-acl] warn: PUT ${aclUrl} threw ${(err as Error).message}; gate remains the authoritative authz boundary`);
      }
    }
  }

  // Per-resource WAC writer used by `publish_context` with
  // `visibility: "public"`. Pins `acl:Read` for `acl:agentClass foaf:Agent`
  // (any authenticated user) on the leaf resource even if the parent
  // `/context-graphs/` ACL is later tightened. Owner retains full control.
  // Best-effort: any non-2xx is logged by the caller; the parent ACL on
  // `/context-graphs/` still grants the same anonymous read by inheritance.
  /**
   * Grant world-readable access to a pod resource.
   *
   * ★ `acl:agentClass foaf:Agent` MEANS EVERYONE, INCLUDING UNAUTHENTICATED READERS. It is
   * not "any logged-in user" — the Web Access Control term for that is
   * `acl:AuthenticatedAgent`, and this is deliberately not it. The `publish_context` tool
   * description asserted the weaker reading for a long time, which understated the exposure
   * to anyone (human or model) deciding whether to pass `visibility: "public"`.
   *
   * This function is correct: it is named for what it does, and `"public"` is documented as
   * a deliberate disclosure to the open web. Only the description was wrong. Do not "fix"
   * this by narrowing the class — callers who want authenticated-only want `"shared"`,
   * which envelopes to specific keys.
   */
  /**
   * ★★ `ownerRef` IS A `TurtleIriRef`, NOT A WebID STRING, AND THAT IS THE FIX.
   *
   * The owner reaching here is whatever the caller put in `publish_context`'s `owner_webid`
   * — the dispatchers only default that field, they do not overwrite it. This function
   * composes an ACCESS CONTROL POLICY and PUTs it as the relay; per the `ensurePodAcls`
   * note above, `.acl` documents become the storage-side authority as soon as CSS is off
   * allow-all. So a value that could close its own `<…>` would let the caller append a
   * second `acl:Authorization` to a policy it does not own. Taking the already-serialized
   * token means there is no owner string in scope here to interpolate by mistake;
   * `publish_context`'s door gate is the only place one can be produced, and `tsc` refuses
   * any other call.
   */
  async function writePublicReadAcl(targetUrl: string, ownerRef: TurtleIriRef): Promise<void> {
    const aclUrl = `${targetUrl}.acl`;
    // The resource's own URL. Relay-minted from (podUrl, slug) — but `podUrl` is built from
    // the caller's `pod_name`, so it is checked rather than assumed. Throwing is what this
    // function already does when it cannot write the policy (see the non-2xx below), and
    // both call sites Promise.allSettled + log it; the leaf grant is a pin on top of the
    // container ACL that already inherits anonymous Read, so not writing it withholds no
    // access the caller was promised. Emitting a half-formed policy would.
    //
    // ★★ BOTH POSITIONS TAKE THE STRICTER RULE — `turtleIriRef`, absolute only — WHERE BOTH
    // ARRIVED THROUGH `turtleIriArgs`, WHICH ACCEPTS A SCHEME-LESS IDENTIFIER. An earlier draft
    // applied it to `acl:accessTo` alone and defended the asymmetry by saying a bare slug "is
    // what this relay's identity server actually mints". True of an AGENT id, false of the value
    // in THIS position: `acl:agent` here carries `publish_context`'s `owner_webid`, and every
    // transport supplies an absolute one — the bearer branch composes an `${IDENTITY_URL}/users/…`  (server.ts's own const, not this module's `identityUrl`)
    // profile URL, the signed branch uses the recovered DID, `/mcp` uses the identity server's own
    // answer, and the handler's own default is an https URL. So the only scheme-less value the
    // looser rule admitted here was a CALLER-supplied one, and it reached the document: measured,
    // `owner_webid: "../../../other/profile#me"` was accepted and PUT as
    // `acl:agent <../../../other/profile#me>`, a relative reference resolving against the `.acl`
    // document itself. It gives access away rather than takes it, which is why this is a
    // tightening and not an incident — but an access-control document is the last place to keep a
    // rule whose stated reason does not hold.
    //
    // Throwing is what this function already does when it cannot write the policy, and both call
    // sites `Promise.allSettled` + log it; the leaf grant is a pin on top of a container ACL that
    // already inherits anonymous Read, so not writing it withholds no access the caller was
    // promised. Emitting a half-formed policy would.
    const targetRef = turtleIriRef(targetUrl);
    if (targetRef === null) {
      throw new Error(`refusing to PUT ${aclUrl}: "${targetUrl}" cannot be a Turtle IRI reference, so no ACL naming it can be written`);
    }
    // `ownerRef` is the already-serialized `<…>` form, so the bare value is what is re-asked.
    if (turtleIriRef(ownerRef.slice(1, -1)) === null) {
      throw new Error(`refusing to PUT ${aclUrl}: owner ${ownerRef} is not an absolute IRI, so acl:agent would name a reference resolved against the ACL document itself`);
    }
    const aclBody = [
      `@prefix acl: <http://www.w3.org/ns/auth/acl#> .`,
      `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
      ``,
      `<#owner>`,
      `    a acl:Authorization ;`,
      `    acl:agent ${ownerRef} ;`,
      `    acl:accessTo ${targetRef} ;`,
      `    acl:mode acl:Read, acl:Write, acl:Control .`,
      ``,
      `<#public>`,
      `    a acl:Authorization ;`,
      `    acl:agentClass foaf:Agent ;`,
      `    acl:accessTo ${targetRef} ;`,
      `    acl:mode acl:Read .`,
      ``,
    ].join('\n');
    const resp = await solidFetch(aclUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: aclBody,
    });
    if (!resp.ok && resp.status !== 205) {
      throw new Error(`PUT ${aclUrl} → ${resp.status} ${resp.statusText}`);
    }
  }

  async function bootstrapPod(params: {
    podUrl: string;
    ownerWebId: IRI;
    surfaceAgentIri: IRI;
    userName: string;
    agentLabel: string;
    userId: string;
    identityWebId: string;
    identityDid?: string | undefined;
  }): Promise<void> {
    const {
      podUrl,
      ownerWebId,
      surfaceAgentIri,
      userName,
      agentLabel,
      userId,
      identityWebId,
      identityDid,
    } = params;

    for (let attempt = 1; attempt <= POD_BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
      let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
      const firstTouch = profile === null;
      if (!profile) profile = createOwnerProfile(ownerWebId, userName);
      const existing = profile.authorizedAgents.find(
        a => a.agentId === surfaceAgentIri && !a.revoked,
      );

      // Rename support: a display-name change (agentLabel) on an already-authorized
      // agent must UPDATE the existing canonical entry, not register a new one.
      const labelChanged = !!existing && !!agentLabel && existing.label !== agentLabel;
      if (existing && existing.encryptionPublicKey === relayAgentPublicKey() && !labelChanged) {
        // Re-connect from known surface with current key + name — nothing to do.
        return;
      }

      const nextProfile = existing
        ? {
            ...profile,
            authorizedAgents: Object.freeze(
              profile.authorizedAgents.map(a =>
                a.agentId === surfaceAgentIri && !a.revoked
                  ? { ...a, encryptionPublicKey: encryptionKeyToRecord(undefined, a.encryptionPublicKey), ...(labelChanged ? { label: agentLabel } : {}) }
                  : a,
              ),
            ),
          }
        : addAuthorizedAgent(profile, {
            agentId: surfaceAgentIri,
            delegatedBy: ownerWebId,
            label: agentLabel,
            isSoftwareAgent: true,
            scope: 'ReadWrite',
            validFrom: new Date().toISOString(),
            encryptionPublicKey: encryptionKeyToRecord(undefined),
          });

      if (firstTouch) {
        await putRelayProfileCard({
          podUrl,
          userId,
          userName,
          ownerWebId,
          identityWebId,
          identityDid,
        });
        // FIX 1 (anon-write): write WAC .acl resources at pod root +
        // key containers BEFORE the first registry write lands, so the
        // initial /agents PUT itself is policy-bound (when CSS is
        // off allow-all). Order is: profile/card → .acl → agents PUT.
        // Best-effort: log + continue on failure; the css-gate's
        // per-user bearer check remains the live enforcement until
        // CSS is moved off allow-all.
        await ensurePodAcls({
          podUrl,
          userId,
          ownerWebId,
          surfaceAgentIri,
        });
      }
      // FIX C: write the iep:PodBootstrap descriptor in the same
      // single-writer block as /agents + /profile/card. Idempotent
      // (fixed IRI urn:iep:pod-bootstrap:<userId>:v1) so re-bootstraps
      // don't duplicate the manifest entry. Best-effort — see
      // publishPodBootstrapDescriptor's failure-mode comment. We only
      // publish on first-touch because the bootstrap describes the pod's
      // static topology (owner / storage / WebID / registry / card); the
      // dynamic surface-agent list lives on /agents and is read from
      // there. Subsequent surface adds don't need to re-publish the
      // bootstrap descriptor.
      // The bootstrap descriptor targets a distinct CSS path from
      // /agents — run the two PUTs concurrently.
      await Promise.all([
        writeAgentRegistry(nextProfile, podUrl, { fetch: solidFetch }),
        firstTouch
          ? publishPodBootstrapDescriptor({
              podUrl,
              ownerWebId,
              userId,
              surfaceAgentIri,
            })
          : Promise.resolve(),
      ]);
      invalidateRelayProfile(podUrl);

      // Post-write verify: re-read and confirm our surface agent landed.
      // If a concurrent writer (different replica, or anything outside
      // this process's mutex) clobbered our write, the surface agent
      // won't be there — back off briefly and retry the merge.
      const verifyProfile = await readAgentRegistry(podUrl, { fetch: solidFetch });
      const landed = verifyProfile?.authorizedAgents.some(
        a => a.agentId === surfaceAgentIri && !a.revoked,
      );
      if (landed) return;
      if (attempt === POD_BOOTSTRAP_MAX_ATTEMPTS) {
        throw new Error(
          `Post-write verify failed: ${surfaceAgentIri} missing from ${podUrl}agents after ${attempt} attempts (concurrent writer)`,
        );
      }
      // Short backoff before re-merge — gives the concurrent writer
      // time to finish so we read a stable state next iteration.
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }

  // ── Lazy pod-init for already-authenticated tool calls (FIX A) ────
  //
  // Background: /oauth/verify is the canonical first-write entry point
  // for `<pod>/agents` + `<pod>/profile/card`. But bearer tokens that
  // were issued BEFORE the eager OAuth-side bootstrap shipped are still
  // in the wild — those callers have a valid token but a pod that was
  // never initialized (no /agents, no /profile/card), so any tool that
  // reads the registry returns "no agent" and any tool that writes
  // fails its first-line auth check. The fix is self-healing on first
  // MCP call: when a CallToolRequest comes in with auth context that
  // resolves a podUrl, we lazily run the SAME bootstrap helper used by
  // /oauth/verify, behind the SAME per-pod mutex, gated by a cheap
  // HEAD-based idempotency check so the cost is one round-trip per
  // (pod, relay-process) pair across the relay's lifetime.
  //
  // Idempotency: two layers.
  //   (1) `bootstrappedPods` Set — populated on confirmed success (HEAD
  //       200 or successful bootstrap). O(1) hit cost, no network. The
  //       fast path that absorbs every call after the first.
  //   (2) On Set miss: HEAD <podUrl>agents. 200 → another replica /
  //       process already initialized — record + skip. 404 → take the
  //       mutex, re-check the Set inside the mutex (double-checked
  //       locking against concurrent in-process callers), then bootstrap.
  // No TTL — pod-init is monotonic. The Set is intentionally NOT
  // populated on bootstrap FAILURE so a transient 5xx does not poison
  // subsequent calls.
  //
  // Failure mode: lazy init is best-effort. If bootstrap throws we log
  // at warn level and let the tool call proceed; reads degrade
  // gracefully (discover_context returns []), writes surface their own
  // underlying error. The single exception is the strict-DPoP environment
  // (RELAY_REQUIRE_DPOP=true) combined with an AUTH_REQUIRED_TOOLS call —
  // there we honor the strict guarantee and rethrow so the tool handler
  // surfaces a clear error rather than silently writing to a half-init pod.
  const { bootstrappedPods, ensurePodInitialized } = createLazyPodInit({
    solidFetch,
    withPodMutex,
    bootstrapPod,
  });

  // ── Pod-side /profile/card writer (FIX A) ─────────────────────────
  //
  // Conventional Solid clients (Penny, @inrupt/solid-client, NSS-derived
  // profile dereferencers) dereference `<pod>/profile/card#me` expecting
  // `solid:oidcIssuer` + `solid:storage` so they can sign in against the
  // pod alone, without out-of-band knowledge of the identity server. The
  // relay mirrors this card on the first OAuth completion for a given
  // pod. Subsequent surface-agent additions don't require rewriting the
  // card — it points to `<pod>/agents` (via rdfs:seeAlso) as the
  // authoritative authorized-agent list.
  //
  // We deliberately keep the inline `iep:authorizedAgent` payload narrow
  // (the current surface agent only). The full multi-surface list lives
  // on `<pod>/agents` and is read from there by every cross-pod
  // resolution flow.
  async function putRelayProfileCard(params: {
    podUrl: string;
    userId: string;
    userName: string;
    ownerWebId: IRI;
    identityWebId: string;
    identityDid?: string | undefined;
  }): Promise<void> {
    const { podUrl, userId, userName, ownerWebId, identityWebId, identityDid } = params;
    const cardUrl = `${podUrl}profile/card`;
    const agentsRegistryUrl = `${podUrl}agents`;

    // Ensure the pod's root container and /profile/ subcontainer exist —
    // CSS file backend needs explicit LDP BasicContainer PUTs before a
    // leaf PUT into a missing parent. Best-effort; later steps surface a
    // real error if the leaf PUT still fails.
    for (const containerUrl of [podUrl, `${podUrl}profile/`]) {
      try {
        await fetch(containerUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'text/turtle',
            'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
          },
          body: '',
        });
      } catch { /* best-effort */ }
    }

    const seeAlsoTargets: string[] = [agentsRegistryUrl, identityWebId];
    if (identityDid) seeAlsoTargets.push(identityDid);

    const turtle = [
      `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .`,
      `@prefix pim: <http://www.w3.org/ns/pim/space#> .`,
      `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .`,
      `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
      ``,
      `<${cardUrl}#me>`,
      `    a foaf:Person ;`,
      `    foaf:name "${escapeTurtleString(userName)}" ;`,
      `    solid:oidcIssuer <${identityUrl}> ;`,
      `    solid:storage <${podUrl}> ;`,
      `    pim:storage <${podUrl}> ;`,
      `    iep:agentRegistry <${agentsRegistryUrl}> ;`,
      `    rdfs:seeAlso ${seeAlsoTargets.map(t => `<${t}>`).join(', ')} .`,
      ``,
      // Owner WebID returned by identity (`<identityWebId>`) is the
      // canonical one; cross-reference it back to the pod card so a client
      // resolving either direction stays linked. owl:sameAs is intentional —
      // both IRIs denote the same Person.
      `@prefix owl: <http://www.w3.org/2002/07/owl#> .`,
      `<${ownerWebId}> owl:sameAs <${cardUrl}#me> .`,
      ``,
    ].join('\n');
    void userId; // referenced only for the log/diagnostics surface upstream

    const r = await fetch(cardUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    if (!r.ok && r.status !== 205) {
      throw new Error(`PUT ${cardUrl} failed: ${r.status} ${r.statusText}`);
    }
  }

  // ── Pod-bootstrap descriptor writer (FIX C) ───────────────────────
  //
  // On first-touch pod init the relay also publishes a single
  // `iep:PodBootstrap` Context Descriptor into the pod's
  // `.well-known/context-graphs` manifest. The descriptor self-describes
  // the pod (iep:owner / iep:storage / iep:webId / iep:agentRegistry /
  // iep:profileCard) and carries one iep:Affordance (iep:canPublish) whose
  // hydra:target points back at the relay's publish_context tool so a
  // client discovering the pristine pod has a strictly better UX signal
  // than an empty manifest: "pod is alive, owned by X, here is how to
  // add more context."
  //
  // Idempotency
  // -----------
  // Descriptor IRI is pinned to `urn:iep:pod-bootstrap:<userId>:v1` — the
  // same IRI every time. `publish()` on the substrate is idempotent at
  // the manifest level (it observes the entry already exists and skips
  // the PUT), so subsequent bootstrap calls are no-ops at the manifest
  // layer. The descriptor + graph PUTs overwrite themselves with
  // identical content (or only updated timestamps), so re-bootstrap
  // never accumulates duplicate manifest entries.
  //
  // Failure mode
  // ------------
  // This call is best-effort. If the bootstrap publish fails (CSS
  // unreachable, descriptor validation rejects, manifest CAS exhausts
  // retries), we log and continue — the agent registry + profile card
  // PUTs already landed, and an empty manifest is still functionally
  // correct, just a slightly worse first-touch UX. Callers should not
  // surface this failure as a bootstrap blocker.
  async function publishPodBootstrapDescriptor(params: {
    podUrl: string;
    ownerWebId: IRI;
    userId: string;
    surfaceAgentIri: IRI;
  }): Promise<void> {
    const { podUrl, ownerWebId, userId, surfaceAgentIri } = params;
    const descId = `urn:iep:pod-bootstrap:${userId}:v1` as IRI;
    const agentsRegistryUrl = `${podUrl}agents`;
    const cardUrl = `${podUrl}profile/card`;
    const ownerWebIdHash = `${cardUrl}#me`;
    // hydra:target for the iep:canPublish affordance. `publicBaseUrl` is
    // the relay's public origin (set in container env). When unset the
    // affordance still gets a sensible local-dev target so dev-mode
    // discovers behave consistently with prod.
    const relayBase = (publicBaseUrl || `http://localhost:${port}`).replace(/\/$/, '');
    const publishTarget = `${relayBase}/tool/publish_context`;
    const now = new Date().toISOString();

    const builder = ContextDescriptor.create(descId)
      .describes(podUrl as IRI)
      .temporal({ validFrom: now })
      .validFrom(now)
      .delegatedBy(ownerWebId, surfaceAgentIri, {
        endedAt: now,
      })
      .semiotic({
        modalStatus: 'Asserted',
        epistemicConfidence: 1.0,
      })
      .trust({
        trustLevel: 'SelfAsserted',
        issuer: ownerWebId,
      })
      .federation({
        origin: podUrl as IRI,
        storageEndpoint: podUrl as IRI,
        syncProtocol: 'SolidNotifications',
      })
      .version(1);
    const descriptor = builder.build();

    const validation = validate(descriptor);
    if (!validation.conforms) {
      log(`WARN: pod-bootstrap descriptor failed validation: ${validation.violations.map(v => v.message).join('; ')}`);
      return;
    }

    // Named-graph body: the pod self-description + one iep:canPublish
    // affordance. Kept compact; conventional iep: / hydra: / dcat:
    // vocabularies only. Lines are emitted without prefix declarations —
    // `wrapAsTriG()` hoists the descriptor's prefix block above the
    // named-graph body so iep: / hydra: / dcat: / prov: are already in
    // scope inside the graph block.
    const graphContent = [
      `<${podUrl}>`,
      `    a iep:PodBootstrap ;`,
      `    iep:owner <${ownerWebId}> ;`,
      `    iep:storage <${podUrl}> ;`,
      `    iep:webId <${ownerWebIdHash}> ;`,
      `    iep:agentRegistry <${agentsRegistryUrl}> ;`,
      `    iep:profileCard <${cardUrl}> ;`,
      `    prov:wasGeneratedBy <${surfaceAgentIri}> ;`,
      `    iep:affordance [`,
      `        a iep:Affordance, hydra:Operation ;`,
      `        iep:action iep:canPublish ;`,
      `        hydra:method "POST" ;`,
      `        hydra:target <${publishTarget}> ;`,
      `        hydra:title "Publish a new context descriptor to this pod"`,
      `    ] .`,
    ].join('\n');

    try {
      // ★ THE SAME GATE `publish_context` GOES THROUGH. `urn:iep:pod-bootstrap:<user>:v1`
      // slugs to the bare tail `v1`, so this writes `<pod>/context-graphs/v1.ttl` — a name a
      // user reaches with any descriptor id ending in `v1` (`https://example.org/mygraph/v1`,
      // `urn:mine:v1`). Bootstrap's own idempotency guard is a process-local Set plus a HEAD
      // on `<pod>/agents`; neither looks at the descriptor it is about to replace, so before
      // this check a re-bootstrap could overwrite a user's graph descriptor in place and drop
      // it out of its supersession chain.
      const collision = descriptorWriteCollisionRefusal(
        await getCachedManifest(podUrl),
        podUrl,
        predictDescriptorUrl(podUrl, descId),
        { normalize: normalizeCssUrl },
      );
      if (collision) {
        // Bootstrap is best-effort and has no caller to answer, so refusing is logged rather
        // than returned. Skipping the write is the whole point: the alternative is destroying
        // somebody's descriptor to install a convenience record.
        log(`WARN: pod-bootstrap SKIPPED for ${podUrl}: ${collision.message}`);
        return;
      }
      await publish(descriptor, graphContent, podUrl, { fetch: solidFetch });
      log(`[pod-bootstrap] published ${descId} to ${podUrl}`);
    } catch (err) {
      // Best-effort — see the failure-mode comment above.
      log(`WARN: pod-bootstrap publish failed for ${podUrl}: ${(err as Error).message}`);
    }
  }

  return {
    writePublicReadAcl,
    ensurePodAcls,
    putRelayProfileCard,
    publishPodBootstrapDescriptor,
    bootstrapPod,
    bootstrappedPods,
    ensurePodInitialized,
  };
}
