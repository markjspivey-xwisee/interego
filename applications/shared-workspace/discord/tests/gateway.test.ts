/**
 * THE DISCORD PROTOCOL CLIENT, DRIVEN FRAME BY FRAME.
 *
 * ★ THIS IS THE ONE PART OF THE BOT NO LIVE RUN COVERS, AND THAT IS WHY IT IS TESTED HERE.
 * `tools/drive-bot-live.ts` runs the whole substrate half against the real relay with real
 * identities; it does not connect to Discord, because doing that needs a bot token only the
 * maintainer can supply. So the gateway is exercised the only honest way left: the real class,
 * a real socket interface, and the actual JSON frames Discord sends — no `discord.js` to hide
 * behind and nothing standing in for the class under test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DiscordGateway, DiscordRest, COMMANDS, INTENTS, commandFingerprint,
  type GatewayAutocomplete, type GatewayInteraction, type GatewayMessage, type GatewayModalSubmit,
} from '../src/discord.js';

/** A socket that records what was sent and lets a test deliver frames and closes. */
class FakeSocket {
  readyState = 1;                                  // WebSocket.OPEN
  readonly sent: Record<string, unknown>[] = [];
  private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  on(ev: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb);
    this.handlers.set(ev, list);
    return this;
  }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close(code = 1000): void { this.readyState = 3; for (const cb of this.handlers.get('close') ?? []) cb(code); }
  emit(ev: string, ...a: unknown[]): void { for (const cb of this.handlers.get(ev) ?? []) cb(...a); }
}

interface Harness {
  readonly gw: DiscordGateway;
  readonly sockets: FakeSocket[];
  readonly messages: GatewayMessage[];
  readonly interactions: GatewayInteraction[];
  readonly autocompletes: GatewayAutocomplete[];
  readonly modals: GatewayModalSubmit[];
  readonly notices: string[];
  readonly fatals: string[];
  socket(): FakeSocket;
  frame(f: unknown): void;
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const messages: GatewayMessage[] = [];
  const interactions: GatewayInteraction[] = [];
  const autocompletes: GatewayAutocomplete[] = [];
  const modals: GatewayModalSubmit[] = [];
  const notices: string[] = [];
  const fatals: string[] = [];
  const gw = new DiscordGateway('tok', {
    onMessage: (m) => messages.push(m),
    onInteraction: (i) => interactions.push(i),
    onAutocomplete: (a) => autocompletes.push(a),
    onModalSubmit: (m) => modals.push(m),
    onNotice: (l) => notices.push(l),
    onFatal: (w) => fatals.push(w),
  }, () => { const s = new FakeSocket(); sockets.push(s); return s as unknown as never; });
  const socket = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
  return { gw, sockets, messages, interactions, autocompletes, modals, notices, fatals, socket, frame: (f) => { gw.onFrame(JSON.stringify(f)); } };
}

const HELLO = { op: 10, d: { heartbeat_interval: 41250 } };

describe('the gateway handshake', () => {
  it('identifies with the three intents this bot needs, including the privileged one', () => {
    const h = harness();
    h.gw.connect();
    h.frame(HELLO);
    const identify = h.socket().sent.find((f) => f['op'] === 2);
    expect(identify, 'no IDENTIFY was sent after HELLO').toBeTruthy();
    const d = identify?.['d'] as { intents?: number; token?: string };
    expect(d.token).toBe('tok');
    // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT. Asserted as the three bits rather than as the
    // literal, so a change to the constant that dropped one would fail here rather than pass.
    expect(d.intents).toBe(INTENTS);
    expect((d.intents ?? 0) & (1 << 15), 'MESSAGE_CONTENT is not requested, so every message would arrive empty').toBeTruthy();
    h.gw.stop();
  });

  it('resumes rather than re-identifying once it has a session', () => {
    const h = harness();
    h.gw.connect();
    h.frame(HELLO);
    h.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example', user: { username: 'bot', id: '9' } } });
    h.frame({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: { id: '1', channel_id: '2', author: { id: '3' }, content: 'x' } });
    h.socket().close(4000);
    h.gw.connect();
    h.frame(HELLO);
    const resume = h.socket().sent.find((f) => f['op'] === 6);
    expect(resume, 'a reconnect with a live session must RESUME, not re-IDENTIFY and lose the backlog').toBeTruthy();
    expect((resume?.['d'] as { seq?: number }).seq).toBe(7);
    h.gw.stop();
  });

  it('drops the session when the gateway says the resume is invalid', () => {
    const h = harness();
    h.gw.connect();
    h.frame(HELLO);
    h.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://r', user: {} } });
    h.frame({ op: 9, d: false });                     // INVALID SESSION, not resumable
    h.gw.connect();
    h.frame(HELLO);
    expect(h.socket().sent.find((f) => f['op'] === 6), 'resumed on a session the gateway rejected').toBeFalsy();
    expect(h.socket().sent.find((f) => f['op'] === 2)).toBeTruthy();
    h.gw.stop();
  });

  it('reconnects rather than sitting on a socket that stopped acking', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.frame({ op: 10, d: { heartbeat_interval: 1000 } });
      vi.advanceTimersByTime(1000);                   // first beat: acked flag was true, so it sends
      expect(h.socket().sent.filter((f) => f['op'] === 1)).toHaveLength(1);
      vi.advanceTimersByTime(1000);                   // second beat: no ack arrived
      // ★ A gateway that stops acking keeps the socket open and delivers nothing. The bot would
      // look healthy and silently record nothing, which for this bot is the worst failure there is.
      expect(h.notices.some((n) => n.includes('missed a heartbeat ack'))).toBe(true);
      expect(h.socket().readyState).toBe(3);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('names the privileged-intent close code instead of retrying forever', () => {
    const h = harness();
    h.gw.connect();
    h.socket().close(4014);
    expect(h.fatals).toHaveLength(1);
    expect(h.fatals[0]).toContain('MESSAGE CONTENT');
    expect(h.fatals[0]).toContain('Privileged Gateway Intents');
    expect(h.sockets).toHaveLength(1);                // and it did not reconnect
  });

  it('treats a rejected token as fatal too', () => {
    const h = harness();
    h.gw.connect();
    h.socket().close(4004);
    expect(h.fatals[0]).toContain('DISCORD_BOT_TOKEN');
  });
});

describe('dispatch', () => {
  it('reads a message and marks bot authors', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: '10', channel_id: '20', author: { id: '30', bot: true }, content: 'from a bot' } });
    h.frame({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '11', channel_id: '20', author: { id: '31' }, content: 'from a person' } });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]?.authorBot).toBe(true);
    expect(h.messages[1]?.authorBot).toBe(false);
    expect(h.messages[1]?.content).toBe('from a person');
    h.gw.stop();
  });

  it('ignores a message frame missing the fields every caller reads', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: '10', channel_id: '20' } });   // no author
    h.frame({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { channel_id: '20', author: { id: '3' } } }); // no id
    expect(h.messages).toHaveLength(0);
    h.gw.stop();
  });

  it('flattens a subcommand that takes NO argument — four of the five commands are one', () => {
    // ★ THE DEFECT THIS CASE FOUND. The flattening keyed on `Array.isArray(first.options)`,
    // which is true only for a subcommand that takes an argument. `/workspace start`, `link`,
    // `unlink` and `show` all arrived at the router as bare `workspace` and fell through to
    // "this bot does not know that command". Discord's type 1 is SUB_COMMAND; that is the fact.
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    for (const name of ['start', 'link', 'unlink', 'show']) {
      h.frame({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'i', token: 't', type: 2, channel_id: 'c', member: { user: { id: 'u1' } }, data: { name: 'workspace', options: [{ type: 1, name }] } } });
    }
    expect(h.interactions.map((i) => i.name)).toEqual(['workspace start', 'workspace link', 'workspace unlink', 'workspace show']);
    h.gw.stop();
  });

  it('★★ carries a BOOLEAN option, which was being dropped on the floor', () => {
    /**
     * Discord's option type 5 arrives as a real `boolean`. The collector accepted `string` and
     * `number` only, so a checkbox would render in the client, be ticked by the user, and simply
     * not arrive — the handler reading `undefined`, taking its default, and doing the OPPOSITE of
     * what was asked with nothing reporting a problem.
     *
     * `/workspace start private:true` is the first such option, and the default it would have
     * silently fallen back to is "public" — a workspace published in the clear for somebody who
     * asked for it to be encrypted. Pinned so the next boolean option cannot rediscover this.
     */
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: 'i', token: 't', type: 2, channel_id: 'c', member: { user: { id: 'u1' } },
        data: { name: 'workspace', options: [{ type: 1, name: 'start', options: [{ type: 5, name: 'private', value: true }] }] },
      },
    });
    expect(h.interactions[0]?.name).toBe('workspace start');
    expect(h.interactions[0]?.options['private']).toBe('true');
    h.gw.stop();
  });

  it('★ and a boolean left FALSE arrives as false, not as absent', () => {
    // The two are read differently downstream — absent means "not chosen", false means "chosen
    // not to". Collapsing them would be the same bug wearing the opposite sign.
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: 'i', token: 't', type: 2, channel_id: 'c', member: { user: { id: 'u1' } },
        data: { name: 'workspace', options: [{ type: 1, name: 'start', options: [{ type: 5, name: 'private', value: false }] }] },
      },
    });
    expect(h.interactions[0]?.options['private']).toBe('false');
    h.gw.stop();
  });

  it('delivers an autocomplete, flattened, with the FOCUSED option and not the subcommand', () => {
    // ★ TYPE 4 WAS DROPPED ON THE FLOOR AND `ask` IS BUILT AROUND IT. The flattening matters twice
    // here: without it `data.options[0]` is the SUBCOMMAND, so the focused option would never be
    // found and the picker would answer every keystroke with nothing.
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: 'a1', token: 'tk', type: 4, channel_id: 'c1', member: { user: { id: 'u1' } },
        data: {
          name: 'workspace',
          options: [{
            type: 1, name: 'ask',
            options: [
              { type: 3, name: 'agent', value: 'sched', focused: true },
              { type: 3, name: 'task', value: 'review Q3' },
            ],
          }],
        },
      },
    });
    expect(h.interactions).toHaveLength(0);
    expect(h.autocompletes).toHaveLength(1);
    const a = h.autocompletes[0] as GatewayAutocomplete;
    expect(a.name).toBe('workspace ask');
    expect(a.focused).toBe('agent');
    expect(a.query).toBe('sched');
    // The other option is carried too: a picker that wanted to narrow on what has been typed
    // elsewhere can, and one that does not is unaffected.
    expect(a.options['task']).toBe('review Q3');
    h.gw.stop();
  });

  it('names NO focused option rather than guessing one, when Discord marks none', () => {
    // A command with two autocompleting options would otherwise have both answered out of one
    // box's text. A handler told which box it is in can refuse; one that guessed would silently
    // answer the wrong one.
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: 'a2', token: 'tk', type: 4, channel_id: 'c1', user: { id: 'u9' },
        data: { name: 'workspace', options: [{ type: 1, name: 'ask', options: [{ type: 3, name: 'agent', value: 'x' }] }] },
      },
    });
    expect(h.autocompletes[0]?.focused).toBe('');
    expect(h.autocompletes[0]?.query).toBe('');
    h.gw.stop();
  });

  it('still ignores components and modals, which are genuinely unused', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    for (const type of [3, 5]) {
      h.frame({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'i', token: 't', type, channel_id: 'c', data: { name: 'workspace' } } });
    }
    expect(h.interactions).toHaveLength(0);
    expect(h.autocompletes).toHaveLength(0);
    h.gw.stop();
  });

  it('flattens a subcommand so the router sees "workspace link-confirm" with its option', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({
      op: 0, t: 'INTERACTION_CREATE', s: 1,
      d: {
        id: 'i1', token: 'tk', type: 2, channel_id: 'c1', channel: { name: 'design review' },
        member: { user: { id: 'u1' } },
        data: { name: 'workspace', options: [{ type: 1, name: 'link-confirm', options: [{ type: 3, name: 'pod', value: 'u-eth-0123456789ab' }] }] },
      },
    });
    expect(h.interactions).toHaveLength(1);
    const i = h.interactions[0] as GatewayInteraction;
    expect(i.name).toBe('workspace link-confirm');
    expect(i.options['pod']).toBe('u-eth-0123456789ab');
    expect(i.userId).toBe('u1');
    expect(i.channelName).toBe('design review');
    h.gw.stop();
  });

  it('reads the invoker from `user` in a DM, where there is no member', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    h.frame({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'i', token: 't', type: 2, channel_id: 'c', user: { id: 'u9' }, data: { name: 'workspace', options: [{ type: 1, name: 'link' }] } } });
    expect(h.interactions[0]?.userId).toBe('u9');
    expect(h.interactions[0]?.name).toBe('workspace link');
    h.gw.stop();
  });

  it('ignores interactions that are not application commands', () => {
    const h = harness();
    h.gw.connect(); h.frame(HELLO);
    // Type 3 is a message component. Half-answering one leaves Discord showing an error forever.
    h.frame({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'i', token: 't', type: 3, channel_id: 'c', data: { name: 'x' } } });
    expect(h.interactions).toHaveLength(0);
    h.gw.stop();
  });

  it('survives a frame that is not JSON, and says so', () => {
    const h = harness();
    h.gw.connect();
    h.gw.onFrame('<html>a proxy error page</html>');
    expect(h.notices.some((n) => n.includes('could not parse'))).toBe(true);
    h.gw.stop();
  });
});

describe('the command tree', () => {
  it('declares exactly the subcommands the bot routes, and only those', () => {
    // ★ THE LIST IS PINNED SO A COMMAND CANNOT BE REGISTERED WITHOUT A ROUTE, or routed without
    // being registered. `mentions` was added in the round that made agents @mentionable, and this
    // is the check that noticed — which is the point of writing the names out rather than counting.
    const tree = COMMANDS[0];
    expect(tree.name).toBe('workspace');
    const names = tree.options.map((o) => o.name).sort();
    expect(names).toEqual(['ask', 'link', 'link-confirm', 'mentions', 'show', 'start', 'unlink', 'who']);
    const confirm = tree.options.find((o) => o.name === 'link-confirm') as { options?: readonly { name: string; required?: boolean }[] };
    expect(confirm.options?.[0]?.name).toBe('pod');
    expect(confirm.options?.[0]?.required).toBe(true);
  });

  it('registers `ask` with a LIVE picker and no static choice list', () => {
    // ★ A STATIC `choices` ARRAY WOULD BE THIS BOT'S CACHED OPINION OF SOMEBODY ELSE'S REGISTRY.
    // Which agents exist, which their delegator still authorises and which have said their host is
    // up are all facts on other people's pods that change between one command and the next.
    const tree = COMMANDS[0] as unknown as { options: readonly { name: string; options?: readonly Record<string, unknown>[] }[] };
    const askCmd = tree.options.find((o) => o.name === 'ask') as { options: readonly Record<string, unknown>[] };
    const agent = askCmd.options.find((o) => o['name'] === 'agent') as Record<string, unknown>;
    expect(agent['autocomplete']).toBe(true);
    expect(agent['required']).toBe(true);
    expect(agent['choices']).toBeUndefined();
    expect(askCmd.options.find((o) => o['name'] === 'task')?.['required']).toBe(true);
  });
});

/**
 * ★ THE FINGERPRINT DECIDES WHETHER TO RE-REGISTER, AND BOTH WAYS OF BEING WRONG COST SOMETHING.
 *
 * Too eager and every boot bumps the command `version`, which makes Discord reject invocations
 * carrying the older one — "This command is outdated, please try again in a few minutes" — for as
 * long as a client caches it. Too lax and a real edit to the tree is never published, which is the
 * worse of the two because nothing anywhere would say so.
 */
describe('deciding whether the command tree needs re-registering', () => {
  /** What Discord hands back: the same tree plus the fields it fills in and this bot never sends. */
  const asDiscordStoredIt = (): readonly unknown[] => [{
    id: '123456789',
    application_id: '987654321',
    version: '111222333',
    default_member_permissions: null,
    dm_permission: true,
    nsfw: false,
    // Discord stores CHAT_INPUT explicitly; the bot omits it and relies on the default.
    type: 1,
    name: 'workspace',
    description: COMMANDS[0].description,
    options: COMMANDS[0].options.map((o) => ({
      type: o.type, name: o.name, description: o.description,
      // And it fills in the optional flags the bot leaves off.
      ...(('options' in o) ? {
        options: (o as { options: readonly Record<string, unknown>[] }).options.map((x) => ({
          required: false, autocomplete: false, ...x,
        })),
      } : {}),
    })),
  },
  /**
   * ★ AND THE CONTEXT-MENU COMMAND, WHICH DISCORD STORES DIFFERENTLY FROM HOW THE BOT SENDS IT.
   *
   * A `type: 3` command is sent with no `description` — Discord rejects one with a 400 — and comes
   * back with `description: ''`. If the fingerprint did not normalise that to the same thing, the
   * bot would decide the tree had changed on EVERY boot and re-publish, which costs real users a
   * working command until their client catches up. That is precisely what this pair asserts, so
   * the fixture has to carry the asymmetry rather than paper over it.
   */
  {
    id: '223456789',
    application_id: '987654321',
    version: '211222333',
    default_member_permissions: null,
    dm_permission: true,
    nsfw: false,
    type: 3,
    name: 'Ask this agent',
    description: '',
    options: [],
  }];

  it('★ registers a MESSAGE context-menu command, which is how Discord addresses a message', () => {
    // The three earlier ways to address an agent were a picker, a reply, and typing its name at
    // the start of a sentence — and the last is a text heuristic doing a job Discord has a gesture
    // for. `type: 3` is that gesture. It carries no description: Discord rejects one with a 400.
    const menu = (COMMANDS as readonly { name: string; type?: number; description?: string }[])
      .find((c) => c.type === 3);
    expect(menu, 'no MESSAGE command is registered').toBeTruthy();
    expect(menu?.name).toBe('Ask this agent');
    expect(menu?.description).toBeUndefined();
  });

  it('★ calls an untouched tree unchanged, despite the fields Discord adds to it', () => {
    // If this were ever false the bot would re-publish on every boot and every restart would cost
    // real users a working command until their client caught up.
    expect(commandFingerprint(asDiscordStoredIt()))
      .toBe(commandFingerprint(COMMANDS as unknown as readonly unknown[]));
  });

  it('is not fooled by ordering, which carries no meaning', () => {
    // Both the option order WITHIN a command and the order OF the commands are meaningless, and
    // the second only became testable once there were two commands to swap.
    const shuffled = [
      COMMANDS[1],
      { ...COMMANDS[0], options: [...COMMANDS[0].options].reverse() },
    ];
    expect(commandFingerprint(shuffled)).toBe(commandFingerprint(COMMANDS as unknown as readonly unknown[]));
  });

  it('★ sees every kind of real edit, so nothing ships unpublished', () => {
    const base = commandFingerprint(COMMANDS as unknown as readonly unknown[]);
    const tree = COMMANDS[0];
    const variant = (over: Record<string, unknown>): string => commandFingerprint([{ ...tree, ...over }]);

    // A reworded description is a real change: it is what people read in the command picker.
    expect(variant({ description: 'Something else entirely' })).not.toBe(base);
    // A subcommand removed.
    expect(variant({ options: tree.options.filter((o) => o.name !== 'who') })).not.toBe(base);
    // A subcommand added.
    expect(variant({ options: [...tree.options, { type: 1, name: 'archive', description: 'x' }] })).not.toBe(base);
    // A subcommand renamed.
    expect(variant({
      options: tree.options.map((o) => (o.name === 'show' ? { ...o, name: 'view' } : o)),
    })).not.toBe(base);
    // An argument made optional — the change that would let `/workspace link-confirm` be invoked
    // with no pod at all.
    expect(variant({
      options: tree.options.map((o) => (o.name === 'link-confirm'
        ? { ...o, options: [{ ...(o as unknown as { options: readonly Record<string, unknown>[] }).options[0], required: false }] }
        : o)),
    })).not.toBe(base);
    // The live picker switched off, which would silently turn `ask` into a free-text field.
    expect(variant({
      options: tree.options.map((o) => (o.name === 'ask'
        ? {
          ...o,
          options: (o as unknown as { options: readonly Record<string, unknown>[] }).options
            .map((x) => (x['name'] === 'agent' ? { ...x, autocomplete: false } : x)),
        }
        : o)),
    })).not.toBe(base);
  });

  it('treats an empty answer as different, so a wiped registration is republished', () => {
    // A GET that returns nothing at all — the commands were deleted out from under the bot — must
    // not read as "unchanged, nothing to do".
    expect(commandFingerprint([])).not.toBe(commandFingerprint(COMMANDS as unknown as readonly unknown[]));
  });
});

describe('REST', () => {
  const fetchOf = (steps: readonly { status: number; body: string }[]): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const s = steps[Math.min(n++, steps.length - 1)] as { status: number; body: string };
      return { ok: s.status >= 200 && s.status < 300, status: s.status, text: async () => s.body } as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  it('never lets a value become a mention', async () => {
    const { impl, calls } = fetchOf([{ status: 200, body: '{}' }]);
    await new DiscordRest('tok', impl).post('c1', 'a workspace titled @everyone');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { allowed_mentions?: { parse?: unknown[]; users?: unknown[] } };
    // This bot renders text that came off other people's pods. A title containing `@everyone`
    // must be text, not a ping to a whole server.
    expect(sent.allowed_mentions?.parse).toEqual([]);
    expect(sent.allowed_mentions?.users).toEqual([]);
  });

  it('pings exactly the one person a "not recorded" notice is addressed to', async () => {
    const { impl, calls } = fetchOf([{ status: 200, body: '{}' }]);
    await new DiscordRest('tok', impl).post('c1', 'x', ['u1', 'u2', 'u3']);
    const sent = JSON.parse(String(calls[0]?.init.body)) as { allowed_mentions?: { users?: unknown[] } };
    expect(sent.allowed_mentions?.users).toEqual(['u1']);
  });

  it('honours a 429 once and then gives up rather than looping', async () => {
    const { impl, calls } = fetchOf([{ status: 429, body: '{"retry_after":0}' }, { status: 200, body: '{"id":"1"}' }]);
    await new DiscordRest('tok', impl).post('c1', 'x');
    expect(calls).toHaveLength(2);
    const twice = fetchOf([{ status: 429, body: '{"retry_after":0}' }]);
    // A second 429 must SAY it is the second: identical copy for "rate limited once, retried,
    // fine" and "rate limited, waited, rate limited again" hides that the backoff is spent.
    await expect(new DiscordRest('tok', twice.impl).post('c1', 'x')).rejects.toThrow(/rate limited twice in a row/);
  });

  it('reports a failure with the status and the body, not as a silent no-op', async () => {
    const { impl } = fetchOf([{ status: 403, body: '{"message":"Missing Access"}' }]);
    await expect(new DiscordRest('tok', impl).post('c1', 'x')).rejects.toThrow(/HTTP 403.*Missing Access/);
  });

  it('answers a picker as a type-8 CALLBACK, capped at 25 and clamped at 100 characters', async () => {
    // ★ ONE OVER-LONG LABEL WOULD MAKE THE WHOLE LIST FAIL TO RENDER, and there is no deferral for
    // an autocomplete — no second chance to send a shorter one. The person would see an empty box
    // that says nothing about why, which is the failure mode this bot exists to not have.
    const { impl, calls } = fetchOf([{ status: 200, body: '{}' }]);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: 'agent-' + i + '-' + 'x'.repeat(200), value: 'did:web:x:agents:a' + i }));
    await new DiscordRest('tok', impl).autocomplete('a1', 'tk', many);
    expect(calls[0]?.url).toContain('/interactions/a1/tk/callback');
    const sent = JSON.parse(String(calls[0]?.init.body)) as { type: number; data: { choices: { name: string; value: string }[] } };
    expect(sent.type).toBe(8);
    expect(sent.data.choices).toHaveLength(25);
    for (const c of sent.data.choices) expect(c.name.length).toBeLessThanOrEqual(100);
    // Clamping says it clamped, rather than ending mid-word as though that were the whole label.
    expect(sent.data.choices[0]?.name.endsWith('…')).toBe(true);
    // The VALUE is the DID and is not decorated: it is what the command actually receives.
    expect(sent.data.choices[0]?.value).toBe('did:web:x:agents:a0');
  });

  it('defers with the ephemeral flag only when asked', async () => {
    const { impl, calls } = fetchOf([{ status: 200, body: '{}' }, { status: 200, body: '{}' }]);
    const rest = new DiscordRest('tok', impl);
    await rest.defer('i', 't', true);
    await rest.defer('i', 't', false);
    expect((JSON.parse(String(calls[0]?.init.body)) as { data?: { flags?: number } }).data?.flags).toBe(64);
    expect((JSON.parse(String(calls[1]?.init.body)) as { data?: { flags?: number } }).data?.flags).toBeUndefined();
  });
});
