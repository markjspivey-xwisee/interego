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
import type { IRI } from '../../../src/index.js';

const AZURE_CSS_BASE = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD_BASE = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;

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
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE' }); } catch {}
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE' }); } catch {}
    try { await fetch(root, { method: 'DELETE' }); } catch {}
  }
}

async function isPodReachable(): Promise<boolean> {
  if (process.env.SKIP_AZURE_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(TEST_POD_BASE, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let reachable = false;
beforeAll(async () => { reachable = await isPodReachable(); });

describe('Tier 8 — agent-development-practice production end-to-end', () => {
  it('reachability probe', () => {
    if (!reachable) console.warn('Azure CSS unreachable; ADP Tier 8 skipped');
    expect(typeof reachable).toBe('boolean');
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
      expect(cap.capabilityIri).toContain('urn:cg:capability');

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
        probeIri: 'urn:cg:probe:test' as IRI,
        fragmentIris: ['urn:cg:fragment:test' as IRI],
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
        synthesisIri: 'urn:cg:synthesis:test' as IRI,
        amplifyProbeIris: ['urn:cg:probe:a' as IRI],
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
