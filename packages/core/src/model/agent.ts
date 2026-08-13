/**
 * @module model/agent
 * @description WHAT AN AGENT IS TO EVERYBODY ELSE — two documents at two addresses, both composed
 *              from its DID, both on its own pod, both signed by its own key.
 *
 * ── THE MODEL, AND WHY IT INVERTS THE OBVIOUS ONE ────────────────────────────────────────────
 *
 * The obvious design is "a room has members, so let the room say who they are and what they can
 * do". That is backwards. Agents exist FIRST, independently: a Codex agent testing a build, a
 * Foxxi tutor, a bare delegate on somebody's laptop. A workspace is merely a room they can talk
 * in and a channel is merely a door into that room, so neither may define what an agent is, what
 * it can be asked, how it is reached or whether it is available. A room only ever REFERENCES
 * agents that already exist.
 *
 * So everything a peer needs is derived from the DID alone:
 *
 *     did:web:<host>:agents:<surface>-<pod>
 *        ├── <relay>/ns/<pod>/agent-<pod>-<h>-presence        "my host is running until T"
 *        └── <relay>/ns/<pod>/agent-<pod>-<h>-capabilities    "here is what I can be asked, and how"
 *
 *            …where <h> is {@link agentIdHash} over the WHOLE did. See {@link agentDocName} for the
 *            measurement that put it there: two distinct agents sharing a pod used to compose one
 *            address, and the second to publish deleted the first one's presence.
 *
 * Hold a DID, compose two URLs, and you know whether it is up and what it offers. No directory, no
 * lookup, no roster, no channel. ★ THE TEST THIS IS BUILT TO PASS: a Codex agent that has never
 * heard of a workspace, reached from a bare script with no Discord anywhere, can be discovered,
 * addressed, asked to do something, and answer. Nothing in this file mentions either.
 *
 * ★ AND AN ID THIS READER CANNOT NAME A DOCUMENT FROM IS ITS OWN ANSWER. A `did:key`, a `did:ethr`
 * or a cross-issuer `did:web` with no pod segment yields no address, and no address means no pod
 * was asked — which is `unnameable`, and is emphatically NOT "this agent has never said it was
 * running". That sentence used to be produced for all three, out of a parse failure, with no
 * network read anywhere behind it.
 *
 * ★ AND THE ERROR THIS REPLACES WAS CONCRETE. The first capability document was named
 * `<member pod>/<convener pod>--<slug>-affordances` — a capability described as a fact about an
 * agent IN ONE WORKSPACE, findable only by somebody who already knew the convener's pod AND the
 * slug. Two agents in two rooms had two capability documents and no reader could ask "does anyone
 * here have a tool for X" across them. The name below is agent-scoped, and that one change is what
 * makes cross-room discovery reachable at all.
 *
 * ── WHY THE OWN-POD RULE IS FORCED RATHER THAN CHOSEN ────────────────────────────────────────
 *
 * ★ MEASURED LIVE, 2026-08-08, with a freshly minted delegate publishing under its own session
 * onto its DELEGATOR's pod: the write is ACCEPTED, and reading the descriptor back gives
 *
 *     authorshipVerified: false
 *     reason: "…the proof is signed for owner <the DELEGATE's own WebID> and …"
 *
 * The relay's descriptor binding holds the proof's owner against the pod the bytes landed on, so
 * every cross-pod write under a delegation reads back unverified. The identical document published
 * on the delegate's OWN pod, in the same run, reads back `authorshipVerified: true` with
 * `contentBinding: "bound"`. A self-claim by an agent is therefore only CHECKABLE on its own pod.
 * The substrate refuses the wrong design; this module is the shape that survives it.
 *
 * ★ AND THE MOVE MAKES THE MODEL BETTER, NOT MERELY POSSIBLE. Both documents are statements BY an
 * agent ABOUT ITSELF, so its own pod is where they belong, and neither needs a delegation at all.
 * A delegate whose delegator revoked it can still say its host is up — and that is CORRECT: "my
 * host is running" and "I am authorised to write for that person" are two independent facts, read
 * from two documents on two pods, and collapsing them is the error this whole layer exists to
 * prevent. A reader gets the second from the delegator's registry (`readDelegates`) and the first
 * from here.
 */

import { escapeTurtleLiteral, graphRegion, substrateReaders } from '../rdf/turtle-region.js';
import {
  agentPodOf, readAuthorship, relayRefusal,
  type AuthorshipReading, type Check, type DelegateRegistryPort,
} from './delegate.js';

const { readIri, readIriAll, readLiteral } = substrateReaders;

// ── Addressing ───────────────────────────────────────────────

/**
 * Re-exported, not defined here. It reads a pod out of an agent DID and out of a relay WebID, and
 * {@link judgeAuthorship} needs the second — so it lives in `model/delegate.ts`, which this file
 * already imports, rather than being spelled a second time on the other side of a cycle.
 */
export { agentPodOf } from './delegate.js';

/** A relay `/ns/` document address. The relay's own route, so the composition is the same one. */
export const agentNsIri = (relay: string, pod: string, name: string): string =>
  relay + '/ns/' + pod + '/' + name;

/**
 * A 64-bit FNV-1a over the whole agent id, as 16 lowercase hex characters.
 *
 * ★ THE WHOLE ID, WHICH IS THE ENTIRE POINT. See {@link agentDocName}: keying a document name on
 * the pod segment alone made the DID → address mapping non-injective, so two distinct agents that
 * share a pod composed ONE address and — with `auto_supersede_prior` — the later publisher silently
 * made the earlier one's presence unreadable. Every byte of the id goes in here.
 *
 * ★ AND IT IS A HASH RATHER THAN AN ENCODING, WITH THE TRADE STATED. A base64url of the id would be
 * exactly injective and would put a ~104-character opaque blob in a URL a person is meant to be
 * able to read and follow. What a hash costs instead is a collision probability: two DIDs collide
 * only on a full 64-bit collision, which at a million agents on one deployment is about 3 in 10^8.
 * That is a real number and not zero, and it is the reason the READER does not trust the name: both
 * documents restate the agent they are about INSIDE the signed region, and both readers below
 * refuse anything whose region names a different agent than the one they asked for. The name is an
 * address; the region is the assertion.
 *
 * FNV-1a rather than a cryptographic digest because this has to run in a browser bundle, an
 * Electron renderer, a Node CLI and the relay, and `node:crypto` is unavailable in one of those
 * while `crypto.subtle` is asynchronous in all of them. Nothing here is a security boundary.
 *
 * ★ AND THE UTF-8 IS SPELLED OUT RATHER THAN TAKEN FROM `TextEncoder`, WHICH IS NOT A STYLE CHOICE.
 * Every address in this module is composed from this function, so a runtime where it throws is a
 * runtime where no agent can publish or be found. `TextEncoder` is a global, and it is absent from
 * a JSDOM window — measured: the desktop shell's presence heartbeat died with
 * `ReferenceError: TextEncoder is not defined` and reported "it has not managed to say its host is
 * running", which is exactly the shape of failure that reads as a design problem. Polyfilling it
 * in a test would have hidden that from the one runtime that caught it, and this repo has already
 * been bitten by a polyfill in one test file changing another's behaviour through a shared global.
 */
export function agentIdHash(agentId: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = OFFSET;
  const mix = (byte: number): void => { h = ((h ^ BigInt(byte)) * PRIME) & MASK; };
  // Hashed over UTF-8 bytes rather than UTF-16 code units, so two runtimes cannot disagree about
  // the address of an id containing a non-ASCII character. `for…of` iterates by CODE POINT, so a
  // surrogate pair arrives here once, already combined.
  for (const ch of agentId) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) { mix(cp); }
    else if (cp < 0x800) { mix(0xc0 | (cp >> 6)); mix(0x80 | (cp & 0x3f)); }
    else if (cp < 0x10000) { mix(0xe0 | (cp >> 12)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f)); }
    else { mix(0xf0 | (cp >> 18)); mix(0x80 | ((cp >> 12) & 0x3f)); mix(0x80 | ((cp >> 6) & 0x3f)); mix(0x80 | (cp & 0x3f)); }
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The last segment of an agent's document of `kind`, or null when the id carries no pod.
 *
 * ★ THE NAME CARRIES THE WHOLE AGENT ID, NOT ONLY ITS POD, AND THAT WAS MEASURED THE WRONG WAY
 * ROUND FIRST. It used to be `agent-<pod>-<kind>`, and `register_agent` freely issues several
 * distinct DIDs whose ids embed the same pod — a pod owner's own surface agent and any delegate
 * registered there. Measured on the live relay: `claude-u-pk-63aaca4b0d72` and
 * `wsp-delegate-u-pk-63aaca4b0d72` composed the IDENTICAL presence and capability IRIs, so the
 * second one to publish superseded the first at that shared address and the first then read back
 * `unreadable` — one agent publishing silently deleted another agent's presence. The DID → address
 * mapping the whole model rests on has to be injective, and the pod segment alone is not the DID.
 */
export function agentDocName(agentId: string, kind: 'presence' | 'capabilities'): string | null {
  const pod = agentPodOf(agentId);
  return pod ? 'agent-' + pod + '-' + agentIdHash(agentId) + '-' + kind : null;
}

/** `<relay>/ns/<agent pod>/agent-<agent pod>-<kind>`, or null. */
export function agentDocIri(relay: string, agentId: string, kind: 'presence' | 'capabilities'): string | null {
  const pod = agentPodOf(agentId);
  const name = agentDocName(agentId, kind);
  return pod && name ? agentNsIri(relay, pod, name) : null;
}

/**
 * Where this agent says whether its host is running.
 *
 * ★ THE POD IS DERIVED, NOT PASSED, AND THAT IS DELIBERATE. It used to be an argument, and an
 * argument is a way to put a lease on the wrong pod — where, as the header records, its signature
 * cannot be verified and it is therefore worth nothing. Both halves come from the one agent id, so
 * the writer and every reader compose the same address or neither composes one.
 */
export const presenceIri = (relay: string, agentId: string): string | null =>
  agentDocIri(relay, agentId, 'presence');

/** Where this agent says what it can be asked. Agent-scoped — see the header. */
export const capabilitiesIri = (relay: string, agentId: string): string | null =>
  agentDocIri(relay, agentId, 'capabilities');

/**
 * What this module needs from a caller, and nothing more.
 *
 * ★ A PORT RATHER THAN A CLIENT, for the same reason {@link DelegateRegistryPort} is one: this has
 * to run in the relay, a Node CLI, an Electron main process and a browser artifact, which have
 * four transports and one of which cannot import `node:` anything.
 */
export interface AgentPort extends DelegateRegistryPort {
  /** Fetch a descriptor by URL. MUST reject rather than resolve an error body. */
  readonly descriptor: (url: string) => Promise<Record<string, unknown>>;
}

const describe = (port: AgentPort, e: unknown): string =>
  (port.describeError ? port.describeError(e) : String((e as { message?: unknown })?.message ?? e)).toLowerCase();

const iriRef = (u: string, what: string): string => {
  if (typeof u !== 'string' || !u) throw new Error('agent: ' + what + ' is missing, so this document is refused rather than written without it');
  // An IRI reference ends at the first `>` and Turtle's IRIREF production has no escape for one,
  // so a value containing it would close the reference and every byte after it would parse as
  // further triples — in a document published under this agent's own signature. There is nothing
  // to escape it to, so the only correct handling is refusal.
  if (/[\s<>"{}|\\^`]/.test(u)) throw new Error('agent: ' + what + ' is not serializable as a Turtle IRI reference, so this document is refused rather than written with a reference that ends somewhere else: ' + u);
  return '<' + u + '>';
};

const parseMs = (s: unknown): number | null => {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

// ── Presence ─────────────────────────────────────────────────

/**
 * ── WHY A LEASE, AND WHY NOT A RELAY FLAG ────────────────────────────────────────────────────
 *
 * ★ THE TEMPTING TOOL IS DELIBERATELY REFUSED. A relay-held "agent X is online" flag would be THE
 * RELAY ASSERTING AVAILABILITY — a third party vouching for a process it cannot see. A lease is
 * the opposite: a statement BY the host, on its own pod, signed with its own key, and it is only
 * worth anything because it is SHORT and had to be renewed. Nothing was added to the substrate.
 *
 * ★ IT DECAYS BY EXPIRY, AND NOTHING ANYWHERE RUNS A TIMER. The host stops, the lease stops being
 * renewed, and one lease-length later it is past its own `iep:leaseExpires` — which is inside the
 * signed region, so the expiry a reader turns on is one the AGENT put its key to rather than one
 * the relay computed. Nothing has to notice the outage and nothing has to be retracted; a host that
 * crashed could not retract anything either, which is exactly why lapsing is the mechanism that can
 * be trusted. The same bound is sent as `valid_until` so the relay's temporal filter agrees, but
 * the reader does not depend on that filter to pick — see {@link readPresence} for the live
 * measurement that made the difference matter.
 *
 * ★ AND THE HOLE IS GUARDED RATHER THAN HOPED AWAY. `valid_until` is a caller-supplied argument, so
 * a host COULD publish one lease claiming a year and never run again. A reader refuses any span
 * over {@link PRESENCE_MAX_LEASE_MS} and reports `overlong` — a finding about that document, which
 * is NOT presence. A lease with no `validUntil` is the same refusal under another name: a lease
 * that never expires is not a lease.
 */

/** How often a running host republishes. */
export const PRESENCE_RENEW_MS = 90_000;

/** How long one lease claims. Two renewal intervals, so one missed publish is not an outage. */
export const PRESENCE_LEASE_MS = 180_000;

/**
 * The longest span a reader will accept as evidence.
 *
 * Three renewal intervals: enough slack for a host whose clock is off by a minute or whose publish
 * was slow, and nowhere near enough for a lease that says nothing about now.
 */
export const PRESENCE_MAX_LEASE_MS = 3 * PRESENCE_RENEW_MS;

/**
 * The lease, as Turtle.
 *
 * The subject is the document's own IRI, because that is the region an `/ns/` reader locates:
 * statements hanging off any other subject publish, resolve and read as "this agent says nothing".
 *
 * `iep:presenceOf` is INSIDE the signed region, so a reader can hold the agent the lease CLAIMS to
 * be about against the agent that SIGNED it. Without it the filename would be the only thing naming
 * the subject, and a filename is not an assertion.
 */
export function presenceTurtle(args: {
  readonly iri: string;
  readonly agentId: string;
  /** The person this delegate acts for, as their pod's registry reports them. Standing, not a per-act claim. */
  readonly principal: string | null;
  /** Free text naming the host, e.g. "the desktop app". Never a hostname or a path. */
  readonly host: string;
  readonly createdIso: string;
  readonly expiresIso: string;
}): string {
  const self = iriRef(args.iri, 'the presence document IRI');
  const agent = iriRef(args.agentId, 'the agent this lease is about');
  return '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
    + '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n'
    + self + '\n'
    + '  a iep:PresenceLease ;\n'
    + '  iep:presenceOf ' + agent + ' ;\n'
    + (args.principal ? '  iep:presenceActingFor ' + iriRef(args.principal, 'the principal this delegate acts for') + ' ;\n' : '')
    + '  iep:presenceHost "' + escapeTurtleLiteral(args.host) + '" ;\n'
    + '  dct:created "' + args.createdIso + '"^^xsd:dateTime ;\n'
    + '  iep:leaseExpires "' + args.expiresIso + '"^^xsd:dateTime .\n';
}

export type PresencePublish =
  | { readonly kind: 'published'; readonly iri: string; readonly descriptorUrl: string | null; readonly expiresIso: string }
  | { readonly kind: 'unnameable'; readonly why: string }
  | { readonly kind: 'refused'; readonly iri: string; readonly why: string }
  | { readonly kind: 'error'; readonly iri: string | null; readonly error: unknown };

/**
 * Say, for one lease-length, that this agent's host is running.
 *
 * ★ THE SESSION MUST BE THE AGENT'S OWN AND THE POD IS ITS OWN. Both halves are the same fact: a
 * lease is only evidence because the key that signed it is the key the agent IS, and — measured,
 * see the header — a proof only verifies on the pod whose owner it was signed for. `pod_name` is
 * still sent explicitly rather than left to the session, so the address is a value this function
 * computed and can be checked against, not one the relay filled in.
 *
 * ★ `auto_supersede_prior: true` SO THERE IS ONE HEAD. A forked lease would leave a reader choosing
 * which of two claims about a running process to believe, and there is no honest way to choose.
 * Unlike a log there is no history here that a reader walks.
 */
export async function publishPresence(
  port: AgentPort,
  args: {
    readonly relay: string;
    readonly agentId: string;
    readonly principal: string | null;
    readonly host: string;
    readonly nowMs?: number;
    readonly leaseMs?: number;
  },
): Promise<PresencePublish> {
  const iri = presenceIri(args.relay, args.agentId);
  const pod = agentPodOf(args.agentId);
  if (!iri || !pod) {
    return {
      kind: 'unnameable',
      why: 'This agent\'s id (' + args.agentId + ') carries no pod segment this client can read, so there is no address a '
        + 'reader would look for its presence at. Nothing was published — a lease at a name nobody else computes would read '
        + 'to every other client as "this agent has never said it was running".',
    };
  }
  const now = args.nowMs ?? Date.now();
  const lease = Math.min(args.leaseMs ?? PRESENCE_LEASE_MS, PRESENCE_MAX_LEASE_MS);
  const createdIso = new Date(now).toISOString();
  const expiresIso = new Date(now + lease).toISOString();
  let res: Record<string, unknown>;
  try {
    res = await port.tool('publish_context', {
      pod_name: pod,
      graph_iri: iri,
      graph_content: presenceTurtle({ iri, agentId: args.agentId, principal: args.principal, host: args.host, createdIso, expiresIso }),
      visibility: 'public',
      auto_supersede_prior: true,
      sign_authorship: true,
      valid_from: createdIso,
      // ★ THE WHOLE MECHANISM IS THIS ONE FIELD. Past it the relay's own temporal filter stops
      // answering for this document, and nothing anywhere has to run a timer.
      valid_until: expiresIso,
    }) as Record<string, unknown>;
  } catch (e) { return { kind: 'error', iri, error: e }; }
  const bad = relayRefusal(res);
  if (bad) return { kind: 'refused', iri, why: String(bad['message'] ?? bad['error']) };
  return { kind: 'published', iri, descriptorUrl: typeof res['descriptorUrl'] === 'string' ? res['descriptorUrl'] : null, expiresIso };
}

/**
 * SEVEN ANSWERS, AND ONLY ONE OF THEM IS PRESENCE.
 *
 * `never` and `stale` are different facts and a reader is told which. `overlong` is a finding about
 * a document that claims too much. `disputed` is a lease whose SIGNED expiry and the relay's own
 * row disagree — the case the signed expiry exists to catch, reported rather than resolved by
 * picking one. `unreadable` is the pod not answering — which is not the same as the host being off.
 * `unnameable` is this client being unable to compose an address at all, so no pod was asked and
 * nothing about that agent was established in either direction. ★ Absence of evidence is not
 * presence, a failed read is not presence, and a parse failure is not a fact about somebody's agent.
 */
export type Presence =
  | {
      readonly state: 'running';
      readonly agentId: string;
      readonly pod: string;
      readonly iri: string;
      /** When the lease was written, by its author's own clock, out of the SIGNED region. */
      readonly saidAtMs: number;
      /** `iep:leaseExpires`, out of the SIGNED region — never the relay's `validUntil`. */
      readonly expiresMs: number;
      readonly descriptorUrl: string;
      readonly host: string | null;
      readonly authorship: AuthorshipReading;
    }
  | { readonly state: 'stale'; readonly agentId: string; readonly pod: string; readonly iri: string; readonly lastExpiresMs: number | null; readonly why: string }
  | { readonly state: 'never'; readonly agentId: string; readonly pod: string; readonly iri: string; readonly why: string }
  | { readonly state: 'overlong'; readonly agentId: string; readonly pod: string; readonly iri: string; readonly spanMs: number | null; readonly why: string }
  | {
      readonly state: 'disputed';
      readonly agentId: string; readonly pod: string; readonly iri: string;
      /** What the agent signed. */
      readonly signedExpiresMs: number | null;
      /** What the relay's own unsigned row says. */
      readonly rowExpiresMs: number | null;
      readonly why: string;
    }
  | { readonly state: 'unreadable'; readonly agentId: string; readonly pod: string; readonly iri: string; readonly why: string }
  | { readonly state: 'unnameable'; readonly agentId: string; readonly pod: null; readonly iri: null; readonly why: string };

/** True only for a lease valid now, signed, content-bound, self-declared and within the span bound. */
export const isPresent = (p: Presence): boolean => p.state === 'running';

/**
 * What that pod says about this agent's host, right now.
 *
 * ★ ONE READ, AND IT ASKS FOR THE HEAD RATHER THAN FOR "WHAT IS VALID NOW". See the read itself
 * for the live measurement that changed this: an older, longer-lived lease outlives the newer one
 * that superseded it, so the relay's temporal filter can hand back a claim the agent has already
 * withdrawn. Presence is an agent's CURRENT claim.
 *
 * ★ AND THE SIGNATURE IS CHECKED, NOT THE FILENAME. A lease is only evidence because a process
 * holding the agent's private key had to sign it. So: the descriptor's authorship must verify, its
 * content binding must be `bound` (an unbound proof covers WHICH document was written and not WHAT
 * it says), the signer must BE this agent, and the signed region must name this agent as the one it
 * is about. Any of those failing is `unreadable` — never presence.
 *
 * ★ ONE MEASURED FACT A CALLER HAS TO KNOW. `discover_context` is served from a manifest cache with
 * a roughly ten-second window on this deployment, so a lease is invisible — even to its own writer
 * — for a few seconds after it is published. That is why {@link PRESENCE_RENEW_MS} is 90 seconds
 * and not five: the renewal interval has to be far larger than the window, or a reader would see
 * gaps that mean nothing.
 */
export async function readPresence(
  port: AgentPort,
  args: { readonly relay: string; readonly agentId: string; readonly nowMs?: number },
): Promise<Presence> {
  const pod = agentPodOf(args.agentId);
  const iri = presenceIri(args.relay, args.agentId);
  if (!pod || !iri) {
    // ★ NOT `never`, AND THE DIFFERENCE IS THE WHOLE OF WHY THIS BRANCH EXISTS. `never` is a fact
    // about a pod that answered and held nothing. Here no pod was asked and no address was even
    // composed, and the sentence this used to produce — "has never said it was running" — was a
    // flat negative claim about somebody's agent manufactured out of a parse failure, with zero
    // network reads behind it. Reachable for every `did:key`, `did:ethr` and cross-issuer
    // `did:web` — which is to say, for exactly the Codex agent this module is built to serve.
    return {
      state: 'unnameable', agentId: args.agentId, pod: null, iri: null,
      why: 'this client cannot compose a presence address from that agent id (' + args.agentId + '), because it carries no pod '
        + 'segment this reader knows how to take out. No pod was asked, so whether its host is running was never established in '
        + 'either direction.',
    };
  }
  const now = args.nowMs ?? Date.now();

  /**
   * ★ THE NEWEST LEASE THE AGENT HAS PUBLISHED — NOT THE NEWEST ONE STILL INSIDE ITS OWN WINDOW.
   *
   * This read used to be `effective_at: now`, letting the relay's temporal filter pick, and that
   * is subtly the wrong question. MEASURED, live, 2026-08-09: an agent published a year-long lease
   * (the forged-lease case), then an honest 180s one, then stopped. Once the honest lease lapsed
   * the year-long one was the only row still valid, so it became the answer — a claim the agent had
   * already superseded, resurfacing because the newer claim expired. It was reported as `overlong`
   * and so was never read as presence, but the reasoning was wrong and the shape generalises: any
   * older, longer-lived lease outlives the newer one that replaced it.
   *
   * An agent's presence is its CURRENT claim. So the head is what governs, and its own window is
   * checked here against `now`. That is also one round trip instead of two — which matters, because
   * a channel picker reads this once per delegate inside Discord's three-second budget — and it
   * distinguishes `never` from `stale` without a second query.
   *
   * The row's own `validUntil` is used HERE and only here, as a pre-filter that saves a descriptor
   * fetch for a lease the relay has already stopped answering for. Every temporal decision — stale,
   * overlong, the expiry reported to a caller — is taken further down from `iep:leaseExpires` and
   * `dct:created` INSIDE the signed region, and a disagreement between the two is reported as
   * `disputed` rather than resolved by picking one.
   */
  let rows: readonly Record<string, unknown>[];
  try {
    const p = await port.tool('discover_context', {
      pod_name: pod, graph_iri: iri, sort: 'newest-first', limit: 8,
      // No cache: presence is the one read where a two-minute-old answer is exactly the wrong one.
    }, { cache: false }) as Record<string, unknown> | null;
    const bad = relayRefusal(p);
    if (bad) throw new Error(String(bad['message'] ?? bad['error']));
    rows = Array.isArray(p?.['entries']) ? p?.['entries'] as Record<string, unknown>[] : [];
  } catch (e) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'pod ' + pod + ' did not answer when asked whether that agent had said it was running (' + describe(port, e)
        + '). That is not the same as it being off, and neither is being assumed.',
    };
  }

  if (!rows.length) {
    return {
      state: 'never', agentId: args.agentId, pod, iri,
      why: 'that pod holds no presence document for this agent at all. It may well be a real agent; nothing has ever '
        + 'published that its host was up.',
    };
  }

  // ── the relay's own row, used ONLY as the cheap pre-filter it is ──────────
  //
  // ★ NOTHING BELOW DECIDES ANYTHING FROM THESE TWO NUMBERS. `validFrom` and `validUntil` are the
  // relay's unsigned row metadata, and this module's whole position is that a relay-held claim
  // about availability is a third party vouching for a process it cannot see. What the row is good
  // for is skipping a descriptor fetch for a lease the relay has already stopped answering for —
  // and, further down, being HELD AGAINST the signed value so a disagreement is visible.
  const head = rows[0] as Record<string, unknown>;
  const rowFrom = parseMs(head['validFrom']);
  const rowUntil = parseMs(head['validUntil']);
  if (rowUntil !== null && rowUntil <= now) {
    return {
      state: 'stale', agentId: args.agentId, pod, iri, lastExpiresMs: rowUntil,
      why: 'the newest lease this agent published lapsed at ' + new Date(rowUntil).toISOString() + ' and has not been '
        + 'renewed since. Older leases of its own may still be inside their windows; they are claims it has already '
        + 'superseded, and its current claim is this one.',
    };
  }
  const url = typeof head['descriptorUrl'] === 'string' ? head['descriptorUrl'] : '';
  if (!url) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'a live lease was listed for this agent and the listing named no descriptor to read it out of, so nothing was read from bytes anybody signed',
    };
  }

  let d: Record<string, unknown>;
  try { d = await port.descriptor(url); }
  catch (e) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'that lease is listed as live and its descriptor could not be fetched (' + describe(port, e) + '), so who signed it is not established',
    };
  }
  const authorship = readAuthorship(d['authorship']);
  const block = d['authorship'] as Record<string, unknown> | undefined;
  const verified = block?.['authorshipVerified'] === true || block?.['signed'] === true;
  if (!verified) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'that lease\'s authorship did not verify, so nothing about who published it is established. An unverified claim that '
        + 'a process is running is not evidence that one is.',
    };
  }
  if (authorship.contentBinding !== 'bound' && authorship.contentBinding !== 'bound-at-signing') {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'that lease\'s signature reports contentBinding "' + (authorship.contentBinding ?? 'none') + '", so the proof covers '
        + 'WHICH document was written and not WHAT it says. The expiry inside it is not something that signature stands behind.',
    };
  }
  if (authorship.signerAgent !== args.agentId) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'that lease was signed by ' + (authorship.signerAgent ?? 'an agent the response did not name') + ' and it claims to be '
        + 'about ' + args.agentId + '. Only a process holding that agent\'s own key can say its host is running, so this is not '
        + 'being read as presence.',
    };
  }
  const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', iri);
  if (region === null) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: 'the signed region of that lease could not be located, so nothing was read from bytes anybody signed',
    };
  }
  // ★ EVERY object of `iep:presenceOf`, not the first. These readers are region-scoped and the
  // author of the region controls its bytes, so a lease stating the predicate twice would let
  // `readIri` silently pick one — a choice about whose presence this is, made by an arbitrary
  // document order. Anything but exactly one agreeing object is refused.
  const about = readIriAll(region, 'iep:presenceOf');
  if (about.length !== 1 || about[0] !== args.agentId) {
    return {
      state: 'unreadable', agentId: args.agentId, pod, iri,
      why: about.length > 1
        ? 'that lease\'s signed region names ' + about.length + ' different agents as the one it is about, so which agent it is a '
          + 'claim about is not decided and picking one would be this reader guessing'
        : 'that lease\'s signed region names ' + (about[0] ?? 'no agent at all') + ' as the agent it is about, and it was asked for '
          + args.agentId + '. The document name is not an assertion; the region is, and it does not agree.',
    };
  }

  // ── the two numbers that actually decide this, BOTH out of the signed region ──────────────
  //
  // ★ THIS IS THE CHECK THE MODULE CLAIMED TO MAKE AND DID NOT. `iep:leaseExpires` was written by
  // `presenceTurtle` and never read: `stale`, `overlong` and the reported expiry all came off the
  // relay's `validUntil`/`validFrom`. Measured against the shipped reader, a descriptor whose SIGNED
  // region said the lease expired a year ago and whose relay row said two minutes remained came
  // back `running (said so 60s ago)` — presence decided entirely by the third-party assertion this
  // file exists to refuse, and the forged-lease guard enforced against a span the agent never
  // signed. The lease is the agent's claim, so the agent's own numbers govern.
  const signedExpires = parseMs(readLiteral(region, 'iep:leaseExpires'));
  const signedCreated = parseMs(readLiteral(region, 'dct:created'));
  if (signedExpires === null) {
    return {
      state: 'overlong', agentId: args.agentId, pod, iri, spanMs: null,
      why: 'that lease\'s signed region declares no readable iep:leaseExpires. A lease is only evidence because it is short and '
        + 'has to be renewed, and an expiry the agent did not sign is the relay\'s claim about availability rather than the '
        + 'agent\'s — so there is nothing here to read as presence.',
    };
  }
  // ★ THE DISAGREEMENT IS REPORTED, NOT RESOLVED. These are the same ISO string in every honest
  // publish — `publishPresence` sends one value to both — so a difference means the row and the
  // bytes are telling a reader two different things about the same lease. Picking the signed one
  // silently would throw away exactly the evidence the signed field exists to produce.
  if (rowUntil !== null && Math.abs(rowUntil - signedExpires) > 1000) {
    return {
      state: 'disputed', agentId: args.agentId, pod, iri,
      signedExpiresMs: signedExpires, rowExpiresMs: rowUntil,
      why: 'that lease\'s signed region says it expires at ' + new Date(signedExpires).toISOString() + ' and the relay\'s own '
        + 'row for it says ' + new Date(rowUntil).toISOString() + '. One of those the agent put its key to and one of those it '
        + 'did not, they do not agree, and reporting the disagreement is the whole reason the signed value is written.',
    };
  }
  if (signedExpires <= now) {
    return {
      state: 'stale', agentId: args.agentId, pod, iri, lastExpiresMs: signedExpires,
      why: 'the newest lease this agent published expired, by its own signed iep:leaseExpires, at '
        + new Date(signedExpires).toISOString() + ' and has not been renewed since.',
    };
  }
  const span = signedCreated === null ? null : signedExpires - signedCreated;
  if (span === null || span > PRESENCE_MAX_LEASE_MS) {
    return {
      state: 'overlong', agentId: args.agentId, pod, iri, spanMs: span,
      why: span === null
        ? 'that lease\'s signed region carries an expiry and no readable dct:created, so how long it claims to be good for cannot be computed and it is not being read as presence'
        : 'that lease is valid for ' + describeSpan(span) + ', by its own signed dates. A lease is only evidence because it is '
          + 'short and has to be renewed; one that long says nothing about whether anything is running now, so it is not being '
          + 'read as presence.',
    };
  }
  return {
    state: 'running', agentId: args.agentId, pod, iri,
    saidAtMs: signedCreated ?? rowFrom ?? now, expiresMs: signedExpires, descriptorUrl: url,
    host: readLiteral(region, 'iep:presenceHost'),
    authorship,
  };
}

/** "41s", "6m", "3h", "2d" — the coarsest unit that still says something. */
export function describeSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + 's';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

/**
 * One clause a surface can put beside an agent's name.
 *
 * ★ EVERY ONE OF THESE IS A STATEMENT ABOUT A DOCUMENT, NOT ABOUT A PROCESS. "said it was running
 * 41s ago" is what the lease says; nothing here can see a process, and a line that claimed to would
 * be the one sentence this whole module exists to avoid.
 */
export function presenceLine(p: Presence, nowMs = Date.now()): string {
  switch (p.state) {
    case 'running': return 'running (said so ' + describeSpan(nowMs - p.saidAtMs) + ' ago)';
    case 'stale': return p.lastExpiresMs === null ? 'not running as far as its pod says' : 'not since ' + new Date(p.lastExpiresMs).toISOString();
    case 'never': return 'its pod holds no lease for it at all';
    case 'overlong': return 'published a lease too long to be evidence';
    case 'disputed': return 'its lease and the relay disagree about when it expires';
    case 'unreadable': return 'whether it is running is not established';
    // ★ SAYS WHAT HAPPENED, WHICH IS THAT NOTHING DID. Every other line here reports a document;
    // this one reports that no document was looked for, because no address could be composed.
    case 'unnameable': return 'this client cannot compose a presence address from that agent id, so whether it is running was never asked';
  }
}

// ── The capability document ──────────────────────────────────

/**
 * HOW AN AGENT SAYS WHAT IT CAN BE ASKED — and the two shapes it may take.
 *
 * ★ TWO SHAPES, AND BOTH-OR-NEITHER IS REFUSED AT WRITE TIME.
 *
 *  · A HOSTED agent is a process at a URL, so it publishes `hydra:target`. `invoke_affordance`
 *    re-resolves that target out of the SIGNED graph at execution time, so a caller cannot redirect
 *    the call and the agent moves its endpoint by republishing one document.
 *  · A DESKTOP agent is a laptop, its human's model credential and no reachable endpoint, so it
 *    publishes `iep:askVia` naming the ask-and-wake path instead. ★ PUBLISHING A `hydra:target` FOR
 *    ONE WOULD ADVERTISE A CALL THAT CAN NEVER CONNECT. A reader that finds no target takes the ask
 *    path rather than pretending it can invoke.
 *
 * NEITHER is refused because an agent reachable by no route at all is advertising nothing, and BOTH
 * is refused because it would leave a reader choosing which of two ways is the real one with no
 * honest basis for the choice.
 *
 * ★ AND ACCESS CONTROL LIVES AT THE EXPOSING END, NOT IN THE RELAY. `invoke_affordance` forwards no
 * caller identity, and the tempting fix is to add forwarding — a substrate change, for a problem
 * the substrate already solves. `sign_request` is the dual: an exposer that wants to scope an offer
 * to specific peers requires a signed request, recovers the address and compares it to its own
 * policy. The check lands where the authority actually is, with the agent exposing the tool.
 */
export type CapabilityRoute =
  /** A process at a URL. The relay POSTs to it once it has resolved this document. */
  | { readonly kind: 'hosted'; readonly target: string }
  /** No endpoint. Reached by putting a record on the channel and waiting for its host to run. */
  | { readonly kind: 'ask'; readonly askVia: string };

export interface CapabilityDraft {
  /** The document's own IRI — `<relay>/ns/<agent pod>/agent-<agent pod>-capabilities`. */
  readonly iri: string;
  /** The agent this document is about. Inside the signed region, so a filename is not the claim. */
  readonly agentId: string;
  /** The `iep:action` a client names when invoking. Dereferenceable, per the URL-identifier rule. */
  readonly action: string;
  readonly route: CapabilityRoute;
  /**
   * A published SHACL shape the request body must satisfy, or absent for an action taking none.
   *
   * ★ THIS IS WHAT LETS AN ASK NAME *WHAT* RATHER THAN ONLY *WHO*. Without it an affordance is a
   * verb with no arguments: a caller learns an agent can be invoked and learns nothing about what
   * to send, so every cross-vertical composition degrades to prose in a channel with a human
   * reading it. With it, a Foxxi skill and a workspace agent are reached the same way — resolve
   * the shape, build a conforming body, invoke — because the contract is published data rather
   * than something each caller has to know out of band.
   *
   * `hydra:expects` and not a minted term: Hydra already means exactly this, and declaring input
   * under our own predicate would make every non-Interego client learn a synonym for a word it has.
   *
   * ★ A DECLARATION, NOT AN ENFORCEMENT POINT — the same rule as `requiresSignedRequest` below.
   * The gate is at the exposing end, where the endpoint validates what it actually received. A
   * caller treating the ABSENCE of a shape as "anything is acceptable" would be reading absence
   * as evidence.
   */
  readonly expects?: string;
  /** What a reader shows on the control. Read from here, never composed by the page. */
  readonly title: string;
  readonly description: string;
  /**
   * This agent will only act on a request whose caller signed it.
   *
   * ★ A DECLARATION, NOT AN ENFORCEMENT POINT, AND THE DIFFERENCE IS THE WHOLE DESIGN. The gate is
   * at the exposing end: the caller signs a canonical payload with `sign_request`, the endpoint
   * recovers the address and compares it to its own policy — the shape Foxxi's `/agent/teach`
   * already uses in production. This flag exists only so a caller learns the gate is there before
   * it spends a call finding out. Nothing about it is load-bearing for security, and a reader that
   * treated its ABSENCE as "no gate" would be reading absence as evidence.
   */
  readonly requiresSignedRequest?: boolean;
  readonly createdIso?: string;
}

/** Why this draft cannot be published, or null when it can. */
export function capabilityProblem(draft: {
  readonly action?: unknown; readonly route?: unknown; readonly expects?: unknown;
}): string | null {
  if (typeof draft.action !== 'string' || !draft.action) {
    return 'a capability names no iep:action, so there is nothing for a caller to invoke and nothing for a reader to dereference';
  }
  if (!/^https?:\/\//.test(draft.action)) {
    return 'a capability\'s iep:action must be a dereferenceable http(s) URL — every identifier in this system is one, and a '
      + 'reader that cannot follow it is being handed an opaque token dressed as a link. `' + draft.action + '` is not one.';
  }
  const r = draft.route as CapabilityRoute | undefined;
  if (!r || (r.kind !== 'hosted' && r.kind !== 'ask')) {
    return 'a capability declares neither a hydra:target nor an iep:askVia, so it advertises an agent reachable by no route at '
      + 'all. That is not a smaller offer than the other two; it is an offer a reader cannot act on in any way.';
  }
  if (r.kind === 'hosted' && !r.target) return 'a hosted capability names no hydra:target';
  if (r.kind === 'ask' && !r.askVia) return 'an ask-routed capability names no iep:askVia';
  /**
   * ★ THE SAME RULE AS `action`, BECAUSE A SHAPE NOBODY CAN FETCH IS NOT A CONTRACT.
   *
   * The whole value of declaring input is that a caller it has never met can resolve the shape and
   * build a conforming body. An opaque token here would advertise a contract while withholding it,
   * which is worse than declaring nothing — a caller would believe terms exist and be unable to
   * read them. Absent is fine and means "this document says nothing about input"; present and
   * unfetchable is refused.
   */
  if (draft.expects !== undefined) {
    if (typeof draft.expects !== 'string' || !draft.expects) {
      return 'a capability declares a hydra:expects that is not a string, so the shape a caller would have to satisfy is not named';
    }
    if (!/^https?:\/\//.test(draft.expects)) {
      return 'a capability\'s hydra:expects must be a dereferenceable http(s) URL, for the same reason iep:action must be: a '
        + 'caller has to be able to FETCH the shape to build a body that satisfies it. `' + draft.expects + '` is not one.';
    }
  }
  return null;
}

/**
 * The capability document, as Turtle.
 *
 * The subject is the document's own IRI because that is the region an `/ns/` reader locates — a
 * document whose statements hung off some other subject would publish, dereference, and read as
 * "this agent advertises nothing".
 */
export function capabilityTurtle(draft: CapabilityDraft): string {
  const problem = capabilityProblem(draft);
  if (problem) throw new Error('capabilityTurtle: ' + problem);
  const self = iriRef(draft.iri, 'the capability document IRI');
  const agent = iriRef(draft.agentId, 'the agent this capability document is about');
  const action = iriRef(draft.action, 'the action IRI');
  const route = draft.route.kind === 'hosted'
    ? '  hydra:target ' + iriRef(draft.route.target, 'the hydra:target, which comes from this deployment\'s own configuration') + ' ;\n'
      + '  hydra:method "POST" ;\n'
    : '  iep:askVia ' + iriRef(draft.route.askVia, 'the iep:askVia route') + ' ;\n';
  const expects = draft.expects
    ? '  hydra:expects ' + iriRef(draft.expects, 'the hydra:expects shape IRI') + ' ;\n'
    : '';
  const created = draft.createdIso ?? new Date().toISOString();
  return '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
    + '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .\n'
    + '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n'
    + self + '\n'
    + '  a iep:Affordance, hydra:Operation ;\n'
    + '  iep:capabilityOf ' + agent + ' ;\n'
    + '  iep:action ' + action + ' ;\n'
    + route
    + expects
    + (draft.requiresSignedRequest ? '  iep:requiresSignedRequest true ;\n' : '')
    + '  hydra:title "' + escapeTurtleLiteral(draft.title) + '" ;\n'
    + '  dct:description "' + escapeTurtleLiteral(draft.description) + '" ;\n'
    + '  dct:created "' + created + '"^^xsd:dateTime .\n';
}

export type CapabilityPublish =
  | { readonly kind: 'published'; readonly iri: string; readonly descriptorUrl: string | null; readonly status: string }
  | { readonly kind: 'unnameable'; readonly why: string }
  | { readonly kind: 'invalid'; readonly why: string }
  | { readonly kind: 'refused'; readonly iri: string; readonly why: string }
  | { readonly kind: 'error'; readonly iri: string | null; readonly error: unknown };

/**
 * Publish this agent's capability document on its own pod.
 *
 * `pod_name` is sent and it is the AGENT's own — derived from its DID, never an argument. A
 * capability document is a statement about WHO CAN BE ASKED, which is the one field that must not
 * be pointable at somebody else; and per the header, a proof only verifies on the pod whose owner
 * it was signed for, so anywhere else it would not be checkable either.
 */
export async function publishCapability(
  port: AgentPort,
  args: {
    readonly relay: string;
    readonly agentId: string;
    readonly action: string;
    readonly route: CapabilityRoute;
    readonly title: string;
    readonly description: string;
    readonly requiresSignedRequest?: boolean;
    readonly createdIso?: string;
  },
): Promise<CapabilityPublish> {
  const iri = capabilitiesIri(args.relay, args.agentId);
  const pod = agentPodOf(args.agentId);
  if (!iri || !pod) {
    return {
      kind: 'unnameable',
      why: 'This agent\'s id (' + args.agentId + ') carries no pod segment this client can read, so there is no address a peer '
        + 'would look for its capabilities at. Nothing was published.',
    };
  }
  const problem = capabilityProblem(args);
  if (problem) return { kind: 'invalid', why: problem };
  let res: Record<string, unknown>;
  try {
    res = await port.tool('publish_context', {
      pod_name: pod,
      graph_iri: iri,
      graph_content: capabilityTurtle({ iri, ...args }),
      visibility: 'public',
      // A reader reads the CURRENT head of this IRI, so republishing must move the head rather than
      // fork it. Unlike a log there is no history here that a reader walks.
      auto_supersede_prior: true,
      // Signed, because an unsigned capability document is an unattributable instruction to POST
      // somewhere. The bytes are immutable once published and the key moves on, so a document not
      // signed at write time can never be attributed afterwards.
      sign_authorship: true,
    }) as Record<string, unknown>;
  } catch (e) { return { kind: 'error', iri, error: e }; }
  const bad = relayRefusal(res);
  if (bad) return { kind: 'refused', iri, why: String(bad['message'] ?? bad['error']) };
  return {
    kind: 'published', iri,
    descriptorUrl: typeof res['descriptorUrl'] === 'string' ? res['descriptorUrl'] : null,
    status: String(res['status'] ?? 'ok'),
  };
}

/** What an agent's capability document turned out to say. */
export type CapabilityRead =
  | {
      readonly kind: 'advertised';
      readonly agentId: string;
      readonly iri: string;
      readonly action: string;
      readonly route: CapabilityRoute;
      /**
       * The published shape a request body must satisfy, when the document declared one.
       *
       * Optional because absence is a real answer and a different one from "takes nothing": the
       * document said nothing, so the caller knows nothing, and a reader that reported an empty
       * contract would be inventing the agent's terms for it.
       */
      readonly expects?: string;
      readonly title: string | null;
      readonly description: string | null;
      /** What the document DECLARES about a signing gate. Absence is not "no gate" — see the draft. */
      readonly requiresSignedRequest: boolean;
      readonly descriptorUrl: string;
      readonly authorship: AuthorshipReading;
    }
  /** The pod answered and holds no capability document. Its own answer, not a failure. */
  | { readonly kind: 'none'; readonly agentId: string; readonly iri: string; readonly why: string }
  | { readonly kind: 'unreadable'; readonly agentId: string; readonly iri: string; readonly why: string }
  /**
   * No address could be composed from that id, so no pod was asked.
   *
   * ★ NOT `none`. This used to collapse into it, and `none` renders as "advertises nothing" — a
   * statement about an agent, produced from this client's inability to parse its name.
   */
  | { readonly kind: 'unnameable'; readonly agentId: string; readonly iri: null; readonly why: string };

/**
 * What this agent says it can be asked, read from its own pod and checked against its own key.
 *
 * ★ THE SAME FOUR SIGNATURE CHECKS AS A LEASE, AND FOR A SHARPER REASON. A capability document
 * tells a reader where to POST. An unverified one is an unattributable instruction to send somebody
 * else's work to an address of the forger's choosing, so `unreadable` — never a capability.
 *
 * ★ AND THIS ONE CAN DEMAND THE FULL `authorshipVerified` WHERE `verifyRequest` CANNOT, which is
 * the own-pod rule paying for itself. A presence lease and a capability document are written by an
 * agent on ITS OWN pod, so the proof's owner IS the pod's owner and the descriptor binding holds. A
 * channel entry is written by a delegate on ITS DELEGATOR's pod, where it structurally cannot. Two
 * different documents, two different strongest-available checks, and the difference is a fact about
 * where each one lives rather than a preference.
 */
export async function readCapabilities(
  port: AgentPort,
  args: { readonly relay: string; readonly agentId: string },
): Promise<CapabilityRead> {
  const pod = agentPodOf(args.agentId);
  const iri = capabilitiesIri(args.relay, args.agentId);
  if (!pod || !iri) {
    return {
      kind: 'unnameable', agentId: args.agentId, iri: null,
      why: 'this client cannot compose a capability address from that agent id (' + args.agentId + '), because it carries no pod '
        + 'segment this reader knows how to take out. No pod was asked, so what that agent can be asked is not established — '
        + 'which is not the same as it advertising nothing.',
    };
  }
  let rows: readonly Record<string, unknown>[];
  try {
    const p = await port.tool('discover_context', { pod_name: pod, graph_iri: iri, sort: 'newest-first', limit: 4 }, { cache: false }) as Record<string, unknown> | null;
    const bad = relayRefusal(p);
    if (bad) throw new Error(String(bad['message'] ?? bad['error']));
    rows = Array.isArray(p?.['entries']) ? p?.['entries'] as Record<string, unknown>[] : [];
  } catch (e) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'pod ' + pod + ' did not answer when asked what that agent can be asked (' + describe(port, e) + '), so its capabilities are not established — which is not the same as it having none' };
  }
  if (!rows.length) {
    return { kind: 'none', agentId: args.agentId, iri, why: 'that pod holds no capability document for this agent, so it advertises nothing a reader could invoke' };
  }
  const url = typeof rows[0]?.['descriptorUrl'] === 'string' ? rows[0]['descriptorUrl'] as string : '';
  if (!url) return { kind: 'unreadable', agentId: args.agentId, iri, why: 'a capability document was listed and the listing named no descriptor to read it out of' };
  let d: Record<string, unknown>;
  try { d = await port.descriptor(url); }
  catch (e) { return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document could not be fetched (' + describe(port, e) + '), so who published it is not established' }; }
  const authorship = readAuthorship(d['authorship']);
  const block = d['authorship'] as Record<string, unknown> | undefined;
  if (!(block?.['authorshipVerified'] === true || block?.['signed'] === true)) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document\'s authorship did not verify. An unverified document naming a place to POST is an unattributable instruction, so nothing is being read out of it.' };
  }
  if (authorship.contentBinding !== 'bound' && authorship.contentBinding !== 'bound-at-signing') {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document\'s signature reports contentBinding "' + (authorship.contentBinding ?? 'none') + '", so it covers WHICH document was written and not WHAT it says — the target inside it is not something that signature stands behind' };
  }
  if (authorship.signerAgent !== args.agentId) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document was signed by ' + (authorship.signerAgent ?? 'an agent the response did not name') + ' and it sits at the address for ' + args.agentId + '. Only that agent can say what it can be asked.' };
  }
  const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', iri);
  if (region === null) return { kind: 'unreadable', agentId: args.agentId, iri, why: 'the signed region of that capability document could not be located, so nothing was read from bytes anybody signed' };
  const about = readIriAll(region, 'iep:capabilityOf');
  if (about.length !== 1 || about[0] !== args.agentId) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document\'s signed region names ' + (about.length > 1 ? about.length + ' different agents' : (about[0] ?? 'no agent at all')) + ' as the agent it is about, and it was asked for ' + args.agentId + '. The document name is not an assertion; the region is.' };
  }
  const action = readIri(region, 'iep:action');
  const expects = readIri(region, 'hydra:expects');
  const target = readIri(region, 'hydra:target');
  const askVia = readIri(region, 'iep:askVia');
  if (!action) return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document names no iep:action, so there is nothing in it a caller could invoke' };
  if (target && askVia) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document declares BOTH a hydra:target and an iep:askVia. Those are two different ways to reach this agent and nothing in the document says which is the real one, so choosing would be this reader guessing on the caller\'s behalf.' };
  }
  if (!target && !askVia) {
    return { kind: 'unreadable', agentId: args.agentId, iri, why: 'that capability document declares neither a hydra:target nor an iep:askVia, so it advertises an agent reachable by no route at all' };
  }
  return {
    kind: 'advertised', agentId: args.agentId, iri, action,
    route: target ? { kind: 'hosted', target } : { kind: 'ask', askVia: askVia as string },
    // ★ ABSENT STAYS ABSENT. Defaulting this would report that the agent accepts anything, which
    // is a claim its document did not make — the same absence-is-not-evidence rule the rest of
    // this reader is built on.
    ...(expects ? { expects } : {}),
    title: readLiteral(region, 'hydra:title'),
    description: readLiteral(region, 'dct:description'),
    requiresSignedRequest: substrateReaders.hasTrue(region, 'iep:requiresSignedRequest'),
    descriptorUrl: url, authorship,
  };
}

// ── A request addressed to an agent ──────────────────────────

/**
 * ── THE MEASUREMENT THIS HALF IS BUILT ON ────────────────────────────────────────────────────
 *
 * ★ ANY ACCOUNT ON THIS RELAY CAN DELIVER INTO ANY INBOX. That is measured, and the desktop shell
 * already says it out loud beside every invitation it draws: an inbox item is a CLAIM. So an inbox
 * item is never the request and is never acted on directly. What arrives is a POINTER; the request
 * itself is a signed, chained record on the ASKER's own pod, readable by every peer with or without
 * any notification ever having been delivered.
 *
 * That is also why a running host needs no notification at all: it is already reading, and the
 * record is there. `notify_agent` is an ACCELERANT for the case where the host was off when the ask
 * was made. It never carries the task text, because text that travelled by inbox is text a forger
 * could write.
 *
 * ★ AND A FAILING CHECK DOES NOT DISCARD THE ITEM. It comes back as an unverified claim with the
 * checklist showing which check failed, and nothing is dispatched. Silently dropping it would make
 * a forged notice and a genuine one look identical from the outside — the failure that makes people
 * stop reading their inbox at all.
 */

/** How many inbox items one read looks at. */
export const REQUEST_INBOX_LIMIT = 50;

/**
 * One item from an inbox that MIGHT be a request addressed to an agent on this machine.
 *
 * `type` is the notification's own — `Question` is what a request is delivered as — and it is
 * carried rather than filtered on alone, because the type is the sender's word and the checks
 * below are not.
 */
export interface RequestNotice {
  readonly item: Record<string, unknown>;
  readonly about: string;
  readonly actor: string | null;
  readonly summary: string | null;
  readonly published: string | null;
}

/**
 * Read the inbox and keep the items that point at something. Nothing is verified here.
 *
 * ★ `pod_url` IS DELIBERATELY NOT SENT AND CANNOT USEFULLY BE. Measured live: the relay answers
 * `read_inbox: forbidden — you may only read your own inbox` for any pod but the caller's. So this
 * reads the inbox of whatever session the port carries and nothing else — which is why the address
 * it read is REPORTED. A request addressed to an agent has to be delivered to the pod that agent's
 * OWN session polls, and for a whole release it was delivered to its delegator's pod instead, where
 * it sat unread while the panel said "nothing was waiting". `inbox` is what makes that checkable by
 * a caller and assertable by a driver.
 */
export async function readRequests(port: AgentPort, limit = REQUEST_INBOX_LIMIT): Promise<{
  readonly notices: readonly RequestNotice[];
  readonly saturated: boolean;
  readonly limit: number;
  /** The inbox the relay reports for THIS session — the canonical address a peer must deliver to. */
  readonly inbox: string | null;
}> {
  const p = await port.tool('read_inbox', { limit }, { cache: false }) as Record<string, unknown> | null;
  const bad = relayRefusal(p);
  if (bad) throw new Error(String(bad['message'] ?? bad['error']));
  const inbox = typeof p?.['inbox'] === 'string' ? p['inbox'] as string : null;
  const all = Array.isArray(p?.['items']) ? p?.['items'] as Record<string, unknown>[] : [];
  const notices = all
    .filter((it) => it && typeof it['about'] === 'string' && it['about'])
    .map((item) => ({
      item,
      about: String(item['about']),
      actor: typeof item['actor'] === 'string' ? item['actor'] : null,
      summary: typeof item['summary'] === 'string' ? item['summary'] : null,
      published: typeof item['published'] === 'string' ? item['published'] : null,
    }));
  return { notices, saturated: all.length >= limit, limit, inbox };
}

/**
 * The canonical LDN inbox of whatever session this port carries, as the relay itself reports it.
 *
 * ★ COMPOSED BY THE RELAY, NEVER BY A CLIENT, AND THAT IS THE ENTIRE POINT. The desktop shell used
 * to advertise `<relay>/ns/<its human's pod>/inbox` as the route by which its agent could be
 * reached. That address 404s — it is a `/ns/` graph name and not an inbox — AND it named the wrong
 * pod, so the one route a stranger holding only the DID was told to use dereferenced to nothing and
 * pointed at a mailbox the agent does not read. Measured: the relay answers with
 * `http://css.railway.internal:3456/<pod>/inbox/`, an address `notify_agent` accepts directly and
 * reports back as `canonicalInbox: true`. That is a real route; a composed one was a guess.
 */
export async function agentInbox(port: AgentPort): Promise<string | null> {
  const p = await port.tool('read_inbox', { limit: 1 }, { cache: false }) as Record<string, unknown> | null;
  const bad = relayRefusal(p);
  if (bad) throw new Error(String(bad['message'] ?? bad['error']));
  return typeof p?.['inbox'] === 'string' && p['inbox'] ? p['inbox'] as string : null;
}

/**
 * Whether the party that wrote a record has standing to put work to this agent.
 *
 * ★ THIS IS THE ONE THING THE SUBSTRATE CANNOT ANSWER, AND IT IS THE HINGE OF THE WHOLE LAYERING.
 * A workspace supplies "is the asker seated in this room"; a Codex agent supplies "is the asker on
 * my allowlist"; a bare delegate supplies "any verified signer will do". Every other check below is
 * identical for all three. Before this was a parameter, verification took a workspace roster — and
 * was therefore unusable by an agent that belongs to no workspace, which is precisely the case the
 * model says must work.
 *
 * Return null to admit, or the sentence explaining the refusal.
 */
export type AdmissionPredicate = (asker: {
  /**
   * The first path segment of the URL the NOTICE pointed at. ★ NOT ESTABLISHED AS A POD, AND A
   * PREDICATE THAT GATES ON IT IS NOT A GATE.
   *
   * The whole URL comes off an inbox item, an inbox on this relay is world-writable, and
   * `get_descriptor` will fetch a caller-supplied URL on any public host — measured: it returned
   * the contents of `raw.githubusercontent.com/w3c/…` and this field then read `"w3c"`. So a
   * descriptor served from `https://attacker.example/u-eth-<a seated pod>/req.ttl` yields the name
   * of a pod the bytes never touched. It is carried because it is worth SAYING in a report, and it
   * is named for what it actually is so nobody keys a decision on it again.
   *
   * Key on {@link signedBy}, which the relay verified over the bytes.
   */
  readonly servedFromPath: string;
  /** The agent or WebID whose signature the relay verified over that record. */
  readonly signedBy: string;
  /** The signed region, for a predicate that needs to read a context out of the record itself. */
  readonly region: string;
  readonly descriptorUrl: string;
}) => string | null | Promise<string | null>;

/** Admit anybody whose record verifies. The honest default for a bare delegate. */
export const admitAnyVerifiedSigner: AdmissionPredicate = () => null;

/** What one notice turned out to be, once the record it points at was read. */
export interface RequestVerdict {
  readonly about: string;
  readonly checks: readonly Check[];
  /** True only when every check is a finding in favour. A `q` never makes it true. */
  readonly ok: boolean;
  readonly why: string | null;
  /**
   * The first path segment of the URL the notice pointed at. ★ A REPORTING FIELD, NOT A FINDING —
   * see {@link AdmissionPredicate.servedFromPath}: the URL is attacker-chosen and the relay will
   * fetch any public host, so this is what the address LOOKED like and not where the bytes live.
   */
  readonly servedFromPath: string | null;
  /** The body of the ask, read out of the signed region. Null when the region carried none. */
  readonly body: string | null;
  /** The agent ids the record says it is addressed to. */
  readonly addressedTo: readonly string[];
  /** Which of those this machine holds a key for. */
  readonly forMe: readonly string[];
  readonly descriptorUrl: string | null;
  readonly signedBy: string | null;
  /** The signed region, so a caller does not fetch and locate it a second time. */
  readonly region: string | null;
}

/**
 * Hold one inbox notice against the signed record it points at.
 *
 * ★ NOTHING BELIEVES THE ITEM. Every field the verdict carries comes out of the descriptor or out
 * of what the caller already knew; the item supplies only the address to go and look at, and the
 * `actor` that check 3 holds against the signature.
 *
 * The six checks, and why each is a refusal — each answers a question that, left unasked, lets
 * somebody else's claim become work done on your human's subscription and a permanent record on
 * their pod:
 *
 *   1. the `about` resolves to a descriptor at all — otherwise the notice points at nothing;
 *   2. its signature is INTACT AND BOUND TO ITS OWN CONTENT, and names a signer. Measured: this is
 *      `contentBinding === 'bound'` and NOT `authorshipVerified`, which additionally requires the
 *      proof to name the URL it was served from and is therefore false for every delegated
 *      cross-pod write — see the check itself for why keying on it refused the whole class of
 *      record this exists to accept;
 *   3. the notice's `actor` IS the party that signed that record. ★ THIS IS THE CHECK THAT MAKES A
 *      WORLD-WRITABLE INBOX SURVIVABLE: a pointer placed by somebody who did not write the thing is
 *      somebody else pointing at your record;
 *   4. `iep:addressedTo` names an agent THIS MACHINE HOLDS A KEY FOR — an agent runs on its own
 *      human's credential, and answering for one whose key is elsewhere is the path that must not
 *      exist;
 *   5. {@link AdmissionPredicate} admits the asker — the caller's own policy, see above;
 *   6. it has not already been answered — this run's list first, and a record on my own pod
 *      declaring `prov:wasDerivedFrom` it second, because the second survives a restart.
 *
 * Worst case a forger achieves is wasted attention. They cannot supply text (2), cannot point at
 * somebody else's record (3), cannot reach a key they do not hold (4), cannot pass a policy they are
 * not in (5), and cannot cause a second answer (6).
 */
export async function verifyRequest(
  port: AgentPort,
  notice: RequestNotice,
  args: {
    /** Agent ids this machine holds a private key for. The keyring, and NOT any pod's roster. */
    readonly heldAgentIds: readonly string[];
    /** Descriptor URLs this run has already answered. */
    readonly answeredHere: readonly string[];
    /** Descriptor URLs some record on my own pod already declares it was derived from. */
    readonly derivedFromOnMyPod: readonly string[];
    /** The caller's own standing policy. Omitted means any verified signer. */
    readonly admits?: AdmissionPredicate;
  },
): Promise<RequestVerdict> {
  const checks: Check[] = [];
  const base = {
    about: notice.about, servedFromPath: null, body: null,
    addressedTo: [] as readonly string[], forMe: [] as readonly string[],
    descriptorUrl: null, signedBy: null, region: null,
  };
  const no = (why: string, extra: Partial<RequestVerdict> = {}): RequestVerdict => {
    checks.push({ mark: 'n', text: why });
    return { ...base, ...extra, checks, ok: false, why };
  };

  // ── 1. it resolves ─────────────────────────────────────────────────────────
  let d: Record<string, unknown>;
  try { d = await port.descriptor(notice.about); }
  catch (e) {
    return no('the address this notice points at did not resolve to a descriptor (' + describe(port, e)
      + '), so there is nothing signed to read the ask out of');
  }
  const descriptorUrl = notice.about;
  const servedFromPath = podOfDescriptorUrl(descriptorUrl);
  checks.push({ mark: 'y', text: 'The address in the notice resolves to a descriptor' + (servedFromPath ? ', at a URL whose first path segment is ' + servedFromPath : '') });

  // ── 2. the signature is intact AND covers these bytes ─────────────────────
  //
  // ★ THIS CHECK IS `contentBinding`, NOT `authorshipVerified`, AND THE DIFFERENCE IS THE WHOLE
  // REASON THE ASK-AND-WAKE PATH WORKS AT ALL. Measured live, 2026-08-09, on the exact write the
  // Discord conduit makes — a delegate's session appending to its DELEGATOR's pod:
  //
  //     authorshipVerified: false
  //     signedBy:           <the delegate>
  //     contentBinding:     "bound"
  //     descriptorBinding:  { bound: false, basis: "none" }
  //     reason:             "the authorship proof's signature is INTACT, but the proof is not
  //                          about this record: … signed for owner <the delegate's own WebID> and
  //                          the pod serving … publishes <the delegator> as its owner."
  //
  // `authorshipVerified` is the conjunction of "the signature verified" AND "the proof names the
  // URL this was served from". The second half is FALSE BY CONSTRUCTION for every delegated
  // cross-pod write — which is EVERY entry a conduit relays and EVERY entry a desktop delegate
  // writes for its human. A verifier keyed on it refuses precisely the class of record it exists
  // to accept, and does so with the words "authorship did not verify" about a signature the relay
  // has just called intact.
  //
  // ★ AND `contentBinding: 'bound'` IS SOUND ON ITS OWN, which is why it is safe to key on. Read
  // the relay's own verifier: a failed signature returns `contentBindingWhenUnchecked(...)` and
  // never reaches the comparison, so `'bound'` is only ever produced on a path where the signature
  // verified AND the digest inside the signed payload was recomputed over the payload served here
  // and matched. It is therefore strictly the statement this check needs — these bytes are
  // authentically attributable to `signedBy` — and `authorshipVerified` only ever ADDED a question
  // about the address.
  //
  // ★ WHAT IS GENUINELY LOST IS REPORTED RATHER THAN WAVED THROUGH. An unbound descriptor means a
  // proof could have been written for a document at another URL and replayed here. Two things
  // carry that weight instead, and both are below: check 3 requires that the party who DELIVERED
  // the pointer is the party who SIGNED the record (and the relay sets the deliverer from its own
  // session, so it cannot be claimed), and check 5 requires the pod the record was SERVED from to
  // have standing. A replayed copy on a forger's pod passes neither.
  const block = d['authorship'] as Record<string, unknown> | undefined;
  const binding = typeof block?.['contentBinding'] === 'string' ? block['contentBinding'] as string : null;
  const signedBy = typeof block?.['signedBy'] === 'string' ? block['signedBy'] as string
    : typeof block?.['signer'] === 'string' ? block['signer'] as string : null;
  const descriptorBound = (block?.['descriptorBinding'] as { bound?: unknown } | undefined)?.bound === true;
  const withDoc = { descriptorUrl, servedFromPath, signedBy };
  if (binding !== 'bound' && binding !== 'bound-at-signing') {
    return no('that record\'s signature reports contentBinding "' + (binding ?? 'none') + '". Only "bound" means a signature '
      + 'was verified AND its digest recomputed over the bytes being served, so nothing here establishes that what the ask says '
      + 'is what anybody signed.', withDoc);
  }
  if (!signedBy) {
    return no('that record\'s content is bound to a signature and the response names no signer, so who wrote the ask is not '
      + 'established — and check 3 below has nothing to hold the deliverer against', withDoc);
  }
  checks.push({ mark: 'y', text: 'Its signature is intact and bound to its own content, signed by ' + signedBy });
  // Reported, never fatal. `q` and not `y`: this is a question that was asked and not answered in
  // this record's favour, and rendering it as a pass would be the collapse the relay itself refuses.
  if (!descriptorBound) {
    checks.push({
      mark: 'q',
      text: 'Its proof does not bind to the address it was served from — the ordinary shape of a delegated write, where the '
        + 'signer is the agent and the pod is its delegator\'s. What rules out a proof replayed onto somebody else\'s pod is '
        + 'not this field but the two checks below: the party that delivered the pointer must BE the signer, and the pod it '
        + 'was served from must have standing.',
    });
  }

  // ── 3. the notice's sender is the party that signed the record ────────────
  if (!notice.actor) {
    return no('the notice names no actor, so whether the party that delivered it is the party that wrote the record is not established', withDoc);
  }
  if (notice.actor !== signedBy) {
    return no('the notice was delivered by ' + notice.actor + ' and the record it points at was signed by '
      + (signedBy ?? 'an agent the descriptor did not name') + '. Any account on this relay can deliver into any inbox, so a '
      + 'pointer placed by a party that did not write the thing is somebody else pointing at your record.', withDoc);
  }
  checks.push({ mark: 'y', text: 'The account that delivered the notice is the one that signed the record it points at (' + signedBy + ')' });

  // ── the signed region, which everything below reads from ──────────────────
  //
  // ★ THE REGION IS NAMED BY THE GRAPH THE DESCRIPTOR DECLARES, NOT BY THE RECORD'S OWN IRI. A log
  // publishes with `graph_iri: <stream>` and a subject of `<stream>/e/<seq>` inside it, so the TriG
  // block is `<stream> { … }` and locating it by the RECORD's IRI finds nothing — the defect where
  // three correctly committed entries all rendered "the signed region could not be located". A
  // verifier reached by a notification has no roster to hand, so the graph IRIs come out of the
  // descriptor's own `iep:describes`. Composing one would be this reader deciding what the document
  // is about.
  const content = (d['graph'] as { content?: string } | undefined)?.content ?? '';
  const describes = readIriAll(typeof d['turtle'] === 'string' ? d['turtle'] as string : '', 'iep:describes');
  let region: string | null = null;
  for (const g of describes) { region = graphRegion(content, g); if (region !== null) break; }
  if (region === null) {
    return no('the signed region of that record could not be located'
      + (describes.length ? ' under any of the ' + describes.length + ' graph IRIs its descriptor declares' : ', and its descriptor declares no iep:describes to look one up by')
      + ', so nothing was read from bytes anybody signed', withDoc);
  }
  const body = readLiteral(region, 'dct:description');
  const addressedTo = readIriAll(region, 'iep:addressedTo');
  const withRegion = { ...withDoc, body, addressedTo, region };

  // ── 4. it is addressed to an agent whose key is on THIS machine ───────────
  const held = new Set(args.heldAgentIds);
  const forMe = addressedTo.filter((a) => held.has(a));
  if (!addressedTo.length) {
    return no('that record names no iep:addressedTo, so it is not a request addressed to anybody. It is a record and is read as '
      + 'one; nothing is being dispatched from it.', withRegion);
  }
  if (!forMe.length) {
    return no('that record is addressed to ' + addressedTo.join(', ') + ' and this machine holds no key for any of them. An '
      + 'agent runs on its own human\'s credential, so answering for an agent whose key is somewhere else is the one thing this '
      + 'refuses to do.', withRegion);
  }
  checks.push({ mark: 'y', text: 'It is addressed to ' + forMe.join(', ') + ', and this machine holds that key' });

  // ── 5. the caller's own standing policy ───────────────────────────────────
  //
  // ★ THE PREDICATE IS HANDED THE SIGNER, AND THE PATH SEGMENT IS LABELLED AS ONE. It used to be
  // handed `pod`, taken from the first path segment of the notice's own `about` — a field a forger
  // writes — and `admitSeatedIn` gated on exactly that. A descriptor served from
  // `https://attacker.example/u-eth-<a seated pod>/req.ttl` therefore produced the name of a pod
  // the bytes had never touched, and check 5 admitted it. What the relay actually verified over
  // these bytes is `signedBy`, so that is what a policy resolves; the segment is carried for the
  // report and named so that nobody keys on it again.
  const admits = args.admits ?? admitAnyVerifiedSigner;
  const refused = await admits({ servedFromPath: servedFromPath ?? '', signedBy: signedBy as string, region, descriptorUrl });
  if (refused) return no(refused, { ...withRegion, forMe });
  checks.push({ mark: 'y', text: signedBy + ' has standing to ask this agent, by this host\'s own policy rather than by anything in the notice' });

  // ── 6. it has not already been answered ───────────────────────────────────
  if (args.answeredHere.indexOf(descriptorUrl) >= 0) {
    return no('this client has already drafted an answer to that record in this run. Answering again would put a second '
      + 'permanent record in your log saying the same thing.', { ...withRegion, forMe });
  }
  if (args.derivedFromOnMyPod.indexOf(descriptorUrl) >= 0) {
    return no('a record already on your pod declares it was derived from that one, so it has been answered — and that survives '
      + 'a restart of this app, which the in-run list above does not.', { ...withRegion, forMe });
  }
  checks.push({ mark: 'y', text: 'Nothing on your pod and nothing in this run has answered it yet' });

  return { about: notice.about, ...withRegion, forMe, checks, ok: true, why: null };
}

/**
 * The first path segment of a URL, which on a relay pod URL happens to be the pod name.
 *
 * ★ WHAT THIS IS NOT: EVIDENCE OF WHERE ANY BYTES CAME FROM. It used to say it was, and that
 * sentence was the reason a check gated on it. It is string surgery on whatever URL it is handed —
 * measured: `podOfDescriptorUrl('https://raw.githubusercontent.com/w3c/rdf-tests/main/README.md')`
 * is `'w3c'`, and `get_descriptor` will fetch and return that document. Where the URL came off an
 * inbox item, the segment is the sender's choice. Use it to SAY what an address looked like; never
 * to decide anything. Identity comes from the signature.
 */
export function podOfDescriptorUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const m = /^https?:\/\/[^/]+\/([^/]+)\//.exec(u);
  return m?.[1] ?? null;
}
