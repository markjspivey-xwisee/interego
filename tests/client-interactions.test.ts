import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@interego/core';
import { ClientInteractions, encryptedInteractionStore } from '../deploy/mcp-relay/client-interactions.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

describe('durable client signing handoffs', () => {
  it('encrypts private requests at rest and refuses lost conditional-write protection', async () => {
    const f = await signingFixture(); const pending = (await f.create())!;
    const record = f.storage.records.get(String(pending['id']))!.record;
    let saved = ''; let revision = 0;
    const encryptionKey = generateKeyPair();
    const fetcher = async (_url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (options?.method === 'PUT') {
        if (revision ? options.headers?.['If-Match'] !== String(revision) : options.headers?.['If-None-Match'] !== '*') return new Response('', { status: 412 });
        saved = options.body!; revision++; return new Response('', { status: 201 });
      }
      return new Response(saved, { headers: { ETag: String(revision) } });
    };
    const config = { podUrl: 'https://pod.example/service/', fetch: fetcher, encryptionKey };
    const store = encryptedInteractionStore(config); await store.write(record);
    expect(saved).not.toContain(record.credential); expect(saved).not.toContain(record.owner.principal);
    const restarted = encryptedInteractionStore(config);
    expect((await restarted.read(record.id))!.record).toEqual(record);
    await expect(restarted.write(record)).rejects.toThrow('interaction changed');
    await expect(encryptedInteractionStore({ ...config, encryptionKey: generateKeyPair() }).read(record.id)).rejects.toThrow();
    await expect(encryptedInteractionStore({ ...config, fetch: async () => new Response(saved) }).read(record.id)).rejects.toThrow('conditional writes');
  });
  it('records two real independent signatures after a head change, and replays both', async () => {
    const f = await signingFixture();
    const a = (await f.create())!; const b = (await f.create('bob'))!;
    expect(f.publish).not.toHaveBeenCalled();
    expect(a['signingUrl']).toMatch(/^https:\/\/identity.example\/sign-action\?request=[\w-]{43}$/);
    const oldBob = await f.broker.review(String(b['id']), 'bob');
    f.advance(12 * 60_000); // Chat delay consumes no signing-receipt TTL.
    const alice = await f.broker.review(String(a['id']), 'alice');
    const result = await f.broker.submit(String(a['id']), 'alice', alice.reviewId, await f.sign(alice.signingRequest));
    expect(result.status).toBe('completed');
    await expect(f.broker.submit(String(b['id']), 'bob', oldBob.reviewId, await f.sign(oldBob.signingRequest, 'bob'))).rejects.toThrow('review expired');
    const freshBob = await f.broker.review(String(b['id']), 'bob');
    expect(freshBob.signingRequest.message).not.toBe(oldBob.signingRequest.message);
    expect((await f.broker.submit(String(b['id']), 'bob', freshBob.reviewId, await f.sign(freshBob.signingRequest, 'bob'))).status).toBe('completed');
    const resolved = await f.store.resolve();
    expect(resolved.replay.complete).toBe(true);
    const approvals = resolved.state.data['approvals'] as Array<{ approver: string; keyId: string; verified: boolean }>;
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map(a => a.approver)).size).toBe(2);
    expect(new Set(approvals.map(a => a.keyId)).size).toBe(2);
    expect(approvals.every(a => a.verified)).toBe(true);
    expect(f.publish).toHaveBeenCalledTimes(2);
  });
  it('survives a broker restart and makes duplicate submissions idempotent', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const restarted = new ClientInteractions(f.deps);
    expect(await restarted.status(id, f.owners['alice']!)).toMatchObject({ status: 'pending' });
    const control = await f.control();
    expect(await restarted.existing('alice', String(control['descriptorUrl']), String(control['action']), { client_proof: '' }, f.owners['alice']!)).toMatchObject({ id, status: 'pending' });
    expect(await restarted.resume(id, f.owners['alice']!, String(control['descriptorUrl']), String(control['action']), { client_proof: '' })).toMatchObject({ id, status: 'pending' });
    const review = await restarted.review(id, 'alice'); const proof = await f.sign(review.signingRequest);
    const first = await restarted.submit(id, 'alice', review.reviewId, proof);
    expect(await restarted.submit(id, 'alice', review.reviewId, proof)).toEqual(first);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.storage.records.get(id)!.record.credential).toBe('');
  });
  it('rejects another account, another client, forged continuation inputs and forged signatures', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    await expect(f.broker.review(id, 'bob')).rejects.toThrow('not found');
    await expect(f.broker.status(id, { ...f.owners['alice']!, clientId: 'different-client' })).rejects.toThrow('not found');
    const c = await f.control();
    await expect(f.broker.resume(id, f.owners['alice']!, String(c['descriptorUrl']), String(c['action']), { forged: true })).rejects.toThrow('original action');
    const review = await f.broker.review(id, 'alice');
    await expect(f.broker.submit(id, 'alice', review.reviewId, await f.sign(review.signingRequest, 'bob'))).rejects.toThrow();
    expect((await f.broker.status(id, f.owners['alice']!)).status).toBe('reviewing');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('chooses a configured origin compatible with the holder key and refuses arbitrary origins', async () => {
    const f = await signingFixture(); const control = await f.control();
    const reference = String(control['descriptorUrl']); const action = String(control['action']);
    const original = await f.registry.prepareSignature(reference, action, {}, f.context());
    const draft = { ...original, request: { ...original.request, keys: [{ keyId: 'test-passkey', key: {
      scheme: 'webauthn' as const, credentialId: 'test', origins: ['https://relay.example'], rpIds: ['relay.example'],
    } }] } };
    const broker = new ClientInteractions({ ...f.deps, signingOrigins: ['https://identity.example', 'https://relay.example'] });
    const request = { credential: 'alice', reference, action, payload: {}, draft };
    expect((await broker.create(request)).signingUrl).toMatch(/^https:\/\/relay.example\/sign-action\?request=/);
    // A wallet and legacy multi-origin credential must not override a verified
    // passkey's registration site just because identity is configured first.
    const mixed = { ...draft, request: { ...draft.request, keys: [
      ...original.request.keys,
      { keyId: 'legacy', key: { scheme: 'webauthn' as const, credentialId: 'legacy',
        origins: ['https://identity.example', 'https://relay.example'], rpIds: ['example', 'identity.example', 'relay.example'] } },
      ...draft.request.keys,
    ] } };
    expect((await broker.create({ ...request, payload: { mixed: true }, draft: mixed })).signingUrl)
      .toMatch(/^https:\/\/relay.example\/sign-action\?request=/);
    const unsupported = { ...draft, request: { ...draft.request, keys: [{ keyId: 'foreign', key: {
      scheme: 'webauthn' as const, credentialId: 'foreign', origins: ['https://unconfigured.example'], rpIds: ['unconfigured.example'],
    } }] } };
    await expect(broker.create({ ...request, payload: { different: true }, draft: unsupported })).rejects.toThrow('No configured signing page');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('requires fresh review after a current-state change even while the old proof is unexpired', async () => {
    const f = await signingFixture(); const a = (await f.create())!; const b = (await f.create('bob'))!;
    const ar = await f.broker.review(String(a['id']), 'alice'); const br = await f.broker.review(String(b['id']), 'bob');
    await f.broker.submit(String(a['id']), 'alice', ar.reviewId, await f.sign(ar.signingRequest));
    await expect(f.broker.submit(String(b['id']), 'bob', br.reviewId, await f.sign(br.signingRequest, 'bob'))).rejects.toThrow('state changed');
    expect((await f.broker.status(String(b['id']), f.owners['bob']!)).status).toBe('reviewing');
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('cancels durably, refuses expired requests and rechecks the originating grant', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const review = await f.broker.review(id, 'alice');
    await f.broker.cancel(id, f.owners['alice']!);
    expect((await f.broker.submit(id, 'alice', review.reviewId, await f.sign(review.signingRequest))).status).toBe('cancelled');
    const second = (await f.create())!;
    f.revoked.add('alice');
    await expect(f.broker.review(String(second['id']), 'alice')).rejects.toThrow('grant revoked');
    f.revoked.clear(); f.advance(31 * 60_000);
    expect((await f.broker.status(String(second['id']), f.owners['alice']!)).status).toBe('expired');
    await expect(f.broker.review(String(second['id']), 'alice')).rejects.toThrow('expired');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('refuses authority changes and does not retry an ambiguous publication', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const changed = new ClientInteractions({ ...f.deps, prepare: async record => ({ ...await f.deps.prepare(record), binding: 'different evidence' }) });
    await expect(changed.review(id, 'alice')).rejects.toThrow('authority, evidence');
    const broken = new ClientInteractions({ ...f.deps, execute: async () => { throw new Error('connection lost after publish'); } });
    const review = await broken.review(id, 'alice');
    const result = await broken.submit(id, 'alice', review.reviewId, await f.sign(review.signingRequest));
    expect(result).toMatchObject({ status: 'failed', result: { committed: 'unknown', error: 'submission_requires_reconciliation' } });
    expect(await broken.submit(id, 'alice', review.reviewId, await f.sign(review.signingRequest))).toEqual(result);
  });
});
