/**
 * THE RELAY'S DECRYPTION KEY WAS HANDED OUT ON A PATH-PREFIX TEST.
 *
 * `relayAgentKey` is ONE process-wide X25519 keypair that every graph published here is encrypted
 * to. The gate deciding whether to apply it was one line in server.ts:
 *
 *     toInternalPodUrl(target).startsWith(toInternalPodUrl(own))
 *
 * and `toInternalPodUrl` DISCARDS the host — it pastes the path onto our own store. So both sides
 * of that comparison were caller-controlled. A victim's ciphertext is public bytes: copy it, serve
 * it from your own host at `/eth-<your-own-12hex>/anything.jose.json`, ask the relay to read it,
 * and it decrypts somebody else's private graph for you. Same class as the unauth decryption oracle
 * closed in the round-26 audit, at a site that fix never reached.
 *
 * ── ★★★ THIS FILE EXISTS IN ITS SECOND FORM, AND THE FIRST ONE IS THE LESSON ────────────────
 *
 * Version one RESTATED the gate locally, because `server.ts` starts an HTTP listener at import and
 * cannot be loaded into a test process. A hostile reviewer reverted `server.ts` to the vulnerable
 * code and ran it: nine of twelve assertions PASSED, including the headline "an attacker-hosted
 * copy of somebody else's ciphertext gets no key". They were exercising the restatement. A gate
 * whose test cannot fail when the gate is removed is not a gate, and I wrote one while quoting the
 * rule about not doing that.
 *
 * So the rule moved into `deploy/mcp-relay/relay-key-gate.ts` — importable, and therefore the thing
 * under test. Every behavioural assertion below runs the SHIPPED function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayUseRelayKey } from '../deploy/mcp-relay/relay-key-gate.js';

const INTERNAL = 'http://css.railway.internal:3456';
const PUBLIC = 'https://gate.interego.xwisee.com';
/** Both spellings configured, as production is (CSS_URL + CSS_PUBLIC_URL). */
const BOTH: ReadonlySet<string> = new Set([INTERNAL, PUBLIC]);
/** CSS_PUBLIC_URL unset — CSS_PUBLIC_URL defaults to CSS_URL, so the set collapses to one. */
const INTERNAL_ONLY: ReadonlySet<string> = new Set([INTERNAL]);

const OWN = `${INTERNAL}/eth-aaaaaaaaaaaa/`;
const may = (targetUrl: string, storeOrigins: ReadonlySet<string> = BOTH, ownPodUrl = OWN): boolean =>
  mayUseRelayKey({ targetUrl, ownPodUrl, storeOrigins });

describe('★★ the decryption oracle stays shut', () => {
  it('an attacker-hosted copy of somebody else\'s ciphertext gets no key', () => {
    // The exploit verbatim: the PATH begins with the caller's own pod segment, so a path-only
    // comparison says "yours". The bytes are the victim's, copied from their public pod.
    expect(may('https://attacker.example/eth-aaaaaaaaaaaa/stolen.envelope.jose.json')).toBe(false);
  });

  it('and neither does any other host, however our-looking', () => {
    for (const host of [
      'https://gate.interego.xwisee.com.attacker.example',
      'https://css.railway.internal.attacker.example',
      'http://css.railway.internal:9999',
      'https://gate.interego.xwisee.com@attacker.example',
      'http://169.254.169.254',
      'https://evil.example',
    ]) expect(may(`${host}/eth-aaaaaaaaaaaa/x.jose.json`), host).toBe(false);
  });

  it('a pod whose segment merely BEGINS with the caller\'s gets no key', () => {
    // Without the trailing-slash boundary `eth-aaaaaaaaaaaa` is a prefix of
    // `eth-aaaaaaaaaaaabbbb`, and a different principal's pod reads as the caller's own.
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaabbbb/x.jose.json`)).toBe(false);
  });

  it('★ an ENCODED separator is refused, because URL normalisation does not resolve it', () => {
    // Measured: `new URL()` resolves `../` and `%2E%2E/` but leaves `..%2f` as one segment, which
    // passes a prefix test and is a traversal again wherever the far end decodes it.
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/..%2feth-victim000000/secret.jose.json`)).toBe(false);
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/..%5ceth-victim000000/secret.jose.json`)).toBe(false);
  });

  it('and a resolvable traversal cannot climb out either', () => {
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/../eth-victim000000/x.jose.json`)).toBe(false);
  });

  it('a caller with no pod segment is never "inside its own pod"', () => {
    expect(may(`${INTERNAL}/anything/x.jose.json`, BOTH, `${INTERNAL}/`)).toBe(false);
  });
});

describe('★ and the capability survives, or the patch is a denial of service', () => {
  it('the caller\'s own ciphertext decrypts, in either spelling of one store', () => {
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/note.jose.json`)).toBe(true);
    expect(may(`${PUBLIC}/eth-aaaaaaaaaaaa/note.jose.json`), 'the URL users are actually given').toBe(true);
  });

  it('★★ but ONLY when the public spelling is configured — the regression this nearly shipped', () => {
    // `STORE_ORIGINS` is built from CSS_URL and CSS_PUBLIC_URL. With CSS_PUBLIC_URL unset the set
    // collapses to the internal origin alone, and a caller addressing its OWN pod by the public
    // URL it was handed is refused its OWN key — with an error that blames recipient membership
    // rather than configuration. The code and the deploy descriptor land together or not at all.
    expect(may(`${PUBLIC}/eth-aaaaaaaaaaaa/note.jose.json`, INTERNAL_ONLY)).toBe(false);
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/note.jose.json`, INTERNAL_ONLY), 'internal still works').toBe(true);
  });

  it('garbage in either position is refused rather than thrown over', () => {
    expect(may('not a url')).toBe(false);
    expect(may(`${INTERNAL}/eth-aaaaaaaaaaaa/x`, BOTH, 'not a url')).toBe(false);
  });
});

describe('the relay uses this gate, and screens the RAW target', () => {
  const src = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'mcp-relay', 'server.ts',
  ), 'utf8');
  const body = (name: string): string => {
    const at = src.indexOf(name);
    expect(at, `${name} not found`).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', at);
    return src.slice(at, end < 0 ? src.length : end + 3);
  };

  it('recipientKeyFor delegates to the importable gate rather than restating it', () => {
    const fn = body('async function recipientKeyFor');
    expect(fn).toMatch(/mayUseRelayKey\(\{ targetUrl, ownPodUrl: own, storeOrigins: STORE_ORIGINS \}\)/);
  });

  it('★ and hands it the RAW targetUrl — never the laundered one', () => {
    // The first fix screened `new URL(toInternalPodUrl(targetUrl))`, i.e. the value AFTER the
    // attacker's host had been rewritten to ours. The origin check could then only ever see our
    // own origin and passed everything. A check downstream of the laundering is decoration.
    const fn = body('async function recipientKeyFor');
    expect(fn, 'the gate must not be fed through toInternalPodUrl').not.toMatch(/toInternalPodUrl/);
  });

  it('STORE_ORIGINS is exact-origin membership, never a prefix test', () => {
    const at = src.indexOf('const STORE_ORIGINS');
    const decl = src.slice(at, src.indexOf(');', at) + 2);
    expect(decl).toMatch(/new URL\(u\)\.origin/);
    expect(decl).not.toMatch(/startsWith|endsWith|includes\(/);
  });

  it('★★ and toInternalPodUrl still CLAMPS, because that clamp is load-bearing elsewhere', () => {
    // Reverted deliberately after review. `canonicalPodKey` discards the host too and is the sole
    // comparator in `requireOwnPod` and the read_inbox gate; those gates are survivable only
    // because every consumer then forces the target back onto our store before fetching. Letting a
    // foreign origin through here would hand `solidFetch` — the UNSCREENED pool — an authenticated
    // GET at a caller-chosen host with the body reflected, and a GET+PUT+DELETE at another.
    const fn = body('function toInternalPodUrl');
    expect(fn).toMatch(/\$\{CSS_URL\.replace\(\/\\\/\$\/, ''\)\}\$\{new URL\(url\)\.pathname\}/);
    expect(fn, 'do not make this origin-aware without fixing canonicalPodKey and the fetch sites')
      .not.toMatch(/STORE_ORIGINS/);
  });
});

describe('the deploy descriptor configures the public spelling', () => {
  it('the relay service sets CSS_PUBLIC_URL', () => {
    // Without this the set above collapses and own-pod decryption by public URL breaks — a silent
    // functional regression that the code alone cannot prevent.
    const services = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'railway', 'services.json',
    ), 'utf8');
    const parsed = JSON.parse(services) as Record<string, unknown>;
    const flat = JSON.stringify(parsed);
    expect(flat, 'CSS_PUBLIC_URL must be declared for the relay').toMatch(/CSS_PUBLIC_URL/);
  });
});
