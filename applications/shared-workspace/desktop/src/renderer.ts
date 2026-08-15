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
  ConnectorTransport, WorkspaceClient, acceptGrant, admitSeatedIn, agentInbox, agentPort, assignPodMarks,
  authorshipLine, briefPrompt,
  checkDraft, checkOwnHandle, checkRoleForWorkspace, checkWriteEligibility, createWorkspace,
  decideTurn, delegatePlan, describeSpan, entryShapeAnswer, errorCopy, footingLine,
  PRESENCE_RENEW_MS, publishCapability, publishPresence, readRequests, verifyRequest,
  RESPOND_AS_MEMBER, type RequestVerdict,
  readDelegates, readEntryAuthorship, REQUIRED_TOOLS,
  foldRoster, graphRegion, grantPodFor, hasType, listWorkspaces, mergeForward, nsIri, orderChain,
  parseRoleProfile, parseWorkspaceIri, podClaimVsServed, podOfDescriptorUrl, pollingWatch, postEntry, verifiedSigner,
  preconditionLine, publishDelegation, readCanvas, readInbox, readInt, readIri, readIriAll, readLiteral,
  readPresence, readViewer, revokeDelegation, revokeGrant,
  agentPodOf, notifyAsk, presenceLine, type Presence,
  roleKnown, roleName, roleWhy, saveCanvas, sendInvite, shortRef, slugProblem, verifyInvitation,
  verifyWorkspaceEntry,
  delegatePort,
  type CanvasRead, type ChainRow, type Check, type ConnectorMcp, type DelegateRoster, type DelegateRow,
  type EntryAuthorship, type GrantVerdict, type Invitation, type RoleTable, type Seat,
  type EntryFooting, type StatedFooting,
  type SeenEntry, type SpeakingDelegate, type Viewer, type WithheldAcceptance,
  type WorkspaceEntry, type WorkspaceRecord,
} from '@interego/workspace-client';
/**
 * ★ THE DISCORD LINK FORM COMES FROM THE DISCORD CONDUIT, NOT FROM THE SHARED CLIENT.
 *
 * `discordLinkPlan` and its snowflake check used to be exported by `@interego/workspace-client` —
 * a Discord regex inside the package that every surface of this vertical bundles, including a
 * published artifact that has no Discord feature at all. This shell is the only thing that draws
 * the link form, so it takes the dependency itself, on the package that owns the conduit. The bot
 * and this form still compute `challengeLabel` from ONE definition, which is the property that
 * matters: two spellings of that string would refuse every honest link.
 */
import { discordLinkPlan } from '@interego/workspace-discord/src/link-plan.js';
/**
 * ★ THE SAME PARSER THE MAIN PROCESS RUNS, AND FOR A DIFFERENT REASON IN EACH PLACE.
 *
 * Here it means a mistyped key is named for what is wrong with it — a pasted ADDRESS, a copy that
 * wrapped, 64 hex digits that are not a valid scalar — without the key leaving this window at all.
 * There it is the guard, because the renderer is the half that renders bytes other people wrote.
 * One function so the two answers cannot differ.
 */
import { checkPrivateKey } from './privatekey.js';
import type { AccountKeyInfo, BridgeFailure, HostedDelegateInfo, ProviderInfo, SessionInfo, WorkspaceBridge } from './preload.js';

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
/**
 * The read-back evidence behind a delegation outcome, as marks a viewer can see.
 *
 * ★ THE SHELL DRAWS THE EVIDENCE; THE SUBSTRATE ESTABLISHES IT. `publishDelegation` decides
 * whether the row is on the pod — this only says so on screen. It reads `roster`/`listed` rather
 * than restating `why`, so a viewer sees the two separate facts (the pod answered at all; it
 * lists this agent at this scope) instead of one sentence that could be true for either reason.
 * `q` rather than `n` when the registry could not be read: a pod that did not answer has not
 * denied anything.
 */
function delegationChecks(out: { roster: DelegateRoster | null; listed: DelegateRow | null }): readonly Check[] {
  const checks: Check[] = [];
  if (!out.roster) return checks;
  checks.push(out.roster.read
    ? { mark: 'y', text: 'Pod ' + out.roster.podName + '\'s delegation registry answered' }
    : { mark: 'q', text: 'Pod ' + out.roster.podName + '\'s delegation registry could not be read', ...(out.roster.why ? { detail: out.roster.why } : {}) });
  if (out.listed) {
    checks.push({ mark: 'y', text: 'It lists ' + out.listed.agentId + ' with scope ' + out.listed.scope, detail: out.listed.label ?? '' });
    checks.push(out.listed.writeEligible
      ? { mark: 'y', text: 'That scope may publish' }
      : { mark: 'n', text: 'That scope cannot publish' });
  } else if (out.roster.read) {
    checks.push({ mark: 'n', text: 'It does not list this agent' });
  }
  return checks;
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
      /**
       * The bridge is already connected to exactly one relay, so there is one server and the
       * probe is a live call rather than a directory lookup.
       *
       * ★ THE PROBE IS THE CHEAPEST CALL THAT PROVES THE POINT, NOT THE MOST DESCRIPTIVE ONE.
       * This asked `get_pod_status`, which MEASURED 56,450,477 bytes on a real pod — the app
       * downloaded 56 MB to establish that it was connected and discarded the response unread.
       * Any successful call proves reachability equally well.
       *
       * `read_inbox` is the replacement rather than something cheaper still, because a probe has
       * a second job: it is the grant check, so it must be one of `REQUIRED_TOOLS`. Of those,
       * only it and `get_pod_status` take no arguments, and it is 2,507 bytes against 1.2 MB on
       * the same pod. It is a read — the relay gates it for identity binding, not mutation — so
       * probing costs nothing and consumes nothing.
       */
      const r = await window.interego.call('read_inbox', {});
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
  /**
   * Who composed it, read out of the same signed region as the body.
   *
   * ★ NOT DERIVED FROM THE POD. The pod says whose LOG this is; the entry says who WROTE it, and
   * those are different the moment a delegate writes. A shell that labelled every entry with its
   * pod's owner would be asserting the thing this whole change exists to stop asserting.
   */
  readonly author: EntryAuthorship;
  /**
   * The record this one declares it was derived FROM, if any.
   *
   * ★ THE DURABLE HALF OF "HAVE I ALREADY ANSWERED THIS". The in-run set is lost on restart, so
   * without this an agent restarted after answering would read the same ask, judge it unanswered
   * and answer it again — a second permanent record saying the same thing, on somebody's public
   * log. This is on the pod and survives, which is exactly why the substrate's verifier takes it as
   * a separate argument from the in-run list and names it as the one that survives.
   */
  readonly derivedFrom: string | null;
  /**
   * The agents this entry names as its addressees — `iep:addressedTo`, from the signed region.
   *
   * ★ READ FROM THE SIGNED BYTES AND NOWHERE ELSE, which is the only reason it is worth anything.
   * The predicate decides which delegate a request belongs to; taken from anywhere the relaying
   * party could edit, it would let whoever carried the message re-address it in flight.
   */
  readonly addressedTo: readonly string[];
  readonly note: string | null;
  readonly error?: unknown;
}

const S = {
  relay: RELAY_FALLBACK,
  watchDescription: '',
  /**
   * Every account key this machine holds — the identities it can sign in as.
   *
   * ★ ALWAYS THE MAIN PROCESS'S ANSWER, NEVER THIS SIDE'S BOOKKEEPING. The keyring is on disk in
   * the privileged half; a renderer that maintained its own copy would eventually draw a key that
   * had been deleted, or hide one that had not.
   */
  accounts: [] as readonly AccountKeyInfo[],
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
  /**
   * Each seated member's delegates, read from THEIR OWN pod.
   *
   * ★ ONE ROSTER PER POD, BECAUSE AUTHORISATION IS PER POD. Reading the viewer's registry and
   * applying it to everybody would invent an authorization record for somebody else — the same
   * trap `delegatedScopes` in `respond.ts` records. A pod that does not answer contributes NO
   * entry here, and `readEntryAuthorship` then reports `authorised: null` for its entries, which
   * is "not checked" and not "not authorised".
   */
  delegatesByPod: new Map<string, DelegateRoster>(),
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
  /**
   * Acceptances on this pod that are NOT places to go — retired ones, and ones that could not be
   * read. Held apart from `spaces` because `spaces` is what the switcher draws Open controls on.
   */
  withheld: [] as readonly WithheldAcceptance[],
  spacesError: null as unknown,
  /** How many descriptors your pod's index held. Reported, never a cap — the read is complete. */
  spacesScanned: 0,
  lobbyOpen: true,

  // ── delegates ──────────────────────────────────────────────────────────────
  /** The viewer's own delegates, from their pod. Null = not read yet, which is not "none". */
  myDelegates: null as DelegateRoster | null,
  /** Which of them this machine holds a key for. A keyring, not a roster — see `preload.ts`. */
  hosted: [] as readonly HostedDelegateInfo[],
  hostedRead: false,
  hostedError: null as unknown,
  /**
   * The agent id of the delegate currently selected to speak, or null.
   *
   * ★ NULL IS "NOBODY SPEAKS", NOT "THE PERSON SPEAKS". `decideTurn` refuses on it for the same
   * reason. A person's delegates are plural and this is which ONE is on; the others stay
   * authorised and silent, which is a different state from being revoked.
   */
  speaking: null as string | null,
  /**
   * The agent your NEXT message will be addressed to, chosen from the roster. Null is the default
   * and means the open floor.
   *
   * ★ NOT THE SAME AXIS AS `speaking`, AND CONFUSING THE TWO IS THE WHOLE REASON THIS IS SPELLED
   * OUT. `speaking` picks which of YOUR OWN delegates is activated to compose — an author. This
   * picks WHO A MESSAGE IS FOR — an addressee, usually somebody else's agent. A person can have
   * both set, one set, or neither, and the three read differently in the record: an entry names
   * its author in `prov:wasAttributedTo` and its addressee in `iep:addressedTo`, and no reader
   * infers either from the other.
   *
   * ★ AND IT IS CLEARED AFTER EVERY POST RATHER THAN LEFT STICKY. An addressee that persisted
   * would make the message after the ask — "thanks", "one more thing" — a second request to the
   * same agent, permanently, with no visible reason.
   */
  ask: null as { agentId: string; name: string | null; pod: string; agentPod: string | null } | null,
  /** A freshly minted key, shown once and never stored here. Cleared as soon as it is dismissed. */
  mintedKey: null as { address: string; agentId: string; privateKey: string } | null,
};

// ── the boot checklist ───────────────────────────────────────────────────────
/**
 * ★ COLD START ON A FRESH IDENTITY IS A FEW SECONDS TO ABOUT HALF A MINUTE, because the first
 * pod-aware call PROVISIONS A POD. A spinner for thirty seconds reads as broken, so this counts
 * up and says which step it is on.
 *
 * ★ AND THE RANGE IS WIDE, WHICH IS THE PART THE COPY HAS TO CARRY. This said "12–16 s" and the
 * on-screen string said "12 to 17 seconds", both from a handful of measurements taken on one
 * afternoon. Two brand-new wallets signed in minutes apart on 2026-08-08 took **2.5 s** and
 * **30.7 s** — an order of magnitude apart, same fleet, same code path. Earlier recorded runs:
 * 16.7 s for a brand-new wallet and 1.8 s for one whose pod already existed; 12.3 s and 16.2 s
 * from the published artifact against the same fleet; 30.0 s for the packaged app's first run.
 *
 * A narrow range is worse than no range here. Somebody told "12 to 17 seconds" who then waits
 * thirty concludes it has hung and kills it — during pod provisioning, which is the one moment
 * where that costs them something. So the number quoted to the user is the SLOW end.
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

  /**
   * ★★ "PRIVATE" IS ONLY OFFERED WHEN THIS SESSION COULD READ ONE BACK.
   *
   * A browser sign-in holds no key on this machine. A private workspace created under it would
   * still publish — sealed to whatever keys the pod's registry carries, which without a member key
   * is the relay's own — so the person would end up with a workspace THEY cannot read and the
   * relay can. It returns 200 and looks like it worked. Disabling the control is the only place
   * that fact can be told before it is true.
   */
  const priv = document.getElementById('wsvis-private') as HTMLInputElement | null;
  const pub = document.getElementById('wsvis-public') as HTMLInputElement | null;
  if (priv && pub) {
    priv.disabled = !s.sealedReads;
    // A control that was already ticked before the session changed must not silently stay ticked
    // while disabled — the form would still read `private` from a box nobody can see is active.
    if (!s.sealedReads && priv.checked) { priv.checked = false; pub.checked = true; }
    const hint = document.getElementById('wsvishint');
    if (hint) {
      hint.textContent = s.sealedReads
        ? 'Private hides the words, not the fact: the roster, the timestamps and who wrote when stay '
          + 'readable. It cannot be changed later.'
        : 'Private needs a key on this machine, and this session signed in through the browser, which '
          + 'holds none. A private workspace created now would be sealed to the relay rather than to '
          + 'you. Sign in with a wallet key to make it available.';
    }
  }
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
  S.accounts = d.accounts ?? [];
  renderAccounts();
  renderSession(d.session);
  window.interego.onSessionChanged(renderSession);
}

/**
 * EVERY ACCOUNT KEY THIS MACHINE HOLDS, DRAWN BEFORE ANY SIGN-IN.
 *
 * ★ THE LIST IS THE ANSWER TO "WHAT HAPPENED TO MY OTHER KEY". Because slots are named after the
 * address of the key inside them, importing never replaces anything — so the honest way to say
 * that is to show the keys that are still there, rather than to promise it in a sentence.
 *
 * ★ AND A POD IS ONLY NAMED WHERE THE RELAY NAMED IT. `u-eth-<first 12 hex of the address>` is what
 * the relay does today; a client that computed it would address a pod that does not exist the day
 * that changes, and a wrong pod name reads back as an EMPTY LOG rather than as an error.
 */
function renderAccounts(): void {
  const box = clear($('signin-accounts'));
  if (!S.accounts.length) return;
  box.appendChild(el('h4', undefined, S.accounts.length === 1
    ? 'This machine holds one account key'
    : 'This machine holds ' + S.accounts.length + ' account keys'));
  box.appendChild(el('div', 'note', 'Signing in with a key you paste does not replace these. Each key is stored under its own '
    + 'address, so the only way one leaves this machine is if you delete it below — and a private key is the whole of an '
    + 'identity, with nothing anywhere that can bring it back.'));
  for (const a of S.accounts) {
    const row = el('div', 'panel' + (a.unreadable ? ' refused' : a.active ? ' ok' : ''));
    row.appendChild(el('div', 'iri', a.address));
    row.appendChild(el('div', 'note', a.unreadable
      ? 'This key is on disk here and could not be read back: ' + a.unreadable
      : a.pod
        ? 'The relay answered ' + a.pod + ' for this key the last time it signed in on this machine.'
        : 'Which pod this key reaches is not established here — it is whatever the relay answers when it signs in, and '
          + 'this app does not work pod names out from addresses.'));
    if (a.active) row.appendChild(el('div', 'note', 'This is the key the plain wallet button above uses.'));
    const controls = el('div', 'row');
    if (!a.unreadable) {
      const use = el('button', 'sm', a.active ? 'Sign in with this key' : 'Sign in with this one instead') as HTMLButtonElement;
      use.addEventListener('click', () => { void signInAs(a.address); });
      controls.appendChild(use);
    }
    const forget = el('button', 'danger sm', 'Delete this key from this machine') as HTMLButtonElement;
    forget.addEventListener('click', () => { void forgetAccount(a.address); });
    controls.appendChild(forget);
    row.appendChild(controls);
    box.appendChild(row);
  }
}

/** Refresh the keyring from the main process. The renderer never keeps its own idea of it. */
async function loadAccounts(): Promise<void> {
  try {
    S.accounts = (await window.interego.accountList()).accounts;
  } catch (e) {
    S.accounts = [];
    clear($('signinnote')).appendChild(errBox(e, 'Which keys this machine holds could not be read, so none are listed — that is a failed read, not an empty keyring.'));
    return;
  }
  renderAccounts();
}

/** Everything on the sign-in card that starts a ceremony, so one cannot be started twice. */
const signInButtons = (): readonly HTMLButtonElement[] => [btn('signin-wallet'), btn('signin-browser'), btn('signin-import')];

/** The one place a completed sign-in changes the window, whichever of the four paths got there. */
async function signedIn(pod: string): Promise<void> {
  $('signin').hidden = true;
  $('whoami').textContent = pod;
  btn('lobbybtn').hidden = false;
  btn('signoutbtn').hidden = false;
  await boot();
}

/** The one place a failed sign-in reports, so no path can fail silently or lock the buttons. */
function signInFailed(e: unknown, where: string): void {
  step('auth', 'Sign-in did not complete', 'err');
  clear($('signinnote')).appendChild(errBox(e, where));
  signInButtons().forEach((b) => { b.disabled = false; });
}

async function signIn(kind: 'wallet' | 'browser'): Promise<void> {
  signInButtons().forEach((b) => { b.disabled = true; });
  step('auth', kind === 'wallet'
    ? 'Signing a SIWE message with the key in your OS secret store'
    : 'Waiting for you to finish signing in, in your browser', 'wait');
  try {
    const who = kind === 'wallet' ? await window.interego.signInWithWallet() : await window.interego.signInWithBrowser();
    step('auth', 'Signed in — you are pod ' + who.pod + (kind === 'wallet' ? '' : ' (browser sign-in)'), 'done');
    if (kind === 'wallet' && 'mintedNewKey' in who && who.mintedNewKey) {
      $('signinnote').textContent = 'A new wallet key was minted and stored, so this is a brand new pod with nothing on it yet. '
        + 'If you already have a pod, sign out and paste its key instead — this one is a different account, not another door to it.';
    }
    await signedIn(who.pod);
  } catch (e) {
    signInFailed(e, 'Nothing is read until a session exists — this client holds no fixtures, so with no session there is nothing to show.');
  }
}

/**
 * SIGN IN WITH A KEY THE PERSON ALREADY HAS.
 *
 * ★ THE KEY IS CHECKED HERE BEFORE IT CROSSES ANYWHERE. `checkPrivateKey` is the same function the
 * main process runs — the renderer's call is a courtesy that answers instantly and by name, and
 * the main process's is the guard. Refusing here also means a mistyped key never leaves this
 * window at all.
 *
 * ★ AND THE FIELD IS EMPTIED THE INSTANT IT IS READ. A private key sitting in an input is a
 * private key on screen, recoverable by anything that can reach the DOM and by anyone who walks
 * past. It is cleared before the sign-in is even attempted, including on the failing paths, and
 * it is never written into a message.
 */
async function importAccount(): Promise<void> {
  const field = inp('signin-importkey');
  const parsed = checkPrivateKey(field.value);
  const hint = clear($('signin-importhint'));
  if (!parsed.ok) {
    // ★ THE FIELD IS LEFT ALONE ON A REFUSAL, AND ONLY ON A REFUSAL. Nothing left this window, so
    // there is nothing on screen that was not already; and a paste that lost its last character is
    // fixed by typing the character, not by pasting the whole thing again.
    hint.className = 'hint bad';
    hint.textContent = parsed.why;
    return;
  }
  field.value = '';
  hint.className = 'hint';
  hint.textContent = '';
  signInButtons().forEach((b) => { b.disabled = true; });
  step('auth', 'Signing in as the key you pasted. If its pod does not exist yet the relay provisions one on this first call, '
    + 'which has been measured at anything from 2 to 31 seconds on this fleet — a wait here is normal and is not a hang', 'wait');
  try {
    const who = await window.interego.accountImport(parsed.key);
    step('auth', 'Signed in — you are pod ' + who.pod, 'done');
    const note = clear($('signinnote'));
    note.appendChild(el('div', undefined, who.alreadyHeld
      ? 'This machine already held that key, so nothing changed about what it holds — it is now the one being used.'
      : 'That key is now stored on this machine, encrypted by your operating system, exactly as a key this app minted would be.'));
    if (who.kept.length) {
      note.appendChild(el('div', 'note', who.kept.length === 1
        ? 'The key this machine already held (' + who.kept[0] + ') was KEPT. Nothing was overwritten: you can sign out and go '
          + 'back to it at any time.'
        : 'The ' + who.kept.length + ' keys this machine already held were KEPT. Nothing was overwritten: you can sign out and '
          + 'go back to any of them.'));
    }
    await signedIn(who.pod);
  } catch (e) {
    /**
     * ★ WHAT THE KEYRING SAYS, NOT WHAT THIS FUNCTION ASSUMES.
     *
     * The import stores before it signs in, so "the key was stored" is the usual truth — but it is
     * not always true: with no OS secret store there is nowhere to put it and the handler refuses
     * before storing anything. A fixed sentence would then tell somebody their key is safe on this
     * machine when it is nowhere. So the keyring is RE-READ and the answer comes from whether it
     * grew, which needs no address derivation and cannot be wrong.
     */
    const before = S.accounts.length;
    await loadAccounts();
    signInFailed(e, S.accounts.length > before
      ? 'The key WAS stored on this machine — it is listed on the sign-in screen and you can try it again from there. What '
        + 'did not happen is the sign-in, so nothing was read and nothing below is a statement about any pod.'
      : 'This machine\'s keyring did not change: either it already held that key, or storing it was refused for the reason '
        + 'above. What did not happen is the sign-in, so nothing was read and nothing below is a statement about any pod.');
  }
}

/** Switch to another key this machine holds. Same ceremony, different identity. */
async function signInAs(address: string): Promise<void> {
  signInButtons().forEach((b) => { b.disabled = true; });
  step('auth', 'Signing a SIWE message with the key for ' + address, 'wait');
  try {
    const who = await window.interego.accountSignInAs(address);
    step('auth', 'Signed in — you are pod ' + who.pod, 'done');
    await signedIn(who.pod);
  } catch (e) {
    signInFailed(e, 'The key is untouched and still on this machine. What failed is the sign-in.');
    await loadAccounts();
  }
}

/**
 * Delete an account key.
 *
 * ★ THE CONFIRMATION IS NOT A FORMALITY AND THE COPY DOES NOT SOFTEN IT. Forgetting a DELEGATE key
 * loses a host; the delegation row on the pod survives and another machine holding the same key is
 * still that delegate. An ACCOUNT key is the identity itself — there is no registry, no recovery
 * and no one to ask — so unless it is written down somewhere else this is a pod becoming
 * permanently unreachable.
 */
async function forgetAccount(address: string): Promise<void> {
  const a = S.accounts.find((x) => x.address === address);
  const ok = window.confirm('Delete the account key for ' + address + ' from this machine?\n\n'
    + 'This is the whole of that identity. If you do not have this key written down somewhere else, '
    + (a?.pod ? 'the pod ' + a.pod + ' becomes permanently unreachable' : 'whatever pod it reaches becomes permanently unreachable')
    + ' — by you and by anyone. There is no recovery and nobody to ask.');
  if (!ok) return;
  try {
    S.accounts = (await window.interego.accountForget(address)).accounts;
    renderAccounts();
  } catch (e) {
    clear($('signinnote')).appendChild(errBox(e, 'The key was not deleted and is still on this machine.'));
  }
}

/**
 * END THE SESSION AND COME BACK TO THE SIGN-IN CARD.
 *
 * ★ WITHOUT THIS THERE IS NO SWITCHING. Everything below the header belongs to one identity — the
 * roster, the streams, the delegate keyring in use, the watches — so signing out tears the
 * workspace down rather than leaving another person's reads on screen under a new name. The keys
 * are untouched: signing out is not forgetting.
 */
async function signOut(): Promise<void> {
  btn('signoutbtn').disabled = true;
  try {
    S.accounts = (await window.interego.signOut()).accounts;
  } catch (e) {
    btn('signoutbtn').disabled = false;
    clear($('bootnote')).appendChild(errBox(e, 'The session was not ended, so it is still live.'));
    return;
  }
  teardownWorkspace();
  S.client = null; S.viewer = null; S.spaces = null; S.spacesError = null;
  S.invites = null; S.inviteError = null; S.handleCheck = null;
  S.myDelegates = null; S.hosted = []; S.hostedRead = false; S.speaking = null;
  S.writeBlocked = null; S.enforcement = null; S.enforcementWhy = null;
  // ★ AND WHICH WORKSPACE WAS OPEN. `teardownWorkspace` deliberately leaves `S.workspace` alone —
  // it runs on every SWITCH, where the next IRI overwrites it a line later. Here there is no next
  // one, and a stale value would keep the header's title and make the lobby dismissible back to a
  // channel belonging to an identity that is no longer signed in.
  S.workspace = null; S.iriOwner = null; S.slug = null;
  steps.length = 0;
  renderSteps();
  // Not `showLobby`: with no workspace it forces the lobby OPEN, which is right after a sign-in
  // and wrong here. Signing out leaves the sign-in card and nothing else.
  $('lobby').hidden = true;
  $('shell').hidden = true;
  S.lobbyOpen = false;
  $('wstitle').textContent = '';
  $('whoami').textContent = '';
  btn('lobbybtn').hidden = true;
  btn('signoutbtn').hidden = true;
  btn('signoutbtn').disabled = false;
  clear($('signinnote'));
  $('signin').hidden = false;
  signInButtons().forEach((b) => { b.disabled = false; });
  renderAccounts();
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  teardownWorkspace();
  S.handleCheck = null; S.invites = null; S.inviteError = null;
  S.spaces = null; S.spacesError = null; S.writeBlocked = null;
  step('connect', 'Resolving the tool surface — the first pod-aware call provisions a pod. Measured between 2 and 31 seconds on this fleet, so half a minute here is normal and not a hang', 'wait');
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
  // Not awaited: what this machine can run an agent on is a local question with no bearing on
  // reading the fleet, and a slow CLI probe must not hold up the boot behind it.
  void loadProviders();
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
  // Unawaited for the same reason: the delegates card says "reading…" until it lands, which is a
  // true sentence, and a boot held behind an optional read is a boot that looks broken.
  void loadDelegates();

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
  for (const id of ['send', 'agentsend', 'save', 'stalesave', 'createbtn', 'sendinvite']) {
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
    S.spacesError = e; S.spaces = null; S.withheld = [];
    step('spaces', 'Your own pod\'s manifest could not be read', 'err');
    renderLobby();
    return;
  }
  S.spaces = list.entries.slice();
  S.withheld = list.withheld;
  S.spacesScanned = list.scanned;
  S.spacesError = null;
  const retired = S.withheld.filter((w) => w.kind === 'retired').length;
  const unread = S.withheld.length - retired;
  // The withheld count is on the STEP as well as in the card, because the step line is the
  // running account of what boot did and "twenty acceptances were read and eighteen of them are
  // retired" is part of that account — not a detail to be discovered later.
  const aside = S.withheld.length
    ? ' · ' + (retired ? retired + ' retired' : '') + (retired && unread ? ', ' : '')
      + (unread ? unread + ' could not be read' : '') + ' and not offered'
    : '';
  step('spaces', 'Found ' + list.entries.length + ' acceptance' + (list.entries.length === 1 ? '' : 's')
    + ' on your pod that name a workspace' + aside + ' — checking each against its convener\'s pod', 'wait');
  renderLobby();
  let verified = 0;
  for (const c of S.spaces) {
    await verifyWorkspaceEntry(S.client, S.relay, S.viewer, c);
    if (c.verified) verified++;
    renderLobby();
  }
  step('spaces', list.entries.length
    ? verified + ' of ' + list.entries.length + ' acceptance' + (list.entries.length === 1 ? '' : 's')
      + ' on your pod verified against the convener\'s pod' + aside
    : 'No acceptance on your pod names a workspace you are in' + aside, 'done');
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

/**
 * The acceptances that are NOT places to go: a count, and the whole of the detail one click away.
 *
 * ★ WHY A DISCLOSURE AND NOT A ROW. Every sentence here is worth keeping — a real membership that
 * fails to parse is a defect, and a record you retired is still a record you published. What made
 * the old rendering useless was not the sentences, it was that they sat in the list of things you
 * could open: measured on the maintainer's pod, twenty retired test memberships buried the one
 * live workspace. A count states the fact at a glance, the disclosure holds the evidence, and
 * neither of them offers an Open control — because none of these is somewhere to go.
 *
 * ★ AND THE TWO KINDS ARE DRAWN APART. "Its author withdrew it" and "this could not be read" are
 * different facts about different worlds; one is somebody's decision and the other is a fault.
 */
function withheldPanel(rows: readonly WithheldAcceptance[]): HTMLElement {
  const retired = rows.filter((w) => w.kind === 'retired');
  const unread = rows.filter((w) => w.kind === 'unreadable');
  const d = el('details', 'withheld');
  const sum = el('summary', undefined,
    rows.length + ' acceptance' + (rows.length === 1 ? '' : 's') + ' on your pod ' + (rows.length === 1 ? 'is' : 'are')
    + ' not offered above — ' + [
      retired.length ? retired.length + ' retired by you' : '',
      unread.length ? unread.length + ' this client could not read' : '',
    ].filter(Boolean).join(', '));
  d.appendChild(sum);
  const group = (kind: string, list: readonly WithheldAcceptance[], head: string): void => {
    if (!list.length) return;
    d.appendChild(el('div', 'note ' + kind, head));
    for (const w of list) {
      const row = el('div', 'item ' + kind);
      row.appendChild(el('div', 'iri', w.acceptanceIri));
      if (w.workspace) row.appendChild(el('div', 'iri', 'for workspace ' + w.workspace));
      row.appendChild(el('div', 'note', w.why));
      d.appendChild(row);
    }
  };
  group('retired', retired, 'Retired. Each of these states iep:modalStatus "Retracted" in its own '
    + 'signed region — read out of the document, not guessed from what is missing. The record is still on your pod; '
    + 'what it says is that the membership it recorded is over.');
  group('bad', unread, 'Not read. Which workspace these are for was not established — the descriptor did not fetch, '
    + 'its signed region was not found, or it names no wsp:workspace. This is NOT being reported as a retraction: a '
    + 'truncated read and a tombstone look identical from outside, and only the record\'s own iep:modalStatus tells '
    + 'them apart. If one of these is a workspace you are really in, that is a fault worth reporting.');
  return d;
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
    // ★ NO LONGER TWO SENTENCES. One of them said "an older acceptance may lie past the end of
    // it" — a real possibility while this read asked for a capped window. It asks for the whole
    // index now, so the count is what that pod holds rather than what fitted.
    $('wsnote').textContent = 'Read from your own pod in one call — all ' + S.spacesScanned
      + ' descriptors it lists, not a window into them. A workspace-qualified acceptance name carries the workspace '
      + 'inside it, so most of these needed no further read.';
    if (S.spacesError) wl.appendChild(errBox(S.spacesError, 'Your own pod\'s manifest is where the list of workspaces comes from.', () => { void loadSpaces(); }));
    else if (!S.spaces?.length) wl.appendChild(el('div', 'note', 'No acceptance on your pod names a workspace you are in, so you are in none yet. Accept an invitation above, or create one below.'));
    else for (const c of S.spaces) wl.appendChild(spaceRow(c));
    // Below the list, never inside it. See `withheldPanel`.
    if (!S.spacesError && S.withheld.length) wl.appendChild(withheldPanel(S.withheld));
  } else wc.hidden = true;

  const ready = !!S.viewer?.podName;
  $('createcard').hidden = !ready;
  $('opencard').hidden = !ready;
  renderModelCard();
  renderDelegates();
  renderDiscordPlan();
  renderSetup();
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
    // Read from the control rather than defaulted here: `createWorkspace` treats an omitted value
    // as public, and two places deciding the same thing is how they come to disagree.
    visibility: (document.getElementById('wsvis-private') as HTMLInputElement | null)?.checked ? 'private' : 'public',
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
  // Whose delegates were read is a fact about the OTHER MEMBERS of the workspace being left, and
  // carrying it forward would attribute one channel's delegates to another channel's authors.
  S.delegatesByPod.clear();
  // ★ AND SO IS THE PENDING ADDRESSEE, FOR THE SAME REASON THE DELEGATE ROSTER IS. It names an
  // agent chosen from the roster of the workspace being LEFT. Carrying it into the next channel
  // would address a message to somebody who may not be seated there at all — and it would do it
  // silently, since the chip that shows it is drawn from this state.
  S.ask = null;
  renderAsk();
  S.roles = { roles: null, caps: null };
  S.profileFrom = null; S.profileError = null;
  S.streamsOpened = false; S.streamIri = null;
  S.canvas = { iri: null, head: null, loaded: null, exists: false };
  for (const id of ['postresult', 'canvasresult']) { const n = document.getElementById(id); if (n) clear(n); }
  /**
   * ★ THE AGENT IS SWITCHED OFF AND ITS DRAFT DISCARDED WHEN THE WORKSPACE CHANGES.
   *
   * An adversarial review found this one and it was the worst of them. Everything above was reset
   * and `A` was not, so switching workspaces mid-turn left the agent ON in a workspace the user
   * never enabled it for, and the in-flight turn — composed from the OLD channel's transcript —
   * wrote its draft into the new channel's composer. With auto-post ticked it published one
   * workspace's discussion as a permanent public entry in another. Consent to run here is not
   * consent to run there, so it is withdrawn rather than carried.
   */
  if (A.on) void window.interego.agentCancel();
  const hadDraft = A.phase === 'drafted';
  A.on = false; A.auto = false; A.busy = false; A.phase = 'off'; A.why = '';
  A.answered.clear();
  /**
   * ★ THE GIVE-UP COUNTS ARE RELOADED, NOT CLEARED. `A.answered` is per-run on purpose — it is
   * the "I drafted this already" memory and a new channel deserves a fresh one. The attempt counts
   * are the opposite: they exist BECAUSE a restart forgets, and clearing them here would restore
   * the loop the moment somebody switched workspace and back. Reloaded per workspace, since they
   * are keyed that way.
   */
  A.attempts = loadAttempts();
  // The delegate whose draft was in the box is forgotten with the draft. A stale `drafted` would
  // let the next Send attribute text to a delegate that did not write it.
  A.drafted = null;
  // ★ AND WHO WAS SPEAKING IS NOT CARRIED EITHER. Choosing a delegate for one channel is not
  // choosing it for the next — the same reasoning as `A.on` above, one field over.
  S.speaking = null;
  /**
   * ★ ONLY A DRAFT THE AGENT PUT THERE IS DISCARDED. The first version cleared the composer
   * unconditionally, which destroyed unsent text the PERSON had typed on every workspace switch —
   * and this file's own rule two functions down is "locked, not emptied … your text is still in the
   * composer". Losing somebody's sentence to fix an agent bug is not a trade worth making.
   */
  const composer = document.getElementById('composer');
  if (hadDraft && composer) (composer as HTMLTextAreaElement).value = '';
  /**
   * ★ AND THE CANVAS EDITOR IS CLEARED FOR A REASON THAT PREDATES THE AGENT ENTIRELY. Reviewing
   * the agent's own cross-workspace leak turned up the same shape next to it: `S.canvas` was reset
   * here and the TEXTAREA was not, and `loadCanvas` returns early for a canvas that does not exist
   * yet — leaving one workspace's unsaved text in the box with a "Create on your pod" button now
   * pointing at a DIFFERENT workspace's canvas IRI. One press published it there, permanently, with
   * no agent involved.
   */
  const canvas = document.getElementById('canvas');
  if (canvas) (canvas as HTMLTextAreaElement).value = '';
  const ar = document.getElementById('agentresult');
  if (ar) clear(ar);
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
      /**
       * ★ A DESKTOP SHELL IS NOT A THREE-SECOND AUTOCOMPLETE, so it reads further than the
       * default. The reads are two round trips per grant against possibly-cold pods, which is a
       * real cost — but this panel is already showing a spinner and can afford it, where the
       * Discord Ask picker cannot: Discord gives an autocomplete no "thinking" state, so a
       * handler that overruns draws an empty box with no explanation. One number could not serve
       * both, which is why this is per-caller and the picker keeps the default.
       */
      readCap: 200,
      // If the cap does bite, read the grants that matter first: the viewer's own seat, so this
      // client can never tell somebody they are not in a room they are in, and the convener's.
      prefer: S.viewer ? [S.viewer.podName] : [],
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
  // ★ AFTER THE ROSTER IS ON SCREEN, NOT BEFORE. One `get_pod_status` per seated member is a
  // round trip each, and the roster is worth showing before they finish — every author line
  // renders as "not checked" until they land, which is a true statement rather than a wait.
  await loadMemberDelegates();
}

/**
 * Each seated member's delegates, from each member's OWN pod.
 *
 * ★ ONE READ PER POD, AND A POD THAT DOES NOT ANSWER CONTRIBUTES NOTHING. Reading the viewer's
 * registry and applying it to everybody would be inventing an authorization record for somebody
 * else — `respond.ts` records the same trap one layer over. An absent roster makes
 * `readEntryAuthorship` answer `authorised: null`, which the stream renders as "not checked".
 */
async function loadMemberDelegates(): Promise<void> {
  if (!S.client) return;
  // Keyed on the seat's own `pod` — the one derived from the grant's grantee WebID — because that
  // is what `Loaded.pod` carries, and a map two different derivations write into is a map whose
  // lookups miss silently.
  const pods = new Set<string>();
  for (const m of S.seats) if (m.seated && m.pod) pods.add(m.pod);
  if (S.viewer) pods.add(S.viewer.podName);
  for (const pod of pods) {
    S.delegatesByPod.set(pod, await readDelegates(delegatePort(S.client), pod));
  }
  if (S.viewer) S.myDelegates = S.delegatesByPod.get(S.viewer.podName) ?? null;
  reauthorBodies();
  renderRoster();
  renderStream();
  renderAgent();
  renderDelegates();
}

/**
 * Re-answer "does that pod's own registry list this agent" for every entry already read.
 *
 * ★ NO NETWORK AND NO RE-READING OF SIGNED BYTES. What the entry SAYS — who it is attributed to,
 * and who that agent acted for — was decided when the region was read and is not touched here.
 * Only the registry-dependent half is refreshed, because the rosters arrive after the first
 * bodies do. Without this, every entry loaded in that window would say "not checked" forever:
 * true about the moment it was read, false about now.
 */
function reauthorBodies(): void {
  for (const [url, b] of S.bodies) {
    const a = b.author;
    if (a.kind !== 'delegate') continue;
    let pod: string | null = null;
    for (const s of S.streams.values()) if (s.rows.some((r) => r.url === url)) { pod = s.pod; break; }
    if (pod === null) continue;
    const d = S.delegatesByPod.get(pod) ?? null;
    const hit = d?.read ? d.rows.find((r) => r.agentId === a.agentId) ?? null : null;
    S.bodies.set(url, {
      ...b,
      author: { ...a, name: hit?.name ?? null, authorised: d?.read ? hit !== null : null, scope: hit?.scope ?? null },
    });
  }
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
    // ★ THE "grant scan came back full" WARNING USED TO LIVE HERE AND IS GONE BECAUSE THE SCAN IS
    // NO LONGER CAPPED. It said a member missing from the roster might also be missing from the
    // channel — true at the time, and caused by this client asking for only 400 descriptors when
    // the relay's own default is unbounded. Nothing about it is being suppressed; the condition
    // it reported cannot arise.
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
    // ★ A MEMBER'S DELEGATES ARE DRAWN AS THEIR OWN ROWS, UNDER THEM.
    //
    // Not a count on the member's row, and not folded into it. The whole correction is that a
    // delegate is a distinct identity: one person can have an Anthropic-backed one and an
    // OpenAI-backed one, both authorised, both writing into the same log, and a reader has to be
    // able to name each. Their authority is their own row's scope, which is why it is printed
    // here rather than the member's.
    if (m.seated && m.pod) delegateRows(box, m.pod);
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

/**
 * One roster row per delegate a seated member has authorised, read from THEIR pod.
 *
 * ★ THREE STATES AND NONE OF THEM IS "NONE" BY DEFAULT. A registry this client has not read yet,
 * one it read that lists no delegates, and one whose read FAILED are three different facts about
 * somebody else's pod, and only the middle one licenses "they have no delegates".
 */
function delegateRows(box: HTMLElement, pod: string): void {
  const roster = S.delegatesByPod.get(pod);
  if (!roster) return;                       // not read yet; the row simply says nothing about it
  if (!roster.read) {
    const r = el('div', 'member');
    r.appendChild(el('div', 'badge', '?'));
    const right = el('div');
    right.appendChild(el('div', 'mname', 'delegates not established'));
    right.appendChild(el('div', 'mmeta', roster.why ?? 'the read did not complete'));
    r.appendChild(right);
    box.appendChild(r);
    return;
  }
  for (const d of roster.delegates) {
    const r = el('div', 'member');
    // A distinct badge, because a delegate is a distinct identity and the eye has to catch it.
    const b = el('div', 'badge', '⚙');
    // ★ WHAT THIS ROSTER SETTLES AND WHAT IT DOES NOT. Standing delegate status is exactly what a
    // roster is: a row on that person's pod, revocable by them, true until they withdraw it. It
    // decides nothing at all about whether any PARTICULAR thing this agent wrote was said on their
    // behalf — that is per-entry and is read off the entry, in the stream. Saying so here is what
    // stops the roster from being read as a blanket endorsement of everything the agent says.
    b.title = 'A delegate of pod ' + pod + '. Its authority is its own row on that pod, not this member\'s. '
      + 'That standing does NOT mean everything it writes is said on their behalf: each entry declares its own '
      + 'footing, and the stream shows which.';
    r.appendChild(b);
    const right = el('div');
    const nm = el('div', 'mname');
    nm.appendChild(el('span', undefined, d.name ?? 'unnamed delegate'));
    nm.appendChild(el('span', 'cap', 'delegate of ' + pod));
    const sc = el('span', 'cap ' + (d.writeEligible ? 'held' : 'withheld'), d.scope ?? 'scope not reported');
    sc.title = d.writeEligible
      ? 'This delegate\'s own row grants a scope that may publish. What it may do in THIS workspace is still capped by the seat\'s role above.'
      : 'This delegate\'s own row grants a scope that cannot publish, so it cannot write here whatever the role above permits.';
    nm.appendChild(sc);
    right.appendChild(nm);
    const id = el('div', 'mpod', d.agentId);
    id.title = 'Read from pod ' + pod + '\'s own delegation registry — a document only that pod\'s owner can write. '
      + 'The id is a function of the delegate\'s key and one shared surface name, so it is the same delegate in any client that holds that key.';
    right.appendChild(id);
    if (d.validFrom) right.appendChild(el('div', 'mpod', 'delegated ' + d.validFrom));
    /**
     * ★ THE ONE AFFORDANCE THAT MAKES ANOTHER PERSON'S AGENT REACHABLE FROM THIS APP.
     *
     * Everything needed for it was already on this row and unused: the agent's id, whose pod
     * authorises it, and whether that pod's own registry lets it append. The rows were read for
     * every SEATED member, not only the viewer, so the one thing that had to change is that they
     * became clickable. Until this existed the app could RECEIVE an ask — `wake()` verifies one
     * against `iep:addressedTo` and refuses anything not naming a key this machine holds — and had
     * no way whatsoever to send one, so the whole surface was half a conversation.
     *
     * ★ A DELEGATE ITS OWN POD WILL NOT LET PUBLISH IS NOT OFFERED. It could read the ask and think
     * about it and never append the answer, which would leave a permanent unanswerable entry on
     * YOUR log. Only its delegator can change that, so the button says so instead of writing one.
     */
    const askIt = el('button', 'sm') as HTMLButtonElement;
    askIt.textContent = 'Ask ' + (d.name ?? 'this delegate');
    askIt.disabled = !d.writeEligible;
    askIt.title = d.writeEligible
      ? 'Address your next message to this agent by name. It is written into the signed region of your entry as '
        + 'iep:addressedTo, so whoever relays it cannot change who it is for — and an agent that is not named will '
        + 'leave it alone.'
      : 'This delegate\'s own row grants a scope that cannot publish, so it could read your ask and never answer it. '
        + 'Only ' + pod + ' can change that.';
    askIt.addEventListener('click', () => {
      S.ask = { agentId: d.agentId, name: d.name, pod, agentPod: agentPodOf(d.agentId) };
      renderAsk();
      area('composer').focus();
    });
    const acts = el('div', 'row');
    acts.appendChild(askIt);
    right.appendChild(acts);
    r.appendChild(right);
    box.appendChild(r);
  }
  for (const o of roster.others) {
    // Agents that are NOT delegates — a Discord conduit, another client's own session. Shown,
    // because "who can write to this pod" is the reader's question, and named as what they are.
    const r = el('div', 'member');
    r.appendChild(el('div', 'badge', '·'));
    const right = el('div');
    const nm = el('div', 'mname');
    nm.appendChild(el('span', undefined, o.label ?? 'unlabelled agent'));
    nm.appendChild(el('span', 'cap', 'not a delegate'));
    right.appendChild(nm);
    right.appendChild(el('div', 'mpod', o.agentId));
    right.appendChild(el('div', 'mmeta', 'An agent authorised on pod ' + pod + ' whose row carries no delegate label. '
      + 'It can write there — a chat conduit relaying what this person types is exactly this — but nothing it writes '
      + 'is attributed to it as an author.'));
    r.appendChild(right);
    box.appendChild(r);
  }
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
      // ★ NO INTERVAL PINNED HERE. `pollingWatch` owns the cadence now — a quiet ceiling and a
      // fast cadence while a conversation is live — and a number written here would freeze this
      // reader at one speed while the other reader of the same channel adapted.
    }) ?? null;
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
  // ★ A FAILED READ IS RETRIED; ONLY A SUCCESSFUL ONE IS CACHED. The cache used to be keyed on
  // presence alone, so one transient 502 on one descriptor was permanent for the session — the row
  // never re-fetched, and (since the agent now counts unread rows) the agent refused to act for
  // the rest of the run with copy that read as if it were momentary. Evicting the failures makes
  // the next poll the retry.
  for (const r of rows) { const b = S.bodies.get(r.url); if (b && (b.error || b.note)) S.bodies.delete(r.url); }
  const wanted = rows.filter((r) => !S.bodies.has(r.url)).map((r) => r.url);
  const owner = (url: string): string | null => {
    for (const st of S.streams.values()) if (st.rows.some((r) => r.url === url)) return st.graph;
    return null;
  };
  /** The whole loaded stream a row belongs to, so its seat and its pod are both in hand. */
  const ownerOf = (url: string): Loaded | null => {
    for (const st of S.streams.values()) if (st.rows.some((r) => r.url === url)) return st;
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
        const auth = d['authorship'] as { signedBy?: string; signer?: string; authorshipVerified?: boolean } | undefined;
        // ★ THE KEY THE RELAY VERIFIED OVER THESE BYTES — not the one the proof merely NAMES. A
        // proof that did not bind still reports a signer, and a comparison that decides who spoke
        // must not turn on a name out of a document the pod's owner controls.
        const signerAgent = verifiedSigner(d['authorship']);
        // Whose log this is, from the SEAT — the grant's `wsp:grantedTo`, which lives on the
        // convener's pod and which the log's owner therefore cannot write. Taking it from the
        // entry would let the entry decide what it is being checked against.
        const st = ownerOf(url);
        S.bodies.set(url, {
          body: readLiteral(src, 'dct:description'),
          seq: readInt(src, 'wsp:seq'),
          isEntry: hasType(src, 'wsp:Entry'),
          declaredWorkspace: readIri(src, 'wsp:workspace'),
          servedPod: podOfDescriptorUrl(url),
          signed: !!auth?.authorshipVerified,
          signedBy: signerAgent,
          derivedFrom: readIri(src, 'prov:wasDerivedFrom'),
          addressedTo: readIriAll(src, 'iep:addressedTo'),
          author: readEntryAuthorship(region, {
            logOwnerWebId: st?.seat?.grantedTo ?? null,
            delegates: st ? S.delegatesByPod.get(st.pod) ?? null : null,
            // ★ THE ONE INPUT HERE THAT IS NOT THE POD OWNER'S OWN BYTES. Stored on the row above
            // and never compared to the composed author until now: an entry could name any agent
            // as its author, with a complete on-behalf-of footing, and this stream drew it as that
            // agent speaking for its human while its key never signed and its host never ran.
            signedBy: signerAgent,
          }),
          note: g === null
            ? 'this client is no longer tracking which log this record belongs to, so which signed region is its own could not be established'
            : region === null
              ? 'the signed region of this record could not be located, so nothing here was read from bytes anybody signed'
              : null,
        });
      } catch (e) {
        S.bodies.set(url, {
          body: null, seq: null, isEntry: false, declaredWorkspace: null, servedPod: null,
          signed: false, signedBy: null, derivedFrom: null, addressedTo: [],
          author: { kind: 'unstated', why: 'this record could not be read, so nothing about its author was established' },
          note: errorCopy(e).t, error: e,
        });
      }
    }
  });
  await Promise.all(workers);
  renderStream();
  // ★ THE AGENT IS CONSIDERED HERE AND NOWHERE ELSE — after the bodies for a read are in, which is
  // the only moment the channel is actually known. Hooking it to the watch tick instead would run
  // the decision against half-loaded entries and let it answer a message whose text had not
  // arrived yet. `agentConsider` is a no-op unless the agent is switched on.
  renderAgent();
  void agentConsider();
}

/**
 * The drawing in an entry, if it holds one this shell is willing to display.
 *
 * ★ THE SAME REFUSALS THE CHANNEL APPLIES, so a drawing this app declines to show is the same one
 * Discord declines to post. Script, event handlers, references to anything OUTSIDE the document,
 * entity expansion and oversize — all refused. The markup is written by a model in answer to text
 * other people typed, and here it is about to be rendered inside the shell that holds the session.
 *
 * Returns the markup, or null when there is none or it is refused. Null means the body renders as
 * text exactly as it always did, which is the honest fallback: the record says what it says.
 */
function drawnSvg(body: string): string | null {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(body);
  if (!m) return null;
  const svg = m[0];
  if (svg.length > 60_000) return null;
  const forbidden = [
    /<script[\s>]/i,
    /<foreignObject[\s>]/i,
    /\son\w+\s*=/i,
    /(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i,
    /url\(\s*["']?\s*(?:https?:|\/\/)/i,
    /<!ENTITY/i,
  ];
  for (const rx of forbidden) if (rx.test(svg)) return null;
  return svg;
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
    const a = b?.author ?? null;
    // ★ THE BADGE IS THE AUTHOR, NOT THE POD, AND "YOU" IS NO LONGER A PROPERTY OF THE LOG.
    // A delegate's entry sits in its delegator's log, so a badge keyed on the pod put "YOU" on
    // something the person did not write — the exact confusion this whole change removes.
    const delegateHere = a?.kind === 'delegate';
    // ★ THE BADGE SPLITS THE TWO DELEGATE CASES, because a single glyph over both would leave the
    // whole distinction in the tooltip. "⚙" is a delegate speaking for the person whose log this
    // is; "⚙!" is one speaking for ITSELF — its own position, which that person is not answerable
    // for; "⚙?" is one whose record does not say which.
    const badge = el('div', 'badge', delegateHere
      ? (a.footing.kind === 'on-behalf-of' ? '⚙' : a.footing.kind === 'own-account' ? '⚙!' : '⚙?')
      : item.st.isYou ? 'YOU' : (S.podMarks.get(item.st.pod) ?? '??'));
    badge.title = delegateHere
      ? 'Written by a delegate of pod ' + item.st.pod + ', not by that person. '
        + footingLine(a.footing, { who: 'that person', agentName: a.name })
      : 'pod ' + item.st.pod;
    msg.appendChild(badge);
    const right = el('div');
    const h = el('div', 'mhead');
    /**
     * ★ WHO WROTE IT, FROM THE ENTRY — and the role beside it, from the seat.
     *
     * These answer different questions and used to be one string. The role is the CAPACITY the
     * log's owner holds in this workspace; the author is WHO COMPOSED THESE WORDS. For a person's
     * own entry they coincide closely enough that showing the role alone looked fine. For a
     * delegate's they do not, and for an entry that states no author at all they never did:
     * "Contributor" over text nobody's record attributes to anybody is a confident falsehood.
     */
    const seatRole = item.st.seat ? roleName(S.roles, item.st.seat.role) : null;
    const author = el('span', 'mauthor', a
      ? authorshipLine(a, { displayName: item.st.isYou && a.kind === 'principal' ? 'You' : null })
      : 'author not read yet');
    if (a && (a.kind === 'unstated' || a.kind === 'disputed')) {
      author.style.color = a.kind === 'disputed' ? 'var(--refused)' : 'var(--pending)';
      author.title = a.why;
    } else if (a?.kind === 'delegate') {
      // ★ TWO SENTENCES FOR TWO FACTS, AND THEY ARE ALLOWED TO DISAGREE. The first is STANDING —
      // is this agent listed on that person's own pod as their delegate — and the second is
      // PER-ACT: was this particular entry made on their behalf. An agent can be a properly
      // authorised delegate and still be speaking entirely for itself here, which is the state the
      // old single sentence could not express at all.
      author.title = 'prov:wasAttributedTo ' + a.agentId + '. '
        + footingLine(a.footing, { who: 'that person', agentName: a.name }) + ' '
        + (a.authorised === true ? 'Separately, and unchanged by any of that: that pod\'s own delegation registry lists this agent'
              + (a.scope ? ' with scope ' + a.scope : '') + ', so it is their delegate.'
          : a.authorised === false ? 'And that pod\'s own delegation registry does NOT list this agent at all, so it is not a delegate of theirs by any record they have published.'
            : 'That pod\'s delegation registry has not been read here, so whether it is their delegate at all is not established.');
      if (a.authorised === false) author.style.color = 'var(--refused)';
      // Not an error and not a pass. A record that will not say what it was speaking on is a
      // finding, and the pending colour is what this shell uses for "not established".
      else if (a.footing.kind === 'not-stated') author.style.color = 'var(--pending)';
    } else if (a?.kind === 'principal') {
      author.title = 'prov:wasAttributedTo ' + a.webId + ' — the owner of the pod this log is on, so this is the person\'s own writing.';
    }
    h.appendChild(author);
    if (seatRole) {
      const rl = el('span', 'seq', seatRole);
      rl.title = 'The role the LOG\'S OWNER holds in this workspace. It is the seat\'s, not the author\'s: a delegate '
        + 'inherits it and cannot exceed it. ' + roleWhy(S.roles, item.st.seat?.role);
      h.appendChild(rl);
    }
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
    else if (drawnSvg(b.body)) {
      /**
       * ★ AN AGENT THAT DREW SOMETHING IS SHOWN THE DRAWING, NOT THE MARKUP.
       *
       * A delegate can answer with an SVG — that is its own words, and it lands in
       * `dct:description` like any other answer. Discord rasterises it; here the renderer IS a
       * browser, so the markup can be shown as what it is with nothing to convert.
       *
       * ★ SET AS AN `<img>` WITH A DATA URL, NEVER AS innerHTML. Inlining somebody else's markup
       * into this document would put it in the same DOM as the session, the pod list and every
       * control on the page — a script or an event handler in it would be running inside the
       * shell. An `<img>` renders SVG in an isolated context where script does not execute and
       * external references are not fetched, so the drawing is displayed without the document
       * that drew it ever becoming part of this one.
       *
       * The same refusals as the Discord side are applied first, so a drawing this app declines
       * to show is the same drawing that channel declines to post.
       */
      const svg = drawnSvg(b.body) as string;
      t.className = 'body';
      const img = document.createElement('img');
      img.className = 'drawn';
      img.alt = 'a drawing this agent produced';
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      t.appendChild(img);
      const rest = b.body.replace(svg, '').trim();
      if (rest) t.appendChild(el('div', 'mmeta', rest));
    }
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

/**
 * A relay session belonging to a DELEGATE, over the same transport interface as the person's.
 *
 * ★ NOT A SECOND WRITER — A SECOND CALLER. `postEntry` is still the only thing that appends, with
 * the same chain derivation, the same 412 retry, the same shape assertion and the same readback.
 * What differs is who the relay authenticates: the delegate's own key, so the write is scope-gated
 * on the delegator's `register_agent` row and `revoke_agent` actually stops it. Routing it through
 * the person's session would have produced a record saying "the agent wrote this" that the
 * substrate had no reason to believe.
 */
const delegateClients = new Map<string, WorkspaceClient>();

async function delegateClient(address: string): Promise<WorkspaceClient> {
  const live = delegateClients.get(address);
  if (live) return live;
  const c = new WorkspaceClient(S.relay, new ConnectorTransport({
    async listTools() {
      // One live call, which is also the check that this machine can actually drive this
      // delegate: a key it does not hold answers `delegate_unavailable` here rather than at the
      // write, where the failure would arrive after the person had pressed Send.
      //
      // ★ AND IT IS THE CHEAP REQUIRED TOOL, FOR THE REASON GIVEN ON THE OTHER PROBE. This asked
      // `get_pod_status` — 56,450,477 bytes on a real pod, discarded unread, once per delegate.
      const r = await window.interego.delegateCall(address, 'read_inbox', {});
      if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
      return { servers: [{ server: 'Interego relay', tools: REQUIRED_TOOLS.map((name) => ({ name })) }] };
    },
    async callTool(_server, name, input) {
      const r = await window.interego.delegateCall(address, name, input);
      if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
      return { payload: r.payload };
    },
  }));
  await c.connect();
  delegateClients.set(address, c);
  return c;
}

/**
 * Append what is in the composer.
 *
 * ★ `as` IS WHO IS SPEAKING, AND IT IS THE ONLY THING THAT DIFFERS BETWEEN A PERSON'S POST AND A
 * DELEGATE'S. Same button, same writer, same readback. Omitted, the person is the author; given,
 * the delegate is the author and the person is who it acted for.
 */
async function post(as?: {
  readonly address: string;
  readonly agentId: string;
  readonly footing: StatedFooting;
  /**
   * The record this answer answers.
   *
   * ★ CARRIED ONLY FOR A DELEGATE, because only a delegate has the problem it solves: its in-run
   * memory of what it has answered dies with the process, so without this a restarted host reads
   * the same ask, judges it unanswered, and writes a second permanent record saying the same
   * thing. A person pressing Post is not looping and is not asked to declare anything.
   */
  readonly answering?: string | null;
}): Promise<void> {
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
  // ★ NO WEBID, NO ENTRY. Every entry now states who composed it, and for a person's own post
  // that statement IS their WebID. Writing one without it would put an entry on the pod whose
  // author is unstated — which readers must render as "not stated", not as the pod's owner.
  if (!S.viewer.webId) {
    say('postresult', 'refused', 'Nothing was written: this client cannot name you',
      'get_pod_status returned no registry owner for your pod, so there is no WebID to attribute this entry to. '
      + 'Every entry states its author; one that could not would be a permanent record nobody can be read out of.');
    send.disabled = false; ta.disabled = false; return;
  }
  const key = streamKey(S.viewer.podName, streamIri);
  if (!S.streams.has(key)) {
    S.streams.set(key, { pod: S.viewer.podName, graph: streamIri, isYou: true, seat: seat ?? null, rows: [], error: null, loaded: false, stale: null, watchFailed: null });
  }
  say('postresult', 'pending', 'Deriving your position in your own log…',
    'Reading the current head of ' + streamIri.replace(/^https:\/\//, '') + ' so this entry can declare the one before it.');

  let writer = S.client;
  if (as) {
    try { writer = await delegateClient(as.address); }
    catch (e) {
      clear($('postresult')).appendChild(errBox(e, 'Your delegate\'s own session could not be opened, so nothing was '
        + 'written. This app holds its key or it does not — and a delegate\'s entry is written under the delegate\'s '
        + 'own session, not yours, so it is not falling back to writing this as you.'));
      send.disabled = !!S.writeBlocked; ta.disabled = !!S.writeBlocked; renderAgent();
      return;
    }
  }
  const out = await postEntry(writer, {
    podName: S.viewer.podName, streamIri, workspace: S.workspace, body,
    /**
     * ★★ THE WORKSPACE'S OWN POLICY, READ FROM THE RECORD THIS VIEW IS ALREADY SHOWING.
     *
     * Not re-fetched and not decided here: the record on screen is what the roster, the roles and
     * every other statement in this panel were read from, so the entry is written under the same
     * reading of the workspace the person is looking at. Omitting it would publish a plaintext
     * entry into a private workspace — a 200, and a permanent hole in a conversation everything
     * else about it says is sealed.
     */
    visibility: S.record?.visibility ?? 'public',
    // ★ THE FOOTING IS CARRIED FROM THE DRAFT, NOT DECIDED HERE. It is the delegate's own answer,
    // taken from what its model declared and shown on its Send button before this ran — so the
    // record states what the agent said it was doing, and the person saw it first.
    author: as
      ? { kind: 'delegate', agentId: as.agentId, footing: as.footing }
      : { kind: 'principal', webId: S.viewer.webId },
    ...(as?.answering ? { derivedFrom: as.answering } : {}),
    // ★ WHO IT IS FOR, INSIDE THE SIGNED REGION, AND APPLIED WHOEVER THE AUTHOR IS. Addressing and
    // authorship are different axes: a person may address another person's agent, and so may a
    // delegate. Restricting this to the human's own Post would have made the chip above the box
    // lie the moment a delegate's draft was in it.
    ...(S.ask ? { addressedTo: [S.ask.agentId] } : {}),
    entryShape: S.record?.entryShape ?? null,
    onAttempt: (n) => {
      if (n > 1) say('postresult', 'pending', 'Someone appended while you were typing — re-deriving',
        '412 precondition_failed. Re-reading the head and trying once more, which is the right move for a log.');
    },
  });
  // Every early return re-enables the composer to whatever the delegation check decided, never
  // to plain `false`: a viewer whose scope forbids writing must not be handed it back. And never
  // past `renderAgent`, which is the one place that decides whether a delegate's unedited draft
  // is currently blocking the person's own Post.
  const reopen = (): void => { send.disabled = !!S.writeBlocked; ta.disabled = !!S.writeBlocked; renderAgent(); };

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

  const p = say('postresult', 'ok', out.committed
    ? (as ? 'Your delegate posted to your pod' : 'Posted to your pod')
    : (as ? 'Accepted — your delegate\'s entry is landing on your pod' : 'Accepted — landing on your pod'));
  p.appendChild(kvPair([
    ['pod', S.viewer.podName],
    // ★ THE TRIPLES, NAMED. Not "you" and not the pod: what the record will actually say, so the
    // sentence on this panel and the sentence a reader gets from the entry are the same sentence.
    ['authored by', as
      ? 'prov:wasAttributedTo ' + as.agentId + ' — your delegate, and the entry also states it acted on behalf of ' + S.viewer.webId
      : 'prov:wasAttributedTo ' + S.viewer.webId + ' — you. Nothing acted on your behalf here.'],
    ['wsp:seq', String(out.seq)],
    // Stated as the triple, like every other line here. "Addressed to Scribe" is what the UI did;
    // `iep:addressedTo <did>` is what the record now says, and only the second one is checkable.
    ['addressed to', S.ask
      ? 'iep:addressedTo ' + S.ask.agentId + ' — inside the signed region, so whoever relays this cannot change who it '
        + 'is for. Every other agent reading this channel is expected to leave it alone.'
      : 'nobody — this entry names no iep:addressedTo, so it is open to any agent that reads the channel'],
    ['descriptor', out.descriptorUrl ?? 'not reported by the response'],
    ['shape asserted', entryShapeAnswer(out.shapeSent, S.recordResult, S.workspace)],
    // ABSENCE IS NOT EVIDENCE. What was SENT is on the outcome, so the two are reported
    // separately: what this client asserted, and what came back about it.
    ['precondition', preconditionLine(out.response['precondition'], out.ifMatch, out.ifMatchKind)
      ?? 'none sent — this read found no prior entry in your log to assert against'],
    // ★ WHAT THE PROOF ACTUALLY PROVES, AND THE LINE THIS PANEL MUST NEVER CROSS.
    //
    // MEASURED on this relay, on a delegated write and an own-pod write alike: the proof's
    // `verificationMethod` is ONE key — the relay's own delegation signer — identical for every
    // pod and every agent. Only the ISSUER distinguishes them. So "signed by your delegate" would
    // be read as the delegate's own wallet having signed, and it did not: what is signed is the
    // relay's attestation about who asked. `readAuthorship` in the module says the same thing to
    // the bot, and this says it here rather than shortening it to "signed by".
    ['authorship', (() => {
      const a = out.response['authorship'] as { signed?: boolean; signer?: string; verificationMethod?: string; reason?: string } | undefined;
      if (!a) return 'sign_authorship was requested; the response did not report an authorship block, so nothing is established about it';
      if (!a.signed) return 'not signed — ' + (a.reason ?? 'the response gave no reason');
      return 'the relay signed a statement that the caller it authenticated as ' + (a.signer ?? 'an unnamed agent')
        + ' published this. That is the relay attesting who asked'
        + (a.verificationMethod ? ', verifiable against ' + a.verificationMethod + ' — the relay\'s own key, the same one for every pod and every agent here' : '')
        + '. It is NOT ' + (as ? 'your delegate\'s' : 'your') + ' own wallet signature, and it is not evidence that any key of '
        + (as ? 'that delegate\'s' : 'yours') + ' signed anything.';
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
  if (landed) {
    ta.value = '';
    // The delegate's claim on the composer ends with the text it wrote. Leaving it set would let
    // the NEXT thing typed there be sent as that delegate.
    A.drafted = null;
    A.phase = A.on ? 'watching' : 'off';
    /**
     * ★ THE POINTER GOES ONLY AFTER THE RECORD IS CONFIRMED READABLE, WHICH IS THE ORDERING THAT
     * MATTERS. The ask IS the entry; the notice is an accelerant for a host that is not running.
     * Sending it earlier would risk a notice pointing at a record that never landed — and a
     * recipient dereferencing `about` to find nothing has been handed a mystery rather than a
     * request. Whether it goes at all is `notifyAsk`'s call, shared with the Discord conduit so
     * the two surfaces cannot come to disagree about it.
     */
    const target = S.ask;
    if (target) {
      S.ask = null;
      renderAsk();
      /**
       * ★ A FAILED PRESENCE READ IS `unreadable`, WHICH IS NOT PRESENT — SO THE NOTICE STILL GOES.
       * The asymmetry is deliberate and it is the safe direction: treating a failed read as
       * "running" would suppress the pointer to an agent that is in fact asleep, and the ask would
       * sit unread until somebody happened to start its host. `isPresent` is true only for a
       * verified live lease, so every other answer — including this one — sends.
       */
      const presence = await readPresence(agentPort(S.client), { relay: S.relay, agentId: target.agentId })
        .catch((e): Presence => ({
          state: 'unreadable', agentId: target.agentId, pod: target.agentPod ?? '', iri: '',
          why: 'the read of this agent\'s presence lease failed: ' + errorCopy(e).t,
        }));
      const notice = await notifyAsk(S.client, {
        agentId: target.agentId, agentPod: target.agentPod, presence,
        about: out.descriptorUrl,
        summary: 'A request addressed to ' + (target.name ?? target.agentId) + ' was published in this workspace',
      });
      p.appendChild(kvPair([
        ['its host', presenceLine(presence)],
        ['notice', notice.attempted
          ? (notice.delivered
            ? 'delivered into the inbox on that AGENT\'s own pod' + (target.agentPod ? ' (' + target.agentPod + ')' : '')
              + ' — the one its own session polls, not its delegator\'s, which it is forbidden to read'
              + (notice.canonicalInbox === false ? '. The relay did not report that as the pod\'s canonical inbox, so this is reported as sent rather than as arrived' : '')
            : 'NOT delivered: ' + (notice.why ?? 'no reason reported') + '. The ask is still on the record, so a host that reads this channel will still find it.')
          : (notice.why ?? 'nothing was sent and no reason was reported')],
      ]));
    }
  } else {
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
    // The workspace's own policy, from the record this view was built from — same reasoning as
    // the entry post above. A plaintext canvas in a private workspace is the same hole.
    visibility: S.record?.visibility ?? 'public',
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

// ── the first run, as one sequence ───────────────────────────────────────────

/**
 * Whether THIS app has published a Discord delegation in this session.
 *
 * ★ DELIBERATELY NOT PERSISTED, AND DELIBERATELY NOT A CLAIM ABOUT THE POD. Whether a delegation
 * exists is a question about the pod's registry and it needs an agent id to ask — which this app
 * does not have until the user types one. So this is what this app DID, not what is true, and the
 * checklist below says so in those words. A cached "linked ✓" that outlived a revoke made
 * somewhere else would be the app asserting something it had not checked.
 */
let discordPublishedHere = false;

/** `y` established in favour, `n` established against, `q` not established. */
function setupSteps(): Check[] {
  const out: Check[] = [];
  const pod = S.viewer?.podName ?? null;
  out.push(pod
    ? { mark: 'y', text: '1. Your account — you are pod ' + pod + ', and it is the only storage these credentials can write to.' }
    : { mark: 'q', text: '1. Your account — not resolved yet.' });

  if (!providerRead) out.push({ mark: 'q', text: '2. Your agent\'s model — still checking this machine.' });
  else if (probeFailed) {
    out.push({ mark: 'q', text: '2. Your agent\'s model — this app could not run the check, so what this machine can do is not established. It is not a statement that nothing is here.' });
  } else {
    const p = usableProvider();
    const first = providers[0] ?? null;
    /**
     * ★ THREE OF THE FOUR UNUSABLE CASES ARE "NOT ESTABLISHED", NOT "NO".
     *
     * `membership.ts` states the rule this used to break: collapsing `q` into `n` is how absence
     * gets rendered as a negative fact. An adversarial review found every `usable: false` drawn as
     * a cross — including the CLI-not-installed case, the probe-timed-out case and the
     * unreadable-answer case, in all three of which `loggedIn` is null because nothing was
     * learned about the account at all. Only `loggedIn === false` is the tool having been asked
     * and having answered no.
     */
    out.push(p
      ? { mark: 'y', text: '2. Your agent\'s model — ' + p.label + ', signed in as ' + (p.account ?? 'an account it did not name') + '. Your agent runs on your own subscription.' }
      : first?.loggedIn === false
        ? { mark: 'n', text: '2. Your agent\'s model — ' + first.why + ' You can use everything else without it; there is just no agent until it is fixed.' }
        : { mark: 'q', text: '2. Your agent\'s model — ' + (first?.why ?? 'nothing to run your agent on was found, and nothing was established about your account either way.') + ' Whether you have a subscription is not something this app can see from here.' });
  }

  const joined = S.spaces?.length ?? null;
  out.push(S.spacesError
    ? { mark: 'q', text: '3. A workspace — your own pod could not be read, so how many you are in is not established.' }
    : joined === null ? { mark: 'q', text: '3. A workspace — not read yet.' }
      : joined > 0 ? { mark: 'y', text: '3. A workspace — you are in ' + joined + '. Open one below, or create another.' }
        : { mark: 'n', text: '3. A workspace — you are in none yet. Accept an invitation above, or create one below.' });

  /**
   * ★ THIS STEP CAN BE ANSWERED PROPERLY, UNLIKE THE DISCORD ONE BELOW IT.
   *
   * Delegates carry a labelled row on the person's OWN pod, so "how many have you authorised" is a
   * question a read answers rather than one this app has to shrug at. All four states are
   * distinguished: not read, read and none, read and some, and read-failed — and only the second
   * is a finding against.
   */
  const del = S.myDelegates;
  out.push(!del ? { mark: 'q', text: '4. A delegate — not read yet.' }
    : !del.read ? { mark: 'q', text: '4. A delegate — your pod\'s delegation registry could not be read, so how many you have authorised is not established. That is not the same as none.' }
      : del.delegates.length ? { mark: 'y', text: '4. A delegate — your pod authorises ' + del.delegates.length + '. Each writes as itself, acting for you; none of them writes as you.' }
        : { mark: 'n', text: '4. A delegate — you have authorised none, so nothing can answer in a channel for you. Authorise one below; it will write as itself and say it acted for you.' });

  out.push(discordPublishedHere
    ? { mark: 'y', text: '5. Discord — this app published a delegation on your pod in this session. Run /workspace link-confirm in Discord to finish; the bot checks the row itself rather than taking this app\'s word for it.' }
    // Not "you have not linked Discord": this app cannot know that without an agent id to ask about.
    : { mark: 'q', text: '5. Discord — optional, and this app has not published one for you in this session. Whether your pod already delegates a bot is not something it can check without knowing which bot, so nothing here is a claim either way.' });
  return out;
}

function renderSetup(): void {
  if (!document.getElementById('setupcard')) return;
  $('setupcard').hidden = !S.viewer?.podName;
  clear($('setupsteps')).appendChild(checkList(setupSteps()));
}

// ── your own model, and your own agent ───────────────────────────────────────

/**
 * ★ NOTHING IN THIS SECTION MAKES A MODEL CALL. It asks the main process for one. The renderer
 * cannot spawn a process and must not learn how — a path to an executable crossing this boundary
 * would be a way to make the privileged half run anything, from the half that renders bytes other
 * people wrote.
 */
let providers: readonly ProviderInfo[] = [];
let unsupported: readonly { id: string; label: string; why: string }[] = [];
let providerRead = false;
/**
 * The probe itself failed, as distinct from the probe reporting nothing usable.
 *
 * ★ WITHOUT THIS FLAG AN EMPTY LIST LIES. The catch below used to leave `providers` empty with
 * `providerRead` true, and every reader downstream then said "nothing this app can drive was found
 * on this machine" — a claim about somebody's machine derived from a call that never returned.
 */
let probeFailed = false;

const usableProvider = (): ProviderInfo | null => providers.find((p) => p.usable) ?? null;

async function loadProviders(): Promise<void> {
  try {
    const got = await window.interego.agentProbe();
    providers = got.providers;
    unsupported = got.unsupported;
    probeFailed = false;
  } catch (e) {
    providers = [];
    unsupported = [];
    probeFailed = true;
    clear($('modelresult')).appendChild(errBox(e, 'This app could not check what it can run your agent on, so nothing is being claimed about it either way.'));
  }
  providerRead = true;
  renderModelCard();
  renderSetup();
  renderAgent();
}

function renderModelCard(): void {
  if (!document.getElementById('modelcard')) return;
  $('modelcard').hidden = !S.viewer?.podName;
  const body = clear($('modelbody'));
  if (!providerRead) { body.appendChild(el('div', 'note', 'Checking this machine…')); return; }
  for (const p of providers) {
    const panel = el('div', 'panel ' + (p.usable ? 'ok' : 'pending'));
    panel.appendChild(el('h4', undefined, p.label));
    panel.appendChild(el('div', undefined, p.why));
    // ABSENCE IS NOT EVIDENCE, RENDERED. `loggedIn === null` means the CLI was not found, so there
    // is no evidence either way about this person's account — and it is not drawn as "signed out".
    panel.appendChild(kvPair([
      ['installed', p.installed ? 'yes, at ' + (p.path ?? 'a path it did not report') : 'not found on this machine'],
      // ★ THE REASON IS NOT HARD-CODED. It used to read "not established — the tool is not here to
      // ask" for every null, and `loggedIn` is null in four cases, three of which have the tool
      // right there: a .cmd-only shim, a probe that timed out, and an answer this app could not
      // parse. The card printed "installed: yes, at C:\…" on one row and "not here to ask" on the
      // next. The mark was right and the sentence was false, which is its own kind of absence
      // rendered as a fact.
      ['signed in', p.loggedIn === null
        ? 'not established' + (p.installed ? ' — see the note above for what stopped this app finding out' : ' — the tool is not here to ask')
        : p.loggedIn ? 'yes' : 'no'],
      ['account', p.account ?? 'not reported'],
      ['plan', p.subscription ?? 'not reported'],
    ]));
    body.appendChild(panel);
  }
  for (const u of unsupported) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h4', undefined, u.label));
    panel.appendChild(el('div', undefined, u.why));
    body.appendChild(panel);
  }
}

// ── linking a chat account, by publishing a delegation on your own pod ───────

/**
 * ★ NEITHER FIELD IS A SECRET AND NOTHING HERE MINTS ONE. A delegation row is world-readable —
 * `get_pod_status { pod_name: <anyone's> }` returns anybody's rows WITH their labels — so a nonce
 * published in a label is a nonce published. The bot's `links.ts` records the defect that taught
 * this: whoever read the pod first could bind THEIR Discord account to YOUR pod. The label is the
 * claim itself, and the bot recomputes it from the id of the account actually running the confirm.
 * Do not add a code field here.
 */
function renderDiscordPlan(): void {
  if (!document.getElementById('discordcard')) return;
  $('discordcard').hidden = !S.viewer?.podName;
  const plan = discordLinkPlan({ botAgentId: inp('botagent').value, discordUserId: inp('discorduser').value });
  const where = clear($('discordplan'));
  const started = !!(inp('botagent').value.trim() || inp('discorduser').value.trim());
  $('discordhint').textContent = plan.problems.find((p) => p.field === 'discordUserId')?.why ?? '';
  btn('discordlink').disabled = !plan.call || !!S.writeBlocked;
  if (!started) {
    where.appendChild(el('div', 'note', 'Nothing has been sent anywhere. The call is shown here before it is made.'));
    return;
  }
  if (!plan.call) {
    for (const p of plan.problems) where.appendChild(el('div', 'note', p.why));
    return;
  }
  const panel = el('div', 'panel pending');
  panel.appendChild(el('h4', undefined, 'This is the exact call, and it has not been made'));
  panel.appendChild(kvPair(Object.entries(plan.call.args).map(([k, v]) => [k, String(v)] as [string, string])));
  for (const limit of plan.limits) panel.appendChild(el('div', 'note', limit));
  where.appendChild(panel);
}

async function linkDiscord(): Promise<void> {
  if (!S.client || !S.viewer) return;
  const plan = discordLinkPlan({ botAgentId: inp('botagent').value, discordUserId: inp('discorduser').value });
  if (!plan.call) { renderDiscordPlan(); return; }
  btn('discordlink').disabled = true;
  say('discordresult', 'pending', 'Publishing on your pod', 'register_agent is own-pod gated at the relay, so this can only write to '
    + S.viewer.podName + ' — which is what makes it worth anything.');
  let out;
  try {
    out = await publishDelegation(delegatePort(S.client), { plan, verifyOnPod: S.viewer.podName });
  } catch (e) {
    clear($('discordresult')).appendChild(errBox(e, 'The delegation was not published.'));
    btn('discordlink').disabled = false;
    return;
  }
  btn('discordlink').disabled = false;
  if (out.kind === 'published') {
    const p = say('discordresult', 'ok', 'Published, and read back from your own pod', out.why);
    if (out.rescopedFrom) {
      p.appendChild(el('div', 'note', 'This agent was already registered with scope ' + out.rescopedFrom
        + ' and has now been changed to PublishOnly. That is a change to authority you already had, not a new one.'));
    }
    p.appendChild(checkList(delegationChecks(out)));
    p.appendChild(el('div', 'note', 'Now run /workspace link-confirm pod:' + S.viewer.podName + ' back in Discord. '
      + 'The bot checks this row itself; it does not take this app\'s word for it.'));
    $('discordrevoke').hidden = false;
    discordPublishedHere = true;
    renderSetup();
  } else {
    const p = say('discordresult', out.kind === 'unconfirmed' ? 'pending' : 'refused',
      out.kind === 'unconfirmed' ? 'Accepted, but not confirmed by reading your pod back' : 'Not published', out.why);
    p.appendChild(checkList(delegationChecks(out)));
  }
}

async function revokeDiscord(): Promise<void> {
  if (!S.client || !S.viewer) return;
  const agentId = inp('botagent').value.trim();
  if (!agentId) return;
  btn('discordrevoke').disabled = true;
  const out = await revokeDelegation(delegatePort(S.client), { agentId, podName: S.viewer.podName });
  btn('discordrevoke').disabled = false;
  say('discordresult', out.kind === 'revoked' ? 'ok' : 'refused',
    out.kind === 'revoked' ? 'Revoked' : 'Not revoked', out.why);
}

// ── delegates: identities you authorise, which this app merely hosts ─────────

/**
 * ★ TWO LISTS, DRAWN AS TWO LISTS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 *
 * The POD's delegation registry says who this person has authorised. This app's keyring says
 * which of those it can drive. They overlap and neither contains the other: a delegate on another
 * machine is authorised and not drivable here; a key minted and not yet authorised is drivable
 * and permitted nothing. Merging them would let an application's storage stand in for an
 * authorization record, which is the same class of mistake as letting a pod stand in for an
 * author.
 */
async function loadDelegates(): Promise<void> {
  try {
    const got = await window.interego.delegateList();
    S.hosted = got.delegates;
    S.hostedRead = true;
    S.hostedError = null;
  } catch (e) { S.hostedRead = true; S.hostedError = e; }
  if (S.client && S.viewer) S.myDelegates = await readDelegates(delegatePort(S.client), S.viewer.podName);
  renderDelegates();
  renderAgent();
  renderSetup();
}

function delegateFormPlan(): ReturnType<typeof delegatePlan> | null {
  const agentId = inp('delegateagent').value.trim();
  const name = inp('delegatename').value.trim();
  if (!agentId && !name) return null;
  return delegatePlan({ agentId, name });
}

function renderDelegates(): void {
  if (!document.getElementById('delegatecard')) return;
  $('delegatecard').hidden = !S.viewer?.podName;
  if (!S.viewer?.podName) return;

  // ── what your pod authorises ───────────────────────────────────────────────
  const list = clear($('delegatelist'));
  const roster = S.myDelegates;
  if (!roster) {
    list.appendChild(el('div', 'note', 'Reading which delegates your pod authorises…'));
  } else if (!roster.read) {
    list.appendChild(el('div', 'note', 'Your pod\'s delegation registry could not be read, so how many delegates you have '
      + 'authorised is not established — which is not the same as none. ' + (roster.why ?? '')));
  } else if (!roster.delegates.length) {
    list.appendChild(el('div', 'note', 'Your pod authorises no delegates. Nothing will write as you until you authorise one, '
      + 'and a delegate never writes AS you — it writes as itself.'));
  } else {
    // ★ THE ONE SENTENCE THAT KEEPS THIS CARD FROM BEING READ AS A BLANKET ENDORSEMENT. Everything
    // below is STANDING: these agents are your delegates until you revoke them. None of it says
    // that what any of them writes is said on your behalf — a delegate declares that per entry,
    // and half of the point of authorising one is that it can hold a position you have not taken.
    list.appendChild(el('div', 'note', 'These are STANDING delegations: each of these agents is your delegate until you '
      + 'revoke it, and that is a fact about the agent. It is not a statement about anything they say. Every entry a '
      + 'delegate writes separately declares whether it was speaking FOR you — you share responsibility for those — or on '
      + 'its OWN account, where it alone is answerable. The stream shows which, per entry.'));
    for (const d of roster.delegates) {
      const item = el('div', 'item');
      const head = el('div');
      head.appendChild(el('b', undefined, d.name ?? 'unnamed delegate'));
      const held = S.hosted.some((h) => h.agentId === d.agentId);
      const chip = el('span', 'cap ' + (held ? 'held' : 'withheld'), held ? 'key on this machine' : 'hosted elsewhere');
      chip.title = held
        ? 'This app holds this delegate\'s key, so it can be driven from here.'
        : 'This delegate is authorised on your pod and this app holds no key for it. It is a real delegate — its key '
          + 'is on another machine, or was never kept. A delegate is its key, not the application running it.';
      head.appendChild(chip);
      const sc = el('span', 'cap ' + (d.writeEligible ? 'held' : 'withheld'), d.scope ?? 'scope not reported');
      sc.title = d.writeEligible ? 'This scope may publish to your pod.' : 'This scope cannot publish, so this delegate cannot write.';
      head.appendChild(sc);
      item.appendChild(head);
      item.appendChild(el('div', 'iri', d.agentId));
      if (d.validFrom) item.appendChild(el('div', 'note', 'delegated ' + d.validFrom));
      const rowb = el('div', 'row');
      const rev = el('button', 'danger sm', 'Revoke');
      rev.title = 'Withdraws the delegation on your own pod. Unilateral: it does not need the delegate to cooperate or '
        + 'even to be running. What it already wrote stays — it is on your pod and revocation cannot reach it — and it '
        + 'stays attributed to the delegate.';
      rev.addEventListener('click', () => { void revokeDelegateRow(d.agentId); });
      rowb.appendChild(rev);
      if (held) {
        const forget = el('button', 'sm', 'Forget its key here');
        forget.title = 'Deletes the key from THIS machine only. It is NOT a revocation: the delegation stays on your pod '
          + 'and still authorises this agent. Revoke is the other button.';
        forget.addEventListener('click', () => { void forgetDelegate(d.agentId); });
        rowb.appendChild(forget);
      }
      item.appendChild(rowb);
      list.appendChild(item);
    }
  }
  // Agents that are not delegates. Named, because "who can write to my pod" is a question this
  // card is now the natural place to answer, and silence about them would be an odd omission.
  for (const o of roster?.others ?? []) {
    const item = el('div', 'item');
    const head = el('div');
    head.appendChild(el('b', undefined, o.label ?? 'unlabelled agent'));
    head.appendChild(el('span', 'cap', 'not a delegate'));
    item.appendChild(head);
    item.appendChild(el('div', 'iri', o.agentId));
    item.appendChild(el('div', 'note', 'An agent you have authorised whose row carries no delegate label — your own '
      + 'sessions and a chat conduit both look like this. It can write to your pod, and nothing it writes is attributed '
      + 'to it as an author: a conduit carries YOUR words, so those entries are yours.'));
    list.appendChild(item);
  }

  // ── keys this machine holds that the pod does not authorise ────────────────
  const orphan = clear($('delegatekeys'));
  if (!S.hostedRead) {
    orphan.appendChild(el('div', 'note', 'Checking which delegate keys this machine holds…'));
  } else if (S.hostedError) {
    orphan.appendChild(errBox(S.hostedError, 'This app could not list the delegate keys it holds, so what it can drive from here is not established.'));
  } else {
    const unauthorised = S.hosted.filter((h) => !(roster?.read && h.agentId && roster.rows.some((r) => r.agentId === h.agentId)));
    for (const h of unauthorised) {
      const item = el('div', 'item');
      item.appendChild(el('b', undefined, 'A key with no delegation'));
      item.appendChild(el('div', 'iri', h.agentId ?? h.address));
      item.appendChild(el('div', 'note', h.agentId
        ? 'This machine holds this delegate\'s key and your pod does not list it, so it may not write anything. '
          + 'Authorise it below, or forget the key.'
        : (h.why ?? 'this delegate has not signed in during this run')
          + ', so which agent id your pod would have to authorise is not established. Sign it in by authorising it below.'));
      const rowb = el('div', 'row');
      if (h.agentId) {
        const use = el('button', 'sm', 'Authorise this one');
        use.addEventListener('click', () => {
          inp('delegateagent').value = h.agentId as string;
          renderDelegatePlan();
          inp('delegatename').focus();
        });
        rowb.appendChild(use);
      }
      const forget = el('button', 'danger sm', 'Forget this key');
      forget.addEventListener('click', () => { void forgetDelegateByAddress(h.address); });
      rowb.appendChild(forget);
      item.appendChild(rowb);
      orphan.appendChild(item);
    }
  }

  renderDelegatePlan();

  // ★ THE FRESHLY MINTED KEY, SHOWN ONCE. An identity that cannot leave this installation is one
  // the installation owns, and a delegate is not owned by its host. This is the only moment the
  // key is available, and the copy says so rather than implying it can be found again later.
  const keybox = clear($('delegatekeyout'));
  if (S.mintedKey) {
    const p = el('div', 'panel pending');
    p.appendChild(el('h4', undefined, 'This delegate\'s key — copy it now or accept losing it'));
    p.appendChild(el('div', undefined, 'This is the whole of the identity. Anyone holding it IS this delegate, in this '
      + 'app or any other. It is stored encrypted by your OS on this machine and this app will not show it again — '
      + 'not because it is deleted, but because a screen that offers a private key on demand is a screen that offers it '
      + 'to whoever is looking at yours.'));
    const k = el('div', 'iri', S.mintedKey.privateKey);
    k.style.userSelect = 'text';
    p.appendChild(k);
    p.appendChild(el('div', 'note', 'Its agent id — the public half, and the string you authorise — is ' + S.mintedKey.agentId));
    const done = el('button', 'sm', 'I have it, hide this');
    done.addEventListener('click', () => { S.mintedKey = null; renderDelegates(); });
    p.appendChild(done);
    keybox.appendChild(p);
  }
}

/** The exact `register_agent` call, drawn before it is made. Same discipline as the Discord link. */
function renderDelegatePlan(): void {
  if (!document.getElementById('delegateplan')) return;
  const box = clear($('delegateplan'));
  const plan = delegateFormPlan();
  btn('delegateauthorise').disabled = !plan?.call;
  if (!plan) {
    box.appendChild(el('div', 'note', 'Mint a delegate or paste one you already have, give it a name, and the exact call '
      + 'this app would make appears here before anything is sent.'));
    return;
  }
  if (!plan.call) {
    for (const p of plan.problems) box.appendChild(el('div', 'hint bad', p.why));
    return;
  }
  const p = el('div', 'panel pending');
  p.appendChild(el('h4', undefined, 'This is the exact call, and it has not been made'));
  p.appendChild(kvPair(Object.entries(plan.call.args).map(([k, v]) => [k, String(v)] as [string, string])));
  for (const l of plan.limits) p.appendChild(el('div', 'note', l));
  box.appendChild(p);
}

async function mintDelegate(): Promise<void> {
  btn('delegatemint').disabled = true;
  try {
    const got = await window.interego.delegateMint();
    S.mintedKey = { address: got.address, agentId: got.agentId, privateKey: got.privateKey };
    inp('delegateagent').value = got.agentId;
    await loadDelegates();
    say('delegateresult', 'pending', 'A delegate identity exists; your pod does not authorise it yet',
      'Minting a key is not authorising anything. Give it a name and publish the delegation on your own pod — that row '
      + 'is what lets it write, and revoking it is what stops it.');
  } catch (e) {
    clear($('delegateresult')).appendChild(errBox(e, 'No delegate was minted.'));
  }
  btn('delegatemint').disabled = false;
}

async function importDelegate(): Promise<void> {
  const pk = inp('delegateimportkey').value.trim();
  if (!pk) return;
  btn('delegateimport').disabled = true;
  try {
    const got = await window.interego.delegateImport(pk);
    inp('delegateagent').value = got.agentId;
    // Cleared immediately: a private key sitting in an input is a private key on screen.
    inp('delegateimportkey').value = '';
    await loadDelegates();
    say('delegateresult', 'ok', 'This machine now holds that delegate\'s key',
      'It is the SAME delegate it is anywhere else — its id is a function of the key, not of this app, so entries it '
      + 'wrote elsewhere are its entries. Whether it may write to your pod is a separate question, answered by the '
      + 'delegation row: ' + got.agentId);
  } catch (e) {
    clear($('delegateresult')).appendChild(errBox(e, 'Nothing was imported and nothing was stored.'));
  }
  btn('delegateimport').disabled = false;
}

async function authoriseDelegate(): Promise<void> {
  if (!S.client || !S.viewer) return;
  const plan = delegateFormPlan();
  if (!plan?.call) { renderDelegatePlan(); return; }
  btn('delegateauthorise').disabled = true;
  let out;
  try {
    out = await publishDelegation(delegatePort(S.client), { plan, verifyOnPod: S.viewer.podName });
  } catch (e) {
    clear($('delegateresult')).appendChild(errBox(e, 'The delegation was not published.'));
    btn('delegateauthorise').disabled = false;
    return;
  }
  btn('delegateauthorise').disabled = false;
  const p = say('delegateresult', out.kind === 'published' ? 'ok' : out.kind === 'unconfirmed' ? 'pending' : 'refused',
    out.kind === 'published' ? 'Authorised, and read back from your own pod'
      : out.kind === 'unconfirmed' ? 'Accepted, but not confirmed by reading your pod back' : 'Not authorised',
    out.why);
  if (out.rescopedFrom) {
    p.appendChild(el('div', 'note', 'This agent was already registered with scope ' + out.rescopedFrom
      + ' and has now been changed. That is a change to authority you had already granted, not a new one.'));
  }
  p.appendChild(checkList(delegationChecks(out)));
  await loadDelegates();
}

async function revokeDelegateRow(agentId: string): Promise<void> {
  if (!S.client || !S.viewer) return;
  const out = await revokeDelegation(delegatePort(S.client), { agentId, podName: S.viewer.podName });
  const p = say('delegateresult', out.kind === 'revoked' ? 'ok' : 'refused',
    out.kind === 'revoked' ? 'Revoked' : 'Not revoked', out.why);
  p.appendChild(el('div', 'note', 'What this delegate already wrote is untouched. It lives in your log on your own pod, '
    + 'it still names the delegate as its author, and revoking cannot reach it — which is the point: the record of what '
    + 'was said, and by whom, survives the withdrawal of permission to say more.'));
  // A revoked delegate must stop being the one speaking here, at once, rather than at the next
  // poll. `decideTurn` would refuse anyway; leaving it selected would still read as "on".
  if (S.speaking === agentId) { S.speaking = null; setAgent(false); }
  await loadDelegates();
}

async function forgetDelegate(agentId: string): Promise<void> {
  const h = S.hosted.find((x) => x.agentId === agentId);
  if (!h) return;
  await forgetDelegateByAddress(h.address);
}

async function forgetDelegateByAddress(address: string): Promise<void> {
  await window.interego.delegateForget(address);
  if (S.speaking && !S.hosted.some((h) => h.agentId === S.speaking && h.address !== address)) {
    S.speaking = null;
    setAgent(false);
  }
  await loadDelegates();
  say('delegateresult', 'pending', 'This machine no longer holds that key',
    'That is NOT a revocation. The delegation is still on your pod and still authorises that agent — anything else '
    + 'holding the key can still write with it. Use Revoke to withdraw the authority itself.');
}

// ── the delegate loop ────────────────────────────────────────────────────────

/**
 * ★ OFF BY DEFAULT, AND ITS DRAFT GOES IN THE COMPOSER RATHER THAN ONTO THE POD.
 *
 * An agent that writes on somebody's behalf without them seeing it is not a feature. So: the loop
 * starts off; turning it on says so on screen; every draft is put in the composer for the person
 * to read and send with the SAME button and the SAME compare-and-swap append they would use
 * themselves; and posting without review is a separate checkbox they have to tick.
 *
 * ★ AND THERE IS NO SECOND WRITE PATH. `post()` is the only thing in this file that appends an
 * entry, before and after this loop existed. What a delegate changes is the ARGUMENT — `post(as)`
 * names the delegate as the author and routes the call through the delegate's own relay session —
 * not the writer. An agent with its own writer would be an agent whose writes did not go through
 * the readback, the 412 retry, or the shape assertion.
 *
 * ★ AND A DRAFT LANDING IN THE COMPOSER IS NOT AN INVITATION TO PRESS Post. The Post button posts
 * as the PERSON. A delegate's draft has to be sent with the delegate's own button, or reviewing it
 * would silently convert a delegate's words into the person's. `renderAgent` draws both and says
 * which is which.
 */
/**
 * How many times this client will try to answer one entry before leaving it alone.
 *
 * Two, not one: a model can simply have a bad turn, and one retry is cheap. Deterministic
 * refusals — over the length cap, no footing, an empty answer — produce the same result every
 * time, and each attempt is a real model turn on the person's own subscription.
 */
const ATTEMPT_LIMIT = 2;

/** The entries this client has stopped trying to answer, because trying again produced the same refusal. */
function givenUp(): readonly string[] {
  return [...A.attempts.entries()].filter(([, n]) => n >= ATTEMPT_LIMIT).map(([url]) => url);
}

/**
 * ★ THE GIVE-UP COUNTS, KEPT ACROSS RESTARTS. See `A.attempts` for why this has to outlive the
 * process: the in-run set is cleared on purpose, and the durable half of the dedupe can only
 * record answers that were WRITTEN — so a draft that is refused leaves no trace anywhere, and the
 * same question is picked again on the next launch, forever.
 *
 * Keyed per workspace so one channel's stuck entry cannot silence another's.
 */
function attemptsKey(): string {
  return 'wsp:attempts:' + (S.workspace ?? 'none');
}

function loadAttempts(): Map<string, number> {
  try {
    const raw = localStorage.getItem(attemptsKey());
    if (!raw) return new Map();
    const o = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(o).filter(([, v]) => typeof v === 'number'));
  } catch { return new Map(); }
}

function saveAttempts(m: Map<string, number>): void {
  // ★ BOUNDED. This is keyed by descriptor URL and would otherwise grow for the life of the
  // install; a channel that has run for a year should not carry every entry it ever skipped.
  const entries = [...m.entries()].slice(-200);
  try { localStorage.setItem(attemptsKey(), JSON.stringify(Object.fromEntries(entries))); } catch { /* storage may be denied */ }
}

const A = {
  on: false,
  /** Post without asking. Opt-in, never remembered across a restart, never on by default. */
  auto: false,
  phase: 'off' as 'off' | 'watching' | 'thinking' | 'drafted' | 'stopped',
  why: '',
  busy: false,
  /**
   * Descriptor URLs this run has already drafted an answer to.
   *
   * ★ THE PRIMARY DEDUPE, because it is the only input another member cannot influence. `at` comes
   * from `validFrom`, which comes from the optional `valid_from` argument to `publish_context` — a
   * number the entry's own author chose. See `TurnInput.answeredHere`.
   */
  answered: new Set<string>(),
  /**
   * ★★ ENTRIES THIS CLIENT TRIED TO ANSWER AND COULD NOT — COUNTED, AND KEPT ACROSS RESTARTS.
   *
   * REPORTED FROM A LIVE CHANNEL: "the agent keeps responding to things it's already responded to
   * every time I log in and enable the agent." The cause is a loop with no exit:
   *
   *   1. a draft is refused — over the length cap, no footing declared, empty
   *   2. the refusal path returns WITHOUT recording anything: `A.answered` is only added to once a
   *      draft exists, and `prov:wasDerivedFrom` only exists once an entry is written
   *   3. so the question is still "unanswered", by both halves of the dedupe
   *   4. `decideTurn` picks the OLDEST unanswered entry addressed to this agent, which is that one
   *   5. the same input produces the same over-long answer, which is refused again
   *
   * Deterministic refusals cannot be fixed by trying again, and each attempt costs a real model
   * turn on the person's own subscription. So an attempt is counted here and the count SURVIVES a
   * restart — `A.answered` deliberately does not, and the durable half of the dedupe can only
   * record answers that were actually written.
   *
   * ★ COUNTED RATHER THAN BANNED, because not every refusal is permanent: the model may simply
   * have had a bad turn, and one retry is cheap. Two is where it stops.
   *
   * ★ AND GIVING UP IS SHOWN, NEVER SILENT. An agent that quietly stops answering somebody looks
   * exactly like one that is broken — which is the complaint this whole panel exists to answer.
   */
  attempts: new Map<string, number>(),
  /**
   * The delegate whose draft is sitting in the composer, and the exact text it wrote.
   *
   * ★ THE TEXT IS KEPT SO EDITING IT CHANGES WHO WROTE IT. While the box holds a delegate's words
   * verbatim, the person's own Post is withheld — pressing it would put the delegate's sentences
   * on the record as the person's, which is the corrected defect moved one button along. The
   * moment they change a character the words are theirs again, the delegate's claim on them is
   * dropped, and Post comes back.
   */
  drafted: null as {
    address: string; agentId: string; name: string | null; text: string;
    /**
     * ★ WHICH FOOTING THE DELEGATE CHOSE, HELD BESIDE THE TEXT SO THE PERSON SEES IT BEFORE IT
     * SPEAKS. The agent declares this itself — see `briefPrompt` and `checkDraft` — and the Send
     * button below spells it out, because the difference between "speaking for you" and "speaking
     * for itself" is the difference between a record you share responsibility for and one you do
     * not. Discovering that after it is on the chain is too late; the record cannot be edited.
     */
    footing: StatedFooting;
    /**
     * Which record this draft answers, held beside it so the entry can declare it.
     *
     * ★ WRITTEN INTO THE RECORD RATHER THAN ONLY REMEMBERED HERE. `A.answered` dies with this
     * process; `prov:wasDerivedFrom` is on the pod and outlives every restart, which is what stops
     * a relaunched agent answering the same ask a second time.
     */
    answering: string | null;
  } | null,
  /**
   * When this delegate last successfully said its host was running, and why not when it did not.
   *
   * ★ A FACT ABOUT A DOCUMENT THIS APP WROTE, NEVER A CLAIM THAT ANYTHING IS REACHABLE. `at` is
   * when the publish was ACCEPTED; whether other people can read it back is their read to make, and
   * this panel does not speak for it.
   */
  presence: { at: null as number | null, why: null as string | null },
  /** When the inbox was last read, and what that read established. Null `at` means never. */
  wake: { at: null as number | null, why: null as string | null },
  /** Why this delegate's capability document is not published, or null when it is. */
  advertise: null as string | null,
  /**
   * Notices that pointed at something this host would not act on, kept visible.
   *
   * ★ NOT DROPPED, DELIBERATELY. A forged notice and a genuine one looking identical from the
   * outside is the failure that makes people stop reading their inbox at all — so a refusal is
   * shown WITH the check that failed, and nothing is dispatched from it.
   */
  refusedNotices: [] as { about: string; why: string }[],
};

/** The clause the Send button and its notice both use, so the two cannot say different things. */
const footingPhrase = (f: EntryFooting): string =>
  f.kind === 'on-behalf-of' ? 'speaking for you'
    : f.kind === 'own-account' ? 'speaking for itself'
      : 'footing not stated';

/**
 * The delegate currently selected to speak, resolved against BOTH sides.
 *
 * ★ TWO SIDES, AND EITHER MISSING IS A REFUSAL RATHER THAN A FALLBACK. A delegate can speak only
 * if the POD authorises it (its row in the delegator's own registry) and this MACHINE holds its
 * key. Those are different facts about different things — the second is a keyring, the first is an
 * authorization record — and one standing in for the other is exactly the confusion this whole
 * change is about. A delegate authorised but hosted elsewhere is real and is simply not drivable
 * from here; a key held for a delegate the pod does not authorise cannot write and must not be
 * offered as if it could.
 */
function speakingDelegate(): { address: string; agentId: string; name: string | null; scope: string | null } | null {
  if (!S.speaking) return null;
  const row = S.myDelegates?.read ? S.myDelegates.rows.find((r) => r.agentId === S.speaking) ?? null : null;
  if (!row) return null;
  const key = S.hosted.find((h) => h.agentId === S.speaking) ?? null;
  if (!key) return null;
  return { address: key.address, agentId: row.agentId, name: row.name, scope: row.scope };
}

/**
 * What the person's own Post button looked like before a delegate's draft withheld it.
 *
 * Held so the withholding can be UNDONE exactly, rather than by writing `disabled = false` —
 * which would silently reopen a composer some other check had shut.
 */
let postWithheld: { was: boolean; title: string } | null = null;

function renderAgent(): void {
  if (!document.getElementById('agentcard')) return;
  /**
   * ★ AN UNREAD ROSTER IS NOT AN EMPTY ONE, AND HIDING THE PANEL SAID IT WAS.
   *
   * `S.seats` is `[]` both when nobody is seated and when the fold never ran — a convener pod that
   * did not answer leaves the same empty array `teardownWorkspace` set. Hiding the panel on that
   * drew "you are not seated" as an established fact, silently, from a read that failed. So the
   * panel is shown whenever a roster read has HAPPENED, and `decideTurn`'s own `not-seated` reason
   * — which it was already composing and the shell could never display — is what appears in it.
   */
  const rosterRead = !!S.fold || S.seats.length > 0;
  const seated = !!S.seats.find((s) => s.seated && s.pod === S.viewer?.podName);
  $('agentcard').hidden = !rosterRead;
  if (rosterRead && !seated) {
    btn('agenttoggle').disabled = true;
    clear($('agentstate')).appendChild(document.createTextNode('Unavailable'));
    clear($('agentwhy')).appendChild(document.createTextNode(
      'You are not seated in this workspace, so there is no log of yours for an agent to write to. '
      + 'The roster above says which half is missing.'));
    return;
  }
  const provider = usableProvider();
  const speaker = speakingDelegate();
  /**
   * ★ WHICH DELEGATE SPEAKS IS A CHOICE, AND IT IS DRAWN AS ONE.
   *
   * A person may have several delegates authorised at once, and exactly one of them may be
   * driving this channel. The picker lists every delegate their POD authorises and disables the
   * ones this machine holds no key for — those are real delegates hosted somewhere else, and
   * hiding them would make this app's keyring look like the person's roster.
   */
  const pick = $('agentwho') as HTMLSelectElement;
  const before = pick.value;
  clear(pick);
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Nobody — choose a delegate';
  pick.appendChild(none);
  const roster = S.myDelegates;
  for (const d of roster?.delegates ?? []) {
    const o = document.createElement('option');
    o.value = d.agentId;
    const held = S.hosted.some((h) => h.agentId === d.agentId);
    o.disabled = !held || !d.writeEligible;
    o.textContent = (d.name ?? 'unnamed delegate')
      + (!d.writeEligible ? ' — scope ' + (d.scope ?? 'not reported') + ', cannot publish' : '')
      + (!held ? ' — no key on this machine' : '');
    pick.appendChild(o);
  }
  pick.value = S.speaking ?? '';
  // A delegate that disappeared from the pod between renders (revoked elsewhere) must not stay
  // selected: the select falls back to '' and the state follows it rather than the other way.
  if (pick.value !== (S.speaking ?? '')) { S.speaking = null; pick.value = ''; }
  void before;

  const toggle = btn('agenttoggle');
  toggle.textContent = A.on ? 'Stop this delegate' : 'Let this delegate speak here';
  toggle.disabled = (!provider || !speaker) && !A.on;
  inp('agentauto').checked = A.auto;
  const state = $('agentstate');
  state.textContent = A.on
    ? (A.phase === 'thinking' ? 'Thinking — on your own Claude subscription' : A.phase === 'drafted' ? 'Drafted, waiting for you' : 'Watching this channel')
    : 'Off';
  // The delegate's own Send, separate from the person's Post on purpose: the same text sent by
  // the two buttons produces two DIFFERENT records, and only one of them is true.
  const send = btn('agentsend');
  send.hidden = !A.drafted;
  // The relay's writeEligible verdict is sticky and applies to this button too — a delegate write
  // still lands on this pod, so a pod that will not take writes will not take its writes either.
  send.disabled = !!S.writeBlocked;
  if (S.writeBlocked) send.title = S.writeBlocked;
  // ★ THE BUTTON NAMES THE FOOTING, NOT JUST THE AUTHOR. "Send as Claude side" is the same button
  // whether the entry will say the person shares responsibility for it or that they do not, and a
  // person cannot consent to a distinction the control does not show them. The record is permanent.
  send.textContent = A.drafted
    ? 'Send as ' + (A.drafted.name ?? 'this delegate') + ', ' + footingPhrase(A.drafted.footing)
    : 'Send';
  if (A.drafted) {
    send.title = footingLine(A.drafted.footing, {
      who: S.viewer?.displayName ?? 'you', agentName: A.drafted.name,
    }) + ' Your delegate chose this itself; sending writes it into the record as a permanent, '
      + 'publicly readable statement that cannot be edited afterwards.';
  }
  /**
   * ★ AND THE PERSON'S OWN Post IS WITHHELD WHILE THE BOX HOLDS A DELEGATE'S WORDS VERBATIM.
   *
   * The whole correction is that the record must say who composed a sentence. A draft sitting in
   * a shared composer with a live Post button beside it hands the person a one-click way to
   * publish their delegate's prose under their own name — the same defect, moved one button
   * along, and harder to see because it looks like review. Editing a character makes the words
   * theirs and gives Post straight back; `composer`'s input listener drops `A.drafted` then.
   */
  const mine = btn('send');
  if (A.drafted && !postWithheld) {
    // ★ WHAT IT REPLACED IS REMEMBERED, so this can only ever ADD a refusal. Setting `disabled =
    // false` on the way out would UNDO a disable somebody else made — an unreadable workspace
    // record shuts the composer too, and a panel that reopened it would offer a write against a
    // shape nobody read. Every guard in this vertical is allowed to add refusals and none of
    // them may remove one.
    postWithheld = { was: mine.disabled, title: mine.title };
    mine.disabled = true;
    mine.title = 'This text was written by ' + (A.drafted.name ?? 'your delegate') + ', not by you. Post appends as YOU, '
      + 'so it is withheld while the box holds its words unchanged. Send it as the delegate with the button above, or '
      + 'edit it — the moment you change it, the words are yours and Post comes back.';
  } else if (!A.drafted && postWithheld) {
    mine.disabled = postWithheld.was || !!S.writeBlocked;
    mine.title = postWithheld.title;
    postWithheld = null;
  }
  const why = clear($('agentwhy'));
  if (!providerRead) { why.appendChild(document.createTextNode('Checking what this machine can run your agent on…')); return; }
  if (!provider) {
    // Same rule as the checklist: an empty list because the probe THREW is not a finding that
    // this machine has nothing on it.
    why.appendChild(document.createTextNode(probeFailed
      ? 'This app could not check what it can run your agent on, so whether anything is available here is not established. Nothing is being claimed either way.'
      : (providers[0]?.why ?? 'No model this app can drive was found on this machine.')
        + ' Until that is fixed there is no delegate — this app will not answer for you out of anything else.'));
    return;
  }
  if (!speaker) {
    // ★ THREE REASONS, AND THEY ARE NOT THE SAME FACT. Not read / read and empty / read and the
    // chosen one is not drivable here. Collapsing them would tell somebody with delegates on
    // another machine that they have none.
    why.appendChild(document.createTextNode(
      !roster ? 'Reading which delegates your pod authorises…'
        : !roster.read ? 'Your pod\'s delegation registry could not be read, so which delegates you have authorised is not established. ' + (roster.why ?? '')
          : !roster.delegates.length ? 'You have not authorised a delegate. Nothing here will write as you, so until there is one there is nobody to speak. Authorise one in the lobby.'
            : S.speaking ? 'That delegate is authorised on your pod and this machine holds no key for it, or its scope cannot publish. A delegate is its key — it may well be running somewhere else.'
              : 'Choose which of your delegates speaks in this channel. They are separate identities: what one writes is attributed to it and not to the others, and not to you.'));
    return;
  }
  // ★ THE MODEL PROVIDER IS NAMED AS AN IMPLEMENTATION DETAIL, BESIDE THE IDENTITY RATHER THAN AS
  // IT. Two delegates could both be running on Claude and still be two delegates; the sentence
  // must not read as though the provider were who is speaking.
  why.appendChild(document.createTextNode(A.on
    ? (speaker.name ?? 'This delegate') + ' reads this channel and drafts a reply. It writes as ITSELF, acting for you: '
      + 'entries name ' + speaker.agentId + ' as the author and you as the person it acted for, and anybody reading '
      + 'the channel can tell them from something you typed. It is running on ' + provider.label + ' under '
      + (provider.account ?? 'your own account') + ' — which is how it thinks, not who it is. '
      + (A.auto
        ? 'It will post without asking, because you ticked the box. Untick it to review first.'
        : 'It puts the draft in the box below and stops. Nothing is written until you send it AS that delegate.')
      + (A.why ? ' — ' + A.why : '')
    : (speaker.name ?? 'This delegate') + ' is off. It reads nothing and writes nothing.'));

  /**
   * ★ WHAT OTHER PEOPLE CAN SEE ABOUT THIS AGENT, SHOWN TO ITS OWNER. This is the only place a
   * person learns that switching the delegate on published something on their behalf — a short
   * signed lease, world-readable, saying its host is up. An agent whose availability is broadcast
   * without its owner being told would be a surprise, and this panel exists so there are none.
   *
   * Every clause is about a DOCUMENT this app wrote. "Said so 41s ago", never "is online": whether
   * anybody can read it back is their read to make and this panel does not speak for it.
   */
  const p = el('div', 'note');
  p.appendChild(document.createTextNode(
    !A.on ? 'While it is off it publishes nothing about itself. Its last lease lapses on its own — nothing is retracted, because a host that crashed could not retract one either, and a design that needed it to would report a crashed agent as available for ever.'
      : A.presence.at
        ? 'It last said its host was running ' + describeSpan(Date.now() - A.presence.at) + ' ago, signed with its own key on its own pod, and repeats that every '
          + describeSpan(PRESENCE_RENEW_MS) + '. Anybody holding its DID can read that — a Discord picker, another agent, a bare script — and act on it without asking you.'
        : 'It has not managed to say its host is running' + (A.presence.why ? ' (' + A.presence.why + ')' : '')
          + ', so to everybody else it reads as not running. That is the correct thing for it to read as: nothing has established that it is.'));
  if (A.on) {
    p.appendChild(el('div', 'note', A.advertise === null
      ? 'It has also published what it can be asked, at an address anybody composes from its DID — so a peer that has never heard of this channel can find it, read what it offers, and see that the way to reach it is to put a request where it reads rather than to call an endpoint it does not have.'
      : 'It has NOT managed to publish what it can be asked (' + A.advertise + '), so to a peer it offers nothing — which is not the same as it being unable to help.'));
    p.appendChild(el('div', 'note',
      A.wake.at === null
        ? 'Its inbox has not been read yet this run. Nothing depends on it — a request is an entry in the channel this app is already watching, and a notice is only a pointer at one.'
        : 'Inbox read ' + describeSpan(Date.now() - A.wake.at) + ' ago'
          // ★ THE ADDRESS IS NAMED. "Nothing was waiting" and "this read the wrong mailbox" were
          // the same sentence for a release, and the only way to tell them apart from the screen is
          // to say WHICH inbox answered — this delegate's own, which is where an ask addressed to
          // it has to be delivered.
          + (readInboxAt ? ' — ' + readInboxAt : ' — the relay named no inbox for this session')
          + (A.wake.why ? ': ' + A.wake.why : '. Nothing was waiting.')));
    for (const r of A.refusedNotices.slice(0, 3)) {
      // ★ SHOWN, NOT DROPPED. A forged notice and a genuine one looking identical from the outside
      // is how people stop reading their inbox at all.
      p.appendChild(el('div', 'note', '? a notice pointing at ' + shortRef(r.about) + ' was NOT acted on — ' + r.why));
    }
  }
  why.appendChild(p);
}

/**
 * Everything the decision needs, read out of state this shell already holds.
 *
 * ★ WHAT COULD NOT BE READ IS COUNTED, NOT DROPPED. Silently omitting a row that failed to read
 * makes a partial channel look like a complete one — and an adversarial review found what that
 * costs: lose the read of the agent's OWN latest reply and the "have I spoken since they did"
 * test compares against an older entry of its own, so it answers the same message twice, on a
 * permanent public log. `decideTurn` refuses outright when this is non-zero.
 */
function agentEntries(): { entries: SeenEntry[]; unreadable: number } {
  const entries: SeenEntry[] = [];
  let unreadable = 0;
  for (const st of S.streams.values()) {
    // A whole log this client could not read at all is the same problem one row larger.
    if (st.error || !st.loaded) { unreadable++; continue; }
    for (const r of orderChain(st.rows).ordered) {
      const b = S.bodies.get(r.url);
      // Not fetched yet, or fetched and failed: either way this row is a row nothing is known
      // about, and "not read" is not "not an entry".
      // ★ `b.note` IS PART OF THAT TEST. A descriptor whose SIGNED REGION could not be located
      // comes back with no `error` and `isEntry: false` — the shell renders it to the human as
      // "body unread · nothing here was read from bytes anybody signed", and the agent used to
      // read the same row as "not an entry" and skip it silently. If that row is the agent's own
      // newest reply, its own last word disappears from the decision and it answers again.
      if (!b || b.error || b.note) { unreadable++; continue; }
      if (!b.isEntry) continue;
      if (b.declaredWorkspace && b.declaredWorkspace !== S.workspace) continue;
      // `Date.parse(x) || null` turned the epoch into "no time", which then sorted as newest.
      // Number.isNaN is the test that actually asks the question.
      const t = r.validFrom ? Date.parse(r.validFrom) : NaN;
      entries.push({
        pod: st.pod,
        descriptorUrl: r.url,
        body: b.body,
        // ★ THIS WAS `null`, AND THAT MADE A DOCUMENTED GUARD INERT IN THIS CLIENT. `decideTurn`
        // treats `prov:wasDerivedFrom` on your own pod as the half of "have I answered this" that
        // survives a restart — the in-run set does not. Hardcoding null here meant the durable
        // half never fired in this app: the value was read into `b.derivedFrom` on the way in, used
        // for the wake path, and dropped on the way to the decision.
        derivedFrom: b.derivedFrom,
        // Read from the same signed region as the body. An entry addressed to another agent by
        // name is not this delegate's to answer, and until this was passed it answered anyway.
        addressedTo: b.addressedTo,
        at: Number.isNaN(t) ? null : t,
        // Read from the same signed region as the body, so the transcript the model sees names
        // each speaker rather than calling every entry on this pod "you".
        author: b.author,
      });
    }
  }
  return { entries, unreadable };
}

async function agentConsider(): Promise<void> {
  if (!A.on || A.busy || !S.client || !S.viewer || !S.workspace || !S.slug) return;
  const provider = usableProvider();
  if (!provider) { A.why = 'no model available'; renderAgent(); return; }
  const speaker = speakingDelegate();
  // Never step on something the person is in the middle of writing. A draft that replaced somebody
  // mid-sentence would be an agent taking the keyboard away.
  const ta = area('composer');
  if (ta.value.trim()) { A.why = 'you have unsent text in the box, so nothing was drafted over it'; A.phase = 'watching'; renderAgent(); return; }

  const read = agentEntries();
  const speaking: SpeakingDelegate | null = speaker
    ? { agentId: speaker.agentId, name: speaker.name, scope: speaker.scope } : null;
  const decision = decideTurn({
    workspace: S.workspace, slug: S.slug, mePod: S.viewer.podName,
    delegate: speaking,
    seats: S.seats, roles: S.roles.roles ? S.roles : null,
    // ★ The given-up entries ride in on `answeredHere`, which is exactly what it is for: "do not
    // draft an answer to this again". They are not claimed to have been ANSWERED anywhere on the
    // record — nothing was written, and the panel says so below.
    entries: read.entries, unreadable: read.unreadable, answeredHere: [...A.answered, ...givenUp()],
    // This shell runs the turn with the Interego MCP under the delegate's own bearer
    // whenever it can open that delegate's session — which it can whenever a delegate is
    // selected, since selection already requires a key on this machine.
    tools: true,
  });
  if (decision.kind !== 'answer') {
    A.why = decision.why;
    A.phase = 'watching';
    renderAgent();
    return;
  }

  // `speaker` cannot be null past a decision of `answer` — `decideTurn` returns `no-delegate`
  // without one — but the compiler does not know that and a cast would be this file asserting it.
  if (!speaker) { A.phase = 'watching'; renderAgent(); return; }
  A.busy = true;
  A.phase = 'thinking';
  A.why = '';
  renderAgent();
  say('agentresult', 'pending', (speaker.name ?? 'Your delegate') + ' is reading the channel',
    'Running on ' + provider.label + ' under ' + (provider.account ?? 'your own account') + '. Nothing has been written.');
  let turn;
  try {
    /**
     * ★ THE TURN RUNS AS THE DELEGATE, NOT AS THIS APP. Passing the speaker's ADDRESS lets the
     * main process open that delegate's own relay session and hand the child the Interego MCP
     * under its bearer — so the agent can read the substrate, and what it may do is the scope its
     * delegator granted rather than anything decided here. An address, never a credential: the
     * renderer must not be able to name a bearer.
     */
    turn = await window.interego.agentThink(
      briefPrompt(decision.brief, { displayName: S.viewer.displayName, delegateName: speaker.name }),
      null, speaker.address,
      /**
       * ★ WHO CAUSED THIS TURN, so a permission request is answerable.
       *
       * A gate that says "Claude Desktop wants to run `npm install`" cannot be answered safely.
       * The rest of the sentence — because THIS entry, from THIS pod, in THIS workspace — is what
       * makes it a decision rather than a guess, and this is the only place that knows it.
       */
      {
        agentName: speaker.name ?? speaker.address,
        askedBy: decision.answering.pod,
        channel: S.slug ?? S.workspace ?? 'this workspace',
      });
  } catch (e) {
    A.busy = false; A.phase = 'watching';
    clear($('agentresult')).appendChild(errBox(e, 'Your delegate could not be run, so nothing was drafted and nothing was written.'));
    renderAgent();
    return;
  }
  A.busy = false;
  // Turned off while it was thinking. The answer is discarded rather than used: "off" has to mean
  // off from the moment it is pressed, not from the end of whatever was already running.
  if (!A.on) { A.phase = 'stopped'; say('agentresult', 'refused', 'Stopped', 'You stopped this delegate while it was thinking. Its answer was discarded and nothing was written.'); renderAgent(); return; }
  if (!turn.ok || turn.text === null) {
    A.phase = 'watching';
    say('agentresult', 'refused', (speaker.name ?? 'Your delegate') + ' did not answer', turn.why);
    renderAgent();
    return;
  }
  // The principal a for-you footing would name is supplied HERE and never by the model: it chooses
  // WHICH footing, this chooses WHO — a model that could name the party would be a model that could
  // write a delegation for somebody who never granted one.
  const draft = checkDraft(turn.text, { principal: S.viewer.webId, addressed: decision.brief.addressed });
  if (!draft.ok) {
    /**
     * ★★ THE ATTEMPT IS RECORDED EVEN THOUGH NOTHING WAS WRITTEN. Without this the entry stays
     * "unanswered" by both halves of the dedupe and `decideTurn` picks it again — the same input,
     * the same refusal, every poll and every restart, each one a real model turn on the person's
     * own subscription.
     */
    const url = decision.answering.descriptorUrl;
    const tried = (A.attempts.get(url) ?? 0) + 1;
    A.attempts.set(url, tried);
    saveAttempts(A.attempts);
    if (tried >= ATTEMPT_LIMIT) A.answered.add(url);
    A.phase = 'watching';
    say('agentresult', 'pending', 'Nothing was drafted',
      draft.why + (tried >= ATTEMPT_LIMIT
        // ★ SAID OUT LOUD. An agent that quietly stops answering somebody looks exactly like one
        // that is broken, which is the complaint this panel exists to answer. It also names what
        // to do about it, because "gave up" with no remedy is just a nicer silence.
        ? ' This is attempt ' + tried + ', so your delegate will stop trying this one — the same input '
          + 'produces the same refusal, and each attempt is a real turn on your subscription. Nothing '
          + 'has been written for it. Say it again in the channel, in a way that avoids the problem above, '
          + 'and it will be treated as a new question.'
        : ' It will try once more.'));
    renderAgent();
    return;
  }
  if (ta.value.trim()) {
    A.phase = 'watching';
    say('agentresult', 'pending', 'You started typing', 'Your delegate finished a draft while you were writing, so it was discarded rather than replacing your text.');
    renderAgent();
    return;
  }
  ta.value = draft.body;
  // ★ WHOSE DRAFT THIS IS, RECORDED WITH IT. The composer holds text either the person or a
  // delegate may send, and the two produce different records. Without this the person's own Post
  // button would attribute the delegate's words to them — the very defect being corrected, moved
  // one button along.
  A.drafted = {
    address: speaker.address, agentId: speaker.agentId, name: speaker.name, text: draft.body,
    footing: draft.footing, answering: decision.answering.descriptorUrl,
  };
  // Recorded the moment the draft exists, not when it posts: a draft the user discards was still
  // an answer this run produced, and re-producing it on the next poll is the loop, not a feature.
  A.answered.add(decision.answering.descriptorUrl);
  A.phase = 'drafted';
  renderAgent();
  const p = say('agentresult', 'ok',
    A.auto ? (speaker.name ?? 'Your delegate') + ' drafted this and is posting it'
      : (speaker.name ?? 'Your delegate') + ' drafted this — read it before you send it',
    'Answering ' + shortRef(decision.answering.descriptorUrl) + '. It is in the box below and NOTHING has been written yet. '
    + 'Sending appends a permanent, public record to your pod that cannot be edited or deleted, naming '
    + speaker.agentId + ' as its author. ' + footingLine(draft.footing, {
      who: S.viewer.displayName ?? 'you', agentName: speaker.name,
    }));
  p.appendChild(kvPair([
    ['author it will carry', speaker.agentId],
    // ★ THE FOOTING IS ITS OWN ROW AND NOT FOLDED INTO THE ONE ABOVE IT. "Acting for <you>" used to
    // be printed under every draft regardless of what the draft said, which is the panel asserting
    // the thing the record was wrongly asserting. Now it reports the delegate's own answer, and
    // when that answer is "its own account" this row says so instead of naming a party.
    ['footing it declared', draft.footing.kind === 'on-behalf-of'
      ? 'speaking for you — ' + (S.viewer.webId || 'WebID not reported') + ' shares responsibility for it'
      : 'on its OWN account — you are not answerable for what it says'],
    // Named as the engine, in its own row, so it cannot be mistaken for the identity above it.
    ['model it ran on', provider.label + ' · ' + (provider.account ?? 'account not reported')],
    ['took', (turn.ms / 1000).toFixed(1) + 's'],
  ]));
  p.appendChild(el('div', 'note', 'The Post button below sends as YOU. To send this as ' + (speaker.name ?? 'your delegate')
    + ', use its own button in this panel — the same text sent by the two makes two different records, and only one of them is true.'));
  if (A.auto) await post({ address: speaker.address, agentId: speaker.agentId, footing: draft.footing, answering: decision.answering.descriptorUrl });
}

// ── the host loop: present while running, wakeable when not ──────────────────

/**
 * THE PART THAT MAKES AN AGENT A PARTICIPANT RATHER THAN A FEATURE OF THIS WINDOW.
 *
 * ★ THE TENSION THIS RESOLVES, STATED PLAINLY. An agent must think on ITS OWN human's model
 * credential — nobody else pays and no credential leaves this machine — so it is only answerable
 * while something of theirs is running. Two honest behaviours follow, and there is deliberately no
 * third:
 *
 *   1. PRESENT WHILE THIS APP IS RUNNING. {@link heartbeat} republishes a short lease every
 *      {@link PRESENCE_RENEW_MS}, signed by the delegate's OWN key on its OWN pod. Anybody
 *      anywhere — a Discord picker, another agent, a bare script — composes the address from the
 *      DID and reads it. Close this window and the lease is simply not renewed; one lease-length
 *      later the relay's own temporal filter stops answering for it. NOTHING RETRACTS ANYTHING and
 *      nothing has to notice the outage.
 *   2. ASK-AND-WAKE WHEN IT IS NOT. {@link wake} reads the inbox on start and on a slow tick, holds
 *      every pointer against the SIGNED record it points at, and lets the ordinary decision take it
 *      from there.
 *
 * ★ AND THE INBOX IS AN ACCELERANT, NOT THE SOURCE. The ask is an entry in the channel this shell
 * already reads on a watch, so a request lands whether or not any notification was ever delivered.
 * `wake` shortens the wait after a cold start; deleting it would lose latency, not correctness.
 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wakeTimer: ReturnType<typeof setInterval> | null = null;

/** How often the inbox is re-read. Far slower than presence: it is a hint, not the record. */
const WAKE_EVERY_MS = 5 * 60_000;

/** Descriptor URLs this run has already dispatched from a notice, so a re-read is not a re-ask. */
const woken = new Set<string>();

/** The inbox the relay reported for the delegate's own session on the last read. Shown, not used. */
let readInboxAt: string | null = null;

async function heartbeat(): Promise<void> {
  const speaker = speakingDelegate();
  if (!A.on || !speaker || !S.viewer) return;
  try {
    // ★ THE DELEGATE'S OWN SESSION, AND THAT IS THE WHOLE OF WHY THE LEASE IS WORTH ANYTHING. A
    // lease published through the person's session would be the person saying their agent is up,
    // which is not a thing they can know — and, measured, would not even verify: the relay binds a
    // proof's owner to the pod the bytes land on.
    const client = await delegateClient(speaker.address);
    const out = await publishPresence(agentPort(client), {
      relay: S.relay, agentId: speaker.agentId,
      // Standing, and stated for a reader's convenience. NOT a per-act claim, and not evidence of
      // the delegation either — that lives on the delegator's own pod.
      principal: S.viewer.webId || null,
      host: 'the Interego desktop app',
    });
    A.presence = out.kind === 'published'
      ? { at: Date.now(), why: null }
      : { at: null, why: out.kind === 'refused' ? out.why : out.kind === 'unnameable' ? out.why : errorCopy((out as { error: unknown }).error).t };
  } catch (e) {
    // ★ A FAILED PUBLISH IS REPORTED AND NOT RETRIED HARDER. The next beat is the retry, and until
    // one lands this agent simply reads as not-running to everybody else — which is the correct
    // thing for it to read as, because nothing established that it is.
    A.presence = { at: null, why: errorCopy(e).t };
  }
  renderAgent();
}

/**
 * Requests that arrived while this host was not running.
 *
 * ★ SIX CHECKS AGAINST THE SIGNED RECORD, NOT THE NOTICE, and the fifth is this host's own policy.
 * `admitSeatedIn` is what a workspace host means by "has standing to ask me"; the same verifier
 * serves an agent in no workspace with a different predicate, which is why it lives at the
 * substrate and takes one.
 *
 * ★ NOTHING IS DISPATCHED DIRECTLY FROM A NOTICE. A verified request only causes the ordinary
 * {@link agentConsider} to run, which re-reads the channel and applies every refusal it already
 * has — the role ceiling, the scope ceiling, "have I already answered this", "is there unsent text
 * in the box". A wake path that could write without passing those would be a second, weaker writer.
 */
async function wake(): Promise<void> {
  const speaker = speakingDelegate();
  if (!A.on || A.busy || !speaker || !S.workspace) return;
  const verdicts: RequestVerdict[] = [];
  try {
    // ★ THE DELEGATE'S OWN SESSION, WHICH IS THE ONLY INBOX IT CAN READ. Measured: the relay
    // answers `read_inbox: forbidden — you may only read your own inbox` for any other pod. So the
    // mailbox this polls is the one on the DELEGATE's pod, and for a release the ask path delivered
    // to its DELEGATOR's pod instead — a request addressed to an absent agent landing where that
    // agent cannot look, while this panel reported "nothing was waiting". The address is recorded
    // below so the two halves can be held against each other from the screen.
    const client = await delegateClient(speaker.address);
    const port = agentPort(client);
    const inbox = await readRequests(port);
    readInboxAt = inbox.inbox;
    for (const n of inbox.notices) {
      if (woken.has(n.about) || A.answered.has(n.about)) continue;
      verdicts.push(await verifyRequest(port, n, {
        heldAgentIds: [speaker.agentId],
        answeredHere: [...A.answered, ...givenUp()],
        // Every entry this shell has read that declares what it was derived from. Survives a
        // restart, which the in-run set above does not.
        derivedFromOnMyPod: derivedFromOnMyPod(),
        // ★ THE PREDICATE READS REGISTRIES NOW, so it is given something to read them with. It
        // resolves the KEY that signed a record to a seat rather than trusting the first path
        // segment of the URL the notice pointed at, which a forger writes.
        admits: admitSeatedIn({ workspace: S.workspace, seats: S.seats, port: delegatePort(client) }),
      }));
    }
  } catch (e) {
    A.wake = { at: Date.now(), why: 'the inbox could not be read (' + errorCopy(e).t + '), so whether anything is waiting is not established' };
    renderAgent();
    return;
  }
  const ok = verdicts.filter((v) => v.ok);
  // ★ A REFUSED NOTICE IS KEPT AND COUNTED, NOT DROPPED. A forged notice and a genuine one looking
  // identical from the outside is how people stop reading their inbox at all.
  A.wake = {
    at: Date.now(),
    why: verdicts.length === 0 ? null
      : ok.length + ' of ' + verdicts.length + ' item(s) pointed at a signed record addressed to this delegate'
        + (ok.length < verdicts.length ? '; the rest are shown with the check that failed' : ''),
  };
  A.refusedNotices = verdicts.filter((v) => !v.ok).map((v) => ({ about: v.about, why: v.why ?? 'no reason reported' }));
  // ★ DRAWN ON THE SUCCESS PATH TOO, WHICH IT WAS NOT. Only the catch re-rendered, so a completed
  // read — including "I read THIS inbox and it was empty" — never reached the screen, and the panel
  // went on saying the inbox had not been read this run. That is the sentence a person would use to
  // notice that requests are landing somewhere their agent cannot see.
  renderAgent();
  for (const v of ok) woken.add(v.about);
  // ★ THE CHANNEL IS WHAT IT ANSWERS FROM, so a fresh read comes first and the decision follows it.
  // `readOnce` ends in `loadBodies`, which is the one place `agentConsider` is called — so the
  // wake path reaches the SAME decision every other path reaches, with no second dispatcher.
  if (ok.length) for (const key of [...S.streams.keys()]) await readOnce(key);
}

/**
 * Say, once, what this delegate can be asked — at an address composed from its DID.
 *
 * ★ PRESENCE WITHOUT THIS IS HALF AN ANSWER. A peer that reads "its host is running" still has no
 * idea what it can be asked or by what route, and would have to guess — which is the guessing this
 * whole layer exists to remove. The two documents are a pair: one says whether anybody is home, the
 * other says what you may knock about.
 *
 * ★ `iep:askVia`, NEVER `hydra:target`, AND THAT IS THE HONEST THING TO PUBLISH. This agent runs on
 * somebody's laptop, on their own model credential, behind whatever network they are on. There is
 * no endpoint that will ever answer a POST, so advertising one would be advertising a call that
 * cannot connect. The route it publishes is the one that actually works: put a signed record where
 * it reads, and it answers when its host next runs.
 *
 * ★ AND THE ROUTE IS THE ONE THE RELAY REPORTS FOR THIS DELEGATE'S OWN SESSION, NOT ONE COMPOSED
 * HERE. This used to publish `<relay>/ns/<the HUMAN's pod>/inbox`, which is wrong twice over: it is
 * a `/ns/` graph name and 404s, so the single route a stranger holding only the DID was told to use
 * dereferenced to nothing; and it named the delegator's pod, which is not the mailbox this agent
 * polls — the relay refuses `read_inbox` for any pod but the caller's. When the pod name was
 * missing it published `…/ns//inbox` under this agent's own signature rather than refusing. What
 * goes in now is {@link agentInbox}: the address `read_inbox` reports for THIS session, which
 * `notify_agent` accepts directly and confirms as canonical. If it cannot be read, NOTHING is
 * published — an advertised route that does not work is worse than no advertisement.
 *
 * Published once per delegate per run, not on the heartbeat: what an agent can be asked does not
 * change every ninety seconds, and republishing it on a timer would be noise on somebody's pod.
 */
const advertised = new Set<string>();

async function advertise(): Promise<void> {
  const speaker = speakingDelegate();
  if (!A.on || !speaker || advertised.has(speaker.agentId)) return;
  advertised.add(speaker.agentId);
  try {
    const client = await delegateClient(speaker.address);
    const inbox = await agentInbox(agentPort(client));
    if (!inbox) {
      advertised.delete(speaker.agentId);
      A.advertise = 'the relay did not report an inbox for this delegate\'s own session, so there is no route to advertise. '
        + 'Nothing was published — a capability document naming an address nobody can deliver to is an offer a reader cannot act on.';
      renderAgent();
      return;
    }
    const out = await publishCapability(agentPort(client), {
      relay: S.relay,
      agentId: speaker.agentId,
      action: RESPOND_AS_MEMBER,
      // The inbox is where a request POINTS; the record it points at is the ask itself.
      route: { kind: 'ask', askVia: inbox },
      title: 'Answer in this channel',
      description: 'Ask this agent to read the channel and, if it judges there is something to add, append an answer '
        + 'to its own human\'s log. It decides whether to speak; asking is not instructing.',
    });
    if (out.kind !== 'published') {
      // Dropped from the set so the next switch-on retries. A capability nobody could read is not
      // a capability, and pretending it was published would make this agent look askable when it
      // has said nothing.
      advertised.delete(speaker.agentId);
      A.advertise = out.kind === 'refused' ? out.why : out.kind === 'invalid' || out.kind === 'unnameable' ? out.why : 'the publish did not complete';
    } else { A.advertise = null; }
  } catch (e) {
    advertised.delete(speaker.agentId);
    A.advertise = errorCopy(e).t;
  }
  renderAgent();
}

/**
 * Draw who the next message is addressed to, or nothing at all.
 *
 * ★ THE COPY NAMES THE CONSEQUENCE, NOT THE FEATURE. "Addressed to X" is a UI state; what is
 * actually about to happen is that a permanent public record will name that agent inside bytes
 * nobody downstream can alter, and every OTHER agent reading this channel will leave it alone.
 * A person cannot consent to a distinction the control does not show them.
 */
function renderAsk(): void {
  const row = $('askrow');
  const a = S.ask;
  row.hidden = !a;
  if (!a) return;
  const who = a.name ?? a.agentId;
  clear($('askto')).appendChild(document.createTextNode(
    'Addressed to ' + who + ', a delegate of ' + a.pod + '. Your next post names it in the signed region, so no other '
    + 'agent here will treat it as theirs to answer'
    + (a.agentPod ? '' : ' — though this client cannot derive an inbox from that id, so if its host is not running it '
      + 'will only find the ask when it next reads the channel')
    + '.',
  ));
}

/** Descriptor URLs some entry already on my own pod declares it was derived from. */
function derivedFromOnMyPod(): readonly string[] {
  const out: string[] = [];
  for (const st of S.streams.values()) {
    if (S.viewer && st.pod !== S.viewer.podName) continue;
    for (const r of orderChain(st.rows).ordered) {
      const b = S.bodies.get(r.url);
      if (b?.derivedFrom) out.push(b.derivedFrom);
    }
  }
  return out;
}

function setAgent(on: boolean): void {
  A.on = on;
  A.why = '';
  A.phase = on ? 'watching' : 'off';
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = null; }
  if (!on) {
    // Reaches the child process, not just the flag. A delegate switched off that keeps thinking
    // and then posts is the failure this whole panel exists to make impossible.
    void window.interego.agentCancel();
    clear($('agentresult'));
    // ★ NO RETRACTION IS PUBLISHED AND NONE IS NEEDED. The lease lapses on its own, which is the
    // property that makes it honest: a host that CRASHES cannot publish a retraction either, so a
    // design that depended on one would report a crashed agent as available indefinitely.
    A.presence = { at: null, why: 'this delegate is off; its last lease lapses on its own' };
  }
  renderAgent();
  if (on) {
    void agentConsider();
    void heartbeat();
    void advertise();
    void wake();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, PRESENCE_RENEW_MS);
    wakeTimer = setInterval(() => { void wake(); }, WAKE_EVERY_MS);
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

btn('signin-wallet').addEventListener('click', () => { void signIn('wallet'); });
btn('signin-browser').addEventListener('click', () => { void signIn('browser'); });
btn('signin-import').addEventListener('click', () => { void importAccount(); });
// Enter in the key field does what the button does. Somebody pasting a key and pressing return is
// the ordinary gesture, and a field that swallows it reads as broken.
inp('signin-importkey').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter' && !btn('signin-import').disabled) void importAccount();
});
// A refusal shown against the old text is a refusal about a key that is no longer there.
inp('signin-importkey').addEventListener('input', () => { clear($('signin-importhint')).className = 'hint'; });
btn('signoutbtn').addEventListener('click', () => { void signOut(); });
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
btn('askclear').addEventListener('click', () => { S.ask = null; renderAsk(); area('composer').focus(); });
area('composer').addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (!btn('send').disabled) void post(); }
});
/**
 * ★ EDITING A DELEGATE'S DRAFT MAKES THE WORDS YOURS, AND THE RECORD FOLLOWS THAT.
 *
 * The delegate wrote a specific string. While that exact string is in the box it is the
 * delegate's and only its own Send may publish it. Change anything and the sentence is no longer
 * the one it composed — so the claim is dropped, the person's Post returns, and what lands is
 * attributed to them, which is true.
 */
area('composer').addEventListener('input', () => {
  if (A.drafted && area('composer').value !== A.drafted.text) { A.drafted = null; renderAgent(); }
});

/**
 * ── WHAT THE AGENTS ASKED FOR ────────────────────────────────────────────────
 *
 * The gate refuses anything outside an agent's own workspace and writes down what it wanted. This
 * panel is the other half: without it a refusal is just a refusal, and the agent's "I've asked
 * whether I may" is a sentence pointing at nothing.
 *
 * ★ EVERY REQUEST IS SHOWN WITH WHO CAUSED IT. "Claude Desktop wants to read D:/work/notes.txt" is
 * not answerable; "…because goldenfleece asked it to, in #house" is. The approval then attaches to
 * a message on the record rather than to a dialog that appeared while somebody was making coffee —
 * and a request whose asker you do not recognise is the one you turn down.
 */
async function renderPermissions(): Promise<void> {
  let state: Awaited<ReturnType<typeof window.interego.permissionList>>;
  try { state = await window.interego.permissionList(); }
  catch (e) { clear($('permpending')).appendChild(errBox(e, 'The pending requests could not be read.')); return; }

  const { pending, nominated, grants } = state;
  $('permnote').textContent = pending.length === 0 ? 'Nothing waiting.'
    : String(pending.length) + (pending.length === 1 ? ' request waiting' : ' requests waiting');

  const box = clear($('permpending'));
  for (const r of pending) {
    const card = el('div', 'panel warn');
    card.appendChild(el('h4', undefined, r.agentName + ' wants to ' + r.what));
    // ★ The rule, verbatim, because it is what an approval actually grants — and it is COARSER
    // than the request. Approving `Bash(npm test …)` permits every `npm test`, not this one, and
    // hiding that would make the panel a misleading account of what the button does.
    card.appendChild(el('div', 'note', 'Approving permits: ' + r.rule));
    card.appendChild(el('div', 'note', 'Asked by ' + r.askedBy + ' in ' + r.channel + ' · ' + r.atIso.slice(0, 16).replace('T', ' ')));
    const row = el('div', 'row');
    const yes = el('button', 'sm', 'Allow this from now on') as HTMLButtonElement;
    const no = el('button', 'danger sm', 'No') as HTMLButtonElement;
    const answer = (approve: boolean): void => {
      yes.disabled = true; no.disabled = true;
      void window.interego.permissionAnswer(r.id, approve)
        .then((res) => { say('permresult', res.ok ? 'ok' : 'warn', res.why); return renderPermissions(); })
        .catch((e: unknown) => { clear($('permresult')).appendChild(errBox(e, 'That answer was not recorded.')); });
    };
    yes.addEventListener('click', () => { answer(true); });
    no.addEventListener('click', () => { answer(false); });
    row.appendChild(yes); row.appendChild(no);
    card.appendChild(row);
    box.appendChild(card);
  }

  const where = clear($('permwhere'));
  where.appendChild(el('div', 'note', nominated.length === 0
    ? 'Agents can only work in their own workspace folder. Nominate a project and they can work there too, without asking.'
    : 'Agents may also work in:'));
  for (const dir of nominated) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'note', dir));
    const off = el('button', 'danger sm', 'Stop') as HTMLButtonElement;
    off.addEventListener('click', () => {
      off.disabled = true;
      void window.interego.permissionUnnominate(dir)
        .then((res) => { say('permresult', 'ok', res.why); return renderPermissions(); })
        .catch((e: unknown) => { clear($('permresult')).appendChild(errBox(e, 'That directory was not removed.')); });
    });
    row.appendChild(off);
    where.appendChild(row);
  }

  // ★ STANDING GRANTS ARE LISTED AND REVOCABLE. A permission you cannot see is one you cannot
  // remember giving, and "approve once, forever, invisibly" is how a boundary erodes without
  // anybody deciding to erode it.
  const g = clear($('permgrants'));
  if (grants.length > 0) {
    g.appendChild(el('div', 'note', 'Already allowed, so they no longer ask:'));
    for (const grant of grants) {
      const row = el('div', 'row');
      row.appendChild(el('span', 'note', grant.rule + ' · since ' + grant.grantedIso.slice(0, 10)));
      const off = el('button', 'danger sm', 'Withdraw') as HTMLButtonElement;
      off.addEventListener('click', () => {
        off.disabled = true;
        void window.interego.permissionRevoke(grant.rule)
          .then((res) => { say('permresult', 'ok', res.why); return renderPermissions(); })
          .catch((e: unknown) => { clear($('permresult')).appendChild(errBox(e, 'That grant was not withdrawn.')); });
      });
      row.appendChild(off);
      g.appendChild(row);
    }
  }
}

/**
 * ── WHAT THE AGENTS COST ─────────────────────────────────────────────────────
 *
 * ★ EVERY FIGURE IS COPIED FROM SOMETHING THAT MEASURED IT. The CLI reports `usage`, `num_turns`
 * and `total_cost_usd` for each turn; the permission gate records one line per tool call. Both
 * were already being produced — the tokens were parsed and thrown away, and the tool calls were
 * never joined to a turn. So nothing here is an estimate, and where a number is missing it shows
 * as zero rather than as a guess.
 */
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

async function renderTelemetry(): Promise<void> {
  let state: Awaited<ReturnType<typeof window.interego.telemetryRead>>;
  try { state = await window.interego.telemetryRead(200); }
  catch (e) { clear($('telsummary')).appendChild(errBox(e, 'The turn records could not be read.')); return; }

  const { turns, totals: t } = state;
  $('telnote').textContent = t.turns === 0
    ? 'No turns recorded yet — this fills in as your agents answer.'
    : t.turns + (t.turns === 1 ? ' turn recorded' : ' turns recorded') + ' on this machine';

  const box = clear($('telsummary'));
  if (t.turns === 0) { clear($('telwho')); clear($('telrecent')); return; }
  box.appendChild(kvPair([
    ['tokens in', fmt(t.inputTokens)],
    ['tokens out', fmt(t.outputTokens)],
    // Cache reads are shown separately because they are most of the volume and a fraction of the
    // price — folding them into "tokens in" would make every number look alarming and wrong.
    ['cache read', fmt(t.cacheReadTokens)],
    ['cache write', fmt(t.cacheCreationTokens)],
    ['tool calls', String(t.toolCalls)],
    ['asked / denied', t.asked + ' / ' + t.denied],
    ['cost', '$' + t.costUsd.toFixed(4)],
  ]));

  const who = clear($('telwho'));
  const rank = (label: string, m: Readonly<Record<string, number>>): void => {
    const rows = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!rows.length) return;
    who.appendChild(el('div', 'note', label));
    who.appendChild(kvPair(rows.map(([k, v]) => [k, fmt(v) + ' tokens'] as const)));
  };
  rank('by agent', t.byAgent);
  // ★ Who ASKED, not only which agent answered. A bill nobody can attribute to a person is a
  // number; attributed, it is a conversation about who is driving the machine and how hard.
  rank('by who asked', t.byAsker);

  const recent = clear($('telrecent'));
  recent.appendChild(el('div', 'note', 'most recent turns'));
  for (const r of turns.slice(0, 8)) {
    const line = el('div', 'step ' + (r.ok ? 'done' : 'err'));
    line.appendChild(el('span', 'mark', r.ok ? '✓' : '×'));
    const txt = el('span', 'txt', r.atIso.slice(5, 16).replace('T', ' ') + '  ' + r.agentName
      + '  ' + fmt(r.inputTokens + r.outputTokens) + ' tok'
      + '  ' + r.toolCalls + ' tools'
      + (r.asked ? '  ' + r.asked + ' asked' : '')
      + (r.askedBy ? '  · ' + r.askedBy : ''));
    line.appendChild(txt);
    recent.appendChild(line);
  }
}

btn('telrefresh').addEventListener('click', () => { void renderTelemetry(); });

btn('permnominate').addEventListener('click', () => {
  void window.interego.permissionNominate()
    .then((res) => { if (res.why) say('permresult', res.ok ? 'ok' : 'warn', res.why); return renderPermissions(); })
    .catch((e: unknown) => { clear($('permresult')).appendChild(errBox(e, 'That directory was not nominated.')); });
});

/**
 * ★ POLLED, BECAUSE THE WRITER IS ANOTHER PROCESS. The gate is a fresh subprocess per tool call
 * with no way back into this window, so nothing pushes here — a request arriving while the app is
 * open would otherwise sit unseen until the next restart, which for an agent waiting on an answer
 * is the same as never. Ten seconds is far below the time anybody takes to notice and answer.
 */
void renderPermissions();
void renderTelemetry();
setInterval(() => { void renderPermissions(); void renderTelemetry(); }, 10_000);
btn('save').addEventListener('click', () => { void doSave(false); });
btn('stalesave').addEventListener('click', () => { void doSave(true); });
btn('modelrecheck').addEventListener('click', () => { providerRead = false; renderModelCard(); void loadProviders(); });
inp('botagent').addEventListener('input', renderDiscordPlan);
inp('discorduser').addEventListener('input', renderDiscordPlan);
btn('discordlink').addEventListener('click', () => { void linkDiscord(); });
btn('discordrevoke').addEventListener('click', () => { void revokeDiscord(); });
btn('agenttoggle').addEventListener('click', () => { setAgent(!A.on); });
inp('agentauto').addEventListener('change', () => {
  A.auto = inp('agentauto').checked;
  renderAgent();
});
($('agentwho') as HTMLSelectElement).addEventListener('change', (e) => {
  S.speaking = (e.target as HTMLSelectElement).value || null;
  // Switching which delegate speaks stops the one that WAS speaking. Carrying "on" across the
  // change would hand a turn started by one identity to another.
  if (A.on) setAgent(false);
  A.drafted = null;
  renderAgent();
});
// ★ THE DELEGATE'S OWN SEND. `post(as)` — same writer, same readback, different author.
btn('agentsend').addEventListener('click', () => {
  if (A.drafted) void post({ address: A.drafted.address, agentId: A.drafted.agentId, footing: A.drafted.footing, answering: A.drafted.answering });
});
inp('delegatename').addEventListener('input', renderDelegatePlan);
inp('delegateagent').addEventListener('input', renderDelegatePlan);
btn('delegatemint').addEventListener('click', () => { void mintDelegate(); });
btn('delegateimport').addEventListener('click', () => { void importDelegate(); });
btn('delegateauthorise').addEventListener('click', () => { void authoriseDelegate(); });
window.addEventListener('beforeunload', () => { S.watches.forEach((u) => { try { u(); } catch { /* already gone */ } }); });

// A bare `describe()` left any throw as an unhandled rejection with a sign-in card on screen
// forever — a client reporting a permanent benign state for a crash.
void describe().catch((e: unknown) => {
  clear($('signinnote')).appendChild(errBox(e, 'This client failed while starting up, so nothing below was read.'));
});

/**
 * ★ THE LAST LINE, AND THE ONLY EVIDENCE THAT EVERY LINE ABOVE IT RAN.
 *
 * `did-finish-load` fires whether or not this script threw — an uncaught exception in a renderer
 * is not a crash, not a failed load, and not `render-process-gone`. So the launch smoke could
 * watch the page load perfectly while the renderer had died on its second statement, and CI would
 * be green over a window showing a half-built screen.
 *
 * That is not hypothetical for this file: `$` THROWS on an element it cannot find, and the wiring
 * at the bottom looks up a dozen ids by hand. Rename one in `index.html` and everything after it
 * silently stops existing. The smoke reads this marker, so "the renderer ran to the end" becomes a
 * fact CI can check rather than an assumption it makes.
 */
(window as unknown as { __interegoBooted?: boolean }).__interegoBooted = true;
