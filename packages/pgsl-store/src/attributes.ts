/**
 * The per-atom (edge-scoped) ABAC attribute model.
 *
 * Access class is NOT part of an atom's identity — an atom's URI is a hash of
 * its VALUE alone, so putting classification in the URI would fork the free
 * object (the same value would get different addresses per class). Instead
 * attributes are stored in the AA subspace keyed by (scope, atomAddr), where
 * scope is the containing edge (fragment) — which is what lets one shared atom
 * be public in holon A and secret in holon B without cloning it.
 */

/** public < internal < confidential < secret (monotone clearance lattice). */
export type Classification = 0 | 1 | 2 | 3;
export const CLASSIFICATION = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
} as const;

export interface AtomAccessAttributes {
  owner?: string;
  tenant?: string;
  /** Governs read disclosure; 0 (public) if no attributes are recorded. */
  classification: Classification;
  sensitivity?: number;
  /** IRIs of the AccessControlPolicies that govern this atom. */
  policyRefs?: string[];
  /** X25519 recipient public keys the atom is (or should be) encrypted to. */
  recipientSet?: string[];
}
