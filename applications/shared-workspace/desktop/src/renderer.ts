/**
 * The desktop shell's UI: boot → authenticate → lobby → channel.
 *
 * ★ EVERY SUBSTRATE DECISION IN HERE COMES FROM `@interego/workspace-client`. This file chooses
 * colours and DOM nodes. It does not parse Turtle, compose a member document name, decide
 * whether somebody is seated, verify a grant, work out where an entry goes in a chain, or decide
 * whether a save became the head — the published artifact makes those same decisions with the
 * same code, which is the point. Every drift defect in this vertical came from two copies of one
 * intention, and the last one shipped a workspace that folded differently depending on which
 * client opened it.
 *
 * ★ NOTHING HERE FETCHES A DESCRIPTOR URL. They come back as
 * `http://css.railway.internal:3456/…`, an address inside the fleet. `get_descriptor` is the
 * only way to turn one into bytes from a laptop, and it is reached through the main process.
 *
 * ★ AND NOTHING HERE HOLDS A BEARER. The renderer is the half that renders bytes other people
 * wrote; the credential lives in the main process and a tool call is the only thing that
 * crosses.
 */

import {
  ConnectorTransport, WorkspaceClient, acceptGrant, assignPodMarks, checkOwnHandle,
  checkRoleForWorkspace, checkWriteEligibility, createWorkspace, entryShapeAnswer, errorCopy,
  foldRoster, graphRegion, grantPodFor, hasType, listWorkspaces, mergeForward, nsIri, orderChain,
  parseRoleProfile, parseWorkspaceIri, podClaimVsServed, podOfDescriptorUrl, pollingWatch, postEntry,
  preconditionLine, readCanvas, readInbox, readInt, readIri, readLiteral, readViewer, revokeGrant,
  roleKnown, roleName, roleWhy, saveCanvas, sendInvite, shortRef, slugProblem, verifyInvitation,
  verifyWorkspaceEntry,
  type CanvasRead, type ChainRow, type Check, type ConnectorMcp, type GrantVerdict,
  type Invitation, type RoleTable, type Seat, type Viewer, type WorkspaceEntry, type WorkspaceRecord,
} from '@interego/workspace-client';
import type { BridgeFailure, SessionInfo, WorkspaceBridge } from './preload.js';

declare global {
  interface Window { interego: WorkspaceBridge }
}

const RELAY_FALLBACK = 'https://relay.interego.xwisee.com';

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

const $ = (id: string): HTMLElement => {
  const n = document.getElementById(id);
  if (!n) throw new Error('missing element #' + id);
  return n;
};
const el = (tag: string, cls?: string, txt?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  // textContent, never innerHTML. Every string below came off somebody else's pod.
  if (txt !== undefined) n.textContent = txt;
  return n;
};
const clear = (n: HTMLElement): HTMLElement => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
const btn = (n: string): HTMLButtonElement => $(n) as HTMLButtonElement;
const inp = (n: string): HTMLInputElement => $(n) as HTMLInputElement;
const area = (n: string): HTMLTextAreaElement => $(n) as HTMLTextAreaElement;

function kvPair(rows: readonly (readonly [string, string, string?])[]): HTMLElement {
  const g = el('div', 'kv');
  for (const [k, v, cls] of rows) {
    g.appendChild(el('div', 'k', k));
    g.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
  }
  return g;
}
function say(target: string, kind: string, title: string, body?: string): HTMLElement {
  const box = clear($(target));
  const p = el('div', 'panel ' + kind);
  p.appendChild(el('h4', undefined, title));
  if (body !== undefined) p.appendChild(el('div', undefined, body));
  box.appendChild(p);
  return p;
}
function errBox(err: unknown, where: string, again?: () => void): HTMLElement {
  const e = err as Partial<BridgeFailure> & { message?: string };
  const c = errorCopy(err);
  const box = el('div', 'err');
  box.appendChild(el('h4', undefined, c.t));
  box.appendChild(el('div', undefined, c.d || String(e?.message ?? err)));
  if (where) box.appendChild(el('div', 'note', where));
  if (again) {
    const row = el('div', 'row');
    const b = el('button', 'sm', 'Try this read again') as HTMLButtonElement;
    // `retryable` is stamped by the layer that produced the error and is the only licence to
    // re-issue a READ unattended. Where it is absent, the button still works — but it says so,
    // because a user pressing it is a different authority from a client retrying by itself.
    b.title = e?.retryable
      ? 'The relay stamped this error retryable, so re-issuing the read is licensed.'
      : 'This error is not stamped retryable, so repeating it may not help. It re-reads only because you pressed it.';
    b.addEventListener('click', () => { b.disabled = true; again(); });
    row.appendChild(b);
    if (!e?.retryable) row.appendChild(el('span', 'note', 'Not stamped retryable.'));
    box.appendChild(row);
  }
  return box;
}
function checkList(checks: readonly Check[]): HTMLElement {
  const cl = el('div', 'checks');
  for (const c of checks) {
    const line = el('div', c.mark, c.text);
    if (c.detail) line.title = c.detail;
    cl.appendChild(line);
  }
  return cl;
}
/** A three-state write reporter, so a viewer learns one shape rather than five. */
function writeLine(box: HTMLElement, label: string): (state: string, detail: string) => void {
  const row = el('div', 'wstate');
  const s = el('span', 's', '…');
  const t = el('span', undefined, label);
  row.appendChild(s); row.appendChild(t);
  box.appendChild(row);
  return (state, detail) => {
    const bad = state === 'refused' || state === 'failed';
    s.className = 's' + (state === 'readable' ? ' ok' : bad ? ' no' : '');
    s.textContent = state === 'readable' ? '✓' : bad ? '✗' : '…';
    t.textContent = label + ' — ' + (state === 'readable' ? 'readable'
      : state === 'pending' ? 'accepted, not yet readable' : state) + (detail ? ': ' + detail : '');
  };
}
const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const shortCid = (c: string | null | undefined): string => (c ? shortRef(c) : '—');

/**
 * The IPC bridge, adapted to the transport interface the client already speaks.
 *
 * ★ THIS IS THE SECOND IMPLEMENTATION OF ONE INTERFACE AND THAT IS THE WHOLE ARCHITECTURE.
 * `ConnectorTransport` is written against `window.claude.mcp`; the bridge exposes the same two
 * operations, so the desktop reuses it instead of growing a third code path.
 */
function bridgeAsMcp(): ConnectorMcp {
  return {
    async listTools() {
      // The bridge is already connected to exactly one relay, so there is one server and the
      // probe is a live call rather than a directory lookup.
      const r = await window.interego.call('get_pod_status', {});
      if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
      return { servers: [{ server: 'Interego relay', tools: [{ name: 'get_pod_status' }] }] };
    },
    async callTool(_server, name, input) {
      const r = await window.interego.call(name, input);
      if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
      return { payload: r.payload };
    },
    /**
     * ★ WITHOUT THIS THE DESKTOP HAD NO WATCH AT ALL, and nothing said so.
     *
     * `RelayMcpTransport` implements one — but it lives in the MAIN process, on the far side of
     * the IPC boundary, because that is where the bearer is. The renderer drives a
     * `ConnectorTransport`, whose `watchTool` returns null when the host object has none, so
     * every log fell straight to the one-shot fallback and the channel never moved again. Found
     * by driving this renderer in a document; typechecking could not see it, and neither could
     * the live driver, which calls the module directly and never goes through a shell.
     *
     * The loop is the MODULE's, bound here rather than written again: the same
     * `pollingWatch` the HTTP transport uses, so the two ends cannot come apart, and so
     * "an event means the answer changed" is one implementation rather than two.
     */
    watchTool(_server, name, input, onEvent, opts) {
      return pollingWatch(async (n, i) => {
        const r = await window.interego.call(n, i);
        if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
        return r.payload;
      }, name, input, onEvent, opts);
    },
  };
}

// ── application state ────────────────────────────────────────────────────────

interface Loaded {
  readonly pod: string;
  readonly graph: string;
  readonly isYou: boolean;
  readonly seat: Seat | null;
  rows: readonly ChainRow[];
  error: unknown;
  loaded: boolean;
  stale: unknown;
  watchFailed: unknown;
}
interface Body {
  readonly body: string | null;
  readonly seq: number | null;
  readonly isEntry: boolean;
  readonly declaredWorkspace: string | null;
  readonly servedPod: string | null;
  readonly signed: boolean;
  readonly signedBy: string | null;
  readonly note: string | null;
  readonly error?: unknown;
}

const S = {
  relay: RELAY_FALLBACK,
  watchDescription: '',
  client: null as WorkspaceClient | null,
  viewer: null as Viewer | null,
  writeBlocked: null as string | null,
  handleCheck: null as Awaited<ReturnType<typeof checkOwnHandle>> | null,
  enforcement: null as Record<string, unknown> | null,
  enforcementWhy: null as string | null,

  workspace: null as string | null,
  iriOwner: null as string | null,
  slug: null as string | null,
  recordResult: null as Awaited<ReturnType<WorkspaceClient['readWorkspaceRecord']>> | { kind: 'error'; error: unknown } | null,
  record: null as WorkspaceRecord | null,
  roles: { roles: null, caps: null } as RoleTable,
  profileFrom: null as { from: string; hops: number } | null,
  profileError: null as unknown,
  seats: [] as Seat[],
  fold: null as Awaited<ReturnType<typeof foldRoster>> | null,
  podMarks: new Map<string, string>(),
  streams: new Map<string, Loaded>(),
  bodies: new Map<string, Body>(),
  watches: [] as (() => void)[],
  streamsOpened: false,
  streamIri: null as string | null,
  canvas: { iri: null as string | null, head: null as string | null, loaded: null as string | null, exists: false },

  invites: null as readonly Invitation[] | null,
  inviteError: null as unknown,
  inboxSaturated: false,
  spaces: null as WorkspaceEntry[] | null,
  spacesError: null as unknown,
  spacesSaturated: false,
  lobbyOpen: true,
};

// ── the boot checklist ───────────────────────────────────────────────────────
/**
 * ★ COLD START IS 12–16 s ON A FRESH IDENTITY, because the first pod-aware call PROVISIONS A
 * POD. Measured on this fleet again while building this shell: 16.7 s for a brand-new wallet,
 * 1.8 s for one whose pod already existed. A spinner for sixteen seconds reads as broken, so
 * this counts up and says which step it is on.
 */
const T0 = Date.now();
interface Step { key: string; text: string; state: 'wait' | 'done' | 'err'; at: number | null }
const steps: Step[] = [];
let stepTimer: ReturnType<typeof setInterval> | null = null;

function step(key: string, text: string, state: Step['state']): void {
  const found = steps.find((s) => s.key === key);
  if (found) { found.text = text; found.state = state; if (state !== 'wait') found.at = Date.now() - T0; }
  else steps.push({ key, text, state, at: state === 'wait' ? null : Date.now() - T0 });
  renderSteps();
}
function renderSteps(): void {
  let anyWait = false;
  for (const id of ['steps', 'lobbysteps']) {
    const box = document.getElementById(id);
    if (!box) continue;
    clear(box);
    for (const s of steps) {
      const r = el('div', 'step ' + s.state);
      r.appendChild(el('span', 'mark', s.state === 'done' ? '✓' : s.state === 'err' ? '✗' : '…'));
      r.appendChild(el('span', 'txt', s.text));
      if (s.state === 'wait') { anyWait = true; r.appendChild(el('span', 'el', ((Date.now() - T0) / 1000).toFixed(0) + 's')); }
      else if (s.at !== null) r.appendChild(el('span', 'el', (s.at / 1000).toFixed(1) + 's'));
      box.appendChild(r);
    }
  }
  if (anyWait && !stepTimer) stepTimer = setInterval(renderSteps, 1000);
  if (!anyWait && stepTimer) { clearInterval(stepTimer); stepTimer = null; }
}

// ── the session bar ──────────────────────────────────────────────────────────
/**
 * ★ A LAPSED SESSION IS PAINTED OVER THE WINDOW, NOT OVER NOTHING.
 *
 * A shell whose bearer expired and which then draws a roster with no members has told the user
 * their workspace is empty — from a read that never happened. Absence is not evidence, and this
 * is the largest instance of it a client with an hourly token can commit.
 */
function renderSession(s: SessionInfo): void {
  const bar = $('sessionbar');
  bar.hidden = s.state === 'signed-out';
  bar.className = s.state === 'lapsed' ? 'lapsed' : s.state === 'renewing' ? 'renewing' : 'live';
  const msg = $('sessionmsg');
  if (s.state === 'lapsed') {
    msg.textContent = 'This session has lapsed and nothing below was refreshed from it: ' + (s.why ?? 'the relay gave no reason')
      + ' Anything still on screen was read before it lapsed — it is not a current statement about anybody\'s pod.';
  } else if (s.state === 'renewing') {
    msg.textContent = 'Renewing this session — ' + (s.why ?? 'no reason recorded') + '. Reads in flight are unaffected.';
  } else {
    const when = s.expiresAt ? new Date(s.expiresAt).toLocaleTimeString() : null;
    msg.textContent = 'Signed in as ' + (s.pod ?? 'an unresolved pod') + ' · '
      + (when
        ? 'this bearer expires at ' + when + (s.renewable
          ? ', and will be renewed silently a few minutes before that'
          : ', and the grant carried no refresh token — renewal will need you')
        : 'the grant did not report an expiry, so no renewal is scheduled; a rejected token is recovered when one is met rather than on a guessed clock');
  }
  btn('renewbtn').hidden = !s.renewable;
}

// ── sign in ──────────────────────────────────────────────────────────────────

async function describe(): Promise<void> {
  const d = await window.interego.describe();
  S.relay = d.relay;
  S.watchDescription = d.watchDescription;
  $('relayline').textContent = 'Relay ' + d.relay;
  const s = clear($('storeline'));
  s.appendChild(document.createTextNode(d.secretStore
    ? 'The OS secret store is available, so a wallet key is encrypted by the operating system before it touches disk. That protects it from being copied off this machine; it does not protect it from software already running as you.'
    : 'The OS secret store is NOT available on this machine. The wallet option is offered anyway and will REFUSE rather than write a plaintext key — use browser sign-in, which holds no key at all.'));
  if (d.hasStoredWallet) s.appendChild(el('div', 'note', 'A wallet key is already stored here, so signing in with it returns to the same pod.'));
  renderSession(d.session);
  window.interego.onSessionChanged(renderSession);
}

async function signIn(kind: 'wallet' | 'browser'): Promise<void> {
  const buttons = [btn('signin-wallet'), btn('signin-browser')];
  buttons.forEach((b) => { b.disabled = true; });
  step('auth', kind === 'wallet'
    ? 'Signing a SIWE message with the key in your OS secret store'
    : 'Waiting for you to finish signing in, in your browser', 'wait');
  try {
    const who = kind === 'wallet' ? await window.interego.signInWithWallet() : await window.interego.signInWithBrowser();
    step('auth', 'Signed in — you are pod ' + who.pod + (kind === 'wallet' ? '' : ' (browser sign-in)'), 'done');
    if (kind === 'wallet' && 'mintedNewKey' in who && who.mintedNewKey) {
      $('signinnote').textContent = 'A new wallet key was minted and stored, so this is a brand new pod with nothing on it yet.';
    }
    $('signin').hidden = true;
    $('whoami').textContent = who.pod;
    btn('lobbybtn').hidden = false;
    await boot();
  } catch (e) {
    step('auth', 'Sign-in did not complete', 'err');
    clear($('signinnote')).appendChild(errBox(e,
      'Nothing is read until a session exists — this client holds no fixtures, so with no session there is nothing to show.'));
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  teardownWorkspace();
  S.handleCheck = null; S.invites = null; S.inviteError = null;
  S.spaces = null; S.spacesError = null; S.writeBlocked = null;
  step('connect', 'Resolving the tool surface — the first pod-aware call provisions a pod, measured at 12 to 17 seconds', 'wait');
  const client = new WorkspaceClient(S.relay, new ConnectorTransport(bridgeAsMcp()));
  try {
    await client.connect();
  } catch (e) {
    step('connect', 'The relay tool surface could not be resolved', 'err');
    showLobby(true);
    clear($('bootnote')).appendChild(errBox(e, 'Nothing on this screen is pre-baked, so with no tool surface there is nothing to show.', () => { void boot(); }));
    return;
  }
  S.client = client;
  step('connect', 'Tool surface reachable', 'done');

  step('identity', 'Resolving which pod you write to', 'wait');
  try {
    S.viewer = await readViewer(client);
  } catch (e) {
    step('identity', 'Your pod could not be resolved', 'err');
    showLobby(true);
    clear($('bootnote')).appendChild(errBox(e,
      'Posting and saving are disabled: a wrong or empty pod name reads back as an empty log rather than as an error, which is exactly the confident falsehood this client exists not to make.',
      () => { void boot(); }));
    return;
  }
  step('identity', 'You are pod ' + S.viewer.podName, 'done');
  $('whoami').textContent = S.viewer.podName;
  showLobby(true);

  // Whether the viewer may write is a property of THEIR pod and THEIR agent — nothing to do with
  // any workspace record or roster. Asked here, before any write control is offered.
  const verdict = await checkWriteEligibility(client, S.viewer);
  S.enforcement = verdict.enforcement;
  S.enforcementWhy = verdict.why;
  if (verdict.blocked) applyWriteVerdict(verdict.blocked);
  renderMe();
  // Unawaited: the handle is printed either way and the line under it says "resolving…" until
  // this settles, so boot is not held on a self-check.
  void checkOwnHandle(client, S.relay, S.viewer.podName).then((h) => { S.handleCheck = h; renderMe(); });

  await loadInvites();
  await loadSpaces();

  // Which workspace: what this machine last had open, then the first acceptance that verified,
  // then none — which is the lobby, and is the ordinary state for somebody who has just signed in.
  let want: string | null = null;
  let whence = '';
  try {
    const last = localStorage.getItem('wsp:last');
    if (last) { want = last; whence = 'what this machine last had open'; }
  } catch { /* storage may be denied */ }
  if (!want) {
    // Annotated rather than left to `??` inference: `A[] | never[]` collapses the callback
    // parameter to `never`, which typechecks as a mistake and reads as one too.
    const spaces: readonly WorkspaceEntry[] = S.spaces ?? [];
    const first = spaces.find((c) => c.verified && c.workspace);
    if (first?.workspace) { want = first.workspace; whence = 'the first acceptance on your pod that verified'; }
  }
  if (!want) {
    // ★ "IN NONE" IS A READ, AND A READ THAT FAILED IS NOT THAT READ.
    $('bootnote').textContent = S.spacesError
      ? 'Whether you are in a workspace is not established: the read of your own pod failed — '
        + ((S.spacesError as Error)?.message ?? errorCopy(S.spacesError).t)
        + '. Retry it in the card below, or accept an invitation, create a workspace, or open one by its IRI.'
      : 'You are in no workspace. Accept an invitation, create one, or open one by its IRI.';
    return;
  }
  $('bootnote').textContent = 'Opened ' + want + ', chosen from ' + whence + '.';
  await openWorkspace(want);
}

/** The relay's own writeEligible verdict gates every write control. Sticky — see below. */
function applyWriteVerdict(why: string): void {
  // Sticky, because reads that finish LATER re-enable these controls on several paths, and a
  // verdict that arrived first would otherwise be undone by one that finished second.
  S.writeBlocked = why;
  for (const id of ['send', 'save', 'stalesave', 'createbtn', 'sendinvite']) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) { b.disabled = true; b.title = why; }
  }
  area('composer').disabled = true;
  area('composer').placeholder = 'Not write-eligible on this pod.';
  area('canvas').disabled = true;
  clear($('writes-to')).appendChild(document.createTextNode(why));
}

// ── the lobby ────────────────────────────────────────────────────────────────

function showLobby(open: boolean): void {
  // With no workspace open there is no channel to go back to, so the lobby is not dismissible.
  if (!S.workspace) open = true;
  S.lobbyOpen = open;
  $('lobby').hidden = !open;
  $('shell').hidden = open;
  // The LABEL, not the button: writing textContent on the button removes the count badge from
  // the document, and every later read of it is null.
  $('lobbylabel').textContent = open && S.workspace ? 'Back to the channel' : 'Workspaces';
  renderLobby();
}

function renderMe(): void {
  if (!S.viewer) return;
  $('mecard').hidden = false;
  const box = clear($('mebody'));
  box.appendChild(el('p', 'note', 'Nobody can invite you until they have this. It does not exist until you connect, '
    + 'and there is no directory that can find you by name — so this is the one step of joining that has to happen '
    + 'outside the fabric.'));
  const handle = S.handleCheck?.handle ?? ('acct:' + S.viewer.podName + '@' + new URL(S.relay).host);
  const h = el('div', 'handle');
  h.appendChild(el('code', 'mono', handle));
  const copy = el('button', 'sm', 'Copy handle') as HTMLButtonElement;
  copy.addEventListener('click', () => {
    const done = (): void => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy handle'; }, 1600); };
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(handle).then(done, () => { copy.textContent = 'Select it by hand'; });
    else copy.textContent = 'Select it by hand';
  });
  h.appendChild(copy);
  box.appendChild(h);

  // ★ COMPOSED HERE, AND THEN ACTUALLY RESOLVED. This identifier is the one the whole
  // second-person flow turns on, and the cost of a wrong one falls entirely on the OTHER person:
  // their end fails with a 404 and this end says nothing.
  const hs = el('div', 'note');
  if (!S.handleCheck) {
    hs.textContent = 'This client composed that handle from your pod name and the relay host it is built on. Resolving it…';
  } else if (S.handleCheck.errored) {
    hs.style.color = 'var(--pending)';
    hs.textContent = 'This client composed that handle, and ' + S.handleCheck.why + '.';
  } else if (!S.handleCheck.ok) {
    hs.style.color = 'var(--refused)';
    hs.textContent = 'This client composed that handle, and resolving it did not return you: ' + S.handleCheck.why
      + ' Sending it to somebody would have them look up an identifier that is not yours.';
  } else {
    hs.style.color = 'var(--ok)';
    hs.textContent = 'Resolved: ' + S.handleCheck.why;
  }
  box.appendChild(hs);

  box.appendChild(kvPair([
    ['your pod', S.viewer.podName],
    ['your WebID', S.viewer.webId || 'your pod\'s registry did not report an owner'],
    ['your session agent', S.viewer.agentDid ?? 'get_pod_status reported none'],
    ['delegated scope', S.viewer.agentScope ?? 'not reported by get_pod_status'],
  ]));
  const e = S.enforcement;
  const chip = el('div', 'basis ' + (e?.['basis'] === 'signed-chain' ? 'signed' : e?.['basis'] === 'registry-only' ? 'registry' : ''));
  chip.textContent = e
    ? 'verify_agent · ' + String(e['basis']) + ' · scope ' + String(e['scope'] ?? 'not reported')
      + ' · ' + (typeof e['writeEligible'] === 'boolean' ? 'writeEligible ' + String(e['writeEligible']) : 'writeEligible not reported')
    : 'delegation not established';
  chip.title = e ? String(e['note'] ?? '') : (S.enforcementWhy ?? '');
  box.appendChild(chip);
  if (S.writeBlocked) box.appendChild(el('div', 'note', S.writeBlocked));
}

async function loadInvites(): Promise<void> {
  if (!S.client) return;
  step('inbox', 'Reading your inbox', 'wait');
  try {
    const read = await readInbox(S.client);
    S.invites = read.invitations;
    S.inboxSaturated = read.saturated;
    S.inviteError = null;
    step('inbox', 'Inbox read — ' + read.invitations.length + ' offer' + (read.invitations.length === 1 ? '' : 's')
      + ' with something to look at' + (read.saturated ? ', and that read came back full at ' + read.limit + ' items' : ''), 'done');
  } catch (e) {
    S.inviteError = e;
    S.invites = null;
    step('inbox', 'Your inbox could not be read (' + errorCopy(e).t.toLowerCase() + ')', 'err');
    renderLobby();
    return;
  }
  renderLobby();
  for (const inv of S.invites) {
    await verifyInvitation(S.client, S.relay, S.viewer as Viewer, inv);
    renderLobby();
  }
}

async function loadSpaces(): Promise<void> {
  if (!S.client || !S.viewer) return;
  step('spaces', 'Looking for acceptances on your own pod', 'wait');
  let list;
  try {
    list = await listWorkspaces(S.client, S.relay, S.viewer.podName);
  } catch (e) {
    S.spacesError = e; S.spaces = null;
    step('spaces', 'Your own pod\'s manifest could not be read', 'err');
    renderLobby();
    return;
  }
  S.spaces = list.entries.slice();
  S.spacesSaturated = list.saturated;
  S.spacesError = null;
  step('spaces', 'Found ' + list.entries.length + ' acceptance' + (list.entries.length === 1 ? '' : 's')
    + ' on your pod — checking each against its convener\'s pod', 'wait');
  renderLobby();
  let verified = 0;
  for (const c of S.spaces) {
    await verifyWorkspaceEntry(S.client, S.relay, S.viewer, c);
    if (c.verified) verified++;
    renderLobby();
  }
  step('spaces', list.entries.length
    ? verified + ' of ' + list.entries.length + ' acceptance' + (list.entries.length === 1 ? '' : 's')
      + ' on your pod verified against the convener\'s pod'
    : 'No acceptance on your pod — you are in no workspace yet', 'done');
}

function inviteRow(inv: Invitation): HTMLElement {
  const it = inv.item;
  const v = inv.verdict;
  const row = el('div', 'item' + (v?.ok ? '' : inv.state === 'checked' ? ' bad' : ''));
  row.appendChild(el('h4', undefined, String(it['summary'] ?? 'An offer with no summary')));
  row.appendChild(el('div', 'iri', 'delivered by ' + String(it['actor'] ?? 'an actor the notification did not name')
    + (it['published'] ? ' · ' + String(it['published']) : '')));
  row.appendChild(el('div', 'iri', String(it['about'] ?? '')));
  if (inv.state !== 'checked' || !v) {
    row.appendChild(el('div', 'verdict wait', 'checking it against the pod it names…'));
    return row;
  }
  row.appendChild(checkList(v.checks));
  if (v.ok) {
    row.appendChild(el('div', 'verdict ok', 'verified on pod ' + String(v.owner)));
    row.appendChild(kvPair([
      ['workspace', (v.title ? v.title + ' — ' : '') + String(v.workspace)],
      ['role offered', v.role
        ? (roleKnown(S.roles, v.role) ? roleName(S.roles, v.role) + ' (read from this workspace\'s role table)'
          : v.role + ' — the label for it comes from that workspace\'s own role table, which is read when you open it')
        : 'the grant names no role'],
      ['grant revision', v.grantCid ?? 'the head read reported no CID'],
    ]));
    const b = el('button', 'primary sm', 'Accept — publish to my own pod') as HTMLButtonElement;
    b.disabled = !!S.writeBlocked;
    if (S.writeBlocked) b.title = S.writeBlocked;
    b.addEventListener('click', () => { void accept(v, b); });
    const r = el('div', 'row'); r.appendChild(b); row.appendChild(r);
  } else {
    row.appendChild(el('div', 'verdict no', 'not confirmed'));
    row.appendChild(el('div', 'note', 'This arrived in your inbox from ' + String(it['actor'] ?? 'an unnamed actor')
      + '. Any account on this relay can deliver into any inbox, so it is a claim. It was not confirmed because: '
      + (v.why ?? 'the checks above did not all pass') + '.'));
    if (inv.lead) {
      const b = el('button', 'sm', 'Look for a grant naming me on that pod') as HTMLButtonElement;
      const lead = inv.lead;
      b.addEventListener('click', () => {
        b.disabled = true;
        inv.state = 'unchecked';
        renderLobby();
        void (async () => {
          const { findSeat } = await import('@interego/workspace-client');
          const got = await findSeat(S.client as WorkspaceClient, { relay: S.relay, viewer: S.viewer as Viewer, workspace: lead });
          inv.verdict = got;
          if (got.ok) inv.lead = null;
          inv.state = 'checked';
          renderLobby();
        })();
      });
      const r = el('div', 'row'); r.appendChild(b); row.appendChild(r);
    }
  }
  return row;
}

function spaceRow(c: WorkspaceEntry): HTMLElement {
  const cur = !!S.workspace && c.workspace === S.workspace;
  const row = el('div', 'item' + (cur ? ' cur' : c.verified === false ? ' bad' : ''));
  row.appendChild(el('h4', undefined, c.title || c.slug || 'a workspace this client has not read a title for'));
  const wi = el('div', 'iri', c.workspace ?? c.acceptanceIri);
  // ★ WHICH SIDE OF THE COMPOSED/READ LINE THIS IRI IS ON. A qualified acceptance name carries
  // the convener pod and the slug, so this IRI is TAKEN APART OUT OF THE FILENAME rather than
  // read from the document — which is the whole reason the list is one manifest read.
  wi.title = c.naming === 'qualified'
    ? 'Composed from the acceptance\'s own filename (' + c.acceptanceIri + '), not read out of the document. '
      + 'Whether a workspace record exists at it is what the verdict below reports.'
    : 'Read from wsp:workspace inside the acceptance document itself, because an unqualified name carries no convener.';
  row.appendChild(wi);
  row.appendChild(el('div', 'iri', 'your acceptance: ' + c.acceptanceIri + ' · '
    + (c.naming === 'qualified' ? 'workspace-qualified name — the IRI above was composed from it, not read'
      : 'unqualified name, so the IRI above was read from inside the document')));
  if (c.verified === undefined) {
    row.appendChild(el('div', 'verdict wait', 'verifying against the convener\'s pod…'));
    return row;
  }
  if (c.verified) {
    row.appendChild(el('div', 'verdict ok', cur ? 'open' : 'verified'));
    if (!cur && c.workspace) {
      const b = el('button', 'sm', 'Open') as HTMLButtonElement;
      const iri = c.workspace;
      b.addEventListener('click', () => { void openWorkspace(iri); });
      const r = el('div', 'row'); r.appendChild(b); row.appendChild(r);
    }
    return row;
  }
  row.appendChild(el('div', 'verdict no', 'not verified'));
  row.appendChild(el('div', 'note', 'You have an acceptance for this on your own pod and it does not seat you: '
    + (c.why ?? 'the grant check did not pass') + '. It is listed rather than dropped, because a record you '
    + 'published is a fact about you either way.'));
  if (c.workspace) {
    const b = el('button', 'sm', 'Open it anyway') as HTMLButtonElement;
    b.title = 'Opens the channel. You will appear as writing without a seat, which is what the roster will say.';
    const iri = c.workspace;
    b.addEventListener('click', () => { void openWorkspace(iri); });
    const r = el('div', 'row'); r.appendChild(b); row.appendChild(r);
  }
  return row;
}

function renderLobby(): void {
  if (!document.getElementById('lobby')) return;
  renderSteps();

  const ic = $('invitecard');
  const il = $('invitelist');
  if (S.invites || S.inviteError) {
    ic.hidden = false;
    clear(il);
    if (S.inviteError) {
      il.appendChild(errBox(S.inviteError, 'You may only read your own inbox, so this is about your own pod and nobody else\'s.', () => { void loadInvites(); }));
    } else if (!S.invites?.length) {
      il.appendChild(el('div', 'note', 'No offers in your inbox carry something to look at. That is not the same as '
        + 'nobody having invited you: a grant can exist without a notification, and the control below opens one by IRI.'));
    } else {
      for (const inv of S.invites) il.appendChild(inviteRow(inv));
    }
    // Said whether or not any offer was found: a saturated read is exactly the case where "no
    // offers" is the least trustworthy sentence on the screen.
    if (S.inboxSaturated) {
      const w = el('div', 'panel pending');
      w.appendChild(el('h4', undefined, 'The inbox read came back full'));
      w.appendChild(el('div', undefined, 'This read asked for the most recent items and got exactly that many back, so an '
        + 'older offer may lie past the end of it. The relay\'s answer reports how many it RETURNED and not how many exist, '
        + 'so there is nothing in it to say whether anything was cut off — which is why the cap is stated rather than a total.'));
      il.appendChild(w);
    }
  } else ic.hidden = true;
  const pending = (S.invites ?? []).filter((i) => i.verdict?.ok).length;
  $('lobbycnt').hidden = !pending;
  $('lobbycnt').textContent = pending ? ' ' + String(pending) : '';

  const wc = $('wscard');
  const wl = $('wslist');
  if (S.spaces || S.spacesError) {
    wc.hidden = false;
    clear(wl);
    $('wsnote').textContent = S.spacesSaturated
      ? 'This read asked your own pod for its most recent descriptors and got exactly that many back, so an older acceptance may lie past the end of it.'
      : 'Read from your own pod in one call. A workspace-qualified acceptance name carries the workspace inside it, so most of these needed no further read.';
    if (S.spacesError) wl.appendChild(errBox(S.spacesError, 'Your own pod\'s manifest is where the list of workspaces comes from.', () => { void loadSpaces(); }));
    else if (!S.spaces?.length) wl.appendChild(el('div', 'note', 'No acceptance on your pod names a workspace, so you are in none yet. Accept an invitation above, or create one below.'));
    else for (const c of S.spaces) wl.appendChild(spaceRow(c));
  } else wc.hidden = true;

  const ready = !!S.viewer?.podName;
  $('createcard').hidden = !ready;
  $('opencard').hidden = !ready;
  renderSlugHint();

  // Invite, offered only where a grant this client writes would actually COUNT.
  const sc = $('sendcard');
  const convPod = S.record?.convenerPod ?? null;
  const iAmConvener = !!(S.workspace && S.viewer && convPod && convPod === S.viewer.podName);
  sc.hidden = !iAmConvener;
  if (iAmConvener) {
    $('sendhead').textContent = 'Invite someone to ' + (S.record?.title || S.slug);
    const sel = clear($('inviterole')) as HTMLSelectElement;
    const roles = S.roles.roles ? [...S.roles.roles.entries()] : [];
    for (const [iri, r] of roles) {
      const o = document.createElement('option');
      o.value = iri; o.textContent = r.label;
      sel.appendChild(o);
    }
    if (!roles.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'no roles were read from this workspace\'s profile';
      sel.appendChild(o);
    }
    btn('sendinvite').disabled = !roles.length || !!S.writeBlocked;
    const grantCap = S.record?.grantCapability ?? null;
    let why = 'Grants for this workspace are only counted when they are on pod ' + convPod
      + ', and that is your pod — which is what makes this control worth offering.';
    why += grantCap
      ? ' The workspace\'s record also names ' + grantCap + ' as the capability inviting needs.'
      : ' This workspace\'s record names no wsp:grantCapability, so there is no role-level test to run against it.';
    $('sendwhy').textContent = why;
    $('inviterolehint').textContent = roles.length
      ? 'Roles are read live from ' + (S.record?.roleProfile ?? 'this workspace\'s role profile') + '.'
      : 'This workspace\'s role profile did not resolve, so there is no role to grant.';
    renderRevokeList();
  }
}

function renderSlugHint(): void {
  const s = inp('wsslug').value.trim();
  const t = inp('wstitleIn').value.trim();
  const h = $('slughint');
  const problem = slugProblem(s);
  const pod = S.viewer?.podName ?? '<your pod>';
  if (!s) { h.className = 'hint'; h.textContent = 'Becomes ' + S.relay + '/ns/' + pod + '/<short name>.'; }
  else if (problem) { h.className = 'hint bad'; h.textContent = problem; }
  else { h.className = 'hint good'; h.textContent = nsIri(S.relay, pod, s); }
  btn('createbtn').disabled = !!problem || !t || !!S.writeBlocked;
}

// ── Flow A: create ───────────────────────────────────────────────────────────

async function create(): Promise<void> {
  if (!S.client || !S.viewer) return;
  if (S.writeBlocked) { say('createresult', 'refused', 'Not write-eligible on your pod', S.writeBlocked); return; }
  const b = btn('createbtn');
  b.disabled = true;
  const slug = inp('wsslug').value.trim();
  const p = say('createresult', 'pending', 'Creating ' + slug + ' on pod ' + S.viewer.podName);
  const log = el('div'); p.appendChild(log);
  const setters = new Map<string, (s: string, d: string) => void>();
  const out = await createWorkspace(S.client, {
    relay: S.relay, viewer: S.viewer, title: inp('wstitleIn').value.trim(), slug,
    onStep: (s) => {
      let set = setters.get(s.label);
      if (!set) { set = writeLine(log, s.label); setters.set(s.label, set); }
      set(s.state, s.detail);
    },
  });
  b.disabled = false;
  const h4 = p.querySelector('h4') as HTMLElement;
  if (out.kind === 'invalid') { p.className = 'panel refused'; h4.textContent = 'Nothing was written'; p.appendChild(el('div', 'note', out.why)); return; }
  if (out.kind === 'error') { clear($('createresult')).appendChild(errBox(out.error, 'Stopped at "' + out.at + '". Published before it: ' + (out.done.join(', ') || 'nothing') + '.')); return; }
  if (out.kind === 'refused') { refusalPanel('createresult', out.refusal, 'The ' + out.at); return; }
  if (out.kind === 'stalled') {
    p.className = 'panel pending';
    h4.textContent = 'The ' + out.at + ' is not readable yet, so the rest was not attempted';
    p.appendChild(el('div', 'note', out.why + ' Published before it: ' + (out.done.join(', ') || 'nothing') + '. Press Create again in a moment.'));
    return;
  }
  p.className = 'panel ok';
  h4.textContent = out.seated ? 'Created — you are seated in ' + slug : 'Created, and your acceptance is not readable yet';
  p.appendChild(kvPair([
    ['workspace', out.workspace], ['shape', out.shapeIri], ['roles', out.rolesIri],
    ['your grant', out.grantIri], ['your acceptance', out.acceptanceIri],
    ['grant revision pinned', out.grantCid ?? 'the head read reported no CID'],
  ]));
  p.appendChild(el('div', 'note', 'Every one of those is a URL. Give the workspace IRI to anyone you want to look at it; '
    + 'to seat them you also have to publish a grant naming them, which is the Invite control once this workspace is open.'));
  inp('wsslug').value = ''; inp('wstitleIn').value = '';
  await openWorkspace(out.workspace);
  void loadSpaces();
}

/** The refusals every membership write can meet, in the relay's own words. */
function refusalPanel(where: string, bad: Record<string, unknown>, what: string): HTMLElement {
  const code = bad['code'];
  const message = String(bad['message'] ?? '');
  if (code === 422 && bad['error'] === 'shape_violation') {
    const p = say(where, 'refused', 'Refused by the workspace\'s own shape',
      what + ' did not conform to the shape this workspace declares, so nothing was written. '
      + (bad['shape'] ? 'The shape is ' + String(bad['shape']) + '.' : 'The response did not name the shape.'));
    const list = el('div', 'kv');
    for (const v of (bad['violations'] as readonly Record<string, unknown>[] | undefined) ?? []) {
      list.appendChild(el('div', 'k', String(v['path'] ?? v['constraint'] ?? 'constraint').split(/[#/]/).pop() as string));
      list.appendChild(el('div', 'v', String(v['message'] ?? v['constraint'] ?? '')));
    }
    p.appendChild(list);
    return p;
  }
  if (code === 422) {
    return say(where, 'refused', 'The workspace\'s shape did not resolve',
      message + ' The relay refused the write rather than publishing it unvalidated, so nothing landed and nothing is '
      + 'claiming a conformance that was never checked.');
  }
  if (code === 403) {
    return say(where, 'refused', 'Refused — that pod is not yours to write to',
      message + (bad['scope'] ? ' Your delegated scope is ' + String(bad['scope']) + '.' : '')
      + ' This is the check the whole arrangement rests on: nobody can write a document onto somebody else\'s pod.');
  }
  if (code === 412) {
    return say(where, 'refused', 'Refused — 412 precondition_failed', message + ' Something moved under this write, so it was not applied.');
  }
  if (code === 503) {
    return say(where, 'pending', 'The relay could not check the precondition',
      message + ' This is deliberately not a 412: a 412 means your assertion was checked and failed, this means it could '
      + 'not be checked at all. Nothing was written, and this client will not retry a write on your behalf.');
  }
  return say(where, 'refused', 'Refused: ' + String(bad['error'] ?? 'no code'), message);
}

// ── Flow B: invite ───────────────────────────────────────────────────────────

async function invite(): Promise<void> {
  if (!S.client || !S.viewer || !S.workspace) return;
  if (S.writeBlocked) { say('sendresult', 'refused', 'Not write-eligible on your pod', S.writeBlocked); return; }
  const handle = inp('invitee').value.trim();
  const role = ($('inviterole') as HTMLSelectElement).value;
  if (!handle || !role) return;
  // ★ THE ROLE IS RE-DERIVED AT CLICK, NOT TRUSTED FROM THE RENDER. The select is filled by a
  // render, and a render that ran while a different workspace was open leaves an option behind
  // that this workspace does not define — publishing it produces a member whose role no reader
  // of this workspace can look up.
  const rc = checkRoleForWorkspace(S.roles, role);
  if (!rc.ok) { say('sendresult', 'refused', 'That role is not one this workspace defines', rc.why); renderLobby(); return; }

  const b = btn('sendinvite');
  b.disabled = true;
  const p = say('sendresult', 'pending', 'Resolving ' + handle);
  const log = el('div'); p.appendChild(log);
  let set: ((s: string, d: string) => void) | null = null;
  const out = await sendInvite(S.client, {
    viewer: S.viewer, workspace: S.workspace, workspaceTitle: S.record?.title || (S.slug ?? ''),
    handle, role, entryShape: S.record?.entryShape ?? null,
    onState: (s, d) => { if (!set) set = writeLine(log, 'grant on your pod'); set(s, d); },
  });
  b.disabled = false;
  const h4 = p.querySelector('h4') as HTMLElement;
  if (out.kind === 'resolve-failed') { clear($('sendresult')).appendChild(errBox(out.error, 'Nothing was published and nobody was notified.')); return; }
  p.insertBefore(checkList(out.resolution.checks), log);
  if (out.kind === 'blocked') {
    p.className = 'panel refused'; h4.textContent = 'Cannot grant to that handle';
    p.appendChild(el('div', 'note', 'Nothing was published: ' + out.resolution.blocked + '.'));
    return;
  }
  if (out.kind === 'error') { clear($('sendresult')).appendChild(errBox(out.error, 'No grant was published and nobody was notified.')); return; }
  if (out.kind === 'refused') { refusalPanel('sendresult', out.refusal, 'The grant'); return; }
  p.className = 'panel ' + (out.readable && out.notify.delivered ? 'ok' : 'pending');
  h4.textContent = out.readable
    ? (out.notify.delivered ? 'Invited — the grant is readable and the notice was delivered'
      : 'The grant is readable; the notice was not confirmed delivered')
    : 'The grant was accepted and is not readable yet';
  p.appendChild(kvPair([
    ['grant', out.grantIri],
    ['granted to', out.resolution.webId],
    ['role', roleName(S.roles, role)],
    ['readable on your pod', out.readable ? 'yes — the head matches the descriptor this write returned' : (out.why ?? 'not yet')],
    ['notification', out.notify.line],
  ]));
  p.appendChild(el('div', 'note', out.notify.delivered
    ? 'They will see it the next time their client reads their inbox. The grant is the thing that matters — the notice is only a pointer to it.'
    : 'The grant exists either way. A notification is a convenience, not the membership: send them the grant IRI above by any means and their client will verify it against your pod exactly the same way.'));
  await loadRoster();
}

function renderRevokeList(): void {
  const box = clear($('revokelist'));
  const rows = S.seats.filter((m) => m.graph);
  if (!rows.length) { box.appendChild(el('div', 'note', 'No grants for this workspace have been read from your pod yet.')); return; }
  for (const m of rows) {
    const r = el('div', 'item' + (m.revoked ? ' bad' : ''));
    const h = el('h4', undefined, (m.pod ?? 'an unresolved principal') + ' — ' + roleName(S.roles, m.role));
    h.title = roleWhy(S.roles, m.role);
    r.appendChild(h);
    r.appendChild(el('div', 'iri', m.graph));
    r.appendChild(el('div', 'verdict ' + (m.revoked ? 'no' : m.seated ? 'ok' : 'wait'),
      m.revoked ? 'revoked' : m.seated ? 'seated' : 'granted, not accepted'));
    if (m.revoked) {
      r.appendChild(el('div', 'note', 'Their own acceptance is still on their pod and everything they wrote is still theirs. Revoking a grant cannot reach either.'));
    } else {
      const b = el('button', 'danger sm', 'Revoke this grant') as HTMLButtonElement;
      b.disabled = !!S.writeBlocked;
      if (S.writeBlocked) b.title = S.writeBlocked;
      b.addEventListener('click', () => { void revoke(m, b); });
      const row = el('div', 'row'); row.appendChild(b); r.appendChild(row);
    }
    box.appendChild(r);
  }
}

async function revoke(m: Seat, b: HTMLButtonElement): Promise<void> {
  if (!S.client || !S.viewer || !S.workspace) return;
  b.disabled = true;
  const p = say('sendresult', 'pending', 'Withdrawing the grant for ' + (m.pod ?? 'this principal'));
  const log = el('div'); p.appendChild(log);
  let set: ((s: string, d: string) => void) | null = null;
  const out = await revokeGrant(S.client, {
    viewer: S.viewer, workspace: S.workspace, grantIri: m.graph, grantedTo: m.grantedTo, role: m.role,
    // The revision that is there NOW. A revocation written against a grant somebody has already
    // moved is a revocation of something else.
    ifMatch: m.grantCid ?? m.grantUrl, entryShape: S.record?.entryShape ?? null,
    onState: (s, d) => { if (!set) set = writeLine(log, 'revocation on your pod'); set(s, d); },
  });
  b.disabled = false;
  const h4 = p.querySelector('h4') as HTMLElement;
  if (out.kind === 'incomplete') { p.className = 'panel refused'; h4.textContent = 'This grant cannot be rewritten from here'; p.appendChild(el('div', 'note', out.why)); return; }
  if (out.kind === 'error') { clear($('sendresult')).appendChild(errBox(out.error, 'Nothing was written; the grant still stands.')); return; }
  if (out.kind === 'refused') { refusalPanel('sendresult', out.refusal, 'The revocation'); return; }
  p.className = 'panel ' + (out.readable ? 'ok' : 'pending');
  h4.textContent = out.readable ? 'Revoked' : 'Accepted, not yet readable';
  p.appendChild(kvPair([['grant', out.grantIri], ['asserted revision', out.asserted ?? 'none — this client held no revision for it']]));
  p.appendChild(el('div', 'note', 'Their acceptance and their log are untouched, on their own pod, and this client could not '
    + 'have reached either. The roster will now show the row as revoked and stop folding their log into this channel.'));
  await loadRoster();
}

// ── Flow C: accept ───────────────────────────────────────────────────────────

async function accept(v: GrantVerdict, b: HTMLButtonElement): Promise<void> {
  if (!S.client || !S.viewer) return;
  if (S.writeBlocked) { say('invitedetail', 'refused', 'Not write-eligible on your pod', S.writeBlocked); return; }
  b.disabled = true;
  const p = say('invitedetail', 'pending', 'Publishing your acceptance on your own pod',
    'One write, to ' + S.viewer.podName + ', with your credentials. The convener does nothing here, and could not: '
    + 'the substrate refuses a write to a pod the writer does not own.');
  const log = el('div'); p.appendChild(log);
  let set: ((s: string, d: string) => void) | null = null;
  const out = await acceptGrant(S.client, {
    relay: S.relay, viewer: S.viewer, verdict: v,
    onState: (s, d) => { if (!set) set = writeLine(log, 'acceptance on your pod'); set(s, d); },
  });
  b.disabled = false;
  if (out.kind === 'error') { clear($('invitedetail')).appendChild(errBox(out.error, 'Nothing was written, so nothing seats you.')); return; }
  if (out.kind === 'refused') { refusalPanel('invitedetail', out.refusal, 'Your acceptance'); return; }
  const h4 = p.querySelector('h4') as HTMLElement;
  p.className = 'panel ' + (out.readable ? 'ok' : 'pending');
  h4.textContent = out.readable ? 'Accepted — you are seated' : 'Accepted, not yet readable';
  p.appendChild(kvPair([
    ['your acceptance', out.acceptanceIri],
    ['names grant', out.grantIri],
    ['pinned revision', out.grantCid ?? 'the head read reported no CID'],
    ['your log will be', out.streamIri],
    // `verifyGrantIri` read and located this workspace's record before it returned, so "names
    // none" here is a statement about a document that WAS opened.
    ['shape asserted', out.entryShape ?? 'the workspace record was read and names none, so this was written unvalidated'],
  ]));
  // Open it FIRST. Re-listing every workspace re-verifies every acceptance against every
  // convener's pod, which is seconds of reads the person who just pressed Accept has no reason
  // to wait through — and while they waited the client was still showing whatever was open.
  if (out.readable) await openWorkspace(out.workspace);
  void loadSpaces();
}

// ── the channel ──────────────────────────────────────────────────────────────

function teardownWorkspace(): void {
  S.watches.forEach((u) => { try { u(); } catch { /* already gone */ } });
  S.watches = [];
  S.streams.clear();
  S.bodies.clear();
  S.seats = []; S.fold = null; S.record = null; S.recordResult = null;
  S.roles = { roles: null, caps: null };
  S.profileFrom = null; S.profileError = null;
  S.streamsOpened = false; S.streamIri = null;
  S.canvas = { iri: null, head: null, loaded: null, exists: false };
  for (const id of ['postresult', 'canvasresult']) { const n = document.getElementById(id); if (n) clear(n); }
}

async function openWorkspace(iri: string): Promise<void> {
  if (!S.client || !S.viewer) return;
  const parts = parseWorkspaceIri(S.relay, iri);
  if (!parts) {
    $('openhint').className = 'hint bad';
    $('openhint').textContent = 'That is not a workspace IRI on this relay. It has to look like ' + S.relay + '/ns/<pod>/<short name>.';
    showLobby(true);
    return;
  }
  teardownWorkspace();
  S.workspace = iri; S.iriOwner = parts.owner; S.slug = parts.slug;
  try { localStorage.setItem('wsp:last', iri); } catch { /* storage may be denied */ }
  $('openhint').textContent = '';
  $('chnamewrap').hidden = false;
  $('chname').textContent = parts.slug;
  $('wstitle').textContent = '';
  showLobby(false);
  clear($('roster')).appendChild(el('div', 'note', 'Reading the roster…'));
  clear($('stream')).appendChild(el('div', 'note', 'Reading ' + parts.slug + '…'));
  $('watchline').textContent = 'Updates are ' + S.watchDescription + '.';

  // The viewer's own documents for THIS workspace. Both naming forms are tried; which one
  // answered is what the composer and the canvas then use, so a conversation already living
  // under the older name keeps going.
  const st = await S.client.resolveMemberDoc(S.viewer.podName, parts.owner, parts.slug, 'stream');
  S.streamIri = st.iri;
  const cv = await S.client.resolveMemberDoc(S.viewer.podName, parts.owner, parts.slug, 'canvas');
  S.canvas.iri = cv.iri;

  // ★ THE VERDICT WINS OVER THE DESCRIPTION. `applyWriteVerdict` runs during boot, BEFORE any
  // workspace is opened, and this line used to overwrite it unconditionally — so a viewer the
  // relay had declared not write-eligible was told, in the composer's own footer, exactly where
  // their posts would land. Found by driving this renderer with writeEligible:false.
  clear($('writes-to')).appendChild(document.createTextNode(S.writeBlocked
    ? S.writeBlocked
    : 'Posting writes a wsp:Entry to your own pod ' + S.viewer.podName + ' — a real, public record on the live fleet. '
      + 'Its IRI is composed from that pod name, this workspace\'s convener pod and its short name; the workspace record '
      + 'does not enumerate streams.' + (st.found || st.forked ? '' : ' Nothing is published there yet, so your first post creates it.')));

  // ★ THE COMPOSER STAYS SHUT UNTIL THE RECORD HAS BEEN READ. Posting sends the record's own
  // `wsp:entryShape` as `conforms_to_shapes`; opening the composer before the read settles is
  // how an entry goes out with no shape at all while the panel reports as positive fact that
  // the record names none.
  area('composer').placeholder = 'Reading ' + parts.slug + '\'s record — it says which shape a post is validated against…';
  S.recordResult = await S.client.readWorkspaceRecord(iri, parts.owner).catch((e: unknown) => ({ kind: 'error' as const, error: e }));
  S.record = S.recordResult.kind === 'record' ? S.recordResult.record : null;
  if (S.record) { $('wstitle').textContent = S.record.title; }

  const settled = S.recordResult.kind !== 'error';
  btn('send').disabled = !!S.writeBlocked || !settled;
  area('composer').disabled = !!S.writeBlocked || !settled;
  // ★ THE PLACEHOLDER HAS TO AGREE WITH THE CONTROL. This used to say "Message #<slug>" over a
  // composer the delegation verdict had already disabled — an invitation to type into a box
  // that would refuse, with the real reason painted over. Found by driving this renderer in a
  // document with the relay answering writeEligible:false.
  area('composer').placeholder = S.writeBlocked ? 'Not write-eligible on this pod.'
    : settled ? 'Message #' + parts.slug
      : 'The workspace record could not be read, so which shape a post is validated against is not established — nothing is offered to write.';

  renderCanvasShell();
  void loadCanvas(true);

  // Roles are DATA — read from the profile the record names, not an enum in this file.
  if (S.record?.roleProfile) {
    try {
      const got = await S.client.fetchProfileTurtle(S.record.roleProfile);
      const parsed = parseRoleProfile(got.turtle);
      S.roles = { roles: parsed.roles, caps: parsed.caps };
      S.profileFrom = { from: got.from, hops: got.hops };
    } catch (e) { S.profileError = e; }
  }

  await loadRoster();
  openStreams();
  renderLobby();
}

async function loadRoster(): Promise<void> {
  if (!S.client || !S.workspace || !S.iriOwner || !S.slug) return;
  const box = $('roster');
  if (!S.recordResult || S.recordResult.kind !== 'record') {
    clear(box);
    const r = S.recordResult;
    if (r?.kind === 'forked') {
      const p = el('div', 'panel refused');
      p.appendChild(el('h4', undefined, 'The workspace record has ' + r.heads.length + ' unresolved heads'));
      p.appendChild(el('div', undefined, r.message));
      p.appendChild(el('div', 'note', 'A forked supersession chain is a compare-and-swap somebody missed. The relay reports '
        + 'it rather than picking a winner, so the roster cannot be folded — there is more than one claim about who convenes here.'));
      box.appendChild(p);
    } else {
      box.appendChild(errBox(r?.kind === 'error' ? r.error : new Error(r?.kind === 'missing' ? r.message : 'the workspace record could not be read'),
        'The workspace record could not be read, so no roster can be folded from it.', () => { void loadRoster(); }));
    }
    return;
  }
  const rec = S.recordResult.record;
  let fold;
  try {
    fold = await foldRoster(S.client, {
      workspace: S.workspace, iriOwner: S.iriOwner, slug: S.slug,
      convener: rec.convener, convenerPod: rec.convenerPod,
    });
  } catch (e) {
    clear(box).appendChild(errBox(e, 'Grants live on the convener\'s pod (' + grantPodFor(rec.convenerPod, S.iriOwner)
      + '); without them there are no roles to read.', () => { void loadRoster(); }));
    return;
  }
  S.fold = fold;
  S.seats = fold.seats.slice();
  S.podMarks = assignPodMarks(S.seats.map((m) => m.pod).concat([S.viewer?.podName ?? null]));
  renderRoster();
  renderLobby();
}

const viewerIsSeated = (): boolean => !!(S.viewer && S.seats.some((m) => m.seated && m.pod === S.viewer?.podName));

function renderRoster(): void {
  const box = clear($('roster'));
  const fold = S.fold;
  if (S.profileError) {
    box.appendChild(errBox(S.profileError, 'Roles are data: they come from the profile document the workspace record names. Without it, no capability can be shown.'));
  } else if (S.profileFrom) {
    box.appendChild(el('div', 'note', 'Roles below are read from the profile this workspace names, live — '
      + (S.roles.roles ? S.roles.roles.size : 0) + ' roles from ' + S.profileFrom.from
      + (S.profileFrom.hops === 2 ? ', followed one hop from the page\'s own text/turtle alternate.' : '.')
      + ' A role is a ceiling, not a grant: what a member can actually do is the role\'s capabilities intersected with '
      + 'what their pod owner delegated to their agent. This client shows both sides of that intersection and does not compute it.'));
  }
  if (fold) {
    box.appendChild(el('div', 'note', fold.grantPodDerivedFrom
      ? 'Grants below were read from pod ' + fold.grantPod + ', chosen by resolving the ' + fold.grantPodDerivedFrom + '.'
      : 'Grants below were read from pod ' + fold.grantPod + ', taken from the workspace IRI because the record named no convener.'));
    if (fold.grantScanSaturated) {
      const w = el('div', 'panel pending');
      w.appendChild(el('h4', undefined, 'The grant scan came back full'));
      w.appendChild(el('div', undefined, 'This read asked the convener\'s pod for its most recent ' + fold.grantLimit
        + ' descriptors and got exactly that many back, so older grants may lie past the end of it. A member missing from '
        + 'the roster below would also be missing from the channel.'));
      box.appendChild(w);
    }
    if (fold.grantsFound > fold.grantsRead) {
      const w = el('div', 'panel pending');
      w.appendChild(el('h4', undefined, fold.grantsFound + ' grants were found and ' + fold.grantsRead + ' of them were read'));
      w.appendChild(el('div', undefined, 'Reading a grant is two round trips against a pod that may be cold, so the fold stops at '
        + fold.grantReadCap + '. The rest are not on the list below and their logs are not in the channel. That is this client\'s '
        + 'cap on its own work, not a finding about whether those grants seat anybody.'));
      box.appendChild(w);
    }
  }

  for (const m of S.seats) {
    const row = el('div', 'member');
    const b = el('div', 'badge', (m.pod && S.podMarks.get(m.pod)) ?? '??');
    b.title = m.pod ? 'pod ' + m.pod : 'no pod resolved for this principal';
    row.appendChild(b);
    const right = el('div');
    const nm = el('div', 'mname');
    const rn = el('span', undefined, roleName(S.roles, m.role));
    rn.title = roleWhy(S.roles, m.role);
    // ★ AN UNRESOLVABLE ROLE IS MARKED WHERE IT IS SHOWN, not only in a tooltip: the row is
    // otherwise indistinguishable from one whose role WAS read.
    if (m.role && !roleKnown(S.roles, m.role)) rn.style.color = 'var(--pending)';
    nm.appendChild(rn);
    if (m.role && !roleKnown(S.roles, m.role)) {
      const t = el('span', 'cap', S.roles.roles ? 'role not in this workspace\'s table' : 'role table not resolved');
      t.title = roleWhy(S.roles, m.role);
      nm.appendChild(t);
    }
    if (m.revoked) nm.appendChild(el('span', 'cap', 'revoked'));
    if (!m.seated && !m.revoked) nm.appendChild(el('span', 'cap', m.pending ? 'invited' : 'not seated'));
    right.appendChild(nm);
    const pl = el('div', 'mpod', m.pod ?? 'unresolved principal');
    pl.title = 'Parsed from the grantee WebID in the convener\'s grant. That is a claim in somebody else\'s document.';
    right.appendChild(pl);
    if (m.acceptUrl) {
      // Where this member's own bytes actually came from, held against what the grant claims.
      const v = podClaimVsServed(m.pod, m.podServed ?? null, m.acceptUrl, 'grant');
      const sp = el('div', 'mpod', 'acceptance served from ' + v.text);
      sp.title = v.title;
      if (v.mismatch) sp.style.color = 'var(--refused)';
      right.appendChild(sp);
    }
    if (m.acceptIri) {
      const nn = el('div', 'mpod', m.acceptNaming === 'qualified'
        ? 'seat read from the workspace-qualified name on their pod'
        : 'seat read from the older unqualified name on their pod');
      nn.title = m.acceptIri;
      right.appendChild(nn);
    }
    if (m.seated && m.acceptTest) {
      const at = el('div', 'mpod', m.acceptTest);
      at.title = 'The acceptance is only a seat if it names the grant that is CURRENT. This is the test that ran.';
      right.appendChild(at);
    }
    const roleDef = m.role && S.roles.roles ? S.roles.roles.get(m.role) : null;
    if (m.seated && roleDef && S.roles.caps) {
      const caps = el('div', 'caps');
      // ★ ONE SIDE OF THE INTERSECTION, AND IT SAYS SO. Nothing published maps a delegation
      // scope onto these capability IRIs, so the intersection is not computable from data and is
      // not asserted. What is shown is what the profile says.
      for (const [c, def] of S.roles.caps) {
        const inRole = roleDef.permits.indexOf(c) >= 0;
        const chip = el('span', 'cap ' + (inRole ? 'held' : 'withheld'), def.label);
        chip.title = (inRole
          ? 'This role permits ' + def.label + '. Whether their agent can exercise it also depends on the delegated scope, which this client does not intersect.'
          : 'This role does not permit ' + def.label + '.') + (def.comment ? ' — ' + def.comment : '');
        caps.appendChild(chip);
      }
      right.appendChild(caps);
      right.appendChild(el('div', 'mmeta', roleDef.comment));
    } else if (m.why) {
      right.appendChild(el('div', 'mmeta', m.why));
    }
    if (m.seated && m.memberAgent) {
      const sg = el('div', 'mmeta');
      sg.style.color = m.memberAgentVerified ? 'var(--ok)' : 'var(--pending)';
      sg.textContent = m.memberAgentVerified
        ? 'acceptance signed by ' + m.memberAgent + ' — proof verified by the relay'
        : 'acceptance declares signer ' + m.memberAgent + ' — the relay did not report a verified proof, so this is their claim about themselves';
      right.appendChild(sg);
    }
    row.appendChild(right);
    box.appendChild(row);
  }

  if (!S.seats.length) {
    box.appendChild(el('div', 'note', 'The convener\'s pod was read and no grant naming this workspace was found on it.'));
  }
  if (viewerIsSeated()) return;

  // ★ WHY THE FOLD DID NOT SEAT YOU, FROM THE ROWS ABOVE. Printing "no grant names your pod"
  // while a row directly above shows that same pod tagged "invited" is a contradiction the
  // client already holds the record for.
  const you = el('div', 'panel');
  you.appendChild(el('h4', undefined, 'You are writing, and you are not on the roster'));
  const yourRows = S.viewer ? S.seats.filter((m) => m.pod && m.pod === S.viewer?.podName) : [];
  let w = 'Membership is two-sided. A convener publishes a grant on their pod; you publish an acceptance on yours. ';
  if (yourRows.length) {
    w += (yourRows.length === 1 ? 'One grant on the convener\'s pod does name your pod, and it does not seat you: '
      : yourRows.length + ' grants on the convener\'s pod name your pod, and none of them seats you: ')
      + yourRows.map((m) => m.revoked ? 'revoked' : m.pending ? 'granted, awaiting your acceptance on your own pod' : (m.why ?? 'seated by neither half of the two-sided check')).join(' — ')
      + ' That row is above; this block is not claiming otherwise. ';
  } else if (S.fold?.grantScanSaturated) {
    w += 'No grant naming your pod appeared in the grants this client could see — and that scan came back full, so this is what was read, not necessarily all there is. ';
  } else if (S.fold && S.fold.grantsFound > S.fold.grantsRead) {
    w += 'No grant naming your pod appeared in the ' + S.fold.grantsRead + ' grants this client read, and ' + S.fold.grantsFound
      + ' were found — so this is what was read, not necessarily all there is. ';
  } else {
    w += 'This read found no grant naming your pod on the convener\'s pod, so the fold does not seat you — nobody can add you unilaterally and you cannot add yourself. ';
  }
  w += 'Your posts still land on your pod and are still yours; they are simply outside the roster\'s fold.';
  you.appendChild(el('div', undefined, w));
  box.appendChild(you);
}

// ── streams ──────────────────────────────────────────────────────────────────

// Keyed on (pod, graph), not the graph: two members who name the same wsp:stream would otherwise
// collapse into one entry and the first member's log would render as empty.
const streamKey = (pod: string, graph: string): string => pod + ' ' + graph;

interface Participant { readonly pod: string; readonly graph: string; readonly isYou: boolean; readonly seat: Seat | null }

function participants(): readonly Participant[] {
  const list: Participant[] = S.seats.filter((m) => m.seated && m.stream && m.pod).map((m) => ({
    pod: m.pod as string, graph: m.stream as string, isYou: m.pod === S.viewer?.podName, seat: m,
  }));
  // If the viewer is themselves a seated member they are ONE participant, not two.
  if (S.viewer && S.streamIri && !viewerIsSeated()) {
    list.push({ pod: S.viewer.podName, graph: S.streamIri, isYou: true, seat: null });
  }
  return list;
}

function openStreams(): void {
  if (!S.client) return;
  for (const p of participants()) {
    const key = streamKey(p.pod, p.graph);
    const st: Loaded = { ...p, rows: [], error: null, loaded: false, stale: null, watchFailed: null };
    S.streams.set(key, st);
    const input = { pod_name: p.pod, graph_iri: p.graph, sort: 'oldest-first' };
    const unsub = S.client.tx.watchTool?.('discover_context', input, (ev) => {
      const cur = S.streams.get(key);
      if (!cur) return;
      if (ev.type === 'error') {
        // Authz denials retract the rows; transient errors keep the last good ones.
        if (['needs_reauth', 'server_not_connected', 'blocked_by_policy', 'approval_required', 'not_granted'].indexOf(ev.error.code ?? '') >= 0) {
          cur.rows = []; cur.error = ev.error; cur.loaded = true;
        } else if (!cur.loaded) { cur.error = ev.error; cur.loaded = true; }
        else { cur.stale = ev.error; }
        renderStream();
        return;
      }
      const payload = ev.result.payload as Record<string, unknown> | null;
      const entries = payload?.['entries'];
      if (!Array.isArray(entries)) {
        cur.error = new Error('this pod answered without an entries array, so the stream could not be read — which is not the same as it being empty');
        cur.loaded = true; renderStream(); return;
      }
      cur.error = null; cur.stale = null; cur.loaded = true;
      cur.rows = (entries as Record<string, unknown>[])
        .filter((e) => Array.isArray(e['describes']) && (e['describes'] as string[]).indexOf(p.graph) >= 0)
        .map((e) => ({
          url: String(e['descriptorUrl'] ?? ''), cid: (e['cid'] as string) ?? null,
          validFrom: (e['validFrom'] as string) ?? null,
          supersedes: Array.isArray(e['supersedes']) ? e['supersedes'] as string[] : [],
        }));
      renderStream();
      void loadBodies(cur.rows);
    }, { refetchInterval: 45000 }) ?? null;
    // ★ NULL IS THE ANSWER HERE, NOT A THROW. A registration that failed means no update will
    // EVER arrive on its own, so the row is marked and a one-shot read is attempted rather than
    // leaving "reading…" up forever.
    if (unsub) S.watches.push(unsub);
    else {
      st.watchFailed = new Error('this transport registered no watch for this log, so no update will arrive on its own');
      void readOnce(key);
    }
  }
  S.streamsOpened = true;
  renderStream();
}

async function readOnce(key: string): Promise<{ rows?: readonly ChainRow[]; error?: unknown }> {
  const st = S.streams.get(key);
  if (!st || !S.client) return { error: new Error('this client is not tracking a log for ' + key) };
  try {
    const rows = (await S.client.manifest(st.pod, st.graph)).map((e) => ({
      url: String(e['descriptorUrl'] ?? ''), cid: (e['cid'] as string) ?? null,
      validFrom: (e['validFrom'] as string) ?? null,
      supersedes: Array.isArray(e['supersedes']) ? e['supersedes'] as string[] : [],
    }));
    st.rows = rows; st.error = null; st.loaded = true;
    renderStream();
    await loadBodies(rows);
    return { rows };
  } catch (e) { st.error = e; st.loaded = true; renderStream(); return { error: e }; }
}

/** One `get_descriptor` per entry, on its author's pod, four at a time. */
async function loadBodies(rows: readonly ChainRow[]): Promise<void> {
  if (!S.client) return;
  const wanted = rows.filter((r) => !S.bodies.has(r.url)).map((r) => r.url);
  const owner = (url: string): string | null => {
    for (const st of S.streams.values()) if (st.rows.some((r) => r.url === url)) return st.graph;
    return null;
  };
  const workers = Array.from({ length: Math.min(4, wanted.length) }, async () => {
    for (;;) {
      const url = wanted.shift();
      if (!url) return;
      try {
        const d = await (S.client as WorkspaceClient).descriptor(url);
        const g = owner(url);
        const region = g === null ? null : graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', g);
        // `''` is a signed block that WAS located and is empty; `null` is one that was not.
        const src = region === null ? '' : region;
        const auth = d['authorship'] as { signedBy?: string; authorshipVerified?: boolean } | undefined;
        S.bodies.set(url, {
          body: readLiteral(src, 'dct:description'),
          seq: readInt(src, 'wsp:seq'),
          isEntry: hasType(src, 'wsp:Entry'),
          declaredWorkspace: readIri(src, 'wsp:workspace'),
          servedPod: podOfDescriptorUrl(url),
          signed: !!auth?.authorshipVerified,
          signedBy: auth?.signedBy ?? null,
          note: g === null
            ? 'this client is no longer tracking which log this record belongs to, so which signed region is its own could not be established'
            : region === null
              ? 'the signed region of this record could not be located, so nothing here was read from bytes anybody signed'
              : null,
        });
      } catch (e) {
        S.bodies.set(url, { body: null, seq: null, isEntry: false, declaredWorkspace: null, servedPod: null, signed: false, signedBy: null, note: errorCopy(e).t, error: e });
      }
    }
  });
  await Promise.all(workers);
  renderStream();
}

function renderStream(): void {
  const wrap = $('stream');
  const scroller = $('streamwrap');
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
  clear(wrap);
  const parts = [...S.streams.values()];
  if (!parts.length) {
    wrap.appendChild(el('div', 'note', S.streamsOpened
      ? 'No seated member declares a stream, so there is nothing to compose.'
      : 'Connecting to the workspace…'));
    return;
  }
  const all: { r: ChainRow; st: Loaded; pos: number }[] = [];
  let anyLoaded = false;
  for (const st of parts) {
    if (st.loaded) anyLoaded = true;
    if (st.error) continue;
    orderChain(st.rows).ordered.forEach((r, i) => all.push({ r, st, pos: i }));
  }
  if (!anyLoaded) {
    wrap.appendChild(el('div', 'note', 'Reading one manifest per member, each from that member\'s own pod…'));
    return;
  }
  // Cross-stream order is ADVISORY: these clocks were never synchronised and no shared sequencer
  // exists. Within a stream the chain is authoritative.
  all.sort((a, b) => String(a.r.validFrom ?? '').localeCompare(String(b.r.validFrom ?? '')));
  wrap.appendChild(el('div', 'note', 'Composed from ' + parts.length + ' append-only logs, one per participant, each read from '
    + 'its own pod. Order within a log is the chain each entry declares. Order between logs is by timestamp and is advisory — '
    + 'these clocks were never synchronised, and there is no shared sequencer to appeal to.'));

  for (const item of all) {
    const b = S.bodies.get(item.r.url);
    const msg = el('div', 'msg');
    const badge = el('div', 'badge', item.st.isYou ? 'YOU' : (S.podMarks.get(item.st.pod) ?? '??'));
    badge.title = 'pod ' + item.st.pod;
    msg.appendChild(badge);
    const right = el('div');
    const h = el('div', 'mhead');
    h.appendChild(el('span', 'mauthor', item.st.seat ? roleName(S.roles, item.st.seat.role) : 'You'));
    const v = podClaimVsServed(item.st.pod, b?.servedPod ?? podOfDescriptorUrl(item.r.url), item.r.url, 'roster');
    const origin = el('span', 'seq', v.text);
    origin.title = v.title;
    if (v.mismatch) origin.style.color = 'var(--refused)';
    h.appendChild(origin);
    h.appendChild(el('span', 'mtime', fmtTime(item.r.validFrom)));
    if (b?.seq !== null && b?.seq !== undefined) h.appendChild(el('span', 'seq', 'seq ' + b.seq));
    right.appendChild(h);

    // ★ FIVE STATES, FIVE RENDERS. Still reading, could not be read, no signed region, no
    // description, and an EMPTY description are five different facts, and rendering them the
    // same way is the exact conflation this client exists to avoid.
    const t = el('div', 'body');
    if (!b) { t.className = 'body pending'; t.textContent = 'reading this record from ' + item.st.pod + '…'; }
    else if (b.error) { t.className = 'body unread'; t.textContent = 'This entry could not be read from ' + item.st.pod + ' (' + errorCopy(b.error).t.toLowerCase() + '). Whether it has content is unknown.'; }
    else if (b.note) { t.className = 'body unread'; t.textContent = b.note; }
    else if (b.body === null) { t.className = 'body absent'; t.textContent = 'This record was read and carries no dct:description.'; }
    else if (b.body === '') { t.className = 'body absent'; t.textContent = 'This record carries a dct:description, and it is empty.'; }
    else t.textContent = b.body;
    right.appendChild(t);

    // A member's log belongs to THEM, not to this workspace, so it may hold entries written
    // under some other one. Shown, because it is in the log this workspace's acceptance names;
    // MARKED, because rendering it as though it had been written here would assert a provenance
    // the record itself contradicts.
    if (b && !b.error && !b.note && b.declaredWorkspace && b.declaredWorkspace !== S.workspace) {
      const w = el('div', 'mmeta', 'This entry\'s own wsp:workspace is ' + b.declaredWorkspace + ', not this one. It is in '
        + 'the log this workspace\'s acceptance names, so it is shown — but it was written under a different workspace record.');
      w.style.color = 'var(--pending)';
      right.appendChild(w);
    }
    msg.appendChild(right);
    wrap.appendChild(msg);
  }

  for (const st of parts) {
    if (st.error) {
      wrap.appendChild(errBox(st.error, 'This is the log on pod ' + st.pod + '. The rest of the channel is unaffected — one '
        + 'member being unreachable is not the channel being down, and it is not that member having written nothing.',
      () => { void readOnce(streamKey(st.pod, st.graph)); }));
      continue;
    }
    if (st.watchFailed) {
      const n = el('div', 'note', 'No updates for the log on ' + st.pod + ' will arrive on their own: '
        + ((st.watchFailed as Error).message) + ' What is shown was read once.');
      n.style.color = 'var(--pending)';
      wrap.appendChild(n);
    }
    if (st.loaded && !st.rows.length) {
      const roleDef = st.seat?.role && S.roles.roles ? S.roles.roles.get(st.seat.role) : null;
      // WHY the log is empty is not data, so it is not asserted: the permitted set is printed
      // and the reader can see it.
      wrap.appendChild(el('div', 'note', st.isYou
        ? 'You have not written to this workspace yet. Your log will be created on your own pod by your first post.'
        : roleDef
          ? 'The member on ' + st.pod + ' has written nothing to this workspace yet. Their role permits: '
            + (roleDef.permits.map((c) => S.roles.caps?.get(c)?.label ?? c.split('#').pop()).join(', ') || 'nothing this profile names') + '.'
          : 'The member on ' + st.pod + ' has written nothing to this workspace yet. This client could not read their role, so it cannot say whether that is a choice or a ceiling.'));
    }
    if (st.stale) {
      const n = el('div', 'note', 'Showing the last good read of the log on ' + st.pod + '; the most recent refresh failed ('
        + errorCopy(st.stale).t.toLowerCase() + ').');
      n.style.color = 'var(--pending)';
      wrap.appendChild(n);
    }
  }
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

// ── post ─────────────────────────────────────────────────────────────────────

async function post(): Promise<void> {
  if (!S.client || !S.viewer || !S.workspace) return;
  const ta = area('composer');
  const body = ta.value.trim();
  if (!body) return;
  const send = btn('send');
  send.disabled = true;
  ta.disabled = true;                     // locked, not emptied, until it is confirmed readable
  const seat = S.seats.find((m) => m.seated && m.pod === S.viewer?.podName && m.stream);
  const streamIri = seat?.stream ?? S.streamIri;
  if (!streamIri) { say('postresult', 'refused', 'No log to write to', 'This client could not resolve which document your entries go in.'); send.disabled = false; ta.disabled = false; return; }
  const key = streamKey(S.viewer.podName, streamIri);
  if (!S.streams.has(key)) {
    S.streams.set(key, { pod: S.viewer.podName, graph: streamIri, isYou: true, seat: seat ?? null, rows: [], error: null, loaded: false, stale: null, watchFailed: null });
  }
  say('postresult', 'pending', 'Deriving your position in your own log…',
    'Reading the current head of ' + streamIri.replace(/^https:\/\//, '') + ' so this entry can declare the one before it.');

  const out = await postEntry(S.client, {
    podName: S.viewer.podName, streamIri, workspace: S.workspace, body,
    entryShape: S.record?.entryShape ?? null,
    onAttempt: (n) => {
      if (n > 1) say('postresult', 'pending', 'Someone appended while you were typing — re-deriving',
        '412 precondition_failed. Re-reading the head and trying once more, which is the right move for a log.');
    },
  });
  // Every early return re-enables the composer to whatever the delegation check decided, never
  // to plain `false`: a viewer whose scope forbids writing must not be handed it back.
  const reopen = (): void => { send.disabled = !!S.writeBlocked; ta.disabled = !!S.writeBlocked; };

  if (out.kind === 'read-failed') {
    clear($('postresult')).appendChild(errBox(out.error, 'Your own log could not be read, so no position could be derived. Nothing was written.'));
    reopen(); return;
  }
  if (out.kind === 'forked') {
    say('postresult', 'refused', 'Your log has ' + out.heads + ' entries that nothing supersedes', out.anyLinks
      ? 'Some entries here do declare supersession and these still do not resolve to one head, which is what a missed '
        + 'compare-and-swap looks like. Picking one would be guessing which append survived, so this posts nothing.'
      : 'No entry in this manifest reported a supersedes link at all, so every row reads as a head. That may be a genuine '
        + 'fork, or supersession may not have been reported for this read. This will not guess which, so it posts nothing.');
    reopen(); return;
  }
  if (out.kind === 'unreachable') {
    clear($('postresult')).appendChild(errBox(out.error, out.relayAnswered
      ? 'The relay answered and reported this failure, so nothing here is a guess about whether it ran. Re-read the channel before posting again.'
      : 'The relay did not answer, so whether this write ran is UNKNOWN. A write whose outcome is unknown must not be repeated automatically — re-read the channel before posting again.'));
    reopen(); return;
  }
  if (out.kind === 'refused') { refusalPanel('postresult', out.body, 'Your entry'); reopen(); return; }

  const p = say('postresult', 'ok', out.committed ? 'Posted to your pod' : 'Accepted — landing on your pod');
  p.appendChild(kvPair([
    ['pod', S.viewer.podName],
    ['wsp:seq', String(out.seq)],
    ['descriptor', out.descriptorUrl ?? 'not reported by the response'],
    ['shape asserted', entryShapeAnswer(out.shapeSent, S.recordResult, S.workspace)],
    // ABSENCE IS NOT EVIDENCE. What was SENT is on the outcome, so the two are reported
    // separately: what this client asserted, and what came back about it.
    ['precondition', preconditionLine(out.response['precondition'], out.ifMatch, out.ifMatchKind)
      ?? 'none sent — this read found no prior entry in your log to assert against'],
    ['authorship', (() => {
      const a = out.response['authorship'] as { signed?: boolean; signer?: string; reason?: string } | undefined;
      return a ? (a.signed ? 'signed by ' + (a.signer ?? 'an unnamed signer') : 'not signed — ' + (a.reason ?? 'the response gave no reason'))
        : 'sign_authorship was requested; the response did not report an authorship block';
    })()],
  ]));

  // ★ CONFIRM IT IS READABLE BACK RATHER THAN TAKING THE ACKNOWLEDGEMENT FOR IT.
  if (!out.descriptorUrl) {
    p.className = 'panel pending';
    (p.querySelector('h4') as HTMLElement).textContent = 'Accepted, with no descriptor to check';
    p.appendChild(el('div', 'note', 'The response named no descriptor URL, so there is nothing to read back and confirm. Your text is still in the composer.'));
    reopen(); return;
  }
  p.appendChild(el('div', 'note', 'Confirming it is readable back rather than taking the acknowledgement for it.'));
  let landed = false;
  let readErr: unknown = null;
  for (let i = 0; i < 34 && !landed; i++) {
    await new Promise((r) => { setTimeout(r, 700); });
    const got = await readOnce(key);
    if (got.rows?.some((r) => r.url === out.descriptorUrl)) { landed = true; break; }
    if (got.error) readErr = got.error;
  }
  if (landed) { ta.value = ''; }
  else {
    p.className = 'panel pending';
    (p.querySelector('h4') as HTMLElement).textContent = 'Accepted, but not yet readable';
    p.appendChild(el('div', 'note', readErr
      ? 'The readback itself kept failing (' + errorCopy(readErr).t.toLowerCase() + '), so whether it landed is unknown from here. Your text is still in the composer.'
      : 'The relay took the write and it has not appeared in your log within the wait. It is probably fine; this will not call it posted on that basis. Your text is still in the composer — posting again would append a second entry.'));
  }
  reopen();
}

// ── canvas ───────────────────────────────────────────────────────────────────

function renderCanvasShell(): void {
  clear($('canvas-where')).appendChild(document.createTextNode(
    'On your pod ' + (S.viewer?.podName ?? '—') + ' — the only storage your credentials can write. '
    + 'A workspace canvas on the convener\'s pod behaves identically; you would need a delegation there to save to it.'));
  $('canvas-note').textContent = 'There is no canvas object on a server. This is one graph IRI on your pod with a '
    + 'supersession chain behind it, and what makes it a shared document is the precondition, not a special type. A save '
    + 'against an existing revision sends if_match — here that is the content CID the head read returned. This panel does '
    + 'not say "Saved" until it has read the head back and matched it to the descriptor that save returned. The red control '
    + 're-sends the revision this panel FIRST LOADED, which is what a client that holds a revision id and never asserts it '
    + 'would send — an interface can show you a revision, take your edit, and write it with no reference to the revision it showed you.';
}

function renderRev(override?: string): void {
  const r = clear($('rev'));
  const a = el('span');
  a.appendChild(document.createTextNode('Revision '));
  a.appendChild(el('b', undefined, override ?? shortCid(S.canvas.head)));
  r.appendChild(a);
  if (!override) {
    const current = S.canvas.loaded === S.canvas.head;
    const b = el('span', undefined, current ? 'panel is current' : 'panel holds ' + shortCid(S.canvas.loaded));
    b.style.color = current ? 'var(--faint)' : 'var(--pending)';
    r.appendChild(b);
  }
}

function armStale(): void {
  const noHead = !S.canvas.head;
  const same = noHead || S.canvas.loaded === S.canvas.head;
  const b = btn('stalesave');
  b.disabled = same || !!S.writeBlocked;
  b.title = noHead ? 'No revision has been resolved for this document, so there is none to be stale about.'
    : same ? 'The revision this panel loaded is currently the head, so re-sending it would not be stale. Save once, then this refuses.'
      : 'Re-sends ' + shortCid(S.canvas.loaded) + ' — the revision this panel first loaded — as if_match, which the head has since moved past.';
}

/** `adopt` — whether the served text replaces what is in the editor. False after a save. */
async function loadCanvas(adopt: boolean): Promise<void> {
  if (!S.client || !S.viewer || !S.canvas.iri) return;
  const save = btn('save');
  let read: CanvasRead;
  try { read = await readCanvas(S.client, S.canvas.iri, S.viewer.podName); }
  catch (e) {
    save.disabled = true; btn('stalesave').disabled = true;
    clear($('canvasresult')).appendChild(errBox(e, 'The canvas could not be read from your pod, so no write is offered against it.', () => { void loadCanvas(adopt); }));
    return;
  }
  if (read.kind === 'forked') {
    S.canvas.head = null;
    renderRev(read.heads.length + ' unresolved heads');
    say('canvasresult', 'refused', 'This document forked', read.message);
    save.disabled = true; btn('stalesave').disabled = true;
    return;
  }
  // ★ "NOTHING IS HERE" AND "THIS READ DID NOT RESOLVE" ARE DIFFERENT, and only the first
  // licenses offering to create. Creating on the second would overwrite whatever is actually at
  // this IRI without asserting anything about it.
  if (read.kind === 'unresolved') {
    S.canvas.exists = false; S.canvas.head = null;
    renderRev('not resolved');
    save.disabled = true;
    save.title = 'Disabled: ' + read.message + ' Creating here would overwrite whatever is actually at this IRI without asserting anything about it.';
    btn('stalesave').disabled = true;
    area('canvas').placeholder = 'The read that would locate this document did not resolve, so no write is offered.';
    say('canvasresult', 'pending', 'The current revision could not be resolved',
      read.message + ' This panel will not offer to create or overwrite on the strength of a read it could not parse.');
    return;
  }
  if (read.kind === 'absent') {
    S.canvas.exists = false; S.canvas.head = null;
    renderRev('none yet — Create makes the first one');
    area('canvas').placeholder = 'Nothing here yet. Type, then press Create — that publishes this text to your pod as a public graph anyone can read.';
    save.textContent = 'Create on your pod';
    save.disabled = !!S.writeBlocked;
    save.title = 'The relay reports: ' + read.message + ' Pressing this publishes a new public graph at ' + S.canvas.iri + ' on your pod.';
    btn('stalesave').disabled = true;
    btn('stalesave').title = 'Available once there is a revision to be stale about.';
    return;
  }
  if (read.kind === 'head-unreadable') {
    S.canvas.exists = true; S.canvas.head = null;
    renderRev('head present, body unreadable');
    save.disabled = true;
    save.title = 'Disabled: the current head at ' + read.url + ' reported ' + read.headError + ', so there is no CID to assert against and a save would be unconditional.';
    btn('stalesave').disabled = true;
    say('canvasresult', 'refused', 'The current head could not be read',
      read.headError + ' Saving would have to go without a precondition, which is the defect this panel exists to demonstrate — so it is not offered.');
    return;
  }
  if (read.kind === 'no-region') {
    S.canvas.exists = true; S.canvas.head = read.cid;
    save.disabled = true;
    save.title = 'Disabled: the signed region of the current revision could not be located.';
    say('canvasresult', 'refused', 'The signed region of this revision could not be located',
      'The descriptor was fetched, but the payload block for ' + S.canvas.iri + ' was not found inside it. Nothing was read '
      + 'from bytes anybody signed, so the editor is not filled and no save is offered.');
    renderRev();
    return;
  }
  S.canvas.exists = true;
  S.canvas.head = read.cid;
  if (!S.canvas.loaded) S.canvas.loaded = read.cid;
  if (adopt) area('canvas').value = read.text ?? '';
  if (adopt && read.text === null) {
    say('canvasresult', 'pending', 'This revision carries no description',
      'The signed region was read and contains no dct:description, so the editor is empty because the record is — not because the read failed.');
  }
  save.textContent = 'Save';
  save.disabled = !!S.writeBlocked;
  save.title = 'Sends if_match ' + shortCid(S.canvas.head) + ' — the revision this panel currently holds.';
  armStale();
  renderRev();
}

async function doSave(useStale: boolean): Promise<void> {
  if (!S.client || !S.viewer || !S.canvas.iri || !S.workspace || !S.slug) return;
  const b = useStale ? btn('stalesave') : btn('save');
  b.disabled = true;
  const ifMatch = useStale ? S.canvas.loaded : S.canvas.head;
  const out = await saveCanvas(S.client, {
    canvasIri: S.canvas.iri, podName: S.viewer.podName, workspace: S.workspace, slug: S.slug,
    body: area('canvas').value, ifMatch, previousCid: S.canvas.head,
  });
  const reopen = (): void => { b.disabled = !!S.writeBlocked; };
  if (out.kind === 'error') {
    clear($('canvasresult')).appendChild(errBox(out.error, out.relayAnswered
      ? 'The relay answered and reported this failure — the message above is its own. Re-read the document before saving again.'
      : 'The relay did not answer, so whether this save landed is unknown. Re-read the document before saving again.'));
    reopen(); return;
  }
  if (out.kind === 'stale') {
    const p = say('canvasresult', 'refused', 'Refused — 412 precondition_failed',
      'The relay would not overwrite a revision you had not seen. Nothing was written.');
    p.appendChild(kvPair([
      ['expected.cid', out.detail.expectedCid ?? 'not reported', 'was'],
      ['currentHead.cid', out.detail.currentHeadCid ?? 'not reported', 'is'],
      ['currentHead.descriptor', out.detail.currentHeadDescriptor ?? 'not reported'],
    ]));
    if (out.detail.message) p.appendChild(el('div', 'note', out.detail.message));
    const hint = el('div', 'note');
    hint.appendChild(el('b', undefined, 'retryHint: '));
    hint.appendChild(document.createTextNode(out.detail.retryHint ?? 'the response carried none'));
    p.appendChild(hint);
    const row = el('div', 'row');
    const mf = el('button', 'primary sm', 'Merge forward') as HTMLButtonElement;
    mf.title = 'Follows the retryHint exactly: get_current_head { urn, pod_name }, then resend with the returned cid.';
    mf.addEventListener('click', () => { void doMerge(); });
    const disc = el('button', 'sm', 'Discard mine, reload theirs') as HTMLButtonElement;
    disc.addEventListener('click', () => { S.canvas.loaded = null; clear($('canvasresult')); void loadCanvas(true); });
    row.appendChild(mf); row.appendChild(disc);
    p.appendChild(row);
    reopen(); return;
  }
  if (out.kind === 'refused') { refusalPanel('canvasresult', out.body, 'This revision'); reopen(); return; }

  S.canvas.exists = true;
  const p = say('canvasresult', 'pending', 'Accepted — confirming it became the head');
  p.appendChild(kvPair([
    ['graph', S.canvas.iri],
    ['descriptor', out.descriptorUrl ?? 'not reported by the response'],
    ['status', out.status ?? 'not reported'],
    ['precondition', preconditionLine(out.precondition, out.ifMatch, 'the revision this panel held')
      ?? 'none sent — this panel holds no revision for this graph to assert against'],
    ['supersedes', out.supersededCount === null ? 'not reported by the response' : out.supersededCount + ' prior revision(s)'],
  ]));
  const h4 = p.querySelector('h4') as HTMLElement;
  const keep = S.canvas.loaded;
  // ★ "SAVED" ONLY WHEN THE HEAD IS *YOURS*. A concurrent writer satisfies "the head moved".
  if (out.settled.kind === 'mine') {
    p.className = 'panel ok';
    h4.textContent = 'Saved — your revision is the head';
    p.appendChild(el('div', 'note', 'Confirmed by reading the head back and matching its descriptor to the one this save returned.'));
  } else if (out.settled.kind === 'forked') {
    p.className = 'panel refused';
    h4.textContent = 'The chain forked while this was landing';
    p.appendChild(el('div', 'note', out.settled.message));
  } else if (out.settled.kind === 'moved-elsewhere') {
    p.className = 'panel refused';
    h4.textContent = 'The head moved, but not to your write';
    p.appendChild(el('div', 'note', 'The current head is ' + shortCid(out.settled.cid) + ' at ' + out.settled.url
      + ', which is not the descriptor this save returned. Somebody else\'s revision is sitting where yours was meant to go — '
      + 'this is precisely the case a panel that only watched for "the CID changed" would have reported as Saved.'));
  } else if (!out.descriptorUrl) {
    h4.textContent = out.settled.kind === 'changed' ? 'Something became the head; whether it is yours is unknown' : 'Accepted, and the head did not move within the wait';
    p.appendChild(el('div', 'note', 'The response named no descriptor URL for this write, so there is nothing to match the head against. This panel will not call that saved.'));
  } else {
    h4.textContent = 'Accepted, but not yet readable';
    p.appendChild(el('div', 'note', 'The relay took the write and it has not become the readable head within the wait. It may still land; this panel will not call it saved on that basis.'));
  }
  await loadCanvas(false);
  if (keep) S.canvas.loaded = keep;
  armStale();
  renderRev();
  reopen();
}

async function doMerge(): Promise<void> {
  if (!S.client || !S.viewer || !S.canvas.iri || !S.workspace || !S.slug) return;
  say('canvasresult', 'pending', 'Following the retryHint', 'get_current_head { urn, pod_name } — one read, then a resend with the cid it returns.');
  const out = await mergeForward(S.client, {
    canvasIri: S.canvas.iri, podName: S.viewer.podName, workspace: S.workspace, slug: S.slug,
    body: area('canvas').value,
  });
  if (out.kind === 'no-head') { say('canvasresult', 'refused', 'No single head to merge onto', out.why); return; }
  S.canvas.head = out.onto;
  S.canvas.loaded = out.onto;
  renderRev();
  // The resend already happened inside the module; report it through the same panel path so the
  // two saves cannot describe themselves differently.
  const p = say('canvasresult', 'pending', 'Merged forward onto ' + shortCid(out.onto));
  const s = out.save;
  if (s.kind === 'accepted' && s.settled.kind === 'mine') {
    p.className = 'panel ok';
    (p.querySelector('h4') as HTMLElement).textContent = 'Saved — merged onto ' + shortCid(out.onto) + ' and your revision is the head';
  } else if (s.kind === 'stale') {
    p.className = 'panel refused';
    (p.querySelector('h4') as HTMLElement).textContent = 'Refused again — the head moved while merging';
    p.appendChild(el('div', 'note', s.detail.message ?? 'Something appended between the head read and the resend.'));
  } else {
    p.className = 'panel pending';
    p.appendChild(el('div', 'note', 'The resend ended as "' + s.kind + '"'
      + (s.kind === 'accepted' ? ' with the head settling as "' + s.settled.kind + '"' : '') + '.'));
  }
  await loadCanvas(false);
  armStale();
  renderRev();
}

// ── wiring ───────────────────────────────────────────────────────────────────

btn('signin-wallet').addEventListener('click', () => { void signIn('wallet'); });
btn('signin-browser').addEventListener('click', () => { void signIn('browser'); });
btn('lobbybtn').addEventListener('click', () => { showLobby(!S.lobbyOpen); });
btn('renewbtn').addEventListener('click', () => {
  btn('renewbtn').disabled = true;
  void window.interego.renewSession().then((r) => { btn('renewbtn').disabled = false; renderSession(r.session); });
});
btn('openbtn').addEventListener('click', () => { void openWorkspace(inp('wsopen').value.trim()); });
inp('wsopen').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void openWorkspace(inp('wsopen').value.trim()); });
btn('createbtn').addEventListener('click', () => { void create(); });
inp('wsslug').addEventListener('input', renderSlugHint);
inp('wstitleIn').addEventListener('input', renderSlugHint);
btn('sendinvite').addEventListener('click', () => { void invite(); });
inp('invitee').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !btn('sendinvite').disabled) void invite(); });
btn('send').addEventListener('click', () => { void post(); });
area('composer').addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (!btn('send').disabled) void post(); }
});
btn('save').addEventListener('click', () => { void doSave(false); });
btn('stalesave').addEventListener('click', () => { void doSave(true); });
window.addEventListener('beforeunload', () => { S.watches.forEach((u) => { try { u(); } catch { /* already gone */ } }); });

// A bare `describe()` left any throw as an unhandled rejection with a sign-in card on screen
// forever — a client reporting a permanent benign state for a crash.
void describe().catch((e: unknown) => {
  clear($('signinnote')).appendChild(errBox(e, 'This client failed while starting up, so nothing below was read.'));
});
