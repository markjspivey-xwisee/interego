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
import { buildMemoryDescriptor, affordancesFor } from '../src/bridge.js';
import type {
  IRI,
} from '@interego/core';
import {
  findSubjectsOfType,
  parseTrig,
  readStringValue,
  readStringValues,
} from '@interego/core';

const CONFIG = {
  podUrl: 'https://pod.example/alice/',
  authoringAgentDid: 'did:web:pod.example' as IRI,
};

describe('buildMemoryDescriptor — substrate-pure', () => {
  it('produces an Asserted descriptor by default with all canonical facets', () => {
    const built = buildMemoryDescriptor({ text: 'Bob prefers async standups' }, CONFIG);
    expect(built.memoryIri).toMatch(/^urn:iep:memory:observation:[0-9a-f]{16}$/);
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

  it('Counterfactual mode marks the graph known-false (retraction modal)', () => {
    const built = buildMemoryDescriptor({ text: 'rejected approach', modalStatus: 'Counterfactual' }, CONFIG);
    const s = built.descriptor.facets.find(f => f.type === 'Semiotic') as {
      modalStatus?: string; groundTruth?: boolean;
    };
    expect(s.modalStatus).toBe('Counterfactual');
    expect(s.groundTruth).toBe(false);
  });

  it('attributes the memory to the AGENT even when onBehalfOf names a human', () => {
    // ★ THIS TEST PINNED THE DEFECT. It read "attributes to the owner when onBehalfOf is set,
    // not the agent" and asserted `wasAttributedTo <did:web:owner.example>` — a delegated
    // agent's own observation signed over to a person who never saw it, contradicting the
    // descriptor facet built two lines away.
    const owner = 'did:web:owner.example' as IRI;
    const built = buildMemoryDescriptor(
      { text: 'an org-level fact' },
      { ...CONFIG, onBehalfOf: owner },
    );
    expect(built.graphContent).toMatch(/wasAttributedTo>\s*<did:web:pod\.example>/);
    expect(built.graphContent).toMatch(/wasGeneratedBy>\s*<did:web:pod\.example>/);
    expect(built.graphContent).not.toContain(`<${owner}>`);
    // The human is not lost — they are the STANDING delegation on an Agent facet, which is what
    // a config-level `onBehalfOf` is a statement about. Asked of ALL Agent facets: `.agent()`
    // and `.generatedBy()` each push one, and only the second carries the delegation.
    const onBehalf = built.descriptor.facets
      .filter(f => f.type === 'Agent').map(f => (f as { onBehalfOf?: IRI }).onBehalfOf);
    expect(onBehalf).toContain(owner);
    const prov = built.descriptor.facets.find(f => f.type === 'Provenance') as { wasAttributedTo?: IRI };
    expect(prov.wasAttributedTo).toBe(CONFIG.authoringAgentDid);
    // ★ AND NO PER-ACT FOOTING IS DERIVED FROM A CONSTRUCTOR ARGUMENT. `onBehalfOf` here is
    // standing; asserting a Delegation over every memory the agent ever writes is the
    // unconditional claim the qualified form exists to replace.
    expect(built.graphContent).not.toContain('qualifiedDelegation');
    expect(built.graphContent).not.toContain('actedOnOwnAccount');
  });

  it('records no delegation at all when onBehalfOf is unset', () => {
    // It used to default to the agent, publishing "this agent acts on behalf of itself".
    const built = buildMemoryDescriptor({ text: 'a self-observed fact' }, CONFIG);
    const onBehalf = built.descriptor.facets
      .filter(f => f.type === 'Agent').map(f => (f as { onBehalfOf?: IRI }).onBehalfOf);
    expect(onBehalf.every(v => v === undefined)).toBe(true);
    expect(built.graphContent).toMatch(/wasAttributedTo>\s*<did:web:pod\.example>/);
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
    // Memory entries are typed ieh:AgentMemory (subClassOf prov:Entity)
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
    // Copy before sorting: `readStringValues` hands back a readonly array, and `.sort()` is an
    // in-place mutator that would be reordering the bridge's own value.
    expect([...tags].sort()).toEqual(['project:owl', 'team:beta']);
  });

  it('rejects empty memory text', () => {
    expect(() => buildMemoryDescriptor({ text: '' }, CONFIG)).toThrow(/empty/);
    expect(() => buildMemoryDescriptor({ text: '   ' }, CONFIG)).toThrow(/empty/);
  });

  it('uses the kind in the IRI namespace for human-scannable IDs', () => {
    const fact = buildMemoryDescriptor({ text: 'a fact', kind: 'fact' }, CONFIG);
    const pref = buildMemoryDescriptor({ text: 'a preference', kind: 'preference' }, CONFIG);
    expect(fact.memoryIri).toMatch(/^urn:iep:memory:fact:/);
    expect(pref.memoryIri).toMatch(/^urn:iep:memory:preference:/);
  });

});

describe('affordancesFor — HATEOAS decoration', () => {
  const TARGET = 'urn:iep:memory:fact:abc123' as IRI;
  const DESC_URL = 'https://pod.example/alice/fact-abc123.ttl';

  it('ReadWrite scope is handed the full verb set, each self-describing', () => {
    const affs = affordancesFor(TARGET, DESC_URL, 'ReadWrite');
    const verbs = affs.map(a => a.action).sort();
    expect(verbs).toEqual(['annotate', 'challenge', 'derive', 'forward', 'read', 'retract']);
    for (const a of affs) {
      expect(a.target).toBe(TARGET);
      expect(a.descriptorUrl).toBe(DESC_URL);
      expect(typeof a.hint).toBe('string');
      expect(a.hint.length).toBeGreaterThan(0);
    }
  });

  it('ReadOnly scope is handed only `read` — never a write verb', () => {
    const affs = affordancesFor(TARGET, DESC_URL, 'ReadOnly');
    expect(affs.map(a => a.action)).toEqual(['read']);
  });

  it('PublishOnly scope cannot retract, challenge, or forward', () => {
    const verbs = affordancesFor(TARGET, DESC_URL, 'PublishOnly').map(a => a.action);
    expect(verbs).not.toContain('retract');
    expect(verbs).not.toContain('challenge');
    expect(verbs).not.toContain('forward');
    expect(verbs).toContain('derive');
  });

  it('defaults to ReadWrite when no scope is given', () => {
    expect(affordancesFor(TARGET, DESC_URL)).toHaveLength(6);
  });
});

describe('buildMemoryDescriptor — injection defense', () => {
  it('escapes tags containing newlines + quotes (Turtle-injection defense)', () => {
    // An adversarial tag value tries to break out of the literal and
    // inject a fake triple. With proper escapeLit, the entire value
    // stays inside one quoted literal — the parser sees a single tag
    // with the weird characters in it, not two triples.
    const malicious = `legit-tag" ;\n<urn:iep:fake-admin> a <urn:iep:Admin> ;\n  <http://xmlns.com/foaf/0.1/name> "evil`;
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
    const fakeAdmin = findSubjectsOfType(doc, 'urn:iep:Admin' as IRI);
    expect(fakeAdmin).toHaveLength(0);
  });
});
