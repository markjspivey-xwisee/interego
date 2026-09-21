/** Dedicated private PGSL snapshot. No shared-lattice resident/public registration,
 * public RDF projection, xAPI promotion, seed corpus or tenant-wide fallback.
 * Re-read and revalidate under ETag CAS on every write; never trust a hot mirror. */
import { createPGSL, ingest, promoteInstanceEncryptedCAS, resolveLatticeFromPodDetailed } from '@interego/pgsl';
import type { EncryptionKeyPair, IRI } from '@interego/core';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { Diagnosis, InterventionPlan } from './performance-architecture.js';
import {
  EvidenceError, canonicalJson, evidenceHash, deriveOutcome, empiricalProfile,
  privateEvidenceContext, type PrivateEvidenceContext, type PrivatePlan, type PrivateOutcome,
} from './private-outcomes.js';

type AuthenticatedOutcome = PrivateOutcome & { server_authentication: string };
interface State { schema: 1; owner: string; plans: PrivatePlan[]; outcomes: AuthenticatedOutcome[] }
const SENTINEL = '__foxxi_private_performance_v1__:';
export interface PrivateStoreConfig {
  podFor: (owner: string) => string;
  keypair: () => EncryptionKeyPair | null;
  ownerKey: (pod: string) => Promise<string | null>;
  fetch: typeof fetch;
}
export class PrivatePerformanceStore {
  constructor(private readonly config: PrivateStoreConfig) {}
  private location(owner: string) {
    const pod = this.config.podFor(owner).replace(/\/?$/, '/');
    return { pod, container: `${pod}foxxi-lattice/`, resource: `${pod}foxxi-lattice/private-performance-v1.holon.json` };
  }
  private mac(value: unknown): string {
    const kp = this.config.keypair();
    if (!kp) throw new EvidenceError('Private performance encryption is not configured.', 503);
    return createHmac('sha256', kp.secretKey).update('foxxi-private-performance-v1\n').update(canonicalJson(value)).digest('hex');
  }
  private authentic(value: unknown, mac: unknown): boolean {
    return typeof mac === 'string' && /^[a-f0-9]{64}$/.test(mac) && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.mac(value), 'hex'));
  }
  accountFor(caller: string): string { return this.location(caller).pod; }
  private async read(caller: string) {
    const kp = this.config.keypair();
    if (!kp) throw new EvidenceError('Private performance encryption is not configured.', 503);
    const location = this.location(caller);
    const owner = location.pod;
    const r = await resolveLatticeFromPodDetailed(location.resource, kp, this.config.fetch);
    if (r.status === 'absent') return { state: { schema: 1, owner, plans: [], outcomes: [] } as State, etag: undefined, absent: true, kp, ...location };
    if (r.status !== 'ok' || !r.nodes) throw new EvidenceError('Private performance storage is unreadable; no empty-profile fallback.', 503);
    const atoms = [...r.nodes.values()].filter(n => n.kind === 'Atom' && String(n.value).startsWith(SENTINEL));
    if (atoms.length !== 1 || atoms[0]!.kind !== 'Atom') throw new EvidenceError('Private performance snapshot is malformed.', 503);
    let state: State;
    try { state = JSON.parse(String(atoms[0]!.value).slice(SENTINEL.length)) as State; }
    catch { throw new EvidenceError('Private performance snapshot cannot be decoded.', 503); }
    if (state.schema !== 1 || state.owner !== owner || !Array.isArray(state.plans) || !Array.isArray(state.outcomes)) throw new EvidenceError('Private performance snapshot owner/schema mismatch.', 503);
    try {
      if (new Set(state.plans.map(p => p.plan_id)).size !== state.plans.length || new Set(state.plans.map(p => p.context.episode_id)).size !== state.plans.length || new Set(state.outcomes.map(o => o.input.episode_id)).size !== state.outcomes.length) throw new Error('duplicate identity');
      for (const p of state.plans) {
        const { sha256, server_authentication, ...body } = p;
        if (!this.authentic({ ...body, sha256 }, server_authentication) || p.owner !== owner || evidenceHash(body) !== sha256 || canonicalJson(privateEvidenceContext(p.context)) !== canonicalJson(p.context)) throw new Error('plan integrity');
      }
      for (const o of state.outcomes) {
        const plan = state.plans.find(p => p.plan_id === o.input.plan_id);
        if (!plan) throw new Error('missing plan');
        const { recorded_at: _time, ...derived } = deriveOutcome(o.input, plan, owner, o.recorded_by);
        const { server_authentication, ...authenticated } = o;
        if (!this.authentic(authenticated, server_authentication)) throw new Error('outcome authentication');
        const { recorded_at: _storedTime, ...stored } = authenticated;
        if (canonicalJson(derived) !== canonicalJson(stored)) throw new Error('outcome integrity');
      }
    } catch { throw new EvidenceError('Private evidence snapshot integrity validation failed.', 503); }
    return { state, etag: r.etag, absent: false, kp, ...location };
  }
  private async update<T>(owner: string, change: (state: State) => { value: T; changed: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.read(owner);
      const result = change(r.state);
      if (!result.changed) return result.value;
      if (!r.absent && !r.etag) throw new EvidenceError('Private storage supplied no ETag; unsafe overwrite refused.', 503);
      if (r.state.plans.length > 1000 || r.state.outcomes.length > 1000) throw new EvidenceError('Private evidence capacity reached (1000 plans/episodes); archive before adding more.', 413);
      const json = canonicalJson(r.state);
      if (Buffer.byteLength(json) > 4_000_000) throw new EvidenceError('Private evidence snapshot exceeds 4 MB.', 413);
      const ownerKey = await this.config.ownerKey(r.pod);
      if (!ownerKey) throw new EvidenceError('Owner encryption key unavailable; bridge-only encryption refused.', 503);
      if (r.absent) {
        const c = await this.config.fetch(r.container, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"', 'If-None-Match': '*' }, body: '' });
        if (!c.ok && c.status !== 412 && c.status !== 409) throw new EvidenceError(`Private storage container unavailable (${c.status}).`, 503);
      }
      const pgsl = createPGSL({ wasAttributedTo: owner as IRI, generatedAtTime: new Date().toISOString() });
      const top = ingest(pgsl, [owner, 'urn:foxxi:private-performance:v1', `${SENTINEL}${json}`], { wasAttributedTo: owner as IRI, generatedAtTime: new Date().toISOString() });
      const written = await promoteInstanceEncryptedCAS(pgsl, top as IRI, r.resource, [...new Set([ownerKey, r.kp.publicKey])], r.kp, this.config.fetch, r.absent ? { ifNoneMatch: '*' } : { ifMatch: r.etag! });
      if (written.status === 'ok') return result.value;
      if (written.status === 'error') {
        // Ambiguous PUT (connection dropped after commit): re-read next iteration.
        // change() sees the already-durable hash and returns the same logical result.
        if (attempt === 3) throw new EvidenceError('Private evidence write not confirmed; retry the same payload to resolve.', 503);
      }
    }
    throw new EvidenceError('Private evidence write conflicted repeatedly; retry unchanged payload.', 409);
  }
  async profile(owner: string) { return empiricalProfile((await this.read(owner)).state.outcomes); }
  async outcomes(owner: string, episode?: string) {
    const state = (await this.read(owner)).state;
    return { outcomes: state.outcomes.filter(o => episode === undefined || o.input.episode_id === episode), plans: state.plans.filter(p => episode === undefined || p.context.episode_id === episode) };
  }
  async savePlan(owner: string, context: PrivateEvidenceContext, input: unknown, diagnosis: Diagnosis, plan: InterventionPlan): Promise<PrivatePlan> {
    const unsigned = { plan_id: randomUUID(), owner: this.accountFor(owner), created_by: owner, created_at: new Date().toISOString(), context, input_sha256: evidenceHash(input), diagnosis: JSON.parse(JSON.stringify(diagnosis)) as Diagnosis, plan: JSON.parse(JSON.stringify(plan)) as InterventionPlan };
    if (Date.parse(context.baseline.assessed_at) > Date.parse(unsigned.created_at)) throw new EvidenceError('Baseline must precede server plan creation.');
    const hashed = { ...unsigned, sha256: evidenceHash(unsigned) };
    const record: PrivatePlan = { ...hashed, server_authentication: this.mac(hashed) };
    return this.update(owner, state => {
      const prior = state.plans.find(x => x.context.episode_id === context.episode_id);
      if (prior) {
        if (prior.input_sha256 !== record.input_sha256 || canonicalJson(prior.context) !== canonicalJson(context)) throw new EvidenceError('Episode already has a different immutable plan/context; use a linked new episode for a revision.', 409);
        return { value: prior, changed: false };
      }
      state.plans.push(record); return { value: record, changed: true };
    });
  }
  async record(owner: string, input: unknown): Promise<{ outcome: PrivateOutcome; duplicate: boolean; durable: true }> {
    return this.update<{ outcome: PrivateOutcome; duplicate: boolean; durable: true }>(owner, state => {
      const id = (input as { plan_id?: unknown } | null)?.plan_id;
      const plan = state.plans.find(p => p.plan_id === id);
      if (!plan) throw new EvidenceError('No private server plan for this caller and plan_id.', 404);
      const derived = deriveOutcome(input, plan, this.accountFor(owner), owner);
      const record: AuthenticatedOutcome = { ...derived, server_authentication: this.mac(derived) };
      const prior = state.outcomes.find(o => o.input.episode_id === record.input.episode_id);
      if (prior) {
        if (prior.sha256 !== record.sha256) throw new EvidenceError('Episode outcome is immutable; altered retry conflicts.', 409);
        return { value: { outcome: prior, duplicate: true, durable: true as const }, changed: false };
      }
      // Different caller-chosen episode IDs do not turn the same assessment into
      // independent observations. Reject repeated learner/study post responses.
      if (state.outcomes.some(o => {
        const priorPlan = state.plans.find(p => p.plan_id === o.input.plan_id);
        return priorPlan?.context.learner_id === plan.context.learner_id && o.input.post.responses.sha256 === record.input.post.responses.sha256 && o.input.post.assessment.sha256 === record.input.post.assessment.sha256;
      })) throw new EvidenceError('This learner/study post response is already counted in another episode.', 409);
      state.outcomes.push(record);
      return { value: { outcome: record, duplicate: false, durable: true as const }, changed: true };
    });
  }
}
