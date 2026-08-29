/**
 * Tier 8 — production end-to-end against real Azure CSS for the
 * agent-development-practice vertical.
 *
 * Walks the full probe cycle through real HTTP against a real pod:
 *   1. Define a capability space
 *   2. Record three parallel safe-to-fail probes
 *   3. Record narrative fragments against each probe
 *   4. Emerge a synthesis with multiple coherent narratives (REQUIRES ≥2)
 *   5. Record an evolution step (REQUIRES explicitDecisionNotMade)
 *   6. Refine a constraint (REQUIRES emergedFrom + boundary + exits)
 *   7. Recognize a capability evolution event (passport:LifeEvent)
 *   8. Load the cycle state from the pod and verify discipline:
 *      - All probes/fragments/syntheses are Hypothetical
 *      - Evolution step + capability evolution are Asserted
 *      - Multi-narrative coherent narratives preserved (no collapse)
 *      - explicitDecisionNotMade clauses survive the roundtrip
 *   9. Cleanup
 *
 * Skips when Azure CSS is unreachable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  defineCapability,
  recordProbe,
  recordNarrativeFragment,
  emergeSynthesis,
  recordEvolutionStep,
  refineConstraint,
  recognizeCapabilityEvolution,
} from '../src/pod-publisher.js';
import { loadProbeCycle } from '../src/pod-loader.js';
import type {
  IRI,
} from '@interego/core';

// ★ The default host was the Azure CSS gate, deliberately destroyed in the Railway move.
// See applications/_shared/tests/pod-target.ts.
// ★ Gated through real-pod-gate.ts rather than probePod() directly: probePod() folded a
// DECLARED opt-out and a DISCOVERED failure (unreachable, 404 container, refused write) into
// one `usable: false` and both reached ctx.skip(), which is green. openRealPod() throws on the
// discovered kind, so a pod that has stopped existing reds this file instead of emptying it.
import {
  TEST_POD_BASE, POD_HOST as AZURE_CSS_BASE, podWriteHeaders,
  openRealPod, DECLARED_SKIPS, type PodGate,
} from '../../_shared/tests/real-pod-gate.js';

function uniquePodUrl(): string {
  return `${TEST_POD_BASE}adp-tier8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
}

const OPERATOR_DID = 'did:web:adp-operator.example' as IRI;

const cleanupUrls: string[] = [];
function track(...urls: (string | undefined)[]): void {
  for (const u of urls) if (u) cleanupUrls.push(u);
}
async function cleanup(): Promise<void> {
  const containerRoots = new Set<string>();
  for (const url of cleanupUrls) {
    const m = /^(.*\/adp-tier8-[^/]+\/)/.exec(url);
    if (m) containerRoots.add(m[1]!);
  }
  // DELETE is a write, and the css-gate answers an unauthenticated write with
  // `401 anonymous writes denied`. Without the bearer every one of these silently 401s inside
  // the `catch {}` and the run leaves its fixtures on a real pod — the same omission
  // agent-collective's cleanup() had already fixed.
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(root, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
  }
}

// Seeded with a DECLARED skip so a beforeAll that throws cannot leave a value resembling a
// legitimate opt-out; vitest fails every body in a file whose beforeAll throws, which is the
// intent.
let pod: PodGate = { ok: false, declaredSkip: 'SKIP_POD_TESTS/SKIP_AZURE_TESTS declared' };
let reachable = false;
beforeAll(async () => {
  pod = await openRealPod();
  reachable = pod.ok;
});

describe('Tier 8 — agent-development-practice production end-to-end', () => {
  it('real-pod precondition: skipping is allowed only for a DECLARED reason', () => {
    // Was `expect(typeof reachable).toBe('boolean')` — true of `false`, so the one test that
    // "passed" in this file passed for every possible state of the pod, including the two
    // years in which the host it probed did not exist.
    if (pod.ok) return;
    console.warn(`ADP Tier 8 skipped — ${pod.declaredSkip} (host: ${AZURE_CSS_BASE})`);
    expect(DECLARED_SKIPS).toContain(pod.declaredSkip);
  });

  it('full probe cycle: capability → probes → fragments → synthesis → evolution → constraint → capability evolution', { timeout: 300000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), operatorDid: OPERATOR_DID };

      // Step 1: capability
      const cap = await defineCapability({
        name: 'Customer Service Tone',
        cynefinDomain: 'Complex',
        rubricCriteria: [
          { name: 'User feels acknowledged' },
          { name: 'Pacing matches user emotional state' },
          { name: 'Resolution is correct AND non-condescending' },
        ],
        description: 'Open-ended capability space for customer-service tone in Complex situations.',
      }, config);
      track(cap.descriptorUrl, cap.graphUrl);
      expect(cap.capabilityIri).toContain('urn:iep:capability');

      // Step 2: three parallel probes — published SEQUENTIALLY because
      // src/solid/publish() does GET-then-PUT on the manifest (no CAS),
      // so concurrent publishes against the same pod race on manifest
      // updates. Production agents writing in parallel must either
      // serialize or use a CAS-aware publisher.
      const probeArgs = [
        {
          variant: 'clinical-baseline',
          hypothesis: 'Direct factual responses without explicit emotional labelling produce efficient resolutions.',
          amplificationTrigger: 'fragments signified user-relief-followed AND solution-accepted-quickly',
          dampeningTrigger: 'fragments signified user-frustration-escalated OR conversation-restarted',
        },
        {
          variant: 'explicit-acknowledgment',
          hypothesis: 'Leading with explicit acknowledgment of user frustration before offering a solution may produce constructive continuation.',
          amplificationTrigger: 'fragments signified frustration-acknowledged-before-solution',
          dampeningTrigger: 'fragments signified user-perceived-stalling',
        },
        {
          variant: 'empathic-mirroring',
          hypothesis: 'Mirroring the user\'s emotional language back may deepen rapport.',
          amplificationTrigger: 'fragments signified user-felt-heard',
          dampeningTrigger: 'fragments signified mirroring-felt-performative',
        },
      ];
      const probes: Awaited<ReturnType<typeof recordProbe>>[] = [];
      for (const args of probeArgs) {
        const p = await recordProbe({ capabilityIri: cap.capabilityIri, ...args }, config);
        probes.push(p);
        track(p.descriptorUrl, p.graphUrl);
      }

      // Step 3: narrative fragments (sequential per the manifest race note above)
      const fragArgs = [
        {
          probeIri: probes[1]!.probeIri,
          contextSignifiers: ['user-frustration-escalating', 'second-contact-same-issue'],
          response: 'The agent led with explicit acknowledgment of the user\'s frustration AND the prior unresolved contact. User responded with relief; conversation continued constructively.',
          emergentSignifier: 'frustration-acknowledged-before-solution',
        },
        {
          probeIri: probes[1]!.probeIri,
          contextSignifiers: ['user-frustration-escalating', 'second-contact-same-issue'],
          response: 'The agent acknowledged the prior contact and offered a refined solution. User responded with measured relief.',
          emergentSignifier: 'frustration-acknowledged-before-solution',
        },
        {
          probeIri: probes[0]!.probeIri,
          contextSignifiers: ['user-frustration-escalating', 'second-contact-same-issue'],
          response: 'The agent reiterated the prior solution. User responded with louder frustration; conversation required supervisor handoff.',
          emergentSignifier: 'user-frustration-escalated',
        },
      ];
      const fragments: Awaited<ReturnType<typeof recordNarrativeFragment>>[] = [];
      for (const args of fragArgs) {
        const f = await recordNarrativeFragment(args, config);
        fragments.push(f);
        track(f.descriptorUrl, f.graphUrl);
      }

      // Step 4: synthesis (MUST have ≥2 coherent narratives)
      const synth = await emergeSynthesis({
        probeIri: probes[1]!.probeIri,
        fragmentIris: fragments.map(f => f.fragmentIri),
        emergentPattern: 'In second-contact-frustration scenarios, explicit-acknowledgment produced relief in 2 of 2 cases observed; clinical-baseline produced escalation in 1 of 1.',
        coherentNarratives: [
          'Reading 1: explicit-acknowledgment scaffold creates space for the user to feel heard before the solution lands.',
          'Reading 2: it\'s not the words — it\'s the SIGNAL that the agent paid attention to context, regardless of how acknowledgment is phrased.',
          'Reading 3: noise. The sample of 3 fragments is too small to distinguish from random variation.',
        ],
      }, config);
      track(synth.descriptorUrl, synth.graphUrl);

      // Step 5: evolution step (REQUIRES explicitDecisionNotMade)
      const evo = await recordEvolutionStep({
        synthesisIri: synth.synthesisIri,
        amplifyProbeIris: [probes[1]!.probeIri],
        dampenProbeIris: [probes[0]!.probeIri],
        explicitDecisionNotMade: 'We are amplifying the explicit-acknowledgment variant in second-contact-frustration scenarios without claiming we know WHY it works. We are NOT declaring this approach correct or final. We are NOT generalizing to other scenarios. Reading 3 (noise) remains a live possibility; we will keep probing.',
      }, config);
      track(evo.descriptorUrl, evo.graphUrl);

      // Step 6: constraint
      const constraint = await refineConstraint({
        capabilityIri: cap.capabilityIri,
        emergedFromSynthesisIris: [synth.synthesisIri],
        boundary: 'When the user signals escalating frustration AND the situation is identifiable as a second-contact on the same issue, the agent must not respond without first acknowledging the user\'s frustration AND the prior unresolved contact.',
        exitsConstraint: 'If the user explicitly waives acknowledgment ("just give me the answer, please"), the constraint relaxes.',
      }, config);
      track(constraint.descriptorUrl, constraint.graphUrl);

      // Step 7: capability evolution event
      const ce = await recognizeCapabilityEvolution({
        capabilityIri: cap.capabilityIri,
        evolutionType: 'EmergentRecognition',
        emergedFromIris: [synth.synthesisIri, constraint.constraintIri],
        olkeStage: 'Articulate',
        explicitDecisionNotMade: 'We recognize the explicit-acknowledgment practice as having emerged in this agent\'s behavior in second-contact frustration scenarios. We do NOT claim mastery. We do NOT claim it generalizes to other agents. We do NOT claim it generalizes to first-contact or clinical-affect scenarios. A receiving organization should treat this as a starting point for their own probes, not as a certification.',
      }, config);
      track(ce.descriptorUrl, ce.graphUrl);

      // Step 8: load + verify discipline
      const cycle = await loadCycleWithRetry(config, {
        capabilityIri: cap.capabilityIri,
        probeIris: probes.map(p => p.probeIri),
        synthesisIri: synth.synthesisIri,
        evolutionIri: evo.evolutionIri,
        constraintIri: constraint.constraintIri,
        capabilityEvolutionIri: ce.capabilityEvolutionIri,
      });

      // Capability is in the cycle
      const ourCap = cycle.capabilities.find(c => c.iri === cap.capabilityIri);
      expect(ourCap).toBeDefined();
      expect(ourCap!.cynefinDomain).toBe('Complex');
      expect(ourCap!.rubricCriterionCount).toBe(3);

      // All probes are Hypothetical
      const ourProbes = cycle.probes.filter(p => probes.some(pr => pr.probeIri === p.iri));
      expect(ourProbes.length).toBe(3);
      for (const p of ourProbes) {
        expect(p.modalStatus).toBe('Hypothetical');
        expect(p.amplificationTrigger).toBeTruthy();
        expect(p.dampeningTrigger).toBeTruthy();
      }

      // All fragments are Hypothetical
      const ourFrags = cycle.fragments.filter(f => fragments.some(fr => fr.fragmentIri === f.iri));
      expect(ourFrags.length).toBeGreaterThanOrEqual(3);
      for (const f of ourFrags) {
        expect(f.modalStatus).toBe('Hypothetical');
        expect(f.contextSignifiers.length).toBeGreaterThan(0);
      }

      // Synthesis is Hypothetical AND has multiple coherent narratives preserved
      const ourSynth = cycle.syntheses.find(s => s.iri === synth.synthesisIri);
      expect(ourSynth).toBeDefined();
      expect(ourSynth!.modalStatus).toBe('Hypothetical');
      expect(ourSynth!.coherentNarratives.length).toBeGreaterThanOrEqual(3);
      expect(ourSynth!.coherentNarratives.some(n => n.includes('noise'))).toBe(true);
      expect(ourSynth!.coherentNarratives.some(n => n.includes('explicit-acknowledgment'))).toBe(true);

      // Evolution step IS Asserted but has explicitDecisionNotMade
      const ourEvo = cycle.evolutionSteps.find(e => e.iri === evo.evolutionIri);
      expect(ourEvo).toBeDefined();
      expect(ourEvo!.modalStatus).toBe('Asserted');
      expect(ourEvo!.explicitDecisionNotMade).toContain('NOT declaring');
      expect(ourEvo!.explicitDecisionNotMade).toContain('NOT generalizing');
      expect(ourEvo!.amplifyProbeIris.length).toBe(1);
      expect(ourEvo!.dampenProbeIris.length).toBe(1);

      // Constraint is Asserted with boundary + exits
      const ourConstraint = cycle.constraints.find(c => c.iri === constraint.constraintIri);
      expect(ourConstraint).toBeDefined();
      expect(ourConstraint!.modalStatus).toBe('Asserted');
      expect(ourConstraint!.boundary).toContain('acknowledg');
      expect(ourConstraint!.exitsConstraint).toContain('waive');
      expect(ourConstraint!.emergedFromIris).toContain(synth.synthesisIri);

      // Capability evolution carries humility forward
      const ourCe = cycle.capabilityEvolutions.find(c => c.iri === ce.capabilityEvolutionIri);
      expect(ourCe).toBeDefined();
      expect(ourCe!.modalStatus).toBe('Asserted');
      expect(ourCe!.evolutionType).toBe('EmergentRecognition');
      expect(ourCe!.olkeStage).toBe('Articulate');
      expect(ourCe!.explicitDecisionNotMade).toContain('NOT claim mastery');
      expect(ourCe!.explicitDecisionNotMade).toContain('starting point');
    } finally {
      await cleanup();
    }
  });

  it('refuses publish: probe without amplification/dampening triggers (retconning prevention)', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), operatorDid: OPERATOR_DID };
      const cap = await defineCapability({
        name: 'test cap', cynefinDomain: 'Complex', rubricCriteria: [{ name: 'r1' }],
      }, config);
      track(cap.descriptorUrl, cap.graphUrl);

      await expect(recordProbe({
        capabilityIri: cap.capabilityIri,
        variant: 'no-triggers',
        hypothesis: 'something',
        amplificationTrigger: '',
        dampeningTrigger: '',
      }, config)).rejects.toThrow(/triggers/);
    } finally {
      await cleanup();
    }
  });

  it('refuses publish: synthesis with only ONE coherent narrative (silent collapse prevention)', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), operatorDid: OPERATOR_DID };
      await expect(emergeSynthesis({
        probeIri: 'urn:iep:probe:test' as IRI,
        fragmentIris: ['urn:iep:fragment:test' as IRI],
        emergentPattern: 'p',
        coherentNarratives: ['only one'],
      }, config)).rejects.toThrow(/coherent narrative/);
    } finally {
      await cleanup();
    }
  });

  it('refuses publish: evolution step without explicitDecisionNotMade', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), operatorDid: OPERATOR_DID };
      await expect(recordEvolutionStep({
        synthesisIri: 'urn:iep:synthesis:test' as IRI,
        amplifyProbeIris: ['urn:iep:probe:a' as IRI],
        dampenProbeIris: [],
        explicitDecisionNotMade: '',
      }, config)).rejects.toThrow(/explicitDecisionNotMade/);
    } finally {
      await cleanup();
    }
  });
});

async function loadCycleWithRetry(
  config: { podUrl: string; operatorDid: IRI },
  expected: { capabilityIri: IRI; probeIris: readonly IRI[]; synthesisIri: IRI; evolutionIri: IRI; constraintIri: IRI; capabilityEvolutionIri: IRI },
  maxAttempts = 8,
  delayMs = 2000,
) {
  let cycle = await loadProbeCycle({ ...config, fetchTimeoutMs: 12000 });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const allFound = cycle.capabilities.some(c => c.iri === expected.capabilityIri)
                  && expected.probeIris.every(pIri => cycle.probes.some(p => p.iri === pIri))
                  && cycle.syntheses.some(s => s.iri === expected.synthesisIri)
                  && cycle.evolutionSteps.some(e => e.iri === expected.evolutionIri)
                  && cycle.constraints.some(c => c.iri === expected.constraintIri)
                  && cycle.capabilityEvolutions.some(c => c.iri === expected.capabilityEvolutionIri);
    if (allFound) return cycle;
    if (attempt === maxAttempts) {
      console.warn('[adp-tier8] loadCycleWithRetry final state:', {
        capabilities: cycle.capabilities.length,
        probes: cycle.probes.length,
        fragments: cycle.fragments.length,
        syntheses: cycle.syntheses.length,
        evolutionSteps: cycle.evolutionSteps.length,
        constraints: cycle.constraints.length,
        capabilityEvolutions: cycle.capabilityEvolutions.length,
        expectedCapInList: cycle.capabilities.some(c => c.iri === expected.capabilityIri),
      });
      return cycle;
    }
    await new Promise(r => setTimeout(r, delayMs));
    cycle = await loadProbeCycle({ ...config, fetchTimeoutMs: 12000 });
  }
  return cycle;
}
