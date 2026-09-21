/** Private empirical evidence model. Numeric checks bind supplied assessor evidence;
 * they do not establish that an external observation happened or prove causality. */
import { createHash } from 'node:crypto';
import type { Diagnosis, InterventionPlan, InterventionType } from './performance-architecture.js';
import { buildCalibrationProfile, dominantCause, type OutcomeRecord, type OutcomeVerdict } from './performance-calibration.js';

export class EvidenceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new EvidenceError('Evidence must be finite JSON.');
}
export const evidenceHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
function obj(v: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new EvidenceError(`${name} must be an object.`);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some(k => !keys.includes(k))) throw new EvidenceError(`${name} has unsupported fields.`);
  return o;
}
function str(v: unknown, name: string, max = 1000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/u.test(v)) throw new EvidenceError(`${name} must be nonempty printable text (max ${max}).`);
  return v;
}
function hash(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new EvidenceError(`${name} must be lowercase SHA-256 hex.`);
  return v;
}
function date(v: unknown, name: string): string {
  const s = str(v, name, 40);
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(s) || !Number.isFinite(Date.parse(s)) || Date.parse(s) > Date.now() + 300_000) throw new EvidenceError(`${name} must be an observed UTC timestamp, not a future prediction.`);
  return s;
}
function count(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1_000_000) throw new EvidenceError(`${name} must be a bounded nonnegative integer.`);
  return v;
}
export interface EvidenceRef { uri: string; version: string; sha256: string }
export function evidenceRef(v: unknown, name: string): EvidenceRef {
  const p = obj(v, ['uri', 'version', 'sha256'], name);
  const uri = str(p.uri, `${name}.uri`, 2048);
  if (!/^(https?:\/\/|urn:)/.test(uri)) throw new EvidenceError(`${name}.uri must be an HTTP(S) or URN evidence identifier.`);
  return { uri, version: str(p.version, `${name}.version`, 100), sha256: hash(p.sha256, `${name}.sha256`) };
}
export interface AssessorReport {
  phase: 'baseline' | 'post' | 'fresh'; correct: number; total: number; unsafe: number;
  assessed_at: string; policy_sha256: string; assessment_sha256: string; responses_sha256: string; scorer_sha256: string;
}
export interface Measurement {
  phase: AssessorReport['phase']; correct: number; total: number; unsafe: number; assessed_at: string;
  assessment: EvidenceRef; responses: EvidenceRef; scorer: EvidenceRef; report: EvidenceRef; report_content: AssessorReport;
}
export function measurement(v: unknown, phase: AssessorReport['phase'], policy: EvidenceRef): Measurement {
  const p = obj(v, ['phase', 'correct', 'total', 'unsafe', 'assessed_at', 'assessment', 'responses', 'scorer', 'report', 'report_content'], phase);
  if (p.phase !== phase) throw new EvidenceError(`Expected ${phase} measurement.`);
  const correct = count(p.correct, `${phase}.correct`), total = count(p.total, `${phase}.total`), unsafe = count(p.unsafe, `${phase}.unsafe`);
  if (total === 0 || correct > total || unsafe > total) throw new EvidenceError(`${phase} counts out of range.`);
  const assessed_at = date(p.assessed_at, `${phase}.assessed_at`);
  const assessment = evidenceRef(p.assessment, 'assessment'), responses = evidenceRef(p.responses, 'responses'), scorer = evidenceRef(p.scorer, 'scorer'), report = evidenceRef(p.report, 'report');
  const report_content: AssessorReport = { phase, correct, total, unsafe, assessed_at, policy_sha256: policy.sha256, assessment_sha256: assessment.sha256, responses_sha256: responses.sha256, scorer_sha256: scorer.sha256 };
  if (canonicalJson(p.report_content) !== canonicalJson(report_content) || evidenceHash(report_content) !== report.sha256) throw new EvidenceError(`${phase} report content, evidence hashes, policy or numeric scores do not match.`);
  return { phase, correct, total, unsafe, assessed_at, assessment, responses, scorer, report, report_content };
}
export interface PrivateEvidenceContext {
  episode_id: string; study_id: string; learner_id: string; policy: EvidenceRef; baseline: Measurement;
  assistance: string; independence: 'same-account-procedural' | 'self-assessed'; target: { minimum_score: number; maximum_unsafe: number };
}
export function privateEvidenceContext(v: unknown): PrivateEvidenceContext {
  const p = obj(v, ['episode_id', 'study_id', 'learner_id', 'policy', 'baseline', 'assistance', 'independence', 'target'], 'private_evidence');
  const policy = evidenceRef(p.policy, 'policy');
  if (p.independence !== 'same-account-procedural' && p.independence !== 'self-assessed') throw new EvidenceError('independence must state same-account-procedural or self-assessed; independent signatures are not verified by this route.');
  const t = obj(p.target, ['minimum_score', 'maximum_unsafe'], 'target');
  if (typeof t.minimum_score !== 'number' || !Number.isFinite(t.minimum_score) || t.minimum_score <= 0 || t.minimum_score > 1) throw new EvidenceError('target.minimum_score must be in (0,1].');
  return { episode_id: str(p.episode_id, 'episode_id', 160), study_id: str(p.study_id, 'study_id', 160), learner_id: str(p.learner_id, 'learner_id', 160), policy, baseline: measurement(p.baseline, 'baseline', policy), assistance: str(p.assistance, 'assistance', 2000), independence: p.independence, target: { minimum_score: t.minimum_score, maximum_unsafe: count(t.maximum_unsafe, 'maximum_unsafe') } };
}
export interface PrivatePlan {
  plan_id: string; sha256: string; server_authentication: string; owner: string; created_by: string; created_at: string; context: PrivateEvidenceContext;
  input_sha256: string; diagnosis: Diagnosis; plan: InterventionPlan;
}
export interface EpisodeInput {
  episode_id: string; plan_id: string; plan_sha256: string;
  intervention: { type: InterventionType; delivered: boolean; artifact: EvidenceRef; delivered_at: string };
  post: Measurement; fresh?: Measurement; assistance: string; observed_at: string;
}
export interface PrivateOutcome {
  input: EpisodeInput; sha256: string; owner: string; recorded_by: string; learner_id: string; study_id: string; recorded_at: string;
  verdict: OutcomeVerdict; score_change: number; fresh_score_change: number | null;
  target_met: boolean; fresh_target_met: boolean | null; observed_gain: boolean;
  transfer: 'additional-fresh-assessment-observed' | 'not-measured'; learning_attribution: 'not-established';
  eligible: boolean; eligibility_reason: string; calibration_record: OutcomeRecord | null;
  verification_scope: string;
}
export const VERIFICATION_SCOPE = 'Server validates numeric arithmetic, exact supplied report hashes, policy/assessment/response/scorer bindings and its own persisted plan. Evidence URIs are not fetched; supplied reports are assessor claims. Same-account procedural separation is not independent cryptographic attestation. No causal learning attribution, retention or model-weight change is established.';
export function deriveOutcome(v: unknown, plan: PrivatePlan, owner: string, recordedBy = owner): PrivateOutcome {
  const p = obj(v, ['episode_id', 'plan_id', 'plan_sha256', 'intervention', 'post', 'fresh', 'assistance', 'observed_at'], 'outcome');
  if (plan.owner !== owner || p.plan_id !== plan.plan_id || p.plan_sha256 !== plan.sha256 || p.episode_id !== plan.context.episode_id) throw new EvidenceError('Outcome does not bind the owner, episode and exact persisted server plan.', 409);
  const i = obj(p.intervention, ['type', 'delivered', 'artifact', 'delivered_at'], 'intervention');
  if (!plan.plan.selected.some(x => x.type === i.type) || typeof i.delivered !== 'boolean') throw new EvidenceError('Intervention must be selected by the persisted plan and delivered must be a boolean.');
  const intervention = { type: i.type as InterventionType, delivered: i.delivered, artifact: evidenceRef(i.artifact, 'intervention.artifact'), delivered_at: date(i.delivered_at, 'delivered_at') };
  const post = measurement(p.post, 'post', plan.context.policy), fresh = p.fresh === undefined ? undefined : measurement(p.fresh, 'fresh', plan.context.policy);
  const baseline = plan.context.baseline;
  if (Date.parse(baseline.assessed_at) > Date.parse(plan.created_at)) throw new EvidenceError('Baseline must precede the persisted server plan.');
  const phases = [baseline, post, ...(fresh ? [fresh] : [])];
  if (new Set(phases.map(x => x.assessment.sha256)).size !== phases.length || new Set(phases.map(x => x.responses.uri)).size !== phases.length) throw new EvidenceError('Every phase must bind a distinct assessment and locked response.');
  if (phases.some(x => x.scorer.sha256 !== baseline.scorer.sha256 || x.scorer.version !== baseline.scorer.version)) throw new EvidenceError('Scorer version/hash must remain fixed across phases.');
  const observed_at = date(p.observed_at, 'observed_at');
  if (Date.parse(intervention.delivered_at) < Math.max(Date.parse(baseline.assessed_at), Date.parse(plan.created_at)) || Date.parse(post.assessed_at) < Date.parse(intervention.delivered_at) || (fresh && Date.parse(fresh.assessed_at) < Date.parse(post.assessed_at)) || Date.parse(observed_at) < Date.parse((fresh ?? post).assessed_at)) throw new EvidenceError('Baseline, server plan creation, delivery, post, fresh and observation timestamps must be ordered.');
  const input: EpisodeInput = { episode_id: plan.context.episode_id, plan_id: plan.plan_id, plan_sha256: plan.sha256, intervention, post, ...(fresh ? { fresh } : {}), assistance: str(p.assistance, 'assistance', 2000), observed_at };
  const score = (m: Measurement): number => m.correct / m.total;
  const target = (m: Measurement): boolean => score(m) >= plan.context.target.minimum_score && m.unsafe <= plan.context.target.maximum_unsafe;
  const score_change = score(post) - score(baseline), fresh_score_change = fresh ? score(fresh) - score(baseline) : null;
  const regression = score_change < 0 || post.unsafe > baseline.unsafe || !!(fresh && (fresh_score_change! < 0 || fresh.unsafe > baseline.unsafe));
  const observed_gain = score_change > 0 && !regression;
  const target_met = target(post), fresh_target_met = fresh ? target(fresh) : null;
  const verdict: OutcomeVerdict = regression ? 'worsened' : !target(baseline) && target_met && (fresh_target_met ?? true) ? 'closed' : observed_gain ? 'improved' : 'no-change';
  const d = plan.diagnosis;
  const eligibility_reason = d.regimeSource !== 'derived' ? 'Regime was not derived from trajectory evidence.' : d.domain !== 'Knowable' || d.method !== 'gap-analysis' || dominantCause(d) === 'not-applicable' ? 'No eligible Knowable cause-analysis cell; work outcome is still measured.' : !intervention.delivered ? 'No newly delivered intervention exposure.' : target(baseline) ? 'No baseline target gap.' : plan.context.independence === 'self-assessed' ? 'Self-assessed reports are not eligible for independent-assessor calibration.' : 'Eligible observed episode; association only, not a causal effect.';
  const eligible = eligibility_reason.startsWith('Eligible');
  const calibration_record: OutcomeRecord | null = eligible ? { regime: d.domain!, method: d.method, causeFactor: dominantCause(d), intervention: intervention.type, verdict, source: owner } : null;
  return { input, sha256: evidenceHash(input), owner, recorded_by: recordedBy, learner_id: plan.context.learner_id, study_id: plan.context.study_id, recorded_at: new Date().toISOString(), verdict, score_change, fresh_score_change, target_met, fresh_target_met, observed_gain, transfer: fresh ? 'additional-fresh-assessment-observed' : 'not-measured', learning_attribution: 'not-established', eligible, eligibility_reason, calibration_record, verification_scope: VERIFICATION_SCOPE };
}
export function empiricalProfile(outcomes: readonly PrivateOutcome[]) {
  const records = outcomes.flatMap(o => o.calibration_record ? [o.calibration_record] : []);
  const profile = buildCalibrationProfile(records);
  // Learner labels do not prove independent sampling. This private pilot path
  // exposes measured rates, but never upgrades them to Asserted on item/retry/
  // repeated-learner volume alone. A trusted sampling design is future work.
  for (const cell of profile.cells) cell.modalStatus = 'Hypothetical';
  return { distinct_reported_learners: new Set(outcomes.map(o => o.learner_id)).size, independent_sampling_verified: false, assertion_policy: 'Private caller-supplied evidence remains Hypothetical; numeric threshold alone is not independent sampling.', source: 'own-private-observed-episodes' as const, seed_samples: 0, measured_episodes: outcomes.length, eligible_episodes: records.length, ineligible_episodes: outcomes.length - records.length, sample_unit: 'one learner/intervention episode', causal_effect_established: false, profile, verification_scope: VERIFICATION_SCOPE };
}
