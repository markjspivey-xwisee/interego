/**
 * A seated member that is a process: read the channel, then write one entry to its own log.
 *
 * ── WHAT THIS IS AND WHAT IT REFUSES TO BE ───────────────────────────────────
 *
 * The temptation this file exists to refuse is a responder whose CALLER supplies the reply.
 * That is trivial to build, it looks identical in a chat window, and it is a lie: the
 * author would be whoever made the request, and the agent would be a signing service with
 * a name on it. So the only input this takes is WHICH WORKSPACE. Everything the reply says
 * is read here, from the members' own pods, through the agent's own credentials, and every
 * descriptor it read is cited by URL on the entry it writes — so the derivation is not a
 * claim in prose, it is a set of links a reader can follow and check.
 *
 * ★ THE REPLY IS DERIVED, NOT GENERATED. There is no model in this path and no prompt. The
 * agent reports what it found and what it could not read, quotes the message it is
 * answering, and answers the questions it can answer FROM THE CHANNEL. A sentence a model
 * produced would read better and would be unverifiable — the grounding could only ever be
 * asserted, and this vertical's whole discipline is that a field nobody read is reported as
 * not read rather than turned into a statement about the world.
 *
 * ★ THE ROLE IS A CEILING AND IT IS ENFORCED HERE, BEFORE THE WRITE. `foldRoster` computes
 * `role.permits ∩ delegatedScope` and this refuses when appending is not in it. That
 * refusal is not decoration: it is the property the substrate CANNOT enforce, because the
 * agent's pod is the agent's pod and nothing can stop it writing there. So an unauthorised
 * entry is not prevented, it is INERT — and the honest thing for a well-behaved member is
 * to decline to write it at all, and to say why.
 */

import { digestedGraphRegion } from '@interego/solid';
import {
  appendEntry, readStream, verifyChain, attestationOfResponse, readDeclaredSeq, WSP_SHAPES,
  type StreamDeps, type StreamRow,
} from './stream.js';
import {
  dereferenceWorkspaceRecord, dereferenceRoleProfile,
  readGrantRecord, readAcceptanceRecord, membershipRowsOf,
} from './membership.js';
import {
  foldRoster, may, explain,
  type Acceptance, type Grant, type Roster, type RoleProfile,
} from './roster.js';
// ★ THE READ CAP COMES FROM THE SHARED CLIENT rather than being spelled again here. The number
// that used to sit in this file was a SCAN cap (`?? 400`) and it disagreed with the one in
// `seats.ts` about what it even bounded. One definition of "how many grants will I dereference"
// is the point; `advertise.ts` already takes this package's dependency on the same module.
import { GRANT_READ_CAP } from '@interego/workspace-client';
import { CAPS, capabilitiesForScope } from './can.js';
import type { AgentSession } from './agent-session.js';

/**
 * The capability a role must permit before this agent will write anything.
 *
 * ★ IT IS THE DEFAULT PROFILE'S CAPABILITY IRI, and that is a real limit rather than a
 * convention. Capabilities are named by the role profile a workspace DECLARES, so a
 * workspace publishing its own governance names its own — and this check would then be
 * asking about a capability that profile never mentions, which `may` answers `false` to.
 * Refusing to write is the right failure for that case, and it is the one this reports:
 * `explain` names the role and the capability, so an operator sees the mismatch rather than
 * a silent refusal. `CAPS` lives in `can.ts` and is shared, so there is one spelling.
 */
export const APPEND: string = CAPS.append;

const PROV_USED = 'http://www.w3.org/ns/prov#used';
const PROV_DERIVED = 'http://www.w3.org/ns/prov#wasDerivedFrom';

/** One entry as this responder read it, with everything it needs to quote and cite. */
export interface ReadEntry {
  readonly descriptorUrl: string;
  readonly cid: string | null;
  readonly seq: number | null;
  readonly body: string | null;
  /** The pod the record was SERVED from, not a name composed from a member list. */
  readonly pod: string;
  readonly principal: string;
  readonly signedBy: string | null;
  readonly authorshipVerified: boolean;
}

/** One member's log, or the reason it is not here. */
export interface ReadLog {
  readonly principal: string;
  readonly stream: string;
  readonly role: string;
  readonly entries: readonly ReadEntry[];
  /** Non-null when the log could not be read or does not verify. Never silently empty. */
  readonly unreadable: string | null;
}

export type RespondOutcome =
  | {
      readonly outcome: 'appended';
      readonly entry: { readonly descriptorUrl: string; readonly cid: string | null; readonly seq: number };
      readonly body: string;
      readonly answering: ReadEntry | null;
      readonly read: RespondReading;
    }
  | {
      readonly outcome: 'already-answered';
      readonly answering: ReadEntry;
      readonly read: RespondReading;
      readonly message: string;
    }
  | {
      readonly outcome: 'nothing-to-answer';
      readonly read: RespondReading;
      readonly message: string;
    }
  | {
      /**
       * ★ EVERY REFUSAL BELOW ANSWERED HTTP 200.
       *
       * `wsp.respond_as_member` spreads this straight into its answer, and the shared
       * dispatcher derives status from `kind` — which this union did not carry. So `not-seated`
       * (the agent is not a member) and `ceiling` (its role forbids the write) told the caller
       * the call SUCCEEDED. A repo-wide source census had cleared this file: its key matched
       * both `outcome: 'refused'` and `reason`, but its phrase list knew nothing of
       * "not-seated". Found by POSTing to the bridge.
       *
       * `outcome` and `reason` are unchanged — callers branch on them. The three added fields
       * are what the dispatcher reads, and they are optional so the union stays assignable
       * where a refusal is constructed without them.
       */
      readonly outcome: 'refused';
      readonly reason: 'not-seated' | 'ceiling' | 'unreadable-workspace' | 'append-failed';
      readonly message: string;
      readonly read: RespondReading | null;
      readonly kind?: 'refusal';
      readonly 'iep:refusalStatus'?: number;
      readonly 'iep:refusalReason'?: string;
    };

/** Everything the agent actually read, returned so a caller can check the derivation. */
export interface RespondReading {
  readonly workspace: string;
  readonly convener: string | null;
  readonly roleProfile: string | null;
  readonly agentPrincipal: string;
  readonly agentPod: string;
  readonly agentRole: string | null;
  /** `role.permits ∩ delegatedScope` — what the roster says this agent may actually do. */
  readonly agentEffective: readonly string[];
  readonly agentWithheldByDelegation: readonly string[];
  readonly logs: readonly ReadLog[];
  /** Every descriptor URL this run dereferenced to compose its answer. Cited on the entry. */
  readonly consulted: readonly string[];
}

const trunc = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The pod segment of a `<relay>/ns/<pod>/<slug>` IRI, or null. */
function podOfNsIri(iri: string | null | undefined): string | null {
  if (!iri) return null;
  const m = /\/ns\/([^/]+)\//.exec(iri);
  return m ? (m[1] ?? null) : null;
}

/** The pod segment of a descriptor URL served by a CSS pod. */
function podOfDescriptorUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * The storage base a record was ACTUALLY SERVED FROM — `<origin>/<pod>/`.
 *
 * ★ NOT `<relay>/ns/<pod>/`, AND THE TWO ARE NOT INTERCHANGEABLE. A workspace IRI's
 * `/ns/<owner>/` segment is a logical name under the relay's naming authority; a pod URL
 * addresses storage. Measured live, feeding the `/ns/` form to `discover_context` alongside
 * a `pod_name` earned a flat refusal — "Those are different pods and this call can only be
 * about one of them" — which arrived as `unreadable` on EVERY member's log at once, i.e. as
 * a channel that looked empty. `get_pod_status` was quieter and worse: it answered, with no
 * delegation registry, so every member's effective capability computed to nothing and the
 * agent refused its own write citing a ceiling that was really a wrong URL.
 *
 * So the base is taken from the URL the member's own acceptance came back on, which is the
 * pod that served it. It is derived, never composed from the viewer's host with a pod
 * segment glued on — that composition assumes every member's storage lives on one server,
 * which is the assumption this whole vertical exists to break.
 */
function podBaseOfDescriptorUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const pod = u.pathname.split('/').filter(Boolean)[0];
    return pod === undefined ? null : `${u.origin}/${pod}/`;
  } catch {
    return null;
  }
}

/**
 * The grants this workspace's convener has published, by descriptor URL.
 *
 * ★ READ FROM THE CONVENER'S POD, NOT FROM THE WORKSPACE IRI'S OWNER SEGMENT. The record
 * NAMES a convener; that name resolved to a pod is where grants live. Using the IRI's own
 * owner segment throws the named convener away and reads a different pod in the one case
 * where the two disagree — which is exactly the case worth getting right.
 */
async function grantHeads(args: {
  readonly workspace: string;
  readonly convenerPod: string;
  readonly deps: StreamDeps;
  /** How many of the grants found may be READ. The scan itself is not capped — see below. */
  readonly readCap: number;
}): Promise<{ readonly heads: readonly string[]; readonly found: number; readonly why: string | null }> {
  let res: Record<string, unknown>;
  try {
    // ★ NO `limit`, FOR THE REASON `foldRoster` RECORDS: the relay's own default is unbounded, it
    // caches the whole manifest either way, and it slices LAST — so a cap truncated the answer and
    // bought nothing. What replaces it is a READ cap below, which bounds the thing that is
    // genuinely expensive. This responder had NO read bound at all: it walked every grant head it
    // found, then a head and a descriptor per member, then every seated member's whole log,
    // sequentially. Uncapping the enumeration without capping the reads would have turned "grants
    // in the 400-window" into "every grant that ever existed on this pod", unbounded.
    res = await args.deps.discover({ pod_name: args.convenerPod, sort: 'newest-first' });
  } catch (e) {
    return { heads: [], found: 0, why: `discover_context on '${args.convenerPod}' threw: ${(e as Error).message}` };
  }
  if (res['error'] !== undefined) {
    return { heads: [], found: 0, why: `discover_context on '${args.convenerPod}': ${String(res['message'] ?? res['error'])}` };
  }
  const rows = Array.isArray(res['entries']) ? res['entries'] as Array<Record<string, unknown>> : [];
  const prefix = `${args.workspace}-grant-`;
  const seen = new Set<string>();
  const heads: string[] = [];
  for (const e of rows) {
    const describes = Array.isArray(e['describes']) ? e['describes'] as string[] : [];
    const g = describes.find(x => x.startsWith(prefix));
    const url = typeof e['descriptorUrl'] === 'string' ? e['descriptorUrl'] : null;
    if (g === undefined || url === null || seen.has(g)) continue;
    seen.add(g);
    heads.push(url);
  }
  // The enumeration is complete; the READ is what is bounded, and both numbers are reported so
  // the responder states its own work bound instead of inheriting one from a truncated index.
  return { heads: heads.slice(0, args.readCap), found: heads.length, why: null };
}

export interface RespondOptions {
  readonly workspace: string;
  /**
   * The slug the member IRIs are composed from — `<slug>-acceptance`, `<slug>-stream`.
   * Derived from the workspace IRI's last segment when omitted, which is the convention
   * every record in this vertical follows; passed explicitly it is the caller's choice and
   * is reported as such.
   */
  readonly slug?: string;
  /**
   * How many of the grants found may be READ. Defaults to `GRANT_READ_CAP`.
   *
   * ★ THIS REPLACED A SCAN CAP, AND THE TWO ARE NOT THE SAME KNOB. The old `grantLimit` bounded
   * how much of the convener pod's index came back, which hid members. This bounds how much work
   * this responder does per run, which is the thing that was actually unbounded here.
   */
  readonly grantReadCap?: number;
}

/**
 * Read the channel and, if there is something to answer and the role permits it, answer.
 *
 * The whole of the trigger contract: the caller says WHICH workspace, and nothing else.
 */
export async function respondAsMember(
  session: AgentSession,
  opts: RespondOptions,
): Promise<RespondOutcome> {
  const deps = session.deps;
  const workspace = opts.workspace;
  const slug = opts.slug ?? workspace.split('/').pop() ?? '';
  const consulted: string[] = [];

  // ── 1. the workspace record, dereferenced (never handed to us) ─────────────
  const evidence = await dereferenceWorkspaceRecord(workspace, deps);
  if (evidence.kind === 'unreadable') {
    return { outcome: 'refused' as const, reason: 'unreadable-workspace' as const, kind: 'refusal' as const, 'iep:refusalStatus': 502, 'iep:refusalReason': 'the workspace record could not be read, so membership could not be established; nothing about the caller failed', message: evidence.why, read: null };
  }
  const record = evidence.record;
  consulted.push(record.head);
  const convenerPod = podOfNsIri(record.convener)
    ?? /\/users\/([^/]+)\//.exec(record.convener)?.[1]
    ?? null;
  if (convenerPod === null) {
    return {
      outcome: 'refused' as const, reason: 'unreadable-workspace' as const, kind: 'refusal' as const, 'iep:refusalStatus': 502, 'iep:refusalReason': 'the workspace record could not be read, so membership could not be established; nothing about the caller failed', read: null,
      message: `the record names convener <${record.convener}>, which this reader cannot resolve to a pod, `
        + 'so it does not know where the grants that would seat anybody live',
    };
  }

  // ── 2. the role table, dereferenced from the IRI the record declares ───────
  const roleEvidence = await dereferenceRoleProfile(record.roleProfile, deps);
  if (roleEvidence.kind === 'unreadable') {
    return {
      outcome: 'refused' as const, reason: 'unreadable-workspace' as const, kind: 'refusal' as const, 'iep:refusalStatus': 502, 'iep:refusalReason': 'the workspace record could not be read, so membership could not be established; nothing about the caller failed', read: null,
      message: `the workspace declares role profile <${record.roleProfile}> and it could not be read, `
        + `so no ceiling can be computed and this agent will not write: ${roleEvidence.why}`,
    };
  }
  const profile: RoleProfile = { profile: record.roleProfile, roles: roleEvidence.document.roles };
  consulted.push(roleEvidence.document.head);

  // ── 3. both halves of every membership ─────────────────────────────────────
  const readCap = opts.grantReadCap ?? GRANT_READ_CAP;
  const scan = await grantHeads({ workspace, convenerPod, deps, readCap });
  if (scan.why !== null) {
    return { outcome: 'refused' as const, reason: 'unreadable-workspace' as const, kind: 'refusal' as const, 'iep:refusalStatus': 502, 'iep:refusalReason': 'the workspace record could not be read, so membership could not be established; nothing about the caller failed', message: scan.why, read: null };
  }
  const grants: Grant[] = [];
  const acceptances: Acceptance[] = [];
  /** principal → the storage base their own acceptance was served from. See podBaseOfDescriptorUrl. */
  const servedFrom = new Map<string, string>();
  const relayBase = workspace.slice(0, workspace.indexOf('/ns/'));

  for (const head of scan.heads) {
    consulted.push(head);
    const read = await readGrantRecord(head, deps);
    const rows = membershipRowsOf(read);
    grants.push(...rows);
    const g = read.record;
    if (g === null) continue;
    const memberPod = podOfNsIri(g.grantedTo) ?? /\/users\/([^/]+)\//.exec(g.grantedTo)?.[1] ?? null;
    if (memberPod === null) continue;
    // The member's own half, on the member's own pod. The IRI is COMPOSED from the naming
    // convention — the grant does not enumerate acceptances — and that is stated rather
    // than presented as something the record said.
    const acceptanceIri = `${relayBase}/ns/${memberPod}/${slug}-acceptance`;
    let ah: Record<string, unknown>;
    try {
      ah = await deps.currentHead!({ urn: acceptanceIri, pod_name: memberPod });
    } catch {
      continue;
    }
    // ★ THE URL IS NESTED UNDER `head`, and reading it off the top level is not a
    // near-miss — it is `undefined`, which this loop treats as "no acceptance", which
    // `foldRoster` reads as an unanswered invitation. Measured live: every membership
    // present and correct on both pods, and the responder reported ITSELF as not seated
    // with `logs: []`. A wrong field name here does not fail, it un-seats everybody.
    // `dereferenceWorkspaceRecord` reads the same shape the same way, three files over.
    const acceptanceHead = ah['head'] as { descriptorUrl?: unknown } | undefined | null;
    const url = typeof acceptanceHead?.descriptorUrl === 'string' ? acceptanceHead.descriptorUrl : null;
    if (ah['error'] !== undefined || ah['forked'] === true || url === null) continue;
    consulted.push(url);
    const aRead = await readAcceptanceRecord(url, deps);
    acceptances.push(...membershipRowsOf(aRead));
    const base = podBaseOfDescriptorUrl(url);
    if (aRead.record !== null && base !== null) servedFrom.set(aRead.record.member, base);
  }

  // ── 4. the delegation each member's own pod grants — the other half of the ceiling ──
  const scopes = await delegatedScopes({ servedFrom, session });

  const roster: Roster = foldRoster({ workspace, profile, grants, acceptances, scopes });
  const me = session.identity.webId;
  const seat = roster.members.find(m => m.principal === me) ?? null;

  // ── 5. read every seated member's log ──────────────────────────────────────
  const logs: ReadLog[] = [];
  for (const m of roster.members) {
    const pod = podOfNsIri(m.stream);
    if (pod === null) {
      logs.push({
        principal: m.principal, stream: m.stream, role: m.role, entries: [],
        unreadable: `their acceptance names stream <${m.stream}>, which is not a <relay>/ns/<pod>/<slug> IRI`,
      });
      continue;
    }
    const base = servedFrom.get(m.principal) ?? null;
    if (base === null) {
      logs.push({
        principal: m.principal, stream: m.stream, role: m.role, entries: [],
        unreadable: 'nothing was fetched from their pod during this run, so this reader has no '
          + 'storage URL for it. Composing one from this agent\'s own host would be addressing a '
          + 'pod that may not exist, which reads back as an empty log rather than as an error',
      });
      continue;
    }
    let rows: readonly StreamRow[];
    try {
      rows = await readStream({ graphIri: m.stream, workspace, podUrl: base }, deps);
    } catch (e) {
      logs.push({
        principal: m.principal, stream: m.stream, role: m.role, entries: [],
        unreadable: `their log could not be read: ${(e as Error).message}`,
      });
      continue;
    }
    const chain = verifyChain(rows);
    // ★ AN EMPTY LOG IS NOT A BROKEN ONE. `verifyChain([])` reports `intact: false` with
    // zero heads, zero merges and zero dangling links — a shape that is perfectly
    // consistent and says nothing is wrong. Reading it as a divergence made a member who
    // had simply not written yet render as one whose log was WITHHELD FOR TAMPERING, which
    // is a serious accusation to make about an absence. `headOf` already answers `'head'`
    // for the empty case; this is the same rule, one caller over.
    if (rows.length === 0) {
      logs.push({ principal: m.principal, stream: m.stream, role: m.role, entries: [], unreadable: null });
      continue;
    }
    if (!chain.intact) {
      // The same rule `appendEntry` applies to its own stream: a log that does not verify is
      // WITHHELD rather than folded in, and the reason is reported.
      logs.push({
        principal: m.principal, stream: m.stream, role: m.role, entries: [],
        unreadable: `their log does not verify — ${chain.heads.length} head(s), ${chain.merges.length} merge(s), `
          + `${chain.danglingLinks.length} dangling link(s) — so it is withheld rather than folded in`,
      });
      continue;
    }
    const entries: ReadEntry[] = [];
    for (const row of chain.ordered) {
      consulted.push(row.descriptorUrl);
      entries.push(await readOneEntry(row, m.principal, deps));
    }
    logs.push({ principal: m.principal, stream: m.stream, role: m.role, entries, unreadable: null });
  }

  const reading: RespondReading = {
    workspace,
    convener: record.convener,
    roleProfile: record.roleProfile,
    agentPrincipal: me,
    agentPod: session.identity.podName,
    agentRole: seat?.role ?? null,
    agentEffective: seat?.effective ?? [],
    agentWithheldByDelegation: seat?.withheldByDelegation ?? [],
    logs,
    consulted: [...new Set(consulted)],
  };

  // ── 6. am I seated, and does my role permit writing? ───────────────────────
  if (seat === null) {
    return {
      outcome: 'refused' as const, reason: 'not-seated' as const, kind: 'refusal' as const, 'iep:refusalStatus': 403, 'iep:refusalReason': 'the caller is authenticated but holds no seat in this workspace', read: reading,
      message: `this agent (${me}) is not seated in <${workspace}>. Both halves are required: a `
        + `wsp:MembershipGrant on the convener's pod '${convenerPod}' naming it, and a `
        + `wsp:MembershipAcceptance on its own pod '${session.identity.podName}' naming that grant. `
        + 'It will not write into a channel it has not been admitted to.',
    };
  }
  if (!may(roster, me, APPEND)) {
    return {
      outcome: 'refused' as const, reason: 'ceiling' as const, kind: 'refusal' as const, 'iep:refusalStatus': 403, 'iep:refusalReason': 'the caller holds a seat whose role ceiling does not permit this write', read: reading,
      message: `the role ceiling refuses this write. ${explain(roster, me, APPEND)} `
        + 'Nothing could stop this agent writing to its own pod — it is its own pod — so this is a '
        + 'refusal it imposes on itself. An entry written anyway would exist and be inert: the fold '
        + 'would not count it, and would say why.',
    };
  }

  // ── 7. what am I answering? ────────────────────────────────────────────────
  const mine = logs.find(l => l.principal === me) ?? null;
  const answeredAlready = new Set<string>();
  for (const e of mine?.entries ?? []) {
    for (const url of derivedFrom(e.body)) answeredAlready.add(url);
  }
  const others = logs
    .filter(l => l.principal !== me)
    .flatMap(l => l.entries)
    .filter(e => e.body !== null && e.body.trim() !== '');
  const newest = others.length > 0 ? others[others.length - 1]! : null;

  if (newest === null) {
    return {
      outcome: 'nothing-to-answer', read: reading,
      message: 'every log this agent could read is empty of message bodies, so there is nothing to answer. '
        + 'It has not written an entry, because an entry saying nothing is still a permanent record.',
    };
  }
  if (answeredAlready.has(newest.descriptorUrl)) {
    return {
      outcome: 'already-answered', answering: newest, read: reading,
      message: `this agent has already answered <${newest.descriptorUrl}> and has not written a second `
        + 'entry about it. Appending again would put two permanent records in its log saying the same thing.',
    };
  }

  // ── 8. derive the reply from what was read, and cite every input ───────────
  const body = deriveReply({ answering: newest, logs, reading, slug });
  const extraTriples = [
    `<${PROV_DERIVED}> <${newest.descriptorUrl}>`,
    ...reading.consulted.slice(0, 40).map(u => `<${PROV_USED}> <${u}>`),
  ];

  const appended = await appendEntry(
    {
      graphIri: `${relayBase}/ns/${session.identity.podName}/${slug}-stream`,
      workspace,
      podUrl: session.identity.podUrl,
      ...(session.identity.agentDid !== null ? { agentDid: session.identity.agentDid } : {}),
    },
    { body, extraTriples, shapes: [] },
    // No `pod_name` override: `readStream` already sends `pod_url` from the ref, and sending
    // both is refused outright — see podBaseOfDescriptorUrl. The ref's podUrl is the one
    // `get_pod_status` reported for this wallet, so the write goes where the substrate says
    // this identity's storage is.
    deps,
  );

  if (appended.outcome !== 'appended') {
    return {
      outcome: 'refused' as const, reason: 'append-failed' as const, kind: 'refusal' as const, 'iep:refusalStatus': 502, "iep:refusalReason": "the entry could not be appended to the pod the caller owns", read: reading,
      message: `the append did not land (${appended.outcome}): ${'message' in appended ? appended.message : ''}`,
    };
  }
  return {
    outcome: 'appended',
    entry: { descriptorUrl: appended.entry.descriptorUrl, cid: appended.entry.cid, seq: appended.entry.seq },
    body,
    answering: newest,
    read: reading,
  };
}

/**
 * One `get_descriptor` per entry, giving the body, the declared position and the substrate's
 * verdict on who signed it — all three off the SAME read, so they cannot be answered from
 * two reads of a pod that changed in between.
 *
 * ★ THE BODY COMES OUT OF THE SIGNED REGION AND NOWHERE ELSE. `digestedGraphRegion` is the
 * digester's own function: text lifted from anywhere else in the served document is text
 * nobody signed, and quoting it as the message would let a forger put words in a member's
 * mouth by parking a `dct:description` in the default graph.
 */
async function readOneEntry(
  row: StreamRow,
  principal: string,
  deps: StreamDeps,
): Promise<ReadEntry> {
  const base = {
    descriptorUrl: row.descriptorUrl,
    cid: row.cid ?? null,
    pod: podOfDescriptorUrl(row.descriptorUrl),
    principal,
  };
  if (deps.getDescriptor === undefined) {
    // A programming error, not a data condition: this responder always supplies it.
    throw new Error('readOneEntry: no `getDescriptor` dependency, so no entry body can be read');
  }
  let res: Record<string, unknown>;
  try {
    res = await deps.getDescriptor({ url: row.descriptorUrl });
  } catch {
    // The row exists; its body does not read. Reporting `body: null` says exactly that, and
    // is not the same claim as an entry that carries no body.
    return { ...base, seq: row.seq ?? null, body: null, signedBy: null, authorshipVerified: false };
  }
  const attestation = attestationOfResponse(res, row.descriptorUrl);
  const graph = res['graph'] as Record<string, unknown> | undefined | null;
  const region = digestedGraphRegion({
    descriptorTurtle: typeof res['turtle'] === 'string' ? res['turtle'] : null,
    graphContent: graph !== null && graph !== undefined && typeof graph['content'] === 'string'
      ? graph['content'] as string
      : null,
  });
  return {
    ...base,
    seq: readDeclaredSeq(res).seq,
    body: region.ok ? descriptionOf(region.turtle) : null,
    signedBy: attestation.signedBy,
    authorshipVerified: attestation.authorshipVerified,
  };
}

/**
 * The `dct:description` literal in a Turtle region.
 *
 * Deliberately small and deliberately strict: it reads the quoted form this vertical's own
 * `entryTurtle` writes, unescapes the four sequences that writer emits, and returns null for
 * anything it does not recognise. A looser reader would quote text it had guessed at.
 */
function descriptionOf(turtle: string): string | null {
  const m = /(?:dct:description|<http:\/\/purl\.org\/dc\/terms\/description>)\s+"((?:[^"\\]|\\.)*)"/.exec(turtle);
  if (m === null) return null;
  return m[1]!.replace(/\\(.)/g, (_, c: string) =>
    ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c] ?? c));
}

/**
 * Which descriptor URLs a previous reply of ours said it answered.
 *
 * Read out of the body rather than out of the RDF because the body is what `readStream`
 * already has in hand; the authoritative `prov:wasDerivedFrom` triple is on the record too,
 * and a reader wanting the stronger answer should follow that. Stated rather than glossed:
 * this is the cheap check, and its only job is to stop the agent answering twice.
 */
function derivedFrom(body: string | null): readonly string[] {
  if (body === null) return [];
  return [...body.matchAll(/<(https?:\/\/[^>\s]+\.ttl)>/g)].map(m => m[1]!);
}

/**
 * Compose the reply out of what was read. No model, no template of pre-written sentences
 * chosen by keyword — every clause below is a fact this run established, and the ones that
 * could not be established are the ones that say so.
 */
function deriveReply(args: {
  readonly answering: ReadEntry;
  readonly logs: readonly ReadLog[];
  readonly reading: RespondReading;
  readonly slug: string;
}): string {
  const { answering, logs, reading } = args;
  const readable = logs.filter(l => l.unreadable === null);
  const withheld = logs.filter(l => l.unreadable !== null);
  const total = readable.reduce((n, l) => n + l.entries.length, 0);
  const parts: string[] = [];

  parts.push(
    `Read the channel at ${new Date().toISOString()}. Answering the newest message I had not `
    + `answered: seq ${answering.seq ?? '(undeclared)'} from pod ${answering.pod}, `
    + `<${answering.descriptorUrl}>`
    + (answering.cid !== null ? ` (cid ${answering.cid})` : '')
    + `, which says: "${trunc(answering.body ?? '', 300)}".`,
  );

  parts.push(
    answering.authorshipVerified
      ? `Its authorship proof verifies and names ${answering.signedBy ?? '(no signer reported)'}, `
        + 'so I am answering a record whose author the substrate re-derived, not a line somebody typed into a list.'
      : 'Its authorship proof did NOT verify here, so I can quote what it says but cannot tell you who wrote it. '
        + 'I am answering it anyway and saying so, because withholding the fact would be worse than the fact.',
  );

  parts.push(
    `What I could see: ${readable.length} log(s) totalling ${total} entr${total === 1 ? 'y' : 'ies'} — `
    + readable.map(l => `${podOfNsIri(l.stream) ?? '?'} (${l.role.split('#').pop() ?? l.role}, ${l.entries.length})`).join(', ')
    + '. Each of those is a separate pod I read one at a time; there is no index across them and no query that '
    + 'spans them.',
  );

  if (withheld.length > 0) {
    parts.push(
      `What I could NOT see, and am not treating as empty: `
      + withheld.map(l => `${podOfNsIri(l.stream) ?? l.stream} — ${l.unreadable ?? ''}`).join('; ')
      + '.',
    );
  }

  // Capabilities are IRIs and the entry reads better for their local names — but the full
  // IRIs are on the record as `prov:used` inputs and in the role table the workspace
  // declares, so nothing is lost by shortening the prose. The role table's IRI is quoted in
  // full precisely once, below, because that is the document that decides all of it.
  const localName = (iri: string): string => iri.split('#').pop() ?? iri;
  parts.push(
    `I am writing this to my own log on pod ${reading.agentPod}, not to yours and not to a shared table. `
    + `My role here is ${localName(reading.agentRole ?? 'unknown')}, defined by <${reading.roleProfile ?? '(no profile named)'}>, `
    + `and what I may actually do is ${reading.agentEffective.length === 0 ? 'nothing' : reading.agentEffective.map(localName).join(', ')}`
    + (reading.agentWithheldByDelegation.length > 0
      ? `; ${reading.agentWithheldByDelegation.map(localName).join(', ')} `
        + `${reading.agentWithheldByDelegation.length === 1 ? 'is' : 'are'} permitted by the role but withheld by my `
        + 'own pod\'s delegation, so I may not'
      : '')
    + '. I cannot grant or revoke anybody\'s membership here, including my own — that is not a setting, it is what '
    + 'the published role table permits intersected with what my pod delegates. '
    + `I dereferenced ${reading.consulted.length} descriptor(s) to say this; they are cited on this entry with `
    + 'prov:used, so you can check every one.',
  );

  return parts.join(' ');
}

/**
 * Each principal's delegation scope, read from THEIR pod's own registry.
 *
 * ★ `get_pod_status` PER POD, not one call generalised. The scope that bounds a member is
 * the one their own pod publishes; reading ours and applying it to them would be inventing
 * an authority record for somebody else. A pod that does not answer contributes NO row —
 * which, because `foldRoster` intersects, is the reading that grants least.
 */
async function delegatedScopes(args: {
  /** principal → the storage base their own acceptance was served from. */
  readonly servedFrom: ReadonlyMap<string, string>;
  readonly session: AgentSession;
}): Promise<Array<{ principal: string; capabilities: readonly string[] }>> {
  const out: Array<{ principal: string; capabilities: readonly string[] }> = [];
  for (const [principal, podUrl] of args.servedFrom) {
    let res: Record<string, unknown>;
    try {
      res = await args.session.call('get_pod_status', { pod_url: podUrl });
    } catch {
      continue;
    }
    const reg = res['delegationRegistry'] as { rows?: Array<{ scope?: string }> } | undefined;
    const scopes = (reg?.rows ?? []).map(r => r.scope).filter((s): s is string => typeof s === 'string');
    if (scopes.length === 0) continue;
    // ★ `capabilitiesForScope` FROM `can.ts`, NOT A SECOND COPY OF THE TABLE. An unrecognised
    // scope yields nothing there, which is the only safe reading of an authorization
    // statement this layer cannot interpret — and a private re-implementation would be a
    // second place that rule could drift, on the side that grants.
    //
    // Several rows for one principal are UNIONED here, exactly as `capabilitiesOfAgent`'s
    // caller does: a pod may delegate to more than one agent, and holding two keys is not
    // holding less authority than holding one. `foldRoster` then intersects across duplicate
    // PRINCIPAL rows, which is the different question and the one that must narrow.
    const caps = new Set<string>();
    for (const s of scopes) for (const c of capabilitiesForScope(s)) caps.add(c);
    out.push({ principal, capabilities: [...caps].sort() });
  }
  return out;
}

export { WSP_SHAPES };
