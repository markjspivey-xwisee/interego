/**
 * A PRIVATE WORKSPACE MUST NOT BECOME N SILOS.
 *
 * ── ★★ THE FAILURE THIS PINS ────────────────────────────────────────────────
 *
 * Entries live on their AUTHOR's pod. `visibility: 'shared'` seals a payload to that pod's own
 * registered agents unioned with `share_with` — so with no `share_with`, the union is just the
 * author. Every entry in a "private" channel would be encrypted to the one person who wrote it.
 *
 * Nothing about that looks wrong from the writing side: the publish returns 200, the entry appears
 * in the chain, the descriptor is well formed. It is only wrong from everybody else's side, where
 * the channel reads as a list of records none of which will open — and it cannot be repaired
 * afterwards, because an envelope's recipients are fixed when it is written.
 *
 * So the writers FAIL CLOSED: private with no recipients is a refusal, not a publish. Refusing
 * costs a message; publishing costs the record.
 */

import { describe, it, expect } from 'vitest';
import { postEntry } from '../packages/workspace-client/src/entry.js';
import { saveCanvas } from '../packages/workspace-client/src/canvas.js';
import { recipientsFor } from '../packages/workspace-client/src/recipients.js';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';
import type { Seat } from '../packages/workspace-client/src/seats.js';

const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const seat = (pod: string, over: Partial<Seat> = {}): Seat => ({
  graph: 'urn:graph:' + pod, grantUrl: null, grantCid: null, role: 'Contributor',
  grantedTo: WEBID(pod), pod, seated: true, why: null, ...over,
} as Seat);

/** Records every `publish_context` argument set, and answers plausibly. */
function recordingClient(): { client: WorkspaceClient; published: Record<string, unknown>[] } {
  const published: Record<string, unknown>[] = [];
  const tx = {
    callTool: (name: string, input: Record<string, unknown>) => {
      if (name === 'discover_context') return Promise.resolve({ pod: 'u-a', entries: [] });
      if (name === 'publish_context') {
        published.push(input);
        return Promise.resolve({ published: true, descriptorUrl: 'https://css.example/u-a/x.ttl', status: 'committed' });
      }
      return Promise.resolve({});
    },
  };
  return { client: new WorkspaceClient('https://relay.example', tx as never), published };
}

const ENTRY = {
  podName: 'u-a', streamIri: 'https://relay.example/ns/u-a/wsp-stream',
  workspace: 'https://relay.example/ns/u-a/wsp', body: 'hello', entryShape: null,
  author: { kind: 'principal', webId: WEBID('u-a') } as const,
};
const CANVAS = {
  canvasIri: 'https://relay.example/ns/u-a/wsp-canvas', podName: 'u-a',
  workspace: 'https://relay.example/ns/u-a/wsp', slug: 'wsp', body: 'notes',
  ifMatch: null, previousCid: null,
};

describe('★★ a private write with no recipients is refused, not published', () => {
  it('refuses an entry rather than sealing it to its author alone', async () => {
    const { client, published } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private' });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('seal it to you alone');
    // The point of failing closed: nothing reached the relay.
    expect(published).toHaveLength(0);
  });

  it('refuses a canvas save for the same reason', async () => {
    const { client, published } = recordingClient();
    const out = await saveCanvas(client, { ...CANVAS, visibility: 'private' });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('seal it to you alone');
    expect(published).toHaveLength(0);
  });

  it('★ and an EMPTY recipient list is refused too — it is not a shorter list, it is nobody', async () => {
    const { client } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private', shareWith: [] });
    expect(out.kind).toBe('refused');
  });
});

describe('what actually reaches the relay', () => {
  it('★★ sends share_with for a private entry', async () => {
    const { client, published } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private', shareWith: [WEBID('u-b')] });
    expect(out.kind).toBe('accepted');
    expect(published[0]?.['visibility']).toBe('shared');
    expect(published[0]?.['share_with']).toEqual([WEBID('u-b')]);
  });

  it('★ and sends NO share_with for a public one, which would imply an audience the plaintext has not got', async () => {
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, visibility: 'public', shareWith: [WEBID('u-b')] });
    expect(published[0]?.['visibility']).toBe('public');
    expect(published[0]).not.toHaveProperty('share_with');
  });

  it('★ the canvas sends it too', async () => {
    const { client, published } = recordingClient();
    // `awaitTries: 0` because this asserts what was SENT, not what the pod did with it — the
    // head-settling loop would otherwise poll a fake that never settles.
    await saveCanvas(client, { ...CANVAS, visibility: 'private', shareWith: [WEBID('u-b')], awaitTries: 0 });
    expect(published[0]?.['visibility']).toBe('shared');
    expect(published[0]?.['share_with']).toEqual([WEBID('u-b')]);
  });
});

describe('★★ a member the relay could not reach is REPORTED, since it cannot be undone', () => {
  /**
   * `resolveRecipient` returns an empty key list rather than an error when a handle does not
   * resolve or a member's pod registers no encryption key — somebody who has only ever opened the
   * workspace in the browser artifact, for instance. The publish SUCCEEDS, encrypted to fewer
   * people than it named, and is indistinguishable from one that reached everybody.
   *
   * By the time this is known the entry is written and its recipients are sealed into it, so
   * reporting is the only move left — but a signal nothing reads is the same as no signal, which
   * is why `postEntry` reads it rather than leaving it to each caller.
   */
  function clientAnswering(sharedWith: unknown): WorkspaceClient {
    const tx = {
      callTool: (name: string) => Promise.resolve(name === 'discover_context'
        ? { pod: 'u-a', entries: [] }
        : { published: true, descriptorUrl: 'https://css.example/u-a/x.ttl', status: 'committed', sharedWith }),
    };
    return new WorkspaceClient('https://relay.example', tx as never);
  }

  it('names the member whose pod resolved to no key', async () => {
    const out = await postEntry(clientAnswering([
      { handle: WEBID('u-a'), agentCount: 2 },
      { handle: WEBID('u-b'), agentCount: 0 },
    ]), { ...ENTRY, visibility: 'private', shareWith: [WEBID('u-a'), WEBID('u-b')] });
    expect(out.kind).toBe('accepted');
    if (out.kind === 'accepted') expect(out.unreached).toEqual([WEBID('u-b')]);
  });

  it('★ and says nothing when everybody was reached', async () => {
    const out = await postEntry(clientAnswering([{ handle: WEBID('u-a'), agentCount: 1 }]),
      { ...ENTRY, visibility: 'private', shareWith: [WEBID('u-a')] });
    expect(out.kind).toBe('accepted');
    if (out.kind === 'accepted') expect(out.unreached).toEqual([]);
  });

  it('★ a PUBLIC post carries no sharedWith, and that is not "everybody unreachable"', async () => {
    // Reading an absent field as total failure would put a warning on every ordinary write in the
    // system — the exact over-reading `unreachedRecipients` was written to avoid.
    const out = await postEntry(clientAnswering(undefined), { ...ENTRY, visibility: 'public' });
    expect(out.kind).toBe('accepted');
    if (out.kind === 'accepted') expect(out.unreached).toEqual([]);
  });
});

describe('★★ when the host can seal, the relay never gets the words', () => {
  const SEALED_ENVELOPE = '{"algorithm":"X25519-XSalsa20-Poly1305","content":{"ciphertext":"OPAQUE","nonce":"n"},"wrappedKeys":[{"recipientPublicKey":"K","wrapped":"w","nonce":"n"}]}';
  const sealer = async (): Promise<{ ok: true; graphContent: string; contentDigest: string; cleartextMirror: string; recipientCount: number }> => ({
    ok: true, graphContent: SEALED_ENVELOPE, contentDigest: 'bafydigest',
    cleartextMirror: '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .', recipientCount: 1,
  });

  it('sends the envelope and the sealed flag, not the plaintext', async () => {
    const { client, published } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private', seal: sealer });
    expect(out.kind).toBe('accepted');
    expect(published[0]?.['graph_content']).toBe(SEALED_ENVELOPE);
    expect(published[0]?.['sealed_payload']).toBe(true);
    expect(published[0]?.['content_digest']).toBe('bafydigest');
    expect(published[0]?.['cleartext_mirror']).toContain('iep:');
  });

  it('★★ the words themselves reach the relay nowhere in the request', async () => {
    // The whole claim, stated as the only thing that can verify it: search everything sent.
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, body: 'MARKER-secret-words', visibility: 'private', seal: sealer });
    expect(JSON.stringify(published)).not.toContain('MARKER-secret-words');
  });

  it('★★ no share_with, because the relay would answer with itself in the recipient set', async () => {
    /**
     * `share_with` asks the RELAY to resolve handles to keys and seal to them. The envelope is
     * already built so the list cannot affect it — but the relay would still compute a recipient
     * set including its own key and report that, announcing itself as a recipient of an envelope
     * it is provably not in.
     */
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, visibility: 'private', shareWith: [WEBID('u-b')], seal: sealer });
    expect(published[0]).not.toHaveProperty('share_with');
  });

  it('★★ no conforms_to_shapes, because validating ciphertext is a hard 422', async () => {
    // `validateAgainstShape` over an envelope does not fail to find violations — it fails to
    // PARSE. Sending the shape would refuse every honest sealed write.
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, entryShape: 'urn:shape:entry', visibility: 'private', seal: sealer });
    expect(published[0]).not.toHaveProperty('conforms_to_shapes');
  });

  it('★★ a seal that REFUSES does not fall back to sending plaintext', async () => {
    /**
     * The most tempting wrong behaviour in the whole feature. "I could not encrypt this to your
     * members, so I sent it in the clear instead" answers the problem by doing the exact thing the
     * person was avoiding — and it would look like a successful post.
     */
    const { client, published } = recordingClient();
    const out = await postEntry(client, {
      ...ENTRY, body: 'MARKER-secret-words', visibility: 'private',
      seal: async () => ({ ok: false as const, why: 'one member published no key' }),
    });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('no key');
    expect(published, 'nothing may reach the relay after a refused seal').toHaveLength(0);
  });

  it('★ a PUBLIC workspace does not seal even when a sealer is available', async () => {
    // Public means published in the clear; sealing it would make it unreadable to the audience it
    // was chosen for.
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, visibility: 'public', seal: sealer });
    expect(published[0]?.['visibility']).toBe('public');
    expect(published[0]).not.toHaveProperty('sealed_payload');
  });
});

describe('recipientsFor joins "is it private" to "who is in it"', () => {
  const roster = { seats: [seat('u-a'), seat('u-b')], grantsFound: 2, grantsRead: 2 };

  it('gives no list at all for a public workspace', () => {
    const r = recipientsFor('public', roster);
    expect(r.ok).toBe(true);
    // undefined, NOT [] — the writers only send `share_with` when they are actually encrypting,
    // and an empty array is the value that means "nobody".
    if (r.ok) expect(r.shareWith).toBeUndefined();
  });

  it('gives every seated member for a private one', () => {
    const r = recipientsFor('private', roster);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shareWith).toEqual([WEBID('u-a'), WEBID('u-b')]);
  });

  it('★★ refuses when the workspace is private and no roster was read', () => {
    // The state a caller is in before the members list loads. Publishing here would seal to the
    // author alone — the exact silo this file exists for — so it is a refusal.
    const r = recipientsFor('private', null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    /**
     * ★ THE FACTS A CALLER ACTS ON, NOT THE SENTENCE. This assertion used to pin the substring
     * 'roster has not been read', and the copy has since been rewritten twice — once because it
     * told somebody to wait for a members list that had already FAILED to load, which is not an
     * act. A test pinned to the wording fails on every honest correction and pins none of what a
     * caller does with the result, so what is pinned here is: it refuses, repeating the same call
     * can succeed, it names the read to repeat, and it says the write was withheld.
     */
    expect(r.retryable, 'a state that a re-read clears was reported as terminal').toBe(true);
    expect(r.why, 'the refusal names no act').toMatch(/members read|read the members/i);
    expect(r.why).toContain('Nothing was written');
  });

  it('★ and refuses a truncated roster rather than encrypting to the part of it that was read', () => {
    // 15 of the 40 grants this fold FOUND were never read, so the recipient set built from it is
    // not the workspace. Re-sealing the record to it would retire the revision the other 15 need
    // in order to accept — a one-way door out, for somebody nobody revoked.
    const r = recipientsFor('private', { seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The counts, because they are what makes the refusal checkable against the workspace.
    expect(r.why, 'the shortfall is not quantified').toContain('15');
    expect(r.why, 'the roster it was measured against is not named').toContain('40');
    /**
     * ★ AND `retryable` IS FALSE, WHICH IS THE HONEST ANSWER HERE AND WAS NOT ALWAYS. This fold
     * reports a shortfall and names no row for it, so nothing is established about those grants
     * — not even whether they were asked for. Offering a bare Retry over that advertises an act
     * whose effect is unknown; `retryable` means precisely that this same call, unchanged, can
     * answer differently, and nothing here says it can.
     */
    expect(r.retryable).toBe(false);
    expect(r.why).toContain('Nothing was written');
  });

  /**
   * ── ★★ AND A REFUSAL NOBODY FINISHES READING NAMES NO EXIT ──────────────────────
   *
   * Measured on the fold above: 1,279 characters in which the phrase "a grant whose IRI names no
   * pod" appeared THIRTY times — fifteen in the clause naming the population, fifteen more in the
   * clause naming what could be done about it. Every word of it was true.
   *
   * That is not a cosmetic complaint. The person holding a refusal is deciding what to do next,
   * and the two clauses that answer that were buried in a wall of one repeated phrase; a refusal
   * that is not read to the end costs exactly what a refusal naming no exit costs, which is the
   * failure the rest of `recipients.ts` was written to avoid. Every list in that file is one row
   * per member or per grant, so any of them can do this.
   *
   * ★ PINNED AS A PROPERTY, BECAUSE THE WORDING IS THE PART THAT CHANGES. The rule is: name each
   * distinct cause once, and stay short enough to act on.
   */
  const worstRepeat = (text: string): { phrase: string; times: number } => {
    const words = text.split(/\s+/).filter((w) => w !== '');
    let worst = { phrase: '', times: 1 };
    // Five words is long enough not to collide on the ordinary connectives a refusal is made of,
    // and short enough to catch a repeated NAME together with the grammar around it.
    for (let n = 5; n <= 10; n++) {
      const seen = new Map<string, number>();
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        const times = (seen.get(phrase) ?? 0) + 1;
        seen.set(phrase, times);
        if (times > worst.times) worst = { phrase, times };
      }
    }
    return worst;
  };

  /** One grant this fold reached for and did not read — the shape `foldRoster` records. */
  const unreadRow = (pod: string): {
    graph: string; pod: string; kind: 'transient'; clears: 'read-again'; why: string;
  } => ({
    graph: 'https://relay.example/ns/u-a/wsp-grant-' + pod, pod,
    kind: 'transient', clears: 'read-again', why: 'the grant record could not be read',
  });

  it('★★ and it names each cause once, so it can be read to the end', () => {
    // 1. THE MEASURED FOLD. It reports a shortfall and names no row for it, so every one of the
    //    fifteen is the same nothing and the only honest rendering of them is a count.
    const padded = recipientsFor('private', { seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 });
    expect(padded.ok).toBe(false);
    if (padded.ok) return;
    const worst = worstRepeat(padded.why);
    expect(worst.times, 'the refusal says "' + worst.phrase + '" ' + worst.times + ' times')
      .toBeLessThanOrEqual(2);

    // 2. AND A REAL ROSTER'S WORTH OF NAMES STAYS SHORT. Measured with the cap removed, this same
    //    fold answers in 810 characters, half of them a list of forty pods standing between the
    //    reader and the clause that says what to do. A relay outage puts every grant in a
    //    workspace into this state at once, so the size of the list is the size of the workspace.
    const many = recipientsFor('private', {
      seats: [seat('u-a')], grantsFound: 41, grantsRead: 1,
      unread: Array.from({ length: 40 }, (_, i) => unreadRow('u-eth-' + (0x1000 + i).toString(16))),
    });
    expect(many.ok).toBe(false);
    if (many.ok) return;
    expect(many.why.length, 'too long to read to the end is the same as naming no exit').toBeLessThan(600);
    expect(worstRepeat(many.why).times).toBeLessThanOrEqual(2);

    // 3. AND NO ROW IS NAMED TWICE. The opening sentence used to carry the whole population in
    //    parentheses and the clause naming the act then named every one of them over again, which
    //    is where half of the thirty copies came from.
    const two = recipientsFor('private', {
      seats: [seat('u-a')], grantsFound: 3, grantsRead: 1,
      unread: [unreadRow('u-eth-bb02'), unreadRow('u-eth-cc03')],
    });
    expect(two.ok).toBe(false);
    if (two.ok) return;
    for (const pod of ['u-eth-bb02', 'u-eth-cc03']) {
      expect(two.why.split(pod).length - 1, pod + ' is named more than once').toBe(1);
    }
  });
});
