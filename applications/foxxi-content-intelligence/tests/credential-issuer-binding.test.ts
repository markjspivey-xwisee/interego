/**
 * A credential may only be issued by the party that signed for it.
 *
 * ★ WHY THIS FILE EXISTS. `/agent/prove-competency` derived its BBS+ issuer seed
 * from a caller-supplied `issuer_did`. Two things were confirmed against the
 * deployed bridge:
 *
 *   1. A wallet minted seconds earlier, with an empty learning record, obtained a
 *      credential asserting Expert proficiency in "Neurosurgical Anastomosis", and
 *      /agent/verify-presentation returned verified: true.
 *
 *   2. Two UNRELATED holders both naming issuer_did = did:web:acme-id.interego...
 *      received credentials signed by the SAME derived key. Anyone could therefore
 *      mint a credential that verifies against the key a named authority's
 *      credentials are signed with — and a verifier doing the correct thing, pinning
 *      the issuer key, would accept it.
 *
 * The sibling surface was already hardened against the claim half of this ("the old
 * default 'Intermediate' let an agent claim any proficiency"), but the hardening
 * landed on one of two routes and the affordance manifest pointed at the other.
 *
 * These are SOURCE assertions on purpose. A live check cannot run in a pull request
 * that has not deployed yet, and the property worth protecting — "the issuer is the
 * signer, and it is not reachable from the request" — is visible in the source. That
 * is also the layer that would have caught it originally.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const affordances = readFileSync(join(ROOT, 'affordances.ts'), 'utf8');
const proof = readFileSync(join(ROOT, 'src', 'competency-proof.ts'), 'utf8');

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\ncredential issuance: the issuer is the signer, never a request field');

// ── 1. The forgery vector itself ───────────────────────────────────────────
// The seed must never be derived from a value the caller supplies.
const proveRoute = server.slice(
  server.indexOf("app.post('/agent/prove-competency'"),
  server.indexOf("app.post('/agent/verify-presentation'"),
);
check('the prove-competency route exists', proveRoute.length > 0);
check('the issuer seed is NOT derived from a caller-supplied issuer_did',
  !/creator:\$\{\s*issuerDid\s*\}/.test(proveRoute) || /const issuerDid = holderDid/.test(proveRoute),
  'issuerSeed must derive from the authenticated signer');
check('issuerDid is bound to the authenticated holder',
  /const issuerDid = holderDid/.test(proveRoute));
check('naming a different issuer is refused, not silently accepted',
  /namedIssuer !== holderDid/.test(proveRoute) && /403/.test(proveRoute));
check('score is not read from the request payload',
  !/p\.score/.test(proveRoute), 'caller-asserted score was the unearned-credential half');
check('proficiency is not read from the request payload',
  !/p\.proficiency/.test(proveRoute));

// ── 2. A self-issued credential must say so ────────────────────────────────
// Selective disclosure proves integrity, not merit. If the result does not carry
// that distinction, a relying party cannot tell a self-assertion from an
// authority's attestation — which is how the forgery would have been believed.
check('the result declares itself self-issued', /selfIssued: true/.test(proveRoute));
check('the result declares trustLevel SelfAsserted', /trustLevel: 'SelfAsserted'/.test(proveRoute));
check('the result states the claims are not grounded in a record',
  /claimsGroundedInRecord: false/.test(proveRoute));
check('the result names the grounded alternative', /groundedAlternative/.test(proveRoute));

// ── 3. The DISCOVERABLE path must be the grounded one ──────────────────────
// An agent that follows published affordances is following the contract of this
// system. Pointing that contract at the weaker route made the safe implementation
// the one nobody could find.
const proveAff = affordances.slice(
  affordances.indexOf("toolName: 'foxxi.prove_competency'"),
  affordances.indexOf("toolName: 'foxxi.prove_competency'") + 4000,
);
check('the published affordance targets the grounded route',
  /targetTemplate: '\{base\}\/foxxi\/prove_competency'/.test(proveAff),
  'must not point at /agent/prove-competency');
check('the affordance no longer advertises score/proficiency as inputs',
  !/score\?, proficiency\?/.test(proveAff));

// ── 4. The grounded route keeps its grounding ──────────────────────────────
check('the grounded handler refuses an undemonstrated competency',
  /you can only prove a demonstrated competency, not a claimed one/.test(server));
check('the grounded handler derives proficiency from the record, not the caller',
  /Derived from the record, not the caller/.test(server));

// ── 5. A proof a third party can actually check ────────────────────────────
// proofB64 was documented as "an external verifier can re-check it". It cannot:
// BBS+ verification needs the disclosed messages, their indexes, and the issuer
// public key. So the grounded proof was, in practice, verifiable only by the
// bridge that minted it — while foxxi.verify_presentation's description told
// callers to feed it exactly this output.
check('prove_competency returns a full serialized presentation',
  /presentation: \{/.test(proof) && /disclosedIndexes/.test(proof) && /issuerPublicKey/.test(proof));
check('the misleading "external verifier can re-check it" claim is gone',
  !/opaque; an external verifier can re-check it/.test(proof));
check('dropped reveal paths are reported rather than silently ignored',
  /unknownRevealPaths/.test(proof));

// ── 6. Context binding survives the round trip ─────────────────────────────
// A presentation derived with a context is bound to it; verification must
// reconstruct the same header or every context-bound proof fails with a bare
// "proof did not verify" that blames the crypto.
const verifyRoute = server.slice(server.indexOf("app.post('/agent/verify-presentation'"));
check('the verifier reconstructs presentationHeader from presentationContext',
  /presentationHeader: new TextEncoder\(\)\.encode\(String\(pr\.presentationContext\)\)/.test(verifyRoute));

// ── 7. No caller may re-introduce the pattern ──────────────────────────────
// The demo scripts drove the vulnerable shape, so they are part of the surface.
for (const rel of [
  'tools/killer-demos-feasibility.ts',
  'tools/demo-roadmap-proof.ts',
  'tools/capture-landing-tour.ts',
  'microsite-app/src/demo/ceremonies.ts',
  'microsite-app/src/demo/agent-tools.ts',
]) {
  const body = readFileSync(join(ROOT, ...rel.split('/')), 'utf8');
  const calls = body.split('\n').filter(l => l.includes('/agent/prove-competency') && l.includes('issuer_did'));
  check(`${rel} does not name a foreign issuer`, calls.length === 0, calls[0]?.trim().slice(0, 100));
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nThe issuer is the signer. Selective disclosure proves integrity, not merit.\n');
