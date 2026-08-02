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
  readAttestation,
  proofDescriptorId,
  proofBindsToDescriptor,
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

  it('★ headOf REFUSES a forked chain instead of answering "brand new stream"', () => {
    // The whole trap in one assertion. `{url: null, seq: 0}` is not "I could not tell" — it
    // is "start at 0, no precondition needed", and acting on it lands a THIRD head at a seq
    // two entries already claim, gated on nothing. appendEntry guards separately, so this
    // only ever bites a caller of the exported helper — which is who it must protect.
    const forked = [...LINEAR, row(3, [d(1)])];
    expect(verifyChain(forked).ordered).toEqual([]);   // the input that produced the wrong answer
    expect(() => headOf(forked)).toThrow(/does not verify/);
  });

  it('★ headOf refuses a chain missing its beginning, which DOES order cleanly', () => {
    // Ordering is not the test — this walks perfectly and covers every row it was given.
    // It is still missing the start of the log, so there is no verified tip to gate on.
    const truncatedHead = [row(1, [d(0)]), row(2, [d(1)])];
    expect(verifyChain(truncatedHead).ordered).toHaveLength(2);
    expect(() => headOf(truncatedHead)).toThrow(/dangling link/);
  });

  it('an empty stream is still the one case headOf answers with seq 0', () => {
    // The refusal must not swallow the legitimate case, or no stream could ever be started.
    expect(() => headOf([])).not.toThrow();
  });
});

describe('★ wsp:seq is written on every entry — so it has to be read back', () => {
  // The number was published on every entry and had nowhere to land: StreamRow carried no
  // seq, so nothing could compare what an entry SAYS its position is against where the
  // links put it. That leaves one removal invisible — a row dropped and linked around.

  it('a declared sequence that agrees with the walked position verifies', () => {
    const rows: StreamRow[] = [
      { ...row(0), seq: 0 }, { ...row(1, [d(0)]), seq: 1 }, { ...row(2, [d(1)]), seq: 2 },
    ];
    const r = verifyChain(rows);
    expect(r.seqMismatches).toEqual([]);
    expect(r.declaredSeqChecked).toBe(true);
    expect(r.intact).toBe(true);
  });

  it('★ a row removed and LINKED AROUND is caught by its successor\'s declared position', () => {
    // Structurally flawless: one head, one root, no dangling link, every row on the path.
    // Only the number says a position is missing — seq 2 sitting at index 1.
    const relinked: StreamRow[] = [{ ...row(0), seq: 0 }, { ...row(2, [d(0)]), seq: 2 }];
    const r = verifyChain(relinked);
    expect(r.heads).toEqual([d(2)]);
    expect(r.danglingLinks).toEqual([]);
    expect(r.ordered).toHaveLength(2);          // it ordered, and it is still not trustworthy
    expect(r.seqMismatches).toEqual([{ url: d(2), declared: 2, position: 1 }]);
    expect(r.intact).toBe(false);
  });

  it('★ and headOf will not derive a precondition from it either', () => {
    const relinked: StreamRow[] = [{ ...row(0), seq: 0 }, { ...row(2, [d(0)]), seq: 2 }];
    expect(() => headOf(relinked)).toThrow(/sequence mismatch/);
  });

  it('★ "nobody looked" is reported, never rendered as "the numbering agrees"', () => {
    // The honest half. A manifest row carries descriptorUrl / cid / describes / facetTypes /
    // validFrom / supersedes / issuer — and NOT seq, which lives in the entry's payload and
    // would cost one get_descriptor per entry to fetch, destroying the one-read catch-up.
    // So `seqMismatches: []` on a real stream means nothing was compared, and the two cases
    // are indistinguishable unless the report says which one it is.
    const r = verifyChain(LINEAR);
    expect(r.seqMismatches).toEqual([]);
    expect(r.declaredSeqChecked).toBe(false);
    expect(r.intact).toBe(true);   // NOT divergent — a missing manifest column is not a fork
  });

  it('a partially-numbered chain does not report itself as checked', () => {
    // One row carrying a number is not the log's numbering having been verified, and
    // reading "checked" off it would be exactly the false assurance this field exists for.
    const partial: StreamRow[] = [{ ...row(0), seq: 0 }, row(1, [d(0)])];
    const r = verifyChain(partial);
    expect(r.declaredSeqChecked).toBe(false);
    expect(r.seqMismatches).toEqual([]);
    expect(r.intact).toBe(true);
  });

  it('★ but TAIL truncation still verifies clean, and that is stated, not hidden', () => {
    // The limit of what the served rows can show. Dropping the oldest leaves a dangling
    // link and is caught; dropping the newest leaves a prefix, and a prefix of a valid
    // chain IS a valid chain. seq cannot rescue it — the row carrying the highest number is
    // precisely the row that was removed — so both of these verify, and a reader who needs
    // "this is the whole log" needs an anchor from outside these rows.
    const whole: StreamRow[] = [
      { ...row(0), seq: 0 }, { ...row(1, [d(0)]), seq: 1 }, { ...row(2, [d(1)]), seq: 2 },
    ];
    const prefix = whole.slice(0, 2);
    expect(verifyChain(whole).intact).toBe(true);
    expect(verifyChain(prefix).intact).toBe(true);
    expect(verifyChain(prefix).seqMismatches).toEqual([]);
    // And headOf answers confidently on the prefix, because from the rows it was given
    // there is nothing wrong with it.
    expect(headOf(prefix)).toEqual({ url: d(1), seq: 2 });
  });

  it('readStream reads the declared sequence when a row carries one', async () => {
    // Null against today's relay — the check switches itself on if the number ever arrives,
    // rather than waiting for someone to remember to wire it up.
    const deps: StreamDeps = {
      publish: vi.fn(),
      discover: vi.fn(async () => ({
        entries: [
          { descriptorUrl: d(0), cid: 'a', validFrom: null, supersedes: [], seq: 0, describes: [STREAM] },
          // The lexical form of "3"^^xsd:nonNegativeInteger, which is how anything
          // mirroring the literal without reading its datatype would hand it back.
          { descriptorUrl: d(1), cid: 'b', validFrom: null, supersedes: [d(0)], seq: '1', describes: [STREAM] },
          { descriptorUrl: d(2), cid: 'c', validFrom: null, supersedes: [d(1)], describes: [STREAM] },
        ],
      })),
    };
    const rows = await readStream(ref, deps);
    expect(rows.map(r => r.seq)).toEqual([0, 1, null]);
    expect(verifyChain(rows).declaredSeqChecked).toBe(false); // one row short of checked
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

  it('★ every entry is SIGNED — an unsigned one can never be attributed afterwards', async () => {
    // The read path used to attach `principal` from the caller's members list and nothing in
    // the record could contradict it. Without this flag there is no iep:authorshipProof to
    // verify, so `verifyAuthorship` withholds every entry and the property is unreachable —
    // and it is unreachable permanently, because the bytes are immutable and the key moved on.
    const { deps, calls } = makeDeps({ rows: [] });
    await appendEntry(ref, { body: 'first' }, deps);
    expect(calls[0]!.sign_authorship).toBe(true);
  });

  it('★★ asking to sign is not being signed: a relay that REFUSED to sign is reported', async () => {
    // `sign_authorship: true` is a REQUEST. The relay catches a signing failure, logs a
    // warning, leaves the publish to proceed, and reports it in the response body as
    // `authorship: {signed: false, reason}`. `appendEntry` read only `code`, `error` and
    // `descriptorUrl`, so a transient outage of the signing key produced a run of entries
    // reported as a clean `appended` with nothing anywhere mentioning signing.
    //
    // That is PERMANENT by this module's own rule — the bytes are immutable and the key has
    // moved on — so the operator finds out at read time, when `verifyAuthorship: true`
    // withholds a stretch of their own log, months later. The previous test pinned only that
    // the flag went out on the wire, so no double could express the failure at all.
    const { deps } = makeDeps({
      rows: [],
      publishResult: {
        descriptorUrl: d(90), status: 'pending',
        authorship: { signed: false, reason: 'issuer seed unset' },
      },
    });
    const res = await appendEntry(ref, { body: 'first' }, deps);
    expect(res.outcome).toBe('appended'); // it DID land — pretending otherwise is its own lie
    expect(res.outcome === 'appended' && res.signing).toBe('NOT-SIGNED');
    expect(res.outcome === 'appended' && res.signingNote).toMatch(/issuer seed unset/);
    expect(res.outcome === 'appended' && res.signingNote).toMatch(/unattributable FOREVER/);
  });

  it('a relay that DID sign says so, and the value is not the failure one', async () => {
    const { deps } = makeDeps({
      rows: [], publishResult: { descriptorUrl: d(90), status: 'pending', authorship: { signed: true } },
    });
    const res = await appendEntry(ref, { body: 'first' }, deps);
    expect(res.outcome === 'appended' && res.signing).toBe('signed');
  });

  it('★ a relay that says NOTHING is `unreported`, not silently either answer', async () => {
    // Guessing "unsigned" would make every append look broken against a relay that simply
    // does not report it; guessing "signed" is the defect above. Neither is a claim this
    // layer is entitled to make, so it says it does not know.
    const { deps } = makeDeps({ rows: [] });
    const res = await appendEntry(ref, { body: 'first' }, deps);
    expect(res.outcome === 'appended' && res.signing).toBe('unreported');
    expect(res.outcome === 'appended' && res.signingNote).toMatch(/UNKNOWN/);
  });

  it('the signing verdict survives onto a `pending` outcome too — the write happened', async () => {
    const { deps } = makeDeps({
      rows: [], neverVisible: true,
      publishResult: { descriptorUrl: d(90), status: 'pending', authorship: { signed: false, reason: 'key down' } },
    });
    const res = await appendEntry(ref, { body: 'first' }, deps);
    expect(res.outcome).toBe('pending');
    expect(res.outcome === 'pending' && res.signing).toBe('NOT-SIGNED');
  });

  it('agent_did rides along when the ref carries one, and is absent when it does not', async () => {
    // A hint for the verifier, NOT the identity: iep:issuer comes from the relay's own
    // session field. If this argument decided who the proof named, the proof would be
    // worthless — the caller types it.
    const withDid = makeDeps({ rows: [] });
    await appendEntry({ ...ref, agentDid: 'did:web:agents.test:bot-7' }, { body: 'x' }, withDid.deps);
    expect(withDid.calls[0]!.agent_did).toBe('did:web:agents.test:bot-7');

    const without = makeDeps({ rows: [] });
    await appendEntry(ref, { body: 'x' }, without.deps);
    expect(without.calls[0]).not.toHaveProperty('agent_did');
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

  // ★ These exist because the live substrate reports a failed read as DATA, not as a
  // rejection. `discover_context` against a dead host returns the plain string
  // "Error: fetch failed"; against a real pod holding nothing it returns
  // `{entries: [], registry: null}`. A permissive read reduces both to zero rows, and the
  // two claims could not be further apart.
  //
  // The composed view's per-stream isolation was fully covered by a double that THREW, so
  // it passed — and against the real relay it never fired once. An unreachable member was
  // rendered as an idle one. Testing the double is not testing the composition.

  const readWith = (value: unknown) =>
    readStream(ref, { publish: vi.fn(), discover: vi.fn(async () => value as Record<string, unknown>) });

  it('★ a tool-level error string THROWS rather than reading as an empty stream', async () => {
    await expect(readWith('Error: fetch failed')).rejects.toThrow(/did not return a result object/);
  });

  it('★ an error envelope throws too, carrying the message', async () => {
    await expect(readWith({ error: 'forbidden', message: 'no access to that pod' }))
      .rejects.toThrow(/no access to that pod/);
  });

  it('★ a result with no entries array throws — the read did not succeed', async () => {
    await expect(readWith({ registry: null })).rejects.toThrow(/unreachable member as an idle one/);
  });

  it('but a genuinely empty pod reads as an empty stream, not an error', async () => {
    // The opposite direction matters just as much: a member who has not written yet is
    // normal, and turning that into a failure would make every new workspace look broken.
    await expect(readWith({ entries: [], registry: null })).resolves.toEqual([]);
  });
});

// ── Authorship ───────────────────────────────────────────────────────────────

describe('proofBindsToDescriptor — is this proof about THIS record?', () => {
  // ★ The substrate's verifier answers a narrower question than it appears to: it re-derives
  // the canonical payload from the proof block's own fields and checks the signature over it.
  // A proof block copied verbatim out of one of a principal's real, public descriptors and
  // pasted into a record somebody else fabricated therefore verifies clean, naming that
  // principal. These pin the only cross-check available from outside the relay.

  it('an exact match binds', () => {
    expect(proofBindsToDescriptor('https://alice.test/c/9.ttl', 'https://alice.test/c/9.ttl')).toBe(true);
  });

  it('the relay\'s urn form binds to the URL its slug produces', () => {
    // descriptor_id is minted as `urn:iep:<pod>:<epoch-ms>` and the descriptor URL is derived
    // from its terminal segment. Rejecting that shape would withhold every real entry.
    expect(proofBindsToDescriptor(
      'urn:iep:u-alice:1754000000000',
      'https://alice.test/context-graphs/1754000000000.ttl',
    )).toBe(true);
  });

  it('★ a proof LIFTED from another of the same author\'s records does not bind', () => {
    // The manufactured-participant attack in its surviving form: the signature is genuine and
    // the signer really is the member, and the proof is about a different document.
    expect(proofBindsToDescriptor(
      'urn:iep:u-alice:1754000000000',
      'https://conv.test/context-graphs/1799999999999.ttl',
    )).toBe(false);
  });

  it('a descriptor with no proof block at all does not bind', () => {
    expect(proofBindsToDescriptor(null, 'https://alice.test/c/9.ttl')).toBe(false);
  });

  it('an unparseable descriptor URL does not bind — refusing is the safe direction', () => {
    expect(proofBindsToDescriptor('urn:iep:u-alice:1', 'not a url')).toBe(false);
  });

  it('parses the id out of the embedded block, and only out of that block', () => {
    const ttl = '<> a iep:ContextDescriptor ;\n  iep:descriptorId <urn:iep:decoy:0> .\n\n'
      + '<> iep:authorshipProof [\n    a iep:SignedAuthorship ;\n'
      + '    iep:issuer <did:web:agents.test:bot-7> ;\n'
      + '    iep:descriptorId <urn:iep:u-alice:7> ;\n    iep:proofValue "0xabc"\n  ] .\n';
    expect(proofDescriptorId(ttl)).toBe('urn:iep:u-alice:7');
    expect(proofDescriptorId('<> a iep:ContextDescriptor .')).toBeNull();
  });
});

describe('readAttestation — one get_descriptor, and every failure is REPORTED', () => {
  const URL_A = 'https://alice.test/context-graphs/1754000000000.ttl';
  const proofTtl = (id: string) =>
    `<> iep:authorshipProof [ a iep:SignedAuthorship ; iep:descriptorId <${id}> ] .`;

  const depsReturning = (res: unknown): StreamDeps => ({
    publish: vi.fn(),
    discover: vi.fn(),
    getDescriptor: vi.fn(async () => res as Record<string, unknown>),
  });

  it('a verified proof bound to this descriptor is attested', async () => {
    const att = await readAttestation(URL_A, depsReturning({
      url: URL_A,
      turtle: proofTtl('urn:iep:u-alice:1754000000000'),
      authorship: { authorshipVerified: true, signedBy: 'did:web:agents.test:bot-7' },
    }));
    expect(att).toEqual({
      authorshipVerified: true,
      signedBy: 'did:web:agents.test:bot-7',
      boundToDescriptor: true,
      // A relay that reports no contentBinding has not checked one. Reading the omission as
      // anything but 'unbound' would let an older relay satisfy `requireContentBinding`.
      contentBinding: 'unbound',
    });
  });

  it('★ contentBinding is passed through, and anything unrecognised falls to `unbound`', async () => {
    // ★ THE DEFAULT IS THE SECURITY PROPERTY. This is JSON off a pod-facing tool: the field
    // can be missing, a non-string, or a value from a vocabulary this build predates. All of
    // them mean "nobody here established that the proof covers the content", and only
    // 'bound' may ever satisfy a policy that demands it — so the mapping is an allowlist,
    // not a cast. Defaulting the other way would turn a typo into a passing content check.
    const cases: [unknown, string][] = [
      ['bound', 'bound'],
      ['declared', 'declared'],
      ['unbound', 'unbound'],
      [undefined, 'unbound'],
      [null, 'unbound'],
      ['BOUND', 'unbound'],
      ['bound-ish', 'unbound'],
      [true, 'unbound'],
      [1, 'unbound'],
      [{ toString: () => 'bound' }, 'unbound'],
    ];
    for (const [raw, expected] of cases) {
      const att = await readAttestation(URL_A, depsReturning({
        url: URL_A,
        turtle: proofTtl('urn:iep:u-alice:1754000000000'),
        authorship: { authorshipVerified: true, signedBy: 'did:web:agents.test:bot-7', contentBinding: raw },
      }));
      expect(att.contentBinding, `contentBinding: ${JSON.stringify(raw)}`).toBe(expected);
    }
  });

  it('★ a descriptor with NO proof is unattested, with a reason naming why', async () => {
    // The state every entry written before this change is in. It must not read as an absent
    // objection: "nobody signed it" and "the signature checked out" are opposite claims.
    const att = await readAttestation(URL_A, depsReturning({ url: URL_A, turtle: '<> a iep:ContextDescriptor .' }));
    expect(att.authorshipVerified).toBe(false);
    expect(att.reason).toMatch(/without sign_authorship/);
  });

  it('a proof the relay refused carries the relay\'s own diagnostic', async () => {
    const att = await readAttestation(URL_A, depsReturning({
      url: URL_A, turtle: proofTtl('urn:iep:u-alice:1754000000000'),
      authorship: { authorshipVerified: false, signedBy: 'did:web:x', reason: 'signature did not recover' },
    }));
    expect(att).toMatchObject({ authorshipVerified: false, signedBy: 'did:web:x' });
    expect(att.reason).toBe('signature did not recover');
  });

  it('★ authorshipVerified must be the BOOLEAN true, not merely truthy', async () => {
    // This is JSON read off somebody's pod. A string "false", or a 1, must not come out the
    // admitting end of the branch.
    for (const value of ['true', 1, {}] as unknown[]) {
      const att = await readAttestation(URL_A, depsReturning({
        url: URL_A, turtle: proofTtl('urn:iep:u-alice:1754000000000'),
        authorship: { authorshipVerified: value, signedBy: 'did:web:x' },
      }));
      expect(att.authorshipVerified).toBe(false);
    }
  });

  it('a read that failed is unattested and says so, rather than throwing past the caller', async () => {
    // Withholding is the right outcome for all three of "no proof", "bad proof" and "could
    // not read" — the reason string is what keeps them distinguishable to a person.
    const errEnvelope = await readAttestation(URL_A, depsReturning({ error: 'forbidden', message: 'no access' }));
    expect(errEnvelope).toMatchObject({ authorshipVerified: false, signedBy: null });
    expect(errEnvelope.reason).toMatch(/no access/);

    const threw = await readAttestation(URL_A, {
      publish: vi.fn(), discover: vi.fn(),
      getDescriptor: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    });
    expect(threw.reason).toMatch(/ECONNREFUSED/);

    const notAnObject = await readAttestation(URL_A, depsReturning('Error: fetch failed'));
    expect(notAnObject.reason).toMatch(/did not return a result object/);
  });

  it('★ asking to verify without the tool THROWS — it cannot be answered "unverified"', async () => {
    // Answering here would hand back a result indistinguishable from a workspace whose
    // entries really are forged, produced by a caller who merely forgot a dependency.
    await expect(readAttestation(URL_A, { publish: vi.fn(), discover: vi.fn() }))
      .rejects.toThrow(/one call per entry/);
  });

  it('★ an unbound proof says WHICH of the four situations it is — three are not forgeries', () => {
    // `boundToDescriptor: false` has four causes and only one of them is a lifted proof. The
    // refusal downstream used to render all four as "the proof was copied in from another
    // record", stated as fact, so a record published by the PGSL-primary path
    // (`holon-<hash>.ttl`, which the naming convention here cannot match) had its real author
    // accused of forgery in the one channel operators are told to watch.
    return Promise.all([
      // (a) the response carried no turtle at all — nothing to compare, says nothing about
      //     the proof
      readAttestation(URL_A, depsReturning({
        url: URL_A, authorship: { authorshipVerified: true, signedBy: 'did:web:x' },
      })).then(att => {
        expect(att.boundToDescriptor).toBe(false);
        expect(att.reason).toMatch(/no descriptor turtle/);
      }),
      // (b) turtle present, proof block carries no iep:descriptorId
      readAttestation(URL_A, depsReturning({
        url: URL_A, turtle: '<> iep:authorshipProof [ a iep:SignedAuthorship ] .',
        authorship: { authorshipVerified: true, signedBy: 'did:web:x' },
      })).then(att => {
        expect(att.boundToDescriptor).toBe(false);
        expect(att.reason).toMatch(/no iep:descriptorId/);
      }),
      // (c) an honest record whose name does not follow the convention — refused, correctly,
      //     and NOT called a forgery
      readAttestation(
        'https://css.test/u-alice/context-graphs/holon-9f2c1a.ttl',
        depsReturning({
          turtle: proofTtl('urn:iep:u-alice:pgsl:sha256-9f2c1a'),
          authorship: { authorshipVerified: true, signedBy: 'did:web:x' },
        }),
      ).then(att => {
        expect(att.boundToDescriptor).toBe(false);
        expect(att.reason).toMatch(/pgsl:sha256-9f2c1a/);
        expect(att.reason).toMatch(/holon-9f2c1a\.ttl/);
      }),
      // (d) an actually-lifted proof reaches the same verdict by the same route — the layer
      //     genuinely cannot tell (c) from (d), which is why it now says so
      readAttestation(URL_A, depsReturning({
        url: URL_A, turtle: proofTtl('urn:iep:u-alice:1799999999999'),
        authorship: { authorshipVerified: true, signedBy: 'did:web:x' },
      })).then(att => {
        expect(att.boundToDescriptor).toBe(false);
        expect(att.reason).toMatch(/1799999999999/);
      }),
    ]).then(() => undefined);
  });

  it('a bound proof carries NO reason — a diagnostic on a clean result is noise', async () => {
    const att = await readAttestation(URL_A, depsReturning({
      url: URL_A, turtle: proofTtl('urn:iep:u-alice:1754000000000'),
      authorship: { authorshipVerified: true, signedBy: 'did:web:x' },
    }));
    expect(att.boundToDescriptor).toBe(true);
    expect(att.reason).toBeUndefined();
  });
});
