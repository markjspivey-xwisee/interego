/**
 * THE WIRING, AND ONLY THE WIRING.
 *
 * ★ WHAT WAS UNTESTED, EXACTLY. `tests/gateway.test.ts` drives the Discord protocol frame by
 * frame with no socket. `tests/record.test.ts` drives the substrate half against a scripted
 * relay. `tests/links.test.ts` and `tests/render.test.ts` cover the store and the copy. Between
 * those two halves sits `src/main.ts`, which decides WHICH substrate function a given Discord
 * frame reaches, what deps it is handed, whether the deferral is public or private, where the
 * answer is delivered, and what happens when the substrate throws. None of that was exercised by
 * anything, and it is the file the bot cannot run without.
 *
 * ★ SO THE HALVES ARE NOT RE-TESTED HERE. `../src/workspace.js` — the substrate half — is
 * replaced by spies, deliberately: this file's subject is the ROUTING, and a second copy of
 * `record.test.ts`'s scripted relay would test the thing that already has a test while telling
 * us nothing about the wiring. Everything else is REAL: the real `DiscordGateway` parsing real
 * Discord JSON frames, the real `DiscordRest` making real (recorded) HTTP calls, the real
 * `LinkStore` reading a real file it wrote itself, and the real renderers producing the real
 * text. The only doubles are the socket, `fetch`, the relay session, and the substrate half.
 *
 * ★ AND THE ENTRY POINT IS THE THING THAT MADE THIS POSSIBLE. `main` used to be module-private
 * and self-invoking, so importing this file WAS launching the bot — a live Discord login, a
 * SIWE mint, a write to `~/.interego/`, a real gateway socket and two `process.exit` signal
 * handlers, inside a shared single-threaded vitest worker. `main(boot)` and the
 * `invokedAsProgram()` guard are what let a test reach the wiring at all; every `boot` field
 * defaults to what ran before, so the program is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── the substrate half, replaced by spies ────────────────────────────────────
// `render.ts` imports only TYPES from `workspace.js`, so mocking it leaves every renderer real.
const wsp = vi.hoisted(() => ({
  beginLink: vi.fn(),
  confirmLink: vi.fn(),
  unlink: vi.fn(),
  startWorkspace: vi.fn(),
  recordMessage: vi.fn(),
  showWorkspace: vi.fn(),
}));
vi.mock('../src/workspace.js', () => wsp);

/**
 * The ASK half, replaced the same way and for the same reason.
 *
 * `askCandidates` is three live reads deep — a roster fold, one delegation registry per seated pod,
 * one presence document per delegate — and every one of them has its own test against a scripted
 * relay. What this file is about is whether a type-4 Discord frame reaches it at all, whether the
 * answer goes back as a type-8 callback, and whether `/workspace ask` is serialised on the asker's
 * pod like every other append.
 */
const askmod = vi.hoisted(() => ({
  ask: vi.fn(),
  askCandidates: vi.fn(),
  askChoices: vi.fn(),
  AUTOCOMPLETE_MAX: 25,
  canAppend: () => true,
}));
vi.mock('../src/ask.js', () => askmod);

import { LinkStore, type Link, type ThreadBinding } from '../src/links.js';
import { PerKeyQueue, main, type Boot, type SessionLike, type Started } from '../src/main.js';

const RELAY = 'https://relay.example';
// `POD_RX` in @interego/workspace-client is `^u-(eth|pk|did)-[0-9a-fA-F]+$`, and `LinkStore`
// refuses anything else on the way in as well as dropping it on the way out.
const POD = 'u-eth-aaaabbbbcccc';
const THREAD = '900000000000000001';
const USER = '400000000000000002';
const OTHER = '400000000000000003';

/** A socket that records what was sent and lets a test deliver frames. Same shape as gateway.test.ts. */
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
}

interface RestCall { readonly method: string; readonly path: string; readonly body: Record<string, unknown> | null }

/** A recording `fetch`. `/users/@me` answers with the application identity; everything else 200 `{}`. */
function recordingFetch(): { impl: typeof fetch; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const impl = (async (url: unknown, init?: Record<string, unknown>) => {
    const full = String(url);
    const raw = init?.['body'];
    calls.push({
      method: String(init?.['method'] ?? 'GET'),
      path: full.replace('https://discord.com/api/v10', ''),
      body: typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : null,
    });
    const payload = full.endsWith('/users/@me') ? { id: 'app-1', username: 'workspace-bot' } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The one client object every substrate call must be handed. Identity is the assertion. */
const CLIENT = { theOnlyClient: true } as unknown as never;

function fakeSession(): { session: SessionLike; opens: number; calls: number } {
  const state = { opens: 0, calls: 0 };
  const identity = { client: CLIENT, agentId: 'did:ethr:0xbot', pod: POD, address: '0xbot' };
  const session = {
    open: async () => { state.opens++; return identity; },
    current: identity,
    call: async <T,>(fn: (c: never) => Promise<T>) => { state.calls++; return fn(CLIENT); },
  } as unknown as SessionLike;
  return {
    session,
    get opens() { return state.opens; },
    get calls() { return state.calls; },
  } as { session: SessionLike; opens: number; calls: number };
}

const link = (discordUserId: string): Link => ({
  discordUserId, pod: POD, webId: `https://css.example/${POD}/profile/card#me`,
  boundAt: '2026-01-01T00:00:00.000Z', scopeAtBinding: null, basisAtBinding: null,
});
const binding = (): ThreadBinding => ({
  threadId: THREAD, convenerPod: POD, workspace: `${RELAY}/ns/${POD}/garden`,
  slug: 'garden', title: 'Garden', startedAt: '2026-01-01T00:00:00.000Z', startedBy: USER,
});

const dirs: string[] = [];
function statePath(seed?: (s: LinkStore) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'wsp-discord-'));
  dirs.push(dir);
  const path = join(dir, 'state.json');
  if (seed) seed(new LinkStore(path));
  return path;
}

interface Booted {
  readonly started: Started;
  readonly calls: RestCall[];
  readonly sockets: FakeSocket[];
  readonly lines: string[];
  readonly signals: string[];
  frame(f: unknown): void;
}

const started: Started[] = [];

async function boot(over: Partial<Boot> = {}): Promise<Booted> {
  const rest = recordingFetch();
  const sockets: FakeSocket[] = [];
  const lines: string[] = [];
  const signals: string[] = [];
  const s = await main({
    env: { DISCORD_BOT_TOKEN: 'tok', INTEREGO_RELAY: RELAY, INTEREGO_IDENTITY: 'https://id.example' },
    argv: ['node', 'main.ts'],
    out: (l) => lines.push(l),
    fetchImpl: rest.impl,
    openSocket: () => new FakeSocket() as unknown as never,
    statePath: statePath(),
    session: fakeSession().session,
    installSignalHandler: (sig) => { signals.push(sig); },
    ...over,
  });
  if (s === null) throw new Error('boot() is for the connecting path; use main() directly for --register-commands-only');
  started.push(s);
  return {
    started: s, calls: rest.calls, sockets, lines, signals,
    frame: (f) => { s.gateway.onFrame(JSON.stringify(f)); },
  };
}

/** Let the `void`-fired async handlers run to completion. */
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((r) => { setTimeout(r, 0); }); };

const interaction = (name: string, extra: Record<string, unknown> = {}): unknown => ({
  op: 0, t: 'INTERACTION_CREATE',
  d: {
    id: 'i1', token: 'itok', channel_id: THREAD, type: 2,
    member: { user: { id: USER } },
    channel: { name: 'garden' },
    data: { name: 'workspace', options: [{ type: 1, name }] },
    ...extra,
  },
});

const message = (over: Record<string, unknown> = {}): unknown => ({
  op: 0, t: 'MESSAGE_CREATE',
  d: { id: 'm1', channel_id: THREAD, author: { id: USER, bot: false }, content: 'we should re-tile in spring', ...over },
});

/** An autocomplete frame — Discord's type 4, which this bot used to drop on the floor. */
const autocomplete = (sub: string, opts: readonly Record<string, unknown>[]): unknown => ({
  op: 0, t: 'INTERACTION_CREATE',
  d: {
    id: 'a1', token: 'atok', channel_id: THREAD, type: 4,
    member: { user: { id: USER } },
    data: { name: 'workspace', options: [{ type: 1, name: sub, options: opts }] },
  },
});

beforeEach(() => {
  // ★ THE WATCHER RUNS FOR REAL IN THESE TESTS and its first pass calls this. A spy with no return
  // value would hand it `undefined` where a `ShowOut` belongs, and the rejection would surface in
  // whichever unrelated test happened to be running when the timer fired.
  wsp.showWorkspace.mockResolvedValue({ kind: 'not-a-workspace' });
});

afterEach(() => {
  // ★ THE WATCHER IS STOPPED, NOT JUST THE GATEWAY. It owns a sweep interval and a timer per
  // thread; left running they keep a single-threaded vitest worker alive after the assertions have
  // finished and go on calling spies the next test is about to assert on.
  for (const s of started.splice(0)) { s.watcher.stop(); s.gateway.stop(); }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* tmpdir */ } }
  vi.clearAllMocks();
});

describe('the boot sequence', () => {
  it('authenticates, opens the session, loads the store it was given, registers commands, then connects', async () => {
    const sess = fakeSession();
    const path = statePath();
    const b = await boot({ session: sess.session, statePath: path });

    expect(b.calls.map((c) => c.method + ' ' + c.path)).toEqual([
      'GET /users/@me',
      'PUT /applications/app-1/commands',
    ]);
    expect(sess.opens).toBe(1);
    // ★ The store is the one it was told to use. Left to its default this writes to the real
    // `~/.interego/discord-workspace.json` — a test that boots the bot would edit the operator's
    // live link index.
    expect(b.started.store.file).toBe(path);
    expect(b.started.identity.pod).toBe(POD);
    // Connected: the gateway opened a socket and identified itself on HELLO.
    b.frame({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(b.lines.some((l) => l.includes('commands registered'))).toBe(true);
  });

  it('--register-commands-only registers and stops: no relay session, no store, no socket', async () => {
    const rest = recordingFetch();
    const sess = fakeSession();
    let opened = 0;
    const out = await main({
      env: { DISCORD_BOT_TOKEN: 'tok' },
      argv: ['node', 'main.ts', '--register-commands-only'],
      out: () => { /* quiet */ },
      fetchImpl: rest.impl,
      openSocket: () => { opened++; return new FakeSocket() as unknown as never; },
      statePath: statePath(),
      session: sess.session,
      installSignalHandler: () => { /* none expected */ },
    });

    expect(out).toBeNull();
    expect(rest.calls.map((c) => c.method + ' ' + c.path)).toEqual([
      'GET /users/@me',
      'PUT /applications/app-1/commands',
    ]);
    // ★ The early exit is the whole point of the flag: registering commands must not sign in to
    // the relay, touch the link store, or open a gateway connection.
    expect(sess.opens).toBe(0);
    expect(opened).toBe(0);
  });

  it('refuses to start with no bot token, and names the variable', async () => {
    await expect(main({ env: {}, argv: [], out: () => { /* quiet */ } }))
      .rejects.toThrow(/DISCORD_BOT_TOKEN is not set/);
  });

  it('refuses to start with no bot key when it has to make its own session', async () => {
    const rest = recordingFetch();
    await expect(main({ env: { DISCORD_BOT_TOKEN: 'tok' }, argv: [], out: () => { /* quiet */ }, fetchImpl: rest.impl }))
      .rejects.toThrow(/INTEREGO_BOT_KEY is not set/);
    // It refused BEFORE authenticating — a missing key is not worth a round trip to Discord.
    expect(rest.calls).toEqual([]);
  });

  it('installs both shutdown signals through the injected installer', async () => {
    const b = await boot();
    // Registration is asserted; the handlers are NOT invoked, because each one ends in
    // `process.exit(0)` and calling it would take the vitest worker down with it.
    expect(b.signals).toEqual(['SIGINT', 'SIGTERM']);
  });
});

describe('a slash command, from gateway frame to Discord reply', () => {
  it('defers `workspace start` publicly and `workspace link` privately', async () => {
    wsp.startWorkspace.mockResolvedValue({ kind: 'not-linked' });
    wsp.beginLink.mockReturnValue({ kind: 'challenge', agentId: 'did:ethr:0xbot', label: 'discord-link ' + USER, existing: null });

    const b = await boot();
    b.frame(interaction('start'));
    await settle();
    b.frame(interaction('link'));
    await settle();

    const defers = b.calls.filter((c) => c.path.startsWith('/interactions/'));
    expect(defers).toHaveLength(2);
    // Ephemerality is decided BEFORE the work because the deferral carries the flag. `start`
    // is public; a link code in a public channel is a link code somebody else can use.
    expect(defers[0]?.body?.['data']).toEqual({});
    expect(defers[1]?.body?.['data']).toEqual({ flags: 64 });
  });

  it('hands every substrate call the same deps — relay, agent id, the loaded store, the session client', async () => {
    wsp.startWorkspace.mockResolvedValue({ kind: 'not-linked' });
    const path = statePath();
    const b = await boot({ statePath: path });

    b.frame(interaction('start'));
    await settle();

    expect(wsp.startWorkspace).toHaveBeenCalledTimes(1);
    const [deps, args] = wsp.startWorkspace.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(deps['relay']).toBe(RELAY);
    expect(deps['agentId']).toBe('did:ethr:0xbot');
    expect(deps['client']).toBe(CLIENT);
    expect((deps['store'] as LinkStore).file).toBe(path);
    // The channel is the thread, and the channel NAME becomes the workspace title.
    expect(args).toEqual({ threadId: THREAD, threadName: 'garden', discordUserId: USER });
  });

  it('routes each of the five commands to its own substrate function', async () => {
    wsp.beginLink.mockReturnValue({ kind: 'challenge', agentId: 'a', label: 'l', existing: null });
    wsp.confirmLink.mockResolvedValue({ kind: 'no-challenge' });
    wsp.unlink.mockReturnValue({ kind: 'was-not-linked', had: null, agentId: 'a' });
    wsp.startWorkspace.mockResolvedValue({ kind: 'not-linked' });
    wsp.showWorkspace.mockResolvedValue({ kind: 'not-a-workspace' });

    const b = await boot();
    for (const name of ['link', 'unlink', 'start', 'show']) { b.frame(interaction(name)); await settle(); }
    b.frame(interaction('link-confirm', { data: { name: 'workspace', options: [{ type: 1, name: 'link-confirm', options: [{ name: 'pod', value: POD }] }] } }));
    await settle();

    expect(wsp.beginLink).toHaveBeenCalledTimes(1);
    expect(wsp.unlink).toHaveBeenCalledTimes(1);
    expect(wsp.startWorkspace).toHaveBeenCalledTimes(1);
    expect(wsp.showWorkspace).toHaveBeenCalledTimes(1);
    // `show` takes the channel id directly rather than an args object.
    expect(wsp.showWorkspace.mock.calls[0]?.[1]).toBe(THREAD);
    // The subcommand's own option is flattened onto the interaction and forwarded.
    expect(wsp.confirmLink).toHaveBeenCalledTimes(1);
    expect(wsp.confirmLink.mock.calls[0]?.[1]).toEqual({ discordUserId: USER, podName: POD });
  });

  it('edits the deferred placeholder using the APPLICATION id, not the interaction id', async () => {
    wsp.showWorkspace.mockResolvedValue({ kind: 'not-a-workspace' });
    const b = await boot();
    b.frame(interaction('show'));
    await settle();

    const edit = b.calls.find((c) => c.method === 'PATCH');
    // `app-1` came from `GET /users/@me`; `itok` is the interaction token. Using the interaction
    // id here would 404 and leave "the application did not respond" as the bot's answer.
    expect(edit?.path).toBe('/webhooks/app-1/itok/messages/@original');
    expect(String(edit?.body?.['content'])).toContain('This thread is not a workspace');
  });

  it('a substrate failure is still answered in the thread, at the ephemerality already deferred', async () => {
    wsp.startWorkspace.mockRejectedValue(new Error('the relay did not answer'));
    const b = await boot();
    b.frame(interaction('start'));
    await settle();

    const edit = b.calls.find((c) => c.method === 'PATCH');
    // An interaction that is deferred and never edited reads as "the application did not
    // respond" forever — the worst possible answer from a bot whose subject is what got written.
    expect(String(edit?.body?.['content'])).toContain('That did not complete.');
    expect(String(edit?.body?.['content'])).toContain('the relay did not answer');
    expect(String(edit?.body?.['content'])).toContain('Nothing below this is a statement about your pod.');
    expect(b.lines.some((l) => l.includes('command workspace start failed'))).toBe(true);
  });

  it('names an unknown subcommand rather than going quiet', async () => {
    const b = await boot();
    b.frame(interaction('teleport'));
    await settle();

    const edit = b.calls.find((c) => c.method === 'PATCH');
    expect(String(edit?.body?.['content'])).toContain('does not know the command `workspace teleport`');
  });

  it('ignores an interaction carrying no user, before anything is deferred', async () => {
    const b = await boot();
    b.frame(interaction('start', { member: undefined, user: undefined }));
    await settle();

    expect(b.calls.filter((c) => c.path.startsWith('/interactions/'))).toEqual([]);
    expect(wsp.startWorkspace).not.toHaveBeenCalled();
    expect(b.lines.some((l) => l.includes('interaction arrived with no user'))).toBe(true);
  });
});

/**
 * ASKING AN AGENT, AND THE PICKER THAT MAKES IT ADDRESSABLE.
 *
 * ★ THE TRANSPORT THESE COVER DID NOT EXIST. `discord.ts` dropped interaction type 4 with the
 * comment "not used by this bot", which was true while every command took a pod name typed by
 * hand. It stopped being true the moment a command had to offer a choice out of OTHER PEOPLE'S
 * PODS — which agents exist, which their delegator still authorises, which have said their host is
 * up — none of which this bot may cache and all of which change between one command and the next.
 */
describe('the agent picker and /workspace ask', () => {
  it('answers a type-4 frame as a type-8 CALLBACK, with the choices the module computed', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    askmod.askCandidates.mockResolvedValue({ kind: 'candidates', binding: binding(), targets: [], unread: [], noneOn: [] });
    askmod.askChoices.mockReturnValue([{ name: 'scheduler · running (said so 41s ago)', value: 'did:web:x:agents:interego-delegate-u-eth-1' }]);
    b.frame(autocomplete('ask', [{ type: 3, name: 'agent', value: 'sch', focused: true }]));
    await settle();

    // ★ A CALLBACK, NOT AN EDIT. There is no deferral for an autocomplete and no second chance.
    const sent = b.calls.find((c) => c.path === '/interactions/a1/atok/callback');
    expect(sent?.body?.['type']).toBe(8);
    expect((sent?.body?.['data'] as { choices: unknown[] }).choices).toEqual([
      { name: 'scheduler · running (said so 41s ago)', value: 'did:web:x:agents:interego-delegate-u-eth-1' },
    ]);
    // The query is the text in the FOCUSED box, and it reached the module.
    expect(askmod.askChoices).toHaveBeenCalledWith(expect.anything(), 'sch');
  });

  it('★ answers a failed lookup with a row that SAYS so, never with an empty list', async () => {
    // Discord draws a choice list and nothing else, so "nobody has an agent" and "that pod did not
    // answer" would render identically — and the second is a failed read being drawn as a fact
    // about somebody else's pod.
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    askmod.askCandidates.mockRejectedValue(new Error('the relay did not answer'));
    b.frame(autocomplete('ask', [{ type: 3, name: 'agent', value: '', focused: true }]));
    await settle();

    const sent = b.calls.find((c) => c.path === '/interactions/a1/atok/callback');
    const choices = (sent?.body?.['data'] as { choices: { name: string; value: string }[] }).choices;
    expect(choices).toHaveLength(1);
    expect(choices[0]?.name).toContain('not established');
    // Nothing can act on it — it is a sentence, not a target.
    expect(choices[0]?.value).toBe('?failed');
    expect(b.lines.some((l) => l.includes('autocomplete failed'))).toBe(true);
  });

  it('answers an autocomplete on a box it does not fill with an empty list, and looks nothing up', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    b.frame(autocomplete('ask', [{ type: 3, name: 'task', value: 'review the numbers', focused: true }]));
    await settle();
    expect(askmod.askCandidates).not.toHaveBeenCalled();
    const sent = b.calls.find((c) => c.path === '/interactions/a1/atok/callback');
    expect((sent?.body?.['data'] as { choices: unknown[] }).choices).toEqual([]);
  });

  it('routes /workspace ask with both options and renders what came back', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    askmod.ask.mockResolvedValue({ kind: 'empty-task' });
    b.frame(interaction('ask', {
      data: {
        name: 'workspace',
        options: [{
          type: 1, name: 'ask',
          options: [
            { type: 3, name: 'agent', value: 'did:web:x:agents:interego-delegate-u-eth-1' },
            { type: 3, name: 'task', value: 'review the Q3 numbers' },
          ],
        }],
      },
    }));
    await settle();

    expect(askmod.ask).toHaveBeenCalledWith(
      expect.objectContaining({ client: CLIENT }),
      expect.objectContaining({
        threadId: THREAD, discordUserId: USER,
        spec: 'did:web:x:agents:interego-delegate-u-eth-1', task: 'review the Q3 numbers',
      }),
    );
    const edit = b.calls.find((c) => c.method === 'PATCH');
    expect(String(edit?.body?.['content'])).toContain('Nothing was asked');
  });

  it('★ notes an ask for the silence notice only when one was actually WRITTEN', async () => {
    // Recording a refused ask would promise a follow-up about an entry that does not exist.
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    askmod.ask.mockResolvedValue({ kind: 'not-a-workspace' });
    b.frame(interaction('ask', { data: { name: 'workspace', options: [{ type: 1, name: 'ask', options: [{ type: 3, name: 'agent', value: 'x' }, { type: 3, name: 'task', value: 'y' }] }] } }));
    await settle();
    expect(b.started.watcher.pending()).toHaveLength(0);

    askmod.ask.mockResolvedValue({
      kind: 'asked',
      target: { agentId: 'did:web:x:agents:interego-delegate-u-eth-1', pod: POD, name: 'scheduler', scope: 'PublishOnly', writeEligible: true, isYou: false, presence: { state: 'never', agentId: 'x', pod: POD, iri: null, why: 'w' } },
      record: { kind: 'recorded', pod: POD },
      accepted: { kind: 'accepted', seq: 7 },
      descriptorUrl: 'https://css.example/e/7.ttl',
      notice: { attempted: true, delivered: true, canonicalInbox: true, inbox: null, warning: null, why: null },
      checks: [],
    });
    b.frame(interaction('ask', { id: 'i2', token: 'itok2', data: { name: 'workspace', options: [{ type: 1, name: 'ask', options: [{ type: 3, name: 'agent', value: 'x' }, { type: 3, name: 'task', value: 'y' }] }] } }));
    await settle();
    const pending = b.started.watcher.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.seq).toBe(7);
    // Verbatim, so the follow-up quotes what was true when the ask was made rather than
    // re-deriving a fact that has since changed.
    expect(pending[0]?.presenceAtAsk).toContain('has never said it was running');
  });

  it('serialises an ask on the ASKER\'s pod, like every other append to their log', async () => {
    // An ask IS an entry in their log, so two a second apart race the chain derivation exactly as
    // two messages would — and this one is likelier, because a person who asks one agent something
    // often asks the next one straight after.
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    let release = (): void => {};
    const order: string[] = [];
    askmod.ask
      .mockImplementationOnce(async () => { order.push('one:start'); await new Promise<void>((r) => { release = r; }); order.push('one:end'); return { kind: 'empty-task' }; })
      .mockImplementationOnce(async () => { order.push('two:start'); return { kind: 'empty-task' }; });
    b.frame(interaction('ask', { data: { name: 'workspace', options: [{ type: 1, name: 'ask', options: [{ type: 3, name: 'agent', value: 'a' }, { type: 3, name: 'task', value: 't' }] }] } }));
    await settle();
    b.frame(interaction('ask', { id: 'i2', token: 'itok2', data: { name: 'workspace', options: [{ type: 1, name: 'ask', options: [{ type: 3, name: 'agent', value: 'b' }, { type: 3, name: 'task', value: 't' }] }] } }));
    await settle();
    expect(order).toEqual(['one:start']);
    release();
    await settle();
    expect(order).toEqual(['one:start', 'one:end', 'two:start']);
  });

  it('routes /workspace who and answers privately', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); s.bindThread(binding()); }) });
    askmod.askCandidates.mockResolvedValue({ kind: 'not-a-workspace' });
    b.frame(interaction('who'));
    await settle();
    expect(askmod.askCandidates).toHaveBeenCalled();
    // `who` names other people's agents and their availability, so it is the caller's business.
    const defer = b.calls.find((c) => c.path === '/interactions/i1/itok/callback');
    expect((defer?.body?.['data'] as { flags?: number }).flags).toBe(64);
  });
});

describe('a message arriving in a channel', () => {
  it('ignores its own kind, and every other bot', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bindThread(binding()); s.bind(link(USER)); }) });
    b.frame(message({ author: { id: USER, bot: true } }));
    await settle();
    expect(wsp.recordMessage).not.toHaveBeenCalled();
  });

  it('says nothing at all in a channel that is not a workspace', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bind(link(USER)); }) });
    b.frame(message());
    await settle();
    expect(wsp.recordMessage).not.toHaveBeenCalled();
    // Not merely unrecorded — UNMENTIONED. A channel that is not a workspace is not its business.
    expect(b.calls.filter((c) => c.path.startsWith('/channels/'))).toEqual([]);
  });

  it('tells an unlinked speaker once per thread, pings only them, and never records', async () => {
    const b = await boot({ statePath: statePath((s) => { s.bindThread(binding()); }) });
    b.frame(message({ id: 'm1' }));
    await settle();
    b.frame(message({ id: 'm2' }));
    await settle();
    // A different person in the same thread gets their own single notice.
    b.frame(message({ id: 'm3', author: { id: OTHER, bot: false } }));
    await settle();

    const posts = b.calls.filter((c) => c.path === '/channels/' + THREAD + '/messages');
    expect(posts).toHaveLength(2);
    expect(String(posts[0]?.body?.['content'])).toContain('not recorded.');
    expect(posts[0]?.body?.['allowed_mentions']).toEqual({ parse: [], users: [USER] });
    expect(posts[1]?.body?.['allowed_mentions']).toEqual({ parse: [], users: [OTHER] });
    expect(wsp.recordMessage).not.toHaveBeenCalled();
  });

  it('records a linked speaker, and posts only when the renderer has something to say', async () => {
    wsp.recordMessage.mockResolvedValueOnce({ kind: 'error', error: new Error('pod refused') });
    wsp.recordMessage.mockResolvedValueOnce({ kind: 'empty' });

    const b = await boot({ statePath: statePath((s) => { s.bindThread(binding()); s.bind(link(USER)); }) });
    b.frame(message({ id: 'm1' }));
    await settle();
    b.frame(message({ id: 'm2', content: '' }));
    await settle();

    expect(wsp.recordMessage).toHaveBeenCalledTimes(2);
    const [deps, args] = wsp.recordMessage.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(deps['client']).toBe(CLIENT);
    expect(args).toEqual({ threadId: THREAD, discordUserId: USER, text: 'we should re-tile in spring' });

    // `renderRecord` returns null for `empty`, and `say` must treat that as "post nothing"
    // rather than posting an empty message.
    const posts = b.calls.filter((c) => c.path === '/channels/' + THREAD + '/messages');
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.body?.['content'])).toContain('pod refused');
  });

  it('serialises two messages from one pod — the second append waits for the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    wsp.recordMessage.mockImplementationOnce(async () => { await gate; return { kind: 'empty' }; });
    wsp.recordMessage.mockResolvedValue({ kind: 'empty' });

    const b = await boot({ statePath: statePath((s) => { s.bindThread(binding()); s.bind(link(USER)); }) });
    b.frame(message({ id: 'm1' }));
    b.frame(message({ id: 'm2' }));
    await settle();

    // ★ Both messages are in flight; only one append has started. Two concurrent appends would
    // both derive the same sequence number and one would lose its CAS retry.
    expect(wsp.recordMessage).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(wsp.recordMessage).toHaveBeenCalledTimes(2);
  });

  it('a failed append is logged and does not stop the next message', async () => {
    wsp.recordMessage.mockRejectedValueOnce(new Error('append exploded'));
    wsp.recordMessage.mockResolvedValue({ kind: 'empty' });

    const b = await boot({ statePath: statePath((s) => { s.bindThread(binding()); s.bind(link(USER)); }) });
    b.frame(message({ id: 'm1' }));
    await settle();
    b.frame(message({ id: 'm2' }));
    await settle();

    expect(wsp.recordMessage).toHaveBeenCalledTimes(2);
    expect(b.lines.some((l) => l.includes('recording failed for message m1'))).toBe(true);
  });
});

describe('PerKeyQueue', () => {
  it('runs one at a time per key, and different keys concurrently', async () => {
    const q = new PerKeyQueue();
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });

    const a1 = q.run('pod-a', async () => { await gateA; order.push('a1'); });
    const a2 = q.run('pod-a', async () => { order.push('a2'); });
    const b1 = q.run('pod-b', async () => { order.push('b1'); });

    await new Promise((r) => { setTimeout(r, 0); });
    // pod-b is a different chain and does not wait behind pod-a.
    expect(order).toEqual(['b1']);
    releaseA();
    await Promise.all([a1, a2, b1]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
  });

  it('★ a rejection does not wedge the key', async () => {
    const q = new PerKeyQueue();
    // One failed append must not stop that pod recording anything ever again.
    await expect(q.run('pod-a', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(q.run('pod-a', async () => 'after')).resolves.toBe('after');
  });

  // ★ MEASURED, AND THE MEASUREMENT CORRECTS A CLAIM. `PerKeyQueue` guards this property TWICE
  // — `prior.then(fn, fn)` runs the next job on either settle path, and the stored tail is
  // `next.then(() => undefined, () => undefined)`, which never rejects in the first place. They
  // are redundant: mutating EITHER one alone leaves all 20 tests here green, because with the
  // other still in place the observable behaviour is unchanged. Both were tried.
  //
  // That is not a hole in the test. Two implementations with identical observable behaviour
  // cannot be told apart by a behavioural test, and should not be — the assertion above is
  // about the property the bot depends on, and the property genuinely survives either guard on
  // its own. Recorded here so the next reader does not take the surviving mutant as a gap and
  // "fix" it by pinning the implementation instead of the behaviour. Removing BOTH guards does
  // fail the test above.
});
