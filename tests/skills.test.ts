/**
 * agentskills.io ↔ cg:Affordance bridge tests.
 *
 * Covers: SKILL.md frontmatter parser (valid + invalid inputs),
 * round-trip emission, skill→descriptor translation, descriptor→skill
 * reverse translation, content-hash stability, supersedes-chaining,
 * bundled scripts/references via dct:hasPart.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSkillMd,
  emitSkillMd,
  skillBundleToDescriptor,
  descriptorGraphToSkillBundle,
  descriptorGraphToSkillMd,
  type SkillBundle,
} from '../src/index.js';
import type { IRI } from '../src/index.js';
import { parseTrig, findSubjectsOfType, readStringValue } from '../src/rdf/turtle-parser.js';

const AUTHOR = 'did:web:alice.example' as IRI;

const MIN_SKILL_MD = `---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when working with PDFs or forms.
---
# PDF Processing

Step 1. Identify the operation type.
Step 2. Run scripts/extract.py.
`;

const FULL_SKILL_MD = `---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when working with PDFs or forms.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(python:*) Read
---
# PDF Processing

Body content here.
`;

describe('parseSkillMd — happy path', () => {
  it('parses minimal valid SKILL.md', () => {
    const r = parseSkillMd(MIN_SKILL_MD);
    expect(r.errors).toEqual([]);
    expect(r.document?.frontmatter.name).toBe('pdf-processing');
    expect(r.document?.frontmatter.description).toContain('Extract PDF text');
    expect(r.document?.body).toContain('Step 1');
  });

  it('parses all optional frontmatter fields', () => {
    const r = parseSkillMd(FULL_SKILL_MD);
    expect(r.errors).toEqual([]);
    const fm = r.document!.frontmatter;
    expect(fm.license).toBe('Apache-2.0');
    expect(fm.compatibility).toBe('Requires Python 3.14+ and uv');
    expect(fm.metadata.get('author')).toBe('example-org');
    expect(fm.metadata.get('version')).toBe('1.0');
    expect(fm.allowedTools).toBe('Bash(python:*) Read');
  });

  it('round-trips through emit + parse', () => {
    const parsed = parseSkillMd(FULL_SKILL_MD);
    const emitted = emitSkillMd(parsed.document!);
    const reparsed = parseSkillMd(emitted);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.document?.frontmatter.name).toBe('pdf-processing');
    expect(reparsed.document?.frontmatter.metadata.get('author')).toBe('example-org');
  });
});

describe('parseSkillMd — validation failures', () => {
  it('rejects names with uppercase', () => {
    const md = `---\nname: PDF-Processing\ndescription: foo\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects names with leading hyphen', () => {
    const md = `---\nname: -pdf\ndescription: foo\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects names with consecutive hyphens', () => {
    const md = `---\nname: pdf--processing\ndescription: foo\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects missing description', () => {
    const md = `---\nname: pdf\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'description')).toBe(true);
  });

  it('rejects names exceeding 64 chars', () => {
    const md = `---\nname: ${'a'.repeat(65)}\ndescription: foo\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects unterminated frontmatter', () => {
    const md = `---\nname: foo\ndescription: bar\n# but no closing ---\n`;
    const r = parseSkillMd(md);
    expect(r.document).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects compatibility exceeding 500 chars', () => {
    const md = `---\nname: foo\ndescription: bar\ncompatibility: ${'x'.repeat(501)}\n---\n`;
    const r = parseSkillMd(md);
    expect(r.errors.some(e => e.field === 'compatibility')).toBe(true);
  });
});

describe('skillBundleToDescriptor — substrate translation', () => {
  it('produces a typed Hypothetical descriptor by default', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    expect(out.skillIri).toMatch(/^urn:cg:skill:pdf-processing:[0-9a-f]{16}$/);
    expect(out.descriptor.facets.some(f => f.type === 'Semiotic' && f.modalStatus === 'Hypothetical')).toBe(true);
    expect(out.descriptor.facets.some(f => f.type === 'Provenance')).toBe(true);
  });

  it('produces an Asserted descriptor when requested', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR, modalStatus: 'Asserted' });
    expect(out.descriptor.facets.some(f => f.type === 'Semiotic' && f.modalStatus === 'Asserted')).toBe(true);
  });

  it('produces a Counterfactual descriptor (deprecated/withdrawn skill)', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR, modalStatus: 'Counterfactual' });
    const semiotic = out.descriptor.facets.find(f => f.type === 'Semiotic');
    expect(semiotic).toBeDefined();
    expect((semiotic as { modalStatus?: string }).modalStatus).toBe('Counterfactual');
  });

  it('emits a parseable graph with cg:Affordance + pgsl:Atom', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const doc = parseTrig(out.graphContent);
    const affordances = findSubjectsOfType(doc, 'https://markjspivey-xwisee.github.io/interego/ns/cg#Affordance' as IRI);
    expect(affordances).toHaveLength(1);
    expect(readStringValue(affordances[0]!, 'http://www.w3.org/2000/01/rdf-schema#label' as IRI)).toBe('pdf-processing');
    const atoms = findSubjectsOfType(doc, 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#Atom' as IRI);
    expect(atoms.length).toBeGreaterThanOrEqual(1);
  });

  it('content-addresses the skill IRI (same SKILL.md → same IRI)', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const a = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const b = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    expect(b.skillIri).toBe(a.skillIri);
  });

  it('changing SKILL.md changes the IRI (new content-hash)', () => {
    const bundle1: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const bundle2: SkillBundle = { skillMd: MIN_SKILL_MD + '\nMore content.\n', files: new Map() };
    const a = skillBundleToDescriptor(bundle1, { authoringAgentDid: AUTHOR });
    const b = skillBundleToDescriptor(bundle2, { authoringAgentDid: AUTHOR });
    expect(b.skillIri).not.toBe(a.skillIri);
  });

  it('records supersedes targets when republishing a revision', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const v1 = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });

    const bundle2: SkillBundle = { skillMd: MIN_SKILL_MD + '\nclarification.\n', files: new Map() };
    const v2 = skillBundleToDescriptor(bundle2, {
      authoringAgentDid: AUTHOR,
      supersedes: [v1.skillIri],
    });
    expect(v2.descriptor.supersedes).toContain(v1.skillIri);
  });

  it('emits dct:hasPart atoms for bundled scripts/ + references/', () => {
    const files = new Map<string, string>();
    files.set('scripts/extract.py', '#!/usr/bin/env python3\nimport sys\nprint("ok")\n');
    files.set('references/REFERENCE.md', '# Reference\n\nDetails go here.\n');
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    expect(out.atomIris.size).toBe(3); // SKILL.md + 2 parts
    expect(out.atomIris.has('SKILL.md')).toBe(true);
    expect(out.atomIris.has('scripts/extract.py')).toBe(true);
    expect(out.atomIris.has('references/REFERENCE.md')).toBe(true);
  });

  it('refuses to publish a SKILL.md with no parseable name/description', () => {
    const bundle: SkillBundle = { skillMd: `---\n# nothing here\n---\nbody`, files: new Map() };
    expect(() => skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR })).toThrow(/not parseable/);
  });
});

describe('descriptorGraphToSkillBundle — reverse translation', () => {
  it('round-trips a minimal skill', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const recovered = descriptorGraphToSkillBundle(out.graphContent);
    expect(recovered.skillMd).toBe(MIN_SKILL_MD);
  });

  it('round-trips a skill with bundled parts', () => {
    const files = new Map<string, string>();
    files.set('scripts/extract.py', '#!/usr/bin/env python3\nimport sys\nprint("ok")\n');
    files.set('references/REFERENCE.md', '# Reference\n');
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const recovered = descriptorGraphToSkillBundle(out.graphContent);
    expect(recovered.skillMd).toBe(MIN_SKILL_MD);
    expect(recovered.files.get('scripts/extract.py')).toBe(files.get('scripts/extract.py'));
    expect(recovered.files.get('references/REFERENCE.md')).toBe(files.get('references/REFERENCE.md'));
  });

  it('descriptorGraphToSkillMd re-emits valid frontmatter', () => {
    const bundle: SkillBundle = { skillMd: FULL_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const text = descriptorGraphToSkillMd(out.graphContent);
    const reparsed = parseSkillMd(text);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.document!.frontmatter.name).toBe('pdf-processing');
    expect(reparsed.document!.frontmatter.metadata.get('author')).toBe('example-org');
  });
});

describe('substrate composition — what falls out for free', () => {
  it('content-hash on every atom enables tamper detection', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    // The graph content includes a cg:contentHash; tampering with the
    // SKILL.md value but keeping the hash will be detectable when a
    // verifier rehashes the value.
    expect(out.graphContent).toMatch(/cg#contentHash[^"]*"[a-f0-9]{64}"/);
  });

  it('PROV facet records signed authorship — no skill-specific code', () => {
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const prov = out.descriptor.facets.find(f => f.type === 'Provenance');
    expect(prov).toBeDefined();
  });

  it('skill IRI is stable enough to attest against (existing amta: flow works without changes)', () => {
    // The substrate amta: attestation flow operates on any IRI; if the
    // skill IRI is stable + content-derived, the same flow we use for
    // tools (Demo 19, applications/agent-collective) attests skills
    // without any new code path.
    const bundle: SkillBundle = { skillMd: MIN_SKILL_MD, files: new Map() };
    const out1 = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    const out2 = skillBundleToDescriptor(bundle, { authoringAgentDid: AUTHOR });
    expect(out1.skillIri).toBe(out2.skillIri);
  });
});
