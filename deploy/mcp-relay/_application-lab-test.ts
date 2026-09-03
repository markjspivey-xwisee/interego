import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalJson,
  descriptorTrusted,
  evaluateGuard,
  parseSignedJsonDocument,
  prepareApplicationAction,
  resolveApplicationLab,
  sha256Hex,
  signedJsonGraph,
  type ApplicationLabReads,
  type Json,
  type LabDescriptor,
} from './application-lab-runtime.js';
import { APPLICATION_LAB_APP_HTML } from './application-lab-app.js';

const APP = 'urn:test:application:one';
const CATALOG = 'urn:graph:interego:application-catalog:v1';
const DEF_G = 'urn:graph:test:definition';
const V1_G = 'urn:graph:test:contract:v1';
const V2_G = 'urn:graph:test:contract:v2';
const STATE_G = 'urn:graph:test:state';
const GOV_G = 'urn:graph:test:governance';
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
const s0 = { applicationId: APP, data: { count: 0, status: 'open' }, schema: 'interego.application.state/v1', version: 0 } as unknown as Record<string, Json>;
const r1 = receipt(`${APP}:action:increment`, 'did:example:agent', '2026-01-01T00:00:01.000Z', v1Graph.digest, url('v1-contract'), 'cid-0', 'increment', { count: 1 }, 0);
const s1 = { applicationId: APP, data: { count: 1, status: 'open' }, schema: 'interego.application.state/v1', transition: { actionIri: r1.actionIri, at: r1.at, prior: { cid: 'cid-0', descriptorUrl: url('s0') }, receipt: r1, receiptDigest: sha256Hex(canonicalJson(r1)) }, version: 1 } as unknown as Record<string, Json>;
const r2 = receipt(`${APP}:action:finish`, 'did:example:agent', '2026-01-01T00:00:02.000Z', v2Graph.digest, url('v2-contract'), 'cid-1', 'finish', {}, 1);
const s2 = { applicationId: APP, data: { count: 1, status: 'done' }, schema: 'interego.application.state/v1', transition: { actionIri: r2.actionIri, at: r2.at, prior: { cid: 'cid-1', descriptorUrl: url('s1') }, receipt: r2, receiptDigest: sha256Hex(canonicalJson(r2)) }, version: 2 } as unknown as Record<string, Json>;
const s0Graph = signedJsonGraph(STATE_G, 'application-state', s0);
const s1Graph = signedJsonGraph(STATE_G, 'application-state', s1);
const s2Graph = signedJsonGraph(STATE_G, 'application-state', s2);
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
]);
const descriptorCids = new Map<string, string>([
  [url('catalog'), 'cid-cat'], [url('definition'), 'cid-def'],
  [url('v1-contract'), 'cid-c1'], [url('v2-contract'), 'cid-c2'],
  [url('governance'), 'cid-gov'], [url('s0'), 'cid-0'],
  [url('s1'), 'cid-1'], [url('s2'), 'cid-2'],
]);
const descriptor = (u: string): LabDescriptor => ({ url: u, cid: descriptorCids.get(u), content: bodies.get(u), authorship: trusted });
const heads = new Map<string, { descriptorUrl: string; cid: string }>([
  [CATALOG, { descriptorUrl: url('catalog'), cid: 'cid-cat' }], [DEF_G, { descriptorUrl: url('definition'), cid: 'cid-def' }],
  [V1_G, { descriptorUrl: url('v1-contract'), cid: 'cid-c1' }], [V2_G, { descriptorUrl: url('v2-contract'), cid: 'cid-c2' }],
  [GOV_G, { descriptorUrl: url('governance'), cid: 'cid-gov' }], [STATE_G, { descriptorUrl: url('s2'), cid: 'cid-2' }],
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

assert.ok(APPLICATION_LAB_APP_HTML.startsWith('<!doctype html>'));
assert.ok(APPLICATION_LAB_APP_HTML.includes("callTool('open_application_lab'"));
assert.ok(APPLICATION_LAB_APP_HTML.includes("callTool('execute_application_action'"));
assert.ok(!APPLICATION_LAB_APP_HTML.includes('Release Control'));
assert.ok(!/<script\s+src=|<link\s+href=|@import/i.test(APPLICATION_LAB_APP_HTML));
assert.ok(!/\son[a-z]+\s*=/.test(APPLICATION_LAB_APP_HTML));

const relaySource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
assert.match(relaySource, /const writePodName = podNameOf\(resolved\.podUrl\);/);
assert.match(relaySource, /pod_name: writePodName,/);

console.log('application-lab: canonical binding, two-epoch replay, CAS preparation, and generic MCP App verified');
