/**
 * Shared report models + pure normalizers. Built ONCE here; both the microsite
 * and the operator dashboard import this + report-views.tsx and supply their own
 * data fetch (microsite: demo-identity tokens; dashboard: the operator session).
 *
 * Pure: no React, no fetch, no app coupling — just raw bridge responses → the
 * normalized shapes the views render.
 */

export interface Counted { id: string; label: string; count: number }

export interface LrsAnalytics {
  total: number;
  errors: number;
  successRate: number;
  verbs: Counted[];
  activities: Counted[];
  actors: Counted[];
  actorKinds: Counted[];
  contextKinds: Counted[];
  hourly: Array<{ hour: string; count: number }>;
  conformance?: {
    profileId: string;
    inProfile: number;
    outOfProfile: number;
    rate: number;
    declaredVerbs: number;
    vocabularyDereferenced?: boolean;
  };
}

const tail = (iri: string): string => iri.split(/[#/:]/).filter(Boolean).pop() ?? iri;

/** Normalize /xapi/admin/aggregates (+ optional /xapi/admin/conformance). */
export function normalizeLrs(agg: Record<string, any>, conf?: Record<string, any> | null): LrsAnalytics {
  const counted = (rows: any[] | undefined, labelKey: 'display' | 'name'): Counted[] =>
    (rows ?? []).map(r => ({ id: String(r.id ?? ''), label: String(r[labelKey] ?? r.display ?? r.name ?? tail(String(r.id ?? ''))), count: Number(r.count ?? 0) }));
  return {
    total: Number(agg.total ?? 0),
    errors: Number(agg.errors ?? 0),
    successRate: Number(agg.successRate ?? 0),
    verbs: counted(agg.topVerbs, 'display'),
    activities: counted(agg.topActivities, 'name'),
    actors: counted(agg.topActors, 'name'),
    actorKinds: (agg.byActorKind ?? []).map((r: any) => ({ id: String(r.id), label: String(r.id), count: Number(r.count ?? 0) })),
    contextKinds: (agg.byContextKind ?? []).map((r: any) => ({ id: String(r.id), label: String(r.id), count: Number(r.count ?? 0) })),
    hourly: (agg.hourlyVolume ?? []).map((p: [string, number]) => ({ hour: p[0], count: Number(p[1] ?? 0) })),
    conformance: conf ? {
      profileId: String(conf.profileId ?? ''),
      inProfile: Number(conf.inProfile ?? 0),
      outOfProfile: Number(conf.outOfProfile ?? 0),
      rate: Number(conf.profileConformanceRate ?? 0),
      declaredVerbs: Number(conf.declaredVerbs ?? 0),
      vocabularyDereferenced: conf.vocabularyDereferenced,
    } : undefined,
  };
}

// ── LMS completions (computed from the statement stream) ────────────────

export interface StatementLike {
  verb?: { id?: string; display?: Record<string, string> };
  object?: { id?: string; definition?: { name?: Record<string, string>; type?: string } };
  result?: { success?: boolean; completion?: boolean; score?: { scaled?: number } };
}
export interface CourseCompletion {
  course: string;
  title: string;
  launched: number;
  completed: number;
  passed: number;
  failed: number;
  passRate: number | null;
  avgScore: number | null;
}
export interface LmsCompletions {
  courses: CourseCompletion[];
  totalCompleted: number;
  totalPassed: number;
  totalFailed: number;
}

const LMS_VERBS = new Set(['launched', 'initialized', 'experienced', 'completed', 'passed', 'failed', 'satisfied', 'terminated']);

/** Group a statement page into per-course (object) completion metrics. */
export function lmsFromStatements(statements: StatementLike[]): LmsCompletions {
  const byCourse = new Map<string, CourseCompletion & { _scoreSum: number; _scoreN: number }>();
  let totalCompleted = 0, totalPassed = 0, totalFailed = 0;
  for (const s of statements) {
    const verb = tail(String(s.verb?.id ?? ''));
    if (!LMS_VERBS.has(verb)) continue;
    const id = String(s.object?.id ?? '');
    if (!id) continue;
    const title = s.object?.definition?.name?.en ?? tail(id);
    let c = byCourse.get(id);
    if (!c) { c = { course: id, title, launched: 0, completed: 0, passed: 0, failed: 0, passRate: null, avgScore: null, _scoreSum: 0, _scoreN: 0 }; byCourse.set(id, c); }
    if (verb === 'launched' || verb === 'initialized') c.launched++;
    else if (verb === 'completed') { c.completed++; totalCompleted++; }
    else if (verb === 'passed') { c.passed++; totalPassed++; }
    else if (verb === 'failed') { c.failed++; totalFailed++; }
    const sc = s.result?.score?.scaled;
    if (typeof sc === 'number') { c._scoreSum += sc; c._scoreN++; }
  }
  const courses = [...byCourse.values()].map(c => {
    const graded = c.passed + c.failed;
    return { course: c.course, title: c.title, launched: c.launched, completed: c.completed, passed: c.passed, failed: c.failed,
      passRate: graded > 0 ? c.passed / graded : null,
      avgScore: c._scoreN > 0 ? c._scoreSum / c._scoreN : null };
  }).sort((a, b) => (b.completed + b.passed) - (a.completed + a.passed));
  return { courses, totalCompleted, totalPassed, totalFailed };
}

// ── Per-subject record (ELR competencies + CLR credentials) ─────────────

export interface SubjectCompetency { label: string; basis: string; modalStatus: string; successRate?: number | null }
export interface SubjectCredential { name: string; issuer?: string; issuedAt?: string }
export interface SubjectRecord {
  did: string;
  statementCount: number;
  competencies: SubjectCompetency[];
  credentials: SubjectCredential[];
  error?: string;
}

/** Normalize a /agent/review-record response (ELR + optional CLR). */
export function subjectFromReview(did: string, body: Record<string, any>): SubjectRecord {
  if (!body || body.ok === false) return { did, statementCount: 0, competencies: [], credentials: [], error: String(body?.error ?? 'review-record failed') };
  const comps = (body.elr?.competencies ?? []) as Array<Record<string, any>>;
  const competencies: SubjectCompetency[] = comps.map(c => ({
    label: String(c.label ?? c.id ?? 'competency'),
    basis: String(c.basis ?? ''),
    modalStatus: String(c.modalStatus ?? ''),
    successRate: c.evidenceSummary?.performanceSuccessRate ?? null,
  }));
  const clr = body.clr as Record<string, any> | undefined;
  const entries = (clr?.credentialEntries ?? clr?.verifiableCredential ?? clr?.credentials ?? []) as any[];
  const credentials: SubjectCredential[] = (Array.isArray(entries) ? entries : []).map((e: any) => {
    const subj = e?.credential?.credentialSubject ?? e?.credentialSubject ?? e;
    const name = subj?.achievement?.name ?? subj?.achievement?.[0]?.name ?? e?.name ?? e?.label ?? 'credential';
    return { name: String(name), issuer: e?.credential?.issuer?.id ?? e?.issuer?.id ?? e?.issuer, issuedAt: e?.credential?.validFrom ?? e?.validFrom ?? e?.issuedAt };
  });
  return { did, statementCount: Number(body.subject?.statementCount ?? 0), competencies, credentials };
}
