/**
 * DISCORD'S LIMITS ON THE COMMAND TREE, WHICH ARE FATAL AT BOOT RATHER THAN COSMETIC.
 *
 * ── ★★ WHAT THIS COST ───────────────────────────────────────────────────────
 *
 * Registration is ONE PUT of the whole tree. Discord validates all of it and rejects all of it: a
 * single over-long description returns
 *
 *   400 Invalid Form Body · code 50035 · options.0.options.0.description ·
 *   BASE_TYPE_BAD_LENGTH "Must be between 1 and 100 in length."
 *
 * and the bot treats that as FATAL and exits. So the failure is not "that option is missing", it is
 * "the bot is down and every command is gone" — and it happens on the deployed instance, at
 * startup, minutes after a deploy that reported success. A 107-character description on the new
 * `private:` option did exactly that.
 *
 * Nothing could have caught it: `commandFingerprint` compares the tree to itself, the typecheck
 * sees a string, and no test had ever opened these strings. This walks the tree Discord is actually
 * sent and applies Discord's own limits to it.
 *
 * ── ★ WHY THE WHOLE TREE AND NOT JUST THE NEW OPTION ────────────────────────
 *
 * The limit applies at every depth — command, subcommand, and option, at any nesting. A guard that
 * only checked the level where it last went wrong would pass the next time it goes wrong one level
 * down, which is precisely where it went wrong this time.
 */

import { describe, it, expect } from 'vitest';
import { COMMANDS, COMMAND_TEXT_MAX, safePath } from '../src/discord.js';

interface Node { name?: string; description?: string; options?: readonly Node[]; type?: number }

/**
 * Every command, subcommand and option, with the path Discord would name in its error.
 *
 * ★★ DEPTH IS CARRIED BECAUSE `type` MEANS TWO DIFFERENT THINGS. At the top level it is the
 * COMMAND type — 1 CHAT_INPUT (the default when absent), 2 USER, 3 MESSAGE. Inside `options` it is
 * the OPTION type — 1 SUB_COMMAND, 2 SUB_COMMAND_GROUP, 3 STRING, 5 BOOLEAN. The numbers collide,
 * and the first version of this guard read a top-level `type: 3` (a MESSAGE context-menu command,
 * whose name is a human label like "Ask this agent") as if it were a STRING option, and demanded a
 * lowercase name. A guard that misreads the schema it is guarding fails honest code and teaches
 * people to weaken it.
 */
function walk(nodes: readonly Node[], at = '', depth = 0): { path: string; node: Node; depth: number }[] {
  const out: { path: string; node: Node; depth: number }[] = [];
  nodes.forEach((n, i) => {
    const path = at ? at + '.options.' + i + '(' + String(n.name) + ')' : String(n.name);
    out.push({ path, node: n, depth });
    if (Array.isArray(n.options)) out.push(...walk(n.options, path, depth + 1));
  });
  return out;
}

/** A top-level USER (2) or MESSAGE (3) command: its NAME is the menu label a person reads. */
const isContextMenu = (x: { node: Node; depth: number }): boolean =>
  x.depth === 0 && (x.node.type === 2 || x.node.type === 3);

describe("Discord's own limits on the tree this bot registers", () => {
  const all = walk(COMMANDS as readonly Node[]);

  it('★ the walk actually reaches the nested options, or every check below is vacuous', () => {
    // The exact non-vacuity trap this file exists inside: a walk that stopped at the top level
    // would pass forever while the thing that broke lives two levels down.
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((x) => x.path.includes('.options.'))).toBe(true);
    // The option that caused this: `workspace` → `start` → `private`.
    expect(all.some((x) => x.node.name === 'private')).toBe(true);
  });

  it('★★ every description is within 1 and 100 characters', () => {
    for (const { path, node } of all) {
      if (node.description === undefined) continue;
      expect(node.description.length, path + ' — a description Discord rejects takes the WHOLE bot down at boot, '
        + 'not just this option: ' + JSON.stringify(node.description)).toBeGreaterThan(0);
      expect(node.description.length, path + ' is ' + node.description.length + ' characters; Discord allows '
        + COMMAND_TEXT_MAX + '. Registration is one PUT of the entire tree, so this returns 400 and the bot exits: '
        + JSON.stringify(node.description)).toBeLessThanOrEqual(COMMAND_TEXT_MAX);
    }
  });

  it('★ every name is present and within 32 characters', () => {
    // The other BASE_TYPE_BAD_LENGTH rejections in the same 400, failing the same fatal way.
    for (const { path, node } of all) {
      expect(typeof node.name, path + ' has no name').toBe('string');
      expect(String(node.name).length, path + ' name length').toBeGreaterThan(0);
      expect(String(node.name).length, path + ' name is over 32 characters').toBeLessThanOrEqual(32);
    }
  });

  it('★ chat-input names are lowercase — and context-menu labels are exempt, because they are labels', () => {
    for (const x of all) {
      if (isContextMenu(x)) continue;
      expect(String(x.node.name), x.path + ' — Discord refuses an uppercase name on a chat-input command or option')
        .toBe(String(x.node.name).toLowerCase());
    }
    // Non-vacuity in BOTH directions: there is at least one of each kind, so neither branch is
    // being skipped entirely while the test reports green.
    expect(all.some(isContextMenu), 'no context-menu command found — the exemption is untested').toBe(true);
    expect(all.some((x) => !isContextMenu(x)), 'no chat-input node found — the rule is untested').toBe(true);
  });

  it('★★ chat-input commands and subcommands carry a description; context-menu commands must NOT', () => {
    for (const x of all) {
      if (isContextMenu(x)) {
        // Discord returns 400 for a description on a USER/MESSAGE command — the opposite error,
        // equally fatal, and the reason this is asserted rather than left to "descriptions are
        // good".
        expect(x.node.description, x.path + ' is a context-menu command; Discord rejects a description on one')
          .toBeUndefined();
        continue;
      }
      const needsOne = x.depth === 0 || x.node.type === 1 || x.node.type === 2;
      if (!needsOne) continue;
      expect(typeof x.node.description, x.path + ' is a command or subcommand with no description').toBe('string');
    }
  });
});

describe('★★ a webhook token never reaches a log line', () => {
  /**
   * FOUND LIVE, in a deployment log: a 400 on an over-long message printed
   * `POST /webhooks/<id>/<token>?wait=true` verbatim, because the error message was the request
   * path. A webhook token is enough to post into the channel AS ANY PERSONA — the exact
   * impersonation this bot's authorship rules exist to prevent — and a log has a different and
   * wider audience than the bot's own secrets.
   */
  it('redacts the token out of a webhook path, and keeps the id', () => {
    expect(safePath('/webhooks/1537078937832792094/WpZm8RiJEwwpyhJWOpE8XdPb65K')).
      toBe('/webhooks/1537078937832792094/<token>');
    // The query string is where `?wait=true` lives and must survive; the token before it must not.
    const q = safePath('/webhooks/123/SECRETTOKEN?wait=true');
    expect(q).toBe('/webhooks/123/<token>?wait=true');
    expect(q).not.toContain('SECRETTOKEN');
    // A message edit addresses a message UNDER the token, so the token is mid-path, not trailing.
    expect(safePath('/webhooks/123/SECRETTOKEN/messages/@original'))
      .toBe('/webhooks/123/<token>/messages/@original');
  });

  it('★ leaves every other path exactly as it was', () => {
    // A redactor that mangled ordinary paths would make every other failure harder to read.
    for (const p of ['/channels/999/messages', '/applications/1/commands', '/users/@me']) {
      expect(safePath(p)).toBe(p);
    }
  });
});
