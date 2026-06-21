/**
 * Shared types for the Foxxi dashboard.
 *
 * These mirror the substrate-side shapes from
 * applications/foxxi-content-intelligence/src/enrollment.ts +
 * src/course-qa.ts so the client-side stays in sync with the bridge
 * contract.
 */

export interface AdminMeta {
  tenant: string;
  tenant_pod: string;
  admin_user_web_id: string;
  admin_user_name: string;
  admin_user_role: string;
  tenant_id: string;
}

export interface CatalogEntry {
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
  is_real?: boolean;
  parse_status?: string;
  shacl_violations?: number;
  last_modified?: string;
  last_parsed?: string;
  lms_source?: string;
}

export interface AdminUser {
  user_id: string;
  web_id: string;
  name: string;
  email: string;
  department: string;
  job_title: string;
  manager_user_id?: string | null;
  location?: string;
  audience_tags: string[];
  status: string;
  employee_id?: string;
  hire_date: string;
}

export interface AdminGroup {
  group_id: string;
  name: string;
  kind: string;
  member_count: number;
  member_ids: string[];
  description?: string;
}

export interface AdminPolicy {
  policy_id: string;
  course_id: string;
  course_title: string;
  audience_group_id: string;
  audience_label: string;
  audience_member_count?: number;
  requirement_type: 'required' | 'recommended';
  trigger: string;
  due_relative_days: number;
  created_at: string;
  created_by_user_id?: string;
  created_by_name?: string;
  enabled: boolean;
}

export interface AdminEvent {
  event_id: string;
  user_id: string;
  course_id: string;
  policy_id: string;
  assigned_at: string;
  due_at: string;
  status: string;
  completed_at?: string | null;
  requirement_type: string;
}

export interface AdminCoverageEntry {
  concept_label: string;
  taught_in_courses: string[];
  taught_count: number;
  mentioned_in_courses: string[];
  mentioned_count: number;
  only_mentioned_count: number;
  categories: string[];
}

export interface AdminConnection {
  id: string;
  kind: string;
  product: string;
  instance: string;
  status: string;
  auth_method: string;
  last_sync: string;
  sync_frequency: string;
  courses_contributed: number;
  auth_warning?: string | null;
}

export interface AdminAuditEntry {
  audit_id: string;
  timestamp: string;
  actor_user_id: string;
  actor_web_id?: string;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  reason?: string;
}

export interface AdminPayload {
  meta: AdminMeta;
  catalog: CatalogEntry[];
  users: AdminUser[];
  groups: AdminGroup[];
  policies: AdminPolicy[];
  events: AdminEvent[];
  audit: AdminAuditEntry[];
  coverage: AdminCoverageEntry[];
  connections: AdminConnection[];
}

export interface EnrolledCourse {
  courseId: string;
  courseTitle: string;
  category: string;
  requirementType: 'required' | 'recommended';
  policyId: string;
  assignedAt: string;
  dueAt: string;
  status: 'pending' | 'completed' | 'overdue';
  completedAt?: string;
  /** iep:modalStatus of the enrollment record. 'Asserted' = backed by a
   *  real lifecycle event; 'Hypothetical' = inferred purely from policy
   *  audience-group membership (predicted, not yet observed). Absent in
   *  offline-sample mode (treat as 'Asserted'). */
  modalStatus?: 'Asserted' | 'Hypothetical';
  /** Hypermedia _links emitted by the server (HAL-style). Present when
   *  the bridge is in use; absent in offline-sample mode. The `launch`
   *  link is a Hydra IriTemplate — see HypermediaLink in hypermedia.tsx
   *  for the `mapping` shape. */
  _links?: {
    self?: { href: string };
    course?: { href: string };
    group?: { href: string };
    launch?: import('./hypermedia.js').HypermediaLink;
  };
}

export interface CourseConcept {
  id: string;
  label: string;
  confidence: number;
  tier: number;
  taught_in_slides?: string[];
  total_freq?: number;
}

export interface CourseTranscript {
  duration: number;
  language: string;
  text: string;
}

export interface CourseScene {
  id: string;
  title: string;
  scene_number: number;
  slide_ids: string[];
}

export interface CourseSlideTranscriptSegment {
  path?: string;
  duration?: number;
  text?: string;
  language?: string;
}

export interface CourseSlide {
  id: string;
  title: string;
  scene_id: string;
  sequence_index: number;
  lms_id?: string;
  audio_count?: number;
  transcript_segments?: CourseSlideTranscriptSegment[];
  transcript_combined?: string;
  concept_ids?: string[];
  alt_text_corpus?: string;
}

export interface CoursePrereqEdge {
  from: string;
  to: string;
  confidence?: number;
}

export interface CoursePackageMeta {
  id?: string;
  title?: string;
  standard?: string;
  authoring_tool?: string;
  authoring_version?: string;
  parser_version?: string;
}

export interface CourseContent {
  courseIri: string;
  title: string;
  authoritativeSource: string;
  transcripts: Record<string, CourseTranscript>;
  concepts: CourseConcept[];
  scenes?: CourseScene[];
  slides?: CourseSlide[];
  prereqEdges?: CoursePrereqEdge[];
  packageMeta?: CoursePackageMeta;
}
