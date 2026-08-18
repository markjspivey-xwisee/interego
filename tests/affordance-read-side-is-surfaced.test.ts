/**
 * A descriptor's READ side must survive `dereference`.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * `dereference()` and the relay tools built on it are the only generic way an agent learns what an
 * affordance offers. The extractor read action/target/method/mediaType/expects/returns/fields and
 * stopped — it never read `iep:reads`, `dcat:accessService` or `dcat:accessURL`. Meanwhile the
 * shared affordance emitter puts a read-side block on EVERY affordance in the fleet: three emit
 * sites, zero read sites.
 *
 * So the only thing a caller could see was "POST this target", and the only thing it could do was
 * take whatever came back — measured once at 1,228,985 characters. The descriptor was not silent;
 * the substrate's own read verb discarded what it said. The published rationale for `iep:reads` is
 * "so a caller can learn of it before spending a call", and that was impossible by construction.
 *
 * ★ `dcat:accessService` IS THE ONE THAT MATTERS. In DCAT it means a DataService you QUERY, as
 * against `accessURL`, which is where a copy is fetched. A caller that can see one can ask a narrow
 * question; a caller that cannot has no option but the transfer.
 */

import { describe, it, expect } from 'vitest';
import { extractAffordancesFromTurtle } from '@interego/core';

const DESCRIPTOR = 'https://bridge.example/agent/review-record/affordance';

/** The shape the shared affordance emitter actually produces — blank-node read blocks. */
const TTL = `
@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat:  <http://www.w3.org/ns/dcat#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .

<https://relay.example/ns/iep/action/foxxi/review-record>
    a iep:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action <https://relay.example/ns/iep/action/foxxi/review-record> ;
    hydra:target <https://bridge.example/agent/review-record> ;
    hydra:method "POST" ;
    dcat:mediaType "application/json" ;
    iep:reads
        [
            a iep:EvidenceSource, dcat:Dataset ;
            rdfs:label "the subject's per-agent mesh lens" ;
            iep:store <https://relay.example/ns/iep/store/foxxi/mesh-lens> ;
            dcat:accessURL <https://relay.example/ns/iep/store/foxxi/mesh-lens> ;
            dcat:accessService <https://bridge.example/agent/lattice/lens/query> ;
            iep:populatedBy <https://bridge.example/agent/mesh-event> ;
            iep:admits "Trajectory steps from an enrolled pod." ;
            iep:enrolmentRegister <https://bridge.example/agent/mesh/enrolment>
        ] ,
        [
            a iep:EvidenceSource, dcat:Dataset ;
            rdfs:label "durable statements on the subject's pod" ;
            iep:store <https://relay.example/ns/iep/store/foxxi/durable> ;
            iep:populatedBy <https://bridge.example/xapi/statements>
        ] .
`;

describe('the affordance extractor surfaces what a capability READS', () => {
  const [aff] = extractAffordancesFromTurtle(TTL, DESCRIPTOR);

  it('still reads the invoke side unchanged', () => {
    expect(aff?.target).toBe('https://bridge.example/agent/review-record');
    expect(aff?.method).toBe('POST');
    expect(aff?.mediaType).toBe('application/json');
  });

  it('★ surfaces every declared evidence source', () => {
    expect(aff?.reads).toBeDefined();
    expect(aff?.reads?.length).toBe(2);
  });

  it('★★ surfaces dcat:accessService — the handle that lets a caller QUERY instead of copy', () => {
    expect(aff?.reads?.[0]?.accessService).toBe('https://bridge.example/agent/lattice/lens/query');
  });

  it('keeps the write port distinguishable from the read handles', () => {
    // populatedBy is where the store is WRITTEN. Conflating it with accessService is precisely the
    // bug that sent a DCAT-literate caller to a POST-only endpoint that 404s a GET, leaving the
    // bulk copy as the only remaining read.
    const first = aff?.reads?.[0];
    expect(first?.populatedBy).toBe('https://bridge.example/agent/mesh-event');
    expect(first?.populatedBy).not.toBe(first?.accessService);
  });

  it('carries the rest of the read-side contract a caller needs before spending a call', () => {
    const first = aff?.reads?.[0];
    expect(first?.store).toBe('https://relay.example/ns/iep/store/foxxi/mesh-lens');
    expect(first?.label).toBe("the subject's per-agent mesh lens");
    expect(first?.admits).toMatch(/Trajectory steps/);
    expect(first?.enrolmentRegister).toBe('https://bridge.example/agent/mesh/enrolment');
  });

  it('a source with no query service says so by omission, not by an empty string', () => {
    // "There is no access service" and "there is one and it is blank" are different facts. The
    // absence is the honest statement, and a caller branches on it.
    expect(aff?.reads?.[1]?.accessService).toBeUndefined();
    expect(aff?.reads?.[1]?.store).toBe('https://relay.example/ns/iep/store/foxxi/durable');
  });

  it('an affordance that declares no read side gets undefined, not an empty array', () => {
    const bare = `
@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://relay.example/ns/iep/action/x> a iep:Affordance ;
    iep:action <https://relay.example/ns/iep/action/x> ;
    hydra:target <https://bridge.example/x> ; hydra:method "POST" .
`;
    expect(extractAffordancesFromTurtle(bare, DESCRIPTOR)[0]?.reads).toBeUndefined();
  });
});
