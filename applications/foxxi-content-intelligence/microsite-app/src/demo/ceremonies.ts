/**
 * Scripted, NO-KEY demo ceremonies — every step is a REAL rev-196 signed call to
 * the live Foxxi bridge (no LLM, no API key, no pre-provisioning). These compose
 * the SAME affordances the BYOK agent demo uses; the difference is the sequence is
 * fixed (deterministic) rather than model-emergent, so a visitor with no Anthropic
 * key still drives the full self-sovereign arc.
 *
 * Used by:
 *   - Portfolio (hiring): build a credentialed candidate, then a FRESH employer
 *     re-verifies + decides against a job spec, and records the decision back.
 *   - Evidence Ledger: perform a signed action + assemble a verifiable pack.
 *
 * Honest degradation: if the deployment has no issuer seed (issue-credential /
 * prove-competency → 503), the engine-graded + cross-agent-read + signature parts
 * still run and the missing pieces are flagged, never faked.
 */
import { freshAgent, postSigned, postPlain, type AgentWallet } from './agent-signing.js';

// Thin wrappers: the bridge body is `unknown`; these demos read many response
// fields, so narrow to `any` once here rather than casting at every access.
async function sCall(path: string, a: AgentWallet, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await postSigned(path, a, args); return { ok: r.ok, status: r.status, body: r.body as any };
}
async function pCall(path: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await postPlain(path, args); return { ok: r.ok, status: r.status, body: r.body as any };
}

export const STD_EXT_IRI =
  'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

export type CeremonyKind =
  | 'identity' | 'phase' | 'call' | 'result' | 'verify' | 'credential'
  | 'disclosure' | 'decision' | 'evidence' | 'error';

export interface CeremonyEvent {
  id: number;
  actor: string;       // display label, e.g. 'Training authority', 'Employer'
  kind: CeremonyKind;
  title: string;
  detail?: string;
  data?: unknown;
  ts: string;
}
export type Emit = (e: Omit<CeremonyEvent, 'id' | 'ts'>) => void;

export const PROFICIENCY_ORDER = ['Novice', 'Beginner', 'Intermediate', 'Advanced', 'Expert'] as const;
export type Proficiency = typeof PROFICIENCY_ORDER[number];

/** A disclosed BBS+ claim normalized to { path, value } regardless of wire shape. */
function normalizeDisclosed(raw: unknown): Array<{ path: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => {
    if (d && typeof d.path === 'string' && typeof d.value === 'string') return { path: d.path, value: d.value };
    if (d && typeof d.displayValue === 'string') {
      const [path, ...rest] = d.displayValue.split('=');
      return { path: d.path ?? path, value: rest.join('=') };
    }
    return { path: String(d?.path ?? ''), value: String(d?.value ?? '') };
  }).filter(x => x.path);
}

export interface JobSpec {
  role: string;
  requiredCompetency: string;
  minProficiency: Proficiency;
  tamperEvidentRequired: boolean;
}

export interface Decision { verdict: 'ACCEPT' | 'REJECT' | 'UNDECIDABLE'; reasons: string[]; matched: Record<string, boolean> }

/**
 * The deterministic hiring decision — the net-new logic. Maps the employer's
 * INDEPENDENT verification (verify-extension `checks`) + the BBS+ presentation it
 * cryptographically confirmed against the job spec. No LLM, fully auditable.
 */
export function decide(spec: JobSpec, verify: any, presentationVerified: boolean, disclosedRaw: unknown): Decision {
  const reasons: string[] = [];
  const matched: Record<string, boolean> = {};
  const checks = verify?.checks ?? {};
  const disclosed = normalizeDisclosed(disclosedRaw);
  // Read proficiency ONLY from a proficiency-named path (no value-sniffing across
  // unrelated fields — a competency value that happened to equal a level name must
  // not be mistaken for the proficiency).
  const provVal = disclosed.find(x => /proficien/i.test(x.path))?.value;
  const compVal = disclosed.find(x => /competen|achiev|name/i.test(x.path))?.value;
  const engineGraded = !!checks.independentlyGraded && !!checks.shapeConformant;

  matched.proofValid = presentationVerified === true;
  if (!matched.proofValid) reasons.push('the BBS+ presentation did not cryptographically verify');

  if (spec.tamperEvidentRequired) {
    matched.tamperEvident = engineGraded;
    if (!matched.tamperEvident) reasons.push('the load-bearing competency is not backed by tamper-evident evidence (engine grading + shape conformance)');
  } else {
    matched.tamperEvident = true; // not required by this spec — self-attested accepted
  }

  matched.proficiency = !!provVal && PROFICIENCY_ORDER.indexOf(provVal as Proficiency) >= PROFICIENCY_ORDER.indexOf(spec.minProficiency);
  if (!matched.proficiency) reasons.push(`disclosed proficiency ${provVal ?? '(none)'} is below the required ${spec.minProficiency}`);

  const verdict = reasons.length === 0 ? 'ACCEPT' : 'REJECT';
  if (verdict === 'ACCEPT') {
    // Word the rationale to EXACTLY what was verified.
    const backing = engineGraded
      ? `backed by tamper-evident evidence (engine grading + shape conformance) at ${provVal} — decided on the candidate's own verifiable records, not its say-so`
      : `accepted at ${provVal} on self-attested evidence (this job spec did not require tamper-evident grading)`;
    reasons.push(`competency "${compVal ?? spec.requiredCompetency}" ${backing}`);
  }
  return { verdict, reasons, matched };
}

let counter = 0;
const stamp = (e: Omit<CeremonyEvent, 'id' | 'ts'>): CeremonyEvent => ({ ...e, id: counter++, ts: new Date().toISOString() });
export function makeEmit(push: (e: CeremonyEvent) => void): Emit { return e => push(stamp(e)); }
export function resetCounter(): void { counter = 0; }

/** Result of building a candidate with a real, engine-graded, credentialed record. */
export interface Candidate {
  T: AgentWallet; K: AgentWallet; courseId: string;
  passed: boolean; verificationHolonUri?: string;
  credentialIssued: boolean; issuerUnavailable: boolean;
  extensionName: string;
}

/**
 * Build a candidate with a REAL track record: a training authority T authors a
 * SCORM course, candidate K completes it (engine-graded SN rollup → real xAPI),
 * performs the skill + a transfer onto an untaught standard, then T independently
 * verifies and issues an OB3 credential justified_by the verification holon.
 */
export async function buildCredentialedCandidate(emit: Emit): Promise<Candidate> {
  const T = freshAgent();
  const K = freshAgent();
  const courseId = `agp-hire-${T.address.slice(2, 8)}`;
  const extensionName = 'collaborationDepth';
  emit({ actor: 'Training authority', kind: 'identity', title: 'fresh wallet — no account, no OAuth, no directory row', detail: T.did });
  emit({ actor: 'Candidate', kind: 'identity', title: 'fresh wallet — no account, no OAuth, no directory row', detail: K.did });

  emit({ actor: 'Training authority', kind: 'phase', title: 'Authors a standards-conformant SCORM course' });
  await pCall('/agent/extend-standards', { kind: 'XapiProfileFragment', name: 'hireCoaching', definition: 'Verbs for coaching the standards-extension skill.' });
  const author = await sCall('/agent/scorm/author', T, { course: {
    courseId, title: 'Extend a standard (xAPI / IEEE-LER / ADL-TLA)', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard',
      body: 'Discover /guidance, then POST /agent/extend-standards. WHAT you did rides in the object’s conformsTo, not the verb.',
      assessment: [
        { question: 'Which affordance extends a standard?', answer: 'extend_standards' },
        { question: 'Where does WHAT-was-done ride (not the verb)?', answer: 'object' },
      ] }],
  } });
  emit({ actor: 'Training authority', kind: 'result', title: `SCORM course authored — ${author.body?.manifestValid ? 'manifest valid' : 'authored'}`, detail: `${courseId} · real SCORM 2004 SN manifest`, data: author.body });

  emit({ actor: 'Candidate', kind: 'phase', title: 'Completes the course — graded by the real SCORM SN runtime' });
  const launch = await sCall('/agent/scorm/launch', K, { course_id: courseId, author_did: T.did });
  const sid = launch.body?.sessionId as string;
  let passed = false, last: any = null, guard = 0;
  while (!last?.done && guard++ < 6) {
    const sub = await sCall('/agent/scorm/submit', K, { session_id: sid, answers: ['extend_standards', 'object'] });
    last = sub.body;
    if (sub.status !== 200) break;
  }
  passed = last?.passed === true;
  emit({ actor: 'Candidate', kind: 'result', title: `Course ${passed ? 'PASSED' : 'completed'} (engine-graded)`, detail: `score ${last?.score} · ${last?.recordedStatements} xAPI statements rolled up — tamper-evident`, data: last });

  emit({ actor: 'Candidate', kind: 'phase', title: 'Performs the skill, then proves TRANSFER on an untaught standard' });
  await sCall('/agent/record-performance', K, { task_name: 'Extend an xAPI standard', success: true, quality: 0.9, activity_type: STD_EXT_IRI });
  await pCall('/agent/extend-standards', { kind: 'LerTerm', name: extensionName, definition: 'Depth of cross-agent collaboration evidenced in a performance.' });
  const transfer = await sCall('/agent/record-performance', K, { task_name: 'Extend an untaught IEEE-LER standard', success: true, quality: 0.88, activity_type: STD_EXT_IRI });
  emit({ actor: 'Candidate', kind: 'result', title: 'Skill performed + generalized to an untaught standard', detail: 'transfer, not memorization — real signed xAPI on the candidate’s own pod', data: transfer.body });

  emit({ actor: 'Training authority', kind: 'phase', title: 'Independently verifies the transfer, then credentials it' });
  const ver = await sCall('/agent/verify-extension', T, { subject_did: K.did, name: extensionName, kind: 'XapiContextExtension' });
  emit({ actor: 'Training authority', kind: 'verify', title: `Independent verification — ${ver.body?.verified ? 'PASSED' : 'INSUFFICIENT'}`, detail: `engine-graded:${ver.body?.checks?.independentlyGraded} · shape-conformant:${ver.body?.checks?.shapeConformant}`, data: ver.body });
  const verificationHolonUri = ver.body?.verificationHolonUri as string | undefined;

  let credentialIssued = false, issuerUnavailable = false;
  const cred = await sCall('/agent/issue-credential', T, { recipient_did: K.did, competency_name: 'Standards Extension', achievement_description: 'Demonstrated extending a standard after an engine-graded course.', justified_by: verificationHolonUri });
  if (cred.status === 200 && cred.body?.ok !== false) {
    credentialIssued = true;
    emit({ actor: 'Training authority', kind: 'credential', title: 'OB3 credential issued to the candidate', detail: 'Standards Extension · justified_by the dereferenceable verification holon (chain of custody)', data: cred.body });
  } else if (cred.status === 503) {
    issuerUnavailable = true;
    emit({ actor: 'Training authority', kind: 'error', title: 'Credential issuance not configured on this deployment', detail: 'issue-credential → 503 (issuer seed unset). The engine-graded + verification evidence above is still real and independently checkable.', data: cred.body });
  } else {
    emit({ actor: 'Training authority', kind: 'error', title: 'Credential issuance failed', detail: `HTTP ${cred.status}`, data: cred.body });
  }

  return { T, K, courseId, passed, verificationHolonUri, credentialIssued, issuerUnavailable, extensionName };
}

export interface Evaluation {
  decision: Decision;
  verify: any;
  presentationVerified: boolean;
  disclosed: Array<{ path: string; value: string }>;
  revealed: Array<{ path: string; value: string }>;
  hiddenPaths: string[];
  reviewedStatements?: number;
}

/**
 * A FRESH employer with no prior relationship reads the candidate's OWN pod,
 * independently re-verifies, has the candidate prove the competency via BBS+
 * (score hidden), verifies the proof, decides against the spec, and records the
 * decision back onto the substrate (the verification act becomes itself evidence).
 */
export async function evaluateCandidate(
  emit: Emit, candidate: Candidate, spec: JobSpec,
): Promise<Evaluation> {
  const E = freshAgent();
  const { K, T, extensionName } = candidate;
  emit({ actor: 'Employer', kind: 'identity', title: 'fresh employer wallet — no prior relationship to the candidate', detail: E.did });

  emit({ actor: 'Employer', kind: 'phase', title: `Hiring for: ${spec.role}` });
  const review = await sCall('/agent/review-record', E, { subject_did: K.did, include_clr: true });
  const reviewedStatements = review.body?.subject?.statementCount;
  emit({ actor: 'Employer', kind: 'result', title: 'Read the candidate’s OWN pod (cross-agent, no admin token)', detail: `${reviewedStatements ?? 0} statements on the candidate’s pod — the records the candidate holds itself`, data: review.body?.elr ?? review.body });

  const verify = (await sCall('/agent/verify-extension', E, { subject_did: K.did, name: extensionName, kind: 'XapiContextExtension' })).body;
  emit({ actor: 'Employer', kind: 'verify', title: `Independently re-verified the candidate — ${verify?.verified ? 'CONFIRMED' : 'INSUFFICIENT'}`, detail: 'the employer re-ran verification from scratch against the candidate’s pod — not trusting the candidate or the authority', data: verify });

  // Candidate proves the competency privately — score cryptographically hidden.
  const prove = (await sCall('/agent/prove-competency', K, { issuer_did: T.did, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' })).body;
  const revealed = Array.isArray(prove?.revealed) ? prove.revealed : [];
  const hiddenPaths = Array.isArray(prove?.hiddenPaths) ? prove.hiddenPaths : [];
  let presentationVerified = false;
  let disclosed: Array<{ path: string; value: string }> = [];
  if (prove?.presentation) {
    emit({ actor: 'Candidate', kind: 'disclosure', title: 'Proves the competency via BBS+ — reveals proficiency, hides the score', detail: `revealed ${revealed.length} · hidden ${hiddenPaths.length} (score, name, dates, id)`, data: prove });
    const vp = (await sCall('/agent/verify-presentation', E, { presentation: prove.presentation })).body;
    presentationVerified = vp?.verified === true;
    disclosed = normalizeDisclosed(vp?.disclosed);
    emit({ actor: 'Employer', kind: 'verify', title: `BBS+ presentation ${presentationVerified ? 'VERIFIED' : 'FAILED'}`, detail: `learned only: ${disclosed.map(d => d.path.replace(/^achievement\./, '')).join(', ') || '—'} — the score stayed hidden`, data: vp });
  } else if (prove?.error || candidate.issuerUnavailable) {
    emit({ actor: 'Candidate', kind: 'error', title: 'Private proof unavailable on this deployment', detail: 'prove-competency requires the issuer seed — the independent verification above still stands.', data: prove });
  }

  // If the private proof is unavailable because the deployment lacks an issuer
  // seed (the documented honest-degradation path), do NOT feed empty disclosure
  // into decide() — that would REJECT a possibly-qualified candidate. Surface it
  // as UNDECIDABLE so "deployment can't issue proofs" is never read as "unqualified".
  const decision: Decision = (!prove?.presentation && (candidate.issuerUnavailable || prove?.error))
    ? { verdict: 'UNDECIDABLE', reasons: ['the BBS+ private proof is unavailable on this deployment (issuer seed unset) — the independent engine-graded verification above still stands; the proficiency proof could not be produced'], matched: { proofValid: false, tamperEvident: !!verify?.checks?.independentlyGraded && !!verify?.checks?.shapeConformant, proficiency: false } }
    : decide(spec, verify, presentationVerified, disclosed.length ? disclosed : revealed);
  emit({ actor: 'Employer', kind: 'decision', title: `Decision: ${decision.verdict}`, detail: decision.reasons.join(' · '), data: decision });

  // Recursion close (dogfooding): the employer records its decision back onto the
  // substrate — the verification act is now itself dereferenceable, signed evidence.
  const rec = await sCall('/agent/record-performance', E, {
    task_name: `Hiring decision: ${decision.verdict} for ${spec.role}`,
    success: decision.verdict === 'ACCEPT', quality: 1, activity_type: STD_EXT_IRI,
  });
  emit({ actor: 'Employer', kind: 'evidence', title: 'Recorded the decision back onto the substrate', detail: 'the hiring decision is now itself a signed, dereferenceable record — verification all the way down', data: rec.body });

  return { decision, verify, presentationVerified, disclosed, revealed, hiddenPaths, reviewedStatements };
}
