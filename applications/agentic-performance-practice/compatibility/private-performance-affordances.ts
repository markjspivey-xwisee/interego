/** AGP-owned compatibility declarations hosted in Foxxi's catalog. */
import type { Affordance, AffordanceOutput } from '../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';
import { PRIVATE_PERFORMANCE_SCHEMA } from './private-performance-schema.js';

function privateOutputs(path: string): AffordanceOutput {
  const common: NonNullable<AffordanceOutput['properties']> = {
    ok: { type: 'boolean', description: 'True on a successful signed own-account operation.' },
    owner: { type: 'string', description: 'Canonical verified account pod; shared by its authorized surface delegates.' },
    actor: { type: 'string', description: 'Verified caller DID for this request.' },
    private: { type: 'boolean', description: 'True; no public outcome or seed-profile publication.' },
    error: { type: 'string', description: 'Refusal/failure explanation on a non-success HTTP response; other success properties are absent.' },
  };
  if (path === 'outcome') return {
    description: 'A durable private episode, its independently supplied numeric/report evidence, computed verdict and calibration eligibility; identical logical retries return the original outcome. Or {error} with non-success HTTP status.',
    properties: {
      ...common, duplicate: { type: 'boolean', description: 'True when this exact immutable episode was already durable.' },
      durable: { type: 'boolean', description: 'True only after storage confirmation or read-back of an identical committed write.' },
      outcome: { type: 'object', additionalProperties: true, description: 'Stored episode and derived observations, not a claim of causal learning.', properties: {
        input: { type: 'object', additionalProperties: true, description: 'Exact canonical episode input, including episode_id, plan_id, plan_sha256, selected intervention artifact and post/fresh measurement bindings.' },
        sha256: { type: 'string', description: 'SHA-256 of canonical episode input; binds an identical retry.' },
        owner: { type: 'string' }, recorded_by: { type: 'string', description: 'Original authenticated recording actor; preserved on cross-surface retries.' },
        learner_id: { type: 'string' }, study_id: { type: 'string' }, recorded_at: { type: 'string' },
        verdict: { type: 'string', enum: ['closed', 'improved', 'no-change', 'worsened'] },
        score_change: { type: 'number', description: 'Post correct/total minus baseline correct/total.' },
        fresh_score_change: { type: ['number', 'null'], description: 'Additional fresh minus baseline score, or null if absent.' },
        target_met: { type: 'boolean' }, fresh_target_met: { type: ['boolean', 'null'] },
        observed_gain: { type: 'boolean' }, transfer: { type: 'string', enum: ['additional-fresh-assessment-observed', 'not-measured'] },
        learning_attribution: { type: 'string', enum: ['not-established'] }, eligible: { type: 'boolean' }, eligibility_reason: { type: 'string' },
        calibration_record: { type: ['object', 'null'], additionalProperties: true, description: 'One eligible cause/intervention observation or null, never one sample per question.' },
        verification_scope: { type: 'string' }, server_authentication: { type: 'string', description: 'Bridge HMAC integrity tag, not an independent assessor signature.' },
      } },
    },
  };
  if (path === 'outcomes') return {
    description: 'Private server plans and measured outcomes on the verified account, optionally filtered by episode_id. Empty arrays mean no matching durable records; unreadable storage returns an error instead.',
    properties: { ...common,
      plans: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Immutable {plan_id,sha256,owner,created_by,created_at,context,input_sha256,diagnosis,plan,server_authentication}; context holds baseline/target/evidence bindings. plan_id+sha256 feed the outcome action.' },
      outcomes: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Stored outcomes with input/sha256, derived scores/verdict, eligibility and provenance; same shape as record-private-performance-outcome.outcome.' },
    },
  };
  return {
    description: 'The caller account empirical profile, excluding every seeded corpus. Actual episode counts and eligibility are exposed; caller-supplied evidence stays Hypothetical regardless count and cannot trigger automatic rate-based swaps.',
    properties: { ...common,
      source: { type: 'string', enum: ['own-private-observed-episodes'] }, seed_samples: { type: 'integer', description: 'Always zero on this private path.' },
      measured_episodes: { type: 'integer' }, eligible_episodes: { type: 'integer' }, ineligible_episodes: { type: 'integer' },
      distinct_reported_learners: { type: 'integer', description: 'Distinct caller-supplied learner labels, not verified independent identities.' },
      independent_sampling_verified: { type: 'boolean', description: 'False for this evidence trust class.' },
      assertion_policy: { type: 'string' }, sample_unit: { type: 'string' }, causal_effect_established: { type: 'boolean', description: 'False; observational association does not establish causality.' },
      profile: { type: 'object', additionalProperties: true, description: 'AGP CalibrationProfile {cells,totalSamples,sources,assertThreshold,federationKThreshold,generatedAt}; all private cells retain Hypothetical modal status.' },
      verification_scope: { type: 'string' },
    },
  };
}

export const privatePerformanceAffordances: readonly Affordance[] = [
  ['outcome', 'record-private-performance-outcome', 'Record a private measured intervention episode', 'Signed payload {agent_id,timestamp,outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact:{uri,version,sha256},delivered_at},post,fresh?,assistance,observed_at}}. The server plan is created using private_evidence on contextualize-and-plan. Measurements include exact canonical report content and evidence references. No caller success labels; no causal attribution.'],
  ['outcomes', 'read-private-performance-outcomes', 'Read your private server plans and measured outcomes', 'Signed payload {agent_id,timestamp,episode_id?}. Reads only the verified caller own encrypted pod.'],
  ['calibration', 'read-private-performance-calibration', 'Read your own empirical calibration, excluding seeds', 'Signed payload {agent_id,timestamp}. Counts one learner/intervention episode, with eligibility, source and sample counts. No public aggregate publication.'],
].map(([path, action, title, description]) => ({
  action: `urn:iep:action:foxxi:${action}-signed` as IRI, toolName: `foxxi.${action!.replaceAll('-', '_')}`, title: title!, description: `${description} Full input contract: /agent/performance/schema.`, method: 'POST' as const, externallyRouted: true,
  outputs: privateOutputs(path!),
  targetTemplate: `{base}/agent/performance/${path}`, mediaType: 'application/json',
  inputs: [{ name: '_signed_payload', type: 'string', required: true, description: `${description} Full schema: ${JSON.stringify(PRIVATE_PERFORMANCE_SCHEMA)}` }, { name: '_signature', type: 'string', required: true, description: 'Use sign_request; signature binds agent_id and complete payload.' }],
}));
