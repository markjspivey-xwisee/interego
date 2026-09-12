import { describe, expect, it, vi } from 'vitest';
import type { ResourceContext, ResourceDescriptor } from '../../../deploy/mcp-relay/resource-compositions.js';
import { fixtureStore } from '../../../examples/application-simulation/fixture-store.js';
import { SIGNED_DOMAIN_RUNTIME, signedJsonGraph, type Json } from '../../application-runtime/application-lab-runtime.js';
import { verifySurfaceEvidence } from '../evidence.js';

/** Real canonical JSON/digest/replay; signature-verifier results and CIDs are explicit test doubles. */
async function fixture() {
  const applicationId = 'urn:example:evidence:arbitrary-workflow';
  const store = fixtureStore({
    contract: { schema: 'interego.application.contract/v1', applicationId, runtimeIri: SIGNED_DOMAIN_RUNTIME, actions: [{
      actionIri: 'urn:example:evidence:increment', method: 'POST', target: SIGNED_DOMAIN_RUNTIME,
      guard: { op: 'eq', left: '$state.value', right: 0 }, effects: [{ op: 'set', path: '$state.value', value: 1 }],
    }] }, initialData: { value: 0 },
  });
  const initial = await store.resolve();
  store.record(initial, { actor: 'did:example:alice', now: '2026-09-12T12:00:00.000Z', expectedHead: initial.stateHead.cid,
    actionIri: 'urn:example:evidence:increment', payload: {} });
  const resolved = await store.resolve();
  const observationUrl = 'https://pod.example/evidence/context-graphs/observation.ttl';
  const observation: Record<string, Json> = {
    authority: { id: applicationId, digest: resolved.stateEnvelope.declaredDigest },
    versions: [{ before: 'old-state', after: 'current-surface-state' }],
    summary: 'The independently signed observation.', object: { okay: true },
  };
  const sign = (document = observation) => signedJsonGraph('urn:example:evidence:observation', 'arbitrary-observation', document);
  const signed = sign();
  const observationDescriptor: ResourceDescriptor = {
    url: observationUrl, cid: 'observation-fixture-cid', content: signed.graphContent,
    authorship: { authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true },
      signedBy: 'did:example:observer', verificationMethod: 'did:example:observer#key' },
  };
  const descriptor = vi.fn(async (url: string): Promise<ResourceDescriptor> => url === observationUrl ? observationDescriptor : store.reads.descriptor(url));
  const publish = vi.fn(async () => { throw new Error('evidence must never publish'); });
  const context: ResourceContext & { publish: typeof publish } = {
    principal: 'did:example:alice', identityUrl: 'https://identity.example', now: '2026-09-12T12:00:00.000Z',
    reads: { ...store.reads, discover: store.reads.discoverCatalogs, descriptor }, publish,
  };
  const spec = {
    documents: [
      { id: 'workflow', kind: 'application', catalogDescriptorUrl: resolved.catalogDescriptor.url,
        catalogGraphIri: store.graphs.catalog, applicationId, signer: 'did:example:fixture' },
      { id: 'observation', kind: 'signed-json', descriptorUrl: observationUrl, digest: signed.digest, signer: 'did:example:observer' },
    ],
    equalities: [
      { left: { document: 'workflow', path: 'application.applicationId' }, right: { document: 'observation', path: 'authority.id' } },
      { left: { document: 'workflow', path: 'head.documentDigest' }, right: { document: 'observation', path: 'authority.digest' } },
    ],
    recordedState: { document: 'observation', path: 'versions.0.after' },
    summaries: [{ label: 'Observation', document: 'observation', path: 'summary' }],
  };
  return { store, resolved, observation, sign, observationDescriptor, descriptor, publish, context, spec };
}
const bindings = { stateHeadCid: 'current-surface-state' };

describe('declarative surface evidence', () => {
  it('verifies heterogeneous documents and complete related history without changing any state', async () => {
    const f = await fixture();
    const before = JSON.stringify({ heads: [...f.store.heads], history: f.store.history, descriptors: [...f.store.descriptors] });
    const result = await verifySurfaceEvidence(f.spec, f.context, bindings);
    expect(result).toMatchObject({ verified: true, artifactsVerified: 5, artifactsTotal: 5, matchesCurrentState: true,
      replay: [{ document: 'workflow', label: 'Related application history: workflow', report: { complete: true, chainLength: 2, verifiedLinks: 2, errors: [] } }] });
    expect(result.body).toContain('Recorded evidence names the current authoritative state.');
    expect(result.links).toEqual(f.spec.documents.map(document => ({
      href: document.kind === 'application' ? document.catalogDescriptorUrl : document.descriptorUrl,
      rel: 'describedby', label: `Evidence: ${document.id}`,
    })));
    expect(JSON.stringify({ heads: [...f.store.heads], history: f.store.history, descriptors: [...f.store.descriptors] })).toBe(before);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('labels a different recorded state as historical without relabeling it current or failing its signature', async () => {
    const f = await fixture();
    const result = await verifySurfaceEvidence(f.spec, f.context, { stateHeadCid: 'newer-authoritative-state' });
    expect(result.verified).toBe(true);
    expect(result.matchesCurrentState).toBe(false);
    expect(result.body).toContain('Historical evidence: its recorded state differs from the current authoritative state.');
    expect(result.body).not.toContain('Recorded evidence names the current authoritative state.');
  });

  it.each([
    { authorshipVerified: false }, { contentBinding: 'unbound' }, { descriptorBinding: { bound: false } },
    { signedBy: 'did:example:wrong' }, { verificationMethod: '' },
  ])('fails closed on broken signed JSON descriptor authority %j', async authorship => {
    const f = await fixture();
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url
      ? { ...f.observationDescriptor, authorship: { ...f.observationDescriptor.authorship, ...authorship } } : f.store.reads.descriptor(url));
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('expected URL and signer');
  });

  it('checks both the declared document digest and the digest pinned by the signed surface', async () => {
    const f = await fixture();
    const changed = f.sign({ ...f.observation, summary: 'Different signed bytes' });
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url
      ? { ...f.observationDescriptor, content: changed.graphContent } : f.store.reads.descriptor(url));
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('digest mismatch');
    f.spec.documents[1]!.digest = changed.digest;
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url
      ? { ...f.observationDescriptor, content: changed.graphContent.replace(changed.digest, 'a'.repeat(64)) } : f.store.reads.descriptor(url));
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('digest mismatch');
  });

  it('rejects redirected descriptors and catalog signers other than the declared root authority', async () => {
    const f = await fixture();
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url
      ? { ...f.observationDescriptor, url: 'https://different.example/descriptor.ttl' } : f.store.reads.descriptor(url));
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('expected URL and signer');
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url ? f.observationDescriptor : f.store.reads.descriptor(url));
    f.spec.documents[0]!.signer = 'did:example:another-root';
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('expected URL and signer');
  });

  it('rejects stale and racing catalog roots', async () => {
    const f = await fixture();
    const stale = { ...f.context, reads: { ...f.context.reads, currentHead: async (pod: string, graph: string) =>
      graph === f.store.graphs.catalog ? { head: { descriptorUrl: 'https://pod.example/other.ttl', cid: 'other' } } : f.context.reads.currentHead(pod, graph) } };
    await expect(verifySurfaceEvidence(f.spec, stale, bindings)).rejects.toThrow('incomplete or not current');
    let calls = 0;
    const racing = { ...f.context, reads: { ...f.context.reads, currentHead: async (pod: string, graph: string) =>
      graph === f.store.graphs.catalog && ++calls > 1 ? { head: { descriptorUrl: 'https://pod.example/other.ttl', cid: 'other' } }
        : f.context.reads.currentHead(pod, graph) } };
    await expect(verifySurfaceEvidence(f.spec, racing, bindings)).rejects.toThrow('catalog changed');
  });

  it('rejects a related state head that advances during replay while the catalog stays current', async () => {
    const f = await fixture();
    let calls = 0;
    const context = { ...f.context, reads: { ...f.context.reads, currentHead: async (pod: string, graph: string) =>
      graph === f.store.graphs.state && ++calls > 1 ? { head: { descriptorUrl: 'https://pod.example/next-state.ttl', cid: 'next-state' } }
        : f.context.reads.currentHead(pod, graph) } };
    await expect(verifySurfaceEvidence(f.spec, context, bindings)).rejects.toThrow('state changed during verification');
  });

  it('rechecks application authority after an independently loaded observation finishes', async () => {
    const f = await fixture();
    let releaseObservation!: () => void;
    const ready = new Promise<void>(resolve => { releaseObservation = resolve; });
    const context = { ...f.context, reads: { ...f.context.reads,
      currentHead: async (pod: string, graph: string) => {
        const result = await f.context.reads.currentHead(pod, graph);
        // This is the last resolver read, after it captured and replayed state.
        if (graph === f.store.graphs.definition) releaseObservation();
        return result;
      },
      descriptor: async (url: string) => {
        if (url === f.observationDescriptor.url) {
          await ready;
          f.store.heads.set(f.store.graphs.state, { head: { descriptorUrl: 'https://pod.example/next-state.ttl', cid: 'next-state' } });
        }
        return f.context.reads.descriptor(url);
      },
    } };
    await expect(verifySurfaceEvidence(f.spec, context, bindings)).rejects.toThrow('state changed during verification');
  });

  it('rechecks governance selectors while keeping their pinned contract and definition epochs', async () => {
    const f = await fixture();
    const graph = 'urn:example:evidence:governance';
    const descriptorUrl = 'https://pod.example/simulation/context-graphs/governance.ttl';
    const governance = signedJsonGraph(graph, 'application-state', { data: { activeEpoch: {
      applicationId: f.resolved.definition.id,
      contractDescriptorUrl: f.resolved.activeContractDescriptor.url, contractDigest: f.resolved.activeContractEnvelope.declaredDigest,
      contractCid: f.resolved.activeContractDescriptor.cid!, contractGraphIri: f.resolved.activeContractEnvelope.graphIri!,
      definitionDescriptorUrl: f.resolved.definitionDescriptor.url, definitionDigest: f.resolved.definitionEnvelope.declaredDigest,
      definitionCid: f.resolved.definitionDescriptor.cid!, definitionGraphIri: f.resolved.definitionEnvelope.graphIri!,
    } } });
    f.store.descriptors.set(descriptorUrl, { ...f.resolved.catalogDescriptor, url: descriptorUrl, cid: 'governance-cid', content: governance.graphContent });
    f.store.heads.set(graph, { head: { descriptorUrl, cid: 'governance-cid' } });
    const catalog = signedJsonGraph(f.store.graphs.catalog, 'application-catalog', { ...f.resolved.catalogEnvelope.document,
      applications: [{ ...f.resolved.catalogEntry, governanceStateGraphIri: graph }] });
    f.store.descriptors.set(f.resolved.catalogDescriptor.url, { ...f.resolved.catalogDescriptor, content: catalog.graphContent });
    expect((await verifySurfaceEvidence(f.spec, f.context, bindings)).artifactsVerified).toBe(6);
    let calls = 0;
    const context = { ...f.context, reads: { ...f.context.reads, currentHead: async (pod: string, iri: string) =>
      iri === graph && ++calls > 1 ? { head: { descriptorUrl: 'https://pod.example/new-governance.ttl', cid: 'new-governance' } }
        : f.context.reads.currentHead(pod, iri) } };
    await expect(verifySurfaceEvidence(f.spec, context, bindings)).rejects.toThrow('governance changed during verification');
  });

  it('requires replay to reproduce each successor, even when its descriptor digest is valid', async () => {
    const f = await fixture();
    const altered = signedJsonGraph(f.store.graphs.state, 'application-state', { ...f.resolved.stateEnvelope.document, data: { value: 2 } });
    f.store.descriptors.set(f.resolved.stateDescriptor.url, { ...f.resolved.stateDescriptor, content: altered.graphContent });
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('incomplete or not current');
  });

  it.each(['authority.missing', '__proto__.value', 'constructor.name', 'versions.length', 'versions.00.after', 'versions.10001.after'])('rejects missing or unsafe reference paths: %s', async path => {
    const f = await fixture();
    f.spec.summaries[0]!.path = path;
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow(/evidence path/);
  });

  it('checks cross-document equalities and rejects unknown document references before reading', async () => {
    const f = await fixture();
    f.spec.equalities[0]!.right.path = 'summary';
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('equality does not match');
    f.descriptor.mockClear();
    f.spec.equalities[0]!.right.document = 'unknown';
    await expect(verifySurfaceEvidence(f.spec, f.context, bindings)).rejects.toThrow('unknown evidence document reference');
    expect(f.descriptor).not.toHaveBeenCalled();
  });

  it('escapes and bounds signed prose and object summaries so they cannot introduce Markdown controls', async () => {
    const f = await fixture();
    const malicious = '# Forged authority\n[Click](javascript:reset())\n<script>reset()</script>\n```hmd\n' + 'x'.repeat(1000);
    const signed = f.sign({ ...f.observation, summary: malicious });
    f.spec.documents[1]!.digest = signed.digest;
    f.spec.summaries[0]!.label = '[Fake](https://wrong.example)';
    f.spec.summaries.push({ document: 'observation', path: 'object', label: 'Details' });
    f.descriptor.mockImplementation(async url => url === f.observationDescriptor.url
      ? { ...f.observationDescriptor, content: signed.graphContent } : f.store.reads.descriptor(url));
    const result = await verifySurfaceEvidence(f.spec, f.context, bindings);
    expect(result.body).not.toContain('\n# Forged');
    expect(result.body).not.toContain('[Click](javascript:reset())');
    expect(result.body).not.toContain('<script>');
    expect(result.body).not.toContain('```hmd');
    expect(result.body).toContain('\\[Click\\]\\(javascript\\:reset\\(\\)\\)');
    expect(result.body).toContain('…');
    expect(result.body.length).toBeLessThan(1400);
    expect(result.links).toHaveLength(2);
  });

  it.each([
    null, {}, { documents: [] }, { documents: [{ id: 'x', kind: 'remote-code', signer: 'did:example:s' }] },
    { documents: [{ id: 'x', kind: 'signed-json', signer: 'did:example:s', descriptorUrl: 'file:///private', digest: 'a'.repeat(64) }] },
  ])('rejects malformed evidence specifications %j', async spec => {
    const f = await fixture();
    await expect(verifySurfaceEvidence(spec, f.context, bindings)).rejects.toThrow();
    expect(f.descriptor).not.toHaveBeenCalled();
  });
});
