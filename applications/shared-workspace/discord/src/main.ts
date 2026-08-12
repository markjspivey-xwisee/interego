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
import { presenceLine } from '@interego/workspace-client';
import { LinkStore } from './links.js';
import { BotSession, type BotIdentity } from './identity.js';
import {
  COMMANDS, DiscordGateway, DiscordRest, commandFingerprint,
  type GatewayAutocomplete, type GatewayInteraction, type GatewayMessage,
} from './discord.js';
import { beginLink, confirmLink, recordMessage, showWorkspace, startWorkspace, unlink, type Deps } from './workspace.js';
// `askCandidates` is still called directly by `/workspace who`, which is DEFERRED and has fifteen
// minutes — unlike the picker, which now reads the watcher's snapshot because it has three seconds.
import { ask, askCandidates, askChoices } from './ask.js';
import { addressedText } from './address.js';
import { ChannelWatcher, watchVia } from './watch.js';
import { WebhookPoster } from './webhook.js';
import { SpokenBy } from './spoken-by.js';
import {
  renderAsk, renderChallenge, renderConfirm, renderNews, renderRecord, renderShow, renderStart,
  renderUnlink, renderWho, type Message, type NewsPost,
} from './render.js';

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
  /**
   * The producer. ★ HANDED BACK SO A CALLER CAN STOP IT, which a test must and the program never
   * does — an interval nobody can clear is an interval that keeps a vitest worker alive after the
   * assertions have finished.
   */
  readonly watcher: ChannelWatcher;
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
  /**
   * Called when the bot has established it cannot do its job. Defaults to `process.exit`.
   *
   * ★ `process.exitCode = 1` IS NOT AN EXIT and that was the bug in the old fatal path. Setting the
   * code only takes effect when the loop empties on its own; with a single bound thread the
   * watcher's `pollingWatch` interval is ref'd, so the bot would have sat there forever — polling
   * pods, unable to speak to Discord, flagged as failing to nobody. A worker's exit code is the one
   * channel it has to the platform, and using it means actually leaving.
   */
  readonly exit?: (code: number) => void;
  /**
   * Called with a handler to run if the event loop ever empties. Defaults to `process.on('beforeExit')`.
   *
   * ★ THIS IS THE GENERAL FORM OF THE OUTAGE, not a second fix for it. The specific cause — an
   * `unref()`d reconnect timer — is fixed in `discord.ts`, but the CLASS of fault is "every handle
   * that could keep this worker alive went away and Node exited zero", and Railway does not restart
   * a zero exit. `beforeExit` fires exactly then and nowhere else: not on an explicit
   * `process.exit()`, so the SIGTERM path below is unaffected, and not on a throw. Any future change
   * that re-creates the same hole gets a loud non-zero exit instead of a green deployment with
   * nothing behind it.
   */
  readonly onIdle?: (handler: () => void) => void;
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

  /**
   * ★ REGISTER ONLY WHEN THE TREE ACTUALLY CHANGED, and this is the "This command is outdated"
   * finding written as code.
   *
   * Discord bumps a command's `version` on a substantial change and then REJECTS an invocation
   * carrying an older one (error 50035, INTERACTION_APPLICATION_COMMAND_INVALID_VERSION), which the
   * client renders as "This command is outdated, please try again in a few minutes". Global
   * commands reach clients through a cache, so after a REAL change that message is expected and
   * self-healing — which is what the maintainer hit, because `who` and `ask` were added to the tree
   * that morning. The bulk PUT has been idempotent since 2022, so an unchanged payload should not
   * bump anything. But a bot that PUTs unconditionally on every boot cannot tell you which of those
   * two it just did, and this one boots many times a day. Reading first makes the answer a line in
   * the log instead of an inference.
   */
  const want = commandFingerprint(COMMANDS as unknown as readonly unknown[]);
  // A failed read is not a reason to skip: it is a reason to fall back to what the bot did before.
  const have = await rest.listCommands(who.id).then(
    (list) => commandFingerprint(Array.isArray(list) ? list : []),
    (e: unknown) => { out('discord: could not read the registered commands (' + ((e as Error)?.message ?? String(e)) + '); registering unconditionally'); return null; },
  );
  if (have !== null && have === want) {
    out('discord: commands are registered — unchanged since the last boot, so nothing was re-published and no client\'s cached version was invalidated');
  } else {
    await rest.registerCommands(who.id, COMMANDS as unknown as readonly unknown[]);
    out('discord: commands are registered — the definitions differ from what Discord holds, so they were re-published. Clients caching the previous version will say "This command is outdated" until they reload.');
  }

  const queue = new PerKeyQueue();
  /** One "you are not linked" notice per person per thread. A bot that repeats it is a nuisance. */
  const toldUnlinked = new Set<string>();

  /**
   * The one place this bot posts unprompted, and now the one place a MULTI-PART post stays whole.
   *
   * ★ THE QUEUE IS INSIDE HERE RATHER THAN AROUND ONE CALLER. Three different paths post to a
   * channel — the watcher's `emit`, the "not recorded" notice, and the post-append report — and a
   * multi-part message from one of them interleaving with a single-line message from another
   * would splice somebody's entry into the middle of somebody else's report. Keyed on the CHANNEL,
   * which is deliberately a different key space from the per-pod write queue: the nested call
   * from the append path therefore never waits on its own chain.
   *
   * ★ AND A PART THAT FAILS IS REPORTED IN THE CHANNEL, not only to the operator log. Every part
   * already carries a `(k/n)` marker, so a reader can see that part 3 of 5 never arrived; this
   * adds a line saying so when the send itself is what failed, because a sequence that simply
   * stops reads as a message that simply ended.
   */
  const say = async (channelId: string, m: Message | readonly Message[] | null, ping: readonly string[] = []): Promise<void> => {
    if (!m) return;
    const parts = Array.isArray(m) ? m as readonly Message[] : [m as Message];
    if (!parts.length) return;
    await queue.run('say:' + channelId, async () => {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as Message;
        try { await rest.post(channelId, part.content, i === 0 ? ping : []); }
        catch (e) {
          out('discord: could not post part ' + (i + 1) + '/' + parts.length + ' to ' + channelId + ' — ' + ((e as Error).message));
          if (i > 0) {
            try {
              await rest.post(channelId, '? Part ' + (i + 1) + ' of ' + parts.length + ' could not be sent, so what is above is incomplete. `/workspace show` reads the whole thing again from the pods that hold it.');
            } catch { /* the marker on the last part that DID land still tells the truth */ }
          }
          return;
        }
      }
    });
  };

  /**
   * Deliver what the watcher decided to say: the bot's own messages as itself, a delegate's words
   * under the delegate's own name.
   *
   * ★ ORDER IS PRESERVED ACROSS THE TWO CHANNELS, which is why this is one queued sequence rather
   * than two independent sends. An agent's answer arriving before the entry it answers would be a
   * conversation reordered by an implementation detail of how each message is transmitted.
   *
   * ★ AND A WEBHOOK THAT WILL NOT POST IS NOT A LOST MESSAGE. `postAs` returns false when the
   * channel has no MANAGE_WEBHOOKS or the call failed; the words then go out as an ordinary post
   * from the bot, which is exactly what happened before this existed.
   */
  const sayNews = async (channelId: string, posts: readonly NewsPost[] | null): Promise<void> => {
    if (!posts?.length) return;
    await queue.run('say:' + channelId, async () => {
      for (const p of posts) {
        if (p.kind === 'agent') {
          const sent = await webhooks.postAs(channelId, p.who, p.content);
          if (sent) { spokenBy.remember(sent, p.agentId); continue; }
          // Fall back to the bot's voice, and NAME the agent in it — the display was the only
          // thing lost, and dropping the attribution with it would be the real failure.
          //
          // ★ AND THIS POST IS REMEMBERED TOO. Replying is not a feature of the webhook display;
          // it is how a person addresses an agent. A channel without MANAGE_WEBHOOKS would
          // otherwise lose the gesture as well as the avatar, which is a much bigger loss than
          // the one the fallback exists to absorb.
          try {
            const posted = await rest.post(channelId, '**' + p.who + '** —\n' + p.content, []);
            if (typeof posted['id'] === 'string') spokenBy.remember(posted['id'], p.agentId);
          }
          catch (e) { out('discord: could not post ' + p.who + '\'s entry to ' + channelId + ' — ' + ((e as Error).message)); }
          continue;
        }
        try { await rest.post(channelId, p.message.content, []); }
        catch (e) { out('discord: could not post to ' + channelId + ' — ' + ((e as Error).message)); return; }
      }
    });
  };

  /**
   * The producer: one change-only watch per seated member's log, per thread.
   *
   * ★ IT COMPOSES `showWorkspace` RATHER THAN READING FOR ITSELF — the SAME function `/workspace
   * show` calls. The pushed line and the pulled line therefore cannot disagree about what the
   * record says, and there is no second reader to drift the day somebody fixes a bug in either.
   *
   * ★ AND `emit` GOES THROUGH `say`, which is the one place this bot posts unprompted. `renderNews`
   * returning null is a real answer — nothing worth a message — and `say` already declines a null,
   * so a pass with nothing to report posts nothing rather than an empty line.
   */
  /** One webhook per channel, created on first use. See webhook.ts for why the name is only
   *  ever used for an entry whose own key signed it. */
  const webhooks = new WebhookPoster(rest, out);
  /**
   * Which Discord message was which agent speaking, so a reply reaches the one that spoke.
   *
   * In memory and bounded on purpose — see `spoken-by.ts`. It holds no authority and nothing is
   * decided from it: what it yields is a candidate name for the same `ask()` every other path
   * calls, which re-resolves against the delegator's own pod and refuses if that pod says no.
   */
  const spokenBy = new SpokenBy();

  const watcher = new ChannelWatcher({
    store,
    withClient: (fn) => session.call(async (c) => fn(deps(c))),
    // ★ A GETTER, NOT THE CLIENT. `session.current.client` evaluated HERE binds one client for the
    // life of the watch, so a re-minted session — a bearer expiring, or the relay restarting
    // underneath the bot — left every watch polling with a session that no longer exists. Passing
    // the getter means each poll uses whatever session is current, so a re-mint heals them.
    watch: (name, input, onChange, onError) =>
      watchVia(() => session.current.client)(name, input, onChange, onError),
    emit: (channelId, news) => sayNews(channelId, renderNews(news)),
    out,
  });

  const onInteraction = async (i: GatewayInteraction): Promise<void> => {
    if (!i.userId) { out('discord: an interaction arrived with no user, ignored'); return; }
    // Ephemerality has to be decided BEFORE the work, because the deferral carries the flag and
    // it cannot be changed afterwards. Everything except `start` and `show` is private to the
    // caller — a link code in a public channel is a link code somebody else can use.
    const ephemeral = i.name !== 'workspace start' && i.name !== 'workspace show';
    try { await rest.defer(i.id, i.token, ephemeral); }
    catch (e) { out('discord: could not acknowledge ' + i.name + ' — ' + (e as Error).message); return; }
    // One message or several: the renderers that can overflow Discord's 2000-character limit
    // return every part, and the delivery loop below sends them in order.
    let m: Message | readonly Message[];
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
        case 'workspace who':
          m = renderWho(await session.call((c) => askCandidates(deps(c), {
            threadId: i.channelId, discordUserId: i.userId as string,
          })));
          break;
        case 'workspace ask': {
          // ★ SERIALISED ON THE ASKER'S POD, like every other append. An ask IS an entry in their
          // log, so two of them a second apart race the chain derivation exactly as two messages
          // would — and this one is likelier, because a person who asks one agent something often
          // asks the next one straight after.
          const askerPod = store.linkOf(i.userId)?.pod ?? i.userId;
          const out = await queue.run(askerPod, () => session.call((c) => ask(deps(c), {
            threadId: i.channelId, discordUserId: i.userId as string,
            spec: i.options['agent'] ?? '', task: i.options['task'] ?? '',
          })));
          m = renderAsk(out);
          // Only a written ask is watched for silence. Recording one that was refused would
          // promise a follow-up about an entry that does not exist.
          if (out.kind === 'asked' && out.descriptorUrl) {
            watcher.noteAsk({
              threadId: i.channelId, descriptorUrl: out.descriptorUrl, seq: out.accepted.seq,
              targetPod: out.target.pod, targetAgentId: out.target.agentId,
              targetName: out.target.name ?? out.target.agentId,
              askedAtMs: Date.now(),
              // Verbatim, so the follow-up quotes what was true at the moment of asking rather
              // than re-deriving a fact that has since changed.
              presenceAtAsk: presenceLine(out.target.presence),
            });
          }
          break;
        }
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
    /**
     * ★ THE FIRST PART EDITS THE PLACEHOLDER; THE REST ARE FOLLOWUPS ON THE SAME TOKEN.
     *
     * A deferred interaction has exactly one placeholder, so a reply longer than one message
     * cannot be delivered by `edit` alone — which is why `/workspace show` was clipped rather
     * than continued. Each followup restates `ephemeral`, because the flag is NOT inherited from
     * the deferral and a private reply's later parts would otherwise land in the channel.
     *
     * A part that fails is announced rather than swallowed: the `(k/n)` marker on the parts that
     * did arrive already tells a reader something is missing, and this says which.
     */
    const parts = Array.isArray(m) ? m as readonly Message[] : [m as Message];
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k] as Message;
      try {
        if (k === 0) await rest.edit(who.id, i.token, part.content);
        else await rest.followup(who.id, i.token, part.content, part.ephemeral);
      } catch (e) {
        out('discord: could not deliver part ' + (k + 1) + '/' + parts.length + ' of ' + i.name + ' — ' + (e as Error).message);
        if (k > 0) {
          try {
            await rest.followup(who.id, i.token, '? Part ' + (k + 1) + ' of ' + parts.length
              + ' could not be sent, so the answer above is incomplete.', part.ephemeral);
          } catch { /* the marker on the parts that landed still says how many there should be */ }
        }
        return;
      }
    }
  };

  /**
   * The picker, answered live per keystroke.
   *
   * ★ THREE SECONDS AND NO DEFERRAL. Discord has no "thinking" state for an autocomplete, so a
   * handler that overruns produces an empty box with no explanation. Every read behind
   * `askCandidates` is bounded — one roster fold, one registry read per seated pod, one presence
   * read per delegate — and if it throws, a row SAYING it failed goes back rather than nothing,
   * because an empty list and a failed lookup are different facts and Discord draws them the same.
   *
   * ★ AND NOTHING IS CACHED BETWEEN KEYSTROKES ON PURPOSE. A delegation revoked thirty seconds ago
   * must disappear from this list without anything telling this bot, which is only true while the
   * pods are the ones being asked.
   */
  const onAutocomplete = async (a: GatewayAutocomplete): Promise<void> => {
    if (!a.userId || a.name !== 'workspace ask' || a.focused !== 'agent') {
      try { await rest.autocomplete(a.id, a.token, []); } catch { /* the box simply stays empty */ }
      return;
    }
    /**
     * ★ THE SNAPSHOT, NOT A LIVE READ, AND THIS IS THE DIFFERENCE BETWEEN A PICKER AND AN ERROR.
     *
     * This used to call `askCandidates` inline. Measured 2026-08-11 on a real workspace that
     * read took 6625 ms — `discover_context` 1820 ms over 769 descriptors, `foldRoster` 4298 ms,
     * a registry read 500 ms, a presence read 1827 ms — against Discord's THREE SECONDS with no
     * deferral. Discord renders that as "loading options failed" and says nothing about why.
     *
     * The scan grew when its 400-descriptor cap came off, and the cap was hiding real members, so
     * the answer is not to put it back. The watcher already folds this thread every 45 seconds;
     * it now computes the candidates there too, where the budget is 45 seconds instead of three.
     *
     * ★ AND A SNAPSHOT CANNOT CAUSE A WRONG ASK. `ask()` re-resolves whatever is submitted against
     * the delegator's own pod before writing, and refuses a delegate that has since been revoked
     * or lost write eligibility. The worst a stale list does is offer a name that is then refused
     * with a reason.
     */
    let choices: readonly { name: string; value: string }[];
    const snap = watcher.candidatesFor(a.channelId);
    if (!snap) {
      // Not "nobody has an agent" — this bot has not finished reading the channel yet. Saying the
      // first would tell somebody their delegate does not exist moments after authorising it.
      choices = [{ name: '· still reading this channel — try again in a few seconds', value: '?unread:' }];
    } else {
      // `isYou` is recomputed here because the background pass has no asking user. Everything
      // else — who is seated, who they authorise, whose host is up — is from the snapshot.
      const mine = store.linkOf(a.userId)?.pod ?? null;
      const seen = { ...snap.out, targets: snap.out.targets.map((t) => ({ ...t, isYou: t.pod === mine })) };
      choices = askChoices(seen, a.query);
    }
    try { await rest.autocomplete(a.id, a.token, choices); }
    catch (e) { out('discord: could not answer the picker — ' + (e as Error).message); }
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
      /**
       * ★ A MESSAGE THAT OPENS BY NAMING AN AGENT IS AN ASK, AND GOES THROUGH `ask()`.
       *
       * Not a second writer: the same function `/workspace ask` calls, so the addressing triple,
       * the write-eligibility refusal, the notice to an absent host and the re-resolution against
       * the delegator's own pod are all the ones already tested. What differs is only how the
       * name arrived — typed at the start of a sentence instead of chosen from a picker.
       *
       * ★ AND THE WHOLE LINE IS WHAT GETS RECORDED. `task` is the text that lands in the entry, so
       * it is `msg.content` and not the remainder after the name: the person typed "Claude
       * Desktop, do X", and a record holding only "do X" would be this bot editing their words on
       * their own pod.
       *
       * ★ A CANDIDATE THAT MATCHES NOBODY IS NOT AN ERROR. `addressedText` only proposes; when no
       * delegate answers to the name the message is recorded as an ordinary one, silently, exactly
       * as if this had never looked. That fallback is what lets the form be usable without being
       * dangerous — "Yes, do that" costs nothing.
       */
      /**
       * ★ A REPLY IS ADDRESSING, AND IT OUTRANKS NOTHING — IT ONLY FILLS IN WHAT WAS NOT TYPED.
       *
       * Discord's reply is the gesture people actually reach for, and it was the one this bot
       * could not read: a follow-up to a delegate's answer arrived indistinguishable from any
       * other sentence and was filed as an ordinary entry addressed to nobody. `spokenBy` knows
       * which message was which agent, so the name comes from context instead of being retyped.
       *
       * ★ A TYPED NAME STILL WINS. Someone who replies to one agent while writing "Claude Desktop,
       * ..." means the one they named — reading the reference over their words would be this bot
       * deciding it knows better. So the explicit form is consulted first and this is the default.
       *
       * ★ AND IT ROUTES THROUGH THE SAME `ask()`, so a reply to an agent that has since been
       * revoked, or that cannot append here, gets the same refusal every other path gets. Nothing
       * about being a reply grants anything: it supplies a candidate, and the delegator's own pod
       * remains the only thing that decides.
       */
      const typed = addressedText(msg.content);
      const repliedTo = typed.spec ? null : spokenBy.agentFor(msg.replyToId);
      const addressed = typed.spec ? typed : { spec: repliedTo, rest: msg.content };
      if (addressed.spec) {
        const out = await session.call((c) => ask(deps(c), {
          threadId: msg.channelId, discordUserId: msg.authorId,
          spec: addressed.spec as string, task: msg.content,
        }));
        if (out.kind === 'asked') {
          if (out.descriptorUrl) {
            watcher.noteAsk({
              threadId: msg.channelId, descriptorUrl: out.descriptorUrl, seq: out.accepted.seq,
              targetPod: out.target.pod, targetAgentId: out.target.agentId,
              targetName: out.target.name ?? out.target.agentId,
              askedAtMs: Date.now(),
              presenceAtAsk: presenceLine(out.target.presence),
            });
          }
          await say(msg.channelId, renderAsk(out));
          return;
        }
        // ★ TWO OUTCOMES ARE WORTH A REPLY AND THE REST ARE NOT. A name matching SEVERAL delegates,
        // or one whose pod will not let it publish, are real attempts that produced no ask and the
        // person has to know. `no-match` is not: it is far likelier that a sentence merely opened
        // with a capitalised word, and answering every one of those would make the channel
        // unusable. Both of the reported cases wrote nothing, and `renderAsk` says so.
        if (out.kind === 'ambiguous' || out.kind === 'target-cannot-append') {
          await say(msg.channelId, renderAsk(out));
          return;
        }
      }
      const res = await session.call((c) => recordMessage(deps(c), {
        threadId: msg.channelId, discordUserId: msg.authorId, text: msg.content,
      }));
      await say(msg.channelId, renderRecord(res));
    }).catch((e: unknown) => { out('recording failed for message ' + msg.id + ': ' + ((e as Error)?.stack ?? String(e))); });
  };

  const exit = boot.exit ?? ((code: number) => { process.exit(code); });

  const gateway = new DiscordGateway(token, {
    onMessage,
    onInteraction: (i) => { void onInteraction(i); },
    onAutocomplete: (a) => { void onAutocomplete(a); },
    onNotice: (l) => {
      out('gateway: ' + l);
      // ★ THE BOOT PROOF, AND IT IS THE GATEWAY'S OWN READY RATHER THAN A REST CALL. It used to be
      // "commands registered", which proves both credentials work and says NOTHING about whether
      // the bot is reachable from Discord — the exact gap the outage lived in, where every boot
      // line was present and the socket was gone. `tools/railway-services.mjs` looks for the string
      // below, so a deploy is not called verified until Discord has said READY to this container.
      if (l.startsWith('gateway ready as')) out('discord: bot online — ' + l.slice('gateway ready as '.length));
    },
    onFatal: (why) => {
      out('gateway FATAL: ' + why);
      // ★ EVERYTHING IS TORN DOWN AND THE PROCESS LEAVES NON-ZERO. Stopping the gateway alone left
      // the watcher's ref'd poll intervals running, so a bot that had given up on Discord would
      // keep reading pods forever with `exitCode` set and no exit ever happening. Railway restarts
      // a non-zero exit and ignores a zero one, so this code is the whole signal.
      watcher.stop();
      gateway.stop();
      exit(1);
    },
  }, boot.openSocket);
  gateway.connect();
  // ★ THE PRODUCER, AND THE BOT HAD NONE. Before this the only `setInterval` in the whole program
  // was the gateway heartbeat: an agent could read the channel, think on its own human's
  // subscription and append a signed answer to its own human's pod, and Discord would never show
  // it. Somebody had to type `/workspace show` and happen to look. A channel where half the
  // participants are agents and the agents are invisible is not a channel they are in.
  watcher.start();

  const install = boot.installSignalHandler ?? ((sig, handler) => { process.on(sig, handler); });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    install(sig, () => { out('shutting down on ' + sig); watcher.stop(); gateway.stop(); process.exit(0); });
  }

  // ★ THE BACKSTOP FOR THE WHOLE CLASS OF FAULT — see `Boot.onIdle`. Installed HERE and not at the
  // top of `main`, because `--register-commands-only` returns above and is supposed to end.
  const onIdle = boot.onIdle ?? ((handler: () => void) => { process.on('beforeExit', handler); });
  onIdle(() => {
    out('FATAL: the event loop emptied while this bot was supposed to be running. Nothing was holding '
      + 'the process open — no gateway socket, no pending reconnect, no watch — so Node was about to exit ZERO '
      + 'and Railway, whose restart policy is ON_FAILURE, would have left the deployment green with no container '
      + 'behind it. Exiting non-zero instead so the platform restarts this worker.');
    exit(1);
  });

  return { gateway, identity, store, watcher };
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
