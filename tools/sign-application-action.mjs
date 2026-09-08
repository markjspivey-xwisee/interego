/** Sign a reviewed request using this process's existing credential. Never creates an identity. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import { base58btc } from 'multiformats/bases/base58';

const [requestPath, reviewedDigest, outputPath] = process.argv.slice(2);
if (!requestPath || !/^[0-9a-f]{64}$/.test(reviewedDigest ?? '') || !outputPath || !process.env.INTEREGO_CLIENT_KEY_FILE) {
  throw new Error('Usage: INTEREGO_CLIENT_KEY_FILE=<existing credential file> node tools/sign-application-action.mjs <request.json> <reviewed receipt SHA-256> <proof.json>');
}
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
if (request.schema !== 'interego.client-signing-request/v1' || typeof request.message !== 'string' || !Array.isArray(request.keys)) throw new Error('Invalid signing request');
if (createHash('sha256').update(request.message).digest('hex') !== reviewedDigest) throw new Error('Receipt differs from the digest reviewed');
const age = Date.now() - Date.parse(JSON.parse(request.message).at);
if (!Number.isFinite(age) || age < -30000 || age > 600000) throw new Error('Request expired; obtain a new preview');
const secret = readFileSync(process.env.INTEREGO_CLIENT_KEY_FILE, 'utf8').trim();
let entry, signer;
if (/^0x[0-9a-fA-F]{64}$/.test(secret)) {
  const wallet = new Wallet(secret);
  entry = request.keys.find(value => value.key.scheme === 'eip191' && value.key.address.toLowerCase() === wallet.address.toLowerCase());
  if (entry && entry.keyId !== `did:ethr:${wallet.address.toLowerCase()}`) throw new Error('Signing key fingerprint mismatch');
  signer = message => wallet.signMessage(message);
} else {
  const key = createPrivateKey(secret);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 PEM or a wallet credential');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  const multibase = base58btc.encode(new Uint8Array([0xed, 0x01, ...publicKey]));
  entry = request.keys.find(value => value.key.scheme === 'ed25519' && value.key.publicKeyMultibase === multibase);
  if (entry && entry.keyId !== `did:key:${multibase}`) throw new Error('Signing key fingerprint mismatch');
  signer = async message => sign(null, Buffer.from(message), key).toString('base64url');
}
if (!entry) throw new Error('This credential is not among the authenticated actor\'s registered signing keys');
const signature = await signer(`Interego client authorization v1\nKey: ${entry.keyId}\n${request.message}`);
writeFileSync(outputPath, JSON.stringify({ schema: 'interego.client-signature/v1', key: entry.key, message: request.message, signature }) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Client signature written. Submit it with the reviewed action control; no action has been submitted by this signer.');
