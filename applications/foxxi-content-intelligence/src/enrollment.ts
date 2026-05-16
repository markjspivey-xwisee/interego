/**
 * Foxxi enrollment resolution.
 *
 * Walks an L&D admin payload (catalog + users + groups + policies +
 * events) and resolves "which courses is this learner currently
 * enrolled in?" The admin payload shape matches the imported
 * `admin_payload.json` from the original Foxxi system — see
 * `imported/admin_payload.json` for the live sample (ACME Utility
 * tenant, 183 employees, real policy/event state).
 *
 * Returns assigned courses split into required + recommended +
 * already-completed, with due-by dates derived from the policy's
 * trigger date + due_relative_days.
 */

export interface FoxxiAdminPayload {
  readonly meta: {
    readonly tenant: string;
    readonly tenant_pod: string;
    readonly admin_user_web_id: string;
    readonly admin_user_name: string;
    readonly admin_user_role: string;
    readonly tenant_id: string;
  };
  readonly catalog: ReadonlyArray<{
    readonly course_id: string;
    readonly title: string;
    readonly category: string;
    readonly audience_tags: readonly string[];
    readonly owner: string;
    readonly authoring_tool: string;
    readonly standard: string;
    readonly concept_count: number;
    readonly slide_count: number;
    readonly audio_seconds: number;
    readonly is_real?: boolean;
  }>;
  readonly users: ReadonlyArray<{
    readonly user_id: string;
    readonly web_id: string;
    readonly name: string;
    readonly email: string;
    readonly department: string;
    readonly job_title: string;
    readonly audience_tags: readonly string[];
    readonly status: string;
    readonly hire_date: string;
  }>;
  readonly groups: ReadonlyArray<{
    /** Stable group id (audience groups use "tag-<audience-tag>" convention). */
    readonly group_id: string;
    readonly name: string;
    /** "audience" | "department" | "location" | etc. */
    readonly kind: string;
    readonly member_count: number;
    /** Explicit user_id membership list — the authoritative enrollment join. */
    readonly member_ids: readonly string[];
  }>;
  readonly policies: ReadonlyArray<{
    readonly policy_id: string;
    readonly course_id: string;
    readonly course_title: string;
    readonly audience_group_id: string;
    readonly audience_label: string;
    readonly requirement_type: 'required' | 'recommended';
    readonly trigger: string;
    readonly due_relative_days: number;
    readonly created_at: string;
    readonly enabled: boolean;
  }>;
  readonly events: ReadonlyArray<{
    readonly event_id: string;
    readonly user_id: string;
    readonly course_id: string;
    readonly policy_id: string;
    readonly assigned_at: string;
    readonly due_at: string;
    readonly status: string;
    readonly completed_at?: string | null;
    readonly requirement_type: string;
  }>;
}

export interface ResolvedEnrollment {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly category: string;
  readonly requirementType: 'required' | 'recommended';
  readonly policyId: string;
  readonly assignedAt: string;
  readonly dueAt: string;
  readonly status: 'pending' | 'completed' | 'overdue';
  readonly completedAt?: string;
}

export interface DiscoverAssignedCoursesArgs {
  readonly admin: FoxxiAdminPayload;
  /** Learner web_id (matches users[*].web_id). */
  readonly learnerWebId: string;
  /** Optional override audience tags (default: derived from users[]). */
  readonly audienceTagsOverride?: readonly string[];
  /** Optional "as of" date for overdue computation; default = now. */
  readonly asOf?: Date;
}

export interface DiscoverAssignedCoursesResult {
  readonly learnerWebId: string;
  readonly learnerName?: string;
  readonly audienceTags: readonly string[];
  readonly enrollments: readonly ResolvedEnrollment[];
}

/**
 * Walk the admin payload + return the courses currently assigned to
 * this learner via policy → audience-tag matching, joined with the
 * learner's event history for completion / overdue resolution.
 */
export function discoverAssignedCourses(args: DiscoverAssignedCoursesArgs): DiscoverAssignedCoursesResult {
  const learner = args.admin.users.find(u => u.web_id === args.learnerWebId);
  if (!learner && !args.audienceTagsOverride) {
    return {
      learnerWebId: args.learnerWebId,
      audienceTags: [],
      enrollments: [],
    };
  }

  const tags = args.audienceTagsOverride ?? learner?.audience_tags ?? [];

  // Catalog course_id → entry lookup.
  const catalogIndex = new Map(args.admin.catalog.map(c => [c.course_id, c]));

  // Group lookup by group_id (membership is explicit via member_ids).
  const groupIndex = new Map(args.admin.groups.map(g => [g.group_id, g]));

  // Events per (user_id, course_id) for completion status.
  const userId = learner?.user_id;
  const eventsByCourse = new Map<string, FoxxiAdminPayload['events'][number]>();
  if (userId) {
    for (const e of args.admin.events) {
      if (e.user_id === userId) eventsByCourse.set(e.course_id, e);
    }
  }

  const asOf = args.asOf ?? new Date();
  const enrollments: ResolvedEnrollment[] = [];

  // Audience group ids the learner belongs to: either resolved by
  // explicit member_ids lookup (real shape), or by tag-derived match
  // when only audience_tags override is supplied (legacy fallback).
  const matchingGroupIds = new Set<string>();
  if (userId) {
    for (const g of args.admin.groups) {
      if (g.member_ids.includes(userId)) matchingGroupIds.add(g.group_id);
    }
  }
  // Tag-override fallback: derive group_id via the "tag-<audience-tag>"
  // convention so audience overrides still match the policy join.
  if (args.audienceTagsOverride || (!userId && tags.length > 0)) {
    for (const t of tags) matchingGroupIds.add(`tag-${t}`);
  }

  for (const policy of args.admin.policies) {
    if (!policy.enabled) continue;
    if (!matchingGroupIds.has(policy.audience_group_id)) continue;
    void groupIndex; // lookup retained for future use (group display name etc.)

    const catEntry = catalogIndex.get(policy.course_id);
    if (!catEntry) continue;

    const ev = eventsByCourse.get(policy.course_id);
    let status: 'pending' | 'completed' | 'overdue' = 'pending';
    let completedAt: string | undefined;
    const dueAt = ev?.due_at ?? deriveDueAt(policy, ev?.assigned_at ?? policy.created_at);

    if (ev?.status === 'completed' && ev.completed_at) {
      status = 'completed';
      completedAt = ev.completed_at;
    } else if (Date.parse(dueAt) < asOf.getTime()) {
      status = 'overdue';
    }

    enrollments.push({
      courseId: policy.course_id,
      courseTitle: policy.course_title,
      category: catEntry.category,
      requirementType: policy.requirement_type,
      policyId: policy.policy_id,
      assignedAt: ev?.assigned_at ?? policy.created_at,
      dueAt,
      status,
      ...(completedAt ? { completedAt } : {}),
    });
  }

  return {
    learnerWebId: args.learnerWebId,
    learnerName: learner?.name,
    audienceTags: tags,
    enrollments,
  };
}

function deriveDueAt(policy: { due_relative_days: number }, assignedAt: string): string {
  const t = new Date(assignedAt);
  t.setDate(t.getDate() + policy.due_relative_days);
  return t.toISOString().slice(0, 10);
}
