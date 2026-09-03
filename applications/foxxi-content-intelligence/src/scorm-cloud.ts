/**
 * SCORM Cloud connector — pulls course catalogs + dispatches from
 * Rustici's SCORM Cloud (https://cloud.scorm.com).
 *
 * Composition only: REST adapter over the SCORM Cloud Application API
 * (v2). Returns descriptor-ready payloads that `tenant-publisher.ts`
 * can ingest as `fxs:CourseCatalog` entries.
 *
 * Auth: SCORM Cloud uses Basic auth with `ApplicationId:SecretKey`.
 * Config supplied via `FOXXI_SCORM_CLOUD_APP_ID` +
 * `FOXXI_SCORM_CLOUD_SECRET_KEY` env vars on the bridge container app.
 *
 * Reference: https://cloud.scorm.com/docs/v2/reference/swagger/
 */

import { refuse } from '../../_shared/vertical-bridge/refusal.js';

export interface ScormCloudConfig {
  appId: string;
  secretKey: string;
  /** Override the base URL (defaults to the public SCORM Cloud production endpoint). */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ScormCloudCourse {
  id: string;
  title: string;
  version: number;
  registrationCount?: number;
  activityId?: string;
  /** When the course was uploaded to SCORM Cloud. */
  created?: string;
  updated?: string;
  /** Web entry point per the imsmanifest. */
  webPath?: string;
  /** xAPI activityId — useful for cross-referencing with the LRS. */
  courseLearningStandard?: string;
}

export interface ScormCloudCourseListResult {
  courses: ScormCloudCourse[];
  more?: string;
}

function authHeaderValue(config: ScormCloudConfig): string {
  return 'Basic ' + Buffer.from(`${config.appId}:${config.secretKey}`).toString('base64');
}

function baseUrl(config: ScormCloudConfig): string {
  return (config.baseUrl ?? 'https://cloud.scorm.com/api/v2').replace(/\/$/, '');
}

export async function listScormCloudCourses(config: ScormCloudConfig): Promise<ScormCloudCourseListResult> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const r = await fetchFn(`${baseUrl(config)}/courses`, {
    headers: { 'Authorization': authHeaderValue(config), 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`SCORM Cloud GET /courses ${r.status} ${r.statusText}`);
  const body = await r.json() as { courses?: Array<Record<string, unknown>>; more?: string };
  return {
    courses: (body.courses ?? []).map(c => ({
      id: String(c.id ?? ''),
      title: String(c.title ?? ''),
      version: Number(c.version ?? 0),
      registrationCount: typeof c.registrationCount === 'number' ? c.registrationCount : undefined,
      activityId: typeof c.activityId === 'string' ? c.activityId : undefined,
      created: typeof c.created === 'string' ? c.created : undefined,
      updated: typeof c.updated === 'string' ? c.updated : undefined,
      webPath: typeof c.webPath === 'string' ? c.webPath : undefined,
      courseLearningStandard: typeof c.courseLearningStandard === 'string' ? c.courseLearningStandard : undefined,
    })),
    more: body.more,
  };
}

/** Project SCORM Cloud course list → foxxi `CatalogEntry`-shaped objects. */
export function scormCloudToCatalogEntries(courses: readonly ScormCloudCourse[]): Array<{
  course_id: string;
  title: string;
  category: string;
  audience_tags: string[];
  owner: string;
  authoring_tool: string;
  standard: string;
  concept_count: number;
  slide_count: number;
  audio_seconds: number;
  is_real: boolean;
  parse_status: string;
  last_modified?: string;
  lms_source: string;
}> {
  return courses.map(c => ({
    course_id: `scorm-cloud:${c.id}`,
    title: c.title,
    category: 'Imported · SCORM Cloud',
    audience_tags: [], // ACL on SCORM Cloud side; surfaced via separate sync
    owner: 'SCORM Cloud',
    authoring_tool: 'unknown (Cloud)',
    standard: c.courseLearningStandard ?? 'SCORM/xAPI',
    concept_count: 0,
    slide_count: 0,
    audio_seconds: 0,
    is_real: false, // not parsed by foxxi yet — present in catalog only
    parse_status: 'sync-stub',
    last_modified: c.updated,
    lms_source: 'SCORM Cloud',
  }));
}

/**
 * Register a learner in a SCORM Cloud course (so the LRS records their
 * progress under a known registration id). Foxxi maps the registration
 * id back into the cmi5 `sessionid` extension on emitted statements.
 */
export interface CreateRegistrationArgs {
  registrationId: string;
  courseId: string;
  learner: {
    id: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}
export async function createScormCloudRegistration(
  args: CreateRegistrationArgs,
  config: ScormCloudConfig,
): Promise<{ status: 'created' | 'exists' | 'failed'; launchUrl?: string; error?: string }> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  try {
    const r = await fetchFn(`${baseUrl(config)}/registrations`, {
      method: 'POST',
      headers: {
        'Authorization': authHeaderValue(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registrationId: args.registrationId,
        courseId: args.courseId,
        learner: args.learner,
      }),
    });
    if (r.status === 409) return { status: 'exists' };
    if (!r.ok) {
      // ★★ 502, BECAUSE THE UPSTREAM FAILED AND THE CALLER DID NOT. This returned a bare
      // `{status:'failed', error}` that the dispatcher cannot key on, so the handler - which
      // returns this verbatim - answered HTTP 200 for work that never happened. Its sibling
      // twenty lines away already answered 502 through upstreamFailed(); two handlers against the
      // same upstream disagreed about what a failure is.
      return { ...refuse(502, `${r.status} ${r.statusText}`, 'a pod or upstream service this affordance composes did not complete the operation'), status: 'failed' };
    }
    return { status: 'created' };
  } catch (err) {
    return { ...refuse(502, (err as Error).message, 'a pod or upstream service this affordance composes did not complete the operation'), status: 'failed' };
  }
}

/** Fetch the launch URL for an existing registration. */
export async function getScormCloudLaunchLink(
  args: { registrationId: string; redirectOnExitUrl?: string; expiry?: number },
  config: ScormCloudConfig,
): Promise<{ launchLink?: string; error?: string }> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const r = await fetchFn(`${baseUrl(config)}/registrations/${encodeURIComponent(args.registrationId)}/launchLink`, {
    method: 'POST',
    headers: {
      'Authorization': authHeaderValue(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      redirectOnExitUrl: args.redirectOnExitUrl ?? '',
      expiry: args.expiry ?? 0,
    }),
  });
  if (!r.ok) return { error: `${r.status} ${r.statusText}` };
  const body = await r.json() as { launchLink?: string };
  return { launchLink: body.launchLink };
}
