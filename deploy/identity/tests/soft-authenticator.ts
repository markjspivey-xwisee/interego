/**
 * A software passkey authenticator for the route tests ('none' attestation), so the server's
 * own WebAuthn verification runs unchanged. Like a real software authenticator it registers
 * any credential id it is given, with a key of its own.
 */

import * as crypto from 'node:crypto';
import { deriveUserIdFromCredentialId } from '../derive-userid.js';

// Just enough CBOR for an attestation object and a COSE key: maps, text, bytes, small ints.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported ${typeof v}`);
}

/** A passkey: a credential id (any bytes the authenticator chooses) and its own P-256 key. */
export function softPasskey(rawId: Buffer = crypto.randomBytes(16)) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const id = rawId.toString('base64url');
  return { id, rawId, cose, privateKey, userId: deriveUserIdFromCredentialId(id) };
}
export type SoftPasskey = ReturnType<typeof softPasskey>;

/**
 * `key`'s public key in other COSE bytes that decode to the same key: its map entries in
 * another order, or with a label the verifier ignores. Whoever registers a copy of a key picks
 * its encoding, and registration stores the map in the order it was sent.
 */
export function recoded(key: SoftPasskey, how: 'reordered' | 'extra-label'): Buffer {
  const jwk = crypto.createPublicKey(key.privateKey).export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  return cbor(new Map<number, unknown>(how === 'reordered'
    ? [[3, -7], [1, 2], [-1, 1], [-2, x], [-3, y]]
    : [[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y], [99, 0]]));
}

/** The registration response for `key`. */
export function attest(key: SoftPasskey, challenge: string, origin: string, rpId: string) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(key.rawId.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(),
    Buffer.from([0x45]),          // user present, user verified, attested credential data
    Buffer.alloc(4),              // sign counter
    Buffer.alloc(16),             // AAGUID
    len, key.rawId, key.cose,
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
  const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    id: key.id, rawId: key.id, type: 'public-key', clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      attestationObject: attestationObject.toString('base64url'),
      transports: ['internal'],
    },
  };
}

/** The sign-in (assertion) response for `key`, with sign counter `counter`. */
export function assertion(key: SoftPasskey, challenge: string, origin: string, rpId: string, counter: number) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), count]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const signature = crypto.sign('sha256',
    Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), key.privateKey);
  return { id: key.id, rawId: key.id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url') } };
}
