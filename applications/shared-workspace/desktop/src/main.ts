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
  RelayMcpTransport, WorkspaceClient, type RelayOAuthBearer,
} from '@interego/workspace-client';
import {
  beginAuthorization, exchangeCode, refreshBearer, signInWithWallet, startLoopbackReceiver,
  type AuthMethod,
} from './auth.js';
import { getSecret, putSecret, secretStoreAvailable, WALLET_KEY } from './secrets.js';
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
 * Kill functions for model turns currently running.
 *
 * A set rather than a single handle because a turn that is being cancelled and one that is
 * starting can overlap by a few milliseconds, and the one thing that must not survive a cancel is
 * a child nobody is holding a reference to.
 */
const thinking = new Set<() => void>();

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
    const status = await probeClaude();
    if (!status.usable || !status.path) return { ok: false, text: null, ms: 0, why: status.why };
    const run = await runClaude({
      binary: status.path,
      prompt,
      ...(typeof systemPrompt === 'string' && systemPrompt ? { systemPrompt } : {}),
      // Handed the killer so `agent:cancel` can actually stop a turn already in flight. An agent
      // the user switched off that keeps thinking and then posts is the thing this must not do.
      onChild: (kill) => { thinking.add(kill); },
    });
    thinking.clear();
    return run;
  });

  /** Stop any turn in flight. The user turning the agent off has to reach a running child. */
  ipcMain.handle('agent:cancel', () => {
    const n = thinking.size;
    for (const kill of thinking) { try { kill(); } catch { /* already gone is the ordinary case */ } }
    thinking.clear();
    return { stopped: n };
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
