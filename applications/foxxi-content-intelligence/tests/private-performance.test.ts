import { describe, it, expect } from 'vitest';
import express from 'express';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { recoverSignedRequest } from '../src/auth.js';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, openEncryptedEnvelope, createEncryptedEnvelope } from '@interego/core';
import { PrivatePerformanceStore } from '../../agentic-performance-practice/src/private-performance-store.js';
import { makePrivatePerformanceVerifier } from '../src/private-performance-auth.js';
import { publicSpellingOf } from '../src/store-origins.js';
import { privatePerformanceAffordances } from '../../agentic-performance-practice/compatibility/private-performance-affordances.js';
import { attachPerformanceRoutes } from '../../agentic-performance-practice/compatibility/foxxi-performance-routes.js';
import { diagnose, recommendInterventions, type PerformanceSituation } from '../../agentic-performance-practice/src/performance-architecture.js';
import { evidenceHash, privateEvidenceContext, deriveOutcome, empiricalProfile, type Measurement, type PrivatePlan } from '../../agentic-performance-practice/src/private-outcomes.js';
import { calibrate, calibrationDrivenReplan } from '../../agentic-performance-practice/src/performance-calibration.js';

const ACTOR = 'did:web:identity.example:agents:chatgpt-u-pk-123456789abc';
const PEER = 'did:web:identity.example:agents:claude-u-pk-123456789abc';
const OTHER = 'did:web:identity.example:agents:chatgpt-u-pk-abcdef123456';
const POD = 'https://pod.example/u-pk-123456789abc/';
const now = Date.now();
const time = (n: number) => new Date(now + n * 1000).toISOString();
const ref = (id: string) => ({ uri: `urn:test:${id}`, version: '1', sha256: evidenceHash(id) });
const policy = ref('policy'), scorer = ref('scorer');
function measure(phase: Measurement['phase'], correct: number, unsafe = 0): Measurement {
  const assessment = ref(`assessment-${phase}`), responses = ref(`responses-${phase}`);
  const assessed_at = time(phase === 'baseline' ? -100 : phase === 'post' ? 120 : 150);
  const report_content = { phase, correct, total: 12, unsafe, assessed_at, policy_sha256: policy.sha256, assessment_sha256: assessment.sha256, responses_sha256: responses.sha256, scorer_sha256: scorer.sha256 };
  return { phase, correct, total: 12, unsafe, assessed_at, assessment, responses, scorer, report: { ...ref(`report-${phase}`), sha256: evidenceHash(report_content) }, report_content };
}
function context(episode = 'episode-1') {
  return privateEvidenceContext({ episode_id: episode, study_id: 'study', learner_id: 'learner-A', policy, baseline: measure('baseline', 3), assistance: 'Basic interface; policy not yet supplied', independence: 'same-account-procedural', target: { minimum_score: 1, maximum_unsafe: 0 } });
}
const situation: PerformanceSituation = { id: 'situation', performer: { id: ACTOR, kind: 'agent' }, workContext: 'Apply unfamiliar rules', competency: 'Rule application', observed: '3/12', frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', provenance: 'Independent scorer', domain: 'Knowable' };
function planning(derived = true) {
  const diagnosis = diagnose({ situation, exemplary: '12/12', factorEvidence: { information: { adequate: false, evidence: 'Rules unavailable at baseline' } } });
  // Pure unit fixture, NOT a claim that a live trajectory produced this regime.
  if (derived) diagnosis.regimeSource = 'derived';
  const plan = recommendInterventions({ diagnosis, situation, author: { id: ACTOR, kind: 'agent' } });
  return { diagnosis, plan };
}
function outcome(plan: PrivatePlan, fresh = true) {
  return { episode_id: plan.context.episode_id, plan_id: plan.plan_id, plan_sha256: plan.sha256,
    intervention: { type: plan.plan.selected[0]!.type, delivered: true, artifact: ref('teaching'), delivered_at: time(100) },
    post: measure('post', 12), ...(fresh ? { fresh: measure('fresh', 12) } : {}), assistance: 'Retained policy and peer explanation', observed_at: time(180) };
}
function podDouble() {
  const files = new Map<string, { body: string; etag: string }>();
  const requests: { url: string; method: string; body?: string }[] = [];
  let revision = 0, conflicts = 0, failRead = false, loseAcknowledgement = false, noEtag = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, method, body });
    if (url.endsWith('/')) return new Response('', { status: 201 });
    if (method === 'GET' && failRead) return new Response('', { status: 500 });
    const current = files.get(url), headers = new Headers(init?.headers);
    if (method === 'PUT') {
      if (conflicts > 0) { conflicts--; return new Response('', { status: 412 }); }
      if ((headers.get('if-none-match') === '*' && current) || (headers.has('if-match') && headers.get('if-match') !== current?.etag)) return new Response('', { status: 412 });
      files.set(url, { body: body!, etag: `"${++revision}"` });
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('connection lost after commit'); }
      return new Response('', { status: 201 });
    }
    return current ? new Response(method === 'HEAD' ? null : current.body, { status: 200, headers: noEtag ? {} : { etag: current.etag } }) : new Response('', { status: 404 });
  };
  const bridge = generateKeyPair(), owner = generateKeyPair();
  const config = { podFor: (actor: string) => actor === OTHER ? 'https://pod.example/u-pk-abcdef123456/' : POD, keypair: () => bridge, ownerKey: async () => owner.publicKey, fetch: fetcher };
  return { files, requests, bridge, owner, config, store: () => new PrivatePerformanceStore(config), conflict: () => { conflicts = 1; }, unavailable: () => { failRead = true; }, lostAck: () => { loseAcknowledgement = true; }, noEtag: () => { noEtag = true; } };
}
async function seed(pod = podDouble()) {
  const store = pod.store(), p = planning();
  const plan = await store.savePlan(ACTOR, context(), { situation }, p.diagnosis, p.plan);
  return { pod, store, plan };
}

describe('private measured performance model', () => {
  it('computes measured gain, correct sample unit and conservative calibration', async () => {
    const { plan } = await seed();
    const value = deriveOutcome(outcome(plan), plan, POD, ACTOR);
    expect(value).toMatchObject({ verdict: 'closed', score_change: .75, target_met: true, eligible: true, learning_attribution: 'not-established' });
    const profile = empiricalProfile([value]);
    expect(profile).toMatchObject({ seed_samples: 0, measured_episodes: 1, eligible_episodes: 1, independent_sampling_verified: false });
    expect(profile.profile.cells[0]).toMatchObject({ samples: 1, modalStatus: 'Hypothetical' });
    const note = calibrate(plan.diagnosis, plan.plan, profile.profile);
    expect(note.verdict).not.toBe('untested');
    expect(calibrationDrivenReplan(plan.plan, note).replanned).toBe(false);
  });
  it('does not promote repeated or caller-labelled episodes at the numeric threshold', async () => {
    const { plan } = await seed();
    const row = deriveOutcome(outcome(plan), plan, POD);
    const profile = empiricalProfile(Array.from({ length: 12 }, (_, i) => ({ ...row, learner_id: `claimed-${i}` })));
    expect(profile.profile.totalSamples).toBe(12);
    expect(profile.profile.cells.every(c => c.modalStatus === 'Hypothetical')).toBe(true);
    expect(calibrationDrivenReplan(plan.plan, calibrate(plan.diagnosis, plan.plan, profile.profile)).replanned).toBe(false);
  });
  it('does not manufacture transfer when delayed learner has no follow-up', async () => {
    const { plan } = await seed();
    expect(deriveOutcome(outcome(plan, false), plan, POD)).toMatchObject({ transfer: 'not-measured', fresh_score_change: null, fresh_target_met: null });
  });
  it('keeps asserted regimes ineligible and unsafe regressions visible', async () => {
    const { plan } = await seed();
    plan.diagnosis.regimeSource = 'asserted';
    const p = outcome(plan); p.post = measure('post', 12, 1);
    expect(deriveOutcome(p, plan, POD)).toMatchObject({ eligible: false, verdict: 'worsened', target_met: false });
  });
  it('rejects caller success labels, nonfinite/range metrics and changed evidence', async () => {
    const { plan } = await seed();
    for (const bad of [
      { ...outcome(plan), success: true },
      { ...outcome(plan), plan_sha256: 'f'.repeat(64) },
      { ...outcome(plan), post: { ...measure('post', 12), correct: Infinity } },
      { ...outcome(plan), post: { ...measure('post', 12), correct: 13 } },
      { ...outcome(plan), post: { ...measure('post', 12), correct: -1 } },
      { ...outcome(plan), post: { ...measure('post', 12), report: ref('wrong-report') } },
      { ...outcome(plan), intervention: { ...outcome(plan).intervention, type: 'not-selected' } },
      { ...outcome(plan), intervention: { ...outcome(plan).intervention, delivered_at: time(-50) } },
    ]) expect(() => deriveOutcome(bad, plan, POD)).toThrow();
  });
  it('accepts identical answer bytes on different forms but refuses reused form', async () => {
    const { plan } = await seed();
    const p = outcome(plan);
    p.fresh!.responses.sha256 = p.post.responses.sha256;
    p.fresh!.report_content.responses_sha256 = p.post.responses.sha256;
    p.fresh!.report.sha256 = evidenceHash(p.fresh!.report_content);
    expect(deriveOutcome(p, plan, POD).verdict).toBe('closed');
    p.fresh!.assessment = p.post.assessment;
    p.fresh!.report_content.assessment_sha256 = p.post.assessment.sha256;
    p.fresh!.report.sha256 = evidenceHash(p.fresh!.report_content);
    expect(() => deriveOutcome(p, plan, POD)).toThrow('distinct assessment');
  });
});

describe('private encrypted CAS persistence', () => {
  it('survives new instances, deduplicates same payload and rejects altered retry', async () => {
    const { pod, store, plan } = await seed();
    expect((await store.record(ACTOR, outcome(plan))).duplicate).toBe(false);
    const restarted = pod.store();
    expect((await restarted.record(ACTOR, outcome(plan))).duplicate).toBe(true);
    await expect(restarted.record(ACTOR, { ...outcome(plan), assistance: 'changed' })).rejects.toMatchObject({ status: 409 });
    expect((await restarted.profile(ACTOR)).measured_episodes).toBe(1);
    const changed = planning();
    await expect(restarted.savePlan(ACTOR, context(), { different: true }, changed.diagnosis, changed.plan)).rejects.toMatchObject({ status: 409 });
    expect((await restarted.outcomes(ACTOR, 'absent')).outcomes).toHaveLength(0);
  });
  it('shares a canonical own account across authenticated surfaces, never other pods', async () => {
    const { store, plan } = await seed();
    const result = await store.record(PEER, outcome(plan));
    expect(result.outcome).toMatchObject({ owner: POD, recorded_by: PEER });
    expect((await store.outcomes(PEER)).plans[0]).toMatchObject({ created_by: ACTOR });
    await expect(store.record(OTHER, outcome(plan))).rejects.toMatchObject({ status: 404 });
    expect((await store.profile(OTHER)).measured_episodes).toBe(0);
  });
  it('CAS conflict/retry and ambiguous committed PUT do not double count', async () => {
    const { pod, store, plan } = await seed();
    pod.conflict(); pod.lostAck();
    expect((await store.record(ACTOR, outcome(plan))).durable).toBe(true);
    expect((await pod.store().profile(ACTOR)).measured_episodes).toBe(1);
  });
  it('concurrent conflicting retries settle on one immutable winner', async () => {
    const { pod, plan } = await seed();
    const result = await Promise.allSettled([pod.store().record(ACTOR, outcome(plan)), pod.store().record(ACTOR, { ...outcome(plan), assistance: 'different exposure' })]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await pod.store().profile(ACTOR)).measured_episodes).toBe(1);
  });
  it('fails closed on unreadable storage, missing ETag and missing owner encryption key', async () => {
    const { pod, store, plan } = await seed();
    pod.noEtag(); await expect(store.record(ACTOR, outcome(plan))).rejects.toMatchObject({ status: 503 });
    pod.unavailable(); await expect(store.profile(ACTOR)).rejects.toMatchObject({ status: 503 });
    const noOwner = podDouble(); noOwner.config.ownerKey = async () => null as unknown as string;
    await expect(seed(noOwner)).rejects.toMatchObject({ status: 503 });
  });
  it('writes no public projection or shared learner record and encrypts for owner+bridge', async () => {
    const { pod, store, plan } = await seed(); await store.record(ACTOR, outcome(plan));
    expect([...pod.files.keys()]).toEqual([`${POD}foxxi-lattice/private-performance-v1.holon.json`]);
    const raw = [...pod.files.values()][0]!.body;
    expect(raw).not.toContain('Rule application'); expect(raw).not.toContain('learner-A');
    const envelope = JSON.parse(raw);
    expect(openEncryptedEnvelope(envelope, pod.owner)).toContain('learner-A');
    expect(openEncryptedEnvelope(envelope, pod.bridge)).toContain('learner-A');
    expect(openEncryptedEnvelope(envelope, generateKeyPair())).toBeNull();
  });
  it('refuses owner-reencrypted forged server plan even after content hashes are recomputed', async () => {
    const { pod, store } = await seed();
    const [url, record] = [...pod.files.entries()][0]!;
    const payload = JSON.parse(openEncryptedEnvelope(JSON.parse(record.body), pod.owner)!);
    for (const node of Object.values(payload.nodes) as Array<{ kind: string; value?: string }>) {
      if (!node.value?.startsWith('__foxxi_private_performance_v1__:')) continue;
      const state = JSON.parse(node.value.slice('__foxxi_private_performance_v1__:'.length));
      state.plans[0].diagnosis.regimeSource = 'asserted';
      const { sha256: _sha, server_authentication: _mac, ...body } = state.plans[0];
      state.plans[0].sha256 = evidenceHash(body);
      node.value = '__foxxi_private_performance_v1__:' + JSON.stringify(state);
    }
    record.body = JSON.stringify(createEncryptedEnvelope(JSON.stringify(payload), [pod.owner.publicKey, pod.bridge.publicKey], pod.owner)); pod.files.set(url, record);
    await expect(store.profile(ACTOR)).rejects.toMatchObject({ status: 503 });
  });
  it('does not count aliased evidence again under another study/episode id', async () => {
    const { store, plan } = await seed(); await store.record(ACTOR, outcome(plan));
    const p = planning(), ctx = { ...context('episode-2'), study_id: 'another-label' };
    const second = await store.savePlan(ACTOR, ctx, { id: 'other' }, p.diagnosis, p.plan);
    const repeated = outcome(second); repeated.post.responses.uri = 'urn:alias';
    await expect(store.record(ACTOR, repeated)).rejects.toMatchObject({ status: 409 });
  });
});

function authConfig(scope = ['discover', 'publish']) {
  return { recover: (_body: unknown) => ({ ok: true as const, agentId: ACTOR, signer: `0x${"11".repeat(20)}` }), verify: async (body: unknown) => ({ ok: true as const, callerDid: ACTOR, payload: body as Record<string, unknown> }), ownPod: (_actor: string) => POD, canonicalPod: (pod: string) => publicSpellingOf(pod, { publicPodUrl: POD, internalPodUrl: 'http://internal/u-pk-123456789abc/' }), samePod: (a: string | undefined, b: string) => a === b, credential: async () => ({ pod: POD, scope }) };
}
describe('private transport and scope binding', () => {
  it('accepts the configured internal spelling of an own-pod credential without accepting foreign pods', async () => {
    const config = {
      ...authConfig(),
      samePod: (a: string | undefined, b: string) => a === b,
      credential: async () => ({ pod: 'http://internal/u-pk-123456789abc/', scope: ['discover', 'publish'] }),
    };
    const verify = makePrivatePerformanceVerifier(config);
    expect((await verify({ subject_pod_url: POD }, false)).ok).toBe(true);
    expect((await verify({ subject_pod_url: 'http://internal/u-pk-123456789abc/' }, true)).ok).toBe(true);
    for (const foreign of ['https://foreign.example/u-pk-123456789abc/', 'http://internal.attacker.example/u-pk-123456789abc/', 'http://internal/victim/']) {
      expect(await verify({ subject_pod_url: foreign }, true)).toMatchObject({ ok: false, status: 403 });
      const otherCredential = makePrivatePerformanceVerifier({ ...config, credential: async () => ({ pod: foreign, scope: ['discover', 'publish'] }) });
      expect(await otherCredential({}, false)).toMatchObject({ ok: false, status: 403 });
    }
    const readOnly = makePrivatePerformanceVerifier({ ...config, credential: async () => ({ pod: 'http://internal/u-pk-123456789abc/', scope: ['discover'] }) });
    expect((await readOnly({}, false)).ok).toBe(true);
    expect(await readOnly({}, true)).toMatchObject({ ok: false, status: 403 });
  });
  it('accepts relay-stamped own pod and rejects steering, missing publish and unsigned calls', async () => {
    const normal = makePrivatePerformanceVerifier(authConfig());
    expect((await normal({ subject_pod_url: 'http://internal/u-pk-123456789abc/' }, true)).ok).toBe(true);
    expect(await normal({ subject_pod_url: 'https://victim.example/' }, true)).toMatchObject({ ok: false, status: 403 });
    const readOnly = makePrivatePerformanceVerifier(authConfig(['discover']));
    expect((await readOnly({}, false)).ok).toBe(true); expect((await readOnly({}, true)).ok).toBe(false);
    const unsigned = makePrivatePerformanceVerifier({ ...authConfig(), recover: () => ({ ok: false, reason: 'missing signature' }) });
    expect(await unsigned({}, false)).toMatchObject({ ok: false, status: 401 });
    const wrongScope = makePrivatePerformanceVerifier({ ...authConfig(), credential: async () => ({ pod: 'https://pod.example/victim/', scope: ['discover', 'publish'] }) });
    expect((await wrongScope({}, true)).ok).toBe(false);
  });
  it('enforces delegated did:ethr scopes while allowing the proven direct owner key', async () => {
    const owner = Wallet.createRandom(), anchor = Wallet.createRandom();
    const actor = `did:ethr:${owner.address}`;
    let credentialReads = 0;
    const verifier = makePrivatePerformanceVerifier({
      ...authConfig(), recover: recoverSignedRequest,
      // Existing bridge verifier accepts a separately anchored delegation and
      // returns the AGENT did:ethr, not the anchor's DID. Only that I/O is doubled.
      verify: async body => {
        const rec = recoverSignedRequest(body);
        return rec.ok && rec.agentId === actor && [owner.address, anchor.address].includes(rec.signer)
          ? { ok: true, callerDid: actor, payload: rec.payload }
          : { ok: false, status: 401, error: 'Unrecognized owner/delegation anchor' };
      },
      credential: async () => { credentialReads++; return { pod: POD, scope: ['discover'] }; },
    });
    const sign = async (wallet: typeof owner, pod = POD) => {
      const payload = JSON.stringify({ agent_id: actor, timestamp: new Date().toISOString(), subject_pod_url: pod });
      return { _signed_payload: payload, _signature: await wallet.signMessage('sha256:' + createHash('sha256').update(payload).digest('hex')) };
    };
    const delegated = await sign(anchor);
    expect(await verifier(delegated, true)).toMatchObject({ ok: false, status: 403 });
    expect((await verifier(delegated, false)).ok).toBe(true);
    expect(credentialReads).toBe(2);
    expect((await verifier(await sign(owner), true)).ok).toBe(true);
    expect(credentialReads).toBe(2); // direct owner bypass rests on proof, not prefix
    expect(await verifier(await sign(owner, "https://pod.example/victim/"), true)).toMatchObject({ ok: false, status: 403 });
  });
  it('exercises discoverable signed plan, own profile, immutable retry, outcome/read and review-only routes', async () => {
    const pod = podDouble(), store = pod.store(), app = express(); app.use(express.json());
    const wallet = Wallet.createRandom();
    const verify = makePrivatePerformanceVerifier({ ...authConfig(), recover: recoverSignedRequest, verify: async body => {
      const recovered = recoverSignedRequest(body);
      return recovered.ok && recovered.signer === wallet.address
        ? { ok: true, callerDid: recovered.agentId, payload: recovered.payload }
        : { ok: false, status: 401, error: 'Test delegation anchor mismatch or invalid signature' };
    } });
    attachPerformanceRoutes(app, { selfBaseUrl: 'http://test', verifyDelegatedCaller: body => verify(body, false), privatePerformance: { persistence: pod.config, verify } });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => { const signed = JSON.stringify(body); const envelope = { _signed_payload: signed, _signature: await wallet.signMessage('sha256:' + createHash('sha256').update(signed).digest('hex')) }; const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) }); return { status: r.status, body: await r.json() as Record<string, any> }; };
    try {
      expect((await fetch(base + '/agent/performance/calibration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
      const payload = { agent_id: ACTOR, timestamp: time(0), subject_pod_url: POD, situation, exemplary: '12/12', factorEvidence: { information: { adequate: false, evidence: 'Reference missing' } }, private_evidence: context() };
      const first = await post('/agent/contextualize-and-plan', payload); expect(first.status).toBe(200);
      expect((await post('/agent/contextualize-and-plan', { ...payload, private_review: false })).status).toBe(400);
      expect(first.body.empirical).toMatchObject({ seed_samples: 0, measured_episodes: 0 });
      const retry = await post('/agent/contextualize-and-plan', { ...payload, timestamp: time(1) }); expect(retry.body.privatePlan).toEqual(first.body.privatePlan);
      const saved = (await store.outcomes(ACTOR)).plans[0]!;
      expect((await post('/agent/performance/outcome', { agent_id: ACTOR, timestamp: time(1), subject_pod_url: POD, outcome: outcome(saved) })).status).toBe(200);
      const review = await post('/agent/contextualize-and-plan', { agent_id: ACTOR, timestamp: time(2), subject_pod_url: POD, situation, private_review: true });
      expect(review.status).toBe(200); expect(review.body.privatePlan).toBeUndefined(); expect(review.body.empirical.measured_episodes).toBe(1);
      expect((await store.outcomes(ACTOR)).plans).toHaveLength(1);
      expect((await post('/agent/performance/outcomes', { agent_id: ACTOR, timestamp: time(2), subject_pod_url: POD })).body.outcomes).toHaveLength(1);
      expect((await post('/agent/performance/calibration', { agent_id: ACTOR, timestamp: time(2), subject_pod_url: POD })).body.seed_samples).toBe(0);
      expect((await post('/agent/performance/outcomes', { agent_id: ACTOR, timestamp: time(2), subject_pod_url: 'https://victim.example/' })).status).toBe(403);
      for (const a of privatePerformanceAffordances) { expect(a.externallyRouted).toBe(true); expect((await fetch(base + a.targetTemplate.replace('{base}', '') + '/affordance')).status).toBe(200); }
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
