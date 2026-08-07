/**
 * The whole surface the renderer gets. A handful of verbs, no Node, no bearer.
 *
 * ★ THE RENDERER RENDERS BYTES OTHER PEOPLE WROTE. That is the entire threat model of a
 * workspace client: a member's own pod is the attacker's position. So the privileged side is
 * kept to a list short enough to read in one screen, and a tool call is the only thing that
 * crosses — not a URL to fetch, not a path, not a token.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** Mirrors the failure shape `@interego/workspace-client` switches on. */
export interface BridgeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
}

/**
 * What the renderer may say about the session.
 *
 * `lapsed` is the state that makes this worth crossing the boundary at all: a shell whose token
 * expired and which then drew an empty roster has asserted that somebody's workspace is empty
 * from a read that never ran.
 */
export interface SessionInfo {
  readonly state: 'signed-out' | 'live' | 'renewing' | 'lapsed';
  readonly pod: string | null;
  readonly method: string | null;
  readonly expiresAt: number | null;
  readonly renewable: boolean;
  readonly why: string | null;
}

export interface WorkspaceBridge {
  describe(): Promise<{
    relay: string;
    identityServer: string;
    secretStore: boolean;
    hasStoredWallet: boolean;
    signedInAs: { method: string; pod: string | null } | null;
    session: SessionInfo;
    /** How this shell's transport watches, in the transport's own words. Never a literal here. */
    watchDescription: string;
  }>;
  signInWithWallet(): Promise<{ pod: string; displayName: string | null; method: string; address: string; mintedNewKey: boolean }>;
  signInWithBrowser(): Promise<{ pod: string; displayName: string | null; method: string }>;
  call(name: string, input: Record<string, unknown>): Promise<{ ok: true; payload: unknown } | { ok: false; error: BridgeFailure }>;
  sessionStatus(): Promise<SessionInfo>;
  renewSession(): Promise<{ ok: boolean; session: SessionInfo }>;
  /** Push, so a lapse reaches the window without the renderer polling for one. */
  onSessionChanged(fn: (s: SessionInfo) => void): void;
}

const bridge: WorkspaceBridge = {
  describe: () => ipcRenderer.invoke('identity:describe'),
  signInWithWallet: () => ipcRenderer.invoke('auth:wallet'),
  signInWithBrowser: () => ipcRenderer.invoke('auth:browser'),
  call: (name, input) => ipcRenderer.invoke('substrate:call', name, input),
  sessionStatus: () => ipcRenderer.invoke('session:status'),
  renewSession: () => ipcRenderer.invoke('session:renew'),
  // The listener is wrapped rather than handed `ipcRenderer.on` directly: the event object
  // carries a `sender` the renderer has no business holding.
  onSessionChanged: (fn) => { ipcRenderer.on('session:changed', (_e, s: SessionInfo) => { fn(s); }); },
};

contextBridge.exposeInMainWorld('interego', bridge);
