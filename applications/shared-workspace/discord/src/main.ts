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
 */

import { LinkStore } from './links.js';
import { BotSession } from './identity.js';
import { COMMANDS, DiscordGateway, DiscordRest, type GatewayInteraction, type GatewayMessage } from './discord.js';
import { beginLink, confirmLink, recordMessage, showWorkspace, startWorkspace, unlink, type Deps } from './workspace.js';
import { renderChallenge, renderConfirm, renderRecord, renderShow, renderStart, renderUnlink, type Message } from './render.js';

const out = (line: string): void => { process.stdout.write(new Date().toISOString() + ' ' + line + '\n'); };

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

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
class PerKeyQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    // The chain must not break on a rejection, or one failed append would wedge that pod forever.
    const next = prior.then(fn, fn);
    this.tails.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

async function main(): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  const key = process.env['INTEREGO_BOT_KEY'];
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set. This bot cannot connect to Discord without one and will not start with a placeholder.');
  if (!key) throw new Error('INTEREGO_BOT_KEY is not set. This is the secp256k1 key the bot signs in to the relay with — its OWN identity. Generate one with `openssl rand -hex 32`, prefix it with 0x, and keep it out of the repo.');

  const rest = new DiscordRest(token);
  const who = await rest.me();
  out('discord: authenticated as ' + who.username + ' (application ' + who.id + ')');

  if (process.argv.includes('--register-commands-only')) {
    await rest.registerCommands(who.id, COMMANDS as unknown as readonly unknown[]);
    out('discord: registered ' + COMMANDS.length + ' global command tree(s). Discord can take up to an hour to roll these out.');
    return;
  }

  const session = new BotSession(RELAY, IDENTITY, key);
  const identity = await session.open();
  out('relay: signed in as pod ' + identity.pod + ' · wallet ' + identity.address);
  out('relay: this bot\'s agent id — the string participants delegate — is ' + identity.agentId);

  const store = new LinkStore();
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
  });
  gateway.connect();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { out('shutting down on ' + sig); gateway.stop(); process.exit(0); });
  }
}

main().catch((e: unknown) => {
  out('FATAL: ' + ((e as Error)?.message ?? String(e)));
  process.exitCode = 1;
});
