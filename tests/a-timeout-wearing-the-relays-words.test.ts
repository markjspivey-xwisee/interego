/**
 * `publishAndConfirm` reported a TIMEOUT using the relay's sentence for a REFUSAL.
 *
 * ★ FOUND LIVE, NOT BY READING. A workspace create against the production fleet stopped at its
 * second document and told the caller:
 *
 *     at "role table": No descriptor on this pod describes the requested urn.
 *
 * That sentence is `get_current_head`'s, and on its own it is a definitive negative — the pod
 * does not have this. Asked again minutes later, the same pod answered `head: PRESENT` for the
 * same IRI. The write had SUCCEEDED. What had happened is that the confirm loop waited thirty
 * seconds for the manifest to catch up, gave up, and then repeated the last thing the relay had
 * said while it was still catching up.
 *
 * ── WHY THE RELAY IS NOT WRONG AND THE CLIENT IS ─────────────────────────────
 *
 * "No descriptor on this pod describes the requested urn" is a true and useful answer to
 * `get_current_head`. It is the wrong answer to "did my write land?", because during a write the
 * relay itself reported as `pending` it is the EXPECTED intermediate state — the very state this
 * loop exists to poll through. Adopting it as the verdict turns "not yet" into "not at all".
 *
 * ★ AND THE COST IS A USER'S CONCLUSION. `/workspace start` renders that detail verbatim under
 * "**The workspace was not fully created.**". A person reading it concludes the substrate
 * rejected their document. It is on their pod. The honest report — accepted, not readable within
 * the budget, safe to re-read or re-publish — leads them somewhere; the relay's sentence leads
 * them to a bug report about a write that worked.
 *
 * This is the same class as every other defect this repository keeps finding in its own
 * reporting: a step that says the wrong true thing about what just happened.
 */
import { describe, it, expect } from 'vitest';
import { RelayClient } from '@interego/core/relay';

/**
 * A transport that accepts the publish and then answers `get_current_head` exactly as the live
 * relay does while a write is still settling: no `head` key, and the message that reads like a
 * refusal.
 */
function transportThatNeverSettles(): {
  readonly tx: Parameters<typeof makeClient>[0];
  readonly heads: () => number;
} {
  let heads = 0;
  const tx = {
    connect: async () => ({ granted: [] as readonly string[] }),
    callTool: async (name: string, _input: Record<string, unknown>): Promise<unknown> => {
      if (name === 'publish_context') {
        return { status: 'pending', descriptorUrl: 'http://css.railway.internal:3456/p/ctx/1.ttl' };
      }
      if (name === 'get_current_head') {
        heads++;
        // ★ EXACTLY THE LIVE SHAPE: no `head` key at all. A stand-in that returned `head: null`
        // is what hid a different bug in this same function for three rounds.
        return {
          urn: 'https://relay.example/ns/p/w-roles',
          podUrl: 'http://css.railway.internal:3456/p/',
          message: 'No descriptor on this pod describes the requested urn.',
        };
      }
      return {};
    },
  };
  return { tx, heads: () => heads };
}

function makeClient(tx: {
  connect: () => Promise<{ granted: readonly string[] }>;
  callTool: (n: string, i: Record<string, unknown>) => Promise<unknown>;
}): RelayClient {
  return new RelayClient('https://relay.example', tx as never);
}

/**
 * A virtual clock the fake sleep advances, so the 30-second budget costs no wall time.
 *
 * ★ THE INJECTED `sleep` ALONE COULD NOT DO THIS, which is why the timeout branch had no test.
 * The budget is compared against a clock, so a sleep that returns immediately does not shorten
 * the wait — it spins for the full thirty REAL seconds and the test times out. The clock had to
 * become a parameter too before this branch could be tested at all.
 */
function virtualClock(): { readonly sleep: (ms: number) => Promise<void>; readonly now: () => number } {
  let t = 1_700_000_000_000;
  return {
    sleep: async (ms: number): Promise<void> => { t += ms; await Promise.resolve(); },
    now: () => t,
  };
}

describe('an accepted write that never reads back', () => {
  it('is reported as a TIMEOUT, not as the relay denying the document', async () => {
    const clock = virtualClock();
    const { tx } = transportThatNeverSettles();
    const out = await makeClient(tx).publishAndConfirm(
      { graph_iri: 'https://relay.example/ns/p/w-roles', graph_content: '' },
      'p', 'https://relay.example/ns/p/w-roles', undefined, clock.sleep, clock.now);

    expect(out.readable).toBe(false);
    const why = String(out.why);

    // ★ THE ASSERTION THAT MATTERS. Not "the message changed" — that a reader is TOLD the write
    // was accepted and that the wait, not the relay, ended it.
    expect(why, 'the report does not say the write was accepted').toMatch(/accepted this write/i);
    expect(why, 'the report does not say it stopped waiting').toMatch(/had not read back within/i);

    // The relay's own words are still there — they are evidence — but as a parenthetical.
    expect(why).toContain('No descriptor on this pod describes the requested urn.');
    expect(why, 'the relay sentence must not be the whole verdict')
      .not.toMatch(/^No descriptor/);

    // And it tells the reader what is safe to do next, because "it may have landed since" is
    // the actual situation and re-publishing supersedes rather than duplicating.
    expect(why).toMatch(/may have landed since/i);
  });

  it('still polls — the honest message is not a shortcut past the waiting', async () => {
    // A "fix" that reported the timeout nicely while never looking would pass the test above.
    const clock = virtualClock();
    const { tx, heads } = transportThatNeverSettles();
    await makeClient(tx).publishAndConfirm(
      { graph_iri: 'https://relay.example/ns/p/w-roles', graph_content: '' },
      'p', 'https://relay.example/ns/p/w-roles', undefined, clock.sleep, clock.now);
    expect(heads(), 'the confirm loop did not actually poll').toBeGreaterThan(3);
  });

  it('and a write that DOES read back is still plainly readable', async () => {
    // The other half: a report that always says "accepted but unconfirmed" is not a fix either.
    const url = 'http://css.railway.internal:3456/p/ctx/1.ttl';
    let asked = 0;
    const tx = {
      connect: async () => ({ granted: [] as readonly string[] }),
      callTool: async (name: string): Promise<unknown> => {
        if (name === 'publish_context') return { status: 'pending', descriptorUrl: url };
        asked++;
        return asked < 2
          ? { podUrl: 'http://css.railway.internal:3456/p/', message: 'No descriptor on this pod describes the requested urn.' }
          : { podUrl: 'http://css.railway.internal:3456/p/', head: { descriptorUrl: url } };
      },
    };
    const clock = virtualClock();
    const out = await makeClient(tx).publishAndConfirm(
      { graph_iri: 'https://relay.example/ns/p/w-roles', graph_content: '' },
      'p', 'https://relay.example/ns/p/w-roles', undefined, clock.sleep, clock.now);
    expect(out.readable).toBe(true);
    expect(out.why ?? null).toBeNull();
  });
});
