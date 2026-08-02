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
 * ★ MUTATION-CHECKED — each guard broken, the suite re-run, then reverted. Round 5 covered
 * the guards added in round 5 (the four-value binding, the prefix-position rewrite and its
 * refusal, the acceptance-count enumeration); earlier rounds' counts covered earlier
 * guards. No single number covers all of them, and a header claiming one would be the kind
 * of stale assurance this round was convened to remove. See the header of
 * tests/authorship-covers-content.test.ts for the core half of the same property.
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
  GRAPH_DIGEST_ALGORITHM,
  type IRI,
} from '@interego/core';
import { publish, fetchGraphContent, extractNamedGraphTurtle } from '@interego/solid';
import {
  observedGraphDigest,
  graphIriFromDescriptorTurtle,
  contentBindingNote,
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
  const readerDigest = observedGraphDigest({ graphContent: served, graphIri: GRAPH_IRI });
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
  const { served: servedTampered } = await publishAndServe(TAMPERED);
  const tamperedDigest = observedGraphDigest({ graphContent: servedTampered, graphIri: GRAPH_IRI });
  ok(tamperedDigest !== readerDigest, 'a one-character content change moves the digest');
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
    observedGraphDigest({ graphContent: null, graphIri: GRAPH_IRI }) === undefined,
    'an unreadable payload (encrypted to others) yields no digest rather than a digest of nothing',
  );
  ok(
    observedGraphDigest({ graphContent: served, graphIri: 'urn:graph:not-in-this-document' }) === undefined,
    'a graph IRI absent from the document yields no digest',
  );
  ok(
    observedGraphDigest({ graphContent: 'this is not turtle {{{', graphIri: GRAPH_IRI }) === undefined,
    'an unparseable payload yields no digest',
  );
  ok(
    canonicalGraphDigest('@prefix broken <<<') === null,
    'an unparseable payload digests to null, not to a hash of the empty string',
  );

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
    observedGraphDigest({ graphContent: roundTrip.served, graphIri: GRAPH_IRI })
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
    /graphIri:\s*graphIriFromDescriptorTurtle\(turtle\)/.test(SERVER),
    'the graph IRI comes from the descriptor rather than the caller-supplied URL',
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
  ok(
    /canonicalGraphDigest\(String\(args\.graph_content/.test(SERVER),
    'the publish path commits to the canonical-triples digest, not to a hash of the raw bytes',
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
