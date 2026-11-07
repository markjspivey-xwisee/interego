/**
 * The X25519 keyAgreement encodings that generateEd25519 in server.ts publishes for every
 * identity: `publicKeyMultibase` in its DID document and the raw key in base64.
 *
 * The server once read the raw key from the `x` of a JWK export of the key it had just generated.
 * On Node 20 that export can deadlock the thread (see public-jwk.ts), so the raw key now comes
 * from the tail of the SPKI DER. These pin that the two give the same bytes, so every
 * keyAgreement key the server publishes is encoded as before.
 *
 * Run:
 *   node --test --import tsx tests/key-encoding.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { encodeX25519Multibase, x25519PublicKeyEncodings } from '../key-encoding.js';
import { publicJwk } from './public-jwk.js';

// RFC 7748 §6.1, Alice's public key, and the 12-byte SPKI header of an X25519 key (RFC 8410).
const RFC7748_ALICE = Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex');
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

/** The raw key as the server used to read it: the `x` of the key's JWK. */
function rawFromJwk(key: crypto.KeyObject): Buffer {
  return Buffer.from(publicJwk(key).x!, 'base64url');
}

test('a fixed X25519 key gets the multibase and base64 it got through the JWK export', () => {
  const key = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_HEADER, RFC7748_ALICE]), format: 'der', type: 'spki' });
  // A key parsed from DER shares its mutex with no keygen job, so exporting its JWK is safe.
  const x = Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
  assert.deepEqual(x, RFC7748_ALICE);

  const { multibase, base64 } = x25519PublicKeyEncodings(key);
  assert.equal(base64, x.toString('base64'));
  assert.equal(multibase, encodeX25519Multibase(x));
  // Frozen: 'z' + base58btc(0xec 0x01 || key), computed with multiformats' base58btc. A
  // published keyAgreement key that changed encoding would no longer match what pods hold.
  assert.equal(base64, 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=');
  assert.equal(multibase, 'z6LSkdrX4EvewpktHBjvNxRDogPdC5iVF8LT3LPKefGAgi89');
});

test('generated X25519 keys get the encodings of their JWK `x`', () => {
  for (let i = 0; i < 200; i++) {
    const { publicKey } = crypto.generateKeyPairSync('x25519');
    const x = rawFromJwk(publicKey);
    assert.deepEqual(x25519PublicKeyEncodings(publicKey), { multibase: encodeX25519Multibase(x), base64: x.toString('base64') });
  }
});

test('a key whose SPKI is not 44 bytes is refused', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => x25519PublicKeyEncodings(publicKey), /X25519 SPKI must be 44 bytes, got 91/);
});
