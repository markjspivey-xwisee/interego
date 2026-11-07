/**
 * The desktop MAIN process carries the person's Hosted Terms tick to the wire for exactly the
 * sign-in it was given for, and supplies none of its own.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. The renderer's tick crosses the IPC bridge as an argument;
 * between it and the identity server sit `auth:wallet`, `delegate:mint` and the sign-in helpers
 * they share. A handler that dropped the argument would leave the app unable to open any new
 * account (every first run, every minted delegate refused with 428); one that SUPPLIED a version
 * — a default, a remembered one, the account's for the delegate — would be agreeing for somebody.
 * Only the wire shows which, so the identity server's `/challenges` body is what is asserted.
 *
 * ★ WHAT IS REAL AND WHAT IS SCRIPTED. REAL: `desktop/src/main.ts` itself, imported and booted,
 * with `auth.ts`, `secrets.ts` (on a temp userData directory) and the workspace client under it.
 * SCRIPTED: `electron` (window, IPC registry, safeStorage), and the network — `globalThis.fetch`
 * answers as the relay and the identity server do, with the identity server's Hosted Terms
 * contract for SIWE (see `desktop-wallet-terms.test.ts`). Loopback requests pass through.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMessage } from 'ethers';
import { DELEGATE_SURFACE, REQUIRED_TOOLS } from '@interego/workspace-client';

const host = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const state = { userData: '' };
  const noop = (): void => {};
  return { handlers, state, noop };
});

vi.mock('electron', () => {
  const wc = {
    setWindowOpenHandler: host.noop, on: host.noop, send: host.noop,
    isDestroyed: (): boolean => false, isLoading: (): boolean => false,
    executeJavaScript: async (): Promise<boolean> => true,
  };
  class FakeWindow {
    readonly webContents = wc;
    on = host.noop; loadFile = host.noop; close = host.noop; show = host.noop; focus = host.noop;
    restore = host.noop; setTitle = host.noop; flashFrame = host.noop;
    isDestroyed = (): boolean => false; isFocused = (): boolean => true; isMinimized = (): boolean => false;
    static getAllWindows(): FakeWindow[] { return []; }
  }
  class FakeNotification { static isSupported(): boolean { return false; } on = host.noop; show = host.noop; }
  return {
    app: {
      whenReady: (): Promise<void> => Promise.resolve(), on: host.noop, getPath: (): string => host.state.userData,
      setAppUserModelId: host.noop, disableHardwareAcceleration: host.noop, quit: host.noop, exit: host.noop,
    },
    ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown): void => { host.handlers.set(name, fn); } },
    BrowserWindow: FakeWindow,
    Notification: FakeNotification,
    dialog: { showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async (): Promise<void> => {} },
    safeStorage: {
      isEncryptionAvailable: (): boolean => true,
      encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer): string => b.toString('utf8'),
    },
  };
});

const RELAY = 'https://relay.interego.xwisee.com';
const IDENTITY = 'https://identity.interego.xwisee.com';
const CURRENT = '2026-11-06-r2';
const STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.xwisee.com/terms/${CURRENT}/`;
const REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

/** What reached the identity server and the relay's verify step, per OAuth client name. */
interface Wire { readonly client: string; readonly challenge: Record<string, unknown>; statement?: string }
let wire: Wire[] = [];
/** Lowercased addresses that hold an account. */
const accounts = new Set<string>();
/** The OAuth client name each pending id was opened for, so a challenge can be attributed. */
let lastClient = '';
let termsReads = 0;

const asJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const challenges = new Map<string, { termsVersion?: string; at: number }>();
let serial = 0;

async function scripted(url: string, init: RequestInit | undefined): Promise<Response> {
  const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
  if (url === IDENTITY + '/.well-known/hosted-interego-terms') {
    termsReads++;
    return asJson({ terms: { version: CURRENT, url: `https://interego.xwisee.com/terms/${CURRENT}/` }, privacyUrl: 'https://interego.xwisee.com/privacy/', betaNotice: 'beta' });
  }
  if (url === RELAY + '/register') {
    lastClient = String((JSON.parse(body) as { client_name?: string }).client_name ?? '');
    return asJson({ client_id: 'client:' + lastClient });
  }
  if (url.startsWith(RELAY + '/authorize')) return new Response('<script>const PENDING_ID = \'pending-1\';</script>', { status: 200 });
  if (url === IDENTITY + '/challenges') {
    const req = JSON.parse(body) as Record<string, unknown>;
    const nonce = 'nonce' + String(++serial).padStart(6, '0');
    const accepted = req['termsVersion'] === CURRENT;
    challenges.set(nonce, { ...(accepted ? { termsVersion: CURRENT } : {}), at: wire.length });
    wire.push({ client: lastClient, challenge: req });
    return asJson({ nonce, ...(accepted ? { termsStatement: STATEMENT } : {}) });
  }
  if (url === RELAY + '/oauth/verify') {
    const proof = JSON.parse(body) as { message?: string; signature?: string; nonce?: string };
    const ch = challenges.get(String(proof.nonce));
    if (!ch) return asJson({ error: 'Unknown or expired nonce' }, 401);
    challenges.delete(String(proof.nonce));
    const message = proof.message ?? '';
    const lines = message.split('\n');
    const signer = verifyMessage(message, String(proof.signature));
    if (signer !== lines[1]) return asJson({ error: 'signature does not match' }, 401);
    wire[ch.at]!.statement = lines[3];
    const account = signer.toLowerCase();
    if (!accounts.has(account)) {
      if (!(lines[3] === STATEMENT && ch.termsVersion === CURRENT)) return asJson({ error: REFUSAL }, 428);
      accounts.add(account);
    }
    return asJson({ redirect: 'http://127.0.0.1/cb?code=siwe-' + account });
  }
  if (url === RELAY + '/token') {
    const form = new URLSearchParams(body);
    return asJson({ access_token: 'tok|' + form.get('client_id') + '|' + form.get('code'), refresh_token: 'r', expires_in: 3600 });
  }
  if (url === RELAY + '/mcp') {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers['Authorization'] ?? '';
    const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } };
    if (rpc.method === 'tools/list') return asJson({ jsonrpc: '2.0', id: rpc.id, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
    const [, clientId, code] = bearer.replace(/^Bearer\s+/i, '').split('|');
    const pod = 'u-eth-' + String(code ?? '').slice(7, 19);
    const clientName = String(clientId ?? '').replace(/^client:/, '');
    const payload = rpc.params?.name === 'get_pod_status'
      ? { pod: RELAY + '/pods/' + pod, displayName: null, sessionAgent: { did: 'did:web:identity.interego.xwisee.com:agents:' + clientName + '-' + pod } }
      : { ok: true };
    return asJson({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: payload } });
  }
  throw new Error('the scripted network was asked for ' + url);
}

let realFetch: typeof fetch;
let userDataDir = '';

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'interego-desktop-terms-'));
  host.state.userData = userDataDir;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    return scripted(url, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* not a failure of this suite */ }
});

/** Boot a FRESH main process on an EMPTY keyring, so the wallet button mints. */
async function boot(): Promise<void> {
  host.handlers.clear();
  wire = [];
  rmSync(userDataDir, { recursive: true, force: true });
  userDataDir = mkdtempSync(join(tmpdir(), 'interego-desktop-terms-'));
  host.state.userData = userDataDir;
  vi.resetModules();
  await import('../desktop/src/main.js');
  await new Promise((r) => setTimeout(r, 0));
}

async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = host.handlers.get(channel);
  if (!fn) throw new Error('main.ts registered no handler for ' + channel);
  return await fn(null, ...args) as T;
}

describe('the desktop main process and the Hosted Terms', () => {
  it('reads the offer for the window to show, and agrees to nothing by reading it', async () => {
    await boot();
    const offer = await ipc<{ state: string; version?: string }>('terms:hosted');
    expect(offer).toMatchObject({ state: 'offered', version: CURRENT });
    expect(termsReads).toBeGreaterThan(0);
    expect(wire).toEqual([]);
  });

  it('★ the first-run wallet press with NO tick asks for no agreement, and the 428 comes back in the server\'s words', async () => {
    await boot();
    const err = await ipc('auth:wallet').then(() => null, (e: Error) => e);
    expect(err?.message).toContain('(HTTP 428): ' + REFUSAL);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.challenge).toEqual({ purpose: 'siwe' });
    expect(wire[0]!.statement).toBe('Sign in to Interego');
  });

  it('★ the first-run wallet press WITH the tick carries exactly that version, signs the server\'s statement, and opens the account', async () => {
    await boot();
    const who = await ipc<{ pod: string; mintedNewKey: boolean }>('auth:wallet', CURRENT);
    expect(who.mintedNewKey).toBe(true);
    expect(who.pod).toMatch(/^u-eth-/);
    expect(wire[0]!.challenge).toEqual({ purpose: 'siwe', termsVersion: CURRENT });
    expect(wire[0]!.statement).toBe(STATEMENT);
    await ipc('auth:signout');
  });

  it('★ a version that is not a dated release is refused before anything is sent', async () => {
    await boot();
    await expect(ipc('auth:wallet', 'latest')).rejects.toThrow(/not a terms version, so nothing was signed/);
    await expect(ipc('delegate:mint', { version: CURRENT })).rejects.toThrow(/not a terms version/);
    expect(wire).toEqual([]);
  });

  it('★ a minted delegate signs in under the delegate surface with the DELEGATE\'s tick, and with none when there was none', async () => {
    await boot();
    const minted = await ipc<{ agentId: string }>('delegate:mint', CURRENT);
    expect(minted.agentId).toContain(DELEGATE_SURFACE);
    expect(wire.map((w) => [w.client, w.challenge['termsVersion'] ?? null, w.statement])).toEqual([[DELEGATE_SURFACE, CURRENT, STATEMENT]]);

    wire = [];
    const err = await ipc('delegate:mint').then(() => null, (e: Error) => e);
    expect(err?.message).toContain('(HTTP 428): ' + REFUSAL);
    expect(wire.map((w) => [w.client, w.challenge['termsVersion'] ?? null, w.statement])).toEqual([[DELEGATE_SURFACE, null, 'Sign in to Interego']]);
  });
});
