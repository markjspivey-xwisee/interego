/**
 * A competency's identity — a DEREFERENCEABLE URL, not a urn.
 *
 * A competency was identified by `urn:foxxi:competency:<slug>` (e.g.
 * `urn:foxxi:competency:content-authoring`): a denotation that resolved nothing. A
 * competency is a first-class thing an agent aligns work to, verifies a credential
 * against, and reasons over — so its id is a URL that GETs its definition:
 *
 *     urn:foxxi:competency:content-authoring
 *       ↔ https://foxxi-bridge.interego.xwisee.com/ns/foxxi/competency/content-authoring
 *
 * DUAL-READ: a credential issued / an alignment written before the swap carries the
 * legacy urn; `competencyIdOf` accepts either form and returns the bare slug, and
 * `sameCompetency` compares across schemes, so nothing that matched the urn breaks. The
 * bijection is lossless (slug ↔ URL under the authority).
 */

/** The authority that serves competency definitions. Env-overridable. */
export const COMPETENCY_ID_BASE: string =
  (process.env.FOXXI_COMPETENCY_ID_BASE ?? process.env.BRIDGE_DEPLOYMENT_URL ?? 'https://foxxi-bridge.interego.xwisee.com')
    .replace(/\/+$/, '') + '/ns/foxxi/competency';

const LEGACY_COMPETENCY_PREFIX = 'urn:foxxi:competency:';
const URL_PREFIX = `${COMPETENCY_ID_BASE}/`;

/** Mint a competency's canonical identity: a dereferenceable URL under the authority. */
export function competencyIri(slug: string): string {
  return `${COMPETENCY_ID_BASE}/${encodeURIComponent(slug)}`;
}

/**
 * ★ A COMPETENCY NAMED BY ANOTHER AUTHORITY'S TERM KEEPS THAT AUTHORITY IN ITS IDENTITY.
 *
 * The competency id used to be `competencyIri(<the term's local name>, lowercased and
 * slugged)`. That threw the naming authority away at exactly the seam where two publishers
 * meet, so two independently published terms that merely share a fragment —
 *
 *     https://one-authority.example/ns/skills#EvidenceIntegrityReview
 *     https://attacker.example/totally-unrelated-scheme#EvidenceIntegrityReview
 *
 * — were ONE competency. Measured against production: eight submissions split across two
 * such namespaces produced `competencyCount 1` and a Wilson lower bound of 0.676, i.e. the
 * exact figure for 8/8, so a stranger's term raised a confidence the first authority's term
 * was supposed to carry. Every consequence followed: pooled evidence lists, a pooled Dreyfus
 * level, and the emergent "teach it" affordance firing off the union.
 *
 * So the whole term IRI is the payload of the id, percent-encoded into one path segment.
 * Lossless in both directions (`competencyIdOf` decodes it back), collision-free by
 * construction, and it still dereferences: `/ns/foxxi/competency/:slug` serves a definition
 * that `owl:sameAs`-es the source term.
 *
 * The local-name slug is NOT kept as an alias. An alias would put the collision back on the
 * comparison path — a legacy id would match every authority's same-named term — and the
 * whole point of this function is that no two authorities share an id.
 */
export function competencyIriForTerm(termIri: string): string {
  return competencyIri(termIri);
}

/** True when a competency id's payload is itself an absolute term IRI (the form
 *  `competencyIriForTerm` mints), and that term. Null for a plain slug. */
export function competencyTermOf(iri: string): string | null {
  const id = competencyIdOf(iri);
  return id !== null && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(id) ? id : null;
}

/** True if `iri` is a competency identity in EITHER the URL or the legacy urn form. */
export function isCompetencyIri(iri: string): boolean {
  if (typeof iri !== 'string') return false;
  if (iri.startsWith(LEGACY_COMPETENCY_PREFIX)) return true;
  return /^https?:\/\/[^/]+\/ns\/foxxi\/competency\/[^/?#]+/.test(iri);
}

/** Recover the bare competency slug from either form (URL or legacy urn), or null. */
export function competencyIdOf(iri: string): string | null {
  if (typeof iri !== 'string') return null;
  if (iri.startsWith(LEGACY_COMPETENCY_PREFIX)) return iri.slice(LEGACY_COMPETENCY_PREFIX.length) || null;
  const m = /\/ns\/foxxi\/competency\/([^/?#]+)/.exec(iri);
  if (m) { try { return decodeURIComponent(m[1]!); } catch { return m[1]!; } }
  return null;
}

/** Whether two ids denote the same competency, regardless of scheme (URL vs legacy urn). */
export function sameCompetency(a: string, b: string): boolean {
  const ai = competencyIdOf(a), bi = competencyIdOf(b);
  return ai != null && ai === bi;
}
