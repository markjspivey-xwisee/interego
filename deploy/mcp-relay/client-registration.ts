/** A verifier attests credential membership; the holder still supplies its own signature. */
import { createHash } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { canonicalJson } from '@interego/core';
import { verifyClientAuthorization, type ClientSigningKey } from './client-authorization.js';

export interface ClientRegistrationAttestation {
  readonly schema: 'interego.client-registration-attestation/v1';
  readonly actor: string;
  readonly keyId: string;
  readonly receiptDigest: string;
  readonly at: string;
  readonly verifier: string;
  readonly signature: string;
}
const digest = (message: string) => createHash('sha256').update(message).digest('hex');
function message(value: Omit<ClientRegistrationAttestation, 'signature'>) {
  return 'Interego registered client credential v1\n' + canonicalJson(value);
}

export async function attestClientRegistration(proof: unknown, context: {
  actor: string; now: string; verifier: string; keys: readonly ClientSigningKey[];
  sign: (message: string) => Promise<string>;
}): Promise<ClientRegistrationAttestation> {
  const { actor, now, verifier, sign } = context;
  const raw = JSON.parse(JSON.stringify(proof)) as { message: string };
  const receipt = JSON.parse(raw.message) as Record<string, unknown>;
  const age = Date.parse(now) - Date.parse(String(receipt['at']));
  if (receipt['actor'] !== actor || raw.message !== canonicalJson(receipt) || !Number.isFinite(age) || age < -30_000 || age >= 600_000) {
    throw new Error('credential attestation requires a fresh receipt for the authenticated actor');
  }
  const authorization = await verifyClientAuthorization(raw, raw.message, context.keys);
  const body = { schema: 'interego.client-registration-attestation/v1' as const, actor, keyId: authorization.keyId,
    receiptDigest: digest(raw.message), at: now, verifier };
  const result = { ...body, signature: await sign(message(body)) };
  verifyClientRegistration(result, raw.message, actor, authorization.keyId, verifier);
  return Object.freeze(result);
}

export function verifyClientRegistration(raw: unknown, receipt: string, actor: string, keyId: string, verifier: string): ClientRegistrationAttestation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('registered-credential attestation is required');
  const proof = raw as ClientRegistrationAttestation;
  const { signature, ...body } = proof;
  if (Object.keys(proof).sort().join(',') !== 'actor,at,keyId,receiptDigest,schema,signature,verifier'
    || proof.schema !== 'interego.client-registration-attestation/v1' || proof.actor !== actor || proof.keyId !== keyId
    || proof.receiptDigest !== digest(receipt) || proof.verifier !== verifier || !/^did:ethr:0x[0-9a-f]{40}$/.test(verifier)) {
    throw new Error('credential attestation does not bind the actor, key, receipt and trusted verifier');
  }
  const age = Date.parse(proof.at) - Date.parse(String((JSON.parse(receipt) as Record<string, unknown>)['at']));
  let signer: string;
  try { signer = verifyMessage(message(body), signature).toLowerCase(); }
  catch { throw new Error('credential attestation signature is invalid'); }
  if (!Number.isFinite(age) || age < -30_000 || age >= 600_000
    || signer !== verifier.slice('did:ethr:'.length)) throw new Error('credential attestation signature or time is invalid');
  return proof;
}
