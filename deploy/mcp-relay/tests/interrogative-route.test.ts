#!/usr/bin/env tsx
/**
 * Interrogative-route smoke test (relay-side).
 *
 * The relay's `interrogative_route` handler is a thin composer: it reads a
 * descriptor via the existing get_descriptor path, then calls
 * routeInterrogatives() from @interego/pgsl. The descriptor read needs a live
 * pod, so this test exercises the part the relay actually depends on — the
 * EXACT @interego/pgsl symbols the handler imports — over a fixture descriptor,
 * proving the built package the relay consumes routes correctly (catches a bad
 * pgsl build/publish that the relay would silently inherit).
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/interrogative-route.test.ts
 * Exits non-zero on any failing assertion.
 */
import { routeInterrogatives, CANONICAL_ORDER } from '@interego/pgsl';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}`); }
}

const FIXTURE = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:desc:1> a iep:ContextDescriptor ;
  iep:describes <urn:graph:thing:42> ;
  iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ] ;
  iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent ; rdfs:label "Smith" ; iep:agentIdentity <did:ethr:0xabc> ] ; iep:onBehalfOf <did:web:owner> ] ;
  iep:hasFacet [ a iep:AccessControlFacet ; iep:authorization [ a acl:Authorization ; acl:agent <did:web:owner> ; acl:mode acl:Read ] ] .
`;

function main(): void {
  console.log('interrogative-route (relay-side @interego/pgsl smoke)\n');

  // Eleven interrogatives present.
  ok(CANONICAL_ORDER.length === 11, 'CANONICAL_ORDER has 11 interrogatives');

  // Explicit-interrogatives route over the fixture (the common relay path).
  const r = routeInterrogatives({ turtle: FIXTURE, interrogatives: ['Who', 'When', 'What'], target: 'urn:desc:1' });
  ok(r.ok === true, 'route ok');
  if (r.ok) {
    const who = r.answers.find(a => a.interrogative === 'Who');
    ok(who?.status === 'full' && (who.values as Record<string, any>)?.assertingAgent?.identity === 'did:ethr:0xabc', 'Who resolves the nested asserting-agent identity');
    ok(r.answers.find(a => a.interrogative === 'When')?.status === 'full', 'When is full');
    const what = r.answers.find(a => a.interrogative === 'What');
    ok(what?.status === 'pointer' && what.nextStep?.tool === 'pgsl_resolve', 'What is a pointer to pgsl_resolve');
    ok(typeof (r as { act?: unknown }).act === 'object', 'emits an ie:Act');
  }

  // NL classification path.
  const q = routeInterrogatives({ turtle: FIXTURE, question: 'who owns this and when', target: 'urn:desc:1' });
  ok(q.ok === true && q.classification.method === 'lexical', 'lexical classification path works');

  // Gate: nothing specified -> structured error, never a throw.
  const g = routeInterrogatives({ turtle: FIXTURE });
  ok(g.ok === false, 'gate rejects when no question/interrogatives/all');

  // Not-parseable turtle -> structured error.
  const bad = routeInterrogatives({ turtle: '<<<nope', interrogatives: ['When'] });
  ok(bad.ok === false, 'unparseable turtle -> structured error');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('Failures:', failures.join('; ')); process.exit(1); }
}
main();
