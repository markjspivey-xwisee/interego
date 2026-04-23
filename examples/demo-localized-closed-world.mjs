// Demo: Localized closed-world reasoning at SHACL boundaries.
//
// The semantic web orthodoxy is open-world: absence of information
// means "unknown," not "false." That's correct at the discovery
// layer, where you can never prove a negative across the whole
// federation. But at a SHACL closed-shape boundary, absence becomes
// evidence: the boundary contract defines exactly what properties
// are in scope, so "not present" means "not true" inside that scope.
//
// The same query can return different answers — both correct —
// depending on whether it runs inside the closed boundary or in the
// open federation. Most systems can't tell these apart. Ours can,
// because the boundary is a typed artifact (the SHACL shape), not
// an implicit convention.
//
// Principles exercised:
//   - Closed-world at the boundary, open-world at integration
//   - SHACL 1.2 closed shapes as boundary contracts
//   - Holonic projection (the boundary IS the contract)
//   - Evidence-typed answers (what does "no" mean?)
//
// Success criterion: identical query → different authoritative
// answers in closed vs open mode, with the closed answer carrying
// shape-grounded evidence.

// ── A closed shape for an Employee record ─────────────────────
//
// Per SHACL 1.2: sh:closed=true means properties NOT declared in
// the shape cannot validly appear on conformant instances. Inside
// this boundary, absence is evidence; outside, it's silence.

const employeeShape = {
  iri: 'urn:shape:Employee/v1',
  closed: true,
  properties: [
    { path: 'name', required: true },
    { path: 'role', required: true },
    { path: 'startDate', required: true },
    { path: 'manager', required: false },
    { path: 'team', required: false },
  ],
};

const closedPaths = new Set(employeeShape.properties.map(p => p.path));

// ── A graph that conforms to the closed shape ────────────────

const closedGraph = {
  iri: 'urn:graph:hr:q2-2026-roster',
  conformsTo: employeeShape.iri,
  subjects: {
    'urn:employee:alice': { name: 'Alice Chen', role: 'SRE', startDate: '2024-03-01', manager: 'urn:employee:bob' },
    'urn:employee:bob':   { name: 'Bob Singh',  role: 'Eng Mgr', startDate: '2019-01-15', team: 'urn:team:platform' },
    'urn:employee:carol': { name: 'Carol Ruiz', role: 'Designer', startDate: '2023-11-20' },
  },
};

// ── An open-world extension: facts about the same subjects
//    from other pods / other contexts, not constrained by the
//    Employee shape ─────────────────────────────────────────

const federatedGraph = {
  iri: 'urn:graph:federated:employee-extensions',
  open: true,
  triples: [
    { s: 'urn:employee:alice', p: 'github', o: 'alice-chen' },
    { s: 'urn:employee:bob', p: 'spouse', o: 'urn:person:someone' },
    { s: 'urn:employee:carol', p: 'portfolio', o: 'https://carolruiz.design' },
    // Note: no one ever asserted anyone's salary anywhere visible.
  ],
};

// ── Query semantics ────────────────────────────────────────

/** Answer a property query under closed-world semantics: the shape
 *  says which properties are in scope; absence of declared
 *  properties can yield authoritative "not-present". Undeclared
 *  properties yield "not-in-scope" (which is stronger than "unknown"
 *  — the question isn't legitimate inside this boundary). */
function closedWorldQuery(subject, property) {
  if (!closedPaths.has(property)) {
    return {
      answer: 'not-in-scope',
      justification: `property "${property}" is not declared in ${employeeShape.iri}; the shape is sh:closed, so it cannot validly appear here.`,
      evidence: { shape: employeeShape.iri, closed: true },
    };
  }
  const record = closedGraph.subjects[subject];
  if (!record) {
    return {
      answer: 'subject-not-in-graph',
      justification: `${subject} is not present in ${closedGraph.iri}.`,
      evidence: { graph: closedGraph.iri },
    };
  }
  if (property in record) {
    return {
      answer: record[property],
      justification: `asserted directly in ${closedGraph.iri}.`,
      evidence: { graph: closedGraph.iri, witness: 'direct' },
    };
  }
  return {
    answer: false,
    justification: `property is in the closed shape's scope but is absent from ${subject}'s record in ${closedGraph.iri}; the closed shape makes absence authoritative here.`,
    evidence: { graph: closedGraph.iri, shape: employeeShape.iri, reasoning: 'closed-world-absence' },
  };
}

/** Answer a property query under open-world semantics: absence is
 *  never evidence of falsity; the best you can do is "not-found-in
 *  -these-sources." */
function openWorldQuery(subject, property) {
  const hits = [];
  const rec = closedGraph.subjects[subject];
  if (rec && property in rec) hits.push({ source: closedGraph.iri, value: rec[property] });
  for (const t of federatedGraph.triples) {
    if (t.s === subject && t.p === property) hits.push({ source: federatedGraph.iri, value: t.o });
  }
  if (hits.length > 0) {
    return {
      answer: hits.length === 1 ? hits[0].value : hits.map(h => h.value),
      justification: `found in ${hits.length} source(s).`,
      evidence: { sources: hits.map(h => h.source), count: hits.length },
    };
  }
  return {
    answer: 'unknown',
    justification: 'no source in the federation asserts this; open-world reasoning forbids inferring "not-true" from absence.',
    evidence: { sourcesChecked: [closedGraph.iri, federatedGraph.iri], witnessesFound: 0 },
  };
}

// ── Queries to exercise ─────────────────────────────────────

const QUERIES = [
  { subject: 'urn:employee:alice', property: 'manager', note: 'declared + present' },
  { subject: 'urn:employee:carol', property: 'manager', note: 'declared + absent' },
  { subject: 'urn:employee:alice', property: 'salary', note: 'undeclared property' },
  { subject: 'urn:employee:alice', property: 'github', note: 'federated only' },
  { subject: 'urn:employee:bob', property: 'spouse', note: 'federated only, undeclared' },
];

console.log('=== Localized closed-world + open-world at the federation boundary ===\n');
console.log(`Closed shape:     ${employeeShape.iri}  (sh:closed, paths: ${[...closedPaths].join(', ')})`);
console.log(`Closed graph:     ${closedGraph.iri}  → conforms to shape`);
console.log(`Federated graph:  ${federatedGraph.iri}  → open, unconstrained\n`);

for (const q of QUERIES) {
  console.log(`── ${q.subject.split(':').pop()} . ${q.property}   (${q.note})`);
  const closed = closedWorldQuery(q.subject, q.property);
  const open = openWorldQuery(q.subject, q.property);
  console.log(`   inside closed boundary: ${JSON.stringify(closed.answer)}`);
  console.log(`     ↳ ${closed.justification}`);
  console.log(`   at open federation:     ${JSON.stringify(open.answer)}`);
  console.log(`     ↳ ${open.justification}`);
  console.log('');
}

console.log('── Observed ──');
console.log('   Same question, same subject, two legitimate authoritative answers.');
console.log('   The difference is the shape of the boundary where the question is asked.');
console.log('');
console.log('   Inside the closed boundary:');
console.log('     "does Carol have a manager?" → false, with evidence (closed-shape absence).');
console.log('     "does Alice have a salary?" → not-in-scope (question is malformed here).');
console.log('');
console.log('   At the open federation layer:');
console.log('     same "salary" question → unknown (no witness; absence is not evidence).');
console.log('     "github" question → found (value from federated source).');
console.log('');
console.log('   Most systems treat all queries as one or the other. This system');
console.log('   carries the shape as a typed artifact, so the answer\'s *kind* is');
console.log('   computed, not assumed.');
