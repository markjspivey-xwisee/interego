/**
 * Bridge unit tests — substrate-pure construction.
 *
 * These tests verify that the bridge constructs valid typed
 * descriptors + graph content without touching a pod. The
 * publish-roundtrip behavior is exercised by the broader
 * multi-agent-integration suite; here we lock the descriptor shape
 * itself.
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryDescriptor } from '../src/bridge.js';
import type { IRI } from '../../../src/index.js';
import { parseTrig, findSubjectsOfType, readStringValue, readStringValues } from '../../../src/index.js';

const CONFIG = {
  podUrl: 'https://pod.example/alice/',
  authoringAgentDid: 'did:web:pod.example' as IRI,
};

describe('buildMemoryDescriptor — substrate-pure', () => {
  it('produces an Asserted descriptor by default with all canonical facets', () => {
    const built = buildMemoryDescriptor({ text: 'Bob prefers async standups' }, CONFIG);
    expect(built.memoryIri).toMatch(/^urn:cg:memory:observation:[0-9a-f]{16}$/);
    const facetTypes = built.descriptor.facets.map(f => f.type).sort();
    expect(facetTypes).toContain('Agent');
    expect(facetTypes).toContain('Trust');
    expect(facetTypes).toContain('Provenance');
    expect(facetTypes).toContain('Temporal');
    expect(facetTypes).toContain('Semiotic');
    const semiotic = built.descriptor.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic.modalStatus).toBe('Asserted');
  });

  it('Hypothetical mode flips the modal status', () => {
    const built = buildMemoryDescriptor({ text: 'maybe alice', modalStatus: 'Hypothetical' }, CONFIG);
    const s = built.descriptor.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(s.modalStatus).toBe('Hypothetical');
  });

  it('attributes to the owner when onBehalfOf is set, not the agent', () => {
    const owner = 'did:web:owner.example' as IRI;
    const built = buildMemoryDescriptor(
      { text: 'an org-level fact' },
      { ...CONFIG, onBehalfOf: owner },
    );
    expect(built.graphContent).toContain(`<${owner}>`);
    // PROV: wasAttributedTo points at the owner; the agent is wasGeneratedBy.
    expect(built.graphContent).toMatch(/wasAttributedTo>\s*<did:web:owner\.example>/);
    expect(built.graphContent).toMatch(/wasGeneratedBy>\s*<did:web:pod\.example>/);
  });

  it('content-addresses by SKILL-style hash — same text → same IRI', () => {
    const a = buildMemoryDescriptor({ text: 'identical fact' }, CONFIG);
    const b = buildMemoryDescriptor({ text: 'identical fact' }, CONFIG);
    expect(a.memoryIri).toBe(b.memoryIri);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('different text → different IRI', () => {
    const a = buildMemoryDescriptor({ text: 'fact 1' }, CONFIG);
    const b = buildMemoryDescriptor({ text: 'fact 2' }, CONFIG);
    expect(a.memoryIri).not.toBe(b.memoryIri);
  });

  it('records supersedes when republishing', () => {
    const v1 = buildMemoryDescriptor({ text: 'v1' }, CONFIG);
    const v2 = buildMemoryDescriptor({ text: 'v2', supersedes: [v1.memoryIri] }, CONFIG);
    expect(v2.descriptor.supersedes).toContain(v1.memoryIri);
  });

  it('emits typed graph parseable by the project Turtle parser', () => {
    const built = buildMemoryDescriptor(
      { text: 'tagged fact', kind: 'fact', tags: ['team:beta', 'project:owl'] },
      CONFIG,
    );
    const doc = parseTrig(built.graphContent);
    // Memory entries are typed cgh:AgentMemory (subClassOf prov:Entity)
    const memSubjects = findSubjectsOfType(
      doc,
      'https://markjspivey-xwisee.github.io/interego/ns/harness#AgentMemory' as IRI,
    );
    expect(memSubjects).toHaveLength(1);
    const subj = memSubjects[0]!;
    const text = readStringValue(subj, 'http://purl.org/dc/terms/description' as IRI);
    expect(text).toBe('tagged fact');
    // Tags use dct:subject (W3C/DCMI) — no new substrate vocab
    const tags = readStringValues(subj, 'http://purl.org/dc/terms/subject' as IRI);
    expect(tags.sort()).toEqual(['project:owl', 'team:beta']);
  });

  it('rejects empty memory text', () => {
    expect(() => buildMemoryDescriptor({ text: '' }, CONFIG)).toThrow(/empty/);
    expect(() => buildMemoryDescriptor({ text: '   ' }, CONFIG)).toThrow(/empty/);
  });

  it('uses the kind in the IRI namespace for human-scannable IDs', () => {
    const fact = buildMemoryDescriptor({ text: 'a fact', kind: 'fact' }, CONFIG);
    const pref = buildMemoryDescriptor({ text: 'a preference', kind: 'preference' }, CONFIG);
    expect(fact.memoryIri).toMatch(/^urn:cg:memory:fact:/);
    expect(pref.memoryIri).toMatch(/^urn:cg:memory:preference:/);
  });

  it('escapes tags containing newlines + quotes (Turtle-injection defense)', () => {
    // An adversarial tag value tries to break out of the literal and
    // inject a fake triple. With proper escapeLit, the entire value
    // stays inside one quoted literal — the parser sees a single tag
    // with the weird characters in it, not two triples.
    const malicious = `legit-tag" ;\n<urn:cg:fake-admin> a <urn:cg:Admin> ;\n  <http://xmlns.com/foaf/0.1/name> "evil`;
    const built = buildMemoryDescriptor(
      { text: 'tagged with malicious payload', tags: [malicious] },
      CONFIG,
    );
    // The graph must still parse cleanly — no injected triples.
    const doc = parseTrig(built.graphContent);
    const memSubjects = findSubjectsOfType(
      doc,
      'https://markjspivey-xwisee.github.io/interego/ns/harness#AgentMemory' as IRI,
    );
    expect(memSubjects).toHaveLength(1);
    // The tag round-trips exactly as supplied
    const recoveredTags = readStringValues(memSubjects[0]!, 'http://purl.org/dc/terms/subject' as IRI);
    expect(recoveredTags).toEqual([malicious]);
    // No fake-admin subject made it in
    const fakeAdmin = findSubjectsOfType(doc, 'urn:cg:Admin' as IRI);
    expect(fakeAdmin).toHaveLength(0);
  });
});
