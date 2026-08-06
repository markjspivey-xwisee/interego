/**
 * The whole surface the renderer gets. Three verbs, no Node, no bearer.
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

export interface WorkspaceBridge {
  describe(): Promise<{
    relay: string;
    identityServer: string;
    secretStore: boolean;
    hasStoredWallet: boolean;
    signedInAs: { method: string; pod: string | null } | null;
  }>;
  signInWithWallet(): Promise<{ pod: string; displayName: string | null; method: string; address: string; mintedNewKey: boolean }>;
  signInWithBrowser(): Promise<{ pod: string; displayName: string | null; method: string }>;
  call(name: string, input: Record<string, unknown>): Promise<{ ok: true; payload: unknown } | { ok: false; error: BridgeFailure }>;
}

const bridge: WorkspaceBridge = {
  describe: () => ipcRenderer.invoke('identity:describe'),
  signInWithWallet: () => ipcRenderer.invoke('auth:wallet'),
  signInWithBrowser: () => ipcRenderer.invoke('auth:browser'),
  call: (name, input) => ipcRenderer.invoke('substrate:call', name, input),
};

contextBridge.exposeInMainWorld('interego', bridge);
