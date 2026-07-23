import { describe, it, expect } from 'vitest';
import { isPrivateHostname, safePublicUrlOrUndefined, assertSafeFetchTarget } from '../src/ssrf-guard.js';
import { isSafeIri, iesc } from '../src/turtle-escape.js';

// ── A1 (BLOCKER): IPv4-mapped / compat / NAT64 IPv6 literals must be classified private. ──
describe('round-17 — ssrf-guard classifies IPv4-embedded IPv6 (the round-16 bypass) as private', () => {
  it('IPv4-mapped IPv6 (dotted AND hex forms) resolving to a private v4 is private', () => {
    for (const h of [
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',   // metadata (dotted + hex)
      '::ffff:127.0.0.1', '::ffff:7f00:1',            // loopback
      '::ffff:10.255.255.1', '::ffff:0aff:ff01',      // private
      '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', // bracketed (as URL.hostname yields)
      '::10.255.255.1',                                // IPv4-compatible
      '64:ff9b::169.254.169.254', '64:ff9b::a9fe:a9fe',// NAT64
    ]) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
  });
  it('IPv6 loopback / link-local / ULA / multicast are private', () => {
    for (const h of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
  });
  it('a genuinely public IPv6 (and public IPv4-mapped) is NOT private', () => {
    expect(isPrivateHostname('2606:4700:4700::1111')).toBe(false); // Cloudflare public v6
    expect(isPrivateHostname('::ffff:8.8.8.8')).toBe(false);       // mapped public v4
    expect(isPrivateHostname('::ffff:0808:0808')).toBe(false);     // same, hex
  });
  it('safePublicUrlOrUndefined drops a mapped-IPv6 internal literal', () => {
    expect(safePublicUrlOrUndefined('http://[::ffff:169.254.169.254]/')).toBeUndefined();
    expect(safePublicUrlOrUndefined('http://[::ffff:a9fe:a9fe]/')).toBeUndefined();
  });
  it('assertSafeFetchTarget rejects a mapped-IPv6 internal literal WITHOUT hanging (no DNS/connect)', async () => {
    await expect(assertSafeFetchTarget('http://[::ffff:169.254.169.254]/')).rejects.toThrow();
    await expect(assertSafeFetchTarget('http://[::ffff:127.0.0.1]/')).rejects.toThrow();
    await expect(assertSafeFetchTarget('http://[64:ff9b::a9fe:a9fe]/')).rejects.toThrow();
  });
});

// ── B1 (BLOCKER): isSafeIri validates absolute IRIs and rejects breakout chars. ──
describe('round-17 — isSafeIri rejects malformed / injection IRIs at the boundary', () => {
  it('accepts well-formed absolute IRIs', () => {
    for (const s of ['did:ethr:0x1111111111111111111111111111111111111111', 'did:key:z6Mkabc', 'urn:foxxi:agent:x', 'https://gate.interego.xwisee.com/eth-abc/']) {
      expect(isSafeIri(s), s).toBe(true);
    }
  });
  it('rejects a breakout / injection author.id and non-absolute / empty ids', () => {
    for (const s of [
      'did:key:0xVICTIM> ; <http://evil.example/pwned> <http://evil.example/forged',
      'did:key:0xEVIL> . <urn:evil2> <urn:p2> <urn:o2> . <urn:sink',
      'has a space', 'no-scheme', '', 'urn:x"quote', 'urn:x\nnewline',
    ]) {
      expect(isSafeIri(s), JSON.stringify(s)).toBe(false);
    }
  });
  it('iesc still neutralizes an injection value if one reaches a graph sink anyway', () => {
    const out = iesc('did:key:0xEVIL> . <urn:evil> <urn:p> <urn:o> . <urn:sink');
    expect(out).not.toContain('>');
    expect(out).not.toContain('<');
    expect(out).not.toContain(' ');
  });
});
