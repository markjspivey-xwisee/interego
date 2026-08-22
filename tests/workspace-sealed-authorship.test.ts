/**
 * A DELEGATE'S ENTRY IN A PRIVATE WORKSPACE READ AS "AUTHORSHIP DISPUTED".
 *
 * ── ★★ WHY, AND WHY IT WAS NOBODY'S BUG ─────────────────────────────────────
 *
 * The relay verifies an authorship proof in two independent parts: the SIGNATURE, and whether
 * that signature covers the payload served beside it. The second needs the payload — and for a
 * sealed graph the relay is not a recipient. Its own module says exactly this: "a private payload
 * the relay is not a recipient of decrypts to null". It reports that, correctly, as
 * `contentBinding: 'declared'` — an honest "I did not check".
 *
 * `verifiedSigner()` keys on `contentBinding`, deliberately and for a measured reason. So every
 * descriptor in a PRIVATE workspace arrived with `signedBy: null`, and `judgeAuthorship` reads a
 * null signer on a record attributed to an AGENT as `disputed`.
 *
 * The reason it gave was not true: "no authorship block reached this reader". One did. It was
 * complete, its signature verified, and the single thing missing was a comparison the relay was
 * structurally unable to perform.
 *
 * ★ THE NET EFFECT: encrypting a workspace silently disabled the thing that says who is speaking
 * in it — worst in exactly the rooms where that matters most.
 *
 * ── WHAT THE FIX IS ─────────────────────────────────────────────────────────
 *
 * The reader has what the relay lacked: it just opened the envelope with a key the relay does not
 * hold. It runs the SAME digest over the SAME region the relay would have. This is not a new
 * trust assumption — it is the deferred half of a check that was already specified.
 *
 * These tests drive the REAL `openSealedDescriptor` with the REAL `digestedGraphRegion`,
 * `canonicalGraphDigest` and proof parser. Only the transport and the opener are scripted.
 */
import { describe, it, expect } from 'vitest';
import { canonicalGraphDigest } from '@interego/core';
import { verifiedSigner } from '@interego/core/delegate';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';
import { sealedBindingCheck, type OpenedGraph } from '../packages/workspace-client/src/opener.js';

const GRAPH = 'https://relay.example/ns/u-a/room-stream';
const URL_ = 'http://css.internal:3456/u-a/context-graphs/9.ttl';
const AGENT = 'did:web:identity.example:agents:scribe-u-b';

/** The payload as SERVED — the TriG wrap, prefixes hoisted, body indented, as `publish()` writes it. */
const PLAINTEXT = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix prov: <http://www.w3.org/ns/prov#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n\n'
  + '<' + GRAPH + '> {\n'
  + '    <' + GRAPH + '/e/0> a wsp:Entry ;\n'
  + '      dct:description "the delegate speaks" ;\n'
  + '      prov:wasAttributedTo <' + AGENT + '> .\n'
  + '}\n';

/**
 * The region the publisher digested, built here the way `extractNamedGraphTurtle` builds it —
 * the document's prefix lines hoisted back on, the four spaces `wrapAsTriG` added taken off —
 * and NOT by calling that function, which would make this test agree with itself.
 *
 * ★ THE SCOPE MATTERS AS MUCH AS THE DIGEST. It is the named-graph block alone: the descriptor
 * shares the served document and carries the proof, so a digest over the whole thing could never
 * match anything a publisher computed, and a digest that reached the DEFAULT graph would let a
 * forged record be smuggled in beside an honest one with the digest unchanged.
 */
const REGION = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix prov: <http://www.w3.org/ns/prov#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<' + GRAPH + '/e/0> a wsp:Entry ;\n'
  + '  dct:description "the delegate speaks" ;\n'
  + '  prov:wasAttributedTo <' + AGENT + '> .\n';

const descriptorTurtle = (contentHash: string | null): string =>
  '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
  + '<' + URL_ + '> iep:describes <' + GRAPH + '> ;\n'
  + '  iep:authorshipProof [\n'
  + '    iep:issuer <' + AGENT + '> ;\n'
  + '    iep:verificationMethod <did:key:zRelay#k> ;\n'
  + '    iep:signerAddress "0xabc" ;\n'
  + '    iep:created "2026-08-20T10:00:00.000Z" ;\n'
  + '    iep:ownerWebId <https://identity.example/users/u-a/profile#me> ;\n'
  + '    iep:descriptorId <' + URL_ + '> ;\n'
  + '    iep:proofValue "0xsig" ;\n'
  + (contentHash ? '    iep:contentHash "' + contentHash + '" ;\n' : '')
  + '  ] .\n';

/** What the relay answers for a sealed graph it is not a recipient of: no content, `declared`. */
const sealedResponse = (contentHash: string | null): Record<string, unknown> => ({
  turtle: descriptorTurtle(contentHash),
  graph: { encrypted: true, content: null },
  authorship: {
    authorshipVerified: true,
    signedBy: AGENT,
    verificationMethod: 'did:key:zRelay#k',
    contentBinding: 'declared',
    contentBindingNote: 'the proof commits to a digest and nothing was checked against it',
  },
});

function client(opened: OpenedGraph): WorkspaceClient {
  const tx = { callTool: async () => ({ envelope: 'whatever' }) };
  const c = new WorkspaceClient('https://relay.example', tx as never);
  c.setGraphOpener(() => opened, sealedBindingCheck);
  return c;
}

describe('★★ a sealed entry, opened by somebody it was sealed to', () => {
  it('★ completes the binding the relay could not check, so the signer is established', async () => {
    const digest = canonicalGraphDigest(REGION);
    expect(digest, 'the fixture could not be digested, so it tests nothing').toBeTruthy();

    const c = client({ kind: 'opened', content: PLAINTEXT });
    const out = await c.openSealedDescriptor(sealedResponse(digest as string), URL_);

    expect(out['openedWithOwnKey']).toBe(true);
    const a = out['authorship'] as Record<string, unknown>;
    // ★ THE LOAD-BEARING ASSERTION. Before this, `verifiedSigner` returned null for every
    // descriptor in every private workspace, and `judgeAuthorship` called every delegate's
    // entry disputed.
    expect(a['contentBinding'], 'a sealed entry the reader opened is still reported as unchecked')
      .toBe('bound');
    expect(verifiedSigner(a), 'the reader opened the envelope and still cannot say who signed it')
      .toBe(AGENT);
    // ★ AND IT IS NOT WEARING THE RELAY'S AUTHORITY. This verdict was reached HERE, with a key
    // the relay does not hold, and a reader must be able to tell the two apart.
    expect(a['contentBindingCheckedLocally']).toBe(true);
    expect(String(a['contentBindingLocalNote'])).toContain('not by the relay');
    // The relay's own note is left exactly as the relay wrote it.
    expect(String(a['contentBindingNote'])).toContain('nothing was checked against it');
  });

  it('★ says MISMATCHED when the opened bytes are not what the proof committed to', async () => {
    // The dangerous direction. Reporting 'declared' after a comparison that RAN and failed would
    // deliver the substrate's sharpest signal with a note telling the reader to disregard it.
    const c = client({ kind: 'opened', content: PLAINTEXT });
    const out = await c.openSealedDescriptor(
      sealedResponse(canonicalGraphDigest('<urn:s> <urn:p> "something else" .') as string), URL_);
    const a = out['authorship'] as Record<string, unknown>;
    expect(a['contentBinding']).toBe('mismatched');
    // And a mismatch establishes no signer — `verifiedSigner` refuses it as it refuses 'declared'.
    expect(verifiedSigner(a)).toBeNull();
    expect(String(a['contentBindingLocalNote'])).toContain('DOES NOT match');
  });

  it('never overturns a verdict the relay reached by looking', async () => {
    // A LOCAL CHECK MAY COMPLETE A CHECK NOBODY RAN. It may not re-run one that ran: bound,
    // mismatched and unbound are all verdicts the relay reached by looking at the payload.
    const settled = ['bound', 'mismatched', 'unbound'];
    for (const binding of settled) {
      const res = sealedResponse(canonicalGraphDigest(REGION) as string);
      (res['authorship'] as Record<string, unknown>)['contentBinding'] = binding;
      const out = await client({ kind: 'opened', content: PLAINTEXT }).openSealedDescriptor(res, URL_);
      const a = out['authorship'] as Record<string, unknown>;
      expect(a['contentBinding'], 'a local check overwrote the relay verdict ' + binding).toBe(binding);
      expect(a['contentBindingCheckedLocally']).toBeUndefined();
    }
  });

  it('leaves a proof that commits to no digest alone', async () => {
    // Nothing to compare against. `declared` requires a digest in the proof; a proof without one
    // is `unbound`, and inventing a comparison for it would be inventing the commitment too.
    const out = await client({ kind: 'opened', content: PLAINTEXT })
      .openSealedDescriptor(sealedResponse(null), URL_);
    const a = out['authorship'] as Record<string, unknown>;
    expect(a['contentBinding']).toBe('declared');
    expect(a['contentBindingCheckedLocally']).toBeUndefined();
  });

  it('changes nothing for a reader that could not open the envelope', async () => {
    const out = await client({ kind: 'not-for-you' } as OpenedGraph)
      .openSealedDescriptor(sealedResponse(canonicalGraphDigest(REGION) as string), URL_);
    expect(out['openedWithOwnKey']).toBeUndefined();
    expect((out['authorship'] as Record<string, unknown>)['contentBinding']).toBe('declared');
  });
});
