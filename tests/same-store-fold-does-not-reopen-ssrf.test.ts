/**
 * ONE STORE WITH TWO NAMES, FOLDED — WITHOUT RE-OPENING THE SSRF THE ORIGIN CHECK EXISTS FOR.
 *
 * `sign_request` stamps a caller's pod as `http://css.railway.internal:3456/u-eth-…/`; everything
 * public names the same pod `https://gate.interego.xwisee.com/u-eth-…/`. Comparisons that treated
 * those as different origins have now been wrong four times, and the fourth — `selfBoundPod` —
 * failed SILENTLY: a caller passing its own pod exactly as the relay writes it was quietly handed
 * the derived pod instead. Found by a delegate reading the published comment, not by this suite.
 *
 * ★ THE DANGEROUS FIX IS THE OBVIOUS ONE. Relaxing the origin test with a substring or suffix match
 * re-opens the exact attack it was added for: `https://gate.interego.xwisee.com.<attacker>/eth-
 * <caller12>/` shares the caller's last path segment, so a loose comparison honours the override and
 * the server-side write lands on an attacker host — SSRF, and it leaked the write bearer too.
 *
 * So the fold is an ALLOW-LIST of two exact origins read from configuration, and these assertions
 * pin both halves: the two legitimate spellings fold together, and everything else — most
 * pointedly the suffix-extension host — does not.
 */

import { describe, it, expect } from 'vitest';

const PUBLIC = 'https://gate.interego.xwisee.com';
const INTERNAL = 'http://css.railway.internal:3456';

/**
 * The shipped predicate, restated here against the same allow-list the bridge builds. `server.ts`
 * starts an HTTP listener at import so it cannot be loaded into a test process; what is pinned is
 * the RULE, and the companion source assertion below keeps the bridge on this rule.
 */
const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ''; } };
const allow = new Set([PUBLIC, INTERNAL]);
const sameStore = (a: string, b: string): boolean => {
  const oa = originOf(a); const ob = originOf(b);
  if (!oa || !ob) return false;
  if (oa === ob) return true;
  return allow.has(oa) && allow.has(ob);
};

describe('the two spellings of one store fold together', () => {
  it('the internal and public spellings of the same pod are the same store', () => {
    expect(sameStore(`${INTERNAL}/u-eth-03f52e15b9df/`, `${PUBLIC}/u-eth-03f52e15b9df/`)).toBe(true);
    expect(sameStore(`${PUBLIC}/u-eth-03f52e15b9df/`, `${INTERNAL}/u-eth-03f52e15b9df/`)).toBe(true);
  });

  it('and a URL is trivially the same store as itself', () => {
    expect(sameStore(`${PUBLIC}/a/`, `${PUBLIC}/b/`)).toBe(true);
    expect(sameStore(`${INTERNAL}/a/`, `${INTERNAL}/b/`)).toBe(true);
  });
});

describe('★ and nothing else folds — the SSRF the origin check exists for stays shut', () => {
  it('a suffix-extension of the public host is NOT the same store', () => {
    // The round-26 blocker, verbatim in shape: the attacker host ends with the real one, and under
    // a substring or endsWith test it would pass while pointing at somebody else's server.
    const attacker = 'https://gate.interego.xwisee.com.attacker.example';
    expect(sameStore(`${attacker}/eth-8f3b8e939600/`, `${PUBLIC}/eth-8f3b8e939600/`)).toBe(false);
    expect(sameStore(`${attacker}/x/`, `${INTERNAL}/x/`)).toBe(false);
  });

  it('a prefix-alike, a different port and a different scheme are all different stores', () => {
    expect(sameStore('https://gate.interego.xwisee.com.evil/x/', `${PUBLIC}/x/`)).toBe(false);
    expect(sameStore('http://css.railway.internal:9999/x/', `${INTERNAL}/x/`)).toBe(false);
    // Scheme is part of an origin, and http:// to a public host is not the https:// store.
    expect(sameStore('http://gate.interego.xwisee.com/x/', `${PUBLIC}/x/`)).toBe(false);
  });

  it('an unparseable side is never the same store, so it fails closed', () => {
    expect(sameStore('not a url', `${PUBLIC}/x/`)).toBe(false);
    expect(sameStore(`${PUBLIC}/x/`, '')).toBe(false);
  });
});

describe('the bridge uses this rule rather than a second copy of it', () => {
  it('both origin comparisons go through sameStore, and the allow-list is exact equality', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
    ), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

    // The two sites that used to compare raw origins.
    expect(code.some((l) => /const sameOrigin = sameStore\(/.test(l)), 'selfBoundPod').toBe(true);
    expect(code.some((l) => /if \(!sameStore\(pod, tenantPodUrl\)\)/.test(l)), 'enrolmentOriginCheck').toBe(true);

    // ★ Membership, never a substring test — the whole safety argument.
    const fn = src.slice(src.indexOf('function sameStore'));
    const bodyText = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(bodyText).toMatch(/SAME_STORE_ORIGINS\.has\(oa\)\s*&&\s*SAME_STORE_ORIGINS\.has\(ob\)/);
    expect(bodyText, 'must not loosen with a substring/suffix test').not.toMatch(/endsWith|includes\(/);

    // And the silent fallback now reports itself.
    expect(code.some((l) => /pod override ignored for/.test(l)), 'selfBoundPod must log the fallback').toBe(true);
  });
});
