/**
 * Work redesign — the browser client for the work-redesign bridge.
 *
 * A Path-A client: it reads the affordance manifest (GET /affordances?format=jsonld) and calls
 * only the targets and methods it declares. Every number shown comes from an affordance
 * response (wrd.read_records, wrd.read_calibration, or the answer to a write); every change is
 * an envelope signed by the person acting — in their own wallet, or, only in the offline demo,
 * by a persona key the demo server holds, which this page says on every screen.
 *
 * Reads are signed too. The page signs one wrd:read-records envelope per signer and pod and
 * reuses it for up to nine minutes (the bridge accepts it for fifteen, and a read spends no
 * nonce); a reused read that has gone stale is signed once more. With nothing to sign with, it
 * tries the unsigned read model, which a bridge answers only when its operator opened reads.
 *
 * Untrusted text (anything read from the pod or typed by a person) reaches the page only as
 * text nodes. No innerHTML, no style attribute: widths are set through the CSSOM, which the
 * page's Content-Security-Policy allows. localStorage keeps unsigned drafts only (the capture
 * table and valuation inputs); nothing signed or authoritative is stored there.
 */

// ── Words the page uses (prose lives here, not in the logic) ─────────────────────────────

const DEMO_BANNER = 'DEMO — keys are generated and held by this demo server. These are not signatures by real people.';
const EPHEMERAL = 'EPHEMERAL — records will not be trusted after this server restarts';
const DEMO_KEY = 'DEMO KEY — derived from a published seed';
const READ_ONLY = 'No wallet: this browser has no EIP-191 wallet, so this page cannot sign, and it reads the pod only where the bridge serves unsigned reads. Install or enable a wallet that supports personal_sign and reload; the bridge accepts only signed envelopes and never asks for a key.';
const READ_SIGNING = 'Reading this pod needs your signature too: the page asks your wallet to sign one read and reuses it for up to nine minutes.';
const READ_ENVELOPE_MS = 9 * 60 * 1000;
const SIGNING_MEANS = 'Your signature says this description of your work is right, or records why it is not. It is stored with the record, anyone who can read the pod can check it, and you can take a copy of every record about you.';
const WALLET_STEPS = [
  'Use a browser wallet that supports personal_sign (EIP-191).',
  'Ask an admin to add your wallet address to this pod\'s registry: until then the bridge refuses your signature, for reads as for changes.',
  'Press "Connect wallet" at the top of the page, then sign. The page shows the exact payload before your wallet does.',
  READ_SIGNING,
];
const PACKET_SENTENCE = 'Give this to your own AI agent; this server drafts nothing.';
const PREVIEW_LABEL = 'preview — the platform re-checks when you sign';
const NO_TOTALS = 'No totals across decisions: percentiles do not add.';
// A decision whose walk back from its current version stops short (chainUnreadable) is never shown as its whole chain.
const CHAIN_WHOLE = 'Every version of this decision';
const CHAIN_CUT = 'Versions of this decision read so far: not every version (the chain is incomplete)';
const CHAIN_CUT_PRINT = 'Not every version: the chain is incomplete.';
const chainCuts = (n) => `${n} record chain(s) do not read back to their first version: an earlier version is missing, or is not trusted. Their history is shown as incomplete, never as whole.`;
const trustCuts = (n, keys) => `${n} of them reach a version signed by a platform key this bridge no longer trusts (${keys.join(', ')}). Every change to them is refused (409) until the operator lists that address in WRD_TRUSTED_PLATFORM_ADDRESSES again: an address that signed records on this pod stays trusted for as long as the pod is used.`;
const HOLDER_WITHOUT_READ = 'Your read was refused, but anyone named in a record, or who signed one, can still take a copy of every record about their work, registered here or not. The copy keeps the platform\'s original signature; verify a download against the platform address you expect (the README gives the command).';
const LEVEL_NAMES = {
  person: 'A person does it',
  'person-with-agent-assist': 'A person does it, with an agent assisting',
  'agent-drafts-person-decides': 'An agent drafts, a person decides',
  'agent-acts-person-audits': 'An agent acts, a person audits',
  'agent-acts-within-grant': 'An agent acts within an earned grant',
};
const REGIME_NOTES = {
  Evident: 'Evident: the only regime where an agent may act within a grant.',
  Knowable: 'Knowable: valued only with expert evidence; no agent acts within a grant.',
  Emergent: 'Emergent: changes only as safe-to-fail probes, never priced.',
  Turbulent: 'Turbulent: stabilise first; no allocation change.',
};
const METRIC_NAMES = { 'weekly-cash-delta': 'weekly cash change', 'weekly-delta-if-redeployed': 'weekly change if freed hours are redeployed' };
const metricName = (m) => METRIC_NAMES[m] ?? m;
const BASIS_NAMES = { measured: 'measured', document: 'from a document', 'performer-reported': 'reported by the performer', estimate: 'estimate', 'not-applicable': 'not applicable (0)' };
const SOURCE_NAMES = { 'approved-decision': 'from an approved decision, being measured', 'measured-decision': 'from a measured, kept decision' };
const STATE_FIELDS = [
  ['performerHoursPerRun', 'Performer hours per run'],
  ['oversightHoursPerRun', 'Oversight hours per run (the person who decides or audits)'],
  ['agentCostPerRun', 'Agent cost per run'],
  ['minorFailureRate', 'Minor failure rate (0 to 1)'],
  ['minorFailureCost', 'Cost of one minor failure'],
  ['criticalFailureRate', 'Critical failure rate (0 to 1)'],
  ['criticalFailureCost', 'Cost of one critical failure'],
];
const TABS = [
  ['tasks', 'Tasks'], ['roles', 'Roles'], ['capture', 'Capture'], ['plan', 'Plan'], ['value', 'Value'],
  ['decisions', 'Decisions'], ['calibration', 'Calibration'], ['agents', 'Agents & grants'], ['me', 'My record'],
];
const TAB_OF = {
  'wrd.update_registry': 'roles', 'wrd.task_map_packet': 'capture', 'wrd.record_task_map': 'capture', 'wrd.capture_workflow': 'capture',
  'wrd.revise_task': 'tasks', 'wrd.ratify_task': 'tasks', 'wrd.classify_task': 'tasks', 'wrd.propose_allocation': 'plan',
  'wrd.value_plan': 'value', 'wrd.submit_decision': 'decisions', 'wrd.countersign_decision': 'decisions', 'wrd.record_outcome': 'decisions',
  'wrd.log_agent_run': 'agents', 'wrd.grant_autonomy': 'agents', 'wrd.revoke_grant': 'agents', 'wrd.holder_copy': 'me',
  'wrd.list_records': 'tasks', 'wrd.calibration': 'calibration', 'wrd.read_records': 'tasks', 'wrd.read_calibration': 'calibration',
  'wrd.envelope_template': 'tasks', 'wrd.read_envelope_template': 'tasks', 'wrd.demo_advance_clock': 'decisions',
};

// ── Small pure helpers ───────────────────────────────────────────────────────────────────

/** Port of @interego/core canonicalJson: keys sorted recursively, arrays in order, undefined dropped. */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    if (v[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v[k])}`);
  }
  return `{${parts.join(',')}}`;
}
const utf8Hex = (s) => `0x${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
async function sha256Hex(s) {
  if (!globalThis.crypto || !crypto.subtle) throw new Error('This browser cannot compute SHA-256 here (crypto.subtle needs https or localhost).');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const envelopeSha256 = (env) => sha256Hex(canonicalJson({ payload: env.payload, signature: env.signature }));
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Port of the published quote normalisation (wrd.task_map_packet quoteRule): NFC, straight quotes, collapsed whitespace, trim; case kept. */
const normaliseForQuote = (s) => s.normalize('NFC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/\s+/g, ' ').trim();
function previewQuote(normDoc, quote) {
  const q = normaliseForQuote(quote);
  if (q.length < 12) return { status: 'unverified', why: 'shorter than 12 characters' };
  const i = normDoc.indexOf(q);
  return i < 0 ? { status: 'unverified', why: 'not found in the document' } : { status: 'verified', start: i, end: i + q.length };
}

const store = {
  get(key) { try { const v = localStorage.getItem(key); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* the page works without storage */ } },
  drop(key) { try { localStorage.removeItem(key); } catch { /* the page works without storage */ } },
};

const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : String(a ?? ''));
const addrOfDid = (did) => String(did ?? '').replace(/^did:ethr:/, '');
const num = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
function money(n, currency) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  try { return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }); } catch { return num(n, 0); }
}
const band = (b, f) => (b ? `P10 ${f(b.p10)} · P50 ${f(b.p50)} · P90 ${f(b.p90)}` : '—');
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
const plusWeeks = (iso, w) => new Date(Date.parse(iso) + w * 7 * 86400000).toISOString();

// ── DOM ──────────────────────────────────────────────────────────────────────────────────

/** Build an element. Strings become text nodes; props set properties or attributes, never a style attribute. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'for') el.htmlFor = v;
    else if (k.startsWith('aria-') || k.startsWith('data-')) el.setAttribute(k, String(v));
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, ...kids);
  return el;
}
function add(el, ...kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false || k === '') continue;
    el.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
  return el;
}
const chip = (text, tone) => h('span', { class: `chip${tone ? ` ${tone}` : ''}`, text });
const field = (label, control) => h('div', null, h('label', null, h('span', { text: label }), h('br'), control));
const select = (options, value, on) => h('select', { on: on ? { change: on } : undefined },
  options.map(([v, t, disabled, title]) => h('option', { value: v, text: t, selected: v === value, disabled: !!disabled, title })));
const input = (value, on, props) => h('input', { ...(props || {}), value: value ?? '', on: on ? { input: on } : undefined });
const textarea = (value, on, props) => h('textarea', { value: value ?? '', ...(props || {}), on: on ? { input: on } : undefined });
const table = (head, rows) => h('div', { class: 'scroll' }, h('table', null,
  h('thead', null, h('tr', null, head.map((c) => h('th', { class: c.startsWith('#') ? 'num' : '' }, c.replace(/^#/, ''))))),
  h('tbody', null, rows)));

// ── State ────────────────────────────────────────────────────────────────────────────────

const S = {
  tools: new Map(), data: null, cal: null, mode: 'readonly', persona: '', personas: [], account: '', tab: 'tasks',
  workflow: '', plan: '', result: null, panel: null, busy: false, planForm: {}, packet: null, decisionOpen: '',
  pod: new URLSearchParams(location.search).get('pod') ?? '',
  reads: new Map(),             // signed read envelopes by signer and pod, reused for up to READ_ENVELOPE_MS
  readRefused: false,           // the last signed read was refused (401 or 403): the holder's copy is still offered
};
const data = () => S.data || {};
const reg = () => (S.data && S.data.registry) || { members: [], taskKinds: [], head: null };
/** A principal as the bridge compares it: a 0x address lower-cased, an Interego user DID (did:web:…:users:…) exactly as spelled. */
const principalKey = (a) => { const v = String(a || ''); return /^did:web:/.test(v) ? v : v.toLowerCase(); };
const member = (a) => reg().members.find((m) => m.address === principalKey(a));
const labelOf = (a) => member(a)?.label ?? short(a);
const people = () => reg().members.filter((m) => !m.softwareAgent);
const agentsList = () => reg().members.filter((m) => m.softwareAgent);
const kindsList = (all) => reg().taskKinds.filter((k) => all || !k.retired);
const personas = () => (S.personas.length ? S.personas : data().bridge?.demo?.personas ?? []);
const tasks = () => data().tasks ?? [];
const taskBy = (iri) => tasks().find((t) => t.taskIri === iri);
const taskName = (iri) => taskBy(iri)?.name ?? short(iri);
const planBy = (iri) => (data().plans ?? []).find((p) => p.planIri === iri);
function actor() {
  if (S.mode === 'demo') return personas().find((p) => p.id === S.persona)?.address ?? '';
  return S.mode === 'wallet' ? S.account : '';
}
const roles = (a) => member(a)?.roles ?? [];
const can = (role) => roles(actor()).includes(role) && !member(actor())?.softwareAgent;
const demoChip = (row) => (row && row.demo ? chip(data().demoLabel || 'scripted by the offline demo, not evidence', 'demo') : null);

// ── Talking to the bridge (only what the manifest declares) ──────────────────────────────

async function call(toolName, body) {
  const t = S.tools.get(toolName);
  if (!t) return { ok: false, status: 0, body: { error: `This bridge does not declare ${toolName}.` } };
  let url = t.path;
  const init = { method: t.method, headers: { accept: 'application/json' } };
  if (t.method === 'GET') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(body || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    if (q.toString()) url += `?${q}`;
  } else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body || {});
  }
  let res;
  try { res = await fetch(url, init); } catch (e) {
    return { ok: false, status: 0, body: { error: 'The bridge could not be reached.', 'iep:refusalReason': String(e?.message ?? e) } };
  }
  let j;
  try { j = await res.json(); } catch { j = { error: `HTTP ${res.status}: the answer was not JSON.` }; }
  return { ok: res.ok && j?.kind !== 'refusal', status: res.status, body: j };
}

class NotSigned extends Error {}

/** Sign a payload as the acting identity (or, in the demo, as a named persona). */
async function sign(payload, persona) {
  if (S.mode === 'demo') {
    // The demo server's clock is scripted: it fills issuedAt and the nonce itself.
    const r = await call('wrd.demo_envelope', { persona: persona || S.persona, payload });
    if (!r.ok) { showResult('wrd.demo_envelope', r); throw new NotSigned('demo signing refused'); }
    return r.body.envelope;
  }
  if (S.mode === 'wallet' && S.account) {
    const full = { ...payload, issuedAt: new Date().toISOString(), nonce: randomHex(16) };
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [utf8Hex(canonicalJson(full)), S.account] });
    return { payload: full, signature };
  }
  showResult('sign', { ok: false, status: 0, body: { error: 'Nothing to sign with.', 'iep:refusalReason': S.mode === 'wallet' ? 'connect your wallet first' : READ_ONLY } });
  throw new NotSigned('read only');
}

/** Sign one envelope for `intent`, POST it to `toolName` with `extra`, show the answer, re-read the pod. */
async function act(toolName, intent, fields, extra) {
  if (S.busy) return null;
  S.busy = true;
  S.result = { pending: true, tool: toolName };
  render();
  let r;
  try {
    const envelope = await sign({ intent, podUrl: data().podUrl, ...fields });
    r = await call(toolName, { envelope, ...(extra || {}) });
  } catch (e) {
    S.busy = false;
    if (!(e instanceof NotSigned)) showResult(toolName, { ok: false, status: 0, body: { error: 'Signing did not complete.', 'iep:refusalReason': String(e?.message ?? e) } });
    else render();
    return null;
  }
  S.busy = false;
  S.result = { tool: toolName, ...r };
  if (r.ok) S.panel = null;
  await refresh();
  return r.ok ? r.body : null;
}

async function send(toolName, body) {
  if (S.busy) return null;
  S.busy = true;
  S.result = { pending: true, tool: toolName };
  render();
  const r = await call(toolName, body);
  S.busy = false;
  S.result = { tool: toolName, ...r };
  if (r.ok) S.panel = null;
  await refresh();
  return r.ok ? r.body : null;
}

function showResult(tool, r) { S.result = { tool, ...r }; render(); }

/**
 * Show exactly what a write signs: the payload's schema and a template the bridge fills from the
 * pod. Reads only. When this signer holds a fresh signed read for this pod, it goes as
 * read_envelope in the POST body of wrd.read_envelope_template, never in a URL, so the bridge
 * fills the whole template; without one (or if the bridge refuses it), the unsigned GET
 * wrd.envelope_template carries only the shape and the head binding.
 */
async function showPayload(intent, args) {
  const base = { intent, pod_url: S.pod || undefined, ...(args || {}) };
  const hit = S.reads.get(`${readSigner()}|${S.pod}`);
  const fresh = readSigner() !== '' && hit && Date.now() - hit.at < READ_ENVELOPE_MS;
  let r = fresh ? await call('wrd.read_envelope_template', { ...base, read_envelope: hit.envelope }) : await call('wrd.envelope_template', base);
  if (!r.ok && fresh && (r.status === 401 || r.status === 403)) { S.reads.delete(`${readSigner()}|${S.pod}`); r = await call('wrd.envelope_template', base); }
  if (!r.ok) { showResult(fresh ? 'wrd.read_envelope_template' : 'wrd.envelope_template', r); return; }
  openPanel(`What “${intent}” signs`, h('div', null,
    h('p', { class: 'small muted', text: `${r.body.signing} Sent to ${r.body.toolName}. Fields still yours to decide: ${(r.body.fill ?? []).join(', ') || 'none'}.` }),
    r.body.contextWithheld ? h('p', { class: 'small warnbox', text: r.body.contextWithheld }) : null,
    h('h3', { text: 'Template, filled from the pod' }), h('pre', { text: JSON.stringify(r.body.template, null, 2) }),
    Object.keys(r.body.context ?? {}).length ? h('details', null, h('summary', { text: 'What the bridge read to fill it' }), h('pre', { text: JSON.stringify(r.body.context, null, 2) })) : null,
    h('details', null, h('summary', { text: 'JSON Schema' }), h('pre', { text: JSON.stringify(r.body.schema, null, 2) }))));
}
const payloadButton = (intent, args) => h('button', { class: 'small', text: 'What this signs', title: 'The payload schema and a template filled from the pod (reads only)', on: { click: () => showPayload(intent, args) } });

/** Who would sign a read now, or '' when nothing can sign. */
function readSigner() {
  if (S.mode === 'demo') return S.persona ? `demo:${S.persona}` : '';
  return S.mode === 'wallet' && S.account ? `wallet:${S.account}` : '';
}

/**
 * Send one signed read through `send`, which posts the envelope to its tool. The envelope is the
 * one this signer signed for this pod in the last nine minutes, or a new one over the template
 * wrd.envelope_template fills (which names the pod the bridge resolves). A reused envelope the
 * bridge calls stale (401: the demo's scripted clock moves) is dropped and signed once more.
 */
async function signedRead(send) {
  const key = `${readSigner()}|${S.pod}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let envelope;
    const hit = S.reads.get(key);
    const reused = Boolean(hit && Date.now() - hit.at < READ_ENVELOPE_MS);
    if (reused) {
      envelope = hit.envelope;
    } else {
      const t = await call('wrd.envelope_template', { intent: 'wrd:read-records', pod_url: S.pod || undefined });
      if (!t.ok) return t;
      try {
        envelope = await sign({ intent: 'wrd:read-records', podUrl: t.body.template.podUrl });
      } catch (e) {
        return { ok: false, status: 0, body: { error: 'The read was not signed.', 'iep:refusalReason': String(e?.message ?? e) } };
      }
      S.reads.set(key, { envelope, at: Date.now() });
    }
    const r = await send(envelope);
    if (r.status === 401 && reused && attempt === 0) { S.reads.delete(key); continue; }
    return r;
  }
  return { ok: false, status: 0, body: { error: 'The read was not signed.' } };
}

/** Re-read the pod; `quiet` keeps the answer on screen when the read is refused (a holder copy's, say). */
async function refresh(quiet = false) {
  const pod = S.pod || undefined;
  let signed = readSigner() !== '';
  let r = signed
    ? await signedRead((envelope) => call('wrd.read_records', { envelope, pod_url: pod }))
    : await call('wrd.list_records', { pod_url: pod });
  if (signed && r.status === 403) {
    // A signer with no role here still reads where the operator opened reads to anyone.
    const open = await call('wrd.list_records', { pod_url: pod });
    if (open.ok) { r = open; signed = false; }
  }
  // A signed read the bridge refused (401 or 403): the signer may still take their copy (holderCard).
  S.readRefused = !r.ok && readSigner() !== '' && (r.status === 401 || r.status === 403);
  if (r.ok) S.data = r.body;
  else if (!quiet) { S.data = null; S.result = { tool: signed ? 'wrd.read_records' : 'wrd.list_records', ...r }; }
  else S.data = null;
  if (S.data && S.tab === 'calibration') {
    const c = signed
      ? await signedRead((envelope) => call('wrd.read_calibration', { envelope, pod_url: pod }))
      : await call('wrd.calibration', { pod_url: pod });
    S.cal = c.ok ? c.body : null;
    if (!c.ok) S.result = { tool: signed ? 'wrd.read_calibration' : 'wrd.calibration', ...c };
  }
  render();
}

async function boot() {
  const root = document.getElementById('app');
  let m;
  try {
    const res = await fetch('/affordances?format=jsonld', { headers: { accept: 'application/ld+json' } });
    m = await res.json();
  } catch (e) {
    add(root, h('p', { class: 'badbox', text: `The affordance manifest could not be read: ${e?.message ?? e}` }));
    return;
  }
  for (const a of m.affordances ?? []) {
    S.tools.set(a.toolName, { path: new URL(a.target, location.href).pathname, method: a.method, title: a.title ?? a.toolName, action: a.action });
  }
  // The signer is chosen before the first read, because reading is signed: only the demo server
  // declares its persona signer, and it names its personas when asked without one.
  if (S.tools.has('wrd.demo_envelope')) {
    const r = await call('wrd.demo_envelope', {});
    S.personas = r.ok ? r.body.personas ?? [] : [];
    S.mode = 'demo';
    S.persona = S.personas.find((p) => p.id === 'ana')?.id ?? S.personas[0]?.id ?? '';
  } else if (window.ethereum) {
    S.mode = 'wallet';
  }
  window.addEventListener('hashchange', render);
  await refresh();
}

// ── Frame: header strip, tabs, result ────────────────────────────────────────────────────

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.replaceChildren();
  if (!S.data) {
    // Nothing read: still offer the way to sign a read (or another signer), and another pod. A signer
    // whose read was refused may still be named in records here (someone removed from the registry,
    // say): their copy needs no read model, so it is offered here too.
    const holder = S.readRefused && actor() ? h('section', null, h('h2', { text: 'My record' }), h('p', { class: 'small', text: HOLDER_WITHOUT_READ }), holderCard(null)) : null;
    add(root, h('h1', { text: 'Work redesign' }), resultNode(), h('div', { class: 'stack' }, signerNode()),
      S.mode === 'wallet' ? h('p', { class: 'small muted', text: READ_SIGNING }) : null, holder, podPicker());
    return;
  }
  const taskIri = taskFromHash();
  add(root,
    strip(),
    h('div', { class: 'layout' },
      h('nav', { class: 'tabs', 'aria-label': 'Views' }, TABS.map(([id, label]) => h('button', {
        'aria-current': !taskIri && S.tab === id ? 'page' : undefined, text: label,
        on: { click: () => goTab(id) },
      }))),
      h('main', null, resultNode(), panelNode(), taskIri ? taskView(taskIri) : view())));
}

function strip() {
  const d = data();
  const platform = d.bridge?.platform ?? {};
  const me = actor();
  const m = member(me);
  const altered = (d.altered ?? []).length;
  const forked = (d.forked ?? []).length;
  const untrusted = (d.untrusted ?? []).length;
  // Every graph whose line is cut, whatever its kind (a bridge that reports chainCuts), else the decisions and grants that say so.
  const cuts = Array.isArray(d.chainCuts) ? d.chainCuts.length : [...(d.decisions ?? []), ...(d.grants ?? [])].filter((x) => x.chainUnreadable).length;
  const byKey = (d.chainCuts ?? []).filter((c) => c.untrustedKey);
  return h('header', { class: 'strip' },
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h1', { text: 'Work redesign' }), h('span', { class: 'muted small' }, 'pod ', h('code', { text: d.podUrl })),
        h('button', { text: 'Re-read the pod', on: { click: refresh } }), h('details', { class: 'small' }, h('summary', { text: 'another pod' }), podPicker())),
      h('div', { class: 'row small' }, 'Platform signer ', h('code', { text: platform.address, title: platform.did }), chip(platform.keyKind ?? 'unknown'),
        platform.keyKind === 'ephemeral' ? chip(EPHEMERAL, 'bad') : null, platform.keyKind === 'demo' ? chip(DEMO_KEY, 'bad') : null),
      h('p', { class: 'small muted', text: d.readExposure }),
      d.demoRecords > 0 ? h('p', { class: 'small' }, chip('demo', 'demo'), ` ${d.demoRecords} of ${d.records} records here are ${d.demoLabel}.`) : null,
      altered + forked + untrusted > 0 ? h('p', { class: 'warnbox small' },
        `${altered} graph(s) altered after signing, ${forked} forked, ${untrusted} descriptor(s) set aside as untrusted. Altered or forked records are never used as a current version.`) : null,
      cuts > 0 ? h('p', { class: 'badbox small', text: chainCuts(cuts) }) : null,
      byKey.length > 0 ? h('p', { class: 'badbox small', text: trustCuts(byKey.length, [...new Set(byKey.map((c) => c.untrustedKey))]) }) : null,
      (d.sealed ?? []).length > 0 ? h('p', { class: 'badbox small', text: `${d.sealed.length} record(s) are sealed and this bridge cannot open them. ${d.sealedNote ?? ''}` }) : null,
      d.recordKeyMismatch ? h('p', { class: 'badbox small', text: `Another record key: ${d.recordKeyMismatch.why}` }) : null,
      d.plaintext ? h('p', { class: 'warnbox small', text: `${d.plaintext.versions} record version(s) written before the record key are plaintext on the pod. ${d.plaintext.why}` }) : null,
      d.unreadable ? h('p', { class: 'badbox small', text: `Marked, not worked out without them, because records they depend on cannot be read: ${Object.keys(d.unreadable).join(', ')}.` }) : null),
    h('div', { class: 'stack' },
      signerNode(),
      me ? h('div', { class: 'row small' }, 'Acting address ', h('code', { text: me }),
        m ? [m.roles.map((r) => chip(r)), m.softwareAgent ? chip('software agent', 'warn') : null, m.personRef ? ['person ', h('code', { text: m.personRef })] : null,
          m.principal ? ['principal ', labelOf(m.principal)] : null]
          : chip(S.persona === 'admin' ? 'admin key (signs registry changes only)' : 'not in this pod\'s registry', 'warn')) : null));
}

/** Who signs: the demo persona picker, the wallet, or why nothing can. Reads are signed as this identity too. */
function signerNode() {
  if (S.mode === 'demo') {
    return [
      h('div', { class: 'demo-banner', text: DEMO_BANNER }),
      S.data && S.tools.has('wrd.demo_advance_clock') ? demoClockNode() : null,
      h('div', { class: 'row' }, h('label', { class: 'inline', for: 'persona' }, 'Acting as'),
        h('select', { id: 'persona', on: { change: (e) => { S.persona = e.target.value; S.panel = null; S.result = null; refresh(); } } },
          personas().map((p) => h('option', { value: p.id, selected: p.id === S.persona, text: `${p.label} — ${roles(p.address).join(', ') || (p.id === 'admin' ? 'admin' : 'not registered')}` })))),
    ];
  }
  if (S.mode === 'wallet') {
    return h('div', { class: 'row' },
      S.account ? ['Signing with your wallet ', h('code', { text: S.account })] : h('button', { class: 'primary', text: 'Connect wallet', on: { click: connectWallet } }));
  }
  return h('p', { class: 'warnbox small', text: READ_ONLY });
}

/** Demo only: the demo server's clock is scripted, so a visitor's own measurement window can end only when they move it. */
function demoClockNode() {
  const weeks = input('4', null, { type: 'number', min: 1, max: 104, size: 4, 'aria-label': 'weeks' });
  return h('div', { class: 'row small' }, 'Demo clock: ', S.demoNow ? h('code', { text: when(S.demoNow) }) : 'scripted',
    weeks, h('button', { text: 'Move it forward (weeks)', on: { click: async () => {
      const out = await send('wrd.demo_advance_clock', { weeks: Number(weeks.value) });
      if (out) { S.demoNow = out.now; render(); }
    } } }));
}

/** Read another pod: the choice lives in the page address (?pod=), not in storage. */
function podPicker() {
  const box = input(S.pod, null, { placeholder: 'https://pod.example/team/ (blank: the bridge\'s default pod)', size: 44 });
  return h('div', { class: 'row' }, box, h('button', { text: 'Read this pod', on: { click: () => {
    S.pod = box.value.trim();
    const q = new URLSearchParams(location.search);
    if (S.pod) q.set('pod', S.pod); else q.delete('pod');
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`);
    S.result = null;
    refresh();
  } } }));
}

async function connectWallet() {
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    S.account = String(accounts?.[0] ?? '').toLowerCase();
  } catch (e) {
    showResult('wallet', { ok: false, status: 0, body: { error: 'The wallet did not connect.', 'iep:refusalReason': String(e?.message ?? e) } });
    return;
  }
  S.result = null;
  await refresh();
}

function resultNode() {
  const r = S.result;
  if (!r) return null;
  if (r.pending) return h('div', { class: 'card result muted', text: `Signing and sending ${S.tools.get(r.tool)?.title ?? r.tool}…` });
  const title = S.tools.get(r.tool)?.title ?? r.tool;
  const b = r.body ?? {};
  const close = h('button', { text: 'Dismiss', on: { click: () => { S.result = null; render(); } } });
  if (r.ok) {
    return h('div', { class: 'goodbox result' },
      h('div', null, h('strong', { text: title }), ' — ', chip(String(b.status ?? 'done'), 'good'), ' ', close),
      summaryOf(r.tool, b),
      h('details', null, h('summary', { text: 'The full answer' }), h('pre', { text: JSON.stringify(b, null, 2) })));
  }
  const fix = b['iep:resolvedBy'];
  return h('div', { class: 'badbox result' },
    h('div', null, h('strong', { text: `Refused${r.status ? ` — HTTP ${r.status}` : ''}` }), ` (${title}) `, close),
    h('p', { text: b.error ?? 'No answer.' }),
    b['iep:refusalReason'] ? h('p', { class: 'small muted', text: `Why: ${b['iep:refusalReason']}` }) : null,
    b.evaluation ? evaluationNode(b.evaluation) : null,
    b.expectedPayload ? h('details', null, h('summary', { text: 'The payload this tool expects (JSON Schema)' }), h('pre', { text: JSON.stringify(b.expectedPayload, null, 2) })) : null,
    fix?.toolName && TAB_OF[fix.toolName] ? h('button', { text: `What resolves it: ${S.tools.get(fix.toolName)?.title ?? fix.toolName}`, on: { click: () => goTab(TAB_OF[fix.toolName]) } }) : null,
    h('details', null, h('summary', { text: 'The full answer' }), h('pre', { text: JSON.stringify(b, null, 2) })));
}

function goTab(id) {
  S.tab = id;
  S.panel = null;
  if (taskFromHash()) history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (id === 'calibration') refresh(); else render();
}

function summaryOf(tool, b) {
  if (tool === 'wrd.classify_task') {
    return h('p', null, `${b.regime} — method ${b.method}; source ${b.regimeSource}; answered as ${b.answeredBy?.role}. Rules fired: `,
      (b.rulesFired ?? []).map((iri) => chip(ruleLabel(iri))), (b.notes ?? []).map((n) => h('div', { class: 'small', text: n })));
  }
  if (tool === 'wrd.record_task_map' || tool === 'wrd.capture_workflow') return captureResultNode(b);
  if (tool === 'wrd.propose_allocation') return h('p', { text: `A ${b.planKind} plan changing ${(b.changedTasks ?? []).length} task(s). People it names see "named by the operator, not acknowledged" until they acknowledge.` });
  if (tool === 'wrd.value_plan') return h('p', { text: `${b.reused ? 'The same plan and inputs were valued before: the existing record is returned. ' : ''}Valuation hash ${short(b.valuationHash)}; see the Value view for the full result.` });
  if (tool === 'wrd.submit_decision' && b.prediction) return h('p', { text: `Predicted ${metricName(b.prediction.metric)}: ${band(b.prediction.band, (n) => num(n, 0))} per week. Hypothetical until an approver countersigns.` });
  if (tool === 'wrd.countersign_decision') return h('p', { text: b.statusLabel });
  if (tool === 'wrd.record_outcome' && b.valued) {
    return h('p', null, chip(b.valued.verdict, b.valued.verdict === 'in-band' ? 'good' : 'warn'),
      ` measured ${num(b.valued.measured, 0)} against the ${b.valued.rampAdjusted ? 'ramp-adjusted ' : ''}band ${band(b.valued.adjustedBand, (n) => num(n, 0))}; ${b.valued.basisLabel}.`);
  }
  if (tool === 'wrd.record_outcome' && b.probes) return h('p', { text: `${b.probes.map((p) => `probe ${p.index}: ${p.signal}`).join('; ')}${b.next ? ` — ${b.next}` : ''}` });
  if (tool === 'wrd.grant_autonomy') return evaluationNode(b.evaluation);
  if (tool === 'wrd.holder_copy') {
    return h('p', { text: b.status === 'copied'
      ? `${(b.copied ?? []).filter((c) => !c.skipped).length} version(s) copied, ${(b.copied ?? []).filter((c) => c.skipped).length} already there, to ${b.targetPodUrl}.`
      : `${(b.bundle ?? []).length} record version(s) in the download.${b.platform?.address ? ` This bridge signs as ${b.platform.address}; verify the download against the address you expect.` : ''}` });
  }
  return null;
}

function panelNode() {
  if (!S.panel) return null;
  return h('section', { class: 'panel' }, h('div', null, h('strong', { text: S.panel.title }), ' ', h('button', { text: 'Close', on: { click: () => { S.panel = null; render(); } } })), S.panel.node);
}
function openPanel(title, node) { S.panel = { title, node }; render(); window.scrollTo({ top: 0 }); }

function view() {
  switch (S.tab) {
    case 'roles': return rolesView();
    case 'capture': return captureView();
    case 'plan': return planView();
    case 'value': return valueView();
    case 'decisions': return decisionsView();
    case 'calibration': return calibrationView();
    case 'agents': return agentsView();
    case 'me': return meView();
    default: return tasksView();
  }
}

// ── Shared pickers ───────────────────────────────────────────────────────────────────────

const personOptions = (blank) => [['', blank], ...people().map((m) => [m.address, `${m.label} (${m.roles.join(', ')})`])];
const agentOptions = (blank) => [['', blank], ...agentsList().map((m) => [m.address, `${m.label} — model ${m.model}`])];
const kindOptions = () => [['', 'choose a registered task kind'], ...kindsList(false).map((k) => [k.slug, `${k.label} (${k.slug})`])];
const captureLevels = () => Object.entries(LEVEL_NAMES).filter(([l]) => l !== 'agent-acts-within-grant');
const levelRule = (level) => (data().vocabulary?.levels ?? []).find((l) => l.level === level) ?? {};
const ruleLabel = (iri) => {
  const r = (data().vocabulary?.rules ?? []).find((x) => x.iri === iri);
  return r ? `${r.id}: ${r.condition}` : short(iri);
};
const partiesText = (a) => [a.personAddress ? labelOf(a.personAddress) : null, a.agentAddress ? `${labelOf(a.agentAddress)} (agent)` : null].filter(Boolean).join(' + ');
const allocationText = (a) => (a ? `${LEVEL_NAMES[a.level] ?? a.level}${partiesText(a) ? ` — ${partiesText(a)}` : ''}` : '—');

// ── View 0: the task link (shareable, for the people a task names) ──────────────────────

function taskFromHash() {
  const m = /^#task=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : '';
}

function taskView(iri) {
  const t = taskBy(iri);
  const back = h('button', { text: 'All tasks', on: { click: () => goTab('tasks') } });
  if (!t) return h('section', null, back, h('p', { class: 'badbox', text: 'No task with this link on this pod (or it has no trusted record).' }));
  const me = actor();
  const named = t.namedParties.some((p) => p.address === me);
  const owed = (t.owedRatification ?? []).some((p) => p.address === me);
  const c = t.classification;
  return h('section', null, back,
    h('h2', { text: t.name }), demoChip(t),
    h('p', { text: t.description }),
    h('p', null, statusChip(t.status), chip(`quotes ${t.quoteStatus}`), chip(t.taskKind), t.taskKindDefinition ? h('span', { class: 'small muted', text: ` ${t.taskKindDefinition}` }) : null),
    t.quotes?.length ? [h('h3', { text: 'What the document says (checked by the platform)' }), quotesNode(t.quotes)] : null,
    t.revision ? h('p', { class: 'small' }, `Revised${t.revision.note ? `: ${t.revision.note}` : ''}. It answers ${t.revision.answers.length} open dispute(s): `,
      t.revision.answers.map((a) => h('div', { class: 'quote', text: `${labelOf(a.party)}: ${a.note}` }))) : null,
    h('h3', { text: 'Who is named on this task' }),
    partiesNode(t),
    h('h3', { text: 'How knowable this work is' }),
    classificationNode(t),
    h('div', { class: 'card' }, h('strong', { text: 'What signing means' }), h('p', { text: SIGNING_MEANS }),
      S.mode !== 'demo' ? h('ol', null, WALLET_STEPS.map((s) => h('li', { text: s }))) : null),
    h('div', null,
      h('button', { class: 'primary', disabled: !(named || owed) || t.status === 'retired', title: named || owed ? '' : 'Only the people and agents named on this task (or removed from it by a revision) can ratify or dispute it.', text: 'Ratify or dispute this description', on: { click: () => ratifyPanel(t, 'description') } }),
      h('button', { disabled: !named || !c || c.state !== 'ok', title: named ? '' : 'Only the people and agents named on this task can ratify or dispute its classification.', text: 'Ratify or dispute the classification', on: { click: () => ratifyPanel(t, 'classification') } })));
}

const statusChip = (s) => chip(s, s === 'ratified' ? 'good' : s === 'disputed' ? 'bad' : s === 'retired' ? 'warn' : '');

function quotesNode(quotes) {
  return h('div', null, quotes.map((q) => h('div', { class: `quote ${q.status}` },
    chip(q.status, q.status === 'verified' ? 'good' : 'bad'), ` “${q.quote}” `,
    h('span', { class: 'small muted', text: q.status === 'verified' ? `(characters ${q.start}–${q.end} of the normalised document${q.occurrences > 1 ? `; ${q.occurrences} occurrences` : ''})` : `(${q.why}; never corrected)` }))));
}

function partiesNode(t) {
  const verdict = (p) => [p.ratification ? chip(p.ratification.verdict === 'ratify' ? 'ratified' : 'disputed', p.ratification.verdict === 'ratify' ? 'good' : 'bad') : chip('has not signed', 'warn'),
    p.ratification?.note ? h('span', { class: 'small', text: ` “${p.ratification.note}”` }) : null];
  return h('div', null, t.namedParties.map((p) => h('div', null, `${p.label} `, chip(p.kind), verdict(p))),
    (t.owedRatification ?? []).map((p) => h('div', null, `${p.label} `, chip('removed by a revision: must ratify it', 'warn'), verdict(p))));
}

function classificationNode(t) {
  const c = t.classification;
  if (!c) return h('p', { class: 'muted', text: 'Not classified yet.' });
  if (c.state !== 'ok') return h('p', { class: 'badbox', text: `The classification record is ${c.state} (trusted: no): it was changed after the platform signed it, or more than one version claims to be current. Classify the task again.` });
  const qs = data().vocabulary?.questions ?? [];
  return h('div', null,
    h('p', null, h('strong', { text: c.regime }), ` — method ${c.method} `, statusChip(c.status), c.current ? null : chip('classified against an earlier description', 'warn'),
      ` answered by ${labelOf(c.answeredBy.address)} as ${c.answeredBy.role}`),
    h('p', { class: 'small muted', text: REGIME_NOTES[c.regime] ?? '' }),
    h('div', { class: 'small' }, 'Rules fired: ', c.rulesFired.map((iri) => chip(ruleLabel(iri)))),
    c.notes.map((n) => h('div', { class: 'small', text: n })),
    table(['Question', 'Classifier', ...c.disagreement.map((d) => labelOf(d.party))],
      qs.map((q) => h('tr', null, h('td', { text: q.text }), h('td', { text: c.answers[q.id] }), c.disagreement.map((d) => h('td', { text: d.answers[q.id] }))))),
    c.ratifications.filter((r) => r.note).map((r) => h('div', { class: 'quote', text: `${labelOf(r.party)} ${r.verdict === 'ratify' ? 'ratified' : 'disputed'}: ${r.note}` })),
    c.contraryEvidence ? h('p', { class: c.contraryEvidence.suggestReclassify ? 'warnbox small' : 'small muted' },
      `${c.contraryEvidence.reviewedRuns} person-reviewed run(s); ${pct(c.contraryEvidence.reworkedShare)} not accepted; ${c.contraryEvidence.criticalFailures} critical failure(s). `,
      c.contraryEvidence.suggestReclassify ? c.contraryEvidence.note : '') : null);
}

function ratifyPanel(t, subject) {
  const head = subject === 'description' ? t.head : t.classification?.head;
  const qs = data().vocabulary?.questions ?? [];
  const own = {};
  const note = textarea('', null, { placeholder: 'Why (required to dispute)' });
  const withAnswers = h('input', { type: 'checkbox' });
  const sendVerdict = (verdict) => act('wrd.ratify_task', 'wrd:ratify-task', {
    subject, taskIri: t.taskIri, descriptorUrl: head.descriptorUrl, graphDigest: head.graphDigest, verdict,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    ...(subject === 'classification' && verdict === 'dispute' && withAnswers.checked ? { answers: { ...own } } : {}),
  });
  openPanel(`${subject === 'description' ? 'The description' : 'The classification'} of “${t.name}”`, h('div', null,
    h('p', { class: 'small', text: SIGNING_MEANS }),
    field('Note', note),
    subject === 'classification' ? h('details', null, h('summary', { text: 'Dispute with your own answers (shown beside the classifier\'s)' }),
      h('label', { class: 'inline' }, withAnswers, 'send my answers with the dispute'),
      qs.map((q) => { own[q.id] = 'unknown'; return field(q.text, select(q.options.map((o) => [o, o]), 'unknown', (e) => { own[q.id] = e.target.value; })); })) : null,
    h('button', { class: 'primary', text: 'Ratify', on: { click: () => sendVerdict('ratify') } }),
    h('button', { text: 'Dispute', on: { click: () => sendVerdict('dispute') } })));
}

// ── View 1: roles ────────────────────────────────────────────────────────────────────────

function rolesView() {
  const r = reg();
  const v = data().vocabulary ?? {};
  const gp = v.grantPolicy ?? {};
  return h('section', null,
    h('h2', { text: 'Who may act on this pod' }),
    h('p', { class: 'small muted', text: `Roles, the person an admin attests is behind each key, agents' principals and declared models. Every change is signed by an admin; this bridge has ${data().bridge?.admins ?? 0} admin address(es).` }),
    r.head ? h('p', { class: 'small' }, 'Registry version ', String(r.head.versions), ' ', demoChip(r.head)) : h('p', { class: 'warnbox', text: 'No registry yet: an admin registers people, agents and task kinds first.' }),
    table(['Who', 'Address or Interego user', 'Roles', 'Person / principal', ''], r.members.map((m) => h('tr', null,
      h('td', null, m.label, m.softwareAgent ? [' ', chip('agent', 'warn'), h('div', { class: 'small muted', text: `model ${m.model}` })] : null),
      h('td', null, h('code', { text: m.address }), /^did:web:/.test(m.address) ? [' ', chip('relay-attested', 'warn')] : null),
      h('td', null, m.roles.map((x) => chip(x))),
      h('td', { text: m.softwareAgent ? `principal: ${labelOf(m.principal)}` : m.personRef }),
      h('td', null, h('button', { text: 'Edit', on: { click: () => memberPanel(m) } }), h('button', { text: 'Remove', on: { click: () => act('wrd.update_registry', 'wrd:update-registry', { entries: [{ address: m.address, roles: [] }] }) } }))))),
    h('button', { text: 'Add a person or agent', on: { click: () => memberPanel(null) } }),
    h('h3', { text: 'Kinds of task' }),
    table(['Slug', 'Label', 'Definition', ''], r.taskKinds.map((k) => h('tr', null,
      h('td', null, h('code', { text: k.slug })), h('td', { text: k.label }), h('td', { text: k.definition }),
      h('td', null, k.retired ? chip('retired', 'warn') : h('button', { text: 'Retire', on: { click: () => act('wrd.update_registry', 'wrd:update-registry', { taskKinds: [{ slug: k.slug, retire: true }] }) } }))))),
    kindForm(),
    h('h3', { text: 'Grant policy in force' }),
    h('p', { class: 'small', text: `An agent earns a grant on one kind of task from at least ${gp.minSamples} person-reviewed runs on its declared model, a rating of at least ${gp.floor}, at least ${gp.minHumanConfirmations} person confirmations from at least ${gp.minDistinctConfirmers} ${v.distinctPeopleNote}, and ready-claim precision of at least ${gp.minReadyClaimPrecision}. Critical work under a grant needs ceil(3 / ${gp.criticalWorkFailureCeiling}) clean runs.` }),
    h('p', { class: 'small' }, 'Pod policy: ', v.podPolicy ? h('code', { text: JSON.stringify(v.podPolicy) }) : 'none (the published policy applies)'),
    policyForm());
}

function memberPanel(m) {
  const st = { address: m?.address ?? '', label: m?.label ?? '', roles: new Set(m?.roles ?? []), personRef: m?.personRef ?? '', principal: m?.principal ?? '', model: m?.model ?? '' };
  const box = (role) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: st.roles.has(role), on: { change: (e) => { if (e.target.checked) st.roles.add(role); else st.roles.delete(role); } } }), role);
  openPanel(m ? `Change ${m.label}` : 'Add a person or agent', h('div', null,
    h('p', { class: 'small muted', text: 'Only an admin\'s signature changes the registry. A person is a key they hold (its 0x address) or, if they sign in with their Interego account, their user DID (did:web:<identity host>:users:<id>): relay-attested, not a key they hold, so whoever holds the relay\'s key or controls the identity host can act as them. A person needs a person reference (the admin\'s attestation of which human this is; a key and a user DID with one reference are one person). An agent is always a key: it needs the agent role only, an accountable principal (a registered person) and the model it runs on.' }),
    field('Address (0x…) or Interego user DID (did:web:…:users:…)', input(st.address, (e) => { st.address = e.target.value.trim(); })),
    field('Label', input(st.label, (e) => { st.label = e.target.value; })),
    h('div', null, ['approver', 'operator', 'worker', 'agent'].map(box)),
    field('Person reference (people)', input(st.personRef, (e) => { st.personRef = e.target.value.trim(); })),
    field('Principal (agents)', select(personOptions('none'), st.principal, (e) => { st.principal = e.target.value; })),
    field('Declared model (agents)', input(st.model, (e) => { st.model = e.target.value; })),
    h('button', { class: 'primary', text: 'Sign the change', on: { click: () => {
      const isAgent = st.roles.has('agent');
      const entry = { address: st.address, roles: [...st.roles], label: st.label, softwareAgent: isAgent,
        ...(isAgent ? { principal: st.principal, model: st.model } : { personRef: st.personRef }) };
      act('wrd.update_registry', 'wrd:update-registry', { entries: [entry] });
    } } })));
}

function kindForm() {
  const st = { slug: '', label: '', definition: '' };
  return h('details', { class: 'card' }, h('summary', { text: 'Declare a kind of task (admin)' }),
    field('Slug (lowercase, digits, hyphens)', input('', (e) => { st.slug = e.target.value.trim(); })),
    field('Label', input('', (e) => { st.label = e.target.value; })),
    field('Definition (one sentence)', input('', (e) => { st.definition = e.target.value; }, { size: 60 })),
    h('button', { text: 'Sign', on: { click: () => act('wrd.update_registry', 'wrd:update-registry', { taskKinds: [{ ...st }] }) } }));
}

function policyForm() {
  const st = {};
  const n = (key, label) => field(label, input('', (e) => { if (e.target.value === '') delete st[key]; else st[key] = Number(e.target.value); }, { type: 'number', step: key === 'floor' ? '0.01' : '1' }));
  return h('details', { class: 'card' }, h('summary', { text: 'Tighten the pod policy (admin)' }),
    h('p', { class: 'small muted', text: 'A pod policy can only tighten the published one; the bridge refuses any field that would loosen it.' }),
    field('Highest allocation level allowed on this pod', select([['', 'no cap'], ...Object.entries(LEVEL_NAMES)], '', (e) => { if (e.target.value) st.maxLevel = e.target.value; else delete st.maxLevel; })),
    n('floor', 'Rating floor'), n('minSamples', 'Person-reviewed runs needed'), n('minHumanConfirmations', 'Person confirmations needed'), n('minDistinctConfirmers', 'Distinct reviewers needed'),
    h('button', { text: 'Sign the policy', on: { click: () => act('wrd.update_registry', 'wrd:update-registry', { podPolicy: { ...st } }) } }),
    h('button', { text: 'Clear the pod policy', on: { click: () => act('wrd.update_registry', 'wrd:update-registry', { podPolicy: null }) } }));
}

// ── View 2: capture ──────────────────────────────────────────────────────────────────────

const CAPTURE_KEY = 'wrd.capture.draft';
const blankTask = () => ({ name: '', description: '', currentLevel: 'person', personAddress: '', agentAddress: '', taskKind: '', externalTaskTerm: '', sourceQuotes: [], suggestedTaskKind: '' });
function captureDraft() {
  return store.get(CAPTURE_KEY) ?? { mode: 'manual', workflow: { title: '', unitLabel: '', description: '' }, tasks: [blankTask()], doc: { title: '', text: '' }, storeText: false, draftText: '', draftedBy: null };
}

function captureView() {
  const st = captureDraft();
  const save = () => store.set(CAPTURE_KEY, st);
  const normDoc = normaliseForQuote(st.doc.text || '');
  const docMode = st.mode === 'document';
  const rerender = () => { save(); render(); };
  const taskCard = (t, i) => h('div', { class: 'card' },
    h('div', { class: 'cols' },
      h('div', null, field('Task name (verb first)', input(t.name, (e) => { t.name = e.target.value; save(); }, { size: 50 })),
        field('Description', textarea(t.description, (e) => { t.description = e.target.value; save(); })),
        field('External task term (optional absolute IRI, e.g. a published task statement)', input(t.externalTaskTerm, (e) => { t.externalTaskTerm = e.target.value.trim(); save(); }, { size: 50 }))),
      h('div', null,
        field('Who does it today', select(captureLevels(), t.currentLevel, (e) => { t.currentLevel = e.target.value; rerender(); })),
        levelRule(t.currentLevel).requiresPerson !== false ? field('Person', select(personOptions('choose a registered person'), t.personAddress, (e) => { t.personAddress = e.target.value; save(); })) : null,
        levelRule(t.currentLevel).requiresAgent || t.currentLevel === 'person-with-agent-assist'
          ? field(t.currentLevel === 'person-with-agent-assist' ? 'Assisting agent (optional)' : 'Agent', select(agentOptions('none'), t.agentAddress, (e) => { t.agentAddress = e.target.value; save(); })) : null,
        field(`Kind of task${t.suggestedTaskKind ? ` (draft suggests “${t.suggestedTaskKind}”)` : ''}`, select(kindOptions(), t.taskKind, (e) => { t.taskKind = e.target.value; save(); })))),
    docMode ? h('div', null, h('div', { class: 'small muted', text: `Quotes from the draft (read-only) — ${PREVIEW_LABEL}` }),
      t.sourceQuotes.length === 0 ? h('p', { class: 'badbox small', text: 'No quotes: a drafted task cites 1 to 5.' }) : null,
      t.sourceQuotes.map((q) => { const p = previewQuote(normDoc, q); return h('div', { class: `quote ${p.status}` }, chip(p.status, p.status === 'verified' ? 'good' : 'bad'), ` “${q}” `, h('span', { class: 'small muted', text: p.status === 'verified' ? `(${p.start}–${p.end})` : `(${p.why})` })); })) : null,
    h('button', { text: 'Remove this task', on: { click: () => { st.tasks.splice(i, 1); if (st.tasks.length === 0) st.tasks.push(blankTask()); rerender(); } } }));

  const loadFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { st.doc.text = String(reader.result ?? ''); if (!st.doc.title) st.doc.title = f.name; rerender(); };
    reader.readAsText(f);
  };
  const fillFromDraft = () => {
    let d;
    try { d = JSON.parse(st.draftText); } catch (e) { showResult('draft', { ok: false, status: 0, body: { error: 'The draft is not JSON.', 'iep:refusalReason': String(e.message) } }); return; }
    const draft = d && typeof d === 'object' ? d : {};
    if (draft.workflow?.title) st.workflow.title = String(draft.workflow.title);
    if (draft.workflow?.unitLabel) st.workflow.unitLabel = String(draft.workflow.unitLabel);
    st.tasks = (Array.isArray(draft.tasks) ? draft.tasks : []).map((t) => {
      const suggested = String(t?.suggestedTaskKind ?? '');
      return { ...blankTask(), name: String(t?.name ?? ''), description: String(t?.description ?? ''), sourceQuotes: Array.isArray(t?.sourceQuotes) ? t.sourceQuotes.map(String) : [],
        suggestedTaskKind: suggested, taskKind: kindsList(false).some((k) => k.slug === suggested) ? suggested : '' };
    });
    if (st.tasks.length === 0) st.tasks.push(blankTask());
    const by = draft.draftedBy;
    st.draftedBy = by && typeof by === 'object' && ['person', 'agent', 'not-declared'].includes(by.kind)
      ? { kind: by.kind, ...(by.agent && by.agent !== '<fill>' ? { agent: String(by.agent).slice(0, 120) } : {}), ...(by.model && !String(by.model).startsWith('<fill') ? { model: String(by.model).slice(0, 120) } : {}) }
      : { kind: 'not-declared' };
    rerender();
  };
  const packet = async () => {
    const r = await call('wrd.task_map_packet', { document_title: st.doc.title, document_text: st.doc.text, workflow_title: st.workflow.title || undefined, pod_url: data().podUrl });
    if (!r.ok) { showResult('wrd.task_map_packet', r); return; }
    S.packet = r.body;
    render();
  };
  const signCapture = async () => {
    const taskPayload = st.tasks.map((t) => ({
      name: t.name, description: t.description, currentLevel: t.currentLevel, taskKind: t.taskKind,
      ...(t.personAddress ? { personAddress: t.personAddress } : {}), ...(t.agentAddress ? { agentAddress: t.agentAddress } : {}),
      ...(t.externalTaskTerm ? { externalTaskTerm: t.externalTaskTerm } : {}),
      ...(docMode ? { sourceQuotes: t.sourceQuotes } : {}),
    }));
    const workflow = { title: st.workflow.title, unitLabel: st.workflow.unitLabel, ...(st.workflow.description ? { description: st.workflow.description } : {}) };
    let out;
    let sha;
    let draftSha = '';
    try {
      sha = docMode ? await sha256Hex(st.doc.text) : '';
      draftSha = docMode && st.draftText ? await sha256Hex(st.draftText) : '';
    } catch (e) { showResult('wrd.record_task_map', { ok: false, status: 0, body: { error: 'The document could not be hashed in this browser.', 'iep:refusalReason': String(e?.message ?? e) } }); return; }
    if (docMode) {
      out = await act('wrd.record_task_map', 'wrd:record-task-map', {
        workflow, tasks: taskPayload, document: { title: st.doc.title, sha256: sha, storeText: !!st.storeText },
        draftedBy: st.draftedBy ?? { kind: 'not-declared' }, ...(draftSha ? { draftSha256: draftSha } : {}),
      }, { document_text: st.doc.text });
    } else {
      out = await act('wrd.capture_workflow', 'wrd:capture-workflow', { workflow, tasks: taskPayload });
    }
    if (out) { store.drop(CAPTURE_KEY); S.workflow = out.workflowIri; S.packet = null; render(); }
  };

  return h('section', null,
    h('h2', { text: 'Capture how the work is done' }),
    h('div', null, h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'mode', checked: !docMode, on: { change: () => { st.mode = 'manual'; rerender(); } } }), 'By hand'),
      h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'mode', checked: docMode, on: { change: () => { st.mode = 'document'; rerender(); } } }), 'From a document')),
    docMode ? h('div', { class: 'card' },
      field('Document title', input(st.doc.title, (e) => { st.doc.title = e.target.value; save(); }, { size: 50 })),
      field('Load a .txt or .md file', h('input', { type: 'file', accept: '.txt,.md,text/plain,text/markdown', on: { change: loadFile } })),
      field('Or paste the text', textarea(st.doc.text, (e) => { st.doc.text = e.target.value; save(); }, { class: 'tall' })),
      h('button', { text: 'Get the drafting packet', on: { click: packet } }), ' ', h('span', { class: 'small', text: PACKET_SENTENCE }),
      S.packet ? h('div', null, h('pre', { text: JSON.stringify(S.packet, null, 2) }),
        h('button', { text: 'Copy the packet', on: { click: () => copyText(JSON.stringify(S.packet, null, 2)) } })) : null,
      field('Paste your agent\'s draft (JSON)', textarea(st.draftText, (e) => { st.draftText = e.target.value; save(); }, { class: 'tall' })),
      h('button', { text: 'Fill the table from the draft', on: { click: fillFromDraft } }),
      st.draftedBy ? h('p', { class: 'small' }, 'Drafted by: ', st.draftedBy.kind === 'not-declared' ? 'not declared' : `${st.draftedBy.kind}${st.draftedBy.agent ? ` ${st.draftedBy.agent}` : ''}${st.draftedBy.model ? `, model ${st.draftedBy.model}` : ''}`) : null,
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!st.storeText, on: { change: (e) => { st.storeText = e.target.checked; save(); } } }), 'Store the document text on the pod'),
      h('span', { class: 'small muted', text: data().readExposure })) : null,
    h('div', { class: 'card' },
      field('Workflow title', input(st.workflow.title, (e) => { st.workflow.title = e.target.value; save(); }, { size: 50 })),
      field('Unit of work (what one run handles, e.g. “invoice”)', input(st.workflow.unitLabel, (e) => { st.workflow.unitLabel = e.target.value; save(); })),
      field('Description (optional)', textarea(st.workflow.description, (e) => { st.workflow.description = e.target.value; save(); }))),
    st.tasks.map(taskCard),
    h('button', { text: 'Add a task', on: { click: () => { st.tasks.push(blankTask()); rerender(); } } }),
    h('p', { class: 'small muted', text: 'This table is a draft kept in this browser only. Signing records it on the pod; the people named on each task then ratify or dispute it.' }),
    h('button', { class: 'primary', disabled: S.busy, text: docMode ? 'Sign and record the task map' : 'Sign and record the workflow', on: { click: signCapture } }),
    S.result?.ok && (S.result.tool === 'wrd.record_task_map' || S.result.tool === 'wrd.capture_workflow') ? captureResultNode(S.result.body) : null);
}

function captureResultNode(b) {
  if (!b?.tasks) return null;
  return h('div', null, h('p', { text: `${b.tasks.length} task(s) recorded. Send each person named on a task their link to ratify it.` }),
    b.tasks.map((t, i) => h('div', { class: 'card' }, h('strong', { text: t.name }), ' ', chip(`quotes ${t.quoteStatus}`),
      ' ', h('button', { text: 'Copy the link for the people named', on: { click: () => copyText(new URL(t.link, location.href).href) } }),
      b.quotes ? quotesNode(b.quotes.perTask[i] ?? []) : null)));
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); showResult('copy', { ok: true, status: 200, body: { status: 'copied to the clipboard' } }); }
  catch { openPanel('Copy this', h('textarea', { value: s, readOnly: true, class: 'tall' })); }
}

// ── View 3: tasks ────────────────────────────────────────────────────────────────────────

function workflowPicker() {
  const wfs = data().workflows ?? [];
  // Default to the workflow with the most current tasks; the person's own choice sticks.
  if (!S.workflow || !wfs.some((w) => w.workflowIri === S.workflow)) S.workflow = [...wfs].sort((a, b) => b.taskIris.length - a.taskIris.length)[0]?.workflowIri ?? '';
  return wfs.length === 0 ? h('p', { class: 'muted', text: 'No workflow captured yet: start in Capture.' })
    : field('Workflow', select(wfs.map((w) => [w.workflowIri, `${w.title} (${w.taskIris.length} tasks)`]), S.workflow, (e) => { S.workflow = e.target.value; S.panel = null; render(); }));
}
const currentWorkflow = () => (data().workflows ?? []).find((w) => w.workflowIri === S.workflow);

function tasksView() {
  const picker = workflowPicker();
  const wf = currentWorkflow();
  if (!wf) return h('section', null, h('h2', { text: 'Tasks' }), picker);
  const me = actor();
  const rows = wf.taskIris.map(taskBy).filter(Boolean);
  const retired = wf.retiredTaskIris.map(taskBy).filter(Boolean);
  const op = can('operator');
  return h('section', null,
    h('h2', { text: 'Tasks' }), picker,
    h('div', { class: 'card small' }, h('strong', { text: wf.title }), ` — unit “${wf.unitLabel}”, captured ${wf.captureMode === 'document' ? 'from a document' : 'by hand'} by ${labelOf(addrOfDid(wf.capturedBy))}. `,
      wf.document ? `Document “${wf.document.title}”, ${wf.document.chars} characters, sha256 ${short(wf.document.sha256)}, text ${wf.document.textStored ? 'stored on the pod' : 'not stored'}. ` : '',
      wf.captureMode === 'document' ? `Drafted by: ${typeof wf.draftedBy === 'string' ? wf.draftedBy : `${wf.draftedBy.kind}${wf.draftedBy.agent ? ` ${wf.draftedBy.agent}` : ''}${wf.draftedBy.model ? `, model ${wf.draftedBy.model}` : ''}`}. ` : '',
      demoChip(wf)),
    table(['Task', 'Named on it', 'Status', 'How knowable', ''], rows.map((t) => {
      const named = t.namedParties.some((p) => p.address === me);
      const owed = (t.owedRatification ?? []).some((p) => p.address === me);
      const c = t.classification;
      return h('tr', null,
        h('td', null, h('strong', { text: t.name }), h('div', { class: 'small muted', text: t.description }), chip(t.taskKind), chip(`quotes ${t.quoteStatus}`), demoChip(t),
          h('div', { class: 'small', text: `In force: ${allocationText(t.effective)}${t.effective.source !== 'captured' ? ` (${SOURCE_NAMES[t.effective.source] ?? t.effective.source})` : ''}` }),
          t.effective.suspended ? h('div', { class: 'badbox small', text: t.effective.suspendedWhy }) : null,
          t.effective.unreadable ? h('div', { class: 'badbox small', text: t.effective.unreadable }) : null,
          t.currentNotPermitted ? h('div', { class: 'warnbox small', text: t.currentNotPermitted }) : null,
          t.currentNotPermittedUnreadable ? h('div', { class: 'badbox small', text: t.currentNotPermittedUnreadable }) : null),
        h('td', null, partiesNode(t)),
        h('td', null, statusChip(t.status), t.revision ? h('div', { class: 'small', text: `revised; answers ${t.revision.answers.length} dispute(s)` }) : null),
        h('td', null, c && c.state === 'ok' ? [h('strong', { text: c.regime }), ` ${c.method} `, statusChip(c.status), c.current ? null : chip('classified against an earlier description', 'warn'),
          c.disagreement.length ? chip(`${c.disagreement.length} party disagrees`, 'bad') : null,
          c.contraryEvidence?.suggestReclassify ? h('div', { class: 'warnbox small' }, c.contraryEvidence.note, ' ', h('button', { text: 'Re-classify', on: { click: () => classifyPanel(t) } })) : null,
          c.contraryEvidence?.unreadable ? h('div', { class: 'badbox small', text: c.contraryEvidence.unreadable }) : null]
          : c ? [chip(`classification ${c.state}: not trusted`, 'bad'), c.unreadable ? h('div', { class: 'badbox small', text: c.unreadable }) : null] : chip('not classified', 'warn')),
        h('td', null,
          h('button', { text: 'Open', on: { click: () => { location.hash = `task=${encodeURIComponent(t.taskIri)}`; } } }),
          h('button', { text: 'Copy link', on: { click: () => copyText(new URL(t.link, location.href).href) } }),
          h('button', { disabled: !(named || owed), title: named || owed ? '' : 'Only the people and agents named on this task, or removed from it by a revision.', text: 'Ratify / dispute', on: { click: () => ratifyPanel(t, 'description') } }),
          h('button', { disabled: !(op || named || can('approver')), title: 'Operators, approvers and the people named on the task classify it.', text: 'Classify', on: { click: () => classifyPanel(t) } }),
          h('button', { disabled: !(op || named), title: 'An operator or someone named on the task.', text: 'Revise', on: { click: () => revisePanel(t) } }),
          h('button', { disabled: !op, title: 'Operators only.', text: 'Retire', on: { click: () => retirePanel(t) } })));
    })),
    h('button', { disabled: !op, title: op ? '' : 'Operators only.', text: 'Add a task', on: { click: () => addTaskPanel(wf) } }),
    retired.length ? [h('h3', { text: 'Retired tasks' }), retired.map((t) => h('div', { class: 'small' }, `${t.name} — retired ${when(t.retirement?.at)}: ${t.retirement?.why ?? ''}`))] : null);
}

function classifyPanel(t) {
  const qs = data().vocabulary?.questions ?? [];
  const prior = t.classification?.state === 'ok' ? t.classification.answers : {};
  const answers = {};
  const notes = textarea('', null, { placeholder: 'Optional note' });
  openPanel(`Classify “${t.name}”`, h('div', null,
    h('p', { class: 'small muted', text: 'The regime comes from a published rule applied to your signed answers (rule-on-signed-answers). "unknown" is a real answer: if the answers place nothing, nothing is recorded.' }),
    qs.map((q) => { answers[q.id] = prior[q.id] ?? 'unknown'; return field(q.text, select(q.options.map((o) => [o, o]), answers[q.id], (e) => { answers[q.id] = e.target.value; })); }),
    field('Note', notes),
    h('details', { class: 'small' }, h('summary', { text: 'The published rules, in order' }), (data().vocabulary?.rules ?? []).map((r) => h('div', { text: `${r.id}: ${r.condition}` }))),
    h('p', { class: 'small muted', text: 'Your signature binds these answers to the description as it reads now (its textSha256): if the description is revised before this lands, the answers are refused, not attached to a text you did not see.' }),
    h('button', { class: 'primary', text: 'Sign the answers', on: { click: () => act('wrd.classify_task', 'wrd:classify-task', { taskIri: t.taskIri, taskTextSha256: t.textSha256, answers: { ...answers }, ...(notes.value.trim() ? { notes: notes.value.trim() } : {}) }) } }),
    payloadButton('wrd:classify-task', { task_iri: t.taskIri })));
}

function revisePanel(t) {
  const st = { name: t.name, description: t.description, currentLevel: t.current.level, personAddress: t.current.personAddress ?? '', agentAddress: t.current.agentAddress ?? '', taskKind: t.taskKind, externalTaskTerm: t.externalTaskTerm ?? '', note: '' };
  const disputes = t.namedParties.filter((p) => p.ratification?.verdict === 'dispute');
  openPanel(`Revise “${t.name}”`, h('div', null,
    disputes.length ? h('div', { class: 'warnbox' }, h('strong', { text: 'This revision answers these open disputes:' }), disputes.map((p) => h('div', { text: `${p.label}: ${p.ratification.note ?? ''}` }))) : null,
    h('p', { class: 'small muted', text: 'Changing the text without new quotes clears the quotes (their verdicts stay in the record\'s history). Everyone named must ratify the revised text again, and anyone this revision removes from the task must ratify it too: a dispute is answered, never edited away.' }),
    field('Name', input(st.name, (e) => { st.name = e.target.value; }, { size: 50 })),
    field('Description', textarea(st.description, (e) => { st.description = e.target.value; })),
    field('Who does it today', select(captureLevels(), st.currentLevel, (e) => { st.currentLevel = e.target.value; })),
    field('Person', select(personOptions('nobody'), st.personAddress, (e) => { st.personAddress = e.target.value; })),
    field('Agent', select(agentOptions('none'), st.agentAddress, (e) => { st.agentAddress = e.target.value; })),
    field('Kind of task', select(kindOptions(), st.taskKind, (e) => { st.taskKind = e.target.value; })),
    field('External task term', input(st.externalTaskTerm, (e) => { st.externalTaskTerm = e.target.value.trim(); }, { size: 50 })),
    field('Note (what changed and why)', textarea('', (e) => { st.note = e.target.value; })),
    h('button', { class: 'primary', text: 'Sign the revision', on: { click: () => {
      const changes = {};
      if (st.name !== t.name) changes.name = st.name;
      if (st.description !== t.description) changes.description = st.description;
      if (st.currentLevel !== t.current.level) changes.currentLevel = st.currentLevel;
      if (st.personAddress !== (t.current.personAddress ?? '')) changes.personAddress = st.personAddress || null;
      if (st.agentAddress !== (t.current.agentAddress ?? '')) changes.agentAddress = st.agentAddress || null;
      if (st.taskKind !== t.taskKind) changes.taskKind = st.taskKind;
      if (st.externalTaskTerm && st.externalTaskTerm !== (t.externalTaskTerm ?? '')) changes.externalTaskTerm = st.externalTaskTerm;
      act('wrd.revise_task', 'wrd:revise-task', { op: 'revise', taskIri: t.taskIri, descriptorUrl: t.head.descriptorUrl, graphDigest: t.head.graphDigest, ...changes, ...(st.note.trim() ? { note: st.note.trim() } : {}) });
    } } })));
}

function retirePanel(t) {
  const why = textarea('', null, { placeholder: 'Why this task is retired' });
  openPanel(`Retire “${t.name}”`, h('div', null, h('p', { class: 'small muted', text: 'The task\'s record is withdrawn (Retracted) as of now; the workflow\'s next version no longer lists it. Plans that change it become stale.' }),
    field('Why', why),
    h('button', { class: 'primary', text: 'Sign the retirement', on: { click: () => act('wrd.revise_task', 'wrd:revise-task', { op: 'retire', taskIri: t.taskIri, descriptorUrl: t.head.descriptorUrl, graphDigest: t.head.graphDigest, why: why.value.trim() }) } })));
}

function addTaskPanel(wf) {
  const st = blankTask();
  openPanel(`Add a task to “${wf.title}”`, h('div', null,
    field('Name', input('', (e) => { st.name = e.target.value; }, { size: 50 })),
    field('Description', textarea('', (e) => { st.description = e.target.value; })),
    field('Who does it today', select(captureLevels(), st.currentLevel, (e) => { st.currentLevel = e.target.value; })),
    field('Person', select(personOptions('nobody'), '', (e) => { st.personAddress = e.target.value; })),
    field('Agent', select(agentOptions('none'), '', (e) => { st.agentAddress = e.target.value; })),
    field('Kind of task', select(kindOptions(), '', (e) => { st.taskKind = e.target.value; })),
    h('button', { class: 'primary', text: 'Sign', on: { click: () => act('wrd.revise_task', 'wrd:revise-task', {
      op: 'add', workflowIri: wf.workflowIri, descriptorUrl: wf.head.descriptorUrl, graphDigest: wf.head.graphDigest,
      task: { name: st.name, description: st.description, currentLevel: st.currentLevel, taskKind: st.taskKind,
        ...(st.personAddress ? { personAddress: st.personAddress } : {}), ...(st.agentAddress ? { agentAddress: st.agentAddress } : {}) },
    }) } })));
}

// ── View 4: plan ─────────────────────────────────────────────────────────────────────────

const activeGrant = (agent, kind) => (data().grants ?? []).find((g) => g.agentAddress === agent && g.taskKind === kind && g.active);
const grantWhy = (kind) => (data().grants ?? []).find((g) => g.taskKind === kind)?.why ?? 'no grant on this kind of task';

function planView() {
  const picker = workflowPicker();
  const wf = currentWorkflow();
  if (!wf) return h('section', null, h('h2', { text: 'Plan' }), picker);
  const rows = wf.taskIris.map(taskBy).filter(Boolean);
  const classified = rows.filter((t) => t.classification && t.classification.state === 'ok').length;
  const allClassified = classified === rows.length;
  const f = S.planForm[wf.workflowIri] ??= { title: '', rows: {} };
  const regimes = data().vocabulary?.regimes ?? [];
  const rowState = (t) => f.rows[t.taskIri] ??= { level: '', personAddress: t.effective.personAddress ?? '', agentAddress: t.effective.agentAddress ?? '', probes: [] };
  const lockOf = (t) => {
    const c = t.classification;
    if (!c) return 'not classified';
    if (c.state !== 'ok') return `its classification record is ${c.state} (changed after signing): classify it again`;
    if (t.status === 'disputed') return 'the description is disputed: revise it first';
    if (c.status === 'disputed') return 'someone named on it disputes the classification: classify it again';
    if (!c.current) return 'classified against an earlier description: classify it again';
    if (c.regime === 'Turbulent') return 'stabilise first';
    return '';
  };
  const agentLock = (t) => (t.classification?.status === 'ratified' ? '' : 'an agent is put on this work only once everyone named on it has ratified its classification');
  const editRow = (t) => {
    const s = rowState(t);
    const c = t.classification;
    const lock = lockOf(t);
    const permitted = regimes.find((r) => r.regime === c?.regime)?.permittedLevels ?? [];
    const rule = levelRule(s.level);
    const levelOpts = [['', 'no change'], ...permitted.map((l) => {
      const disabled = l === 'agent-acts-within-grant' && !(s.agentAddress && activeGrant(s.agentAddress, t.taskKind)) && !agentsList().some((a) => activeGrant(a.address, t.taskKind));
      return [l, LEVEL_NAMES[l] ?? l, disabled, disabled ? grantWhy(t.taskKind) : ''];
    })];
    const g = s.level === 'agent-acts-within-grant' && s.agentAddress ? activeGrant(s.agentAddress, t.taskKind) : null;
    return h('tr', null,
      h('td', null, h('strong', { text: t.name }), h('div', { class: 'small muted', text: allocationText(t.effective) }), t.effective.source !== 'captured' ? chip(SOURCE_NAMES[t.effective.source] ?? t.effective.source) : null,
        t.effective.suspended ? chip(t.effective.suspendedWhy, 'bad') : null, t.effective.unreadable ? chip(t.effective.unreadable, 'bad') : null),
      h('td', null, c?.regime ? [h('strong', { text: c.regime }), h('div', { class: 'small muted', text: REGIME_NOTES[c.regime] ?? '' })] : '—'),
      h('td', null, lock ? chip(lock, 'warn') : [
        select(levelOpts, s.level, (e) => { s.level = e.target.value; render(); }),
        s.level && (rule.requiresPerson || s.level === 'person-with-agent-assist') ? field('Person', select(personOptions('choose'), s.personAddress, (e) => { s.personAddress = e.target.value; })) : null,
        s.level && (rule.requiresAgent || s.level === 'person-with-agent-assist') ? field(s.level === 'person-with-agent-assist' ? 'Assisting agent (optional)' : 'Agent', select(agentOptions('choose'), s.agentAddress, (e) => { s.agentAddress = e.target.value; render(); })) : null,
        s.level && (rule.requiresAgent || s.agentAddress) && agentLock(t) ? chip(agentLock(t), 'warn') : null,
        g ? h('div', { class: 'small' }, `Grant in force: ${g.evaluation.samples} reviewed runs; `, g.evidenceTaskIris.includes(t.taskIri) ? 'evidence from this task' : chip('grant evidence comes from other tasks', 'warn')) : null,
        c?.regime === 'Emergent' && s.level ? probesEditor(s) : null]));
  };
  const submit = () => {
    const changes = [];
    for (const t of rows) {
      const s = f.rows[t.taskIri];
      if (!s || !s.level || lockOf(t)) continue;
      const rule = levelRule(s.level);
      changes.push({ taskIri: t.taskIri, proposedLevel: s.level,
        ...((rule.requiresPerson || s.level === 'person-with-agent-assist') && s.personAddress ? { personAddress: s.personAddress } : {}),
        ...((rule.requiresAgent || s.level === 'person-with-agent-assist') && s.agentAddress ? { agentAddress: s.agentAddress } : {}),
        ...(t.classification?.regime === 'Emergent' ? { probes: s.probes.map((p) => ({ ...p, timeboxWeeks: Number(p.timeboxWeeks) })) } : {}) });
    }
    const emergent = changes.filter((c) => taskBy(c.taskIri)?.classification?.regime === 'Emergent').length;
    if (emergent > 0 && emergent < changes.length) {
      showResult('wrd.propose_allocation', { ok: false, status: 0, body: { error: 'Probe changes and valued changes go in separate plans.', 'iep:refusalReason': 'a probe\'s effect would land inside the measured value of the valued change; propose them separately' } });
      return;
    }
    act('wrd.propose_allocation', 'wrd:propose-allocation', { workflowIri: wf.workflowIri, title: f.title || 'Untitled plan', changes });
  };
  const plans = (data().plans ?? []).filter((p) => p.workflowIri === wf.workflowIri);
  return h('section', null,
    h('h2', { text: 'Propose who does what' }), picker,
    allClassified ? null : h('p', { class: 'warnbox', text: `Classify every task first (${classified} of ${rows.length} classified).` }),
    h('fieldset', { disabled: !allClassified || !can('operator') },
      h('legend', { class: 'small muted', text: can('operator') ? 'Operators propose; the people a plan names acknowledge or object.' : 'Only a registered operator proposes a plan.' }),
      field('Plan title', input(f.title, (e) => { f.title = e.target.value; }, { size: 50 })),
      table(['Task and who does it now', 'Regime', 'Proposed'], rows.map(editRow)),
      h('button', { class: 'primary', text: 'Sign and propose', on: { click: submit } })),
    h('h3', { text: 'Plans for this workflow' }),
    plans.length === 0 ? h('p', { class: 'muted', text: 'None yet.' }) : plans.map(planCard));
}

function probesEditor(s) {
  const probe = () => ({ hypothesis: '', amplifyIf: '', dampenIf: '', timeboxWeeks: 4 });
  if (s.probes.length === 0) s.probes.push(probe());
  return h('div', { class: 'card' }, h('div', { class: 'small muted', text: 'Emergent work changes only as 1 to 5 safe-to-fail probes, each with the signal that would amplify it and the one that would dampen it.' }),
    s.probes.map((p, i) => h('div', { class: 'card' },
      field(`Probe ${i + 1}: hypothesis`, input(p.hypothesis, (e) => { p.hypothesis = e.target.value; }, { size: 40 })),
      field('Amplify if', input(p.amplifyIf, (e) => { p.amplifyIf = e.target.value; }, { size: 40 })),
      field('Dampen if', input(p.dampenIf, (e) => { p.dampenIf = e.target.value; }, { size: 40 })),
      field('Timebox (weeks, 1 to 26)', input(String(p.timeboxWeeks), (e) => { p.timeboxWeeks = e.target.value; }, { type: 'number', min: 1, max: 26 })),
      h('button', { text: 'Remove probe', on: { click: () => { s.probes.splice(i, 1); render(); } } }))),
    s.probes.length < 5 ? h('button', { text: 'Add a probe', on: { click: () => { s.probes.push(probe()); render(); } } }) : null);
}

function planCard(p) {
  const me = actor();
  const changed = p.tasks.filter((r) => r.changed);
  return h('div', { class: 'card' },
    h('div', null, h('strong', { text: p.title }), ' ', chip(p.planKind), p.stale ? chip(`stale: ${p.stale}`, 'bad') : null, p.unreadable ? chip(p.unreadable, 'bad') : null, demoChip(p),
      h('span', { class: 'small muted', text: ` proposed by ${labelOf(addrOfDid(p.proposedBy))}` })),
    changed.map((r) => h('div', { class: 'small' }, `${taskName(r.taskIri)}: ${allocationText(r.current)} → ${allocationText(r.proposed)}`,
      r.grant ? (r.grant.evidenceFromThisTask ? '' : [' ', chip('grant evidence comes from other tasks', 'warn')]) : '',
      r.probes ? h('ul', null, r.probes.map((pr) => h('li', { text: `${pr.hypothesis} — amplify if ${pr.amplifyIf}; dampen if ${pr.dampenIf}; ${pr.timeboxWeeks} weeks` }))) : null)),
    p.assignments.map((a) => h('div', { class: 'small' }, `${labelOf(a.personAddress)} on “${taskName(a.taskIri)}”: `,
      chip(a.label, a.state === 'acknowledged' ? 'good' : a.state === 'objected' ? 'bad' : 'warn'), a.note ? ` “${a.note}”` : '',
      a.personAddress === me ? [' ', h('button', { text: 'Acknowledge', on: { click: () => acknowledge(p, a.taskIri, 'acknowledge') } }),
        h('button', { text: 'Object…', on: { click: () => objectPanel(p, a.taskIri) } })] : null)));
}

function acknowledge(p, taskIri, verdict, note) {
  return act('wrd.ratify_task', 'wrd:ratify-task', { subject: 'assignment', planIri: p.planIri, taskIri, descriptorUrl: p.head.descriptorUrl, graphDigest: p.head.graphDigest, verdict, ...(note ? { note } : {}) });
}
function objectPanel(p, taskIri) {
  const note = textarea('', null, { placeholder: 'Why you object (required)' });
  openPanel(`Object to your assignment on “${taskName(taskIri)}”`, h('div', null,
    h('p', { class: 'small muted', text: 'An objection does not block the plan, but an approver can approve it only by naming your objection.' }),
    field('Why', note), h('button', { class: 'primary', text: 'Sign the objection', on: { click: () => acknowledge(p, taskIri, 'object', note.value.trim()) } })));
}

// ── View 5: value ────────────────────────────────────────────────────────────────────────

/** A plan's valuations, oldest first. */
const valuationsOf = (planIri) => (data().valuations ?? []).filter((v) => v.planIri === planIri)
  .sort((a, b) => String(a.head.validFrom).localeCompare(String(b.head.validFrom)));

const triBlank = () => ({ low: '', likely: '', high: '', basis: 'estimate', note: '', source: '' });
const stateBlank = () => Object.fromEntries(STATE_FIELDS.map(([k]) => [k, triBlank()]));

function valueDraft(p) {
  const key = `wrd.value.${p.planIri}`;
  const saved = store.get(key);
  if (saved) return { key, st: saved };
  const prior = valuationsOf(p.planIri).at(-1)?.inputs;
  if (prior) return { key, st: draftFromInputs(prior, p) };
  const st = {
    currency: 'USD', throughputChanges: false, unitsCurrent: triBlank(), unitsProposed: triBlank(), valuePerUnit: triBlank(), hourlyCost: triBlank(), oneOffCost: triBlank(),
    horizonMonths: 24, rampMonths: 3, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01, tasks: {}, freedHours: {},
  };
  for (const r of p.tasks) {
    st.tasks[r.taskIri] = { entered: r.changed, runsPerUnit: triBlank(), overrideHourly: false, hourlyCost: triBlank(), current: stateBlank(), proposed: stateBlank() };
    if (r.changed) st.freedHours[r.taskIri] = { disposition: 'undecided', note: '' };
  }
  return { key, st };
}

const triIn = (t) => (t ? { low: String(t.low), likely: String(t.likely), high: String(t.high), basis: t.basis, note: t.note ?? '', source: t.source ?? '' } : triBlank());
/** An editable draft from inputs a valuation on the pod already recorded. */
function draftFromInputs(i, p) {
  const st = {
    currency: i.currency, throughputChanges: !!i.unitsPerWeek.proposed, unitsCurrent: triIn(i.unitsPerWeek.current), unitsProposed: triIn(i.unitsPerWeek.proposed),
    valuePerUnit: triIn(i.valuePerUnit), hourlyCost: triIn(i.hourlyCost), oneOffCost: triIn(i.oneOffCost), horizonMonths: i.horizonMonths, rampMonths: i.rampMonths,
    annualDiscountRate: i.annualDiscountRate, criticalFailureCeiling: i.criticalFailureCeiling, tasks: {},
    freedHours: Object.fromEntries(Object.entries(i.freedHours).map(([iri, f]) => [iri, { disposition: f.disposition, note: f.note ?? '' }])),
  };
  for (const r of p.tasks) {
    const ti = i.tasks[r.taskIri];
    st.tasks[r.taskIri] = {
      entered: !!ti, runsPerUnit: triIn(ti?.runsPerUnit), overrideHourly: !!ti?.hourlyCost, hourlyCost: triIn(ti?.hourlyCost),
      current: ti ? Object.fromEntries(STATE_FIELDS.map(([k]) => [k, triIn(ti.current[k])])) : stateBlank(),
      proposed: ti?.proposed ? Object.fromEntries(STATE_FIELDS.map(([k]) => [k, triIn(ti.proposed[k])])) : stateBlank(),
    };
  }
  return st;
}

/** A three-point input; one number in "likely" alone is a single number, marked "no range given". */
function triEditor(label, t, save) {
  const one = t.likely !== '' && t.low === '' && t.high === '';
  return h('div', { class: 'tri' }, h('span', { class: 'lbl', text: label }),
    input(t.low, (e) => { t.low = e.target.value; save(); }, { type: 'number', step: 'any', placeholder: 'low', 'aria-label': `${label} low` }),
    input(t.likely, (e) => { t.likely = e.target.value; save(); }, { type: 'number', step: 'any', placeholder: 'likely', 'aria-label': `${label} likely` }),
    input(t.high, (e) => { t.high = e.target.value; save(); }, { type: 'number', step: 'any', placeholder: 'high', 'aria-label': `${label} high` }),
    select(Object.entries(BASIS_NAMES), t.basis, (e) => { t.basis = e.target.value; save(); }),
    input(t.note, (e) => { t.note = e.target.value; save(); }, { placeholder: 'note', size: 14 }),
    input(t.source, (e) => { t.source = e.target.value.trim(); save(); }, { placeholder: 'source IRI', size: 14 }),
    one ? chip('no range given') : null);
}
function triOut(t) {
  const n = (v) => (String(v).trim() === '' ? null : Number(v));
  const likely = n(t.likely);
  const low = String(t.low).trim() === '' ? likely : n(t.low);
  const high = String(t.high).trim() === '' ? likely : n(t.high);
  return { low, likely, high, basis: t.basis, ...(t.note ? { note: t.note } : {}), ...(t.source ? { source: t.source } : {}) };
}

function valueView() {
  const plans = (data().plans ?? []).filter((p) => p.planKind === 'valued');
  // Default to the plan valued most recently (else the first valued plan); the person's own choice sticks.
  if (!S.plan || !plans.some((p) => p.planIri === S.plan)) {
    const newest = [...(data().valuations ?? [])].sort((a, b) => String(b.head.validFrom).localeCompare(String(a.head.validFrom)))
      .find((v) => plans.some((p) => p.planIri === v.planIri));
    S.plan = newest?.planIri ?? plans[0]?.planIri ?? '';
  }
  const p = planBy(S.plan);
  const picker = plans.length === 0 ? h('p', { class: 'muted', text: 'No valued plan yet: propose one in Plan. (Probe plans on Emergent work are never priced.)' })
    : field('Plan', select(plans.map((x) => [x.planIri, `${x.title}${x.stale ? ' — stale' : x.unreadable ? ' — cannot be read in full' : ''}`]), S.plan, (e) => { S.plan = e.target.value; render(); }));
  if (!p) return h('section', null, h('h2', { text: 'Value a plan' }), picker);
  const { key, st } = valueDraft(p);
  const save = () => store.set(key, st);
  const rerender = () => { save(); render(); };
  const latest = valuationsOf(p.planIri).at(-1);
  const taskBlock = (r) => {
    const ti = st.tasks[r.taskIri] ??= { entered: r.changed, runsPerUnit: triBlank(), overrideHourly: false, hourlyCost: triBlank(), current: stateBlank(), proposed: stateBlank() };
    const needed = r.changed || st.throughputChanges;
    if (r.changed) st.freedHours[r.taskIri] ??= { disposition: 'undecided', note: '' };
    const body = h('div', null,
      triEditor('Runs per unit', ti.runsPerUnit, save),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: ti.overrideHourly, on: { change: (e) => { ti.overrideHourly = e.target.checked; rerender(); } } }), 'this task has its own hourly cost'),
      ti.overrideHourly ? triEditor('Hourly cost for this task', ti.hourlyCost, save) : null,
      h('div', { class: 'small muted', text: `Now: ${allocationText(r.current)}` }),
      STATE_FIELDS.map(([k, label]) => triEditor(`${label} — now`, ti.current[k], save)),
      r.changed ? [
        h('div', { class: 'small muted', text: `Proposed: ${allocationText(r.proposed)}` }),
        h('button', { text: 'Copy current to proposed', on: { click: () => { ti.proposed = JSON.parse(JSON.stringify(ti.current)); rerender(); } } }),
        STATE_FIELDS.map(([k, label]) => triEditor(`${label} — proposed`, ti.proposed[k], save)),
        field('What happens to the hours this change frees', select(data().vocabulary?.dispositions?.freedHours?.map((d) => [d, d]) ?? [], st.freedHours[r.taskIri]?.disposition, (e) => { st.freedHours[r.taskIri].disposition = e.target.value; save(); })),
        input(st.freedHours[r.taskIri]?.note, (e) => { st.freedHours[r.taskIri].note = e.target.value; save(); }, { placeholder: 'note (e.g. who takes on what)', size: 40 }),
      ] : null);
    if (needed) return h('div', { class: 'card' }, h('strong', { text: taskName(r.taskIri) }), r.changed ? chip('changes') : chip('throughput changes: required'), body);
    return h('details', { class: 'card', open: ti.entered && !r.changed ? true : undefined },
      h('summary', null, `${taskName(r.taskIri)} — not needed: unchanged tasks cancel `),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: ti.entered, on: { change: (e) => { ti.entered = e.target.checked; save(); } } }), 'enter it anyway (needed for the value-to-cost ratio)'), body);
  };
  const run = () => {
    const tasksOut = {};
    for (const r of p.tasks) {
      const ti = st.tasks[r.taskIri];
      if (!ti || !(r.changed || st.throughputChanges || ti.entered)) continue;
      tasksOut[r.taskIri] = {
        runsPerUnit: triOut(ti.runsPerUnit), ...(ti.overrideHourly ? { hourlyCost: triOut(ti.hourlyCost) } : {}),
        current: Object.fromEntries(STATE_FIELDS.map(([k]) => [k, triOut(ti.current[k])])),
        ...(r.changed ? { proposed: Object.fromEntries(STATE_FIELDS.map(([k]) => [k, triOut(ti.proposed[k])])) } : {}),
      };
    }
    const inputs = {
      currency: st.currency, unitsPerWeek: { current: triOut(st.unitsCurrent), ...(st.throughputChanges ? { proposed: triOut(st.unitsProposed) } : {}) },
      valuePerUnit: triOut(st.valuePerUnit), hourlyCost: triOut(st.hourlyCost), oneOffCost: triOut(st.oneOffCost),
      horizonMonths: Number(st.horizonMonths), rampMonths: Number(st.rampMonths), annualDiscountRate: Number(st.annualDiscountRate), criticalFailureCeiling: Number(st.criticalFailureCeiling),
      freedHours: Object.fromEntries(Object.entries(st.freedHours).map(([iri, f]) => [iri, { disposition: f.disposition, ...(f.note ? { note: f.note } : {}) }])),
      tasks: tasksOut,
    };
    act('wrd.value_plan', 'wrd:value-plan', { planIri: p.planIri, inputs });
  };
  const nInput = (k, label, props) => field(label, input(String(st[k]), (e) => { st[k] = e.target.value; save(); }, { type: 'number', step: 'any', ...props }));
  return h('section', null,
    h('h2', { text: 'Value a plan with ranges' }), picker,
    p.stale ? h('p', { class: 'badbox', text: `This plan is stale: ${p.stale}` }) : null,
    p.unreadable ? h('p', { class: 'badbox', text: p.unreadable }) : null,
    h('p', { class: 'small muted', text: 'Give every input as low / likely / high and say where it came from. A single number in "likely" is kept as one number and marked "no range given". These inputs are a draft in this browser until you sign them.' }),
    h('div', { class: 'card' },
      field('Currency (ISO 4217)', input(st.currency, (e) => { st.currency = e.target.value.toUpperCase(); save(); }, { size: 4 })),
      triEditor('Units per week now', st.unitsCurrent, save),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: st.throughputChanges, on: { change: (e) => { st.throughputChanges = e.target.checked; rerender(); } } }), 'the change alters throughput'),
      st.throughputChanges ? triEditor('Units per week after the change', st.unitsProposed, save) : null,
      triEditor('Value of one unit', st.valuePerUnit, save), triEditor('Hourly cost of a person', st.hourlyCost, save), triEditor('One-off cost of the change', st.oneOffCost, save),
      h('div', { class: 'row' }, nInput('horizonMonths', 'Horizon (months)', { min: 1, max: 120 }), nInput('rampMonths', 'Ramp (months)', { min: 0, max: 60 }),
        nInput('annualDiscountRate', 'Annual discount rate (0 to 1)'), nInput('criticalFailureCeiling', 'Critical-failure ceiling for pilot sizing'))),
    p.tasks.map(taskBlock),
    h('p', { class: 'small muted', text: 'Mark a zero that does not apply to a state (for example performer hours where an agent performs) "not applicable": it is counted apart, not read as a single-number estimate. A proposed state has not run yet, so "measured" there needs the source IRI it was measured on. Where a person decides on or audits the agent\'s work, cost their oversight hours.' }),
    h('button', { class: 'primary', disabled: S.busy || !can('operator'), title: can('operator') ? '' : 'Only a registered operator requests a valuation.', text: 'Sign and value', on: { click: run } }),
    payloadButton('wrd:value-plan', { plan_iri: p.planIri }),
    latest ? valuationNode(latest) : null);
}

function pathLabel(path) {
  const m = /^tasks\[(.+?)\]\.(.+)$/.exec(path);
  if (!m) return path;
  return `${taskName(m[1])} · ${m[2].replace('.', ' · ')}`;
}

function valuationNode(v) {
  const r = v.result;
  const cur = r.currency;
  const m = (n) => money(n, cur);
  const sc = r.scenarios;
  const scenarioRows = [
    ['Weekly change', band(sc.cash.weeklyDelta, m), band(sc.redeployed.weeklyDelta, m)],
    ['Net present value over the horizon', band(sc.cash.npv, m), band(sc.redeployed.npv, m)],
    ['Probability the NPV is above zero', pct(sc.cash.probabilityNpvPositive), pct(sc.redeployed.probabilityNpvPositive)],
    ['Payback month (median)', sc.cash.payback.p50Month ?? 'not within the horizon', sc.redeployed.payback.p50Month ?? 'not within the horizon'],
    ['Probability of payback within the horizon', pct(sc.cash.payback.probabilityWithinHorizon), pct(sc.redeployed.payback.probabilityWithinHorizon)],
  ];
  const breakdownRows = ['value', 'loss', 'personCost', 'oversightCost', 'agentCost'].map((k) => h('tr', null,
    h('td', { text: { value: 'Value', loss: 'Expected loss from failures', personCost: 'Person cost', oversightCost: 'Oversight cost', agentCost: 'Agent cost' }[k] }),
    h('td', { class: 'num', text: m(r.breakdown.current.total[k]) }), h('td', { class: 'num', text: m(r.breakdown.proposed.total[k]) })));
  const sens = (s) => {
    const max = Math.max(1e-9, ...s.sensitivity.map((x) => x.swing));
    return s.sensitivity.map((x) => {
      const bar = h('div', { class: 'bar' });
      bar.style.width = `${Math.max(0.5, (x.swing / max) * 100)}%`;
      return h('div', { class: 'small' }, h('div', null, pathLabel(x.input), ' ', chip(BASIS_NAMES[x.basis] ?? x.basis), x.basis === 'estimate' ? chip('unmeasured', 'warn') : null,
        ` NPV ${m(x.npvAtLow)} at low, ${m(x.npvAtHigh)} at high`), h('div', { class: 'bartrack' }, bar));
    });
  };
  return h('div', { class: 'card' },
    h('h3', { text: 'Valuation' }), demoChip(v),
    h('p', { class: 'small muted' }, `Seed ${short(r.seed)}, ${r.draws} draws, method `, h('code', { text: r.method }), `. Hash ${short(v.valuationHash)}.`),
    v.unratifiedTasks.length ? h('p', { class: 'warnbox', text: `Not yet ratified by everyone named: ${v.unratifiedTasks.map(taskName).join(', ')}. A decision cannot be submitted until they are.` }) : null,
    v.expertEvidence.length ? h('p', { class: 'small', text: `Expert evidence for Knowable changes: ${v.expertEvidence.map((e) => `${taskName(e.taskIri)} — ${e.satisfiedBy}`).join('; ')}` }) : null,
    table(['', 'Cash (freed hours count only where the work stays unfilled)', 'If freed hours are redeployed at current cost'], scenarioRows.map((row) => h('tr', null, row.map((c) => h('td', { text: String(c) }))))),
    h('p', { class: 'small muted', text: NO_TOTALS }),
    h('h3', { text: 'Freed person-hours per week' }),
    table(['Task', 'Hours freed (negative = added)', 'What happens to them'], [
      ...r.freedPersonHours.perTask.map((f) => h('tr', null, h('td', { text: taskName(f.taskIri) }), h('td', { text: band(f.band, (n) => num(n, 1)) }), h('td', { text: `${f.disposition}${f.note ? ` — ${f.note}` : ''}` }))),
      h('tr', null, h('td', { text: 'All changed tasks' }), h('td', { text: band(r.freedPersonHours.total, (n) => num(n, 1)) }), h('td')),
    ]),
    h('h3', { text: 'Weekly breakdown at likely values' }),
    table(['', '#Now', '#Proposed'], breakdownRows),
    h('p', { class: 'small' }, 'Value-to-cost ratio, (value − expected loss) ÷ cost: ',
      r.valueToCost.why ? r.valueToCost.why : `now ${band(r.valueToCost.current, (n) => num(n, 2))}; proposed ${band(r.valueToCost.proposed, (n) => num(n, 2))}`),
    h('div', { class: 'cols' }, h('div', null, h('h3', { text: 'What moves the cash NPV most' }), sens(sc.cash)), h('div', null, h('h3', { text: 'What moves the redeployed NPV most' }), sens(sc.redeployed))),
    h('h3', { text: 'Where the inputs came from' }),
    h('p', { class: 'small', text: Object.entries(r.inputs.byBasis).filter(([, n]) => n > 0).map(([b, n]) => `${n} ${BASIS_NAMES[b] ?? b}`).join(' · ') }),
    r.inputs.noRange.length ? h('p', { class: 'small', text: `No range given (${r.inputs.noRange.length}): ${r.inputs.noRange.map(pathLabel).join('; ')}` }) : null,
    r.inputs.topSensitivityEstimates.length ? h('p', { class: 'warnbox small', text: `Unmeasured estimates among the three inputs that move the cash NPV most: ${r.inputs.topSensitivityEstimates.map(pathLabel).join('; ')}` }) : null,
    h('p', { class: 'small muted', text: `Unchanged tasks: ${r.inputs.unchangedTasks}` }),
    r.inputs.unconfirmed.map((u) => h('p', { class: 'small', text: `${pathLabel(u.path)}: ${u.why}` })),
    (r.inputs.reportedAgentCost ?? []).map((c) => h('p', { class: 'small', text: `Agent run cost for ${c.taskKind}: ${num(c.mean, 4)} ${c.currency} over ${c.runs} run(s) — ${c.basis}, not instrumented` })),
    r.pilot.length ? [h('h3', { text: 'Pilot size (rule of three, 95% one-sided)' }), r.pilot.map((x) => h('p', { class: x.likelyRateExceedsCeiling ? 'warnbox small' : 'small' },
      `${taskName(x.taskIri)}: ${x.runsNeeded} runs with no critical failure bound the rate below ${x.ceiling}; about ${x.weeksAtLikelyThroughput ?? '—'} week(s) at likely throughput.`,
      x.likelyRateExceedsCeiling ? ' The likely critical-failure rate is above the ceiling: a pilot cannot show this is below it.' : ''))] : null,
    h('details', null, h('summary', { text: 'Assumptions' }), h('ul', null, r.assumptions.map((a) => h('li', { text: a })))));
}

// ── View 6: decisions ────────────────────────────────────────────────────────────────────

function decisionsView() {
  const ds = data().decisions ?? [];
  const valuationOf = (d) => (data().valuations ?? []).find((v) => v.valuationIri === d.valuationIri);
  return h('section', null,
    h('h2', { text: 'Decisions' }),
    h('p', { class: 'small muted', text: `A submitted decision is Hypothetical. An approver who prepared none of it (proposal, valuation, submission), whose work it does not change and who answers for no agent it names countersigns it: then it reads "approved; prediction unmeasured" until someone who neither prepared nor approved it records what was measured, over the whole declared window. ${NO_TOTALS}` }),
    table(['Plan', 'Kind', 'Status', 'Predicted per week', 'Measured', 'Verdict', 'Basis', 'Disposition', 'Freed hours', ''], ds.map((d) => {
      const o = d.outcome;
      return h('tr', null,
        h('td', { text: planBy(d.planIri)?.title ?? short(d.planIri) }), h('td', { text: d.decisionKind }),
        h('td', null, chip(d.statusLabel, d.status === 'measured' ? 'good' : d.status === 'declined' ? 'bad' : 'warn'), demoChip(d)),
        h('td', { text: d.prediction ? `${metricName(d.prediction.metric)}: ${band(d.prediction.band, (n) => num(n, 0))}` : (d.probes ? `${d.probes.length} probe(s), never priced` : '—') }),
        h('td', { text: o?.valued ? num(o.valued.measured.weeklyValueDelta, 0) : o?.probes ? o.probes.map((p) => `#${p.index} ${p.signal}`).join(', ') : '—' }),
        h('td', null, o?.valued ? chip(o.valued.verdict, o.valued.verdict === 'in-band' ? 'good' : 'warn') : '—'),
        h('td', { text: d.basisLabel ?? '—' }), h('td', { text: o ? o.disposition : '—' }),
        h('td', { text: d.freedHours ? d.freedHours.perTask.map((f) => `${taskName(f.taskIri)}: ${f.disposition}`).join('; ') : '—' }),
        h('td', null, h('button', { text: S.decisionOpen === d.decisionIri ? 'Hide' : 'Open', on: { click: () => { S.decisionOpen = S.decisionOpen === d.decisionIri ? '' : d.decisionIri; render(); } } })));
    })),
    ds.filter((d) => d.decisionIri === S.decisionOpen).map((d) => decisionCard(d, valuationOf(d))),
    submitForm());
}

function submitForm() {
  // A plan whose staleness cannot be read (a record it was proposed against does not open) is not offered: the bridge would refuse it (409).
  const plans = (data().plans ?? []).filter((p) => !p.stale && !p.unreadable);
  const st = { planIri: plans[0]?.planIri ?? '', valuationIri: '', metric: 'weekly-cash-delta', basis: '', windowWeeks: 8, description: '', note: '' };
  const body = h('div');
  const draw = () => {
    const p = planBy(st.planIri);
    const vals = valuationsOf(st.planIri);
    if (!vals.some((v) => v.valuationIri === st.valuationIri)) st.valuationIri = vals.at(-1)?.valuationIri ?? '';
    body.replaceChildren(...[
      field('Plan', select(plans.map((x) => [x.planIri, `${x.title} (${x.planKind})`]), st.planIri, (e) => { st.planIri = e.target.value; draw(); })),
      p?.planKind === 'valued' ? [
        field('Valuation', select(vals.map((v) => [v.valuationIri, `valued ${when(v.head.validFrom)} — hash ${short(v.valuationHash)}`]), st.valuationIri, (e) => { st.valuationIri = e.target.value; })),
        vals.length === 0 ? h('p', { class: 'warnbox small', text: 'Value this plan first.' }) : null,
        field('What will be measured', select((data().vocabulary?.metrics ?? []).map((x) => [x, metricName(x)]), st.metric, (e) => { st.metric = e.target.value; })),
        field('Comparison (choose: a controlled comparison claims a comparison group you must actually have)', select([['', 'choose how the change will be compared'], ...(data().vocabulary?.comparisonBases ?? []).map((x) => [x, x === 'before-after' ? 'before-after — no comparison group' : x])], st.basis, (e) => { st.basis = e.target.value; draw(); })),
        field('Measurement window (weeks after countersign)', input(String(st.windowWeeks), (e) => { st.windowWeeks = Number(e.target.value); }, { type: 'number', min: 1, max: 104 })),
        field('How the comparison is made (optional)', input('', (e) => { st.description = e.target.value; }, { size: 50 })),
      ] : p ? h('div', { class: 'small' }, 'A probe decision carries no valuation and no prediction. Its probes:', h('ul', null, p.tasks.filter((r) => r.changed).flatMap((r) => (r.probes ?? []).map((pr) => h('li', { text: `${taskName(r.taskIri)}: ${pr.hypothesis}` }))))) : null,
      field('Note (optional)', input('', (e) => { st.note = e.target.value; }, { size: 50 })),
      h('button', { class: 'primary', disabled: !p || !can('operator') || (p.planKind === 'valued' && !st.basis), title: can('operator') ? (p?.planKind === 'valued' && !st.basis ? 'Choose the comparison first.' : '') : 'Only a registered operator submits.', text: 'Sign and submit', on: { click: () => {
        const v = (data().valuations ?? []).find((x) => x.valuationIri === st.valuationIri);
        act('wrd.submit_decision', 'wrd:submit-decision', {
          planIri: st.planIri, ...(st.note ? { note: st.note } : {}),
          ...(p?.planKind === 'valued' ? { valuationIri: st.valuationIri, valuationHash: v?.valuationHash, measurementPlan: { metric: st.metric, comparisonBasis: st.basis, windowWeeks: st.windowWeeks, ...(st.description ? { comparisonDescription: st.description } : {}) } } : {}),
        });
      } } }),
    ].flat());
  };
  draw();
  return h('details', { class: 'card' }, h('summary', { text: 'Submit a decision' }), body);
}

function decisionCard(d, v) {
  const head = d.head;
  const binding = { decisionIri: d.decisionIri, recordId: head.recordId, descriptorUrl: head.descriptorUrl, graphDigest: head.graphDigest };
  const objected = d.assignments.filter((a) => a.state === 'objected');
  const livePlan = (data().plans ?? []).find((p) => p.planIri === d.planIri);
  const liveObjections = livePlan?.assignments.filter((a) => a.state === 'objected') ?? objected;
  const liveSilent = livePlan?.assignments.filter((a) => a.state === 'not-acknowledged') ?? [];
  const considered = new Set();
  const overSilence = new Set();
  const csNote = input('', null, { placeholder: 'note (optional)', size: 40 });
  return h('div', { class: 'card' },
    h('h3', { text: `${planBy(d.planIri)?.title ?? 'Decision'} — ${d.statusLabel}` }), demoChip(d),
    d.prediction ? h('p', { text: `Predicted ${metricName(d.prediction.metric)} at steady state: ${band(d.prediction.band, (n) => num(n, 0))}; ramp ${d.prediction.rampMonths} month(s); prediction ${d.prediction.status}.` }) : null,
    d.measurementPlan ? h('p', { class: 'small', text: `Measured over ${d.measurementPlan.windowWeeks} week(s) after countersign; ${d.basisLabel}.` }) : null,
    h('p', { class: 'small', text: `${d.preparedBy ? `Prepared by: ${d.preparedBy.map((x) => `${x.role} ${x.personRef}`).join(', ')}` : `Submitted by ${d.submittedBy.personRef}`}. People whose work it changes: ${d.subjects.map((s) => labelOf(s.address)).join(', ') || 'none'}. Decision level: ${LEVEL_NAMES[d.decisionLevel] ?? d.decisionLevel}.` }),
    d.assignments.map((a) => h('div', { class: 'small', text: `${labelOf(a.personAddress)} on ${taskName(a.taskIri)}: ${a.state}${a.note ? ` — “${a.note}”` : ''}` })),
    d.grantChecks.map((g) => h('div', { class: 'small', text: `Grant for ${taskName(g.taskIri)}: ${g.active ? 'active' : 'not active'}${g.evidenceFromThisTask ? '' : '; grant evidence comes from other tasks'}` })),
    d.countersign ? h('p', { class: 'small', text: `${d.countersign.verdict === 'approve' ? 'Countersigned' : 'Declined'} by ${d.countersign.personRef} at ${when(d.countersign.at)}${d.countersign.objectionsConsidered.length ? `, over the named objection(s) on ${d.countersign.objectionsConsidered.map(taskName).join(', ')}` : ''}${(d.countersign.unacknowledgedConsidered ?? []).length ? `, over the silence of the person named on ${d.countersign.unacknowledgedConsidered.map(taskName).join(', ')}` : ''}.` }) : null,
    d.outcome ? outcomeNode(d) : null,
    d.next ? h('p', { class: 'warnbox', text: d.next }) : null,
    h('h3', { text: d.chainUnreadable ? CHAIN_CUT : CHAIN_WHOLE }),
    d.chainUnreadable ? h('p', { class: 'badbox small', text: d.chainUnreadable }) : null,
    table(['#', 'Status', 'Modal status', 'Signed by', 'At', 'Descriptor'], d.chain.map((c) => h('tr', null, h('td', { text: String(c.version) }), h('td', { text: c.status }), h('td', { text: c.modalStatus }),
      h('td', { text: c.signedBy.map((x) => labelOf(addrOfDid(x))).join(', ') }), h('td', { text: when(c.at) }), h('td', null, h('code', { text: c.descriptorUrl }))))),
    d.status === 'submitted' ? h('div', { class: 'card' }, h('strong', { text: 'Countersign or decline' }),
      h('p', { class: 'small muted', text: 'A registered approver who did not propose, value or submit it (from any of their keys), is not a person whose work it changes, and is not the accountable principal of an agent it puts on the work.' }),
      liveObjections.length ? h('div', null, h('div', { class: 'small', text: 'Objections you must name to approve over them:' }), liveObjections.map((a) => h('label', { class: 'inline' },
        h('input', { type: 'checkbox', on: { change: (e) => { if (e.target.checked) considered.add(a.taskIri); else considered.delete(a.taskIri); } } }),
        `${labelOf(a.personAddress)} on ${taskName(a.taskIri)}: “${a.note ?? ''}”`))) : null,
      liveSilent.length ? h('div', null, h('div', { class: 'small', text: 'Named but not acknowledged — silence is not assent; name each to approve over it, or ask them to acknowledge first:' }), liveSilent.map((a) => h('label', { class: 'inline' },
        h('input', { type: 'checkbox', on: { change: (e) => { if (e.target.checked) overSilence.add(a.taskIri); else overSilence.delete(a.taskIri); } } }),
        `${labelOf(a.personAddress)} on ${taskName(a.taskIri)}`))) : null,
      csNote,
      h('button', { class: 'primary', text: 'Approve', on: { click: () => act('wrd.countersign_decision', 'wrd:countersign-decision', { ...binding, verdict: 'approve', objectionsConsidered: [...considered], unacknowledgedConsidered: [...overSilence], ...(csNote.value ? { note: csNote.value } : {}) }) } }),
      h('button', { text: 'Decline', on: { click: () => act('wrd.countersign_decision', 'wrd:countersign-decision', { ...binding, verdict: 'decline', ...(csNote.value ? { note: csNote.value } : {}) }) } }),
      payloadButton('wrd:countersign-decision', { decision_iri: d.decisionIri })) : null,
    d.status === 'countersigned' ? outcomeForm(d, binding) : null,
    h('button', { text: 'Print summary', on: { click: () => printDecision(d, v) } }));
}

function outcomeNode(d) {
  const o = d.outcome;
  if (o.valued) {
    const x = o.valued;
    return h('div', { class: 'card' }, h('strong', { text: 'Measured' }), ' ', chip(x.verdict, x.verdict === 'in-band' ? 'good' : 'warn'),
      h('p', { class: 'small', text: `${num(x.measured.weeklyValueDelta, 0)} per week${x.measured.interval ? ` (interval ${num(x.measured.interval.low, 0)} to ${num(x.measured.interval.high, 0)})` : ''} against the ${x.rampAdjusted ? `ramp-adjusted (×${num(x.rampFactor, 3)}) ` : ''}band ${band(x.adjustedBand, (n) => num(n, 0))}. Window ${when(x.measured.windowStart)} to ${when(x.measured.windowEnd)}; ${x.measured.comparisonBasis === 'before-after' ? 'before-after — no comparison group' : x.measured.comparisonBasis}${x.basisChanged ? ' (not the basis the plan declared)' : ''}. ${x.measured.method}` }),
      x.windowShorterThanPlanned ? h('p', { class: 'warnbox small', text: `Measured over less than the ${x.windowWeeks ?? ''} week(s) the plan declared (the change was ${o.disposition}): kept out of the calibration cells.` }) : null,
      x.pilotCheck ? h('p', { class: 'small', text: `Pilot: ${x.pilotCheck.reviewedRuns} person-reviewed run(s) logged in the window, ${x.pilotCheck.criticalFailures} critical failure(s); ${x.pilotCheck.ceilingSupported ? 'enough clean runs to bound the rate below the ceiling' : `not enough to bound it (needs ${x.pilotCheck.runsNeeded} clean runs)`}.${x.pilotCheck.declared ? ` Declared by the grader: ${x.pilotCheck.declared.runsObserved ?? '—'} runs, ${x.pilotCheck.declared.criticalFailuresObserved ?? '—'} critical failure(s) (not counted).` : ''}` }) : null,
      h('p', { class: 'small', text: `Disposition: ${o.disposition}${o.dispositionNote ? ` — ${o.dispositionNote}` : ''}. Recorded by ${o.personRef} at ${when(o.at)}.` }));
  }
  return h('div', { class: 'card' }, h('strong', { text: 'Probes read' }),
    (o.probes ?? []).map((p) => h('div', { class: 'small', text: `${taskName(p.taskIri)} probe ${p.index}: ${p.signal}${p.pastTimebox ? ' (ran past its timebox)' : ''} — ${p.observed}` })),
    h('p', { class: 'small', text: `Disposition: ${o.disposition}${o.dispositionNote ? ` — ${o.dispositionNote}` : ''}. Recorded by ${o.personRef}.` }));
}

function outcomeForm(d, binding) {
  const cs = d.countersign?.at ?? '';
  const st = { disposition: 'kept', note: '', measured: '', low: '', high: '', basis: d.measurementPlan?.comparisonBasis ?? 'staggered',
    windowStart: cs, windowEnd: d.measurementPlan ? plusWeeks(cs, d.measurementPlan.windowWeeks) : cs, method: '', runs: '', critical: '',
    probes: (d.probes ?? []).map((p) => ({ taskIri: p.taskIri, index: p.index, signal: 'neither', observed: '', windowStart: cs, windowEnd: plusWeeks(cs, p.timeboxWeeks) })) };
  const send = () => {
    const common = { ...binding, disposition: st.disposition, ...(st.note ? { dispositionNote: st.note } : {}) };
    if (d.decisionKind === 'valued') {
      act('wrd.record_outcome', 'wrd:record-outcome', { ...common, measured: {
        weeklyValueDelta: Number(st.measured), ...(st.low !== '' && st.high !== '' ? { interval: { low: Number(st.low), high: Number(st.high) } } : {}),
        comparisonBasis: st.basis, windowStart: st.windowStart, windowEnd: st.windowEnd, method: st.method,
        ...(st.runs !== '' ? { runsObserved: Number(st.runs) } : {}), ...(st.critical !== '' ? { criticalFailuresObserved: Number(st.critical) } : {}),
      } });
    } else {
      act('wrd.record_outcome', 'wrd:record-outcome', { ...common, probeResults: st.probes.map((p) => ({ ...p })) });
    }
  };
  return h('div', { class: 'card' }, h('strong', { text: 'Record what was measured' }),
    h('p', { class: 'small muted', text: 'Someone who neither prepared nor approved the decision, after the whole declared window has ended (a shorter window only for a change stopped early or reverted, and then kept out of calibration). The platform grades the value against the predicted band scaled for the declared ramp; an interval that straddles a band edge is inconclusive. The pilot check counts the person-reviewed runs logged in the window; counts typed here are shown beside it as declared.' }),
    field('What happened to the change', select((data().vocabulary?.dispositions?.outcome ?? []).map((x) => [x, x]), st.disposition, (e) => { st.disposition = e.target.value; })),
    field('Note (required unless kept)', input('', (e) => { st.note = e.target.value; }, { size: 50 })),
    d.decisionKind === 'valued' ? [
      field(`Measured ${metricName(d.prediction?.metric ?? '')} (per week)`, input('', (e) => { st.measured = e.target.value; }, { type: 'number', step: 'any' })),
      h('div', { class: 'row' }, field('Interval low (optional)', input('', (e) => { st.low = e.target.value; }, { type: 'number', step: 'any' })), field('Interval high', input('', (e) => { st.high = e.target.value; }, { type: 'number', step: 'any' }))),
      field('Comparison', select((data().vocabulary?.comparisonBases ?? []).map((x) => [x, x === 'before-after' ? 'before-after — no comparison group' : x]), st.basis, (e) => { st.basis = e.target.value; })),
      field('Window start (ISO)', input(st.windowStart, (e) => { st.windowStart = e.target.value.trim(); }, { size: 26 })),
      field('Window end (ISO)', input(st.windowEnd, (e) => { st.windowEnd = e.target.value.trim(); }, { size: 26 })),
      field('How it was measured', input('', (e) => { st.method = e.target.value; }, { size: 50 })),
      h('div', { class: 'row' }, field('Agent runs observed (optional, declared)', input('', (e) => { st.runs = e.target.value; }, { type: 'number', min: 0 })), field('Critical failures observed (declared)', input('', (e) => { st.critical = e.target.value; }, { type: 'number', min: 0 }))),
    ] : st.probes.map((p) => h('div', { class: 'card' }, h('div', { class: 'small', text: `${taskName(p.taskIri)} probe ${p.index}` }),
      field('Which declared condition fired', select(['amplify', 'dampen', 'neither'].map((x) => [x, x]), p.signal, (e) => { p.signal = e.target.value; })),
      field('What was observed', input('', (e) => { p.observed = e.target.value; }, { size: 50 })),
      field('Window start (ISO)', input(p.windowStart, (e) => { p.windowStart = e.target.value.trim(); }, { size: 26 })),
      field('Window end (ISO)', input(p.windowEnd, (e) => { p.windowEnd = e.target.value.trim(); }, { size: 26 })))),
    h('button', { class: 'primary', text: 'Sign the outcome', on: { click: send } }));
}

function printDecision(d, v) {
  const target = document.getElementById('print');
  if (!target) return;
  const r = v?.result;
  target.replaceChildren(
    h('h1', { text: `Decision: ${planBy(d.planIri)?.title ?? d.decisionIri}` }),
    d.demo ? h('p', null, chip(data().demoLabel || 'scripted by the offline demo, not evidence', 'demo')) : null,
    h('p', { text: `${d.decisionKind} decision — ${d.statusLabel}. Pod ${data().podUrl}. Decision ${d.decisionIri}.` }),
    d.prediction ? h('p', { text: `Predicted ${metricName(d.prediction.metric)}: ${band(d.prediction.band, (n) => num(n, 0))} (ramp ${d.prediction.rampMonths} months; prediction ${d.prediction.status}).` }) : null,
    r ? h('p', { text: `Cash weekly change ${band(r.scenarios.cash.weeklyDelta, (n) => money(n, r.currency))}; if redeployed ${band(r.scenarios.redeployed.weeklyDelta, (n) => money(n, r.currency))}. NPV (cash) ${band(r.scenarios.cash.npv, (n) => money(n, r.currency))}. Seed ${r.seed}, ${r.draws} draws.` }) : null,
    d.measurementPlan ? h('p', { text: `Measurement: ${d.measurementPlan.windowWeeks} weeks after countersign; ${d.basisLabel}.` }) : null,
    d.outcome ? outcomeNode(d) : null,
    h('h2', { text: d.chainUnreadable ? CHAIN_CUT : CHAIN_WHOLE }),
    d.chainUnreadable ? h('p', { class: 'badbox', text: `${CHAIN_CUT_PRINT} ${d.chainUnreadable}` }) : null,
    table(['#', 'Status', 'Modal status', 'Signed by', 'At'], d.chain.map((c) => h('tr', null, h('td', { text: String(c.version) }), h('td', { text: c.status }), h('td', { text: c.modalStatus }),
      h('td', { text: c.signedBy.join(', ') }), h('td', { text: when(c.at) })))),
    h('p', { text: NO_TOTALS }));
  window.print();
}

// ── View 7: calibration ──────────────────────────────────────────────────────────────────

function calibrationView() {
  const c = S.cal;
  if (!c) return h('section', null, h('h2', { text: 'Calibration' }), h('p', { class: 'muted', text: 'Reading…' }));
  return h('section', null,
    h('h2', { text: 'Calibration: did the predictions land?' }),
    c.recordKeyMismatch ? h('p', { class: 'badbox small', text: `Another record key: ${c.recordKeyMismatch.why}` }) : null,
    Object.values(c.unreadable ?? {}).map((why) => h('p', { class: 'badbox small', text: why })),
    h('p', { class: 'small muted', text: `A prediction cell counts measured decisions whose value landed in the ramp-adjusted P10–P90 band (nominal coverage ${c.nominalBandCoverage}). Cells stay Hypothetical below ${c.minSamples} samples. Inconclusive outcomes are excluded and counted.` }),
    table(['Kind', 'Samples', 'In band', 'Mean Brier', 'Mean level distance', 'Status', 'Excluded (inconclusive)', 'Excluded (short window)', 'Ramp-adjusted', 'Dispositions', ''],
      (c.predictionCells ?? []).map((x) => h('tr', null, h('td', null, x.label, x.basisClass === 'uncontrolled' ? chip('no comparison group', 'warn') : null),
        h('td', { class: 'num', text: String(x.samples) }), h('td', { class: 'num', text: `${pct(x.hitRate)} vs ${pct(c.nominalBandCoverage)}` }), h('td', { class: 'num', text: num(x.meanBrier, 3) }),
        h('td', { class: 'num', text: num(x.meanOrdinalDistance, 3) }), h('td', null, chip(x.status, x.status === 'Asserted' ? 'good' : 'warn')), h('td', { class: 'num', text: String(x.excludedInconclusive) }),
        h('td', { class: 'num', text: String(x.excludedShortWindow ?? 0) }),
        h('td', { class: 'num', text: String(x.rampAdjusted) }), h('td', { text: Object.entries(x.dispositions).map(([k, n]) => `${k} ${n}`).join(', ') }),
        h('td', null, x.scriptedLabel ? chip(x.scriptedLabel, 'demo') : null)))),
    h('h3', { text: 'Probe signals' }),
    c.probeSignals ? h('p', null, `${c.probeSignals.label}. ${c.probeSignals.probes} probe(s): ${c.probeSignals.amplify} amplify, ${c.probeSignals.dampen} dampen, ${c.probeSignals.neither} neither; a declared condition fired ${c.probeSignals.conditionFired} time(s). `,
      c.probeSignals.scriptedLabel ? chip(c.probeSignals.scriptedLabel, 'demo') : null) : null,
    h('h3', { text: 'Agents: how often a person accepted the work, and how well the agent judged its own runs' }),
    h('p', { class: 'small muted', text: 'Accepted is the share of reviewed runs a person accepted: what a grant rests on. Self-assessment agreement (and its Brier) is how often the agent\'s own verdict matched the person\'s: an agent can label its failures truthfully and still do poor work.' }),
    table(['Agent', 'Kind of task', 'Model', 'Samples', 'Accepted by a person', 'Self-assessment agreement', 'Mean Brier', 'Ready claims', 'Ready-claim precision', 'Distinct reviewers', 'Status', 'Grant', ''],
      (c.agentCells ?? []).map((x) => h('tr', null, h('td', { text: labelOf(x.agentAddress) }), h('td', { text: x.taskKind }),
        h('td', null, x.model, x.currentModel ? null : chip('not the declared model now', 'warn')), h('td', { class: 'num', text: String(x.samples) }), h('td', { class: 'num', text: pct(x.acceptedShare) }), h('td', { class: 'num', text: pct(x.hitRate) }),
        h('td', { class: 'num', text: num(x.meanBrier, 3) }), h('td', { class: 'num', text: String(x.readyClaims ?? '—') }), h('td', { class: 'num', text: pct(x.readyClaimPrecision) }),
        h('td', { title: x.distinctConfirmersNote, text: `${x.distinctConfirmers} (${x.distinctConfirmersNote})` }), h('td', null, chip(x.status, x.status === 'Asserted' ? 'good' : 'warn')),
        h('td', { text: x.grant.active ? 'active' : x.grant.why }), h('td', null, x.scriptedLabel ? chip(x.scriptedLabel, 'demo') : null)))),
    (c.awaitingAPerson ?? []).length ? h('p', { class: 'warnbox small', text: `${c.awaitingAPerson.length} run(s) acted under a grant await a person's review; they count toward nothing until reviewed.` }) : null);
}

// ── View 8: agents and grants ────────────────────────────────────────────────────────────

function agentsView() {
  const d = data();
  const agentPersonas = personas().filter((p) => member(p.address)?.softwareAgent);
  const st = { persona: agentPersonas[0]?.id ?? '', taskIri: tasks().find((t) => t.status !== 'retired')?.taskIri ?? '', runId: `run-${randomHex(4)}`, output: '', answer: 'accepted',
    cost: '', currency: 'USD', underGrant: false, review: true, verdict: 'accepted', note: '', pasted: '' };
  const latestTime = () => [...tasks().map((t) => t.head.validFrom), ...(d.decisions ?? []).flatMap((x) => x.chain.map((c) => c.at))].filter(Boolean).sort().at(-1);
  const logRun = async () => {
    let run;
    const t = taskBy(st.taskIri);
    if (S.mode === 'demo') {
      const agent = personas().find((p) => p.id === st.persona)?.address ?? '';
      const g = activeGrant(agent, t?.taskKind);
      const payload = {
        intent: 'wrd:agent-run', podUrl: d.podUrl, runId: st.runId, taskIri: st.taskIri, taskKind: t?.taskKind, model: member(agent)?.model,
        outputSha256: await sha256Hex(st.output), selfAssessment: { answer: st.answer },
        // The demo server's clock is scripted; the newest record time on the pod is its current reading.
        performedAt: latestTime() ?? new Date().toISOString(),
        ...(st.underGrant && g ? { underGrant: g.grantIri } : {}),
        ...(st.cost !== '' ? { costPerRun: { amount: Number(st.cost), currency: st.currency } } : {}),
      };
      try { run = await sign(payload, st.persona); } catch { return; }
    } else {
      try { run = JSON.parse(st.pasted); } catch (e) { showResult('wrd.log_agent_run', { ok: false, status: 0, body: { error: 'The run envelope is not JSON.', 'iep:refusalReason': String(e.message) } }); return; }
    }
    let reviewEnv;
    if (st.review) {
      try { reviewEnv = await sign({ intent: 'wrd:review-agent-run', podUrl: d.podUrl, runEnvelopeSha256: await envelopeSha256(run), verdict: st.verdict, ...(st.note ? { note: st.note } : {}) }); } catch { return; }
    }
    send('wrd.log_agent_run', { run_envelope: run, ...(reviewEnv ? { review_envelope: reviewEnv } : {}) });
  };
  const reviewPanel = (a) => {
    const verdict = h('select', null, ['accepted', 'reworked', 'critical-failure'].map((v) => h('option', { value: v, text: v })));
    const note = input('', null, { placeholder: 'note (optional)', size: 40 });
    openPanel(`Review a run of ${labelOf(a.agentAddress)} on “${taskName(a.taskIri)}”`, h('div', null,
      h('p', { class: 'small muted', text: `The agent called it: ${a.runEnvelope.payload.selfAssessment?.answer}. Your verdict is what counts; the agent's principal cannot review its runs.` }),
      field('Your verdict', verdict), note,
      h('button', { class: 'primary', text: 'Sign the review', on: { click: async () => {
        let env;
        try { env = await sign({ intent: 'wrd:review-agent-run', podUrl: d.podUrl, runEnvelopeSha256: await envelopeSha256(a.runEnvelope), verdict: verdict.value, ...(note.value ? { note: note.value } : {}) }); } catch { return; }
        send('wrd.log_agent_run', { run_envelope: a.runEnvelope, review_envelope: env });
      } } })));
  };
  const grantForm = { agent: agentsList()[0]?.address ?? '', kind: kindsList(false)[0]?.slug ?? '' };
  return h('section', null,
    h('h2', { text: 'Agents and grants' }),
    h('p', { class: 'small muted', text: 'An agent earns a grant to act alone on one registered kind of task only from runs a person reviewed, on its currently declared model. Revocation and model changes are checked on every use. People are never given enforced grants.' }),
    table(['Agent', 'Kind of task', 'Model', '#Reviewed', '#Acted under grant', 'Cost per run (agent-reported, reviewed runs)'], (d.runs ?? []).map((r) => h('tr', null,
      h('td', { text: labelOf(r.agentAddress) }), h('td', { text: r.taskKind }), h('td', { text: r.model }), h('td', { class: 'num', text: String(r.reviewed) }), h('td', { class: 'num', text: String(r.actedUnderGrant) }),
      h('td', { text: r.reportedCost ? `${num(r.reportedCost.mean, 4)} ${r.reportedCost.currency} over ${r.reportedCost.runs}` : '—' })))),
    d.unreadable?.runs ? h('p', { class: 'badbox small', text: d.unreadable.runs }) : null,
    h('details', { class: 'card' }, h('summary', { text: 'Log a run' }),
      S.mode === 'demo' ? [
        field('Signed by the agent (demo persona)', select(agentPersonas.map((p) => [p.id, p.label]), st.persona, (e) => { st.persona = e.target.value; })),
        field('Task', select(tasks().filter((t) => t.status !== 'retired').map((t) => [t.taskIri, `${t.name} (${t.taskKind})`]), st.taskIri, (e) => { st.taskIri = e.target.value; })),
        field('Run id', input(st.runId, (e) => { st.runId = e.target.value; })),
        field('The output (only its sha256 is recorded)', textarea('', (e) => { st.output = e.target.value; })),
        field('The agent\'s own assessment', select([['accepted', 'ready to accept'], ['reworked', 'needs rework'], ['critical-failure', 'critical failure']], st.answer, (e) => { st.answer = e.target.value; })),
        h('div', { class: 'row' }, field('Cost of this run (optional)', input('', (e) => { st.cost = e.target.value; }, { type: 'number', step: 'any', min: 0 })), field('Currency', input(st.currency, (e) => { st.currency = e.target.value.toUpperCase(); }, { size: 4 }))),
        h('label', { class: 'inline' }, h('input', { type: 'checkbox', on: { change: (e) => { st.underGrant = e.target.checked; } } }), 'the agent acted under its grant (only a run it calls ready, on a task an approved decision put under the grant)'),
      ] : field('Run envelope signed by the agent\'s own key (JSON {payload, signature})', textarea('', (e) => { st.pasted = e.target.value; }, { class: 'tall' })),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: true, on: { change: (e) => { st.review = e.target.checked; } } }), 'review it now, signed by the acting identity'),
      field('Your verdict', select([['accepted', 'accepted'], ['reworked', 'reworked'], ['critical-failure', 'critical failure']], st.verdict, (e) => { st.verdict = e.target.value; })),
      input('', (e) => { st.note = e.target.value; }, { placeholder: 'review note (optional)', size: 40 }),
      h('button', { class: 'primary', text: 'Sign and log', on: { click: logRun } })),
    h('h3', { text: 'Awaiting a person' }),
    d.unreadable?.awaitingReview ? h('p', { class: 'badbox small', text: d.unreadable.awaitingReview }) : null,
    (d.awaitingReview ?? []).length === 0 ? h('p', { class: 'muted small', text: d.unreadable?.awaitingReview ? 'No run that can be read awaits review.' : 'No run acted under a grant awaits review.' })
      : (d.awaitingReview ?? []).map((a) => h('div', { class: 'small' }, `${labelOf(a.agentAddress)} on “${taskName(a.taskIri)}” (${a.taskKind}) `, demoChip(a), h('button', { text: 'Review', on: { click: () => reviewPanel(a) } }))),
    h('h3', { text: 'Grants' }),
    table(['Agent', 'Kind of task', 'Principal', 'Model', 'Status', 'Evidence', ''], (d.grants ?? []).map((g) => h('tr', null,
      h('td', { text: labelOf(g.agentAddress) }), h('td', { text: g.taskKind }), h('td', { text: labelOf(g.principal) }), h('td', { text: g.model }),
      h('td', null, chip(g.status, g.active ? 'good' : 'bad'), g.active ? null : h('div', { class: 'small', text: g.why }), demoChip(g),
        g.chainUnreadable ? h('div', { class: 'badbox small', text: g.chainUnreadable }) : null),
      h('td', { class: 'small', text: `${g.evaluation.samples} reviewed runs, ${pct(g.evaluation.acceptedShare)} accepted by a person, ${g.evaluation.distinctConfirmers} ${g.evaluation.distinctConfirmersNote}; ${g.evaluation.readyClaims ?? '—'} ready claims, precision ${pct(g.evaluation.readyClaimPrecision)}; from ${g.evidenceTaskIris.map(taskName).join(', ')}` }),
      h('td', null, g.status === 'granted' ? h('button', { text: 'Revoke…', on: { click: () => revokePanel(g) } }) : g.revokedAt ? h('span', { class: 'small', text: `revoked ${when(g.revokedAt)}: ${g.revocationWhy}` }) : null)))),
    h('div', { class: 'card' }, h('strong', { text: 'Evaluate and grant' }),
      field('Agent', select(agentsList().map((m) => [m.address, `${m.label} — model ${m.model}`]), grantForm.agent, (e) => { grantForm.agent = e.target.value; })),
      field('Kind of task', select(kindsList(false).map((k) => [k.slug, k.label]), grantForm.kind, (e) => { grantForm.kind = e.target.value; })),
      h('button', { class: 'primary', disabled: !can('approver'), title: can('approver') ? '' : 'Only a registered approver grants.', text: 'Evaluate and sign the grant', on: { click: () => act('wrd.grant_autonomy', 'wrd:grant-autonomy', { agentAddress: grantForm.agent, taskKind: grantForm.kind }) } })));
}

function revokePanel(g) {
  const why = textarea('', null, { placeholder: 'Why the grant is revoked' });
  openPanel(`Revoke ${labelOf(g.agentAddress)}'s grant on ${g.taskKind}`, h('div', null,
    h('p', { class: 'small muted', text: 'The grant record is withdrawn (Retracted) with its window ending now. Every later use is refused; re-earning counts only runs reviewed after this.' }),
    field('Why', why),
    h('button', { class: 'primary', text: 'Sign the revocation', on: { click: () => act('wrd.revoke_grant', 'wrd:revoke-grant', { grantIri: g.grantIri, recordId: g.head.recordId, descriptorUrl: g.head.descriptorUrl, graphDigest: g.head.graphDigest, why: why.value.trim() }) } })));
}

function evaluationNode(e) {
  if (!e) return null;
  return h('div', { class: 'small' }, h('div', null, e.earned ? chip('earned', 'good') : chip('not earned', 'warn'), ` ${e.why}`),
    h('div', { text: `${e.samples} person-reviewed run(s) on model ${e.model}${e.countedSince ? ` since ${when(e.countedSince)}` : ''}; ${pct(e.acceptedShare)} of them accepted by a person (the competence rating, ${num(e.rating, 3)}); ${e.distinctConfirmers} ${e.distinctConfirmersNote}; ${e.readyClaims ?? '—'} run(s) the agent called ready, ${pct(e.readyClaimPrecision)} of them accepted; ${e.criticalFailures} critical failure(s).` }));
}

// ── View 9: my record ────────────────────────────────────────────────────────────────────

function meView() {
  const me = actor();
  if (!me) return h('section', null, h('h2', { text: 'My record' }), h('p', { class: 'warnbox', text: READ_ONLY }));
  const did = `did:ethr:${me}`;
  const d = data();
  const mine = tasks().filter((t) => t.namedParties.some((p) => p.address === me) || (t.owedRatification ?? []).some((p) => p.address === me));
  const signed = [
    ...(d.workflows ?? []).map((w) => ['Workflow', w.title, w]), ...tasks().map((t) => ['Task', t.name, t]),
    ...(d.plans ?? []).map((p) => ['Plan', p.title, p]), ...(d.decisions ?? []).map((x) => ['Decision', planBy(x.planIri)?.title ?? x.decisionIri, x]),
    ...(d.grants ?? []).map((g) => ['Grant', `${labelOf(g.agentAddress)} on ${g.taskKind}`, g]),
  ].filter(([, , row]) => row.head?.signedBy?.includes(did));
  const myPlans = (d.plans ?? []).filter((p) => p.tasks.some((r) => r.changed && [r.current.personAddress, r.current.agentAddress, r.proposed.personAddress, r.proposed.agentAddress].includes(me)));
  const freed = (d.valuations ?? []).filter((v) => myPlans.some((p) => p.planIri === v.planIri))
    .flatMap((v) => v.result.freedPersonHours.perTask.filter((f) => mine.some((t) => t.taskIri === f.taskIri)).map((f) => ({ ...f, plan: planBy(v.planIri)?.title })));
  return h('section', null,
    h('h2', { text: 'My record' }),
    h('p', { class: 'small muted', text: 'Every record that names you or carries your signature, with every version. Take a copy to a pod you hold, or download it; each copy keeps the platform\'s original signature. This page does not verify a download: the README gives the command that does, offline, against the platform address you expect.' }),
    h('p', { class: 'small' }, 'The platform address these records should be signed by: ', h('code', { text: d.bridge?.platform?.address ?? 'not reported' }), d.bridge?.platform?.keyKind === 'ephemeral' ? chip('ephemeral key: not trusted after a restart', 'warn') : null),
    h('h3', { text: 'Tasks that name me' }),
    mine.length === 0 ? h('p', { class: 'muted small', text: 'None.' }) : mine.map((t) => h('div', { class: 'small' }, h('a', { href: t.link, text: t.name }), ' ', statusChip(t.status), demoChip(t))),
    h('h3', { text: 'Current versions carrying my signature' }),
    signed.length === 0 ? h('p', { class: 'muted small', text: 'None.' }) : signed.map(([k, title, row]) => h('div', { class: 'small' }, chip(k), ` ${title} `, demoChip(row))),
    freed.length ? [h('h3', { text: 'What plans say happens to hours on my work' }), freed.map((f) => h('div', { class: 'small', text: `${f.plan}: ${taskName(f.taskIri)} — ${band(f.band, (n) => num(n, 1))} hours a week; ${f.disposition}${f.note ? ` (${f.note})` : ''}` }))] : null,
    holderCard(d.podUrl));
}

/**
 * Copy to a pod, or download: wrd.holder_copy, signed as the acting identity. It needs no read
 * model, so it works for a signer whose read is refused: `podUrl` null asks the bridge which pod it
 * serves (the unsigned template names it), and a refused re-read afterwards leaves the answer shown.
 */
function holderCard(podUrl) {
  const me = actor();
  const target = input('', null, { placeholder: 'https://your-pod.example/you/', size: 40 });
  const copy = async (fields) => {
    if (S.busy) return null;
    let pod = podUrl;
    if (!pod) {
      const t = await call('wrd.envelope_template', { intent: 'wrd:holder-copy', pod_url: S.pod || undefined });
      if (!t.ok) { showResult('wrd.envelope_template', t); return null; }
      pod = t.body.template?.podUrl;
    }
    S.busy = true;
    S.result = { pending: true, tool: 'wrd.holder_copy' };
    render();
    let r;
    try {
      const envelope = await sign({ intent: 'wrd:holder-copy', podUrl: pod, ...fields });
      r = await call('wrd.holder_copy', { envelope, pod_url: S.pod || undefined });
    } catch (e) {
      S.busy = false;
      if (!(e instanceof NotSigned)) showResult('wrd.holder_copy', { ok: false, status: 0, body: { error: 'Signing did not complete.', 'iep:refusalReason': String(e?.message ?? e) } });
      else render();
      return null;
    }
    S.busy = false;
    S.result = { tool: 'wrd.holder_copy', ...r };
    await refresh(true);
    return r.ok ? r.body : null;
  };
  const download = async () => {
    const out = await copy({});
    if (!out) return;
    const blob = new Blob([JSON.stringify({ holder: out.holder, receipt: out.receiptUrl, bundle: out.bundle }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `wrd-record-${me}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return h('div', { class: 'card' }, field('Copy to my pod', target),
    h('button', { class: 'primary', text: 'Sign and copy', on: { click: () => copy({ targetPodUrl: target.value.trim() }) } }),
    h('button', { text: 'Download my record', on: { click: download } }));
}

boot();
