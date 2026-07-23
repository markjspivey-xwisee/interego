/**
 * foundation-shared-lattice.ts — a PER-AGENT, ACCUMULATING PGSL lattice that
 * artifacts of ANY content type compose INTO (so their terms — IRIs, xAPI verbs,
 * activity types, competency ids — become REUSED content-addressed nodes across
 * the corpus), and from which interop surfaces are PROJECTED. PGSL is the
 * canonical substrate; RDF is just ONE projection over it (alongside W3C VC,
 * ActivityStreams, …). This is the foundation-first composition the existing
 * per-artifact `alsoPersistEncryptedHolon` does NOT do (it builds a fresh
 * throwaway lattice per artifact, so nothing is ever reused or dereferenced).
 *
 * Two altitudes, like the rest of the substrate: the lattice is held in-memory per
 * agent (fast reuse + dereference) AND persisted whole to ONE canonical encrypted
 * pod resource (durable; reloaded on a cold miss). The full artifact is stored
 * LOSSLESSLY as a content atom, so the exact artifact (any type) is read back FROM
 * the lattice — PGSL is canonical. The authoritative hand-authored RDF path is left
 * untouched: this layer is ADDITIVE + reversible until the projection is verified.
 *
 * Composes substrate primitives only (see [[feedback_compose_dont_reinvent]]).
 */
import {
  createPGSL, ingest, resolve, ancestorFragments, projectHolon,
  projectHolonToCredential, projectHolonToActivity,
  promoteInstanceEncryptedCAS, resolveLatticeFromPodDetailed, latticeStats,
  type PGSLInstance, type Node as PgslNode,
} from '@interego/pgsl';
import type { IRI, FetchFn } from '@interego/core';
import { mintNodeId } from '@interego/core';
import { resolveAgentEncryptionKey } from '@interego/solid';
import { bridgeEncryptionKeypair } from './foundation-holon-altitude.js';
import { assertSafeFetchTarget, guardedFetchFn } from './ssrf-guard.js';

interface AgentLattice { pgsl: PGSLInstance; podUrl: string; agentDid: string; resourceUrl: string }
const resident = new Map<string, AgentLattice>();   // label -> in-memory shared lattice
/**
 * Labels whose pod copy EXISTS but this process could not read it (a 5xx, a network
 * blip, a decrypt failure, no key). Such a label is FENCED: it serves reads from
 * whatever is in memory, but casPersist REFUSES to write it, because the in-memory
 * instance is not known to be a superset of what is on the pod.
 *
 * PR #64 introduced this because the failure was silent and DESTRUCTIVE: getLattice
 * used to latch a permanent load flag BEFORE awaiting the read and swallow the error,
 * so one blip left an empty lattice resident for the whole process lifetime, and the
 * next compose PUT that empty node map over the real corpus with no precondition —
 * silently destroying courses that exist in no file in this repo. Now the write is a
 * compare-and-swap (so it can't clobber) AND the fence stays as defense-in-depth, AND
 * a fenced label is retried with backoff instead of latched forever.
 */
const unreadable = new Set<string>();
const creating = new Map<string, Promise<PGSLInstance>>();   // per-label creation mutex

/**
 * Labels whose lattice may be dereferenced NODE BY NODE, without auth and without
 * being told the label. FAIL-CLOSED: a label is private until explicitly marked.
 *
 * Only content that is ALREADY published qualifies — the code-derived ontologies
 * served at /ns/*. An agent's own lattice holds authored courses, learner records
 * and credentials, and must never be node-addressable: a label-free lookup over
 * every resident lattice would be a cross-tenant existence oracle, which is exactly
 * what pgsl-store's addressing was designed to close.
 */
const publicLabels = new Set<string>();
/** Mark a label's lattice as public — see publicLabels. Only for code-derived,
 *  already-published content; never for an agent's own corpus. */
export function markLatticePublic(label: string): void { publicLabels.add(label); }
export function publicLatticeLabels(): string[] { return [...publicLabels]; }
/** True only for a label explicitly marked public (ns-foxxi, spec-ontology,
 *  public-memories). The unauthenticated /agent/lattice/:label{,/term,/holon,
 *  /interrogate} dereference routes MUST gate on this — a per-agent record
 *  lattice (record-performance / scorm-author / issue-credential, holding xAPI
 *  statements + learner PII) is never public and must not be served or
 *  self-rehydrated to an anonymous caller. */
export function isLabelPublic(label: string): boolean { return publicLabels.has(label); }

/**
 * Resolve a PGSL node by its content hash WITHOUT being told which lattice holds it.
 *
 * This is the lookup an id-as-url needs and the substrate has never had. A node id
 * (urn:pgsl:atom:<hash>) is a perfect DENOTATION — content-addressed, deterministic,
 * identical everywhere — but it resolves no CONNOTATION: today you must already know
 * the pod AND the label and pass the urn as a query param, i.e. supply out of band
 * exactly the knowledge the identifier should have carried. That is the gap that
 * makes the id a word rather than a term.
 *
 * PUBLIC lattices only, and a private node is reported IDENTICALLY to an absent one
 * (both null -> 404), so this cannot answer "does this content exist somewhere".
 */
export function resolvePublicNode(kind: 'atom' | 'fragment', hash: string): { label: string; node: PgslNode; pgsl: PGSLInstance; uri: IRI } | null {
  if (!/^[0-9a-f]{6,64}$/i.test(hash)) return null;
  // Dual-read: nodes minted after the URL-scheme swap are keyed under the current
  // authority; a corpus persisted before it still holds the legacy urn. Try both.
  const candidates: IRI[] = [mintNodeId(kind, hash) as IRI, `urn:pgsl:${kind}:${hash}` as IRI];
  for (const label of publicLabels) {
    const a = resident.get(label);
    if (!a) continue;
    for (const uri of candidates) {
      const node = a.pgsl.nodes.get(uri);
      if (node) return { label, node, pgsl: a.pgsl, uri };
    }
  }
  return null;
}


/**
 * Optimistic-concurrency state, keyed by POD RESOURCE — never by label.
 *
 * The write target latticeResourceUrl(podUrl) is per-POD, and multiple labels can
 * share it. So the etag, the write serialization, and the load-retry clock are all
 * per-RESOURCE: a per-label etag would ping-pong forever between labels sharing a
 * pod, because each write bumps the resource etag and invalidates the other's.
 */
interface PodState {
  etag?: string;         // the resource's entity tag, for the next If-Match write
  absent?: boolean;      // we last saw a 404 → create with If-None-Match: *
  nextRetryAt?: number;  // a failed load is retried only after this (backoff)
  retryStep?: number;
}
const podState = new Map<string, PodState>();              // resourceUrl -> state
const podWriteTail = new Map<string, Promise<unknown>>();  // resourceUrl -> serialized write chain

const RETRY_BASE_MS = Number(process.env.FOXXI_LATTICE_RETRY_BASE_MS ?? 30_000);
const RETRY_MAX_MS = Number(process.env.FOXXI_LATTICE_RETRY_MAX_MS ?? 600_000);
const CAS_MAX_ATTEMPTS = 4;

function podS(url: string): PodState { let s = podState.get(url); if (!s) { s = {}; podState.set(url, s); } return s; }
/** A failed load's retry is due once nextRetryAt passes (or was never set). */
function retryDue(url: string): boolean { const t = podState.get(url)?.nextRetryAt; return t == null || Date.now() >= t; }
/** Exponential backoff + jitter, so a down single-replica CSS sees at most one GET
 *  per window per resource rather than a retry storm. */
function scheduleRetry(url: string): void {
  const s = podS(url);
  const step = (s.retryStep ?? 0) + 1;
  s.retryStep = step;
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (step - 1));
  s.nextRetryAt = Date.now() + backoff + Math.floor(Math.random() * 5000);
}
function clearRetry(url: string): void { const s = podS(url); s.nextRetryAt = undefined; s.retryStep = 0; }
/** Serialize writes to ONE pod resource: read-etag -> If-Match PUT -> update-etag must
 *  not interleave with another writer to the same resource (their etags would tear).
 *  Runs regardless of the prior write's outcome. */
function withPodWriteLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = podWriteTail.get(url) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  podWriteTail.set(url, next.then(() => undefined, () => undefined));
  return next;
}

/** Pod-wins ADDITIVE merge: base = the pod's nodes, then add only our in-memory nodes
 *  whose uri is ABSENT from the pod. Content-addressed, so a shared uri means byte-
 *  identical content; pod-wins keeps the pod's provenance for it. Rebuilds a fresh
 *  instance (re-derives the value indexes + levels) and reseats resident. This is what
 *  makes a 412 non-destructive: our nodes are UNIONED onto the current pod state, never
 *  the pod state replaced by ours. */
function mergeReseat(label: string, ours: PGSLInstance, podNodes: Map<IRI, PgslNode>, agentDid: string): PGSLInstance {
  const merged = new Map<IRI, PgslNode>(podNodes);
  for (const [u, n] of ours.nodes) if (!merged.has(u)) merged.set(u as IRI, n as PgslNode);
  const inst = rebuildInstance(merged, agentDid);
  const cur = resident.get(label);
  if (cur) resident.set(label, { ...cur, pgsl: inst });
  return inst;
}

const provFor = (agentDid: string) => ({ wasAttributedTo: agentDid as IRI, generatedAtTime: new Date().toISOString() });

/** The ONE canonical encrypted resource that holds the agent's whole shared lattice. */
/** The canonical encrypted resource for a pod's lattice. `resourceName` selects WHICH
 *  resource on the pod: the default `shared-lattice` holds the agent's own (private)
 *  corpus, but a caller can route to a SEPARATE resource — e.g. a `public-memories`
 *  commons whose every node is already-published, so its label may be marked public
 *  without turning the private corpus into a node-addressable existence oracle. The
 *  resource is per-(pod,name): distinct names never share a merged node map. */
function latticeResourceUrl(podUrl: string, resourceName = 'shared-lattice'): string {
  const base = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  return `${base}foxxi-lattice/${resourceName}.holon.json`;
}

/** Idempotent LDP container create (CSS doesn't always auto-create the parent of a
 *  PUT). Best-effort — already-exists or a 4xx is tolerated; we only need the
 *  parent to exist so the resource PUT below doesn't 404. */
async function ensureContainer(containerUrl: string, fetchFn: FetchFn): Promise<void> {
  try {
    await fetchFn(containerUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' },
      body: '',
    });
  } catch { /* best-effort */ }
}

/** Rebuild a usable PGSLInstance from a persisted node map — reconstructs the
 *  atom (value->uri) + fragment (items->uri) registries so the lattice can keep
 *  ingesting with dedup. Keys mirror lattice.ts (atom: String(value); fragment:
 *  items.join('|')). */
function rebuildInstance(nodes: Map<IRI, PgslNode>, agentDid: string): PGSLInstance {
  const pgsl = createPGSL(provFor(agentDid));
  for (const [uri, node] of nodes) {
    (pgsl.nodes as Map<IRI, PgslNode>).set(uri, node);
    if (node.kind === 'Atom') (pgsl.atoms as Map<string, IRI>).set(String(node.value), uri);
    else (pgsl.fragments as Map<string, IRI>).set(node.items.join('|'), uri);
  }
  return pgsl;
}

/** Get the agent's resident shared lattice, loading it from the pod once (best-
 *  effort) on a cold miss, else starting fresh.
 *
 *  `ephemeral` skips the pod load entirely — see composeIntoSharedLattice's
 *  `ephemeral` flag. The pod resource is per-POD, not per-label, so loading it
 *  into a second label's instance imports the FIRST label's nodes, and the next
 *  persist writes the union back. Labels that never touch the pod cannot take
 *  part in that. */
async function getLattice(podUrl: string, agentDid: string, label: string, fetchFn: FetchFn, ephemeral = false, resourceName?: string): Promise<PGSLInstance> {
  const existing = resident.get(label);
  // A label is bound to ONE resource for the process lifetime; prefer the bound one so
  // a caller that forgets resourceName on a later read can't re-point the label at the
  // default (private) resource and cross-contaminate a dedicated public commons.
  const resourceUrl = existing?.resourceUrl ?? latticeResourceUrl(podUrl, resourceName);
  // Fast path: resident and not due for a fence-retry. (Was: return the moment a
  // label was resident, which — with the pre-await loadAttempted latch — meant a
  // failed load was NEVER retried for the process lifetime. Now a fenced label whose
  // backoff has elapsed falls through and re-attempts the load.)
  if (existing && !(unreadable.has(label) && retryDue(resourceUrl))) return existing.pgsl;
  // Per-label creation mutex: concurrent callers (e.g. a fire-and-forget completion
  // compose racing an awaited performance compose) MUST share ONE lattice instance,
  // else two cold creations clobber each other in `resident` and lose ingests.
  const inflight = creating.get(label);
  if (inflight) return inflight;
  const p = (async (): Promise<PGSLInstance> => {
    let pgsl: PGSLInstance | undefined = existing?.pgsl;
    const shouldLoad = !ephemeral && (!existing || (unreadable.has(label) && retryDue(resourceUrl)));
    if (shouldLoad) {
      const kp = bridgeEncryptionKeypair();
      if (!kp) {
        // No key: we cannot have read the pod copy, so we must never write over it.
        unreadable.add(label); scheduleRetry(resourceUrl);
      } else {
        // SSRF guard at the shared lattice read-fetch primitive: resourceUrl derives from a
        // caller-influenced podUrl (resolveSubjectPodUrl only did a sync literal check), so
        // DNS-resolve-guard here before the fetch — covers every ensureResident /
        // loadCourseFromLattice / getLattice read path, incl. a public host that resolves
        // to an internal IP. A throw fences the label (unreadable) rather than 500ing.
        await assertSafeFetchTarget(resourceUrl);
        // guardedFetchFn re-guards resourceUrl AND every redirect hop — resolveLatticeFromPodDetailed
        // otherwise reads the (caller-influenced) pod with a raw redirect-following fetch, so a public
        // host could 302 the lattice read to an internal address (round-32, live-confirmed unauth).
        const d = await resolveLatticeFromPodDetailed(resourceUrl, kp, guardedFetchFn(fetchFn) as unknown as typeof fetch);
        if (d.status === 'ok') {
          // Adopt the pod copy if we have no in-memory ingests; if we DO (we composed
          // while fenced), keep ours — the write path's CAS will merge them onto the
          // pod. Either way: record the etag, un-fence, clear the backoff.
          if (!pgsl || pgsl.nodes.size === 0) pgsl = rebuildInstance(d.nodes!, agentDid);
          const s = podS(resourceUrl); s.etag = d.etag; s.absent = false;
          unreadable.delete(label); clearRetry(resourceUrl);
        } else if (d.status === 'absent') {
          // Genuinely nothing here — safe to create. The first write uses If-None-Match:*.
          const s = podS(resourceUrl); s.etag = undefined; s.absent = true;
          unreadable.delete(label); clearRetry(resourceUrl);
        } else {
          // Unreadable: a body exists we could not read. FENCE (serve from memory, do
          // NOT persist) but schedule a retry so recovery doesn't need a redeploy.
          unreadable.add(label); scheduleRetry(resourceUrl);
        }
      }
    }
    if (!pgsl) pgsl = createPGSL(provFor(agentDid));
    resident.set(label, { pgsl, podUrl, agentDid, resourceUrl });
    return pgsl;
  })();
  creating.set(label, p);
  try { return await p; } finally { creating.delete(label); }
}

/**
 * Persist the resident lattice for `label` with optimistic concurrency: serialized
 * per pod resource, CAS with If-Match / If-None-Match, and on a 412 reload + pod-wins
 * merge + retry. The fence stays as defense-in-depth: if a (re)load is UNREADABLE we
 * REFUSE rather than risk overwriting a corpus we never saw (PR #64 closed that
 * silent-destruction path). This replaces the unconditional last-writer-wins PUT.
 */
async function casPersist(a: {
  label: string; resourceUrl: string; agentDid: string; holonUri: IRI;
  recipients: string[]; kp: { publicKey: string }; fetchFn: FetchFn;
}): Promise<{ ok: true; pgsl: PGSLInstance } | { ok: false; error: string }> {
  const kpFull = bridgeEncryptionKeypair();
  if (!kpFull) { unreadable.add(a.label); return { ok: false, error: `no encryption key — cannot read or write "${a.label}"` }; }
  let instance = resident.get(a.label)!.pgsl;   // holds holonUri
  const s = podS(a.resourceUrl);
  const doFetch = a.fetchFn as unknown as typeof fetch;

  // Establish a precondition. If the state is unknown (never loaded), read fresh so a
  // blind create can't clobber an existing corpus.
  if (s.etag === undefined && !s.absent) {
    const d = await resolveLatticeFromPodDetailed(a.resourceUrl, kpFull, doFetch);
    if (d.status === 'unreadable') { unreadable.add(a.label); return { ok: false, error: `refusing to persist "${a.label}": pod copy exists but is unreadable` }; }
    if (d.status === 'absent') { s.absent = true; }
    else { s.etag = d.etag; instance = mergeReseat(a.label, instance, d.nodes!, a.agentDid); }
  }

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const precond = s.etag ? { ifMatch: s.etag } : (s.absent ? { ifNoneMatch: '*' as const } : {});
    const w = await promoteInstanceEncryptedCAS(instance, a.holonUri, a.resourceUrl, a.recipients, kpFull, doFetch, precond);
    if (w.status === 'ok') { s.etag = w.etag; s.absent = false; unreadable.delete(a.label); return { ok: true, pgsl: instance }; }
    if (w.status === 'conflict') {
      // Someone wrote since we loaded. Reload; enforce the fence on every reload.
      const d = await resolveLatticeFromPodDetailed(a.resourceUrl, kpFull, doFetch);
      if (d.status === 'unreadable') { unreadable.add(a.label); return { ok: false, error: `refusing to persist "${a.label}": conflict-reload was unreadable` }; }
      if (d.status === 'absent') { s.absent = true; s.etag = undefined; }   // deleted out from under us — recreate
      else { s.absent = false; s.etag = d.etag; instance = mergeReseat(a.label, instance, d.nodes!, a.agentDid); }
      continue;
    }
    // Transient error (5xx / network): brief backoff, then retry.
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  return { ok: false, error: `persist exhausted ${CAS_MAX_ATTEMPTS} attempts for "${a.label}"` };
}

/** Interop surfaces a holon can be projected to. RDF is just ONE of them. */
export type ProjectionKind = 'rdf' | 'vc' | 'activity';

/**
 * A composition, to any depth: a leaf value, or a node composed of children.
 *
 * Holons all the way down — and, deliberately, all the way FURTHER down later. A
 * corpus can start at triple granularity and a leaf can be decomposed afterwards
 * (a url into its segments, a literal into words or characters) without breaking
 * anything that reads at the level above it: the sub-holon's uri is derived from
 * its content, so refining what sits BENEATH a level leaves that level's identity
 * intact. Granularity is a rung, not a lock-in.
 */
export type TermTree = string | readonly TermTree[];
/** Prefix marking a lossless full-content atom (filtered out of dereference). */
const ARTIFACT_SENTINEL = '__fxa__:';
function isContentAtom(value: string): boolean { return value.startsWith(ARTIFACT_SENTINEL); }

export interface ComposeResult {
  holonUri: string;
  contentType: string;
  descriptorUrl: string;
  reusedNodes: number;       // how many of this artifact's spine terms already existed (reuse)
  newNodes: number;
  stats: ReturnType<typeof latticeStats>;
  /** Interop surfaces emitted from this holon — proof RDF is one projection of many. */
  projections: ProjectionKind[];
  persisted: boolean;
  persistError?: string;
}

/**
 * Compose ANY artifact — an xAPI statement, a credential, a course, a descriptor,
 * an affordance — INTO the agent's shared lattice. `terms` is the reusable spine
 * (its nodes are shared + dereferenceable across the corpus); `content` is the FULL
 * artifact, stored losslessly so the exact artifact is read back from the lattice.
 * The holon projects to the requested interop surfaces. Best-effort, never throws.
 */
export async function composeIntoSharedLattice(args: {
  podUrl: string; agentDid: string; label: string;
  terms: readonly string[];
  content: Record<string, unknown>;
  contentType: string;
  ts?: string;
  projections?: readonly ProjectionKind[];
  /** Additional recipient pods whose published key also wraps the encrypted lattice
   *  (cross-seat owner-decrypt) — preserves the recipients feature of the removed
   *  hand-authored record. */
  recipientPods?: readonly string[];
  /**
   * Sub-compositions to compose this holon FROM, to ANY depth. A leaf is a value
   * (atomized); a node is composed of its children and contributes its holon uri
   * upward (ingest treats an existing node uri as a reference, not a value).
   *
   * This is what makes the lattice holonic rather than flat. `terms` is a flat
   * spine: every item is an opaque atom, so overlap exists only where two
   * artifacts share a WHOLE term. For an RDF artifact that is the wrong shape — a
   * graph is subjects, a subject is triples, a triple is subject/predicate/object.
   * Feeding an ontology's subject urls as flat `terms` measured 1.05x reuse (every
   * atom used exactly once, so the overlap was destroyed before the lattice saw
   * it); feeding its triples measures 82% of slots hitting an EXISTING atom,
   * because rdf:type / rdfs:label / rdfs:isDefinedBy and every shared url collapse
   * to ONE atom apiece across every triple and every ontology.
   *
   * KEEP EVERY LEVEL NARROW. ingest builds ~n^2/2 fragments over a sequence, so
   * composing one holon out of 448 triples is not "more holonic", it is quadratic
   * — it OOMs. Mirror the artifact's real hierarchy instead (graph -> subject ->
   * triple), which keeps every ingest a handful of items wide.
   *
   * Granularity stays open by construction: a leaf here can later be decomposed
   * BELOW this level (url segments, characters) without disturbing anything
   * reading at this level — the holon uris above it do not change.
   */
  termGroups?: readonly TermTree[];
  /** The artifact is DERIVED FROM CODE, so the pod is not its system of record —
   *  neither read the pod copy on a cold miss nor write one back. Use this for a
   *  projection that is regenerated deterministically at every boot and served
   *  from the resident lattice (an ontology, a vocabulary): its durable copy is
   *  write-only, and persisting it is not free.
   *
   *  The pod resource is per-POD, not per-label. Every label composing to the same
   *  pod loads that ONE resource into its own instance and persists the union
   *  back, so N code-derived labels sharing a pod ACCUMULATE each other's nodes
   *  without bound. That is not hypothetical: the tenant pod reached 16,178 nodes
   *  / 43 MB across 9 ontology labels until the pod server refused the PUT
   *  ("Encrypted instance publish failed: 500"). Ephemeral labels never join that
   *  union.
   *
   *  Only set this when the content is genuinely reproducible from code. An
   *  authored course or a learner's record is NOT — it must persist. */
  ephemeral?: boolean;
  /** This artifact is ALREADY published in full, so its lattice may be dereferenced
   *  node-by-node without auth (see markLatticePublic). Only for code-derived public
   *  content — never an agent's own corpus. */
  publicLattice?: boolean;
  /** Route this compose to a NON-default pod resource (see latticeResourceUrl). A
   *  dedicated resource keeps a public commons's node map disjoint from the agent's
   *  private `shared-lattice` — required before a label can be marked public. */
  resourceName?: string;
  fetch?: FetchFn;
}): Promise<ComposeResult | null> {
  try {
    // SSRF guard on the WRITE path (best-effort, never throws): args.podUrl is the
    // compose/write target and can be caller-influenced; a getLattice cache-hit would
    // otherwise skip the read-fetch guard and this function would PUT to an internal host.
    await assertSafeFetchTarget(args.podUrl);
    const kp = bridgeEncryptionKeypair();
    if (!kp || args.terms.length === 0) return null;
    if (args.publicLattice) markLatticePublic(args.label);
    const fetchFn = (args.fetch ?? (globalThis.fetch as unknown as FetchFn));
    const pgsl = await getLattice(args.podUrl, args.agentDid, args.label, fetchFn, args.ephemeral, args.resourceName);
    const prov = provFor(args.agentDid);
    // Reuse measurement: which spine terms/atoms already existed BEFORE this
    // ingest — counted over the groups too, since that is where the reuse lives.
    const leaves: string[] = [];
    const collect = (t: TermTree): void => { if (typeof t === 'string') leaves.push(t); else t.forEach(collect); };
    (args.termGroups ?? []).forEach(collect);
    const spine = [...args.terms, ...leaves];
    const reusedNodes = spine.filter(t => pgsl.atoms.has(String(t))).length;
    // Holonic, bottom-up: compose each sub-tree into its own holon and hand its uri
    // upward. ingest() treats an existing node uri as a reference rather than a
    // value, so sub-holons compose without being re-atomized. Depth is the caller's
    // (a triple is a holon of 3; a subject is a holon of its triples), which is what
    // keeps each ingest narrow — ingest is ~O(n^2) in the sequence length.
    const composeTree = (t: TermTree): string => {
      if (typeof t === 'string') return t;                       // leaf: a value ingest will atomize
      const parts = t.map(composeTree);
      return parts.length ? ingest(pgsl, parts, prov) : '';
    };
    const groupUris = (args.termGroups ?? []).map(composeTree).filter(Boolean);
    // The holon = its sub-holons + reusable spine terms + a lossless content atom
    // (sentinel-marked so dereference filters it out). PGSL is canonical: the exact
    // artifact (ANY content type, not just RDF) is recoverable from the content atom.
    const contentAtom = `${ARTIFACT_SENTINEL}${JSON.stringify({ t: args.contentType, c: args.content })}`;
    const holonUri = ingest(pgsl, [...groupUris, ...args.terms, contentAtom], prov);
    const node = pgsl.nodes.get(holonUri);
    if (!node) return null;
    const descriptorBase = `${args.podUrl.endsWith('/') ? args.podUrl : `${args.podUrl}/`}foxxi-lattice/`;
    // typedFacets: emit nested iep: facets (Who/When/Why/How/WhatKind/Whether) from the
    // holon's provenance + content-type so the PUBLISHED descriptor is answerable by the
    // interrogative router — not just a iep:Projection marker. (See projectHolon JSDoc.)
    const proj = projectHolon(node, pgsl, { descriptorBase, typedFacets: true, contentType: args.contentType });
    // Each requested surface is a render of the SAME holon — proof the lattice is
    // canonical and RDF is one projection of many.
    const projections = [...new Set<ProjectionKind>(args.projections ?? ['rdf'])];

    // Durable altitude: persist the whole shared lattice to its one canonical
    // encrypted resource (AWAITED — this is now a canonical store, so we confirm
    // the write rather than fire-and-forget) + PUT the projected descriptor.
    let persisted = false; let persistError: string | undefined;
    if (args.ephemeral) {
      // Nothing to confirm: this holon is reproduced from code on the next boot and
      // read back from the resident lattice, so the pod copy would be write-only.
      return {
        holonUri, contentType: args.contentType, descriptorUrl: proj.descriptorUrl,
        reusedNodes, newNodes: args.terms.length - reusedNodes,
        stats: latticeStats(pgsl), projections, persisted: false,
      };
    }
    // Persist to the SAME resource getLattice bound this label to — not a fresh compute
    // from args.resourceName. Otherwise a later compose to a public label that omits
    // resourceName would LOAD from the bound (public) resource but PERSIST to the private
    // default, tearing the two apart. getLattice ran just above, so the label is resident
    // with its bound resourceUrl; fall back to the computed one only if it somehow isn't.
    const resourceUrl = resident.get(args.label)?.resourceUrl ?? latticeResourceUrl(args.podUrl, args.resourceName);
    try {
      const recipients = [kp.publicKey];
      // resolveAgentEncryptionKey GETs <pod>/keys/encryption.json. A recipient pod is
      // caller-supplied (record-performance recipients[]); the initial host is guarded at
      // the route, but the key GET must ALSO re-guard every redirect hop or a public
      // recipient host can 302 the key read to an internal address (round-30). guardedFetchFn
      // wraps the fetch so the target + every redirect is re-guarded.
      const guardedFetch = guardedFetchFn(fetchFn) as typeof fetchFn;
      const ownerKey = await resolveAgentEncryptionKey(args.podUrl, { fetch: guardedFetch }).catch(() => null);
      if (ownerKey && ownerKey !== kp.publicKey) recipients.push(ownerKey);
      for (const pod of args.recipientPods ?? []) {
        try { const k = await resolveAgentEncryptionKey(pod, { fetch: guardedFetch }); if (k && !recipients.includes(k)) recipients.push(k); }
        catch { /* skip an unresolvable cross-seat recipient — best-effort */ }
      }
      await ensureContainer(`${args.podUrl.endsWith('/') ? args.podUrl : `${args.podUrl}/`}foxxi-lattice/`, fetchFn);
      // Compare-and-swap persist, serialized per resource. Non-clobbering: a concurrent
      // writer yields a 412, and casPersist reloads + pod-wins-merges + retries rather
      // than overwriting; an unreadable (re)load refuses (the fence). The reseat below
      // adopts the exact instance the write settled on (post-merge), so resident is
      // never left diverged from what is on the pod.
      const outcome = await withPodWriteLock(resourceUrl, () =>
        casPersist({ label: args.label, resourceUrl, agentDid: args.agentDid, holonUri, recipients, kp, fetchFn }));
      if (outcome.ok) {
        persisted = true;
        const cur = resident.get(args.label);
        if (cur) resident.set(args.label, { ...cur, pgsl: outcome.pgsl });
      } else {
        persistError = outcome.error;
        console.warn('[shared-lattice][persist]', persistError);
      }
      // The descriptor is a deterministic PROJECTION of the holon (idempotent), so it
      // is written best-effort and unconditionally — it never carries authorship.
      await fetchFn(proj.descriptorUrl, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: proj.descriptorTurtle }).catch(() => undefined);
    } catch (e) { persistError = (e as Error).message; console.warn('[shared-lattice][persist]', persistError); }

    return {
      holonUri, contentType: args.contentType, descriptorUrl: proj.descriptorUrl,
      reusedNodes, newNodes: args.terms.length - reusedNodes,
      stats: latticeStats(pgsl), projections, persisted, ...(persistError ? { persistError } : {}),
    };
  } catch { return null; }
}

/** Reconstruct the FULL artifact from the lattice (PGSL is canonical — read the
 *  exact content back, any content type). Resolves the holon's content atom. */
export function readArtifact(label: string, holonUri: string): { contentType: string; content: unknown } | null {
  const a = resident.get(label);
  if (!a) return null;
  const node = a.pgsl.nodes.get(holonUri);
  if (!node || node.kind !== 'Fragment') return null;
  for (const itemUri of node.items) {
    const atom = a.pgsl.nodes.get(itemUri);
    if (atom?.kind !== 'Atom') continue;
    const v = String(atom.value);
    if (!isContentAtom(v)) continue;
    try {
      const env = JSON.parse(v.slice(ARTIFACT_SENTINEL.length)) as { t: string; c: unknown };
      return { contentType: env.t, content: env.c };
    } catch { return null; }
  }
  return null;
}

/** Project a holon node to an interop surface — RDF, W3C VC, or ActivityStreams.
 *  All three are renders of the SAME canonical lattice node. */
export function projectAs(label: string, holonUri: string, as: ProjectionKind): unknown | null {
  const a = resident.get(label);
  if (!a) return null;
  const node = a.pgsl.nodes.get(holonUri);
  if (!node) return null;
  const ts = node.provenance.generatedAtTime || '1970-01-01T00:00:00Z';
  if (as === 'rdf') {
    // Parity with the published compose descriptor: the dereference render also
    // carries typed iep: facets so interrogative_route answers over it too.
    const art = readArtifact(label, holonUri);
    return projectHolon(node, a.pgsl, { descriptorBase: `${a.podUrl.replace(/\/$/, '')}/foxxi-lattice/`, typedFacets: true, ...(art ? { contentType: art.contentType } : {}) }).descriptorTurtle;
  }
  if (as === 'vc') return projectHolonToCredential(node, { issuanceDate: ts, extraTypes: ['FoxxiArtifact'] });
  if (as === 'activity') return projectHolonToActivity(node, { published: ts, activityType: 'Create' });
  return null;
}

// ── Dereferencing (the polygranular payoff) ───────────────────────────────────

export interface TermDereference {
  found: boolean;
  iri: string;
  atomUri?: string;
  appearsInFragments?: number;
  /** The holon URIs (top fragments) this term participates in — read back via readArtifact. */
  holons?: string[];
  /** The full artifacts (top fragments) this term participates in, resolved (spine only). */
  artifacts?: string[];
  /** Syntagmatic neighbors — what sits immediately left/right of this term. */
  leftNeighbors?: string[];
  rightNeighbors?: string[];
  /** Usage neighborhood — other terms it co-occurs with (paradigmatic signal). */
  coOccurring?: string[];
  /** iep:ContextDescriptor RDF PROJECTED from a containing lattice node (RDF is one of many surfaces). */
  projectedRdf?: string;
}

/** Resolve a fragment's SPINE (its reusable term items, skipping the content atom). */
function resolveSpine(pgsl: PGSLInstance, fragUri: IRI): string {
  const n = pgsl.nodes.get(fragUri);
  if (!n || n.kind !== 'Fragment') return resolve(pgsl, fragUri);
  return n.items
    .map(it => { const x = pgsl.nodes.get(it); return x?.kind === 'Atom' ? String(x.value) : resolve(pgsl, it); })
    .filter(v => !isContentAtom(v))
    .join(' ');
}

/** Dereference one IRI in an agent's shared lattice. */
export function dereferenceTerm(label: string, iri: string): TermDereference | null {
  const a = resident.get(label);
  if (!a) return null;
  return dereferenceIn(a.pgsl, a.podUrl, iri);
}

/** Pure dereference over a given lattice (testable without residence). */
export function dereferenceIn(pgsl: PGSLInstance, podUrl: string, iri: string): TermDereference {
  const atomUri = pgsl.atoms.get(String(iri));
  if (!atomUri) return { found: false, iri };
  const containers = ancestorFragments(pgsl, atomUri);
  const left = new Set<string>(), right = new Set<string>(), coOccur = new Set<string>();
  let maxLevel = 0;
  const resolveTerm = (u: IRI): string | null => { const v = resolve(pgsl, u); return isContentAtom(v) ? null : v; };
  for (const fUri of containers) {
    const n = pgsl.nodes.get(fUri);
    if (n?.kind !== 'Fragment') continue;
    if (n.level > maxLevel) maxLevel = n.level;
    const i = n.items.indexOf(atomUri);
    if (i < 0) continue;
    if (i > 0) { const l = resolveTerm(n.items[i - 1]!); if (l) left.add(l); }
    if (i < n.items.length - 1) { const r = resolveTerm(n.items[i + 1]!); if (r) right.add(r); }
    for (const it of n.items) { if (it === atomUri) continue; const c = resolveTerm(it); if (c) coOccur.add(c); }
  }
  const topFrags = containers
    .map(u => pgsl.nodes.get(u))
    .filter((n): n is PgslNode => !!n && n.kind === 'Fragment' && (n as { level: number }).level === maxLevel);
  const holons = [...new Set(topFrags.map(n => n.uri))];
  const artifacts = [...new Set(topFrags.map(n => resolveSpine(pgsl, n.uri)))];
  let projectedRdf: string | undefined;
  if (topFrags[0]) {
    try {
      projectedRdf = projectHolon(topFrags[0], pgsl, { descriptorBase: `${podUrl.replace(/\/$/, '')}/foxxi-lattice/`, typedFacets: true }).descriptorTurtle;
    } catch { /* skip */ }
  }
  return {
    found: true, iri, atomUri,
    appearsInFragments: containers.length,
    holons, artifacts, leftNeighbors: [...left], rightNeighbors: [...right], coOccurring: [...coOccur],
    projectedRdf,
  };
}

export interface NamespaceView {
  resident: boolean;
  stats?: ReturnType<typeof latticeStats>;
  /** Namespaces present in the lattice (IRI prefix -> term count) — the coarse slice. */
  namespaces?: Array<{ namespace: string; count: number }>;
  /** Every distinct reusable term (atom value) the lattice holds (content atoms excluded). */
  terms?: string[];
}

/** The coarse-granularity view of an agent's shared lattice: stats + namespaces. */
export function latticeNamespaceView(label: string): NamespaceView {
  const a = resident.get(label);
  if (!a) return { resident: false };
  const pgsl = a.pgsl;
  const ns = new Map<string, number>();
  const terms: string[] = [];
  for (const val of pgsl.atoms.keys()) {
    if (isContentAtom(val)) continue;   // skip lossless content atoms — show reusable terms only
    terms.push(val);
    const m = /^(.*[#/])[^#/]*$/.exec(val);
    const prefix = m ? m[1]! : '(literal)';
    ns.set(prefix, (ns.get(prefix) ?? 0) + 1);
  }
  return {
    resident: true,
    stats: latticeStats(pgsl),
    namespaces: [...ns.entries()].map(([namespace, count]) => ({ namespace, count })).sort((x, y) => y.count - x.count),
    terms: terms.sort(),
  };
}

export function isResident(label: string): boolean { return resident.has(label); }

// ── Read FROM PGSL (the inversion — lattice is canonical, any content type) ────

export interface LatticeArtifact { contentAtomUri: string; contentType: string; content: unknown }

/** Every artifact of a content type held in the agent's lattice, reconstructed
 *  losslessly from its content atom. PGSL is the read source — RDF is one of the
 *  projections, not the store. Deduped (one per distinct content atom). */
export function latticeArtifacts(label: string, contentType?: string): LatticeArtifact[] {
  const a = resident.get(label);
  if (!a) return [];
  const out: LatticeArtifact[] = [];
  for (const [uri, node] of a.pgsl.nodes) {
    if (node.kind !== 'Atom') continue;
    const v = String(node.value);
    if (!isContentAtom(v)) continue;
    try {
      const env = JSON.parse(v.slice(ARTIFACT_SENTINEL.length)) as { t: string; c: unknown };
      if (contentType && env.t !== contentType) continue;
      out.push({ contentAtomUri: uri, contentType: env.t, content: env.c });
    } catch { /* skip malformed */ }
  }
  return out;
}

/** ELR-shaped xAPI statements reconstructed FROM the lattice (the canonical read
 *  source). Same wrapper shape the ELR assembler consumes. */
export function latticeStatements(label: string): Array<{ id: string; statement: Record<string, unknown>; stored: string; voided: boolean }> {
  return latticeArtifacts(label, 'xapi:Statement').map(a => {
    const s = (a.content ?? {}) as Record<string, unknown>;
    return { id: String((s as { id?: unknown }).id ?? ''), statement: s, stored: String((s as { timestamp?: unknown }).timestamp ?? ''), voided: false };
  });
}

/** Load a full SCORM course from an agent's shared lattice by courseId — the
 *  course is stored losslessly as a foxxi:Course content atom (so it is launchable
 *  from PGSL, cross-restart + cross-agent). Loads from the pod on a cold miss. */
export async function loadCourseFromLattice(podUrl: string, agentDid: string, label: string, courseId: string, fetchFn?: FetchFn): Promise<Record<string, unknown> | null> {
  await ensureResident(podUrl, agentDid, label, fetchFn);
  for (const a of latticeArtifacts(label, 'foxxi:Course')) {
    const c = a.content as { courseId?: string } | null;
    if (c && c.courseId === courseId) return c as Record<string, unknown>;
  }
  return null;
}

/** Best-effort: load an agent's lattice into residence (load-from-pod on a cold
 *  miss) so the read path can source statements from PGSL. Returns whether the
 *  resident lattice has any content. Never throws. */
export async function ensureResident(podUrl: string, agentDid: string, label: string, fetchFn?: FetchFn, resourceName?: string): Promise<boolean> {
  try { await getLattice(podUrl, agentDid, label, fetchFn ?? (globalThis.fetch as unknown as FetchFn), false, resourceName); } catch { /* best-effort */ }
  const a = resident.get(label);
  return !!a && a.pgsl.atoms.size > 0;
}
