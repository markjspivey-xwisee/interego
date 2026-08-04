/**
 * The adp: DESCRIBED GRAPH conforms to adp-shapes.ttl — offline, no pod.
 *
 * WHY THIS FILE EXISTS. integration.test.ts validates the ContextDescriptor
 * ENVELOPE; `validate()` is never handed the graph. The graph's only observer
 * was tier8-real-pod-end-to-end.test.ts, which gates every assertion on a live
 * Azure CSS that is now paused — so it ctx.skip()s and reports nothing. In that
 * gap, adp:timeBound and adp:nextRevisitAt shipped as plain xsd:string literals
 * against the `rdfs:range xsd:dateTime` adp.ttl declares for both.
 *
 * ★ THE FIRST TESTS ARE THE REJECTION TESTS, ON PURPOSE. validateAgainstShape
 * returns conforms=true for a graph containing zero focus nodes — a shape with
 * no targets trivially conforms. So a suite that only asserts conforms===true
 * passes just as happily against a typo'd sh:targetClass, i.e. it proves
 * nothing. Every conformance claim below is paired with a graph that MUST be
 * rejected.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateAgainstShape } from '@interego/core';
import type { IRI } from '@interego/core';
import {
  buildCapabilityGraph,
  buildProbeGraph,
  buildNarrativeFragmentGraph,
  buildSynthesisGraph,
  buildEvolutionStepGraph,
  buildConstraintGraph,
  buildCapabilityEvolutionGraph,
} from '../src/pod-publisher.js';

const SHAPES = readFileSync(new URL('../ontology/adp-shapes.ttl', import.meta.url), 'utf8');
const WHEN = '2026-08-10T00:00:00.000Z';

const CAP = 'urn:iep:capability:c1' as IRI;
const PROBE = 'urn:iep:probe:p1' as IRI;
const FRAG = 'urn:iep:fragment:f1' as IRI;
const SYNTH = 'urn:iep:synthesis:s1' as IRI;

function why(report: ReturnType<typeof validateAgainstShape>): string {
  return report.results.map(r => `${r.constraintComponent} @ ${r.path ?? '-'}: ${r.message}`).join('\n');
}

const graphs: ReadonlyArray<{ name: string; ttl: string }> = [
  { name: 'Capability', ttl: buildCapabilityGraph(CAP, 'c1', {
      name: 'Customer Service Tone', cynefinDomain: 'Complex',
      rubricCriteria: [{ name: 'User feels acknowledged' }, { name: 'Pacing matches state' }],
      description: 'Open-ended capability space.',
    }) },
  { name: 'Probe', ttl: buildProbeGraph(PROBE, WHEN, {
      capabilityIri: CAP, variant: 'explicit-acknowledgment',
      hypothesis: 'Leading with acknowledgment may produce constructive continuation.',
      amplificationTrigger: 'frustration-acknowledged-before-solution',
      dampeningTrigger: 'user-perceived-stalling',
    }) },
  { name: 'NarrativeFragment', ttl: buildNarrativeFragmentGraph(FRAG, {
      probeIri: PROBE, contextSignifiers: ['user-frustration-escalating', 'second-contact-same-issue'],
      response: 'The agent acknowledged the prior unresolved contact first.',
      emergentSignifier: 'frustration-acknowledged-before-solution',
    }) },
  { name: 'Synthesis', ttl: buildSynthesisGraph(SYNTH, {
      probeIri: PROBE, fragmentIris: [FRAG],
      emergentPattern: 'Explicit acknowledgment preceded relief in 2 of 2 observed.',
      coherentNarratives: ['Reading 1: the scaffold creates space.', 'Reading 2: it is the signal, not the words.', 'Reading 3: noise.'],
    }) },
  { name: 'EvolutionStep', ttl: buildEvolutionStepGraph('urn:iep:evolution:e1' as IRI, WHEN, {
      synthesisIri: SYNTH, amplifyProbeIris: [PROBE], dampenProbeIris: ['urn:iep:probe:p0' as IRI],
      explicitDecisionNotMade: 'We are NOT claiming we know why it works.',
    }) },
  { name: 'Constraint', ttl: buildConstraintGraph('urn:iep:constraint:k1' as IRI, {
      capabilityIri: CAP, emergedFromSynthesisIris: [SYNTH],
      boundary: 'Must acknowledge frustration before offering a solution on second contact.',
      exitsConstraint: 'Relaxed if the user explicitly waives acknowledgment.',
    }) },
  { name: 'CapabilityEvolution', ttl: buildCapabilityEvolutionGraph('urn:iep:capability-evolution:x1' as IRI, {
      capabilityIri: CAP, evolutionType: 'EmergentRecognition', emergedFromIris: [SYNTH],
      olkeStage: 'Articulate', explicitDecisionNotMade: 'We do NOT claim mastery.',
    }) },
];

describe('adp graph payload — the shape actually fires', () => {
  // ANTI-VACUITY. If sh:targetClass ever stops matching, these go green-by-
  // silence and every assertion in the next block becomes theatre.
  it('REJECTS a probe whose timeBound is an untyped string (the HEAD defect)', () => {
    const bad = buildProbeGraph(PROBE, WHEN, {
      capabilityIri: CAP, variant: 'v', hypothesis: 'h',
      amplificationTrigger: 'a', dampeningTrigger: 'd',
    }).replace(`"${WHEN}"^^xsd:dateTime`, `"${WHEN}"`);
    const report = validateAgainstShape(bad, SHAPES);
    expect(report.conforms, 'an untyped adp:timeBound must be a Violation').toBe(false);
    expect(report.results.some(r => r.constraintComponent.endsWith('DatatypeConstraintComponent'))).toBe(true);
  });

  it('REJECTS an evolution step whose nextRevisitAt is an untyped string (the HEAD defect)', () => {
    const bad = buildEvolutionStepGraph('urn:iep:evolution:e1' as IRI, WHEN, {
      synthesisIri: SYNTH, amplifyProbeIris: [PROBE], dampenProbeIris: [],
      explicitDecisionNotMade: 'not claiming why',
    }).replace(`"${WHEN}"^^xsd:dateTime`, `"${WHEN}"`);
    const report = validateAgainstShape(bad, SHAPES);
    expect(report.conforms).toBe(false);
    expect(report.results.some(r => r.constraintComponent.endsWith('DatatypeConstraintComponent'))).toBe(true);
  });

  it('REJECTS a synthesis collapsed to a single coherent narrative', () => {
    // The publisher's own if(x) guard is bypassed here on purpose: this pins
    // that the PUBLISHED SHAPE carries the invariant, not only the TS branch.
    const collapsed = buildSynthesisGraph(SYNTH, {
      probeIri: PROBE, fragmentIris: [FRAG], emergentPattern: 'p',
      coherentNarratives: ['Reading 1: the only reading.'],
    });
    expect(validateAgainstShape(collapsed, SHAPES).conforms).toBe(false);
  });
});

describe('adp graph payload — every publisher emits a conforming graph', () => {
  for (const { name, ttl } of graphs) {
    it(`${name} conforms to adp-shapes.ttl`, () => {
      const report = validateAgainstShape(ttl, SHAPES);
      expect(report.conforms, `${name}:\n${why(report)}\n--- graph ---\n${ttl}`).toBe(true);
    });
  }
});
