/**
 * @module pgsl/lattice-codec
 * @description Compress-then-encrypt codec for a persisted lattice plaintext.
 *
 * NODE-ONLY: this module statically imports `node:zlib`. It is reached only
 * through `persistence.ts` (already Node-only: `node:crypto`, `node:fs`), never
 * through `@interego/pgsl/browser-native-resource`. Do not import it from a
 * module a browser bundle reaches.
 *
 * WHY. A persisted lattice is one sealed resource whose plaintext is
 * `JSON.stringify({ topUri, nodes })`. That text is highly redundant — every
 * fragment repeats its full `items` list of ~91-character URIs and the same
 * provenance object sits on every node — so it deflates to a few percent of
 * its size. Compression has to happen BEFORE sealing: ciphertext does not
 * compress.
 *
 * TWO PLAINTEXT FORMATS, told apart by the FIRST BYTE of the authenticated
 * plaintext (inside the seal, so a storage provider cannot flip it):
 *
 *   plain       UTF-8 JSON text. Every writer has always emitted
 *               `JSON.stringify(<object>)`, so its first byte is `{` (0x7B).
 *   compressed  a 12-byte header followed by one gzip stream:
 *
 *                 0      0x00            NUL — can never begin a JSON text
 *                 1..5   "PGSLZ"         magic
 *                 6      0x01            container version
 *                 7      0x01            codec (1 = gzip / RFC 1952)
 *                 8..11  uint32 BE       exact byte length of the inflated text
 *                 12..   gzip stream
 *
 * The discriminator is byte 0 alone. A plain plaintext can never be read as
 * compressed, because JSON text cannot start with NUL; a compressed one can
 * never be read as plain, because it always starts with NUL. Once byte 0 says
 * "compressed", EVERYTHING after it must check out — magic, version, codec,
 * declared length within the cap, a gzip stream that inflates to exactly the
 * declared length (gzip's own CRC-32 and length trailer are verified by zlib)
 * — or the decode throws. There is no fallback to "try it as JSON instead":
 * a corrupt or truncated compressed body is refused, never reinterpreted.
 *
 * Note this is not a marker that could collide with JSON *content*: a lattice
 * whose strings contain "PGSLZ" is still a text beginning with `{`.
 */
import { gzipSync, gunzipSync } from 'node:zlib';

/** Compression applied to a lattice plaintext before it is sealed. */
export type LatticeCompression = 'none' | 'gzip';

/**
 * The environment variable that turns compressed writes OFF when a caller does
 * not pass an explicit `compression` option. The only value that disables it
 * is the exact string `none`; unset, empty or anything else means gzip.
 */
export const LATTICE_COMPRESSION_ENV = 'PGSL_LATTICE_COMPRESSION';

/**
 * The largest plaintext a reader will inflate, and the largest a writer will
 * compress: 256 MiB. Generous — the largest lattice a pod has accepted is a
 * few tens of megabytes — while still bounding what a small sealed body can
 * make a reader allocate. A writer whose plaintext exceeds it stays
 * uncompressed rather than emit something no reader would open.
 */
export const MAX_LATTICE_INFLATED_BYTES = 256 * 1024 * 1024;

const HEADER_BYTES = 12;
const MAGIC = Uint8Array.of(0x00, 0x50, 0x47, 0x53, 0x4c, 0x5a); // NUL "PGSLZ"
const CONTAINER_VERSION = 1;
const CODEC_GZIP = 1;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A lattice plaintext that could not be decoded. Always fail-closed. */
export class LatticeCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LatticeCodecError';
  }
}

/**
 * Which compression a writer should use: the caller's explicit choice if it
 * made one, otherwise gzip unless the environment variable says `none`.
 *
 * DEFAULT IS GZIP. It was off for one release on purpose: several services
 * read these resources and deploy separately, and a reader built before this
 * module cannot open a compressed body, so the reader shipped first (2026-11-13)
 * and the writer followed once that reader was live everywhere. Setting
 * PGSL_LATTICE_COMPRESSION=none on a service returns it to plain JSON writes
 * without a code change; readers accept both either way.
 */
export function resolveLatticeCompression(explicit?: LatticeCompression): LatticeCompression {
  if (explicit !== undefined) return explicit;
  const env = typeof process !== 'undefined' ? process.env?.[LATTICE_COMPRESSION_ENV] : undefined;
  return env === 'none' ? 'none' : 'gzip';
}

/** True when an authenticated plaintext is in the compressed container (byte 0 is NUL). */
export function isCompressedLatticePlaintext(plaintext: Uint8Array): boolean {
  return plaintext.length > 0 && plaintext[0] === 0x00;
}

/**
 * Pack a lattice plaintext into the compressed container. Returns null when
 * the text is larger than {@link MAX_LATTICE_INFLATED_BYTES} — the caller then
 * seals it uncompressed, exactly as before.
 */
export function compressLatticePlaintext(text: string): Uint8Array | null {
  const raw = Buffer.from(text, 'utf8');
  if (raw.byteLength > MAX_LATTICE_INFLATED_BYTES) return null;
  const packed = gzipSync(raw);
  const out = new Uint8Array(HEADER_BYTES + packed.byteLength);
  out.set(MAGIC, 0);
  out[6] = CONTAINER_VERSION;
  out[7] = CODEC_GZIP;
  new DataView(out.buffer).setUint32(8, raw.byteLength, false);
  out.set(packed, HEADER_BYTES);
  return out;
}

/**
 * Decode an authenticated lattice plaintext of EITHER format to its JSON text.
 *
 * Plain (first byte not NUL): strict UTF-8 decode. Compressed (first byte
 * NUL): validate the whole container and inflate, refusing anything whose
 * declared or actual inflated size exceeds the cap. `maxInflatedBytes` can
 * only LOWER the cap below {@link MAX_LATTICE_INFLATED_BYTES}.
 *
 * @throws LatticeCodecError on a malformed, truncated, oversized or
 *   unsupported compressed body, and on plain bytes that are not UTF-8.
 */
export function decodeLatticePlaintext(
  plaintext: Uint8Array,
  options: { readonly maxInflatedBytes?: number } = {},
): string {
  if (!isCompressedLatticePlaintext(plaintext)) {
    try { return strictUtf8.decode(plaintext); }
    catch { throw new LatticeCodecError('lattice plaintext is neither UTF-8 text nor a compressed lattice container'); }
  }
  const cap = Math.min(options.maxInflatedBytes ?? MAX_LATTICE_INFLATED_BYTES, MAX_LATTICE_INFLATED_BYTES);
  if (plaintext.length < HEADER_BYTES) throw new LatticeCodecError('compressed lattice body is truncated: header incomplete');
  for (let i = 0; i < MAGIC.length; i++) {
    if (plaintext[i] !== MAGIC[i]) throw new LatticeCodecError('compressed lattice body has an unrecognized marker');
  }
  if (plaintext[6] !== CONTAINER_VERSION) throw new LatticeCodecError(`unsupported compressed lattice container version ${plaintext[6]}`);
  if (plaintext[7] !== CODEC_GZIP) throw new LatticeCodecError(`unsupported lattice compression codec ${plaintext[7]}`);
  const declared = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(8, false);
  if (declared > cap) {
    throw new LatticeCodecError(`compressed lattice body declares ${declared} inflated bytes, over the ${cap}-byte cap`);
  }
  let inflated: Buffer;
  try {
    // maxOutputLength makes zlib itself stop: a header that lies about the
    // size cannot make this allocate more than it declared (itself <= cap).
    inflated = gunzipSync(plaintext.subarray(HEADER_BYTES), { maxOutputLength: Math.max(declared, 1) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new LatticeCodecError(`compressed lattice body inflates past its declared ${declared} bytes`);
    }
    throw new LatticeCodecError(`compressed lattice body is corrupt or truncated (${code ?? (e as Error).message})`);
  }
  if (inflated.byteLength !== declared) {
    throw new LatticeCodecError(`compressed lattice body inflated to ${inflated.byteLength} bytes, header declares ${declared}`);
  }
  try { return strictUtf8.decode(inflated); }
  catch { throw new LatticeCodecError('compressed lattice body does not inflate to UTF-8 text'); }
}
