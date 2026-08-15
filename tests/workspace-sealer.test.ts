/**
 * SEALING BEFORE ANYTHING LEAVES THE PROCESS — AND THE THREE EQUIVALENCES IT MUST PRESERVE.
 *
 * Moving the encryption from the relay to the client is only safe if what the relay used to do
 * with the plaintext still happens somewhere. Three of those are equivalences a test can pin, and
 * each of them fails SILENTLY if it drifts:
 *
 *   · the sealed-then-opened bytes must yield the same graph a reader gets today, or every reader
 *     sees an empty workspace;
 *   · the digest must be one a READER can reproduce, or every content binding reads `mismatched`
 *     and members start being told their own messages were tampered with;
 *   · the cleartext mirror must reproduce what the relay lifts out of the plaintext, or every
 *     entry becomes its own head and the chain forks with nothing reporting it.
 */

import { describe, it, expect } from 'vitest';
import { canonicalGraphDigest, deriveEncryptionKeyPair, normalizePublishInputs, openEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import { extractNamedGraphTurtle } from '@interego/solid';
import { mirrorTurtleFor, sealForRoster } from '../packages/workspace-client/src/sealer.js';

const A = deriveEncryptionKeyPair('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const B = deriveEncryptionKeyPair('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const STRANGER = deriveEncryptionKeyPair('0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356');

const GRAPH = 'https://relay.example/ns/u-a/wsp-stream';
/**
 * ★ THE PREFIXED FORM, BECAUSE THAT IS WHAT THE REAL WRITERS EMIT AND WHAT THE RELAY MATCHES.
 * `extractIRIList` regexes the literal string `iep:supersedes`; a fixture written with the full
 * IRI is semantically identical Turtle the extractor cannot see, so the mirror test would compare
 * an extraction that found nothing against another that found nothing, and pass proving nothing.
 */
const PREFIXES = '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n';
const PAYLOAD = PREFIXES + '<' + GRAPH + '/e/1> dct:description "the words" ;\n'
  + '  iep:supersedes <https://css.example/u-a/prior.ttl> .';

describe('★★ the three equivalences', () => {
  it('sealed then opened yields the graph a reader reads today', () => {
    const out = sealForRoster({ graphIri: GRAPH, payloadTurtle: PAYLOAD, recipientKeys: [A.publicKey, B.publicKey], sender: A });
    expect(out.ok, out.ok ? '' : out.why).toBe(true);
    if (!out.ok) return;

    const opened = openEncryptedEnvelope(JSON.parse(out.graphContent) as EncryptedEnvelope, B);
    expect(opened, 'B is a recipient and must be able to open it').not.toBeNull();
    // ★ Through `extractNamedGraphTurtle`, which is the inverse every reader already uses. A seal
    // that produced bytes this cannot invert would open fine and still render nothing.
    const region = extractNamedGraphTurtle(opened ?? '', GRAPH);
    expect(region, 'the opened bytes are not a TriG naming this graph').not.toBeNull();
    expect(region).toContain('the words');
  });

  it('★★ the digest is one a READER can reproduce from what it opened', () => {
    /**
     * The relay signs authorship over this value without being able to check it. If the publisher
     * hashes different bytes from the ones a reader reconstructs, every entitled reader computes
     * `mismatched` — the system telling members their own messages were tampered with, forever,
     * with the signature technically valid.
     */
    const out = sealForRoster({ graphIri: GRAPH, payloadTurtle: PAYLOAD, recipientKeys: [A.publicKey], sender: A });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const opened = openEncryptedEnvelope(JSON.parse(out.graphContent) as EncryptedEnvelope, A) ?? '';
    const asReaderSeesIt = extractNamedGraphTurtle(opened, GRAPH) ?? '';
    expect(canonicalGraphDigest(asReaderSeesIt)).toBe(out.contentDigest);
    expect(out.contentDigest, 'an empty digest would compare equal to another empty one').not.toBe('');
  });

  it('★★ the mirror reproduces exactly what the relay lifts from the same plaintext', () => {
    /**
     * The failure this prevents is the quietest in the whole feature. `normalizePublishInputs`
     * pulls `iep:supersedes` out of the payload and into the descriptor; give the relay ciphertext
     * and it finds nothing, so every entry declares no predecessor, every entry is a head, and
     * `orderChain` reports a fork. Nothing errors. The channel just stops being a chain.
     */
    const fromPlaintext = normalizePublishInputs({ graphContent: PAYLOAD });
    const mirror = mirrorTurtleFor(PAYLOAD, GRAPH);
    expect(mirror.ok).toBe(true);
    if (!mirror.ok) return;

    const fromMirror = normalizePublishInputs({ graphContent: mirror.turtle });
    expect(fromMirror.supersedes).toEqual(fromPlaintext.supersedes);
    expect(fromMirror.wasDerivedFrom).toEqual(fromPlaintext.wasDerivedFrom);
    expect(fromMirror.conformsTo).toEqual(fromPlaintext.conformsTo);
    // Non-vacuity: this payload really does assert a supersession, so the comparison has teeth.
    expect(fromPlaintext.supersedes.length).toBeGreaterThan(0);
  });
});

describe('★ addressed, not merely encrypted', () => {
  it('a member opens it and a stranger does not', () => {
    const out = sealForRoster({ graphIri: GRAPH, payloadTurtle: PAYLOAD, recipientKeys: [A.publicKey, B.publicKey], sender: A });
    if (!out.ok) throw new Error(out.why);
    const envelope = JSON.parse(out.graphContent) as EncryptedEnvelope;

    expect(openEncryptedEnvelope(envelope, B)).not.toBeNull();
    expect(openEncryptedEnvelope(envelope, STRANGER)).toBeNull();
    // And the recipient list is exactly what was asked for — nobody was added.
    expect(envelope.wrappedKeys.map((w) => w.recipientPublicKey).sort())
      .toEqual([A.publicKey, B.publicKey].sort());
  });

  it('★★ refuses to seal to nobody', () => {
    // An envelope with no recipients is not "more private" — it is unreadable by everyone
    // including its author, permanently, and it publishes successfully.
    const out = sealForRoster({ graphIri: GRAPH, payloadTurtle: PAYLOAD, recipientKeys: [], sender: A });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('no_recipients');
  });
});

describe('★ what the relay can no longer check, checked here instead', () => {
  const SHAPE = '@prefix sh: <http://www.w3.org/ns/shacl#> .\n'
    + '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<urn:shape:entry> a sh:NodeShape ;\n'
    + '  sh:targetSubjectsOf dct:description ;\n'
    + '  sh:property [ sh:path dct:description ; sh:minCount 1 ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ] .';

  it('refuses a payload that violates the workspace shape, BEFORE sealing', () => {
    const bad = PREFIXES + '<' + GRAPH + '/e/2> dct:description 42 .';
    const out = sealForRoster({
      graphIri: GRAPH, payloadTurtle: bad, recipientKeys: [A.publicKey], sender: A,
      shape: { iri: 'urn:shape:entry', turtle: SHAPE },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('shape_violation');
  });

  it('★ and passes a conforming one, so the gate is not refusing everything', () => {
    const out = sealForRoster({
      graphIri: GRAPH, payloadTurtle: PAYLOAD, recipientKeys: [A.publicKey], sender: A,
      shape: { iri: 'urn:shape:entry', turtle: SHAPE },
    });
    expect(out.ok, out.ok ? '' : out.why).toBe(true);
  });
});

describe('★★ what it refuses to carry rather than drop', () => {
  it('a revocation condition, because the mirror cannot yet express one', () => {
    /**
     * Dropping it would publish a claim whose retirement condition had evaporated — the record
     * outliving the thing meant to retire it, with nothing saying so. No workspace document emits
     * one today; a vertical that starts to must extend the mirror rather than find this out later.
     */
    const withRevocation = PAYLOAD + '\n<' + GRAPH + '> iep:revokedIf [\n'
      + '  iep:successorQuery "ASK { ?s ?p ?o }" ] .';
    const out = sealForRoster({ graphIri: GRAPH, payloadTurtle: withRevocation, recipientKeys: [A.publicKey], sender: A });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('unmirrorable');
      expect(out.why).toContain('cannot be retired');
    }
  });
});
