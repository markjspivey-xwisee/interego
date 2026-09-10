import { describe, expect, it } from 'vitest';
import { ClientInteractions, clientInteractionComposition, INTERACTION_RENEW } from '../deploy/mcp-relay/client-interactions.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

describe('explicit pending-request authorization renewal', () => {
  it('resumes after access expiry, preserves the original window and requires fresh review', async () => {
    const f = await signingFixture();
    const originalAuthorize = f.deps.authorize;
    const createdAt = Date.now();
    f.deps.authorize = async token => ({ ...await originalAuthorize(token === 'refreshed' ? 'alice' : token),
      expiresAt: createdAt + (token === 'refreshed' ? 3600_000 : 120_000) });
    const pending = (await f.create())!; const id = String(pending['id']);
    const review = await f.broker.review(id, 'alice');
    f.advance(180_000);
    const revision = f.storage.records.get(id)!.revision;
    expect((await f.broker.status(id, f.owners['alice']!)).status).toBe('expired');
    expect(f.storage.records.get(id)!.revision).toBe(revision); // polling never reauthorizes
    const resumed = await new ClientInteractions(f.deps).renewAuthorization(id, 'refreshed');
    expect(resumed.status).toBe('pending');
    const record = f.storage.records.get(id)!.record;
    expect(record.credential).toBe('refreshed');
    expect(record.expiresAt).toBe(record.createdAt + 30 * 60_000);
    expect(record.binding).toBeTruthy(); expect(record.draft).toBeUndefined();
    await expect(f.broker.submit(id, 'alice', review.reviewId, await f.sign(review.signingRequest))).rejects.toThrow('review this request');
    expect(f.publish).not.toHaveBeenCalled();
    f.advance(30 * 60_000);
    await expect(f.broker.renewAuthorization(id, 'refreshed')).rejects.toThrow('expired');
  });
  it('rejects changed actor/client, revoked grants, cancelled and uncertain submissions', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const authorize = f.deps.authorize;
    f.deps.authorize = async token => ({ ...await authorize('alice'), ...(token === 'client' ? { clientId: 'other' } : { principal: 'did:example:other' }) });
    await expect(f.broker.renewAuthorization(id, 'client')).rejects.toThrow('not found');
    await expect(f.broker.renewAuthorization(id, 'actor')).rejects.toThrow('not found');
    f.deps.authorize = authorize; f.revoked.add('alice');
    await expect(f.broker.renewAuthorization(id, 'alice')).rejects.toThrow('revoked'); f.revoked.clear();
    await f.broker.cancel(id, f.owners['alice']!);
    await expect(f.broker.renewAuthorization(id, 'alice')).rejects.toThrow('cannot be resumed');
    const entry = f.storage.records.get(id)!;
    for (const status of ['submitting', 'completed', 'failed'] as const) {
      entry.record.status = status;
      await expect(f.broker.renewAuthorization(id, 'alice')).rejects.toThrow('cannot be resumed');
    }
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('publishes an explicit write affordance that works through the generic composition', async () => {
    const f = await signingFixture(); const pending = (await f.create())!;
    const composition = clientInteractionComposition(); const ref = String(pending['descriptorUrl']);
    const context = { ...f.context(), interactionStatus: (id: string) => f.broker.status(id, f.owners['alice']!),
      renewInteraction: (id: string) => f.broker.renewAuthorization(id, 'alice') };
    expect(composition.access(ref, INTERACTION_RENEW)).toBe('write');
    const view = await composition.render(ref, context);
    expect(view!.controls).toContainEqual(expect.objectContaining({ action: INTERACTION_RENEW, method: 'POST' }));
    expect(await composition.invoke(ref, INTERACTION_RENEW, {}, context)).toMatchObject({ id: pending['id'], status: 'pending' });
  });
});
