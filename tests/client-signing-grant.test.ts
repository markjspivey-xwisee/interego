import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Wallet } from 'ethers';
import { base58btc } from 'multiformats/bases/base58';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../integrations/application-runtime/application-lab-runtime.js';
import { clientKeyId, clientSigningMessage, requireVerifiedClientAuthorization, verifyClientAuthorization,
  type ClientSignature, type ClientSigningKey, type VerifiedClientAuthorization } from '../integrations/application-runtime/client-authorization.js';
import { clientSigningGrantMessage, delegatedClientSigningMessage, replayDelegatedClientSignature,
  requireVerifiedDelegatedClientAuthorization, verifyClientSigningGrant, verifyDelegatedClientAuthorization,
  type ClientSigningGrant, type DelegatedClientSignature, type VerifiedDelegatedClientAuthorization } from '../integrations/application-runtime/client-signing-grant.js';

const start = Date.parse('2026-09-11T12:00:00.000Z');
const owner = Wallet.createRandom();
const ownerKey: ClientSigningKey = { scheme: 'eip191', address: owner.address };

function agentSigner() {
  // Test-owned keys only. Production key custody cannot be established by a fixture.
  const pair = generateKeyPairSync('ed25519');
  const bytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = { scheme: 'ed25519' as const, publicKeyMultibase: base58btc.encode(new Uint8Array([0xed, 1, ...bytes])) };
  const proof = (message: string): ClientSignature => ({ schema: 'interego.client-signature/v1', key, message,
    signature: sign(null, Buffer.from(clientSigningMessage(message, key)), pair.privateKey).toString('base64url') });
  return { key, proof };
}

async function fixture(changes: Partial<ClientSigningGrant> = {}) {
  const agent = agentSigner();
  const grant: ClientSigningGrant = { schema: 'interego.client-signing-grant/v1', id: `urn:uuid:${randomUUID()}`,
    issuer: 'did:example:owner', actor: 'did:example:reviewer', audience: 'https://relay.example', podUrl: 'https://pod.example/release/',
    applicationId: 'urn:example:application', actionIri: 'urn:example:approve', contractDigest: 'a'.repeat(64),
    key: agent.key, notBefore: new Date(start).toISOString(), expiresAt: new Date(start + 3_600_000).toISOString(), ...changes };
  const grantMessage = canonicalJson(grant);
  const issuerProof: ClientSignature = { schema: 'interego.client-signature/v1', key: ownerKey, message: grantMessage,
    signature: await owner.signMessage(clientSigningMessage(grantMessage, ownerKey)) };
  const envelope = { grant, issuerProof, possessionProof: agent.proof(grantMessage) };
  const receipt = canonicalJson({ actor: grant.actor, applicationId: grant.applicationId, actionIri: grant.actionIri,
    contractDigest: grant.contractDigest, at: new Date(start + 60_000).toISOString(), expectedHead: 'urn:example:head:4', payload: {}, stateVersion: 4,
    authority: { podUrl: grant.podUrl } });
  const readStatus = vi.fn(async () => 'active' as 'active' | 'revoked' | 'unknown');
  const context = { issuer: 'did:example:owner', actor: 'did:example:reviewer', audience: 'https://relay.example',
    issuerKeys: [ownerKey], now: () => start + 60_000, readStatus };
  const authorize = (message = receipt): DelegatedClientSignature => ({ schema: 'interego.delegated-client-signature/v1',
    grant: envelope, proof: agent.proof(delegatedClientSigningMessage(grant, message)) });
  return { agent, grant, envelope, receipt, context, readStatus, authorize };
}

describe('proposed scoped client signing grants', () => {
  it('verifies both grant signatures and an action, preserving distinct issuer and delegate fingerprints', async () => {
    const f = await fixture();
    expect(clientSigningGrantMessage(f.grant)).toBe(canonicalJson(f.grant));
    const proposal = await verifyClientSigningGrant(f.envelope, f.context);
    const result = await verifyDelegatedClientAuthorization(f.authorize(), f.receipt, f.context);
    expect(requireVerifiedDelegatedClientAuthorization(result, f.receipt)).toBe(result);
    expect(result.keyId).toBe(clientKeyId(f.agent.key));
    expect(result.issuerKeyId).toBe(clientKeyId(ownerKey));
    expect(result.grantDigest).toBe(proposal.binding.digest);
    expect(f.readStatus).toHaveBeenCalledExactlyOnceWith(proposal.binding);
    expect(Object.isFrozen(result.proof.grant.grant.key)).toBe(true);
  });

  it.each(['issuer', 'actor', 'audience'] as const)('requires an independent authenticated %s binding', async field => {
    const f = await fixture();
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, { ...f.context, [field]: 'https://wrong.example' })).rejects.toThrow('authenticated context');
    expect(f.readStatus).not.toHaveBeenCalled();
  });

  it.each(['actor', 'applicationId', 'actionIri', 'contractDigest'] as const)('refuses receipts outside the grant %s', async field => {
    const f = await fixture();
    const receipt = canonicalJson({ ...JSON.parse(f.receipt), [field]: 'urn:example:other' });
    await expect(verifyDelegatedClientAuthorization(f.authorize(), receipt, f.context)).rejects.toThrow('outside grant scope');
    expect(f.readStatus).not.toHaveBeenCalled();
  });

  it('requires a current registered issuer key and subordinate proof of possession', async () => {
    const f = await fixture();
    await expect(verifyClientSigningGrant(f.envelope, { ...f.context, issuerKeys: [] })).rejects.toThrow('registered credential');
    const other = agentSigner();
    await expect(verifyClientSigningGrant({ ...f.envelope, possessionProof: other.proof(canonicalJson(f.grant)) }, f.context)).rejects.toThrow('registered credential');
    await expect(verifyClientSigningGrant({ ...f.envelope, issuerProof: { ...f.envelope.issuerProof, signature: '0x00' } }, f.context)).rejects.toThrow();
  });

  it('refuses the same application and contract copied to another resource pod', async () => {
    const f = await fixture();
    const receipt = canonicalJson({ ...JSON.parse(f.receipt), authority: { podUrl: 'https://pod.example/other-owner/' } });
    await expect(verifyDelegatedClientAuthorization(f.authorize(), receipt, f.context)).rejects.toThrow('resource pod');
  });

  it('retains issuer key metadata from admission rather than caller-supplied restrictions', async () => {
    const f = await fixture();
    const original = f.authorize();
    const supplied = { ...original, grant: { ...original.grant, issuerProof: { ...original.grant.issuerProof,
      key: { ...ownerKey, address: owner.address.toLowerCase(), origins: ['https://untrusted.example'] } } } };
    const result = await verifyDelegatedClientAuthorization(supplied, f.receipt, f.context);
    expect(result.proof.grant.issuerProof.key).toEqual(ownerKey);
  });

  it('refuses self-delegation of the same mathematical key', async () => {
    const f = await fixture();
    const proof = f.agent.proof(canonicalJson(f.grant));
    await expect(verifyClientSigningGrant({ ...f.envelope, issuerProof: proof }, { ...f.context, issuerKeys: [f.agent.key] })).rejects.toThrow('differ from the issuer');
  });

  it('refuses altered grant bytes and signatures under a different delegate key', async () => {
    const f = await fixture();
    const altered = { ...f.envelope, grant: { ...f.grant, actionIri: 'urn:example:deploy' } };
    await expect(verifyClientSigningGrant(altered, f.context)).rejects.toThrow('exact action receipt');
    const proof = f.authorize();
    await expect(verifyDelegatedClientAuthorization({ ...proof, proof: agentSigner().proof(proof.proof.message) }, f.receipt, f.context)).rejects.toThrow('registered credential');
    const bad = { ...proof.proof, signature: agentSigner().proof(proof.proof.message).signature };
    await expect(verifyDelegatedClientAuthorization({ ...proof, proof: bad }, f.receipt, f.context)).rejects.toThrow('invalid');
  });

  it.each(['revoked', 'unknown'] as const)('refuses %s grants after cryptographic verification', async status => {
    const f = await fixture(); f.readStatus.mockResolvedValue(status);
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, f.context)).rejects.toThrow('revoked, unknown or unavailable');
    expect(f.readStatus).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unavailable status source and does not retry', async () => {
    const f = await fixture(); f.readStatus.mockRejectedValue(new Error('status store unavailable'));
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, f.context)).rejects.toThrow('status store unavailable');
    expect(f.readStatus).toHaveBeenCalledTimes(1);
  });

  it('binds status to the content digest as well as the grant ID', async () => {
    const f = await fixture();
    const other = await fixture({ id: f.grant.id });
    const enrolled = await verifyClientSigningGrant(f.envelope, f.context);
    await expect(verifyDelegatedClientAuthorization(other.authorize(), other.receipt, { ...other.context,
      readStatus: async binding => binding.id === enrolled.binding.id && binding.digest === enrolled.binding.digest ? 'active' : 'unknown',
    })).rejects.toThrow('unknown');
  });

  it.each([start - 1, start + 3_600_000, Number.NaN])('refuses inactive grant time %s', async now => {
    const f = await fixture();
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, { ...f.context, now: () => now })).rejects.toThrow('not active');
  });

  it('checks expiry again after awaiting the authoritative status read', async () => {
    const f = await fixture(); let now = start + 60_000;
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, { ...f.context, now: () => now,
      readStatus: async () => { now = start + 3_600_000; return 'active'; },
    })).rejects.toThrow('not active');
  });

  it('does not let an admitted result become a timeless signing capability', async () => {
    const f = await fixture(); let now = start + 60_000;
    const result = await verifyDelegatedClientAuthorization(f.authorize(), f.receipt, { ...f.context, now: () => now });
    now = start + 3_600_000;
    expect(() => requireVerifiedDelegatedClientAuthorization(result, f.receipt)).toThrow('not active');
  });

  it.each([start + 29_999, start + 660_000])('refuses future or stale receipt at verifier time %s', async now => {
    const f = await fixture();
    await expect(verifyDelegatedClientAuthorization(f.authorize(), f.receipt, { ...f.context, now: () => now })).rejects.toThrow('not fresh');
  });

  it.each([start - 1, start + 3_600_000])('refuses receipt time outside the signed grant interval: %s', async at => {
    const f = await fixture();
    const receipt = canonicalJson({ ...JSON.parse(f.receipt), at: new Date(at).toISOString() });
    await expect(verifyDelegatedClientAuthorization(f.authorize(), receipt, f.context)).rejects.toThrow('not active');
  });

  it.each([
    { expiresAt: new Date(start).toISOString() },
    { expiresAt: new Date(start + 3_600_001).toISOString() },
    { notBefore: '2026-09-11' }, { actor: '*' }, { actionIri: 'urn:example:*' },
    { audience: 'http://relay.example' }, { audience: 'https://relay.example/' },
    { audience: 'https://user@relay.example' }, { audience: 'https://relay.example/?token=x' },
    { id: 'urn:example:arbitrary' }, { contractDigest: '*' }, { podUrl: 'https://pod.example/release/?token=x' },
  ] as Partial<ClientSigningGrant>[])('refuses invalid grant %j', async changes => {
    const f = await fixture(changes);
    await expect(verifyClientSigningGrant(f.envelope, f.context)).rejects.toThrow();
  });

  it('rejects extra fields instead of silently ignoring claimed authority', async () => {
    const f = await fixture();
    await expect(verifyClientSigningGrant({ ...f.envelope, approved: true }, f.context)).rejects.toThrow('proof field');
    await expect(verifyClientSigningGrant({ ...f.envelope, grant: { ...f.grant, canRedelegate: true } }, f.context)).rejects.toThrow('proof field');
    await expect(verifyDelegatedClientAuthorization({ ...f.authorize(), verified: true }, f.receipt, f.context)).rejects.toThrow('proof field');
  });

  it('refuses cross-head, cross-input and cross-grant replay of an action signature', async () => {
    const f = await fixture(); const proof = f.authorize();
    for (const change of [{ expectedHead: 'urn:example:head:5' }, { payload: { deploy: true } }]) {
      await expect(verifyDelegatedClientAuthorization(proof, canonicalJson({ ...JSON.parse(f.receipt), ...change }), f.context)).rejects.toThrow('exact action receipt');
    }
    const g = { ...f.grant, id: `urn:uuid:${randomUUID()}` };
    const message = canonicalJson(g);
    const issuerProof = { ...f.envelope.issuerProof, message, signature: await owner.signMessage(clientSigningMessage(message, ownerKey)) };
    await expect(verifyDelegatedClientAuthorization({ ...proof, grant: { grant: g, issuerProof, possessionProof: f.agent.proof(message) } }, f.receipt, f.context)).rejects.toThrow('exact action receipt');
  });

  it('keeps historical signature checks distinct from authority, revocation and live admission', async () => {
    const f = await fixture(); const proof = f.authorize();
    const live = await verifyDelegatedClientAuthorization(proof, f.receipt, f.context);
    const history = await replayDelegatedClientSignature(proof, f.receipt);
    expect(history).toMatchObject({ signaturesVerified: true, grantTimeVerified: true, authorityVerified: false, revocationVerified: false });
    expect(() => requireVerifiedDelegatedClientAuthorization(history as unknown as VerifiedDelegatedClientAuthorization, f.receipt)).toThrow('independently verified');
    expect(() => requireVerifiedDelegatedClientAuthorization({ ...live }, f.receipt)).toThrow('independently verified');
    expect(() => requireVerifiedDelegatedClientAuthorization(live, 'other')).toThrow('independently verified');
    f.readStatus.mockResolvedValue('revoked');
    await expect(verifyDelegatedClientAuthorization(proof, f.receipt, f.context)).rejects.toThrow('revoked');
    expect((await replayDelegatedClientSignature(proof, f.receipt)).signaturesVerified).toBe(true);
  });

  it('cannot satisfy the current direct-signature policy, even with a registered delegate key', async () => {
    const f = await fixture(); const proof = f.authorize();
    await expect(verifyClientAuthorization(proof, f.receipt, [f.agent.key])).rejects.toThrow();
    await expect(verifyClientAuthorization(proof.proof, f.receipt, [f.agent.key])).rejects.toThrow('exact action receipt');
    const result = await verifyDelegatedClientAuthorization(proof, f.receipt, f.context);
    expect(() => requireVerifiedClientAuthorization(result as unknown as VerifiedClientAuthorization, f.receipt)).toThrow('independently verified');
  });

  it('takes an immutable snapshot before awaiting any cryptographic or status work', async () => {
    const f = await fixture(); const proof = f.authorize();
    const promise = verifyDelegatedClientAuthorization(proof, f.receipt, f.context);
    (proof.grant.grant as unknown as Record<string, unknown>)['actor'] = 'did:example:attacker';
    f.context.issuerKeys.length = 0;
    f.context.readStatus = vi.fn(async () => 'revoked' as const);
    const result = await promise;
    expect(result.proof.grant.grant.actor).toBe('did:example:reviewer');
    expect(f.readStatus).toHaveBeenCalledTimes(1);
  });
});
