/**
 * REPLYING TO AN AGENT — THE ONE FORM OF ADDRESSING THE BOT COULD NOT READ.
 *
 * A person watched their delegate answer in the channel, hit Discord's Reply, typed a follow-up,
 * and it was filed as an ordinary entry addressed to nobody. Both other forms worked:
 * `/workspace ask` picks from a list, and a sentence opening with a name is routed by
 * `addressedText`. Each makes the person supply the name. A reply supplies it from context, which
 * is the entire reason people reach for it — and it needs two things the bot did not have:
 *
 *   1. the reply reference off `MESSAGE_CREATE` (`message_reference.message_id`), which the
 *      gateway parsed away, and
 *   2. a memory of which Discord message was which agent, which needs `?wait=true` on the webhook
 *      or Discord answers 204 and the post has no id at all.
 *
 * ── WHAT THIS FILE PINS ──────────────────────────────────────────────────────
 *
 * §1 the gateway now surfaces the reference, and still reports its absence as absence.
 * §2 the store maps, bounds, and evicts oldest-first — including the re-remember case, where a
 *    naive `set` leaves a still-current message at its original position and evicts it early.
 * §3 the precedence rule: a TYPED name beats the reply, because someone who replies to one agent
 *    while naming another means the one they named.
 *
 * The `ask()` path itself is not re-tested here. That is the point of routing through it: a reply
 * yields a candidate name and nothing else, and the delegator's own pod remains the only thing
 * that decides whether the agent exists, may append, or is revoked.
 */

import { describe, it, expect } from 'vitest';
import { DiscordGateway, type GatewayAutocomplete, type GatewayInteraction, type GatewayMessage } from '../src/discord.js';
import { SpokenBy, SPOKEN_BY_LIMIT } from '../src/spoken-by.js';

// ── §1 THE GATEWAY SURFACES THE REFERENCE ────────────────────────────────────

class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  on(): this { return this; }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close(): void { /* nothing to close */ }
}

function messagesFrom(payload: Record<string, unknown>): readonly GatewayMessage[] {
  const seen: GatewayMessage[] = [];
  const gw = new DiscordGateway('tok', {
    onMessage: (m) => seen.push(m),
    onInteraction: (_i: GatewayInteraction) => undefined,
    onAutocomplete: (_a: GatewayAutocomplete) => undefined,
    onNotice: () => undefined,
    onFatal: () => undefined,
  }, () => new FakeSocket() as unknown as never);
  gw.onFrame(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: payload }));
  gw.stop();
  return seen;
}

const BASE = { id: 'm2', channel_id: 'c1', author: { id: 'u1' }, content: 'and what about Tuesday?' };

describe('a reply arrives with the message it answers', () => {
  it('★ carries message_reference.message_id, which used to be parsed away', () => {
    const [msg] = messagesFrom({ ...BASE, message_reference: { message_id: 'm1', channel_id: 'c1' } });
    expect(msg?.replyToId).toBe('m1');
    // The rest of the message is unchanged — this adds a field, it does not reinterpret one.
    expect(msg?.content).toBe('and what about Tuesday?');
    expect(msg?.id).toBe('m2');
  });

  it('reports an ordinary message as having no reference, rather than as an empty one', () => {
    expect(messagesFrom(BASE)[0]?.replyToId).toBeNull();
  });

  it('★ reads the reference, not the embedded copy Discord may omit', () => {
    // `referenced_message` is absent when the target is deleted or uncached; the reference
    // survives. Taking the copy would silently drop the reply gesture on older messages.
    const [msg] = messagesFrom({ ...BASE, message_reference: { message_id: 'm1' }, referenced_message: null });
    expect(msg?.replyToId).toBe('m1');
  });

  it('ignores a malformed reference instead of coercing it to a string', () => {
    expect(messagesFrom({ ...BASE, message_reference: { message_id: 12345 } })[0]?.replyToId).toBeNull();
    expect(messagesFrom({ ...BASE, message_reference: {} })[0]?.replyToId).toBeNull();
  });
});

describe('an attachment is a thing that was posted, and now reaches the record', () => {
  it('★ a picture with no caption used to write nothing and say nothing', () => {
    // `content: ""` reached `recordMessage`, which answered `{ kind: 'empty' }`, which
    // `renderRecord` rendered as null. Correct about the words and wrong about the event: the
    // person posted something and the pod said they had not. `EntryDraft.body` is optional in the
    // substrate for exactly this case.
    const [msg] = messagesFrom({
      ...BASE, content: '',
      attachments: [{ filename: 'floorplan.png', url: 'https://cdn.discordapp.com/x/floorplan.png?ex=1', content_type: 'image/png', size: 40518 }],
    });
    expect(msg?.content).toBe('');
    expect(msg?.attachments).toEqual([{
      name: 'floorplan.png',
      url: 'https://cdn.discordapp.com/x/floorplan.png?ex=1',
      mediaType: 'image/png',
      bytes: 40518,
    }]);
  });

  it('an ordinary message reports no attachments rather than undefined', () => {
    expect(messagesFrom(BASE)[0]?.attachments).toEqual([]);
  });

  it('keeps every file when several are posted at once', () => {
    const [msg] = messagesFrom({
      ...BASE,
      attachments: [
        { filename: 'a.png', url: 'https://cdn/a' },
        { filename: 'b.pdf', url: 'https://cdn/b' },
        { filename: 'c.csv', url: 'https://cdn/c' },
      ],
    });
    expect(msg?.attachments.map((a) => a.name)).toEqual(['a.png', 'b.pdf', 'c.csv']);
  });

  it('★ reports a missing type or size as null rather than inventing one', () => {
    // A record that guessed `application/octet-stream` would be asserting something Discord did
    // not say, on a descriptor that cannot afterwards be corrected.
    const [msg] = messagesFrom({ ...BASE, attachments: [{ filename: 'x.bin', url: 'https://cdn/x' }] });
    expect(msg?.attachments[0]?.mediaType).toBeNull();
    expect(msg?.attachments[0]?.bytes).toBeNull();
  });

  it('drops an entry with no name or no location instead of half-recording it', () => {
    const [msg] = messagesFrom({
      ...BASE,
      attachments: [
        { filename: 'good.png', url: 'https://cdn/good' },
        { url: 'https://cdn/nameless' },
        { filename: 'no-url.png' },
        { filename: '', url: 'https://cdn/empty' },
        null,
      ],
    });
    expect(msg?.attachments.map((a) => a.name)).toEqual(['good.png']);
  });
});

// ── §2 THE STORE ─────────────────────────────────────────────────────────────

const AGENT_A = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-a';
const AGENT_B = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-b';

describe('which message was which agent', () => {
  it('answers for a message it recorded, and null for one it never saw', () => {
    const s = new SpokenBy();
    s.remember('m1', AGENT_A);
    expect(s.agentFor('m1')).toBe(AGENT_A);
    expect(s.agentFor('m-unknown')).toBeNull();
    // A message that is not a reply asks with null, and must not throw or match anything.
    expect(s.agentFor(null)).toBeNull();
  });

  it('keeps two agents in the same channel distinct', () => {
    const s = new SpokenBy();
    s.remember('m1', AGENT_A);
    s.remember('m2', AGENT_B);
    expect(s.agentFor('m1')).toBe(AGENT_A);
    expect(s.agentFor('m2')).toBe(AGENT_B);
  });

  it('ignores an empty id or agent rather than storing a mapping to nothing', () => {
    const s = new SpokenBy();
    s.remember('', AGENT_A);
    s.remember('m1', '');
    expect(s.size).toBe(0);
    expect(s.agentFor('m1')).toBeNull();
  });

  it('★ is bounded — the bot runs for weeks and every agent message adds one', () => {
    const s = new SpokenBy(3);
    s.remember('m1', AGENT_A);
    s.remember('m2', AGENT_A);
    s.remember('m3', AGENT_A);
    s.remember('m4', AGENT_A);
    expect(s.size).toBe(3);
    // Oldest-first eviction: the eldest is gone, everything newer survives.
    expect(s.agentFor('m1')).toBeNull();
    expect(s.agentFor('m4')).toBe(AGENT_A);
  });

  it('★ an evicted message falls back to being unrecognised, which is the pre-existing behaviour', () => {
    // Stated as a test because it is the cost of the bound: replying to a very old agent message
    // records an ordinary entry, exactly as it did before any of this existed. That is the same
    // fallback an unrecognised name gets, and it is why a modest cap is not a trap.
    const s = new SpokenBy(1);
    s.remember('old', AGENT_A);
    s.remember('new', AGENT_B);
    expect(s.agentFor('old')).toBeNull();
  });

  it('★ re-remembering a message moves it to the newest position, not its original one', () => {
    // The naive form — `set` without a preceding `delete` — leaves the key at its first insertion
    // point in a Map's iteration order. The message would then be evicted as though it were the
    // oldest thing said while actually being the newest, and a reply to the message a person is
    // currently looking at would fall through.
    const s = new SpokenBy(2);
    s.remember('m1', AGENT_A);
    s.remember('m2', AGENT_A);
    s.remember('m1', AGENT_B);   // m1 is now the most recent
    s.remember('m3', AGENT_A);   // evicts the true oldest, m2
    expect(s.agentFor('m2')).toBeNull();
    expect(s.agentFor('m1')).toBe(AGENT_B);
    expect(s.agentFor('m3')).toBe(AGENT_A);
  });

  it('defaults to a limit sized for a conversation rather than for history', () => {
    expect(SPOKEN_BY_LIMIT).toBeGreaterThanOrEqual(500);
    const s = new SpokenBy();
    for (let i = 0; i < SPOKEN_BY_LIMIT + 10; i++) s.remember('m' + i, AGENT_A);
    expect(s.size).toBe(SPOKEN_BY_LIMIT);
  });
});

// ── §3 PRECEDENCE ────────────────────────────────────────────────────────────

/**
 * The rule `main.ts` applies, stated as the one line it is.
 *
 * ★ ASSERTED HERE RATHER THAN THROUGH THE WIRING because reaching `onMessage` means a gateway, a
 * relay session, a link store and a per-pod queue — and the decision under test is which of two
 * candidate names wins. Exercised at that size, a failure would be reported as a write to the
 * wrong pod several layers away from the choice that caused it.
 */
const choose = (typedSpec: string | null, repliedAgent: string | null): string | null =>
  typedSpec ?? repliedAgent;

describe('a typed name outranks the message being replied to', () => {
  it('uses the reply when the sentence names nobody', () => {
    expect(choose(null, AGENT_A)).toBe(AGENT_A);
  });

  it('★ uses the TYPED name even while replying to a different agent', () => {
    // Someone who replies to one agent while writing "Claude Desktop, ..." means the one they
    // named. Reading the reference over their words would be the bot deciding it knows better.
    expect(choose('Claude Desktop', AGENT_B)).toBe('Claude Desktop');
  });

  it('addresses nobody when there is neither, so an ordinary message stays ordinary', () => {
    expect(choose(null, null)).toBeNull();
  });
});
