/**
 * Compressed lattice persistence — reader first.
 *
 * A persisted lattice is one sealed pod resource. Its plaintext used to be only
 * `JSON.stringify({ topUri, nodes })`; it may now also be a compressed container
 * (packages/pgsl/src/lattice-codec.ts). What this suite holds:
 *
 *   - every reader opens BOTH formats, to the same nodes;
 *   - a writer that is not asked to compress writes what it always wrote;
 *   - the two formats cannot be mistaken for each other, and a compressed body
 *     that is truncated, corrupt or oversized is REFUSED rather than read as
 *     something else (an 'unreadable' lattice is one a writer will not overwrite).
 *
 * All fixture content is made up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  createPGSL, ingest,
  promoteToPodEncrypted, resolveHolonFromPod,
  promoteLatticeSliceEncrypted, promoteInstanceEncrypted, promoteInstanceEncryptedCAS,
  resolveLatticeFromPod, resolveLatticeFromPodDetailed,
  compressLatticePlaintext, decodeLatticePlaintext, isCompressedLatticePlaintext,
  resolveLatticeCompression, LatticeCodecError,
  LATTICE_COMPRESSION_ENV, MAX_LATTICE_INFLATED_BYTES,
} from '@interego/pgsl';
import {
  deriveEncryptionKeyPair, createEncryptedEnvelope, createEncryptedEnvelopeFromBytes,
  openEncryptedEnvelope, openEncryptedEnvelopeBytes,
  type EncryptedEnvelope, type IRI,
} from '@interego/core';

const kp = deriveEncryptionKeyPair('1'.repeat(64));
const stranger = deriveEncryptionKeyPair('2'.repeat(64));
const prov = { wasAttributedTo: 'https://example.test/agent' as IRI, generatedAtTime: '2026-07-17T00:00:00Z' };
const URL_ = 'https://pod.test/lattice.holon.json';

/** One pod resource: PUT stores the body, GET returns it. */
function pod(initial?: string) {
  let body: string | null = initial ?? null;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') { body = await new Response(init?.body ?? null).text(); return new Response(null, { status: 201, headers: { etag: '"put"' } }); }
    if (body == null) return new Response(null, { status: 404 });
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { etag: '"cur"' } });
  }) as unknown as typeof fetch;
  return { fetchFn, body: () => body! };
}

/** A lattice wide enough that its plaintext is redundant: one 24-item sequence. */
function wideInstance() {
  const pgsl = createPGSL(prov as never);
  const values = Array.from({ length: 24 }, (_, i) => `https://fixture.example/orchard/term-${i}`);
  const top = ingest(pgsl, values as never, prov as never) as IRI;
  return { pgsl, top };
}

const plainTextOf = (body: string) => openEncryptedEnvelope(JSON.parse(body) as EncryptedEnvelope, kp);
const bytesOf = (body: string) => openEncryptedEnvelopeBytes(JSON.parse(body) as EncryptedEnvelope, kp)!;
const sealedBytes = (bytes: Uint8Array) => JSON.stringify(createEncryptedEnvelopeFromBytes(bytes, [kp.publicKey], kp));
const sealedText = (text: string) => JSON.stringify(createEncryptedEnvelope(text, [kp.publicKey], kp));

let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[LATTICE_COMPRESSION_ENV]; delete process.env[LATTICE_COMPRESSION_ENV]; });
afterEach(() => { if (savedEnv === undefined) delete process.env[LATTICE_COMPRESSION_ENV]; else process.env[LATTICE_COMPRESSION_ENV] = savedEnv; });

describe('core: a bytes plaintext seals in the same envelope', () => {
  it('round-trips raw bytes, including bytes that are not text', () => {
    const raw = Uint8Array.of(0x00, 0xff, 0x1f, 0x8b, 0x80, 0x7b);
    const env = createEncryptedEnvelopeFromBytes(raw, [kp.publicKey], kp);
    expect(env.version).toBe(1);
    expect(env.algorithm).toBe('X25519-XSalsa20-Poly1305');
    expect([...openEncryptedEnvelopeBytes(env, kp)!]).toEqual([...raw]);
    expect(openEncryptedEnvelopeBytes(env, stranger)).toBeNull();
  });

  it('leaves a string envelope exactly what it was: same shape, same sealed bytes', () => {
    const text = '{"greeting":"héllo ✓"}';
    const env = createEncryptedEnvelope(text, [kp.publicKey], kp);
    expect(Object.keys(env).sort()).toEqual(['algorithm', 'content', 'version', 'wrappedKeys']);
    expect(Object.keys(env.content).sort()).toEqual(['algorithm', 'ciphertext', 'encryptedAt', 'nonce']);
    expect(openEncryptedEnvelope(env, kp)).toBe(text);
    // The sealed plaintext is the UTF-8 of the string and nothing else.
    expect(Buffer.from(openEncryptedEnvelopeBytes(env, kp)!).equals(Buffer.from(text, 'utf8'))).toBe(true);
    // secretbox adds a 16-byte tag; the ciphertext is exactly that much longer.
    expect(Buffer.from(env.content.ciphertext, 'base64').byteLength).toBe(Buffer.byteLength(text, 'utf8') + 16);
  });
});

describe('the writer compresses unless told not to', () => {
  it('resolves to gzip by default, none only on the exact env value, and an explicit choice wins', () => {
    expect(resolveLatticeCompression()).toBe('gzip');
    process.env[LATTICE_COMPRESSION_ENV] = 'NONE';
    expect(resolveLatticeCompression()).toBe('gzip');
    process.env[LATTICE_COMPRESSION_ENV] = '0';
    expect(resolveLatticeCompression()).toBe('gzip');
    process.env[LATTICE_COMPRESSION_ENV] = 'none';
    expect(resolveLatticeCompression()).toBe('none');
    expect(resolveLatticeCompression('gzip')).toBe('gzip');
    delete process.env[LATTICE_COMPRESSION_ENV];
    expect(resolveLatticeCompression('none')).toBe('none');
  });

  it('with no option and no env, every writer seals a compressed body', async () => {
    const { pgsl, top } = wideInstance();
    for (const write of [
      (f: typeof fetch) => promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, f, { ifNoneMatch: '*' }),
      (f: typeof fetch) => promoteInstanceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, f),
      (f: typeof fetch) => promoteLatticeSliceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, f),
      (f: typeof fetch) => promoteToPodEncrypted(pgsl, top, URL_, [kp.publicKey], kp, f),
    ]) {
      const p = pod();
      await write(p.fetchFn as typeof fetch);
      expect(isCompressedLatticePlaintext(bytesOf(p.body()))).toBe(true);
    }
  });

  it('told not to by the environment, every writer seals the plain JSON it always did', async () => {
    process.env[LATTICE_COMPRESSION_ENV] = 'none';
    const { pgsl, top } = wideInstance();
    const expected = JSON.stringify({ topUri: top, nodes: Object.fromEntries(pgsl.nodes) });

    const a = pod();
    await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, a.fetchFn, { ifNoneMatch: '*' });
    expect(plainTextOf(a.body())).toBe(expected);
    expect(plainTextOf(a.body())!.startsWith('{')).toBe(true);
    expect(isCompressedLatticePlaintext(bytesOf(a.body()))).toBe(false);
    // Stored size is the plain text's: ciphertext = plaintext + 16-byte tag.
    const envelope = JSON.parse(a.body()) as EncryptedEnvelope;
    expect(Buffer.from(envelope.content.ciphertext, 'base64').byteLength).toBe(Buffer.byteLength(expected, 'utf8') + 16);

    const b = pod();
    await promoteInstanceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, b.fetchFn);
    expect(plainTextOf(b.body())).toBe(expected);

    const c = pod();
    await promoteLatticeSliceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, c.fetchFn);
    expect(plainTextOf(c.body())!.startsWith('{"topUri":')).toBe(true);

    const d = pod();
    await promoteToPodEncrypted(pgsl, top, URL_, [kp.publicKey], kp, d.fetchFn);
    expect(plainTextOf(d.body())).toBe(JSON.stringify(pgsl.nodes.get(top)));
  });
});

describe('both formats read back to the same lattice', () => {
  it('reads a body written in the old format (hand-built, no codec involved)', async () => {
    const { pgsl, top } = wideInstance();
    const old = sealedText(JSON.stringify({ topUri: top, nodes: Object.fromEntries(pgsl.nodes) }));
    const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(old).fetchFn);
    expect(read.status).toBe('ok');
    expect(read.topUri).toBe(top);
    expect(Object.fromEntries(read.nodes!)).toEqual(Object.fromEntries(pgsl.nodes));
  });

  it('round-trips compressed to nodes deep-equal to the uncompressed round trip, far smaller', async () => {
    const { pgsl, top } = wideInstance();
    const plain = pod(), packed = pod();
    await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, plain.fetchFn, { ifNoneMatch: '*' }, { compression: 'none' });
    const w = await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, packed.fetchFn,
      { ifNoneMatch: '*', confirmBody: true }, { compression: 'gzip' });
    expect(w.status).toBe('ok');
    expect(w.confirmedEtag).toBe('"put"');

    expect(isCompressedLatticePlaintext(bytesOf(packed.body()))).toBe(true);
    expect(packed.body().length).toBeLessThan(plain.body().length / 5);

    const fromPlain = await resolveLatticeFromPodDetailed(URL_, kp, plain.fetchFn);
    const fromPacked = await resolveLatticeFromPodDetailed(URL_, kp, packed.fetchFn);
    expect(fromPacked.status).toBe('ok');
    expect(fromPacked.topUri).toBe(fromPlain.topUri);
    expect([...fromPacked.nodes!.keys()]).toEqual([...fromPlain.nodes!.keys()]);   // same order too
    expect(Object.fromEntries(fromPacked.nodes!)).toEqual(Object.fromEntries(fromPlain.nodes!));
    expect(Object.fromEntries(fromPacked.nodes!)).toEqual(Object.fromEntries(pgsl.nodes));
    // The thin reader agrees, and a key that is not a recipient still gets nothing.
    expect((await resolveLatticeFromPod(URL_, kp, packed.fetchFn))?.nodes.size).toBe(pgsl.nodes.size);
    expect((await resolveLatticeFromPodDetailed(URL_, stranger, packed.fetchFn)).status).toBe('unreadable');
  });

  it('round-trips every writer when compression is asked for', async () => {
    const { pgsl, top } = wideInstance();
    const a = pod();
    await promoteInstanceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, a.fetchFn, { compression: 'gzip' });
    expect(isCompressedLatticePlaintext(bytesOf(a.body()))).toBe(true);
    expect(Object.fromEntries((await resolveLatticeFromPod(URL_, kp, a.fetchFn))!.nodes)).toEqual(Object.fromEntries(pgsl.nodes));

    const b = pod();
    await promoteLatticeSliceEncrypted(pgsl, top, URL_, [kp.publicKey], kp, b.fetchFn, { compression: 'gzip' });
    expect(isCompressedLatticePlaintext(bytesOf(b.body()))).toBe(true);
    expect((await resolveLatticeFromPod(URL_, kp, b.fetchFn))!.topUri).toBe(top);

    const c = pod();
    await promoteToPodEncrypted(pgsl, top, URL_, [kp.publicKey], kp, c.fetchFn, { compression: 'gzip' });
    expect(isCompressedLatticePlaintext(bytesOf(c.body()))).toBe(true);
    expect(await resolveHolonFromPod(URL_, kp, c.fetchFn)).toEqual(pgsl.nodes.get(top));
  });

  it('the environment variable turns the writer on, and an explicit none turns it back off', async () => {
    const { pgsl, top } = wideInstance();
    process.env[LATTICE_COMPRESSION_ENV] = 'gzip';
    const on = pod(), off = pod();
    await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, on.fetchFn, { ifNoneMatch: '*' });
    await promoteInstanceEncryptedCAS(pgsl, top, URL_, [kp.publicKey], kp, off.fetchFn, { ifNoneMatch: '*' }, { compression: 'none' });
    expect(isCompressedLatticePlaintext(bytesOf(on.body()))).toBe(true);
    expect(plainTextOf(off.body())!.startsWith('{')).toBe(true);
    expect((await resolveLatticeFromPodDetailed(URL_, kp, on.fetchFn)).status).toBe('ok');
  });
});

describe('a compressed body is refused, never reinterpreted', () => {
  const json = JSON.stringify({ topUri: 'urn:fixture:top', nodes: { 'urn:fixture:top': { kind: 'Atom', value: 'pear '.repeat(4000) } } });

  it('refuses a truncated body, at every cut, with a reason', async () => {
    const whole = compressLatticePlaintext(json)!;
    expect(decodeLatticePlaintext(whole)).toBe(json);
    for (const keep of [1, 5, 11, 12, 13, 20, whole.length - 9, whole.length - 1]) {
      const cut = whole.subarray(0, keep);
      expect(() => decodeLatticePlaintext(cut), `cut at ${keep}`).toThrow(LatticeCodecError);
      // Through the reader (the cut body is sealed validly — the damage is inside the seal):
      const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedBytes(cut)).fetchFn);
      expect(read.status, `cut at ${keep}`).toBe('unreadable');
      expect(read.error, `cut at ${keep}`).toMatch(/compressed lattice body/);
      expect(read.nodes).toBeUndefined();
      expect(await resolveLatticeFromPod(URL_, kp, pod(sealedBytes(cut)).fetchFn)).toBeNull();
      expect(await resolveHolonFromPod(URL_, kp, pod(sealedBytes(cut)).fetchFn)).toBeNull();
    }
  });

  it('refuses a flipped byte in the stream, an unknown version and an unknown codec', () => {
    const whole = compressLatticePlaintext(json)!;
    const flipped = Uint8Array.from(whole); flipped[flipped.length - 6]! ^= 0xff;   // inside the CRC-32
    expect(() => decodeLatticePlaintext(flipped)).toThrow(/corrupt or truncated/);
    const version = Uint8Array.from(whole); version[6] = 2;
    expect(() => decodeLatticePlaintext(version)).toThrow(/container version 2/);
    const codec = Uint8Array.from(whole); codec[7] = 9;
    expect(() => decodeLatticePlaintext(codec)).toThrow(/codec 9/);
    const magic = Uint8Array.from(whole); magic[3] = 0x58;
    expect(() => decodeLatticePlaintext(magic)).toThrow(/unrecognized marker/);
  });

  it('refuses an inflation over the cap before inflating, and a header that understates it', async () => {
    expect(MAX_LATTICE_INFLATED_BYTES).toBe(256 * 1024 * 1024);
    const header = (declared: number) => {
      const h = new Uint8Array(12);
      h.set([0x00, 0x50, 0x47, 0x53, 0x4c, 0x5a, 1, 1]);
      new DataView(h.buffer).setUint32(8, declared, false);
      return h;
    };
    const withStream = (declared: number, stream: Uint8Array) => {
      const out = new Uint8Array(12 + stream.length); out.set(header(declared)); out.set(stream, 12); return out;
    };
    // 1. Declares more than the cap: refused on the header alone (the stream here is not even gzip).
    const overCap = withStream(MAX_LATTICE_INFLATED_BYTES + 1, Uint8Array.of(1, 2, 3));
    expect(() => decodeLatticePlaintext(overCap)).toThrow(/over the 268435456-byte cap/);
    const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedBytes(overCap)).fetchFn);
    expect(read.status).toBe('unreadable');
    expect(read.error).toMatch(/over the 268435456-byte cap/);

    // 2. A small body that inflates hugely but DECLARES little: zlib is stopped at the declared size.
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    expect(bomb.byteLength).toBeLessThan(16 * 1024);
    expect(() => decodeLatticePlaintext(withStream(64, bomb))).toThrow(/inflates past its declared 64 bytes/);

    // 3. Declares honestly, but over a caller's lower cap.
    expect(() => decodeLatticePlaintext(withStream(8 * 1024 * 1024, bomb), { maxInflatedBytes: 1024 * 1024 }))
      .toThrow(/over the 1048576-byte cap/);
    // A caller cannot RAISE the cap past the constant.
    expect(() => decodeLatticePlaintext(overCap, { maxInflatedBytes: Number.MAX_SAFE_INTEGER })).toThrow(/over the 268435456-byte cap/);

    // 4. Declares more than the stream holds.
    expect(() => decodeLatticePlaintext(withStream(9 * 1024 * 1024, bomb))).toThrow(/header declares 9437184/);
  });
});

describe('the two formats cannot be mistaken for each other', () => {
  it('reads plain JSON whose CONTENT carries the marker text as plain JSON', async () => {
    const marker = '\u0000PGSLZ\u0001\u0001';
    const nodes = { [`urn:fixture:${marker}`]: { kind: 'Atom', value: `${marker} is only a value here` } };
    const text = JSON.stringify({ topUri: `urn:fixture:${marker}`, nodes });
    expect(text.startsWith('{')).toBe(true);
    const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedText(text)).fetchFn);
    expect(read.status).toBe('ok');
    expect(Object.fromEntries(read.nodes!)).toEqual(nodes);
    // And the same content survives the compressed container.
    expect(decodeLatticePlaintext(compressLatticePlaintext(text)!)).toBe(text);
  });

  it('refuses a text plaintext that BEGINS with the marker bytes, even when JSON follows', async () => {
    const valid = JSON.stringify({ topUri: 'urn:fixture:top', nodes: {} });
    // A string sealed through the text API whose first characters are the marker. It is not a
    // lattice any writer produced (those begin with "{"), and it is not a valid container.
    const impostor = `\u0000PGSLZ\u0001\u0001\u0000\u0000\u0000\u0010${valid}`;
    const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedText(impostor)).fetchFn);
    expect(read.status).toBe('unreadable');
    expect(read.error).toMatch(/corrupt or truncated/);
    // A bare NUL in front of valid JSON is refused the same way — never "skipped".
    const nul = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedText(`\u0000${valid}`)).fetchFn);
    expect(nul.status).toBe('unreadable');
    expect(nul.error).toMatch(/truncated|unrecognized marker/);
  });

  it('treats marker letters without the leading NUL as ordinary (unparseable) text', async () => {
    const read = await resolveLatticeFromPodDetailed(URL_, kp, pod(sealedText('PGSLZ{"topUri":"urn:x","nodes":{}}')).fetchFn);
    expect(read.status).toBe('unreadable');
    expect(read.nodes).toBeUndefined();
  });

  it('a compressed container never begins with "{" and a JSON text never begins with NUL', () => {
    const text = JSON.stringify({ topUri: 'urn:fixture:top', nodes: {} });
    const packed = compressLatticePlaintext(text)!;
    expect(packed[0]).toBe(0x00);
    expect(Buffer.from(text, 'utf8')[0]).toBe(0x7b);
    expect(isCompressedLatticePlaintext(Buffer.from(text, 'utf8'))).toBe(false);
    expect(isCompressedLatticePlaintext(new Uint8Array(0))).toBe(false);
  });
});
