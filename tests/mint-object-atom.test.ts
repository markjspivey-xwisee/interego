/**
 * mint(kind:atom) object content — the "[object Object]" bug.
 *
 * A ChatGPT session found that mint(kind:"atom", content:{obj}) round-tripped as
 * `iep:value: "[object Object]"`. Root cause: atoms content-address on
 * `String(value)`, which collapses EVERY object to "[object Object]" — so all
 * object atoms collided onto one holon AND serialized as that useless literal.
 * Fix: canonicalize object content to stable JSON at the mint boundary.
 */
import { describe, it, expect } from 'vitest';
import { mint } from '@interego/core';

describe('mint(kind:atom) with object content', () => {
  it('round-trips as canonical JSON, never "[object Object]"', () => {
    const r = mint({ title: 'A note', body: 'hello', n: 3 }, { kind: 'atom' });
    const value = r.holon.content;
    expect(value).not.toBe('[object Object]');
    expect(typeof value).toBe('string');
    expect(JSON.parse(value as string)).toEqual({ title: 'A note', body: 'hello', n: 3 });
  });

  it('is content-addressed by CONTENT, not key order (same object → same holon)', () => {
    const a = mint({ title: 'x', body: 'y' }, { kind: 'atom' });
    const b = mint({ body: 'y', title: 'x' }, { kind: 'atom' }); // keys reversed
    expect(a.holon.iri).toBe(b.holon.iri);
    expect(a.holon.contentHash).toBe(b.holon.contentHash);
  });

  it('DIFFERENT objects get DIFFERENT holons (no collision — the real bug)', () => {
    const a = mint({ title: 'one' }, { kind: 'atom' });
    const b = mint({ title: 'two' }, { kind: 'atom' });
    expect(a.holon.iri).not.toBe(b.holon.iri);
    expect(a.holon.contentHash).not.toBe(b.holon.contentHash);
  });

  it('scalar atoms are unchanged (string/number/boolean)', () => {
    const s = mint('hello', { kind: 'atom' });
    expect(s.holon.content).toBe('hello');
    const n = mint(42, { kind: 'atom' });
    expect(n.holon.content).toBe(42);
  });

  it('nested objects + arrays round-trip', () => {
    const content = { tags: ['a', 'b'], meta: { z: 1, a: 2 } };
    const r = mint(content, { kind: 'atom' });
    expect(JSON.parse(r.holon.content as string)).toEqual(content);
  });
});
