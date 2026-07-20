/**
 * Sample demo course data bundled at build time. Generic demo tenant
 * (Acme Training Co); demo course is the public SCORM Cloud "Golf
 * Explained" single-SCO sample from Rustici Software. No client
 * content.
 *
 * Vite resolves the JSON imports at build time. The dashboard uses
 * these as the offline fallback when the Foxxi bridge isn't running.
 * When the bridge IS running, this data is sent to the bridge as the
 * `admin` / `course_content` argument of each affordance call.
 */

import adminPayloadJson from '../../../imported/admin_payload.json';
import courseTranscripts from '../../../imported/transcripts.json';
import courseDashboard from '../../../imported/dashboard_data.json';
import type {
  AdminPayload,
  CourseContent,
  CourseConcept,
  CourseTranscript,
  CourseScene,
  CourseSlide,
  CoursePrereqEdge,
  CoursePackageMeta,
} from '../types.js';

export const SAMPLE_ADMIN_PAYLOAD = adminPayloadJson as unknown as AdminPayload;

const DEMO_TENANT_DID = 'did:web:acme-id.interego.xwisee.com';

interface RawDashboardData {
  package?: CoursePackageMeta;
  scenes?: CourseScene[];
  slides?: CourseSlide[];
  concepts: CourseConcept[];
  prereq_edges?: CoursePrereqEdge[];
}

function golfExplainedCourse(): CourseContent {
  const d = courseDashboard as unknown as RawDashboardData;
  return {
    courseIri: 'https://acme-id.interego.xwisee.com/courses/golf-explained#package',
    title: 'Golf Explained',
    authoritativeSource: DEMO_TENANT_DID,
    transcripts: courseTranscripts as unknown as Record<string, CourseTranscript>,
    concepts: d.concepts,
    scenes: d.scenes,
    slides: d.slides,
    prereqEdges: d.prereq_edges,
    packageMeta: d.package,
  };
}

export const SAMPLE_LESSON_PAYLOADS: Record<string, CourseContent> = {
  'golf-explained': golfExplainedCourse(),
};

export const SAMPLE_TENANT_POD_URL = SAMPLE_ADMIN_PAYLOAD.meta.tenant_pod;
