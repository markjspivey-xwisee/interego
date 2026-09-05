import { fixtureStore } from './fixture-store.js';
import { releaseControl, ticTacToe } from './rule-packs.js';
import { simulateApplication } from './simulator.js';

for (const pack of [ticTacToe(), releaseControl()]) {
  const store = fixtureStore(pack);
  const resolved = await store.resolve();
  const frontier = simulateApplication(resolved, {
    actor: 'did:example:alice', now: '2026-09-05T12:00:00.000Z', expectedHead: resolved.stateHead.cid,
  });
  console.log(JSON.stringify({ applicationId: pack.contract.applicationId,
    basis: frontier.basis, coverage: frontier.coverage,
    alternatives: frontier.alternatives.map(a => ({ actionIri: a.actionIri, payload: a.payload, status: a.status,
      ...(a.status === 'simulated' ? { stateDigest: a.stateDigest, changes: a.changes } : { reason: a.reason }) })),
    fixtureWrites: store.counts().writes,
  }, null, 2));
}
