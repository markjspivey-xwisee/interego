/**
 * The JWK of a key's public half, exported from a copy parsed out of its SPKI encoding.
 *
 * On Node 20, a JWK export of an EC or OKP key (`KeyObject.export({ format: 'jwk' })`, and
 * WebCrypto's `exportKey('jwk', ...)`) holds the key pair's mutex while it allocates the JWK's
 * strings. A garbage collection there can collect the finished job that generated the pair, and
 * that job's destructor takes the same mutex: the main thread deadlocks with itself and the test
 * file never ends, with no output and no error (master CI run 40440495350 waited on
 * provisional-play.test.ts until the job's 45-minute timeout). A key parsed from DER shares its
 * mutex with no generator job, and the SPKI export takes no lock while it allocates. Not
 * reproduced on Node 22.
 *
 * So a test that generates a key pair in-process and needs its JWK reads it through here.
 */

import * as crypto from 'node:crypto';

export function publicJwk(key: crypto.KeyObject): crypto.JsonWebKey {
  const spki = (key.type === 'private' ? crypto.createPublicKey(key) : key).export({ type: 'spki', format: 'der' });
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ format: 'jwk' });
}
