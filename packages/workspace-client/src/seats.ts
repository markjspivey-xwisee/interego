/**
 * THE SEAT FOLD: grants on the convener's pod, acceptances on each member's own.
 *
 * A seat is TWO documents on TWO pods with TWO different owners, and the substrate refuses
 * either party the other's pod — so neither half can be manufactured by the party that
 * benefits from it. Find only the grant and the row reads "invited"; find only the acceptance
 * and it reads as a seat nobody granted.
 *
 * ★ EVERY NON-SEAT CARRIES A REASON, AND THE REASONS ARE NOT INTERCHANGEABLE. "granted, but
 * no acceptance published yet" and "their acceptance could not be read" are different facts
 * about different worlds, and a fold that collapsed them told an invited member they had been
 * refused.
 */

import { graphRegion, hasTrue, isRetracted, readIri, readLiteral, readModalStatus } from './turtle.js';
import { podOfDescriptorUrl, podBaseOfDescriptorUrl, podOfNsIri, podOfWebid } from './naming.js';
import { shortRef } from './format.js';
import { fail, refusal } from './transport.js';
import type { WorkspaceClient } from './substrate.js';

/** One row of the roster: a grant, folded as far as it could be. */
export interface Seat {
  readonly graph: string;
  grantUrl: string | null;
  grantCid: string | null;
  role: string | null;
  grantedTo: string | null;
  pod: string | null;
  seated: boolean;
  /** Why this row is not a seat. Null only when `seated` is true. */
  why: string | null;
  /** Granted and awaiting an acceptance — an ordinary state, not a failure. */
  pending?: boolean;
  revoked?: boolean;
  /**
   * What each half of the seat states about its OWN status, read from its signed region.
   *
   * ★ SEPARATE FROM `revoked`, BECAUSE THEY ARE SEPARATE FACTS. `wsp:revoked` is the convener
   * withdrawing a seat; `iep:modalStatus "Retracted"` is the author of those bytes withdrawing
   * the record itself — and either half can be withdrawn by its own owner without touching the
   * other. Null is "the record stated no status", which is not a withdrawal.
   */
  grantStatus?: string | null;
  acceptStatus?: string | null;
  acceptIri?: string;
  acceptNaming?: string;
  acceptUrl?: string;
  acceptTest?: string;
  accepts?: string | null;
  acceptsCid?: string | null;
  stream?: string | null;
  /**
   * This member's X25519 public key, read from THEIR OWN acceptance's signed region.
   *
   * ★★ THE ONLY SOURCE A SEALING PUBLISHER MAY USE. The alternative — each pod's agent registry —
   * is rewritable by the relay, and `encryptionKeyToRecord` already substitutes the relay's own key
   * there as a placeholder for an agent that registered none. Sealing to a key read from the
   * registry can therefore seal to the relay while the publisher believes the opposite. Read from
   * the same signed region as `wsp:stream` and `wsp:accepts`, so a substituted key means a new
   * head that visibly supersedes an honest one.
   */
  encryptionKey?: string | null;
  streamPod?: string | null;
  podServed?: string | null;
  podBase?: string | null;
  memberAgent?: string | null;
  memberAgentVerified?: boolean;
  grantAuthorship?: unknown;
  acceptAuthorship?: unknown;
}

/** What the fold found, and the one cap it still has — how many of the grants it found it READ. */
export interface RosterFold {
  readonly seats: readonly Seat[];
  readonly grantPod: string;
  /** Non-null when the grant pod came from `wsp:convener` rather than the workspace IRI. */
  readonly grantPodDerivedFrom: string | null;
  readonly grantsFound: number;
  readonly grantsRead: number;
  readonly grantReadCap: number;
}

/**
 * How many of the grants the scan FINDS are then read.
 *
 * ★ THE ONLY CAP LEFT, AND IT IS A WORK BOUND RATHER THAN A VISIBILITY ONE. Each read is two
 * round trips (head + descriptor) against a possibly cold pod plus an acceptance lookup on the
 * member's own, so an unbounded fold on a large workspace is a client that appears to hang. The
 * ENUMERATION is now complete (see {@link foldRoster}); this bounds only how much of it one
 * caller will dereference, and the caller is told both numbers.
 *
 * ★ AND IT IS A DEFAULT, NOT A CONSTANT ANY MORE. One number cannot serve a background responder
 * and a per-keystroke Discord autocomplete: `main.ts` states that picker's budget as three
 * seconds with NO deferral — Discord has no "thinking" state for an autocomplete, so a handler
 * that overruns produces an empty box with no explanation. Callers with room pass a bigger
 * `readCap`; the picker keeps this.
 */
export const GRANT_READ_CAP = 25;

/**
 * WHICH POD HOLDS THE GRANTS, decided once and exported so a caller can NAME it.
 *
 * The record NAMES a convener; that name, resolved to a pod, is where grants are read from.
 * The pod segment inside the workspace IRI is only the fallback for a record that names none.
 * This is exported because a shell that reports "grants live on pod X and that read failed"
 * has to mean the same X the fold would have used — re-deriving the `??` in a message string
 * is how a diagnostic comes to name a pod nothing was ever asked for.
 */
export const grantPodFor = (convenerPod: string | null, iriOwner: string): string => convenerPod ?? iriOwner;

/**
 * Fold the roster for one workspace.
 *
 * ★ BOUNDED. The number of tool calls is `1 + 2·min(grantsFound, GRANT_READ_CAP) +
 * 2·(acceptance lookups)`, and the acceptance lookup is at most two heads per member. Nothing
 * here loops on a condition the relay controls.
 */
export async function foldRoster(
  client: WorkspaceClient,
  args: {
    readonly workspace: string;
    /** The pod segment inside the workspace IRI. Used only when the record names no convener. */
    readonly iriOwner: string;
    readonly slug: string;
    readonly convener: string | null;
    readonly convenerPod: string | null;
    /**
     * How many of the grants found may be dereferenced. Defaults to {@link GRANT_READ_CAP}.
     *
     * Per-caller because the budgets genuinely differ — see the constant. A caller that raises
     * this is claiming it has the time, and nothing here can check that claim for it.
     */
    readonly readCap?: number;
    /**
     * Pods whose grant should be read FIRST if the cap bites. The convener's own is always
     * included; a shell adds the viewer's.
     *
     * ★ WHICH GRANTS SURVIVE A TRUNCATED READ IS THE REAL DEFECT ONCE ENUMERATION IS COMPLETE.
     * The scan is newest-first, and grants are written ONCE at invite time while entries are
     * published to the same pod continuously — so the oldest members, very often including the
     * convener's own founding grant, are exactly the rows a cap drops. Ordering the rows that
     * matter to the front costs nothing and removes that symptom without raising the cap.
     */
    readonly prefer?: readonly string[];
  },
): Promise<RosterFold> {
  // ★ WHICH POD HOLDS THE GRANTS — see `grantPodFor`. Using the pod segment inside the
  // workspace IRI and throwing the convener away meant a record naming a convener elsewhere
  // was read from the wrong pod and reported an empty roster.
  const grantPod = grantPodFor(args.convenerPod, args.iriOwner);

  /**
   * ★ NO `limit`, AND THAT IS THE FIX RATHER THAN AN OVERSIGHT.
   *
   * This asked for `limit: 400` and then reported `grantScanSaturated` when 400 came back, which
   * every surface rendered as "older grants may lie past the end of this — a member missing from
   * the roster would also be missing from the channel". Honest, and avoidable: the cap bought
   * NOTHING. Read from the relay's own handler rather than assumed — `discover_context`'s `limit`
   * is optional, documented "Default: unbounded", has no maximum, and is applied LAST, as
   * `sorted.slice(0, limit)` over a set the relay has already built in full. It caches the whole
   * pod manifest server-side either way. So the 400 sliced the JSON response and cost this fold
   * the ability to see a founding member.
   *
   * ★ AND REMOVING IT CANNOT UNSEAT ANYBODY, because the relay sorts THEN slices: the capped
   * answer was exactly the newest-400 PREFIX of the uncapped one, so this can only append rows
   * older than the old cutoff. Monotone, checked against the handler and not inferred.
   *
   * ★ WHICH IS WHAT EARNS THE SILENCE. Dropping a "may be incomplete" warning is only honest if
   * the read is now complete, and this one is: `discover()` follows the manifest's archive chain
   * and THROWS rather than hand back a partial pod, so a short answer here is a real answer and
   * not a truncated one. Absence is evidence only when the read could not have missed anything.
   */
  const p = await client.tool('discover_context', { pod_name: grantPod, sort: 'newest-first' }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  const rows = (p?.['entries'] as readonly Record<string, unknown>[]) ?? [];

  const prefix = args.workspace + '-grant-';
  const seen = new Set<string>();
  const grantRows: { graph: string }[] = [];
  for (const e of rows) {
    const describes = e['describes'];
    if (!Array.isArray(describes)) continue;
    const g = (describes as string[]).find((x) => typeof x === 'string' && x.indexOf(prefix) === 0);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    grantRows.push({ graph: g });
  }
  const grantsFound = grantRows.length;
  const grantReadCap = args.readCap ?? GRANT_READ_CAP;
  // ★ A STABLE PARTITION, NOT A SORT. The relay's order is the only ordering evidence there is
  // for the rest; this moves the grants a truncated read must not lose to the front and leaves
  // every other row exactly where the relay put it.
  const first = new Set<string>([prefix + grantPod, ...(args.prefer ?? []).map((pod) => prefix + pod)]);
  const ordered = [...grantRows.filter((g) => first.has(g.graph)), ...grantRows.filter((g) => !first.has(g.graph))];
  const toRead = ordered.slice(0, grantReadCap);

  const seats: Seat[] = [];
  for (const g of toRead) {
    const m: Seat = { graph: g.graph, grantUrl: null, grantCid: null, role: null, grantedTo: null, pod: null, seated: false, why: null };
    try {
      // No cache on a head: a revocation republishes the grant, and a stale head would keep a
      // withdrawn member seated for the life of the entry.
      const h = await client.currentHead(g.graph, grantPod);
      if (h.forked) { m.why = "this grant's own chain has " + h.heads.length + ' unresolved heads, so which grant is current is not decided'; seats.push(m); continue; }
      if (!h.url) { m.why = 'unreadable' in h ? 'the current grant could not be resolved: ' + h.message : 'this grant has no current head: ' + h.message; seats.push(m); continue; }
      m.grantUrl = h.url;
      m.grantCid = h.cid;
      const d = await client.descriptor(h.url);
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', g.graph);
      // `region === null` is "not located"; `region === ''` is a block that WAS located and is
      // empty. Collapsing them reported a located region as missing.
      if (region === null) { m.why = 'the signed region of this grant could not be located, so nothing about it was read from bytes anybody signed'; seats.push(m); continue; }
      m.grantedTo = readIri(region, 'wsp:grantedTo');
      m.role = readIri(region, 'wsp:role');
      m.grantAuthorship = d['authorship'] ?? null;
      m.revoked = hasTrue(region, 'wsp:revoked');
      m.grantStatus = readModalStatus(region);
      // ★ A GRANT ITS OWN AUTHOR HAS WITHDRAWN IS NOT A SEAT EITHER, AND IT IS NOT A REVOCATION.
      // The convener owns both spellings here — the grant is on their pod — but they are not the
      // same statement, so they do not collapse into one sentence. Tested before the grantee is
      // resolved, because a withdrawn record's other fields are not current claims.
      if (isRetracted(region)) {
        m.why = 'this grant states iep:modalStatus "' + String(m.grantStatus) + '", so the pod that published it has '
          + 'withdrawn it as an assertion. That is not the same as wsp:revoked — nobody unseated this member, the '
          + 'record naming them was retired — and either way it seats nobody now.';
        seats.push(m); continue;
      }
    } catch (e) {
      m.why = 'the grant record could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
      seats.push(m); continue;
    }

    const pod = podOfWebid(m.grantedTo);
    m.pod = pod;
    if (!pod) { m.why = 'the grantee is named by an identifier this reader cannot resolve to a pod'; seats.push(m); continue; }

    // ★ A REVOKED GRANT IS NOT A SEAT. This used to add a grey chip and carry on: the member
    // stayed seated, kept a live watch on their stream, kept rendering messages, and still
    // counted. Revocation stops the fold here. What they already wrote is untouched — it is on
    // their pod and revocation cannot reach it — and the row says exactly that.
    if (m.revoked) {
      m.why = 'this grant was revoked. Their stream is not folded into the channel and they are not counted. '
        + 'What they already wrote is unaffected: it lives on their own pod, and revoking a grant cannot reach it.';
      seats.push(m); continue;
    }

    const found = await client.resolveMemberDoc(pod, args.iriOwner, args.slug, 'acceptance');
    m.acceptIri = found.iri;
    m.acceptNaming = found.naming;
    try {
      if (found.forked) { m.why = "this member's acceptance has " + found.forked.heads.length + ' unresolved heads'; seats.push(m); continue; }
      if (!found.found || !found.head) {
        m.why = found.error
          ? 'their acceptance could not be resolved: ' + found.error
          : 'granted, but no acceptance published on their pod yet';
        m.pending = !found.error;
        seats.push(m); continue;
      }
      const ad = await client.descriptor(found.head.url);
      const region = graphRegion((ad['graph'] as { content?: string } | undefined)?.content ?? '', found.iri);
      if (region === null) { m.why = 'the signed region of their acceptance could not be located, so no seat will be read out of it'; seats.push(m); continue; }
      m.acceptStatus = readModalStatus(region);
      // ★ AND THE MEMBER'S OWN HALF, WHICH ONLY THEY CAN WITHDRAW. Their acceptance is on their
      // pod under their signature; retiring it is how somebody leaves a room without asking the
      // convener's permission, and a fold that ignored it kept folding their log in after they
      // had said they were done. Said as its own reason, never as "their acceptance is malformed".
      if (isRetracted(region)) {
        m.why = 'their acceptance states iep:modalStatus "' + String(m.acceptStatus) + '", so they have withdrawn it '
          + 'on their own pod. The grant naming them still stands; what they retired is their own half of the seat.';
        seats.push(m); continue;
      }
      m.acceptUrl = found.head.url;
      // The pod the acceptance was actually SERVED from, and its base URL. Everything
      // downstream that needs to address this member's storage uses these rather than a name
      // composed from the viewer's own host.
      m.podServed = podOfDescriptorUrl(found.head.url);
      m.podBase = podBaseOfDescriptorUrl(found.head.url);
      m.stream = readIri(region, 'wsp:stream');
      // Same region, same read as everything else the acceptance asserts about itself.
      m.encryptionKey = readLiteral(region, 'wsp:encryptionKey');
      m.accepts = readIri(region, 'wsp:accepts');
      m.acceptsCid = readLiteral(region, 'wsp:acceptsCid');
      const auth = ad['authorship'] as { signedBy?: string; authorshipVerified?: boolean } | undefined;
      m.memberAgent = auth?.signedBy ?? null;
      m.memberAgentVerified = !!auth?.authorshipVerified;
      m.acceptAuthorship = ad['authorship'] ?? null;

      // ★ WHICH GRANT THIS ACCEPTANCE IS AN ACCEPTANCE OF. Two forms, both accepted, and which
      // test ran is recorded.
      //  · The older one names the grant's DESCRIPTOR URL. Equality with the current head's
      //    descriptor is the whole check: republish the grant and a stale acceptance stops
      //    matching.
      //  · The newer one names the grant's own /ns/ IRI — a URL anybody can open — and pins the
      //    revision separately in wsp:acceptsCid. An IRI match with NO cid is NOT accepted as a
      //    seat: the IRI alone never changes, so it could not detect a re-grant.
      if (m.accepts && m.accepts === m.grantUrl) {
        m.acceptTest = "the acceptance names the grant's descriptor URL, and it is the one currently at the head";
      } else if (m.accepts && m.accepts === m.graph && m.acceptsCid && m.grantCid && m.acceptsCid === m.grantCid) {
        // ★ THE TWO REVISIONS ARE NAMED, not just compared. A reader deciding whether to
        // believe a seat needs the pair in front of them; "the revision that is the head" is
        // this fold asserting its own conclusion and showing none of the evidence for it.
        m.acceptTest = "the acceptance names the grant's IRI and pins revision " + shortRef(m.acceptsCid) + ', which is the head';
      } else if (m.accepts && m.accepts === m.graph && m.acceptsCid && m.grantCid) {
        m.why = 'their acceptance names this grant but pins revision ' + shortRef(m.acceptsCid)
          + ', and the current head of the grant is ' + shortRef(m.grantCid)
          + '. The grant was republished after they accepted it, so what they agreed to is not what is there now.';
        seats.push(m); continue;
      } else if (m.accepts && m.accepts === m.graph) {
        m.why = "their acceptance names this grant's IRI and pins no revision this reader could compare"
          + (m.grantCid ? '' : ', and the head read reported no CID for the grant either')
          + ', so it cannot be told apart from an acceptance of a grant that has since been rewritten';
        seats.push(m); continue;
      } else {
        m.why = m.accepts
          ? 'their acceptance names a different grant than the one current here'
          : 'their acceptance names no wsp:accepts, so there is nothing to hold against the grant';
        seats.push(m); continue;
      }
      if (!m.stream) { m.why = 'their acceptance names no stream'; seats.push(m); continue; }

      // ★ A LOG BELONGS TO THE POD THAT OWNS IT. `wsp:stream` is a value in a document the
      // MEMBER wrote, so it is checked rather than believed.
      m.streamPod = podOfNsIri(m.stream);
      if (m.streamPod && m.streamPod !== pod) {
        m.why = 'their acceptance names a stream under pod ' + m.streamPod + ', which is not the pod their own grant '
          + 'names (' + pod + "). A member's log is on their own pod, so no log they point at somebody else's storage for is folded in.";
        seats.push(m); continue;
      }
      m.seated = true;
    } catch (e) {
      m.why = 'the acceptance could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
    }
    seats.push(m);
  }

  // Two seats resolving to the same log are ONE log. Folding it twice would double every
  // message in it and count the same author twice.
  const seenLog = new Map<string, Seat>();
  for (const m of seats) {
    if (!m.seated) continue;
    const k = m.pod + ' ' + String(m.stream);
    if (!seenLog.has(k)) { seenLog.set(k, m); continue; }
    m.seated = false;
    m.why = 'another current grant on this roster already seats pod ' + m.pod + ' with the same wsp:stream, so this '
      + 'grant would fold the same log into the channel a second time. The log itself is shown once, under the first '
      + 'of the two; this row is not a claim that they wrote nothing.';
  }

  return {
    seats,
    grantPod,
    grantPodDerivedFrom: args.convenerPod ? 'wsp:convener in the record' : null,
    grantsFound,
    grantsRead: toRead.length,
    grantReadCap,
  };
}
