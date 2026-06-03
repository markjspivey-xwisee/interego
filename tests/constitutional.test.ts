/**
 * Constitutional layer tests — propose / vote / ratify / fork.
 */

import { describe, it, expect } from 'vitest';
import type { IRI } from '@interego/core';
import {
  proposeAmendment,
  vote,
  tryRatify,
  communityModal,
  forkConstitution,
  DEFAULT_RULES,
} from '@interego/core';

const ALICE = 'urn:agent:alice' as IRI;

function votersFromArray(amendment: ReturnType<typeof proposeAmendment>, votes: { voter: string; modal: 'Asserted' | 'Counterfactual' | 'Hypothetical' }[]) {
  for (const v of votes) {
    vote(amendment, v.voter as IRI, v.modal);
  }
  return amendment;
}

describe('amendments — proposal + voting', () => {
  it('proposes an amendment with status Proposed', () => {
    const a = proposeAmendment({
      id: 'urn:amend:1' as IRI,
      proposedBy: ALICE,
      amends: 'urn:policy:p1' as IRI,
      tier: 3,
      diff: { summary: 'tweak quorum' },
    });
    expect(a.status).toBe('Proposed');
    expect(a.votes).toHaveLength(0);
  });

  it('votes accumulate; voter can change their vote (last wins)', () => {
    const a = proposeAmendment({
      id: 'urn:amend:1' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
    });
    vote(a, 'urn:agent:b' as IRI, 'Asserted');
    vote(a, 'urn:agent:c' as IRI, 'Counterfactual');
    vote(a, 'urn:agent:b' as IRI, 'Counterfactual'); // change of heart
    expect(a.votes).toHaveLength(2);
    expect(a.votes.find(v => v.voter === 'urn:agent:b')?.modalStatus).toBe('Counterfactual');
  });
});

describe('ratification', () => {
  it('Tier 3 majority threshold passes with simple majority', () => {
    const a = proposeAmendment({
      id: 'urn:a:1' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
      proposedAt: '2026-04-20T00:00:00Z',
    });
    votersFromArray(a, [
      { voter: 'urn:agent:b', modal: 'Asserted' },
      { voter: 'urn:agent:c', modal: 'Asserted' },
      { voter: 'urn:agent:d', modal: 'Counterfactual' },
    ]);
    tryRatify(a, undefined, '2026-04-25T00:00:00Z');
    expect(a.status).toBe('Ratified');
    expect(a.ratifiedAt).toBeDefined();
  });

  it('Tier 1 supermajority blocks bare-majority passage', () => {
    const a = proposeAmendment({
      id: 'urn:a:2' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 1,
      diff: { summary: 'x' },
      proposedAt: '2026-04-01T00:00:00Z',
    });
    // 11 for, 9 against = 55% — fails Tier 1's 67% threshold
    for (let i = 0; i < 11; i++) vote(a, `urn:agent:f-${i}` as IRI, 'Asserted');
    for (let i = 0; i < 9; i++) vote(a, `urn:agent:a-${i}` as IRI, 'Counterfactual');
    tryRatify(a, undefined, '2026-04-22T00:00:00Z'); // past cooling
    expect(a.status).toBe('Rejected');
  });

  it('cooling period delays ratification', () => {
    const a = proposeAmendment({
      id: 'urn:a:3' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
      proposedAt: '2026-04-24T00:00:00Z',
    });
    // Tier 3 has 0 cooling, so this case uses Tier 2 (7 days):
    votersFromArray(a, [
      { voter: 'urn:b', modal: 'Asserted' },
      { voter: 'urn:c', modal: 'Asserted' },
      { voter: 'urn:d', modal: 'Asserted' },
      { voter: 'urn:e', modal: 'Asserted' },
      { voter: 'urn:f', modal: 'Asserted' },
      { voter: 'urn:g', modal: 'Asserted' },
      { voter: 'urn:h', modal: 'Asserted' },
      { voter: 'urn:i', modal: 'Asserted' },
      { voter: 'urn:j', modal: 'Asserted' },
      { voter: 'urn:k', modal: 'Asserted' },
    ]);
    a.tier = 2;
    tryRatify(a, undefined, '2026-04-25T00:00:00Z'); // 1 day after, < 7-day cool
    expect(a.status).toBe('PendingCooling');
    tryRatify(a, undefined, '2026-05-05T00:00:00Z'); // past cooling
    expect(a.status).toBe('Ratified');
  });

  it('PendingQuorum if not enough non-abstain votes', () => {
    const a = proposeAmendment({
      id: 'urn:a:4' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
    });
    vote(a, 'urn:b' as IRI, 'Asserted');
    vote(a, 'urn:c' as IRI, 'Hypothetical'); // abstains don't count toward quorum
    tryRatify(a);
    expect(a.status).toBe('PendingQuorum');
  });

  it('weighted votes: high-trust voter swings outcome', () => {
    const a = proposeAmendment({
      id: 'urn:a:5' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
      proposedAt: '2026-04-20T00:00:00Z',
    });
    vote(a, 'urn:b' as IRI, 'Counterfactual', 1);
    vote(a, 'urn:c' as IRI, 'Counterfactual', 1);
    vote(a, 'urn:d' as IRI, 'Asserted', 5); // weighted heavily
    tryRatify(a, undefined, '2026-04-25T00:00:00Z');
    // 5 / (5+1+1) = ~71% — passes Tier 3's 51% threshold
    expect(a.status).toBe('Ratified');
  });
});

describe('communityModal', () => {
  it('aggregates votes via meet (most-conservative)', () => {
    const a = proposeAmendment({
      id: 'urn:a:6' as IRI, proposedBy: ALICE,
      amends: 'urn:p:1' as IRI, tier: 3,
      diff: { summary: 'x' },
    });
    votersFromArray(a, [
      { voter: 'urn:b', modal: 'Asserted' },
      { voter: 'urn:c', modal: 'Counterfactual' },
    ]);
    expect(communityModal(a)).toBe('Counterfactual'); // meet of A and C
  });
});

describe('fork', () => {
  it('records a fork with parent + dissenters + new constitution', () => {
    const fork = forkConstitution({
      id: 'urn:fork:1' as IRI,
      parentConstitution: 'urn:const:original' as IRI,
      dissenters: ['urn:a' as IRI, 'urn:b' as IRI],
      newConstitution: {
        id: 'urn:const:new' as IRI,
        tier: 1,
        description: 'minority faction',
        ratifyRule: DEFAULT_RULES[1],
      },
      reason: 'irreconcilable amendment failed',
    });
    expect(fork.parentConstitution).toBe('urn:const:original');
    expect(fork.dissenters).toHaveLength(2);
    expect(fork.newConstitution.id).toBe('urn:const:new');
  });
});
