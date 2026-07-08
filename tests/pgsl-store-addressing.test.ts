import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  publicAtomAddress,
  privateAtomAddress,
  atomAddress,
  nodeAddrFromUrn,
  urnFromNodeAddr,
} from '../packages/pgsl-store/src/addressing.js';

describe('pgsl-store: atom addressing — public/private dedup split (existence-oracle mitigation)', () => {
  it('public address is the canonical bare-hash urn, wire-compatible with @interego/pgsl atomUri', () => {
    const expected =
      'urn:pgsl:atom:' + createHash('sha256').update('atom:hello').digest('hex').slice(0, 40);
    expect(publicAtomAddress('hello')).toBe(expected);
    expect(publicAtomAddress('hello')).toMatch(/^urn:pgsl:atom:[0-9a-f]{40}$/);
  });

  it('public dedups globally: same value -> same address', () => {
    expect(publicAtomAddress('123-45-6789')).toBe(publicAtomAddress('123-45-6789'));
  });

  it('private dedups WITHIN a tenant but NOT across tenants', () => {
    const v = '123-45-6789';
    expect(privateAtomAddress(v, 'tenantA-key')).toBe(privateAtomAddress(v, 'tenantA-key'));
    expect(privateAtomAddress(v, 'tenantA-key')).not.toBe(privateAtomAddress(v, 'tenantB-key'));
  });

  it('closes the existence oracle: a private atom does NOT live at its public bare-hash address', () => {
    const v = '123-45-6789';
    // The only address an attacker without the tenant key can compute is the public one.
    expect(privateAtomAddress(v, 'tenantA-key')).not.toBe(publicAtomAddress(v));
  });

  it('private addressing requires a tenant key', () => {
    expect(() => atomAddress('x', { sensitivity: 'private' })).toThrow();
    expect(() => privateAtomAddress('x', '')).toThrow();
  });

  it('atomAddress dispatches by sensitivity (public is the default)', () => {
    expect(atomAddress('x')).toBe(publicAtomAddress('x'));
    expect(atomAddress('x', { sensitivity: 'public' })).toBe(publicAtomAddress('x'));
    expect(atomAddress('x', { sensitivity: 'private', tenantKey: 'k' })).toBe(privateAtomAddress('x', 'k'));
  });

  it('the address shape never leaks sensitivity (public and private are both 40-hex urns)', () => {
    expect(atomAddress('x', { sensitivity: 'private', tenantKey: 'k' })).toMatch(/^urn:pgsl:atom:[0-9a-f]{40}$/);
  });
});

describe('pgsl-store: node-address codec (urn <-> 21-byte FDB key)', () => {
  it('round-trips atom + fragment urns', () => {
    const a = publicAtomAddress('hello');
    const na = nodeAddrFromUrn(a);
    expect(na.kind).toBe('atom');
    expect(na.hash.length).toBe(20);
    expect(urnFromNodeAddr(na)).toBe(a);

    const f = 'urn:pgsl:fragment:' + 'a'.repeat(40);
    const nf = nodeAddrFromUrn(f);
    expect(nf.kind).toBe('fragment');
    expect(nf.hash.length).toBe(20);
    expect(urnFromNodeAddr(nf)).toBe(f);
  });

  it('rejects malformed / non-pgsl urns', () => {
    expect(() => nodeAddrFromUrn('urn:pgsl:atom:xyz')).toThrow();
    expect(() => nodeAddrFromUrn('http://example.org/x')).toThrow();
    expect(() => nodeAddrFromUrn('urn:pgsl:atom:' + 'a'.repeat(39))).toThrow();
  });
});
