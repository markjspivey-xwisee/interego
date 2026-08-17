/**
 * AN AFFORDANCE THAT ANSWERS FROM A STORE MUST SAY WHICH STORE.
 *
 * ── ★★ THE INCIDENT ─────────────────────────────────────────────────────────
 *
 * A contract has two sides and only one was ever written. `hydra:expects` says what a caller must
 * SEND; nothing said what an affordance must FIND. `affordanceToTurtle` proved it — it emitted
 * `iep:action`, `hydra:method`, `hydra:target`, `hydra:returns` and a fully expanded
 * `hydra:expects`, and stopped.
 *
 * MEASURED, live, over four turns and about $3 of model spend: a delegate signed a valid rev-196
 * envelope, dereferenced an affordance whose INPUT was documented exhaustively (fields, canonical
 * `sha256:` message, ±60s skew, signing key), invoked it correctly, and received an empty record.
 * It could not distinguish "you have done nothing" from "your evidence is not in the store I read",
 * because nothing it could dereference named the store, what fills it, or whether it was enrolled.
 * The deciding fact was an ENVIRONMENT VARIABLE. A human read deployment config to find it.
 *
 * WHEN AN ANSWER IS ASSEMBLED FROM DATA THE CALLER NEITHER SENT NOR CAN SEE, AN EMPTY ANSWER AND A
 * CORRECT ANSWER ARE THE SAME BYTES — and a descriptor that cannot distinguish them is
 * unfalsifiable. The agent's reasoning was never the weak link; the descriptor was.
 *
 * These cases hold the SERIALIZER and the PUBLISHED SHAPE against each other, so a source that is
 * mentioned but not usable fails here rather than in front of an agent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAgainstShape } from '@interego/core';
import {
  affordanceToTurtle, affordancesManifestTurtle, type Affordance,
} from '../applications/_shared/affordance-mcp/index.js';

const ROOT = process.cwd();
/** ★ THE PUBLISHED FILES, from disk. A fixture copy of a shape validates nothing about it. */
const SHAPES = readFileSync(join(ROOT, 'docs/ns/iep-shapes.ttl'), 'utf8')
  + '\n' + readFileSync(join(ROOT, 'docs/ns/iep.ttl'), 'utf8');

const BASE = 'https://foxxi-bridge.interego.xwisee.com';

const base = (over: Partial<Affordance> = {}): Affordance => ({
  action: 'urn:iep:action:test:read-side' as Affordance['action'],
  toolName: 'test_read_side',
  title: 'A capability that answers from a store',
  description: 'Answers from data the caller did not send.',
  method: 'POST',
  targetTemplate: '{base}/agent/test',
  inputs: [{ name: 'x', type: 'string', required: true, description: 'anything' }],
  ...over,
});

/**
 * ★ `affordanceToTurtle` emits the affordance BODY, not a document — the manifest wrapper supplies
 * the prefixes in production. So a bare-serializer case has to supply them to be parseable, and the
 * manifest case below proves the real served document needs no such help.
 */
const PREFIXES = [
  '@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
  '@prefix ieh:   <https://markjspivey-xwisee.github.io/interego/ns/harness#> .',
  '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
  '@prefix dcat:  <http://www.w3.org/ns/dcat#> .',
  '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix dct:   <http://purl.org/dc/terms/> .',
].join('\n') + '\n\n';

const conforms = (ttl: string): { ok: boolean; why: string } => {
  const doc = ttl.trimStart().startsWith('@prefix') ? ttl : PREFIXES + ttl;
  const r = validateAgainstShape(doc, SHAPES, { entailment: 'rdfs' });
  return { ok: r.conforms, why: r.results.map((x) => String(x.message ?? x.constraintComponent)).join('; ') };
};

const SOURCE = {
  store: 'https://relay.interego.xwisee.com/ns/iep/store/foxxi/mesh-lens',
  label: 'the subject\'s per-agent mesh lens',
  populatedBy: BASE + '/agent/mesh-event',
  admits: 'Trajectory steps from an enrolled pod. A Hypothetical step is an intention, not evidence.',
  enrolmentRegister: BASE + '/agent/mesh/enrolment',
};

describe('★★ the serializer emits the read side', () => {
  it('emits nothing when an affordance declares no source — absence states nothing', () => {
    // The rule everywhere in this vocabulary: an affordance that declares no source has NOT
    // declared that it reads none, and inventing an empty `iep:reads` would say the opposite.
    const ttl = affordanceToTurtle(base(), BASE);
    expect(ttl).not.toContain('iep:reads');
    expect(ttl).not.toContain('iep:EvidenceSource');
  });

  it('★★ emits store, what fills it, what it admits, and where enrolment is published', () => {
    const ttl = affordanceToTurtle(base({ reads: [SOURCE] }), BASE);
    expect(ttl).toContain('iep:reads');
    expect(ttl).toContain('a iep:EvidenceSource');
    expect(ttl).toContain('iep:store <' + SOURCE.store + '>');
    expect(ttl).toContain('iep:populatedBy <' + SOURCE.populatedBy + '>');
    expect(ttl).toContain('iep:enrolmentRegister <' + SOURCE.enrolmentRegister + '>');
    expect(ttl).toContain('Hypothetical step is an intention');
    expect(conforms(ttl).ok, conforms(ttl).why).toBe(true);
  });

  it('★ several stores, because one answer is routinely assembled from several', () => {
    // Collapsing them to one hides WHICH was empty — the distinction the incident turned on.
    const ttl = affordanceToTurtle(base({
      reads: [SOURCE, { store: BASE + '/x', label: 'durable pod record', populatedBy: BASE + '/xapi/statements' }],
    }), BASE);
    expect((ttl.match(/a iep:EvidenceSource/g) ?? [])).toHaveLength(2);
    expect(conforms(ttl).ok, conforms(ttl).why).toBe(true);
  });

  it('★ a quote in a label or an admits sentence cannot break the document', () => {
    // These strings are prose written by whoever declared the affordance.
    const ttl = affordanceToTurtle(base({
      reads: [{ ...SOURCE, label: 'a "quoted" lens', admits: 'says "Asserted" only' }],
    }), BASE);
    expect(ttl).toContain('\\"quoted\\"');
    expect(conforms(ttl).ok, conforms(ttl).why).toBe(true);
  });

  it('survives the manifest wrapper the bridge actually serves it through', () => {
    const ttl = affordancesManifestTurtle(BASE + '/agent/test/affordance', [base({ reads: [SOURCE] })], BASE, {
      verticalLabel: 'test', rdfsComment: 'test',
    });
    expect(ttl).toContain('iep:populatedBy');
    expect(conforms(ttl).ok, conforms(ttl).why).toBe(true);
  });
});

describe('★★ the read side is visible to a DCAT client, not only to this vocabulary', () => {
  /**
   * ── WHY THIS MATTERS AND WHY IT WAS MISSING ─────────────────────────────────
   *
   * `iep:reads` was added because nothing said what an affordance must FIND. It was added WITHOUT
   * alignment, which reproduced a smaller version of the same fault one layer up: a DCAT or DPROD
   * client reading the descriptor would see opaque blank nodes, understand none of them, and be as
   * unable to answer "where does this answer come from" as the agent had been.
   *
   * A term only this vocabulary understands is not self-description; it is a private note. So the
   * test is not "does alignment.ttl contain the right triples" — it is "does a reader who knows
   * ONLY DCAT get a handle on our evidence source". That has to be answered by entailment, not by
   * grepping the alignment file.
   */
  const ALIGNED = SHAPES + '\n' + readFileSync(join(ROOT, 'docs/ns/alignment.ttl'), 'utf8');

  /** A shape written by someone who has never heard of iep: — it targets dcat:Dataset only. */
  const DCAT_ONLY_SHAPE = `
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
_:datasetNeedsAccess a sh:NodeShape ;
    sh:targetClass dcat:Dataset ;
    sh:property [
        sh:path dcat:accessURL ;
        sh:minCount 1 ;
        sh:message "a dcat:Dataset a DCAT client can see must carry dcat:accessURL"
    ] .
`;

  it('★★ an iep:EvidenceSource IS a dcat:Dataset under entailment, and its store IS a dcat:accessURL', () => {
    const ttl = affordanceToTurtle(base({ reads: [SOURCE] }), BASE);
    // The DCAT-only shape targets dcat:Dataset. It can only see our source at all if
    // `iep:EvidenceSource rdfs:subClassOf dcat:Dataset` is entailed, and can only satisfy its
    // accessURL requirement if `iep:store rdfs:subPropertyOf dcat:accessURL` is too.
    const r = validateAgainstShape(PREFIXES + ttl, ALIGNED + DCAT_ONLY_SHAPE, { entailment: 'rdfs' });
    expect(r.conforms, r.results.map((x) => String(x.message)).join('; ')).toBe(true);
  });

  it('★★ and it is the ALIGNMENT doing the work — without it, the DCAT reader sees nothing', () => {
    /**
     * The control that makes the case above mean something. Validated WITHOUT alignment.ttl, the
     * DCAT-only shape finds no dcat:Dataset to target — so it passes VACUOUSLY, which is exactly
     * how an unaligned term looks to a standards client: not wrong, invisible.
     */
    const ttl = affordanceToTurtle(base({ reads: [SOURCE] }), BASE);
    const unaligned = validateAgainstShape(PREFIXES + ttl, SHAPES + DCAT_ONLY_SHAPE, { entailment: 'rdfs' });
    // It conforms either way; the difference is whether anything was CHECKED. Prove the shape has
    // teeth by giving it a dataset with no access URL and watching it fail.
    const probe = PREFIXES + '<https://x.example/d> a <http://www.w3.org/ns/dcat#Dataset> .\n';
    const teeth = validateAgainstShape(probe, SHAPES + DCAT_ONLY_SHAPE, { entailment: 'rdfs' });
    expect(teeth.conforms, 'the DCAT-only shape must be capable of failing, or the case above is vacuous').toBe(false);
    expect(unaligned.conforms).toBe(true);
  });
});

describe('★★ what the published shape refuses', () => {
  /**
   * A HALF-DECLARED SOURCE IS WORSE THAN SILENCE. An agent would dereference it, find no
   * `iep:populatedBy`, and be exactly as stuck as before — with the added false belief that it had
   * checked. Both cases below produce Turtle that LOOKS declared.
   */
  const wrap = (body: string): string =>
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
    + '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n'
    + '<https://x.example/aff> iep:reads [\n' + body + '\n] .\n';

  it('a source that names no store', () => {
    const v = conforms(wrap('  a iep:EvidenceSource ;\n  iep:populatedBy <https://x.example/fill>'));
    expect(v.ok).toBe(false);
    expect(v.why).toContain('MUST name the store');
  });

  it('★★ a source that does not say what fills it — the field whose absence cost the incident', () => {
    const v = conforms(wrap('  a iep:EvidenceSource ;\n  iep:store <https://x.example/store>'));
    expect(v.ok).toBe(false);
    expect(v.why).toContain('PUTS DATA IN IT');
  });

  it('★ an enrolment register that is a string rather than something a caller can GET', () => {
    const v = conforms(wrap('  a iep:EvidenceSource ;\n  iep:store <https://x.example/s> ;\n'
      + '  iep:populatedBy <https://x.example/f> ;\n  iep:enrolmentRegister "ask the operator"'));
    expect(v.ok).toBe(false);
  });

  it('★ two contradictory `admits` sentences', () => {
    const v = conforms(wrap('  a iep:EvidenceSource ;\n  iep:store <https://x.example/s> ;\n'
      + '  iep:populatedBy <https://x.example/f> ;\n  iep:admits "asserted only" ;\n  iep:admits "anything"'));
    expect(v.ok).toBe(false);
    expect(v.why).toContain('at most one');
  });
});
