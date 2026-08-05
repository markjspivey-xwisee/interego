#!/usr/bin/env tsx
/**
 * An authorship proof must be checked against the graph served beside it.
 *
 * ★ THE DEFECT. `get_descriptor` called `verifySignedAuthorship(proof, verifier)` with no
 * observed payload and dropped the content verdict on the floor. The signed payload had
 * carried a `contentHash` for a whole release; the descriptor Turtle serialised it; the
 * parser read it back — and the read path never compared it to anything. So a descriptor
 * whose graph had been replaced entirely still answered `authorshipVerified: true`, which
 * a reader has every reason to take as "this document is attested" and which in fact meant
 * only "somebody signed this URL once".
 *
 * ★ THE REGRESSION THIS FILE EXISTS TO PREVENT. The obvious repair — hash the served bytes,
 * compare — is WRONG, and measurably so. `publish()` rewrites the payload through
 * `wrapAsTriG` on the way in: the caller's `@prefix` lines are hoisted out of the graph
 * block to document scope, the body outside long literals is indented four spaces, and the
 * descriptor's own triples share the document. The bytes signed are never the bytes served.
 * The first two assertions below measure exactly that on one payload — the published and
 * served hashes, PRINTED so the figures can be quoted and refuted — and the next two show
 * the triples agreeing across the same rewrite. A read path built on the byte comparison
 * would have reported every honest content-bound proof as tampering. The round-trip runs
 * through the REAL `publish()` and the REAL `fetchGraphContent()`, not through a double that
 * hands back what it was given — a double could not have exposed the rewrite, which is
 * precisely how it went unnoticed.
 *
 * ★ FOUR OUTCOMES. bound / mismatched / declared / unbound are asserted as distinct.
 * Collapsing "the signer committed to a digest" into "the digest was checked" was the
 * original overclaim; collapsing "the digest was checked and FAILED" into "nothing was
 * checked" was its mirror image, and shipped the substrate's sharpest signal under a note
 * telling the reader it was not evidence of anything.
 *
 * ★ ROUND 6 — TWO MORE THINGS THE READ PATH WAS SILENT ABOUT:
 *
 *   1. VALID TURTLE THE DIGESTER REFUSED. `canonicalGraphDigest` swallowed every parse throw
 *      into `null`, and `handlePublishContext` spelled that `?? undefined` — so a payload
 *      this build could not read was SIGNED WITH NO CONTENT BINDING and its proof reports
 *      `contentBinding: 'unbound'` forever, which readers are told means the proof predates
 *      content binding. Two shapes reaching it were ordinary valid Turtle: `'''…'''` literals
 *      (the tokeniser handled only `"`) and SPARQL-style `PREFIX` (the directive branch
 *      demanded the `.` that SPARQL forbids). Both now parse; the rest of the class now
 *      arrives as a NAMED reason, with the parser's offset, on the publish response.
 *      ★ The dangerous half of that fix is asserted here too: teaching the tokeniser `'''`
 *      means those payloads now GET a digest, so a wrap/unwrap that disagreed about where a
 *      `'''` literal starts would have converted a silent `unbound` into an active TAMPERING
 *      accusation against an honest publisher — strictly worse than the bug. Measured
 *      through the real publish path, not read off `flipsLongLiteralState`.
 *
 *   2. WHETHER THE PROOF IS ABOUT THIS RECORD AT ALL. `verifySignedAuthorship` re-derives the
 *      canonical payload from the proof block's OWN fields, so a proof lifted verbatim out of
 *      one of a principal's real public descriptors and pasted into a fabricated record
 *      verified clean and named that principal. `get_descriptor` held the proof AND the URL
 *      it fetched it from and never compared them. It does now, via the same
 *      `proofBindsToDescriptorUrl` the workspace layer uses, reporting a BASIS — because
 *      `exact-url` and `slug-only` are not equally strong and a boolean hid the difference.
 *
 * ★ MUTATION-CHECKED — each guard broken, the suite re-run, then reverted. Round 5 covered
 * the guards added in round 5 (the four-value binding, the prefix-position rewrite and its
 * refusal, the acceptance-count enumeration); earlier rounds' counts covered earlier
 * guards. No single number covers all of them, and a header claiming one would be the kind
 * of stale assurance this round was convened to remove. See the header of
 * tests/authorship-covers-content.test.ts for the core half of the same property.
 *
 * ★ Round-6 mutations, each applied, suite re-run, then reverted:
 *   parser —      single/triple single-quote literals unsupported again  4
 *                 SPARQL PREFIX folded back onto @prefix (dot demanded)  1
 *                 SPARQL BASE consumes the next token blind again        1
 *   digest —      the refusal reason emptied (silent null restored)      1
 *                 the parser offset dropped from the reason              1
 *                 publish path back to the silent digest                 1
 *   binding —     the URL branch falls through to the slug compare       1
 *                 the URL branch never taken (every id graded as URN)    4
 *                 the slug compare dropped (everything binds)            3
 *                 the host normaliser ignored                            1
 *                 slug-only reported as exact-url                        1
 *   wiring —      stream.ts stops using the shared function              3
 *                 the relay stops passing normalizeCssUrl                2
 *                 the relay computes the binding INSIDE the try          1
 *
 * ★ THE HARNESS ITSELF WAS WRONG FIRST, and the way it was wrong is worth recording: it
 * mutated `packages/core/src` without rebuilding, and `@interego/core` resolves to `dist/`,
 * so EVERY core mutation reported "SURVIVED". A harness that stands in for the thing it
 * measures cannot measure it — the same lesson as the double-vs-real-publish() note above,
 * arriving from the tooling side. A second false survivor came from a mutation that set a
 * variable after the return that made it irrelevant: a mutation that does not mutate is not
 * evidence of a guard.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/authorship-content-binding.test.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ContextDescriptor,
  createSignedAuthorship,
  verifySignedAuthorship,
  canonicalGraphDigest,
  // The same digest, carrying WHY there is none. The publish path uses this one; the silent
  // form is what let an unparseable payload sign itself into a permanent `unbound`.
  canonicalGraphDigestResult,
  GRAPH_DIGEST_ALGORITHM,
  type IRI,
} from '@interego/core';
import { publish, fetchGraphContent, extractNamedGraphTurtle } from '@interego/solid';
import {
  observedGraphDigest,
  graphIriFromDescriptorTurtle,
  contentBindingNote,
  authorshipVerdict,
  podRootOfDescriptorUrl,
  makeServingPodOwnerReader,
} from '../authorship-content-binding.js';

let pass = 0;
let fail = 0;
// `detail` prints on PASS as well as on failure. Several of these assertions exist to make
// a measured number reproducible rather than merely true, and a number only visible when
// the test breaks is a number nobody can quote.
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? `\n         ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const GRAPH_IRI = 'urn:graph:binding-probe';
const DESC_IRI = 'urn:iep:binding-probe:v1';
const POD = 'https://alice.pod/';

const PAYLOAD = `@prefix dct: <http://purl.org/dc/terms/> .
@prefix ex: <https://example.org/ns#> .
<${GRAPH_IRI}> dct:title "Quarterly figures" ;
    dct:description "Revenue up 4%." ;
    ex:confidence 5 ;
    ex:reviewer [ dct:title "nested blank node" ] .
`;

/** The relay's signer stand-in: deterministic, so the test needs no wallet. */
const sha = (s: string): string => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
const signer = async (payload: string) => ({
  signature: sha(payload),
  signerAddress: '0xabc',
  verificationMethod: 'did:ethr:0xabc' as IRI,
});
const verifier = async (payload: string, proof: { proofValue: string }) =>
  proof.proofValue === sha(payload);

/** An in-memory CSS: PUT stores, GET serves back verbatim. */
function makePod() {
  const store = new Map<string, { body: string; type: string }>();
  const fetchFn = async (url: string, init?: Record<string, unknown>) => {
    const method = (init?.method as string) ?? 'GET';
    if (method === 'PUT') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      store.set(url, { body: String(init?.body), type: headers['Content-Type'] ?? '' });
      return { ok: true, status: 201, statusText: 'Created', headers: new Map() };
    }
    const hit = store.get(url);
    if (!hit) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', headers: { get: () => null } };
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => hit.body,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? hit.type : null) },
    };
  };
  return { store, fetchFn };
}

/** Publish PAYLOAD through the real substrate and hand back what a reader would receive. */
async function publishAndServe(payload: string): Promise<{ turtle: string; served: string }> {
  const { store, fetchFn } = makePod();
  const descriptor = ContextDescriptor.create(DESC_IRI as IRI)
    .describes(GRAPH_IRI as IRI)
    .temporal({ validFrom: '2026-07-31T00:00:00Z' })
    .selfAsserted('did:web:alice.example' as IRI)
    .build();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await publish(descriptor, payload, POD, { fetch: fetchFn as any });
  const graphUrl = [...store.keys()].find(k => k.endsWith('.trig'))!;
  const descUrl = [...store.keys()].find(k => k.endsWith('.ttl') && !k.includes('well-known'))!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph = await fetchGraphContent(graphUrl, { fetch: fetchFn as any });
  return { turtle: store.get(descUrl)!.body, served: graph.content! };
}

async function main(): Promise<void> {
  console.log('\n★ the rewrite that makes a byte-comparison wrong');

  const { turtle, served } = await publishAndServe(PAYLOAD);

  ok(served !== PAYLOAD, 'the served graph is NOT the published bytes — publish() rewrote it');
  // The pair is PRINTED, not asserted against constants. Doc comments used to quote a
  // specific published/served pair as "measured on a four-line payload"; the payload that
  // produced it was not in the repo, so nobody could reproduce or refute the figures. Now
  // the only place the numbers exist is the run that computes them.
  ok(
    sha(served) !== sha(PAYLOAD),
    '★ a naive sha256(served) !== sha256(published): this comparison would fail every honest proof',
    `published ${sha(PAYLOAD).slice(0, 17)}… vs served ${sha(served).slice(0, 17)}…`,
  );
  ok(
    graphIriFromDescriptorTurtle(turtle) === GRAPH_IRI,
    'the graph IRI is read off the descriptor rather than guessed from the URL',
  );

  console.log('\n★ the digest that survives it');

  const publisherDigest = canonicalGraphDigest(PAYLOAD)!;
  // ★ THE DESCRIPTOR TURTLE, NOT A PRE-EXTRACTED GRAPH IRI. `observedGraphDigest` derives the
  // IRI itself, through `digestedGraphRegion`, so the digester and every reader are handed
  // the same two strings and cannot disagree about which region is covered. Passing the IRI
  // separately is how the scopes came apart: the relay digested the block and
  // `membership.ts` parsed the whole served document, and everything in the gap was read
  // and never digested.
  const readerDigest = observedGraphDigest({ graphContent: served, descriptorTurtle: turtle });
  ok(
    publisherDigest === readerDigest,
    '★ publisher and reader agree across the wrap — the whole fix rests on this',
    `${publisherDigest} vs ${readerDigest}`,
  );
  ok(
    publisherDigest.startsWith(`${GRAPH_DIGEST_ALGORITHM}:`),
    'the digest is labelled with its algorithm so a verifier knows whether it can recompute it',
  );

  console.log('\n★ four outcomes, end to end through the real verifier');

  const base = {
    agentId: 'https://ex.org/agent' as IRI,
    ownerWebId: 'https://ex.org/owner#me' as IRI,
    descriptorId: DESC_IRI as IRI,
    created: '2026-07-31T00:00:00.000Z',
  };

  const boundProof = await createSignedAuthorship({ ...base, contentHash: publisherDigest }, signer);
  const rBound = await verifySignedAuthorship(boundProof, verifier, { contentHash: readerDigest });
  ok(rBound.valid && rBound.contentBinding === 'bound', '★ BOUND — digest recomputed over the served payload and matched');

  const legacyProof = await createSignedAuthorship(base, signer);
  const rLegacy = await verifySignedAuthorship(legacyProof, verifier, { contentHash: readerDigest });
  ok(
    rLegacy.valid && rLegacy.contentBinding === 'unbound',
    '★ UNBOUND — a proof with no digest still VERIFIES; on its own that is no evidence of forgery',
  );

  const rUnchecked = await verifySignedAuthorship(boundProof, verifier, undefined);
  ok(
    rUnchecked.valid && rUnchecked.contentBinding === 'declared',
    '★ DECLARED — a digest nobody checked must not report as bound',
  );

  // ★★ THE FOURTH OUTCOME, AND WHY IT IS FOURTH. A recomputed-and-mismatched digest used to
  // come back as 'declared' — the same value as "nobody looked" — so a detected content
  // swap was rendered to the reader with the sentence "NOTHING WAS CHECKED against it …
  // neither an attestation of the content nor evidence against it". Every clause of that
  // was false in the one case it mattered.
  const rMismatch = await verifySignedAuthorship(
    boundProof, verifier, { contentHash: canonicalGraphDigest('<urn:s> <urn:p> "other" .')! },
  );
  ok(
    !rMismatch.valid && rMismatch.contentBinding === 'mismatched',
    '★★ MISMATCHED — a checked digest that did not match is its own outcome, not "declared"',
  );
  // A failed signature reached no content, so it cannot report 'unbound' — the value whose
  // note exonerates the proof — when the proof plainly carries a digest.
  const rBadSig = await verifySignedAuthorship(boundProof, async () => false, { contentHash: readerDigest });
  ok(
    !rBadSig.valid && rBadSig.contentBinding === 'declared',
    '★★ a proof whose SIGNATURE failed reports "declared" (not checked), never "unbound"',
  );
  const rBadSigLegacy = await verifySignedAuthorship(legacyProof, async () => false, undefined);
  ok(
    !rBadSigLegacy.valid && rBadSigLegacy.contentBinding === 'unbound',
    '…and a failed signature on a proof that really carries no digest is still "unbound"',
  );

  console.log('\n★ tampering IS caught');

  const TAMPERED = PAYLOAD.replace('Revenue up 4%.', 'Revenue up 40%.');
  const { turtle: turtleTampered, served: servedTampered } = await publishAndServe(TAMPERED);
  const tamperedDigest = observedGraphDigest({
    graphContent: servedTampered, descriptorTurtle: turtleTampered,
  });
  ok(tamperedDigest !== readerDigest, 'a one-character content change moves the digest');

  // ★★ AND A CHANGE OUTSIDE THE BLOCK DOES NOT — WHICH IS THE POINT, AND WAS THE HOLE. The
  // digest covers ONE REGION of the served document. Triples added to the DEFAULT graph
  // leave it byte-identical, so `contentBinding` stays `'bound'` and says so honestly. What
  // made that a manufactured workspace participant was a READER that parsed the whole
  // document while believing `'bound'` covered it. Pinned here, on the digester's side, so
  // the scope this verdict actually has is a measured fact rather than a comment.
  const outsideBlock = served.replace(
    '# ── Named Graph Content',
    `<https://attacker.example/planted> <https://example.org/ns#p> "not digested" .\n\n# ── Named Graph Content`,
  );
  ok(
    outsideBlock !== served
      && observedGraphDigest({ graphContent: outsideBlock, descriptorTurtle: turtle }) === readerDigest,
    '★★ triples in the DEFAULT graph do not move the digest — `bound` covers the block ALONE, '
    + 'and any reader that parses more than the block is reading undigested bytes',
  );
  const rSwap = await verifySignedAuthorship(boundProof, verifier, { contentHash: tamperedDigest! });
  ok(
    !rSwap.valid && /covers content/.test(rSwap.reason ?? ''),
    '★ an authentic signature over DIFFERENT content fails verification outright',
  );

  console.log('\n★ the false-forgery guards');

  const legacyStyle = await createSignedAuthorship({ ...base, contentHash: sha(PAYLOAD) }, signer);
  const rLegacyDigest = await verifySignedAuthorship(legacyStyle, verifier, { contentHash: readerDigest });
  ok(
    rLegacyDigest.valid && rLegacyDigest.contentBinding === 'declared',
    '★★ a pre-existing `sha256:` proof is DECLARED, never a forgery — this is the live-data guard',
    rLegacyDigest.reason ?? '',
  );

  ok(
    observedGraphDigest({ graphContent: null, descriptorTurtle: turtle }) === undefined,
    'an unreadable payload (encrypted to others) yields no digest rather than a digest of nothing',
  );
  ok(
    observedGraphDigest({
      graphContent: served,
      descriptorTurtle: '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
        + '<https://x/d.ttl> iep:describes <urn:graph:not-in-this-document> .\n',
    }) === undefined,
    'a graph IRI absent from the document yields no digest',
  );
  ok(
    observedGraphDigest({ graphContent: served, descriptorTurtle: '<https://x/d.ttl> a <urn:t> .' }) === undefined,
    'a descriptor with no iep:describes yields no digest — the region cannot be located, so '
    + 'nothing may be digested and nothing may be parsed',
  );
  ok(
    observedGraphDigest({ graphContent: 'this is not turtle {{{', descriptorTurtle: turtle }) === undefined,
    'an unparseable payload yields no digest',
  );
  ok(
    canonicalGraphDigest('@prefix broken <<<') === null,
    'an unparseable payload digests to null, not to a hash of the empty string',
  );

  console.log("\n★ valid Turtle the digester used to refuse — and the silence around it");

  // ★ THE DEFECT. `null` here is not inert: `handlePublishContext` spells it `?? undefined`,
  // so the proof is signed with NO contentHash and reports `contentBinding: 'unbound'`
  // forever — which readers are told means "every proof written before content binding
  // existed". Both shapes below are ordinary valid Turtle that every other tool accepts, so
  // this was not a legacy-data story: live payloads were being signed into a permanent,
  // unexplained "uncovered" and nobody was told, least of all the publisher.
  const NOW_PARSES: [string, string][] = [
    ['SPARQL PREFIX (no terminating `.`)',
      `PREFIX ex: <https://example.org/ns#>\n<${GRAPH_IRI}> ex:p "v" .\n`],
    ['SPARQL BASE (no terminating `.`)',
      `BASE <https://example.org/>\n<${GRAPH_IRI}> <https://example.org/ns#p> "v" .\n`],
    ["triple-quoted ''' literal",
      `<${GRAPH_IRI}> <https://example.org/ns#p> '''line one\nline two''' .\n`],
    ["single-quoted ' literal",
      `<${GRAPH_IRI}> <https://example.org/ns#p> 'plain' .\n`],
    ["' and \" nested in each other's literals",
      `<${GRAPH_IRI}> <https://example.org/ns#a> 'he said "hi"' ;\n`
      + `    <https://example.org/ns#b> "it's fine" .\n`],
  ];
  for (const [label, src] of NOW_PARSES) {
    ok(canonicalGraphDigest(src) !== null, `★ ${label} now digests instead of yielding a permanent unbound`);
  }

  // ★★ AND THE SAME QUOTING SURVIVES THE PUBLISH REWRITE. This is the assertion that matters
  // most and the one a helper-only test would have missed. Teaching the tokeniser `'''`
  // means those payloads now GET a contentHash where before they silently got none — so if
  // `wrapAsTriG`/`extractNamedGraphTurtle` disagreed about where a `'''` literal starts, the
  // fix would have converted a silent `unbound` into an active TAMPERING accusation against
  // an honest publisher. Strictly worse than the bug. `flipsLongLiteralState` counts both
  // delimiters, so they agree — measured here through the real publish path rather than
  // asserted from reading it.
  const SQ_INDENTED = `@prefix ex: <https://example.org/ns#> .
<${GRAPH_IRI}> ex:note '''first
    four spaces of the caller's own
last''' .
`;
  const sqTrip = await publishAndServe(SQ_INDENTED);
  ok(
    observedGraphDigest({ graphContent: sqTrip.served, descriptorTurtle: sqTrip.turtle })
      === canonicalGraphDigest(SQ_INDENTED),
    "★★ a ''' literal's own leading spaces survive the wrap and the unwrap — the new parse "
    + 'did not turn a silent unbound into a false tampering report',
  );

  // ★ THE REFUSAL NAMES THE SHAPE. Fixing two shapes does not remove the class — this parser
  // is deliberately narrow — so what changed structurally is that the next unsupported shape
  // arrives as a NAMED reason instead of as a proof that quietly attests nothing.
  const stillBroken = canonicalGraphDigestResult('@prefix broken <<<');
  ok(stillBroken.digest === null, 'a genuinely unparseable payload still yields no digest');
  ok(
    /did not parse as Turtle/.test(stillBroken.reason ?? ''),
    '★ and it now says so, rather than returning a bare null the publish path spells `?? undefined`',
  );
  ok(
    /at offset \d+/.test(stillBroken.reason ?? ''),
    '★ with the parser\'s own offset — "which shape defeated it" is a question about a position',
    stillBroken.reason,
  );
  ok(
    /contentBinding "unbound" permanently/.test(stillBroken.reason ?? ''),
    'and it states the CONSEQUENCE, which is the part an operator has to act on',
  );
  ok(
    canonicalGraphDigestResult(PAYLOAD).reason === undefined
      && canonicalGraphDigestResult(PAYLOAD).digest === canonicalGraphDigest(PAYLOAD),
    'a clean payload carries no reason and the same digest as the plain form',
  );
  // (The wiring assertion — that the publish path actually CALLS the reason-carrying form —
  // lives in the server.ts-as-text section below, where SERVER is read.)

  console.log('\n★ prefix rebinding changes meaning, so it must change the digest');

  const rebound = PAYLOAD.replace('<https://example.org/ns#>', '<https://attacker.example/ns#>');
  ok(
    canonicalGraphDigest(rebound) !== publisherDigest,
    '★ rebinding a prefix to another namespace moves the digest — a byte-level body hash would not have',
  );

  console.log('\n★ reordering serialization does NOT change it');

  const reordered = `@prefix ex: <https://example.org/ns#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${GRAPH_IRI}>
      dct:description "Revenue up 4%." ;
      dct:title "Quarterly figures" ;
      ex:confidence 5 ;
      ex:reviewer [ dct:title "nested blank node" ] .
`;
  ok(
    canonicalGraphDigest(reordered) === publisherDigest,
    'reindenting and reordering predicates leaves the digest alone — otherwise honest republishes look like tampering',
  );

  console.log('\n★ the wrap and its inverse agree about long literals');

  // ★★ THE ONE PLACE WHITESPACE IS NOT SERIALISATION. `wrapAsTriG` indents the graph body
  // four spaces and `extractNamedGraphTurtle` strips them back off — a pure round-trip
  // everywhere EXCEPT inside a triple-quoted literal, where those four characters are part
  // of the string's value. Both sides run the same long-literal state machine so neither
  // touches those lines. The literal below deliberately carries its OWN four-space indent on
  // a continuation line: an unwrap that stripped unconditionally would eat exactly those
  // four characters, and every other payload in this file would still pass.
  const INDENTED_LITERAL = `@prefix ex: <https://example.org/ns#> .
<${GRAPH_IRI}> ex:note """first
    four spaces of the caller's own
last""" .
`;
  const roundTrip = await publishAndServe(INDENTED_LITERAL);
  ok(
    observedGraphDigest({ graphContent: roundTrip.served, descriptorTurtle: roundTrip.turtle })
      === canonicalGraphDigest(INDENTED_LITERAL),
    "★★ a literal's own leading spaces survive the wrap and the unwrap — publisher and reader agree",
  );
  ok(
    (extractNamedGraphTurtle(roundTrip.served, GRAPH_IRI) ?? '').includes("    four spaces of the caller's own"),
    'and the recovered payload still carries them, rather than four fewer',
  );

  console.log('\n★ the WIRING, not just the helper');

  // ★★ THE DEFECT WAS A MISSING ARGUMENT, and every assertion above this one would have
  // passed while it was missing. The helpers were never broken; `handleGetDescriptor` simply
  // called the verifier without an observed payload and dropped the verdict. A suite that
  // exercises only the extracted module measures the module — the same mistake that let the
  // gap survive a release — so the call site itself is pinned here. Source-level, because
  // server.ts opens a listener on import and cannot be called from a test.
  const here = dirname(fileURLToPath(import.meta.url));
  const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');

  ok(
    /verifySignedAuthorship\(\s*parsedProof,\s*delegationVerifier,\s*observedContentHash/.test(SERVER),
    '★★ the read path passes the OBSERVED content to the verifier — the missing argument that was the defect',
  );
  ok(
    /observedGraphDigest\(\{[\s\S]{0,200}graphContent:\s*graph\?\.content/.test(SERVER),
    'the observed digest is taken from the payload get_descriptor actually serves',
  );
  ok(
    /observedGraphDigest\(\{[\s\S]{0,200}descriptorTurtle:\s*turtle/.test(SERVER),
    'the graph IRI comes from the descriptor rather than the caller-supplied URL',
  );
  // ★★ AND THE SCOPE IS NOT THE RELAY'S TO PICK ALONE. `observedGraphDigest` no longer
  // accepts a pre-extracted `graphIri`: it takes the descriptor Turtle and derives the region
  // through `digestedGraphRegion`, the ONE function every party that reads a payload must go
  // through. While the parameter existed, the relay passed a block and `membership.ts`
  // parsed the whole document, and the difference was a manufactured workspace participant
  // built from a verbatim copy of somebody else's honest record. Pinned on the module source,
  // because a signature is exactly the thing a future caller would widen back.
  const BINDING_SRC = readFileSync(join(here, '..', 'authorship-content-binding.ts'), 'utf8');
  ok(
    !/readonly graphIri:/.test(BINDING_SRC) && /digestedGraphRegion\(args\)/.test(BINDING_SRC),
    '★★ observedGraphDigest cannot be handed a graph IRI of the caller\'s own choosing — one '
    + 'function decides the digested region, and readers call the same one',
  );
  // ★ NON-OMITTABLE IN THE TYPE, not merely present at the three sites. Declared without
  // `?`, tsc forces every assignment — verified, refused, and threw — to carry it, so a
  // future branch cannot quietly answer with the old two-outcome shape. Asserting the
  // declaration is asserting the thing that does the enforcing.
  ok(
    /contentBinding: ReadContentBinding;/.test(SERVER),
    '★ contentBinding is a REQUIRED field of the authorship result — the compiler keeps every branch honest',
  );
  ok(
    (SERVER.match(/contentBinding:\s*(?:verifyResult\.contentBinding|unchecked)/g) ?? []).length >= 3,
    'all three outcome branches (verified, refused, threw) set it',
  );
  // The catch branch used to hard-code 'declared', which is a claim that the proof carries
  // a digest — false for a proof that carries none. It now derives from the proof, using
  // the same rule the verifier's own unchecked paths use.
  ok(
    /contentBindingWhenUnchecked\(parsedProof\.contentHash\)/.test(SERVER),
    'the catch branch derives "not checked" from the proof rather than asserting `declared`',
  );

  // ★★ THE OTHER QUESTION THE READ PATH NEVER ASKED: is the proof about THIS record?
  // `verifySignedAuthorship` re-derives the canonical payload from the proof block's own
  // fields, so a proof lifted verbatim out of one of a principal's real public descriptors
  // and pasted into a fabricated record verified clean and named that principal. This
  // function holds the proof AND the URL it fetched it from — everything the comparison
  // needs — and did not make it.
  ok(
    /proofBindsToDescriptorUrl\(\s*parsedProof\.descriptorId,\s*landedUrl,\s*normalizeCssUrl,/.test(SERVER),
    '★★ get_descriptor compares the proof\'s descriptorId against the URL it was served from',
  );
  ok(
    /normalizeCssUrl,\s*\n\s*\{\s*\n\s*claimedOwner: parsedProof\.ownerWebId,\s*\n\s*servingPodOwner:/.test(SERVER),
    '★★ …and, for a URN-form id, compares the LOCATION through the other signed field: the '
    + 'proof\'s ownerWebId against the owner the serving pod publishes. The terminal segment '
    + 'is all a URN can match, so without this a proof lifted onto another party\'s pod at '
    + 'the same epoch bound clean',
  );
  // ★ THE LANDED URL, NOT THE URL ASKED FOR — the alternate-turtle precedent, for the same
  // two reasons: `normalizeCssUrl` rewrites a legacy CSS host to a DIFFERENT ORIGIN, and a
  // redirect moves the target. Anchoring on the request would name the wrong pod (or none)
  // and would fail honest reads closed the moment either happened.
  ok(
    /const \{ response: resp, landedUrl: landed \} = await guardedInvokeFetchLanded\(url, \{/.test(SERVER),
    '★ the descriptor GET reports where it LANDED',
  );
  ok(
    /cacheDescriptorBody\(url, \{ content: turtle, mediaType: 'text\/turtle', encrypted: false, landedUrl: landed \}\)/.test(SERVER),
    '★★ and the landed URL is cached WITH the body — otherwise the second read of a URL '
    + 'knows only where it asked, and the binding silently weakens on every cache hit',
  );
  ok(
    /const servingPodRoot = podRootOfDescriptorUrl\(landedUrl\);/.test(SERVER)
    && /const inferredPodUrl = servingPodRoot \?\? undefined;/.test(SERVER),
    '★ the delegation walk and the owner lookup derive the pod with ONE rule off ONE url, so '
    + 'the trust label and the binding verdict cannot be about two different pods',
  );
  ok(
    !/const m = url\.match\(\/\^\(https\?:/.test(SERVER),
    '★ …and the second, inline copy of that rule is gone rather than left beside it',
  );
  // ★★ R4. The pod root is cut out of a CALLER-SUPPLIED URL, so the registry read is an
  // egress on a host the caller chose. `solidFetch` would put it on the unscreened global
  // pool — a second SSRF door opened by a check whose whole purpose is defensive, which is
  // the exact shape found next to `discover_context` on 2026-08-04.
  ok(
    /readAgentRegistry\(podUrl, \{ fetch: guardedInvokeFetch \}\)/.test(SERVER),
    '★★ the serving pod\'s registry is read through the SCREENED fetcher',
  );
  // ★ COMPUTED OUTSIDE THE `try`. It depends on neither the signature nor the payload, so a
  // verifier that throws is no reason to withhold an answer that already exists. Inside, a
  // throw would have meant "and nobody checked what the proof was attached to" — the exact
  // collapse the contentBinding work spent three rounds undoing in the neighbouring field.
  const bindingDecl = SERVER.indexOf('const descriptorBindingResult');
  const tryAfterProof = SERVER.indexOf('try {', SERVER.indexOf('const parsedProof'));
  ok(
    bindingDecl > 0 && bindingDecl < tryAfterProof,
    '★★ the binding is computed BEFORE the try, so all three exits can report it',
  );
  // ★★ AND IT IS NOW ACTED ON. Every assertion above this one passed while the handler
  // computed the binding, reported it on all three exits, and entered the success branch on
  // `if (verifyResult.valid)` alone — the field was a report and the verdict was decided
  // without it.
  ok(
    /const verdict = authorshipVerdict\(\{[\s\S]{0,240}descriptorBinding,\s*\r?\n\s*\}\);\s*\r?\n\s*if \(verdict\.verified\) \{/.test(SERVER),
    '★★ the read path GATES on the verdict, and the gate is a bare read of verdict.verified',
  );
  ok(
    (SERVER.match(/^\s*authorshipVerified: true,\r?$/gm) ?? []).length === 1,
    '★ exactly ONE place in the file can answer authorshipVerified: true',
    `found ${(SERVER.match(/^\s*authorshipVerified: true,\r?$/gm) ?? []).length}`,
  );
  // Counts every ASSIGNMENT of the field, not just the `effective` spelling. Written that
  // way after the obvious version survived its own mutant: pinning `effectiveTrustLevel:
  // effective,` at 1 let `effectiveTrustLevel: 'SelfAsserted' as const,` be added to the
  // REFUSAL branch and still pass — a refused binding carrying a trust level, which is
  // exactly the half of the defect this line exists for. The type declaration at :4387 and
  // the JSON-schema property at :7860 are excluded by requiring a value that is an
  // identifier or a quoted literal followed by a comma.
  const trustAssignments = SERVER.match(/^\s*effectiveTrustLevel: (?:[A-Za-z_$][\w$]*|'[^']*')(?: as const)?,\r?$/gm) ?? [];
  ok(
    trustAssignments.length === 1,
    '★ and effectiveTrustLevel is ASSIGNED in exactly one place, so a refused binding cannot '
    + 'carry a trust upgrade — the second half of the same defect',
    `found ${trustAssignments.length}: ${trustAssignments.map(t => t.trim()).join(' | ')}`,
  );
  ok(
    (SERVER.match(/^\s*descriptorBinding,$/gm) ?? []).length >= 3,
    'all three outcome branches (verified, refused, threw) carry it',
    `found ${(SERVER.match(/^\s*descriptorBinding,$/gm) ?? []).length}`,
  );
  // Non-omittable in the type, same discipline as contentBinding: declared without `?`, so
  // tsc forces a future branch to answer rather than quietly omitting the field.
  ok(
    /descriptorBinding: \{\s*\n\s*bound: boolean;/.test(SERVER),
    '★ descriptorBinding is a REQUIRED field of the authorship result',
  );
  ok(
    /enum: \['exact-url', 'slug-and-owner', 'slug-only', 'none'\]/.test(SERVER),
    '★ the published schema advertises the BASIS, so a caller can tell a full URL comparison '
    + 'from a terminal-segment one — the three are not equally strong and a boolean hid that',
  );
  ok(
    /canonicalGraphDigestResult\(String\(args\.graph_content/.test(SERVER),
    'the publish path commits to the canonical-triples digest, not to a hash of the raw bytes',
  );
  // ★★ AND IT USES THE FORM THAT CARRIES A REASON. The silent `canonicalGraphDigest(...) ??
  // undefined` here is what turned "this build cannot parse your payload" into a proof that
  // attests nothing, reported to nobody. Pinned as a NEGATIVE too: reverting to the silent
  // call is a one-token edit and every other assertion in this file would still pass.
  ok(
    !/canonicalGraphDigest\(String\(args\.graph_content[^)]*\)\)?\s*\?\?\s*undefined/.test(SERVER),
    '★★ …and NOT via the silent form whose null the publish path spelled `?? undefined`',
  );
  ok(
    /contentBindingRefusal/.test(SERVER),
    '★★ the reason reaches the publish RESPONSE, not just the log — the publisher is the one '
    + 'party holding the source text and able to repair it',
  );

  console.log('\n★ the note a reader is handed');

  ok(/NOTHING WAS CHECKED/.test(contentBindingNote('declared')), 'the declared note says plainly that nothing was checked');
  ok(/no evidence of forgery/.test(contentBindingNote('unbound')), 'the unbound note says plainly that it is on its own no evidence of forgery');
  ok(/covers this graph/.test(contentBindingNote('bound')), 'the bound note is the only one that claims coverage');

  // ★ THE NOTES THAT USED TO CONTRADICT THE VERDICT THEY ANNOTATED. Each of these three
  // shipped a sentence telling the reader the opposite of what the substrate had found.
  ok(
    /TAMPERING/.test(contentBindingNote('mismatched')) && !/NOTHING WAS CHECKED/.test(contentBindingNote('mismatched')),
    '★★ a recomputed-and-mismatched digest reads as tampering, not as "nothing was checked"',
  );
  ok(
    !/not a forgery/.test(contentBindingNote('unbound', undefined, false))
    && /did NOT verify/.test(contentBindingNote('unbound', undefined, false)),
    '★★ the unbound note does NOT exonerate a proof whose signature failed',
  );
  ok(
    /not that the bytes are identical/.test(contentBindingNote('bound')),
    '★ the bound note says what `bound` means — triple-identity, not byte-identity',
  );
  ok(
    /reported as `mismatched`, never here/.test(contentBindingNote('declared')),
    'the declared note names the value that a failed check would have produced instead',
  );

  console.log('\n★ a proof that is not about this record is not authorship of it');

  // ★ MEASURED LIVE ON BUILD 7c9124a BEFORE THIS GATE EXISTED. One public descriptor's
  // bytes — proof, iep:describes, distribution link — re-served at a URL its signer never
  // named answered authorshipVerified:true, contentBinding:'bound', naming that signer,
  // with descriptorBinding {bound:false, basis:'none'} reported beside it and read by
  // nothing. contentBinding does not narrow it: the payload was lifted with the proof, so
  // the digest recomputes and matches.
  const lifted = authorshipVerdict({
    signatureValid: true,
    descriptorBinding: {
      bound: false, basis: 'none',
      note: 'the proof names <urn:iep:alice:9> and the record is served at <https://evil.example/9>',
    },
  });
  ok(
    lifted.verified === false,
    '★★ a valid signature on a proof that does not name this record is NOT verified authorship',
  );
  ok(
    /urn:iep:alice:9/.test(lifted.reason ?? '') && /evil\.example/.test(lifted.reason ?? ''),
    'and the reason carries the binding diagnostic, naming both identifiers',
  );
  ok(
    /cannot tell which/.test(lifted.reason ?? '') && /signature is intact/.test(lifted.reason ?? ''),
    '★ the reason does not state forgery as fact — a publisher that names its descriptors '
    + 'some other way reaches this verdict too, and accusing its author is how a true report '
    + 'stops being believed',
  );
  // ★★ THE HONEST-DATA DIRECTION, WITH THE NUMBERS BEHIND IT, AND THEY ARE RE-MEASURED
  // RATHER THAN RE-QUOTED. 2026-08-03: 272 pods, 1,375 descriptors, 134 proofs, 134/134
  // `slug-only`. 2026-08-04, after the owner comparison landed: 278 pods, 2,314 descriptors,
  // 633 proofs on 13 pods — every one of the 13 pods publishes a registry owner EXACTLY
  // equal to the `iep:ownerWebId` its proofs sign, so 633/633 were PREDICTED to keep binding
  // and 0 to lose it. 2026-08-05, the same 633 re-read against the DEPLOYED build carrying
  // the refusal: 633 `slug-and-owner`, 633 verified, 0 refused — the prediction, run.
  // A gate on the BASIS still refuses all of them, and so does one on the delegation chain
  // (605 of the 633 are SelfAsserted) — the fail-closed-on-live-data direction this area
  // has already shipped once.
  ok(
    authorshipVerdict({
      signatureValid: true,
      descriptorBinding: { bound: true, basis: 'slug-only', note: 'only the terminal segment matched' },
    }).verified === true,
    '★★ a slug-only binding STILL verifies — gating on basis rather than on bound refuses '
    + '633/633 live proofs',
  );
  ok(
    authorshipVerdict({
      signatureValid: true,
      descriptorBinding: { bound: true, basis: 'slug-and-owner', note: 'the serving pod publishes the same owner' },
    }).verified === true,
    '★ and the stronger URN basis verifies too — `bound` is the gate, `basis` is the grade',
  );
  ok(
    authorshipVerdict({
      signatureValid: true, descriptorBinding: { bound: true, basis: 'exact-url' },
    }).verified === true,
    'an exact-url binding verifies',
  );
  ok(
    authorshipVerdict({
      signatureValid: false, signatureReason: 'signature did not recover',
      descriptorBinding: { bound: true, basis: 'slug-only' },
    }).reason === 'signature did not recover',
    '★ a FAILED signature still reports the verifier\'s own reason — the two refusals are '
    + 'different facts and must not be flattened into one another',
  );
  ok(
    authorshipVerdict({
      signatureValid: false, descriptorBinding: { bound: false, basis: 'none' },
    }).reason === 'verification returned false',
    'and the default reason is preserved when the verifier gave none',
  );

  console.log('\n★ WHERE the bytes came from, and who that pod says it belongs to');

  // ── `podRootOfDescriptorUrl` — the ONE rule for "which pod is this" ────────────────────
  ok(
    podRootOfDescriptorUrl('http://css.railway.internal:3456/u-eth-8f3b/context-graphs/17858.ttl')
      === 'http://css.railway.internal:3456/u-eth-8f3b/',
    'the pod root of a live descriptor URL is the pod, not the container',
  );
  ok(
    podRootOfDescriptorUrl('https://css.test/alice/notes/17858.ttl') === null,
    '★ a URL that is not in the publish layout yields NO pod — matching without the '
    + '`context-graphs/` segment would call the first path segment of any URL a pod, and the '
    + 'owner of "any URL" is not a thing to compare against',
  );
  ok(
    podRootOfDescriptorUrl('not a url') === null && podRootOfDescriptorUrl('') === null,
    'and an unparseable url yields none rather than throwing out of the read path',
  );
  // ★★ THE BYPASS THE INLINE REGEX HAD. A regex over the raw request string reads the pod
  // out of the text a caller typed; `fetch` reads it out of the RESOLVED path. Traversal
  // therefore names alice's pod while serving mallory's document — which is precisely the
  // one owner that would make a lifted proof bind.
  ok(
    podRootOfDescriptorUrl('https://css.test/alice/context-graphs/../../mallory/context-graphs/9.ttl')
      === 'https://css.test/mallory/',
    '★★ a traversing URL names the pod the bytes ACTUALLY come from, not the one it opens with',
  );
  ok(
    podRootOfDescriptorUrl('https://css.test/alice/context-graphs/%2e%2e/%2e%2e/mallory/context-graphs/9.ttl')
      === 'https://css.test/mallory/',
    '★ …in the percent-encoded spelling too',
  );

  // ── `makeServingPodOwnerReader` — evidence, cached, and never an accusation ────────────
  {
    let calls = 0;
    let clock = 1_000;
    const reader = makeServingPodOwnerReader({
      readOwner: async (pod) => { calls += 1; return pod.includes('alice') ? 'https://id.test/alice#me' : null; },
      now: () => clock,
      ttlMs: 60_000,
    });
    ok(await reader('https://css.test/alice/') === 'https://id.test/alice#me', 'it reads the owner the pod publishes');
    await reader('https://css.test/alice/');
    ok(calls === 1, '★ and reads it ONCE per pod per TTL — this sits on every descriptor read', `calls=${calls}`);
    clock += 60_001;
    await reader('https://css.test/alice/');
    ok(calls === 2, '★ the TTL is real: aged out, it asks again', `calls=${calls}`);
    // ★ THE NULL IS CACHED TOO. Without it a pod with no registry pays a fetch on EVERY
    // descriptor read of it, and a null can only ever weaken a binding to `slug-only`.
    const before = calls;
    ok(await reader('https://css.test/bob/') === null, 'a pod that publishes no owner reads as null');
    await reader('https://css.test/bob/');
    ok(calls === before + 1, '★ …and the null is cached, not re-fetched', `calls=${calls}`);
  }
  {
    // ★ A THROWING REGISTRY IS `unchecked`, NOT `refused`. Failing closed on an unreachable
    // pod would turn a network blip into a wave of honest records reported as forgeries —
    // the direction this whole area has shipped a defect on before.
    const reasons: string[] = [];
    const reader = makeServingPodOwnerReader({
      readOwner: async () => { throw new Error('ECONNREFUSED'); },
      onUnavailable: (_pod, why) => reasons.push(why),
    });
    ok(await reader('https://css.test/carol/') === null, '★★ a registry read that THROWS answers null, not a refusal');
    ok(reasons.some(r => /ECONNREFUSED/.test(r)), 'and the reason is reported, so a wave of them is visible');
  }
  {
    // Two readers must not share a cache: module-level state is how one test inherits
    // another's answers and how a TTL becomes unexercisable.
    let n = 0;
    const opts = { readOwner: async () => { n += 1; return `owner-${n}`; } };
    const a = makeServingPodOwnerReader(opts);
    const b = makeServingPodOwnerReader(opts);
    ok(await a('https://css.test/x/') === 'owner-1' && await b('https://css.test/x/') === 'owner-2',
      '★ each reader owns its own cache');
  }

  console.log('\n★ the four outcomes are four, everywhere they are enumerated');

  // A value the relay can emit and a consumer coerces to something else is worse than an
  // unknown one: `readContentBinding` maps anything unrecognised to 'unbound', which would
  // relabel detected tampering as ordinary pre-binding data.
  const STREAM = readFileSync(new URL('../../../applications/shared-workspace/src/stream.ts', import.meta.url), 'utf8');
  ok(
    /raw === 'bound' \|\| raw === 'mismatched' \|\| raw === 'declared'/.test(STREAM),
    "★★ the workspace reader recognises 'mismatched' rather than flattening it to 'unbound'",
  );
  const SCHEMA_ENUM = SERVER.match(/enum: \['bound', 'mismatched', 'declared', 'unbound'\]/);
  ok(SCHEMA_ENUM !== null, 'the published get_descriptor schema advertises all four values');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
