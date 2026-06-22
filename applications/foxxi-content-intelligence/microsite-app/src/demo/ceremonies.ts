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
import { dispatchTool, toolList, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';

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

// ── BYOK variant: the employer is a REAL LLM agent ───────────────────────────
// Same arc, but the hire DECISION is made by a genuine Claude agent (not the
// deterministic decide() above). The employer reasons over the live substrate
// with the bridge endpoints as its tools — review_record / verify_extension /
// verify_presentation / record_performance. Crypto stays deterministic: the tools
// return REAL cryptographic results from the bridge that the model cannot fake; the
// model's contribution is the JUDGMENT (does this verified evidence meet the spec?),
// not the verification itself. Requires an Anthropic key.

const EMPLOYER_SYS =
  'You are a hiring agent on the Interego/Foxxi substrate with a self-sovereign did:ethr identity and NO prior relationship to the candidate. You act ONLY through the provided tools — real signed calls to the live bridge that return REAL cryptographic results you cannot fake. Be decisive and skeptical: verify before you trust, decide strictly on what you can INDEPENDENTLY verify against the requirement, and never ask questions. Finish with exactly one line: "DECISION: ACCEPT|REJECT|UNDECIDABLE — <one-sentence rationale citing what you verified>".';

const summarizeInput = (name: string, i: Record<string, unknown>): string => {
  if (name === 'review_record') return `subject ${String(i.subject_did ?? '(candidate)').slice(0, 18)}…`;
  if (name === 'verify_extension') return `subject ${String(i.subject_did ?? '(candidate)').slice(0, 14)}… · ${String(i.name ?? '')}`;
  if (name === 'verify_presentation') return 'the candidate’s BBS+ proof';
  if (name === 'record_performance') return String(i.task_name ?? '');
  return '';
};
const interpretResult = (name: string, b: any): string => {
  if (name === 'review_record') return `${b?.subject?.statementCount ?? 0} statements on the candidate’s own pod`;
  if (name === 'verify_extension') return `verified:${b?.verified} · engine-graded:${b?.checks?.independentlyGraded} · shape-conformant:${b?.checks?.shapeConformant}`;
  if (name === 'verify_presentation') return `verified:${b?.verified} · disclosed: ${normalizeDisclosed(b?.disclosed).map(d => d.path.replace(/^achievement\./, '')).join(', ') || '—'} (score stayed hidden)`;
  if (name === 'record_performance') return `recorded · statement ${String(b?.statementId ?? '').slice(0, 8)}…`;
  return b?.error ? `error: ${b.error}` : '';
};

export async function evaluateCandidateLLM(
  apiKey: string, emit: Emit, candidate: Candidate, spec: JobSpec,
): Promise<Evaluation> {
  const E = freshAgent();
  const { K, T, extensionName } = candidate;
  emit({ actor: 'Employer', kind: 'identity', title: 'fresh employer AGENT (a real LLM) — no prior relationship to the candidate', detail: E.did });

  // The candidate derives a BBS+ selective-disclosure proof — its OWN action, signed
  // by the candidate, score cryptographically hidden. The crypto is deterministic
  // (produced by the bridge); only the employer's judgment over it is the LLM's.
  const prove = (await sCall('/agent/prove-competency', K, { issuer_did: T.did, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' })).body;
  const revealed = Array.isArray(prove?.revealed) ? prove.revealed : [];
  const hiddenPaths = Array.isArray(prove?.hiddenPaths) ? prove.hiddenPaths : [];
  const proofAvailable = !!prove?.presentation;
  if (proofAvailable) emit({ actor: 'Candidate', kind: 'disclosure', title: 'Derives a BBS+ proof — reveals proficiency, hides the score', detail: `revealed ${revealed.length} · hidden ${hiddenPaths.length} (score, name, dates, id)`, data: prove });
  else emit({ actor: 'Candidate', kind: 'error', title: 'Private proof unavailable on this deployment', detail: 'prove-competency requires the issuer seed — the employer can still read + independently re-verify the record.', data: prove });

  const captured: { verify?: any; presentationVerified: boolean; disclosed: Array<{ path: string; value: string }>; reviewedStatements?: number; recordedByAgent: boolean } =
    { presentationVerified: false, disclosed: [], recordedByAgent: false };

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
    emit({ actor: 'Employer', kind: 'call', title: `affordance · ${name}`, detail: summarizeInput(name, input) });
    const r = await dispatchTool(name, input, E, { subjectDid: K.did, presentation: prove?.presentation });
    const b: any = r.body ?? {};
    emit({ actor: 'Employer', kind: name === 'record_performance' ? 'evidence' : 'verify', title: `signed → ${name} · HTTP ${r.status}${r.ok ? ' ✓' : ' ✗'}`, detail: interpretResult(name, b), data: b });
    if (name === 'review_record') captured.reviewedStatements = b?.subject?.statementCount;
    if (name === 'verify_extension') captured.verify = b;
    if (name === 'verify_presentation') { captured.presentationVerified = b?.verified === true; captured.disclosed = normalizeDisclosed(b?.disclosed); }
    if (name === 'record_performance' && r.ok) captured.recordedByAgent = true;
    return { text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };

  emit({ actor: 'Employer', kind: 'phase', title: `A real LLM employer agent decides — hiring for: ${spec.role}` });
  const goal =
    `You are hiring for "${spec.role}". Requirement: competency "${spec.requiredCompetency}" at minimum proficiency "${spec.minProficiency}", and ${spec.tamperEvidentRequired ? 'the load-bearing evidence MUST be tamper-evident (engine-graded + shape-conformant), not merely self-attested' : 'self-attested evidence is acceptable for this role'}.\n` +
    `The candidate is ${K.did}, credentialed by ${T.did}. ${proofAvailable ? 'The candidate has derived a BBS+ selective-disclosure proof of its competency (proficiency revealed, score hidden); verify it with verify_presentation (no args needed — the proof is provided to you).' : 'NOTE: the candidate could NOT derive a BBS+ proof on this deployment (issuer seed unset). Absence of a producible proof is NOT disqualifying — treat that case as UNDECIDABLE, not REJECT.'}\n` +
    `Do your OWN due diligence — take no one's word:\n` +
    `1) review_record (the candidate) — read the candidate's own pod.\n` +
    `2) verify_extension (subject the candidate, name "${extensionName}", kind "XapiContextExtension") — independently re-run verification; note checks.independentlyGraded and checks.shapeConformant.\n` +
    (proofAvailable ? `3) verify_presentation — cryptographically verify the candidate's BBS+ proof; note "verified" and the disclosed proficiency.\n` : '') +
    `Then DECIDE strictly on what you independently verified against the requirement, and call record_performance to record your decision (task_name "Hiring decision: <verdict> for ${spec.role}", success true ONLY if ACCEPT, quality 1, activity_type "${STD_EXT_IRI}").\n` +
    `Finish with: DECISION: ACCEPT|REJECT|UNDECIDABLE — <one-sentence rationale citing what you verified>.`;

  let finalText = '';
  try {
    await runAgentLoop({
      apiKey, system: EMPLOYER_SYS, goal,
      tools: toolList((proofAvailable
        ? ['review_record', 'verify_extension', 'verify_presentation', 'record_performance']
        : ['review_record', 'verify_extension', 'record_performance']) as ToolName[]),
      dispatch,
      onThinking: t => { finalText = t; emit({ actor: 'Employer', kind: 'result', title: 'reasoning', detail: t }); },
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 10,
    });
  } catch (e) { emit({ actor: 'Employer', kind: 'error', title: 'employer agent error', detail: (e as Error).message }); }

  // Parse the verdict the LLM employer rendered.
  const m = /DECISION:\s*(ACCEPT|REJECT|UNDECIDABLE)\b[\s—:-]*([\s\S]*)/i.exec(finalText);
  const verdict = (m?.[1]?.toUpperCase() as Decision['verdict']) ?? 'UNDECIDABLE';
  const rationale = (m?.[2]?.trim() || finalText.trim() || 'the employer agent did not return a parseable decision').slice(0, 400);
  // matched flags reflect the REAL verified facts (for the decision-card checklist).
  const engineGraded = !!captured.verify?.checks?.independentlyGraded && !!captured.verify?.checks?.shapeConformant;
  const provVal = captured.disclosed.find(x => /proficien/i.test(x.path))?.value;
  const decision: Decision = {
    verdict,
    reasons: [rationale],
    matched: {
      proofValid: captured.presentationVerified,
      tamperEvident: spec.tamperEvidentRequired ? engineGraded : true,
      proficiency: !!provVal && PROFICIENCY_ORDER.indexOf(provVal as Proficiency) >= PROFICIENCY_ORDER.indexOf(spec.minProficiency),
    },
  };
  emit({ actor: 'Employer', kind: 'decision', title: `Decision (by the LLM employer agent): ${decision.verdict}`, detail: rationale });

  // Guarantee the dogfooding close: if the agent didn't record its decision itself,
  // record it deterministically so the verification act is always dereferenceable.
  if (!captured.recordedByAgent) {
    const rec = await sCall('/agent/record-performance', E, { task_name: `Hiring decision: ${decision.verdict} for ${spec.role}`, success: decision.verdict === 'ACCEPT', quality: 1, activity_type: STD_EXT_IRI });
    emit({ actor: 'Employer', kind: 'evidence', title: 'Recorded the decision back onto the substrate', detail: 'the hiring decision is now itself a signed, dereferenceable record — verification all the way down', data: rec.body });
  }

  return { decision, verify: captured.verify, presentationVerified: captured.presentationVerified, disclosed: captured.disclosed, revealed, hiddenPaths, reviewedStatements: captured.reviewedStatements };
}
