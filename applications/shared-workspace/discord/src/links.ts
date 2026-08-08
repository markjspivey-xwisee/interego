/**
 * THE BOT'S INDEX, AND IT IS NOT THE RECORD.
 *
 * Two maps and a set of short-lived secrets:
 *   · Discord user  -> the pod they proved control of
 *   · Discord thread -> the pod that convenes the workspace started in it
 *   · a pending link challenge, in memory only
 *
 * ★ NOTHING HERE IS AUTHORITATIVE AND LOSING ALL OF IT LOSES NOTHING. A workspace is five
 * documents on the convener's pod and two per member on theirs; the entries are on the authors'
 * pods, content-addressed and chained. Delete this file and every one of those still resolves,
 * still verifies, and still folds — you would only have to tell the bot which pod convenes which
 * thread again. That is the whole claim the bot is making, so its own store had better not be
 * load-bearing, and this one is not: `slugFor` derives the workspace slug from the Discord thread
 * id alone, so `<relay>/ns/<convener pod>/d-<thread id>` is reconstructible from two facts a
 * human can read off the screen.
 *
 * ★ AND THERE IS NO SECRET HERE, WHICH IS THE SECOND DESIGN AND NOT THE FIRST.
 *
 * The first design minted a one-time code, told one Discord user, and asked them to put it in
 * the `label` of their own `register_agent` call — possession of the code plus control of the
 * pod being the binding. `tests/workspace-client-delegation.test.ts` was written to assert that
 * the code never appeared in a rendered verdict, and it failed: the label came back inside the
 * verdict's `row`. Chasing that turned up the real defect, which is not about rendering at all.
 *
 * A DELEGATION ROW IS WORLD-READABLE. `get_pod_status { pod_name: <anyone's> }` answers for any
 * pod and returns `delegationRegistry.rows` with the labels in them — measured live. So the
 * instant the honest user publishes the code, the code is public, and anybody who can guess or
 * scan for that pod can race them to `/workspace link-confirm` and bind THEIR Discord account to
 * that pod. The victim then gets "already claimed" and the attacker's messages land on the
 * victim's pod under the victim's WebID. That is a record falsely attributed, which is worse
 * than no record — the one outcome this bot must not produce.
 *
 * ★ SO THE LABEL IS NOT A SECRET, IT IS THE CLAIM ITSELF: `discord-link <discord user id>`. The
 * pod owner writes, in a document only they can write, "I authorise this agent on behalf of
 * Discord account U". A reader learns nothing they did not already know — a Discord id is public
 * — and it is useless to them, because {@link challengeLabel} is computed from the id of the
 * account actually running the confirm. To bind pod P to account A, somebody must control P AND
 * be A. Nothing expires, nothing leaks, and there is nothing to race.
 *
 * The per-user record below is therefore a RATE LIMIT and an intent marker, not a credential.
 * It stays in memory anyway: it is worth nothing, and writing worthless state to disk is how a
 * file that is safe to lose grows a reason not to lose it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { POD_RX, SLUG_RX } from '@interego/workspace-client';
import { SNOWFLAKE_RX, challengeLabel } from './link-plan.js';

/**
 * ★ RE-EXPORTED, NOT DEFINED, AND NOW FROM THE RIGHT SIDE OF THE LAYERING. Both lived in
 * `@interego/workspace-client` because the desktop app became a second publisher of this row and a
 * copy of {@link challengeLabel} in the shell would make its own warning come true — "two format
 * sites is how a link flow comes to reject every honest user". That was the right instinct and the
 * wrong destination: it put a Discord snowflake regex inside the shared-workspace client, which
 * every surface of that vertical bundles and none of which should have to know Discord exists.
 * They are in `./link-plan.ts` now, in the conduit that IS the Discord one, and the desktop shell
 * depends on THIS package for them. Still one site.
 */
export { SNOWFLAKE_RX, challengeLabel };

/** A pod this bot has been shown control of. */
export interface Link {
  readonly discordUserId: string;
  readonly pod: string;
  /** The WebID that pod's own registry reported when the binding was made. */
  readonly webId: string;
  readonly boundAt: string;
  /** What the relay said it would enforce at binding time. A record of the moment, not a claim about now. */
  readonly scopeAtBinding: string | null;
  readonly basisAtBinding: string | null;
}

/** A thread somebody ran `/workspace start` in. */
export interface ThreadBinding {
  readonly threadId: string;
  readonly convenerPod: string;
  readonly workspace: string;
  readonly slug: string;
  readonly title: string;
  readonly startedAt: string;
  readonly startedBy: string;
}

/** An outstanding link attempt. A rate limit, not a credential — see the header. */
export interface Challenge {
  readonly discordUserId: string;
  readonly issuedAt: number;
  attempts: number;
}

/** How long one `/workspace link` licenses confirms for. Long enough to switch apps and back. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** How many pods may be tried per `/workspace link`. Bounds a spammer's cross-pod reads. */
export const CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * The workspace slug for a thread, DERIVED rather than stored.
 *
 * A Discord thread id is a snowflake — digits, at most 20 of them — so `d-<id>` is at most 22
 * characters and always satisfies {@link SLUG_RX}. Deriving it means the workspace IRI can be
 * rebuilt from the thread and the convener's pod with nothing out of this file.
 */
export function slugFor(threadId: string): string | null {
  if (!SNOWFLAKE_RX.test(threadId)) return null;
  const slug = 'd-' + threadId;
  return SLUG_RX.test(slug) ? slug : null;
}

interface Persisted {
  readonly version: 1;
  readonly links: readonly Link[];
  readonly threads: readonly ThreadBinding[];
}

/**
 * Where the index lives. NEVER in the repo, and said out loud rather than defaulted quietly
 * into the working directory, where a `git add .` would commit it.
 */
export const defaultStatePath = (): string =>
  process.env['INTEREGO_DISCORD_STATE'] ?? join(homedir(), '.interego', 'discord-workspace.json');

export class LinkStore {
  private readonly path: string;
  private links = new Map<string, Link>();
  private threads = new Map<string, ThreadBinding>();
  /** In memory only. See the header. */
  private readonly challenges = new Map<string, Challenge>();
  private readonly now: () => number;

  constructor(path?: string, now: () => number = Date.now) {
    this.path = path ?? defaultStatePath();
    this.now = now;
    this.load();
  }

  get file(): string { return this.path; }

  private load(): void {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch { return; }              // a store that does not exist yet is not a failure
    // ★ A CORRUPT STORE THROWS RATHER THAN STARTING EMPTY. Starting empty would tell every
    // linked participant they are not linked and re-seat them from scratch on a pod that already
    // has their documents — a workspace that quietly forgot who was in it.
    const parsed = JSON.parse(raw) as Persisted;
    if (parsed.version !== 1) throw new Error('the link store at ' + this.path + ' is version ' + String(parsed.version) + ', which this build does not read.');
    for (const l of parsed.links ?? []) if (POD_RX.test(l.pod) && SNOWFLAKE_RX.test(l.discordUserId)) this.links.set(l.discordUserId, l);
    for (const t of parsed.threads ?? []) if (POD_RX.test(t.convenerPod) && SNOWFLAKE_RX.test(t.threadId)) this.threads.set(t.threadId, t);
  }

  /**
   * Atomic write, owner-only.
   *
   * `writeFileSync` straight onto the live path leaves a truncated file if the process dies
   * mid-write, and the loader above deliberately throws on one — so the crash would take the
   * bot down on its next start rather than at the moment of the crash, which is the hardest
   * version of this failure to diagnose.
   */
  private save(): void {
    const body: Persisted = { version: 1, links: [...this.links.values()], threads: [...this.threads.values()] };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // ── links ────────────────────────────────────────────────────────────────
  linkOf(discordUserId: string): Link | null { return this.links.get(discordUserId) ?? null; }

  /** Every Discord user currently bound to this pod. Used to refuse a second claimant. */
  claimantsOf(pod: string): readonly string[] {
    return [...this.links.values()].filter((l) => l.pod === pod).map((l) => l.discordUserId);
  }

  /**
   * ★ THE WRITE PATH VALIDATES WHAT THE READ PATH FILTERS. `load` drops any row whose pod or
   * user id is not the shape this store writes — a defence against a hand-edited file — and
   * `bind` used to accept anything. So a malformed id lived in memory, answered `linkOf`, and
   * vanished on the next start: the bot would record somebody's messages all afternoon and stop
   * knowing who they were after a restart. Refused here instead, loudly, as the programming
   * error it would be.
   */
  bind(link: Link): void {
    if (!SNOWFLAKE_RX.test(link.discordUserId)) throw new Error('not a Discord user id: ' + link.discordUserId);
    if (!POD_RX.test(link.pod)) throw new Error('not a pod identifier: ' + link.pod);
    this.links.set(link.discordUserId, link);
    this.save();
  }

  unbind(discordUserId: string): Link | null {
    const had = this.links.get(discordUserId) ?? null;
    if (had) { this.links.delete(discordUserId); this.save(); }
    return had;
  }

  // ── threads ──────────────────────────────────────────────────────────────
  threadOf(threadId: string): ThreadBinding | null { return this.threads.get(threadId) ?? null; }

  /** Same reason as {@link bind}: what `load` would drop must never be accepted here. */
  bindThread(t: ThreadBinding): void {
    if (!SNOWFLAKE_RX.test(t.threadId)) throw new Error('not a Discord channel id: ' + t.threadId);
    if (!POD_RX.test(t.convenerPod)) throw new Error('not a pod identifier: ' + t.convenerPod);
    this.threads.set(t.threadId, t);
    this.save();
  }

  // ── link attempts ────────────────────────────────────────────────────────
  /** Replaces any outstanding attempt record for this user. */
  issue(discordUserId: string): Challenge {
    const c: Challenge = { discordUserId, issuedAt: this.now(), attempts: 0 };
    this.challenges.set(discordUserId, c);
    return c;
  }

  /** The live record, or null when there is none or it has expired. Expiry is enforced here. */
  challengeOf(discordUserId: string): Challenge | null {
    const c = this.challenges.get(discordUserId);
    if (!c) return null;
    if (this.now() - c.issuedAt > CHALLENGE_TTL_MS) { this.challenges.delete(discordUserId); return null; }
    return c;
  }

  /** Count one attempt; returns false once the cap is spent, and burns the code when it is. */
  spendAttempt(discordUserId: string): boolean {
    const c = this.challengeOf(discordUserId);
    if (!c) return false;
    c.attempts++;
    if (c.attempts >= CHALLENGE_MAX_ATTEMPTS) { this.challenges.delete(discordUserId); }
    return true;
  }

  burn(discordUserId: string): void { this.challenges.delete(discordUserId); }
}
