/**
 * GIVING A DELEGATE THE TOOLS ITS HUMAN ALREADY GRANTED IT — AND NOTHING ELSE.
 *
 * ── THIS IS NOT A NEW MCP SERVER ─────────────────────────────────────────────
 *
 * ★ IT IS THE RELAY, THE SAME ONE EVERYTHING ELSE IN THIS APP TALKS TO. The file written below
 * names `<relay>/mcp` — the endpoint the person's own `claude.ai interego` connector uses, the
 * same fifty tools. Nothing is built, deployed or maintained by this module. The ONLY thing that
 * differs from the human's own connector is which bearer sits in the header, and that difference
 * is the entire feature: with the DELEGATE's bearer the relay applies the DELEGATE's scope.
 *
 * ── WHY THE CEILING IS NOT IN THIS FILE ──────────────────────────────────────
 *
 * ★ NO TOOL LIST. `turnArgv` allows the SERVER (`mcp__interego`) rather than a set of tool names,
 * so what a delegate may actually do is decided where it was granted: the delegation row on its
 * delegator's pod, enforced by the relay on every call. A list here would be a second copy of an
 * authorization record — the exact mistake `delegates.ts` exists to prevent — and it would drift
 * the day somebody changed the grant. A capability added to the relay tomorrow is reachable with
 * no change here; one the delegator never granted is refused however this file is written.
 *
 * This is also why nothing was added to the substrate for any of it. The relay already
 * authenticates a delegate, already scopes it, and already speaks MCP. What was missing was
 * entirely in this shell: it spawned the model with `--tools ""`.
 *
 * ── WHAT THE FILE COSTS, STATED ──────────────────────────────────────────────
 *
 * ★ A BEARER IS WRITTEN TO DISK FOR THE LIFE OF ONE TURN. The CLI takes `--mcp-config` as a PATH,
 * so there is no way to hand it a credential in memory. It is written 0600 into a fresh
 * `mkdtemp` directory, and {@link withAgentTools} deletes the directory in a `finally` — so a
 * throw, a timeout, and a user pressing Stop all remove it. It is the delegate's bearer, not the
 * person's account: its blast radius is the delegation they granted, and it expires on its own.
 *
 * ★ AND IT IS PER TURN, NOT PER SESSION. A file that outlived the turn would be a credential
 * sitting in the temp directory of a laptop that may not be locked, for the sake of saving a
 * `writeFileSync`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnTools } from './modelprovider.js';

/** The prefix of the server key. The full name identifies the IDENTITY — see `serverNameFor`. */
export const AGENT_MCP_SERVER = 'interego';

/**
 * The config key for one delegate's session.
 *
 * ★ IT CARRIES THE IDENTITY, NOT JUST THE SERVICE, BECAUSE THE CLI CACHES BY NAME. Measured: a
 * turn whose config named the server plainly `interego` — the same name an earlier run had used
 * with a DIFFERENT bearer — came back `MCP server "interego" session expired` and could not call
 * anything, while the isolation flags all held. Two identities pointed at one endpoint under one
 * key, and the second inherited the first's dead session.
 *
 * That is not a caching quirk to work around; it is the same statement this vertical makes
 * everywhere. A session belongs to an agent, so the thing that names it must name the agent.
 */
export const serverNameFor = (delegatePod: string): string =>
  AGENT_MCP_SERVER + '-' + delegatePod.replace(/[^a-zA-Z0-9-]/g, '');

/**
 * Run `fn` with a config naming the relay under the delegate's own bearer, then delete it.
 *
 * The caller supplies the bearer because this module must not know how a delegate signs in —
 * `delegateSession` owns that, and it is the only thing that should.
 */
export async function withAgentTools<T>(
  args: { readonly relay: string; readonly bearer: string; readonly delegatePod: string },
  fn: (tools: TurnTools) => Promise<T>,
): Promise<T> {
  const server = serverNameFor(args.delegatePod);
  const dir = mkdtempSync(join(tmpdir(), 'interego-agent-'));
  try {
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        [server]: {
          type: 'http',
          // The relay this app is already pointed at. Not a second server, not a local one.
          url: args.relay.replace(/\/$/, '') + '/mcp',
          headers: { Authorization: 'Bearer ' + args.bearer },
        },
      },
    }), { mode: 0o600, encoding: 'utf8' });
    return await fn({ mcpConfigPath: path, server });
  } finally {
    // ★ IN A `finally`, so a throw, a timeout and a cancelled turn all remove the credential.
    rmSync(dir, { recursive: true, force: true });
  }
}
