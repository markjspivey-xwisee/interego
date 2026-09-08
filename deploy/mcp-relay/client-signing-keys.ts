import type { ResourceSigningKey } from './resource-compositions.js';

/** Read only the authenticated caller's registered PUBLIC credential material. */
export async function readClientSigningKeys(input: {
  identityUrl: string; identityToken: string; userId: string; relayAddress: string;
  fetch: typeof fetch;
}): Promise<readonly ResourceSigningKey[]> {
  if (!input.identityToken || !input.userId) throw new Error('client signing requires an authenticated identity session');
  const response = await input.fetch(input.identityUrl.replace(/\/$/, '') + '/auth-methods/me?purpose=client-signature', {
    headers: { Authorization: `Bearer ${input.identityToken}` }, redirect: 'error',
  });
  if (!response.ok) throw new Error(`registered signing keys could not be read (${response.status}); reconnect your identity`);
  const body = await response.json() as Record<string, unknown>;
  if (body['userId'] !== input.userId) throw new Error('signing credential subject differs from authenticated session');
  const keys: ResourceSigningKey[] = [];
  for (const address of Array.isArray(body['walletAddresses']) ? body['walletAddresses'] : []) {
    if (typeof address === 'string' && address.toLowerCase() !== input.relayAddress.toLowerCase()) keys.push({ scheme: 'eip191', address });
  }
  for (const key of Array.isArray(body['didKeys']) ? body['didKeys'] as Record<string, unknown>[] : []) {
    if (typeof key['publicKeyMultibase'] === 'string' && key['keyType'] === 'Ed25519VerificationKey2020') keys.push({ scheme: 'ed25519', publicKeyMultibase: key['publicKeyMultibase'] });
  }
  for (const key of Array.isArray(body['webAuthnCredentials']) ? body['webAuthnCredentials'] as Record<string, unknown>[] : []) {
    if (typeof key['id'] === 'string' && typeof key['publicKey'] === 'string'
      && Array.isArray(key['origins']) && Array.isArray(key['rpIds'])
      && key['origins'].every(x => typeof x === 'string') && key['rpIds'].every(x => typeof x === 'string')) {
      keys.push({ scheme: 'webauthn', credentialId: key['id'], publicKey: key['publicKey'], origins: key['origins'] as string[], rpIds: key['rpIds'] as string[] });
    }
  }
  if (!keys.length) throw new Error('no supported client signing credential is registered; relay signing cannot substitute for it');
  return keys;
}
