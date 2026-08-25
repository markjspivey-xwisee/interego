/**
 * Electron main process for the workspace desktop shell.
 *
 * ★ WHY ELECTRON AND NOT TAURI, stated as a measurement rather than a preference.
 * Tauri is the better shape — no bundled Chromium, a ~10 MB installer instead of ~200 MB —
 * and this machine has WebView2 (151.0.4129.59), MSVC 14.44.35207 and Windows SDK
 * 10.0.26100.0 already, so its native half would link. What it does NOT have is a Rust
 * toolchain: `cargo --version` and `rustc --version` both answer "command not found". A Tauri
 * app shipped from here would be one nobody had built or run, which is the one thing this
 * skeleton exists not to produce.
 *
 * Two smaller reasons point the same way. The wallet path needs secp256k1 signing and an OS
 * secret store in the privileged process; Electron gives both in TypeScript (`ethers`,
 * `safeStorage`), Tauri would need Rust for the keychain and an HTTP plugin for the relay
 * calls. And the auth work is inherently Node-shaped — a loopback HTTP listener for the
 * RFC 8252 redirect — which is the main process here and a Rust task there.
 *
 * ★ WHAT WOULD CHANGE TO SWITCH. Nothing in `@interego/workspace-client`, and nothing in
 * `auth.ts` except the transport of the IPC calls: the renderer talks to this process through a
 * deliberately small surface (`auth:*`, `substrate:call`, `identity:*`, `session:*`).
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { clearPending, nominate, readPending, readSettings, revokeGrant, writeGrant } from './permission.js';
import { composeGate } from './turnsetup.js';
import {
  findTurn, measuredFacts, readTurns, recordDraft, recordTurn, startedAt, totals, toolsInTurn, usageFrom,
} from './telemetry.js';
import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, EpochCounter, RelayMcpTransport, WorkspaceClient, guarded, handover,
  isOvertaken, isRestoreFailed, publishTurn,
  type Epoch, type RelayOAuthBearer, type TurnOutcome,
} from '@interego/workspace-client';
/**
 * ★ A SEPARATE ENTRY POINT, AND NOT FOR TIDINESS. The opener reaches `@interego/core`'s crypto,
 * which imports `node:crypto`. Exported from the package index it followed every consumer of the
 * index into the BROWSER artifact bundle, and that build fails outright — which is the good
 * outcome; the bad one would have been a polyfill quietly satisfying it.
 */
import { encryptionKeyFor, openerFor, sealedBindingCheck } from '@interego/workspace-client/opener';
// The sealer is node-only for the same reason the opener is; see its header.
import { sealForRoster } from '@interego/workspace-client/sealer';
import {
  beginAuthorization, exchangeCode, refreshBearer, signInWithWallet, startLoopbackReceiver,
  type AuthMethod,
} from './auth.js';
import {
  ACCOUNT_KEY, ACCOUNT_POD, ACTIVE_ACCOUNT, DELEGATE_KEY, forgetSecret, getSecret, listAccountKeys,
  listDelegateKeys, putSecret, secretStoreAvailable, WALLET_KEY,
} from './secrets.js';
import { checkPrivateKey } from './privatekey.js';
import {
  CODEX_UNSUPPORTED, probeClaude, runClaude,
  type ModelRun, type ProviderStatus, type TurnTools,
} from './modelprovider.js';
// The relay's OWN MCP endpoint, named under the delegate's bearer. Not a second server —
// see agent-tools.ts.
import { withAgentTools } from './agent-tools.js';
import type { TurnGate } from './modelprovider.js';
// Type-only, so nothing from the preload bundle is loaded here — it runs `exposeInMainWorld` at
// import time and belongs to a different process. The shape of what crosses the wire is one
// declaration, and this is the side that has to satisfy it.
import type { ModelTurn } from './preload.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

// ★ SMOKE-ONLY: no GPU. Under a virtual display (xvfb) and on a headless CI runner, hardware
// acceleration cannot initialise; Electron then spins up a GPU child that retries, fails to
// create its disk cache, and OUTLIVES `app.exit()` — holding the launcher's stdout open so the
// job never returns and burns its whole 40-minute timeout. This must be called before the app is
// ready, so it is gated on the env var here, at module load. It changes nothing for a real user
// (the var is set only by `desktop-package.yml`); the shell still ships with the GPU enabled.
if (process.env['INTEREGO_DESKTOP_SMOKE'] === '1') app.disableHardwareAcceleration();

/**
 * How long before a bearer expires the renewal is attempted.
 *
 * Measured: the relay issues `expires_in: 3600`. Five minutes is enough slack for a cold relay
 * and short enough that a machine asleep across the boundary wakes into a lapse it can still
 * report rather than one it silently rode past.
 */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

/**
 * The live session. Held in the MAIN process, never handed to the renderer.
 *
 * ★ THE BEARER NEVER CROSSES THE IPC BOUNDARY. The renderer asks for a tool call by name and
 * arguments; this process attaches the credential. A renderer that held the token could leak
 * it through any injected script, and the renderer is the half that renders bytes other
 * people wrote.
 */
let client: WorkspaceClient | null = null;
let transport: RelayMcpTransport | null = null;
let bearer: RelayOAuthBearer | null = null;
let signedInAs: { readonly method: AuthMethod; readonly pod: string | null } | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * What the renderer is allowed to say about the session, and nothing beyond it.
 *
 * ★ FOUR STATES, AND `lapsed` IS WHY THIS EXISTS. A shell whose token expired and which then
 * rendered a workspace with no members and no messages has TOLD THE USER THEIR WORKSPACE IS
 * EMPTY, from a read that never happened. `lapsed` carries the relay's own reason and the
 * renderer paints it over the whole window instead of over nothing.
 */
type SessionState = 'signed-out' | 'live' | 'renewing' | 'lapsed';
interface Session {
  readonly state: SessionState;
  readonly pod: string | null;
  readonly method: AuthMethod | null;
  /** Unix ms, or null when the grant did not report one — never a guessed hour. */
  readonly expiresAt: number | null;
  /** Whether a renewal is even possible without the user. Measured per grant, not assumed. */
  readonly renewable: boolean;
  /** Why the session is not live. Null when it is. */
  readonly why: string | null;
  /**
   * Whether this session holds an encryption key, and so whether a PRIVATE workspace is a thing
   * this person can create here.
   *
   * ★★ WITHOUT IT, "PRIVATE" IS A TRAP RATHER THAN A SETTING. A browser sign-in leaves no key on
   * this machine. Publishing privately anyway still succeeds — the payload is sealed to whatever
   * keys the pod's registry holds, which in that case is the relay's own — so the person would
   * create a workspace THEY cannot read and the relay can. That is the exact inversion of what the
   * word promises, and it returns 200. The renderer disables the choice on this.
   */
  readonly sealedReads: boolean;
  /** The PUBLIC half of this account's encryption key, for publishing in an acceptance. */
  readonly encryptionPublicKey: string | null;
}
let session: Session = { state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null, sealedReads: false, encryptionPublicKey: null };

/**
 * One model turn in flight.
 *
 * `cancelled` is separate from `kill` because a turn spends its first seconds INSIDE the provider
 * probe, with no child of its own to kill yet. A cancel in that window has to be remembered, or
 * the turn sails past it — which is what an adversarial review found the first version doing.
 */
interface Turn { cancelled: boolean; kill: (() => void) | null }

/**
 * Model turns currently running.
 *
 * A set rather than a single handle because a turn that is being cancelled and one that is
 * starting can overlap, and the one thing that must not survive a cancel is a child nobody is
 * holding a reference to. Entries are removed one at a time by the turn that owns them.
 */
const thinking = new Set<Turn>();

/**
 * How often a running turn reports what it has reached for.
 *
 * ★ SLOW ENOUGH TO BE FREE, FAST ENOUGH TO LOOK ALIVE. Each tick reads a bounded tail of the gate's
 * audit trail on the main process; at two seconds that is ~35 reads across a 70-second turn, which
 * is nothing, and no tool call stays invisible for longer than a blink. The ELAPSED CLOCK is not
 * driven from here — the renderer counts its own seconds, so the number on screen ticks smoothly
 * without an IPC message per second.
 */
const TURN_PROGRESS_MS = 2000;

/**
 * A DELEGATE THIS APP IS CURRENTLY HOSTING.
 *
 * ★ HOSTING, NOT OWNING, AND THE DIFFERENCE IS THE WHOLE POINT. A delegate is a keypair plus a
 * row on its delegator's pod — see `delegates.ts` in the shared package. This process holds keys
 * for SOME of a person's delegates; the authoritative list of who they have authorised is their
 * pod's delegation registry, which the renderer reads. A delegate whose key sits on their other
 * laptop appears there and not here, and that is correct rather than a gap.
 *
 * The session is minted lazily and per delegate, under `DELEGATE_SURFACE` rather than this app's
 * own OAuth client name — measured, see `auth.ts`: the client name is inside the agent DID, so
 * signing a delegate in under "interego-workspace-desktop" would make it a different delegate in
 * every other client that ever held the same key.
 *
 * ★★ AND THERE IS DELIBERATELY NO ROW FOR THE DELEGATE'S ENCRYPTION KEYPAIR. A first repair for
 * "a delegate's sign-in overwrote its human's sealing key" gave it one, and nothing ever read it:
 * this process seals only as the ACCOUNT (`substrate:seal` is the person's act) and routes a
 * delegate's work as tool calls under its own bearer, so the only thing here that consumes a
 * delegate's key is the opener on `client`, which closes over its own copy — see `openerFor`. A
 * field written and never read is a claim that something depends on it, and nothing did.
 */
interface HostedDelegate {
  readonly address: string;
  readonly agentId: string;
  readonly pod: string;
  client: WorkspaceClient;
  bearer: RelayOAuthBearer;
}
const hosted = new Map<string, HostedDelegate>();

/**
 * Delegate ceremonies currently in flight, one per address.
 *
 * ★★ SINGLE-FLIGHT, BECAUSE TWO CEREMONIES FOR ONE DELEGATE ARE NOT TWO SESSIONS. Three callers
 * ask independently — `delegate:list` on every boot, `delegate:call` re-minting after a 401, and
 * `agent:think` before a turn — and none of them was deduped. So two ceremonies could run for one
 * address: each caller was handed its OWN session and the map kept whichever finished LAST, which
 * means the session in `hosted` need not be the one a caller is holding, and a loopback port and
 * four relay round trips were spent twice to establish one delegate. Joining the run already in
 * flight is the same answer to the same question.
 */
const opening = new Map<string, Promise<HostedDelegate>>();

/** Open (or reuse) a delegate's own relay session. Its key never leaves this process. */
async function delegateSession(address: string): Promise<HostedDelegate> {
  const key = address.toLowerCase();
  const live = hosted.get(key);
  // A bearer inside its last five minutes is re-minted rather than refreshed: this process holds
  // the key, so re-running the ceremony costs four round trips and needs no rotation state — the
  // same reasoning the Discord bot's `BotSession` records.
  if (live && (!live.bearer.expiresAt || live.bearer.expiresAt - Date.now() > RENEW_MARGIN_MS)) return live;
  /**
   * ★ REFUSED WHILE THE ACCOUNT IS BEING SWITCHED. `adopt`'s handover has already dropped
   * `hosted`, so a ceremony begun here would commit into the gap between identities — the very
   * write the clear just performed, arriving one await later. There is a live answer to "which
   * person is hosting this delegate" on either side of a switch and none during it.
   */
  if (accounts.handingOver()) {
    throw new Error('This app is switching accounts right now, so there is no signed-in person to host a delegate '
      + 'as. Nothing was signed in. Ask again once the switch has finished.');
  }
  const already = opening.get(key);
  if (already) return already;
  const run = openDelegateSession(key, address).finally(() => {
    // Cleared however it ended, so a ceremony that failed is not remembered as one in flight.
    if (opening.get(key) === run) opening.delete(key);
  });
  opening.set(key, run);
  return run;
}

/**
 * The ceremony itself, as a {@link handover} on this ADDRESS's own counter.
 *
 * ★★ WHY A HANDOVER AND NOT A GUARD. `hosted.set` used to land after five awaits with no ordering
 * of any kind, and the write that has to be stopped is not a stale one — it is a CORRECT one
 * arriving after somebody signed out. Reproduced (round4/refute-7 #7): a delegate sign-in in
 * flight at `auth:signout` landed in `hosted` after `hosted.clear()`, and `delegate:list` then
 * reported a live delegate with nobody signed in. `auth:signout` and `adopt` bump every delegate
 * counter as they clear the map (see {@link endDelegateAttempts}), which takes custody away from
 * a ceremony in flight — so it commits nothing, restores nothing, and fails with `Overtaken`.
 *
 * ★ AND THE FAILURE PATH IS REAL HERE TOO: a re-mint that throws puts the session the address
 * already had back, rather than leaving the caller with neither the old one nor a new one.
 */
async function openDelegateSession(key: string, address: string): Promise<HostedDelegate> {
  const pk = getSecret(DELEGATE_KEY(key));
  if (!pk) throw new Error('This app does not hold a key for delegate ' + address + '. It may be authorised on your pod and hosted somewhere else — a delegate is its key, not this application.');
  const wallet = new Wallet(pk);
  return handover<HostedDelegate | null, HostedDelegate>(delegateEpochs(key), {
    snapshot: () => hosted.get(key) ?? null,
    clear: () => { hosted.delete(key); },
    work: async () => {
      const recv = await startLoopbackReceiver();
      let issued: RelayOAuthBearer;
      try {
        issued = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri, DELEGATE_SURFACE);
      } finally { recv.close(); }
      const delegateTransport = new RelayMcpTransport(RELAY, issued);
      /**
       * ── ★★ A DELEGATE RE-AUTHENTICATES ITSELF ──────────────────────────
       *
       * MEASURED: a relay redeploy invalidates every bearer the previous revision issued, and this
       * process then held a dead one until somebody restarted the app. The turn that hit it reported
       * "the delegation registry could not be read", which reads as the substrate refusing the agent
       * rather than as a token that needed re-minting.
       *
       * The key never leaves this process either way — the ceremony below is the SAME one that opened
       * the session, run again. What changes is that a person is no longer the retry mechanism.
       *
       * ★ IT WRITES NOTHING SHARED, which is why it takes no Epoch: the fresh credential goes to
       * the transport that asked for it and nowhere else. The ACCOUNT's re-authorizer is the one
       * that had to be guarded, because that one wrote a module global.
       */
      delegateTransport.setReauthorizer(async () => {
        const again = await startLoopbackReceiver();
        try {
          return await signInWithWallet(
            RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), again.redirectUri, DELEGATE_SURFACE,
          );
        } finally { again.close(); }
      });
      const delegateClient = new WorkspaceClient(RELAY, delegateTransport);
      await delegateClient.connect();
      const status = await delegateClient.podStatus();
      const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
      const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
      const agent = status['sessionAgent'] as { did?: string; id?: string } | undefined;
      const agentId = agent?.did ?? agent?.id ?? '';
      // ★ REFUSED RATHER THAN GUESSED, exactly as the Discord bot refuses. The agent id is the string
      // a delegator authorises and the string the relay's scope gate compares. A delegate that came up
      // without one would ask somebody to authorise an empty name, and every write it then made would
      // be attributed to nothing while looking like a delegate that worked.
      if (!pod || !agentId) throw new Error('The relay signed this delegate key in and reported no ' + (pod ? 'sessionAgent' : 'pod') + ', so it has no identity to be authorised under. Nothing was done.');
      // ★ A delegate holds its OWN encryption key, derived from its OWN wallet. That is what stops an
      // agent's reach from silently becoming its human's: being seated in a private workspace is a
      // separate grant, and this key is what makes it a separate one in fact and not just on paper.
      //
      // ★★ AND IT IS INSTALLED ON THIS CLIENT ONLY. This called `installEncryption`, which also wrote
      // the ACCOUNT's `accountEncryptionPair` — so the sentence above was true of the derivation and
      // false of where the result went. See `setAccountEncryption` for the two things that cost.
      //
      // ★ BOTH HALVES, AND THE OPENER IS THE ONE WITH NO SUBSTITUTE. Registration is what lets other
      // members seal TO this delegate; the opener is what lets it READ what they sealed. A session
      // that got the registration and no opener reports `canOpenSealed: false`, which `verifyGrantIri`
      // renders as "this client holds no key to open them" for every private record it is seated in —
      // a total, silent loss of private reads that nothing else in this file would notice.
      const encryption = installClientEncryption(delegateClient, pk);
      await registerEncryptionKey(delegateClient, encryption, agentId);
      return { address: key, agentId, pod, client: delegateClient, bearer: issued };
    },
    commit: (next) => { hosted.set(key, next); },
    // Only when there WAS one: `clear` deleted the entry, so an address that had no session goes
    // back to having none rather than to having a hole somebody has to read as absence.
    restore: (was) => { if (was) hosted.set(key, was); },
  });
}

// ── the account keyring ──────────────────────────────────────────────────────

/**
 * ONE PERSON, ONE IDENTITY — AND THIS IS THE PART OF THE APP THAT DECIDES WHICH.
 *
 * ★ THE GAP THIS EXISTS TO CLOSE, FOUND BY USING THE APP FOR REAL. "Use a wallet key on this
 * machine" MINTED a key when it did not find one, and there was no way to give it a key you
 * already had. Somebody whose pod already holds everything they have written — from the Discord
 * conduit, from another machine, from the artifact — signed in here and got a THIRD, empty
 * identity, with no path back to the one that is actually theirs. Two identities belonging to one
 * human corrupt everything downstream: the roster shows two members, attribution splits between
 * them, and which agent is whose delegate stops being answerable.
 *
 * ★ AND NO KEY IS EVER REPLACED. Slots are named after the address of the key inside them (see
 * `secrets.ts`), so importing a second account ADDS one. There is no state in which pasting a key
 * discards the previous one, because a private key is the entire identity and its loss is
 * permanent. Which key the app signs in with is a separate, reversible choice, recorded in
 * {@link ACTIVE_ACCOUNT}.
 */
interface AccountSlot {
  readonly address: string;
  /** The pod the RELAY answered for this key here, or null for "not established" — never derived. */
  readonly pod: string | null;
  /** Whether the wallet button uses this one. Exactly one is true once anything has signed in. */
  readonly active: boolean;
  /** Present when the stored ciphertext will not decrypt — a real state, and not the same as absent. */
  readonly unreadable: string | null;
}

/** Read a secret without letting an undecryptable one masquerade as an absent one. */
function readableSecret(name: string): { value: string | null; why: string | null } {
  try { return { value: getSecret(name), why: null }; }
  catch (e) { return { value: null, why: (e as Error)?.message ?? String(e) }; }
}

/**
 * Copy the pre-keyring single slot into an address-named one, once.
 *
 * ★ COPY, NOT MOVE, AND IT NEVER THROWS. This runs before the first window is drawn, on a file
 * written by an older build, and the one outcome that must not happen is an app that will not
 * start because of a key it could not read — the person would then have no way to reach the store
 * that key is in. A failure here leaves the legacy slot exactly as it was and is reported through
 * the ordinary "this stored secret will not decrypt" path when something asks for it.
 */
function migrateLegacyWallet(): void {
  const legacy = readableSecret(WALLET_KEY);
  if (!legacy.value) return;
  try {
    const address = new Wallet(legacy.value).address;
    // Already carried across on an earlier run. Writing again would be harmless and pointless.
    if (getSecret(ACCOUNT_KEY(address)) !== null) return;
    putSecret(ACCOUNT_KEY(address), legacy.value);
    // The key that WAS the app's single account becomes the one it signs in with, so an upgrade
    // returns to the same pod without the person choosing anything.
    if (getSecret(ACTIVE_ACCOUNT) === null) putSecret(ACTIVE_ACCOUNT, address.toLowerCase());
  } catch { /* see the header: an unreadable legacy slot must not stop the app booting */ }
}

/** Every account key this machine holds, with the pod each was last seen to reach. */
function accountSlots(): readonly AccountSlot[] {
  const active = readableSecret(ACTIVE_ACCOUNT).value?.toLowerCase() ?? null;
  const addresses = listAccountKeys();
  // With exactly one key and no recorded choice, that key IS the choice. Reporting "none active"
  // when there is only one would make the sign-in screen ask a question with one answer.
  const effective = active ?? (addresses.length === 1 ? addresses[0] ?? null : null);
  return addresses.map((address) => {
    const held = readableSecret(ACCOUNT_KEY(address));
    return {
      address,
      pod: readableSecret(ACCOUNT_POD(address)).value,
      active: address === effective,
      unreadable: held.value === null ? (held.why ?? 'this key is listed on disk and could not be read back') : null,
    };
  });
}

/**
 * Sign in as one account key: the whole ceremony, from the key to a live session.
 *
 * ★ ONE PATH, USED BY ALL THREE ENTRY POINTS — the wallet button, an import, and switching to a
 * stored key. They differ only in WHICH key, and a second copy of the ceremony is how "import"
 * ends up subtly unlike "sign in" in a way nobody notices until somebody's pod is wrong.
 */
async function signInWithAccountKey(privateKey: string): Promise<{ pod: string; displayName: string | null; method: AuthMethod; address: string }> {
  const wallet = new Wallet(privateKey);
  const recv = await startLoopbackReceiver();
  let who;
  try {
    const got = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri);
    who = await adopt(got, 'wallet', privateKey);
  } finally {
    // The wallet path never uses the listener — it posts the proof itself — but the relay requires
    // a registered redirect_uri, and leaving a socket open because it went unused is how a desktop
    // app ends up holding a port for its whole lifetime.
    recv.close();
  }
  // Both written only now, on the strength of an answer: the pod is what the RELAY said, and the
  // active account is the one that demonstrably worked.
  putSecret(ACCOUNT_POD(wallet.address), who.pod);
  putSecret(ACTIVE_ACCOUNT, wallet.address.toLowerCase());
  return { ...who, address: wallet.address };
}

/**
 * The PUBLIC half of the account's encryption key, for the renderer to publish in an acceptance.
 *
 * ★★ THE PUBLIC HALF ONLY, AND IT LEAVES THIS PROCESS BY DESIGN. That is what a recipient list is
 * made of — it is meant to be world-readable, and it goes into a document on a public pod. The
 * SECRET stays here and is never exposed on the bridge, which is the entire reason the renderer is
 * sandboxed and the reads are opened up here rather than there.
 */
let accountEncryptionPublicKey: string | null = null;

/**
 * This account's FULL encryption keypair, held in the privileged process only.
 *
 * ★★ THE SECRET LIVES HERE AND NOWHERE ELSE. The renderer is sandboxed precisely so that a page
 * rendering bytes other people wrote can never reach it. That is also why sealing happens on this
 * side: the renderer asks for a payload to be sealed, this process seals it, and the ciphertext
 * goes back — the plaintext crosses the bridge in one direction and the key crosses in neither.
 */
let accountEncryptionPair: ReturnType<typeof encryptionKeyFor> | null = null;

/**
 * ★★ THE ONE PLACE THIS KEY'S LIFETIME IS DECIDED, BECAUSE IT USED TO OUTLIVE ITS SESSION.
 *
 * Both fields above were only ever WRITTEN, by a sign-in that found a key. Nothing cleared them,
 * and two ordinary sequences then carried one identity's secret into another's session:
 *
 *   · SIGN OUT. `auth:signout` drops the bearer, the transport, the client and the delegate
 *     sessions — and left the encryption pair in this process. `substrate:seal` checks only
 *     `accountEncryptionPair`, never the session, so it would still seal, as the person who had
 *     signed out.
 *   · ★ SIGN IN THROUGH THE BROWSER AFTERWARDS. That path holds no key on this machine, and
 *     `installEncryption` used to RETURN EARLY for it without clearing anything — so the new
 *     session was published with `encryptionPublicKey: <the previous account's>`. That value goes
 *     into the new identity's
 *     ACCEPTANCE, which is the one document every other member reads to decide who to seal to.
 *     Every entry written afterwards would be encrypted to a key only the previous identity can
 *     open, in a channel the new one is correctly seated in — and nothing anywhere reports it,
 *     because from every side it looks like a member with a key.
 *
 * Absent is a real state and this is what it means: no key here, so nothing seals and nothing
 * opens, which is exactly what a browser sign-in already advertises about itself.
 *
 * ── ★★ AND IT SAID "THE ONE PLACE" WHILE A THIRD WRITER EXISTED ─────────────
 *
 * The heading above was a wish, not a description. `installEncryption` was ONE function with TWO
 * callers — the person's sign-in and `delegateSession` — and it wrote these fields for both, so
 * every delegate this app signed in overwrote its human's key and nothing ever put the human's
 * back. The invariant `delegateSession` states in its own comment, and again on the turn path
 * ("a delegate's reach must not silently become its human's"), was being broken by the line that
 * states it.
 *
 * ★ IT IS NOT AN EXOTIC PATH. It is an ORDINARY BOOT. The renderer fires `loadDelegates()` after
 * sign-in; `delegate:list` signs in every stored delegate key not already in `hosted` — it has to,
 * because the relay is the only thing that can say what agent id a key gets. So by the time the
 * window is drawn, the LAST delegate's keypair is sitting in the account's globals with the
 * person's own session live in front of it. Two things followed:
 *
 *   · `substrate:seal` reads `accountEncryptionPair` as the SENDER, so every entry the person
 *     wrote afterwards carried `senderPublicKey: <a delegate's>`. Nobody was locked out — a
 *     recipient reads the sender out of each wrapped key, so opening never consults who claimed to
 *     have sealed it — but the provenance stamped on somebody's own words named an agent they had
 *     merely switched on, and provenance is the thing this vertical asks to be believed about.
 *   · ★ THE REFUSAL BELOW STOPPED REFUSING, WHICH IS THE BEHAVIOURAL HALF. A browser sign-in
 *     installs a NULL pair precisely so that nothing can be sealed; `substrate:seal` checks the
 *     pair and says so. Once `loadDelegates` had run, the pair was a delegate's and the guard
 *     PASSED. Measured with the sequence in
 *     `tests/workspace-desktop-delegate-key.test.ts`: "seal refused before delegate = true |
 *     after delegate = false". A deliberate refusal that lapses on an ordinary boot is worse than
 *     one nobody wrote, because the code still reads as though it holds.
 *
 * ── ★★ AND THE FIRST REPAIR ANSWERED THE WRONG QUESTION ────────────────────
 *
 * Splitting the installer removed the third writer, and the docblock then declared the heading
 * true again "because only two things call this". That is a CALLER COUNT, and the heading is
 * about a LIFETIME — nothing a caller count can establish, because the interesting writes happen
 * across an await where the number of callers is irrelevant and the ORDER is everything. The
 * split had in fact moved the write from BEFORE `register_agent` to AFTER it, and both halves of
 * the defect above came straight back by a new route:
 *
 *   · SIGN OUT mid-sign-in and the sign-in's continuation wrote the pair back on top of the
 *     clear. Measured: "SEALED as ACC1" after signing out, where the ordering before the split
 *     refused.
 *   · SWITCH ACCOUNTS and, for the length of the new account's `register_agent`, sealing was
 *     stamped with the PREVIOUS account's key.
 *
 * ── ★★ WHAT ACTUALLY BOUNDS THE LIFETIME NOW ─────────────────────────
 *
 * Not a caller count. An ORDER — and one this file no longer keeps privately, because `adopt` is
 * a {@link handover} on {@link accounts} and the order is the package's:
 *
 *   1 · `clear` drops this pair SYNCHRONOUSLY, before the sign-in's first await, along with the
 *       bearer, the transport, the client, the renewal timer and the hosted delegate sessions. A
 *       handover starts when it is asked for, so there is no window in which this process is
 *       still armed with the outgoing identity's secret while acquiring the incoming one's.
 *   2 · `work` writes NOTHING shared: it derives the key, installs the opener on the client it
 *       built and registers the public half under that client's own bearer. See
 *       {@link prepareAccountEncryption}.
 *   3 · `commit` assigns in ONE synchronous block, and it runs only while that sign-in still
 *       holds custody of the state it cleared. An overtaken sign-in commits nothing and says so.
 *   4 · ★ AND THE FAILURE PATH IS WRITTEN, which is the half that was missing for three rounds.
 *       A throw anywhere in `work` used to exit with this pair permanently null while the panel
 *       still advertised the OUTGOING account as live — `sealedReads: true` and its
 *       `encryptionPublicKey` included — so sealing was disarmed for the life of the process.
 *       `restore` puts every field back and re-arms the timer, and it runs only while this
 *       handover is still the custodian.
 *
 * So the writers are `adopt`'s handover (`clear`, `commit` and `restore`) and `auth:signout`,
 * which clears and then bumps the subject — and the bump ends any adopt's custody, so a failing
 * sign-in can no longer put a departed account's key back on top of a sign-out.
 */
function setAccountEncryption(key: ReturnType<typeof encryptionKeyFor> | null): void {
  accountEncryptionPair = key;
  accountEncryptionPublicKey = key?.publicKey ?? null;
}

/**
 * WHICH ACCOUNT THIS PROCESS'S SHARED STATE BELONGS TO, AND WHICH ATTEMPT AT IT.
 *
 * ★★ TWO AXES, BECAUSE AN IDENTITY GUARD IS NOT AN ORDERING GUARD. This was one integer,
 * `accountGeneration`, and one integer cannot answer both questions: two sign-ins at the SAME
 * account share an identity and are still alternatives, and a renewal in flight is neither a
 * sign-in nor a different account. {@link EpochCounter} is the single implementation of this,
 * shared with the renderer, the Discord watcher and the artifact — it lives in the package
 * because four shells re-derived the guard privately and each got a different subset of it right.
 *
 * ★ AND IT CARRIES CUSTODY, WHICH A NUMBER CANNOT. `adopt` clears the credential, the key, the
 * timer and the delegate sessions before its first await; for the whole of that window
 * `current()` and `sameSubject()` answer FALSE for every stamp, so nothing — not the renewal
 * timer, not a 401 re-authorizer, not a delegate ceremony — can write into the gap. An integer
 * can say "a different identity"; it has no way to say "between identities".
 */
const accounts = new EpochCounter();

/**
 * ONE COUNTER PER DELEGATE ADDRESS, because two delegates are two subjects.
 *
 * ★ THE ORDERING QUESTION IS "IS THERE A NEWER CEREMONY FOR THIS DELEGATE", AND ONE SHARED
 * COUNTER CANNOT ASK IT. Two ceremonies for DIFFERENT addresses are routinely in flight together:
 * the renderer fires `loadDelegates()` unawaited at boot while `agent:think` opens a delegate's
 * session before a turn, and `delegate:call` opens one on demand. On a shared counter each of
 * those would take the subject from the others, so a delegate would be dropped for a reason that
 * has nothing to do with it — while "a second sign-in for the SAME address replaces the first",
 * which is the rule actually wanted, would still not be expressible.
 *
 * (`delegate:list`'s own loop is NOT the case that forces this, and the first version of this
 * comment said it was: it AWAITS each ceremony, so iteration N has committed before iteration
 * N+1 bumps anything, and a shared counter would survive it.)
 */
const delegates = new Map<string, EpochCounter>();

/** The counter for one delegate address, minted on first use. */
function delegateEpochs(key: string): EpochCounter {
  const held = delegates.get(key);
  if (held) return held;
  const made = new EpochCounter();
  delegates.set(key, made);
  return made;
}

/**
 * End every outstanding attempt at every delegate this run has opened a counter for.
 *
 * ★★ CALLED WHEREVER `hosted` IS CLEARED, OR THE CLEAR IS HALF A CLEAR. `auth:signout` and
 * `adopt` both mean "the person this process acts for has changed", and both drop `hosted` — but
 * a ceremony already in flight holds its own counter and would commit into the map afterwards.
 * MEASURED (round4/refute-7 #7): a delegate sign-in in flight at `auth:signout` landed in
 * `hosted` AFTER `hosted.clear()`, so with nothing signed in `delegate:list` returned a live
 * delegate. This is the line that makes those commits drop.
 */
function endDelegateAttempts(): void {
  for (const counter of delegates.values()) counter.bumpSubject();
}

/**
 * GIVE A CLIENT THE KEY IT READS PRIVATE WORKSPACES WITH.
 *
 * ── ★★ THE HALF THAT MAKES THE WORD "END-TO-END" TRUE ───────────────────────
 *
 * The relay keeps a public key an agent supplies and hands back sealed envelopes without opening
 * them. Both are useless until something on this side actually HOLDS a secret: until now no member
 * held a key at all, so "encrypted to its members" meant encrypted to one keypair the relay owns.
 * This installs the opener that uses the private half; {@link registerEncryptionKey} publishes the
 * public one.
 *
 * ── ★ THE DERIVATION TAKES NO PRINCIPAL, DELIBERATELY ───────────────────────
 *
 * `encryptionKeyFor` accepts one so a delegate need not share a key with its human, but a delegate
 * here already HAS its own wallet — `DELEGATE_KEY` — so passing anything would only make the key
 * depend on a second input. That matters more than it looks: the derivation must be STABLE for the
 * lifetime of the identity, because content encrypted to a key is unreadable the moment the key
 * changes. Scoping it by, say, the session agent DID would silently re-key on some future sign-in
 * and quietly orphan every private message the person had already received.
 *
 * ── ★★ ONE CLIENT, ONE IDENTITY — AND SYNCHRONOUS ON PURPOSE ────────────────
 *
 * Deriving a keypair from a private key is arithmetic and so is installing an opener, so this
 * function awaits nothing and touches nothing but the client it is handed. That is load-bearing
 * rather than tidy: while the derivation and the relay-side registration were one `async`
 * function, the account's sign-in could not commit its own key until the network had answered,
 * and a sign-out landing in that window was overwritten by the sign-in's continuation. See
 * `setAccountEncryption`, which records both the merge that made a delegate write the account's
 * key and the ordering that undid a sign-out.
 *
 * The derived pair is RETURNED rather than stored, so each caller decides where its own identity's
 * key belongs: `adopt` commits the account's into the module globals under the generation guard,
 * and `delegateSession` stores a delegate's nowhere at all — the opener installed here already
 * holds the only copy anything in this process reads.
 */
function installClientEncryption(target: WorkspaceClient, privateKeyHex: string): ReturnType<typeof encryptionKeyFor> {
  const key = encryptionKeyFor(privateKeyHex);
  target.setGraphOpener(openerFor(privateKeyHex), sealedBindingCheck);
  return key;
}

/**
 * Publish a client's PUBLIC half relay-side, so other members can seal TO this identity.
 *
 * ★ AND A FAILURE HERE MUST NOT STOP THE SIGN-IN. Registration is a nicety on a pod that may
 * already carry the key; the opener {@link installClientEncryption} installed is worth having
 * either way, because reading is what this key is for and reading does not depend on the registry.
 *
 * ★ NO AGENT ID, NO CALL. The relay's row is keyed on the agent the SESSION is, so without one
 * there is nothing to register the key against — and a guessed id would attach it to nobody.
 */
async function registerEncryptionKey(
  target: WorkspaceClient, key: ReturnType<typeof encryptionKeyFor>, agentId: string | null,
): Promise<void> {
  if (!agentId) return;
  try {
    await target.tool('register_agent', {
      agent_id: agentId, scope: 'ReadWrite', encryption_public_key: key.publicKey,
    });
  } catch { /* see above: the opener is still worth having */ }
}

/**
 * The account's own key: derived, installed on ITS client, published relay-side — and deliberately
 * NOT committed. What comes back is what `adopt` commits, or null for a session that holds no key.
 *
 * ★★ PREPARE, NOT INSTALL, AND THE NAME IS THE INVARIANT. Called `installEncryption`, with a
 * `target` parameter that made it look per-client, it read as something any session could safely
 * call — and `delegateSession` did, so every delegate this app signed in overwrote its human's
 * sealing key. Renamed `installAccountEncryption` it was out of the delegate's reach but still
 * WROTE the account globals, from the far side of a network round trip, which undid a sign-out.
 * Nothing here writes anything a sign-out or a later sign-in shares; `adopt` alone commits, behind
 * one generation check. See `setAccountEncryption` for both measurements.
 *
 * ★ NULL IS A RESULT, NOT THE ABSENCE OF ONE. A browser sign-in holds no key on this machine, so
 * it reads what it can and carries NOTHING over from whoever was signed in before. Carrying one
 * over is the second defect `setAccountEncryption` records: the new session was published with
 * the previous account's `encryptionPublicKey`, and that value goes into an acceptance.
 */
async function prepareAccountEncryption(
  target: WorkspaceClient, privateKeyHex: string | null, agentId: string | null,
): Promise<ReturnType<typeof encryptionKeyFor> | null> {
  if (!privateKeyHex) {
    target.setGraphOpener(null);
    return null;
  }
  const key = installClientEncryption(target, privateKeyHex);
  await registerEncryptionKey(target, key, agentId);
  return key;
}

const listeners = new Set<WebContents>();
function setSession(next: Session): void {
  session = next;
  for (const wc of listeners) {
    // A window closed between the read and the send is the ordinary case, not a failure.
    if (!wc.isDestroyed()) wc.send('session:changed', session);
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    backgroundColor: '#12151c',
    title: 'Interego Workspace',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // The renderer gets no Node and no direct access to this process's globals. It reaches
      // exactly the channels the preload exposes and nothing else.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Anything that tries to navigate or open a window goes to the user's real browser. A
  // workspace renders IRIs somebody else published; a click must never be able to replace
  // this window's document with a page of theirs.
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); void shell.openExternal(url); });
  // ★ THE REFERENCE IS CAPTURED HERE, WHILE THE WINDOW IS ALIVE, AND THE `closed` HANDLER BELOW
  // CLOSES OVER IT RATHER THAN RE-READING IT.
  //
  // `closed` fires AFTER the window has been destroyed. At that point every property accessor on
  // the BrowserWindow — `webContents` among them — throws `TypeError: Object has been destroyed`,
  // so the previous form, `win.on('closed', () => listeners.delete(win.webContents))`, threw on
  // the way out of the app. Nothing caught it, so Electron's default handler drew "A JavaScript
  // error occurred in the main process" over whatever the person was doing, EVERY time they closed
  // the window — and because the throw happened while evaluating the argument, the `delete` never
  // ran either, so the destroyed WebContents stayed in the set it was supposed to be leaving.
  //
  // Deleting by a captured reference needs no `isDestroyed()` guard: it never touches the dead
  // object at all, it only removes an entry from a Set. `setSession` already guards its own sends.
  const wc = win.webContents;
  listeners.add(wc);
  win.on('closed', () => { listeners.delete(wc); });
  void win.loadFile(join(__dirname, '..', 'index.html'));
  return win;
}

/**
 * What one sign-in built, ready to become this process's live session in a single assignment.
 *
 * ★ EVERY FIELD IS PRODUCED BY `work`, WHICH WRITES NOTHING SHARED. That is a rule `handover`
 * makes structural rather than advisory: module state is touched only in `clear`, `commit` and
 * `restore`, all three synchronous, and a `guarded` commit attempted from inside `work` drops.
 */
interface AdoptedSession {
  readonly client: WorkspaceClient;
  readonly transport: RelayMcpTransport;
  /**
   * The credential the transport is ACTUALLY holding when `work` finishes, which is not always
   * the one `adopt` was handed.
   *
   * ★ THEY DIFFER WHENEVER THE RE-AUTHORIZER FIRED DURING THE SIGN-IN ITSELF, and `connect` and
   * `get_pod_status` are both calls that can provoke it. Committing the argument instead would
   * install a credential the transport had already replaced, and `scheduleRenewal` would arm its
   * timer off a spent expiry. The old code did not have this problem because that closure wrote
   * the module global directly — which is the defect being closed, so the value has to come back
   * some other way.
   */
  readonly credential: RelayOAuthBearer;
  readonly pod: string;
  readonly displayName: string | null;
  readonly key: ReturnType<typeof encryptionKeyFor> | null;
}

/** Everything the OUTGOING account owns in this process, read before any of it is dropped. */
interface OutgoingAccount {
  readonly client: WorkspaceClient | null;
  readonly transport: RelayMcpTransport | null;
  readonly bearer: RelayOAuthBearer | null;
  readonly signedInAs: { readonly method: AuthMethod; readonly pod: string | null } | null;
  readonly session: Session;
  readonly encryption: ReturnType<typeof encryptionKeyFor> | null;
  /** A COPY. `clear` empties the live map, so a restore needs its own list to fill it from. */
  readonly hosted: readonly (readonly [string, HostedDelegate])[];
}

/**
 * Resolve which pod the freshly minted session actually writes to, and make it this process's.
 *
 * ── ★★ A HANDOVER, AND THE FAILURE PATH IS THE POINT ───────────────────────
 *
 * The account's state is dropped before the first await, because leaving the outgoing key
 * standing across the incoming account's `register_agent` had `substrate:seal` answering — for
 * the length of a round trip, stamped with the PREVIOUS account's key — on an entry the new
 * account was about to write.
 *
 * ★★ AND NOTHING PUT IT BACK. Any throw between building the client and the commit — a failed
 * `connect`, a `get_pod_status` with no pod URL, a key that would not derive — exited with the
 * encryption pair permanently null while `session:status` still advertised the OUTGOING account
 * as live, `sealedReads: true` and its `encryptionPublicKey` included. Sealing was disarmed for
 * the life of the process and nothing anywhere said so. Reproduced twice (round4/refute-7 #1,
 * refute-10 #1). {@link handover} is that shape written once, in the package all four shells
 * already import: snapshot, clear, await, then commit if this run still holds custody of what it
 * cleared and restore if it does not.
 *
 * ★ SO "BETWEEN IDENTITIES, ACTING AS NEITHER" IS NOW TRUE OF THE PROCESS. The previous version
 * of this docblock claimed it while `session:status` went on answering as the outgoing account
 * and `hosted` went on holding the delegate sessions it had switched on. `clear` drops the
 * credential, the transport, the client, `signedInAs`, the encryption pair, the renewal timer and
 * the delegate sessions, and publishes a SIGNED-OUT session — which is what this process is for
 * that window: every handler needing a credential refuses, through the same checks that refuse
 * before a first sign-in.
 */
async function adopt(next: RelayOAuthBearer, method: AuthMethod, accountKey?: string): Promise<{ pod: string; displayName: string | null; method: AuthMethod }> {
  let adopted: AdoptedSession;
  try {
    adopted = await handover<OutgoingAccount, AdoptedSession>(accounts, {
      snapshot: () => ({
        client, transport, bearer, signedInAs, session,
        encryption: accountEncryptionPair,
        hosted: [...hosted],
      }),
      clear: () => {
        /**
         * ★ THE TIMER IS STATE, AND IT WAS THE HALF NOBODY NAMED. `adopt` never disarmed it, and
         * only its own success path ever reached `scheduleRenewal`. So a FAILED switch left the
         * outgoing account's renewal armed over the incoming globals: when it fired it refreshed
         * whatever bearer was there and republished `{...session, state: 'live'}` for a pod
         * nobody was signed in to — once an hour, indefinitely.
         *
         * ★★ BUT THIS LINE IS NOT WHAT CLOSES THAT, AND SAYING SO WAS THE FIRST THING A MUTANT
         * REFUTED. What closes it is the Epoch the timer carries: one armed by an earlier sign-in
         * finds `accounts.current(e)` false and spends nothing. Removing this line leaves all
         * fourteen cases green, because `scheduleRenewal` clears the slot before it arms and
         * every exit from a handover goes through it. It stays for the reason `Handover.clear`
         * gives in `epoch.ts` — "clear everything the outgoing subject owns INCLUDING TIMERS, or
         * restore cannot be its inverse": with it, nothing fires into the gap at all, rather than
         * firing and being refused, and the pair below describes what actually happened.
         */
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        renewing = null;
        client = null;
        transport = null;
        bearer = null;
        signedInAs = null;
        setAccountEncryption(null);
        /**
         * ★ AND THE DELEGATES, WHICH `auth:signout` HAS ALWAYS CLEARED AND THIS NEVER TOUCHED.
         * The two writers of "the person this process acts for has changed" disagreed about what
         * a handover is, so switching accounts left the previous identity's hosted delegate
         * sessions live for the next identity's window to drive. Bumping their counters is the
         * other half: it stops a ceremony already in flight putting one back an await later.
         */
        hosted.clear();
        endDelegateAttempts();
        setSession({
          state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false,
          why: 'this process is between accounts: the previous session has been dropped and the next one has not '
            + 'answered yet. Nothing can be read, written or sealed until it does.',
          sealedReads: false, encryptionPublicKey: null,
        });
      },
      work: async (e) => {
        const myTransport = new RelayMcpTransport(RELAY, next);
        // See {@link AdoptedSession.credential}: the re-authorizer below can replace this before
        // `work` returns, and the commit has to install what the transport is actually holding.
        let credential = next;
        /**
         * ★ ONLY WHEN THIS PROCESS HOLDS THE KEY. A wallet sign-in can be repeated silently
         * because the key is here; a BROWSER sign-in cannot — repeating it means putting a window
         * in front of somebody, and doing that unprompted because a token expired would be worse
         * than the honest "needs_reauth" the transport reports instead. So the account session
         * recovers by itself for the one method where recovering is not a decision on the
         * person's behalf.
         */
        if (accountKey) {
          const stored = accountKey;
          myTransport.setReauthorizer(async () => {
            const w = new Wallet(stored);
            const again = await startLoopbackReceiver();
            try {
              const fresh = await signInWithWallet(RELAY, IDENTITY, w.address, (m) => w.signMessage(m), again.redirectUri);
              /**
               * ── ★★ THIS TRANSPORT'S CREDENTIAL ALWAYS; THE PROCESS'S ONLY WHILE IT IS STILL
               * THIS ACCOUNT ───────────────────────────────────────
               *
               * This closure wrote `bearer` unconditionally, capturing neither a generation nor a
               * transport identity. A 401 on a call still travelling through account A's
               * transport, resolving after a switch to B, overwrote B's `bearer` with A's fresh
               * credential — and `renew` then read that global, refreshed A's token and set it on
               * B's transport, so the process made relay calls as A under a panel that said B.
               *
               * `sameSubject` is also false for the whole of a handover, so a 401 arriving
               * mid-switch cannot write into the gap either. The fresh credential is still
               * RETURNED: it belongs to the transport that asked for it, and withholding it would
               * fail a call in flight for a reason that has nothing to do with that call.
               */
              credential = fresh;
              if (accounts.sameSubject(e)) bearer = fresh;
              return fresh;
            } finally { again.close(); }
          });
        }
        /**
         * ★ THE CLIENT THIS SIGN-IN OWNS, AND IT IS A LOCAL. The module `client` is null for the
         * whole of `work` — `clear` dropped it — so there is no global here to read back by
         * mistake. MEASURED, on the version that assigned it on the way in: signing out
         * mid-sign-in made the continuation throw `Cannot read properties of null (reading
         * 'canOpenSealed')`, and an overtaken sign-in handed its opener to whatever client the
         * LATER sign-in had installed.
         */
        const mine = new WorkspaceClient(RELAY, myTransport);
        await mine.connect();
        const status = await mine.podStatus();
        const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
        // The pod SEGMENT, taken from the pod URL — never `displayName`, which is a label the
        // account chose. Using a display name as a pod name addresses a pod that does not exist,
        // and that reads back as an EMPTY LOG rather than as an error.
        const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
        if (!pod) throw new Error('get_pod_status answered without a pod URL this client could turn into a pod name, so there is no address to write to.');
        // The key this machine reads private workspaces with, registered against the agent the
        // relay says this session IS. A browser sign-in passes no key and simply reads less.
        const sessionAgent = status['sessionAgent'] as { did?: string; id?: string } | undefined;
        const key = await prepareAccountEncryption(mine, accountKey ?? null, sessionAgent?.did ?? sessionAgent?.id ?? null);
        return { client: mine, transport: myTransport, credential, pod, displayName: (status['displayName'] as string) ?? null, key };
      },
      commit: (v, e) => {
        /**
         * ── ★★ THE COMMIT: ONE SYNCHRONOUS BLOCK, RUN ONLY BY THE CUSTODIAN ────
         *
         * What stood here said "everything above this line either read the relay or wrote `mine`,
         * which no other session can see" — while the five lines above it had assigned the
         * generation, the encryption pair, the bearer, the transport and the client. It is true
         * of `work`, and it is true because `handover` puts every shared write into one of three
         * synchronous callbacks, not because a reader checked the lines above.
         */
        client = v.client;
        transport = v.transport;
        bearer = v.credential;
        setAccountEncryption(v.key);
        signedInAs = { method, pod: v.pod };
        setSession({
          state: 'live', pod: v.pod, method, expiresAt: v.credential.expiresAt,
          renewable: !!(v.credential.refreshToken && v.credential.clientId),
          why: null,
          // Measured from the client, not inferred from the sign-in method: the opener is
          // installed only if a key was actually found and derived.
          sealedReads: v.client.canOpenSealed,
          // The address other members seal to. Null for a browser sign-in, which holds no key — such a
          // member is still seated, and `recipientsFromRoster` names them rather than sealing to a subset.
          encryptionPublicKey: accountEncryptionPublicKey,
        });
        scheduleRenewal(e);
      },
      restore: (was) => {
        /**
         * ★ WHAT `clear` DROPPED, PUT BACK — and the two lists are written to be read against
         * each other. A field cleared and not restored is the whole of the defect this callback
         * exists to close.
         */
        client = was.client;
        transport = was.transport;
        bearer = was.bearer;
        signedInAs = was.signedInAs;
        setAccountEncryption(was.encryption);
        /**
         * ★ EXCEPT `renewing`, WHICH IS DELIBERATELY NOT PUT BACK, and the rule above says a
         * cleared field that does not come back is the defect — so this is the exception being
         * argued rather than overlooked. It is a promise, not a value: the exchange it names was
         * begun for a credential this handover took away, its Epoch is stale, and it will answer
         * `false` whatever happens here. Reinstating it would only make the next renewal join a
         * run that is already refusing.
         */
        for (const [address, delegate] of was.hosted) hosted.set(address, delegate);
        setSession(was.session);
        /**
         * ★ THE TIMER IS RE-ARMED RATHER THAN RESTORED: `clear` called `clearTimeout` on it and a
         * cancelled handle cannot be put back. `asOf()` and not `begin()` — this is not an
         * attempt at anything and must supersede nothing, and a LATER handover can be running
         * this restore from the chain it inherited, where this handover's own Epoch is already
         * stale and would arm a timer that could only ever drop itself.
         */
        scheduleRenewal(accounts.asOf());
      },
    });
  } catch (err) {
    if (isOvertaken(err)) {
      /**
       * ★ AN OVERTAKEN SIGN-IN FAILS RATHER THAN PARTLY SUCCEEDING. Returning quietly would let
       * `signInWithAccountKey` go on to record this key as the ACTIVE account for a session that
       * never became live. The person asked for two things and got the later one; saying so is
       * the only answer that leaves the app and the disk agreeing.
       *
       * ★ `err.value` IS THIS RUN'S SESSION AND NOTHING ELSE HOLDS A REFERENCE TO IT — and there
       * is nothing on it to close. `RelayMcpTransport` opens no socket of its own (`connect` is
       * one `tools/list` POST, and a watch is opened per CALL — this run made none), and the
       * loopback receiver a wallet sign-in opens is closed in its caller's `finally`. Dropping
       * the reference is the whole of the disposal; a `close()` that does not exist would be a
       * worse thing to write here than this sentence.
       */
      throw new Error('This sign-in was overtaken — you signed out, or signed in again, before it finished. '
        + 'Nothing about the live session was changed.');
    }
    if (isRestoreFailed(err)) {
      /**
       * ★★ THE ONE OUTCOME THIS PROCESS MAY NOT CARRY ON FROM. The sign-in failed AND the session
       * it had put aside could not be put back, so the account's state is cleared and nothing
       * owns it: no credential, no key to seal with, and a panel that would be describing neither
       * identity. Signing out is the only description that is true, and it is a state the person
       * can act on.
       */
      if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
      renewing = null;
      client = null;
      transport = null;
      bearer = null;
      signedInAs = null;
      setAccountEncryption(null);
      hosted.clear();
      endDelegateAttempts();
      setSession({
        state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false,
        why: 'a sign-in failed and the session it had put aside could not be put back, so this process signed '
          + 'itself out rather than carry on holding half of one. Sign in again.',
        sealedReads: false, encryptionPublicKey: null,
      });
      accounts.bumpSubject();
      throw new Error('This sign-in failed, and restoring the session it had put aside failed as well — so this '
        + 'process has signed itself out rather than carry on with half a session. Nothing was written to your pod. '
        + ((err as Error)?.message ?? String(err)));
    }
    /**
     * Everything else: the handover restored, so the OUTGOING account is live again and the panel
     * is describing it correctly. The error belongs to the sign-in and is reported as its own.
     */
    throw err;
  }
  return { pod: adopted.pod, displayName: adopted.displayName, method };
}

/**
 * Arm the renewal for THIS grant, and say so when there is nothing to arm.
 *
 * ★ A GRANT THAT REPORTED NO LIFETIME GETS NO TIMER, NOT A GUESSED ONE. Inventing an hour would
 * mean renewing on a schedule the relay never stated — early is wasteful, late is a lapse in
 * the middle of a session. With no `expiresAt` the shell relies on the 401 recovery below,
 * which is a real mechanism rather than an assumption, and the session panel says which of the
 * two is protecting it.
 *
 * ★ THE TIMER CARRIES THE EPOCH OF THE RUN THAT ARMED IT, and that is what makes a renewal safe
 * beside a switch. One that fires while `adopt` is in flight finds `accounts.current(e)` false
 * and spends no round trip — and it needs no re-issuing, because whichever way that handover
 * ends re-arms one: `commit` for the incoming credential, `restore` for the outgoing one.
 */
function scheduleRenewal(e: Epoch): void {
  if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
  if (!bearer?.expiresAt || !bearer.refreshToken) return;
  const at = Math.max(10_000, bearer.expiresAt - Date.now() - RENEW_MARGIN_MS);
  renewTimer = setTimeout(() => { void renew('the token was about to expire', e); }, at);
}

/**
 * The renewal in flight, if any.
 *
 * ★ ONE AT A TIME, BECAUSE THE REFRESH TOKEN ROTATES. The relay issues a new refresh token and
 * REFUSES the spent one — that is the measurement the docblock below is built on. Three things
 * can ask for a renewal at once (the timer, the session panel's button, and `substrate:call`'s
 * 401 recovery), and the second to arrive would be spending a token the first had already
 * exchanged: it fails, and the catch below then paints `lapsed` over a session that is live.
 * Joining the run already in flight is the same answer to the same question.
 */
let renewing: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a fresh bearer, in place.
 *
 * ★ THE WHOLE CREDENTIAL IS REPLACED, NOT JUST ITS ACCESS TOKEN. The relay ROTATES the refresh
 * token and refuses the spent one — measured — so a shell that swapped only the access token
 * would renew exactly once and then fail an hour later with nobody at the keyboard.
 *
 * ── ★★ AND IT IS THE THIRD WRITER OF THE ACCOUNT'S SHARED STATE ─────────────
 *
 * `setAccountEncryption` names "the two writers" as `adopt` and `auth:signout`. This was the
 * third, it wrote `bearer`, the transport's credential and the whole session panel across an
 * await, and it carried no guard of any kind. Two things were measured (round4/refute-7 #2 and
 * #3):
 *
 *   · Park ACC1's renewal at `/token`, sign out, sign in as ACC2, release — `session:renew`
 *     answered `ok`, ACC1's refreshed credential was written over ACC2's and set on ACC2's
 *     transport, and the panel was wrong. The live session was acting as a departed identity.
 *   · A renewal in flight across a sign-out ALONE un-did the sign-out, and reported
 *     `state: "lapsed", why: "Cannot read properties of null (reading 'setCredential')"` — a raw
 *     JS TypeError shown to a person as the reason their session had lapsed.
 *
 * Both close on the same two moves. The credential and the transport are captured BEFORE the
 * await, so the transport written to is the one that asked and cannot have become null; and the
 * write is a {@link guarded} commit, which re-checks the Epoch and assigns synchronously. The
 * catch is a shared write too and asks first — a lapse notice about a session somebody has
 * already left is painted over whatever they are looking at now.
 *
 * ★ A DROP LEAVES THE PANEL TO WHOEVER TOOK IT. Nothing in this process calls
 * `accounts.begin()`; the only things that end an attempt are `adopt`'s handover and
 * `auth:signout`'s bump, and both write the session themselves as they do it. So a renewal that
 * finds itself superseded has nothing to put right.
 */
function renew(because: string, e: Epoch): Promise<boolean> {
  if (!accounts.current(e)) return Promise.resolve(false);
  const joined = renewing;
  if (joined) return joined;
  const run = renewOnce(because, e).finally(() => {
    // Only if it is still ours: `adopt` and `auth:signout` clear this as they clear the credential.
    if (renewing === run) renewing = null;
  });
  renewing = run;
  return run;
}

async function renewOnce(because: string, e: Epoch): Promise<boolean> {
  /**
   * ★ CAPTURED BEFORE THE AWAIT, WHICH IS THE WHOLE OF THE NULL-DEREFERENCE REPAIR. `transport`
   * is module state a sign-out nulls; reading it back after the round trip is what produced
   * "Cannot read properties of null (reading 'setCredential')" as a user-facing lapse reason.
   */
  const held = bearer;
  const heldTransport = transport;
  if (!held || !heldTransport) return false;
  setSession({ ...session, state: 'renewing', why: because });
  try {
    return await guarded(
      accounts, e,
      () => refreshBearer(RELAY, held),
      (fresh) => {
        bearer = fresh;
        heldTransport.setCredential(fresh);
        setSession({
          ...session, state: 'live', expiresAt: fresh.expiresAt,
          renewable: !!(fresh.refreshToken && fresh.clientId), why: null,
        });
        scheduleRenewal(e);
      },
    );
  } catch (err) {
    /**
     * ★ SAID OUT LOUD. The alternative — carry on and let every read 401 — renders as an empty
     * workspace, which is a statement about somebody's pod made from no read at all.
     *
     * ★ AND SAID AS A SENTENCE. The relay's own message is carried, framed by what was attempted
     * and what it cost, because what this used to hand a person verbatim was a JS TypeError
     * thrown by this function's own null dereference.
     */
    if (!accounts.current(e)) return false;
    setSession({
      ...session, state: 'lapsed',
      why: 'this session could not be renewed — ' + ((err as Error)?.message
        ?? 'the relay refused the refresh and gave no reason')
        + ' Nothing below was refreshed from it, and the credential this process still holds is the expired one.',
    });
    return false;
  }
}

app.whenReady().then(() => {
  // Before anything is drawn or asked: an install from before account keys were address-keyed has
  // its only key in the legacy slot, and every read below works in the new namespace.
  try { migrateLegacyWallet(); } catch { /* see migrateLegacyWallet: never fatal */ }

  ipcMain.handle('identity:describe', () => ({
    relay: RELAY,
    identityServer: IDENTITY,
    secretStore: secretStoreAvailable(),
    // ★ ANY account key, not "the" one. This drives the sentence "signing in with it returns to the
    // same pod", which was true of a single slot and would be a half-truth now: which pod it
    // returns to is whichever key is active, and the sign-in screen lists them.
    hasStoredWallet: accountSlots().length > 0,
    accounts: accountSlots(),
    signedInAs,
    session,
    // Read off the transport rather than written here: the two transports watch differently and
    // a shell that printed "live" over either would be describing a channel it did not open.
    watchDescription: transport?.watchDescription ?? new RelayMcpTransport(RELAY, {
      kind: 'relay-oauth-bearer', accessToken: '', method: 'siwe', expiresAt: null,
      refreshToken: null, clientId: null,
    }).watchDescription,
  }));

  ipcMain.handle('session:status', () => session);
  /**
   * Renew on demand, so the session panel's control is the same path the timer takes.
   *
   * ★ `asOf()`, WHICH SUPERSEDES NOTHING. Pressing this button is not a new attempt at the
   * account — a `begin()` here would cancel the sign-in or the timed renewal already in flight and
   * report `ok: false` for having done so. What the stamp buys is the refusal: taken while `adopt`
   * is mid-handover it is never current, so the renewal drops before it spends a round trip, and
   * `session` below is whatever the switch has already published rather than a panel this handler
   * painted over it.
   */
  ipcMain.handle('session:renew', async () => {
    const ok = await renew('you asked for it', accounts.asOf());
    return { ok, session };
  });

  /**
   * PATH 1 — a wallet this app holds. First run mints one; later runs reuse the ACTIVE one,
   * because the key IS the identity and a new key is a new pod with none of your words on it.
   */
  ipcMain.handle('auth:wallet', async () => {
    const slots = accountSlots();
    const chosen = slots.find((a) => a.active) ?? null;
    let pk = chosen ? readableSecret(ACCOUNT_KEY(chosen.address)).value : null;
    let minted = false;
    if (!pk) {
      // ★ MINTING IS THE LAST RESORT AND ONLY WHEN THIS MACHINE HOLDS NOTHING. It used to be what
      // happened whenever the one fixed slot was empty, which is how somebody who already had a pod
      // got a brand new one instead. A machine that holds a key it could not READ is a different
      // case again and is refused rather than minted over: the key is still there, the pod behind it
      // still exists, and answering that with a fresh identity abandons both silently.
      const unreadable = slots.find((a) => a.unreadable);
      if (unreadable) throw new Error('This machine holds an account key for ' + unreadable.address
        + ' and could not read it back: ' + unreadable.unreadable
        + ' No new identity was minted, because that would leave the pod behind that key stranded.');
      // ★ AND HOLDING KEYS WITH NONE CHOSEN IS NOT HOLDING NOTHING. Reached by deleting the active
      // key while others remain: `accountSlots` marks a single key active on its own, but it will
      // not pick between several, because picking would decide somebody's identity for them. This
      // branch existed and fell through to minting — which is the exact failure the whole change is
      // about, one condition later. The keys are listed on screen; the answer is to press one.
      if (slots.length) throw new Error('This machine holds ' + slots.length + ' account keys and none of them is currently '
        + 'the one to sign in with. Pick one from the list on the sign-in screen. Nothing was minted, because a new key is a '
        + 'new pod with none of your words on it.');
      pk = Wallet.createRandom().privateKey;
      putSecret(ACCOUNT_KEY(new Wallet(pk).address), pk);
      minted = true;
    }
    const who = await signInWithAccountKey(pk);
    return { ...who, mintedNewKey: minted };
  });

  /**
   * WHICH ACCOUNT KEYS THIS MACHINE HOLDS.
   *
   * The `pod` on each is what the relay ANSWERED for that key here, not a name derived from the
   * address — see {@link ACCOUNT_POD}. A key that has never signed in on this machine reports
   * null, which the sign-in screen draws as "not established here" rather than guessing.
   */
  ipcMain.handle('account:list', () => ({ accounts: accountSlots(), secretStore: secretStoreAvailable() }));

  /**
   * ADOPT AN ACCOUNT KEY THE PERSON ALREADY HAS, AND SIGN IN AS IT.
   *
   * ★ THE POINT OF THE WHOLE CHANGE. A pod is reached by holding its key; before this the app
   * could only reach pods it had minted keys for itself, so the person's real identity — the one
   * their Discord messages land on, the one their history is on — was unreachable from here.
   *
   * ★ THE KEY IS STORED BEFORE THE SIGN-IN IS ATTEMPTED, AND THE RENDERER SAYS SO. Storing after
   * would mean a relay outage loses a key somebody has already pasted and closed the source of;
   * storing before means a failed sign-in leaves a key on this machine that has not been shown to
   * work. The second is recoverable and the first is not, so the second is what happens — and the
   * copy on screen states it rather than claiming "nothing was stored", which is what the DELEGATE
   * import's error text claimed while doing exactly this.
   *
   * ★ AND A POD THAT DOES NOT EXIST YET IS NOT AN ERROR. The first pod-aware call PROVISIONS one;
   * measured between 2 and 31 seconds on this fleet. Importing a key for a pod nobody has used is
   * a legitimate, ordinary act and it simply takes that long.
   */
  ipcMain.handle('account:import', async (_e, privateKey: string) => {
    // Checked here even though the renderer checks too: the renderer is the half that renders
    // bytes other people wrote, and a guard that only exists there is a guard.
    const parsed = checkPrivateKey(String(privateKey ?? ''));
    if (!parsed.ok) throw new Error(parsed.why + ' Nothing was stored.');
    // ★ REFUSED BEFORE ANYTHING IS ATTEMPTED WHEN THERE IS NOWHERE SAFE TO PUT IT. `putSecret`
    // already refuses rather than writing plaintext, but it would refuse three lines further down —
    // after this handler had begun an import it cannot finish, and with the renderer about to say
    // the key was stored. Saying it here means the sentence the person reads is true.
    if (!secretStoreAvailable()) {
      throw new Error('The OS secret store is not available on this machine, so there is nowhere to put a private key that '
        + 'is not a plaintext file. NOTHING WAS STORED and nothing was signed in. Browser sign-in holds no key at all.');
    }
    const address = new Wallet(parsed.key).address;
    const before = accountSlots();
    const alreadyHeld = before.some((a) => a.address === address.toLowerCase());
    putSecret(ACCOUNT_KEY(address), parsed.key);
    const who = await signInWithAccountKey(parsed.key);
    return {
      ...who,
      alreadyHeld,
      // What did NOT happen to the other keys, reported as a fact the renderer can state rather
      // than as reassurance it composes.
      kept: before.filter((a) => a.address !== address.toLowerCase()).map((a) => a.address),
    };
  });

  /** Sign in as a stored account key that is not the active one. This is what "switch" means. */
  ipcMain.handle('account:signInAs', async (_e, address: string) => {
    const want = String(address ?? '').toLowerCase();
    const slot = accountSlots().find((a) => a.address === want);
    if (!slot) throw new Error('This machine holds no account key for ' + (want || '(no address given)') + ', so there is nothing to sign in as.');
    const pk = getSecret(ACCOUNT_KEY(want));
    if (!pk) throw new Error('The account key for ' + want + ' is listed on this machine and could not be read back, so it was not used.');
    return signInWithAccountKey(pk);
  });

  /**
   * Delete an account key from this machine.
   *
   * ★ THIS IS NOT THE SAME KIND OF ACT AS FORGETTING A DELEGATE KEY, AND THE RENDERER SAYS SO.
   * A delegate's authority lives on its delegator's pod and survives; forgetting the key only
   * stops this machine driving it. An ACCOUNT key is the whole of an identity — there is no row
   * anywhere that can reconstitute it — so unless the person has the key written down elsewhere,
   * this is the pod becoming permanently unreachable. The handler refuses to touch the key that is
   * signed in right now, because "forget" while live would leave a session running on an identity
   * the machine can no longer reach.
   */
  ipcMain.handle('account:forget', (_e, address: string) => {
    const want = String(address ?? '').toLowerCase();
    if (signedInAs && session.state !== 'signed-out' && readableSecret(ACTIVE_ACCOUNT).value?.toLowerCase() === want) {
      throw new Error('That is the key this session is signed in with. Sign out first — forgetting it while it is live would '
        + 'leave a session running on an identity this machine can no longer reach.');
    }
    forgetSecret(ACCOUNT_KEY(want));
    forgetSecret(ACCOUNT_POD(want));
    if (readableSecret(ACTIVE_ACCOUNT).value?.toLowerCase() === want) forgetSecret(ACTIVE_ACCOUNT);
    return { forgotten: want, accounts: accountSlots() };
  });

  /**
   * END THE SESSION WITHOUT TOUCHING A KEY.
   *
   * ★ WHAT MAKES SWITCHING POSSIBLE AT ALL. Without this, the only way to sign in as a different
   * identity was to restart the app, and a person who has just realised they are on the wrong pod
   * is exactly the person who should not be told to relaunch. The credential is dropped and the
   * renew timer disarmed; the keys stay, because signing out is not forgetting.
   */
  ipcMain.handle('auth:signout', () => {
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
    // The renewal in flight, if any, is no longer this process's business: whatever it returns is
    // about a credential nobody is holding. Dropping the handle also means the next sign-in's
    // renewal does not join it. See {@link renewing}.
    renewing = null;
    bearer = null; transport = null; client = null; signedInAs = null;
    // ★ AND THE ENCRYPTION KEY, which `substrate:seal` reads without consulting the session at
    // all — so leaving it here meant a signed-out process would still seal as the person who
    // left. See `setAccountEncryption`.
    setAccountEncryption(null);
    // Delegate sessions were minted under THEIR OWN keys and are nothing to do with this person's
    // bearer — but they were opened during this person's run, and leaving them live would let the
    // next identity's window drive delegates the previous one switched on.
    hosted.clear();
    setSession({ state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null, sealedReads: false, encryptionPublicKey: null });
    /**
     * ── ★★ THE BUMPS, AND THEY COME AFTER THE WRITES ───────────────────────
     *
     * Clearing alone was not enough once a sign-in's own write moved to the far side of a round
     * trip: sign out while a sign-in is in flight and its continuation wrote the pair straight
     * back. `bumpSubject` is what tells that continuation it is answering about a session nobody
     * is in any more — and, unlike the integer it replaces, it also ENDS ANY HANDOVER'S CUSTODY,
     * so a sign-in that then fails cannot put the departed account back over what was just
     * written here. This handler is the one writing the state, so it is the one that owns it.
     *
     * ★ AND THE DELEGATE COUNTERS TOO, WHICH IS THE OTHER HALF OF `hosted.clear()`. MEASURED
     * (round4/refute-7 #7): a delegate sign-in in flight at this line landed in `hosted` AFTER the
     * clear, so `delegate:list` returned a live delegate with nobody signed in. The map being
     * empty is not the same as the ceremonies filling it having stopped.
     */
    accounts.bumpSubject();
    endDelegateAttempts();
    return { accounts: accountSlots() };
  });

  /**
   * PATH 2 — the relay's own sign-in page in the system browser, which is where a passkey
   * ceremony has to happen: `clientDataJSON.origin` must be the identity server's, and a
   * renderer loaded from `file://` cannot produce that.
   */
  ipcMain.handle('auth:browser', async () => {
    const recv = await startLoopbackReceiver();
    const pending = await beginAuthorization(RELAY, 'interego-workspace-desktop', recv.redirectUri);
    await shell.openExternal(pending.authorizeUrl);
    const code = await recv.code;
    const got = await exchangeCode(RELAY, pending, code, 'webauthn');
    return adopt(got, 'browser');
  });

  /**
   * The ONLY way the renderer reaches the substrate. Name and arguments in, parsed payload
   * out; the bearer stays here.
   */
  /**
   * SEAL A PAYLOAD, IN THE PROCESS THAT HOLDS THE KEY.
   *
   * ── ★★ WHY THE RENDERER CANNOT DO THIS ITSELF ───────────────────────────────
   *
   * It is sandboxed and holds no secret, deliberately — a page whose whole job is rendering bytes
   * other people wrote is the last place to keep one. So the plaintext crosses INTO this process,
   * the ciphertext crosses back, and the key crosses in neither direction.
   *
   * ★ AND THE RECIPIENT LIST IS THE CALLER'S. This process does not decide who a workspace's
   * members are — the renderer read that from the roster, out of each member's own acceptance.
   * Adding a recipient here would be exactly the move the relay was making.
   *
   * ── ★★ WHAT AN `ok` FROM HERE MEANS, AND WHAT IT CANNOT MEAN ─────────────
   *
   * It means END-TO-END, to exactly the `recipientCount` keys the CALLER supplied.
   * `sealForRoster` encrypts to `recipientKeys` and to nothing else; this process adds no
   * recipient of its own, and an empty list is REFUSED (`no_recipients`) rather than turned into
   * an envelope somebody else would fill. There is no degraded success here to tell apart from a
   * real one — whether the relay is inside an envelope built here is settled entirely by the list
   * that crossed the bridge, and `entry.ts` refuses to send `share_with` beside a sealed payload,
   * which is the only argument that would ever have put it there.
   *
   * ★ THE RELAY-READABLE PATH IS NOT REACHED BY FAILING HERE EITHER. `recipientsFor` calls it
   * `Sealing` mode `'escrow'`: the client publishes `share_with` with the payload in the clear,
   * the relay resolves each member to a registered key and puts ITS OWN key in the envelope. A
   * write takes that path when the renderer supplies NO sealer at all — `sealerFor([])` — and
   * never as a fallback from a refusal below, because `postEntry` answers a refusal with
   * `seal_failed` and writes nothing ("a refusal is not a reason to fall back", `entry.ts`).
   * Which of the two a private write took is the renderer's to state, because the roster and the
   * mode are the renderer's; what this process owes is an unambiguous account of what IT did,
   * and refusals that say which state they are refusing from rather than all sounding like "no
   * key".
   */
  ipcMain.handle('substrate:seal', async (_e, req: { graphIri: string; payloadTurtle: string; recipientKeys: readonly string[]; shape?: { iri: string; turtle: string } }) => {
    /**
     * ★ AND THE THIRD STATE, WHICH BOTH CHECKS BELOW WOULD HAVE MISDESCRIBED. Mid-switch the
     * pair is null and `client` is null, so this refused already — as "nothing is signed in",
     * which is true of the process and reads to a person as "you are signed out". The machine
     * still holds the key and an identity is arriving; "seal as whom?" simply has no answer for
     * that second. Naming the switch is the difference between a state somebody waits out and one
     * they go and sign in again over.
     */
    if (accounts.handingOver()) {
      return { ok: false as const, why: 'this app is switching accounts right now, so there is no identity to seal as. '
        + 'Nothing was sealed and nothing was sent. Your key is still on this machine — ask again once the switch has finished.' };
    }
    /**
     * ★ A SESSION AND A KEY, NOT JUST A KEY. This checked only the key, so it was reachable in a
     * signed-out process — and answered, with a seal made under the departed identity. Sealing is
     * an act performed AS somebody; there has to be a somebody.
     */
    if (!client || !signedInAs) {
      return { ok: false as const, why: 'nothing is signed in here, so there is no identity to seal as and nothing was sealed.' };
    }
    if (!accountEncryptionPair) {
      return { ok: false as const, why: 'this session holds no encryption key, so nothing can be sealed here. Sign in with a wallet key.' };
    }
    const out = sealForRoster({
      graphIri: String(req?.graphIri ?? ''),
      payloadTurtle: String(req?.payloadTurtle ?? ''),
      recipientKeys: Array.isArray(req?.recipientKeys) ? req.recipientKeys.map(String) : [],
      sender: accountEncryptionPair,
      ...(req?.shape ? { shape: req.shape } : {}),
    });
    return out.ok
      ? { ok: true as const, graphContent: out.graphContent, contentDigest: out.contentDigest, cleartextMirror: out.cleartextMirror, recipientCount: out.recipientCount }
      : { ok: false as const, why: out.why };
  });

  ipcMain.handle('substrate:call', async (_e, name: string, input: Record<string, unknown>) => {
    /**
     * ★ THE CLIENT IS TAKEN ONCE AND THE CALL IS MADE THROUGH THAT ONE. `once()` below read the
     * module global on every invocation, and the 401 retry re-invokes it after `await renew(...)`
     * — so with the unguarded `renew` this file used to have, a second `adopt` landing in that
     * window issued the renderer's A-scoped tool call against B's client.
     *
     * ★★ WHAT CLOSES THAT IS THE EPOCH `renew` NOW CARRIES, NOT THIS CAPTURE. A renewal that is
     * no longer the current account drops and answers false, so the retry is not reached at all;
     * mutating this line back to `client!` leaves all fourteen cases green. It is kept because it
     * makes the property structural rather than a two-step argument, and because it takes a `!`
     * off a global read on the far side of an await.
     *
     * ★ AND THE OTHER HALF OF THE CENSUS FINDING DOES NOT SURVIVE READING. It said this line could
     * also "dereference a null `client!` and throw a raw TypeError across IPC". Both writers of
     * this state null `client` and `bearer` together, and `renew` returns false when there is no
     * bearer — so the retry that would read the null is never taken. Reported rather than fixed,
     * because there was nothing there to fix.
     */
    const mine = client;
    if (!mine) throw new Error('not signed in yet');
    if (typeof name !== 'string' || !name) throw new Error('a tool call needs a tool name');
    /**
     * ★ WHICH ACCOUNT THIS CALL IS BEING MADE AS, STAMPED BEFORE IT IS MADE. `asOf()` and not
     * `begin()`: this handler fires once per read the renderer makes, and a `begin()` here would
     * supersede — and so cancel — the account's renewal guard and any sign-in commit, on every
     * read in the app. It supersedes nothing and answers only "is this still the account I
     * started as".
     */
    const startedAs = accounts.asOf();
    /**
     * ★★ THE ONE CALL THIS BRIDGE MAY NOT PASS STRAIGHT THROUGH.
     *
     * The renderer is sandboxed and holds no key, by design — the account secret stays in this
     * process. But that means every read it makes arrives here as a raw tool call, and a raw
     * `get_descriptor` returns a SEALED payload that the renderer can do nothing with. The
     * opener installed on this client only ran inside `descriptor()`, which nothing on this path
     * calls, so it was dead code: the app could create a private workspace and then show it as
     * withheld to the very person who created it.
     *
     * Opening it here keeps the secret in the privileged process and hands the renderer plaintext
     * it is entitled to — and `input` is passed through untouched, so `bypass_cache` and anything
     * else the caller sent still applies.
     */
    const once = async (): Promise<{ ok: true; payload: unknown }> => {
      const payload = await mine.tool(name, input ?? {});
      if (name === 'get_descriptor' && payload && typeof payload === 'object') {
        return {
          ok: true,
          payload: await mine.openSealedDescriptor(payload as Record<string, unknown>, String((input ?? {})['url'] ?? '')),
        };
      }
      return { ok: true, payload };
    };
    try {
      return await once();
    } catch (err) {
      const e = err as { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
      // ★ ONE SILENT RECOVERY, AND ONLY FOR THE CODE THAT MEANS THE TOKEN. A 401 arrives as
      // `needs_reauth`; anything else is the relay answering about the CALL and must not be
      // retried, because a write whose outcome is unknown must never be repeated automatically.
      // A read that failed because the hour ran out is a different thing from a write that was
      // refused, and only the first is safe to re-issue.
      if (e.code === 'needs_reauth' && bearer?.refreshToken) {
        /**
         * ★★ THE SAME IDENTITY OR NO RETRY, AND `startedAs` IS THE WHOLE OF HOW THAT IS SAID. The
         * justification above is "safe to re-issue" — and it is safe to re-issue AS THE SAME
         * IDENTITY. Handing `renew` the stamp this call began under makes it refuse outright once
         * a sign-out or a second `adopt` has landed, so `true` here already carries "and it is
         * still the account that asked": {@link guarded} re-checks that Epoch at the instant it
         * commits, and nothing between that commit and this line is more than a microtask.
         *
         * ★ SO THERE IS NO SECOND CHECK HERE, AND ONE WAS WRITTEN AND THEN TAKEN OUT. Nothing could
         * reach it, and a refusal nobody can ever be shown reads as protection that is not there.
         * What would make it reachable is `renew` losing this parameter or gaining an await after
         * its guarded commit — and that is measured from the HARM instead, by the case that counts
         * refresh grants after a switch: a renewal issued on the wrong stamp spends the arriving
         * account's one turn of a rotating key, which is visible whether or not a branch here
         * catches it.
         */
        if (await renew('the relay rejected the session token mid-call', startedAs)) {
          try { return await once(); }
          catch (again) {
            const a = again as { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
            return { ok: false, error: { code: a.code ?? 'upstream_error', message: a.message ?? String(again), retryable: !!a.retryable, retryAfterMs: a.retryAfterMs ?? null } };
          }
        }
        return { ok: false, error: {
          code: 'needs_reauth',
          message: 'This session expired and could not be renewed: ' + (session.why ?? 'the relay gave no reason')
            + '. Nothing below was read, so nothing on screen is a statement about your workspace.',
          retryable: false, retryAfterMs: null,
        } };
      }
      // ★ THE ERROR IS SERIALISED, NOT THROWN ACROSS IPC. Electron stringifies a thrown Error
      // into a message that loses `.code`, and `.code` is what every caller in the client
      // switches on — an outage would have arrived at the renderer indistinguishable from a
      // refusal.
      return { ok: false, error: { code: e.code ?? 'upstream_error', message: e.message ?? String(err), retryable: !!e.retryable, retryAfterMs: e.retryAfterMs ?? null } };
    }
  });

  /**
   * WHICH DELEGATES THIS MACHINE HOLDS A KEY FOR.
   *
   * ★ NOT "WHICH DELEGATES YOU HAVE". That question is answered by the pod, and the renderer asks
   * it with `readDelegates`. This answers the narrower one the renderer cannot answer for itself:
   * which of them can be DRIVEN from this machine. Merging the two would let a keyring stand in
   * for an authorization record.
   *
   * The agent id is computed rather than minted — `delegateAgentId` is a pure function of the pod
   * segment and the surface constant — so listing does not sign anything in. `pod` here is the
   * DELEGATE's own pod (the one its key provisions), which is not where it writes.
   */
  ipcMain.handle('delegate:list', async () => {
    /**
     * ★ THE LISTING BELONGS TO THE ACCOUNT THAT ASKED FOR IT, and it signs delegates in one at a
     * time, so a sign-out lands MIDWAY through an ordinary boot's loop. `hosted` is the person's:
     * `auth:signout` clears it precisely so the next identity's window cannot drive delegates the
     * previous one switched on, and a loop that kept going would put them back an iteration at a
     * time. Each ceremony's own handover already drops its commit; this stops the loop spending
     * four relay round trips and a loopback port per remaining key to produce nothing.
     *
     * `asOf()` because a listing is not an attempt at the account and must supersede none.
     */
    const startedAs = accounts.asOf();
    const out: { address: string; agentId: string | null; why: string | null }[] = [];
    for (const address of listDelegateKeys()) {
      let live = hosted.get(address.toLowerCase()) ?? null;
      let why: string | null = null;
      if (!live && !accounts.current(startedAs)) {
        why = 'this listing began under a session that has since been signed out, or is being switched right '
          + 'now, so no delegate session was opened for it. Which delegates this machine can drive is a '
          + 'question about the person who is signed in; ask again.';
      } else if (!live) {
        /**
         * ★★ ASK THE RELAY, RATHER THAN REPORT THAT NOBODY HAS ASKED IT. THIS WAS A DEADLOCK,
         * AND IT MADE EVERY DELEGATE STOP WORKING THE MOMENT THE APP RESTARTED.
         *
         * This used to return `agentId: null` with "has not signed in during this run", on the
         * principle — a good one — that a COMPUTED id would be this process asserting what the
         * relay would answer. But `hosted` is a per-run Map, so after any restart it is empty and
         * every stored key reported null. The renderer matches a held key to a registry row BY
         * AGENT ID, so a null made the row read "no key on this machine" and DISABLED it — and
         * the id only becomes known by signing the delegate in, which requires selecting the
         * option that is disabled. Nothing could ever break the cycle.
         *
         * MEASURED 2026-08-11: a delegate minted and authorised at 16:20 was unusable by 21:40,
         * with its key sitting in `secrets/delegate-0x03f52e15b9df….bin` the whole time. The app
         * said the key was not on the machine while holding it.
         *
         * The principle is kept exactly — the id still comes from the relay and is never derived
         * here. `delegateSession` performs the real sign-in, so what is reported is established
         * rather than asserted. It costs one ceremony per delegate per run: the session is cached
         * in `hosted`, and a live bearer short-circuits on every later call.
         */
        try { live = await delegateSession(address); }
        catch (e) {
          why = 'this delegate holds a key here but could not open its own relay session, so the '
            + 'id the relay issues it is not established: ' + ((e as Error)?.message ?? String(e));
        }
      }
      out.push({ address, agentId: live?.agentId ?? null, why });
    }
    return { delegates: out, secretStore: secretStoreAvailable() };
  });

  /**
   * Mint a delegate key, sign it in once, and report the identity a delegator must authorise.
   *
   * ★ THE PRIVATE KEY IS RETURNED, ONCE, AND THAT IS DELIBERATE. A delegate that exists only
   * inside one installation is a delegate that dies with the installation — reinstall, and the
   * same person's "same" delegate becomes a different identity with none of its record. Handing
   * the key back at the moment of creation is the only way this app can host an identity without
   * owning it. The renderer shows it with a warning and never stores it.
   */
  ipcMain.handle('delegate:mint', async () => {
    const wallet = Wallet.createRandom();
    putSecret(DELEGATE_KEY(wallet.address), wallet.privateKey);
    const d = await delegateSession(wallet.address);
    return { address: d.address, agentId: d.agentId, pod: d.pod, privateKey: wallet.privateKey };
  });

  /**
   * Adopt a delegate whose key was minted elsewhere. The other half of "identity is not the host".
   *
   * ★ THE SAME PARSER AS AN ACCOUNT IMPORT. It used to be a local regex whose whole vocabulary was
   * "that is not a secp256k1 private key", which is the one thing the person already knows. See
   * `privatekey.ts` — a pasted ADDRESS, a copy that wrapped, and 64 hex digits that are not a valid
   * scalar are three different mistakes with three different fixes.
   */
  ipcMain.handle('delegate:import', async (_e, privateKey: string) => {
    const parsed = checkPrivateKey(String(privateKey ?? ''));
    if (!parsed.ok) throw new Error(parsed.why + ' Nothing was stored.');
    const wallet = new Wallet(parsed.key);
    putSecret(DELEGATE_KEY(wallet.address), wallet.privateKey);
    const d = await delegateSession(wallet.address);
    return { address: d.address, agentId: d.agentId, pod: d.pod };
  });

  /**
   * Forget a key. NOT a revocation, and the renderer says so.
   *
   * The delegation lives on the pod and survives this entirely; deleting the key here only stops
   * THIS machine driving it. `revoke_agent` from the person's own session is the withdrawal, and
   * it is a different button.
   */
  ipcMain.handle('delegate:forget', (_e, address: string) => {
    const key = String(address ?? '').toLowerCase();
    forgetSecret(DELEGATE_KEY(key));
    hosted.delete(key);
    /**
     * ★ AND ANY CEREMONY STILL IN FLIGHT FOR IT. `delegate:list` signs every stored key in on an
     * ordinary boot, so "forget" pressed during that loop would otherwise be undone one await
     * later by the sign-in it interrupted: the key gone from disk and the session live in the map,
     * with nothing left on the machine to explain where it came from. Same shape as the sign-out
     * resurrection, one address wide.
     */
    delegateEpochs(key).bumpSubject();
    return { forgotten: key };
  });

  /**
   * A tool call made BY a delegate, under the delegate's own relay session.
   *
   * ★ THIS IS WHAT MAKES THE ATTRIBUTION MORE THAN A STRING IN A DOCUMENT. The entry's triples
   * name the delegate; this makes the relay authenticate the delegate too, so the write is
   * scope-gated on the delegator's own `register_agent` row and `revoke_agent` actually stops it.
   * Routing a delegate's write through the person's session instead would have left a record
   * saying "the agent wrote this" that the substrate had no reason to believe.
   */
  ipcMain.handle('delegate:call', async (_e, address: string, name: string, input: Record<string, unknown>) => {
    if (typeof name !== 'string' || !name) throw new Error('a tool call needs a tool name');
    let d: HostedDelegate;
    try { d = await delegateSession(String(address ?? '')); }
    catch (err) { return { ok: false, error: { code: 'delegate_unavailable', message: (err as Error)?.message ?? String(err), retryable: false, retryAfterMs: null } }; }
    try { return { ok: true, payload: await d.client.tool(name, input ?? {}) }; }
    catch (err) {
      const e = err as { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
      // ★ ONE RE-MINT, AND ONLY FOR THE CODE THAT MEANS THE HOUR RAN OUT. Anything else is the
      // relay answering about the CALL, and a write whose outcome is unknown must not be repeated.
      if (e.code === 'needs_reauth') {
        hosted.delete(String(address ?? '').toLowerCase());
        try {
          const again = await delegateSession(String(address ?? ''));
          return { ok: true, payload: await again.client.tool(name, input ?? {}) };
        } catch (second) {
          const s = second as { code?: string; message?: string };
          return { ok: false, error: { code: s.code ?? 'upstream_error', message: s.message ?? String(second), retryable: false, retryAfterMs: null } };
        }
      }
      return { ok: false, error: { code: e.code ?? 'upstream_error', message: e.message ?? String(err), retryable: !!e.retryable, retryAfterMs: e.retryAfterMs ?? null } };
    }
  });

  /**
   * WHAT THIS MACHINE CAN RUN THE USER'S AGENT ON.
   *
   * Probed on demand rather than cached at boot: somebody who reads "not signed in", runs
   * `claude auth login` in a terminal and comes back must not be told the same thing by a value
   * this process decided at startup.
   */
  ipcMain.handle('agent:probe', async (): Promise<{ providers: readonly ProviderStatus[]; unsupported: readonly { id: string; label: string; why: string }[] }> => ({
    providers: [await probeClaude()],
    unsupported: [CODEX_UNSUPPORTED],
  }));

  /**
   * ONE MODEL TURN, ON THE USER'S OWN CREDENTIAL.
   *
   * ★ THE ONLY PART OF THE AGENT LOOP THAT LIVES HERE, AND THAT IS DELIBERATE. Deciding whether
   * there is anything to answer, and reading the channel to find out, is `@interego/workspace-client`
   * running in the renderer against state it already holds. Putting the loop here would have meant
   * a SECOND channel reader in a process that does not have one — the "two copies of one intention"
   * that every drift defect in this vertical came from. What the renderer cannot do is spawn a
   * child process, so that, and only that, crosses.
   *
   * ★ AND THE RENDERER CANNOT NAME THE BINARY. The path comes from this process's own probe, not
   * from the call — a renderer that could pass an executable path would be able to make this
   * process run anything, and the renderer is the half that renders bytes other people wrote.
   */

  ipcMain.handle('agent:think', async (
    _e,
    prompt: string,
    systemPrompt: string | null,
    asDelegate?: string,
    /**
     * Who is being answered, and where.
     *
     * ★ CARRIED SO AN APPROVAL IS ANSWERABLE. "Claude Desktop wants to run `npm install`" is not
     * a question anybody can answer safely; "…because goldenfleece asked X in #house" is. The
     * renderer is the only place that knows it, so it travels with the request rather than being
     * re-derived — and it is DESCRIPTIVE only: nothing here grants anything, and a wrong value
     * makes an approval harder to answer, never easier to obtain.
     */
    context?: { readonly agentName?: string; readonly askedBy?: string; readonly channel?: string },
  ) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('a model turn needs a prompt');
    /**
     * ★ THIS TURN IS REGISTERED BEFORE ANY CHILD EXISTS, AND `cancelled` IS CHECKED AFTER EVERY
     * AWAIT. An adversarial review found the hole: the probe below spawns its own child with a
     * 20-SECOND timeout, and the old code only registered a killer once `runClaude` had already
     * spawned. For that whole window `agent:cancel` iterated an empty set, answered
     * `{stopped: 0}`, and the model child then started and ran to completion — on a subscription
     * the user had just switched off. A turn is now a live object from its first line.
     */
    const turn: Turn = { cancelled: false, kill: null };
    thinking.add(turn);
    /**
     * ★ MINTED BEFORE ANYTHING RUNS, so the gate's very first audit line already carries it. It is
     * the join between what a turn COST (the CLI's reply) and what it DID (the gate's trail) —
     * two processes that never speak to each other. Random rather than sequential because two
     * delegates can be answering at the same moment.
     */
    const turnId = randomUUID();
    // ★ AND THE START TIME WITH IT, for the same reason: the record is written when the turn ENDS,
    // so `prov:startedAtTime` taken from that put the beginning of a turn after its own end — and
    // the graph publishes a duration next to it.
    const startedIso = new Date().toISOString();
    /**
     * ★★ THE ID IS ATTACHED IN ONE PLACE, so no return path can forget it.
     *
     * `ipcMain.handle` erases its handler's return type — the boundary is untyped — so a fifth
     * early return added later would compile, ship, and publish a turn record under a fresh random
     * id that matches nothing. Routing every exit through one typed constructor is what makes the
     * contract enforced rather than remembered.
     */
    const asTurn = (r: Omit<ModelTurn, 'turnId'>): ModelTurn => ({ ...r, turnId });

    /**
     * ── ★★ PROOF OF LIFE, BECAUSE A MINUTE OF SILENCE READS AS BROKEN ───────────
     *
     * MEASURED: a turn takes ~56 s on Sonnet and ~70 s on Opus 5, and for all of it the person saw
     * one static panel. That is the complaint this whole vertical keeps producing — "I can't tell
     * if it's working" — and it is not a speed problem. Shaving round trips elsewhere buys a few
     * seconds off seventy; saying what the agent is DOING changes the minute from silence into
     * visible work, which is the thing a person actually wants.
     *
     * ★ NOTHING NEW IS MEASURED TO DO THIS. The permission gate already writes one audit line per
     * tool call, stamped with this turn's id — that is how `toolsInTurn` bills a turn afterwards.
     * Reading the same trail WHILE the turn runs is the identical join, asked earlier. No hook, no
     * streaming parser, no change to how the child is spawned or how its reply is read: the parts
     * of this that were hard to get right are untouched.
     *
     * ★ AND THE TOOL NAMES ONLY, NEVER THE MODEL'S TEXT. A draft that has not been through
     * `checkDraft` has not declared a footing and may never be written at all; previewing it would
     * put unvalidated words on screen as though they were an answer.
     */
    const progress = setInterval(() => {
      let t: ReturnType<typeof toolsInTurn>;
      try { t = toolsInTurn(app.getPath('userData'), turnId); } catch { return; }
      for (const wc of listeners) {
        // A window closed mid-turn is ordinary, not a failure — same rule as `session:changed`.
        if (!wc.isDestroyed()) wc.send('agent:turn-progress', { turnId, tools: t.tools, toolCalls: t.toolCalls, asked: t.asked });
      }
    }, TURN_PROGRESS_MS);

    try {
      // The probe's own child is registered too — see `probeClaude`. Without it a cancel during
      // the probe was recorded and not effected, and the turn sailed on for up to 20 seconds.
      const status = await probeClaude(undefined, (kill) => {
        turn.kill = kill;
        if (turn.cancelled) kill();
      });
      // ★ EVERY PATH CARRIES THE ID, including the ones that never ran a model. The renderer joins
      // its verdict to it, and a refusal returned without one is published under a fresh random id
      // — a permanent record of a turn that cannot be matched to the turn it describes.
      if (turn.cancelled) return asTurn({ ok: false, text: null, ms: 0, why: 'You turned your agent off before it started. Nothing was written.' });
      if (!status.usable || !status.path) return asTurn({ ok: false, text: null, ms: 0, why: status.why });
      const spawnTurn = (tools?: TurnTools, gate?: TurnGate): Promise<ModelRun> => runClaude({
        binary: status.path as string,
        prompt,
        ...(typeof systemPrompt === 'string' && systemPrompt ? { systemPrompt } : {}),
        ...(tools ? { tools } : {}),
        ...(gate ? { gate } : {}),
        onChild: (kill) => {
          turn.kill = kill;
          // Cancelled while the child was being spawned: kill it the moment it exists, or it
          // outlives the cancel by its whole timeout.
          if (turn.cancelled) kill();
        },
      });

      /**
       * ★ THE TURN RUNS UNDER THE DELEGATE'S OWN SESSION, OR UNDER NO TOOLS AT ALL.
       *
       * `asDelegate` is an ADDRESS this process holds a key for, never a bearer from the
       * renderer — the renderer must not be able to name a credential, only a delegate this
       * machine already hosts. `delegateSession` does the sign-in and the relay issues the scope;
       * nothing here decides what the agent may do.
       *
       * ★ AND A FAILURE TO OPEN THAT SESSION FALLS BACK TO NO TOOLS RATHER THAN TO THE PERSON'S.
       * The tempting recovery — use the account session, it is right there — would hand a
       * delegate its human's full credential, which is the one thing every part of this vertical
       * refuses. A turn with no tools still writes a sentence; a turn with the wrong identity
       * writes a permanent record under it.
       */
      let run: ModelRun;
      if (typeof asDelegate === 'string' && asDelegate) {
        let bearer: string | null = null;
        let delegatePod = '';
        let why: string | null = null;
        try {
          const live = await delegateSession(asDelegate);
          bearer = live.bearer.accessToken;
          delegatePod = live.pod;
        } catch (e) { why = (e as Error)?.message ?? String(e); }
        if (bearer) {
          /**
           * ★ THE GATE IS COMPOSED ONLY WHEN THE DELEGATE HAS ITS OWN SESSION. An agent with no
           * relay session is already refused below; giving one a permission gate — and therefore
           * real tools — while it could not establish who it is would be the wrong order to fail
           * in. Capabilities follow identity here, not the other way round.
           */
          const gate = composeGate({
            userData: app.getPath('userData'),
            bundleDir: __dirname,
            agentId: asDelegate,
            agentName: context?.agentName ?? asDelegate,
            askedBy: context?.askedBy ?? 'somebody in the channel',
            channel: context?.channel ?? 'this channel',
            turnId,
          });
          run = await withAgentTools({ relay: RELAY, bearer, delegatePod }, (tools) => spawnTurn(tools, gate));
        } else {
          /**
           * ★ REFUSED, NOT QUIETLY DEGRADED. The tempting recovery is to run the turn with no
           * tools — it would still produce a paragraph, and nobody would see an error. That is
           * the trap: an agent that could not look anything up writes an answer that READS
           * exactly like one that did, and it would land on a permanent public log as though it
           * had. A person who switched on an agent that can consult the substrate is owed the
           * difference between "it looked and this is what it found" and "it could not look".
           *
           * A turn that refuses costs one poll. `agentConsider` runs again on the next read.
           */
          run = {
            ok: false, text: null, ms: 0,
            why: 'This delegate could not open its own relay session, so it has no tools for this '
              + 'turn and nothing was drafted. It is NOT falling back to answering without them: an '
              + 'answer written with no way to look anything up reads exactly like one written after '
              + 'looking, and would land on your log as though it had. ' + (why ?? 'No reason was reported.'),
          };
        }
      } else {
        run = await spawnTurn();
      }
      if (turn.cancelled) return asTurn({ ok: false, text: null, ms: run.ms, why: 'You turned your agent off while it was thinking. Its answer was discarded and nothing was written.' });

      /**
       * ★ WHAT THE TURN COST, RECORDED FROM WHAT THE TOOLS ALREADY REPORTED.
       *
       * Nothing here is estimated. The token counts, turn count, cost and session id are copied
       * out of the CLI's own reply — which the app was parsing and discarding — and the tool calls
       * are counted from the gate's audit trail, joined by `turnId` rather than by a time window,
       * because two delegates answering at once is the ordinary case in a shared workspace.
       *
       * Written after the cancellation check, so a turn the person stopped is not billed to them.
       */
      try {
        const u = usageFrom(run.reply);
        const t = toolsInTurn(app.getPath('userData'), turnId);
        recordTurn(app.getPath('userData'), {
          turnId, atIso: new Date().toISOString(), startedIso,
          agentId: asDelegate ?? 'self',
          agentName: context?.agentName ?? asDelegate ?? 'this client',
          askedBy: context?.askedBy ?? '', channel: context?.channel ?? '',
          ok: run.ok, ms: run.ms, ...u, ...t,
        });
      } catch { /* a record nobody can write must not fail the turn it describes */ }
      return asTurn(run);
    } finally {
      // ★ IN `finally`, so a throw, a cancel and an early return all stop it. A progress timer that
      // outlived its turn would keep reading the audit trail forever and keep a dead turn's tool
      // list on screen — telemetry that misreports the thing it measures.
      clearInterval(progress);
      // ★ `delete`, NOT `clear`. The set exists because a turn being cancelled and one starting
      // can overlap; clearing it on every completion orphaned the other one's child permanently,
      // which is the exact failure the set was introduced to prevent.
      thinking.delete(turn);
    }
  });

  /** Stop any turn in flight. The user turning the agent off has to reach a running child. */
  /**
   * What the renderer decided about a draft. The verdict lives THERE — `checkDraft` runs in the
   * renderer — so main cannot record it at the same moment it records the turn.
   *
   * ★ WITHOUT THIS THE ONLY RECORD OF A REFUSAL IS TEXT IN A PANEL. Live: three turns, all
   * `ok: true`, about $0.27 spent, nothing written, and the reason readable only by the person
   * looking at the screen — so working out why meant asking them to transcribe their own UI.
   */
  ipcMain.handle('agent:draftOutcome', async (_e, rec: {
    turnId?: string; channel?: string; outcome?: string;
    kind?: TurnOutcome; reason?: string; agentId?: string; answeredFor?: string; channelIri?: string;
    channelPrivate?: boolean;
  }) => {
    /**
     * ── ★★ THE SAME FACT, TWICE, ON PURPOSE ────────────────────────────────────
     *
     * The JSONL is the local truth: it survives a relay outage, needs no network, and is what a
     * person can read on their own machine when nothing else works. The published graph is the
     * DURABLE and SHARED one: addressable, joinable to the channel it describes, shape-validated,
     * and — the point of the exercise — readable by the agent it is about.
     *
     * ★ THE LOCAL WRITE HAPPENS FIRST AND UNCONDITIONALLY. A pod that is down must not cost the
     * person the only record they had; telemetry that can lose the thing it measures is worse than
     * none.
     */
    recordDraft(app.getPath('userData'), {
      turnId: String(rec?.turnId ?? ''), atIso: new Date().toISOString(),
      channel: String(rec?.channel ?? ''), outcome: String(rec?.outcome ?? 'unknown'),
    });

    /**
     * ★★ AND PUBLISHED AS A GRAPH THE AGENT CAN READ ABOUT ITSELF. Nothing was added to the relay
     * to make this possible: a turn is an ordinary `publish_context` to the agent's own pod under
     * the harness vocabulary, so discovering it is `discover_context` and reading it is
     * `get_descriptor`. Self-reflection is an EMERGENT affordance of the substrate already there,
     * not a capability anybody had to grant.
     */
    if (!client || !signedInAs?.pod || !rec?.agentId || !rec?.kind) return;

    /**
     * ── ★★ WHAT IT COST, JOINED BACK ON THE WAY OUT ────────────────────────────
     *
     * The cost was measured in `agent:think` and written to `agent-turns.jsonl`; the OUTCOME is
     * decided in the renderer, which is where this arrives from. Both halves are keyed by the same
     * `turnId`, so the record published here is the two joined — and the join is exact rather than
     * "the most recent turn", because two delegates answering at once is the ordinary case.
     *
     * ★ A MISSING JOIN PUBLISHES THE OUTCOME ANYWAY. An agent that wrote nothing is the fact worth
     * having; dropping the record because the cost could not be looked up would lose the important
     * half to protect the cheap one.
     */
    const joined = findTurn(app.getPath('userData'), String(rec?.turnId ?? ''));
    /**
     * ★★ AND NOT FOR A CHANNEL THAT IS NOT KNOWN TO BE PUBLIC.
     *
     * The turn graph is world-readable. The outcome and the channel IRI were already on it; token
     * counts are different in kind, because they are CONTENT-CORRELATED — `inputTokens` tracks how
     * much transcript the delegate was fed and `outputTokens` approximates the length of a reply
     * that is otherwise sealed. Joining those to `ieh:inChannel <a private workspace>` would let an
     * anonymous reader price and size a conversation they cannot read, which is a disclosure this
     * change would have introduced by itself. The numbers stay in `agent-turns.jsonl`, on the
     * machine that spent them, where the person who paid can read them.
     */
    const measured = rec?.channelPrivate ? {} : measuredFacts(joined);
    const out = await publishTurn(client, {
      relay: RELAY, podName: signedInAs.pod,
      facts: {
        // ★ THE SAME ID THE COST WAS RECORDED UNDER, so the graph and the local log name one turn.
        // The fallback exists for a renderer too old to send one, and is deliberately random: an
        // unjoinable record is honest about being unjoinable, where reusing another turn's id would
        // silently merge two.
        turnId: String(rec.turnId || randomUUID()),
        agentId: String(rec.agentId),
        /**
         * ★ WHEN THE TURN STARTED, NOT WHEN THIS ARRIVED. `prov:startedAtTime` is a claim about the
         * activity, and this handler runs after the model has finished and the renderer has judged
         * the draft — so the clock reading here is the END, and publishing it beside `ieh:elapsedMs`
         * described a turn that finished before it began. The fallback is only for a turn with no
         * joinable record, where the least-wrong available answer is "about now".
         */
        atIso: startedAt(joined) ?? new Date().toISOString(),
        outcome: rec.kind,
        ...(rec.reason ? { outcomeReason: rec.reason.slice(0, 400) } : {}),
        ...(rec.answeredFor ? { answeredFor: rec.answeredFor } : {}),
        ...(rec.channelIri ? { inChannel: rec.channelIri } : {}),
        ...measured,
      },
    });
    // Reported into the local log rather than thrown: the turn it describes has already happened,
    // and a record that could fail the work is the thing this is trying to prevent.
    if (!out.ok) {
      recordDraft(app.getPath('userData'), {
        turnId: String(rec?.turnId ?? ''), atIso: new Date().toISOString(),
        channel: String(rec?.channel ?? ''), outcome: 'turn-graph-unpublished: ' + out.why.slice(0, 160),
      });
    }
  });

  ipcMain.handle('agent:cancel', () => {
    let killed = 0;
    const flagged = thinking.size;
    for (const turn of thinking) {
      turn.cancelled = true;
      // A turn between spawns has no child at this instant; `onChild` kills it on arrival.
      if (turn.kill) { try { turn.kill(); killed++; } catch { /* already gone is the ordinary case */ } }
    }
    // ★ `flagged` AND `killed` ARE REPORTED SEPARATELY BECAUSE THEY ARE DIFFERENT FACTS. The first
    // version returned the set size as `stopped`, which counted a turn that had merely been marked
    // as one that had been stopped — and the renderer then told the user "Stopped" on the strength
    // of it. A turn with no live child is flagged, not killed, and the two are not merged.
    return { flagged, killed };
  });

  /**
   * ── ANSWERING WHAT AN AGENT ASKED FOR ──────────────────────────────────────
   *
   * The gate refuses and records; this is where a person answers. Everything below is deliberately
   * a THIN wrapper over `permission.ts`, because the renderer must not be able to describe a
   * permission in its own terms — it can only approve a rule the gate already wrote down.
   *
   * ★ THE RULE IS TAKEN FROM THE PENDING FILE, NOT FROM THE RENDERER. A handler that granted
   * whatever string arrived would make the approval UI itself the way past the boundary: anything
   * able to send an IPC message could grant `Bash(curl …)` without an agent ever asking. So the
   * argument is an id, it is looked up, and a request nobody made cannot be approved.
   */
  // ★ `readSettings`, NOT `readPolicy` — see its comment. `readPolicy` mkdirs a workspace for the
  // agent id it is given, and this handler has no agent: it is a person looking at a list.
  /**
   * What the agents have cost, and who caused it.
   *
   * ★ READ-ONLY AND LOCAL. Nothing here sends anything anywhere; it reads two files this app
   * already writes, in the same directory as the audit trail and the grants.
   */
  ipcMain.handle('telemetry:read', (_e, limit?: number) => {
    const turns = readTurns(app.getPath('userData'), typeof limit === 'number' ? limit : 200);
    return { turns, totals: totals(turns) };
  });

  ipcMain.handle('permission:list', () => ({
    pending: readPending(app.getPath('userData')),
    ...readSettings(app.getPath('userData')),
  }));

  ipcMain.handle('permission:answer', (_e, id: string, approve: boolean) => {
    const userData = app.getPath('userData');
    const req = readPending(userData).find((r) => r.id === id);
    if (!req) return { ok: false, why: 'that request is no longer waiting — it may already have been answered' };
    if (approve) writeGrant(userData, { rule: req.rule, what: req.what, grantedIso: new Date().toISOString() });
    clearPending(userData, req.rule);
    return {
      ok: true,
      why: approve
        ? 'approved — ' + req.agentName + ' may now ' + req.what + ' without asking again'
        : 'turned down — ' + req.agentName + ' will be refused if it tries again',
    };
  });

  ipcMain.handle('permission:revoke', (_e, rule: string) => {
    revokeGrant(app.getPath('userData'), rule);
    return { ok: true, why: 'withdrawn — that goes back to being asked about' };
  });

  /**
   * Nominate a project directory, chosen through the OS picker.
   *
   * ★ THROUGH THE PICKER, NOT A TYPED PATH. A directory arriving as a string is a directory some
   * other code could send; one arriving from `showOpenDialog` was pointed at by the person sitting
   * in front of the machine. Widening an agent's boundary is exactly the operation that should
   * require a hand on the mouse.
   */
  ipcMain.handle('permission:nominate', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a project your agents may work in',
      properties: ['openDirectory'],
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return { ok: false, why: '' };
    return nominate(app.getPath('userData'), dir, true);
  });

  ipcMain.handle('permission:unnominate', (_e, dir: string) => nominate(app.getPath('userData'), dir, false));

  const bootWindow = createWindow();
  // ★ CI LAUNCH SMOKE TEST — only when the workflow sets INTEREGO_DESKTOP_SMOKE=1. See runLaunchSmoke.
  if (process.env['INTEREGO_DESKTOP_SMOKE'] === '1') runLaunchSmoke(bootWindow);
  else watchForRequests();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

/**
 * ── TELLING A PERSON THEIR AGENT IS WAITING ON THEM ──────────────────────────
 *
 * ★ THE PANEL ONLY WORKS IF SOMEBODY IS LOOKING AT IT, AND THE WHOLE POINT IS THAT THEY ARE NOT.
 * A delegate answers Discord while its human is elsewhere; that is what it is for. So a request
 * that only ever appears in a side panel of a window behind three others is, in practice, a
 * refusal with extra steps — the agent says "I have asked" and nothing ever asks.
 *
 * ★ IT WATCHES FROM THE MAIN PROCESS, NOT THE RENDERER. The renderer's poll stops mattering the
 * moment the window is minimised or the machine is locked, which is exactly when this is needed.
 *
 * ★ AND IT NOTIFIES PER RULE, ONCE. An agent that is refused retries — every turn, sometimes every
 * few seconds — and one toast per attempt would train the person to dismiss them without reading,
 * which is worse than silence because it looks like it is working. `told` is the set of rules
 * already raised; a rule answered and asked for again is a new question and does notify.
 *
 * What this is NOT: a way to approve from somewhere else. Clicking brings the window forward and
 * the answer is still given here, because the grant is enforced on this machine by a hook running
 * on this machine. Reaching somebody who is genuinely away — a Discord DM, an approval sent back
 * through the pod — is a further step and is not built.
 */
const told = new Set<string>();
function watchForRequests(): void {
  // Windows shows a toast under the app's identity, and without this it is attributed to the
  // Electron binary — so the notification arrives claiming to be from something the person never
  // installed. electron-builder writes the same id into the shortcut it creates.
  if (process.platform === 'win32') app.setAppUserModelId('com.interego.workspace');

  /**
   * ★★ THE TOAST IS NOT TRUSTED TO ARRIVE, BECAUSE MEASURED, IT DID NOT.
   *
   * On the machine this was built on, `HKCU\…\PushNotifications\ToastEnabled` is `0` — the person
   * turned Windows notifications off. `Notification.isSupported()` still returns true, because it
   * describes the PLATFORM and not the setting, and `show()` returns without error. So the app
   * believed it had escalated, and nothing appeared anywhere.
   *
   * An escalation that fails silently is worse than none: it is a promise the person is relying on.
   * So the toast is one of three signals, and the other two cannot be switched off —
   *
   *   · the taskbar entry FLASHES (`flashFrame`), which no notification setting governs
   *   · the WINDOW TITLE carries the count, so it is in the taskbar hover and in alt-tab
   *
   * Neither is as good as a toast. Both are visible when the toast is not, and between them the
   * claim "you will be told" survives a machine where notifications are off.
   */
  const signal = (count: number): void => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    win.setTitle(count > 0
      ? 'Interego Workspace — ' + String(count) + (count === 1 ? ' request waiting' : ' requests waiting')
      : 'Interego Workspace');
    // Flashing a window that is already in front is noise, and on Windows it is ignored anyway.
    if (count > 0 && !win.isFocused()) win.flashFrame(true);
    if (count === 0) win.flashFrame(false);
  };

  const look = (): void => {
    let pending: readonly { rule: string; what: string; agentName: string; askedBy: string; channel: string }[] = [];
    try { pending = readPending(app.getPath('userData')); } catch { return; }
    const live = new Set(pending.map((r) => r.rule));
    // Forget rules that are no longer pending, so the same question asked again is asked again.
    for (const rule of [...told]) if (!live.has(rule)) told.delete(rule);
    signal(pending.length);

    for (const r of pending) {
      if (told.has(r.rule)) continue;
      told.add(r.rule);
      if (!Notification.isSupported()) continue;
      const n = new Notification({
        title: r.agentName + ' is asking permission',
        // The asker is in the body because it is what makes the request answerable — see the
        // panel's own comment. A toast reading only "wants to run a command" is not a question.
        body: 'To ' + r.what + '\nAsked by ' + r.askedBy + ' in ' + r.channel,
      });
      n.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0] ?? createWindow();
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    }
  };
  // The gate is a separate short-lived process per tool call, so nothing can push here. Five
  // seconds is well inside the time a person takes to react and far outside anything expensive:
  // the read is one small file that usually does not exist.
  const timer = setInterval(look, 5_000);
  timer.unref();
  look();
}

/**
 * Set while the launch smoke is deliberately closing its own window.
 *
 * ★ WITHOUT THIS THE CHECK CANNOT REPORT. Closing the only window fires `window-all-closed`, whose
 * handler quits the app — so the process was gone before the verdict reached stdout, and the
 * launcher, which reads stdout for a marker, saw a silent clean exit. That is indistinguishable
 * from a crash to `ci-launch-smoke.ts` and it failed the leg. The smoke owns its own exit code via
 * `done()`; this keeps the ordinary quit out of its way for the few hundred milliseconds it needs.
 */
let smokeTeardown = false;

/**
 * ★ THE LAUNCH SMOKE TEST, AND WHY IT IS NOT selftest.js.
 *
 * `desktop-package.yml` proves the three platforms BUILD. It did not prove they LAUNCH, and two
 * of them had never been started by anyone. This closes that: gated on INTEREGO_DESKTOP_SMOKE=1
 * (set only by CI), it boots the REAL main process — every handler above, the real
 * `createWindow`, the real `index.html` and preload — and asserts the window reaches
 * `did-finish-load` without the renderer crashing, then exits with a code CI reads.
 *
 * ★ IT IS DELIBERATELY NOT selftest.js. That entry signs in to the live relay, requires an OS
 * secret store — absent on a bare Linux runner, where it exits 2 before touching the network —
 * and, by its own header, "does NOT cover the renderer … a window nobody looked at is not
 * evidence a window works." So it cannot answer the question the release actually needs answered:
 * does the packaged app open a window at all. This can, needs no network and no secret store, and
 * runs headless under xvfb. selftest.js stays the substrate check; this is the launch check.
 *
 * A window that never finishes loading is a FAILURE, reported as one, rather than a hang left to
 * exhaust the job's 40-minute timeout — a timed-out job says nothing about why.
 *
 * ★ AND IT CLOSES THE WINDOW BEFORE IT PASSES, BECAUSE OPENING WAS NEVER THE WHOLE LIFECYCLE.
 * A smoke that only waits for `did-finish-load` proves the app STARTS. It says nothing about the
 * teardown every single user performs, every time, at the end of every session — and that is
 * where this app was broken. `createWindow` registered `win.on('closed', () => listeners.delete(
 * win.webContents))`, and `closed` fires AFTER the window is destroyed, so reading `win.webContents`
 * inside it threw `TypeError: Object has been destroyed`. Nothing caught it, so Electron's default
 * handler put "A JavaScript error occurred in the main process" on screen — a modal the person had
 * to dismiss on the way out of the app, on a build that had passed this very check.
 *
 * So the window is now CLOSED here and any uncaught exception during that teardown fails the run.
 * The handler below is the assertion, not a safety net: it exists so a throw becomes a non-zero
 * exit with the stack on stdout, on all three platforms, instead of a dialog on a developer's
 * screen that CI would never see.
 */
function runLaunchSmoke(win: BrowserWindow): void {
  const done = (code: number, why: string): void => {
    process.stdout.write((code === 0 ? 'SMOKE OK: ' : 'SMOKE FAILED: ') + why + '\n');
    app.exit(code);
    // ★ FORCE the exit if `app.exit` does not take. A lingering helper process that keeps the
    // launcher's stdout open is the difference between a 1-second check and a 40-minute timeout,
    // and this runs on a throwaway runner where an un-reaped child costs nothing.
    setTimeout(() => process.exit(code), 3000).unref();
  };
  // Registered before anything is torn down, so a throw raised by closing the window is reported
  // as this check failing rather than drawn in a dialog box.
  process.on('uncaughtException', (e: Error) => {
    done(1, 'an uncaught exception reached the main process: ' + (e?.stack ?? String(e)));
  });
  const timer = setTimeout(() => done(1, 'the window did not finish loading within 45s'), 45_000);
  const pass = (): void => {
    clearTimeout(timer);
    if (win.isDestroyed()) { done(1, 'the window was destroyed before it finished loading'); return; }
    const open = BrowserWindow.getAllWindows().length;
    // ★ DID THE RENDERER ACTUALLY RUN TO THE END? `did-finish-load` says the PAGE loaded, and says
    // nothing about whether its script threw — an uncaught exception in a renderer is not a crash,
    // not a failed load, and not `render-process-gone`. Without this the smoke passes over a
    // window that finished loading and then died on `missing element #whatever`.
    void win.webContents.executeJavaScript('window.__interegoBooted === true')
      .then((booted: unknown) => {
        if (booted !== true) {
          done(1, 'the page loaded but the renderer did not run to the end — it threw partway '
            + 'through (most often a missing element id), so the window is half-built');
          return;
        }
        finish(open);
      })
      .catch((e: unknown) => { done(1, 'could not ask the renderer whether it booted: ' + String(e)); });
  };
  const finish = (open: number): void => {
    // ★ THE TEARDOWN, EXERCISED. `close()` runs the real `close`/`closed` path — the same one a
    // person triggers with the window's X — and the `uncaughtException` handler above is what
    // turns a throw in any listener on it into a failure. The pass is deferred a tick past the
    // close so that a synchronous throw during teardown lands first and wins.
    smokeTeardown = true;
    win.close();
    setTimeout(() => {
      done(0, 'window reached did-finish-load and closed cleanly; ' + open + ' window(s) had been open');
    }, 250);
  };
  win.webContents.on('did-finish-load', pass);
  win.webContents.on('did-fail-load', (_e, code, desc) => { clearTimeout(timer); done(1, 'did-fail-load ' + code + ' ' + desc); });
  win.webContents.on('render-process-gone', (_e, d) => { clearTimeout(timer); done(1, 'render-process-gone: ' + d.reason); });
  // If the page already finished loading before these listeners attached, did-finish-load will
  // not fire again — cover that so the test cannot hang on a race.
  if (!win.webContents.isLoading()) pass();
}

app.on('window-all-closed', () => {
  // The launch smoke closes the window on purpose and reports a verdict afterwards; quitting here
  // would kill it mid-sentence. It exits with its own code. See `smokeTeardown`.
  if (smokeTeardown) return;
  if (process.platform !== 'darwin') app.quit();
});
