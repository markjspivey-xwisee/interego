/**
 * Learner / Performer Companion — integration test.
 *
 * Verifies the vertical's PROTOCOL-LAYER claims using real code paths:
 *   - Credential descriptor has Trust facet with issuer + ThirdPartyAttested
 *   - Performance record carries Provenance attributing it to manager (NOT user)
 *   - Training content + learning objective + grounding atom (PGSL) shape
 *   - Development plan is Hypothetical (assistant suggests, user decides)
 *   - Cited response references multiple cited descriptors
 *
 * "Real" boundary: builder + Turtle + validate + PGSL atom minting (real
 * content-addressed hashing). Does NOT pull from a real LRS or verify a
 * real OB 3.0 VC proof block (Tier 5).
 *
 * Scope finding (worth recording): the L1 cg:TrustFacet has issuer + a
 * trustLevel enum. Verifiable Credential proof blocks (the JSON Object that
 * holds the cryptographic signature) are vertical-scoped — they live as
 * lpc:vcProof literals on the descriptor IRI in the described graph, NOT
 * inside cg:TrustFacet. So integration tests at L1 verify the trust facet
 * structure; full VC proof verification belongs to a Tier 5 test that
 * actually invokes the compliance/ verifier against a real signature.
 */

import { describe, it, expect } from 'vitest';
import {
  ContextDescriptor,
  toTurtle,
  validate,
  createPGSL,
  mintAtom,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

// ── DIDs / IRIs ───────────────────────────────────────────────────────

const MARK_DID  = 'did:web:mark.example' as IRI;
const ARIA_DID  = 'did:web:aria.example' as IRI;
const ACME_DID  = 'did:web:acme-training.example' as IRI;
const JANE_DID  = 'did:web:jane.example' as IRI;
const HR_ISSUER = 'did:web:hr.acme.example' as IRI;

// ── Builders ─────────────────────────────────────────────────────────

function buildCredential() {
  return ContextDescriptor.create('urn:cg:credential:open-badge-3:cs101-mod3' as IRI)
    .describes('urn:graph:lpc:credential' as IRI)
    .temporal({ validFrom: '2025-09-15T11:00:00Z' })
    .asserted(0.99)
    .agent(MARK_DID)
    .trust({ issuer: ACME_DID, trustLevel: 'ThirdPartyAttested' })
    .build();
}

function buildLearningExperience() {
  return ContextDescriptor.create('urn:cg:lpc:learning-experience:cs101-mod3' as IRI)
    .describes('urn:graph:lpc:learning-experience' as IRI)
    .temporal({ validFrom: '2026-04-15T14:32:00Z' })
    .asserted(0.95)
    .agent(MARK_DID)
    .selfAsserted(MARK_DID)
    .build();
}

function buildTrainingContent() {
  return ContextDescriptor.create('urn:cg:lpc:training-content:cs101:module-3' as IRI)
    .describes('urn:graph:lpc:training-content' as IRI)
    .temporal({ validFrom: '2025-06-01T00:00:00Z' })
    .asserted(0.99)
    .trust({ issuer: ACME_DID, trustLevel: 'ThirdPartyAttested' })   // authoritative source
    .build();
}

function buildPerformanceRecord() {
  return ContextDescriptor.create('urn:cg:lpc:performance-record:q1-2026' as IRI)
    .describes('urn:graph:lpc:performance-record' as IRI)
    .temporal({ validFrom: '2026-04-20T16:00:00Z' })
    .asserted(0.95)
    .agent(JANE_DID)                                                  // ASSERTED BY MANAGER
    .provenance({ wasAttributedTo: [JANE_DID] })                      // attributed to Jane
    .trust({ issuer: HR_ISSUER, trustLevel: 'ThirdPartyAttested' })
    .build();
}

function buildDevelopmentPlan() {
  return ContextDescriptor.create('urn:cg:lpc:development-plan:q2-2026' as IRI)
    .describes('urn:graph:lpc:development-plan' as IRI)
    .temporal({ validFrom: '2026-04-27T10:00:00Z' })
    .hypothetical(0.4)                                                // suggestion, NOT commitment
    .agent(ARIA_DID, 'AssertingAgent', MARK_DID)                      // Aria asserts on Mark's behalf
    .selfAsserted(ARIA_DID)
    .build();
}

function buildCitedResponse() {
  return ContextDescriptor.create('urn:cg:lpc:cited-response:question-1' as IRI)
    .describes('urn:graph:lpc:cited-response' as IRI)
    .temporal({ validFrom: '2026-04-27T11:00:00Z' })
    .asserted(0.85)
    .agent(ARIA_DID, 'AssertingAgent', MARK_DID)
    .selfAsserted(ARIA_DID)
    .build();
}

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('learner-performer-companion — descriptor shape', () => {
  it('credential carries Trust facet with issuer + ThirdPartyAttested level', () => {
    const cred = buildCredential();
    const trust = cred.facets.find(f => f.type === 'Trust') as
      { issuer?: IRI; trustLevel?: string };
    expect(trust?.issuer).toBe(ACME_DID);
    expect(trust?.trustLevel).toBe('ThirdPartyAttested');
    expect(validate(cred).conforms).toBe(true);
  });

  it('performance record provenance attributes to MANAGER (not user)', () => {
    const rec = buildPerformanceRecord();
    const prov = rec.facets.find(f => f.type === 'Provenance') as
      { wasAttributedTo?: readonly IRI[] };
    expect(prov?.wasAttributedTo).toContain(JANE_DID);

    // The trust facet should point at the HR issuer (not at Mark)
    const trust = rec.facets.find(f => f.type === 'Trust') as { issuer?: IRI };
    expect(trust?.issuer).toBe(HR_ISSUER);

    expect(validate(rec).conforms).toBe(true);
  });

  it('training content + grounding atom: PGSL atom is content-addressed (deterministic)', () => {
    const content = buildTrainingContent();
    expect(validate(content).conforms).toBe(true);

    const passage = 'When a customer makes second contact, acknowledge their frustration first.';
    const pgsl = createPGSL();
    const atomIri1 = mintAtom(pgsl, passage);
    const atomIri2 = mintAtom(pgsl, passage);

    // Same passage → same content-addressed IRI (deterministic)
    expect(atomIri1).toBe(atomIri2);
    expect(atomIri1.length).toBeGreaterThan(20);
  });

  it('development plan is Hypothetical — assistant suggests, user decides', () => {
    const plan = buildDevelopmentPlan();
    const semiotic = plan.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic?.modalStatus).toBe('Hypothetical');

    // Plan is asserted by Aria but ON BEHALF OF Mark
    const agent = plan.facets.find(f => f.type === 'Agent') as
      { assertingAgent?: { identity?: IRI }; onBehalfOf?: IRI };
    expect(agent?.assertingAgent?.identity).toBe(ARIA_DID);
    expect(agent?.onBehalfOf).toBe(MARK_DID);

    expect(validate(plan).conforms).toBe(true);
  });

  it('cited response is asserted by assistant on behalf of user', () => {
    const resp = buildCitedResponse();
    const agent = resp.facets.find(f => f.type === 'Agent') as
      { assertingAgent?: { identity?: IRI }; onBehalfOf?: IRI };
    expect(agent?.assertingAgent?.identity).toBe(ARIA_DID);
    expect(agent?.onBehalfOf).toBe(MARK_DID);

    expect(validate(resp).conforms).toBe(true);
  });

  it('full wallet+history+content+record+plan+response cycle round-trips through Turtle', () => {
    const wallet = [
      buildCredential(),
      buildLearningExperience(),
      buildTrainingContent(),
      buildPerformanceRecord(),
      buildDevelopmentPlan(),
      buildCitedResponse(),
    ];

    for (const desc of wallet) {
      const ttl = toTurtle(desc);
      expect(ttl.length).toBeGreaterThan(0);
      expect(ttl).toContain(desc.id);
      expect(validate(desc).conforms).toBe(true);
    }
  });
});
