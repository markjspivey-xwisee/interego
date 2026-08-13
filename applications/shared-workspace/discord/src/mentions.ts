/**
 * `@Claude Desktop` — ADDRESSING AN AGENT THE WAY DISCORD ADDRESSES ANYBODY.
 *
 * ── WHY THE OTHER THREE WERE NOT THIS ────────────────────────────────────────
 *
 * A picker, a reply and a context menu all work, and none of them is what a person does when they
 * want to talk to somebody in Discord. Two of the three act on a MESSAGE, so they need the agent
 * to have spoken first. The third — typing a name at the start of a sentence — is a text heuristic
 * that has to guess where a name ends and prose begins, and it guesses conservatively enough to
 * refuse things that were meant as asks.
 *
 * A mention has none of those properties. It autocompletes as you type `@`, it renders as a chip
 * so the channel SHOWS who was addressed, it cannot be misspelled, and it arrives as an id Discord
 * resolved before the bot saw the message. There is no parsing to get wrong.
 *
 * ── WHY A ROLE ───────────────────────────────────────────────────────────────
 *
 * ★ ONLY USERS AND ROLES ARE MENTIONABLE. An agent is not a Discord user and a webhook post shows
 * a name without being addressable, so the only object that can carry an agent's name into `@`
 * autocomplete is a role. That is the whole of why this file exists — it is a Discord limitation
 * being worked with, not a model of anything.
 *
 * ★ THE ROLE GRANTS NOTHING AND CONTAINS NOBODY. Permissions `0`, not hoisted, no members ever
 * added. A role ping notifies its members and this one has none, so `@Claude Desktop` notifies no
 * human. It is a NAME Discord will resolve and nothing else — the agent's authority lives on its
 * delegator's pod, and a Discord object could not confer any of it.
 *
 * ★ AND IT IS NOT AUTHORITATIVE ABOUT WHO MAY BE ASKED. What a mention yields is a NAME, handed to
 * the same `resolveTarget` the picker uses, which reads the live roster off the pods. A role left
 * behind after a delegation is revoked resolves to nothing and the ask is refused — the stale
 * Discord object cannot outlive the authority, because it never carried any.
 *
 * ── WHY IT IS OPT-IN ─────────────────────────────────────────────────────────
 *
 * Creating roles in somebody's server is intrusive and needs MANAGE_ROLES, which an operator may
 * deliberately not have granted. Nothing here happens on its own: `/workspace mentions` is run by
 * a person who wants it, and the failure to hold the permission is REPORTED rather than retried
 * silently.
 */

import type { DiscordRest } from './discord.js';

/**
 * The prefix every agent role carries.
 *
 * ★ SO THE BOT CAN TELL ITS OWN ROLES FROM A SERVER'S. Without it, a server that already has a
 * role called "Scribe" would have that role treated as an agent handle — and worse, a role
 * somebody uses for real permissions could be matched by an agent's name and then mentioned by
 * anyone expecting to reach an agent. The prefix is visible on purpose: a person reading the
 * member list should be able to see which roles this bot made.
 */
export const AGENT_ROLE_PREFIX = 'agent ';

/** Discord's own bound on a role name. */
const ROLE_NAME_MAX = 100;

/** The role name for an agent, or null when no usable one can be formed. */
export function agentRoleName(agentName: string | null): string | null {
  const raw = (agentName ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  return (AGENT_ROLE_PREFIX + raw).slice(0, ROLE_NAME_MAX);
}

/** The agent name a role stands for, or null when the role is not one of this bot's. */
export function agentNameFromRole(roleName: string | null | undefined): string | null {
  const raw = (roleName ?? '').trim();
  if (!raw.toLowerCase().startsWith(AGENT_ROLE_PREFIX)) return null;
  const name = raw.slice(AGENT_ROLE_PREFIX.length).trim();
  return name || null;
}

export interface RoleRow { readonly id: string; readonly name: string }

/** Roles as this bot reads them, narrowed from Discord's payload. */
export function roleRows(raw: readonly Record<string, unknown>[]): readonly RoleRow[] {
  return raw
    .filter((r) => typeof r['id'] === 'string' && typeof r['name'] === 'string')
    .map((r) => ({ id: r['id'] as string, name: r['name'] as string }));
}

/**
 * Which agent — by NAME — a message's mentioned roles stand for.
 *
 * ★ A NAME, NOT AN AGENT. This deliberately stops at the string on the role and hands it to the
 * same resolver the picker and the typed form use, which reads the live roster from the pods. A
 * mention is a convenient way to SAY a name; it establishes nothing about whether that agent
 * exists, is still delegated, or may write here.
 *
 * ★ AND SEVERAL MENTIONS ARE REFUSED RATHER THAN RANKED. A message naming two agents is a person
 * asking two things or being unclear, and picking the first would put work on one pod while the
 * channel showed two names. Returning null lets it be recorded as an ordinary message, which is
 * what it looks like.
 */
export function mentionedAgentName(
  mentionedRoleIds: readonly string[],
  roles: readonly RoleRow[],
): string | null {
  const byId = new Map(roles.map((r) => [r.id, r.name]));
  const names = mentionedRoleIds
    .map((id) => agentNameFromRole(byId.get(id)))
    .filter((n): n is string => n !== null);
  return names.length === 1 ? (names[0] as string) : null;
}

export type MentionSync =
  | { readonly kind: 'synced'; readonly created: readonly string[]; readonly already: readonly string[] }
  | { readonly kind: 'no-permission'; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * Ensure a mentionable role exists for each named agent. Existing ones are left exactly as they
 * are — including any colour or position somebody chose, which is theirs and not this bot's.
 */
export async function syncAgentRoles(
  rest: Pick<DiscordRest, 'listRoles' | 'createRole'>,
  args: { readonly guildId: string; readonly agentNames: readonly string[] },
): Promise<MentionSync> {
  let existing: readonly RoleRow[];
  try { existing = roleRows(await rest.listRoles(args.guildId)); }
  catch (e) { return { kind: 'error', error: e }; }

  const have = new Set(existing.map((r) => r.name.toLowerCase()));
  const created: string[] = [];
  const already: string[] = [];
  for (const agentName of args.agentNames) {
    const roleName = agentRoleName(agentName);
    if (!roleName) continue;
    if (have.has(roleName.toLowerCase())) { already.push(agentName); continue; }
    try { await rest.createRole(args.guildId, roleName); created.push(agentName); }
    catch (e) {
      // ★ 403 IS AN ANSWER ABOUT THIS SERVER, NOT A FAILURE OF THE FEATURE. An operator who has
      // not granted MANAGE_ROLES gets told exactly that, once, instead of a stack trace — and
      // every other way of addressing an agent keeps working.
      const msg = (e as Error)?.message ?? String(e);
      if (/HTTP 403/.test(msg)) {
        return {
          kind: 'no-permission',
          why: 'this bot does not have Manage Roles in this server, so it cannot create a mentionable '
            + 'name for an agent. Grant it in Server Settings → Roles, or keep using `/workspace ask`, '
            + 'a reply, or right-click → Apps → Ask this agent — none of those need it.',
        };
      }
      return { kind: 'error', error: e };
    }
  }
  return { kind: 'synced', created, already };
}
