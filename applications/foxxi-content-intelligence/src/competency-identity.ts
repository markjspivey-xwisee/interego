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
