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

/**
 * What this machine can run the user's own agent on.
 *
 * `loggedIn: null` is a real value and means "not established" — the CLI is not installed, so
 * whether this person has a subscription is not something the app has evidence about. A renderer
 * that collapsed it to `false` would be making a statement about somebody's account from a
 * filesystem check.
 */
export interface ProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
  readonly path: string | null;
  readonly shimOnly: boolean;
  readonly loggedIn: boolean | null;
  readonly authMethod: string | null;
  readonly account: string | null;
  readonly subscription: string | null;
  readonly why: string;
  readonly usable: boolean;
}

export interface ModelTurn {
  readonly ok: boolean;
  readonly text: string | null;
  readonly why: string;
  readonly ms: number;
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

  /** What this machine can run the user's agent on, asked fresh every time. */
  agentProbe(): Promise<{ providers: readonly ProviderInfo[]; unsupported: readonly { id: string; label: string; why: string }[] }>;
  /**
   * One model turn on the user's own credential.
   *
   * No binary path and no model credential crosses in either direction — the renderer says what to
   * ask, the main process decides what to ask it with.
   */
  agentThink(prompt: string, systemPrompt: string | null): Promise<ModelTurn>;
  /**
   * Stop a turn already running.
   *
   * `flagged` is how many turns were marked cancelled; `killed` is how many had a live child that
   * was actually terminated. They are different facts and are not merged — a turn between spawns
   * is flagged and not killed, and reporting that as "stopped" is a claim about a process nobody
   * signalled.
   */
  agentCancel(): Promise<{ flagged: number; killed: number }>;
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
  agentProbe: () => ipcRenderer.invoke('agent:probe'),
  agentThink: (prompt, systemPrompt) => ipcRenderer.invoke('agent:think', prompt, systemPrompt),
  agentCancel: () => ipcRenderer.invoke('agent:cancel'),
};

contextBridge.exposeInMainWorld('interego', bridge);
