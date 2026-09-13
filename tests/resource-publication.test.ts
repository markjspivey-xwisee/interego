import { describe, expect, it, vi } from 'vitest';
import { createEncryptedEnvelope, generateKeyPair, openEncryptedEnvelope } from '@interego/core';
import { protectResourcePublication } from '../deploy/mcp-relay/resource-publication.js';
import { ResourceCompositions, type ResourceDescriptor, type ResourceReads, type ResourceWriteContext } from '../deploy/mcp-relay/resource-compositions.js';
import application from '../integrations/application-runtime/resource-composition.js';
import { parseSignedJsonDocument, signedJsonGraph } from '../integrations/application-runtime/application-lab-runtime.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../examples/application-simulation/rule-packs.js';

const actor = 'did:example:alice';
const podUrl = 'https://pod.example/simulation/';
const graphIri = 'urn:test:state';
const sourceUrl = podUrl + 'context-graphs/state.ttl';
type Visibility = 'public' | 'private' | 'shared' | undefined;
function distribution(url: string, visibility: Visibility, encrypted = visibility !== 'public') {
  const payload = url + '.payload';
  return { distribution: { url: payload, encrypted }, turtle: `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<> iep:affordance [ a dcat:Distribution ; dcat:accessURL <${payload}> ; hydra:target <${payload}> ;
  iep:encrypted ${encrypted} ${visibility ? `; iep:visibility "${visibility}"` : ''} ] .` };
}
function descriptor(visibility: Visibility = 'public'): ResourceDescriptor {
  return { url: sourceUrl, cid: 'source-cid', content: '<urn:test> <urn:value> "source" .', ...distribution(sourceUrl, visibility),
    authorship: { authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true },
      effectiveTrustLevel: 'CryptographicallyVerified', signedBy: actor } };
}
function harness(source = descriptor()) {
  const sink = vi.fn(async (_request: Parameters<ResourceWriteContext['publish']>[0], visibility: 'public' | 'private') => ({ published: true, visibility }));
  const reads: ResourceReads = { discover: async () => [], discoverGraph: async () => [],
    currentHead: async () => ({ head: { descriptorUrl: sourceUrl, cid: 'source-cid' } }), descriptor: async () => source };
  const guarded = protectResourcePublication(reads, actor, sink);
  const request = { podUrl, graphIri, graphContent: '<urn:derived> <urn:value> "result" .', expectedHead: 'source-cid', actor };
  return { source, sink, reads, guarded, request };
}

describe('derived resource audience enforcement', () => {
  it.each(['public', 'private'] as const)('preserves a readable verified %s source', async visibility => {
    const h = harness(descriptor(visibility));
    await h.guarded.reads.descriptor(sourceUrl);
    expect(await h.guarded.publish(h.request)).toMatchObject({ published: true, visibility });
    expect(h.sink).toHaveBeenCalledWith(h.request, visibility);
  });

  it.each([
    ['shared', () => descriptor('shared')],
    ['legacy encrypted without audience', () => ({ ...descriptor('private'), ...distribution(sourceUrl, undefined, true) })],
    ['legacy plaintext without audience', () => ({ ...descriptor(), ...distribution(sourceUrl, undefined, false) })],
    ['unobserved encryption', () => ({ ...descriptor(), distribution: undefined })],
    ['undecryptable content', () => ({ ...descriptor('private'), content: undefined })],
    ['unverified source', () => ({ ...descriptor(), authorship: { ...descriptor().authorship!, authorshipVerified: false } })],
    ['private source belonging to another actor', () => ({ ...descriptor('private'), authorship: { ...descriptor().authorship!, signedBy: 'did:example:bob' } })],
    ['claimed public but observed encrypted', () => ({ ...descriptor(), distribution: { url: sourceUrl + '.payload', encrypted: true } })],
    ['declared private but plaintext', () => ({ ...descriptor('private'), ...distribution(sourceUrl, 'private', false) })],
    ['different observed payload', () => ({ ...descriptor(), distribution: { url: sourceUrl + '.other', encrypted: false } })],
    ['conflicting visibility assertions', () => ({ ...descriptor(), turtle: descriptor().turtle!.replace('iep:visibility "public"', 'iep:visibility "public", "private"') })],
    ['duplicate distributions', () => ({ ...descriptor(), turtle: descriptor().turtle! + '\n<> iep:affordance [ a dcat:Distribution ; iep:visibility "public" ] .' })],
  ] as const)('refuses %s before any publication', async (_label, make) => {
    const h = harness(make());
    await h.guarded.reads.descriptor(sourceUrl);
    expect(await h.guarded.publish(h.request)).toMatchObject({ error: 'resource_audience_refused', published: false, committed: false });
    expect(h.sink).not.toHaveBeenCalled();
  });

  it('refuses missing sources, unread predecessors, changed heads and a different actor', async () => {
    const h = harness();
    expect(await h.guarded.publish(h.request)).toMatchObject({ committed: false });
    await h.guarded.reads.descriptor(sourceUrl);
    expect(await h.guarded.publish({ ...h.request, actor: 'did:example:bob' })).toMatchObject({ committed: false });
    expect(await h.guarded.publish({ ...h.request, expectedHead: 'different-cid' })).toMatchObject({ committed: false });
    const changed = protectResourcePublication({ ...h.reads, currentHead: async () => ({ head: { descriptorUrl: sourceUrl + '.unread', cid: 'source-cid' } }) }, actor, h.sink);
    await changed.reads.descriptor(sourceUrl);
    expect(await changed.publish(h.request)).toMatchObject({ committed: false });
    const fork = protectResourcePublication({ ...h.reads, currentHead: async () => ({ forked: true, head: { descriptorUrl: sourceUrl, cid: 'source-cid' } }) }, actor, h.sink);
    await fork.reads.descriptor(sourceUrl);
    expect(await fork.publish(h.request)).toMatchObject({ committed: false });
    expect(h.sink).not.toHaveBeenCalled();
  });

  it('captures privacy before callers mutate a returned source and refuses inconsistent rereads', async () => {
    const h = harness(descriptor('private'));
    const returned = await h.guarded.reads.descriptor(sourceUrl);
    Object.assign(returned, distribution(sourceUrl, 'public'));
    expect(await h.guarded.publish(h.request)).toMatchObject({ visibility: 'private' });
    await h.guarded.reads.descriptor(sourceUrl);
    expect(await h.guarded.publish(h.request)).toMatchObject({ error: 'resource_audience_refused', committed: false });
    expect(h.sink).toHaveBeenCalledTimes(1);
  });

  it('refuses publication while a shared-source read is pending', async () => {
    const h = harness();
    let finishRead!: (value: ResourceDescriptor) => void;
    const pending = new Promise<ResourceDescriptor>(resolve => { finishRead = resolve; });
    const sharedUrl = sourceUrl + '.shared';
    const guarded = protectResourcePublication({ ...h.reads, descriptor: url => url === sharedUrl ? pending : h.reads.descriptor(url) }, actor, h.sink);
    await guarded.reads.descriptor(sourceUrl);
    const sharedRead = guarded.reads.descriptor(sharedUrl);
    expect(await guarded.publish(h.request)).toMatchObject({ committed: false, published: false });
    finishRead({ ...descriptor('shared'), url: sharedUrl, ...distribution(sharedUrl, 'shared') });
    await sharedRead;
    expect(await guarded.publish(h.request)).toMatchObject({ committed: false, published: false });
    expect(h.sink).not.toHaveBeenCalled();
  });

  it('rejects a new source read during the awaited predecessor check and rechecks before writing', async () => {
    const h = harness();
    let finishHead!: (value: Awaited<ReturnType<ResourceReads['currentHead']>>) => void;
    const pendingHead = new Promise<Awaited<ReturnType<ResourceReads['currentHead']>>>(resolve => { finishHead = resolve; });
    const guarded = protectResourcePublication({ ...h.reads, currentHead: async () => pendingHead }, actor, h.sink);
    await guarded.reads.descriptor(sourceUrl);
    const publication = guarded.publish(h.request);
    await expect(guarded.reads.descriptor(sourceUrl + '.shared')).rejects.toThrow('during derived publication');
    finishHead({ head: { descriptorUrl: sourceUrl, cid: 'source-cid' } });
    expect(await publication).toMatchObject({ committed: false, published: false });
    expect(h.sink).not.toHaveBeenCalled();
  });

  it('uses source binding guarantees without adding a delegation trust-label requirement', async () => {
    const source = descriptor();
    const h = harness({ ...source, authorship: { ...source.authorship!, effectiveTrustLevel: 'SelfAsserted' } });
    await h.guarded.reads.descriptor(sourceUrl);
    expect(await h.guarded.publish(h.request)).toMatchObject({ visibility: 'public', published: true });
  });

  it('publishes the checked request snapshot despite mutations during the predecessor read', async () => {
    const h = harness();
    let finishHead!: (value: Awaited<ReturnType<ResourceReads['currentHead']>>) => void;
    const pendingHead = new Promise<Awaited<ReturnType<ResourceReads['currentHead']>>>(resolve => { finishHead = resolve; });
    const guarded = protectResourcePublication({ ...h.reads, currentHead: async () => pendingHead }, actor, h.sink);
    await guarded.reads.descriptor(sourceUrl);
    const original = { ...h.request };
    const publication = guarded.publish(h.request);
    Object.assign(h.request, { actor: 'did:example:bob', podUrl: 'https://other.example/', graphIri: 'urn:other', graphContent: 'changed', expectedHead: 'changed' });
    finishHead({ head: { descriptorUrl: sourceUrl, cid: 'source-cid' } });
    expect(await publication).toMatchObject({ published: true });
    expect(h.sink).toHaveBeenCalledWith(original, 'public');
  });
});

/** Actual interpreter, accounting and encryption; source signature checks are fixture doubles. */
async function applicationFixture(initialVisibility: Visibility, evidenceVisibility?: Visibility) {
  const pack = releaseControl();
  const first = { ...pack.contract.actions[0]!, label: 'Accept evidence',
    ...(evidenceVisibility !== undefined ? {
      inputs: [{ name: 'proof', type: 'iri', required: true }],
      evidence: [{ input: 'proof', documentType: 'test-proof', requireCurrentHead: false }],
    } : {}) };
  const second = { ...pack.contract.actions[0]!, actionIri: pack.contract.applicationId + ':finish', label: 'Finish',
    guard: { op: 'eq', left: true, right: true }, effects: [{ op: 'set', path: '$state.status', value: 'finished' }] };
  const store = fixtureStore({ ...pack, contract: { ...pack.contract, actions: [first, second] } });
  const initial = await store.resolve();
  const privacy = new Map<string, Visibility>([[initial.stateDescriptor.url, initialVisibility]]);
  const proofUrl = podUrl + 'context-graphs/proof.ttl';
  const secret = 'private-evidence-marker';
  if (evidenceVisibility !== undefined) {
    const proof = signedJsonGraph('urn:test:proof', 'test-proof', { passed: true, secret });
    store.descriptors.set(proofUrl, { ...initial.stateDescriptor, url: proofUrl, cid: 'proof-cid', content: proof.graphContent });
    privacy.set(proofUrl, evidenceVisibility);
  }
  const reads: ResourceReads = { ...store.reads, discover: store.reads.discoverCatalogs, descriptor: async url => {
    const source = await store.reads.descriptor(url);
    const visibility = privacy.has(url) ? privacy.get(url) : 'public';
    return { ...source, authorship: { ...source.authorship!, signedBy: actor }, ...distribution(url, visibility) };
  } };
  const ownerKey = generateKeyPair();
  const otherKey = generateKeyPair();
  const writes: { visibility: 'public' | 'private'; content: string; stored: string }[] = [];
  const sink = vi.fn(async (request: Parameters<ResourceWriteContext['publish']>[0], visibility: 'public' | 'private') => {
    const parsed = parseSignedJsonDocument(request.graphContent);
    const previous = store.heads.get(store.graphs.state)!.head!;
    expect(request.expectedHead).toBe(previous.cid);
    const url = podUrl + `context-graphs/state-${parsed.document.version}.ttl`;
    const cid = 'fixture-cid-' + parsed.declaredDigest;
    store.descriptors.set(url, { ...initial.stateDescriptor, url, cid, content: request.graphContent, authorship: { ...initial.stateDescriptor.authorship!, signedBy: actor } });
    store.heads.set(store.graphs.state, { head: { descriptorUrl: url, cid }, forked: false });
    store.history.push({ descriptorUrl: url, cid, supersedes: [previous.descriptorUrl!] });
    privacy.set(url, visibility);
    const stored = visibility === 'public' ? request.graphContent : JSON.stringify(createEncryptedEnvelope(request.graphContent, [ownerKey.publicKey], ownerKey));
    writes.push({ visibility, content: request.graphContent, stored });
    return { published: true, visibility };
  });
  const registry = new ResourceCompositions([application]);
  const context = () => ({ principal: actor, identityUrl: 'https://identity.example', now: '2026-09-13T12:00:00.000Z',
    ...protectResourcePublication(reads, actor, sink) });
  const invoke = async (label: string, payload = {}) => {
    const view = await registry.render(initial.catalogDescriptor.url, { reads, principal: actor, identityUrl: 'https://identity.example', now: '2026-09-13T12:00:00.000Z' }, await reads.descriptor(initial.catalogDescriptor.url));
    const control = view!.controls.find(c => c['label'] === 'Submit: ' + label)!;
    return registry.invoke(String(control['descriptorUrl']), String(control['action']), payload, context());
  };
  return { invoke, sink, writes, proofUrl, secret, ownerKey, otherKey };
}

describe('application state and receipt publication', () => {
  it('keeps a private predecessor and its derived receipt encrypted', async () => {
    const h = await applicationFixture('private');
    expect(await h.invoke('Accept evidence')).toMatchObject({ committed: true });
    expect(h.writes[0]!.visibility).toBe('private');
    expect(parseSignedJsonDocument(h.writes[0]!.content).document).toHaveProperty('transition.receipt');
    const envelope = JSON.parse(h.writes[0]!.stored);
    expect(openEncryptedEnvelope(envelope, h.ownerKey)).toBe(h.writes[0]!.content);
    expect(openEncryptedEnvelope(envelope, h.otherKey)).toBeNull();
  });

  it('protects private evidence copied into a public state receipt, including the next transition', async () => {
    const h = await applicationFixture('public', 'private');
    expect(await h.invoke('Accept evidence', { proof: h.proofUrl })).toMatchObject({ committed: true });
    expect(JSON.stringify(parseSignedJsonDocument(h.writes[0]!.content).document)).toContain(h.secret); // The interpreter embeds the entire evidence document.
    expect(h.writes[0]!.visibility).toBe('private');
    expect(h.writes[0]!.stored).not.toContain(h.secret);
    expect(openEncryptedEnvelope(JSON.parse(h.writes[0]!.stored), h.otherKey)).toBeNull();
    expect(await h.invoke('Finish')).toMatchObject({ committed: true });
    expect(h.writes.map(write => write.visibility)).toEqual(['private', 'private']);
  });

  it('preserves public behavior only when all consulted sources are explicitly public', async () => {
    const h = await applicationFixture('public', 'public');
    expect(await h.invoke('Accept evidence', { proof: h.proofUrl })).toMatchObject({ committed: true });
    expect(h.writes[0]!.visibility).toBe('public');
    expect(h.writes[0]!.stored).toBe(h.writes[0]!.content);
  });

  it('refuses shared evidence before committing a successor instead of recomputing a broader audience', async () => {
    const h = await applicationFixture('public', 'shared');
    expect(await h.invoke('Accept evidence', { proof: h.proofUrl })).toMatchObject({ committed: false, error: 'application_action_refused' });
    expect(h.sink).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});
