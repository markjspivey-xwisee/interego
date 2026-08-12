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

/**
 * One delegate this machine holds a key for.
 *
 * ★ THIS IS A KEYRING, NOT A ROSTER. Which delegates a person HAS is answered by their pod's
 * delegation registry and read in the renderer with `readDelegates`; this says only which of
 * them can be driven from here. `agentId: null` means this delegate has not signed in during
 * this run, so what id the relay issues it is not established — not that it has none.
 */
export interface HostedDelegateInfo {
  readonly address: string;
  readonly agentId: string | null;
  readonly why: string | null;
}

/**
 * One account key this machine holds — one identity it can sign in as.
 *
 * ★ `pod` IS A REMEMBERED ANSWER, NOT A DERIVATION. It is what the relay said the last time this
 * key signed in HERE. Null means "not established on this machine", which is the honest state for
 * a key just pasted in: `u-eth-<first 12 hex of the address>` is what the relay does today, and a
 * client that computed it would address a pod that does not exist the day that changes — read back
 * as an empty log rather than as an error.
 */
export interface AccountKeyInfo {
  readonly address: string;
  readonly pod: string | null;
  /** Whether the plain wallet sign-in uses this one. */
  readonly active: boolean;
  /** Set when the stored ciphertext will not decrypt. Not the same as the key being absent. */
  readonly unreadable: string | null;
}

export interface WorkspaceBridge {
  describe(): Promise<{
    relay: string;
    identityServer: string;
    secretStore: boolean;
    hasStoredWallet: boolean;
    accounts: readonly AccountKeyInfo[];
    signedInAs: { method: string; pod: string | null } | null;
    session: SessionInfo;
    /** How this shell's transport watches, in the transport's own words. Never a literal here. */
    watchDescription: string;
  }>;
  signInWithWallet(): Promise<{ pod: string; displayName: string | null; method: string; address: string; mintedNewKey: boolean }>;
  signInWithBrowser(): Promise<{ pod: string; displayName: string | null; method: string }>;

  /** Which account keys this machine holds. See {@link AccountKeyInfo}. */
  accountList(): Promise<{ accounts: readonly AccountKeyInfo[]; secretStore: boolean }>;
  /**
   * Adopt an account key the person already has, and sign in as it.
   *
   * ★ NOTHING IS OVERWRITTEN. Keys are stored under the address they belong to, so this ADDS one;
   * `kept` names the others, which stay exactly where they were. A private key is the whole of an
   * identity and its loss is permanent, so there is no path here that discards one.
   */
  accountImport(privateKey: string): Promise<{
    pod: string; displayName: string | null; method: string; address: string;
    /** True when this machine already held this exact key — a re-paste, not a new identity. */
    alreadyHeld: boolean;
    kept: readonly string[];
  }>;
  /** Sign in as a stored key that is not the active one. This is what switching identity means. */
  accountSignInAs(address: string): Promise<{ pod: string; displayName: string | null; method: string; address: string }>;
  /**
   * Delete an account key from this machine.
   *
   * ★ NOT THE SAME ACT AS FORGETTING A DELEGATE KEY. A delegate's authority is a row on a pod and
   * survives; an account key IS the identity, and nothing anywhere can reconstitute it. Refused
   * outright while that key is the live session.
   */
  accountForget(address: string): Promise<{ forgotten: string; accounts: readonly AccountKeyInfo[] }>;
  /** Drop the session and keep every key. Signing out is not forgetting. */
  signOut(): Promise<{ accounts: readonly AccountKeyInfo[] }>;
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
  /**
   * Run one model turn.
   *
   * `asDelegate` is the ADDRESS of a delegate this machine holds a key for — never a credential.
   * The main process opens that delegate's own relay session and gives the child the Interego MCP
   * under ITS bearer, so what the agent may do is the scope its delegator granted, enforced by the
   * relay. Omit it and the turn runs with no tools at all.
   */
  agentThink(prompt: string, systemPrompt: string | null, asDelegate?: string): Promise<ModelTurn>;
  /**
   * Stop a turn already running.
   *
   * `flagged` is how many turns were marked cancelled; `killed` is how many had a live child that
   * was actually terminated. They are different facts and are not merged — a turn between spawns
   * is flagged and not killed, and reporting that as "stopped" is a claim about a process nobody
   * signalled.
   */
  agentCancel(): Promise<{ flagged: number; killed: number }>;

  /** Which delegates this machine holds a key for. See {@link HostedDelegateInfo}. */
  delegateList(): Promise<{ delegates: readonly HostedDelegateInfo[]; secretStore: boolean }>;
  /**
   * Mint a delegate identity and return the key ONCE.
   *
   * ★ THE KEY COMES BACK ON PURPOSE. An identity that cannot leave one installation is an
   * identity the installation owns, and a delegate is not owned by the app hosting it. The
   * renderer shows it with a warning, offers no second chance to see it, and stores nothing.
   */
  delegateMint(): Promise<{ address: string; agentId: string; pod: string; privateKey: string }>;
  /** Adopt a delegate minted elsewhere — the other half of "the identity is not the host". */
  delegateImport(privateKey: string): Promise<{ address: string; agentId: string; pod: string }>;
  /** Forget a key. NOT a revocation: the delegation is on the pod and is untouched. */
  delegateForget(address: string): Promise<{ forgotten: string }>;
  /**
   * A tool call made BY a delegate, under the delegate's OWN relay session.
   *
   * This is what makes the attribution more than a string: the relay authenticates the delegate,
   * so the write is scope-gated on the delegator's `register_agent` row and `revoke_agent` stops
   * it for real.
   */
  delegateCall(address: string, name: string, input: Record<string, unknown>): Promise<{ ok: true; payload: unknown } | { ok: false; error: BridgeFailure }>;
}

const bridge: WorkspaceBridge = {
  describe: () => ipcRenderer.invoke('identity:describe'),
  signInWithWallet: () => ipcRenderer.invoke('auth:wallet'),
  signInWithBrowser: () => ipcRenderer.invoke('auth:browser'),
  accountList: () => ipcRenderer.invoke('account:list'),
  accountImport: (privateKey) => ipcRenderer.invoke('account:import', privateKey),
  accountSignInAs: (address) => ipcRenderer.invoke('account:signInAs', address),
  accountForget: (address) => ipcRenderer.invoke('account:forget', address),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  call: (name, input) => ipcRenderer.invoke('substrate:call', name, input),
  sessionStatus: () => ipcRenderer.invoke('session:status'),
  renewSession: () => ipcRenderer.invoke('session:renew'),
  // The listener is wrapped rather than handed `ipcRenderer.on` directly: the event object
  // carries a `sender` the renderer has no business holding.
  onSessionChanged: (fn) => { ipcRenderer.on('session:changed', (_e, s: SessionInfo) => { fn(s); }); },
  agentProbe: () => ipcRenderer.invoke('agent:probe'),
  agentThink: (prompt, systemPrompt, asDelegate) => ipcRenderer.invoke('agent:think', prompt, systemPrompt, asDelegate),
  agentCancel: () => ipcRenderer.invoke('agent:cancel'),
  delegateList: () => ipcRenderer.invoke('delegate:list'),
  delegateMint: () => ipcRenderer.invoke('delegate:mint'),
  delegateImport: (privateKey) => ipcRenderer.invoke('delegate:import', privateKey),
  delegateForget: (address) => ipcRenderer.invoke('delegate:forget', address),
  delegateCall: (address, name, input) => ipcRenderer.invoke('delegate:call', address, name, input),
};

contextBridge.exposeInMainWorld('interego', bridge);
