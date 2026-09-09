import { describe, expect, it, vi } from 'vitest';
import { clientSigningSession, type ClientSigningScope } from '../integrations/application-runtime/client-signing-session.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

async function setup(who: 'alice' | 'bob' = 'alice', fixture?: Awaited<ReturnType<typeof signingFixture>>) {
  const f = fixture ?? await signingFixture();
  const view = (await f.registry.render(f.initial.catalogDescriptor.url, f.context(who), f.initial.catalogDescriptor))!;
  const get = (label: string) => {
    const c = view.controls.find(c => c['label'] === label)!;
    return { descriptorUrl: String(c['descriptorUrl']), action: String(c['action']) };
  };
  const preview = get('Preview: Approve release'), submit = get('Submit: Approve release');
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (f.revoked.has(who)) throw new Error('grant revoked');
    const out = await f.registry.invoke(String(args['descriptor_url']), String(args['action_iri']), args['payload'], f.context(who));
    return { status: 200, body: JSON.stringify(out) };
  });
  const sign = vi.fn((message: string) => f.wallets[who].signMessage(message));
  const scope: ClientSigningScope = { actor: f.owners[who]!.principal,
    applicationId: f.initial.activeContract.applicationId, actionIri: submit.action,
    contractDigest: f.initial.activeContractEnvelope.declaredDigest,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), review: vi.fn(async () => true) };
  const config = { call, sign, scope, key: { scheme: 'eip191' as const, address: f.wallets[who].address } };
  return { f, preview, submit, call, sign, scope, config, session: clientSigningSession(config) };
}

describe('runtime-held client signer over the existing MCP session', () => {
  it('records two distinct own-key approvals without creating human handoffs', async () => {
    const a = await setup();
    expect(await a.session.execute(a.preview, a.submit)).toMatchObject({ committed: true });
    const b = await setup('bob', a.f);
    expect(await b.session.execute(b.preview, b.submit)).toMatchObject({ committed: true });
    expect(a.f.storage.records.size).toBe(0);
    expect(a.call).toHaveBeenCalledTimes(2);
    expect(b.call).toHaveBeenCalledTimes(2);
    const state = await a.f.store.resolve();
    expect(state.replay.complete).toBe(true);
    const approvals = state.state.data['approvals'] as Array<{ approver: string; keyId: string }>;
    expect(new Set(approvals.map(v => v.approver)).size).toBe(2);
    expect(new Set(approvals.map(v => v.keyId)).size).toBe(2);
  });
  it.each(['actor', 'applicationId', 'contractDigest'] as const)('refuses a receipt outside the configured %s', async field => {
    const s = await setup();
    const session = clientSigningSession({ ...s.config, scope: { ...s.scope, [field]: 'wrong' } });
    await expect(session.execute(s.preview, s.submit)).rejects.toThrow('outside signing scope');
    expect(s.sign).not.toHaveBeenCalled();expect(s.f.publish).not.toHaveBeenCalled();
  });
  it('does not sign when review refuses or the configured scope expires', async () => {
    const s = await setup();
    const session = clientSigningSession({ ...s.config, scope: { ...s.scope, review: async () => false } });
    await expect(session.execute(s.preview, s.submit)).rejects.toThrow('review refused');
    const expired = clientSigningSession({ ...s.config, scope: { ...s.scope, expiresAt: new Date(0).toISOString() } });
    await expect(expired.execute(s.preview, s.submit)).rejects.toThrow('scope expired');
    expect(s.sign).not.toHaveBeenCalled();expect(s.call).toHaveBeenCalledTimes(1);
  });
  it('refuses another runtime key and invalid signatures before submit', async () => {
    const s = await setup();
    const wrongKey = clientSigningSession({ ...s.config, key: { scheme: 'eip191', address: s.f.wallets.bob.address } });
    await expect(wrongKey.execute(s.preview, s.submit)).rejects.toThrow('not registered');
    const wrongSigner = clientSigningSession({ ...s.config, sign: msg => s.f.wallets.bob.signMessage(msg) });
    await expect(wrongSigner.execute(s.preview, s.submit)).rejects.toThrow('signature is invalid');
    expect(s.f.publish).not.toHaveBeenCalled();
  });
  it('keeps server revocation effective and never retries a refused submit', async () => {
    const s = await setup();
    const session = clientSigningSession({ ...s.config, scope: { ...s.scope, review: async () => { s.f.revoked.add('alice'); return true; } } });
    await expect(session.execute(s.preview, s.submit)).rejects.toThrow('grant revoked');
    expect(s.call).toHaveBeenCalledTimes(2);expect(s.f.publish).not.toHaveBeenCalled();
  });
});
