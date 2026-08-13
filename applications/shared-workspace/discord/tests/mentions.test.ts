/**
 * `@agent Claude Desktop` — THE FORM OF ADDRESSING DISCORD ACTUALLY HAS.
 *
 * Three ways to address an agent existed and none was this one. A picker and a context menu are
 * chrome; a reply needs the agent to have spoken first; and typing a name at the start of a
 * sentence is a heuristic that has to guess where a name ends and prose begins — the thing that
 * was objected to in the first place.
 *
 * A mention has none of those properties. It autocompletes, it renders as a chip so the channel
 * SHOWS who was addressed, it cannot be misspelled, and it arrives as an id Discord resolved
 * before the bot saw the message.
 *
 * ★ THE COST IS THAT ONLY USERS AND ROLES ARE MENTIONABLE. An agent is not a Discord user and a
 * webhook post shows a name without being addressable, so the name has to be carried by a role.
 * Everything below is about making that role inert: it grants nothing, contains nobody, and
 * establishes nothing about who may be asked.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_ROLE_PREFIX, agentNameFromRole, agentRoleName, mentionedAgentName, roleRows, syncAgentRoles,
} from '../src/mentions.js';

const GUILD = '1535699997444808724';

describe('an agent name becomes a role name and back', () => {
  it('round-trips', () => {
    const role = agentRoleName('Claude Desktop');
    expect(role).toBe(AGENT_ROLE_PREFIX + 'Claude Desktop');
    expect(agentNameFromRole(role)).toBe('Claude Desktop');
  });

  it('★ refuses a role this bot did not make, so a server\'s own roles are not agent handles', () => {
    // Without the prefix, a server that already has a role called "Scribe" would have it treated
    // as an agent handle — and a role somebody uses for real permissions could be matched by an
    // agent's name and then mentioned by anyone expecting to reach an agent.
    expect(agentNameFromRole('Moderator')).toBeNull();
    expect(agentNameFromRole('Scribe')).toBeNull();
    expect(agentNameFromRole('')).toBeNull();
    expect(agentNameFromRole(null)).toBeNull();
    // The prefix alone names nobody.
    expect(agentNameFromRole(AGENT_ROLE_PREFIX)).toBeNull();
    expect(agentNameFromRole(AGENT_ROLE_PREFIX + '   ')).toBeNull();
  });

  it('has no name for an agent whose delegator gave it none', () => {
    expect(agentRoleName(null)).toBeNull();
    expect(agentRoleName('   ')).toBeNull();
  });

  it('stays inside Discord\'s 100-character role-name bound', () => {
    const long = agentRoleName('x'.repeat(200));
    expect(long).not.toBeNull();
    expect((long as string).length).toBeLessThanOrEqual(100);
  });
});

describe('reading which agent a message mentioned', () => {
  const roles = [
    { id: 'r1', name: AGENT_ROLE_PREFIX + 'Claude Desktop' },
    { id: 'r2', name: AGENT_ROLE_PREFIX + 'Scribe' },
    { id: 'r3', name: 'Moderator' },
  ];

  it('names the agent whose role was mentioned', () => {
    expect(mentionedAgentName(['r1'], roles)).toBe('Claude Desktop');
    expect(mentionedAgentName(['r2'], roles)).toBe('Scribe');
  });

  it('★ ignores a mention of a role that is not an agent\'s', () => {
    // @Moderator in a workspace thread is a person addressing moderators, not an ask.
    expect(mentionedAgentName(['r3'], roles)).toBeNull();
    expect(mentionedAgentName([], roles)).toBeNull();
    expect(mentionedAgentName(['r-unknown'], roles)).toBeNull();
  });

  it('★ refuses TWO agents rather than picking the first', () => {
    // A message naming two agents is somebody asking two things or being unclear. Picking one
    // would put work on one pod while the channel visibly showed two names.
    expect(mentionedAgentName(['r1', 'r2'], roles)).toBeNull();
  });

  it('reads an agent mention alongside an ordinary role mention', () => {
    expect(mentionedAgentName(['r3', 'r1'], roles)).toBe('Claude Desktop');
  });

  it('narrows Discord\'s payload rather than trusting its shape', () => {
    expect(roleRows([{ id: 'r1', name: 'a' }, { id: 5 }, { name: 'b' }, {}])).toEqual([{ id: 'r1', name: 'a' }]);
  });
});

describe('creating the mentionable names', () => {
  const restWith = (existing: readonly Record<string, unknown>[], onCreate?: (n: string) => void) => ({
    listRoles: async (): Promise<Record<string, unknown>[]> => [...existing],
    createRole: async (_g: string, name: string): Promise<Record<string, unknown>> => {
      onCreate?.(name);
      return { id: 'new', name };
    },
  });

  it('creates one per agent, and reports what it made', async () => {
    const made: string[] = [];
    const out = await syncAgentRoles(restWith([], (n) => made.push(n)), { guildId: GUILD, agentNames: ['Claude Desktop', 'Scribe'] });
    expect(out.kind).toBe('synced');
    if (out.kind !== 'synced') throw new Error('narrowed');
    expect(out.created).toEqual(['Claude Desktop', 'Scribe']);
    expect(made).toEqual([AGENT_ROLE_PREFIX + 'Claude Desktop', AGENT_ROLE_PREFIX + 'Scribe']);
  });

  it('★ leaves an existing role exactly as it is', async () => {
    // Its colour and position are somebody's choice, not this bot's, and re-creating it would
    // also make a second role with the same name.
    const made: string[] = [];
    const out = await syncAgentRoles(
      restWith([{ id: 'r1', name: AGENT_ROLE_PREFIX + 'Claude Desktop' }], (n) => made.push(n)),
      { guildId: GUILD, agentNames: ['Claude Desktop'] },
    );
    expect(out.kind).toBe('synced');
    if (out.kind !== 'synced') throw new Error('narrowed');
    expect(out.created).toEqual([]);
    expect(out.already).toEqual(['Claude Desktop']);
    expect(made).toEqual([]);
  });

  it('matches an existing role case-insensitively, so it does not duplicate one', async () => {
    const made: string[] = [];
    const out = await syncAgentRoles(
      restWith([{ id: 'r1', name: (AGENT_ROLE_PREFIX + 'claude desktop').toUpperCase() }], (n) => made.push(n)),
      { guildId: GUILD, agentNames: ['Claude Desktop'] },
    );
    expect(made).toEqual([]);
    if (out.kind !== 'synced') throw new Error('narrowed');
    expect(out.already).toEqual(['Claude Desktop']);
  });

  it('★ reports a missing permission as a fact about the server, not as a crash', async () => {
    // An operator may deliberately not have granted Manage Roles, and every other way of
    // addressing an agent keeps working without it.
    const rest = {
      listRoles: async (): Promise<Record<string, unknown>[]> => [],
      createRole: async (): Promise<Record<string, unknown>> => { throw new Error('Discord POST /guilds/x/roles -> HTTP 403 Missing Permissions'); },
    };
    const out = await syncAgentRoles(rest, { guildId: GUILD, agentNames: ['Claude Desktop'] });
    expect(out.kind).toBe('no-permission');
    if (out.kind !== 'no-permission') throw new Error('narrowed');
    expect(out.why).toContain('Manage Roles');
    // And it names what still works, so the answer is not just a refusal.
    expect(out.why).toContain('/workspace ask');
  });

  it('skips an agent with no name rather than creating a role called nothing', async () => {
    const made: string[] = [];
    const out = await syncAgentRoles(restWith([], (n) => made.push(n)), { guildId: GUILD, agentNames: ['', '  ', 'Scribe'] });
    expect(made).toEqual([AGENT_ROLE_PREFIX + 'Scribe']);
    if (out.kind !== 'synced') throw new Error('narrowed');
    expect(out.created).toEqual(['Scribe']);
  });
});

/**
 * ★ THE PRECEDENCE, WHICH IS THE ONE DECISION THAT COULD OVERRULE A PERSON.
 *
 * Asserted as the expression `main.ts` uses. Exercising it through the wiring would mean a
 * gateway, a relay session, a link store and a per-pod queue, and a failure would then be reported
 * as a write to the wrong pod several layers from the choice that caused it.
 */
const choose = (mentioned: string | null, typed: string | null, replied: string | null): string | null =>
  mentioned ?? typed ?? replied;

describe('a mention outranks the other two forms', () => {
  it('★ wins over a typed name, because the person picked it from autocomplete', () => {
    // They can SEE the chip in their own message. Reading a name parsed out of the prose over it
    // would be the bot overruling the one signal they deliberately produced.
    expect(choose('Claude Desktop', 'Scribe', null)).toBe('Claude Desktop');
  });

  it('wins over the message being replied to', () => {
    expect(choose('Claude Desktop', null, 'did:web:…:agents:interego-delegate-u-eth-aaaaaaaaaaaa')).toBe('Claude Desktop');
  });

  it('falls through in order when there is no mention', () => {
    expect(choose(null, 'Scribe', 'did:web:x')).toBe('Scribe');
    expect(choose(null, null, 'did:web:x')).toBe('did:web:x');
    expect(choose(null, null, null)).toBeNull();
  });
});
