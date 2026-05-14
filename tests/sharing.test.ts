/**
 * Tests for src/solid/sharing.ts — cross-pod recipient resolution for
 * selective E2EE sharing. resolveRecipient decides whose X25519 keys
 * become envelope recipients, including the Sec #12 key-rollover
 * window — so a regression here either leaks to the wrong keys or
 * orphans in-flight envelopes. This module had no test coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveHandleToPodUrl,
  resolveRecipient,
  resolveRecipients,
  createOwnerProfile,
  ownerProfileToTurtle,
} from '../src/index.js';
import type { IRI, AuthorizedAgentData, OwnerProfileData, FetchFn } from '../src/index.js';

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
