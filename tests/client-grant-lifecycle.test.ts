import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Wallet } from 'ethers';
import { base58btc } from 'multiformats/bases/base58';
import { describe, expect, it, vi } from 'vitest';
import { signingFixture } from './fixtures/client-interaction-fixture.js';
import { canonicalJson, sha256Hex, signedJsonGraph,
  type Json } from '../integrations/application-runtime/application-lab-runtime.js';
import { clientKeyId, clientSigningMessage, type ClientSignature } from '../integrations/application-runtime/client-authorization.js';
import { delegatedClientSigningMessage, type ClientSigningGrant, type SignedClientSigningGrant } from '../integrations/application-runtime/client-signing-grant.js';
import { ClientInteractions } from '../deploy/mcp-relay/client-interactions.js';

function subordinate() {
  const pair = generateKeyPairSync('ed25519');
  const key = { scheme: 'ed25519' as const, publicKeyMultibase: base58btc.encode(new Uint8Array([0xed, 1, ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)])) };
  const proof = (message: string): ClientSignature => ({ schema: 'interego.client-signature/v1', key, message,
    signature: sign(null, Buffer.from(clientSigningMessage(message, key)), pair.privateKey).toString('base64url') });
  return { key, proof };
}
type Fixture = Awaited<ReturnType<typeof signingFixture>>;
async function proposal(f: Fixture, actor: 'alice' | 'bob' = 'alice') {
  const signer = subordinate();
  const resolved = await f.store.resolve(f.owners[actor]!.principal);
  const control = await f.control(actor);
  const now = Date.parse(f.context(actor).now);
  const grant: ClientSigningGrant = { schema: 'interego.client-signing-grant/v1', id: 'urn:uuid:' + randomUUID(),
    actor: f.owners[actor]!.principal, issuer: f.owners[actor]!.principal, audience: 'https://relay.example', podUrl: resolved.podUrl,
    applicationId: resolved.state.applicationId, actionIri: String(control['action']), contractDigest: resolved.activeContractEnvelope.declaredDigest,
    key: signer.key, notBefore: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3500_000).toISOString() };
  const payload = { grant: canonicalJson(grant), possession: canonicalJson(signer.proof(canonicalJson(grant))) };
  return { signer, grant, payload, control };
}
async function enroll(f: Fixture, actor: 'alice' | 'bob' = 'alice') {
  const p = await proposal(f, actor);
  const pending = await f.create(actor);
  const child = await f.broker.grant(String(pending!['id']), actor, p.payload);
  const review = await f.broker.review(child.id, actor);
  const result = await f.broker.submit(child.id, actor, review.reviewId, await f.sign(review.signingRequest, actor));
  expect(result.status, JSON.stringify(result)).toBe('completed');
  const after = await f.store.resolve();
  const envelope = after.state.clientSigningGrants!.find(e => e.envelope.grant.id === p.grant.id)!.envelope;
  return { ...p, envelope, parent: String(pending!['id']), child: child.id };
}
async function prepared(f: Fixture, signer: ReturnType<typeof subordinate>, envelope: SignedClientSigningGrant, actor: 'alice' | 'bob' = 'alice') {
  const control = await f.control(actor);
  const draft = await f.registry.prepareSignature(String(control['descriptorUrl']), String(control['action']), {}, f.context(actor));
  const proof = { schema: 'interego.delegated-client-signature/v1', grant: envelope,
    proof: signer.proof(delegatedClientSigningMessage(envelope.grant, draft.request.message)) };
  return { draft, proof, invoke: () => f.registry.invoke(draft.reference, String(control['action']), { client_proof: proof }, f.context(actor)) };
}
async function revoke(f: Fixture, id: string) {
  const resolved = await f.store.resolve();
  const view = (await f.registry.render(resolved.catalogDescriptor.url, f.context(), resolved.catalogDescriptor))!;
  const c = view.controls.find(v => v['label'] === 'Submit: Revoke signing grant')!;
  const payload = { grantId: id };
  const draft = await f.registry.prepareSignature(String(c['descriptorUrl']), String(c['action']), payload, f.context());
  return f.registry.invoke(draft.reference, String(c['action']), { ...payload, client_proof: await f.sign(draft.request) }, f.context());
}

describe('scoped grant enrollment and action ordering', () => {
  it('enrolls, executes two reviewer actions through separate brokers, and replays holder and subordinate proofs', async () => {
    const f = await signingFixture({ clientGrants: true });
    const a = await enroll(f);
    const b = await enroll(f, 'bob');
    for (const [actor, grant] of [['alice', a], ['bob', b]] as const) {
      // A new broker has no verifier cache or private key from enrollment.
      const restarted = new ClientInteractions(f.deps);
      const review = await restarted.review(grant.parent, actor);
      const proof = { schema: 'interego.delegated-client-signature/v1', grant: grant.envelope,
        proof: grant.signer.proof(delegatedClientSigningMessage(grant.grant, review.signingRequest.message)) };
      expect((await restarted.submit(grant.parent, actor, review.reviewId, proof)).status).toBe('completed');
    }
    const result = await f.store.resolve();
    expect(result.replay.complete).toBe(true);
    expect(result.replay.verifiedLinks).toBe(5);
    expect(result.state.data['approvals']).toEqual(expect.arrayContaining(['alice', 'bob'].map(actor => expect.objectContaining({
      approver: f.owners[actor]!.principal, keyId: clientKeyId({ scheme: 'eip191', address: f.wallets[actor as 'alice' | 'bob'].address }), verified: true,
    }))));
    expect(result.replay.links.at(-1)).toMatchObject({ authorizationBasis: 'delegated-client-signature', delegatedKeyId: clientKeyId(b.signer.key) });
  });

  it('revocation invalidates an already signed action and historical enrollment remains verifiable', async () => {
    const f = await signingFixture({ clientGrants: true });
    const g = await enroll(f);
    const old = await prepared(f, g.signer, g.envelope);
    expect((await revoke(f, g.grant.id))!['committed']).toBe(true);
    await expect(old.invoke()).rejects.toThrow(/stale application head/);
    await expect((await prepared(f, g.signer, g.envelope)).invoke()).rejects.toThrow(/active enrolled grant/);
    expect((await f.store.resolve()).replay.complete).toBe(true);
  });

  it('CAS refuses an action when another relay commits revocation immediately before publication', async () => {
    const f = await signingFixture({ clientGrants: true });
    const g = await enroll(f);
    const action = await prepared(f, g.signer, g.envelope);
    const context = f.context();
    const publish = context.publish;
    await expect(f.registry.invoke(action.draft.reference, g.grant.actionIri, { client_proof: action.proof }, {
      ...context, publish: async request => { await revoke(f, g.grant.id); return publish(request); },
    })).rejects.toThrow('CAS failed');
    expect((await f.store.resolve()).state.data['approvals']).toEqual([]);
  });

  it.each(['actor', 'audience', 'root', 'expiry', 'unknown', 'tampered'])('refuses a delegated action with invalid %s', async kind => {
    const f = await signingFixture({ clientGrants: true });
    const g = await enroll(f);
    const a = await prepared(f, g.signer, g.envelope);
    const context = { ...f.context() };
    if (kind === 'actor') context.principal = f.owners['bob']!.principal;
    if (kind === 'audience') context.relayUrl = 'https://another-relay.example';
    if (kind === 'root') context.signingKeys = async () => [];
    if (kind === 'expiry') f.advance(3600_000);
    if (kind === 'unknown') (a.proof.grant.grant as { id: string }).id = 'urn:uuid:' + randomUUID();
    if (kind === 'tampered') (a.proof.grant as { enrollmentReceipt: string }).enrollmentReceipt += ' ';
    await expect(f.registry.invoke(a.draft.reference, g.grant.actionIri, { client_proof: a.proof }, context)).rejects.toThrow();
    expect((await f.store.resolve()).state.data['approvals']).toEqual([]);
  });

  it('refuses duplicate enrollment, another holder, and a contract that has not opted in', async () => {
    const f = await signingFixture({ clientGrants: true });
    const g = await enroll(f);
    await expect(f.broker.grant(g.parent, 'bob', g.payload)).rejects.toThrow('not found');
    const duplicate = await f.broker.grant(g.parent, 'alice', g.payload);
    const review = await f.broker.review(duplicate.id, 'alice');
    await expect(f.broker.submit(duplicate.id, 'alice', review.reviewId, await f.sign(review.signingRequest))).rejects.toThrow('already enrolled');
    const legacy = await signingFixture();
    const p = await proposal(legacy);
    const parent = await legacy.create();
    await expect(legacy.broker.grant(String(parent!['id']), 'alice', p.payload)).rejects.toThrow('does not allow');
  });

  it.each(['registration', 'issuer', 'ledger', 'unrelated-transition'])('historical replay rejects forged %s even with recomputed document digests', async kind => {
    const f = await signingFixture({ clientGrants: true });
    const g = await enroll(f);
    if (kind === 'unrelated-transition') await (await prepared(f, g.signer, g.envelope)).invoke();
    const resolved = await f.store.resolve();
    const state = structuredClone(resolved.state) as unknown as Record<string, Json>;
    const entries = state['clientSigningGrants'] as unknown as { envelope: SignedClientSigningGrant; registration: { signature: string } }[];
    const transition = state['transition'] as Record<string, Json>;
    const receipt = transition['receipt'] as Record<string, Json>;
    if (kind === 'registration') {
      entries[0]!.registration.signature = '0x' + '00'.repeat(65);
      receipt['clientRegistration'] = entries[0]!.registration as unknown as Json;
    }
    if (kind === 'issuer') {
      const wallet = Wallet.createRandom();
      const proof: ClientSignature = { schema: 'interego.client-signature/v1', key: { scheme: 'eip191', address: wallet.address }, message: entries[0]!.envelope.enrollmentReceipt! };
      const forged = { ...proof, signature: await wallet.signMessage(clientSigningMessage(proof.message, proof.key)) };
      receipt['clientAuthorization'] = forged as unknown as Json;
      (entries[0]!.envelope as { issuerProof: ClientSignature }).issuerProof = forged;
    }
    if (kind === 'ledger' || kind === 'unrelated-transition') state['clientSigningGrants'] = [];
    transition['receiptDigest'] = sha256Hex(canonicalJson(receipt));
    const graph = signedJsonGraph(f.store.graphs.state, 'application-state', state);
    f.store.descriptors.set(resolved.stateHead.descriptorUrl, { ...resolved.stateDescriptor, content: graph.graphContent });
    const after = await f.store.resolve();
    expect(after.replay.complete).toBe(false);
    expect(after.replay.links.at(-1)!.errors.join(' ')).toMatch(/attestation|ledger replay|authorization/);
  });

  it('does not expose another account’s pending queue', async () => {
    const f = await signingFixture({ clientGrants: true });
    const a = await f.create();
    await f.create('bob');
    await expect(f.broker.pending(String(a!['id']), 'bob')).rejects.toThrow('not found');
    expect((await f.broker.pending(String(a!['id']), 'alice')).requests).toHaveLength(1);
  });
});

describe('owner browser companion', () => {
  it('authorizes one grant, signs the pending action with a nonexportable browser key, and discards it on stop', async () => {
    const f = await signingFixture({ clientGrants: true });
    const parent = await f.create();
    let walletSignatures = 0;
    const cryptoCalls = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
      .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: 'https://identity.example', relayUrl: 'https://relay.example' }));
    const dom = new JSDOM(html, { url: String(parent!['signingUrl']), runScripts: 'dangerously', beforeParse(window) {
      window.sessionStorage.setItem('cg.token', 'holder-alice');
      Object.defineProperty(window, 'crypto', { value: globalThis.crypto });
      Object.assign(window, { TextEncoder, TextDecoder,
        fetch: async (url: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
          expect(options.headers['Authorization']).toBe('Bearer holder-alice');
          const [, , id, operation] = new URL(url).pathname.split('/');
          const body = JSON.parse(options.body ?? '{}') as { proof: unknown; reviewId: string };
          const result = operation === 'review' ? await f.broker.review(id!, 'alice')
            : operation === 'submit' ? await f.broker.submit(id!, 'alice', body.reviewId, body.proof)
              : operation === 'grant' ? await f.broker.grant(id!, 'alice', body)
                : operation === 'pending' ? await f.broker.pending(id!, 'alice') : await f.broker.status(id!, { holderUserId: 'alice' });
          return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        }, ethereum: { request: async (args: { method: string; params: string[] }) => {
          if (args.method === 'eth_requestAccounts') return [f.wallets.alice.address];
          if (args.method === 'personal_sign') { walletSignatures++; return f.wallets.alice.signMessage(Buffer.from(args.params[0]!.slice(2), 'hex')); }
          throw new Error('unexpected wallet call');
        } },
      });
    } });
    const button = (id: string) => dom.window.document.getElementById(id) as HTMLButtonElement;
    try {
      await vi.waitFor(() => expect(button('sign').disabled).toBe(false));
      await button('enable-scoped').onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
      expect(button('sign').textContent, dom.window.document.getElementById('status')!.textContent!).toBe('Authorize this scoped signing grant');
      await button('sign').onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
      expect(dom.window.document.getElementById('scope-status')!.textContent).toContain('Signed and verified an action');
      expect(walletSignatures).toBe(1);
      expect(cryptoCalls).toHaveBeenCalledWith('Ed25519', false, ['sign', 'verify']);
      const result = await f.store.resolve();
      expect(result.state.version).toBe(2);
      expect(result.replay.complete).toBe(true);
      expect(result.replay.links.at(-1)!.authorizationBasis).toBe('delegated-client-signature');
      expect(JSON.stringify([...f.storage.records.values()])).not.toMatch(/privateKey|PRIVATE KEY/);
      button('stop-scoped').click();
      expect(dom.window.document.getElementById('scope-status')!.textContent).toContain('private key was discarded');
    } finally { dom.window.close(); cryptoCalls.mockRestore(); }
  });
});
