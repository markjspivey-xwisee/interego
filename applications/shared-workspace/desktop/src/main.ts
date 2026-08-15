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
import { readTurns, recordTurn, totals, toolsInTurn, usageFrom } from './telemetry.js';
import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient, type RelayOAuthBearer,
} from '@interego/workspace-client';
import {
  beginAuthorization, exchangeCode, refreshBearer, signInWithWallet, startLoopbackReceiver,
  type AuthMethod,
} from './auth.js';
import {
  ACCOUNT_KEY, ACCOUNT_POD, ACTIVE_ACCOUNT, DELEGATE_KEY, forgetSecret, getSecret, listAccountKeys,
  listDelegateKeys, putSecret, secretStoreAvailable, WALLET_KEY,
} from './secrets.js';
import { checkPrivateKey } from './privatekey.js';
import { encryptionKeyFor, openGraph } from './e2e.js';
import {
  CODEX_UNSUPPORTED, probeClaude, runClaude,
  type ModelRun, type ProviderStatus, type TurnTools,
} from './modelprovider.js';
// The relay's OWN MCP endpoint, named under the delegate's bearer. Not a second server —
// see agent-tools.ts.
import { withAgentTools } from './agent-tools.js';
import type { TurnGate } from './modelprovider.js';

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
}
let session: Session = { state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null };

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
 */
interface HostedDelegate {
  readonly address: string;
  readonly agentId: string;
  readonly pod: string;
  client: WorkspaceClient;
  bearer: RelayOAuthBearer;
}
const hosted = new Map<string, HostedDelegate>();

/** Open (or reuse) a delegate's own relay session. Its key never leaves this process. */
async function delegateSession(address: string): Promise<HostedDelegate> {
  const key = address.toLowerCase();
  const live = hosted.get(key);
  // A bearer inside its last five minutes is re-minted rather than refreshed: this process holds
  // the key, so re-running the ceremony costs four round trips and needs no rotation state — the
  // same reasoning the Discord bot's `BotSession` records.
  if (live && (!live.bearer.expiresAt || live.bearer.expiresAt - Date.now() > RENEW_MARGIN_MS)) return live;
  const pk = getSecret(DELEGATE_KEY(key));
  if (!pk) throw new Error('This app does not hold a key for delegate ' + address + '. It may be authorised on your pod and hosted somewhere else — a delegate is its key, not this application.');
  const wallet = new Wallet(pk);
  const recv = await startLoopbackReceiver();
  let bearer: RelayOAuthBearer;
  try {
    bearer = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri, DELEGATE_SURFACE);
  } finally { recv.close(); }
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const status = await client.podStatus();
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
  await installEncryption(client, pk, agentId);
  const next: HostedDelegate = { address: key, agentId, pod, client, bearer };
  hosted.set(key, next);
  return next;
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
 * GIVE A CLIENT THE KEY IT READS PRIVATE WORKSPACES WITH.
 *
 * ── ★★ THE HALF THAT MAKES THE WORD "END-TO-END" TRUE ───────────────────────
 *
 * The relay keeps a public key an agent supplies and hands back sealed envelopes without opening
 * them. Both are useless until something on this side actually HOLDS a secret: until now no member
 * held a key at all, so "encrypted to its members" meant encrypted to one keypair the relay owns.
 * This registers the public half and installs the opener that uses the private half.
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
 * ★ AND A FAILURE HERE MUST NOT STOP THE SIGN-IN. Registration is a nicety on a pod that may
 * already carry the key; the opener is worth installing either way, because reading is what this
 * key is for and reading does not depend on the registry.
 */
async function installEncryption(target: WorkspaceClient, privateKeyHex: string | null, agentId: string | null): Promise<void> {
  if (!privateKeyHex) return;   // browser sign-in: no key on this machine, so it reads what it can
  const key = encryptionKeyFor(privateKeyHex);
  if (agentId) {
    try {
      await target.tool('register_agent', {
        agent_id: agentId, scope: 'ReadWrite', encryption_public_key: key.publicKey,
      });
    } catch { /* see above: the opener is still worth having */ }
  }
  target.setGraphOpener((sealed) => {
    const opened = openGraph(sealed, key);
    // ★ null means NOT ADDRESSED TO ME, and nothing else. `unreadable` is a fault and is reported
    // as one by leaving the record withheld — never by handing back a substitute string, which
    // would land in a workspace document as if somebody had published it.
    return opened.kind === 'opened' || opened.kind === 'plaintext' ? opened.content : null;
  });
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

/** Resolve which pod the freshly minted session actually writes to, and cache the client. */
async function adopt(next: RelayOAuthBearer, method: AuthMethod, accountKey?: string): Promise<{ pod: string; displayName: string | null; method: AuthMethod }> {
  bearer = next;
  transport = new RelayMcpTransport(RELAY, next);
  client = new WorkspaceClient(RELAY, transport);
  await client.connect();
  const status = await client.podStatus();
  const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
  // The pod SEGMENT, taken from the pod URL — never `displayName`, which is a label the
  // account chose. Using a display name as a pod name addresses a pod that does not exist,
  // and that reads back as an EMPTY LOG rather than as an error.
  const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  if (!pod) throw new Error('get_pod_status answered without a pod URL this client could turn into a pod name, so there is no address to write to.');
  // The key this machine reads private workspaces with, registered against the agent the relay
  // says this session IS. A browser sign-in passes no key and simply reads less.
  const sessionAgent = status['sessionAgent'] as { did?: string; id?: string } | undefined;
  await installEncryption(client, accountKey ?? null, sessionAgent?.did ?? sessionAgent?.id ?? null);
  signedInAs = { method, pod };
  setSession({
    state: 'live', pod, method, expiresAt: next.expiresAt,
    renewable: !!(next.refreshToken && next.clientId),
    why: null,
  });
  scheduleRenewal();
  return { pod, displayName: (status['displayName'] as string) ?? null, method };
}

/**
 * Arm the renewal for THIS grant, and say so when there is nothing to arm.
 *
 * ★ A GRANT THAT REPORTED NO LIFETIME GETS NO TIMER, NOT A GUESSED ONE. Inventing an hour would
 * mean renewing on a schedule the relay never stated — early is wasteful, late is a lapse in
 * the middle of a session. With no `expiresAt` the shell relies on the 401 recovery below,
 * which is a real mechanism rather than an assumption, and the session panel says which of the
 * two is protecting it.
 */
function scheduleRenewal(): void {
  if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
  if (!bearer?.expiresAt || !bearer.refreshToken) return;
  const at = Math.max(10_000, bearer.expiresAt - Date.now() - RENEW_MARGIN_MS);
  renewTimer = setTimeout(() => { void renew('the token was about to expire'); }, at);
}

/**
 * Exchange the refresh token for a fresh bearer, in place.
 *
 * ★ THE WHOLE CREDENTIAL IS REPLACED, NOT JUST ITS ACCESS TOKEN. The relay ROTATES the refresh
 * token and refuses the spent one — measured — so a shell that swapped only the access token
 * would renew exactly once and then fail an hour later with nobody at the keyboard.
 */
async function renew(because: string): Promise<boolean> {
  if (!bearer || !transport) return false;
  setSession({ ...session, state: 'renewing', why: because });
  try {
    const next = await refreshBearer(RELAY, bearer);
    bearer = next;
    transport.setCredential(next);
    setSession({
      ...session, state: 'live', expiresAt: next.expiresAt,
      renewable: !!(next.refreshToken && next.clientId), why: null,
    });
    scheduleRenewal();
    return true;
  } catch (e) {
    // ★ SAID OUT LOUD. The alternative — carry on and let every read 401 — renders as an empty
    // workspace, which is a statement about somebody's pod made from no read at all.
    setSession({
      ...session, state: 'lapsed', why: (e as Error)?.message
        ?? 'the session could not be renewed and the relay gave no reason',
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
  /** Renew on demand, so the session panel's control is the same path the timer takes. */
  ipcMain.handle('session:renew', async () => {
    const ok = await renew('you asked for it');
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
    bearer = null; transport = null; client = null; signedInAs = null;
    // Delegate sessions were minted under THEIR OWN keys and are nothing to do with this person's
    // bearer — but they were opened during this person's run, and leaving them live would let the
    // next identity's window drive delegates the previous one switched on.
    hosted.clear();
    setSession({ state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null });
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
  ipcMain.handle('substrate:call', async (_e, name: string, input: Record<string, unknown>) => {
    if (!client) throw new Error('not signed in yet');
    if (typeof name !== 'string' || !name) throw new Error('a tool call needs a tool name');
    const once = async (): Promise<{ ok: true; payload: unknown }> => ({ ok: true, payload: await client!.tool(name, input ?? {}) });
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
        if (await renew('the relay rejected the session token mid-call')) {
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
    const out: { address: string; agentId: string | null; why: string | null }[] = [];
    for (const address of listDelegateKeys()) {
      let live = hosted.get(address.toLowerCase()) ?? null;
      let why: string | null = null;
      if (!live) {
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
    try {
      // The probe's own child is registered too — see `probeClaude`. Without it a cancel during
      // the probe was recorded and not effected, and the turn sailed on for up to 20 seconds.
      const status = await probeClaude(undefined, (kill) => {
        turn.kill = kill;
        if (turn.cancelled) kill();
      });
      if (turn.cancelled) return { ok: false, text: null, ms: 0, why: 'You turned your agent off before it started. Nothing was written.' };
      if (!status.usable || !status.path) return { ok: false, text: null, ms: 0, why: status.why };
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
      if (turn.cancelled) return { ok: false, text: null, ms: run.ms, why: 'You turned your agent off while it was thinking. Its answer was discarded and nothing was written.' };

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
          turnId, atIso: new Date().toISOString(),
          agentId: asDelegate ?? 'self',
          agentName: context?.agentName ?? asDelegate ?? 'this client',
          askedBy: context?.askedBy ?? '', channel: context?.channel ?? '',
          ok: run.ok, ms: run.ms, ...u, ...t,
        });
      } catch { /* a record nobody can write must not fail the turn it describes */ }
      return run;
    } finally {
      // ★ `delete`, NOT `clear`. The set exists because a turn being cancelled and one starting
      // can overlap; clearing it on every completion orphaned the other one's child permanently,
      // which is the exact failure the set was introduced to prevent.
      thinking.delete(turn);
    }
  });

  /** Stop any turn in flight. The user turning the agent off has to reach a running child. */
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
