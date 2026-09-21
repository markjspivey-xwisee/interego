/** AGP-owned performance HTTP adapter, mounted at legacy Foxxi URLs. Uses delegated
 * identity, never default-tenant membership or a raw-wallet-only endpoint. */
import type { Express } from 'express';
import { privatePerformanceAffordances } from './private-performance-affordances.js';
import { PRIVATE_PERFORMANCE_SCHEMA } from './private-performance-schema.js';
import { affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import { EvidenceError } from '../src/private-outcomes.js';
import type { PrivatePerformanceStore } from '../src/private-performance-store.js';

import type { VerifyPrivateCaller } from '../../foxxi-content-intelligence/src/private-performance-auth.js';
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
