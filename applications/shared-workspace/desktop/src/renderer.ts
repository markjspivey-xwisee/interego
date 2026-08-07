/**
 * The walking skeleton's UI: boot -> authenticate -> read a workspace -> roster + stream ->
 * post an entry onto the user's own pod.
 *
 * ★ EVERY SUBSTRATE DECISION IN HERE COMES FROM `@interego/workspace-client`. This file
 * chooses colours and DOM nodes. It does not parse Turtle, compose a member document name,
 * decide whether somebody is seated, or work out where an entry goes in a chain — the
 * published artifact makes those same decisions with the same code, which is the point.
 *
 * ★ NOTHING HERE FETCHES A DESCRIPTOR URL. They come back as
 * `http://css.railway.internal:3456/…`, an address inside the fleet. `get_descriptor` is the
 * only way to turn one into bytes from a laptop.
 */

import {
  ConnectorTransport, WorkspaceClient, foldRoster, graphRegion, hasType, orderChain,
  parseWorkspaceIri, postEntry, preconditionLine, readInt, readLiteral, toChainRow,
  entryShapeAnswer, assignPodMarks,
  type ChainRow, type ConnectorMcp, type Seat,
} from '@interego/workspace-client';
import type { BridgeFailure, WorkspaceBridge } from './preload.js';

declare global {
  interface Window { interego: WorkspaceBridge }
}

const RELAY_FALLBACK = 'https://relay.interego.xwisee.com';

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

/**
 * The IPC bridge, adapted to the transport interface the client already speaks.
 *
 * ★ THIS IS THE SECOND IMPLEMENTATION OF ONE INTERFACE AND THAT IS THE WHOLE ARCHITECTURE.
 * `ConnectorTransport` is written against `window.claude.mcp`; the bridge exposes the same
 * two operations, so the desktop reuses it instead of growing a third code path. The
 * credential — a relay OAuth bearer — never appears here: it lives in the main process, which
 * is why this side can be handed to a document that renders untrusted bytes.
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
  };
}

let client: WorkspaceClient | null = null;
let relay = RELAY_FALLBACK;
let viewerPod = '';
let seats: readonly Seat[] = [];
let podMarks = new Map<string, string>();

/**
 * The boot checklist.
 *
 * ★ COLD START IS 12–16 s ON A FRESH IDENTITY, because the first pod-aware call PROVISIONS A
 * POD. Two measured cold starts on this fleet took 12.3 s and 16.2 s; every later call in the
 * same session was around 200 ms. A spinner for sixteen seconds reads as broken, so this
 * counts up and says which step it is on.
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
  const box = clear($('steps'));
  let anyWait = false;
  for (const s of steps) {
    const r = el('div', 'step ' + s.state);
    r.appendChild(el('span', 'mark', s.state === 'done' ? '✓' : s.state === 'err' ? '✗' : '…'));
    r.appendChild(el('span', 'txt', s.text));
    if (s.state === 'wait') { anyWait = true; r.appendChild(el('span', 'el', ((Date.now() - T0) / 1000).toFixed(0) + 's')); }
    else if (s.at !== null) r.appendChild(el('span', 'el', (s.at / 1000).toFixed(1) + 's'));
    box.appendChild(r);
  }
  if (anyWait && !stepTimer) stepTimer = setInterval(renderSteps, 1000);
  if (!anyWait && stepTimer) { clearInterval(stepTimer); stepTimer = null; }
}

function failureBox(where: string, err: unknown): HTMLElement {
  const e = err as Partial<BridgeFailure> & { message?: string };
  const box = el('div', 'err');
  box.appendChild(el('h4', undefined, e?.code === 'tool_error' ? 'The relay reported a failure' : 'Could not complete the call'));
  box.appendChild(el('div', undefined, e?.message ?? String(err)));
  box.appendChild(el('div', 'note', where));
  return box;
}

// ── sign in ──────────────────────────────────────────────────────────────────

async function describe(): Promise<void> {
  const d = await window.interego.describe();
  relay = d.relay;
  $('relayline').textContent = 'Relay ' + d.relay + ' · identity server ' + d.identityServer;
  const s = $('storeline');
  clear(s);
  s.appendChild(document.createTextNode(d.secretStore
    ? 'The OS secret store is available, so a wallet key is encrypted by the operating system before it touches disk. That protects it from being copied off this machine; it does not protect it from software already running as you.'
    : 'The OS secret store is NOT available on this machine. The wallet option is offered anyway and will REFUSE rather than write a plaintext key — use browser sign-in, which holds no key at all.'));
  if (d.hasStoredWallet) s.appendChild(el('div', 'note', 'A wallet key is already stored here, so signing in with it returns to the same pod.'));
}

async function signIn(kind: 'wallet' | 'browser'): Promise<void> {
  const btns = [$('signin-wallet'), $('signin-browser')] as HTMLButtonElement[];
  btns.forEach((b) => { b.disabled = true; });
  step('auth', kind === 'wallet' ? 'Signing a SIWE message with the key in your OS secret store' : 'Waiting for you to finish signing in, in your browser', 'wait');
  try {
    const who = kind === 'wallet' ? await window.interego.signInWithWallet() : await window.interego.signInWithBrowser();
    viewerPod = who.pod;
    step('auth', 'Signed in — you are pod ' + who.pod + (kind === 'wallet' ? '' : ' (browser sign-in)'), 'done');
    if (kind === 'wallet' && 'mintedNewKey' in who && who.mintedNewKey) {
      $('signinnote').textContent = 'A new wallet key was minted and stored, so this is a brand new pod with nothing on it yet.';
    }
    $('signin').setAttribute('hidden', '');
    $('app').removeAttribute('hidden');
    $('whoami').textContent = who.pod;
    const mcp = bridgeAsMcp();
    const transport = new ConnectorTransport(mcp);
    client = new WorkspaceClient(relay, transport);
    step('connect', 'Resolving the tool surface — the first pod-aware call provisions a pod, measured at 12 to 16 seconds', 'wait');
    await client.connect();
    step('connect', 'Tool surface reachable', 'done');
  } catch (e) {
    step('auth', 'Sign-in did not complete', 'err');
    clear($('signinnote')).appendChild(failureBox('Nothing is read until a session exists — this client holds no fixtures, so with no session there is nothing to show.', e));
    btns.forEach((b) => { b.disabled = false; });
  }
}

// ── open a workspace ─────────────────────────────────────────────────────────

async function openWorkspace(iri: string): Promise<void> {
  if (!client) return;
  const parts = parseWorkspaceIri(relay, iri);
  if (!parts) {
    $('openhint').textContent = 'That is not a workspace IRI on this relay. It has to look like ' + relay + '/ns/<pod>/<short name>.';
    return;
  }
  $('openhint').textContent = '';
  clear($('roster')).appendChild(el('div', 'note', 'Reading the roster…'));
  clear($('stream')).appendChild(el('div', 'note', 'Reading one manifest per member…'));

  const read = await client.readWorkspaceRecord(iri, parts.owner).catch((e: unknown) => ({ kind: 'error' as const, error: e }));
  if (read.kind !== 'record') {
    // ★ FOUR OUTCOMES, NOT TWO. "no record is published here" and "the read failed" are
    // different facts and only one of them says anything about the world.
    const why = read.kind === 'forked' ? 'The workspace record has ' + read.heads.length + ' unresolved heads, so which record governs here is not decided.'
      : read.kind === 'missing' ? (read.unreadable ? 'The read could not be interpreted: ' + read.message : 'The relay reports nothing published at this IRI: ' + read.message)
      : 'The read of the workspace record failed.';
    clear($('roster')).appendChild(read.kind === 'error' ? failureBox(why, read.error) : el('div', 'err', why));
    clear($('stream'));
    // The composer stays SHUT: posting into a record nobody could read would assert a
    // conformance story this client cannot stand behind.
    ($('send') as HTMLButtonElement).disabled = true;
    ($('composer') as HTMLTextAreaElement).disabled = true;
    ($('composer') as HTMLTextAreaElement).placeholder = 'The workspace record could not be read, so which shape a post is validated against is not established — nothing is offered to write.';
    return;
  }

  const rec = read.record;
  $('wstitle').textContent = rec.title || parts.slug;
  $('wsiri').textContent = iri;
  currentWorkspace = { iri, owner: parts.owner, slug: parts.slug, entryShape: rec.entryShape, record: read };
  $('shapeline').textContent = rec.entryShape
    ? 'Posts here are validated against ' + rec.entryShape + ' — the shape this workspace\'s own record declares.'
    : 'This workspace\'s record was read and names no wsp:entryShape, so nothing will validate a post here.';

  const fold = await foldRoster(client, {
    workspace: iri, iriOwner: parts.owner, slug: parts.slug,
    convener: rec.convener, convenerPod: rec.convenerPod,
  }).catch((e: unknown) => { clear($('roster')).appendChild(failureBox('Grants live on the convener\'s pod; without them there are no roles to read.', e)); return null; });
  if (!fold) return;

  seats = fold.seats;
  podMarks = assignPodMarks(seats.map((s) => s.pod).concat([viewerPod]));
  renderRoster(fold.grantsFound, fold.grantsRead, fold.grantReadCap, fold.grantScanSaturated, fold.grantLimit);

  ($('composer') as HTMLTextAreaElement).disabled = false;
  ($('send') as HTMLButtonElement).disabled = false;
  await loadStreams();
}

interface OpenWorkspace {
  readonly iri: string; readonly owner: string; readonly slug: string;
  readonly entryShape: string | null;
  readonly record: Parameters<typeof entryShapeAnswer>[1];
}
let currentWorkspace: OpenWorkspace | null = null;

function renderRoster(found: number, readCount: number, cap: number, saturated: boolean, limit: number): void {
  const box = clear($('roster'));
  if (saturated) box.appendChild(el('div', 'note', 'That scan of the convener\'s pod came back full at ' + limit + ' entries, so a grant may have been cut off the end of it.'));
  if (found > readCount) box.appendChild(el('div', 'note', found + ' grants were found and ' + readCount + ' were read (the cap is ' + cap + '). Members beyond that are not on this list and this is not a claim that they are not members.'));
  for (const m of seats) {
    const row = el('div', 'member' + (m.seated ? ' seated' : ''));
    row.appendChild(el('span', 'mark', (m.pod && podMarks.get(m.pod)) ?? '??'));
    const mid = el('div', 'mid');
    mid.appendChild(el('div', 'pod', m.pod ?? 'unresolved'));
    // ★ ABSENCE IS NOT EVIDENCE. A row that is not a seat carries the REASON it is not, in
    // the fold's own words — never a blank, never "no".
    mid.appendChild(el('div', 'why', m.seated ? 'seated · ' + (m.acceptTest ?? '') : (m.why ?? 'no reason was recorded, which is itself a defect')));
    row.appendChild(mid);
    if (m.pending) row.appendChild(el('span', 'chip', 'invited'));
    if (m.revoked) row.appendChild(el('span', 'chip', 'revoked'));
    box.appendChild(row);
  }
  if (!seats.length) box.appendChild(el('div', 'note', 'The convener\'s pod was read and no grant naming this workspace was found on it.'));
}

// ── the stream ───────────────────────────────────────────────────────────────

interface Participant { readonly pod: string; readonly graph: string; readonly isYou: boolean }
interface Loaded { readonly p: Participant; rows: readonly ChainRow[]; error: unknown; walked: number; forked: boolean }
const streams = new Map<string, Loaded>();
// Keyed on (pod, graph), not the graph: two members who name the same wsp:stream would
// otherwise collapse into one entry and the first member's log would render as empty.
const streamKey = (pod: string, graph: string): string => pod + ' ' + graph;
const bodies = new Map<string, { body: string | null; seq: number | null; isEntry: boolean; note: string | null }>();

function participants(): readonly Participant[] {
  const list: Participant[] = seats.filter((m) => m.seated && m.stream && m.pod)
    .map((m) => ({ pod: m.pod as string, graph: m.stream as string, isYou: m.pod === viewerPod }));
  return list;
}

async function loadStreams(): Promise<void> {
  if (!client) return;
  streams.clear();
  const parts = participants();
  for (const p of parts) {
    const key = streamKey(p.pod, p.graph);
    const st: Loaded = { p, rows: [], error: null, walked: 0, forked: false };
    streams.set(key, st);
    try {
      const rows = (await client.manifest(p.pod, p.graph)).map(toChainRow);
      const walk = orderChain(rows);
      st.rows = walk.ordered;
      st.walked = walk.walked;
      st.forked = walk.forked;
    } catch (e) { st.error = e; }
  }
  await loadBodies();
  renderStream();
}

/** One `get_descriptor` per entry, on its author's pod, four at a time. */
async function loadBodies(): Promise<void> {
  if (!client) return;
  const wanted: { url: string; graph: string }[] = [];
  for (const st of streams.values()) for (const r of st.rows) if (!bodies.has(r.url)) wanted.push({ url: r.url, graph: st.p.graph });
  const workers = Array.from({ length: Math.min(4, wanted.length) }, async () => {
    for (;;) {
      const job = wanted.shift();
      if (!job) return;
      try {
        const d = await (client as WorkspaceClient).descriptor(job.url);
        const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', job.graph);
        // `''` is a signed block that WAS located and is empty; `null` is one that was not.
        const src = region === null ? '' : region;
        bodies.set(job.url, {
          body: readLiteral(src, 'dct:description'),
          seq: readInt(src, 'wsp:seq'),
          isEntry: hasType(src, 'wsp:Entry'),
          note: region === null ? 'the signed region of this record could not be located, so nothing here was read from bytes anybody signed' : null,
        });
      } catch (e) {
        bodies.set(job.url, { body: null, seq: null, isEntry: false, note: (e as Error)?.message ?? 'this record could not be read' });
      }
    }
  });
  await Promise.all(workers);
}

function renderStream(): void {
  const box = clear($('stream'));
  const rows: { pod: string; row: ChainRow }[] = [];
  for (const st of streams.values()) {
    if (st.error) { box.appendChild(failureBox('This member\'s log could not be read, which is not the same as their having written nothing.', st.error)); continue; }
    if (st.forked) box.appendChild(el('div', 'note', st.p.pod + '’s log has more than one entry that nothing supersedes, so its order is not decided and it is shown unordered.'));
    for (const r of st.rows) rows.push({ pod: st.p.pod, row: r });
  }
  if (!rows.length) { box.appendChild(el('div', 'note', 'No seated member’s log yielded an entry. That is a statement about what these manifests returned, not about what anybody wrote.')); return; }
  // Across members there is no shared clock and no server that orders them, so the merge is
  // by declared time and says so rather than claiming a global order.
  rows.sort((a, b) => String(a.row.validFrom ?? '').localeCompare(String(b.row.validFrom ?? '')));
  for (const { pod, row } of rows) {
    const b = bodies.get(row.url);
    const msg = el('div', 'msg' + (pod === viewerPod ? ' mine' : ''));
    const head = el('div', 'msghead');
    head.appendChild(el('span', 'mark', podMarks.get(pod) ?? '??'));
    head.appendChild(el('span', 'pod', pod));
    if (b?.seq !== null && b?.seq !== undefined) head.appendChild(el('span', 'seq', 'seq ' + b.seq));
    if (b && !b.isEntry) head.appendChild(el('span', 'chip', 'not typed wsp:Entry'));
    msg.appendChild(head);
    msg.appendChild(el('div', 'body', b?.body ?? '(this record declares no dct:description)'));
    if (b?.note) msg.appendChild(el('div', 'note', b.note));
    box.appendChild(msg);
  }
  $('streamwrap').scrollTop = $('streamwrap').scrollHeight;
}

// ── post ─────────────────────────────────────────────────────────────────────

async function post(): Promise<void> {
  const ta = $('composer') as HTMLTextAreaElement;
  const body = ta.value.trim();
  if (!body || !client || !currentWorkspace) return;
  const send = $('send') as HTMLButtonElement;
  send.disabled = true;
  ta.disabled = true;                     // locked, not emptied, until it is confirmed readable
  const seat = seats.find((m) => m.seated && m.pod === viewerPod && m.stream);
  const streamIri = seat?.stream
    ?? relay + '/ns/' + viewerPod + '/' + currentWorkspace.owner + '--' + currentWorkspace.slug + '-stream';
  const panel = clear($('postresult'));
  panel.appendChild(el('div', 'note', 'Deriving your position in your own log…'));

  const out = await postEntry(client, {
    podName: viewerPod, streamIri, workspace: currentWorkspace.iri, body,
    entryShape: currentWorkspace.entryShape,
  });

  clear(panel);
  if (out.kind === 'read-failed') { panel.appendChild(failureBox('Your own log could not be read, so no position could be derived. Nothing was written.', out.error)); }
  else if (out.kind === 'forked') {
    panel.appendChild(el('div', 'err', 'Your log has ' + out.heads + ' entries that nothing supersedes. '
      + (out.anyLinks
        ? 'Some entries here do declare supersession and these still do not resolve to one head, which is what a missed compare-and-swap looks like. Picking one would be guessing which append survived, so this posts nothing.'
        : 'No entry in this manifest reported a supersedes link at all, so every row reads as a head. That may be a genuine fork, or supersession may not have been reported for this read. This will not guess which, so it posts nothing.')));
  } else if (out.kind === 'unreachable') {
    panel.appendChild(failureBox(out.relayAnswered
      ? 'The relay answered and reported this failure. Re-read the channel before posting again.'
      : 'The relay did not answer, so whether this write ran is UNKNOWN. A write whose outcome is unknown must not be repeated automatically — re-read the channel before posting again.', out.error));
  } else if (out.kind === 'refused') {
    panel.appendChild(el('div', 'err', 'Refused' + (out.code ? ' — ' + out.code : '') + ' ' + String(out.body['error'] ?? '') + '. ' + String(out.body['message'] ?? '')));
  } else {
    const ok = el('div', 'ok');
    ok.appendChild(el('h4', undefined, out.committed ? 'Posted to your pod' : 'Accepted — landing on your pod'));
    const kv = el('div', 'kv');
    const add = (k: string, v: string): void => { kv.appendChild(el('div', 'k', k)); kv.appendChild(el('div', 'v', v)); };
    add('pod', viewerPod);
    add('wsp:seq', String(out.seq));
    add('descriptor', out.descriptorUrl ?? 'not reported by the response');
    add('shape asserted', entryShapeAnswer(out.shapeSent, currentWorkspace.record, currentWorkspace.iri));
    add('precondition', preconditionLine(out.response['precondition'], out.ifMatch, out.ifMatchKind)
      ?? 'none sent — this read found no prior entry in your log to assert against');
    const auth = out.response['authorship'] as { signed?: boolean; signer?: string; reason?: string } | undefined;
    add('authorship', auth
      ? (auth.signed ? 'signed by ' + (auth.signer ?? 'an unnamed signer') : 'not signed — ' + (auth.reason ?? 'the response gave no reason'))
      : 'sign_authorship was requested; the response did not report an authorship block');
    ok.appendChild(kv);
    panel.appendChild(ok);

    // ★ CONFIRM IT IS READABLE BACK RATHER THAN TAKING THE ACKNOWLEDGEMENT FOR IT.
    if (out.descriptorUrl) {
      let landed = false;
      for (let i = 0; i < 34 && !landed; i++) {
        await new Promise((r) => setTimeout(r, 700));
        await loadStreams();
        landed = [...streams.values()].some((st) => st.rows.some((r) => r.url === out.descriptorUrl));
      }
      if (landed) { ok.appendChild(el('div', 'note', 'Read back from your own pod.')); ta.value = ''; }
      else ok.appendChild(el('div', 'note', 'The relay took the write and it has not appeared in your log within the wait. It is probably fine; this will not call it posted on that basis. Your text is still in the composer — posting again would append a second entry.'));
    } else {
      ok.appendChild(el('div', 'note', 'The response named no descriptor URL, so there is nothing to read back and confirm. Your text is still in the composer.'));
    }
  }
  send.disabled = false;
  ta.disabled = false;
}

// ── wiring ───────────────────────────────────────────────────────────────────

($('signin-wallet') as HTMLButtonElement).addEventListener('click', () => { void signIn('wallet'); });
($('signin-browser') as HTMLButtonElement).addEventListener('click', () => { void signIn('browser'); });
($('open') as HTMLButtonElement).addEventListener('click', () => { void openWorkspace(($('wsopen') as HTMLInputElement).value.trim()); });
($('send') as HTMLButtonElement).addEventListener('click', () => { void post(); });
$('composer').addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void post(); }
});
void describe();
