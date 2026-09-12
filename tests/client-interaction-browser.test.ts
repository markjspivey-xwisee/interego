import { describe, expect, it } from 'vitest';
import { ClientInteractions, INTERACTION_OPEN, type BrowserInteractionCaller, type InteractionOwner } from '../deploy/mcp-relay/client-interactions.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

const origin = 'https://identity.example';
const launchCode = (value: { signingUrl: string }) => new URL(value.signingUrl).hash.slice('#launch='.length);
async function browserFixture(options: { clientGrants?: boolean } = {}) {
  const f = await signingFixture(options);
  const pending = (await f.create())!;
  const id = String(pending['id']);
  const launch = await f.broker.openSigning(id, f.owners['alice']!);
  const exchanged = await f.broker.exchangeBrowser(id, launchCode(launch), origin);
  const caller: BrowserInteractionCaller = { kind: 'browser-interaction', credential: exchanged.credential, origin };
  return { ...f, id, launch, exchanged, caller };
}

describe('single-receipt browser signing capabilities', () => {
  it('requires the exact authenticated owner and exposes only a fresh fragment launch', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    expect(pending['openAction']).toBe(INTERACTION_OPEN);
    expect(new URL(String(pending['signingUrl'])).hash).toBe('');
    for (const owner of [f.owners['bob']!, { ...f.owners['alice']!, clientId: 'another-client' }, { ...f.owners['alice']!, principal: 'another-agent' }]) {
      await expect(f.broker.openSigning(id, owner)).rejects.toThrow('not found');
    }
    await expect(f.broker.openSigning(id, { holderUserId: 'alice' } as unknown as InteractionOwner)).rejects.toThrow('not found');
    await expect(f.broker.exchangeBrowser(id, id, origin)).rejects.toThrow('invalid or expired');
    const launch = await f.broker.openSigning(id, f.owners['alice']!);
    expect(launch).toMatchObject({ schema: 'interego.client-interaction/v1', id, status: 'pending', actor: f.owners['alice']!.principal });
    expect(launch.signingUrl).toMatch(/^https:\/\/identity.example\/sign-action\?request=[\w-]{43}#launch=[\w-]{43}$/);
    expect(Date.parse(launch.launchExpiresAt) - f.deps.now()).toBe(120_000);
    expect(launch.expiresAt).toBe(pending['expiresAt']);
    const stored = JSON.stringify(f.storage.records.get(id)!.record);
    expect(stored).not.toContain(launchCode(launch));
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('rejects foreign origins, altered codes, cross-request codes, and used codes', async () => {
    const f = await signingFixture(); const a = (await f.create())!; const b = (await f.create('bob'))!;
    const id = String(a['id']); const launch = await f.broker.openSigning(id, f.owners['alice']!); const code = launchCode(launch);
    for (const foreign of ['https://evil.example', 'https://identity.example.evil.test', 'null', '']) {
      await expect(f.broker.exchangeBrowser(id, code, foreign)).rejects.toThrow('not authorized');
    }
    await expect(f.broker.exchangeBrowser(String(b['id']), code, origin)).rejects.toThrow('invalid or expired');
    await expect(f.broker.exchangeBrowser(id, 'invalid', origin)).rejects.toThrow('invalid or expired');
    await expect(f.broker.exchangeBrowser(id, 'z'.repeat(43), origin)).rejects.toThrow('invalid or expired');
    const session = await f.broker.exchangeBrowser(id, code, origin);
    expect(session).toMatchObject({ schema: 'interego.browser-signing/v1', id });
    expect(session.credential).toMatch(/^[\w-]{43}$/);
    expect(Date.parse(session.expiresAt) - f.deps.now()).toBe(300_000);
    await expect(f.broker.exchangeBrowser(id, code, origin)).rejects.toThrow('invalid or expired');
    const stored = JSON.stringify(f.storage.records.get(id)!.record);
    expect(stored).not.toContain(code); expect(stored).not.toContain(session.credential);
  });

  it('atomically consumes a launch across simultaneous exchanges and broker restarts', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const launch = await f.broker.openSigning(id, f.owners['alice']!);
    const restarted = new ClientInteractions(f.deps);
    const results = await Promise.allSettled([f.broker.exchangeBrowser(id, launchCode(launch), origin), restarted.exchangeBrowser(id, launchCode(launch), origin)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const success = results.find(r => r.status === 'fulfilled')!;
    if (success.status !== 'fulfilled') throw new Error('missing exchange result');
    expect(await restarted.browserStatus(id, { kind: 'browser-interaction', credential: success.value.credential, origin }))
      .toMatchObject({ id, status: 'pending' });
    expect(f.storage.records.get(id)!.record.browserLaunch).toBeUndefined();
  });

  it('expires launches at two minutes and caps browser access at OAuth and interaction expiry', async () => {
    const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
    const launch = await f.broker.openSigning(id, f.owners['alice']!);
    f.advance(120_000);
    await expect(f.broker.exchangeBrowser(id, launchCode(launch), origin)).rejects.toThrow('invalid or expired');
    const oauthExpiry = f.deps.now() + 45_000;
    const short = new ClientInteractions({ ...f.deps, authorize: async credential => ({ ...await f.deps.authorize(credential), expiresAt: oauthExpiry }) });
    const limited = await short.openSigning(id, f.owners['alice']!);
    expect(Date.parse(limited.launchExpiresAt)).toBe(oauthExpiry);
    const session = await short.exchangeBrowser(id, launchCode(limited), origin);
    expect(Date.parse(session.expiresAt)).toBe(oauthExpiry);
    const caller: BrowserInteractionCaller = { kind: 'browser-interaction', credential: session.credential, origin };
    f.advance(45_000);
    await expect(short.browserStatus(id, caller)).rejects.toThrow('not authorized');
    // Independently, an otherwise live OAuth grant cannot outlast the request.
    f.advance(27 * 60_000);
    const last = await f.broker.openSigning(id, f.owners['alice']!);
    const end = await f.broker.exchangeBrowser(id, launchCode(last), origin);
    expect(end.expiresAt).toBe(pending['expiresAt']);
  });

  it('rejects forged browser credentials, origins, other requests and holder/owner operations', async () => {
    const f = await browserFixture(); const other = (await f.create('bob'))!;
    await expect(f.broker.browserStatus(f.id, { ...f.caller, credential: 'x'.repeat(43) })).rejects.toThrow('not authorized');
    await expect(f.broker.browserReview(f.id, { ...f.caller, origin: 'https://evil.example' })).rejects.toThrow('not authorized');
    await expect(f.broker.browserStatus(String(other['id']), f.caller)).rejects.toThrow('not authorized');
    const forgedOwner = { ...f.owners['alice']!, ...f.caller } as InteractionOwner;
    await expect(f.broker.openSigning(f.id, forgedOwner)).rejects.toThrow('not found');
    await expect(f.broker.status(f.id, forgedOwner)).rejects.toThrow('not found');
    await expect(f.broker.cancel(f.id, forgedOwner)).rejects.toThrow('not found');
    const notHolder = f.caller as unknown as string;
    await expect(f.broker.review(f.id, notHolder)).rejects.toThrow('not found');
    await expect(f.broker.pending(f.id, notHolder)).rejects.toThrow('not found');
    await expect(f.broker.grant(f.id, notHolder, {})).rejects.toThrow('not found');
    await expect(f.broker.renewAuthorization(f.id, f.caller.credential)).rejects.toThrow('grant revoked');
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('revalidates the original OAuth on launch exchange, status, review and submission', async () => {
    const f = await browserFixture(); const review = await f.broker.browserReview(f.id, f.caller); const proof = await f.sign(review.signingRequest);
    f.revoked.add('alice');
    await expect(f.broker.browserStatus(f.id, f.caller)).rejects.toThrow('grant revoked');
    await expect(f.broker.browserReview(f.id, f.caller)).rejects.toThrow('grant revoked');
    await expect(f.broker.browserSubmit(f.id, f.caller, review.reviewId, proof)).rejects.toThrow('grant revoked');
    await expect(f.broker.openSigning(f.id, f.owners['alice']!)).rejects.toThrow('grant revoked');
    f.revoked.clear();
    const launch = await f.broker.openSigning(f.id, f.owners['alice']!);
    f.revoked.add('alice');
    await expect(f.broker.exchangeBrowser(f.id, launchCode(launch), origin)).rejects.toThrow('grant revoked');
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('refuses changed OAuth ownership and withdrawn configured signing origins', async () => {
    const f = await browserFixture();
    for (const change of [{ userId: 'bob' }, { clientId: 'another-client' }, { principal: 'another-agent' }]) {
      const changed = new ClientInteractions({ ...f.deps, authorize: async credential => ({ ...await f.deps.authorize(credential), ...change }) });
      await expect(changed.browserStatus(f.id, f.caller)).rejects.toThrow('originating authorization expired or changed');
    }
    const moved = new ClientInteractions({ ...f.deps, signingOrigins: ['https://relay.example'] });
    await expect(moved.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
    f.storage.records.get(f.id)!.record.credential = 'bob';
    await expect(f.broker.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('invalidates all older generations on a new launch or authorization renewal', async () => {
    const f = await browserFixture();
    const launch = await f.broker.openSigning(f.id, f.owners['alice']!);
    await expect(f.broker.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
    const newer = await f.broker.openSigning(f.id, f.owners['alice']!);
    await expect(f.broker.exchangeBrowser(f.id, launchCode(launch), origin)).rejects.toThrow('invalid or expired');
    const session = await f.broker.exchangeBrowser(f.id, launchCode(newer), origin);
    const caller = { ...f.caller, credential: session.credential };
    await f.broker.browserReview(f.id, caller);
    await f.broker.renewAuthorization(f.id, 'alice');
    await expect(f.broker.browserStatus(f.id, caller)).rejects.toThrow('not authorized');
    expect(f.storage.records.get(f.id)!.record.draft).toBeUndefined();
    const pending = await f.broker.openSigning(f.id, f.owners['alice']!);
    await f.broker.renewAuthorization(f.id, 'alice');
    await expect(f.broker.exchangeBrowser(f.id, launchCode(pending), origin)).rejects.toThrow('invalid or expired');
  });

  it('invalidates cancellation and non-browser completion without exposing their terminal results', async () => {
    const f = await browserFixture();
    await f.broker.cancel(f.id, f.owners['alice']!);
    await expect(f.broker.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
    const other = await browserFixture();
    const review = await other.broker.review(other.id, 'alice');
    await other.broker.submit(other.id, 'alice', review.reviewId, await other.sign(review.signingRequest));
    await expect(other.broker.browserStatus(other.id, other.caller)).rejects.toThrow('not authorized');
    expect(other.storage.records.get(other.id)!.record.credential).toBe('');
  });

  it('keeps exact-receipt proof validation and refuses delegated browser proofs', async () => {
    const f = await browserFixture({ clientGrants: true }); const review = await f.broker.browserReview(f.id, f.caller);
    expect(review.signingRequest).not.toHaveProperty('clientGrants');
    await expect(f.broker.browserSubmit(f.id, f.caller, review.reviewId, { schema: 'interego.delegated-client-signature/v1' }))
      .rejects.toThrow('direct registered holder signature');
    await expect(f.broker.browserSubmit(f.id, f.caller, 'wrong-review', await f.sign(review.signingRequest))).rejects.toThrow('current review');
    await expect(f.broker.browserSubmit(f.id, f.caller, review.reviewId, await f.sign(review.signingRequest, 'bob'))).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    expect((await f.broker.browserStatus(f.id, f.caller)).status).toBe('reviewing');
  });

  it('preserves current-head validation before claiming a browser submission', async () => {
    const f = await browserFixture(); const review = await f.broker.browserReview(f.id, f.caller);
    const bob = (await f.create('bob'))!; const other = await f.broker.review(String(bob['id']), 'bob');
    await f.broker.submit(String(bob['id']), 'bob', other.reviewId, await f.sign(other.signingRequest, 'bob'));
    await expect(f.broker.browserSubmit(f.id, f.caller, review.reviewId, await f.sign(review.signingRequest))).rejects.toThrow('state changed');
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect((await f.broker.browserStatus(f.id, f.caller)).status).toBe('reviewing');
  });

  it('commits once, retains only minimal terminal browser access, and replays the real signature', async () => {
    const f = await browserFixture(); const review = await f.broker.browserReview(f.id, f.caller); const proof = await f.sign(review.signingRequest);
    const result = await f.broker.browserSubmit(f.id, f.caller, review.reviewId, proof);
    // Verify the durable terminal write itself, before any follow-up access.
    expect(f.storage.records.get(f.id)!.record.credential).toBe('');
    expect(f.storage.records.get(f.id)!.record.draft).toBeUndefined();
    expect(result).toMatchObject({ id: f.id, status: 'completed', result: { committed: true } });
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'id', 'result', 'status']);
    expect(Object.keys(result.result!).sort()).toEqual(['committed', 'status']);
    expect(await f.broker.browserSubmit(f.id, f.caller, review.reviewId, proof)).toEqual(result);
    expect(await f.broker.browserStatus(f.id, f.caller)).toEqual(result);
    await expect(f.broker.browserReview(f.id, f.caller)).rejects.toThrow('cannot be reviewed');
    await expect(f.broker.openSigning(f.id, f.owners['alice']!)).rejects.toThrow('live signing request');
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect((await f.store.resolve()).replay.complete).toBe(true);
    // Reporting the already-completed minimal result is the deliberate exception
    // to live-grant revalidation; the general bearer has already been erased.
    f.revoked.add('alice');
    expect(await f.broker.browserStatus(f.id, f.caller)).toEqual(result);
    expect(await f.broker.browserSubmit(f.id, f.caller, review.reviewId, proof)).toEqual(result);
    await expect(f.broker.browserReview(f.id, f.caller)).rejects.toThrow('cannot be reviewed');
    f.advance(5 * 60_000);
    await expect(f.broker.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
    expect(f.storage.records.get(f.id)!.record.credential).toBe('');
  });

  it('erases general OAuth immediately on failed or ambiguous publication without follow-up access', async () => {
    for (const ambiguous of [false, true]) {
      const f = await browserFixture();
      const broker = new ClientInteractions({ ...f.deps, execute: async () => {
        if (ambiguous) throw new Error('connection lost after publication');
        return { error: 'publication_failed', status: 'failed', committed: false };
      } });
      const review = await broker.browserReview(f.id, f.caller); const proof = await f.sign(review.signingRequest);
      const result = await broker.browserSubmit(f.id, f.caller, review.reviewId, proof);
      expect(f.storage.records.get(f.id)!.record.credential).toBe('');
      expect(f.storage.records.get(f.id)!.record.draft).toBeUndefined();
      expect(result).toMatchObject({ id: f.id, status: 'failed', result: { committed: ambiguous ? 'unknown' : false } });
      expect(Object.keys(result.result!).sort()).toEqual(['committed', 'status']);
      f.revoked.add('alice');
      expect(await broker.browserStatus(f.id, f.caller)).toEqual(result);
      expect(await broker.browserSubmit(f.id, f.caller, review.reviewId, proof)).toEqual(result);
      await expect(broker.browserReview(f.id, f.caller)).rejects.toThrow('cannot be reviewed');
      await expect(broker.openSigning(f.id, f.owners['alice']!)).rejects.toThrow('live signing request');
      f.advance(5 * 60_000);
      await expect(broker.browserStatus(f.id, f.caller)).rejects.toThrow('not authorized');
      expect(f.publish).not.toHaveBeenCalled();
    }
  });
});
