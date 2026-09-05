import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson, prepareApplicationAction, sha256Hex, type Json,
} from '../deploy/mcp-relay/application-lab-runtime.js';
import { fixtureStore } from '../examples/application-simulation/fixture-store.js';
import { releaseControl, ticTacToe, type RulePack } from '../examples/application-simulation/rule-packs.js';
import { simulateApplication, type SimulationFrontier } from '../examples/application-simulation/simulator.js';

const actor = 'did:example:alice';
const now = '2026-09-05T12:00:00.000Z';
const accepted = (frontier: SimulationFrontier) => frontier.alternatives.filter(a => a.status === 'simulated');
const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
};
afterEach(() => vi.restoreAllMocks());

describe('one offline interpreter for independent domain rule packs', () => {
  it.each([['Tic-Tac-Toe', ticTacToe, 21, 9], ['Release Control', releaseControl, 3, 1]] as const)(
    '%s keeps the whole candidate frontier and never reads or writes', async (_name, build, total, successful) => {
      const store = fixtureStore(build());
      const resolved = await store.resolve();
      const input = { actor, now, expectedHead: resolved.stateHead.cid };
      const before = JSON.stringify({ resolved, input });
      const counts = store.counts();
      freeze(resolved);
      freeze(input);
      const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected network'); });
      vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('unexpected clock'); });
      const frontier = simulateApplication(resolved, input);
      expect(frontier.alternatives).toHaveLength(total);
      expect(accepted(frontier)).toHaveLength(successful);
      expect(frontier).toEqual(simulateApplication(resolved, input));
      expect(store.counts()).toEqual(counts);
      expect(network).not.toHaveBeenCalled();
      expect(JSON.stringify({ resolved, input })).toBe(before);
      expect(frontier.basis.contractDigest).toBe(resolved.activeContractEnvelope.declaredDigest);
      for (const alternative of accepted(frontier)) {
        const prepared = prepareApplicationAction(resolved, { ...input, actionIri: alternative.actionIri, payload: alternative.payload });
        expect(alternative.successor).toEqual(prepared.successor);
        expect(alternative.receiptDigest).toBe(prepared.receiptDigest);
        expect(alternative.stateDigest).toBe(sha256Hex(canonicalJson(prepared.successor)));
        expect(alternative.changeCount).toBeGreaterThan(0);
      }
      // A UI editing a preview cannot mutate the resolved state or another preview.
      accepted(frontier)[0]!.successor.data.status = 'edited preview';
      expect(JSON.stringify({ resolved, input })).toBe(before);
      expect(accepted(simulateApplication(resolved, input))[0]!.successor.data.status).not.toBe('edited preview');
    },
  );

  async function step(store: ReturnType<typeof fixtureStore>, local: string, payload: Record<string, Json> = {}, who = actor) {
    const resolved = await store.resolve(who);
    expect(resolved.replay.complete).toBe(true);
    const input = { actor: who, now, expectedHead: resolved.stateHead.cid };
    const actionIri = `${resolved.state.applicationId}:${local}`;
    const frontier = simulateApplication(resolved, { ...input, samples: [{ actionIri, payload }] });
    const selected = accepted(frontier).find(a => a.actionIri === actionIri && canonicalJson(a.payload) === canonicalJson(payload));
    expect(selected, `${local} should be available`).toBeDefined();
    expect(store.record(resolved, { ...input, actionIri, payload })).toEqual(selected!.successor);
    const replayed = await store.resolve(who);
    expect(replayed.replay.complete).toBe(true);
    expect(replayed.replay.verifiedLinks).toBe(replayed.replay.chainLength);
    expect(replayed.state).toEqual(selected!.successor);
    return replayed;
  }

  it('replays Tic-Tac-Toe moves, refuses occupied cells, and stops at a win', async () => {
    const store = fixtureStore(ticTacToe());
    for (const [local, cell] of [['place-X', 0], ['place-O', 3], ['place-X', 1], ['place-O', 4], ['place-X', 2]] as const) {
      await step(store, local, { cell });
    }
    const won = await store.resolve();
    const frontier = simulateApplication(won, { actor, now, expectedHead: won.stateHead.cid });
    expect(accepted(frontier).map(a => [a.actionIri.split(':').at(-1), a.payload])).toEqual([['declare-winner', { player: 'X' }]]);
    expect(frontier.alternatives.filter(a => a.actionIri.endsWith(':place-O')).every(a => a.status === 'refused')).toBe(true);
    const finished = await step(store, 'declare-winner', { player: 'X' });
    expect(finished.state.data.winner).toBe('X');
    expect(accepted(simulateApplication(finished, { actor, now, expectedHead: finished.stateHead.cid }))).toHaveLength(0);
  });

  it('requires distinct approval actors, then replays the release state transition', async () => {
    const store = fixtureStore(releaseControl());
    const once = await step(store, 'approve');
    const oneApproval = simulateApplication(once, { actor, now, expectedHead: once.stateHead.cid });
    expect(accepted(oneApproval)).toHaveLength(0);
    await step(store, 'approve', {}, 'did:example:bob');
    const deployed = await step(store, 'deploy');
    expect(deployed.state.data).toMatchObject({ status: 'deployed', deployed: true, deployedBy: actor, deployedAt: now });
    expect(store.counts().writes).toBe(3); // Explicit fixture records only; no infrastructure deployment.
  });

  it('keeps open input spaces incomplete even with a successful supplied sample', async () => {
    const store = fixtureStore(releaseControl());
    const resolved = await store.resolve();
    const actionIri = `${resolved.state.applicationId}:cancel`;
    const frontier = simulateApplication(resolved, { actor, now, expectedHead: resolved.stateHead.cid,
      samples: [{ actionIri, payload: { reason: 'Postpone release' } }, { actionIri, payload: {} }] });
    expect(frontier.coverage.find(c => c.actionIri === actionIri)).toMatchObject({ inputSpace: 'open', suppliedSamples: 2 });
    const choices = frontier.alternatives.filter(a => a.actionIri === actionIri);
    expect(choices.map(a => a.status).sort()).toEqual(['needs-input', 'refused', 'simulated']);
    expect(choices.find(a => a.status === 'refused')).toMatchObject({ reason: expect.stringContaining('reason is required') });
    expect(accepted(frontier).find(a => a.actionIri === actionIri)!.successor.data.reason).toBe('Postpone release');
    expect(store.counts().writes).toBe(0);
  });

  it('binds an owned receipt payload before the caller can edit its input', async () => {
    const resolved = await fixtureStore(releaseControl()).resolve();
    const payload = { reason: 'Postpone release' };
    const prepared = prepareApplicationAction(resolved, { actor, now, expectedHead: resolved.stateHead.cid,
      actionIri: `${resolved.state.applicationId}:cancel`, payload });
    payload.reason = 'Changed after preparation';
    expect(prepared.receipt.payload).toEqual({ reason: 'Postpone release' });
    expect(sha256Hex(canonicalJson(prepared.receipt))).toBe(prepared.receiptDigest);
  });

  it('orders candidates independently of contract action and option ordering', async () => {
    const pack = ticTacToe();
    const original = await fixtureStore(pack).resolve();
    const reordered: RulePack = { ...pack, contract: { ...pack.contract, actions: [...pack.contract.actions].reverse().map(a => ({
      ...a, ...(a.inputs ? { inputs: [...a.inputs].reverse().map(i => ({ ...i, ...(i.options ? { options: [...i.options].reverse() } : {}) })) } : {}),
    })) } };
    const other = await fixtureStore(reordered).resolve();
    const frontiers = [original, other].map(r => simulateApplication(r, { actor, now, expectedHead: r.stateHead.cid }));
    // Contract digest/receipts must change when signed bytes change; candidate semantics do not.
    expect(frontiers.map(f => f.alternatives.map(a => [a.id, a.actionIri, a.payload, a.status,
      a.status === 'simulated' ? a.successor.data : null]))[0]).toEqual(frontiers.map(f => f.alternatives.map(a => [
      a.id, a.actionIri, a.payload, a.status, a.status === 'simulated' ? a.successor.data : null,
    ]))[1]);
    expect(frontiers[0]!.basis.contractDigest).not.toBe(frontiers[1]!.basis.contractDigest);
  });

  it('fails the whole request on candidate overflow instead of returning a partial frontier', async () => {
    const resolved = await fixtureStore(ticTacToe()).resolve();
    expect(() => simulateApplication(resolved, { actor, now, expectedHead: resolved.stateHead.cid, maxCandidates: 20 }))
      .toThrow(/budget exceeded/);
  });

  it('includes implicit Boolean choices, optional omission/null, and empty option spaces', async () => {
    const pack = releaseControl();
    const base = pack.contract.actions[0]!;
    const actions = [
      { ...base, actionIri: 'urn:test:boolean', inputs: [{ name: 'flag', type: 'boolean', required: true }] },
      { ...base, actionIri: 'urn:test:optional', inputs: [{ name: 'flag', type: 'boolean' }] },
      { ...base, actionIri: 'urn:test:empty', inputs: [{ name: 'flag', required: true, options: [] }] },
    ];
    const resolved = await fixtureStore({ ...pack, contract: { ...pack.contract, actions } }).resolve();
    const frontier = simulateApplication(resolved, { actor, now, expectedHead: resolved.stateHead.cid });
    expect(frontier.coverage.every(c => c.inputSpace === 'finite')).toBe(true);
    expect(accepted(frontier).filter(a => a.actionIri === 'urn:test:boolean').map(a => a.payload))
      .toEqual([{ flag: false }, { flag: true }]);
    expect(accepted(frontier).filter(a => a.actionIri === 'urn:test:optional').map(a => a.payload))
      .toEqual([{ flag: false }, { flag: null }, { flag: true }, {}]);
    expect(frontier.coverage.find(c => c.actionIri === 'urn:test:empty')).toBeDefined();
    expect(frontier.alternatives.filter(a => a.actionIri === 'urn:test:empty')).toHaveLength(0);
  });

  it('retains unsupported guard/effect/target and read-only refusals', async () => {
    const pack = releaseControl();
    const base = pack.contract.actions[0]!;
    const actions = [
      { ...base, actionIri: 'urn:test:guard', guard: { op: 'invented' } },
      { ...base, actionIri: 'urn:test:effect', effects: [{ op: 'invented', path: '$state.status' }] },
      { ...base, actionIri: 'urn:test:target', target: 'https://example.com/deploy' },
      { ...base, actionIri: 'urn:test:read', method: 'GET' },
    ];
    const resolved = await fixtureStore({ ...pack, contract: { ...pack.contract, actions } }).resolve();
    const frontier = simulateApplication(resolved, { actor, now, expectedHead: resolved.stateHead.cid });
    expect(frontier.alternatives).toHaveLength(4);
    expect(frontier.alternatives.every(a => a.status === 'refused')).toBe(true);
    expect(frontier.alternatives.map(a => a.status === 'refused' ? a.reason : '')).toEqual([
      expect.stringContaining('unsupported effect'), expect.stringContaining('guard refused'),
      expect.stringContaining('read-only'), expect.stringContaining('not executable'),
    ]);
  });

  it('rejects stale heads, forks, and histories with a missing transition', async () => {
    const store = fixtureStore(releaseControl());
    const resolved = await store.resolve();
    expect(() => simulateApplication(resolved, { actor, now, expectedHead: 'stale' })).toThrow(/stale/);
    expect(() => simulateApplication({ ...resolved, catalogCurrent: false }, { actor, now, expectedHead: resolved.stateHead.cid }))
      .toThrow(/authoritative catalog/);
    await step(store, 'approve');
    await step(store, 'approve', {}, 'did:example:bob');
    store.history.splice(1, 1);
    const incomplete = await store.resolve();
    expect(incomplete.replay.complete).toBe(false);
    expect(() => simulateApplication(incomplete, { actor, now, expectedHead: incomplete.stateHead.cid })).toThrow(/complete verified replay/);
    store.heads.set(store.graphs.state, { forked: true, heads: [] });
    await expect(store.resolve()).rejects.toThrow(/state is forked/);
  });

  it.each(['digest', 'authorship', 'cid'])('refuses a tampered %s at the resolver boundary', async field => {
    const store = fixtureStore(releaseControl());
    const resolved = await store.resolve();
    const descriptor = resolved.activeContractDescriptor;
    store.descriptors.set(descriptor.url, field === 'digest'
      ? { ...descriptor, content: descriptor.content!.replace(/ia:sha256 "[a-f0-9]+"/, `ia:sha256 "${'0'.repeat(64)}"`) }
      : field === 'authorship' ? { ...descriptor, authorship: { authorshipVerified: false } }
        : { ...descriptor, cid: 'tampered-cid' });
    await expect(store.resolve()).rejects.toThrow(/verified|digest|CID/);
    expect(store.counts().writes).toBe(0);
  });
});
