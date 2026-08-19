/**
 * ONE POD, TWO SPELLINGS — AND A SELF-READ MUST SURVIVE BOTH.
 *
 * `sign_request` overwrites `subject_pod_url` from the caller's session and writes the CSS-INTERNAL
 * host, `http://css.railway.internal:3456/u-eth-…/`. Everything derived from an identity yields the
 * PUBLIC one, `https://gate.interego.xwisee.com/u-eth-…/`. They are the same pod.
 *
 * ★ THE REGRESSION THIS PINS. When `isSelf` moved from comparing DIDs to comparing the pod actually
 * being read — the right move, it closed a privacy bypass — the comparison was written as a string
 * match on the two URLs. A caller reading its OWN record therefore failed the match, `isSelf` came
 * out false, the privacy gate ran, the subject classified human, and the caller got
 * "you may only review your own" about the record it was already reading.
 *
 * Found by a live delegate, not by this suite. It ran four variants — its own pod with and without
 * `subject_did`, another agent's pod, and a DID that does not exist — and reported four
 * byte-identical 403s. That a NON-EXISTENT subject answered the same as a real one is what named
 * the fault: the refusal was landing before anything about the subject could matter.
 *
 * Same class as the twin-spelling trap in the classifier (`eth-` vs `u-eth-` for one wallet) and the
 * internal-host mismatch that tripped the SSRF guard on the CLR wallet read. An identifier with two
 * legitimate spellings must be compared on the part that identifies somebody, never on the bytes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
);
const src = readFileSync(SERVER, 'utf8');

/** A named function's body, signature to closing brace — not a fixed-size window. */
function body(name: string): string {
  const at = src.indexOf(name);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  return end < 0 ? rest : rest.slice(0, end + 3);
}

describe('a self-read is decided on the pod, not on the spelling of its URL', () => {
  it('readIsSelf reduces both sides to a pod principal before comparing', () => {
    const fn = body('function readIsSelf');
    expect(fn, 'must fold both sides through podPrincipalKey').toMatch(/podPrincipalKey\([\s\S]*podPrincipalKey\(/);
    // The regression, exactly: two URLs compared after nothing but a trailing-slash/case tidy.
    expect(fn, 'must not compare whole URLs').not.toMatch(/norm\(ownPod\)\s*===\s*norm\(/);
  });

  it('and fails closed when either side is not reducible to a pod', () => {
    const fn = body('function readIsSelf');
    // A URL that names no pod must not compare equal to another that names no pod — otherwise two
    // unreadable identities would "match" and every such read would be treated as a self-read.
    expect(fn).toMatch(/!==\s*null/);
  });

  it('★ podPrincipalKey folds the two spellings that actually occur', () => {
    const fn = body('const podPrincipalKey');
    // Last path segment, so host and scheme cannot enter the comparison at all.
    expect(fn, 'must take the final path segment').toMatch(/split\('\/'\)\.pop\(\)/);
    // `eth-<hex>` and `u-eth-<hex>` are one wallet — own-pod.ts derives the first, the identity
    // service the second.
    expect(fn, "must fold the 'u-' prefix").toMatch(/replace\(\/\^u-\/, ''\)/);
  });

  it('the caller side is derived from the proved identity, never from the request', () => {
    const fn = body('function readIsSelf');
    // The whole point of the original fix: a caller-supplied field must not decide an authority
    // outcome. Folding spellings must not smuggle the request back into the caller's side.
    expect(fn).toMatch(/resolveSubjectPodUrl\(opts\.callerDid, undefined\)/);
  });
});
