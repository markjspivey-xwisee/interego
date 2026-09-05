import assert from 'node:assert/strict';
import {
  canonicalJson,
  descriptorTrusted,
  evaluateGuard,
  parseSignedJsonDocument,
  prepareApplicationAction,
  resolveApplicationActionEvidence,
  resolveApplicationLab,
  sha256Hex,
  signedJsonGraph,
  type ApplicationLabReads,
  type Json,
  type LabDescriptor,
} from '../../integrations/application-runtime/application-lab-runtime.js';

const APP = 'urn:test:application:one';
const CATALOG = 'urn:graph:interego:application-catalog:v1';
const DEF_G = 'urn:graph:test:definition';
const V1_G = 'urn:graph:test:contract:v1';
const V2_G = 'urn:graph:test:contract:v2';
const STATE_G = 'urn:graph:test:state';
const GOV_G = 'urn:graph:test:governance';
const EVIDENCE_G = 'urn:graph:test:performance-readiness';
const POD = 'https://pod.example/alice/';
const url = (name: string) => `${POD}context-graphs/${name}.ttl`;

const trusted = {
  authorshipVerified: true,
  contentBinding: 'bound',
  descriptorBinding: { bound: true, basis: 'fixture' },
  effectiveTrustLevel: 'CryptographicallyVerified',
  signedBy: 'did:example:agent',
  verificationMethod: 'did:example:key',
};

const v1 = {
  actions: [{
    actionIri: `${APP}:action:increment`, effects: [{ op: 'set', path: '$state.count', value: '$payload.count' }],
    goal: 'increment', guard: true, inputs: [{ name: 'count', type: 'number', required: true }], label: 'Increment',
    method: 'POST', target: 'urn:interego:runtime:signed-domain:v1',
  }],
  applicationId: APP, runtimeIri: 'urn:interego:runtime:signed-domain:v1', schema: 'interego.application.contract/v1', version: '1.0.0',
} as unknown as Record<string, Json>;
const v2 = {
  actions: [
    {
      actionIri: `${APP}:action:finish`, effects: [{ op: 'set', path: '$state.status', value: 'done' }],
      goal: 'finish', guard: { left: { path: '$state.count' }, op: 'eq', right: 1 }, inputs: [], label: 'Finish',
      method: 'POST', target: 'urn:interego:runtime:signed-domain:v1',
    },
    {
      actionIri: `${APP}:action:archive`, effects: [{ op: 'set', path: '$state.archived', value: true }],
      goal: 'archive', guard: { left: { path: '$state.status' }, op: 'eq', right: 'done' }, inputs: [], label: 'Archive',
      method: 'POST', target: 'urn:interego:runtime:signed-domain:v1',
    },
    {
      actionIri: `${APP}:action:accept-readiness`,
      effects: [
        { op: 'set', path: '$state.releaseReady', value: true },
        { op: 'set', path: '$state.readinessEvidence', value: {
          descriptorUrl: { path: '$evidence.readiness_descriptor.descriptorUrl' },
          cid: { path: '$evidence.readiness_descriptor.cid' },
          documentDigest: { path: '$evidence.readiness_descriptor.documentDigest' },
        } },
      ],
      evidence: [{
        input: 'readiness_descriptor', role: 'performance-readiness',
        documentType: 'agp-performance-readiness', graphIri: EVIDENCE_G,
        signedBy: ['did:example:agent'],
      }],
      goal: 'accept independently verified performance readiness',
      guard: { op: 'all', guards: [
        { left: { path: '$state.status' }, op: 'eq', right: 'done' },
        { left: { path: '$evidence.readiness_descriptor.document.ready' }, op: 'eq', right: true },
        { left: { path: '$evidence.readiness_descriptor.document.subjectDigest' }, op: 'eq', right: { path: '$state.candidateDigest' } },
      ] },
      inputs: [{ name: 'readiness_descriptor', type: 'iri', required: true }],
      label: 'Accept readiness evidence', method: 'POST', target: 'urn:interego:runtime:signed-domain:v1',
    },
  ],
  applicationId: APP, runtimeIri: 'urn:interego:runtime:signed-domain:v1', schema: 'interego.application.contract/v1', version: '2.0.0',
} as unknown as Record<string, Json>;

const v1Graph = signedJsonGraph(V1_G, 'application-contract', v1);
const v2Graph = signedJsonGraph(V2_G, 'application-contract', v2);
const definition = {
  contractGraphIri: V1_G, description: 'fixture', id: APP, schema: 'interego.application.definition/v1', stateGraphIri: STATE_G,
  title: 'Fixture application', ui: { primaryView: 'status', views: [{ id: 'status', kind: 'value', label: 'Status', path: 'status' }] }, version: '1.0.0',
} as unknown as Record<string, Json>;
const defGraph = signedJsonGraph(DEF_G, 'application-definition', definition);

function receipt(actionIri: string, actor: string, at: string, contractDigest: string, descriptorUrl: string, expectedHead: string, goal: string, payload: Record<string, Json>, stateVersion: number) {
  return { actionIri, actor, applicationId: APP, at, contractDigest, descriptorUrl, expectedHead, goal, payload, stateVersion, version: 1 } as Record<string, Json>;
}
const s0 = { applicationId: APP, data: { candidateDigest: 'candidate-sha256', count: 0, releaseReady: false, status: 'open' }, schema: 'interego.application.state/v1', version: 0 } as unknown as Record<string, Json>;
const r1 = receipt(`${APP}:action:increment`, 'did:example:agent', '2026-01-01T00:00:01.000Z', v1Graph.digest, url('v1-contract'), 'cid-0', 'increment', { count: 1 }, 0);
const s1 = { applicationId: APP, data: { candidateDigest: 'candidate-sha256', count: 1, releaseReady: false, status: 'open' }, schema: 'interego.application.state/v1', transition: { actionIri: r1.actionIri, at: r1.at, prior: { cid: 'cid-0', descriptorUrl: url('s0') }, receipt: r1, receiptDigest: sha256Hex(canonicalJson(r1)) }, version: 1 } as unknown as Record<string, Json>;
const r2 = receipt(`${APP}:action:finish`, 'did:example:agent', '2026-01-01T00:00:02.000Z', v2Graph.digest, url('v2-contract'), 'cid-1', 'finish', {}, 1);
const s2 = { applicationId: APP, data: { candidateDigest: 'candidate-sha256', count: 1, releaseReady: false, status: 'done' }, schema: 'interego.application.state/v1', transition: { actionIri: r2.actionIri, at: r2.at, prior: { cid: 'cid-1', descriptorUrl: url('s1') }, receipt: r2, receiptDigest: sha256Hex(canonicalJson(r2)) }, version: 2 } as unknown as Record<string, Json>;
const s0Graph = signedJsonGraph(STATE_G, 'application-state', s0);
const s1Graph = signedJsonGraph(STATE_G, 'application-state', s1);
const s2Graph = signedJsonGraph(STATE_G, 'application-state', s2);
const readinessDocument = {
  schema: 'agp.performance-readiness/v1',
  subjectDigest: 'candidate-sha256',
  ready: true,
  regime: 'Knowable',
  modalStatus: 'Asserted',
  heldOutEvaluation: { cases: 8, passed: 8, suiteDigest: 'held-out-suite-sha256' },
  standardsEvidence: { xapiStatements: 9, lerDescriptorUrl: 'https://pod.example/learner/ler.ttl' },
} as unknown as Record<string, Json>;
const readinessGraph = signedJsonGraph(EVIDENCE_G, 'agp-performance-readiness', readinessDocument);
const governance = signedJsonGraph(GOV_G, 'application-governance-state', {
  applicationId: `${APP}:governance`, data: { activeEpoch: {
    applicationId: APP,
    contractCid: 'cid-c2',
    contractDescriptorUrl: url('v2-contract'),
    contractDigest: v2Graph.digest,
    contractGraphIri: V2_G,
    definitionCid: 'cid-def',
    definitionDescriptorUrl: url('definition'),
    definitionDigest: defGraph.digest,
    definitionGraphIri: DEF_G,
  }, targetApplicationId: APP }, schema: 'interego.application.state/v1', version: 1,
});
const catalog = signedJsonGraph(CATALOG, 'application-catalog', {
  applications: [{
    applicationId: APP, contractGraphIri: V1_G, definitionDescriptorUrl: url('definition'), definitionGraphIri: DEF_G,
    governanceStateGraphIri: GOV_G,
    manifestCids: {
      contract: { cid: 'cid-c1', descriptorUrl: url('v1-contract'), documentDigest: v1Graph.digest, graphIri: V1_G },
      definition: { cid: 'cid-def', descriptorUrl: url('definition'), documentDigest: defGraph.digest, graphIri: DEF_G },
      genesisState: { cid: 'cid-0', descriptorUrl: url('s0'), documentDigest: s0Graph.digest, graphIri: STATE_G },
    },
    stateGraphIri: STATE_G, title: 'Fixture application', version: '1.0.0',
  }], id: CATALOG, schema: 'interego.application.catalog/v1', version: 2,
});

const bodies = new Map<string, string>([
  [url('catalog'), catalog.graphContent], [url('definition'), defGraph.graphContent],
  [url('v1-contract'), v1Graph.graphContent], [url('v2-contract'), v2Graph.graphContent],
  [url('governance'), governance.graphContent], [url('s0'), s0Graph.graphContent],
  [url('s1'), s1Graph.graphContent], [url('s2'), s2Graph.graphContent],
  [url('readiness'), readinessGraph.graphContent],
]);
const descriptorCids = new Map<string, string>([
  [url('catalog'), 'cid-cat'], [url('definition'), 'cid-def'],
  [url('v1-contract'), 'cid-c1'], [url('v2-contract'), 'cid-c2'],
  [url('governance'), 'cid-gov'], [url('s0'), 'cid-0'],
  [url('s1'), 'cid-1'], [url('s2'), 'cid-2'], [url('readiness'), 'cid-ready'],
]);
const descriptor = (u: string): LabDescriptor => ({ url: u, cid: descriptorCids.get(u), content: bodies.get(u), authorship: trusted });
const heads = new Map<string, { descriptorUrl: string; cid: string }>([
  [CATALOG, { descriptorUrl: url('catalog'), cid: 'cid-cat' }], [DEF_G, { descriptorUrl: url('definition'), cid: 'cid-def' }],
  [V1_G, { descriptorUrl: url('v1-contract'), cid: 'cid-c1' }], [V2_G, { descriptorUrl: url('v2-contract'), cid: 'cid-c2' }],
  [GOV_G, { descriptorUrl: url('governance'), cid: 'cid-gov' }], [STATE_G, { descriptorUrl: url('s2'), cid: 'cid-2' }],
  [EVIDENCE_G, { descriptorUrl: url('readiness'), cid: 'cid-ready' }],
]);
const history = [
  { descriptorUrl: url('s0'), cid: 'cid-0', validFrom: '2026-01-01T00:00:00.000Z' },
  { descriptorUrl: url('s1'), cid: 'cid-1', validFrom: '2026-01-01T00:00:01.000Z' },
  { descriptorUrl: url('s2'), cid: 'cid-2', validFrom: '2026-01-01T00:00:02.000Z' },
];
const reads: ApplicationLabReads = {
  discoverCatalogs: async () => [{ podUrl: POD, entry: { descriptorUrl: url('catalog'), cid: 'cid-cat', validFrom: '2026-01-01T00:00:03.000Z' } }],
  currentHead: async (_pod, graph) => ({ forked: false, head: heads.get(graph) ?? null }),
  discoverGraph: async (_pod, graph) => graph === STATE_G ? history : [],
  descriptor: async u => { const d = descriptor(u); if (!d.content) throw new Error(`missing fixture ${u}`); return d; },
};

const parsed = parseSignedJsonDocument(catalog.graphContent);
assert.equal(parsed.digestVerified, true);
assert.equal(descriptorTrusted(descriptor(url('catalog')), parsed), true);
assert.deepEqual(JSON.parse(canonicalJson({ z: 1, a: { y: true, x: 2 } })), { a: { x: 2, y: true }, z: 1 });
assert.equal(evaluateGuard({ guards: [{ left: { path: '$state.status' }, op: 'eq', right: 'done' }], op: 'all' }, { state: { status: 'done' } }).pass, true);
assert.equal(evaluateGuard({ op: 'invented' }, {}).supported, false);

const resolved = await resolveApplicationLab({ actor: 'did:example:agent', applicationId: APP }, reads);
assert.equal(resolved.activeContract.version, '2.0.0');
assert.equal(resolved.replay.complete, true);
assert.equal(resolved.replay.chainLength, 3);
assert.equal(resolved.replay.contractEpochs.length, 2);
assert.equal((resolved.snapshot.trust as Record<string, Json>).verified, true);
assert.equal((resolved.snapshot.actions as unknown as Array<Record<string, Json>>)[1]!.executable, true);

const prepared = prepareApplicationAction(resolved, {
  actionIri: `${APP}:action:archive`, actor: 'did:example:agent', now: '2026-01-01T00:00:03.000Z', expectedHead: 'cid-2', payload: {},
});
assert.equal(prepared.successor.version, 3);
assert.equal(prepared.successor.data.archived, true);
assert.equal(parseSignedJsonDocument(prepared.graphContent).digestVerified, true);
assert.throws(() => prepareApplicationAction(resolved, { actionIri: `${APP}:action:archive`, actor: 'did:example:agent', now: '2026-01-01T00:00:03.000Z', expectedHead: 'stale', payload: {} }), /stale application head/);

const readinessPayload = { readiness_descriptor: url('readiness') };
await assert.rejects(
  resolveApplicationActionEvidence(resolved, { actionIri: `${APP}:action:accept-readiness`, payload: readinessPayload }, {
    ...reads,
    descriptor: async u => u === url('readiness') ? { ...descriptor(u), authorship: { ...trusted, authorshipVerified: false } } : reads.descriptor(u),
  }),
  /not fully verified/,
);
heads.set(EVIDENCE_G, { descriptorUrl: url('superseding-readiness'), cid: 'cid-new-ready' });
await assert.rejects(
  resolveApplicationActionEvidence(resolved, { actionIri: `${APP}:action:accept-readiness`, payload: readinessPayload }, reads),
  /not the singular current graph head/,
);
heads.set(EVIDENCE_G, { descriptorUrl: url('readiness'), cid: 'cid-ready' });
const verifiedEvidence = await resolveApplicationActionEvidence(
  resolved,
  { actionIri: `${APP}:action:accept-readiness`, payload: readinessPayload },
  reads,
);
assert.equal(verifiedEvidence.length, 1);
assert.equal(verifiedEvidence[0]!.documentDigest, readinessGraph.digest);
assert.throws(() => prepareApplicationAction(resolved, {
  actionIri: `${APP}:action:accept-readiness`, actor: 'did:example:agent', now: '2026-01-01T00:00:03.000Z',
  expectedHead: 'cid-2', payload: readinessPayload,
  evidence: [{ ...verifiedEvidence[0]! }],
}), /not produced by the verifier/);
await assert.rejects(
  resolveApplicationActionEvidence(resolved, { actionIri: `${APP}:action:accept-readiness`, payload: readinessPayload }, {
    ...reads,
    descriptor: async u => u === url('readiness') ? {
      ...descriptor(u),
      authorship: { ...trusted, signedBy: 'did:example:unapproved', verificationMethod: 'did:example:unapproved#key-1' },
    } : reads.descriptor(u),
  }),
  /evidence signer is not allowed/,
);
assert.throws(() => prepareApplicationAction(resolved, {
  actionIri: `${APP}:action:accept-readiness`, actor: 'did:example:agent', now: '2026-01-01T00:00:03.000Z',
  expectedHead: 'cid-2', payload: readinessPayload,
}), /evidence count mismatch/);
const accepted = prepareApplicationAction(resolved, {
  actionIri: `${APP}:action:accept-readiness`, actor: 'did:example:agent', now: '2026-01-01T00:00:03.000Z',
  expectedHead: 'cid-2', payload: readinessPayload, evidence: verifiedEvidence,
});
assert.equal(accepted.successor.data.releaseReady, true);
assert.equal((accepted.successor.data.readinessEvidence as Record<string, Json>).cid, 'cid-ready');
assert.equal((accepted.receipt.evidence as Json[]).length, 1);

// Add the successor exactly as a pod would, then resolve from scratch. Replay
// re-fetches the external descriptor and verifies the receipt's snapshot.
bodies.set(url('s3'), accepted.graphContent);
descriptorCids.set(url('s3'), 'cid-3');
heads.set(STATE_G, { descriptorUrl: url('s3'), cid: 'cid-3' });
history.push({ descriptorUrl: url('s3'), cid: 'cid-3', validFrom: '2026-01-01T00:00:03.000Z' });
const afterEvidence = await resolveApplicationLab({ actor: 'did:example:agent', applicationId: APP }, reads);
assert.equal(afterEvidence.replay.complete, true);
assert.equal(afterEvidence.replay.chainLength, 4);
assert.equal(afterEvidence.replay.links[3]!.evidenceVerified, true);
assert.equal(afterEvidence.replay.links[3]!.evidenceCount, 1);

const originalEvidenceBody = bodies.get(url('readiness'))!;
bodies.set(url('readiness'), signedJsonGraph(EVIDENCE_G, 'agp-performance-readiness', {
  ...readinessDocument,
  subjectDigest: 'different-candidate',
  ready: false,
} as unknown as Record<string, Json>).graphContent);
const afterEvidenceSwap = await resolveApplicationLab({ actor: 'did:example:agent', applicationId: APP }, reads);
assert.equal(afterEvidenceSwap.replay.complete, false);
assert.equal(afterEvidenceSwap.replay.links[3]!.evidenceVerified, false);
assert.ok(afterEvidenceSwap.replay.links[3]!.errors.some(e => e.includes('evidence signed')));
bodies.set(url('readiness'), originalEvidenceBody);

console.log('application runtime: canonical binding, two-epoch replay, evidence verification and CAS preparation verified');
