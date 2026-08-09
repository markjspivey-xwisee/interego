/**
 * THE DISCORD HALF, AND IT IS THE ONLY PART OF THIS PACKAGE THAT KNOWS DISCORD EXISTS.
 *
 * ★ WHY `ws` AND NOT `discord.js`. Two reasons, and neither is that the library is bad.
 *   · The surface actually needed is closed and small: two gateway opcodes out (IDENTIFY,
 *     HEARTBEAT / RESUME), three in (HELLO, DISPATCH, RECONNECT / INVALID_SESSION), and four
 *     REST calls. That is a protocol client anybody can read in one sitting and a test can drive
 *     frame by frame; `discord.js` would be an opaque dependency that no test in this repo could
 *     exercise, because there is no Discord to exercise it against in CI.
 *   · `ws` is already a dependency of this monorepo's root. Adding `discord.js` means ~30 new
 *     packages in `package-lock.json`, and this branch is being written alongside another that
 *     is also touching the root manifest.
 *
 * What this deliberately does NOT implement, said plainly rather than discovered later:
 * sharding (one gateway connection, fine to a few thousand guilds and wrong above it), voice,
 * per-route rate-limit buckets (it honours a 429's `retry_after` and retries once, which is
 * enough for a bot that posts a handful of messages a minute and is not enough for a busy one),
 * message edits and deletes (an edited Discord message does not amend the entry already
 * written — see the README), and attachments.
 */

import { WebSocket } from 'ws';

const API = 'https://discord.com/api/v10';

/**
 * GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT.
 *
 * ★ `MESSAGE_CONTENT` (1 << 15) IS PRIVILEGED and must be switched on by hand in the Discord
 * Developer Portal — Bot → Privileged Gateway Intents. Without it the gateway still connects and
 * every `MESSAGE_CREATE` arrives with `content: ""`, so the bot would cheerfully record an empty
 * entry for every message. That is why {@link DiscordGateway} treats close code 4014 as fatal and
 * names the toggle: failing loudly at connect is the only way this does not become a log full of
 * blank records.
 */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/** An interaction response that only the invoker sees. */
export const EPHEMERAL = 64;

export interface GatewayMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorBot: boolean;
  readonly content: string;
}

export interface GatewayInteraction {
  readonly id: string;
  readonly token: string;
  readonly channelId: string;
  /** The invoking user, from `member.user` in a guild or `user` in a DM. */
  readonly userId: string | null;
  readonly name: string;
  readonly options: Readonly<Record<string, string>>;
  readonly channelName: string | null;
}

/**
 * A partially-typed command, arriving per keystroke.
 *
 * ★ TYPE 4 USED TO BE DROPPED ON THE FLOOR HERE, with the comment "not used by this bot". That was
 * true when the bot was a conduit with five commands that took a pod name. It stopped being true
 * the moment a command had to offer a choice out of OTHER PEOPLE'S PODS: which agents exist, which
 * of them their delegator still authorises, and which of them have said their host is running are
 * all facts that live on pods and change between one command and the next. A static choice list
 * would be this bot's cached opinion of somebody else's registry, which is the one thing its whole
 * design refuses to be. So the picker is live, and this is the frame it arrives on.
 */
export interface GatewayAutocomplete {
  readonly id: string;
  readonly token: string;
  readonly channelId: string;
  readonly userId: string | null;
  readonly name: string;
  /** The option Discord says the cursor is in. */
  readonly focused: string;
  /** What has been typed into it so far. Empty on the first keystroke, which is the common case. */
  readonly query: string;
  readonly options: Readonly<Record<string, string>>;
}

/** One choice in an autocomplete response. `value` is what the command actually receives. */
export interface Choice { readonly name: string; readonly value: string }

export interface GatewayHandlers {
  onMessage(m: GatewayMessage): void;
  onInteraction(i: GatewayInteraction): void;
  /**
   * Answer a partially-typed command.
   *
   * ★ DISCORD GIVES THIS THREE SECONDS AND NO DEFERRAL EXISTS FOR IT — unlike a command, an
   * autocomplete has no "thinking" state, so a handler that takes longer produces no list at all
   * and the person sees an empty box with no explanation. Everything the handler does is therefore
   * bounded, and an empty result is rendered as a row that SAYS it is empty rather than as nothing.
   */
  onAutocomplete(a: GatewayAutocomplete): void;
  onNotice(line: string): void;
  /** Called once, with a sentence, when the connection cannot be recovered. */
  onFatal(why: string): void;
}

/**
 * How many consecutive attempts to re-establish the gateway before the bot gives up and says so.
 *
 * ★ GIVING UP IS THE POINT, and it took an outage to see it. A worker that retries forever in
 * silence and a worker that is dead are indistinguishable from outside — Railway reports the
 * deployment SUCCESS either way, because a container that is running is all it can see. The only
 * signal a portless worker has is its exit code, so the reconnect is BOUNDED and running out is
 * routed to `onFatal`, which exits non-zero. Ten attempts with the backoff below is a little over
 * eight minutes of trying, which is longer than any gateway outage that resolves itself.
 */
export const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * How long a fresh socket may sit without sending HELLO before it is abandoned.
 *
 * ★ `ws` HAS NO DEFAULT HANDSHAKE TIMEOUT. `handshakeTimeout` is undefined unless passed, and the
 * defaults object discards any `timeout` given alongside it, so no `'timeout'` handler is
 * registered at all. A TCP connection that opens and then stalls in the TLS negotiation or never
 * returns the HTTP 101 therefore emits NEITHER `'error'` NOR `'close'` — the socket hangs, and with
 * it the bot, with no line in the log and no way for anything to notice. The OS-level ETIMEDOUT
 * covers only an unanswered SYN, not a connected-but-stalled handshake. This watchdog is the
 * backstop, and it is armed by this class rather than left to the library on purpose.
 */
export const HANDSHAKE_TIMEOUT_MS = 20_000;

/** Close codes Discord will never let a reconnect fix. Anything else is retried. */
const FATAL_CLOSE: Record<number, string> = {
  4004: 'the bot token was rejected (4004). Check DISCORD_BOT_TOKEN.',
  4010: 'invalid shard (4010).',
  4011: 'this bot is in too many guilds for a single connection and needs sharding (4011), which this skeleton does not implement.',
  4012: 'invalid API version (4012).',
  4013: 'invalid intents (4013).',
  4014: 'disallowed intents (4014). This bot asks for MESSAGE CONTENT, which is privileged: switch it on in the Discord Developer Portal under Bot → Privileged Gateway Intents. Without it every message arrives empty and the bot would record blanks.',
};

/**
 * One gateway connection, with heartbeats, resume, and a bounded reconnect.
 *
 * ★ THE HEARTBEAT ACK IS CHECKED. A gateway that stops acking is a zombie connection: the socket
 * stays open, no error fires, and no event ever arrives again. A bot in that state looks healthy
 * and silently records nothing — which, for something whose whole claim is "your words are in the
 * record", is the worst failure available. A missed ack forces a reconnect.
 */
export class DiscordGateway {
  private readonly token: string;
  private readonly handlers: GatewayHandlers;
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private acked = true;
  private backoff = 1000;
  private stopped = false;
  private readonly openSocket: (url: string) => WebSocket;
  /** The pending reconnect. Held so `stop()` can cancel it — see why it is NOT unref'd below. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The handshake watchdog for the CURRENT socket. Cleared the moment HELLO arrives. */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive attempts since the last READY or RESUMED. Reset by either. */
  private attempts = 0;
  /**
   * Which socket is the live one.
   *
   * ★ AN ABANDONED SOCKET MUST NOT STILL DRIVE THIS CLASS. Every listener captures the generation
   * it was registered under, so a socket the watchdog gave up on cannot deliver a late `close` that
   * schedules a SECOND reconnect on top of the one already running — two sockets racing, each
   * closing the other, is a livelock that reads in the log as a reconnect storm.
   */
  private gen = 0;

  constructor(token: string, handlers: GatewayHandlers, openSocket?: (url: string) => WebSocket) {
    this.token = token;
    this.handlers = handlers;
    this.openSocket = openSocket ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const gen = ++this.gen;
    const url = (this.sessionId && this.resumeUrl ? this.resumeUrl : 'wss://gateway.discord.gg') + '/?v=10&encoding=json';
    let ws: WebSocket;
    try { ws = this.openSocket(url); }
    catch (e) {
      // ★ A SYNCHRONOUS THROW HERE USED TO BE AN UNCAUGHT EXCEPTION. `connect` is called from a
      // timer callback, so anything the socket constructor threw — a malformed `resume_gateway_url`
      // from a bad frame is the realistic one — escaped to the top with no handler and no notice.
      // It is a failed attempt like any other, and it is retried and named.
      this.handlers.onNotice('gateway could not open a socket to ' + url + ' — ' + ((e as Error)?.message ?? String(e)));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.acked = true;
    // See HANDSHAKE_TIMEOUT_MS: without this, a stalled upgrade hangs forever in total silence.
    this.handshakeTimer = setTimeout(() => {
      if (this.stopped || gen !== this.gen) return;
      this.handlers.onNotice('gateway sent no HELLO within ' + HANDSHAKE_TIMEOUT_MS + 'ms — abandoning this socket, which `ws` would otherwise hold open indefinitely without an error or a close');
      // Bump the generation FIRST, so anything this socket says from here is ignored.
      this.gen++;
      try { ws.close(4000); } catch { /* it is abandoned either way */ }
      this.ws = null;
      this.scheduleReconnect();
    }, HANDSHAKE_TIMEOUT_MS);
    // Unref'd, and only this one: a real socket mid-handshake is itself a ref'd handle, so the
    // process cannot fall out from under this timer. The RECONNECT timer has no such companion.
    this.handshakeTimer.unref?.();
    ws.on('message', (raw: unknown) => { if (gen === this.gen) this.onFrame(String(raw)); });
    ws.on('close', (code: number) => { if (gen === this.gen) this.onClose(code); });
    // An error event is always followed by a close on `ws`, so the reconnect is driven from
    // `close` alone. Handling both would double every reconnect.
    ws.on('error', (e: Error) => { if (gen === this.gen) this.handlers.onNotice('gateway socket error: ' + e.message); });
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    this.ws?.close(1000);
  }

  /**
   * Wait, then try again — or give up loudly.
   *
   * ★★ THE TIMER IS DELIBERATELY NOT `unref()`d, AND THAT ONE CALL WAS THE OUTAGE. It used to read
   * `setTimeout(() => this.connect(), wait).unref?.()`. `unref` tells libuv this timer must not keep
   * the process alive — and at the instant a close is handled it is the ONLY thing left that could:
   * the heartbeat interval has just been cleared two lines up, the socket is gone, and the bot's
   * other timers (the watcher sweep, its per-thread reads) are unref'd too and register nothing at
   * all until a thread is bound. So the event loop emptied, Node exited ZERO, and Railway — whose
   * default restart policy is ON_FAILURE — treated a clean exit as a job well done and left the
   * deployment green with no container behind it. Measured: the log said "reconnecting in 1000ms"
   * and the process was already gone; nothing was ever written again.
   *
   * A timer that carries the entire liveness of a process is exactly the timer that must hold it
   * open. `stop()` cancels it, which is what `unref` was reaching for and got wrong.
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempts++;
    if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
      this.handlers.onFatal('the gateway could not be re-established after ' + MAX_RECONNECT_ATTEMPTS
        + ' consecutive attempts. The bot is not connected to Discord and cannot become connected by waiting, so it is exiting rather than staying up looking healthy.');
      return;
    }
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.handlers.onNotice('reconnecting in ' + wait + 'ms (attempt ' + this.attempts + ' of ' + MAX_RECONNECT_ATTEMPTS + ')');
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, wait);
  }

  private send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  /** Exposed so a test can drive the protocol frame by frame with no socket at all. */
  onFrame(raw: string): void {
    let f: { op?: number; d?: unknown; s?: number | null; t?: string | null };
    try { f = JSON.parse(raw) as typeof f; }
    catch { this.handlers.onNotice('gateway sent a frame this bot could not parse as JSON'); return; }
    if (typeof f.s === 'number') this.seq = f.s;
    switch (f.op) {
      case 10: {                                          // HELLO
        // The socket spoke, so the handshake did not stall. Anything after this is covered by the
        // heartbeat-ack check instead, which is the right instrument once frames are flowing.
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        const every = (f.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41250;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          if (!this.acked) {
            // See the class header: a zombie connection records nothing and looks fine.
            this.handlers.onNotice('the gateway missed a heartbeat ack — reconnecting rather than sitting on a dead socket');
            this.ws?.close(4000);
            return;
          }
          this.acked = false;
          this.send(1, this.seq);
        }, every);
        if (this.sessionId) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.send(2, { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'interego-workspace-discord', device: 'interego-workspace-discord' } });
        return;
      }
      case 11: this.acked = true; return;                 // HEARTBEAT ACK
      case 1: this.send(1, this.seq); return;             // the gateway asking for one
      case 7: this.ws?.close(4000); return;               // RECONNECT
      case 9: {                                           // INVALID SESSION
        if (f.d !== true) { this.sessionId = null; this.seq = null; }
        this.ws?.close(4000);
        return;
      }
      case 0: this.dispatch(f.t ?? '', f.d); return;
      default: return;
    }
  }

  private dispatch(t: string, d: unknown): void {
    const p = (d ?? {}) as Record<string, unknown>;
    if (t === 'READY') {
      this.sessionId = typeof p['session_id'] === 'string' ? p['session_id'] : null;
      this.resumeUrl = typeof p['resume_gateway_url'] === 'string' ? p['resume_gateway_url'] : null;
      this.backoff = 1000;
      // A connection that reached READY is the definition of "the attempts worked", so the budget
      // that decides whether to give up starts again from here and not from process start.
      this.attempts = 0;
      const user = p['user'] as { username?: string; id?: string } | undefined;
      this.handlers.onNotice('gateway ready as ' + (user?.username ?? 'unknown') + ' (' + (user?.id ?? '?') + ')');
      return;
    }
    if (t === 'RESUMED') { this.backoff = 1000; this.attempts = 0; this.handlers.onNotice('gateway resumed'); return; }
    if (t === 'MESSAGE_CREATE') {
      const author = p['author'] as { id?: string; bot?: boolean } | undefined;
      if (typeof p['id'] !== 'string' || typeof p['channel_id'] !== 'string' || typeof author?.id !== 'string') return;
      this.handlers.onMessage({
        id: p['id'], channelId: p['channel_id'], authorId: author.id,
        authorBot: author.bot === true,
        // ★ `??` AND NOT `|| ''`. An absent `content` means the MESSAGE CONTENT intent is not
        // granted; an empty string means the user posted only an attachment. Both end up as ''
        // here, and the caller cannot tell them apart — which is exactly why 4014 is fatal above,
        // so the first case never reaches this line.
        content: typeof p['content'] === 'string' ? p['content'] : '',
      });
      return;
    }
    if (t === 'INTERACTION_CREATE') {
      // Type 2 = APPLICATION_COMMAND, type 4 = APPLICATION_COMMAND_AUTOCOMPLETE. Components and
      // modals are still not used by this bot and are ignored rather than half-answered.
      if (p['type'] !== 2 && p['type'] !== 4) return;
      type Opt = { type?: number; name?: string; value?: unknown; focused?: boolean; options?: readonly Opt[] };
      const data = p['data'] as { name?: string; options?: readonly Opt[] } | undefined;
      const member = p['member'] as { user?: { id?: string } } | undefined;
      const user = p['user'] as { id?: string } | undefined;
      const channel = p['channel'] as { name?: string } | undefined;
      if (typeof p['id'] !== 'string' || typeof p['token'] !== 'string' || typeof p['channel_id'] !== 'string' || !data?.name) return;
      if (p['type'] === 4) {
        // ★ THE SAME SUBCOMMAND FLATTENING AS BELOW, AND KEYED ON THE SAME FACT. An autocomplete on
        // `/workspace ask agent:…` arrives as name `workspace` with a type-1 option `ask` whose own
        // options carry the focus. Reading `data.options` directly would give the SUBCOMMAND as the
        // focused option and never the argument, so nothing would ever be looked up.
        const first0 = data.options?.[0];
        const sub0 = first0 && first0.type === 1 ? first0 : null;
        const opts = (sub0 ? sub0.options : data.options) ?? [];
        const focusedOpt = opts.find((o) => o?.focused === true) ?? null;
        const values: Record<string, string> = {};
        for (const o of opts) {
          if (o?.name && (typeof o.value === 'string' || typeof o.value === 'number')) values[o.name] = String(o.value);
        }
        this.handlers.onAutocomplete({
          id: p['id'], token: p['token'], channelId: p['channel_id'],
          userId: member?.user?.id ?? user?.id ?? null,
          name: sub0 ? data.name + ' ' + String(sub0.name) : data.name,
          // ★ `focused` IS READ AND NOT ASSUMED. A command with two autocompleting options would
          // otherwise have both answered from one option's text. Empty rather than guessed when
          // Discord names none: a handler told which box it is in can refuse, and one that guessed
          // would silently answer the wrong box.
          focused: focusedOpt?.name ?? '',
          query: typeof focusedOpt?.value === 'string' ? focusedOpt.value : '',
          options: values,
        });
        return;
      }
      // One level of subcommand: `/workspace start` arrives as name `workspace` with an option
      // of type 1 named `start`. Flattened here so the command router sees `workspace start`.
      //
      // ★ KEYED ON THE TYPE, NOT ON THE PRESENCE OF NESTED OPTIONS. This tested
      // `Array.isArray(first.options)`, which is true only for a subcommand that TAKES an
      // argument — so `/workspace link-confirm pod:…` flattened and `/workspace start`,
      // `/workspace link`, `/workspace unlink` and `/workspace show` did not. Four of the five
      // commands would have arrived at the router as bare `workspace` and fallen through to
      // "this bot does not know that command". Discord's type 1 is SUB_COMMAND and is the fact
      // being read; nested options are a property of the subcommand, not evidence of one.
      const first = data.options?.[0];
      const sub = first && first.type === 1 ? first : null;
      const options: Record<string, string> = {};
      for (const o of (sub ? sub.options : data.options) ?? []) {
        if (o?.name && (typeof o.value === 'string' || typeof o.value === 'number')) options[o.name] = String(o.value);
      }
      this.handlers.onInteraction({
        id: p['id'], token: p['token'], channelId: p['channel_id'],
        userId: member?.user?.id ?? user?.id ?? null,
        name: sub ? data.name + ' ' + String(sub.name) : data.name,
        options, channelName: channel?.name ?? null,
      });
    }
  }

  private onClose(code: number): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) { this.handlers.onFatal(fatal); return; }
    // 4007 / 4009 mean the resume was rejected; anything else may still resume.
    if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; }
    this.handlers.onNotice('gateway closed (' + code + ')');
    this.scheduleReconnect();
  }
}

// ── REST ─────────────────────────────────────────────────────────────────────

/**
 * The four calls this bot makes, and one retry on a 429.
 *
 * ★ A FAILED REPLY IS REPORTED, NOT SWALLOWED. If the bot writes an entry to somebody's pod and
 * then cannot say so in the thread, the record is right and the person does not know it — so the
 * caller is told, and it goes to the operator's log rather than nowhere.
 */
export class DiscordRest {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl?: typeof fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  // Generic in the answer because `GET /commands` returns an ARRAY and everything else an object.
  // Defaulted to the object shape so no existing call site changes.
  private async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchImpl(API + path, {
        method,
        headers: { Authorization: 'Bot ' + this.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status === 429) {
        // ★ THE SECOND 429 SAYS IT IS THE SECOND. This used to fall through to the generic
        // `!res.ok` throw below, so being rate limited twice reported "HTTP 429" — identical to
        // being rate limited once by a bot that does not retry, and it hid the fact that the
        // backoff had already been spent. An operator reading that line needs to know whether
        // waiting longer is the fix.
        if (attempt > 0) throw new Error('Discord ' + method + ' ' + path + ' was rate limited twice in a row (HTTP 429): ' + text.slice(0, 200));
        let after = 1;
        try { after = Number((JSON.parse(text) as { retry_after?: number }).retry_after ?? 1); } catch { /* a body this client cannot parse gets the one-second default */ }
        await new Promise((r) => setTimeout(r, Math.min(Math.max(after, 0) * 1000 + 250, 30_000)));
        continue;
      }
      if (!res.ok) throw new Error('Discord ' + method + ' ' + path + ' -> HTTP ' + res.status + ' ' + text.slice(0, 300));
      if (!text) return {} as T;
      try { return JSON.parse(text) as T; } catch { return {} as T; }
    }
    /* istanbul ignore next — every path through the loop returns or throws; this satisfies the compiler. */
    throw new Error('Discord ' + method + ' ' + path + ': the retry loop ended without an answer');
  }

  /** Acknowledge an interaction inside Discord's three-second window. */
  defer(interactionId: string, token: string, ephemeral: boolean): Promise<Record<string, unknown>> {
    // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE. Substrate work takes several round trips
    // and Discord kills an interaction that is not acknowledged in 3 s, so every command defers
    // first and edits the placeholder afterwards.
    return this.call('POST', '/interactions/' + interactionId + '/' + token + '/callback', { type: 5, data: ephemeral ? { flags: EPHEMERAL } : {} });
  }

  /** Replace the deferred placeholder with the real answer. */
  edit(applicationId: string, token: string, content: string): Promise<Record<string, unknown>> {
    // `allowed_mentions` is empty except for the one user a "not recorded" notice pings: this bot
    // renders text that came off other people's pods, and a workspace title containing `@everyone`
    // must not become a ping.
    return this.call('PATCH', '/webhooks/' + applicationId + '/' + token + '/messages/@original', { content, allowed_mentions: { parse: [], users: [] } });
  }

  /**
   * Answer an autocomplete with a choice list.
   *
   * ★ TYPE 8 = APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, and it is a CALLBACK, not an edit — there
   * is no deferral for an autocomplete and no second chance to send one. Discord caps the list at
   * 25 and refuses a `name` over 100 characters outright, so both are enforced here rather than
   * hoped for at the call site: one over-long agent label would make the whole list fail to render,
   * and the person would see an empty box that says nothing about why.
   */
  autocomplete(interactionId: string, token: string, choices: readonly Choice[]): Promise<Record<string, unknown>> {
    const safe = choices.slice(0, 25).map((c) => ({
      name: c.name.length > 100 ? c.name.slice(0, 99) + '…' : c.name,
      value: c.value.length > 100 ? c.value.slice(0, 100) : c.value,
    }));
    return this.call('POST', '/interactions/' + interactionId + '/' + token + '/callback', { type: 8, data: { choices: safe } });
  }

  post(channelId: string, content: string, pingUserIds: readonly string[] = []): Promise<Record<string, unknown>> {
    return this.call('POST', '/channels/' + channelId + '/messages', { content, allowed_mentions: { parse: [], users: pingUserIds.slice(0, 1) } });
  }

  /** Global command registration. Discord may take up to an hour to roll these out. */
  registerCommands(applicationId: string, commands: readonly unknown[]): Promise<Record<string, unknown>> {
    return this.call('PUT', '/applications/' + applicationId + '/commands', commands);
  }

  /**
   * What Discord currently has registered, so a boot can decide whether to publish at all.
   *
   * ★ THIS EXISTS BECAUSE RE-REGISTERING IS NOT FREE. Discord bumps a command's `version` on a
   * substantial change and then REJECTS an invocation carrying an older one — error 50035,
   * `INTERACTION_APPLICATION_COMMAND_INVALID_VERSION`, which the client renders as "This command is
   * outdated, please try again in a few minutes". Global commands reach clients through a cache, so
   * that window is real and is measured in tens of minutes. The bulk PUT has been idempotent since
   * 2022, so an unchanged payload SHOULD be a no-op — but "should" is a claim about Discord's
   * normalisation of a payload this bot cannot see the stored form of, and the bot has no way to
   * tell a spurious bump from a real one after the fact. Reading first turns that into a decision
   * this program makes and logs, rather than one it hopes about.
   */
  listCommands(applicationId: string): Promise<readonly unknown[]> {
    return this.call<readonly unknown[]>('GET', '/applications/' + applicationId + '/commands');
  }

  /** Who this token is. Used to learn the application id rather than asking for it twice. */
  async me(): Promise<{ id: string; username: string }> {
    const j = await this.call('GET', '/users/@me');
    return { id: String(j['id'] ?? ''), username: String(j['username'] ?? '') };
  }
}

/**
 * The command tree, as Discord's registration payload.
 *
 * `link-confirm` is a separate top-level subcommand rather than an option on `link`, because the
 * two halves happen minutes apart in a different application, and an optional argument on one
 * command reads as though supplying it were the normal path.
 */
export const COMMANDS = [
  {
    name: 'workspace',
    description: 'Turn this thread into a record on the participants\' own pods',
    options: [
      { type: 1, name: 'start', description: 'Create a workspace convened by your pod, named after this thread' },
      { type: 1, name: 'link', description: 'Get a one-time code to bind your own Interego pod to this Discord account' },
      {
        type: 1, name: 'link-confirm', description: 'Finish linking, once you have published the delegation on your pod',
        options: [{ type: 3, name: 'pod', description: 'Your pod identifier, e.g. u-eth-0123456789ab', required: true }],
      },
      { type: 1, name: 'unlink', description: 'Make this bot forget your pod (this does NOT revoke the delegation)' },
      { type: 1, name: 'show', description: 'The composed view of this thread\'s workspace, and the IRI anyone can follow' },
      {
        type: 1, name: 'who', description: 'Every agent that could be asked something here, and what its own pod says about it',
      },
      {
        type: 1, name: 'ask',
        description: 'Ask one agent to do something. The ask goes on the record whether or not its host is running',
        options: [
          // ★ `autocomplete: true` AND NO STATIC `choices`. Which agents exist, which their
          // delegator still authorises and which have said their host is up are facts on other
          // people's pods that change between one command and the next. A static list would be this
          // bot's cached opinion of somebody else's registry.
          { type: 3, name: 'agent', description: 'Which agent. Pick from the list — the value is its full DID', required: true, autocomplete: true },
          { type: 3, name: 'task', description: 'What you are asking it to do. This goes in the record, in your own words', required: true },
        ],
      },
    ],
  },
] as const;

/**
 * A stable string standing for "what the command tree IS", comparable across the two shapes it
 * comes in: the payload this bot would PUT, and the record Discord hands back from a GET.
 *
 * ★ THE TWO SHAPES DIFFER AND ONLY ONE OF THE DIFFERENCES IS REAL. Discord's stored record carries
 * an `id`, an `application_id`, a `version`, permission and context fields, and localisation maps
 * this bot never sends — comparing raw JSON would report "changed" on every single boot and defeat
 * the whole check. So only the fields this bot actually declares are folded in, the defaults
 * Discord fills in are applied to BOTH sides (a command with no `type` is CHAT_INPUT; an option
 * with no `required` is optional), and commands and options are sorted by name so that reordering
 * the source without changing its meaning is not mistaken for a change.
 *
 * ★ AND IT IS DELIBERATELY CONSERVATIVE. A field this function ignores is a change it would MISS,
 * which would leave a real edit unpublished — the worse failure of the two. Every field the tree in
 * `COMMANDS` uses is therefore folded in, and the test asserts that a change to any of them shows.
 */
export function commandFingerprint(commands: readonly unknown[]): string {
  type Node = { name?: unknown; description?: unknown; type?: unknown; required?: unknown; autocomplete?: unknown; choices?: unknown; options?: unknown };
  const byName = (a: unknown, b: unknown): number =>
    String((a as { name?: unknown }).name ?? '').localeCompare(String((b as { name?: unknown }).name ?? ''));
  const option = (o: unknown): unknown => {
    const n = (o ?? {}) as Node;
    return {
      name: String(n.name ?? ''),
      description: String(n.description ?? ''),
      type: Number(n.type ?? 0),
      required: n.required === true,
      autocomplete: n.autocomplete === true,
      choices: Array.isArray(n.choices)
        ? n.choices.map((c) => ({ name: String((c as Node).name ?? ''), value: (c as { value?: unknown }).value ?? null }))
        : [],
      options: Array.isArray(n.options) ? [...n.options].map(option).sort(byName) : [],
    };
  };
  const folded = [...commands].map((c) => {
    const n = (c ?? {}) as Node;
    return {
      name: String(n.name ?? ''),
      description: String(n.description ?? ''),
      // Discord stores CHAT_INPUT as type 1 and this bot omits it; without the default every boot
      // would see 1 on one side and 0 on the other and re-register forever.
      type: Number(n.type ?? 1),
      options: Array.isArray(n.options) ? [...n.options].map(option).sort(byName) : [],
    };
  }).sort(byName);
  return JSON.stringify(folded);
}
