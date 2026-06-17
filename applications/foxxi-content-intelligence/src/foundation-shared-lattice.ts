/**
 * foundation-shared-lattice.ts — a PER-AGENT, ACCUMULATING PGSL lattice that
 * artifacts compose INTO (so their terms — RDF IRIs, xAPI verbs, activity types —
 * become REUSED content-addressed nodes across the corpus), and from which the
 * cg-RDF descriptor is PROJECTED. This is the foundation-first composition the
 * existing per-artifact `alsoPersistEncryptedHolon` does NOT do (it builds a fresh
 * throwaway lattice per artifact, so nothing is ever reused or dereferenced).
 *
 * Two altitudes, like the rest of the substrate: the lattice is held in-memory per
 * agent (fast reuse + dereference) AND persisted whole to ONE canonical encrypted
 * pod resource (durable; reloaded on a cold miss). The authoritative hand-authored
 * RDF path is left untouched — this layer is ADDITIVE and reversible until the
 * projection is verified, at which point it becomes the authoritative composer.
 *
 * Dereferencing is the payoff: take one IRI and see where it appears across the
 * corpus + its syntagmatic (left/right) neighbors + its usage neighborhood —
 * exactly the polygranular reuse PGSL is for. Composes substrate primitives only
 * (see [[feedback_compose_dont_reinvent]]).
 */
import {
  createPGSL, ingest, resolve, ancestorFragments, projectHolon,
  promoteInstanceEncrypted, resolveLatticeFromPod, latticeStats,
  type PGSLInstance, type Node as PgslNode,
} from '@interego/pgsl';
import type { IRI, FetchFn } from '@interego/core';
import { resolveAgentEncryptionKey } from '@interego/solid';
import { bridgeEncryptionKeypair } from './foundation-holon-altitude.js';

interface AgentLattice { pgsl: PGSLInstance; podUrl: string; agentDid: string }
const resident = new Map<string, AgentLattice>();   // label -> in-memory shared lattice
const loadAttempted = new Set<string>();

const provFor = (agentDid: string) => ({ wasAttributedTo: agentDid as IRI, generatedAtTime: new Date().toISOString() });

/** The ONE canonical encrypted resource that holds the agent's whole shared lattice. */
function latticeResourceUrl(podUrl: string): string {
  const base = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  return `${base}foxxi-lattice/shared-lattice.holon.json`;
}

/** Rebuild a usable PGSLInstance from a persisted node map — reconstructs the
 *  atom (value->uri) + fragment (items->uri) registries so the lattice can keep
 *  ingesting with dedup. Dereference/projection need only `nodes`, but ingest
 *  needs the registries. Keys mirror lattice.ts (atom: String(value); fragment:
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
}

export interface ComposeResult {
  holonUri: string;
  descriptorUrl: string;
  reusedNodes: number;       // how many of this artifact's terms already existed (reuse)
  newNodes: number;
  stats: ReturnType<typeof latticeStats>;
  persisted: boolean;
}

/**
 * Compose an artifact INTO the agent's shared lattice (its terms become reused
 * nodes), project the cg descriptor FROM the lattice, and persist the whole
 * lattice (durable). Best-effort, never throws — the authoritative RDF path is
 * unaffected. `sequence` is the artifact as an ordered term list, e.g.
 * [actorDid, verbIri, activityTypeIri].
 */
export async function composeIntoSharedLattice(args: {
  podUrl: string; agentDid: string; label: string;
  sequence: readonly string[];
  fetch?: FetchFn;
}): Promise<ComposeResult | null> {
  try {
    const kp = bridgeEncryptionKeypair();
    if (!kp || args.sequence.length === 0) return null;
    const fetchFn = (args.fetch ?? (globalThis.fetch as unknown as FetchFn));
    const pgsl = await getLattice(args.podUrl, args.agentDid, args.label, fetchFn);
    // Reuse measurement: which terms already existed BEFORE this ingest.
    const reusedNodes = args.sequence.filter(t => pgsl.atoms.has(String(t))).length;
    const holonUri = ingest(pgsl, args.sequence, provFor(args.agentDid));
    const node = pgsl.nodes.get(holonUri);
    if (!node) return null;
    const descriptorBase = `${args.podUrl.endsWith('/') ? args.podUrl : `${args.podUrl}/`}foxxi-lattice/`;
    const proj = projectHolon(node, pgsl, { descriptorBase });

    // Durable altitude (BACKGROUND, best-effort): persist the WHOLE shared lattice
    // to its one canonical encrypted resource + PUT the projected descriptor. The
    // in-memory lattice + dereference work regardless, so we don't block the
    // response on the pod round-trips.
    void (async () => {
      try {
        const recipients = [kp.publicKey];
        const ownerKey = await resolveAgentEncryptionKey(args.podUrl, { fetch: fetchFn }).catch(() => null);
        if (ownerKey && ownerKey !== kp.publicKey) recipients.push(ownerKey);
        await promoteInstanceEncrypted(pgsl, holonUri, latticeResourceUrl(args.podUrl), recipients, kp, fetchFn as unknown as typeof fetch);
        await fetchFn(proj.descriptorUrl, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: proj.descriptorTurtle });
      } catch (e) { console.warn('[shared-lattice][persist]', (e as Error).message); }
    })();

    return {
      holonUri, descriptorUrl: proj.descriptorUrl,
      reusedNodes, newNodes: args.sequence.length - reusedNodes,
      stats: latticeStats(pgsl), persisted: true,
    };
  } catch { return null; }
}

// ── Dereferencing (the polygranular payoff) ───────────────────────────────────

export interface TermDereference {
  found: boolean;
  iri: string;
  atomUri?: string;
  appearsInFragments?: number;
  /** The full artifacts (top fragments) this term participates in, resolved. */
  artifacts?: string[];
  /** Syntagmatic neighbors — what sits immediately left/right of this term. */
  leftNeighbors?: string[];
  rightNeighbors?: string[];
  /** Usage neighborhood — other terms it co-occurs with (paradigmatic signal). */
  coOccurring?: string[];
  /** cg:ContextDescriptor RDF PROJECTED from a containing lattice node. */
  projectedRdf?: string;
}

/** Dereference one IRI in an agent's shared lattice: where it appears + its
 *  syntagmatic neighbors + usage neighborhood + the RDF projected from it. */
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
  for (const fUri of containers) {
    const n = pgsl.nodes.get(fUri);
    if (n?.kind !== 'Fragment') continue;
    if (n.level > maxLevel) maxLevel = n.level;
    const i = n.items.indexOf(atomUri);
    if (i < 0) continue;
    if (i > 0) left.add(resolve(pgsl, n.items[i - 1]!));
    if (i < n.items.length - 1) right.add(resolve(pgsl, n.items[i + 1]!));
    for (const it of n.items) if (it !== atomUri) coOccur.add(resolve(pgsl, it));
  }
  const artifacts = [...new Set(containers
    .map(u => pgsl.nodes.get(u))
    .filter((n): n is PgslNode => !!n && n.kind === 'Fragment' && (n as { level: number }).level === maxLevel)
    .map(n => resolve(pgsl, n.uri)))];
  // Project the RDF from the largest containing fragment (an artifact).
  const topNode = containers.map(u => pgsl.nodes.get(u)).find(n => n?.kind === 'Fragment' && (n as { level: number }).level === maxLevel);
  let projectedRdf: string | undefined;
  if (topNode) {
    try {
      projectedRdf = projectHolon(topNode, pgsl, { descriptorBase: `${podUrl.replace(/\/$/, '')}/foxxi-lattice/` }).descriptorTurtle;
    } catch { /* skip */ }
  }
  return {
    found: true, iri, atomUri,
    appearsInFragments: containers.length,
    artifacts, leftNeighbors: [...left], rightNeighbors: [...right], coOccurring: [...coOccur],
    projectedRdf,
  };
}

export interface NamespaceView {
  resident: boolean;
  stats?: ReturnType<typeof latticeStats>;
  /** Namespaces present in the lattice (IRI prefix -> term count) — the coarse slice. */
  namespaces?: Array<{ namespace: string; count: number }>;
  /** Every distinct term (atom value) the lattice holds. */
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

/** Best-effort: load an agent's lattice into residence (for dereference after a
 *  cold start). Needs the pod URL — the dereference endpoints derive it from the
 *  gate origin + label. */
export async function ensureResident(podUrl: string, agentDid: string, label: string, fetchFn?: FetchFn): Promise<boolean> {
  await getLattice(podUrl, agentDid, label, fetchFn ?? (globalThis.fetch as unknown as FetchFn));
  return resident.has(label);
}

export function isResident(label: string): boolean { return resident.has(label); }
