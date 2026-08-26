/**
 * ★★ THE KERNEL TRUST GATE KEYED ON A STRING THE PUBLISHER TYPED.
 *
 * `evaluateTrust` returned `verified: trust.trustLevel === 'CryptographicallyVerified'` with
 * a 1.0 / 0.85 / 0.7 confidence ladder derived from that same string, and
 * `evaluateTrustPolicy` ranked that same string against `policy.minTrustLevel` by index.
 * Both read `iep:trustLevel` off whatever body a fetch returned. So a publisher who wrote
 * `iep:trustLevel "CryptographicallyVerified"` into their OWN descriptor got
 * `verified: true, confidence: 1.0` and satisfied a policy demanding the strongest rung.
 *
 * These tests hold the fix to three things at once, because a fix that misses any one of them
 * is not a fix:
 *   1. the forged claim no longer verifies and no longer satisfies the policy;
 *   2. an honestly self-asserted descriptor scores EXACTLY what it always scored — a great
 *      deal of published content is `SelfAsserted` by design and that is a supported state;
 *   3. the relay's own computed `CryptographicallyVerified` still reaches the strongest rung.
 *
 * Written against the same defect CLASS this codebase keeps rediscovering — a check that keys
 * on something the adversary writes — so the assertions are about where the verdict CAME
 * FROM, not only about its value.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAffordances,
  ContextDescriptor,
  evaluateSurprise,
  evaluateTrust,
  createAgentState,
  trustEvidenceFromAuthorship,
} from '@interego/core';
import type { AgentProfile, IRI, TrustEvidence, TrustLevel } from '@interego/core';

// A policy that demands the strongest rung for 'forward' — the shape a caller writes when it
// means "only act on this if a signature stands behind it".
const strictProfile: AgentProfile = {
  agentId: 'urn:agent:test:strict' as IRI,
  delegationScope: 'ReadWrite',
  capabilities: ['discover', 'publish', 'compose', 'causal', 'pgsl', 'project', 'subscribe', 'verify', 'challenge', 'retract'],
  vocabularies: [],
  trustPolicies: [
    { minTrustLevel: 'CryptographicallyVerified', minConfidence: 0, requiredForAction: ['forward'] },
    { minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['cite'] },
  ],
  causalModels: [],
};

/** A descriptor on a pod the adversary controls, whose Trust facet says the strongest rung. */
function forgedDescriptor() {
  return ContextDescriptor.create('urn:iep:test:forged' as IRI)
    .describes('urn:graph:test:forged' as IRI)
    .asserted(0.95)
    .trust({ trustLevel: 'CryptographicallyVerified', issuer: 'did:web:mallory.example' as IRI })
    .build();
}

/** The same descriptor, published honestly: it says what it actually is. */
function honestSelfAsserted() {
  return ContextDescriptor.create('urn:iep:test:honest' as IRI)
    .describes('urn:graph:test:honest' as IRI)
    .asserted(0.95)
    .selfAsserted('did:web:alice.example' as IRI)
    .build();
}

/**
 * A descriptor whose Trust facet carries a word that is not a rung.
 *
 * The cast is the defect, not a shortcut around it: `TrustLevel` is a closed union and
 * NOTHING at the RDF boundary converts — `rdf/jsonld.ts` casts `iep:trustLevel` straight out
 * of whatever body a fetch returned — so a pod really can serve `iep:trustLevel "Wizard"` and
 * have it arrive in a Trust facet typed as a rung. This reproduces that arrival exactly.
 */
function offLadderDescriptor() {
  return ContextDescriptor.create('urn:iep:test:offladder' as IRI)
    .describes('urn:graph:test:offladder' as IRI)
    .asserted(0.95)
    .trust({ trustLevel: 'Wizard' as unknown as TrustLevel, issuer: 'did:web:mallory.example' as IRI })
    .build();
}

/** A descriptor that makes no trust claim at all — no Trust facet. */
function noTrustFacet() {
  return ContextDescriptor.create('urn:iep:test:bare' as IRI)
    .describes('urn:graph:test:bare' as IRI)
    .asserted(0.9)
    .build();
}

/** A policy that asks only for the weakest rung — the floor any honest record clears. */
const weakestProfile: AgentProfile = {
  ...strictProfile,
  trustPolicies: [{ minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['read', 'cite'] }],
};

function forwardIsAvailable(profile: AgentProfile, desc: ReturnType<typeof forgedDescriptor>, evidence?: TrustEvidence): boolean {
  const set = computeAffordances(profile, desc, evidence);
  return set.affordances.find(a => a.action === 'forward')?.available === true;
}

describe('kernel trust gate: a verdict is a function of evidence, not of the body', () => {
  it('a self-declared CryptographicallyVerified does not verify and does not satisfy the policy', () => {
    const desc = forgedDescriptor();
    const verdict = evaluateTrust(desc);

    // The forgery, stated as an assertion: the claim is still visible, and it is not the verdict.
    expect(verdict.claimedTrustLevel).toBe('CryptographicallyVerified');
    expect(verdict.trustLevel).toBe('SelfAsserted');
    expect(verdict.verified).toBe(false);
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.basis).toBe('unwarranted');

    expect(forwardIsAvailable(strictProfile, desc)).toBe(false);
  });

  it('the refusal names the demotion rather than leaving it to be rediscovered', () => {
    const set = computeAffordances(strictProfile, forgedDescriptor());
    const blocked = set.antiAffordances.find(a => a.action === 'forward');
    expect(blocked?.blockedBy).toBe('trust');
    // A reader told only "'SelfAsserted' below required 'CryptographicallyVerified'" about a
    // descriptor whose body says the opposite would go hunting for a bug in the evaluator.
    expect(blocked?.reason).toContain("claims 'CryptographicallyVerified'");
    expect(blocked?.reason).toContain('checked nothing');
  });

  it('★ DOES NOT BREAK THE HONEST PATH: SelfAsserted scores exactly what it always scored', () => {
    const verdict = evaluateTrust(honestSelfAsserted());
    expect(verdict.trustLevel).toBe('SelfAsserted');
    expect(verdict.claimedTrustLevel).toBe('SelfAsserted');
    expect(verdict.verified).toBe(false);
    expect(verdict.confidence).toBe(0.7);
    // And it is still usable: a policy that asks for SelfAsserted is still satisfied.
    const set = computeAffordances(strictProfile, honestSelfAsserted());
    expect(set.affordances.find(a => a.action === 'cite')?.available).toBe(true);
  });

  it('★ DOES NOT BREAK THE HONEST PATH: the relay-computed verdict reaches the strongest rung', () => {
    // Exactly the block `get_descriptor` returns when the authorship proof verified, it names
    // the record it was served with, and the delegation chain walked clean.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: true,
      signedBy: 'did:ethr:0x8f3b8e9396007b3d2b9d9d1cd2fb0e4b7c1679Fd',
      effectiveTrustLevel: 'CryptographicallyVerified',
      contentBinding: 'bound',
    });
    const desc = honestSelfAsserted();
    const verdict = evaluateTrust(desc, evidence);

    // ★ AND THE EVIDENCE ONLY EVER HOLDS A CLAIM DOWN. The body says `SelfAsserted`, the
    // reader established more, and the verdict stays at the body's own modesty — a reader
    // does not get to overrule a publisher who claimed less than it could prove.
    expect(verdict.trustLevel).toBe('SelfAsserted');
    expect(verdict.basis).toBe('evidence-checked');

    // The full honest path: the descriptor claims what the relay computed for it.
    const claimed = ContextDescriptor.create('urn:iep:test:relay' as IRI)
      .describes('urn:graph:test:relay' as IRI)
      .asserted(0.95)
      .trust({ trustLevel: 'CryptographicallyVerified', issuer: 'did:web:alice.example' as IRI })
      .build();
    const relayVerdict = evaluateTrust(claimed, evidence);
    expect(relayVerdict.trustLevel).toBe('CryptographicallyVerified');
    expect(relayVerdict.verified).toBe(true);
    expect(relayVerdict.confidence).toBe(1.0);
    expect(forwardIsAvailable(strictProfile, claimed, evidence)).toBe(true);
  });

  it('a refuted proof is not the same as no proof, and warrants no rung at all', () => {
    // `contentBinding: 'mismatched'` is a comparison that ran: the digest was recomputed over
    // the bytes served and differed from the digest the signer committed to. That is
    // affirmative evidence against, so it must not land on the same rung as an ordinary
    // unchecked descriptor. It is one of only two shapes that refute — see the tests below for
    // the two `authorshipVerified: false` shapes that must NOT.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      signedBy: 'did:ethr:0xdeadbeef',
      contentBinding: 'mismatched',
      reason: 'Authorship proof covers content sha256:aaa but the observed content is sha256:bbb',
    });
    const verdict = evaluateTrust(honestSelfAsserted(), evidence);
    expect(verdict.basis).toBe('evidence-refuted');
    expect(verdict.trustLevel).toBeUndefined();
    expect(verdict.confidence).toBe(0);
    // Even the weakest policy refuses it — and a descriptor with no proof never reaches here,
    // because a reader with nothing to check supplies no evidence at all.
    const set = computeAffordances(strictProfile, honestSelfAsserted(), evidence);
    expect(set.affordances.find(a => a.action === 'cite')?.available).toBe(false);
  });

  it('a missing authorship block is "nothing was checked", never a refutation', () => {
    // `get_descriptor` omits the authorship object entirely for a descriptor carrying no
    // proof — fail-ABSENT. Reading that as evidence against would make every honestly
    // unsigned record unusable, which is the failure mode a fix like this most easily causes.
    expect(trustEvidenceFromAuthorship(undefined)).toBeUndefined();
    expect(trustEvidenceFromAuthorship(null)).toBeUndefined();
  });

  it('no Trust facet stays distinct from a positive SelfAsserted assertion', () => {
    const bare = ContextDescriptor.create('urn:iep:test:bare' as IRI)
      .describes('urn:graph:test:bare' as IRI)
      .asserted(0.9)
      .build();
    const verdict = evaluateTrust(bare);
    expect(verdict.basis).toBe('no-claim');
    expect(verdict.trustLevel).toBeUndefined();
    expect(verdict.confidence).toBe(0);

    // A policy may opt in to accepting the absence; nothing about this change alters that.
    const lenient: AgentProfile = {
      ...strictProfile,
      trustPolicies: [{ minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['cite'], allowMissingTrustFacet: true }],
    };
    expect(computeAffordances(lenient, bare).affordances.find(a => a.action === 'cite')?.available).toBe(true);
  });

  // ── C1: "we could not check" is not evidence against ────────────────────────────────────

  it('★ a verifier that THREW is not evidence against the publisher', () => {
    // deploy/mcp-relay/server.ts, get_descriptor: when the verifier throws, the relay emits
    // `authorshipVerified: false` with `reason: 'verifier threw: …'` and the binding it can
    // still state — its own comment says "A verifier that threw compared nothing". Mapping
    // every `false` to a refutation turned that bad moment into affirmative evidence AGAINST
    // an honest publisher: no rung warranted, confidence 0, and a policy refusing even `read`
    // on a record whose only sin was being fetched while the relay was unwell — while the
    // SAME record with no authorship block at all stayed readable.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      signedBy: 'did:ethr:0x8f3b8e9396007b3d2b9d9d1cd2fb0e4b7c1679Fd',
      reason: 'verifier threw: ECONNRESET reading the agent registry',
      contentBinding: 'declared',
    });
    expect(evidence).toBeUndefined();

    const verdict = evaluateTrust(honestSelfAsserted(), evidence);
    expect(verdict.basis).toBe('unwarranted');
    expect(verdict.trustLevel).toBe('SelfAsserted');
    expect(verdict.confidence).toBe(0.7);
    // The whole point, stated as the thing an operator would notice: it is still readable.
    const set = computeAffordances(weakestProfile, honestSelfAsserted(), evidence);
    expect(set.affordances.find(a => a.action === 'read')?.available).toBe(true);
    expect(set.affordances.find(a => a.action === 'cite')?.available).toBe(true);
  });

  it('★ a proof whose signature is intact but does not name this record withholds, never accuses', () => {
    // The relay's own `authorshipVerdict` produces this one and says outright that two
    // readings fit — a proof lifted off another record, or a publisher that names its
    // descriptors some other way — so it "withholds the attestation rather than naming a
    // forger". Reading it as an accusation here would contradict the layer that produced it.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      signedBy: 'did:ethr:0x8f3b8e9396007b3d2b9d9d1cd2fb0e4b7c1679Fd',
      reason: "the authorship proof's signature is intact, but the proof is not about this record: "
        + 'it does not name the URL this document was served from.',
      contentBinding: 'bound',
    });
    expect(evidence).toBeUndefined();
    // Withheld, not refuted: capped at SelfAsserted like anything unchecked, and no rung above.
    const verdict = evaluateTrust(honestSelfAsserted(), evidence);
    expect(verdict.basis).toBe('unwarranted');
    expect(verdict.trustLevel).toBe('SelfAsserted');
  });

  it('★ a signature that did not verify IS a verdict, and still refutes', () => {
    // The fail-safe reading must not go so far that a real refutation stops refuting: this
    // reason is `verifySignedAuthorship`'s own, emitted when the recovered signer does not
    // match the proof — a check that ran and came back no.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      signedBy: 'did:ethr:0xdeadbeef',
      reason: 'Authorship proof signature did not verify against canonical payload',
      contentBinding: 'unbound',
    });
    expect(evidence?.ceiling).toBe('refuted');
    expect(evaluateTrust(honestSelfAsserted(), evidence).basis).toBe('evidence-refuted');
  });

  it('★ a refuting sentence INSIDE a thrown message does not forge a refutation', () => {
    // The could-not-run reason embeds the thrown Error's message verbatim, and an error
    // message can carry text a remote pod chose. So the reason test is a PREFIX test: an
    // `includes` would let a publisher who can provoke an exception carrying these words
    // refute somebody else's record. The relay's own opening words always come first.
    const evidence = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      reason: 'verifier threw: Authorship proof signature did not verify against canonical payload',
      contentBinding: 'declared',
    });
    expect(evidence).toBeUndefined();
  });

  it('an unexplained authorshipVerified:false is not a refutation either', () => {
    // Absence is the safe side: a block with no reason and no `mismatched` binding says only
    // that the relay did not attest. Nothing was established, so nothing is reported.
    expect(trustEvidenceFromAuthorship({ authorshipVerified: false })).toBeUndefined();
    expect(trustEvidenceFromAuthorship({ authorshipVerified: false, contentBinding: 'unbound' }))
      .toBeUndefined();
  });

  // ── C2: omitting the Trust facet must not discard what the reader found ──────────────────

  it('★ omitting the Trust facet does not silence the reader\'s refutation', () => {
    // The no-claim branch used to return BEFORE evidence was consulted, so a publisher could
    // discard a reader's own negative finding simply by leaving the Trust facet out — and a
    // policy with `allowMissingTrustFacet` then granted `cite` on a record whose proof this
    // reader had refuted, where the identical evidence against a descriptor that DID carry a
    // Trust facet refused. Whether the reader's finding counted was the publisher's choice.
    const refuted = trustEvidenceFromAuthorship({
      authorshipVerified: false,
      contentBinding: 'mismatched',
      reason: 'Authorship proof covers content sha256:aaa but the observed content is sha256:bbb',
    });
    const verdict = evaluateTrust(noTrustFacet(), refuted);
    expect(verdict.basis).toBe('evidence-refuted');
    expect(verdict.evidence?.ceiling).toBe('refuted');

    const lenient: AgentProfile = {
      ...strictProfile,
      trustPolicies: [{ minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['cite'], allowMissingTrustFacet: true }],
    };
    const set = computeAffordances(lenient, noTrustFacet(), refuted);
    expect(set.affordances.find(a => a.action === 'cite')?.available).toBe(false);
    // And the refusal says why, rather than leaving "trust level 'unset'" to be rediscovered.
    expect(set.antiAffordances.find(a => a.action === 'cite')?.reason).toContain('refuted');
  });

  it('★ DOES NOT BREAK THE HONEST PATH: evidence on a no-claim descriptor still lets a lenient policy through', () => {
    // The other half of the same branch, and the direction a fix like this most easily breaks:
    // supplying GOOD evidence must not make a descriptor harder to use than supplying none.
    const good = trustEvidenceFromAuthorship({
      authorshipVerified: true,
      signedBy: 'did:ethr:0x8f3b8e9396007b3d2b9d9d1cd2fb0e4b7c1679Fd',
      effectiveTrustLevel: 'CryptographicallyVerified',
      contentBinding: 'bound',
    });
    const verdict = evaluateTrust(noTrustFacet(), good);
    // Evidence is a CEILING: it caps a claim and never stands in for one, so a descriptor that
    // claims nothing still warrants nothing — the reader does not assert a level on the
    // publisher's behalf. But the finding is now VISIBLE instead of discarded.
    expect(verdict.basis).toBe('no-claim');
    expect(verdict.trustLevel).toBeUndefined();
    expect(verdict.verified).toBe(false);
    expect(verdict.evidence?.ceiling).toBe('CryptographicallyVerified');

    const lenient: AgentProfile = {
      ...strictProfile,
      trustPolicies: [{ minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['cite'], allowMissingTrustFacet: true }],
    };
    expect(computeAffordances(lenient, noTrustFacet(), good).affordances.find(a => a.action === 'cite')?.available).toBe(true);
  });

  // ── C3: a word that is not a rung must refuse, not outrank ───────────────────────────────

  it('★ an off-ladder trustLevel warrants no rung and outranks nothing', () => {
    // `rankOf` answers -1 for a word that is not a rung, and the warrant used to be
    // `rankOf(claim) <= rankOf(ceiling) ? claim : ceiling` — so `-1 <= 0` KEPT the claim and
    // `iep:trustLevel "Wizard"` came out of the verdict as the warranted level, above a
    // checked `SelfAsserted`.
    const verdict = evaluateTrust(offLadderDescriptor());
    expect(verdict.claimedTrustLevel).toBe('Wizard');  // still reported, verbatim
    expect(verdict.trustLevel).toBeUndefined();        // and warranting nothing
    expect(verdict.confidence).toBe(0);
    expect(verdict.warrantNote).toContain('not a rung');

    // Even with the strongest evidence a reader can produce, the claim is not a rung, so
    // there is nothing for the evidence to cap: it does not become CryptographicallyVerified.
    const good = trustEvidenceFromAuthorship({
      authorshipVerified: true,
      effectiveTrustLevel: 'CryptographicallyVerified',
      contentBinding: 'bound',
    });
    expect(evaluateTrust(offLadderDescriptor(), good).trustLevel).toBeUndefined();

    // It refuses even the weakest policy — and unlike a missing facet, `allowMissingTrustFacet`
    // does not excuse it, because the facet is there and it asserted something.
    const set = computeAffordances(weakestProfile, offLadderDescriptor());
    expect(set.affordances.find(a => a.action === 'cite')?.available).toBe(false);
    expect(set.antiAffordances.find(a => a.action === 'cite')?.reason).toContain('not a rung');
    const lenient: AgentProfile = {
      ...strictProfile,
      trustPolicies: [{ minTrustLevel: 'SelfAsserted', minConfidence: 0, requiredForAction: ['cite'], allowMissingTrustFacet: true }],
    };
    expect(computeAffordances(lenient, offLadderDescriptor()).affordances.find(a => a.action === 'cite')?.available).toBe(false);
  });

  it('★ an off-ladder trustLevel does not turn the suspicion heuristic off', () => {
    // The second site of the same switch. `evaluateSurprise` compares the warranted rung
    // against `'SelfAsserted'`, so a claim that survived as `'Wizard'` failed every such
    // comparison open: driven on the shipped code, the off-ladder body scored surprise 0 and
    // was ASSIMILATED where the honest one scored 0.4 and was ignored. One word, chosen by the
    // publisher, decided whether their record entered the belief store.
    const state = createAgentState(strictProfile);
    const honest = evaluateSurprise(state, honestSelfAsserted(), strictProfile);
    const offLadder = evaluateSurprise(state, offLadderDescriptor(), strictProfile);
    expect(offLadder.surprise).toBe(honest.surprise);
    expect(offLadder.surprise).toBeGreaterThan(0);
    expect(offLadder.recommendedResponse).toBe(honest.recommendedResponse);
  });

  it('the surprise heuristic no longer hands the publisher its own off switch', () => {
    // `evaluateSurprise` scores "low trust asserted with high confidence" as suspicious. It
    // read the descriptor's own `trustLevel`, so typing `CryptographicallyVerified` turned
    // the check OFF and typing the honest `SelfAsserted` left it on — the suspicion switch,
    // in the hands of the party being suspected.
    const state = createAgentState(strictProfile);
    const honest = evaluateSurprise(state, honestSelfAsserted(), strictProfile);
    const forged = evaluateSurprise(state, forgedDescriptor(), strictProfile);
    expect(forged.surprise).toBe(honest.surprise);
    expect(forged.surprise).toBeGreaterThan(0);
  });
});
