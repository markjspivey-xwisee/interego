/**
 * An xAPI Activity's identity — a DEREFERENCEABLE URL, not a urn.
 *
 * Foxxi's instrumentation emitted xAPI statements whose `object.id` was a bare urn
 * (`urn:foxxi:question:<course>`, `urn:foxxi:credential:<course>`, …): a valid xAPI Activity
 * IRI, but one that resolved NOTHING. The xAPI spec RECOMMENDS an Activity id dereference to
 * its Activity Definition, and every identifier on this substrate should be a URL you can GET.
 * The bridge is a single, reachable naming authority (exactly like course-id / competency-id),
 * so an activity's canonical id is a URL under it that resolves to the Activity Definition:
 *
 *     urn:foxxi:question:<course>  →  https://foxxi-bridge.interego.xwisee.com/ns/foxxi/activity/question/<course>
 *
 * GET it → the xAPI Activity Definition (JSON). Denote AND resolve.
 *
 * NOTE ON AGGREGATION: competency roll-up keys on `object.definition.type` — "the basis for
 * competency aggregation, NOT the instance leaf token" (learner-record.ts) — so flipping the
 * per-instance `object.id` from urn to URL does NOT split competency history, and there is no
 * exact-`object.id` match site anywhere, so this needs no match-side dual-read.
 */

import { FOXXI_NS } from './foxxi-vocab.js';

const ADL = 'http://adlnet.gov/expapi';

/** The naming authority that serves activity definitions. Env-overridable; defaults to the
 *  live bridge (shares the course-id resolution chain so a non-default deploy stays reachable). */
export const ACTIVITY_ID_BASE: string =
  (process.env.FOXXI_ACTIVITY_ID_BASE ?? process.env.BRIDGE_DEPLOYMENT_URL ?? 'https://foxxi-bridge.interego.xwisee.com')
    .replace(/\/+$/, '');

const ACTIVITY_PATH = '/ns/foxxi/activity/';
const ACTIVITY_URL_PREFIX = `${ACTIVITY_ID_BASE}${ACTIVITY_PATH}`;

/**
 * The known activity categories → their xAPI Activity Definition (type + human name). The
 * resolver serves these; the instrumentation mints ids under these categories. Single source
 * of truth so a minted `object.id` and its dereferenced Definition never drift — the `type`
 * here is the SAME `FOXXI_NS` the instrumentation stamps as `object.definition.type`.
 */
export const ACTIVITY_DEFINITIONS: Record<string, { type: string; name: string; description: string }> = {
  'assignments-catalog': { type: `${ADL}/activities/course`, name: 'Assigned courses', description: 'The catalog of courses assigned to a learner.' },
  'question': { type: `${FOXXI_NS}activities/concept-graph-node`, name: 'Course question', description: 'A question asked against a course concept graph.' },
  'question-agentic': { type: `${FOXXI_NS}activities/concept-graph-node`, name: 'Agentic course question', description: 'A question answered by the agentic retrieval + synthesis loop.' },
  'retrieval': { type: `${FOXXI_NS}activities/concept-graph-node`, name: 'Course context retrieval', description: 'A retrieval over a course concept graph.' },
  'credential': { type: `${FOXXI_NS}activities/credential`, name: 'Course completion credential', description: 'Issuance of a course-completion verifiable credential.' },
  'wallet-clr': { type: `${FOXXI_NS}activities/credential`, name: 'CLR wallet export', description: 'Export of a learner Comprehensive Learner Record.' },
  'framework-alignment': { type: `${FOXXI_NS}activities/framework`, name: 'Framework alignment', description: 'A declared alignment of an item to an external competency framework.' },
  'task': { type: `${FOXXI_NS}ProductionTask`, name: 'Production task', description: 'A unit of on-the-job production work recorded as an xAPI performed statement into a performer lens.' },
};

/** Mint an activity's canonical identity: a dereferenceable URL under the authority. `instance`
 *  (a course id/iri, learner DID, item iri) is percent-encoded into ONE path segment so an
 *  instance that is itself a URL or a colon-bearing DID stays a single, losslessly-decodable
 *  leaf. A category with no instance (e.g. the static assignments catalog) mints the bare
 *  category URL. */
export function activityIri(category: string, instance?: string): string {
  const base = `${ACTIVITY_URL_PREFIX}${encodeURIComponent(category)}`;
  return instance ? `${base}/${encodeURIComponent(instance)}` : base;
}

/** True if `iri` is an activity identity URL under any authority host (keyed on the path). */
export function isActivityIri(iri: string): boolean {
  if (typeof iri !== 'string') return false;
  return /^https?:\/\/[^/]+\/ns\/foxxi\/activity\/[^/?#]+/.test(iri);
}

/** Recover { category, instance } from an activity id URL, or null. Percent-decodes both
 *  segments; `instance` is undefined for a category-only (static) activity. */
export function activityRefOf(iri: string): { category: string; instance?: string } | null {
  if (typeof iri !== 'string') return null;
  const m = /\/ns\/foxxi\/activity\/([^/?#]+)(?:\/([^/?#]+))?/.exec(iri);
  if (!m) return null;
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  return m[2] ? { category: dec(m[1]), instance: dec(m[2]) } : { category: dec(m[1]) };
}
