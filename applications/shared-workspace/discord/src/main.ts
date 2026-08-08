/**
 * WIRING. Two secrets in, one gateway connection, one relay session.
 *
 *   DISCORD_BOT_TOKEN   the bot token from the Discord Developer Portal
 *   INTEREGO_BOT_KEY    a secp256k1 private key (0x…) THIS BOT signs in with — its own identity,
 *                       not anybody else's. Generate one with `openssl rand -hex 32` and prefix
 *                       `0x`, or let the bot print one on first run and put it in the env.
 *   INTEREGO_RELAY      default https://relay.interego.xwisee.com
 *   INTEREGO_IDENTITY   default https://identity.interego.xwisee.com
 *   INTEREGO_DISCORD_STATE  where the link index lives. Default ~/.interego/discord-workspace.json
 *
 * ★ NEITHER SECRET MAY EVER BE IN THE REPO and this file reads both from the environment only.
 * There is no config file, no default token and no fallback key: a missing one refuses to start
 * and names itself.
 *
 * `no-console` is an eslint error in this tree, and rightly — a bot's operator log is a stream
 * with a contract, not a debug aid. Everything below goes to stdout through one function.
 *
 * ★ WHY THIS FILE TAKES A `Boot` AND EXPORTS ITS ENTRY POINT.
 *
 * It used to do neither: `main()` was module-private and line 168 called it, so the act of
 * importing this module authenticated against Discord, minted a SIWE bearer against the live
 * relay, wrote `~/.interego/discord-workspace.json`, opened a real gateway socket and installed
 * two `process.on(SIG…)` handlers — and swallowed any throw into `process.exitCode = 1`, which
 * in a shared vitest worker is a green-looking import that quietly poisons the run. There was
 * therefore no way to reach `onInteraction`, `onMessage` or the per-pod queue at all, and this
 * file — the wiring between the Discord half and the substrate half, the only part of the bot
 * neither `tests/gateway.test.ts` nor `tests/record.test.ts` touches — was the least-proven code
 * in the vertical.
 *
 * The seam is deliberately the SMALLEST one that changes no behaviour. Three of the four
 * injection points already existed and this file simply declined to use them: `DiscordRest`
 * takes a `fetchImpl`, `DiscordGateway` takes an `openSocket`, `LinkStore` takes a path. Only
 * the session and the signal installer are new, and both default to exactly what ran before.
 * Run as a program, every default applies and the behaviour is line-for-line what it was.
 */

import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { LinkStore } from './links.js';
import { BotSession, type BotIdentity } from './identity.js';
import { COMMANDS, DiscordGateway, DiscordRest, type GatewayInteraction, type GatewayMessage } from './discord.js';
import { beginLink, confirmLink, recordMessage, showWorkspace, startWorkspace, unlink, type Deps } from './workspace.js';
import { renderChallenge, renderConfirm, renderRecord, renderShow, renderStart, renderUnlink, type Message } from './render.js';

const defaultOut = (line: string): void => { process.stdout.write(new Date().toISOString() + ' ' + line + '\n'); };

/**
 * The part of `BotSession` the wiring uses. A test supplies these three and nothing else — in
 * particular it never reaches `new Wallet(privateKey)` or the SIWE mint behind `open()`.
 */
export type SessionLike = Pick<BotSession, 'open' | 'current' | 'call'>;

/** What `main` hands back once the gateway is connected. `null` for the register-only exit. */
export interface Started {
  readonly gateway: DiscordGateway;
  readonly identity: BotIdentity;
  readonly store: LinkStore;
}

/**
 * Everything the wiring reaches outside itself. Every field is optional and every default is
 * the live one, so `main()` with no argument is the program.
 */
export interface Boot {
  /** Defaults to `process.env`. Read INSIDE `main`, so the relay URLs are not frozen at import. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.argv`. Only `--register-commands-only` is looked for. */
  readonly argv?: readonly string[];
  /** Defaults to the stdout writer above. */
  readonly out?: (line: string) => void;
  /** Passed to `DiscordRest`. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Passed to `DiscordGateway`. Defaults to a real `ws` socket. */
  readonly openSocket?: ConstructorParameters<typeof DiscordGateway>[2];
  /** Passed to `LinkStore`. Defaults to `INTEREGO_DISCORD_STATE` / `~/.interego/…`. */
  readonly statePath?: string;
  /** Defaults to `new BotSession(relay, identity, INTEREGO_BOT_KEY)`. */
  readonly session?: SessionLike;
  /**
   * Defaults to `process.on`. A test must not leave SIGINT/SIGTERM listeners behind in a
   * single-threaded vitest worker, and a listener that calls `process.exit(0)` least of all.
   */
  readonly installSignalHandler?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/**
 * ONE APPEND AT A TIME PER POD.
 *
 * ★ THE RACE THIS CLOSES IS THE ORDINARY CASE, NOT AN EDGE. Two messages from the same person a
 * second apart both read the chain, both derive sequence N, and both append asserting the same
 * prior head. `postEntry` retries once on the relay's 412 and that is enough for a collision it
 * loses; it is not enough for two of its own writes racing, because the second read may land
 * before the first write commits and then BOTH retries derive N again. Serialising per pod makes
 * the sequence a real sequence. Keyed by pod rather than by thread: one person in two threads is
 * two logs, but one pod is one chain per stream and the CAS is per stream.
 */
export class PerKeyQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    // The chain must not break on a rejection, or one failed append would wedge that pod forever.
    const next = prior.then(fn, fn);
    this.tails.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

export async function main(boot: Boot = {}): Promise<Started | null> {
  const env = boot.env ?? process.env;
  const argv = boot.argv ?? process.argv;
  const out = boot.out ?? defaultOut;
  const RELAY = env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
  const IDENTITY = env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

  const token = env['DISCORD_BOT_TOKEN'];
  const key = env['INTEREGO_BOT_KEY'];
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set. This bot cannot connect to Discord without one and will not start with a placeholder.');
  // ★ The key is required only when a SESSION HAS TO BE MADE. An injected session already holds
  // an identity, so demanding a private key alongside it would make the seam useless for a test
  // and would be a second, weaker copy of the check `new BotSession` does for itself.
  if (!key && !boot.session) throw new Error('INTEREGO_BOT_KEY is not set. This is the secp256k1 key the bot signs in to the relay with — its OWN identity. Generate one with `openssl rand -hex 32`, prefix it with 0x, and keep it out of the repo.');

  const rest = new DiscordRest(token, boot.fetchImpl);
  const who = await rest.me();
  out('discord: authenticated as ' + who.username + ' (application ' + who.id + ')');

  if (argv.includes('--register-commands-only')) {
    await rest.registerCommands(who.id, COMMANDS as unknown as readonly unknown[]);
    out('discord: registered ' + COMMANDS.length + ' global command tree(s). Discord can take up to an hour to roll these out.');
    return null;
  }

  const session: SessionLike = boot.session ?? new BotSession(RELAY, IDENTITY, key as string);
  const identity = await session.open();
  out('relay: signed in as pod ' + identity.pod + ' · wallet ' + identity.address);
  out('relay: this bot\'s agent id — the string participants delegate — is ' + identity.agentId);

  const store = new LinkStore(boot.statePath);
  out('store: ' + store.file);
  const base = { relay: RELAY, agentId: identity.agentId, store };
  const deps = (client: Deps['client']): Deps => ({ ...base, client });

  await rest.registerCommands(who.id, COMMANDS as unknown as readonly unknown[]);
  out('discord: commands registered');

  const queue = new PerKeyQueue();
  /** One "you are not linked" notice per person per thread. A bot that repeats it is a nuisance. */
  const toldUnlinked = new Set<string>();

  const say = async (channelId: string, m: Message | null, ping: readonly string[] = []): Promise<void> => {
    if (!m) return;
    try { await rest.post(channelId, m.content, ping); }
    catch (e) { out('discord: could not post to ' + channelId + ' — ' + ((e as Error).message)); }
  };

  const onInteraction = async (i: GatewayInteraction): Promise<void> => {
    if (!i.userId) { out('discord: an interaction arrived with no user, ignored'); return; }
    // Ephemerality has to be decided BEFORE the work, because the deferral carries the flag and
    // it cannot be changed afterwards. Everything except `start` and `show` is private to the
    // caller — a link code in a public channel is a link code somebody else can use.
    const ephemeral = i.name !== 'workspace start' && i.name !== 'workspace show';
    try { await rest.defer(i.id, i.token, ephemeral); }
    catch (e) { out('discord: could not acknowledge ' + i.name + ' — ' + (e as Error).message); return; }
    let m: Message;
    try {
      switch (i.name) {
        case 'workspace link':
          m = renderChallenge(beginLink(deps(session.current.client), i.userId));
          break;
        case 'workspace link-confirm':
          m = renderConfirm(await session.call((c) => confirmLink(deps(c), { discordUserId: i.userId as string, podName: i.options['pod'] ?? '' })));
          break;
        case 'workspace unlink':
          m = renderUnlink(unlink(deps(session.current.client), i.userId));
          break;
        case 'workspace start':
          m = renderStart(await session.call((c) => startWorkspace(deps(c), {
            threadId: i.channelId, threadName: i.channelName ?? '', discordUserId: i.userId as string,
          })));
          break;
        case 'workspace show':
          m = renderShow(await session.call((c) => showWorkspace(deps(c), i.channelId)));
          break;
        default:
          m = { content: 'This bot does not know the command `' + i.name + '`.', ephemeral: true };
      }
    } catch (e) {
      // ★ THE FAILURE IS NAMED IN THE THREAD. An interaction that is deferred and never edited
      // shows "the application did not respond" forever — a bot whose whole subject is what did
      // and did not get written must not leave that as its answer.
      m = { content: '**That did not complete.** ' + ((e as Error)?.message ?? String(e)) + '\nNothing below this is a statement about your pod.', ephemeral };
      out('command ' + i.name + ' failed: ' + ((e as Error)?.stack ?? String(e)));
    }
    try { await rest.edit(who.id, i.token, m.content); }
    catch (e) { out('discord: could not deliver the answer to ' + i.name + ' — ' + (e as Error).message); }
  };

  const onMessage = (msg: GatewayMessage): void => {
    // Its own posts, and every other bot's. Without this the record would fill with the bot's
    // own confirmations of the record.
    if (msg.authorBot) return;
    if (!store.threadOf(msg.channelId)) return;
    if (!store.linkOf(msg.authorId)) {
      const seen = msg.channelId + ':' + msg.authorId;
      if (toldUnlinked.has(seen)) return;
      toldUnlinked.add(seen);
      void say(msg.channelId, renderRecord({ kind: 'unlinked', discordUserId: msg.authorId }), [msg.authorId]);
      return;
    }
    const pod = store.linkOf(msg.authorId)?.pod ?? msg.authorId;
    void queue.run(pod, async () => {
      const res = await session.call((c) => recordMessage(deps(c), {
        threadId: msg.channelId, discordUserId: msg.authorId, text: msg.content,
      }));
      await say(msg.channelId, renderRecord(res));
    }).catch((e: unknown) => { out('recording failed for message ' + msg.id + ': ' + ((e as Error)?.stack ?? String(e))); });
  };

  const gateway = new DiscordGateway(token, {
    onMessage,
    onInteraction: (i) => { void onInteraction(i); },
    onNotice: (l) => { out('gateway: ' + l); },
    onFatal: (why) => { out('gateway FATAL: ' + why); process.exitCode = 1; gateway.stop(); },
  }, boot.openSocket);
  gateway.connect();

  const install = boot.installSignalHandler ?? ((sig, handler) => { process.on(sig, handler); });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    install(sig, () => { out('shutting down on ' + sig); gateway.stop(); process.exit(0); });
  }

  return { gateway, identity, store };
}

/**
 * ★ RUN AS A PROGRAM, IMPORT AS A MODULE. Without this guard `import '../src/main.js'` IS a
 * launch. `npm start` (`tsx src/main.ts`) and `npm run register-commands` both put this file's
 * own path in `argv[1]`, so both still start the bot; nothing else does.
 */
function invokedAsProgram(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const asUrl = pathToFileURL(resolvePath(entry)).href;
  return process.platform === 'win32'
    ? asUrl.toLowerCase() === import.meta.url.toLowerCase()
    : asUrl === import.meta.url;
}

if (invokedAsProgram()) {
  main().catch((e: unknown) => {
    defaultOut('FATAL: ' + ((e as Error)?.message ?? String(e)));
    process.exitCode = 1;
  });
}
