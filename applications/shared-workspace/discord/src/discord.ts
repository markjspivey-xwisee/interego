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

export interface GatewayHandlers {
  onMessage(m: GatewayMessage): void;
  onInteraction(i: GatewayInteraction): void;
  onNotice(line: string): void;
  /** Called once, with a sentence, when the connection cannot be recovered. */
  onFatal(why: string): void;
}

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

  constructor(token: string, handlers: GatewayHandlers, openSocket?: (url: string) => WebSocket) {
    this.token = token;
    this.handlers = handlers;
    this.openSocket = openSocket ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    if (this.stopped) return;
    const url = (this.sessionId && this.resumeUrl ? this.resumeUrl : 'wss://gateway.discord.gg') + '/?v=10&encoding=json';
    const ws = this.openSocket(url);
    this.ws = ws;
    this.acked = true;
    ws.on('message', (raw: unknown) => { this.onFrame(String(raw)); });
    ws.on('close', (code: number) => { this.onClose(code); });
    // An error event is always followed by a close on `ws`, so the reconnect is driven from
    // `close` alone. Handling both would double every reconnect.
    ws.on('error', (e: Error) => { this.handlers.onNotice('gateway socket error: ' + e.message); });
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.ws?.close(1000);
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
      const user = p['user'] as { username?: string; id?: string } | undefined;
      this.handlers.onNotice('gateway ready as ' + (user?.username ?? 'unknown') + ' (' + (user?.id ?? '?') + ')');
      return;
    }
    if (t === 'RESUMED') { this.backoff = 1000; this.handlers.onNotice('gateway resumed'); return; }
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
      // Type 2 = APPLICATION_COMMAND. Everything else (components, autocomplete, modals) is not
      // used by this bot and is ignored rather than half-answered.
      if (p['type'] !== 2) return;
      const data = p['data'] as { name?: string; options?: readonly { type?: number; name?: string; value?: unknown; options?: readonly { name?: string; value?: unknown }[] }[] } | undefined;
      const member = p['member'] as { user?: { id?: string } } | undefined;
      const user = p['user'] as { id?: string } | undefined;
      const channel = p['channel'] as { name?: string } | undefined;
      if (typeof p['id'] !== 'string' || typeof p['token'] !== 'string' || typeof p['channel_id'] !== 'string' || !data?.name) return;
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
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) { this.handlers.onFatal(fatal); return; }
    // 4007 / 4009 mean the resume was rejected; anything else may still resume.
    if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; }
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.handlers.onNotice('gateway closed (' + code + '); reconnecting in ' + wait + 'ms');
    setTimeout(() => { this.connect(); }, wait).unref?.();
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

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
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
      if (!text) return {};
      try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
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

  post(channelId: string, content: string, pingUserIds: readonly string[] = []): Promise<Record<string, unknown>> {
    return this.call('POST', '/channels/' + channelId + '/messages', { content, allowed_mentions: { parse: [], users: pingUserIds.slice(0, 1) } });
  }

  /** Global command registration. Discord may take up to an hour to roll these out. */
  registerCommands(applicationId: string, commands: readonly unknown[]): Promise<Record<string, unknown>> {
    return this.call('PUT', '/applications/' + applicationId + '/commands', commands);
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
    ],
  },
] as const;
