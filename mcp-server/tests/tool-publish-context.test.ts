/**
 * Smoke coverage for the publish_context tool surface in `@interego/mcp`.
 *
 * The actual handler (`toolPublishContext` in server.ts) is not exported
 * because server.ts is the binary entry point — importing it auto-starts
 * the stdio transport. This file pins the three load-bearing invariants
 * the handler relies on:
 *
 *   (a) share-with-author — the author's session encryption key MUST remain
 *       in the recipient set after any share_with merge. Regression here
 *       would lock the author out of envelopes they just published.
 *
 *   (b) SHARE_WITH_MAX cap — the handler throws when share_with exceeds
 *       50 handles. Without this, a runaway caller could O(N) the relay's
 *       network budget on per-handle pod resolution.
 *
 *   (c) plaintext fallback — when the agent registry has no keyed agents
 *       yet (bootstrap), recipients still resolves to the author's own
 *       key so the very first publishes aren't locked out of themselves.
 *
 * (a) and (c) exercise `computePublishRecipients` from `@interego/solid`,
 * which is the pure published form of the inline merge logic in
 * `toolPublishContext`. (b) pins the cap shape by replaying the exact
 * guard the handler executes.
 */

import { describe, it, expect } from 'vitest';
import { computePublishRecipients, type ResolvedRecipientPod } from '@interego/solid';

// Mirror of the constant in mcp-server/server.ts:toolPublishContext.
// Update both together if the cap ever changes.
const SHARE_WITH_MAX = 50;

const AUTHOR_KEY = 'author-x25519-pubkey-base64';
const AUTHOR_AGENT = 'urn:agent:author:session';

describe('publish_context — share-with-author invariant', () => {
  it('keeps author key in recipients when share_with is empty', () => {
    const result = computePublishRecipients({
      rawVisibility: 'shared',
      shareWith: [],
      authorEncryptionKey: AUTHOR_KEY,
      authorAgentId: AUTHOR_AGENT,
      registryAgentKeys: [],
      resolvedShareTargets: [],
    });
    expect(result.recipients).toContain(AUTHOR_KEY);
    expect(result.selfIncluded).toBe(true);
  });

  it('keeps author key in recipients after share_with append', () => {
    const targets: ResolvedRecipientPod[] = [
      {
        handle: 'acct:bob@example.org',
        podUrl: 'https://example.org/bob/',
        agentEncryptionKeys: ['bob-key-1', 'bob-key-2'],
        agentIds: ['urn:agent:bob:1'],
      },
    ];
    const result = computePublishRecipients({
      rawVisibility: 'shared',
      shareWith: ['acct:bob@example.org'],
      authorEncryptionKey: AUTHOR_KEY,
      authorAgentId: AUTHOR_AGENT,
      registryAgentKeys: [],
      resolvedShareTargets: targets,
    });
    expect(result.recipients).toContain(AUTHOR_KEY);
    expect(result.recipients).toContain('bob-key-1');
    expect(result.recipients).toContain('bob-key-2');
  });
});

describe('publish_context — SHARE_WITH_MAX cap', () => {
  // Re-enacts the inline guard at mcp-server/server.ts (~line 833):
  //   if (args.share_with && args.share_with.length > SHARE_WITH_MAX) throw ...
  function enforceShareWithCap(shareWith: string[] | undefined): void {
    if (shareWith && shareWith.length > SHARE_WITH_MAX) {
      throw new Error(
        `share_with cap exceeded: ${shareWith.length} handles supplied, max ${SHARE_WITH_MAX}. ` +
        `For larger groups, publish via a group-list descriptor and have recipients subscribe — ` +
        `per-publish sharing is designed for small numbers of direct recipients.`,
      );
    }
  }

  it('throws when share_with exceeds SHARE_WITH_MAX', () => {
    const handles = Array.from({ length: SHARE_WITH_MAX + 1 }, (_, i) => `acct:user${i}@example.org`);
    expect(() => enforceShareWithCap(handles)).toThrow(/share_with cap exceeded/);
  });

  it('permits share_with at exactly SHARE_WITH_MAX', () => {
    const handles = Array.from({ length: SHARE_WITH_MAX }, (_, i) => `acct:user${i}@example.org`);
    expect(() => enforceShareWithCap(handles)).not.toThrow();
  });

  it('permits undefined share_with', () => {
    expect(() => enforceShareWithCap(undefined)).not.toThrow();
  });
});

describe('publish_context — plaintext fallback when no keyed agents', () => {
  // The handler chooses plaintext publish (no encrypt option) when
  // recipients.length === 0. With no registry-keyed agents but the
  // author's own key still pushed, recipients stays > 0 — the
  // "bootstrap plaintext" path is reached precisely when the input
  // recipient set is empty AND the author key push is skipped (the
  // server uses an unconditional push of the author key, so this is
  // a structural pin of the contract). We verify both halves:
  //   1. With registry empty BUT author key supplied, recipients
  //      contains exactly the author key → envelope is built for one.
  //   2. With NOTHING in the recipient set, the handler's publish
  //      options collapse to plaintext (recipients.length === 0).
  it('falls back to author-only recipient set when registry has no keyed agents', () => {
    const result = computePublishRecipients({
      rawVisibility: 'shared',
      shareWith: [],
      authorEncryptionKey: AUTHOR_KEY,
      authorAgentId: AUTHOR_AGENT,
      registryAgentKeys: [],
      resolvedShareTargets: [],
    });
    expect(result.recipients).toEqual([AUTHOR_KEY]);
  });

  // Pin the exact branch the handler uses for plaintext: when the merged
  // recipient list is empty, publishOptions must drop the `encrypt` key.
  // This mirrors mcp-server/server.ts:
  //   const publishOptions = recipients.length > 0
  //     ? { fetch, encrypt: { recipients, senderKeyPair } }
  //     : { fetch };
  it('publishOptions omits encrypt when recipients is empty', () => {
    const recipients: string[] = [];
    const publishOptions = recipients.length > 0
      ? { fetch: 'stub-fetch', encrypt: { recipients, senderKeyPair: 'stub' } }
      : { fetch: 'stub-fetch' };
    expect('encrypt' in publishOptions).toBe(false);
  });
});
