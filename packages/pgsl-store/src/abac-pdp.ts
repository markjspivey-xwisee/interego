/**
 * The atom-granular PDP — COMPOSES @interego/abac (does not reinvent it).
 *
 * Per atom, the generic "permit read" policy's predicate is PARTIAL-INSTANTIATED
 * with the atom's classification (a `minInclusive` on the requester's clearance
 * axis), then @interego/abac's `evaluate()` runs it against the requester's
 * attribute graph. This is the design's zero-fork compose-point: the pure
 * evaluator, its deny-overrides combiner, and its open-world default are all
 * reused unchanged.
 *
 * Trust boundary (maintainer decision): the PDP runs ONLY inside a user-authorized
 * MEDIATOR that holds the requester's attributes / plaintext. CSS and the FDB
 * store never run it — they stay zero-trust ciphertext. So this module lives in
 * @interego/pgsl-store as a library the mediator consumes; the store itself does
 * not call it.
 */

import type { AccessControlPolicyData, ContextFacetData, IRI } from '@interego/core';
import {
  evaluate,
  type AttributeGraph,
  type PolicyContext,
  type PolicyPredicateShape,
} from '@interego/abac';
import type { AtomAccessAttributes } from './attributes.js';

export type Verdict = 'Allowed' | 'Denied' | 'Indeterminate';

export interface Pdp {
  /** Verdict for reading one atom given its (edge-scoped) attributes. */
  decide(atomAttrs: AtomAccessAttributes | undefined): Verdict;
}

const READ: IRI = 'iep:canRead' as IRI;
const CLEARANCE_SHAPE: IRI = 'urn:shape:clearance-ge-classification' as IRI;
const CLEARANCE_POLICY: AccessControlPolicyData = {
  id: 'urn:policy:read-by-clearance' as IRI,
  policyPredicateShape: CLEARANCE_SHAPE,
  governedAction: READ,
  deonticMode: 'Permit',
};

/**
 * A clearance-based PDP composed over @interego/abac. The requester's clearance
 * is carried as an `amta:clearance` axis on a Trust facet (exactly the attribute
 * shape `@interego/abac`'s resolver reads). An atom with no attributes is treated
 * as public (classification 0) and always readable; a classified atom is
 * disclosed iff the requester's clearance >= its classification.
 */
export function clearancePdp(
  requesterClearance: number,
  opts: { now?: string; subject?: string } = {},
): Pdp {
  const subject = (opts.subject ?? 'urn:agent:requester') as IRI;
  const now = opts.now ?? '2026-07-08T00:00:00Z';
  const subjectAttributes: AttributeGraph = {
    subject,
    facets: [
      {
        type: 'Trust',
        trustLevel: 'SelfAsserted' as IRI,
        amtaAxes: { clearance: requesterClearance },
      } as ContextFacetData,
    ],
    sources: new Map(),
  };
  const predicates = new Map<IRI, PolicyPredicateShape>();

  return {
    decide(atomAttrs): Verdict {
      const classification = atomAttrs?.classification ?? 0;
      if (classification <= 0) return 'Allowed'; // public: no clearance needed
      const predicate: PolicyPredicateShape = {
        iri: CLEARANCE_SHAPE,
        constraints: [{ path: 'amta:clearance', minCount: 1, minInclusive: classification }],
      };
      predicates.set(CLEARANCE_SHAPE, predicate);
      const ctx: PolicyContext = {
        subject,
        subjectAttributes,
        resource: 'urn:pgsl:atom' as IRI,
        action: READ,
        now,
      };
      // Permit-that-does-not-apply -> Indeterminate (open-world). The projection
      // is fail-closed: only an explicit 'Allowed' discloses the value.
      return evaluate([CLEARANCE_POLICY], predicates, ctx).verdict as Verdict;
    },
  };
}
