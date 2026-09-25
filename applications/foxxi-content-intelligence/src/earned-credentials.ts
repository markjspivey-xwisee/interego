/**
 * Credentials earned from evidence: what a learner has demonstrated, what that entitles them
 * to claim, what they already hold, and what a verifier should check before believing one.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * On 2026-09-24 the tenant could issue an Open Badges 3.0 credential into a learner's pod
 * wallet, but only from claims the admin typed in: nothing looked at what the learner had
 * actually done, nothing told a learner what they were ready to claim, and a verifier that
 * checked the signature checked nothing else — not the expiry, not whether the issuer was one
 * the tenant stands behind. This module is the pure logic between the learner's record and
 * the credential: the mastery evidence in their xAPI statements, the decision a claim gets
 * (issue, already held, not earned), the state of every assigned course, and the checks a
 * credential must pass. The bridge reads the pod and signs; nothing here does either.
 */
/** A stored xAPI statement as the bridge keeps them: the lens, the lattice and the durable records all have this shape. */
export interface StatementRecord {
  readonly id: string;
  readonly statement: Record<string, unknown>;
  readonly voided: boolean;
}

const ADL = 'http://adlnet.gov/expapi/verbs/';
const CMI5 = 'https://w3id.org/xapi/adl/verbs/';

/**
 * The verbs whose statement demonstrates the course was mastered: ADL passed / mastered, cmi5
 * satisfied / waived. Not `completed`: the SCORM engine records `completed` beside `failed` for an
 * attempt that did not pass (2026-09-25, found reading emitScormCompletion), and in xAPI completing
 * a course says nothing about passing it.
 */
export const MASTERY_VERBS: ReadonlySet<string> = new Set([`${ADL}passed`, `${ADL}mastered`, `${CMI5}satisfied`, `${CMI5}waived`]);

export interface EvidenceStatement {
  readonly id: string;
  readonly verb: string;
  readonly object: string;
  readonly timestamp?: string;
  readonly scoreScaled?: number;
  readonly success?: boolean;
  /** Whether the bridge graded this result itself, when a rule for that was given. */
  readonly graded?: boolean;
  /** Whether this statement demonstrates mastery under the course's threshold, graded by the bridge when a rule for that was given. */
  readonly mastery: boolean;
}

export interface CourseIdentity {
  readonly courseId: string;
  /** Every IRI the course is known by: the catalog's, the SCORM engine's, the cmi5 activity's. */
  readonly courseIris: readonly string[];
  /** The scaled score a mastery statement must reach, when the course sets one. */
  readonly masteryScore?: number;
}

export interface MasteryEvidence {
  readonly courseId: string;
  /** Every statement of the learner about the course, mastery or not. */
  readonly statements: readonly EvidenceStatement[];
  /** The statements that demonstrate mastery. */
  readonly mastery: readonly EvidenceStatement[];
  /** Mastery-shaped statements the bridge did not grade: in the record, not evidence. */
  readonly unattested: number;
  readonly earned: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Every identifier an xAPI actor carries, so a learner known by WebID, wallet DID or account name is matched by any. */
export function actorIdentifiers(actor: unknown): string[] {
  const a = obj(actor);
  if (!a) return [];
  const out: string[] = [];
  for (const k of ['mbox', 'mbox_sha1sum', 'openid']) { const v = str(a[k]); if (v) out.push(v); }
  const account = obj(a['account']);
  if (account) { for (const k of ['homePage', 'name']) { const v = str(account[k]); if (v) out.push(v); } }
  return out;
}

/** Whether a statement is about the course: its object is one of the course's IRIs or sits under one, or the course is its parent or grouping. */
export function aboutCourse(statement: Record<string, unknown>, course: CourseIdentity): boolean {
  const under = (id: string | undefined): boolean => !!id && course.courseIris.some((iri) => id === iri || id.startsWith(`${iri}/`) || id.startsWith(`${iri}#`) || id.startsWith(`${iri}?`));
  const object = obj(statement['object']);
  if (under(str(object?.['id']))) return true;
  const context = obj(statement['context']);
  const activities = obj(context?.['contextActivities']);
  for (const k of ['parent', 'grouping']) {
    const list = activities?.[k];
    if (Array.isArray(list) && list.some((x) => under(str(obj(x)?.['id'])))) return true;
  }
  return false;
}

/**
 * The learner's evidence about a course, mastery decided per statement by verb, success and the
 * course's threshold, and — when `attested` is given — by whether the bridge graded the result
 * itself, since a statement the learner wrote into their own record is not evidence of mastery.
 */
export function masteryEvidence(course: CourseIdentity, statements: readonly StatementRecord[], learner?: string, attested?: (statement: Record<string, unknown>) => boolean): MasteryEvidence {
  const out: EvidenceStatement[] = [];
  let unattested = 0;
  for (const s of statements) {
    if (s.voided) continue;
    const st = s.statement;
    if (!aboutCourse(st, course)) continue;
    if (learner && !actorIdentifiers(st['actor']).some((id) => id === learner || id.toLowerCase() === learner.toLowerCase())) continue;
    const verb = str(obj(st['verb'])?.['id']) ?? '';
    const result = obj(st['result']);
    const score = obj(result?.['score']);
    const scaled = typeof score?.['scaled'] === 'number' ? (score['scaled'] as number) : undefined;
    const success = typeof result?.['success'] === 'boolean' ? (result['success'] as boolean) : undefined;
    const shaped = MASTERY_VERBS.has(verb) && success !== false && (course.masteryScore === undefined || scaled === undefined || scaled >= course.masteryScore);
    const graded = attested ? attested(st) : undefined;
    const mastery = shaped && graded !== false;
    if (shaped && graded === false) unattested += 1;
    out.push({ id: s.id || (str(st['id']) ?? ''), verb, object: str(obj(st['object'])?.['id']) ?? '', ...(str(st['timestamp']) ? { timestamp: str(st['timestamp']) } : {}), ...(scaled !== undefined ? { scoreScaled: scaled } : {}), ...(success !== undefined ? { success } : {}), ...(graded !== undefined ? { graded } : {}), mastery });
  }
  const mastery = out.filter((e) => e.mastery);
  return { courseId: course.courseId, statements: out, mastery, unattested, earned: mastery.length > 0 };
}

/**
 * The courses a learner's record is about: every course id `idOf` reads from a statement's object
 * or its parent and grouping activities, in first-seen order. Standings that follow the record
 * rather than an assignment start here.
 */
export function courseIdsInRecord(statements: readonly StatementRecord[], idOf: (iri: string) => string | null): string[] {
  const ids = new Set<string>();
  const take = (v: unknown): void => { const id = typeof v === 'string' ? idOf(v) : null; if (id) ids.add(id); };
  for (const s of statements) {
    if (s.voided) continue;
    take(obj(s.statement['object'])?.['id']);
    const activities = obj(obj(s.statement['context'])?.['contextActivities']);
    for (const k of ['parent', 'grouping']) { const list = activities?.[k]; if (Array.isArray(list)) for (const a of list) take(obj(a)?.['id']); }
  }
  return [...ids];
}

export interface HeldCredential {
  readonly id: string;
  readonly descriptorUrl: string;
  readonly achievementId?: string;
  readonly issuer: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  /** Whether its proof verified when it was read. */
  readonly verified: boolean;
}

/** A held credential still counts when its proof verified and it has not expired. */
export function credentialInForce(c: HeldCredential, now: Date): boolean {
  if (!c.verified) return false;
  if (c.validUntil && Date.parse(c.validUntil) < now.getTime()) return false;
  return true;
}

export interface ClaimPolicy {
  /** The achievement the course confers; a held credential for it is the same credential. */
  readonly achievementId: string;
  /** How long an issued credential stays valid. */
  readonly validityDays: number;
}

export type ClaimDecision =
  | { readonly decision: 'issue'; readonly validUntil: string; readonly evidence: readonly EvidenceStatement[] }
  | { readonly decision: 'already-held'; readonly credential: HeldCredential }
  | { readonly decision: 'not-earned'; readonly missing: string; readonly statements: number };

/** What a claim gets: the credential it already holds, a new one from its mastery evidence, or the evidence it still lacks. */
export function claimDecision(evidence: MasteryEvidence, held: readonly HeldCredential[], policy: ClaimPolicy, now: Date): ClaimDecision {
  const inForce = held.filter((c) => c.achievementId === policy.achievementId && credentialInForce(c, now)).sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  const current = inForce[0];
  if (current) return { decision: 'already-held', credential: current };
  if (evidence.earned) {
    const until = new Date(now.getTime() + Math.max(1, policy.validityDays) * 86_400_000);
    return { decision: 'issue', validUntil: until.toISOString(), evidence: evidence.mastery };
  }
  const missing = evidence.statements.length === 0
    ? `no statement of the learner about the course; a passed, mastered, satisfied or waived statement${evidence.courseId ? ` for ${evidence.courseId}` : ''}, graded by this bridge, would earn it`
    : evidence.unattested > 0
      ? `${evidence.unattested} mastery statement(s) about the course that this bridge did not grade itself (a learner's own report is in the record but is not evidence); a result graded here would earn it`
      : `${evidence.statements.length} statement(s) about the course, none of which demonstrates mastery (a passed, mastered, satisfied or waived statement with success not false and any score at or above the course's threshold)`;
  return { decision: 'not-earned', missing, statements: evidence.statements.length };
}

export type CourseState = 'credentialed' | 'claimable' | 'in-progress' | 'not-started';

export interface CourseStanding {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly state: CourseState;
  readonly dueAt?: string;
  readonly credential?: HeldCredential;
  /** A credential the learner holds for the course that no longer counts, when the state is not credentialed. */
  readonly lapsed?: HeldCredential;
  readonly statements: number;
  readonly mastery: number;
}

const STATE_ORDER: Record<CourseState, number> = { claimable: 0, 'in-progress': 1, 'not-started': 2, credentialed: 3 };

/** Where each assigned course stands for the learner: credentialed, claimable from evidence, in progress, or not started; the claimable first. */
export function courseStandings(
  enrollments: readonly { readonly courseId: string; readonly courseTitle: string; readonly dueAt?: string }[],
  evidenceByCourse: ReadonlyMap<string, MasteryEvidence>,
  held: readonly HeldCredential[],
  achievementIdOf: (courseId: string) => string,
  now: Date,
): CourseStanding[] {
  const standings: CourseStanding[] = enrollments.map((e) => {
    const achievement = achievementIdOf(e.courseId);
    const forCourse = held.filter((c) => c.achievementId === achievement);
    const current = forCourse.find((c) => credentialInForce(c, now));
    const lapsed = current ? undefined : forCourse.sort((a, b) => (b.validUntil ?? '').localeCompare(a.validUntil ?? ''))[0];
    const ev = evidenceByCourse.get(e.courseId);
    const statements = ev?.statements.length ?? 0;
    const mastery = ev?.mastery.length ?? 0;
    const state: CourseState = current ? 'credentialed' : ev?.earned ? 'claimable' : statements > 0 ? 'in-progress' : 'not-started';
    return { courseId: e.courseId, courseTitle: e.courseTitle, state, ...(e.dueAt ? { dueAt: e.dueAt } : {}), ...(current ? { credential: current } : {}), ...(lapsed ? { lapsed } : {}), statements, mastery };
  });
  return standings.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || a.courseId.localeCompare(b.courseId));
}

export interface VerificationChecks {
  /** The Data Integrity proof verified against the issuer's key. */
  readonly signature: boolean;
  /** validUntil, when present, has not passed. */
  readonly notExpired: boolean;
  /** validFrom, when present, has passed. */
  readonly inForce: boolean;
  /** The issuer is one the verifier trusts: the tenant's own, or a listed one. */
  readonly issuerTrusted: boolean;
  /** The credential names its subject. */
  readonly subjectBound: boolean;
}

export interface CredentialVerification {
  readonly valid: boolean;
  readonly checks: VerificationChecks;
  readonly issuer?: string;
  readonly subject?: string;
  readonly achievement?: { readonly id?: string; readonly name?: string };
  readonly validFrom?: string;
  readonly validUntil?: string;
  /** What each failed check found, in words. */
  readonly notes: readonly string[];
}

/**
 * The checks a verifier makes beyond the proof: expiry, the validity window, the issuer's
 * standing, and that the credential names a subject. `proof` is the outcome of verifying the
 * Data Integrity proof, which the caller performs; `trustedIssuers` are the DIDs the verifier
 * stands behind (an empty list trusts no issuer).
 */
export function verifyCredentialChecks(
  credential: Record<string, unknown>,
  proof: { readonly verified: boolean; readonly issuerDid?: string; readonly reason?: string },
  trustedIssuers: readonly string[],
  now: Date,
): CredentialVerification {
  const issuerRaw = credential['issuer'];
  const issuer = str(issuerRaw) ?? str(obj(issuerRaw)?.['id']);
  const subjectObj = obj(credential['credentialSubject']);
  const subject = str(subjectObj?.['id']);
  const achievementObj = obj(subjectObj?.['achievement']);
  const validFrom = str(credential['validFrom']);
  const validUntil = str(credential['validUntil']);
  const notes: string[] = [];
  const signature = proof.verified && (!issuer || !proof.issuerDid || proof.issuerDid === issuer);
  if (!proof.verified) notes.push(`the proof did not verify${proof.reason ? `: ${proof.reason}` : ''}`);
  else if (issuer && proof.issuerDid && proof.issuerDid !== issuer) notes.push(`the proof was made by ${proof.issuerDid}, not the stated issuer ${issuer}`);
  const notExpired = !validUntil || Date.parse(validUntil) >= now.getTime();
  if (!notExpired) notes.push(`expired on ${validUntil}`);
  const inForce = !validFrom || Date.parse(validFrom) <= now.getTime();
  if (!inForce) notes.push(`not in force until ${validFrom}`);
  const issuerTrusted = !!issuer && trustedIssuers.includes(issuer);
  if (!issuerTrusted) notes.push(issuer ? `the issuer ${issuer} is not among the ${trustedIssuers.length} trusted issuer(s)` : 'the credential names no issuer');
  const subjectBound = !!subject;
  if (!subjectBound) notes.push('the credential names no subject');
  const checks: VerificationChecks = { signature, notExpired, inForce, issuerTrusted, subjectBound };
  return {
    valid: Object.values(checks).every(Boolean), checks, ...(issuer ? { issuer } : {}), ...(subject ? { subject } : {}),
    ...(achievementObj ? { achievement: { ...(str(achievementObj['id']) ? { id: str(achievementObj['id']) } : {}), ...(str(achievementObj['name']) ? { name: str(achievementObj['name']) } : {}) } } : {}),
    ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}), notes,
  };
}
