/**
 * An action's identity — a DEREFERENCEABLE URL, not a urn.
 *
 * Affordance actions were identified by `urn:iep:action:<vertical>:<verb>` (e.g.
 * `urn:iep:action:foxxi:scorm-launch-signed`): a denotation that resolved nothing — a
 * word, not a term. Every identifier on this substrate should be a URL you can GET to
 * obtain the thing's description, so an action's canonical id is a URL under the protocol
 * naming authority that resolves to the action's affordance definition:
 *
 *     urn:iep:action:foxxi:scorm-launch-signed
 *       ↔ https://relay.interego.xwisee.com/ns/iep/action/foxxi/scorm-launch-signed
 *
 * The two forms are a lossless bijection (colon-delimited path ↔ slash-delimited path
 * under the authority), so DUAL-READ is exact: `sameAction` treats them as equal, and any
 * caller selecting an affordance by EITHER form resolves it. That is what lets a vertical
 * emit URL-form actions while every urn-selecting caller (cached descriptors, older
 * clients) keeps working — and vice versa.
 *
 * Not this scheme (leave untouched): AMEP's `amep:*` acts and HMD control `rel`s in the
 * `iep:` namespace-URL prefix — those are already CURIEs/URLs, not `urn:iep:action:`.
 */

/** The protocol naming authority that resolves action definitions. Env-overridable. */
export const IEP_ACTION_AUTHORITY: string =
  (process.env.IEP_ACTION_AUTHORITY ?? 'https://relay.interego.xwisee.com/ns/iep/action').replace(/\/+$/, '');

const LEGACY_ACTION_PREFIX = 'urn:iep:action:';
const URL_AUTHORITY_PREFIX = `${IEP_ACTION_AUTHORITY}/`;

/** True if `iri` is an action identity in EITHER the URL or the legacy urn form. */
export function isActionIri(iri: string): boolean {
  if (typeof iri !== 'string') return false;
  return iri.startsWith(LEGACY_ACTION_PREFIX) || iri.startsWith(URL_AUTHORITY_PREFIX)
    || /^https?:\/\/[^/]+\/ns\/iep\/action\/.+/.test(iri);
}

/** The scheme-independent KEY of an action (the path after the prefix, '/'-normalized).
 *  urn:iep:action:foxxi:x → "foxxi/x"; …/ns/iep/action/foxxi/x → "foxxi/x". A tail that
 *  embeds a URL (a rare defensive form) is returned verbatim so it still round-trips. */
export function actionKey(iri: string): string {
  if (typeof iri !== 'string') return '';
  let tail = iri;
  if (iri.startsWith(LEGACY_ACTION_PREFIX)) tail = iri.slice(LEGACY_ACTION_PREFIX.length);
  else { const m = /\/ns\/iep\/action\/(.+)$/.exec(iri); if (m && m[1]) tail = m[1]; else return iri; }
  // A tail that is itself a URL (contains "://") is not a colon-delimited path — keep as-is.
  return tail.includes('://') ? tail : tail.replace(/:/g, '/');
}

/** Mint the URL form of an action (from either form). A tail embedding a URL is left as a
 *  urn (it has no clean path form); everything else maps under the naming authority. */
export function actionUrl(iri: string): string {
  const key = actionKey(iri);
  if (key.includes('://')) return iri.startsWith(LEGACY_ACTION_PREFIX) ? iri : `${LEGACY_ACTION_PREFIX}${key}`;
  return `${IEP_ACTION_AUTHORITY}/${key}`;
}

/** Mint the legacy urn form of an action (from either form) — for compat aliases. */
export function actionUrn(iri: string): string {
  const key = actionKey(iri);
  return `${LEGACY_ACTION_PREFIX}${key.includes('://') ? key : key.replace(/\//g, ':')}`;
}

/** Whether two ids denote the same action, regardless of scheme (URL vs legacy urn). */
export function sameAction(a: string, b: string): boolean {
  const ka = actionKey(a), kb = actionKey(b);
  return ka !== '' && ka === kb;
}
