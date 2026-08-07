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
 * `auth.ts` except the transport of the three IPC calls: the renderer talks to this process
 * through exactly three channels (`auth:*`, `substrate:call`, `identity:*`), which is a
 * deliberately small surface for that reason.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, type RelayOAuthBearer,
} from '@interego/workspace-client';
import { signInWithWallet, startLoopbackReceiver, beginAuthorization, exchangeCode, type AuthMethod } from './auth.js';
import { getSecret, putSecret, secretStoreAvailable, WALLET_KEY } from './secrets.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

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
let signedInAs: { readonly method: AuthMethod; readonly pod: string | null } | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    backgroundColor: '#12141a',
    title: 'Interego Workspace',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      // The renderer gets no Node and no direct access to this process's globals. It reaches
      // exactly the three channels the preload exposes and nothing else.
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
  void win.loadFile(join(__dirname, '..', 'index.html'));
  return win;
}

/** Resolve which pod the freshly minted session actually writes to, and cache the client. */
async function adopt(bearer: RelayOAuthBearer, method: AuthMethod): Promise<{ pod: string; displayName: string | null; method: AuthMethod }> {
  transport = new RelayMcpTransport(RELAY, bearer);
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
  return { pod, displayName: (status['displayName'] as string) ?? null, method };
}

app.whenReady().then(() => {
  ipcMain.handle('identity:describe', () => ({
    relay: RELAY,
    identityServer: IDENTITY,
    secretStore: secretStoreAvailable(),
    hasStoredWallet: (() => { try { return getSecret(WALLET_KEY) !== null; } catch { return true; } })(),
    signedInAs,
  }));

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
      const bearer = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri);
      const who = await adopt(bearer, 'wallet');
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
    const bearer = await exchangeCode(RELAY, pending, code, 'webauthn');
    return adopt(bearer, 'browser');
  });

  /**
   * The ONLY way the renderer reaches the substrate. Name and arguments in, parsed payload
   * out; the bearer stays here.
   */
  ipcMain.handle('substrate:call', async (_e, name: string, input: Record<string, unknown>) => {
    if (!client) throw new Error('not signed in yet');
    if (typeof name !== 'string' || !name) throw new Error('a tool call needs a tool name');
    try {
      return { ok: true, payload: await client.tool(name, input ?? {}) };
    } catch (err) {
      // ★ THE ERROR IS SERIALISED, NOT THROWN ACROSS IPC. Electron stringifies a thrown Error
      // into a message that loses `.code`, and `.code` is what every caller in the client
      // switches on — an outage would have arrived at the renderer indistinguishable from a
      // refusal.
      const e = err as { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
      return { ok: false, error: { code: e.code ?? 'upstream_error', message: e.message ?? String(err), retryable: !!e.retryable, retryAfterMs: e.retryAfterMs ?? null } };
    }
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
