/**
 * Whose pod is it — the resolver that decides every self-sovereign read and write.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * The agent self-enrolment path shipped, and the live abuse test written to attack it found that
 * EVERY agent enrolling itself enrolled the shared Foxxi tenant pod instead. Cause: the signature
 * layer returns the recovered ADDRESS, the resolver only understood `did:ethr:<addr>`, and an
 * unrecognized identity form fell through to the tenant-pod FALLBACK rather than failing. So the
 * first caller poisoned the projector's sweep set with the tenant pod, and every caller after was
 * answered `alreadyEnrolled: true` while its own pod was read by nothing — the same invisible state
 * the enrolment path was built to remove.
 *
 * It was untestable where it lived (private to a 7,700-line server module that listens on import),
 * which is most of why it went unnoticed. These tests pin the fallback: a resolver that answers a
 * SHARED pod for an identity it does not recognize must be caught by a test, not by production.
 */

import { describe, it, expect } from 'vitest';
import { resolveSubjectPodUrlPure } from '../src/subject-pod-url.js';
import { safePublicUrlOrUndefined } from '../src/ssrf-guard.js';

const TENANT = 'https://gate.example.test/foxxi/';
const resolve = (identity: string | undefined, explicit?: string): string =>
  resolveSubjectPodUrlPure({ tenantPodUrl: TENANT, identity, explicit, safeUrl: safePublicUrlOrUndefined });

describe('subject pod resolution — the identity forms that must NOT land on the tenant pod', () => {
  it('★ a bare 0x address resolves to its own pod, not the shared tenant pod', () => {
    const addr = '0x2c3ec2978973680f890c0609c6a8cee382f3c80c';
    expect(resolve(addr)).toBe('https://gate.example.test/eth-2c3ec2978973/');
    expect(resolve(addr)).not.toBe(TENANT);
  });

  it('a bare address and its did:ethr spelling resolve to the SAME pod', () => {
    const addr = '0x3f9f70225074408cdbaac2866881d844abf96236';
    expect(resolve(addr)).toBe(resolve(`did:ethr:${addr}`));
  });

  it('an address without the 0x prefix, and mixed case, resolve identically', () => {
    const lower = '2c3ec2978973680f890c0609c6a8cee382f3c80c';
    expect(resolve(lower)).toBe('https://gate.example.test/eth-2c3ec2978973/');
    expect(resolve(lower.toUpperCase())).toBe('https://gate.example.test/eth-2c3ec2978973/');
  });

  it('a did:ethr identity resolves to its eth- pod', () => {
    expect(resolve('did:ethr:0x8f3b8e9396001111222233334444555566667777'))
      .toBe('https://gate.example.test/eth-8f3b8e939600/');
  });

  it('an embedded agent pod id wins over path-segment derivation', () => {
    // An identity-service WebID must map to the agent id, not to "users".
    expect(resolve('https://id.example.test/users/u-pk-00181cd5dbee/profile#me'))
      .toBe('https://gate.example.test/u-pk-00181cd5dbee/');
    expect(resolve('did:web:example.test:agents:codex-u-pk-b03a054d6915'))
      .toBe('https://gate.example.test/u-pk-b03a054d6915/');
  });

  it('a WebID with no embedded pod id resolves to its account root', () => {
    expect(resolve('https://id.example.test/jliu/profile#me')).toBe('https://id.example.test/jliu/');
  });

  it('only a genuinely unresolvable identity falls back to the tenant pod', () => {
    expect(resolve(undefined)).toBe(TENANT);
    expect(resolve('')).toBe(TENANT);
    expect(resolve('   ')).toBe(TENANT);
    // Too short to be an address, no pod id, not a URL — nothing to derive from.
    expect(resolve('0xdeadbeef')).toBe(TENANT);
  });
});

describe('subject pod resolution — the explicit override is an SSRF choke point', () => {
  it('a safe public override is honoured, canonicalized to a single-segment pod root', () => {
    expect(resolve('did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', 'https://pod.example.test/mine/sub/deeper'))
      .toBe('https://pod.example.test/mine/');
  });

  it('★ a multi-segment override collapses to its FIRST segment', () => {
    // Returning it verbatim let a caller pass a last-segment actor check while a first-segment
    // consumer acted on a different segment — a cross-agent write.
    expect(resolve('did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c', 'https://pod.example.test/eth-victim/eth-2c3ec2978973/'))
      .toBe('https://pod.example.test/eth-victim/');
  });

  it('★ a private or loopback override is IGNORED, and the identity is used instead', () => {
    const addr = 'did:ethr:0x2c3ec2978973680f890c0609c6a8cee382f3c80c';
    const own = 'https://gate.example.test/eth-2c3ec2978973/';
    for (const bad of [
      'http://127.0.0.1/pod/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/pod/',
      'http://localhost:3000/pod/',
      'file:///etc/passwd',
      'not-a-url',
    ]) {
      expect(resolve(addr, bad)).toBe(own);
    }
  });

  it('an override cannot smuggle the tenant pod onto an unresolvable identity', () => {
    // No identity to derive from, so the override is all there is — it must still be a safe public
    // target, and must still collapse to a pod root.
    expect(resolve(undefined, 'http://127.0.0.1/foxxi/')).toBe(TENANT);
  });
});
