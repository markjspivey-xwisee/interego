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
import { openerFor, sealedBindingCheck } from '@interego/workspace-client/opener';
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

  /**
   * Where operational notices go. Null until the host sets it.
   *
   * ★ A SILENT RECOVERY IS STILL SOMETHING AN OPERATOR NEEDS TO SEE. Re-authenticating after a
   * relay redeploy is the right behaviour, but a bot that does it without saying so turns "the
   * relay was replaced under us" into an invisible event — and the next person debugging a
   * different problem has no idea the session changed underneath them.
   */
  out: ((m: string) => void) | null = null;

  constructor(relay: string, identityServer: string, privateKey: string, fetchImpl?: typeof fetch) {
    this.relay = relay.replace(/\/$/, '');
    this.identityServer = identityServer.replace(/\/$/, '');
    this.wallet = new Wallet(privateKey);
    this.encryption = deriveEncryptionKeyPair(privateKey);
    this.opener = openerFor(privateKey);
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
  }

  get address(): string { return this.wallet.address; }

  /**
   * Mint, connect, and resolve who the relay says this process is.
   *
   * ── ★★ SINGLE-FLIGHT, BECAUSE EVERY CALLER NOTICES EXPIRY AT THE SAME MOMENT ─
   *
   * `expiring()` is a comparison against one clock, so at the hour boundary every concurrent
   * caller answers it identically — and each would run its own SIWE ceremony, mint its own bearer,
   * and build its own transport. The last one to finish wins `this.identity` and the rest have
   * signed in for nothing, against a relay that just rate-limited a burst of identical
   * authorization requests from one wallet.
   *
   * It was survivable while only Discord commands went through `call()`. It stops being
   * survivable the moment the WATCHES do — one per watched thread, all polling on the same
   * cadence — which is exactly the change this guard was added for.
   *
   * The in-flight promise is shared, not awaited-and-discarded: a second caller gets the SAME
   * ceremony's result, so both hold the identity the relay actually issued.
   */
  private opening: Promise<BotIdentity> | null = null;

  async open(): Promise<BotIdentity> {
    if (this.opening) return this.opening;
    this.opening = this.openOnce().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async openOnce(): Promise<BotIdentity> {
    // ★ THE CLIENT NAME IS PASSED, NOT DEFAULTED. See `DISCORD_CLIENT_NAME`: the relay bakes it
    // into the agent DID, so omitting it here is what made this bot's permanent identity read
    // `interego-workspace-live-driver-…`.
    const bearer = await mintBearer(this.relay, this.identityServer, this.wallet, DISCORD_CLIENT_NAME, this.fetchImpl);
    this.bearer = bearer;
    this.transport = new RelayMcpTransport(this.relay, bearer, this.fetchImpl);
    /**
     * ── ★★ RE-MINT ON 401 RATHER THAN WAIT FOR A HUMAN TO RESTART THIS PROCESS ──
     *
     * MEASURED: a relay redeploy invalidates every bearer the previous revision issued — the 401
     * body says so itself. This bot then held a dead token and answered a person who had asked
     * their agent a question with "the delegation registry could not be read", which reads as a
     * substrate fault and was in fact a process that needed restarting. It holds its own key and
     * can mint another in about two seconds; there was never a reason for a person to be involved.
     */
    this.transport.setReauthorizer(async () => {
      const fresh = await mintBearer(this.relay, this.identityServer, this.wallet, DISCORD_CLIENT_NAME, this.fetchImpl);
      this.bearer = fresh;
      this.out?.('relay: session token was rejected; re-authenticated with a fresh one');
      return fresh;
    });
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
     * ── ★★ THIS KEY DOES NOT LET THE BOT READ A PRIVATE WORKSPACE, AND SAYING SO MATTERS ────
     *
     * An earlier version of this comment claimed it did. It does not, and the reason is worth
     * writing down because it is not obvious from here: `register_agent` is own-pod gated, so this
     * lands in the BOT's registry — and no publisher reads that. Recipients come from the target
     * pod's own registry unioned with `share_with`, and `share_with` is built from the seated
     * members' acceptances. The bot is a conduit and is never seated, so its pod is never
     * consulted by anybody deciding who to encrypt to.
     *
     * ★ WHAT IT IS ACTUALLY FOR: the bot can read content sealed to it as an ordinary identity —
     * which happens when somebody DELIBERATELY makes it one. That is the honest route and it needs
     * no new machinery: this bot has its own pod, so a convener can invite it exactly like a
     * person, it accepts with this key in its own acceptance, and from then on it is a member by
     * the same rules as everybody else — on the roster, in the recipient list, and revocable.
     *
     * ★ WHICH IS WHY IT IS NOT A SPECIAL CASE. A conduit that could read every private workspace
     * without being seated in any of them would be a second escrow with a different holder — the
     * exact arrangement the sealed path was built to remove from the relay.
     */
    try {
      await client.tool('register_agent', {
        agent_id: agentId, scope: 'ReadWrite', encryption_public_key: this.encryption.publicKey,
      });
    } catch {
      // A registry write that did not land is not a reason to refuse to start: the opener below
      // is what reading depends on, and the pod may already carry this key from a previous run.
    }
    client.setGraphOpener(this.opener, sealedBindingCheck);
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
    // ★ PRE-EMPTIVE, and this is the ONLY path that is. Anything reaching the relay outside
    // `call()` runs on whatever bearer is current and discovers expiry the way the relay tells
    // it — a 401. See `watchVia`, which is why the live watches now come through here.
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
