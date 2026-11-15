/**
 * xapi-x: the `xapix:` namespace, and the published `iep:` terms it describes.
 *
 * xapi-x is a superset of xAPI 2.0 and xAPI Profiles 1.0 made by decoration: every xapi-x
 * statement is a valid xAPI statement, every xapi-x profile is a valid xAPI profile, and a plain
 * LRS or profile processor loses only the decorations. The design is in ../../xapix/README.md.
 *
 * Two sets of IRIs are named here, and they are kept apart:
 *
 *   IEP_DECORATIONS  four keys the lrs-adapter already writes under `result.extensions`. They are
 *                    `iep:` terms, declared in docs/ns/iep.ttl. xapi-x mints nothing for them: it
 *                    declares them in a profile, which no profile did before.
 *   XAPIX_TERMS      what xapi-x adds. Every one is declared in ../../xapix/xapix.ttl, and
 *                    tests/the-xapi-x-namespace-is-declared.test.ts fails when the two lists differ.
 *
 * Layer: vertical (Foxxi), like i2idl-x. No protocol term is added.
 */

/** Where Foxxi's signed vocabulary graphs dereference: the same root as `i2x:` (i2idl-glossary.ts). */
export const XAPIX_NS_ROOT = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc';
export const XAPIX_NS = `${XAPIX_NS_ROOT}/xapix#`;
/** The xapi-x profile. Its version, templates and patterns are children of this IRI. */
export const XAPIX_PROFILE_ID = `${XAPIX_NS_ROOT}/xapix-profile`;

/** The published `iep:` vocabulary (docs/ns/iep.ttl). */
export const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/** The four `iep:` keys a descriptor projection carries under `result.extensions` today. */
export const IEP_DECORATIONS = {
  sourceDescriptor: `${IEP_NS}sourceDescriptor`,
  modalStatus: `${IEP_NS}modalStatus`,
  coherentNarratives: `${IEP_NS}coherentNarratives`,
  projectionLossy: `${IEP_NS}projectionLossy`,
} as const;

/** The modal statuses a projected statement may state. */
export const MODAL_STATUSES = ['Asserted', 'Hypothetical', 'Counterfactual'] as const;

/**
 * Every term xapi-x adds, by local name. Only the namespace and the ontology exist so far: no
 * emitter writes any of these yet, and the first profile declares none of them.
 */
export const XAPIX_TERM_NAMES = [
  // What a term is.
  'Decoration',
  // Provenance.
  'Projection', 'descriptorDigest',
  // Supersession.
  'supersedesStatement',
  // Typed links from a profile's concepts and templates.
  'evidences', 'offers',
  // Hypermedia on a statement.
  'controls',
  // Ordering and who attests it.
  'previous', 'previousDigest', 'orderAttestation',
  'OrderBasis', 'ProviderClaimed', 'StoreAssigned', 'Chained', 'Attested',
] as const;
export type XapixTermName = typeof XAPIX_TERM_NAMES[number];

/** The IRI of an xapi-x term. */
export const xapix = (name: XapixTermName): string => `${XAPIX_NS}${name}`;
