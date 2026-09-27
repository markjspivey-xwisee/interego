/**
 * A plan offers its performer the admission it implies, and the performer keeps it or not.
 *
 * The practice reads a situation's regime and plans for it; Foxxi admits only the forms of content
 * that deliver what the plan selected. Between the two stands the performer: the plan's route
 * offers the admission, and nothing is written onto anyone's record until the performer keeps it
 * with foxxi.content_admit. Once kept, resolution reads it for every composition at that
 * competency. The same for a person and for an agent, because a plan is about the work.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { admissionOffer, attachPerformanceRoutes } from '../applications/agentic-performance-practice/compatibility/foxxi-performance-routes.js';
import type { WorkRegime } from '../applications/agentic-performance-practice/src/agent-disposition.js';
import { diagnose, recommendInterventions, type PerformanceSituation } from '../applications/agentic-performance-practice/src/performance-architecture.js';
import { admissionFor, admissionRecordFrom, standingAdmissions } from '../applications/foxxi-content-intelligence/src/admission-records.js';
import { compositionFrom, resolveComposition, type Composition } from '../applications/foxxi-content-intelligence/src/compositions.js';
import { fragmentFrom, type Fragment } from '../applications/foxxi-content-intelligence/src/content-fragments.js';
import { competencyIri } from '../applications/foxxi-content-intelligence/src/competency-identity.js';

const base = 'http://bridge.example';
const situationIn = (domain?: WorkRegime, competency = 'refund-authority'): PerformanceSituation => ({
  id: 'urn:test:situation', performer: { id: 'did:web:me.example', kind: 'agent' },
  workContext: 'Handle refund requests', competency, observed: 'Uneven results', frequency: 'frequent',
  criticality: 'moderate', modalStatus: 'Hypothetical', provenance: 'synthetic test observation', ...(domain ? { domain } : {}),
});
const offerFor = (domain?: WorkRegime, competency?: string) => {
  const situation = situationIn(domain, competency);
  const diagnosis = diagnose({ situation });
  return admissionOffer(recommendInterventions({ situation, diagnosis }), diagnosis, situation, base);
};

describe('a plan offers the admission it implies', () => {
  it('offers the forms that deliver what it selected, at the situation\'s competency, for its performer to keep', () => {
    const offer = offerFor('Emergent')!;
    expect(offer).toMatchObject({
      competency: competencyIri('refund-authority'), regime: 'Emergent', forPerformer: 'did:web:me.example',
      keep: { affordance: 'urn:iep:action:foxxi:content-admit-signed', target: `${base}/agent/content/admit`, method: 'POST' },
    });
    expect(offer.kinds).toEqual(expect.arrayContaining(['probe']));
    expect(offer.kinds).not.toContain('concept');
    expect(String(offer.because)).toMatch(/Emergent/);
    expect(offerFor('Turbulent')).toMatchObject({ kinds: [], regime: 'Turbulent' });   // content is not the answer
  });

  it('offers nothing for a plan that selected nothing, or a competency no content can be resolved against', () => {
    expect(offerFor(undefined)).toBeUndefined();   // unclassified: classify the work first
    expect(offerFor('Emergent', 'handles refunds well')).toBeUndefined();
  });

  it('is in the signed plan route\'s answer, and nothing is kept on anyone\'s record by the route', async () => {
    const app = express();
    app.use(express.json());
    attachPerformanceRoutes(app, {
      selfBaseUrl: base,
      verifyDelegatedCaller: async body => ({ ok: true, callerDid: 'did:web:me.example', payload: JSON.parse((body as { _signed_payload: string })._signed_payload) }),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/contextualize-and-plan`;
    const plan = async (situation: PerformanceSituation) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _signed_payload: JSON.stringify({ agent_id: 'did:web:me.example', timestamp: new Date().toISOString(), situation }), _signature: 'test' }) });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    try {
      const emergent = await plan(situationIn('Emergent'));
      expect(emergent.status).toBe(200);
      expect(emergent.body.admission).toMatchObject({ competency: competencyIri('refund-authority'), regime: 'Emergent', keep: { target: `${base}/agent/content/admit` } });
      const unclassified = await plan(situationIn(undefined));
      expect(unclassified.status).toBe(200);
      expect(unclassified.body.admission).toBeUndefined();
    } finally { server.close(); }
  });
});

describe('an offer kept is what resolution admits', () => {
  it('admits only what the kept offer names at that competency', () => {
    const offer = offerFor('Emergent')!;
    const concept = fragmentFrom({ kind: 'concept', competencies: ['refund-authority'], body: 'How refunds are approved.' });
    const probe = fragmentFrom({ kind: 'probe', competencies: ['refund-authority'], body: 'Try a small refund and watch who objects.' });
    const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [concept['@id'], probe['@id']] }] });
    const store = new Map<string, Fragment | Composition>([concept, probe].map(x => [x['@id'], x]));
    // What foxxi.content_admit keeps from the offer, as the performer signs it.
    const kept = standingAdmissions([admissionRecordFrom({ competency: offer.competency, admission: { kinds: offer.kinds, because: offer.because }, regime: offer.regime, at: new Date().toISOString() })]);
    const r = resolveComposition({ composition: course, learner: { id: 'did:web:me.example', kind: 'agent' }, lookup: i => store.get(i), admission: c => admissionFor(kept, c) });
    expect(r.steps.map(s => s.fragment.kind)).toEqual(['probe']);
  });
});
