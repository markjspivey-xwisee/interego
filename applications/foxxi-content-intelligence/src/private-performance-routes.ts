/** Foxxi's private adapter for AGP empirical evidence. Uses ordinary delegated
 * identity, never default-tenant membership or a raw-wallet-only endpoint. */
import type { Express } from 'express';
import { PRIVATE_PERFORMANCE_SCHEMA } from './private-performance-schema.js';
import type { Affordance } from '../../_shared/affordance-mcp/index.js';
import { affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';
import { EvidenceError } from '../../agentic-performance-practice/src/private-outcomes.js';
import type { PrivatePerformanceStore } from './private-performance-store.js';

import type { VerifyPrivateCaller } from './private-performance-auth.js';
export type { PrivateAuthResult, VerifyPrivateCaller } from './private-performance-auth.js';
export const privatePerformanceAffordances: readonly Affordance[] = [
  ['outcome', 'record-private-performance-outcome', 'Record a private measured intervention episode', 'Signed payload {agent_id,timestamp,outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact:{uri,version,sha256},delivered_at},post,fresh?,assistance,observed_at}}. The server plan is created using private_evidence on contextualize-and-plan. Measurements include exact canonical report content and evidence references. No caller success labels; no causal attribution.'],
  ['outcomes', 'read-private-performance-outcomes', 'Read your private server plans and measured outcomes', 'Signed payload {agent_id,timestamp,episode_id?}. Reads only the verified caller own encrypted pod.'],
  ['calibration', 'read-private-performance-calibration', 'Read your own empirical calibration, excluding seeds', 'Signed payload {agent_id,timestamp}. Counts one learner/intervention episode, with eligibility, source and sample counts. No public aggregate publication.'],
].map(([path, action, title, description]) => ({
  action: `urn:iep:action:foxxi:${action}-signed` as IRI, toolName: action!.replaceAll('-', '_'), title: title!, description: `${description} Full input contract: /agent/performance/schema.`, method: 'POST' as const, externallyRouted: true,
  targetTemplate: `{base}/agent/performance/${path}`, mediaType: 'application/json',
  inputs: [{ name: '_signed_payload', type: 'string', required: true, description: `${description} Full schema: ${JSON.stringify(PRIVATE_PERFORMANCE_SCHEMA)}` }, { name: '_signature', type: 'string', required: true, description: 'Use sign_request; signature binds agent_id and complete payload.' }],
}));
export function attachPrivatePerformanceRoutes(app: Express, config: { base: string; verify: VerifyPrivateCaller; store: PrivatePerformanceStore }) {
  app.get('/agent/performance/schema', (_req, res) => res.json(PRIVATE_PERFORMANCE_SCHEMA));
  for (const [index, path] of ['outcome', 'outcomes', 'calibration'].entries()) {
    const route = `/agent/performance/${path}`;
    app.get(`${route}/affordance`, (_req, res) => res.type('text/turtle').send(affordancesManifestTurtle(`${config.base}${route}/affordance`, [privatePerformanceAffordances[index]!], config.base, { verticalLabel: 'Foxxi private empirical performance evidence' })));
    app.post(route, async (req, res) => {
      try {
        const auth = await config.verify(req.body, path === 'outcome');
        if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
        const p = auth.payload;
        const allowed = ['agent_id', 'timestamp', 'subject_pod_url', ...(path === 'outcome' ? ['outcome'] : path === 'outcomes' ? ['episode_id'] : [])];
        if (Object.keys(p).some(k => !allowed.includes(k))) throw new EvidenceError('Unsupported payload fields; caller-selected pod/actor overrides are not accepted.');
        if (p.episode_id !== undefined && (typeof p.episode_id !== 'string' || p.episode_id.length > 160)) throw new EvidenceError('episode_id must be a string (max 160).');
        const body = path === 'outcome' ? await config.store.record(auth.callerDid, p.outcome) : path === 'outcomes' ? await config.store.outcomes(auth.callerDid, p.episode_id as string | undefined) : await config.store.profile(auth.callerDid);
        res.json({ ok: true, owner: config.store.accountFor(auth.callerDid), actor: auth.callerDid, private: true, ...body });
      } catch (e) {
        const err = e instanceof EvidenceError ? e : new EvidenceError('Private performance storage operation failed.', 503);
        res.status(err.status).json({ error: err.message });
      }
    });
  }
}
