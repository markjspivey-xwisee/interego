import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { base58btc } from 'multiformats/bases/base58';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { clientKeyId, clientSigningMessage, verifyClientAuthorization, requireVerifiedClientAuthorization,
  type ClientSigningKey, type ClientSignature } from '../integrations/application-runtime/client-authorization.js';
import application from '../integrations/application-runtime/resource-composition.js';
import { ResourceCompositions, type ResourceWriteContext } from '../deploy/mcp-relay/resource-compositions.js';
import { readClientSigningKeys } from '../deploy/mcp-relay/client-signing-keys.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../examples/application-simulation/rule-packs.js';
import { canonicalJson, parseSignedJsonDocument, type Json } from '../integrations/application-runtime/application-lab-runtime.js';

const wallet = Wallet.createRandom();
const other = Wallet.createRandom();
const walletKey: ClientSigningKey = { scheme: 'eip191', address: wallet.address };
const signed = async (message: string, key = walletKey, signer = wallet): Promise<ClientSignature> => ({
  schema: 'interego.client-signature/v1', key, message, signature: await signer.signMessage(clientSigningMessage(message, key)),
});

function passkey(message: string, overrides: { origin?: string; challenge?: string; flags?: number } = {}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
  const key: ClientSigningKey = { scheme: 'webauthn', publicKey: Buffer.from(isoCBOR.encode(cose)).toString('base64url'),
    credentialId: Buffer.from('test-passkey-credential').toString('base64url'), origins: ['https://identity.example'], rpIds: ['identity.example'] };
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: overrides.origin ?? key.origins![0],
    challenge: overrides.challenge ?? hash(clientSigningMessage(message, key)).toString('base64url'), crossOrigin: false }));
  const authenticatorData = Buffer.concat([hash('identity.example'), Buffer.from([overrides.flags ?? 5]), Buffer.from([0, 0, 0, 1])]);
  const signature = sign('sha256', Buffer.concat([authenticatorData, hash(clientDataJSON)]), pair.privateKey);
  const proof: ClientSignature = { schema: 'interego.client-signature/v1', key, message, assertion: {
    id: key.credentialId, rawId: key.credentialId, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') },
  } };
  return { key, proof, cose };
}

describe('client-held authorization signatures', () => {
  it('verifies a registered wallet, preserves the proof, and rejects a forged verification flag', async () => {
    const proof = await signed('reviewed receipt');
    const result = await verifyClientAuthorization(proof, proof.message, [walletKey]);
    expect(result.keyId).toBe(`did:ethr:${wallet.address.toLowerCase()}`);
    expect(result.proof).toEqual(proof);
    expect(Object.isFrozen(result.proof.key)).toBe(true);
    expect(() => requireVerifiedClientAuthorization({ ...result }, proof.message)).toThrow('independently verified');
    expect(() => requireVerifiedClientAuthorization(result, 'other receipt')).toThrow('independently verified');
    const replayOnly = await verifyClientAuthorization(proof, proof.message);
    expect(() => requireVerifiedClientAuthorization(replayOnly, proof.message)).toThrow('independently verified');
  });
  it('rejects modified receipts, wrong credentials and a signature made with another private key', async () => {
    const proof = await signed('receipt');
    await expect(verifyClientAuthorization(proof, 'altered', [walletKey])).rejects.toThrow('exact action');
    await expect(verifyClientAuthorization(await signed('receipt', walletKey, other), 'receipt', [walletKey])).rejects.toThrow('invalid');
    await expect(verifyClientAuthorization(proof, 'receipt', [{ scheme: 'eip191', address: other.address }])).rejects.toThrow('registered credential');
  });
  it('supports an agent-held Ed25519 key', async () => {
    const pair = generateKeyPairSync('ed25519');
    const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const key: ClientSigningKey = { scheme: 'ed25519', publicKeyMultibase: base58btc.encode(new Uint8Array([0xed, 1, ...raw])) };
    const proof: ClientSignature = { schema: 'interego.client-signature/v1', key, message: 'agent receipt',
      signature: sign(null, Buffer.from(clientSigningMessage('agent receipt', key)), pair.privateKey).toString('base64url') };
    expect((await verifyClientAuthorization(proof, proof.message, [key])).keyId).toBe(`did:key:${key.publicKeyMultibase}`);
    const cose = new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, raw]]);
    expect(clientKeyId({ scheme: 'webauthn', publicKey: Buffer.from(isoCBOR.encode(cose)).toString('base64url') })).toBe(clientKeyId(key));
  });
  it('verifies a real P-256 assertion over the receipt challenge and requires user verification', async () => {
    const { proof, key } = passkey('passkey receipt');
    expect((await verifyClientAuthorization(proof, proof.message, [key])).scheme).toBe('webauthn');
    for (const overrides of [{ flags: 1 }, { flags: 4 }, { origin: 'https://attacker.example' }, { challenge: 'different-challenge' }]) {
      const bad = passkey('passkey receipt', overrides);
      await expect(verifyClientAuthorization(bad.proof, bad.proof.message, [bad.key])).rejects.toThrow();
    }
    const forgedOrigins = { ...proof, key: { ...key, origins: ['https://attacker.example'] } };
    // Caller restrictions never replace the identity service's restrictions.
    expect((await verifyClientAuthorization(forgedOrigins, proof.message, [key])).proof.key.origins).toEqual(key.origins);
  });
  it('counts public-key material rather than passkey IDs or COSE metadata', () => {
    const { key, cose } = passkey('receipt');
    const changed = new Map([...cose.entries()].reverse()); changed.set(2, Buffer.from('new label'));
    expect(clientKeyId({ ...key, credentialId: 'different-id', publicKey: Buffer.from(isoCBOR.encode(changed)).toString('base64url') })).toBe(clientKeyId(key));
  });
  it('counts one RSA key across unsigned-integer encodings and verifies its assertions', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const n = Buffer.from(jwk.n!, 'base64url'), e = Buffer.from(jwk.e!, 'base64url');
    const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
    const ids: string[] = [];
    for (const padded of [false, true]) {
      const cose = new Map<number, number | Uint8Array>([[1, 3], [3, -257],
        [-1, padded ? Buffer.concat([Buffer.from([0]), n]) : n],
        [-2, padded ? Buffer.concat([Buffer.from([0, 0]), e]) : e]]);
      const key: ClientSigningKey = { scheme: 'webauthn', publicKey: Buffer.from(isoCBOR.encode(cose)).toString('base64url'),
        credentialId: Buffer.from('synthetic-rsa-' + padded).toString('base64url'),
        origins: ['https://identity.example'], rpIds: ['identity.example'] };
      const message = 'synthetic RSA receipt';
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: key.origins![0],
        challenge: hash(clientSigningMessage(message, key)).toString('base64url'), crossOrigin: false }));
      const authenticatorData = Buffer.concat([hash('identity.example'), Buffer.from([5, 0, 0, 0, 1])]);
      const proof: ClientSignature = { schema: 'interego.client-signature/v1', key, message, assertion: {
        id: key.credentialId!, rawId: key.credentialId!, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
          signature: sign('sha256', Buffer.concat([authenticatorData, hash(clientDataJSON)]), pair.privateKey).toString('base64url') },
      } };
      ids.push((await verifyClientAuthorization(proof, message, [key])).keyId);
    }
    expect(ids[0]).toBe(ids[1]);
  });
  it('reads only the session subject and excludes the relay wallet', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ userId: 'alice', walletAddresses: [wallet.address, other.address] }))) as unknown as typeof fetch;
    const input = { identityUrl: 'https://identity.example', identityToken: 'fixture-token', userId: 'alice', relayAddress: other.address, fetch: fetcher };
    expect(await readClientSigningKeys(input)).toEqual([walletKey]);
    await expect(readClientSigningKeys({ ...input, userId: 'mallory' })).rejects.toThrow('subject differs');
  });
});

async function setup() {
  const pack = releaseControl();
  const approve = pack.contract.actions[0]!;
  const contract = { ...pack.contract, actions: [{ ...approve, clientSignature: true,
    guard: { op: 'all', guards: [approve.guard!, { op: 'none', path: '$state.approvals', where: { itemPath: 'keyId', eq: '$authorization.keyId' } }] } as Json,
    effects: [{ op: 'appendUnique', path: '$state.approvals', by: 'approver', value: { approver: '$actor', at: '$now', keyId: '$authorization.keyId', verified: '$authorization.verified' } }] }, ...pack.contract.actions.slice(1)] };
  const store = fixtureStore({ ...pack, contract });
  const initial = await store.resolve();
  const registry = new ResourceCompositions([application]);
  const publish = vi.fn(async (request: Parameters<ResourceWriteContext['publish']>[0]) => {
    const current = store.heads.get(store.graphs.state)!.head!;
    expect(request.expectedHead).toBe(current.cid);
    const parsed = parseSignedJsonDocument(request.graphContent);
    const url = `https://pod.example/simulation/context-graphs/state-${parsed.document.version}.ttl`;
    const cid = `fixture-cid-${parsed.declaredDigest}`;
    store.descriptors.set(url, { url, cid, content: request.graphContent, authorship: { ...initial.stateDescriptor.authorship!, signedBy: request.actor } });
    store.heads.set(store.graphs.state, { head: { descriptorUrl: url, cid }, forked: false });
    store.history.push({ descriptorUrl: url, cid, supersedes: [current.descriptorUrl!] });
    return { published: true };
  });
  const context: ResourceWriteContext = { reads: { ...store.reads, discover: store.reads.discoverCatalogs },
    principal: 'did:example:alice', identityUrl: 'https://identity.example', now: '2026-09-08T12:00:00.000Z',
    signingKeys: async () => [walletKey], publish };
  const controls = async (ctx = context) => {
    const view = (await registry.render(initial.catalogDescriptor.url, ctx, initial.catalogDescriptor))!;
    return { preview: view.controls.find(c => c.label === 'Preview: Approve release')!, submit: view.controls.find(c => c.label === 'Submit: Approve release')! };
  };
  const invoke = (control: Record<string, unknown>, payload: unknown, ctx = context) => registry.invoke(String(control.descriptorUrl), String(control.action), payload, ctx);
  return { store, registry, context, publish, controls, invoke };
}

describe('descriptor-bound client authorization', () => {
  it('prepares without signing, commits a client proof, re-verifies it on replay and refuses duplicates', async () => {
    const f = await setup(); const controls = await f.controls();
    await expect(f.invoke(controls.submit, {})).rejects.toThrow('client signature is required');
    expect(f.publish).not.toHaveBeenCalled();
    const preview = await f.invoke(controls.preview, {});
    const request = preview!.signingRequest as { message: string };
    expect(preview).toMatchObject({ committed: false });
    expect(f.publish).not.toHaveBeenCalled();
    const proof = await signed(request.message);
    const result = await f.invoke(controls.submit, { client_proof: JSON.stringify(proof) });
    expect(result).toMatchObject({ committed: true, view: { snapshot: { replay: { complete: true, links: [{}, { authorizationBasis: 'client-signature', clientKeyId: clientKeyId(walletKey) }] } } } });
    await expect(f.invoke(controls.submit, { client_proof: proof })).rejects.toThrow('stale application head');
    expect(f.publish).toHaveBeenCalledTimes(1);
    // A second actor using the same key cannot supply a second independent approval.
    const bob = { ...f.context, principal: 'did:example:bob' };
    const next = await f.controls(bob); const p = await f.invoke(next.preview, {}, bob);
    const duplicate = await signed((p!.signingRequest as { message: string }).message);
    await expect(f.invoke(next.submit, { client_proof: duplicate }, bob)).rejects.toThrow('guard refused');
    expect(f.publish).toHaveBeenCalledTimes(1);
    const bobKey: ClientSigningKey = { scheme: 'eip191', address: other.address };
    const independentlyKeyedBob = { ...bob, signingKeys: async () => [bobKey] };
    const otherPreview = await f.invoke(next.preview, {}, independentlyKeyedBob);
    const otherProof = await signed((otherPreview!.signingRequest as { message: string }).message, bobKey, other);
    expect(await f.invoke(next.submit, { client_proof: otherProof }, independentlyKeyedBob)).toMatchObject({ committed: true });
    const after = await f.store.resolve();
    expect(after.replay.complete).toBe(true);
    expect(new Set(after.replay.links.flatMap(link => link.clientKeyId ? [link.clientKeyId] : [])).size).toBe(2);
  });
  it('refuses an expired signature and signing with a different credential', async () => {
    const f = await setup(); const controls = await f.controls();
    const p = await f.invoke(controls.preview, {}); const request = p!.signingRequest as { message: string };
    const proof = await signed(request.message);
    await expect(f.invoke(controls.submit, { client_proof: proof }, { ...f.context, now: '2026-09-08T12:11:00.000Z' })).rejects.toThrow('expired');
    const wrongKey: ClientSigningKey = { scheme: 'eip191', address: other.address };
    await expect(f.invoke(controls.submit, { client_proof: await signed(request.message, wrongKey, other) })).rejects.toThrow('registered credential');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(['actor', 'contractDigest', 'expectedHead', 'payload', 'authority'])('rejects a client-signed alteration to %s', async field => {
    const f = await setup(); const controls = await f.controls();
    const p = await f.invoke(controls.preview, {}); const request = p!.signingRequest as { message: string };
    const altered = JSON.parse(request.message); altered[field] = 'attacker value';
    await expect(f.invoke(controls.submit, { client_proof: await signed(canonicalJson(altered)) })).rejects.toThrow('exact action');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('does not accept a tampered retained proof even after recomputing the outer receipt digest', async () => {
    const f = await setup(); const controls = await f.controls();
    const p = await f.invoke(controls.preview, {}); const request = p!.signingRequest as { message: string };
    await f.invoke(controls.submit, { client_proof: await signed(request.message) });
    const head = f.store.heads.get(f.store.graphs.state)!.head!;
    const descriptor = f.store.descriptors.get(head.descriptorUrl!)!;
    const state = parseSignedJsonDocument(descriptor.content!).document;
    const transition = state.transition as Record<string, Json>;
    const receipt = transition.receipt as Record<string, Json>;
    (receipt.clientAuthorization as Record<string, Json>).signature = (await signed('different receipt')).signature!;
    transition.receiptDigest = createHash('sha256').update(canonicalJson(receipt)).digest('hex');
    const { signedJsonGraph } = await import('../integrations/application-runtime/application-lab-runtime.js');
    f.store.descriptors.set(descriptor.url, { ...descriptor, content: signedJsonGraph(f.store.graphs.state, 'application-state', state).graphContent });
    const replay = (await f.store.resolve()).replay;
    expect(replay.complete).toBe(false);
    expect(replay.links[1]!.errors.join(' ')).toContain('client authorization failed');
  });
  it('the browser signing page produces the verifier-compatible wallet proof and never submits it', async () => {
    const f = await setup(); const controls = await f.controls();
    const p = await f.invoke(controls.preview, {});
    const request = p!.signingRequest as { message: string; expiresAt: string };
    const parsed = JSON.parse(request.message); parsed.at = new Date().toISOString(); request.message = canonicalJson(parsed);
    const dom = new JSDOM(readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8'), {
      url: 'https://identity.example/sign-action', runScripts: 'dangerously', beforeParse(window) {
        Object.defineProperty(window, 'crypto', { value: globalThis.crypto });
        Object.assign(window, { TextEncoder, TextDecoder, ethereum: { request: async (args: { method: string; params: string[] }) => {
          if (args.method === 'eth_requestAccounts') return [wallet.address];
          if (args.method !== 'personal_sign') throw new Error('unexpected wallet request');
          return wallet.signMessage(Buffer.from(args.params[0]!.slice(2), 'hex'));
        } } });
      },
    });
    const doc = dom.window.document;
    (doc.getElementById('request') as HTMLTextAreaElement).value = JSON.stringify(request);
    await (doc.getElementById('load') as HTMLButtonElement).onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
    await (doc.getElementById('sign') as HTMLButtonElement).onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
    const proof = JSON.parse((doc.getElementById('proof') as HTMLTextAreaElement).value);
    expect((await verifyClientAuthorization(proof, request.message, [walletKey])).keyId).toBe(clientKeyId(walletKey));
    expect(f.publish).not.toHaveBeenCalled(); dom.window.close();
  });
});
