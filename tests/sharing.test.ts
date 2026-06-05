/**
 * Tests for src/solid/sharing.ts — cross-pod recipient resolution for
 * selective E2EE sharing. resolveRecipient decides whose X25519 keys
 * become envelope recipients, including the Sec #12 key-rollover
 * window — so a regression here either leaks to the wrong keys or
 * orphans in-flight envelopes. This module had no test coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  createOwnerProfile,
  ownerProfileToTurtle,
} from '@interego/core';
import {
  resolveHandleToPodUrl,
  resolveRecipient,
  resolveRecipients,
} from '@interego/solid';
import type {
  AuthorizedAgentData,
  FetchFn,
  IRI,
  OwnerProfileData,
} from '@interego/core';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function agent(overrides: Partial<AuthorizedAgentData>): AuthorizedAgentData {
  return {
    agentId: 'urn:agent:default' as IRI,
    delegatedBy: 'https://host/alice/profile#me' as IRI,
    scope: 'ReadWrite',
    validFrom: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Serves `${podUrl}agents` as Turtle for known pods, 404 otherwise. */
function mockFetch(registries: Record<string, OwnerProfileData>): FetchFn {
  return async (url) => {
    for (const [podUrl, profile] of Object.entries(registries)) {
      if (url === `${podUrl}agents`) {
        return {
          ok: true, status: 200, statusText: 'OK',
          text: async () => ownerProfileToTurtle(profile),
          json: async () => ({}),
        };
      }
    }
    return {
      ok: false, status: 404, statusText: 'Not Found',
      text: async () => '', json: async () => ({}),
    };
  };
}

describe('resolveHandleToPodUrl', () => {
  it('fast-paths a direct pod URL with no network call', async () => {
    const r = await resolveHandleToPodUrl('https://host/alice/');
    expect(r?.podUrl).toBe('https://host/alice/');
  });
  it('returns null for did:key (no pod linkage) and for garbage', async () => {
    expect(await resolveHandleToPodUrl('did:key:z6Mk...')).toBeNull();
    expect(await resolveHandleToPodUrl('not-a-handle')).toBeNull();
  });
});

describe('resolveRecipient', () => {
  const POD = 'https://host/alice/';

  it('returns encryption keys of non-revoked agents only', async () => {
    const profile = createOwnerProfile('https://host/alice/profile#me' as IRI, 'Alice', [
      agent({ agentId: 'urn:agent:active' as IRI, encryptionPublicKey: 'KEY_ACTIVE' }),
      agent({ agentId: 'urn:agent:revoked' as IRI, encryptionPublicKey: 'KEY_REVOKED', revoked: true }),
      agent({ agentId: 'urn:agent:nokey' as IRI }), // no encryptionPublicKey → excluded
    ]);
    const r = await resolveRecipient(POD, { fetch: mockFetch({ [POD]: profile }) });
    expect(r?.agentEncryptionKeys).toEqual(['KEY_ACTIVE']);
    expect(r?.agentIds).toContain('urn:agent:active');
  });

  it('includes recently-retired keys inside the rollover window, excludes stale ones', async () => {
    const profile = createOwnerProfile('https://host/alice/profile#me' as IRI, 'Alice', [
      agent({
        agentId: 'urn:agent:rotated' as IRI,
        encryptionPublicKey: 'KEY_CURRENT',
        encryptionKeyHistory: [
          { publicKey: 'KEY_RECENT', createdAt: daysAgo(40), retiredAt: daysAgo(5) },
          { publicKey: 'KEY_STALE', createdAt: daysAgo(400), retiredAt: daysAgo(60) },
        ],
      }),
    ]);
    const r = await resolveRecipient(POD, { fetch: mockFetch({ [POD]: profile }) });
    expect(r?.agentEncryptionKeys).toContain('KEY_CURRENT');
    expect(r?.agentEncryptionKeys).toContain('KEY_RECENT'); // retired 5 days ago — in window
    expect(r?.agentEncryptionKeys).not.toContain('KEY_STALE'); // retired 60 days ago — out
  });

  it('returns an empty-keys entry when the pod has no agent registry', async () => {
    const r = await resolveRecipient(POD, { fetch: mockFetch({}) }); // 404
    expect(r).not.toBeNull();
    expect(r?.podUrl).toBe(POD);
    expect(r?.agentEncryptionKeys).toEqual([]);
  });

  it('returns null when the handle cannot be resolved to a pod', async () => {
    const r = await resolveRecipient('did:key:z6Mk...', { fetch: mockFetch({}) });
    expect(r).toBeNull();
  });
});

describe('resolveRecipients', () => {
  it('resolves a batch, surfacing unresolvable handles as empty entries', async () => {
    const POD = 'https://host/alice/';
    const profile = createOwnerProfile('https://host/alice/profile#me' as IRI, 'Alice', [
      agent({ agentId: 'urn:agent:a' as IRI, encryptionPublicKey: 'KEY_A' }),
    ]);
    const results = await resolveRecipients([POD, 'did:key:bogus'], {
      fetch: mockFetch({ [POD]: profile }),
    });
    expect(results).toHaveLength(2);
    const good = results.find((r) => r.handle === POD);
    const bad = results.find((r) => r.handle === 'did:key:bogus');
    expect(good?.agentEncryptionKeys).toEqual(['KEY_A']);
    expect(bad?.podUrl).toBe('');
    expect(bad?.agentEncryptionKeys).toEqual([]);
  });
});

/**
 * Regression: `share-with-author`.
 *
 * When publish_context is called with a non-empty share_with list, the
 * recipient set MUST include the AUTHOR's session-agent key in addition
 * to the resolved share_with targets. share_with APPENDS, never REPLACES,
 * so the author can always deref-decrypt envelopes they just published.
 *
 * This unit-tests the recipient-set computation as a pure function over
 * (authorKey, shareWithResolution) — the same shape used by both
 * deploy/mcp-relay/server.ts and mcp-server/server.ts.
 */
describe('publish_context recipient-set computation (share-with-author fix)', () => {
  const ALICE_POD = 'https://host/alice/';
  const BOB_POD = 'https://host/bob/';
  const AUTHOR_KEY = 'KEY_AUTHOR_ALICE';

  /** Reproduces the relay's recipient-set algorithm as a pure function. */
  async function computeRecipients(
    authorKey: string,
    shareWith: string[],
    fetchFn: FetchFn,
  ): Promise<{ recipients: string[]; recipientAgents: string[]; selfIncluded: boolean }> {
    const recipients: string[] = [];
    const recipientAgents: string[] = ['urn:agent:author-alice'];
    // 1. Author key first — unconditional.
    if (!recipients.includes(authorKey)) recipients.push(authorKey);
    // 2. share_with APPENDS to the base set.
    if (shareWith.length > 0) {
      const resolved = await resolveRecipients(shareWith, { fetch: fetchFn });
      for (const r of resolved) {
        if (r.handle && !recipientAgents.includes(r.handle)) recipientAgents.push(r.handle);
        for (const key of r.agentEncryptionKeys) {
          if (!recipients.includes(key)) recipients.push(key);
        }
      }
    }
    // 3. Defensive invariant: author key still present after merge.
    const selfIncluded = recipients.includes(authorKey);
    if (!selfIncluded) recipients.push(authorKey);
    return { recipients, recipientAgents, selfIncluded };
  }

  it('includes the author when share_with is omitted (default)', async () => {
    const out = await computeRecipients(AUTHOR_KEY, [], mockFetch({}));
    expect(out.recipients).toEqual([AUTHOR_KEY]);
    expect(out.selfIncluded).toBe(true);
  });

  it('includes BOTH author and share_with targets when share_with is non-empty', async () => {
    const bobProfile = createOwnerProfile('https://host/bob/profile#me' as IRI, 'Bob', [
      agent({
        agentId: 'urn:agent:bob' as IRI,
        delegatedBy: 'https://host/bob/profile#me' as IRI,
        encryptionPublicKey: 'KEY_BOB',
      }),
    ]);
    const out = await computeRecipients(
      AUTHOR_KEY,
      [BOB_POD],
      mockFetch({ [BOB_POD]: bobProfile }),
    );
    expect(out.recipients).toContain(AUTHOR_KEY); // author can self-decrypt
    expect(out.recipients).toContain('KEY_BOB'); // share target can decrypt
    expect(out.recipients).toHaveLength(2);
    expect(out.selfIncluded).toBe(true);
    expect(out.recipientAgents).toContain('urn:agent:author-alice');
    expect(out.recipientAgents).toContain(BOB_POD);
  });

  it('does not duplicate the author key when share_with target shares a registry that includes it', async () => {
    // Edge case: a pod's registry happens to list a key identical to the
    // author's (e.g., same relay process minted both). Recipients must
    // remain deduped — selfIncluded still true.
    const sharedKeyProfile = createOwnerProfile('https://host/peer/profile#me' as IRI, 'Peer', [
      agent({
        agentId: 'urn:agent:peer' as IRI,
        delegatedBy: 'https://host/peer/profile#me' as IRI,
        encryptionPublicKey: AUTHOR_KEY, // collision
      }),
    ]);
    const PEER_POD = 'https://host/peer/';
    const out = await computeRecipients(
      AUTHOR_KEY,
      [PEER_POD],
      mockFetch({ [PEER_POD]: sharedKeyProfile }),
    );
    expect(out.recipients).toEqual([AUTHOR_KEY]); // deduped to one
    expect(out.selfIncluded).toBe(true);
  });

  it('appends multiple share_with targets without dropping the author', async () => {
    const bobProfile = createOwnerProfile('https://host/bob/profile#me' as IRI, 'Bob', [
      agent({
        agentId: 'urn:agent:bob' as IRI,
        delegatedBy: 'https://host/bob/profile#me' as IRI,
        encryptionPublicKey: 'KEY_BOB',
      }),
    ]);
    const carolProfile = createOwnerProfile('https://host/carol/profile#me' as IRI, 'Carol', [
      agent({
        agentId: 'urn:agent:carol' as IRI,
        delegatedBy: 'https://host/carol/profile#me' as IRI,
        encryptionPublicKey: 'KEY_CAROL',
      }),
    ]);
    const CAROL_POD = 'https://host/carol/';
    const out = await computeRecipients(
      AUTHOR_KEY,
      [BOB_POD, CAROL_POD],
      mockFetch({ [BOB_POD]: bobProfile, [CAROL_POD]: carolProfile }),
    );
    expect(out.recipients).toEqual([AUTHOR_KEY, 'KEY_BOB', 'KEY_CAROL']);
    expect(out.selfIncluded).toBe(true);
    expect(out.recipientAgents).toEqual(['urn:agent:author-alice', BOB_POD, CAROL_POD]);
  });
});
