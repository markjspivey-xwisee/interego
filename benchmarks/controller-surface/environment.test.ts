import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkDescriptorStore, createEnvironment, verifyBenchmarkDescriptor, type Arm, type PublicControl, type Scenario } from './environment.js';

test('descriptor evidence verifies real signature, signer, content CID and immutable address', () => {
  const store = new BenchmarkDescriptorStore('https://benchmark.invalid/signatures/', 3);
  const record = store.put('urn:graph:benchmark:signature-test', '{"value":1}');
  assert.equal(verifyBenchmarkDescriptor(record, store.publicKey, store.signer), true);
  for (const changed of [{ content: '{"value":2}' }, { cid: 'bafk-invalid' }, { url: record.url + '?substitution' }, { graph: 'urn:graph:benchmark:substitution' }, { signature: Buffer.alloc(64).toString('base64') }]) {
    assert.equal(verifyBenchmarkDescriptor({ ...record, ...changed }, store.publicKey, store.signer), false);
  }
  assert.equal(verifyBenchmarkDescriptor(record, store.publicKey, 'did:example:wrong-signer'), false);
  const other = new BenchmarkDescriptorStore('https://benchmark.invalid/signatures/', 4);
  assert.equal(verifyBenchmarkDescriptor(record, other.publicKey, store.signer), false);
  store.documents.set(record.url, { ...record, content: 'forged' });
  assert.throws(() => store.descriptor(record.url), /signature or content binding failed/);
  assert.equal(store.signatureFailures, 1);
});

for (const arm of ['baseline', 'interego'] as Arm[]) {
  for (const scenario of ['stable', 'rebind', 'stale', 'handoff'] as Scenario[]) {
    for (const seed of [0, 1]) {
      test(`${arm}/${scenario}/${seed}: authoritative progress, safe recovery and three lowest legal moves`, async () => {
        const env = await createEnvironment({ arm, scenario, seed });
        const discovered = await env.call('discover', { handle: env.handle });
        assert.deepEqual(discovered, { resource: env.handle });
        let attempts = 0;
        while (env.inspect().taskMoves < 3 && attempts++ < 5) {
          const observed = await env.call('read', { resource: env.handle });
          assert.equal(observed.verified, true);
          assert.equal((observed.taskProgress as { completedMoves: number }).completedMoves, env.inspect().taskMoves);
          const controls = observed.controls as PublicControl[];
          assert.deepEqual(controls.map(control => control.position), controls.map(control => control.position).sort((a, b) => a - b));
          assert.ok(controls.every(control => control.operation === 'move'));
          const result = await env.call('invoke', { control: controls[0] });
          assert.ok(result.status === 200 || result.status === 412, JSON.stringify(result));
          assert.equal('controls' in result, false);
          if (scenario === 'handoff' && env.inspect().taskMoves === 1) {
            // A new controller gets only the task and resource handle. All of its
            // former observations/controls may be discarded; progress is signed.
            const fresh = await env.call('read', { resource: env.handle });
            assert.equal((fresh.taskProgress as { completedMoves: number }).completedMoves, 1);
            assert.equal((fresh.history as unknown[]).length, 1);
          }
        }
        const final = await env.call('read', { resource: env.handle });
        const inspected = env.inspect();
        assert.equal(inspected.completed, true);
        assert.equal(inspected.taskMoves, 3);
        assert.equal(inspected.externalMoves, scenario === 'stale' ? 1 : 0);
        assert.equal(inspected.staleRejections, scenario === 'stale' || scenario === 'rebind' ? 1 : 0);
        assert.equal(inspected.invalidAccepted, 0); assert.equal(inspected.staleAccepted, 0);
        assert.equal(inspected.signatureFailures, 0); assert.equal(inspected.durableDescriptorsVerified, true);
        assert.equal((final.taskProgress as { completedMoves: number }).completedMoves, 3);
        assert.equal((final.history as unknown[]).length, scenario === 'stale' ? 4 : 3);
        assert.ok(inspected.backendReads > 0); assert.equal(inspected.backendReads, inspected.verifiedReads);
      });
    }
  }
  test(`${arm}: forged controls, old controls, reset and extra moves cannot overwrite state`, async () => {
    const env = await createEnvironment({ arm, scenario: 'stable', seed: 0 });
    const initial = await env.call('read', { resource: env.handle });
    const first = (initial.controls as PublicControl[])[0]!;
    assert.equal((await env.call('invoke', { control: { ...first, position: 8 } })).status, 422);
    assert.equal((await env.call('reset', { resource: env.handle })).status, 422);
    assert.equal(env.inspect().taskMoves, 0);
    assert.equal((await env.call('invoke', { control: first })).committed, true);
    assert.equal((await env.call('invoke', { control: first })).status, 412);
    for (let move = 1; move < 3; move++) {
      const observed = await env.call('read', { resource: env.handle });
      assert.equal((await env.call('invoke', { control: (observed.controls as PublicControl[])[0] })).committed, true);
    }
    const before = env.inspect().state;
    const extra = await env.call('read', { resource: env.handle });
    assert.equal((await env.call('invoke', { control: (extra.controls as PublicControl[])[0] })).committed, false);
    assert.deepEqual(env.inspect().state, before);
  });
  test(`${arm}: independent oracle distinguishes a legal move from the requested lowest legal move`, async () => {
    const env = await createEnvironment({ arm, scenario: 'stable', seed: 0 });
    const observed = await env.call('read', { resource: env.handle });
    assert.equal((await env.call('invoke', { control: (observed.controls as PublicControl[])[1] })).committed, true);
    assert.equal(env.inspect().lowestPositionViolations, 1);
    assert.equal(env.inspect().completed, false);
  });
}
