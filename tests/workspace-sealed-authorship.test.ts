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
const VICTIM = 'did:web:identity.example:users:victim';

/**
 * The payload as SERVED — the TriG wrap, prefixes hoisted, body indented, as `publish()` writes
 * it — and then one triple in the DEFAULT graph, outside the block, that no honest publisher
 * would write. That triple is load-bearing: it is the only thing in this file that can tell a
 * block-scoped digest from a whole-document one. The reason, measured, is under `REGION` below.
 */
const PLAINTEXT = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix prov: <http://www.w3.org/ns/prov#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n\n'
  + '<https://relay.example/forged> a wsp:MembershipAcceptance ;\n'
  + '  prov:wasAttributedTo <' + VICTIM + '> .\n\n'
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
 * ★ THE SCOPE MATTERS AS MUCH AS THE DIGEST — AND UNTIL THE FORGED TRIPLE WENT INTO `PLAINTEXT`
 * THIS FILE PROVED NOTHING WHATSOEVER ABOUT SCOPE. The comment that stood here said a digest over
 * the whole served document "could never match anything a publisher computed". That is true of a
 * PUBLIC descriptor, whose own triples share the file. It is false of the document this file
 * models, and this file models only sealed ones. A sealed payload's plaintext carries no
 * descriptor triples at all: `sealForRoster` wraps with an EMPTY descriptor block,
 * `wrapAsTriG('', payloadTurtle, graphIri)`, because the relay writes the descriptor afterwards
 * and the sealer has never seen it. And `canonicalGraphTriples` emits `${s} <${p}> ${o} .` with no
 * graph component at all, so graph labels are invisible to the digest. With nothing outside the
 * block, whole document and block-only were the same string —
 *   graph-nquads-sha256:471cb47a322867e87ffb532afa86c1aff3294a3380544198b892437f359414ff
 * — and `sealedBindingCheck` mutated to `observed = canonicalGraphDigest(content)`, which is
 * PRECISELY the fallback `digestedGraphRegion` names as the bug ("It must never fall back to the
 * whole document — that fallback is the defect"), passed all eight tests here unchanged.
 *
 * ★ SO `PLAINTEXT` CARRIES A FORGED TRIPLE IN THE DEFAULT GRAPH, beside the honest block. It moves
 * the whole-document digest to a094f502ea8eec81… and leaves the block-only digest at 471cb47a…,
 * because `extractNamedGraphTurtle` carries forward out of `trig.slice(0, open)` only lines
 * matching /^\s*(@prefix|@base|PREFIX|BASE)\s/ — a default-graph triple is not part of the region.
 * A correct reader still reports 'bound'; one that digested the file reports 'mismatched' and the
 * ★-marked assertion below fails.
 *
 * BE PRECISE ABOUT WHAT THIS GUARDS, BECAUSE NOTHING SHIPS WRONG TODAY. All four reader-side
 * parses — `membership.ts`, `respond.ts`, `stream.ts` and `opener.ts` — go through the one shared
 * `digestedGraphRegion`, so digester scope and parser scope agree and no input produces a wrong
 * answer. The class is real all the same: a hostile member can hand-build a `sealedPayload` whose
 * plaintext puts forged triples in the DEFAULT graph beside an honest block, declare only the
 * block's digest, and every recipient reports `contentBinding: 'bound'` with `verifiedSigner`
 * naming the issuer — inert only for as long as all four readers keep staying inside the block.
 *
 * This is the SECOND guard on that invariant, not the only one.
 * `deploy/mcp-relay/tests/authorship-content-binding.test.ts` pins it from the DIGESTER's side: it
 * inserts a default-graph triple and asserts the digest does NOT move. This file pins the reader's
 * side — that the reader keeps asking for the region and never for the file.
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
    // The relay reports these as SEPARATE axes and the reader must consult both — see below.
    descriptorBinding: { bound: true, basis: 'exact-url' },
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
    // ★ AND THE FIXTURE HAS TO STAY DISCRIMINATING. Take the forged default-graph triple out of
    // `PLAINTEXT` and these two become the SAME string, at which point every assertion in this
    // file passes just as happily against a whole-document digest — which is how the file spent
    // its first life asserting a scope invariant it could not see. This is the tripwire on that.
    expect(canonicalGraphDigest(PLAINTEXT),
      'PLAINTEXT no longer carries a triple outside the block, so this file can no longer tell a '
      + 'block-scoped digest from a whole-document one').not.toBe(digest);

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

describe('★★ the local check may complete a verdict, never overturn one', () => {
  /**
   * ── THE FORGERY HOLE THE FIRST VERSION OF THIS FUNCTION OPENED ──────────────
   *
   * Found by a refute-review of this very round, after the suite was green and every mutant was
   * killed — which is exactly what a green suite over your own reading is worth.
   *
   * `'declared'` does NOT mean "the signature was fine and only the content went unchecked". The
   * relay emits it from `contentBindingWhenUnchecked(proof.contentHash)` on EVERY path that did
   * not reach the comparison, and that includes both of its refusals: a signature that did not
   * verify, and a signature that verified over SOME OTHER RECORD — the lifted-proof class, where
   * a genuine proof from one of a principal's honest public descriptors is pasted into a
   * fabricated one. `deploy/mcp-relay/server.ts` sets `authorshipVerified: false` alongside
   * `contentBinding: verifyResult.contentBinding` for both.
   *
   * So a gate on the binding ALONE upgraded a refused descriptor to `'bound'` — and
   * `verifiedSigner` keys on precisely that value. The reader would then have named the forger's
   * chosen issuer as the established signer of a record the relay had already thrown out.
   */
  const digest = canonicalGraphDigest(REGION) as string;

  it('★ refuses to upgrade a descriptor whose SIGNATURE the relay rejected', () => {
    const res = sealedResponse(digest);
    const a = res['authorship'] as Record<string, unknown>;
    a['authorshipVerified'] = false;
    a['reason'] = 'verification returned false';
    const out = client({ kind: 'opened', content: PLAINTEXT }).openSealedDescriptor(res, URL_);
    return out.then((d) => {
      const got = d['authorship'] as Record<string, unknown>;
      expect(got['contentBinding'], 'a rejected signature was upgraded to bound').toBe('declared');
      expect(verifiedSigner(got), 'a rejected proof established a signer').toBeNull();
      expect(got['contentBindingCheckedLocally']).toBeUndefined();
    });
  });

  it('★ refuses to upgrade a proof LIFTED from another descriptor', async () => {
    // The signature is intact and the digest matches — it is simply a proof about a different
    // record. `descriptorBinding.bound` is the relay's answer to that and it is a separate axis.
    const res = sealedResponse(digest);
    const a = res['authorship'] as Record<string, unknown>;
    a['descriptorBinding'] = { bound: false, basis: 'none', note: 'this proof names another descriptor' };
    const out = await client({ kind: 'opened', content: PLAINTEXT }).openSealedDescriptor(res, URL_);
    const got = out['authorship'] as Record<string, unknown>;
    expect(got['contentBinding'], 'a lifted proof was upgraded to bound').toBe('declared');
    expect(verifiedSigner(got)).toBeNull();
  });

  it('and still completes the check when the relay refused nothing', async () => {
    // The other half — the fix must not disable the feature it was added to.
    const out = await client({ kind: 'opened', content: PLAINTEXT })
      .openSealedDescriptor(sealedResponse(digest), URL_);
    const got = out['authorship'] as Record<string, unknown>;
    expect(got['contentBinding']).toBe('bound');
    expect(verifiedSigner(got)).toBe(AGENT);
  });
});
