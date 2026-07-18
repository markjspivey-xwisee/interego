/**
 * describe.ts — the ONE node-description model.
 *
 * A PGSL node is meant to be dereferenced: fetch its id, get a description of what
 * it is, composed of more ids you can follow. Two places render that description —
 * the pgsl-browser (examples/pgsl-browser) and the Foxxi bridge's label-free node
 * resolver — and they had drifted into two shapes: the browser computed a rich
 * self/structure/context/paradigm model inline, while the bridge hand-rolled a
 * poorer {items, appearsIn} subset. Same concept, two renderers, one of them worse.
 *
 * This is the shared model. It is PURE lattice math over a PGSLInstance and knows
 * nothing about HTTP: a consumer supplies `hrefFor` to map a node uri to whatever
 * url scheme it exposes, and adds its own controls/links on top. So the browser
 * (urls like /node/<uri>) and the bridge (urls like /agent/lattice/<kind>/<hash>)
 * render the SAME facets without either owning the model.
 *
 * The facets mirror the linguistic reading of the lattice:
 *  - structure  = SYNTAGM downward — what this holon is composed of (items, the two
 *                 overlapping constituents).
 *  - context    = what contains this node (the fragments that reuse it) — the reuse,
 *                 made walkable.
 *  - paradigm   = the PARADIGM at this position — what else appears BEFORE (source)
 *                 and AFTER (target) this node across every fragment it sits in.
 *                 These are substitution classes computed from actual usage, not a
 *                 declared schema.
 */
import type { IRI } from '@interego/core';
import type { PGSLInstance, Node, ContainmentAnnotation } from './types.js';
import { resolve, computeContainmentAnnotations } from './lattice.js';
import { PGSL_ID_AUTHORITY, toCanonicalNodeId } from '@interego/core';

export { PGSL_ID_AUTHORITY };

/**
 * The canonical URL identity of a node id. Now that the mint itself produces the URL
 * scheme (`${PGSL_ID_AUTHORITY}/<kind>/<hash>`), this is a passthrough for a live node
 * id and a LEGACY-urn converter (a corpus persisted before the mint swap still holds
 * urns; this re-expresses them under the resolving authority). Deterministic +
 * idempotent — kept as the stable public name callers already import.
 */
export function pgslCanonicalUrl(uri: string): string {
  return toCanonicalNodeId(uri);
}

/** A reference to another node — always carries the href so a reader can follow it. */
export interface NodeRef {
  readonly uri: IRI;
  readonly href: string;
  readonly resolved: string;
  readonly kind: Node['kind'] | 'unknown';
  readonly level: number;
}

export interface NodeDescription {
  readonly uri: IRI;
  /** The node's location-INDEPENDENT canonical URL identity (see pgslCanonicalUrl):
   *  a stable https id for federation/overlap, distinct from `href` (this consumer's
   *  location-dependent resolver link, where the description is actually fetched). */
  readonly canonical: string;
  readonly href: string;
  readonly resolved: string;
  readonly kind: Node['kind'];
  readonly level: number;
  readonly hash: string;
  readonly value?: unknown;   // atoms only
  readonly height?: number;   // fragments only
  readonly provenance: Node['provenance'];
  /** SYNTAGM downward — what this holon is composed of. */
  readonly _structure: {
    items?: Array<NodeRef & { position: number }>;
    leftConstituent?: NodeRef;
    rightConstituent?: NodeRef;
  };
  /** Upward — the fragments that reuse this node. */
  readonly _context: {
    containers: Array<NodeRef & { position: number; totalItems: number }>;
    annotations: Array<ContainmentAnnotation & { parentResolved: string }>;
  };
  /** The PARADIGM at this position — substitution classes from usage. */
  readonly _paradigm: {
    sourceOptions: NodeRef[];   // what appears BEFORE this node
    targetOptions: NodeRef[];   // what appears AFTER this node
  };
}

export interface DescribeNodeOptions {
  /** Map a node uri to the href this consumer exposes for it (its url scheme). */
  hrefFor: (uri: IRI) => string;
  /**
   * Cap the fan-out of the context / paradigm arrays. A heavily-reused atom (e.g.
   * rdf:type) appears in thousands of fragments, so an uncapped description would be
   * enormous. 0 or undefined = uncapped. The cap is applied per array.
   */
  maxNeighbors?: number;
}

function refTo(pgsl: PGSLInstance, uri: IRI, hrefFor: (u: IRI) => string): NodeRef {
  const n = pgsl.nodes.get(uri);
  return { uri, href: hrefFor(uri), resolved: resolve(pgsl, uri), kind: n?.kind ?? 'unknown', level: n?.level ?? 0 };
}

/**
 * Describe a node as the shared model. Returns null if the uri is not in the
 * lattice (a consumer maps that to its own 404). Pure — no I/O, no HTTP.
 */
export function describeNode(pgsl: PGSLInstance, uri: IRI, opts: DescribeNodeOptions): NodeDescription | null {
  const node = pgsl.nodes.get(uri);
  if (!node) return null;
  const { hrefFor } = opts;
  const cap = opts.maxNeighbors && opts.maxNeighbors > 0 ? opts.maxNeighbors : Infinity;

  // ── structure (downward) ──
  const structure: NodeDescription['_structure'] = {};
  if (node.kind === 'Fragment') {
    structure.items = node.items.map((itemUri, i) => ({ ...refTo(pgsl, itemUri, hrefFor), position: i }));
    if (node.left) structure.leftConstituent = refTo(pgsl, node.left, hrefFor);
    if (node.right) structure.rightConstituent = refTo(pgsl, node.right, hrefFor);
  }

  // ── context (upward) + paradigm (source/target), in ONE scan of the fragments ──
  const containers: Array<NodeRef & { position: number; totalItems: number }> = [];
  const sourceOptions: NodeRef[] = [];
  const targetOptions: NodeRef[] = [];
  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();
  for (const [fUri, fNode] of pgsl.nodes) {
    if (fNode.kind !== 'Fragment') continue;
    const pos = fNode.items.indexOf(uri);
    if (pos < 0) continue;
    if (containers.length < cap) {
      containers.push({ ...refTo(pgsl, fUri as IRI, hrefFor), position: pos, totalItems: fNode.items.length });
    }
    if (pos > 0) {
      const lu = fNode.items[pos - 1]!;
      if (!seenLeft.has(lu) && sourceOptions.length < cap) { seenLeft.add(lu); sourceOptions.push(refTo(pgsl, lu, hrefFor)); }
    }
    if (pos < fNode.items.length - 1) {
      const ru = fNode.items[pos + 1]!;
      if (!seenRight.has(ru) && targetOptions.length < cap) { seenRight.add(ru); targetOptions.push(refTo(pgsl, ru, hrefFor)); }
    }
  }

  const annotations = computeContainmentAnnotations(pgsl, uri)
    .slice(0, cap === Infinity ? undefined : cap)
    .map(a => ({ ...a, parentResolved: resolve(pgsl, a.parentUri) }));

  return {
    uri, canonical: pgslCanonicalUrl(String(uri)), href: hrefFor(uri), resolved: resolve(pgsl, uri),
    kind: node.kind, level: node.level, hash: String(uri).split(':').pop() ?? String(uri),
    ...(node.kind === 'Atom' ? { value: node.value } : {}),
    ...(node.kind === 'Fragment' ? { height: node.height } : {}),
    provenance: node.provenance,
    _structure: structure,
    _context: { containers, annotations },
    _paradigm: { sourceOptions, targetOptions },
  };
}
