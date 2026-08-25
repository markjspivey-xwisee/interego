/**
 * WHOSE KEY IS IN THE ACCOUNT'S GLOBALS, AND WHEN.
 *
 * ★ WHY THIS FILE EXISTS. `main.ts` had no automated test at all, and the defect it was written
 * for is invisible to every other kind of check: `installEncryption` was ONE function with TWO
 * callers, so `delegateSession` wrote `accountEncryptionPair` — the person's own sealing key —
 * with a delegate's. It typechecked, it read correctly at both call sites, and the comment
 * directly above the account globals asserted it could not happen. Only driving the two sign-ins
 * in sequence and asking what the process would seal with shows it.
 *
 * ★★ AND THEN THE REPAIR FOR IT BROKE THE SAME INVARIANT FROM THE OTHER END, WHICH IS WHY HALF
 * THE CASES BELOW ARE ABOUT TIMING RATHER THAN ABOUT DELEGATES. Splitting the installer left the
 * account's write on the far side of `register_agent`, so a sign-out landing during a sign-in was
 * undone by that sign-in's own continuation and the process kept sealing as the identity that had
 * left; switching accounts sealed with the OUTGOING key for the length of the round trip. Both
 * were reproduced before the fix and both are pinned here, by PARKING a sign-in inside one relay
 * round trip (see {@link parkAt}) and asking the same question — seal now, as whom? — in the gap.
 *
 * ★★ WHAT IS REAL HERE AND WHAT IS SCRIPTED, stated exactly, because a harness that STANDS IN for
 * the thing under test cannot verify it.
 *   REAL: `src/main.ts` itself, imported and booted — every IPC handler below is the shipping one,
 *         reached the way the renderer reaches it. REAL: `src/auth.ts` (the whole OAuth + SIWE
 *         ceremony, including the loopback receiver on a real port), `src/secrets.ts` (the real
 *         address-keyed slots, on a temp userData directory), `RelayMcpTransport`,
 *         `WorkspaceClient`, and the two things the finding is actually about — `encryptionKeyFor`
 *         and `sealForRoster`. Nothing inside them is stubbed, so the envelope inspected below is
 *         a genuine one.
 *   SCRIPTED: two things, and both are genuinely outside this process. `electron` — the window,
 *         the IPC registry, `safeStorage` and `app.getPath`. And the NETWORK: `globalThis.fetch`
 *         answers as the relay and the identity server would, keyed on the bearer, so which
 *         identity a call was made AS is carried the way the live fleet carries it rather than
 *         asserted here. Loopback requests are passed through to the real receiver.
 *
 * ★ THE DELEGATE IS SIGNED IN THROUGH `delegate:list`, NOT `delegate:import`, and that is the
 * point of the case rather than a convenience. `delegate:list` is what an ORDINARY BOOT runs —
 * the renderer fires `loadDelegates()` after sign-in, and the handler signs in every stored
 * delegate key it holds because the relay is the only thing that can say what agent id a key
 * gets. Nobody has to do anything unusual to reach this.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { DELEGATE_SURFACE, REQUIRED_TOOLS, type WorkspaceClient } from '@interego/workspace-client';
// ★ THE SAME MODULE `main.ts` DERIVES WITH — the package `exports` entry, not `src/`. A second
// copy would still agree (the derivation is deterministic), and that agreement is exactly what
// would make a divergence between the built artifact and the source invisible here.
import { encryptionKeyFor } from '@interego/workspace-client/opener';
// The real sealer, used here to make an envelope for the DELEGATE to open — see the read-half case.
import { sealForRoster } from '@interego/workspace-client/sealer';

/**
 * The Electron surface `main.ts` boots against, and the IPC registry the cases drive it through.
 *
 * ★ `vi.hoisted` RATHER THAN A PLAIN `const`. `vi.mock` factories are hoisted above the module's
 * own imports, and `src/secrets.ts` is imported statically below — so the factory runs before any
 * ordinary top-level binding is initialised, and reaching one from inside it is a temporal dead
 * zone error rather than a mock.
 */
const host = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  /** Set before anything is booted; `secretPath` reads it on every call, never at import. */
  const state = { userData: '' };
  const noop = (): void => {};
  return { handlers, state, noop };
});

vi.mock('electron', () => {
  const wc = {
    setWindowOpenHandler: host.noop,
    on: host.noop,
    send: host.noop,
    isDestroyed: (): boolean => false,
    isLoading: (): boolean => false,
    executeJavaScript: async (): Promise<boolean> => true,
  };
  class FakeWindow {
    readonly webContents = wc;
    on = host.noop;
    loadFile = host.noop;
    close = host.noop;
    show = host.noop;
    focus = host.noop;
    restore = host.noop;
    setTitle = host.noop;
    flashFrame = host.noop;
    isDestroyed = (): boolean => false;
    isFocused = (): boolean => true;
    isMinimized = (): boolean => false;
    static getAllWindows(): FakeWindow[] { return []; }
  }
  class FakeNotification {
    // Off, so `watchForRequests` never constructs one. The toast is not what is under test.
    static isSupported(): boolean { return false; }
    on = host.noop;
    show = host.noop;
  }
  return {
    app: {
      whenReady: (): Promise<void> => Promise.resolve(),
      on: host.noop,
      getPath: (): string => host.state.userData,
      setAppUserModelId: host.noop,
      disableHardwareAcceleration: host.noop,
      quit: host.noop,
      exit: host.noop,
    },
    ipcMain: {
      handle: (name: string, fn: (...args: unknown[]) => unknown): void => { host.handlers.set(name, fn); },
    },
    BrowserWindow: FakeWindow,
    Notification: FakeNotification,
    dialog: { showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }) },
    /**
     * The system browser, standing in for the person who clicks through the relay's sign-in page.
     * It answers the loopback receiver `auth:browser` is waiting on, which is what makes PATH 2
     * drivable at all — see `startLoopbackReceiver`.
     */
    shell: {
      openExternal: async (url: string): Promise<void> => {
        const redirect = new URL(url).searchParams.get('redirect_uri');
        if (redirect) await fetch(redirect + '?code=' + BROWSER_CODE);
      },
    },
    /**
     * ★ AVAILABLE, AND A REAL ROUND TRIP. `putSecret` refuses outright when the store says no, so
     * an unavailable stand-in would make every case below fail for a reason that is not the
     * finding. What it is NOT is encryption — see `secrets.ts`, which is explicit that OS-level
     * protection is the whole of what the real one buys.
     */
    safeStorage: {
      isEncryptionAvailable: (): boolean => true,
      encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer): string => b.toString('utf8'),
    },
  };
});

// Imported AFTER the mock is registered, so it binds the fake `safeStorage`/`app` — this is the
// real slot writer, playing the part of "this machine already held these keys when it booted".
import { DELEGATE_KEY, forgetSecret, putSecret } from '../applications/shared-workspace/desktop/src/secrets.js';

const RELAY = 'https://relay.interego.xwisee.com';
const IDENTITY = 'https://identity.interego.xwisee.com';
const DESKTOP_CLIENT = 'interego-workspace-desktop';
const BROWSER_CODE = 'browser-code';

// Three ordinary secp256k1 private keys. Fixed, so the derived encryption keys below are too.
const HUMAN_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// A SECOND account on the same machine, which is the ordinary way a person reaches two pods —
// see `AccountSlot`. The switching case needs two real keys because the question it asks is
// "whose key is the process holding while the second one is still in flight".
const OTHER_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const DELEGATE_PK = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
/**
 * A SECOND delegate key, put in the store by the one case that needs two and taken out again.
 *
 * ★ IT IS NOT IN THE STANDING FIXTURE ON PURPOSE. `delegate:list` is a serial loop, so a case
 * about the loop STOPPING needs a second iteration to stop at — and every other case in this file
 * asks about `delegates[0]` or counts the clients one boot built, so a second key standing in the
 * store the whole time would change what four of them are measuring.
 */
const DELEGATE_2_PK = '0x4bbbf85ce3377467afe5d46f804f221813b2bb19f1932a38faf1d7a2c73f0d97';
const DELEGATE_ADDRESS = new Wallet(DELEGATE_PK).address;
const OTHER_ADDRESS = new Wallet(OTHER_PK).address;
const HUMAN_ADDRESS = new Wallet(HUMAN_PK).address;

/** The SIWE code the scripted relay mints for one wallet — what a bearer carries its identity in. */
const codeFor = (address: string): string => 'siwe-' + address.toLowerCase();

const humanKey = encryptionKeyFor(HUMAN_PK);
const otherKey = encryptionKeyFor(OTHER_PK);
const delegateKey = encryptionKeyFor(DELEGATE_PK);

/** A private workspace the DELEGATE is a recipient of, and its plaintext. */
const SEALED_URL = RELAY + '/ns/u-eth-passkey/private-room';
const SEALED_LINE = 'only a named recipient can read this';
/**
 * ★ SEALED TO THE DELEGATE AND TO NOBODY ELSE. The human's key is deliberately not a recipient:
 * an envelope both could open would pass whether the delegate's own opener was installed or its
 * human's was, and telling those two apart is the whole point of the case that reads it.
 */
const sealedForDelegate = sealForRoster({
  graphIri: SEALED_URL,
  payloadTurtle: '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<' + SEALED_URL + '#e1> dct:title "' + SEALED_LINE + '" .\n',
  recipientKeys: [delegateKey.publicKey],
  sender: humanKey,
});

/**
 * A SECOND private room, sealed to ACC2 ALONE, with a descriptor the relay could not finish
 * checking.
 *
 * ★★ WHY BOTH HALVES ARE HERE. Two mutants survived the five cases this file shipped with, and
 * each needs one of them. `prepareAccountEncryption(mine, …)` → `(client!, …)` puts the incoming
 * account's opener on whatever client the MODULE GLOBAL happens to hold, which nothing observed
 * because no case ever asked a second sign-in to read anything back — so the envelope is sealed
 * to ACC2 and to nobody else, and only the client ACC2's own sign-in built can open it. And
 * deleting the SECOND argument of `setGraphOpener(openerFor(pk), sealedBindingCheck)` costs the
 * reader the half of the authorship proof the relay is structurally unable to run, with no other
 * symptom at all — so the descriptor below carries a real proof, `authorshipVerified` and
 * `descriptorBinding.bound` and a `contentHash`, and the case reads the verdict off it.
 */
const SWITCH_GRAPH = RELAY + '/ns/u-eth-second/switch-stream';
const SWITCH_URL = RELAY + '/ns/u-eth-second/switch-stream/9';
const SWITCH_LINE = 'the account that arrived can read its own room';
const SWITCH_AGENT = 'did:web:identity.interego.xwisee.com:agents:' + DESKTOP_CLIENT + '-u-eth-second';
const sealedForOther = sealForRoster({
  graphIri: SWITCH_GRAPH,
  payloadTurtle: '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<' + SWITCH_GRAPH + '#e1> dct:title "' + SWITCH_LINE + '" .\n',
  recipientKeys: [otherKey.publicKey],
  sender: humanKey,
});

/**
 * What the relay serves for {@link SWITCH_URL}.
 *
 * ★ `contentBinding: 'declared'` IS THE RELAY BEING HONEST, not a gap in the fixture: the payload
 * is sealed and the relay is not a recipient, so it verified the signature and could not compare
 * it against bytes it cannot read. `sealedBindingCheck` is the half only a recipient can finish,
 * and `iep:contentHash` is what the publisher committed to — taken from the sealer itself, so a
 * reader that digests the wrong REGION reports `mismatched` here rather than passing.
 */
const switchDescriptorTurtle = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
  + '<' + SWITCH_URL + '> iep:describes <' + SWITCH_GRAPH + '> ;\n'
  + '  iep:authorshipProof [\n'
  + '    iep:issuer <' + SWITCH_AGENT + '> ;\n'
  + '    iep:verificationMethod <did:key:zRelay#k> ;\n'
  + '    iep:signerAddress "0xabc" ;\n'
  + '    iep:created "2026-08-25T10:00:00.000Z" ;\n'
  + '    iep:ownerWebId <https://identity.interego.xwisee.com/users/u-second/profile#me> ;\n'
  + '    iep:descriptorId <' + SWITCH_URL + '> ;\n'
  + '    iep:proofValue "0xsig" ;\n'
  + '    iep:contentHash "' + (sealedForOther.ok ? sealedForOther.contentDigest : '') + '" ;\n'
  + '  ] .\n';

const switchDescriptor = (): Record<string, unknown> => ({
  turtle: switchDescriptorTurtle,
  graph: { encrypted: true, content: null },
  authorship: {
    authorshipVerified: true,
    signedBy: SWITCH_AGENT,
    verificationMethod: 'did:key:zRelay#k',
    contentBinding: 'declared',
    contentBindingNote: 'the proof commits to a digest and nothing was checked against it',
    descriptorBinding: { bound: true, basis: 'exact-url' },
  },
});

/** Which envelope the relay is holding for a graph URL. Empty for one it has never been told about. */
function envelopeFor(url: string): string {
  if (url === SEALED_URL) return sealedForDelegate.ok ? sealedForDelegate.graphContent : '';
  if (url === SWITCH_URL) return sealedForOther.ok ? sealedForOther.graphContent : '';
  return '';
}

/** Every `tools/call` the scripted relay saw, and the bearer it arrived under. */
interface RelayCall {
  readonly bearer: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}
let seen: RelayCall[] = [];

/**
 * Every `/token` request, as its form.
 *
 * ★ A REFRESH TOKEN IS SPENT WHETHER OR NOT ITS ANSWER IS USED, and that is a harm no tool call
 * shows. The relay ROTATES it and refuses the old one, so a renewal issued on behalf of the wrong
 * account has taken the RIGHT account's one turn of the key — the request is the harm, and `seen`
 * only carries `/mcp`.
 */
let tokenRequests: URLSearchParams[] = [];

/** Who a bearer belongs to, decoded the way the live relay decodes one: from the token itself. */
interface Caller {
  readonly clientName: string;
  readonly pod: string;
  readonly agentId: string;
}
function callerOf(authorization: string): Caller {
  const [, clientId, code] = authorization.replace(/^Bearer\s+/i, '').split('|');
  const clientName = (clientId ?? '').replace(/^client:/, '');
  // A wallet sign-in's pod is a function of its address, exactly as the relay provisions one; the
  // browser path holds no key here and gets the pod its passkey account already had.
  const pod = code && code.startsWith('siwe-') ? 'u-eth-' + code.slice(7, 19) : 'u-eth-passkey';
  // ★ THE CLIENT NAME IS INSIDE THE AGENT DID, which is why `auth.ts` signs a delegate in under
  // `DELEGATE_SURFACE` and not under this app's name. Reproduced here so the assertions can tell
  // a delegate's own session from its human's by looking at what the relay answered.
  return { clientName, pod, agentId: 'did:web:identity.interego.xwisee.com:agents:' + clientName + '-' + pod };
}

const asJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * ★★ HOLD A SIGN-IN INSIDE ONE RELAY ROUND TRIP, AND ASK THE PROCESS A QUESTION IN THE GAP.
 *
 * This is the only way to measure the defects the split introduced. Both of them are about WHEN
 * the account's key is written relative to a network call, and a sign-in driven to completion
 * cannot show them — the end state is identical either way. Parking the first matching
 * `tools/call` and releasing it on the case's word turns "there is a window here" into a moment a
 * test can stand in.
 *
 * ★ ONE CALL ONLY. The gate clears itself the instant it catches something, so the rest of the
 * sign-in (and every other session's traffic, delegates included) runs at full speed. A gate that
 * stayed armed would deadlock the release, because releasing needs the case to keep running.
 */
interface Park {
  /** Resolves once the matching call has arrived and is being held. */
  readonly reached: Promise<void>;
  /** Let it through. */
  release(): void;
}

/**
 * One request the relay is holding, described so a case can say WHICH.
 *
 * ★ `/token` IS A KIND OF ITS OWN, AND IT HAD TO BECOME ONE. Three of the cases below are about a
 * RENEWAL landing across a sign-out or a switch, and a renewal is not a tool call — it is a
 * `grant_type=refresh_token` POST to `/token`, the one request this app makes with no bearer on
 * it at all. So the park matches on the BODY there, which is also what tells it apart from the
 * `authorization_code` POST every sign-in makes, including the sign-in a case fires while the
 * renewal is parked.
 */
interface ParkedCall {
  readonly kind: 'tool' | 'token';
  /** The tool name, or '' for a token request. */
  readonly name: string;
  /** The Authorization header, or '' for a token request. */
  readonly bearer: string;
  /** The raw request body, which is where a token request's grant type and code are. */
  readonly body: string;
}
let park: { match: (c: ParkedCall) => boolean; arrive: () => void; released: Promise<void> } | null = null;

function parkAt(match: (c: ParkedCall) => boolean): Park {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => { arrive = r as () => void; });
  const released = new Promise<void>((r) => { open = r as () => void; });
  park = { match, arrive, released };
  return { reached, release: (): void => { open(); } };
}

/** Hold this request if it is the one a case asked for. Called from both request paths. */
async function holdIfParked(c: ParkedCall): Promise<void> {
  if (!park || !park.match(c)) return;
  const held = park;
  park = null;
  held.arrive();
  await held.released;
}

/** Which bearers a park may catch. The delegate's traffic must never be mistaken for the account's. */
const asDesktop = (bearer: string): boolean => bearer.includes('client:' + DESKTOP_CLIENT);

/** A park on the RENEWAL of one wallet's grant, and on nothing else. */
const renewalOf = (address: string) => (c: ParkedCall): boolean => {
  if (c.kind !== 'token') return false;
  const form = new URLSearchParams(c.body);
  return form.get('grant_type') === 'refresh_token'
    && (form.get('refresh_token') ?? '') === 'refresh|' + codeFor(address);
};

/**
 * Injected failures, all reset by {@link boot}.
 *
 * · `podless` — bearers whose `get_pod_status` answers WITHOUT a pod URL. That is one of the
 *   three throws the census names inside `adopt`'s awaited half, and it is the cheapest of them
 *   to stand up: it needs no transport error and it exercises the same failure path as a dead
 *   `connect` or a key that will not derive.
 * · `reject401` — HTTP 401 for the matching (tool, bearer), which is how a relay redeploy
 *   answers a token the previous revision issued. HOW MANY TIMES IS THE CASE'S TO DECIDE, and the
 *   number is the difference between the two cases that use it: ONE 401 lets the transport's own
 *   re-mint recover the call, TWO carries the failure past the re-mint to the host as
 *   `needs_reauth`, which is the only way `substrate:call`'s renewal path is reached at all.
 * · `refuseRenewal` — `/token` refuses a refresh grant, so the honest-message half of `renew`'s
 *   catch can be read.
 */
const podless: string[] = [];
let reject401: ((name: string, bearer: string) => boolean) | null = null;
let refuseRenewal = false;

/**
 * WHICH MINT A BEARER CAME FROM, so "ACC1's refreshed credential ended up on ACC2's transport" is
 * a thing a case can read off the wire rather than infer. A renewal returns a token for the SAME
 * subject, so without this every mint for one account is the same string.
 */
let mints = 0;

/** The relay and the identity server, answering the six requests a sign-in actually makes. */
async function scriptedRelay(url: string, init: RequestInit | undefined): Promise<Response> {
  const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');

  if (url === RELAY + '/register') {
    const reg = JSON.parse(body) as { client_name?: string };
    return asJson({ client_id: 'client:' + (reg.client_name ?? '') });
  }
  if (url.startsWith(RELAY + '/authorize')) {
    return new Response('<script>const PENDING_ID = \'pending-1\';</script>', { status: 200 });
  }
  if (url === IDENTITY + '/challenges') return asJson({ nonce: 'nonce-1' });
  if (url === RELAY + '/oauth/verify') {
    const proof = JSON.parse(body) as { message?: string };
    // The address is the second line of a SIWE message, and it is what the code is minted for —
    // so the bearer that comes back is bound to the wallet that actually signed.
    const address = (proof.message ?? '').split('\n')[1] ?? '';
    return asJson({ redirect: 'http://127.0.0.1/cb?code=siwe-' + address.toLowerCase() });
  }
  if (url === RELAY + '/token') {
    const form = new URLSearchParams(body);
    tokenRequests.push(form);
    await holdIfParked({ kind: 'token', name: '', bearer: '', body });
    if (refuseRenewal && form.get('grant_type') === 'refresh_token') {
      return asJson({ error: 'invalid_grant', error_description: 'that refresh token was already spent' });
    }
    /**
     * ★ A REFRESH RETURNS A TOKEN FOR THE SAME SUBJECT, which is what makes "whose credential is
     * on whose transport" answerable at all. The live relay rotates the refresh token and mints
     * an access token for the account that held it; recovering the code from `refresh|<code>`
     * reproduces that. Reading `code` unconditionally would have minted `tok|<client>|null` for
     * every renewal, which `callerOf` decodes as the passkey pod — hiding the exact confusion
     * these cases exist to measure behind a fixture artefact.
     */
    const code = form.get('grant_type') === 'refresh_token'
      ? (form.get('refresh_token') ?? '').replace(/^refresh\|/, '')
      : (form.get('code') ?? '');
    return asJson({
      access_token: 'tok|' + form.get('client_id') + '|' + code + '|m' + (++mints),
      refresh_token: 'refresh|' + code,
      expires_in: 3600,
    });
  }
  if (url === RELAY + '/mcp') {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers['Authorization'] ?? '';
    const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (rpc.method === 'tools/list') {
      return asJson({ jsonrpc: '2.0', id: rpc.id, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
    }
    const name = rpc.params?.name ?? '';
    const input = rpc.params?.arguments ?? {};
    seen.push({ bearer, name, input });
    await holdIfParked({ kind: 'tool', name, bearer, body });
    if (reject401?.(name, bearer)) {
      return new Response('this token may have been issued by a prior relay revision', { status: 401 });
    }
    const who = callerOf(bearer);
    const payload = name === 'get_pod_status'
      // ★ A SIGN-IN THAT FAILS INSIDE `adopt`'s AWAITED HALF. `main.ts` refuses a pod status it
      // cannot turn into a pod name rather than guessing one, and that refusal is a throw between
      // the clear and the commit — which is the whole subject of the restore case.
      ? (podless.some((fragment) => bearer.includes(fragment))
          ? { displayName: null, sessionAgent: { did: who.agentId } }
          : { pod: RELAY + '/pods/' + who.pod, displayName: null, sessionAgent: { did: who.agentId } })
      // The shape `openGraph` reads: an envelope the relay serves without being able to open it.
      : name === 'get_encrypted_graph'
        ? { envelope: envelopeFor(String(input['url'] ?? '')) }
        : name === 'get_descriptor' && String(input['url'] ?? '') === SWITCH_URL
          ? switchDescriptor()
          : { ok: true };
    return asJson({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: payload } });
  }
  throw new Error('the scripted relay was asked for ' + url + ', which no sign-in path reaches');
}

let realFetch: typeof fetch;
let userDataDir = '';

/**
 * HOW MANY RENEWAL TIMERS THIS PROCESS ARMED AND DISARMED.
 *
 * ★★ THE ONLY OBSERVER A DISARMED TIMER HAS. `adopt` never cleared the outgoing account's
 * renewal, and only its own SUCCESS path ever re-armed one — so a failed switch left a timer
 * pointing at the incoming globals, and when it fired it refreshed whatever bearer was there and
 * republished `{state: 'live'}` for a pod nobody was signed in to, once an hour, indefinitely.
 * Nothing on the IPC bridge can see a timer, and waiting fifty-five minutes for one is not a
 * test, so the count is taken at the only place it is visible: `setTimeout` itself.
 *
 * ★ A MILLION MILLISECONDS TELLS THE RENEWAL FROM EVERYTHING ELSE THIS PROCESS ARMS. With the
 * scripted `expires_in: 3600` the renewal lands at 3,600,000 − 300,000 ≈ 3.3e6; the only other
 * long timer on these paths is `startLoopbackReceiver`'s sign-in deadline at exactly 300,000, and
 * the turn progress tick is 2,000. If the grant's lifetime in the fixture ever changes, this
 * threshold is the thing to re-derive.
 */
const RENEWAL_TIMER_MS = 1_000_000;
const renewals = { armed: 0, cleared: 0 };
const renewalHandles = new Set<unknown>();
let realSetTimeout: typeof globalThis.setTimeout;
let realClearTimeout: typeof globalThis.clearTimeout;

beforeAll(() => {
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = (realSetTimeout as (f: () => void, m?: number, ...r: unknown[]) => unknown)(fn, ms, ...rest);
    if (typeof ms === 'number' && ms >= RENEWAL_TIMER_MS) { renewals.armed += 1; renewalHandles.add(handle); }
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (renewalHandles.has(handle)) { renewals.cleared += 1; renewalHandles.delete(handle); }
    (realClearTimeout as (h: unknown) => void)(handle);
  }) as unknown as typeof globalThis.clearTimeout;
});

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'interego-desktop-delegate-key-'));
  host.state.userData = userDataDir;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // ★ THE LOOPBACK RECEIVER IS REAL AND MUST STAY REACHABLE. `auth:browser` is waiting on an
    // HTTP request to a port `startLoopbackReceiver` opened in this process; answering it from
    // the script would replace the one part of PATH 2 that is not the network.
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    return scriptedRelay(url, init);
  }) as typeof fetch;

  // What a machine that has been used before holds: the person's delegate key, sitting in its
  // address-named slot from a previous run. Nothing has signed it in.
  putSecret(DELEGATE_KEY(DELEGATE_ADDRESS), DELEGATE_PK);
});

afterAll(() => {
  // ★ RESTORED, BECAUSE THE POOL IS SINGLE-THREADED. A `globalThis.fetch` left overridden is a
  // trap for whichever file runs next, and it would fail there rather than here.
  globalThis.fetch = realFetch;
  // Any renewal an aborted case left armed — an hour out, and enough to hold the worker open long
  // after the file has finished. Cleared through the real function, then both are put back.
  for (const handle of renewalHandles) (realClearTimeout as (h: unknown) => void)(handle);
  renewalHandles.clear();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* a temp dir that will not delete is not a failure of this suite */ }
});

/** Every `WorkspaceClient` `main.ts` built in this boot, in the order it built them. */
const built: WorkspaceClient[] = [];

/**
 * ★★ CATCH THE CLIENTS `main.ts` BUILDS, BECAUSE NOTHING ON THE IPC BRIDGE HANDS ONE BACK.
 *
 * Whether a DELEGATE's own client can read sealed graphs has no other observer. `delegate:call`
 * is a raw `client.tool(name, input)` passthrough — it never reaches `descriptor()` — so the
 * opener installed on a delegate's client is invisible from every channel the renderer can drive.
 * That is precisely why a mutant which registers the delegate relay-side and gives it NO opener
 * survived every other assertion in this file: the delegate loses private reads entirely and
 * nothing observable changes.
 *
 * ★ PATCHED FROM THE INSTANCE `main.ts` WILL IMPORT, NOT THE ONE AT THE TOP OF THIS FILE.
 * `vi.resetModules()` can hand the next `import('main.js')` a fresh copy of the client package, so
 * a patch applied to this file's static import would miss it. Importing here — after the reset and
 * before main — is what makes them the same object. The marker makes it idempotent for the other
 * case, where the package is externalized and the same prototype comes back every boot.
 */
async function captureClients(): Promise<void> {
  const mod = await import('@interego/workspace-client');
  const proto = mod.WorkspaceClient.prototype as unknown as {
    connect(): Promise<{ granted: readonly string[] }>;
    __captured?: true;
  };
  if (proto.__captured) return;
  const real = proto.connect;
  proto.connect = function (this: WorkspaceClient): Promise<{ granted: readonly string[] }> {
    built.push(this);
    return real.call(this);
  };
  proto.__captured = true;
}

/** Boot a FRESH main process. The globals under test are module-level, so each case gets its own. */
async function boot(): Promise<void> {
  host.handlers.clear();
  seen = [];
  built.length = 0;
  park = null;
  tokenRequests = [];
  podless.length = 0;
  reject401 = null;
  refuseRenewal = false;
  renewals.armed = 0;
  renewals.cleared = 0;
  vi.resetModules();
  await captureClients();
  await import('../applications/shared-workspace/desktop/src/main.js');
  // Every handler is registered inside `app.whenReady().then(...)`; one turn of the microtask
  // queue is what stands in for Electron getting there.
  await new Promise((r) => setTimeout(r, 0));
}

async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = host.handlers.get(channel);
  if (!fn) throw new Error('main.ts registered no handler for ' + channel + ', so this case is testing nothing');
  return await fn(null, ...args) as T;
}

type SealAnswer =
  | { ok: true; graphContent: string; contentDigest: string; cleartextMirror: string; recipientCount: number }
  | { ok: false; why: string };

/** The one thing the renderer asks this process to do with the account's secret. */
const sealRequest = {
  graphIri: RELAY + '/ns/u-eth-passkey/roof-stream',
  payloadTurtle: '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<' + RELAY + '/ns/u-eth-passkey/roof-stream#e1> dct:title "the roof decision is deferred to spring" .\n',
  recipientKeys: [humanKey.publicKey],
};

/**
 * What the process did, phrased so a failure names the identity rather than printing `false`.
 *
 * ★ A BARE `expect(ok).toBe(false)` HIDES THE ONE THING WORTH KNOWING when it fails: WHOSE key
 * sealed. "expected 'SEALED as the human/ACC1 key' to be 'refused'" is the measurement; "expected
 * true to be false" is a shrug.
 */
function verdict(answer: SealAnswer): string {
  if (!answer.ok) return 'refused';
  const sender = senderOf(answer);
  const whose = sender === humanKey.publicKey ? 'the human/ACC1 key'
    : sender === otherKey.publicKey ? 'the ACC2 key'
      : sender === delegateKey.publicKey ? 'the DELEGATE key' : 'an unknown key';
  return 'SEALED as ' + whose;
}

/** Who the envelope says wrapped it — the field the merge was silently rewriting. */
function senderOf(answer: SealAnswer): string {
  if (!answer.ok) throw new Error('expected a seal and got a refusal: ' + answer.why);
  const envelope = JSON.parse(answer.graphContent) as { wrappedKeys: readonly { senderPublicKey: string }[] };
  const senders = new Set(envelope.wrappedKeys.map((w) => w.senderPublicKey));
  expect(senders.size).toBe(1);
  return [...senders][0] as string;
}

describe('★★ a delegate signing in does not write the account\'s encryption key', () => {
  it('leaves the human sealing as themselves, and still gives the delegate its own key relay-side', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    // The baseline: before any delegate exists in this run, the person seals as themselves.
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(humanKey.publicKey);

    /**
     * The ordinary boot. `delegate:list` signs the stored key in for real — the agent id it
     * reports is the relay's answer, so a null here would mean the delegate never got a session
     * and the case below would be measuring nothing.
     */
    const listed = await ipc<{ delegates: readonly { address: string; agentId: string | null; why: string | null }[] }>('delegate:list');
    expect(listed.delegates.map((d) => d.address)).toContain(DELEGATE_ADDRESS.toLowerCase());
    expect(listed.delegates[0]?.agentId).toContain(DELEGATE_SURFACE);

    // ★ THE FINDING. This used to be `delegateKey.publicKey`: every entry the person wrote after
    // their own window finished loading carried a delegate's key as the sealer.
    const after = await ipc<SealAnswer>('substrate:seal', sealRequest);
    expect(senderOf(after)).toBe(humanKey.publicKey);
    expect(senderOf(after)).not.toBe(delegateKey.publicKey);

    /**
     * ★ AND THE DELEGATE STILL GOT WHAT IT SIGNED IN FOR. The wrong repair is to stop calling the
     * installer from the delegate path — the account global would then be safe and the delegate
     * would be registered relay-side under no encryption key at all, so nothing could ever seal
     * to it. Its OWN key must reach the relay under its OWN bearer.
     */
    const registrations = seen.filter((c) => c.name === 'register_agent');
    const mine = registrations.find((c) => c.input['encryption_public_key'] === humanKey.publicKey);
    const theirs = registrations.find((c) => c.input['encryption_public_key'] === delegateKey.publicKey);
    expect(mine?.bearer).toContain('client:' + DESKTOP_CLIENT);
    expect(theirs?.bearer).toContain('client:' + DELEGATE_SURFACE);
    expect(theirs?.input['agent_id']).toContain(DELEGATE_SURFACE);

    // Disarms this boot's renewal timer. A live `setTimeout` an hour out holds the worker open
    // long after the case has finished, and `auth:signout` is the shipping way to drop one.
    await ipc('auth:signout');
  });

  /**
   * ★★ THE READ HALF, WHICH IS THE HALF THE KEY IS ACTUALLY FOR.
   *
   * The wrong repair the case above pins is "stop installing anything on the delegate's client".
   * There is a subtler one: register the delegate's public key relay-side and skip its opener. The
   * account global stays safe, the case above stays green, `register_agent` still goes out under
   * the delegate's own bearer — and the delegate silently loses the ability to read every private
   * workspace it is seated in, because `canOpenSealed` goes false and `verifyGrantIri` renders
   * that as "this client holds no key to open them".
   *
   * ★ NO ACCOUNT SIGN-IN IN THIS CASE, DELIBERATELY. `delegate:list` stands on its own, so the
   * only client this boot builds is the delegate's and there is no question about whose opener is
   * being measured. And the envelope is sealed to the delegate ALONE, so installing the human's
   * opener by mistake would fail here rather than pass.
   */
  it('★★ gives the delegate the READ half too — its own client opens what was sealed to IT', async () => {
    expect(sealedForDelegate.ok).toBe(true);
    await boot();

    const listed = await ipc<{ delegates: readonly { agentId: string | null; why: string | null }[] }>('delegate:list');
    expect(listed.delegates[0]?.why).toBeNull();
    expect(listed.delegates[0]?.agentId).toContain(DELEGATE_SURFACE);

    // One sign-in, one client, and it is the delegate's.
    expect(built.length).toBe(1);
    const theirs = built[0] as WorkspaceClient;
    expect(theirs.canOpenSealed).toBe(true);

    /**
     * The real read: `openSealedDescriptor` fetches `get_encrypted_graph` over the DELEGATE's own
     * transport and opens the envelope with the opener `delegateSession` installed. Nothing here
     * is stubbed — the envelope came out of the shipping sealer and the plaintext below is what a
     * recipient actually recovers.
     */
    const opened = await theirs.openSealedDescriptor({ graph: { encrypted: true } }, SEALED_URL);
    expect(opened['openedWithOwnKey']).toBe(true);
    expect(String((opened['graph'] as { content?: string })?.content)).toContain(SEALED_LINE);

    // And it was fetched AS the delegate, not as anybody else this process could have been.
    const fetched = seen.find((c) => c.name === 'get_encrypted_graph');
    expect(fetched?.bearer).toContain('client:' + DELEGATE_SURFACE);
  });

  /**
   * ★★ THE SEQUENCE THE `setAccountEncryption` DOCBLOCK NAMES, DRIVEN WITHOUT A SIGN-OUT.
   *
   * The wallet sign-in first is what makes this case pin its own subject. An earlier version
   * booted straight into `auth:browser`, and the pair was then null because nothing had ever
   * written it — so the case stayed green with the browser path's null write DELETED, which is
   * the one line the title is about. With a live wallet session in front of it, a browser sign-in
   * that carries anything over seals here.
   */
  it('★ a BROWSER sign-in over a live wallet session carries NOTHING over, and the refusal refuses', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(humanKey.publicKey);

    await ipc('auth:browser');

    /**
     * A browser sign-in holds no key on this machine and commits a NULL pair precisely so that
     * nothing seals — the refusal is the documented behaviour of the path, not a gap in it.
     */
    const before = await ipc<SealAnswer>('substrate:seal', sealRequest);
    expect(verdict(before)).toBe('refused');
    if (!before.ok) expect(before.why).toContain('holds no encryption key');

    await ipc('delegate:list');

    /**
     * ★★ THE REGRESSION, AND IT IS THE HALF THAT IS BEHAVIOUR RATHER THAN PROVENANCE. Once a
     * delegate had been signed in, `accountEncryptionPair` was a delegate's, the guard PASSED,
     * and a session that advertises itself as holding no key sealed anyway — as the agent.
     * Measured before the split: "seal refused before delegate = true | after delegate = false".
     */
    const after = await ipc<SealAnswer>('substrate:seal', sealRequest);
    expect(verdict(after)).toBe('refused');
    if (!after.ok) expect(after.why).toContain('holds no encryption key');

    // And the session still says the same thing about itself: no key to publish in an acceptance.
    const live = await ipc<{ encryptionPublicKey: string | null }>('session:status');
    expect(live.encryptionPublicKey).toBeNull();

    await ipc('auth:signout');
  });

  /**
   * ★★ SIGN OUT MID-SIGN-IN, AND THE SIGN-OUT WINS.
   *
   * REPRODUCED BEFORE THE FIX, twice and independently: with the account's write moved to the far
   * side of `register_agent`, `auth:signout` landing in that window was undone by the sign-in's
   * own continuation, and the next sign-in re-armed `client` before rewriting the globals — so
   * `substrate:seal` answered, as the identity that had just left. That is exactly what the
   * comment on `auth:signout` exists to prevent.
   *
   * The second sign-in is not decoration. After a sign-out alone the process refuses for a
   * duller reason — nothing is signed in — so it cannot tell "the key was dropped" from "the
   * session was dropped". Parking a NEW account's sign-in puts a live client back in front of the
   * departed key, which is the state the seal was measured in.
   */
  it('★★ signing out mid-sign-in wins — nothing seals as the identity that left', async () => {
    await boot();

    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'register_agent' && asDesktop(c.bearer));
    // Settled to a string either way: this promise is deliberately left in flight for a while,
    // and an unobserved rejection is a warning that has nothing to do with what is being measured.
    const signIn = ipc('account:import', HUMAN_PK).then(() => 'resolved', (e: Error) => e.message);
    await parked.reached;
    await ipc('auth:signout');
    parked.release();

    // ★ THE OVERTAKEN SIGN-IN SAYS SO. It committed nothing, so it must not report success — the
    // caller would otherwise record this key as the active account for a session that never lived.
    expect(await signIn).toContain('overtaken');

    const parkedAgain = parkAt((c) => c.kind === 'tool' && c.name === 'get_pod_status' && asDesktop(c.bearer));
    const second = ipc('account:import', OTHER_PK).then(() => 'resolved', (e: Error) => e.message);
    await parkedAgain.reached;

    // ★ THE MEASUREMENT. A live client, mid-sign-in, and the question the renderer asks.
    const mid = await ipc<SealAnswer>('substrate:seal', sealRequest);
    expect(verdict(mid)).toBe('refused');

    parkedAgain.release();
    expect(await second).toBe('resolved');
    // Once the new account IS live it seals as itself, so the refusal above was a window and not
    // a session this test broke.
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(otherKey.publicKey);

    await ipc('auth:signout');
  });

  /**
   * ★★ AND SWITCHING ACCOUNTS DOES NOT SEAL WITH THE OUTGOING KEY WHILE THE NEW ONE IS IN FLIGHT.
   *
   * MEASURED BEFORE THE FIX: 'SEALED as ACC1' while adopting ACC2 — the process answered a seal
   * request, with the OUTGOING account's key, on a session that was already becoming somebody
   * else. The window is not a sliver: `get_pod_status` is the call that PROVISIONS a pod, and
   * `account:import` records that taking between 2 and 31 seconds on this fleet.
   *
   * Refusing is the answer, not "seal as the incoming account": until the relay has answered, the
   * incoming identity is not established here, and neither identity is a true answer to "as whom".
   */
  it('★★ switching accounts refuses to seal mid-flight rather than seal as the outgoing one', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(humanKey.publicKey);

    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'get_pod_status' && c.bearer.includes(codeFor(OTHER_ADDRESS)));
    const switching = ipc('account:import', OTHER_PK).then(() => 'resolved', (e: Error) => e.message);
    await parked.reached;

    expect(verdict(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe('refused');

    parked.release();
    expect(await switching).toBe('resolved');
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(otherKey.publicKey);

    await ipc('auth:signout');
  });

  /**
   * ★★ A SWITCH THAT FAILS PUTS THE OUTGOING ACCOUNT BACK — THE HALF THAT WAS MISSING.
   *
   * The case above pins the CLEAR: mid-switch, nothing seals. This pins its inverse, and until
   * `adopt` became a `handover` there was none. Any throw in the awaited half — a failed
   * `connect`, a `get_pod_status` with no pod URL, a key that will not derive — exited with the
   * encryption pair permanently null, the delegate sessions gone, the renewal timer still armed
   * over the incoming globals, and `session:status` still advertising the OUTGOING account as
   * live with `sealedReads: true` and its `encryptionPublicKey`. Sealing was disarmed for the life
   * of the process; the panel said everything was fine. Reproduced twice (round4/refute-7 #1,
   * refute-10 #1).
   *
   * ★ THE THROW IS ONE OF THE REAL ONES. `get_pod_status` answering without a pod URL is a
   * refusal `main.ts` writes itself, rather than a transport error invented for the fixture.
   */
  it('★★ a switch that throws mid-flight puts the outgoing account back — key, delegates and timer', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(humanKey.publicKey);
    const armedBefore = renewals.armed;
    const clearedBefore = renewals.cleared;

    // A delegate this person switched on, so the restore can be asked about `hosted` as well as
    // about the credential. Its ceremony is counted by its own `get_pod_status`.
    await ipc('delegate:list');
    const delegateCeremonies = (): number =>
      seen.filter((c) => c.name === 'get_pod_status' && c.bearer.includes('client:' + DELEGATE_SURFACE)).length;
    const ceremoniesBefore = delegateCeremonies();
    expect(ceremoniesBefore).toBe(1);

    podless.push(codeFor(OTHER_ADDRESS));
    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'get_pod_status' && c.bearer.includes(codeFor(OTHER_ADDRESS)));
    const switching = ipc('account:import', OTHER_PK).then(() => 'resolved', (e: Error) => e.message);
    await parked.reached;

    /**
     * ★ BETWEEN IDENTITIES, ACTING AS NEITHER — which is what `adopt`'s docblock claimed while
     * `session:status` went on answering as the account that was on its way out. A panel that
     * says `live`, names the outgoing pod and carries its `encryptionPublicKey` is a statement
     * about a session this process no longer holds a credential for.
     */
    const between = await ipc<{ state: string; pod: string | null; sealedReads: boolean; encryptionPublicKey: string | null }>('session:status');
    expect(between.state).toBe('signed-out');
    expect(between.pod).toBeNull();
    expect(between.sealedReads).toBe(false);
    expect(between.encryptionPublicKey).toBeNull();

    // And the refusal NAMES THE SWITCH. Both older refusals were true of the process and read to
    // a person as "you are signed out" or "you have no key" — neither of which is why this one
    // is refusing, and only one of the three is a state you wait out.
    const mid = await ipc<SealAnswer>('substrate:seal', sealRequest);
    expect(verdict(mid)).toBe('refused');
    if (!mid.ok) expect(mid.why).toContain('switching accounts');

    parked.release();
    expect(await switching).toContain('without a pod URL');

    // ★★ THE FINDING. Before the restore existed this refused for the rest of the process's life.
    expect(verdict(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe('SEALED as the human/ACC1 key');

    const live = await ipc<{ state: string; pod: string | null; sealedReads: boolean; encryptionPublicKey: string | null }>('session:status');
    expect(live.state).toBe('live');
    expect(live.sealedReads).toBe(true);
    expect(live.encryptionPublicKey).toBe(humanKey.publicKey);

    /**
     * ★ AND THE DELEGATES CAME BACK WITH IT. `clear` drops `hosted` — it has to, because the next
     * identity's window must not be able to drive delegates this one switched on — so a restore
     * that put only the credential back would leave every hosted delegate needing a fresh
     * ceremony nobody asked for. A cached session short-circuits on its bearer, so "no new
     * `get_pod_status` under the delegate's own client" IS the map being intact.
     */
    await ipc('delegate:list');
    expect(delegateCeremonies()).toBe(ceremoniesBefore);

    /**
     * ★ AND THE RENEWAL TIMER WAS DISARMED AND RE-ARMED, which is the second half of the failed
     * switch and the one no reviewer named. Exactly one more arm than before (the restore's) and
     * at least one clear (the handover's). Left as it was, the count would be unchanged and a
     * timer belonging to the departed sign-in would still be pointing at the live globals.
     */
    expect(renewals.cleared).toBeGreaterThan(clearedBefore);
    expect(renewals.armed).toBe(armedBefore + 1);

    await ipc('auth:signout');
  });

  /**
   * ★★ A RENEWAL IN FLIGHT ACROSS A SIGN-OUT DOES NOT UN-DO THE SIGN-OUT.
   *
   * MEASURED (round4/refute-7 #3): `renew` wrote `bearer`, the transport's credential and the
   * whole session panel after its await with no guard of any kind, so a renewal parked at
   * `/token` across a sign-out came back and re-published a live session for the identity that
   * had left — and when the transport had already been nulled it reported
   * `state: "lapsed", why: "Cannot read properties of null (reading 'setCredential')"`, a raw JS
   * TypeError shown to a person as the reason their session had lapsed.
   */
  it('★★ a renewal in flight across a sign-out does not un-do it, and never reports a TypeError', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    const parked = parkAt(renewalOf(HUMAN_ADDRESS));
    const renewal = ipc<{ ok: boolean; session: { state: string; why: string | null } }>('session:renew');
    await parked.reached;
    await ipc('auth:signout');
    parked.release();

    expect((await renewal).ok).toBe(false);
    const now = await ipc<{ state: string; pod: string | null; why: string | null; sealedReads: boolean }>('session:status');
    expect(now.state).toBe('signed-out');
    expect(now.pod).toBeNull();
    expect(now.sealedReads).toBe(false);
    expect(String(now.why ?? '')).not.toContain('Cannot read properties');
    expect(verdict(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe('refused');

    /**
     * ── AND WHEN A RENEWAL GENUINELY FAILS, THE REASON IS A SENTENCE ─────────
     *
     * The relay's own words are carried — they are the only thing that says WHY — but framed by
     * what was attempted and what it leaves the process holding. `lapsed` is the state a whole
     * window gets painted with, so what fills it has to be readable by the person it is painted
     * over rather than by whoever wrote the throw.
     */
    await ipc('account:import', HUMAN_PK);
    refuseRenewal = true;
    const failed = await ipc<{ ok: boolean; session: { state: string; why: string | null } }>('session:renew');
    refuseRenewal = false;
    expect(failed.ok).toBe(false);
    expect(failed.session.state).toBe('lapsed');
    expect(String(failed.session.why)).toContain('could not be renewed');
    expect(String(failed.session.why)).toContain('already spent');
    expect(String(failed.session.why)).toContain('the credential this process still holds is the expired one');

    await ipc('auth:signout');
  });

  /**
   * ★★ A RENEWAL PARKED ACROSS A SWITCH DOES NOT MAKE THE LIVE SESSION ACT AS THE DEPARTED ONE.
   *
   * MEASURED (round4/refute-7 #2): park ACC1's renewal at `/token`, sign out, sign in as ACC2,
   * release — `session:renew` answered `ok`, ACC1's refreshed credential was written over ACC2's
   * and set on ACC2's transport, and every relay call afterwards went out as the departed
   * identity under a panel that said ACC2. The mint marker on the scripted token is what lets
   * this be read off the wire rather than inferred.
   */
  it('★★ a renewal parked across a switch never puts the departed credential on the live transport', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    const parked = parkAt(renewalOf(HUMAN_ADDRESS));
    const renewal = ipc<{ ok: boolean }>('session:renew');
    await parked.reached;
    await ipc('auth:signout');
    await ipc('account:import', OTHER_PK);
    parked.release();
    expect((await renewal).ok).toBe(false);

    const live = await ipc<{ state: string; encryptionPublicKey: string | null }>('session:status');
    expect(live.state).toBe('live');
    expect(live.encryptionPublicKey).toBe(otherKey.publicKey);
    expect(senderOf(await ipc<SealAnswer>('substrate:seal', sealRequest))).toBe(otherKey.publicKey);

    // ★ AND THE CREDENTIAL ON THE WIRE IS ACC2's. The panel and the envelope agreeing is not
    // enough: the harm was a token, and a token is only visible in a request.
    seen.length = 0;
    await ipc('substrate:call', 'get_pod_status', {});
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.bearer).toContain(codeFor(OTHER_ADDRESS));

    await ipc('auth:signout');
  });

  /**
   * ★★ A DELEGATE SIGN-IN IN FLIGHT AT `auth:signout` DOES NOT COME BACK.
   *
   * MEASURED (round4/refute-7 #7): `hosted.set` landed after five awaits with no ordering of any
   * kind, so a ceremony parked at its `register_agent` across a sign-out committed AFTER
   * `hosted.clear()` — and with nothing signed in, `delegate:list` reported a live delegate this
   * app was hosting for a person who had left. `delegate:list` running every stored key in on an
   * ordinary boot is what makes it routine rather than exotic.
   */
  it('★★ a delegate signing in across a sign-out is dropped, not resurrected into `hosted`', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'register_agent' && c.bearer.includes('client:' + DELEGATE_SURFACE));
    const listing = ipc<{ delegates: readonly { address: string; agentId: string | null; why: string | null }[] }>('delegate:list');
    await parked.reached;
    await ipc('auth:signout');
    parked.release();

    const listed = await listing;
    expect(listed.delegates[0]?.agentId).toBeNull();
    expect(String(listed.delegates[0]?.why)).toContain('overtaken');

    /**
     * ★ AND `hosted` IS REALLY EMPTY, not merely reported empty. The listing above could say
     * whatever it liked; what settles it is that the NEXT listing has to run a whole new ceremony,
     * where a session left in the map would have short-circuited on its own live bearer.
     */
    const ceremonies = (): number =>
      seen.filter((c) => c.name === 'get_pod_status' && c.bearer.includes('client:' + DELEGATE_SURFACE)).length;
    const before = ceremonies();
    await ipc('delegate:list');
    expect(ceremonies()).toBe(before + 1);
  });

  /**
   * ★ AND THE LOOP STOPS RATHER THAN SIGNING THE REST IN FOR NOBODY.
   *
   * `delegate:list` signs every stored key in one at a time, so a sign-out lands MIDWAY through an
   * ordinary boot. Each ceremony's own handover already drops its commit — the case above measures
   * that — but the iterations after the sign-out were still starting fresh ceremonies under an
   * account that had gone: a loopback port and four relay round trips each, to produce a session
   * that is thrown away, for a person who is not there. Which delegates this machine can drive is
   * a question about whoever is signed in, and after a sign-out there is no one to answer it for.
   */
  it('★ a listing whose account signs out midway stops, and says that is why', async () => {
    const second = new Wallet(DELEGATE_2_PK).address;
    putSecret(DELEGATE_KEY(second), DELEGATE_2_PK);
    try {
      await boot();
      await ipc('account:import', HUMAN_PK);

      const parked = parkAt((c) => c.kind === 'tool' && c.name === 'register_agent' && c.bearer.includes('client:' + DELEGATE_SURFACE));
      const listing = ipc<{ delegates: readonly { address: string; agentId: string | null; why: string | null }[] }>('delegate:list');
      await parked.reached;
      await ipc('auth:signout');
      parked.release();

      const listed = await listing;
      expect(listed.delegates.length).toBe(2);
      // The one that was in flight: dropped by its own handover.
      expect(listed.delegates[0]?.agentId).toBeNull();
      expect(String(listed.delegates[0]?.why)).toContain('overtaken');
      // The one the loop had not reached: never started, and the listing says which question it
      // stopped being able to answer rather than reporting the key as unusable.
      expect(listed.delegates[1]?.agentId).toBeNull();
      expect(String(listed.delegates[1]?.why)).toContain('has since been signed out');
      // ★ AND IT REALLY DID NOT RUN. A ceremony is four round trips and a loopback port; the
      // `why` above could be written by a loop that spent them anyway.
      expect(seen.filter((c) => c.name === 'get_pod_status' && c.bearer.includes(codeFor(second)))).toEqual([]);
    } finally {
      forgetSecret(DELEGATE_KEY(second));
    }
  });

  /**
   * ★ FORGETTING A DELEGATE KEY STICKS, EVEN MID-CEREMONY.
   *
   * The same shape as the sign-out resurrection, one address wide, and reachable by pressing two
   * buttons in the order a person would: `delegate:list` signs every stored key in on an ordinary
   * boot, so "forget this delegate" pressed while the window is still loading lands inside that
   * ceremony. Without the bump the sign-in it interrupted commits an await later — the key gone
   * from disk and the session live in the map, with nothing left on the machine to explain where
   * the app is getting its authority from.
   */
  it('★ forgetting a delegate mid-ceremony is not undone by the sign-in it interrupted', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'register_agent' && c.bearer.includes('client:' + DELEGATE_SURFACE));
    const listing = ipc('delegate:list');
    await parked.reached;
    await ipc('delegate:forget', DELEGATE_ADDRESS);
    parked.release();
    await listing;

    /**
     * ★ ASKED THROUGH `delegate:call`, WHICH IS THE THING THE MAP IS FOR. `delegate:list` reads
     * the KEYRING and would report this delegate gone either way; only a caller that reuses a
     * hosted session can tell whether one is still sitting there.
     */
    const called = await ipc<{ ok: boolean; error?: { code: string; message: string } }>('delegate:call', DELEGATE_ADDRESS, 'get_pod_status', {});
    expect(called.ok).toBe(false);
    expect(called.error?.code).toBe('delegate_unavailable');
    expect(String(called.error?.message)).toContain('does not hold a key');

    // Put it back for whatever runs next: the secret store is one temp directory for the file.
    putSecret(DELEGATE_KEY(DELEGATE_ADDRESS), DELEGATE_PK);
    await ipc('auth:signout');
  });

  /**
   * ★★ EACH SIGN-IN'S OPENER GOES ON THE CLIENT IT BUILT, WITH THE BINDING CHECK BESIDE IT.
   *
   * Two mutants survived this file's first five cases and neither was pinned:
   *
   *   · `prepareAccountEncryption(mine, …)` → `(client!, …)`. The opener is installed on the
   *     MODULE GLOBAL rather than on the client this sign-in built — a different object during a
   *     switch, and null now that the handover clears it before the first await. No case ever
   *     asked a SECOND sign-in to read a sealed graph back, so nothing observed it.
   *   · Deleting the second argument of `setGraphOpener(openerFor(pk), sealedBindingCheck)`. The
   *     reader still decrypts; what it loses is the half of the authorship proof the relay is
   *     structurally unable to run, so every sealed entry stays `contentBinding: 'declared'`,
   *     `verifiedSigner` refuses it, and `judgeAuthorship` calls it disputed. Silent everywhere
   *     else in this file.
   *
   * Both are read through the shipping IPC path — `substrate:call('get_descriptor')`, which is
   * also where the retry's captured client is exercised — against a room sealed to ACC2 ALONE.
   */
  it('★★ the second account reads its own sealed room, and finishes the proof the relay could not', async () => {
    expect(sealedForOther.ok, 'the ACC2 fixture would not seal, so this case tests nothing').toBe(true);
    await boot();
    await ipc('account:import', HUMAN_PK);
    await ipc('account:import', OTHER_PK);

    const answer = await ipc<{ ok: true; payload: Record<string, unknown> }>('substrate:call', 'get_descriptor', { url: SWITCH_URL });
    const d = answer.payload;
    expect(d['openedWithOwnKey']).toBe(true);
    expect(String((d['graph'] as { content?: string })?.content)).toContain(SWITCH_LINE);

    const a = d['authorship'] as Record<string, unknown>;
    expect(a['contentBinding'], 'the reader opened the envelope and still reports the proof unchecked').toBe('bound');
    expect(a['contentBindingCheckedLocally']).toBe(true);
    expect(String(a['contentBindingLocalNote'])).toContain('not by the relay');
    // The relay's own note is left exactly as the relay wrote it — a verdict reached here does
    // not get to wear the relay's authority.
    expect(String(a['contentBindingNote'])).toContain('nothing was checked against it');

    await ipc('auth:signout');
  });

  /**
   * ★★ A 401 RECOVERED ACROSS A SWITCH DOES NOT RE-ISSUE THE CALL AS SOMEBODY ELSE.
   *
   * `substrate:call`'s one silent recovery re-invokes the call after `await renew(…)`, and its own
   * justification is "a read that failed because the hour ran out is safe to re-issue" — safe to
   * re-issue AS THE SAME IDENTITY. `renew` had no Epoch, so a sign-out or a second `adopt` landing
   * during it was undone: the refreshed credential of the account that ASKED was committed and set
   * on the transport of the account that had ARRIVED, and every later call went out as the wrong
   * one. `once()` re-reading the module `client` on each invocation is the same hole from the
   * other side, and is closed by capturing it once at the top.
   */
  it('★★ a call whose token is rejected mid-switch is refused, not re-issued as the new account', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    // One 401 for this call, on this account's bearer — how a relay redeploy answers a token the
    // previous revision issued. The transport re-mints once and the relay 401s the retry too,
    // which is when the host is handed `needs_reauth` and reaches for `renew`.
    // TWICE: `rpc` answers a 401 by re-minting once and retrying, so a single rejection is
    // recovered inside the transport and the host never hears about it. The second one is what
    // makes `needs_reauth` cross into `substrate:call`.
    let rejected = 0;
    reject401 = (name, bearer) => name === 'discover_context' && bearer.includes(codeFor(HUMAN_ADDRESS)) && ++rejected <= 2;
    const parked = parkAt(renewalOf(HUMAN_ADDRESS));
    const call = ipc<{ ok: boolean; error?: { code: string; message: string } }>('substrate:call', 'discover_context', {});
    await parked.reached;
    await ipc('auth:signout');
    await ipc('account:import', OTHER_PK);
    parked.release();

    const answer = await call;
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('needs_reauth');

    // ★ AND IT WAS NEVER RE-ISSUED AS ACC2. The renderer asked as ACC1; a read answered as ACC2 is
    // a statement about a pod nobody asked about, and it would look like an ordinary answer.
    expect(seen.filter((c) => c.name === 'discover_context' && c.bearer.includes(codeFor(OTHER_ADDRESS)))).toEqual([]);

    // ★ AND ACC1's REFRESHED CREDENTIAL DID NOT LAND ON ACC2's TRANSPORT.
    seen.length = 0;
    await ipc('substrate:call', 'get_pod_status', {});
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.bearer).toContain(codeFor(OTHER_ADDRESS));

    await ipc('auth:signout');
  });

  /**
   * ★★ A 401 RE-AUTHORIZATION THAT LANDS AFTER A SWITCH DOES NOT WRITE THE PROCESS'S CREDENTIAL.
   *
   * The re-authorizer `adopt` installs is a long-lived closure on ONE sign-in's transport, and it
   * wrote the module-global `bearer` unconditionally after its own await, capturing neither a
   * generation nor a transport identity. A 401 on a call still travelling through account A's
   * transport, resolving after a switch to B, overwrote B's `bearer` with A's fresh credential —
   * and `renew` then read that global, refreshed A's token and called `setCredential` on B's
   * transport, so the process made relay calls as A under a panel that said B. Nobody had named
   * this one; the generation existed three lines above the closure and it did not consult it.
   *
   * The fresh credential is still handed back to the transport that asked for it. That call is in
   * flight for reasons of its own and withholding its token would fail it for none of them.
   */
  it('★★ a re-authorization landing after a switch gives its own transport a token and the process none', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    // ONCE, so the transport's re-mint recovers the call — this case is about what that re-mint
    // WRITES, not about a call that failed.
    let rejected = 0;
    reject401 = (name, bearer) => name === 'discover_context' && bearer.includes(codeFor(HUMAN_ADDRESS)) && ++rejected <= 1;
    // The re-mint's own `/token`, told apart from every other by its authorization_code and by
    // being armed only after this account was already signed in.
    const parked = parkAt((c) => c.kind === 'token'
      && new URLSearchParams(c.body).get('grant_type') === 'authorization_code'
      && new URLSearchParams(c.body).get('code') === codeFor(HUMAN_ADDRESS));
    const call = ipc<{ ok: boolean }>('substrate:call', 'discover_context', {});
    await parked.reached;
    await ipc('auth:signout');
    await ipc('account:import', OTHER_PK);
    parked.release();
    expect((await call).ok).toBe(true);

    /**
     * ★ THE HARM IS ONLY VISIBLE THROUGH A RENEWAL. The stale write lands on the module `bearer`,
     * which nothing but `renew` and `scheduleRenewal` read — so a renewal is what turns it into a
     * credential on the wire, and it does so on the LIVE transport. With the guard, `session:renew`
     * refreshes ACC2's grant and every call afterwards still carries ACC2's code.
     */
    expect((await ipc<{ ok: boolean }>('session:renew')).ok).toBe(true);
    seen.length = 0;
    await ipc('substrate:call', 'get_pod_status', {});
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) expect(c.bearer).toContain(codeFor(OTHER_ADDRESS));

    await ipc('auth:signout');
  });

  /**
   * ★ A CALL RENEWS THE GRANT IT WAS MADE UNDER, OR IT RENEWS NOTHING.
   *
   * The case above switches accounts DURING the renewal. This one switches during the CALL, which
   * is the other side of the same await and the one that decides which Epoch `substrate:call` is
   * allowed to renew on. Taking a fresh stamp in the catch reads as harmless — the call is going
   * to be refused either way — but it spends the ARRIVING account's refresh token to do it, and
   * the relay rotates that token and refuses the spent one. One turn of a key that belongs to
   * somebody who never asked for anything.
   */
  it('★ a call that outlives its own account does not spend the arriving account\'s refresh token', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);

    // The 401 is answered after the park releases, so the switch happens inside the CALL rather
    // than inside the renewal it provokes.
    let rejected = 0;
    reject401 = (name, bearer) => name === 'discover_context' && bearer.includes(codeFor(HUMAN_ADDRESS)) && ++rejected <= 2;
    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'discover_context' && c.bearer.includes(codeFor(HUMAN_ADDRESS)));
    const call = ipc<{ ok: boolean; error?: { code: string } }>('substrate:call', 'discover_context', {});
    await parked.reached;
    await ipc('auth:signout');
    await ipc('account:import', OTHER_PK);
    tokenRequests = [];
    parked.release();

    const answer = await call;
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('needs_reauth');

    // ★ NOT ONE REFRESH GRANT, FOR EITHER ACCOUNT. The call belongs to an account that has gone,
    // so there is no credential of its own left to renew — and the one that is live was not the
    // one that asked.
    const refreshes = tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
    expect(refreshes.map((f) => f.get('refresh_token'))).toEqual([]);

    await ipc('auth:signout');
  });

  /**
   * ★★ NO DELEGATE IS SIGNED IN WHILE THE ACCOUNT IS BEING SWITCHED, AND NONE SURVIVES ONE.
   *
   * Two halves of the same rule, and neither had an observer. `hosted` belongs to the person who
   * is signed in — `auth:signout` clears it so the next identity's window cannot drive delegates
   * the previous one switched on — and `adopt` means exactly the same thing while never having
   * touched the map at all. So a switch carried the outgoing person's hosted delegates straight
   * into the incoming person's session, and a ceremony STARTED mid-switch commits under a fresh
   * subject that the clear's bump could not have reached, landing in a process that is between
   * identities.
   */
  it('★★ a switch refuses to host a delegate mid-flight, and drops the ones it was hosting', async () => {
    await boot();
    await ipc('account:import', HUMAN_PK);
    await ipc('delegate:list');
    const ceremonies = (): number =>
      seen.filter((c) => c.name === 'get_pod_status' && c.bearer.includes('client:' + DELEGATE_SURFACE)).length;
    expect(ceremonies()).toBe(1);

    const parked = parkAt((c) => c.kind === 'tool' && c.name === 'get_pod_status' && c.bearer.includes(codeFor(OTHER_ADDRESS)));
    const switching = ipc('account:import', OTHER_PK).then(() => 'resolved', (e: Error) => e.message);
    await parked.reached;

    /**
     * ── half one: nothing new is signed in during the gap ─────────────────
     *
     * Asked BOTH ways, because they refuse in different places and only one of them is a loop.
     * `delegate:list` stops before it starts a ceremony at all — the Epoch it took is not current
     * while a handover holds custody — so its own sentence is what a person reads. `delegate:call`
     * and `agent:think` have no such loop and go straight at `delegateSession`, which is where the
     * refusal that names the switch lives.
     */
    const during = await ipc<{ delegates: readonly { agentId: string | null; why: string | null }[] }>('delegate:list');
    expect(during.delegates[0]?.agentId).toBeNull();
    expect(String(during.delegates[0]?.why)).toContain('is being switched right now');
    const direct = await ipc<{ ok: boolean; error?: { code: string; message: string } }>('delegate:call', DELEGATE_ADDRESS, 'get_pod_status', {});
    expect(direct.ok).toBe(false);
    expect(direct.error?.code).toBe('delegate_unavailable');
    expect(String(direct.error?.message)).toContain('switching accounts');
    expect(ceremonies()).toBe(1);

    parked.release();
    expect(await switching).toBe('resolved');

    /**
     * ── half two: and the one ACC1 was hosting did not come across ─────────
     *
     * A cached session short-circuits on its own bearer, so a WHOLE new ceremony under the
     * delegate's own client is the only thing that shows the map was emptied. ACC2 may host this
     * delegate too — the key is on the machine — but it has to establish that for itself.
     */
    await ipc('delegate:list');
    expect(ceremonies()).toBe(2);

    await ipc('auth:signout');
  });
});
