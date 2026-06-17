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
  promoteInstanceEncrypted, resolveLatticeFromPod, latticeStats,
  type PGSLInstance, type Node as PgslNode,
} from '@interego/pgsl';
import type { IRI, FetchFn } from '@interego/core';
import { resolveAgentEncryptionKey } from '@interego/solid';
import { bridgeEncryptionKeypair } from './foundation-holon-altitude.js';

interface AgentLattice { pgsl: PGSLInstance; podUrl: string; agentDid: string }
const resident = new Map<string, AgentLattice>();   // label -> in-memory shared lattice
const loadAttempted = new Set<string>();
const creating = new Map<string, Promise<PGSLInstance>>();   // per-label creation mutex

const provFor = (agentDid: string) => ({ wasAttributedTo: agentDid as IRI, generatedAtTime: new Date().toISOString() });

/** The ONE canonical encrypted resource that holds the agent's whole shared lattice. */
function latticeResourceUrl(podUrl: string): string {
  const base = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  return `${base}foxxi-lattice/shared-lattice.holon.json`;
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
 *  effort) on a cold miss, else starting fresh. */
async function getLattice(podUrl: string, agentDid: string, label: string, fetchFn: FetchFn): Promise<PGSLInstance> {
  const existing = resident.get(label);
  if (existing) return existing.pgsl;
  // Per-label creation mutex: concurrent callers (e.g. a fire-and-forget completion
  // compose racing an awaited performance compose) MUST share ONE lattice instance,
  // else two cold creations clobber each other in `resident` and lose ingests.
  const inflight = creating.get(label);
  if (inflight) return inflight;
  const p = (async (): Promise<PGSLInstance> => {
    let pgsl: PGSLInstance | undefined;
    if (!loadAttempted.has(label)) {
      loadAttempted.add(label);
      const kp = bridgeEncryptionKeypair();
      if (kp) {
        try {
          const loaded = await resolveLatticeFromPod(latticeResourceUrl(podUrl), kp, fetchFn as unknown as typeof fetch);
          if (loaded && loaded.nodes.size) pgsl = rebuildInstance(loaded.nodes, agentDid);
        } catch { /* fresh */ }
      }
    }
    if (!pgsl) pgsl = createPGSL(provFor(agentDid));
    resident.set(label, { pgsl, podUrl, agentDid });
    return pgsl;
  })();
  creating.set(label, p);
  try { return await p; } finally { creating.delete(label); }
}

/** Interop surfaces a holon can be projected to. RDF is just ONE of them. */
export type ProjectionKind = 'rdf' | 'vc' | 'activity';
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
  fetch?: FetchFn;
}): Promise<ComposeResult | null> {
  try {
    const kp = bridgeEncryptionKeypair();
    if (!kp || args.terms.length === 0) return null;
    const fetchFn = (args.fetch ?? (globalThis.fetch as unknown as FetchFn));
    const pgsl = await getLattice(args.podUrl, args.agentDid, args.label, fetchFn);
    const prov = provFor(args.agentDid);
    // Reuse measurement: which spine terms already existed BEFORE this ingest.
    const reusedNodes = args.terms.filter(t => pgsl.atoms.has(String(t))).length;
    // The holon = reusable spine terms + a lossless content atom (sentinel-marked
    // so dereference filters it out). PGSL is canonical: the exact artifact (ANY
    // content type, not just RDF) is recoverable by resolving the content atom.
    const contentAtom = `${ARTIFACT_SENTINEL}${JSON.stringify({ t: args.contentType, c: args.content })}`;
    const holonUri = ingest(pgsl, [...args.terms, contentAtom], prov);
    const node = pgsl.nodes.get(holonUri);
    if (!node) return null;
    const descriptorBase = `${args.podUrl.endsWith('/') ? args.podUrl : `${args.podUrl}/`}foxxi-lattice/`;
    const proj = projectHolon(node, pgsl, { descriptorBase });
    // Each requested surface is a render of the SAME holon — proof the lattice is
    // canonical and RDF is one projection of many.
    const projections = [...new Set<ProjectionKind>(args.projections ?? ['rdf'])];

    // Durable altitude: persist the whole shared lattice to its one canonical
    // encrypted resource (AWAITED — this is now a canonical store, so we confirm
    // the write rather than fire-and-forget) + PUT the projected descriptor.
    let persisted = false; let persistError: string | undefined;
    try {
      const recipients = [kp.publicKey];
      const ownerKey = await resolveAgentEncryptionKey(args.podUrl, { fetch: fetchFn }).catch(() => null);
      if (ownerKey && ownerKey !== kp.publicKey) recipients.push(ownerKey);
      for (const pod of args.recipientPods ?? []) {
        try { const k = await resolveAgentEncryptionKey(pod, { fetch: fetchFn }); if (k && !recipients.includes(k)) recipients.push(k); }
        catch { /* skip an unresolvable cross-seat recipient — best-effort */ }
      }
      await ensureContainer(`${args.podUrl.endsWith('/') ? args.podUrl : `${args.podUrl}/`}foxxi-lattice/`, fetchFn);
      await promoteInstanceEncrypted(pgsl, holonUri, latticeResourceUrl(args.podUrl), recipients, kp, fetchFn as unknown as typeof fetch);
      await fetchFn(proj.descriptorUrl, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: proj.descriptorTurtle }).catch(() => undefined);
      persisted = true;
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
  if (as === 'rdf') return projectHolon(node, a.pgsl, { descriptorBase: `${a.podUrl.replace(/\/$/, '')}/foxxi-lattice/` }).descriptorTurtle;
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
  /** cg:ContextDescriptor RDF PROJECTED from a containing lattice node (RDF is one of many surfaces). */
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
      projectedRdf = projectHolon(topFrags[0], pgsl, { descriptorBase: `${podUrl.replace(/\/$/, '')}/foxxi-lattice/` }).descriptorTurtle;
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
export async function ensureResident(podUrl: string, agentDid: string, label: string, fetchFn?: FetchFn): Promise<boolean> {
  try { await getLattice(podUrl, agentDid, label, fetchFn ?? (globalThis.fetch as unknown as FetchFn)); } catch { /* best-effort */ }
  const a = resident.get(label);
  return !!a && a.pgsl.atoms.size > 0;
}
