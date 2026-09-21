import { describe, expect, it } from 'vitest';
import { Parser, Store, DataFactory } from 'n3';
import { controlsFor, descriptorTrig, hmdMarkdown, payloadTurtle, IEP, DEFAULT_NS, type PublishContext } from '../src/descriptor.js';
import type { NavigationJudgment } from '../src/judgments/navigate.js';
import { recordOutcome } from '../src/judgments/outcome.js';
import { affordancesIn, findAffordance, actionMatches } from '../src/follower.js';
import { affordancesManifestTurtle } from '../src/affordance-turtle.js';
import { jevHarnessAffordances } from '../affordances.js';

const ctx: PublishContext = { base: 'http://localhost:6090', ns: DEFAULT_NS, agentId: 'urn:agent:test', ownerWebId: 'https://id.example/me#me' };

const navigation: NavigationJudgment = {
  kind: 'navigation', id: 'abc-123', graphIri: 'urn:graph:jev-harness:navigation:abc-123', createdAt: '2026-09-19T00:00:00.000Z',
  model: 'jev-1.13.0', confidence: 0.42, repository: { name: 'fixture', root: '/r', commit: 'deadbeef' },
  usage: { requests: 1, input_tokens: 100, output_tokens: 10, latencyMs: 5 },
  task: 'fix the block rollup', files: [{ path: 'src/course.ts', probability: 0.42 }, { path: 'src/rollup.ts', probability: 0.4 }], tests: [{ path: 'tests/rollup.test.ts', probability: 0.7 }], docs: [],
  covered: 0.7, noTestProbability: 0.1, advice: 'open-top-three', passes: [{ stage: 'files', options: 8, confidence: 0.42 }], filesConsidered: 8,
};

function parseTrig(text: string): Store {
  const store = new Store();
  store.addQuads(new Parser({ format: 'application/trig' }).parse(text));
  return store;
}

describe('descriptor projection', () => {
  it('payload turtle parses, types the judgment, and spells the note predicates as prefixed names', () => {
    const turtle = payloadTurtle(navigation, ctx);
    // The relay's note gate matches these tokens literally (deploy/mcp-relay/note-view.ts).
    expect(turtle).toMatch(/\bschema:text\b/);
    expect(turtle).toMatch(/\bdct:title\b/);
    expect(turtle).toMatch(/\bhmd:control\b/);
    const store = new Store();
    store.addQuads(new Parser().parse(turtle));
    const types = store.getQuads(DataFactory.namedNode('urn:jev-harness:navigation:abc-123'), DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), null, null).map((q) => q.object.value);
    expect(types).toContain(`${DEFAULT_NS}Navigation`);
    expect(types).toContain(`${DEFAULT_NS}Judgment`);
  });

  it('with an attestation known, the Trust facet cites it as the verifiable credential; without one, it cites none', () => {
    const cited = parseTrig(descriptorTrig(navigation, { ...ctx, attestationUrl: 'https://pod.example/u/context-graphs/9.ttl' }));
    expect(cited.getQuads(null, DataFactory.namedNode(`${IEP}verifiableCredential`), null, null).map((q) => q.object.value)).toEqual(['https://pod.example/u/context-graphs/9.ttl']);
    expect(parseTrig(descriptorTrig(navigation, ctx)).getQuads(null, DataFactory.namedNode(`${IEP}verifiableCredential`), null, null)).toHaveLength(0);
  });
  it('a Hypothetical descriptor carries no groundTruth; an Asserted outcome carries groundTruth true', () => {
    const trig = descriptorTrig(navigation, ctx);
    const store = parseTrig(trig);
    expect(store.getQuads(null, DataFactory.namedNode(`${IEP}modalStatus`), DataFactory.namedNode(`${IEP}Hypothetical`), null).length).toBe(1);
    expect(store.getQuads(null, DataFactory.namedNode(`${IEP}groundTruth`), null, null).length).toBe(0);
    expect(store.getQuads(null, DataFactory.namedNode(`${IEP}epistemicConfidence`), null, null)[0]?.object.value).toBe('0.42');

    const outcome = recordOutcome(navigation, { judgmentIri: navigation.graphIri, filesChanged: ['src/rollup.ts'] });
    const oStore = parseTrig(descriptorTrig(outcome, ctx, { supersedes: ['http://localhost:6090/jev-harness/judgments/abc-123.trig'] }));
    expect(oStore.getQuads(null, DataFactory.namedNode(`${IEP}modalStatus`), DataFactory.namedNode(`${IEP}Asserted`), null).length).toBe(1);
    expect(oStore.getQuads(null, DataFactory.namedNode(`${IEP}groundTruth`), null, null)[0]?.object.value).toBe('true');
    expect(oStore.getQuads(null, DataFactory.namedNode(`${IEP}supersedes`), null, null).length).toBe(1);
    expect(outcome.hitAt1).toBe(false);
    expect(outcome.hitAt3).toBe(true);
  });

  it('emergent controls depend on the judged state', () => {
    const controls = controlsFor(navigation, ctx);
    const names = controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['open-files', 'refine', 'select-tests', 'record-outcome']));
    const confident = controlsFor({ ...navigation, confidence: 0.9, advice: 'open-top-file' }, ctx).map((c) => c.name);
    expect(confident).not.toContain('refine');
    const select = controls.find((c) => c.name === 'select-tests')!;
    expect(select.target).toBe('http://localhost:6090/jev-harness/select-tests');
    expect((select.arguments as { changed_files: string[] }).changed_files).toEqual(['src/course.ts', 'src/rollup.ts']);
    expect(controls.find((c) => c.name === 'open-files')!.declarative).toBe(true);
  });

  it('a follower reads the controls back out of the descriptor', () => {
    const trig = descriptorTrig(navigation, ctx);
    const found = affordancesIn(trig);
    const select = findAffordance(trig, 'select-tests');
    expect(select?.target).toBe('http://localhost:6090/jev-harness/select-tests');
    expect(select?.expects).toBe(`${DEFAULT_NS}SelectTestsInputShape`);
    expect(select?.arguments).toMatchObject({ task: 'fix the block rollup' });
    expect(findAffordance(trig, 'open-files')?.declarative).toBe(true);
    expect(found.some((a) => a.action === `${IEP}canFetchPayload`)).toBe(true);
    expect(actionMatches('urn:iep:action:jev-harness:select-tests', 'select-tests')).toBe(true);
    expect(actionMatches('https://relay.example/ns/iep/action/jev-harness/select-tests', 'select-tests')).toBe(true);
    expect(actionMatches('urn:iep:action:foxxi:select-tests-signed', 'select-tests')).toBe(false);
  });

  it('the HyperMarkdown projection carries a control block per control', () => {
    const md = hmdMarkdown(navigation, ctx);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md.match(/^:::control /gm)?.length).toBe(controlsFor(navigation, ctx).length);
    expect(md).toContain('rel: "urn:iep:action:jev-harness:select-tests"');
    expect(md).toContain('declarative: true');
  });

  it('the affordance manifest parses and resolves navigate to the bridge target', () => {
    const manifest = affordancesManifestTurtle('http://localhost:6090/affordances', jevHarnessAffordances, 'http://localhost:6090', { verticalLabel: 'test' });
    const store = parseTrig(manifest);
    expect(store.getQuads(DataFactory.namedNode('http://localhost:6090/affordances'), DataFactory.namedNode(`${IEP}affordance`), null, null).length).toBe(jevHarnessAffordances.length);
    const nav = findAffordance(manifest, 'navigate');
    expect(nav?.target).toBe('http://localhost:6090/jev-harness/navigate');
    expect(nav?.method).toBe('POST');
    expect(nav?.expects).toBe(`${DEFAULT_NS}NavigateInputShape`);
    expect(findAffordance(manifest, 'calibration')?.method).toBe('GET');
  });
});
