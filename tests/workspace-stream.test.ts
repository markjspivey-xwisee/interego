/**
 * The per-participant stream: appending safely, and reading back an order you can check.
 *
 * A log on someone's own pod has failure modes a server-side table does not: two of the
 * owner's own agents deriving the same sequence number, a chain that forked and healed
 * into something unorderable, an entry whose declared prior is not there. Each of those
 * looks exactly like a healthy log unless something re-derives the order from the links —
 * so each is pinned here.
 *
 * ★ The direction of every failure matters, and it is the opposite of the roster's. A
 * roster errs towards refusing authority. A log errs towards REFUSING TO WRITE: appending
 * onto a chain that does not verify buries the divergence under a new entry, and the
 * entry that hides a fork is worse than the fork.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  entryTurtle,
  verifyChain,
  headOf,
  readStream,
  appendEntry,
  appendWithRetry,
  WSP_SHAPES,
  type StreamRow,
  type StreamDeps,
} from '../applications/shared-workspace/src/stream.js';

const WS = 'https://relay.test/ws/alpha';
const STREAM = 'https://alice.test/ws/alpha/stream';
const POD = 'https://alice.test/';
const ref = { graphIri: STREAM, workspace: WS, podUrl: POD };

const d = (n: number) => `https://alice.test/context-graphs/${n}.ttl`;
const row = (n: number, supersedes: string[] = []): StreamRow => ({
  descriptorUrl: d(n), cid: `bafk${n}`, validFrom: `2026-08-0${n + 1}T00:00:00Z`, supersedes,
});

/** v0 ← v1 ← v2, each declaring exactly ONE prior. */
const LINEAR = [row(0), row(1, [d(0)]), row(2, [d(1)])];

describe('entryTurtle — the three positions a value reaches Turtle', () => {
  it('renders a well-formed entry with its sequence and workspace', () => {
    const ttl = entryTurtle({ entryIri: `${STREAM}/e/0`, workspace: WS, seq: 0, draft: { body: 'hello' } });
    expect(ttl).toContain(`<${STREAM}/e/0>`);
    expect(ttl).toContain('a wsp:Entry ;');
    expect(ttl).toContain('wsp:seq "0"^^xsd:nonNegativeInteger ;');
    expect(ttl).toContain(`wsp:workspace <${WS}> ;`);
    expect(ttl.trimEnd().endsWith('.')).toBe(true);
  });

  it('★ refuses an IRI that would close the reference and write someone else\'s triple', () => {
    // An IRI reference ends at the first `>`. Turtle has no escape for it, so the only
    // correct handling is refusal — anything that "escapes" an IRI is guessing.
    const attack = `${WS}> ; <${WSP_SHAPES}#owner> <did:web:attacker`;
    expect(() => entryTurtle({ entryIri: `${STREAM}/e/0`, workspace: attack, seq: 0, draft: {} }))
      .toThrow(/not serializable/);
    expect(() => entryTurtle({ entryIri: attack, workspace: WS, seq: 0, draft: {} }))
      .toThrow(/not serializable/);
    expect(() => entryTurtle({
      entryIri: `${STREAM}/e/0`, workspace: WS, seq: 0, draft: { references: [attack] },
    })).toThrow(/not a serializable IRI/);
  });

  it('★ a bad reference throws rather than being dropped', () => {
    // Dropping it would leave an entry that cites nothing while claiming to cite
    // something, and no one would find out. Loud beats tidy.
    expect(() => entryTurtle({
      entryIri: `${STREAM}/e/0`, workspace: WS, seq: 0, draft: { references: ['not an iri'] },
    })).toThrow();
  });

  it('escapes a body that would otherwise break out of the literal', () => {
    const ttl = entryTurtle({
      entryIri: `${STREAM}/e/0`, workspace: WS, seq: 0,
      draft: { body: 'say "hi"\nthen <urn:x> a <urn:Evil> .' },
    });
    expect(ttl).toContain('\\"hi\\"');
    expect(ttl).toContain('\\n');
    // The injected triple must survive only as text inside the literal.
    expect(ttl.split('\n').some(l => l.trim().startsWith('<urn:x>'))).toBe(false);
  });

  it('rejects a sequence that is not a non-negative integer', () => {
    for (const seq of [-1, 1.5, NaN]) {
      expect(() => entryTurtle({ entryIri: `${STREAM}/e/0`, workspace: WS, seq, draft: {} }))
        .toThrow(/non-negative integer/);
    }
  });

  it('a referencing entry declares BOTH types, so each shape finds its target', () => {
    // wsp:Reference is a subclass of wsp:Entry. Declaring only the subclass would leave
    // the entry shape untargeted unless the validator had already computed the closure —
    // a dependency on inference that a publish gate should not have.
    const ttl = entryTurtle({
      entryIri: `${STREAM}/e/1`, workspace: WS, seq: 1,
      draft: { references: ['https://foxxi.test/credential/7'] },
    });
    expect(ttl).toContain('a wsp:Entry, wsp:Reference ;');
    expect(ttl).toContain('wsp:references <https://foxxi.test/credential/7>');
  });

  it('a reference entry is still terminated correctly when it is the last predicate', () => {
    // The terminator is rewritten onto whichever predicate ends up last, so the shape of
    // the draft decides which line it lands on. Unparseable Turtle would be caught by the
    // publish gate — but only after a round-trip, and only if the gate is reachable.
    const ttl = entryTurtle({
      entryIri: `${STREAM}/e/1`, workspace: WS, seq: 1,
      draft: { references: ['https://foxxi.test/credential/7'] },
    });
    expect(ttl.trimEnd().endsWith('.')).toBe(true);
    expect(ttl).not.toContain('; .');
  });

  it('★ declares exactly ONE prior, so the chain stays linear', () => {
    // auto_supersede_prior links every ancestor: a stream of n entries would carry O(n²)
    // supersedes triples. For a structure that only grows, that is the wrong asymptotics.
    const ttl = entryTurtle({
      entryIri: `${STREAM}/e/2`, workspace: WS, seq: 2, draft: {}, supersedes: d(1),
    });
    expect(ttl.match(/iep:supersedes/g)).toHaveLength(1);
  });
});

describe('verifyChain — the order is derived, never taken on trust', () => {
  it('a linear chain verifies and orders oldest-first', () => {
    const r = verifyChain(LINEAR);
    expect(r.intact).toBe(true);
    expect(r.ordered.map(x => x.descriptorUrl)).toEqual([d(0), d(1), d(2)]);
    expect(r.heads).toEqual([d(2)]);
  });

  it('★ two entries superseding the same prior is a FORK, and is reported', () => {
    // Exactly what a broken precondition produces: both writers derived seq 2 from v1 and
    // both landed. The reader must see two heads rather than a plausible ordering.
    const forked = [...LINEAR, row(3, [d(1)])];
    const r = verifyChain(forked);
    expect(r.intact).toBe(false);
    expect(r.merges).toEqual([d(1)]);
    expect(r.ordered).toEqual([]);
  });

  it('★ it does not fall back to timestamp order when the links disagree', () => {
    // Sorting by validFrom would produce a confident, wrong answer — and a log whose
    // order can be changed by a clock is not an audit trail.
    const r = verifyChain([row(0), row(1, [d(0)]), row(2, [d(0)])]);
    expect(r.ordered).toEqual([]);
    expect(r.heads.sort()).toEqual([d(1), d(2)]);
  });

  it('a declared prior that is absent is reported as a dangling link', () => {
    const r = verifyChain([row(1, [d(0)]), row(2, [d(1)])]);
    expect(r.danglingLinks).toEqual([{ from: d(1), missing: d(0) }]);
    expect(r.intact).toBe(false);
  });

  it('a cycle terminates instead of hanging', () => {
    // Cannot arise from the append path, but a hand-written descriptor could, and a
    // verifier that loops forever on hostile input is a denial of service.
    const r = verifyChain([row(0, [d(1)]), row(1, [d(0)])]);
    expect(r.intact).toBe(false);
    expect(r.heads).toEqual([]);
  });

  it('an empty stream is not intact, and headOf starts at seq 0', () => {
    expect(verifyChain([]).intact).toBe(false);
    expect(headOf([])).toEqual({ url: null, seq: 0 });
  });

  it('headOf points at the verified tip and the next free sequence', () => {
    expect(headOf(LINEAR)).toEqual({ url: d(2), seq: 3 });
  });
});

// ── Append, against a recording double of the two tools ─────────────────────

/**
 * A double for the two tools, plus the substrate's real timing.
 *
 * ★ `publish_context` returns `status: "pending"` and the entry becomes readable a few
 * seconds later — 3–4s measured live. Modelling that here is not pedantry: the first
 * version of this module assumed acceptance meant visibility, and the first live run
 * produced two heads because appends 1 and 2 both read an empty stream. A double that
 * makes writes visible instantly cannot catch that, so this one does not.
 */
function makeDeps(opts: {
  rows?: readonly StreamRow[];
  publishResult?: Record<string, unknown>;
  publishResults?: Record<string, unknown>[];
  /** discover calls a landed entry stays invisible for. 0 = immediate. */
  invisibleFor?: number;
  /** Never make it visible — the deferred write that we cannot confirm. */
  neverVisible?: boolean;
} = {}) {
  const calls: Record<string, unknown>[] = [];
  const landed: StreamRow[] = [];
  let n = 0;
  let clock = 0;
  let sinceWrite = 0;

  const deps: StreamDeps = {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    discover: vi.fn(async () => {
      const visible = opts.neverVisible ? [] : landed.filter((_, i) => i < landed.length - (sinceWrite > 0 ? 1 : 0));
      if (sinceWrite > 0) sinceWrite--;
      return {
        entries: [...(opts.rows ?? []), ...visible].map(r => ({
          descriptorUrl: r.descriptorUrl, cid: r.cid, validFrom: r.validFrom,
          supersedes: r.supersedes, describes: [STREAM],
        })),
      };
    }),
    publish: vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      // Distinct URL per call: the substrate never reuses one, and a double that does
      // would let a bug that overwrites the head look like a bug-free append.
      const res = opts.publishResults
        ? opts.publishResults[Math.min(n++, opts.publishResults.length - 1)]!
        : opts.publishResult ?? { descriptorUrl: d(90 + n++), status: 'pending' };
      if (res.error === undefined && typeof res.descriptorUrl === 'string') {
        const prior = typeof args.if_match === 'string' ? [args.if_match] : [];
        landed.push({ descriptorUrl: res.descriptorUrl, cid: null, validFrom: null, supersedes: prior });
        sinceWrite = opts.neverVisible ? 0 : (opts.invisibleFor ?? 0);
      }
      return res;
    }),
  };
  return { deps, calls };
}

describe('appendEntry', () => {
  it('derives the sequence from the verified head and gates on it', async () => {
    const { deps, calls } = makeDeps({ rows: LINEAR });
    const res = await appendEntry(ref, { body: 'fourth' }, deps);

    expect(res.outcome).toBe('appended');
    expect(res.outcome === 'appended' && res.entry.seq).toBe(3);
    expect(calls[0]!.if_match).toBe(d(2));
    expect(calls[0]!.graph_iri).toBe(STREAM);
    // ★ Both of these are load-bearing, and both are easy to lose in a refactor.
    expect(calls[0]!.auto_supersede_prior).toBe(false);
    expect(calls[0]!.conforms_to_shapes).toEqual([WSP_SHAPES]);
    expect(String(calls[0]!.graph_content)).toContain(`iep:supersedes <${d(2)}>`);
  });

  it('the first entry has no precondition, because there is nothing to gate on', async () => {
    const { deps, calls } = makeDeps({ rows: [] });
    const res = await appendEntry(ref, { body: 'first' }, deps);
    expect(res.outcome === 'appended' && res.entry.seq).toBe(0);
    expect(calls[0]!.if_match).toBeUndefined();
    expect(String(calls[0]!.graph_content)).not.toContain('iep:supersedes');
  });

  it('★ a 412 surfaces as a conflict naming the current head, not as a throw', async () => {
    // The caller is racing a peer, which is normal. It needs the head to re-derive from,
    // and it needs to decide for itself whether re-appending still makes sense.
    const { deps } = makeDeps({
      rows: LINEAR,
      publishResult: {
        error: 'precondition_failed', code: 412, message: 'stale',
        currentHead: { descriptorUrl: d(7) },
      },
    });
    const res = await appendEntry(ref, { body: 'lost the race' }, deps);
    expect(res).toMatchObject({ outcome: 'conflict', currentHead: d(7) });
  });

  it('a shape violation surfaces as a refusal carrying the code', async () => {
    const { deps } = makeDeps({
      rows: [],
      publishResult: { error: 'shape_violation', code: 422, message: 'wsp:seq missing' },
    });
    expect(await appendEntry(ref, {}, deps)).toMatchObject({ outcome: 'refused', code: 422 });
  });

  it('★ REFUSES to append onto a chain that does not verify', async () => {
    // The tempting behaviour is to append to one of the heads and move on. That buries a
    // divergence under a new entry: the fork is still there, now with something written on
    // top of it, and the next reader inherits a mess nobody was told about.
    const { deps, calls } = makeDeps({ rows: [...LINEAR, row(3, [d(1)])] });
    const res = await appendEntry(ref, { body: 'papering over it' }, deps);
    expect(res.outcome).toBe('conflict');
    expect(res.outcome === 'conflict' && res.message).toMatch(/does not verify/);
    expect(calls).toHaveLength(0); // nothing was written
  });

  it('reads exactly ONE manifest to derive the head, however long the stream is', async () => {
    // The federated design already costs one read per member. If it also cost one per
    // entry, catch-up would be quadratic in the size of the workspace. (The confirmation
    // read afterwards is a second call, and is the subject of the next block.)
    const long = Array.from({ length: 40 }, (_, i) => (i === 0 ? row(0) : row(i, [d(i - 1)])));
    const { deps } = makeDeps({ rows: long });
    await appendEntry(ref, { body: 'x' }, deps);
    expect(deps.discover).toHaveBeenCalledTimes(2); // derive head, then confirm visibility
  });
});

describe('★ an append is not done until the entry is readable', () => {
  // The substrate publishes asynchronously: publish_context returns `status: "pending"`
  // and the entry appears seconds later. Treating acceptance as visibility forked the log
  // on the very first live run — appends 1 and 2 both read an empty stream, both derived
  // seq 0, and both landed. These pin the behaviour that fixed it.

  it('waits for its own entry to appear, and reports how long that took', async () => {
    const { deps } = makeDeps({ rows: LINEAR, invisibleFor: 4 });
    const res = await appendEntry(ref, { body: 'x' }, deps);
    expect(res.outcome).toBe('appended');
    expect(res.outcome === 'appended' && res.visibleAfterMs).toBeGreaterThan(0);
    expect(deps.sleep).toHaveBeenCalled();
  });

  it('★ the NEXT append therefore derives the following sequence, not the same one', async () => {
    // The regression itself. With no wait, both of these come back as seq 3.
    const { deps } = makeDeps({ rows: LINEAR, invisibleFor: 3 });
    const first = await appendEntry(ref, { body: 'a' }, deps);
    const second = await appendEntry(ref, { body: 'b' }, deps);
    expect(first.outcome === 'appended' && first.entry.seq).toBe(3);
    expect(second.outcome === 'appended' && second.entry.seq).toBe(4);
  });

  it('★ an unconfirmed write is reported as PENDING, never as success or failure', async () => {
    // "Probably landed" is the truth, and both alternatives are worse: calling it success
    // lets the caller derive the next seq from a view that does not contain it, and
    // calling it failure invites a retry that duplicates an entry in an append-only log.
    const { deps } = makeDeps({ rows: LINEAR, neverVisible: true });
    const res = await appendEntry(ref, { body: 'x' }, deps);
    expect(res.outcome).toBe('pending');
    expect(res.outcome === 'pending' && res.message).toMatch(/re-reading/);
  });

  it('★ appendWithRetry does NOT retry a pending write', async () => {
    // There is no delete in an append-only log, so a duplicate is unfixable by the writer.
    // A lost retry is recoverable; a phantom entry is not.
    const { deps, calls } = makeDeps({ rows: LINEAR, neverVisible: true });
    expect((await appendWithRetry(ref, { body: 'x' }, deps, 3)).outcome).toBe('pending');
    expect(calls).toHaveLength(1);
  });
});

describe('appendWithRetry', () => {
  it('retries a conflict and reports success once it lands', async () => {
    const { deps } = makeDeps({
      rows: LINEAR,
      publishResults: [
        { error: 'precondition_failed', code: 412, message: 'stale', currentHead: { descriptorUrl: d(2) } },
        { descriptorUrl: d(4), previousHeadCid: 'bafk4' },
      ],
    });
    expect((await appendWithRetry(ref, { body: 'x' }, deps)).outcome).toBe('appended');
  });

  it('gives up after the attempt budget rather than looping', async () => {
    const { deps, calls } = makeDeps({
      rows: LINEAR,
      publishResult: { error: 'precondition_failed', code: 412, message: 'stale' },
    });
    expect((await appendWithRetry(ref, { body: 'x' }, deps, 3)).outcome).toBe('conflict');
    expect(calls).toHaveLength(3);
  });

  it('does not retry a refusal — a bad entry stays bad', async () => {
    const { deps, calls } = makeDeps({
      rows: [], publishResult: { error: 'shape_violation', code: 422, message: 'no' },
    });
    expect((await appendWithRetry(ref, {}, deps)).outcome).toBe('refused');
    expect(calls).toHaveLength(1);
  });
});

describe('readStream', () => {
  it('keeps only rows that actually describe this stream', async () => {
    // A pod holds many graphs. A server-side filter that over-returns must not become
    // entries in someone's log.
    const deps: StreamDeps = {
      publish: vi.fn(),
      discover: vi.fn(async () => ({
        entries: [
          { descriptorUrl: d(0), cid: 'a', validFrom: null, supersedes: [], describes: [STREAM] },
          { descriptorUrl: d(1), cid: 'b', validFrom: null, supersedes: [], describes: ['https://elsewhere.test/g'] },
        ],
      })),
    };
    const rows = await readStream(ref, deps);
    expect(rows.map(r => r.descriptorUrl)).toEqual([d(0)]);
  });
});
