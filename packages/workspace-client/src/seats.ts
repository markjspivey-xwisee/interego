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

import { graphRegion, hasTrue, readIri, readLiteral } from './turtle.js';
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
  acceptIri?: string;
  acceptNaming?: string;
  acceptUrl?: string;
  acceptTest?: string;
  accepts?: string | null;
  acceptsCid?: string | null;
  stream?: string | null;
  streamPod?: string | null;
  podServed?: string | null;
  podBase?: string | null;
  memberAgent?: string | null;
  memberAgentVerified?: boolean;
  grantAuthorship?: unknown;
  acceptAuthorship?: unknown;
}

/** What the fold found, plus every cap it hit — a capped scan that came back full may have cut members off. */
export interface RosterFold {
  readonly seats: readonly Seat[];
  readonly grantPod: string;
  /** Non-null when the grant pod came from `wsp:convener` rather than the workspace IRI. */
  readonly grantPodDerivedFrom: string | null;
  readonly grantScanSaturated: boolean;
  readonly grantLimit: number;
  readonly grantsFound: number;
  readonly grantsRead: number;
  readonly grantReadCap: number;
}

/** How many entries the convener's pod is scanned for. */
export const GRANT_LIMIT = 400;
/**
 * How many of the grants that scan FINDS are then read.
 *
 * Each read is two round trips (head + descriptor) against a possibly cold pod, so an
 * unbounded fold on a large workspace is a client that appears to hang. A workspace with more
 * members than this is read down to the cap and the caller is told how many were found.
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
  },
): Promise<RosterFold> {
  // ★ WHICH POD HOLDS THE GRANTS — see `grantPodFor`. Using the pod segment inside the
  // workspace IRI and throwing the convener away meant a record naming a convener elsewhere
  // was read from the wrong pod and reported an empty roster.
  const grantPod = grantPodFor(args.convenerPod, args.iriOwner);

  const p = await client.tool('discover_context', { pod_name: grantPod, limit: GRANT_LIMIT, sort: 'newest-first' }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  const rows = (p?.['entries'] as readonly Record<string, unknown>[]) ?? [];
  // A capped scan that came back full may have cut grants off the end. Silent truncation would
  // drop a member from the roster and their messages from the channel with nothing said.
  const grantScanSaturated = rows.length >= GRANT_LIMIT;

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
  const toRead = grantRows.slice(0, GRANT_READ_CAP);

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
      m.acceptUrl = found.head.url;
      // The pod the acceptance was actually SERVED from, and its base URL. Everything
      // downstream that needs to address this member's storage uses these rather than a name
      // composed from the viewer's own host.
      m.podServed = podOfDescriptorUrl(found.head.url);
      m.podBase = podBaseOfDescriptorUrl(found.head.url);
      m.stream = readIri(region, 'wsp:stream');
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
    grantScanSaturated,
    grantLimit: GRANT_LIMIT,
    grantsFound,
    grantsRead: toRead.length,
    grantReadCap: GRANT_READ_CAP,
  };
}
