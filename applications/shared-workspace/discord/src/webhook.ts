/**
 * MAKING AN AGENT LOOK LIKE A PARTICIPANT, WITHOUT LETTING IT BECOME A FORGERY.
 *
 * A delegate's words used to arrive as a quotation inside a message from the bot. That is honest
 * and it reads as reported speech — the agent is discussed rather than present. A Discord webhook
 * can post under a chosen name and avatar, so the same words can appear as their own speaker.
 *
 * ── WHAT IS REAL HERE AND WHAT IS DECORATION ─────────────────────────────────
 *
 * ★ THE NAME IS DECORATION. Discord cannot verify it; this bot is the writer either way, and a
 * webhook name is a string in a POST body. Anyone reading it as proof would be reading a claim
 * this bot made about a record, not the record.
 *
 * ★ SO THE PROVENANCE TRAVELS WITH EVERY MESSAGE and is not traded away for the nicer frame. The
 * three things that can disagree — whose KEY signed the bytes, what FOOTING this particular
 * message was on, and whether the delegator's pod authorises the agent at all — are stated on
 * each post, exactly as they were inside the bracket before. The frame got friendlier; the claims
 * did not get weaker.
 *
 * ★ AND A NAME IS ONLY EVER USED FOR AN ENTRY WHOSE OWN KEY SIGNED IT. `EntryAuthorship`'s
 * `delegate` variant types its signer as `the-author` and nothing else, so `kind === 'delegate'`
 * IS the proof — the compiler enforces what a comment would only promise. Everything else — a
 * disputed entry, an unstated author, a person's own words relayed by a conduit — keeps the bot's
 * own format, because those are precisely the cases where a confident name would mislead.
 *
 * ── THE ONE ATTACK WORTH NAMING ──────────────────────────────────────────────
 *
 * A display name that could be chosen by a participant would let somebody post as anybody. It
 * cannot be: the name comes from the delegate's row in its delegator's own registry, a document
 * only that pod's owner can write, read back by this bot. What a person types never reaches it.
 */

import type { DiscordRest } from './discord.js';

/** Discord refuses these in a webhook username, and rejects the whole post if one appears. */
const FORBIDDEN = [/discord/i, /clyde/i, /^everyone$/i, /^here$/i];
const NAME_MAX = 80;

/**
 * A display name Discord will accept, derived from a name a pod published.
 *
 * ★ SANITISED RATHER THAN TRUSTED, because the source is a label on somebody else's pod. It is
 * not hostile input in the injection sense — `executeWebhook` sends JSON — but it is input, and a
 * label containing "discord" would make every post from that agent fail with a 400 that reads
 * like a bot outage. A name that cannot be made acceptable returns null, and the caller falls
 * back to the bot's own format rather than inventing one.
 */
export function displayName(name: string | null): string | null {
  const raw = (name ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').slice(0, NAME_MAX);
  if (FORBIDDEN.some((rx) => rx.test(cleaned))) return null;
  return cleaned;
}

/**
 * The channel's webhook, created once and reused.
 *
 * ★ ONE WEBHOOK FOR EVERY AGENT, not one each. The username is per-POST, so a webhook per agent
 * would be a Discord object per delegate — created, orphaned when a delegate is revoked, and
 * counted against the channel's limit of fifteen. One is enough and nothing has to be cleaned up.
 *
 * Reuses an existing one by name so a redeploy does not accumulate them; the id and token are
 * cached in memory, and a cache miss costs one list call.
 */
export class WebhookPoster {
  private readonly cache = new Map<string, { id: string; token: string }>();
  private readonly unavailable = new Set<string>();

  constructor(
    private readonly rest: DiscordRest,
    private readonly out: (line: string) => void,
    private readonly name = 'Interego agents',
  ) {}

  /**
   * Post as `who`, and return the id of the message that became — or null if it did not post.
   *
   * ★ NULL IS A REAL ANSWER AND THE CALLER MUST HANDLE IT. Webhook creation needs
   * MANAGE_WEBHOOKS, which an operator may simply not have granted. A bot that treated that as
   * fatal would go silent in a channel where the ordinary path works perfectly; the caller falls
   * back to its own format, so the words still arrive.
   *
   * ★ AND AN ID RATHER THAN A BOOLEAN, because "it posted" is not enough to be replied to. A
   * reply arrives naming a message id, so unless the bot remembers that this particular id WAS a
   * particular agent speaking, Discord's own gesture for "I am talking to you" reaches nobody.
   */
  async postAs(channelId: string, who: string, content: string): Promise<string | null> {
    if (this.unavailable.has(channelId)) return null;
    let hook = this.cache.get(channelId) ?? null;
    if (!hook) {
      try { hook = await this.resolve(channelId); }
      catch (e) {
        // Said once per channel: an operator needs to know the display is off and why, and does
        // not need it every 45 seconds.
        this.unavailable.add(channelId);
        this.out('discord: cannot post as an agent in ' + channelId + ' (' + ((e as Error)?.message ?? String(e))
          + '); agents will appear as quoted entries from this bot instead');
        return null;
      }
    }
    try {
      const sent = await this.rest.executeWebhook(hook.id, hook.token, { content, username: who });
      // `?wait=true` makes Discord answer with the message. A post that somehow arrives without
      // one still succeeded — it just cannot be replied to, which is reported as a null id rather
      // than as a failure to post.
      return typeof sent['id'] === 'string' ? sent['id'] : null;
    } catch (e) {
      this.out('discord: posting as ' + who + ' in ' + channelId + ' failed — ' + ((e as Error)?.message ?? String(e)));
      // The webhook may have been deleted underneath us; drop it so the next post re-resolves.
      this.cache.delete(channelId);
      return null;
    }
  }

  private async resolve(channelId: string): Promise<{ id: string; token: string }> {
    const existing = await this.rest.listWebhooks(channelId);
    const mine = existing.find((w) => w['name'] === this.name && typeof w['token'] === 'string');
    const use = mine ?? await this.rest.createWebhook(channelId, this.name);
    const id = String(use['id'] ?? '');
    const token = String(use['token'] ?? '');
    if (!id || !token) throw new Error('the webhook Discord returned carries no id or token');
    const hook = { id, token };
    this.cache.set(channelId, hook);
    return hook;
  }
}
