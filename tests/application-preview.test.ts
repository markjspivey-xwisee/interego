import { describe, expect, it } from 'vitest';
import { previewApplicationAction } from '../integrations/application-runtime/application-preview.js';
import { canonicalJson, prepareApplicationAction, signedJsonGraph, type ApplicationLabReads, type Json } from '../integrations/application-runtime/application-lab-runtime.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../examples/application-simulation/rule-packs.js';

const session = { actor: 'did:example:alice', now: '2026-09-05T12:00:00.000Z' };
async function setup() {
  const store = fixtureStore(releaseControl());
  const resolved = await store.resolve();
  const request = {
    catalog_graph_iri: store.graphs.catalog, catalog_descriptor_url: resolved.catalogDescriptor.url,
    application_id: resolved.state.applicationId, action_iri: `${resolved.state.applicationId}:approve`,
    expected_head: resolved.stateHead.cid, expected_contract_digest: resolved.activeContractEnvelope.declaredDigest, payload: {},
  };
  return { store, resolved, request };
}

describe('live action preview boundary', () => {
  it('re-resolves every click, uses the session actor/time, and never changes authority', async () => {
    const { store, resolved, request } = await setup();
    const before = canonicalJson({ heads: [...store.heads], history: store.history, descriptors: [...store.descriptors] });
    const count = store.counts().reads;
    const forged = { ...request, actor: 'did:example:mallory', now: '2030-01-01', effects: [], state: {}, evidence: [{ verified: true }] };
    const first = await previewApplicationAction(forged, session, store.reads);
    const reads = store.counts().reads;
    expect(reads).toBeGreaterThan(count);
    expect(await previewApplicationAction(request, session, store.reads)).toEqual(first);
    expect(store.counts().reads).toBeGreaterThan(reads);
    expect(first).toMatchObject({ live: true, committed: false, basis: { actor: session.actor, at: session.now }, replay: { complete: true } });
    expect(first.alternatives).toHaveLength(1);
    const alternative = first.alternatives[0]!;
    expect(alternative.status).toBe('simulated');
    if (alternative.status !== 'simulated') throw new Error('expected a successor');
    const prepared = prepareApplicationAction(resolved, { actor: session.actor, now: session.now, actionIri: request.action_iri, payload: {}, expectedHead: request.expected_head });
    expect(alternative.successor).toEqual(prepared.successor);
    expect(alternative.receiptDigest).toBe(prepared.receiptDigest);
    expect(store.counts().writes).toBe(0);
    expect(canonicalJson({ heads: [...store.heads], history: store.history, descriptors: [...store.descriptors] })).toBe(before);
  });

  it('returns a signed-guard refusal and accepts open input only as the submitted sample', async () => {
    const { store, request } = await setup();
    const denied = await previewApplicationAction({ ...request, action_iri: request.action_iri.replace(':approve', ':deploy') }, session, store.reads);
    expect(denied.alternatives[0]).toMatchObject({ status: 'refused', reason: expect.stringContaining('guard refused') });
    const sampled = await previewApplicationAction({ ...request, action_iri: request.action_iri.replace(':approve', ':cancel'), payload: { reason: 'test preview' } }, session, store.reads);
    expect(sampled.alternatives).toHaveLength(1);
    expect(sampled.coverage[0]).toMatchObject({ inputSpace: 'open', enumerated: false, suppliedSamples: 1 });
    expect(sampled.alternatives[0]).toMatchObject({ status: 'simulated', successor: { data: { reason: 'test preview' } } });
  });

  it.each([
    ['expected_head', 'stale', /stale application head/],
    ['expected_contract_digest', 'stale', /stale application contract/],
    ['action_iri', 'urn:undeclared', /absent/],
    ['payload', { undeclared: true }, /signed action inputs/],
    ['payload', [], /must be an object/],
  ])('rejects invalid %s before any successor is returned', async (key, value, message) => {
    const { store, request } = await setup();
    await expect(previewApplicationAction({ ...request, [key as string]: value }, session, store.reads)).rejects.toThrow(message as RegExp);
    expect(store.counts().writes).toBe(0);
  });

  it('requires authentication and a complete, current, unforked, verified history', async () => {
    const { store, request, resolved } = await setup();
    await expect(previewApplicationAction(request, { ...session, actor: '' }, store.reads)).rejects.toThrow(/authenticated/);
    store.heads.set(store.graphs.state, { forked: true, head: { cid: request.expected_head, descriptorUrl: resolved.stateHead.descriptorUrl } });
    await expect(previewApplicationAction(request, session, store.reads)).rejects.toThrow(/fork/);
    store.heads.set(store.graphs.state, { head: { cid: request.expected_head, descriptorUrl: resolved.stateHead.descriptorUrl } });
    store.history.length = 0;
    await expect(previewApplicationAction(request, session, store.reads)).rejects.toThrow();
    expect(store.counts().writes).toBe(0);
  });

  it('discards results when another writer advances the head during resolution', async () => {
    const { store, request, resolved } = await setup();
    let stateHeadReads = 0;
    const reads: ApplicationLabReads = { ...store.reads, currentHead: async (pod, graph) => {
      if (graph === store.graphs.state && ++stateHeadReads === 2) {
        store.record(resolved, { ...session, actionIri: request.action_iri, payload: {}, expectedHead: request.expected_head });
      }
      return store.reads.currentHead(pod, graph);
    } };
    await expect(previewApplicationAction(request, session, reads)).rejects.toThrow(/changed during preview/);
    expect(store.counts().writes).toBe(1); // The injected concurrent writer, never the preview.
  });

  it('resolves external evidence through its verifier and rejects a tampered descriptor', async () => {
    const pack = releaseControl();
    const action = { ...pack.contract.actions[0]!, inputs: [{ name: 'proof', type: 'iri' as const, required: true }],
      evidence: [{ input: 'proof', role: 'proof', documentType: 'test-proof', requireCurrentHead: false }],
      guard: { op: 'eq', left: '$evidence.proof.document.passed', right: true } };
    const store = fixtureStore({ ...pack, contract: { ...pack.contract, actions: [action] } });
    const resolved = await store.resolve();
    const url = 'https://pod.example/simulation/context-graphs/proof.ttl';
    const proof = signedJsonGraph('urn:graph:test:proof', 'test-proof', { passed: true });
    const template = store.descriptors.get(resolved.stateHead.descriptorUrl)!;
    store.descriptors.set(url, { ...template, url, cid: 'fixture-proof-cid', content: proof.graphContent });
    const request = { catalog_graph_iri: store.graphs.catalog, catalog_descriptor_url: resolved.catalogDescriptor.url,
      application_id: resolved.state.applicationId, action_iri: action.actionIri, expected_head: resolved.stateHead.cid,
      expected_contract_digest: resolved.activeContractEnvelope.declaredDigest, payload: { proof: url } };
    const good = await previewApplicationAction(request, session, store.reads);
    expect(good.alternatives[0]).toMatchObject({ status: 'simulated' });
    store.descriptors.set(url, { ...store.descriptors.get(url)!, authorship: { ...template.authorship!, authorshipVerified: false } });
    await expect(previewApplicationAction({ ...request, evidence: [{ verified: true, document: { passed: true } as Json }] }, session, store.reads)).rejects.toThrow(/not fully verified/);
    expect(store.counts().writes).toBe(0);
  });
});
