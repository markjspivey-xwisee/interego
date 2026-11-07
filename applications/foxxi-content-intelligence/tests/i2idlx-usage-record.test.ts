import { describe, expect, it, vi } from 'vitest';
// The structural validator reads the real xAPI model. Its publishing substrate
// is outside this test's persistence boundary and must not start pod services.
vi.mock('../src/spec-ontology.js', () => ({ NS_ROOT: 'https://foxxi-bridge.interego.xwisee.com/ns/' }));
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { DataFactory, Parser, Store } from 'n3';
import { projectUsageRecord, persistStatementWithUsage } from '../src/i2idlx-usage-record.js';
import { writeSelfXapi } from '../src/self-xapi.js';

const ns = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#';
const canonical = 'https://id.i2idl.org/concepts/learning-engineering';
const authored = ns + 'concept-competency-framework';
const did = 'did:web:learner.example:agent';
const tags = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds';
const concepts = new Map([
  [canonical, { id: 'learning-engineering', iri: canonical, label: 'Learning engineering', origin: { kind: 'canonical', release: 'v0.0.93', commit: 'b75261de5ad7851c1f61607091cc00e486bbbb5f' } }],
  [authored, { id: 'competency-framework', iri: authored, label: 'Competency framework', origin: { kind: 'authored', catalogVersion: '0.1.0', reviewedProposalSha256: 'f711272b203a8fe74dd26d71b895eca9ee39d05d5a0f8326f70a2852ebc3109b', status: 'Hypothetical' } }],
]);
const context = () => ({ ns, agentDid: did, concepts, generatedAt: '2026-11-04T05:00:00.000Z' });
function statement() { return {
  id: '2f009091-2825-46fd-90af-1c6f72dc182f', timestamp: '2026-11-04T04:00:00Z',
  actor: { objectType: 'Agent', account: { homePage: 'https://learner.example', name: did } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' },
  object: { objectType: 'Activity', id: 'https://example.org/programme' },
  context: { extensions: { [tags]: [authored, canonical, authored, ns + 'concept-not-authored', 'learning-engineering', 'https://id.i2idl.org/concepts/not-in-source'] } },
}; }
const enriched = () => ({ ...statement(), stored: '2026-11-04T04:00:01.000Z', authority: { account: { homePage: 'https://lrs.example', name: 'lrs' } } });

/** Execute the actual persist callback from the signed server route, without starting its listeners. */
function signedPersist(composeIntoSharedLattice: (args: Record<string, unknown>) => Promise<unknown>) {
  const source = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
  let callback: ts.ArrowFunction | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'persist' && ts.isArrowFunction(node.initializer) && node.initializer.getText(ast).includes('contentType: \'xapi:Statement\'')) callback = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!callback) throw new Error('Actual signed statement persistence callback not found');
  const js = ts.transpileModule('const routePersist = ' + callback.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return Function('composeIntoSharedLattice', 'persistStatementWithUsage', 'loadPublicTaskData', 'resolveConceptIndex', 'bound', 'podUrl', 'label', 'telemetry', 'bridgeBaseUrl', js + '; return routePersist;')(
    composeIntoSharedLattice, persistStatementWithUsage,
    async () => ({ meta: { ns }, concepts: [...concepts.values()] }), () => concepts,
    { callerDid: did }, 'https://pod.example/learner/', 'learner', false, 'https://bridge.example',
  ) as (value: Record<string, unknown>) => Promise<unknown>;
}

function ownLatticeHandler(artifacts: Map<string, unknown>) {
  const source = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
  let callback: ts.ArrowFunction | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'app.post' && node.arguments[0]?.getText(ast) === "'/agent/lattice/self'" && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) callback = node.arguments[1];
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!callback) throw new Error('Existing signed own-lattice route not found');
  const js = ts.transpileModule('const handler = ' + callback.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return Function('bindSignedCaller', 'checkAgenticRateLimit', 'enrolmentPodFor', 'actorForPod', 'MESH_ACTOR_LABELS', 'isResident', 'ensureResident', 'projectAs', 'readArtifact', 'latticeNamespaceView', 'sendServerError', js + '; return handler;')(
    async (body: Record<string, unknown>) => body.valid ? { ok: true, callerDid: body.caller, payload: body, authMode: 'existing-signature' } : { ok: false, status: 401, error: 'signature required' },
    () => ({ ok: true }), (caller: string) => ({ pod: 'https://pod.example/' + caller + '/' }),
    (pod: string) => pod.split('/').filter(Boolean).at(-1), {}, () => true, async () => {},
    (label: string, uri: string) => artifacts.has(label + ':' + uri) ? '<urn:descriptor> a <urn:Descriptor> .' : null,
    (label: string, uri: string) => artifacts.get(label + ':' + uri), () => ({}),
    () => { throw new Error('Unexpected own-lattice route error'); },
  ) as (req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>;
}

describe('signed xAPI usage evidence', () => {
  it('runs the actual signed persist callback after LRS readback and retains a private derived artifact', async () => {
    const artifacts: Array<Record<string, unknown>> = [];
    const actual = enriched(), before = JSON.stringify(actual), caller = statement();
    const persist = signedPersist(async args => { artifacts.push(structuredClone(args)); return { persisted: true, holonUri: 'urn:test:artifact:' + artifacts.length, descriptorUrl: 'https://pod.example/computed-descriptor-' + artifacts.length }; });
    const response = await writeSelfXapi(did, [caller], {
      request: async method => method === 'POST' ? { status: 200, body: [caller.id] } : { status: 200, body: actual },
      persist: persist as never,
    });
    expect(response.status).toBe(200);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.content).toEqual(actual);
    expect(artifacts[1]!.contentType).toBe(ns + 'UsageRecord');
    const record = artifacts[1]!.content as ReturnType<typeof projectUsageRecord>;
    expect(record!.concepts.map(c => c.iri)).toEqual([canonical, authored].sort());
    expect(record!.concepts.map(c => c.origin.kind).sort()).toEqual(['authored', 'canonical']);
    expect(record!.sourceStored).toBe(actual.stored);
    expect(record!.sourceTimestamp).toBe(actual.timestamp);
    expect(record!.graph_content).toContain('urn:uuid:' + actual.id);
    expect(record!.graph_content).not.toContain('isClassifiedBy');
    expect(record!.graphSha256).toBe(createHash('sha256').update(record!.graph_content).digest('hex'));
    expect(record!.inference).toBe('usage-only; no achievement or competency assertion');
    expect(artifacts[1]!.podUrl).toBe(artifacts[0]!.podUrl);
    expect(artifacts[1]!.agentDid).toBe(did);
    expect(artifacts[1]!.publishDescriptor).toBe(false);
    expect(artifacts[1]!.publicLattice).not.toBe(true);
    expect(JSON.stringify(actual)).toBe(before);
    expect((response.body as { receipts: Array<{ usageRecord: { status: string; holonUri: string } }> }).receipts[0]!.usageRecord).toMatchObject({ status: 'persisted', holonUri: 'urn:test:artifact:2' });
    expect((response.body as { receipts: Array<{ descriptorUrl: string }> }).receipts[0]!.descriptorUrl).toBe('https://pod.example/computed-descriptor-1');
    expect((response.body as { receipts: Array<{ usageRecord: unknown }> }).receipts[0]!.usageRecord).not.toHaveProperty('descriptorUrl');
    expect((response.body as { receipts: Array<{ usageRecord: { graphSha256: string } }> }).receipts[0]!.usageRecord.graphSha256).toBe(record!.graphSha256);
  });

  it('projects exact source identities, RDF shape fields, dates and aboutness without minting a canonical concept', () => {
    const record = projectUsageRecord(enriched(), context())!;
    const g = new Store(new Parser().parse(record.graph_content));
    const { namedNode: n } = DataFactory, s = n(record.recordIri);
    expect(g.countQuads(s, n(ns + 'aboutConcept'), null, null)).toBe(2);
    for (const property of ['statement', 'usageVerb']) expect(g.countQuads(s, n(ns + property), null, null)).toBe(1);
    expect(g.getObjects(s, n('http://www.w3.org/ns/prov#generatedAtTime'), null)[0]!.value).toBe('2026-11-04T05:00:00.000Z');
    expect(g.getObjects(s, n('http://www.w3.org/ns/prov#generatedAtTime'), null)[0]!.termType).toBe('Literal');
    expect(record.unrecognizedTags).toEqual(['learning-engineering', ns + 'concept-not-authored', 'https://id.i2idl.org/concepts/not-in-source'].sort());
    expect(record.graph_content).not.toContain('https://id.i2idl.org/concepts/competency-framework');
    expect(projectUsageRecord(enriched(), context())).toEqual(record);
    expect(record.generatedAt).not.toBe(record.sourceTimestamp);
    expect(record.generatedAt).not.toBe(record.sourceStored);
    expect(record.sourceTimestamp).not.toBe(record.sourceStored);
    expect(projectUsageRecord(enriched(), { ...context(), generatedAt: '2026-11-04T06:00:00.000Z' })!.recordIri).toBe(record.recordIri);
  });

  it('does not create evidence for unknown/local labels and reports derived persistence failure without inventing replacement events', async () => {
    let derivedWrites = 0;
    const input = enriched(); input.context.extensions[tags] = ['learning-engineering', ns + 'concept-not-authored'];
    const deps = { persistStatement: async () => ({ persisted: true, holonUri: 'urn:original' }), context: async () => context(), persistUsage: async () => { derivedWrites++; return { persisted: false }; } };
    expect(await persistStatementWithUsage(input, deps)).toMatchObject({ persisted: true, usageRecord: { status: 'skipped' } });
    expect(derivedWrites).toBe(0);
    const failed = await persistStatementWithUsage(enriched(), deps);
    expect(failed).toMatchObject({ persisted: false, holonUri: 'urn:original', usageRecord: { status: 'failed', originalRetained: true, reason: 'Original statement retained; derived usage artifact persistence failed' } });
    expect(derivedWrites).toBe(1);
    expect(() => projectUsageRecord({ ...enriched(), stored: undefined }, context())).toThrow('actual statement timestamps');
  });

  it('reads the exact derived artifact only through the existing signature-derived own label', async () => {
    const record = projectUsageRecord(enriched(), context())!;
    const own = { contentType: record.typeIri, content: record };
    const other = { contentType: record.typeIri, content: { private: 'other owner' } };
    const handler = ownLatticeHandler(new Map<string, unknown>([['alice:urn:own', own], ['bob:urn:other', other]]));
    async function invoke(body: Record<string, unknown>) {
      let status = 200, value: unknown;
      const res = { status(code: number) { status = code; return this; }, json(result: unknown) { value = result; } };
      await handler({ body, headers: {}, ip: '127.0.0.1' }, res);
      return { status, body: value };
    }
    const read = await invoke({ valid: true, caller: 'alice', uri: 'urn:own' });
    expect(read.status).toBe(200);
    expect((read.body as { artifact: unknown }).artifact).toEqual(own);
    expect((read.body as { artifact: { content: { graphSha256: string } } }).artifact.content.graphSha256).toBe(record.graphSha256);
    // Caller-supplied labels cannot choose a second owner's lattice.
    expect((await invoke({ valid: true, caller: 'alice', label: 'bob', uri: 'urn:other' })).status).toBe(404);
    expect((await invoke({ valid: true, caller: 'alice', uri: 'urn:unknown' })).status).toBe(404);
    expect((await invoke({ valid: false, caller: 'alice', uri: 'urn:own' })).status).toBe(401);
  });
});
