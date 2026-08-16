/**
 * THE BOT'S OWN IDENTITY, AND IT IS THE ONLY CREDENTIAL THIS PROCESS EVER HOLDS.
 *
 * ★ WHAT IS NOT HERE, AND THAT IS THE DESIGN. There is no per-user token store, no OAuth
 * callback, no refresh-token rotation for anybody but this bot. A participant's pod is written
 * to under a DELEGATION they published on their own pod, not under a credential of theirs this
 * process kept — see `@interego/workspace-client/delegation` for the measurement, and the
 * README for why the alternative was rejected.
 *
 * ★ AND THE BEARER IS RE-MINTED, NOT REFRESHED. The desktop shell refreshes because a human
 * signed in once and is not there to do it again; the relay ROTATES the refresh token and
 * refuses the spent one, which is a whole state machine to get wrong unattended. This process
 * holds the key it signs with, so re-running the SIWE ceremony costs four HTTP round trips and
 * needs no state at all. One code path, and the failure mode of the other one — "renewed once,
 * then died an hour later with nobody watching" — cannot happen here.
 *
 * The key comes from the environment and is never written anywhere. See the README for what the
 * maintainer must supply.
 */

import { Wallet } from 'ethers';
import { RelayMcpTransport, WorkspaceClient, type RelayOAuthBearer } from '@interego/workspace-client';
// A separate entry point because it reaches node:crypto — see the note in the desktop's main.ts.
import { openerFor } from '@interego/workspace-client/opener';
import { deriveEncryptionKeyPair, type EncryptionKeyPair } from '@interego/core';
// ★ IMPORTED, NOT REPEATED. This SIWE ceremony already exists twice — `desktop/src/auth.ts` and
// this driver helper — and `tests/workspace-live-identity-parity.test.ts` pins the two message
// bodies against each other precisely because a third spelling of the same message is a bot that
// cannot sign in for a reason nobody can see. A relative import across the sibling directory is
// the price of there being one copy, and it is cheaper than the copy.
import { mintBearer, type Signer } from '../../tools/live-identity.js';

/** Re-mint this long before the grant expires. Enough slack for a cold relay. */
export const REMINT_MARGIN_MS = 5 * 60 * 1000;

/**
 * THE OAUTH CLIENT NAME THIS BOT SIGNS IN UNDER, AND IT IS NOT A LABEL.
 *
 * ★ MEASURED: THE RELAY PUTS THIS STRING INSIDE THE AGENT DID. `surfaceAgentFromClient` in
 * `deploy/mcp-relay/server.ts` slugifies `client_name` into a surface slug, and the identity
 * server mints `did:web:<identity host>:agents:<slug>-<pod>` from it. So this constant is not
 * cosmetic and it is not a display name: it IS the first half of the identifier every
 * participant pastes into `register_agent` and stores, world-readably, in their own pod's
 * delegation registry.
 *
 * ★ WHICH IS WHY IT IS NAMED HERE RATHER THAN DEFAULTED. `mintBearer`'s default is
 * `interego-workspace-live-driver` — the name of the throwaway DRIVERS in the sibling `tools/`
 * directory. This bot shipped under that default, so the deployed conduit's permanent identity
 * read as somebody's test harness. Changing it later is not a rename: every delegation already
 * published would name an agent the bot no longer signs in as, `checkDelegation` would refuse
 * every write, and every participant would have to re-publish. Change this string only with
 * that cost accepted.
 *
 * The pod is derived from the KEY, not from this, so it does not move.
 */
export const DISCORD_CLIENT_NAME = 'interego-discord';

export interface BotIdentity {
  readonly client: WorkspaceClient;
  /** The agent DID the relay authenticates this process as — what participants delegate. */
  readonly agentId: string;
  readonly pod: string;
  readonly address: string;
}

/**
 * A session that re-mints itself.
 *
 * `call` is the only way out: it re-mints when the grant is near its end AND when the relay
 * answers 401 mid-call. Exactly one retry after a re-mint — a second failure is the relay
 * saying something other than "your hour is up", and a write whose outcome is unknown must
 * never be repeated on a loop.
 */
export class BotSession {
  private readonly relay: string;
  private readonly identityServer: string;
  private readonly wallet: Signer;
  /**
   * This bot's own X25519 keypair and the opener built from it, derived ONCE at construction.
   *
   * ★ DERIVED HERE RATHER THAN IN `open()` so the raw private key is not kept as a second field
   * for the life of the process. `wallet` already holds it because signing needs it; nothing else
   * should.
   */
  private readonly encryption: EncryptionKeyPair;
  private readonly opener: ReturnType<typeof openerFor>;
  private transport: RelayMcpTransport | null = null;
  private bearer: RelayOAuthBearer | null = null;
  private identity: BotIdentity | null = null;
  /**
   * The HTTP the SIWE ceremony runs over. Defaults to the global one, so the program is
   * unchanged; it is a parameter so a test can observe WHICH OAuth client name this session
   * registers under without patching `globalThis.fetch`, which in a shared vitest realm leaks
   * into every other file in the run.
   */
  private readonly fetchImpl: typeof fetch;

  constructor(relay: string, identityServer: string, privateKey: string, fetchImpl?: typeof fetch) {
    this.relay = relay.replace(/\/$/, '');
    this.identityServer = identityServer.replace(/\/$/, '');
    this.wallet = new Wallet(privateKey);
    this.encryption = deriveEncryptionKeyPair(privateKey);
    this.opener = openerFor(privateKey);
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
  }

  get address(): string { return this.wallet.address; }

  /** Mint, connect, and resolve who the relay says this process is. */
  async open(): Promise<BotIdentity> {
    // ★ THE CLIENT NAME IS PASSED, NOT DEFAULTED. See `DISCORD_CLIENT_NAME`: the relay bakes it
    // into the agent DID, so omitting it here is what made this bot's permanent identity read
    // `interego-workspace-live-driver-…`.
    const bearer = await mintBearer(this.relay, this.identityServer, this.wallet, DISCORD_CLIENT_NAME, this.fetchImpl);
    this.bearer = bearer;
    this.transport = new RelayMcpTransport(this.relay, bearer, this.fetchImpl);
    const client = new WorkspaceClient(this.relay, this.transport);
    await client.connect();
    const status = await client.podStatus();
    const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
    const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
    const agent = status['sessionAgent'] as { id?: string; did?: string } | undefined;
    const agentId = agent?.did ?? agent?.id ?? '';
    if (!pod) throw new Error('get_pod_status answered without a pod URL this bot could turn into a pod name.');
    // ★ REFUSED RATHER THAN GUESSED. The agent DID is the string every participant is asked to
    // delegate and the string the relay's scope gate compares. A bot that started up without one
    // would hand out a link instruction naming an empty agent, and every delegation made from it
    // would authorise nothing while looking exactly like a delegation that worked.
    if (!agentId) throw new Error('get_pod_status reported no sessionAgent, so this bot has no agent identifier to ask anybody to delegate. Nothing was started.');

    /**
     * ★★ THE KEY THAT LETS THIS CONDUIT SEE A PRIVATE WORKSPACE AT ALL.
     *
     * Without it the bot cannot even read the workspace RECORD of a private workspace — the
     * eligibility check reads it, finds it withheld, and refuses with "this workspace is private
     * and you are not one of its members". So every private workspace was simply unusable from
     * Discord, which is not a policy anybody chose; it is what happens when no member of the pod
     * holds a key.
     *
     * ★ AND IT DOES NOT MAKE THE BOT A MEMBER. This registers a key against the bot's OWN agent,
     * so it can read what is encrypted TO that agent. Whether the bot may act in a workspace is
     * still decided by the delegation rows on each person's pod, exactly as before — a key is what
     * you read with, not what you are allowed to do.
     */
    try {
      await client.tool('register_agent', {
        agent_id: agentId, scope: 'ReadWrite', encryption_public_key: this.encryption.publicKey,
      });
    } catch {
      // A registry write that did not land is not a reason to refuse to start: the opener below
      // is what reading depends on, and the pod may already carry this key from a previous run.
    }
    client.setGraphOpener(this.opener);
    this.identity = { client, agentId, pod, address: this.wallet.address };
    return this.identity;
  }

  get current(): BotIdentity {
    if (!this.identity) throw new Error('the bot session has not been opened yet');
    return this.identity;
  }

  private expiring(): boolean {
    return !!this.bearer?.expiresAt && this.bearer.expiresAt - Date.now() < REMINT_MARGIN_MS;
  }

  /**
   * Run one substrate operation, re-minting around it when the hour is up.
   *
   * The client is passed IN rather than captured, because `open()` builds a new
   * `WorkspaceClient` and a caller holding the old one would keep using a dead transport.
   */
  async call<T>(fn: (client: WorkspaceClient) => Promise<T>): Promise<T> {
    if (this.expiring()) await this.open();
    try {
      return await fn(this.current.client);
    } catch (e) {
      if ((e as { code?: string })?.code !== 'needs_reauth') throw e;
      await this.open();
      return fn(this.current.client);
    }
  }
}
