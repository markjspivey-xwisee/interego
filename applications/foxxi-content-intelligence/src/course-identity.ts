/**
 * The course's canonical identity — a DEREFERENCEABLE URL, not a urn.
 *
 * A course used to be identified by `urn:foxxi:course:<id>`: a perfect denotation
 * (stable, deterministic) that resolved NOTHING — a word, not a term. Every identifier
 * on this substrate should be a URL you can GET to obtain the thing's description, so a
 * course's id is the bridge URL that already serves it:
 *
 *     https://foxxi-bridge.interego.xwisee.com/agent/scorm/course/<id>
 *
 * GET it → the course (JSON, or `?format=markdown` HyperMarkdown, or `?format=manifest`
 * the real imsmanifest.xml). Denote AND resolve.
 *
 * DUAL-READ: a course composed / a statement emitted before the swap carries the legacy
 * `urn:foxxi:course:<id>`. `courseIdOf` accepts either form and returns the bare id, and
 * `sameCourse` compares two ids across schemes, so nothing that matched on the urn breaks.
 */

/** The naming authority that serves course descriptions. Env-overridable so a non-default
 *  deployment mints ids under its own reachable host; defaults to the live bridge. */
export const COURSE_ID_BASE: string =
  (process.env.FOXXI_COURSE_ID_BASE ?? process.env.BRIDGE_DEPLOYMENT_URL ?? 'https://foxxi-bridge.interego.xwisee.com')
    .replace(/\/+$/, '');

/** The route prefix under the authority (the bridge read route that dereferences). */
const COURSE_PATH = '/agent/scorm/course/';
const COURSE_URL_PREFIX = `${COURSE_ID_BASE}${COURSE_PATH}`;
const LEGACY_COURSE_PREFIX = 'urn:foxxi:course:';

/** Mint a course's canonical identity: a dereferenceable URL under the authority. */
export function courseIri(courseId: string): string {
  return `${COURSE_URL_PREFIX}${encodeURIComponent(courseId)}`;
}

/** True if `iri` is a course identity in EITHER the URL or the legacy urn form. Matches
 *  any authority host for the URL form (a course minted under a different deployment's
 *  base is still a course id), keyed on the `/agent/scorm/course/` path. */
export function isCourseIri(iri: string): boolean {
  if (typeof iri !== 'string') return false;
  if (iri.startsWith(LEGACY_COURSE_PREFIX)) return true;
  return /^https?:\/\/[^/]+\/agent\/scorm\/course\/[^/?#]+/.test(iri);
}

/** Recover the bare course id from either form (URL or legacy urn), or null. Strips any
 *  query/fragment on the URL form and percent-decodes the id segment. */
export function courseIdOf(iri: string): string | null {
  if (typeof iri !== 'string') return null;
  if (iri.startsWith(LEGACY_COURSE_PREFIX)) return iri.slice(LEGACY_COURSE_PREFIX.length) || null;
  const m = /\/agent\/scorm\/course\/([^/?#]+)/.exec(iri);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return null;
}

/** Whether two ids denote the same course, regardless of scheme (URL vs legacy urn). */
export function sameCourse(a: string, b: string): boolean {
  const ai = courseIdOf(a), bi = courseIdOf(b);
  return ai != null && ai === bi;
}
