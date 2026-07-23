/**
 * Round-23: the substrate agent-registry serializer (ownerProfileToTurtle) must escape
 * caller-controlled IRIs (webId, agentId) and literals (name, label, encryptionPublicKey).
 * A self-registering agent's fields flow into this hand-built Turtle written to the pod, so
 * an unescaped `>` / `"` broke out of `<...>` / `"..."` and injected triples into the
 * published agent registry (the round-22 audit found the same injection class here as in
 * the descriptor serializer + solid client).
 */

import { describe, it, expect } from 'vitest';
import { createOwnerProfile, addAuthorizedAgent, ownerProfileToTurtle, type IRI } from '@interego/core';

describe('round-23 — ownerProfileToTurtle escapes injected agent-registry IRIs + literals', () => {
  it('an injected agentId/webId cannot break out of <...>, and a quote in a label cannot break out of the literal', () => {
    const INJ_WEBID = 'https://pod.example/x> <urn:evil-s> <urn:evil-p> <urn:evil-o> . <urn:sink' as IRI;
    const INJ_AGENT = 'did:key:zEVIL> <urn:ap> <urn:ao> . <urn:z' as IRI;
    let profile = createOwnerProfile(INJ_WEBID, 'Owner" ; <urn:s> <urn:p> <urn:o> . "Name');
    profile = addAuthorizedAgent(profile, {
      agentId: INJ_AGENT,
      scope: 'ReadWrite',
      label: 'Agent" . <urn:evil2> <urn:p2> <urn:o2> . "',
      validFrom: '2026-01-01T00:00:00Z',
      encryptionPublicKey: 'AAAA" ; <urn:k> <urn:v> "',
      revoked: false,
    } as Parameters<typeof addAuthorizedAgent>[1]);

    const ttl = ownerProfileToTurtle(profile);

    // IRI-POSITION injections (webId, agentId) must not survive as bare <...> terms — the '>'
    // is percent-encoded so the injected predicates/objects can't break out of the IRIREF.
    for (const t of ['<urn:evil-p>', '<urn:evil-o>', '<urn:ap>', '<urn:ao>']) {
      expect(ttl.includes(t), t).toBe(false);
    }
    expect(ttl.includes('%3E')).toBe(true); // injected '>' is encoded

    // LITERAL-POSITION injection (name/label): the injected `<urn:evil2>` etc. may appear as
    // INERT TEXT inside a quoted literal, but must NOT break out — every " in a literal value
    // is backslash-escaped, so there is no `"…" ; <bare-triple>` or `"…" . <bare-triple>`.
    expect(/foaf:name "[^"\\]*"\s*[;.]\s*</.test(ttl)).toBe(false);
    expect(ttl.includes('\\"')).toBe(true); // the quote in the label is escaped
  });
});
