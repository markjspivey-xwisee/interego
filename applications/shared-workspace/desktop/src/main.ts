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

import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient, type RelayOAuthBearer,
} from '@interego/workspace-client';
import {
  beginAuthorization, exchangeCode, refreshBearer, signInWithWallet, startLoopbackReceiver,
  type AuthMethod,
} from './auth.js';
import {
  DELEGATE_KEY, forgetSecret, getSecret, listDelegateKeys, putSecret, secretStoreAvailable, WALLET_KEY,
} from './secrets.js';
import { CODEX_UNSUPPORTED, probeClaude, runClaude, type ProviderStatus } from './modelprovider.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

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
  const next: HostedDelegate = { address: key, agentId, pod, client, bearer };
  hosted.set(key, next);
  return next;
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
  listeners.add(win.webContents);
  win.on('closed', () => { listeners.delete(win.webContents); });
  void win.loadFile(join(__dirname, '..', 'index.html'));
  return win;
}

/** Resolve which pod the freshly minted session actually writes to, and cache the client. */
async function adopt(next: RelayOAuthBearer, method: AuthMethod): Promise<{ pod: string; displayName: string | null; method: AuthMethod }> {
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
  ipcMain.handle('identity:describe', () => ({
    relay: RELAY,
    identityServer: IDENTITY,
    secretStore: secretStoreAvailable(),
    hasStoredWallet: (() => { try { return getSecret(WALLET_KEY) !== null; } catch { return true; } })(),
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
   * PATH 1 — a wallet this app holds. First run mints one; later runs reuse it, because the
   * key IS the identity and a new key is a new pod with none of your words on it.
   */
  ipcMain.handle('auth:wallet', async () => {
    let pk = getSecret(WALLET_KEY);
    let minted = false;
    if (!pk) {
      pk = Wallet.createRandom().privateKey;
      putSecret(WALLET_KEY, pk);
      minted = true;
    }
    const wallet = new Wallet(pk);
    const recv = await startLoopbackReceiver();
    try {
      const got = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri);
      const who = await adopt(got, 'wallet');
      return { ...who, address: wallet.address, mintedNewKey: minted };
    } finally {
      // The wallet path never uses the listener — it posts the proof itself — but the relay
      // requires a registered redirect_uri, and leaving a socket open because it went unused
      // is how a desktop app ends up holding a port for its whole lifetime.
      recv.close();
    }
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
  ipcMain.handle('delegate:list', () => {
    const out: { address: string; agentId: string | null; why: string | null }[] = [];
    for (const address of listDelegateKeys()) {
      const live = hosted.get(address);
      out.push({
        address,
        // Only a session that has actually happened reports an id. A computed one would be this
        // process asserting what the relay would answer, and the relay is the authority on that.
        agentId: live?.agentId ?? null,
        why: live ? null : 'this delegate has not signed in during this run, so the id the relay issues it is not established here',
      });
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

  /** Adopt a delegate whose key was minted elsewhere. The other half of "identity is not the host". */
  ipcMain.handle('delegate:import', async (_e, privateKey: string) => {
    const pk = String(privateKey ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error('That is not a secp256k1 private key. It should be 0x followed by 64 hex characters. Nothing was stored.');
    }
    const wallet = new Wallet(pk);
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
  ipcMain.handle('agent:think', async (_e, prompt: string, systemPrompt: string | null) => {
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
    try {
      // The probe's own child is registered too — see `probeClaude`. Without it a cancel during
      // the probe was recorded and not effected, and the turn sailed on for up to 20 seconds.
      const status = await probeClaude(undefined, (kill) => {
        turn.kill = kill;
        if (turn.cancelled) kill();
      });
      if (turn.cancelled) return { ok: false, text: null, ms: 0, why: 'You turned your agent off before it started. Nothing was written.' };
      if (!status.usable || !status.path) return { ok: false, text: null, ms: 0, why: status.why };
      const run = await runClaude({
        binary: status.path,
        prompt,
        ...(typeof systemPrompt === 'string' && systemPrompt ? { systemPrompt } : {}),
        onChild: (kill) => {
          turn.kill = kill;
          // Cancelled while the child was being spawned: kill it the moment it exists, or it
          // outlives the cancel by its whole timeout.
          if (turn.cancelled) kill();
        },
      });
      if (turn.cancelled) return { ok: false, text: null, ms: run.ms, why: 'You turned your agent off while it was thinking. Its answer was discarded and nothing was written.' };
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

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
