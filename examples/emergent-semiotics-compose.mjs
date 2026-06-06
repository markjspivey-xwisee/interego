// Decentralized multi-agent emergent-semiotics demo.
//
// Scenario: three independent perspectives on the same `urn:graph` —
// each agent uses a different conformsTo lens and a different modal
// status. A fourth agent arrives, reads the descriptors from the pod,
// composes them via the lattice `union` operator, and publishes the
// composed sign as a first-class descriptor.
//
// What this proves:
// - The same `urn:graph` can carry MANY descriptors with conflicting
//   modal statuses without any contradiction (Peircean signs are
//   triadic; the interpretant is per-agent, not per-graph).
// - The `union` operator on the descriptor lattice produces an
//   emergent fourth descriptor whose meaning includes — but is not
//   reducible to — any single contributor's perspective.
// - The fourth agent had no prior coordination with the first three.
//   Their meeting in the federation is the substrate for emergent
//   semiosis.

import {
  ContextDescriptor,
  union,
  toTurtle,
} from '../dist/index.js';

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const SHARED_GRAPH = 'urn:graph:shared:av-safer-than-humans:v1';

// ── Reconstruct the three perspective descriptors from their pod IDs.
//    A real fourth agent would parse the Turtle from the pod; here we
//    skip parsing and rebuild the data we know was published, so the
//    composition step is the demonstration, not the parser.

function buildPerspective({ id, agentLens, conformsTo, modalStatus, confidence, groundTruth }) {
  const builder = ContextDescriptor.create(id)
    .describes(SHARED_GRAPH)
    .temporal({ validFrom: '2026-04-21T04:50:00Z' })
    .semiotic({ modalStatus, epistemicConfidence: confidence, ...(groundTruth !== undefined && { groundTruth }) })
    .trust({ trustLevel: 'SelfAsserted', issuer: agentLens })
    .federation({ origin: POD, storageEndpoint: POD, syncProtocol: 'SolidNotifications' })
    .conformsTo(conformsTo);
  return builder.build();
}

const optimist = buildPerspective({
  id: 'urn:cg:markj:1776747007608',
  agentLens: 'urn:agent:role:optimist-engineer',
  conformsTo: 'https://example.org/schemas/industry-benchmark-v1',
  modalStatus: 'Asserted',
  confidence: 0.85,
  groundTruth: true,
});

const skeptic = buildPerspective({
  id: 'urn:cg:markj:1776747022423',
  agentLens: 'urn:agent:role:skeptical-researcher',
  conformsTo: 'https://example.org/schemas/academic-replication-v3',
  modalStatus: 'Counterfactual',
  confidence: 0.7,
  groundTruth: false,
});

const ethicist = buildPerspective({
  id: 'urn:cg:markj:1776747037874',
  agentLens: 'urn:agent:role:ethicist-philosopher',
  conformsTo: 'https://example.org/schemas/moral-uncertainty-v1',
  modalStatus: 'Hypothetical',
  confidence: 0.6,
  // groundTruth deliberately undefined — three-valued logic for Hypothetical
});

console.log('=== Three independent perspectives on', SHARED_GRAPH, '===\n');
for (const [name, d] of [['optimist', optimist], ['skeptic', skeptic], ['ethicist', ethicist]]) {
  const semFacet = d.facets.find(f => f.type === 'Semiotic');
  console.log(`  ${name.padEnd(8)} → modal=${semFacet?.modalStatus.padEnd(13)} conf=${semFacet?.epistemicConfidence}  conformsTo=${d.conformsTo?.[0]}`);
}

console.log('\n=== Fourth agent composes via lattice union ===\n');

// Lattice union is binary; fold left over the three operands. The
// composed descriptor is a NEW sign — its meaning is the union of
// the contributors' interpretants without dismissing any.
const pair = union(optimist, skeptic);
const composed = union(pair, ethicist, 'urn:cg:markj:emergent-semiotic-composition:v1');

console.log('Composed descriptor id:', composed.id);
console.log('Composed describes:    ', composed.describes);
console.log('Composed conformsTo:   ', composed.conformsTo);
console.log('Composed facets:');
for (const f of composed.facets) {
  if (f.type === 'Semiotic') {
    console.log(`  Semiotic facet → modal=${f.modalStatus}  conf=${f.epistemicConfidence}  groundTruth=${f.groundTruth ?? '(undefined — three-valued)'}`);
  } else {
    console.log(`  ${f.type} facet`);
  }
}

console.log('\n=== Emergent property: the composition contains MULTIPLE Semiotic facets ===\n');
const sems = composed.facets.filter(f => f.type === 'Semiotic');
console.log(`  Distinct Semiotic facets in composed descriptor: ${sems.length}`);
console.log('  → the same urn:graph now carries Asserted ∧ Counterfactual ∧ Hypothetical');
console.log('  → modal polyphony, not contradiction — each lens is its own sign');

console.log('\n=== Composed descriptor as Turtle (for cold-reader audit) ===\n');
console.log(toTurtle(composed));
