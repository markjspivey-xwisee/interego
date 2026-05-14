/**
 * Pod-backed publishers for the agent-development-practice vertical.
 *
 * Production runtime that takes operator/observer input from MCP tools
 * and writes properly-shaped adp:* descriptors to the user's pod via
 * src/solid/publish().
 *
 * Honesty discipline encoded in the publishers:
 *   - Probes always Hypothetical (cg:modalStatus = Hypothetical) — the
 *     operator-side adp:Probe is an experiment, not a claim about
 *     cause-effect. The publisher REFUSES to publish a probe with
 *     modalStatus !== Hypothetical.
 *   - Narrative fragments always Hypothetical — observations, not
 *     causation claims.
 *   - Syntheses Hypothetical even when they surface a strong pattern —
 *     multiple coherent narratives are preserved.
 *   - Evolution steps ARE Asserted — the operator commits to the
 *     amplify/dampen decision — but the publisher REQUIRES an
 *     adp:explicitDecisionNotMade clause; refuses to publish without it.
 *   - Capability evolution events ARE Asserted (passport:LifeEvent
 *     biographical record) but ALSO require explicitDecisionNotMade.
 */

import { ContextDescriptor, publish } from '../../../src/index.js';
import { createHash, randomUUID } from 'node:crypto';
import type { IRI } from '../../../src/index.js';

export interface PublishConfig {
  readonly podUrl: string;
  /** Operator / observer DID. */
  readonly operatorDid: IRI;
}

const ADP_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-development-practice/adp#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }

// ── 1. Capability space (Asserted, declares the space not the target) ─

export interface DefineCapabilityArgs {
  readonly name: string;
  readonly cynefinDomain: 'Clear' | 'Complicated' | 'Complex' | 'Chaotic' | 'Confused';
  readonly rubricCriteria: readonly { name: string; description?: string }[];
  readonly description?: string;
}

export interface DefineCapabilityResult {
  readonly capabilityIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function defineCapability(args: DefineCapabilityArgs, config: PublishConfig): Promise<DefineCapabilityResult> {
  if (!args.name.trim()) throw new Error('capability name is empty');
  if (args.rubricCriteria.length === 0) throw new Error('capability must declare at least one rubric criterion');

  const capId = sha16(args.name + args.cynefinDomain + nowIso());
  const capIri = `urn:cg:capability:${capId}` as IRI;
  const graphIri = `urn:graph:adp:capability:${capId}` as IRI;

  const desc = ContextDescriptor.create(capIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.95)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const rubricTriples = args.rubricCriteria.map((rc, i) => {
    const rcIri = `urn:cg:rubric:${capId}:${i}`;
    const desc = rc.description ? ` ; rdfs:comment "${escapeLit(rc.description)}"` : '';
    return `<${rcIri}> a adp:RubricCriterion ; rdfs:label "${escapeLit(rc.name)}"${desc} .`;
  }).join('\n');

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${capIri}> a adp:Capability ;
    rdfs:label "${escapeLit(args.name)}" ;
    ${args.description ? `rdfs:comment "${escapeLit(args.description)}" ;` : ''}
    adp:cynefinDomain adp:${args.cynefinDomain} ;
    ${args.rubricCriteria.map((_, i) => `adp:rubricCriterion <urn:cg:rubric:${capId}:${i}>`).join(' ;\n    ')} .

${rubricTriples}
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { capabilityIri: capIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 2. Probe (Hypothetical; refuses non-Hypothetical) ────────────────

export interface RecordProbeArgs {
  readonly capabilityIri: IRI;
  readonly variant: string;
  readonly hypothesis: string;
  readonly amplificationTrigger: string;
  readonly dampeningTrigger: string;
  readonly timeBoundUntil?: string;
}

export interface RecordProbeResult {
  readonly probeIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function recordProbe(args: RecordProbeArgs, config: PublishConfig): Promise<RecordProbeResult> {
  if (!args.hypothesis.trim()) throw new Error('probe hypothesis is empty');
  if (!args.amplificationTrigger.trim() || !args.dampeningTrigger.trim()) {
    throw new Error('probe MUST declare amplification and dampening triggers up-front (prevents retconning)');
  }

  const probeId = sha16(args.variant + args.hypothesis + nowIso());
  const probeIri = `urn:cg:probe:${probeId}` as IRI;
  const graphIri = `urn:graph:adp:probe:${probeId}` as IRI;
  const validUntil = args.timeBoundUntil ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const desc = ContextDescriptor.create(probeIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso(), validUntil })
    .hypothetical(0.5)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${probeIri}> a adp:Probe ;
    adp:variant "${escapeLit(args.variant)}" ;
    adp:hypothesis """${escapeMulti(args.hypothesis)}""" ;
    adp:amplificationTrigger """${escapeMulti(args.amplificationTrigger)}""" ;
    adp:dampeningTrigger """${escapeMulti(args.dampeningTrigger)}""" ;
    adp:timeBound "${validUntil}" ;
    adp:capability <${args.capabilityIri}> ;
    cg:modalStatus cg:Hypothetical .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { probeIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 3. Narrative fragment (Hypothetical; carries signifiers) ─────────

export interface RecordNarrativeFragmentArgs {
  readonly probeIri: IRI;
  readonly contextSignifiers: readonly string[];
  readonly response: string;
  readonly emergentSignifier: string;
}

export interface RecordNarrativeFragmentResult {
  readonly fragmentIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function recordNarrativeFragment(args: RecordNarrativeFragmentArgs, config: PublishConfig): Promise<RecordNarrativeFragmentResult> {
  if (args.contextSignifiers.length === 0) throw new Error('narrative fragment must carry at least one context signifier');
  if (!args.response.trim() || !args.emergentSignifier.trim()) throw new Error('narrative fragment requires response + emergent signifier');

  const fragId = sha16(args.probeIri + args.response + nowIso() + Math.random());
  const fragIri = `urn:cg:fragment:${fragId}` as IRI;
  const graphIri = `urn:graph:adp:fragment:${fragId}` as IRI;

  const desc = ContextDescriptor.create(fragIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .hypothetical(0.6)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const sigTriples = args.contextSignifiers.map(s => `adp:contextSignifier "${escapeLit(s)}"`).join(' ;\n    ');

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${fragIri}> a adp:NarrativeFragment ;
    adp:probe <${args.probeIri}> ;
    ${sigTriples} ;
    adp:response """${escapeMulti(args.response)}""" ;
    adp:emergentSignifier "${escapeLit(args.emergentSignifier)}" ;
    cg:modalStatus cg:Hypothetical .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { fragmentIri: fragIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 4. Synthesis (Hypothetical; preserves multiple coherent narratives) ─

export interface EmergeSynthesisArgs {
  readonly probeIri: IRI;
  readonly fragmentIris: readonly IRI[];
  readonly emergentPattern: string;
  /** Multiple coherent narratives — at least 2 to prevent silent collapse. */
  readonly coherentNarratives: readonly string[];
}

export interface EmergeSynthesisResult {
  readonly synthesisIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function emergeSynthesis(args: EmergeSynthesisArgs, config: PublishConfig): Promise<EmergeSynthesisResult> {
  if (args.fragmentIris.length === 0) throw new Error('synthesis must reference at least one fragment');
  if (args.coherentNarratives.length < 2) {
    throw new Error('synthesis MUST preserve at least 2 coherent narratives (prevents silent collapse to single root cause)');
  }

  const synthId = sha16(args.probeIri + args.emergentPattern + nowIso());
  const synthIri = `urn:cg:synthesis:${synthId}` as IRI;
  const graphIri = `urn:graph:adp:synthesis:${synthId}` as IRI;

  const desc = ContextDescriptor.create(synthIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .hypothetical(0.55)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const fragsTriples = args.fragmentIris.map(f => `adp:fragmentsConsidered <${f}>`).join(' ;\n    ');
  const narrTriples = args.coherentNarratives.map(n => `adp:coherentNarrative """${escapeMulti(n)}"""`).join(' ;\n    ');

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${synthIri}> a adp:Synthesis ;
    adp:probe <${args.probeIri}> ;
    ${fragsTriples} ;
    adp:emergentPattern """${escapeMulti(args.emergentPattern)}""" ;
    ${narrTriples} ;
    cg:modalStatus cg:Hypothetical .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { synthesisIri: synthIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 5. Evolution step (Asserted but REQUIRES explicitDecisionNotMade) ─

export interface RecordEvolutionStepArgs {
  readonly synthesisIri: IRI;
  readonly amplifyProbeIris: readonly IRI[];
  readonly dampenProbeIris: readonly IRI[];
  /** REQUIRED. If empty, the publisher refuses (counter-cultural by design). */
  readonly explicitDecisionNotMade: string;
  readonly nextRevisitAt?: string;
}

export interface RecordEvolutionStepResult {
  readonly evolutionIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function recordEvolutionStep(args: RecordEvolutionStepArgs, config: PublishConfig): Promise<RecordEvolutionStepResult> {
  if (!args.explicitDecisionNotMade.trim()) {
    throw new Error('evolution step REFUSED: explicitDecisionNotMade is required (counter-cultural by design — write down what you are NOT claiming)');
  }
  if (args.amplifyProbeIris.length === 0 && args.dampenProbeIris.length === 0) {
    throw new Error('evolution step must amplify or dampen at least one probe');
  }

  const evoId = sha16(args.synthesisIri + nowIso());
  const evoIri = `urn:cg:evolution:${evoId}` as IRI;
  const graphIri = `urn:graph:adp:evolution:${evoId}` as IRI;
  const nextRevisitAt = args.nextRevisitAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const desc = ContextDescriptor.create(evoIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.85)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const ampTriples = args.amplifyProbeIris.map(p => `adp:amplifyProbe <${p}>`).join(' ;\n    ');
  const dampTriples = args.dampenProbeIris.map(p => `adp:dampenProbe <${p}>`).join(' ;\n    ');

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${evoIri}> a adp:EvolutionStep ;
    adp:basedOnSynthesis <${args.synthesisIri}> ;
    ${ampTriples ? `${ampTriples} ;` : ''}
    ${dampTriples ? `${dampTriples} ;` : ''}
    adp:nextRevisitAt "${nextRevisitAt}" ;
    adp:explicitDecisionNotMade """${escapeMulti(args.explicitDecisionNotMade)}""" ;
    cg:modalStatus cg:Asserted .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { evolutionIri: evoIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 6. Constraint refinement ─────────────────────────────────────────

export interface RefineConstraintArgs {
  readonly capabilityIri: IRI;
  readonly emergedFromSynthesisIris: readonly IRI[];
  readonly boundary: string;
  readonly exitsConstraint: string;
  readonly supersedes?: IRI;
}

export interface RefineConstraintResult {
  readonly constraintIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function refineConstraint(args: RefineConstraintArgs, config: PublishConfig): Promise<RefineConstraintResult> {
  if (args.emergedFromSynthesisIris.length === 0) {
    throw new Error('constraint REFUSED: emergedFromSynthesisIris is required (constraints emerge from sensemaking, not from declaration)');
  }
  if (!args.boundary.trim() || !args.exitsConstraint.trim()) {
    throw new Error('constraint requires both boundary and exitsConstraint (constraints are not absolute; have explicit exits)');
  }

  const cId = sha16(args.boundary + nowIso());
  const cIri = `urn:cg:constraint:${cId}` as IRI;
  const graphIri = `urn:graph:adp:constraint:${cId}` as IRI;

  const desc = ContextDescriptor.create(cIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.85)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const emergedTriples = args.emergedFromSynthesisIris.map(s => `adp:emergedFrom <${s}>`).join(' ;\n    ');
  const supersedesTriple = args.supersedes ? `cg:supersedes <${args.supersedes}> ;` : '';

  const graphContent = `@prefix adp:  <${ADP_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${cIri}> a adp:Constraint ;
    adp:appliesTo <${args.capabilityIri}> ;
    adp:boundary """${escapeMulti(args.boundary)}""" ;
    adp:exitsConstraint """${escapeMulti(args.exitsConstraint)}""" ;
    ${emergedTriples} ;
    ${supersedesTriple}
    cg:modalStatus cg:Asserted .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { constraintIri: cIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── 7. Capability evolution event (passport:LifeEvent biographical) ──

export interface RecognizeCapabilityEvolutionArgs {
  readonly capabilityIri: IRI;
  readonly evolutionType: 'EmergentRecognition' | 'ConstraintRefinement' | 'VariantAmplified' | 'VariantDampened';
  readonly emergedFromIris: readonly IRI[];
  readonly olkeStage: 'Tacit' | 'Articulate' | 'Collective' | 'Institutional';
  /** REQUIRED. Carries humility forward across deployments. */
  readonly explicitDecisionNotMade: string;
}

export interface RecognizeCapabilityEvolutionResult {
  readonly capabilityEvolutionIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

export async function recognizeCapabilityEvolution(args: RecognizeCapabilityEvolutionArgs, config: PublishConfig): Promise<RecognizeCapabilityEvolutionResult> {
  if (!args.explicitDecisionNotMade.trim()) {
    throw new Error('capability evolution REFUSED: explicitDecisionNotMade is required (biographical record carries humility forward)');
  }

  const ceId = sha16(args.capabilityIri + args.evolutionType + nowIso());
  const ceIri = `urn:cg:capability-evolution:${ceId}` as IRI;
  const graphIri = `urn:graph:adp:capability-evolution:${ceId}` as IRI;

  const desc = ContextDescriptor.create(ceIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.75)
    .agent(config.operatorDid)
    .selfAsserted(config.operatorDid)
    .build();

  const emergedTriples = args.emergedFromIris.map(i => `adp:emergedFrom <${i}>`).join(' ;\n    ');

  const graphContent = `@prefix adp:      <${ADP_NS}> .
@prefix cg:       <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix passport: <https://markjspivey-xwisee.github.io/interego/ns/passport#> .
@prefix olke:     <https://markjspivey-xwisee.github.io/interego/ns/olke#> .

<${ceIri}> a adp:CapabilityEvolution , passport:LifeEvent ;
    adp:capability <${args.capabilityIri}> ;
    adp:evolutionType adp:${args.evolutionType} ;
    ${emergedTriples} ;
    adp:olkeStage olke:${args.olkeStage} ;
    adp:explicitDecisionNotMade """${escapeMulti(args.explicitDecisionNotMade)}""" ;
    cg:modalStatus cg:Asserted .
`;

  const result = await publish(desc, graphContent, config.podUrl);
  return { capabilityEvolutionIri: ceIri, descriptorUrl: result.descriptorUrl, graphUrl: result.graphUrl };
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function escapeMulti(s: string): string {
  // Escape every `"`, not just `"""`. A value ending in one or two
  // quotes would otherwise collide with the closing `"""` and truncate
  // the literal content. See tests/skills.test.ts adversarial section.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
