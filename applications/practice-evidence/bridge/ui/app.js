// practice-evidence web client.
//
// A Path-A client: it reads this bridge's affordance manifest (GET affordances?format=jsonld),
// indexes it by action IRI, and invokes every act at the path the manifest names, on this page's
// own origin. It adds no endpoint of its own and decides nothing the bridge does not: which
// controls an attempt shows comes from the attempt's own `nextActions`, every refusal is the
// bridge's, and every score on the page was computed by the bridge from the rubric.
//
// Signing. Every act that changes or reveals a person's record is signed by that person:
//   · demo mode: the bridge holds demo role keys and signs as the role picked here (and every
//     record it writes says so); detected by asking pev.sign_as_demo_role for its roles;
//   · wallet mode: an EIP-191 personal_sign over canonicalJson(payload) by the connected wallet;
//   · paste mode: the page shows the exact text to sign; the person pastes the signature.
// The page never holds a private key.
//
// Untrusted text (everything that came from a pod, a person or a model) is rendered through
// textContent only. No markup is ever parsed from a string anywhere in this file.

const ACT = {
  registerRole: 'urn:iep:action:pev:register-role',
  authorScenario: 'urn:iep:action:pev:author-scenario',
  draftScenarioPacket: 'urn:iep:action:pev:draft-scenario-packet',
  draftScenario: 'urn:iep:action:pev:draft-scenario',
  ratifyScenario: 'urn:iep:action:pev:ratify-scenario',
  listScenarios: 'urn:iep:action:pev:list-scenarios',
  startAttempt: 'urn:iep:action:pev:start-attempt',
  say: 'urn:iep:action:pev:say',
  counterpartPacket: 'urn:iep:action:pev:counterpart-packet',
  recordTurns: 'urn:iep:action:pev:record-turns',
  endConversation: 'urn:iep:action:pev:end-conversation',
  judgeAttempt: 'urn:iep:action:pev:judge-attempt',
  judgePacket: 'urn:iep:action:pev:judge-packet',
  recordJudgment: 'urn:iep:action:pev:record-judgment',
  reviewQueue: 'urn:iep:action:pev:review-queue',
  countersignAttempt: 'urn:iep:action:pev:countersign-attempt',
  overrideAttempt: 'urn:iep:action:pev:override-attempt',
  contestReview: 'urn:iep:action:pev:contest-review',
  retractReview: 'urn:iep:action:pev:retract-review',
  calibration: 'urn:iep:action:pev:calibration',
  scenarioResults: 'urn:iep:action:pev:scenario-results',
  projectAttempt: 'urn:iep:action:pev:project-attempt',
  holderCopy: 'urn:iep:action:pev:holder-copy',
  exportRecord: 'urn:iep:action:pev:export-record',
  redactAttempt: 'urn:iep:action:pev:redact-attempt',
  getAttempt: 'urn:iep:action:pev:get-attempt',
  signAsDemoRole: 'urn:iep:action:pev:sign-as-demo-role',
};

const S = {
  manifest: new Map(),          // action IRI → { method, path, toolName, title }
  pod: '',
  needPod: false,
  bridge: null,                 // list_scenarios' `bridge`: routes, key kind, platform address, demo signing
  mode: 'paste',                // 'demo' | 'wallet' | 'paste'
  demoRoles: [],
  role: 'learner',
  account: null,
  hasWallet: false,
  byok: { on: false, key: '', model: '' },
  readEnvelopes: new Map(),     // signed read envelopes, reused for up to 9 minutes
  unsent: new Map(),            // the learner's unsent line per attempt, kept across refusals
  judgmentShown: new Map(),     // attempt IRI → judgment index whose quotes are highlighted
  queueEntries: new Map(),      // attempt IRI → review queue entry (blindFirst and factors)
  reviewDrafts: new Map(),      // attempt IRI → { picks, whys, revealed }
  showDrafts: false,
  pooled: false,
  author: null,
  seq: 0,
};

const READ_ENVELOPE_MS = 9 * 60 * 1000;
const STATE_WORDS = {
  'in-conversation': 'in conversation',
  'ended': 'ended: not judged yet',
  'judged': 'judged by AI: provisional, not reviewed',
  'countersigned': 'confirmed by a reviewer',
  'overridden': 'levels set by a reviewer',
  'contested': 'contested: waiting for another reviewer',
  'review-retracted': 'review withdrawn',
  'redacted': 'transcript removed',
};
const REGIME_WORDS = {
  evident: 'Evident: the good answer is obvious to anyone in the role',
  knowable: 'Knowable: people with expertise can say what good looks like',
  emergent: 'Emergent: what works only shows in hindsight',
  turbulent: 'Turbulent: no stable pattern to judge against yet',
  unclassified: 'Not classified yet',
};
const CHOSEN_BY_WORDS = {
  'bridge-config': 'this bridge\'s configured model',
  'judge-registry': 'a judge registered by the admin',
  'learner': 'the learner, with their own key',
  'reviewer': 'a reviewer, with their own key',
};
const FACTOR_WORDS = {
  unverified: 'a quote did not check out',
  notQuoted: 'criteria put at the lowest level with no quote (nothing was checked)',
  disagreement: 'the judgments disagree',
  nearThreshold: 'close to the pass mark',
  uncertainty: 'the judge\'s own uncertainty',
  cellNeed: 'few reviewed outcomes for this judge and criterion',
  learnerControlled: 'the learner controlled the other person or chose the judge',
  auditSample: 'in the audit sample (blind first)',
};

const STATUS_WORDS = {
  verified: 'verified',
  unverified: 'unverified',
  'no-quote-needed': 'no quote needed: lowest level, nothing checked',
};
/** A criterion's verification status as a chip: green only when a quote really checked out. */
function statusChip(status) {
  return chip(STATUS_WORDS[status] || status, status === 'verified' ? 'ok' : status === 'unverified' ? 'bad' : '');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  DOM: elements are built, never parsed from strings
// ════════════════════════════════════════════════════════════════════════════════════════════

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') e.className = String(v);
    else if (k === 'value') e.value = String(v);
    else if (k === 'checked') e.checked = Boolean(v);
    else if (k === 'disabled') e.disabled = Boolean(v);
    else if (k === 'readOnly') e.readOnly = Boolean(v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return e;
}

const $ = (sel) => document.querySelector(sel);
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
const short = (s) => {
  const t = String(s || '');
  const m = /0x[0-9a-fA-F]{40}/.exec(t);
  return m ? `${m[0].slice(0, 6)}…${m[0].slice(-4)}` : (t.length > 28 ? `${t.slice(0, 25)}…` : t);
};
const shortHash = (s) => String(s || '').slice(0, 12);
const toolOf = (action) => `pev.${String(action || '').replace('urn:iep:action:pev:', '').replace(/-/g, '_')}`;
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)} %` : 'n/a');
const num = (x) => (typeof x === 'number' ? (Math.round(x * 1000) / 1000).toString() : 'n/a');
const muted = (text) => h('p', { class: 'muted', text });
const chip = (text, cls) => h('span', { class: `chip ${cls || ''}`.trim(), text });
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function levelLabel(rubric, criterionId, levelId) {
  const c = (rubric && rubric.criteria || []).find((x) => x.id === criterionId);
  const l = c && c.levels.find((x) => x.id === levelId);
  return l ? l.label : String(levelId);
}

function hasNext(view, key) { return (view.nextActions || []).some((n) => n.action === ACT[key]); }

function download(name, text, type) {
  if (typeof Blob === 'undefined' || !URL.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function jsonBlock(value) { return h('pre', { class: 'json', text: JSON.stringify(value, null, 2) }); }

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Canonical JSON (the same rule as @interego/core canonicalJson), nonces, hex
// ════════════════════════════════════════════════════════════════════════════════════════════

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) { if (v[k] === undefined) continue; parts.push(`${JSON.stringify(k)}:${canonicalJson(v[k])}`); }
  return `{${parts.join(',')}}`;
}

function freshNonce() {
  if (!globalThis.crypto || !crypto.getRandomValues) throw new Error('This browser offers no secure random source, so it cannot make a nonce.');
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexUtf8(text) {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  The bridge: manifest, invoke, sign
// ════════════════════════════════════════════════════════════════════════════════════════════

class Refused extends Error {
  constructor(status, body) {
    super(body && typeof body.error === 'string' ? body.error : `The bridge answered HTTP ${status}.`);
    this.status = status;
    this.body = body || {};
    this.code = this.body['iep:refusalReason'] || null;
  }
}

async function loadManifest() {
  const r = await fetch('affordances?format=jsonld', { headers: { accept: 'application/ld+json' } });
  if (!r.ok) throw new Error(`The affordance manifest answered HTTP ${r.status}.`);
  const j = await r.json();
  for (const a of j.affordances || []) {
    let path;
    try { path = new URL(a.target, location.href).pathname; } catch { continue; }
    S.manifest.set(a.action, { method: a.method, path, toolName: a.toolName, title: a.title });
  }
}

async function invoke(action, args) {
  const a = S.manifest.get(action);
  if (!a) throw new Error(`This bridge does not offer ${toolOf(action)}.`);
  const init = { method: a.method, headers: { accept: 'application/json' } };
  let url = a.path;
  if (a.method === 'GET') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const qs = q.toString();
    if (qs) url = `${url}?${qs}`;
  } else {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args || {});
  }
  const r = await fetch(url, init);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok || !body || body.kind === 'refusal') throw new Refused(r.status, body);
  return body;
}

function signerKey() {
  if (S.mode === 'demo') return `demo:${S.role}`;
  if (S.mode === 'wallet') return `wallet:${S.account}`;
  return 'paste';
}

async function sign(action, fields, read) {
  if (!S.pod) throw new Error('Choose the pod to work with first (in the bar at the top).');
  const payload = { v: 1, action, podUrl: S.pod, ...fields };
  const cacheKey = read ? `${signerKey()}|${S.pod}|${canonicalJson(payload)}` : null;
  if (cacheKey) {
    const hit = S.readEnvelopes.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_ENVELOPE_MS) return hit.envelope;
  }
  let envelope;
  if (S.mode === 'demo') {
    envelope = (await invoke(ACT.signAsDemoRole, { role: S.role, payload })).envelope;
  } else {
    const full = { ...payload, issuedAt: new Date().toISOString(), nonce: freshNonce() };
    envelope = S.mode === 'wallet' ? { payload: full, signature: await walletSign(full) } : await pasteSign(full);
  }
  if (cacheKey) S.readEnvelopes.set(cacheKey, { envelope, at: Date.now() });
  return envelope;
}

/** Sign and invoke one act. `read` reuses a signed read envelope; `byok` adds a per-request key. */
async function act(action, fields, o) {
  const opts = o || {};
  const envelope = await sign(action, fields || {}, Boolean(opts.read));
  return invoke(action, { envelope, ...(opts.byok ? byokArgs() : {}) });
}

function byokArgs() {
  if (!S.byok.on) return {};
  return { llm_api_key: S.byok.key, llm_model: S.byok.model };
}

async function walletSign(payload) {
  if (!window.ethereum || !S.account) throw new Error('Connect a wallet first.');
  return window.ethereum.request({ method: 'personal_sign', params: [hexUtf8(canonicalJson(payload)), S.account] });
}

async function connectWallet() {
  if (!window.ethereum) throw new Error('No wallet was found in this browser.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error('The wallet offered no account.');
  S.account = accounts[0];
  S.mode = 'wallet';
  S.readEnvelopes.clear();
}

/** Paste mode: show the exact text to sign, wait for the signature. */
function pasteSign(payload) {
  return new Promise((resolve, reject) => {
    const sec = clear($('#signing'));
    const text = canonicalJson(payload);
    const pasted = h('textarea', { rows: 3, placeholder: '0x… (the signature), or {"payload": …, "signature": "0x…"}', 'aria-label': 'Signature' });
    const problem = h('p', { class: 'refusal-inline' });
    const done = () => clear(sec);
    sec.append(h('div', { class: 'panel signing' },
      h('h3', { text: 'Sign this act' }),
      h('p', { text: 'Sign the exact text below with EIP-191 personal_sign (a wallet, or any tool that signs a message that way), then paste the signature here. The signer is who acts: nothing else names you.' }),
      h('details', {}, h('summary', { text: 'How to get a key' }),
        h('p', { text: 'You need an Ethereum-style key held in a wallet that supports personal_sign, or a tool that signs the text shown with EIP-191. This page links to nothing outside this bridge and never sees your key.' })),
      h('p', { class: 'label', text: 'The payload' }), jsonBlock(payload),
      h('label', {}, 'The exact text to sign', h('textarea', { rows: 3, readOnly: true, value: text })),
      pasted, problem,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', text: 'Use this signature', onclick: () => {
          const raw = pasted.value.trim();
          if (/^0x[0-9a-fA-F]{130}$/.test(raw)) { done(); resolve({ payload, signature: raw }); return; }
          try {
            const j = JSON.parse(raw);
            if (j && typeof j.signature === 'string' && j.payload && typeof j.payload === 'object') { done(); resolve({ payload: j.payload, signature: j.signature }); return; }
          } catch { /* not JSON: said below */ }
          problem.textContent = 'Paste a 0x signature of 130 hex digits, or {"payload": …, "signature": "0x…"}.';
        } }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { done(); reject(new Error('Signing was cancelled; nothing was sent.')); } }))));
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Refusals and outcomes
// ════════════════════════════════════════════════════════════════════════════════════════════

function refusalBox(err) {
  if (!(err instanceof Refused)) return h('div', { class: 'refusal', role: 'alert' }, h('p', { text: String(err && err.message || err) }));
  const b = err.body;
  const box = h('div', { class: 'refusal', role: 'alert', dataset: { code: err.code || '' } },
    h('p', { class: 'refusal-head', text: `Refused (HTTP ${err.status})${err.code ? `: ${err.code}` : ''}` }),
    h('p', { text: err.message }));
  const rb = b['iep:resolvedBy'];
  if (rb && typeof rb === 'object') {
    const parts = [];
    if (rb.action) parts.push(`use ${toolOf(rb.action)}`);
    if (rb.then) parts.push(`then ${toolOf(rb.then)}`);
    if (rb.env) parts.push(`the operator sets ${rb.env}`);
    if (Array.isArray(rb.criteria)) parts.push(`criteria: ${rb.criteria.join(', ')}`);
    if (parts.length) box.append(h('p', { class: 'muted', text: `What resolves it: ${parts.join('; ')}.` }));
  }
  if (Array.isArray(b.problems) && b.problems.length) {
    box.append(h('ul', {}, b.problems.map((p) => h('li', { text: typeof p === 'string' ? p : (p.message || JSON.stringify(p)) }))));
  }
  if (b.disclosure) box.append(h('p', { class: 'muted', text: `The model call that was made: ${disclosureWords(b.disclosure)}. Nothing was recorded.` }));
  return box;
}

/** Run an act from a button: disable it, show progress, then the outcome or the refusal. */
async function busy(btn, out, fn) {
  if (btn) btn.disabled = true;
  clear(out).append(muted('Working…'));
  try {
    const node = await fn();
    clear(out);
    if (node) out.append(node);
  } catch (e) {
    clear(out).append(refusalBox(e));
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

function disclosureWords(d) {
  if (!d) return '';
  const parts = [d.provider, d.model || d.requestedModel, d.route === 'scripted' ? 'scripted fixture: no model ran' : d.route, `key: ${d.keySource}`];
  if (d.usage) parts.push(`${d.usage.inputTokens} in / ${d.usage.outputTokens} out tokens`);
  if (d.declaredBy) parts.push(`declared by ${short(d.declaredBy)}`);
  return parts.filter(Boolean).join(' · ');
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Header and tabs
// ════════════════════════════════════════════════════════════════════════════════════════════

function routeWords(route, b) {
  if (route === 'scripted') return 'SCRIPTED: offline fixture, no model ran';
  if (route === 'none') return 'No model on this bridge: use your own agent';
  return `this bridge's model: ${b.provider || '?'} ${b.requestedModel || ''}`.trim();
}

function actingAs() {
  if (S.mode === 'demo') {
    const r = S.demoRoles.find((x) => x.role === S.role);
    return r ? `${r.label} ${short(r.address)}` : S.role;
  }
  if (S.mode === 'wallet') return `your wallet ${short(S.account)}`;
  return 'whoever signs (paste mode)';
}

function renderHeader() {
  const bar = clear($('#bar'));
  if (S.mode === 'demo') {
    bar.append(h('p', { class: 'demo-banner', role: 'note', text: 'DEMO MODE: this bridge holds these role keys and signs as whichever role you pick. Records it writes say so. Do not run demo mode on a shared deployment.' }));
  }
  const podInput = h('input', { type: 'url', value: S.pod, placeholder: 'https://your-pod.example/practice/', 'aria-label': 'Pod', size: 34 });
  const row1 = h('div', { class: 'row' },
    h('strong', { class: 'brand', text: 'Practice evidence' }),
    h('label', { class: 'inline' }, 'Pod ', podInput),
    h('button', { type: 'button', text: 'Use this pod', onclick: () => { S.pod = podInput.value.trim(); S.needPod = !S.pod; S.readEnvelopes.clear(); route(); } }));
  bar.append(row1);
  if (S.needPod) bar.append(h('p', { class: 'warn', text: 'This bridge has no default pod: enter the pod to work with.' }));

  const b = S.bridge;
  if (b) {
    const facts = h('p', { class: 'facts' });
    facts.append(chip(`other person: ${routeWords(b.counterpartRoute, b)}`, b.counterpartRoute === 'scripted' ? 'scripted' : b.counterpartRoute === 'none' ? 'warn' : ''));
    facts.append(chip(`judge: ${routeWords(b.judgeRoute, b)}`, b.judgeRoute === 'scripted' ? 'scripted' : b.judgeRoute === 'none' ? 'warn' : ''));
    facts.append(chip(`platform key: ${b.keyKind} ${short(b.platformAddress)}`, b.keyKind === 'configured' ? '' : 'warn'));
    bar.append(facts);
    if (b.keyKind === 'ephemeral') bar.append(h('p', { class: 'warn', text: 'This bridge\'s signing key is ephemeral: records it writes now become untrusted after it restarts, unless the operator adds its address to PEV_TRUSTED_PLATFORM_ADDRESSES.' }));
    if (b.keyKind === 'demo-fixture') bar.append(h('p', { class: 'warn', text: 'This bridge signs with a public demo key: its records prove nothing outside this demo.' }));
  }

  const who = h('div', { class: 'row' }, h('span', { class: 'label', text: 'Acting as: ' }), h('span', { id: 'acting-as', text: actingAs() }));
  if (S.mode === 'demo') {
    const sel = h('select', { id: 'role', 'aria-label': 'Demo role', onchange: (e) => { S.role = e.target.value; remember('pev.role', S.role); S.readEnvelopes.clear(); renderHeader(); route(); } },
      S.demoRoles.map((r) => h('option', { value: r.role, text: r.label })));
    sel.value = S.role;
    who.append(sel);
  } else if (S.hasWallet && S.mode !== 'wallet') {
    const out = h('span');
    const btn = h('button', { type: 'button', text: 'Connect wallet', onclick: () => busy(btn, out, async () => { await connectWallet(); renderHeader(); route(); return null; }) });
    who.append(btn, out);
  }
  bar.append(who);

  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'API key', value: S.byok.key, 'aria-label': 'Your model key', oninput: (e) => { S.byok.key = e.target.value; } });
  const model = h('input', { type: 'text', placeholder: 'model id', value: S.byok.model, 'aria-label': 'Your model id', oninput: (e) => { S.byok.model = e.target.value; } });
  const toggle = h('input', { type: 'checkbox', id: 'byok', checked: S.byok.on, onchange: (e) => { S.byok.on = e.target.checked; renderHeader(); } });
  const byok = h('div', { class: 'row byok' }, h('label', { class: 'inline' }, toggle, ' Use my own key for this request: sent to this bridge, used once, never stored'));
  if (S.byok.on) byok.append(key, model, muted('This page keeps the key in memory only and sends it only with the act you press.'));
  bar.append(byok);
}

function remember(k, v) { try { localStorage.setItem(k, v); } catch { /* storage is optional */ } }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

const TABS = [['#/practice', 'Practise'], ['#/mine', 'My attempts'], ['#/review', 'Review queue'], ['#/calibration', 'Calibration'], ['#/author', 'Author'], ['#/roles', 'Roles']];

function renderTabs() {
  const nav = clear($('#tabs'));
  const here = location.hash || '#/practice';
  for (const [href, label] of TABS) nav.append(h('a', { href, class: here.startsWith(href) ? 'tab active' : 'tab', text: label }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Router
// ════════════════════════════════════════════════════════════════════════════════════════════

async function route() {
  const seq = ++S.seq;
  renderTabs();
  const view = clear($('#view'));
  const root = h('div', { class: 'page' });
  view.append(root);
  const hash = location.hash || '#/practice';
  const [, name, arg] = /^#\/([a-z]+)(?:\/(.*))?$/.exec(hash) || [];
  const param = arg ? decodeURIComponent(arg) : '';
  try {
    if (S.needPod && name !== 'roles') { root.append(muted('Enter the pod to work with at the top of the page.')); return; }
    if (name === 'attempt' && param) await viewAttempt(root, param, seq);
    else if (name === 'review' && param) await viewReview(root, param, seq);
    else if (name === 'review') await viewQueue(root);
    else if (name === 'results' && param) await viewResults(root, param);
    else if (name === 'calibration') await viewCalibration(root);
    else if (name === 'author') await viewAuthor(root, param);
    else if (name === 'roles') viewRoles(root);
    else if (name === 'mine') await viewMine(root);
    else await viewPractice(root);
  } catch (e) {
    if (seq === S.seq) root.append(refusalBox(e));
  }
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const attemptHash = (iri) => `#/attempt/${encodeURIComponent(iri)}`;
const podArgs = (extra) => ({ ...(S.pod ? { pod_url: S.pod } : {}), ...(extra || {}) });

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Practise: the scenarios
// ════════════════════════════════════════════════════════════════════════════════════════════

async function viewPractice(root) {
  const drafts = h('input', { type: 'checkbox', checked: S.showDrafts, onchange: (e) => { S.showDrafts = e.target.checked; route(); } });
  root.append(h('div', { class: 'toolbar' }, h('h2', { text: 'Practise a scenario' }), h('label', { class: 'inline' }, drafts, ' show drafts (an author can try their own)')));
  const r = await invoke(ACT.listScenarios, podArgs({ include_drafts: S.showDrafts ? 'true' : undefined }));
  S.pod = r.podUrl;
  S.bridge = r.bridge;
  renderHeader();
  if (!r.scenarios.length) root.append(muted('No published scenarios on this pod yet. An author publishes one under Author.'));
  for (const s of r.scenarios) root.append(scenarioCard(s));
  if (r.untrustedRecordsSkipped) root.append(muted(`${r.untrustedRecordsSkipped} record(s) on this pod are not signed by a platform key this bridge trusts; they are not shown.`));
}

function rubricTable(rubric, use) {
  const gate = use === 'pass-gate';
  const wrap = h('div', { class: 'rubric' });
  for (const c of rubric.criteria) {
    wrap.append(h('div', { class: 'criterion' },
      h('p', {}, h('strong', { text: c.title }), gate && c.weight !== null ? ` · weight ${c.weight}` : '', h('span', { class: 'muted', text: ` (${c.id})` })),
      c.description ? muted(c.description) : null,
      h('ol', { class: 'levels' }, c.levels.map((l) => h('li', {},
        h('strong', { text: l.label }), gate && l.value !== null ? ` (${l.value})` : '', `: ${l.descriptor}`)))));
  }
  if (gate && rubric.passRule) {
    const req = Object.entries(rubric.passRule.requiredLevels || {});
    wrap.append(h('p', { class: 'label', text: `Pass rule: at least ${rubric.passRule.minPercent} %${req.length ? `, and ${req.map(([c, l]) => `${c} at least ${levelLabel(rubric, c, l)}`).join(', ')}` : ''}.` }));
  }
  return wrap;
}

function startForm(scenarioIri, versionOf, label) {
  const name = nextId('coached');
  const yes = h('input', { type: 'radio', name, value: 'yes' });
  const no = h('input', { type: 'radio', name, value: 'no' });
  const help = h('input', { type: 'text', maxlength: 300, placeholder: 'what help, if any (optional)', 'aria-label': 'Assistance' });
  const out = h('div', { class: 'outcome' });
  const btn = h('button', { type: 'button', class: 'primary', text: label, dataset: { action: ACT.startAttempt }, onclick: () => busy(btn, out, async () => {
    if (!yes.checked && !no.checked) return h('p', { class: 'refusal-inline', text: 'Say whether you are coached: silence is not the same as unassisted.' });
    const version = await versionOf();
    const r = await act(ACT.startAttempt, { scenarioIri, scenarioVersion: version, coached: yes.checked, ...(help.value.trim() ? { assistance: help.value.trim() } : {}) });
    go(attemptHash(r.attemptIri));
    return null;
  }) });
  return h('div', { class: 'start' },
    h('fieldset', { class: 'inline' }, h('legend', { text: 'Are you coached for this attempt?' }),
      h('label', { class: 'inline' }, yes, ' yes'), h('label', { class: 'inline' }, no, ' no')),
    help, btn, out);
}

function scenarioCard(s) {
  const card = h('article', { class: 'card scenario', dataset: { scenario: s.scenarioIri } });
  card.append(h('h3', {}, s.title, h('span', { class: 'muted', text: ` · version ${s.version} · ${s.status}` })));
  card.append(h('dl', {},
    h('dt', { text: 'What you are practising' }), h('dd', { text: s.learnerGoal }),
    h('dt', { text: 'Your part' }), h('dd', { text: s.learnerPart }),
    h('dt', { text: 'The situation' }), h('dd', { text: s.situation }),
    h('dt', { text: 'You practise with' }), h('dd', { text: s.counterpart.name }),
    h('dt', { text: 'Their first line' }), h('dd', { text: s.firstLine })));
  const use = s.assessmentUse === 'pass-gate'
    ? `Pass rule: ${s.rubric.passRule ? s.rubric.passRule.minPercent : '?'} %`
    : 'Feedback only: no score';
  card.append(h('p', { class: 'facts' }, chip(use), chip(`How knowable: ${s.workRegime}`), s.ratified ? chip(`Rubric ratified by a reviewer ${short(s.ratifiedBy)}`, 'ok') : chip('Rubric not yet ratified: results cannot leave as evidence', 'warn')));
  if (s.passGateWhy) card.append(muted(`Why a pass gate fits: ${s.passGateWhy}`));
  const da = s.draftAssistance || {};
  card.append(muted(da.used
    ? (da.measured ? `Drafted with ${da.provider}/${da.model} (measured by a receipt; ${da.editedAfterDraft ? 'edited by the author afterwards' : 'not edited afterwards'}).` : `The author declared help from ${da.by}${da.provider ? ` (${da.provider}${da.model ? `/${da.model}` : ''})` : ''}.`)
    : 'The author declared no AI help.'));
  card.append(h('details', {}, h('summary', { text: `The rubric (hash ${shortHash(s.rubricHash)}…)` }), rubricTable(s.rubric, s.assessmentUse)));
  card.append(muted(s.evidenceNote));
  if (s.status !== 'draft' || S.showDrafts) {
    card.append(startForm(s.scenarioIri, async () => s.version, s.status === 'draft' ? 'Try this draft (author test)' : 'Start'));
  }
  const out = h('div', { class: 'outcome' });
  const row = h('div', { class: 'row' },
    h('a', { href: `#/results/${encodeURIComponent(s.scenarioIri)}`, text: 'Results' }),
    h('a', { href: `#/author/${encodeURIComponent(s.scenarioIri)}`, text: 'Edit (new version)' }));
  if (s.status === 'published') {
    const rat = h('button', { type: 'button', text: 'Ratify this version (reviewers)', dataset: { action: ACT.ratifyScenario }, onclick: () => busy(rat, out, async () => {
      const r = await act(ACT.ratifyScenario, { scenarioIri: s.scenarioIri, version: s.version, scenarioHash: s.scenarioHash });
      setTimeout(route, 0);
      return h('p', { class: 'ok', text: `Ratified version ${r.version}.` });
    }) });
    row.append(rat);
  }
  card.append(row, out);
  return card;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  An attempt: conversation, evidence, review history, projections, the learner's record
// ════════════════════════════════════════════════════════════════════════════════════════════

async function viewAttempt(root, iri, seq) {
  const v = await act(ACT.getAttempt, { attemptIri: iri }, { read: true });
  if (seq !== S.seq) return;
  root.append(renderAttempt(v, {}));
}

function renderAttempt(v, o) {
  const frag = h('div', { class: 'attempt', dataset: { attempt: v.attemptIri, state: v.state } });
  const withdrawn = [...(v.reopenings || [])].reverse().find((r) => r.kind === 'retract-for-cause');
  const stateText = v.state === 'review-retracted' && withdrawn ? `review withdrawn: ${withdrawn.why || '(reason removed)'}` : (STATE_WORDS[v.state] || v.state);
  frag.append(h('h2', {}, v.scenario.title, ' ', h('span', { class: `state state-${v.state}`, id: 'state', text: stateText })));
  frag.append(h('p', { class: 'facts' },
    chip(`attempt ${v.attemptNumber}`), chip(v.coached ? 'coached' : 'not coached'), chip(`learner ${short(v.learner.did)} (${v.learner.kind})`),
    chip(v.assessmentUse === 'pass-gate' ? 'pass gate' : 'feedback only'), chip(`modal status: ${v.modalStatus}`),
    v.scenario.rubricRatified ? chip('rubric ratified', 'ok') : chip('rubric not ratified', 'warn')));
  frag.append(h('p', { class: 'label', text: 'Practice evidence: rehearsal, not a credential.' }));
  if (v.assistance) frag.append(muted(`Help declared at the start: ${v.assistance}`));
  if (v.authorTest) frag.append(h('p', { class: 'warn', text: 'An author test: it is never reviewed, counted or projected.' }));
  if (v.counterpartControlledBy === 'learner') frag.append(h('p', { class: 'warn', text: 'Their lines in this attempt were written by the learner\'s own agent.' }));
  if (v.counterpartControlledBy === 'learner-model') frag.append(muted('Their lines were produced with a model the learner chose (their own key), under this bridge\'s prompt.'));
  if (v.redaction) frag.append(h('p', { class: 'warn', text: 'The text of this attempt was removed from this pod. Hashes remain, so a copy you hold can still be checked against this record.' }));

  if (v.state === 'in-conversation') frag.append(conversationPanel(v));
  else {
    frag.append(transcriptPanel(v, o));
    if (!o.hideJudge) frag.append(judgmentsPanel(v));
    else frag.append(h('section', { class: 'panel' }, h('h3', { text: 'The judge\'s levels' }), muted('Hidden until you have chosen a level for every criterion: this attempt is in the audit sample.')));
    if (!o.hideJudge) { const a = assessmentPanel(v); if (a) frag.append(a); }
    frag.append(reviewsPanel(v));
    frag.append(projectionsPanel(v));
  }
  frag.append(actionsPanel(v, o));
  frag.append(versionsPanel(v));
  return frag;
}

function disclosureChip(t) {
  if (t.source === 'authored-first-line') return chip('the scenario\'s first line, written by its author');
  if (!t.disclosure) return null;
  return chip(disclosureWords(t.disclosure), t.disclosure.route === 'scripted' ? 'scripted' : t.disclosure.route === 'client-packet' ? 'warn' : '');
}

function bubble(v, t, textNode) {
  const mine = t.speaker === 'learner';
  return h('div', { class: `bubble ${mine ? 'me' : 'them'}`, dataset: { turn: String(t.index) } },
    h('div', { class: 'who', text: mine ? 'you' : v.counterpartName }),
    h('div', { class: 'text' }, textNode || (t.text !== undefined ? t.text : '(text removed from this pod)')),
    mine ? null : disclosureChip(t),
    t.endSignal ? h('div', { class: 'muted', text: 'They signalled the conversation is over.' }) : null);
}

function conversationPanel(v) {
  const sec = h('section', { class: 'panel conversation' }, h('h3', { text: `Talking with ${v.counterpartName}` }));
  sec.append(h('div', { class: 'bubbles' }, v.turns.map((t) => bubble(v, t))));
  const learnerLines = v.turns.filter((t) => t.speaker === 'learner').length;
  const out = h('div', { class: 'outcome' });
  const turnIndex = v.turns.length;
  const end = () => act(ACT.endConversation, { attemptIri: v.attemptIri, turnIndex });

  if (v.endProposedAtTurn !== undefined && hasNext(v, 'endConversation')) {
    const banner = h('div', { class: 'banner', id: 'end-proposed' });
    const endBtn = h('button', { type: 'button', class: 'primary', text: 'End the conversation', dataset: { action: ACT.endConversation }, onclick: () => busy(endBtn, out, async () => { await end(); route(); return null; }) });
    banner.append(h('p', { text: 'They signalled the conversation is over: end it, or keep going.' }), endBtn,
      h('button', { type: 'button', text: 'Keep going', onclick: () => banner.remove() }));
    sec.append(banner);
  }

  if (hasNext(v, 'say') || hasNext(v, 'recordTurns')) {
    const box = h('textarea', { id: 'line', rows: 3, maxlength: 4000, placeholder: 'Your line', 'aria-label': 'Your line' });
    box.value = S.unsent.get(v.attemptIri) || '';
    box.addEventListener('input', () => S.unsent.set(v.attemptIri, box.value));
    sec.append(box, muted(`${learnerLines} of ${v.turnLimit} lines`));
    const send = (endAfter) => async () => {
      const text = box.value;
      if (!text.trim()) return h('p', { class: 'refusal-inline', text: 'Write your line first.' });
      await act(ACT.say, { attemptIri: v.attemptIri, turnIndex, text, ...(endAfter ? { endAfter: true } : {}) }, { byok: true });
      S.unsent.delete(v.attemptIri);
      route();
      return null;
    };
    if (hasNext(v, 'say')) {
      const sendBtn = h('button', { type: 'button', class: 'primary', id: 'send', text: 'Send', dataset: { action: ACT.say }, onclick: () => busy(sendBtn, out, send(false)) });
      const sendEnd = h('button', { type: 'button', id: 'send-end', text: 'Send and end', dataset: { action: ACT.say }, onclick: () => busy(sendEnd, out, send(true)) });
      sec.append(h('div', { class: 'row' }, sendBtn, sendEnd));
    } else {
      sec.append(muted('No model on this bridge answers as the other person: use your own agent below.'));
    }
    if (hasNext(v, 'counterpartPacket') && hasNext(v, 'recordTurns')) sec.append(packetTurnForm(v, box, out, turnIndex));
  }
  if (hasNext(v, 'endConversation') && v.endProposedAtTurn === undefined) {
    const endBtn = h('button', { type: 'button', text: 'End the conversation', dataset: { action: ACT.endConversation }, onclick: () => busy(endBtn, out, async () => { await end(); route(); return null; }) });
    sec.append(h('div', { class: 'row' }, endBtn));
  }
  sec.append(out);
  return sec;
}

function packetTurnForm(v, box, out, turnIndex) {
  const packetOut = h('div', { class: 'outcome' });
  const theirs = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'Their line, as your agent wrote it (or "(end of conversation)")', 'aria-label': 'Their line' });
  const provider = h('input', { type: 'text', maxlength: 60, placeholder: 'provider', 'aria-label': 'Provider' });
  const model = h('input', { type: 'text', maxlength: 120, placeholder: 'model, as the provider returned it', 'aria-label': 'Model' });
  const endAfter = h('input', { type: 'checkbox' });
  const getBtn = h('button', { type: 'button', text: 'Get a packet for your own agent', dataset: { action: ACT.counterpartPacket }, onclick: () => busy(getBtn, packetOut, async () => {
    if (!box.value.trim()) return h('p', { class: 'refusal-inline', text: 'Write your line first: the packet includes it.' });
    const p = await act(ACT.counterpartPacket, { attemptIri: v.attemptIri, turnIndex, learnerText: box.value }, { read: true });
    return h('div', {}, muted(p.instructions), jsonBlock(p.request));
  }) });
  const recBtn = h('button', { type: 'button', text: 'Record both lines', dataset: { action: ACT.recordTurns }, onclick: () => busy(recBtn, out, async () => {
    await act(ACT.recordTurns, {
      attemptIri: v.attemptIri, turnIndex, learnerText: box.value, counterpartText: theirs.value,
      counterpartDisclosure: { provider: provider.value.trim(), model: model.value.trim() }, ...(endAfter.checked ? { endAfter: true } : {}),
    });
    S.unsent.delete(v.attemptIri);
    route();
    return null;
  }) });
  return h('details', { class: 'packet', open: !hasNext(v, 'say') },
    h('summary', { text: 'Use your own agent as the other person' }),
    muted('The record will say that your own agent wrote their lines in this attempt.'),
    getBtn, packetOut, theirs, h('div', { class: 'row' }, provider, model, h('label', { class: 'inline' }, endAfter, ' end after this')), recBtn);
}

function marked(text, ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); last.criteria.add(r.criterionId); }
    else merged.push({ start: r.start, end: r.end, criteria: new Set([r.criterionId]) });
  }
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const r of merged) {
    if (r.start > pos) frag.append(document.createTextNode(text.slice(pos, r.start)));
    frag.append(h('mark', { title: [...r.criteria].join(', '), text: text.slice(r.start, r.end) }));
    pos = r.end;
  }
  frag.append(document.createTextNode(text.slice(pos)));
  return frag;
}

function transcriptPanel(v, o) {
  const shown = S.judgmentShown.get(v.attemptIri) || 0;
  const hl = o.hideJudge ? [] : (v.highlights || []).filter((x) => x.judgmentIndex === shown);
  const sec = h('section', { class: 'panel transcript' }, h('h3', { text: 'The conversation' }));
  for (const t of v.turns) {
    const own = t.speaker === 'learner' && t.normalisedText !== undefined;
    const node = own ? marked(t.normalisedText, hl.filter((x) => x.turnIndex === t.index)) : null;
    sec.append(bubble(v, t, node));
  }
  if (v.turns.some((t) => t.normalisedText !== undefined)) {
    sec.append(muted('Your lines are shown normalised (quote marks straightened, runs of spaces folded) so the highlighted quotes line up exactly with what the platform checked.'));
  }
  if (v.transcriptHash) sec.append(muted(`Transcript hash ${shortHash(v.transcriptHash)}… (ended by ${v.endedBy || '?'}).`));
  return sec;
}

function judgmentsPanel(v) {
  const sec = h('section', { class: 'panel judgments' }, h('h3', { text: 'Judging' }));
  if (!v.judgments.length) { sec.append(muted(v.state === 'ended' ? 'Not judged yet.' : 'No judgment.')); return sec; }
  const shown = S.judgmentShown.get(v.attemptIri) || 0;
  if (v.judgments.length > 1) {
    sec.append(h('div', { class: 'row' }, h('span', { class: 'label', text: 'Highlight the quotes of: ' }), v.judgments.map((j) => h('button', {
      type: 'button', class: j.index === shown ? 'active' : '', text: `judgment ${j.index + 1}${j.index === 0 ? ' (primary)' : ''}`,
      onclick: () => { S.judgmentShown.set(v.attemptIri, j.index); route(); },
    }))));
  }
  const sj = v.judgments.find((j) => j.index === shown) || v.judgments[0];
  for (const c of v.rubric.criteria) {
    const block = h('div', { class: 'criterion', dataset: { criterion: c.id } }, h('h4', { text: c.title }));
    for (const j of v.judgments) {
      const cj = j.criteria.find((x) => x.criterionId === c.id);
      if (!cj) continue;
      block.append(h('p', { class: j.index === sj.index ? 'judged shown' : 'judged' },
        `Judgment ${j.index + 1}: `, h('strong', { text: levelLabel(v.rubric, c.id, cj.levelId) }), ' ',
        statusChip(cj.status)));
    }
    const cj = sj.criteria.find((x) => x.criterionId === c.id);
    if (cj) {
      if (cj.status === 'unverified' && cj.why) block.append(h('p', { class: 'bad-text', text: `Not verified: ${cj.why}.` }));
      if (cj.quotes.length) {
        block.append(h('ul', { class: 'quotes' }, cj.quotes.map((q) => h('li', { class: q.verified ? 'quote ok' : 'quote bad' },
          h('span', { class: 'mark', text: q.verified ? '✓ ' : '✗ ' }),
          h('q', { text: q.text !== undefined ? q.text : '(removed with the transcript)' }),
          q.verified ? (q.occurrences > 1 ? muted(`found ${q.occurrences} times; the first is highlighted`) : null) : h('span', { class: 'bad-text', text: ` ${q.why || ''}` }),
          q.verified && q.declaredTurnIndex !== undefined ? muted(`the judge named turn ${q.declaredTurnIndex}; it was found in turn ${q.turnIndex}`) : null))));
      } else block.append(muted('No quote given.'));
      block.append(h('div', { class: 'rationale' }, h('p', { class: 'label', text: 'The judge\'s words: not part of the score' }),
        h('p', { text: cj.rationale !== undefined ? cj.rationale : '(removed with the transcript)' })));
      block.append(muted(cj.confidence !== null && cj.confidence !== undefined ? `declared confidence ${pct(cj.confidence)}` : 'confidence not declared'));
    }
    const step = (v.nextSteps || []).find((x) => x.criterionId === c.id);
    if (step) block.append(h('p', { class: 'next-step', text: `To reach ${step.nextLevelLabel}, the rubric says: ${step.nextLevelDescriptor}${step.basis === 'provisional' ? ' (from the provisional levels)' : ''}` }));
    if (v.standingReview) {
      const fl = v.standingReview.finalLevels.find((x) => x.criterionId === c.id);
      if (fl) {
        block.append(h('p', { class: 'final' }, 'Final level: ', h('strong', { text: levelLabel(v.rubric, c.id, fl.levelId) }), fl.from === 'judge' ? ' (as the judge chose, confirmed by the reviewer)' : ' (set by the reviewer)'));
        if (fl.why) block.append(h('p', { class: 'muted', text: `The reviewer's reason: ${fl.why}` }));
      }
    }
    sec.append(block);
  }
  if (v.judgments.length > 1) {
    sec.append(h('h4', { text: 'Agreement between judgments' }), h('table', { class: 'agreement' },
      h('thead', {}, h('tr', {}, h('th', { text: 'criterion' }), v.judgments.map((j) => h('th', { text: `judgment ${j.index + 1}` })), h('th', { text: 'spread' }))),
      h('tbody', {}, (v.agreement || []).map((a) => h('tr', { class: a.agree ? '' : 'differ' },
        h('td', { text: a.criterionId }), a.levels.map((l) => h('td', { text: levelLabel(v.rubric, a.criterionId, l) })),
        h('td', { text: a.agree ? 'agree' : `${a.spread} level(s) apart` }))))));
  }
  sec.append(h('h4', { text: 'Who judged' }), h('ul', { class: 'disclosures' }, v.judgments.map((j) => h('li', {
    text: `Judgment ${j.index + 1}${j.repeatOf !== null ? ` (repeat of ${j.repeatOf + 1})` : ''}: ${j.judge.id} (${j.judge.kind}); ${disclosureWords(j.disclosure)}; chosen by ${CHOSEN_BY_WORDS[j.chosenBy] || j.chosenBy}; prompt ${j.promptTemplateHash === 'own-prompt' ? 'the judge\'s own (declared)' : `${shortHash(j.promptTemplateHash)}…`}`,
  }))));
  return sec;
}

function assessmentPanel(v) {
  const final = v.finalAssessment;
  const a = final || v.provisional;
  if (!a) return null;
  const sec = h('section', { class: 'panel assessment', id: 'assessment' }, h('h3', {}, 'Result ', h('span', { class: 'chip', text: 'Platform-computed' })));
  sec.append(h('p', { class: 'label', text: final ? 'Final: a qualified reviewer stated every level.' : 'provisional, not reviewed' }));
  if (a.use === 'pass-gate') {
    sec.append(h('p', { class: 'score', text: `${a.points} of ${a.maxPoints} points · ${a.percent} %` }));
    const verdict = final
      ? (a.meetsPassRule ? 'Meets the pass rule' : 'Does not meet the pass rule')
      : (a.meetsPassRule ? 'Would meet the pass rule (provisional, not reviewed)' : 'Would not meet the pass rule (provisional, not reviewed)');
    sec.append(h('p', { class: 'verdict', text: `${verdict}: at least ${a.minPercent} % is needed.` }));
    if (a.unmetRequirements.length) sec.append(h('ul', {}, a.unmetRequirements.map((x) => h('li', { text: x }))));
    sec.append(h('table', {}, h('thead', {}, h('tr', {}, ['criterion', 'level', 'value × weight', 'points'].map((x) => h('th', { text: x })))),
      h('tbody', {}, a.perCriterion.map((p) => h('tr', {}, h('td', { text: p.criterionId }), h('td', { text: levelLabel(v.rubric, p.criterionId, p.levelId) }),
        h('td', { text: `${p.value} × ${p.weight}` }), h('td', { text: String(p.points) }))))));
  } else {
    sec.append(h('p', { class: 'verdict', text: 'Feedback only: levels, no score.' }));
    sec.append(h('ul', {}, a.levels.map((l) => h('li', { text: `${l.criterionId}: ${levelLabel(v.rubric, l.criterionId, l.levelId)}` }))));
  }
  sec.append(muted('The judge chose levels only. This bridge computed the result from the rubric. Unverified criteria count at their lowest level until a reviewer sets them.'));
  if (final && v.provisional && v.provisional.use === 'pass-gate') sec.append(muted(`Before review the provisional result was ${v.provisional.percent} %.`));
  return sec;
}

function reviewsPanel(v) {
  const sec = h('section', { class: 'panel reviews' }, h('h3', { text: 'Reviews' }));
  if (!v.reviews.length) sec.append(muted('No person has reviewed this attempt yet. Nothing leaves as evidence until one does.'));
  for (const r of v.reviews) {
    const reopening = r.withdrawn ? (v.reopenings || []).find((x) => x.index === r.withdrawn.reopeningIndex) : null;
    sec.append(h('p', {}, `Review ${r.index + 1}: ${r.outcome === 'countersigned' ? 'countersigned as judged' : 'levels set by the reviewer'} by ${short(r.reviewer.did)} at ${r.reviewedAt}; saw the judge's levels first: ${r.sawJudgeLevelsFirst ? 'yes' : 'no'}.`,
      r.reviewer.serverHeldDemoKey ? chip('signed with a demo key held by the bridge', 'warn') : null,
      r.withdrawn ? h('span', { class: 'bad-text', text: ` Withdrawn for cause: ${reopening && reopening.why ? reopening.why : '(reason removed)'}` }) : null));
  }
  for (const r of v.reopenings || []) {
    if (r.kind === 'contest') sec.append(muted(`Contested by the learner at ${r.at}: ${r.why || '(reason removed)'}`));
  }
  return sec;
}

function projectionsPanel(v) {
  const can = v.projectable && hasNext(v, 'projectAttempt');
  const sec = h('section', { class: 'panel projections' }, h('h3', { text: 'Leave as practice evidence' }));
  sec.append(muted(v.projectable ? v.projectableWhy : `Not yet: ${v.projectableWhy}.`));
  const out = h('div', { class: 'outcome', id: 'projection' });
  const button = (format, label) => {
    const b = h('button', { type: 'button', text: label, disabled: !can, title: v.projectableWhy, dataset: { action: ACT.projectAttempt, format }, onclick: () => busy(b, out, async () => {
      const r = await act(ACT.projectAttempt, { attemptIri: v.attemptIri, format });
      const text = JSON.stringify(r.statement, null, 2);
      const dl = h('button', { type: 'button', text: 'Download statement', onclick: () => download(`statement-${r.statementId}.json`, text, 'application/json') });
      return h('div', {},
        h('p', { class: 'ok', text: `Statement ${r.statementId}, checked against the platform's rules; an audit row records it.` }),
        h('pre', { class: 'json statement', text }), dl,
        h('p', { class: 'label', text: 'What it loses' }), h('ul', {}, r.lossy.map((x) => h('li', { text: x }))),
        h('p', { class: 'label', text: 'Nothing was sent anywhere. To record it in an LRS, send it with your own credentials:' }),
        jsonBlock(r.lrsRequest));
    }) });
    return b;
  };
  sec.append(h('div', { class: 'row' }, button('xapi', 'xAPI statement'), button('cmi5', 'xAPI (cmi5-allowed context, no LMS launch)'),
    h('button', { type: 'button', disabled: true, text: 'SCORM: not built (lossy)', title: 'A SCORM write is made by content in the browser, so it would carry a score without its provenance.' })), out);
  return sec;
}

function whyBox(placeholder) { return h('textarea', { rows: 2, maxlength: 1000, placeholder, 'aria-label': placeholder }); }

function actionsPanel(v, o) {
  const sec = h('section', { class: 'panel actions' }, h('h3', { text: 'What you can do next' }));
  const handled = new Set([ACT.say, ACT.counterpartPacket, ACT.recordTurns, ACT.endConversation, ACT.projectAttempt]);
  const items = (v.nextActions || []).filter((n) => !handled.has(n.action));
  if (!items.length) sec.append(muted(v.nextActions && v.nextActions.length ? 'The controls above are what you can do now.' : 'Nothing, as whoever you are acting as.'));
  let reviewLinked = false;
  for (const n of items) {
    const out = h('div', { class: 'outcome' });
    const item = h('div', { class: 'next', dataset: { action: n.action } }, h('p', {}, h('strong', { text: n.label }), ' ', h('span', { class: 'muted', text: n.why })));
    const btn = (label, fn, cls) => { const b = h('button', { type: 'button', class: cls || '', text: label, dataset: { action: n.action }, onclick: () => busy(b, out, fn) }); return b; };
    if (n.action === ACT.judgeAttempt) {
      item.append(btn(n.label, async () => { await act(ACT.judgeAttempt, { attemptIri: v.attemptIri }, { byok: true }); route(); return null; }, 'primary'));
    } else if (n.action === ACT.judgePacket) {
      item.append(btn('Get the packet', async () => {
        const p = await act(ACT.judgePacket, { attemptIri: v.attemptIri }, { read: true });
        return h('div', {}, muted(p.instructions), jsonBlock(p));
      }));
    } else if (n.action === ACT.exportRecord) {
      item.append(btn(n.label, async () => {
        const r = await act(ACT.exportRecord, { attemptIri: v.attemptIri }, { read: true });
        const text = JSON.stringify(r, null, 2);
        const saved = download(`pev-record-${v.attemptIri.split(':').pop()}.json`, text, 'application/json');
        return h('p', { class: 'ok', text: `${r.versions.length} version(s) with their platform signatures${saved ? ', saved as a file' : ''}. Each pair can be checked offline: ${r.verify.join(' ')}` });
      }));
    } else if (n.action === ACT.holderCopy) {
      const target = h('input', { type: 'url', placeholder: 'https://your-own-pod.example/', 'aria-label': 'Your pod', size: 34 });
      item.append(target, btn(n.label, async () => {
        const r = await act(ACT.holderCopy, { attemptIri: v.attemptIri, targetPodUrl: target.value.trim() });
        return h('p', { class: 'ok', text: `${r.copies.length} version(s) copied to ${r.targetPodUrl}; ${r.copiesVerified} read back and verified${r.skippedContentDeleted ? `; ${r.skippedContentDeleted} skipped (text removed)` : ''}.` });
      }), muted('This works only for pods that accept this bridge\'s writes. Otherwise download your record and write it with your own credentials.'));
    } else if (n.action === ACT.contestReview) {
      const why = whyBox('Why should another reviewer look again? (10 to 1000 characters)');
      item.append(why, btn(n.label, async () => {
        await act(ACT.contestReview, { attemptIri: v.attemptIri, target: v.currentTarget, why: why.value });
        route();
        return null;
      }));
    } else if (n.action === ACT.retractReview) {
      const why = whyBox('The cause, shown to the learner (10 to 1000 characters)');
      item.append(why, btn(n.label, async () => {
        await act(ACT.retractReview, { attemptIri: v.attemptIri, target: v.currentTarget, why: why.value });
        route();
        return null;
      }));
    } else if (n.action === ACT.redactAttempt) {
      const why = whyBox('Why (required for an admin; optional for the learner)');
      const confirm = h('div', { class: 'confirm', hidden: true },
        h('p', { class: 'warn', text: 'Download your record first: after this, the full text exists only in copies you hold.' }), why,
        btn('Remove it', async () => {
          const r = await act(ACT.redactAttempt, { attemptIri: v.attemptIri, target: v.currentTarget, ...(why.value.trim() ? { why: why.value } : {}) });
          setTimeout(route, 0);
          return h('p', { class: 'ok', text: `${r.note} ${r.graphsDeleted} earlier version(s) deleted${r.graphsStillPresent.length ? `; still present: ${r.graphsStillPresent.join(', ')}` : ''}.` });
        }, 'danger'));
      const ask = h('button', { type: 'button', class: 'danger', text: n.label, onclick: () => { confirm.hidden = false; ask.disabled = true; } });
      item.append(ask, confirm);
    } else if (n.action === ACT.countersignAttempt || n.action === ACT.overrideAttempt) {
      if (reviewLinked || o.review) continue;
      reviewLinked = true;
      item.append(h('a', { href: `#/review/${encodeURIComponent(v.attemptIri)}`, class: 'button', text: 'Review this attempt' }));
    }
    item.append(out);
    sec.append(item);
  }
  if (v.state !== 'in-conversation' && !o.review && hasNext(v, 'exportRecord')) {
    sec.append(h('div', { class: 'next' }, h('p', {}, h('strong', { text: 'Practise again' }), ' ', h('span', { class: 'muted', text: 'A new attempt on the latest published version of this scenario.' })),
      startForm(v.scenario.scenarioIri, async () => (await invoke(ACT.listScenarios, podArgs({ scenario_iri: v.scenario.scenarioIri }))).scenario.version, 'Start again')));
  }
  return sec;
}

function versionsPanel(v) {
  const a = v.authorship || {};
  const bound = a.valid && a.contentBinding === 'bound' && a.platformKnown;
  return h('section', { class: 'panel versions' },
    h('p', {}, bound ? chip('platform signature bound to this content', 'ok') : chip(`platform signature does not check out (${a.contentBinding})`, 'bad'), ' ', chip(`key: ${v.keyKind}`)),
    h('details', {}, h('summary', { text: `Versions on the pod (${v.versions.length})` }),
      h('ol', {}, v.versions.map((x) => h('li', {}, `${x.state || 'text removed'} · ${x.modalStatus || ''} · `, h('code', { text: x.descriptorUrl }))))));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Review queue and the review form
// ════════════════════════════════════════════════════════════════════════════════════════════

async function viewQueue(root) {
  root.append(h('h2', { text: 'Review queue' }));
  const q = await act(ACT.reviewQueue, { limit: 50 }, { read: true });
  for (const e of q.entries) S.queueEntries.set(e.attemptIri, e);
  root.append(muted(`${q.awaitingReview} attempt(s) await review. ${q.excludedAsConflicted} left out because you are their learner, a judge of them or an earlier reviewer.`));
  root.append(muted(`Priority = ${Object.entries(q.weights).map(([k, w]) => `${w} × ${FACTOR_WORDS[k] || k}`).join(' + ')}. Reopened attempts come first.`));
  if (!q.entries.length) root.append(muted('Nothing waits for you.'));
  for (const e of q.entries) {
    const card = h('article', { class: 'card queue-entry', dataset: { attempt: e.attemptIri } },
      h('h3', {}, e.scenarioTitle, ' ', h('span', { class: `state state-${e.state}`, text: STATE_WORDS[e.state] || e.state }), e.reopened ? chip('reopened', 'warn') : null),
      h('p', {}, h('strong', { text: `priority ${e.priority}` }), e.blindFirst ? chip('blind first: choose your levels before you see the judge\'s', 'warn') : null));
    card.append(h('table', { class: 'factors' }, h('tbody', {}, Object.entries(q.weights).map(([k, w]) => h('tr', {},
      h('td', { text: FACTOR_WORDS[k] || k }), h('td', { text: num(e.why[k]) }), h('td', { text: `× ${w}` }),
      h('td', { text: k === 'uncertainty' && !e.why.uncertaintyDeclared ? 'not declared: counted as 0.2' : '' }))))));
    if (!e.blindFirst) {
      if (e.unverifiedCriteria.length) card.append(h('p', { class: 'bad-text', text: `A quote did not check out for: ${e.unverifiedCriteria.join(', ')}.` }));
      card.append(muted(`Judges: ${e.judges.map((j) => `${j.judgeId} (${j.kind}, chosen by ${CHOSEN_BY_WORDS[j.chosenBy] || j.chosenBy})`).join('; ')}`));
    }
    if (e.counterpartControlledBy === 'learner') card.append(h('p', { class: 'warn', text: 'The learner\'s own agent wrote the other person\'s lines.' }));
    card.append(h('a', { href: `#/review/${encodeURIComponent(e.attemptIri)}`, class: 'button', text: 'Open and review' }));
    root.append(card);
  }
}

async function viewReview(root, iri, seq) {
  let entry = S.queueEntries.get(iri);
  if (!entry) {
    try {
      const q = await act(ACT.reviewQueue, { limit: 100 }, { read: true });
      for (const e of q.entries) S.queueEntries.set(e.attemptIri, e);
      entry = S.queueEntries.get(iri);
    } catch { /* not a reviewer: the attempt view below says what this caller can do */ }
  }
  const v = await act(ACT.getAttempt, { attemptIri: iri }, { read: true });
  if (seq !== S.seq) return;
  const blind = Boolean(entry && entry.blindFirst);
  let st = S.reviewDrafts.get(iri);
  if (!st || st.target !== v.currentTarget.descriptorUrl) {
    st = { picks: {}, whys: {}, revealed: !blind, target: v.currentTarget.descriptorUrl };
    S.reviewDrafts.set(iri, st);
  }
  root.append(h('p', {}, h('a', { href: '#/review', text: '← the queue' })));
  root.append(renderAttempt(v, { hideJudge: !st.revealed, review: true }));
  if (!hasNext(v, 'overrideAttempt')) {
    root.append(h('section', { class: 'panel' }, muted('You cannot review this attempt as whoever you are acting as: a reviewer who is not its learner, one of its judges or an earlier reviewer can.')));
    return;
  }
  const form = h('section', { class: 'panel review-form', id: 'review-form' });
  root.append(form);
  paintReviewForm(form, v, st, blind);
}

function paintReviewForm(form, v, st, blind) {
  clear(form);
  const primary = v.judgments[0];
  const criteria = v.rubric.criteria;
  form.append(h('h3', { text: 'Your review' }), muted(blind
    ? 'This attempt is in the audit sample: choose a level for every criterion before you see the judge\'s. Your review will say you did not see them first.'
    : 'State a level for every criterion. Where yours differs from the judge\'s, or the judge\'s quote did not check out, say why.'));
  const allPicked = criteria.every((c) => st.picks[c.id]);
  for (const c of criteria) {
    const cj = primary && primary.criteria.find((x) => x.criterionId === c.id);
    const sel = h('select', { 'aria-label': `Level for ${c.title}`, dataset: { criterion: c.id }, onchange: (e) => { st.picks[c.id] = e.target.value; paintReviewForm(form, v, st, blind); } },
      h('option', { value: '', text: 'choose a level' }), c.levels.map((l) => h('option', { value: l.id, text: `${l.label}: ${l.descriptor}` })));
    sel.value = st.picks[c.id] || '';
    const row = h('div', { class: 'criterion' }, h('h4', { text: c.title }), sel);
    if (st.revealed && cj) {
      row.append(h('p', {}, 'The judge chose ', h('strong', { text: levelLabel(v.rubric, c.id, cj.levelId) }), ' ', statusChip(cj.status)));
      const needsWhy = Boolean(st.picks[c.id]) && (st.picks[c.id] !== cj.levelId || cj.status === 'unverified');
      const why = h('textarea', { rows: 2, maxlength: 1000, dataset: { why: c.id }, placeholder: needsWhy ? 'Required: why (10 to 1000 characters)' : 'Optional note', oninput: (e) => { st.whys[c.id] = e.target.value; } });
      why.value = st.whys[c.id] || '';
      row.append(why);
      if (needsWhy) row.append(h('p', { class: 'warn', text: cj.status === 'unverified' ? 'The judge\'s quote did not check out here: say why your level stands.' : 'Your level differs from the judge\'s: say why.' }));
      if (cj.status === 'no-quote-needed') row.append(muted('The judge put this at the lowest level and quoted nothing, so nothing was checked: read the learner\'s lines for anything that reaches higher.'));
    }
    form.append(row);
  }
  const out = h('div', { class: 'outcome' });
  if (!st.revealed) {
    const reveal = h('button', { type: 'button', id: 'reveal', text: 'Reveal the judge\'s levels', disabled: !allPicked, onclick: () => { st.revealed = true; route(); } });
    form.append(reveal, allPicked ? null : muted('Choose a level for every criterion first.'));
    return;
  }
  const asJudged = primary && primary.unverifiedCriteria.length === 0 && criteria.every((c) => {
    const cj = primary.criteria.find((x) => x.criterionId === c.id);
    return cj && st.picks[c.id] === cj.levelId;
  });
  const action = asJudged ? ACT.countersignAttempt : ACT.overrideAttempt;
  const submit = h('button', { type: 'button', class: 'primary', id: 'submit-review', disabled: !allPicked, dataset: { action },
    text: asJudged ? 'Countersign as judged' : 'Sign my levels (override)',
    onclick: () => busy(submit, out, async () => {
      const r = await act(action, {
        attemptIri: v.attemptIri, target: v.currentTarget, sawJudgeLevelsFirst: !blind,
        levels: criteria.map((c) => ({ criterionId: c.id, levelId: st.picks[c.id], ...((st.whys[c.id] || '').trim() ? { why: st.whys[c.id] } : {}) })),
      });
      S.reviewDrafts.delete(v.attemptIri);
      S.queueEntries.delete(v.attemptIri);
      const x = r.assessment;
      return h('div', {},
        h('p', { class: 'ok recorded', text: `Recorded: ${STATE_WORDS[r.state] || r.state}. ${x.use === 'pass-gate' ? `${x.percent} %, ${x.meetsPassRule ? 'meets' : 'does not meet'} the pass rule.` : 'Feedback only: levels recorded.'}` }),
        muted(r.projectable ? 'It can now leave as practice evidence.' : `It cannot leave as evidence yet: ${r.projectableWhy}.`),
        h('a', { href: attemptHash(v.attemptIri), text: 'Open the attempt' }), ' ', h('a', { href: '#/review', text: 'Back to the queue' }));
    }) });
  form.append(muted(asJudged ? 'Every level equals the primary judgment and every quote checked out: this is a countersignature.' : 'Some level differs from the primary judgment, or a quote did not check out: this is an override, with your reasons.'), submit, out);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Results and calibration
// ════════════════════════════════════════════════════════════════════════════════════════════

function distributionTable(rows, k) {
  return h('table', { class: 'distribution' }, h('tbody', {}, rows.map((d) => h('tr', {},
    h('th', { text: `${d.title} (n = ${d.n})` }),
    d.withheld
      ? h('td', { text: `split withheld: one side has a count from 1 to ${k - 1}` })
      : d.levels.some((l) => l.suppressed)
        ? h('td', { text: `hidden: a count in this row is from 1 to ${k - 1}, so only the total shows` })
        : d.levels.map((l) => h('td', { text: `${l.label}: ${l.count}` }))))));
}

function resultsCsv(r) {
  const lines = [['section', 'criterionId', 'levelId', 'label', 'count', 'suppressed'].join(',')];
  const add = (section, rows) => { for (const d of rows) for (const l of d.levels) lines.push([section, d.criterionId, l.levelId, JSON.stringify(l.label), l.suppressed ? '' : l.count, l.suppressed].join(',')); };
  add('final', r.final.perCriterion);
  add('final-coached', r.final.byCoached.coached);
  add('final-not-coached', r.final.byCoached.notCoached);
  add('final-first-attempt', r.final.byAttemptNumber.first);
  add('final-later-attempts', r.final.byAttemptNumber.later);
  add('provisional', r.provisional.perCriterion);
  return `${lines.join('\n')}\n`;
}

async function viewResults(root, scenarioIri) {
  const r = await act(ACT.scenarioResults, { scenarioIri }, { read: true });
  root.append(h('h2', { text: 'Results' }), h('p', { class: 'label', text: r.label }));
  const c = r.counts;
  root.append(h('p', { text: `${c.attempts} attempt(s); ${c.authorTestExcluded} author test(s) left out; ${c.redacted} with the transcript removed.` }),
    h('p', { class: 'facts' }, Object.entries(c.byState).filter(([, n]) => n > 0).map(([s, n]) => chip(`${STATE_WORDS[s] || s}: ${n}`))));
  root.append(h('h3', { text: `Final levels (reviewed: ${r.final.reviewedAttempts})` }), distributionTable(r.final.perCriterion, r.k));
  if (r.final.meetsPassRule) root.append(h('p', { text: `Met the pass rule: ${r.final.meetsPassRule.suppressed ? `hidden (it or the rest is from 1 to ${r.k - 1})` : r.final.meetsPassRule.count} of ${r.final.meetsPassRule.of}.` }));
  root.append(h('h4', { text: 'Coached / not coached' }), distributionTable(r.final.byCoached.coached, r.k), distributionTable(r.final.byCoached.notCoached, r.k));
  root.append(h('h4', { text: 'First attempt / later attempts' }), distributionTable(r.final.byAttemptNumber.first, r.k), distributionTable(r.final.byAttemptNumber.later, r.k));
  root.append(h('h3', { text: `Provisional levels (judged: ${r.provisional.judgedAttempts}), ${r.provisional.label}` }), distributionTable(r.provisional.perCriterion, r.k));
  root.append(h('h3', { text: r.reviewerChangesShown === 'each' ? 'What reviewers changed, and why' : 'What reviewers changed' }));
  if (r.reviewerChangesShown === 'each') {
    if (!r.reviewerChanges.length) root.append(muted('No reviewer set a level other than the judge\'s.'));
    else root.append(h('ul', {}, r.reviewerChanges.map((x) => h('li', { text: `${x.criterionId}: ${x.judgeLevelId} → ${x.finalLevelId} (${x.reviewedAt}): ${x.why === null ? '(removed with the transcript)' : x.why}` }))));
  } else {
    root.append(muted('Each change and its reason are shown to reviewers and admins only; here they are counts.'));
    root.append(h('ul', {}, r.reviewerChangeCounts.map((x) => h('li', { text: x.suppressed
      ? `${x.criterionId}: hidden (a count from 1 to ${r.k - 1})` : `${x.criterionId}: raised in ${x.raised}, lowered in ${x.lowered}` }))));
  }
  root.append(h('ul', {}, r.changedByReviewer.map((x) => h('li', { text: x.suppressed
    ? `${x.criterionId}: changed in a hidden number of ${x.reviewedAttempts} reviewed attempt(s)`
    : `${x.criterionId}: changed in ${x.changed} of ${x.reviewedAttempts} reviewed attempt(s)` }))));
  root.append(muted(r.suppressionRule));
  if (r.personJudgeCells && r.personJudgeCells.length) root.append(h('h3', { text: 'People who judged (only readers of results see this)' }), calibrationTable(r.personJudgeCells));
  root.append(h('div', { class: 'row' },
    h('button', { type: 'button', text: 'Download JSON', onclick: () => download('results.json', JSON.stringify(r, null, 2), 'application/json') }),
    h('button', { type: 'button', text: 'Download CSV', onclick: () => download('results.csv', resultsCsv(r), 'text/csv') })));
}

function calibrationTable(cells) {
  const head = ['judge', 'prompt', 'rubric', 'criterion', 'samples', 'distinct reviewers', 'agreement with the reviewer', 'mean Brier', 'mean level distance', 'unverified', 'blind agreement', 'test-retest', 'audit sample', 'status', 'standing'];
  return h('div', { class: 'scroll' }, h('table', { class: 'calibration' },
    h('thead', {}, h('tr', {}, head.map((x) => h('th', { text: x })))),
    h('tbody', {}, cells.map((c) => h('tr', {},
      h('td', { text: `${c.judgeId} (${c.judgeKind})` }), h('td', { text: c.promptTemplateHash === 'own-prompt' ? 'own' : shortHash(c.promptTemplateHash) }),
      h('td', { text: c.rubricHash ? shortHash(c.rubricHash) : 'pooled' }), h('td', { text: c.criterionTitle }),
      h('td', { text: String(c.samples) }), h('td', { text: String(c.distinctHumanConfirmers) }), h('td', { text: pct(c.agreementRate) }),
      h('td', { text: num(c.meanBrier) }), h('td', { text: `${num(c.meanLevelDistance)} (${num(c.normalisedLevelDistance)})` }), h('td', { text: pct(c.unverifiedRate) }),
      h('td', { text: `${pct(c.blindAgreementRate)} of ${c.blindSamples}` }), h('td', { text: `${pct(c.repeatAgreement)} of ${c.repeatSamples}` }),
      h('td', { text: `${pct(c.auditSampleAgreementRate)} of ${c.auditSampleSamples}${c.auditSamplePartial ? ' (partial)' : ''}` }),
      h('td', { text: `${c.status} (20)` }),
      h('td', { text: `${c.standing.evaluated ? (c.standing.clears ? 'clears' : 'does not clear') : 'not evaluated'}: ${c.standing.why}. ${c.standing.effect}` }))))));
}

async function viewCalibration(root) {
  const pooled = h('input', { type: 'checkbox', checked: S.pooled, onchange: (e) => { S.pooled = e.target.checked; route(); } });
  root.append(h('div', { class: 'toolbar' }, h('h2', { text: 'Calibration of the judges' }),
    h('label', { class: 'inline' }, pooled, ' pool across rubric versions with the same criterion text (information only)')));
  const r = await invoke(ACT.calibration, podArgs({ group_by: S.pooled ? 'criterion-content' : undefined }));
  root.append(h('p', { class: 'label', text: r.metricNote }));
  if (r.smallCountRule) root.append(muted(r.smallCountRule.replace(/k − 1/g, String(r.k - 1))));
  root.append(muted(`Policy for standing: agreement of at least ${r.policy.floor} over at least ${r.policy.minSamples} reviewed outcomes, from at least ${r.policy.minDistinctHumanConfirmers} different people. A cell stays Hypothetical below ${r.minSamplesForAsserted} samples. ${r.attemptsRead} attempt(s) and ${r.outcomesRead} outcome row(s) read; ${r.personJudgeCellsWithheld} cell(s) of people who judged are left out here.`));
  if (!r.cells.length) root.append(muted('No reviewed outcomes yet.'));
  else root.append(calibrationTable(r.cells));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Author: the scenario form, drafting, saving, publishing
// ════════════════════════════════════════════════════════════════════════════════════════════

const blankLevel = (id, label, value) => ({ id, label, descriptor: '', value });
const blankCriterion = () => ({ id: '', title: '', description: '', weight: 1, levels: [blankLevel('low', 'Low', 0), blankLevel('high', 'High', 100)] });
function blankScenario() {
  return {
    scenarioKey: '', title: '', learnerGoal: '', learnerPart: '', situation: '', language: 'en',
    counterpart: { name: '', profile: '', wants: '', knows: '', reactions: '' },
    firstLine: '', endsWhen: '', turnLimit: 12, assessmentUse: '', workRegime: '', passGateWhy: '',
    rubric: { criteria: [blankCriterion()], passRule: { minPercent: 70, requiredLevels: {} } },
  };
}

/** Fill the form model from a scenario view or a draft. A draft has no use, regime or scoring. */
function modelFrom(s) {
  const m = blankScenario();
  for (const k of ['scenarioKey', 'title', 'learnerGoal', 'learnerPart', 'situation', 'language', 'firstLine', 'endsWhen']) if (typeof s[k] === 'string') m[k] = s[k];
  if (typeof s.turnLimit === 'number') m.turnLimit = s.turnLimit;
  for (const k of ['name', 'profile', 'wants', 'knows', 'reactions']) if (s.counterpart && typeof s.counterpart[k] === 'string') m.counterpart[k] = s.counterpart[k];
  if (s.assessmentUse) m.assessmentUse = s.assessmentUse;
  if (s.workRegime) m.workRegime = s.workRegime;
  if (s.passGateWhy) m.passGateWhy = s.passGateWhy;
  const r = s.rubric || {};
  if (Array.isArray(r.criteria) && r.criteria.length) {
    m.rubric.criteria = r.criteria.map((c) => ({
      id: c.id || '', title: c.title || '', description: c.description || '', weight: c.weight === undefined || c.weight === null ? '' : c.weight,
      levels: (c.levels || []).map((l) => ({ id: l.id || '', label: l.label || '', descriptor: l.descriptor || '', value: l.value === undefined || l.value === null ? '' : l.value })),
    }));
  }
  if (r.passRule) m.rubric.passRule = { minPercent: r.passRule.minPercent, requiredLevels: { ...(r.passRule.requiredLevels || {}) } };
  return m;
}

function scenarioPayload(m) {
  const gate = m.assessmentUse === 'pass-gate';
  const n = (x) => (x === '' || x === null || x === undefined ? undefined : Number(x));
  const needsWhy = gate && !['evident', 'knowable'].includes(m.workRegime);
  const required = Object.fromEntries(Object.entries(m.rubric.passRule.requiredLevels).filter(([, l]) => l));
  return {
    scenarioKey: m.scenarioKey.trim(), title: m.title, learnerGoal: m.learnerGoal, learnerPart: m.learnerPart, situation: m.situation,
    language: m.language, counterpart: { ...m.counterpart }, firstLine: m.firstLine, endsWhen: m.endsWhen, turnLimit: n(m.turnLimit),
    ...(m.assessmentUse ? { assessmentUse: m.assessmentUse } : {}), ...(m.workRegime ? { workRegime: m.workRegime } : {}),
    ...(needsWhy && m.passGateWhy.trim() ? { passGateWhy: m.passGateWhy } : {}),
    rubric: {
      criteria: m.rubric.criteria.map((c) => ({
        id: c.id.trim(), title: c.title, description: c.description, ...(gate ? { weight: n(c.weight) } : {}),
        levels: c.levels.map((l) => ({ id: l.id.trim(), label: l.label, descriptor: l.descriptor, ...(gate ? { value: n(l.value) } : {}) })),
      })),
      ...(gate ? { passRule: { minPercent: n(m.rubric.passRule.minPercent), requiredLevels: required } } : {}),
    },
  };
}

function field(model, key, label, o) {
  const opts = o || {};
  const input = opts.long
    ? h('textarea', { rows: opts.rows || 2, maxlength: opts.max, oninput: (e) => { model[key] = e.target.value; } })
    : h('input', { type: opts.type || 'text', maxlength: opts.max, disabled: opts.disabled, oninput: (e) => { model[key] = e.target.value; } });
  input.value = model[key] === undefined || model[key] === null ? '' : String(model[key]);
  return h('label', { class: 'field', dataset: { field: key } }, h('span', { class: 'label', text: label }), input);
}

function radios(model, key, legend, options, onchange) {
  const name = nextId(key);
  return h('fieldset', { class: 'radios', dataset: { field: key } }, h('legend', { text: legend }), options.map(([value, text]) => h('label', { class: 'block' },
    h('input', { type: 'radio', name, value, checked: model[key] === value, onchange: () => { model[key] = value; if (onchange) onchange(); } }), ` ${text}`)));
}

async function viewAuthor(root, scenarioIri) {
  if (!S.author || (scenarioIri && S.author.loadedFrom !== scenarioIri)) {
    S.author = { model: blankScenario(), basedOnVersion: null, receipt: null, receiptDisclosure: null, assistance: { choice: '', provider: '', model: '', note: '' }, saved: null, loadedFrom: null, lastSaved: null };
    if (scenarioIri) {
      const r = await invoke(ACT.listScenarios, podArgs({ scenario_iri: scenarioIri }));
      S.author.model = modelFrom(r.scenario);
      S.author.basedOnVersion = r.scenario.version;
      S.author.loadedFrom = scenarioIri;
      S.author.saved = { scenarioIri, version: r.scenario.version, status: r.scenario.status };
    }
  }
  const A = S.author;
  const page = h('div', { class: 'author' });
  root.append(page);
  const paint = () => { clear(page); page.append(...authorForm(A, paint)); };
  paint();
}

function authorForm(A, paint) {
  const m = A.model;
  const gate = m.assessmentUse === 'pass-gate';
  const out = [];
  out.push(h('h2', { text: A.basedOnVersion ? `Edit: a change makes version ${A.basedOnVersion + 1}` : 'Write a practice scenario' }),
    h('p', { class: 'facts' }, h('button', { type: 'button', text: 'Start a new scenario', onclick: () => { S.author = null; go('#/author'); } })));

  // Drafting help
  const brief = h('textarea', { rows: 3, maxlength: 4000, placeholder: 'The performance situation to practise', 'aria-label': 'Brief' });
  const source = h('textarea', { rows: 3, maxlength: 20000, placeholder: 'Material to draw on (optional)', 'aria-label': 'Source material' });
  const pasted = h('textarea', { rows: 3, placeholder: 'Paste a draft as JSON', 'aria-label': 'Draft JSON' });
  const draftOut = h('div', { class: 'outcome' });
  const draftBtn = h('button', { type: 'button', text: 'Draft with this bridge\'s model', dataset: { action: ACT.draftScenario }, onclick: () => busy(draftBtn, draftOut, async () => {
    const r = await act(ACT.draftScenario, { brief: brief.value, ...(source.value.trim() ? { sourceText: source.value } : {}) }, { byok: true });
    A.model = { ...modelFrom(r.draft), assessmentUse: '', workRegime: '', passGateWhy: '' };
    A.receipt = r.receipt;
    A.receiptDisclosure = r.disclosure;
    A.assistance.choice = 'receipt';
    paint();
    return null;
  }) });
  const packetBtn = h('button', { type: 'button', text: 'Get a draft packet for my agent', dataset: { action: ACT.draftScenarioPacket }, onclick: () => busy(packetBtn, draftOut, async () => {
    const p = await invoke(ACT.draftScenarioPacket, { brief: brief.value, ...(source.value.trim() ? { source_text: source.value } : {}) });
    return h('div', {}, muted(p.instructions), muted(p.recordWith.note), jsonBlock(p.request));
  }) });
  const pasteBtn = h('button', { type: 'button', text: 'Load the pasted draft', onclick: () => busy(pasteBtn, draftOut, async () => {
    let d;
    try { d = JSON.parse(pasted.value); } catch { return h('p', { class: 'refusal-inline', text: 'That is not JSON.' }); }
    A.model = { ...modelFrom(d), assessmentUse: '', workRegime: '', passGateWhy: '' };
    A.receipt = null;
    A.assistance.choice = '';
    paint();
    return null;
  }) });
  out.push(h('details', { class: 'panel', open: !A.model.title },
    h('summary', { text: 'Start from a draft (optional)' }),
    muted('A model drafts the conversation, the other person and the criteria. It does not decide how the scenario is used, how knowable the work is or how it is scored: you do.'),
    brief, source, h('div', { class: 'row' }, draftBtn, packetBtn), pasted, pasteBtn, draftOut));
  if (A.receiptDisclosure) out.push(h('p', { class: 'warn', text: `This form holds a draft from ${disclosureWords(A.receiptDisclosure)}. The receipt will record that, and whether you changed it.` }));

  // The scenario
  out.push(h('section', { class: 'panel' }, h('h3', { text: 'The scenario' }),
    field(m, 'scenarioKey', 'Short key (lowercase letters, digits and hyphens; it names the scenario)', { max: 64, disabled: Boolean(A.basedOnVersion) }),
    field(m, 'title', 'Title', { max: 120 }),
    field(m, 'learnerGoal', 'What you are practising', { long: true, max: 600 }),
    field(m, 'learnerPart', 'Your part', { long: true, max: 300 }),
    field(m, 'situation', 'The situation', { long: true, rows: 3, max: 2000 }),
    field(m, 'language', 'Language (for example en)', { max: 20 })));
  out.push(h('section', { class: 'panel' }, h('h3', { text: 'The person you practise with' }),
    field(m.counterpart, 'name', 'Name', { max: 60 }),
    field(m.counterpart, 'profile', 'Who they are', { long: true, max: 1500 }),
    field(m.counterpart, 'wants', 'What they want', { long: true, max: 800 }),
    field(m.counterpart, 'knows', 'What they know', { long: true, max: 1500 }),
    field(m.counterpart, 'reactions', 'How they react', { long: true, max: 1500 }),
    field(m, 'firstLine', 'Their first line', { long: true, max: 600 }),
    field(m, 'endsWhen', 'The conversation ends when', { long: true, max: 600 }),
    field(m, 'turnLimit', 'Turn limit (your lines, 1 to 40)', { type: 'number' })));

  // Classify first
  const decide = h('section', { class: 'panel' }, h('h3', { text: 'Before the rubric: two decisions' }),
    radios(m, 'assessmentUse', 'How will this be used?', [['feedback-only', 'Feedback only: levels, no score'], ['pass-gate', 'Pass gate: a score and a pass rule']], paint),
    radios(m, 'workRegime', 'How knowable is this work?', Object.entries(REGIME_WORDS), paint));
  if (gate && m.workRegime && !['evident', 'knowable'].includes(m.workRegime)) {
    decide.append(h('p', { class: 'warn', text: 'A pass gate assumes a knowable good answer, and you read this work otherwise. Give the reason a gate fits (it is recorded), or use feedback only.' }),
      field(m, 'passGateWhy', 'Why a pass gate fits this work (10 to 600 characters)', { long: true, max: 600 }));
  }
  out.push(decide);

  // The rubric
  const rub = h('section', { class: 'panel rubric-editor' }, h('h3', { text: 'The rubric' }),
    muted(gate ? 'Levels from lowest to highest. A pass gate gives each criterion a weight (1 to 100) and each level a value (0 to 100, rising).' : 'Levels from lowest to highest. Feedback only: no weights, no values, no pass rule.'));
  m.rubric.criteria.forEach((c, ci) => {
    const box = h('div', { class: 'criterion' },
      h('div', { class: 'row' }, field(c, 'id', 'Criterion id', { max: 40 }), field(c, 'title', 'Title', { max: 120 }), gate ? field(c, 'weight', 'Weight', { type: 'number' }) : null),
      field(c, 'description', 'What it looks at', { long: true, max: 600 }));
    c.levels.forEach((l, li) => {
      box.append(h('div', { class: 'row level' },
        field(l, 'id', `Level ${li + 1} id`, { max: 40 }), field(l, 'label', 'Label', { max: 60 }), gate ? field(l, 'value', 'Value', { type: 'number' }) : null,
        field(l, 'descriptor', 'What the learner\'s own words show at this level', { long: true, max: 600 }),
        c.levels.length > 2 ? h('button', { type: 'button', text: 'Remove level', onclick: () => { c.levels.splice(li, 1); paint(); } }) : null));
    });
    box.append(h('div', { class: 'row' },
      c.levels.length < 6 ? h('button', { type: 'button', text: 'Add a level', onclick: () => { c.levels.push(blankLevel('', '', '')); paint(); } }) : null,
      m.rubric.criteria.length > 1 ? h('button', { type: 'button', text: 'Remove this criterion', onclick: () => { m.rubric.criteria.splice(ci, 1); paint(); } }) : null));
    rub.append(box);
  });
  if (m.rubric.criteria.length < 12) rub.append(h('button', { type: 'button', text: 'Add a criterion', onclick: () => { m.rubric.criteria.push(blankCriterion()); paint(); } }));
  if (gate) {
    const pr = m.rubric.passRule;
    rub.append(h('h4', { text: 'Pass rule' }), field(pr, 'minPercent', 'Minimum percent (0 to 100)', { type: 'number' }));
    for (const c of m.rubric.criteria) {
      const sel = h('select', { onchange: (e) => { pr.requiredLevels[c.id] = e.target.value; } },
        h('option', { value: '', text: 'no required level' }), c.levels.map((l) => h('option', { value: l.id, text: l.label || l.id })));
      sel.value = pr.requiredLevels[c.id] || '';
      rub.append(h('label', { class: 'field' }, h('span', { class: 'label', text: `${c.title || c.id || 'criterion'}: at least` }), sel));
    }
  }
  out.push(rub);

  // Draft assistance (required)
  const as = A.assistance;
  const choices = [['none', 'No AI helped draft this'], ['own-agent', 'My own agent helped'], ['model', 'Another model helped'], ['person', 'Another person helped']];
  if (A.receipt) choices.unshift(['receipt', 'This bridge\'s model drafted it (the receipt is attached)']);
  const assist = h('section', { class: 'panel' }, radios(as, 'choice', 'Did anyone or anything help draft this? (required: silence is not the same as unassisted)', choices, paint));
  if (as.choice === 'own-agent' || as.choice === 'model') assist.append(h('div', { class: 'row' }, field(as, 'provider', 'Provider', { max: 60 }), field(as, 'model', 'Model', { max: 120 })));
  if (as.choice && as.choice !== 'none' && as.choice !== 'receipt') assist.append(field(as, 'note', 'Note (optional)', { max: 300 }));
  out.push(assist);

  // Save / publish / try
  const result = h('div', { class: 'outcome', id: 'author-result' });
  const save = (status) => async () => {
    if (!m.assessmentUse || !m.workRegime) return h('p', { class: 'refusal-inline', text: 'Decide how this will be used and how knowable the work is first.' });
    if (!as.choice) return h('p', { class: 'refusal-inline', text: 'Say whether anyone or anything helped draft this.' });
    const assistance = as.choice === 'receipt' ? { draftReceipt: A.receipt }
      : as.choice === 'none' ? { draftAssistance: { used: false } }
        : { draftAssistance: { used: true, by: as.choice, ...(as.provider.trim() ? { provider: as.provider.trim() } : {}), ...(as.model.trim() ? { model: as.model.trim() } : {}), ...(as.note.trim() ? { note: as.note.trim() } : {}) } };
    const r = await act(ACT.authorScenario, { scenario: scenarioPayload(m), status, ...(A.basedOnVersion ? { basedOnVersion: A.basedOnVersion } : {}), ...assistance });
    A.basedOnVersion = r.version;
    A.saved = { scenarioIri: r.scenarioIri, version: r.version, status: r.status };
    A.loadedFrom = r.scenarioIri;
    A.lastSaved = r.changed === false
      ? [`Nothing changed: version ${r.version} is already ${r.status}.`]
      : [`Saved version ${r.version} as ${r.status} (${r.modalStatus}).`, `Rubric hash ${r.rubricHash}${r.rubricChanged ? ' (the rubric changed: a new rubric version, with its own calibration)' : ''}.`,
        r.supersedes ? `It supersedes ${r.supersedes}.` : 'The first version.', r.status === 'published' ? 'Results on it can leave as evidence once a reviewer ratifies it.' : 'A draft: learners cannot start it; you can try it yourself.'];
    paint();
    return null;
  };
  if (A.lastSaved) result.append(h('div', {}, A.lastSaved.map((x) => h('p', { class: 'ok', text: x }))));
  const saveBtn = h('button', { type: 'button', text: 'Save draft', dataset: { action: ACT.authorScenario, status: 'draft' }, onclick: () => busy(saveBtn, result, save('draft')) });
  const pubBtn = h('button', { type: 'button', class: 'primary', text: 'Publish', dataset: { action: ACT.authorScenario, status: 'published' }, onclick: () => busy(pubBtn, result, save('published')) });
  const tryBtn = h('button', { type: 'button', text: 'Try it myself (not coached)', disabled: !A.saved, dataset: { action: ACT.startAttempt }, onclick: () => busy(tryBtn, result, async () => {
    const r = await act(ACT.startAttempt, { scenarioIri: A.saved.scenarioIri, scenarioVersion: A.saved.version, coached: false });
    go(attemptHash(r.attemptIri));
    return null;
  }) });
  out.push(h('div', { class: 'row' }, saveBtn, pubBtn, tryBtn), muted('Your own attempts on your scenario are tests: they are never reviewed, counted or projected.'), result);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Roles and my attempts
// ════════════════════════════════════════════════════════════════════════════════════════════

function viewRoles(root) {
  root.append(h('h2', { text: 'Roles on this pod' }), muted('Only an admin address configured on this bridge can change roles. Each change is a signed record that supersedes the registry\'s previous version.'));
  const address = h('input', { type: 'text', placeholder: '0x… (40 hex digits)', 'aria-label': 'Address', size: 44 });
  const role = h('select', { 'aria-label': 'Role' }, ['reviewer', 'author', 'judge', 'agent', 'learner'].map((r) => h('option', { value: r, text: r })));
  const change = h('select', { 'aria-label': 'Change' }, h('option', { value: 'add', text: 'add' }), h('option', { value: 'remove', text: 'remove' }));
  const out = h('div', { class: 'outcome' });
  const row = h('div', { class: 'row' }, address, role, change);
  if (S.mode === 'demo') {
    const pick = h('select', { 'aria-label': 'Fill from a demo role', onchange: (e) => { address.value = e.target.value; } },
      h('option', { value: '', text: 'fill from a demo role…' }), S.demoRoles.map((r) => h('option', { value: r.address, text: r.label })));
    row.append(pick);
  }
  const btn = h('button', { type: 'button', class: 'primary', text: 'Sign the change', dataset: { action: ACT.registerRole }, onclick: () => busy(btn, out, async () => {
    const r = await act(ACT.registerRole, { address: address.value.trim(), role: role.value, change: change.value });
    return h('div', {}, h('p', { class: r.changed ? 'ok' : 'muted', text: r.changed ? `Recorded: registry version ${r.seq}.` : 'Nothing changed: the registry already says so.' }),
      h('table', {}, h('tbody', {}, r.entries.map((e) => h('tr', {}, h('td', {}, h('code', { text: e.address })), h('td', { text: e.roles.join(', ') }))))));
  }) });
  root.append(row, btn, out);
}

async function viewMine(root) {
  root.append(h('h2', { text: 'Attempts' }));
  const r = await act(ACT.getAttempt, {}, { read: true });
  root.append(muted('Your own attempts; a reviewer or an admin sees every attempt on the pod except authors\' tests.'));
  if (!r.attempts.length) { root.append(muted('No attempts yet.')); return; }
  root.append(h('table', { class: 'mine' }, h('thead', {}, h('tr', {}, ['scenario', 'attempt', 'state', 'started', 'result'].map((x) => h('th', { text: x })))),
    h('tbody', {}, r.attempts.map((a) => h('tr', {},
      h('td', {}, h('a', { href: attemptHash(a.attemptIri), text: a.scenarioTitle })),
      h('td', { text: `${a.attemptNumber}${a.authorTest ? ' (author test)' : ''}` }),
      h('td', { text: STATE_WORDS[a.state] || a.state }), h('td', { text: a.startedAt }),
      h('td', { text: a.finalPercent !== undefined ? `${a.finalPercent} %, ${a.finalMeetsPassRule ? 'meets' : 'does not meet'} the pass rule (reviewed)` : a.provisionalPercent !== undefined ? `${a.provisionalPercent} % (provisional, not reviewed)` : '' }))))));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Start
// ════════════════════════════════════════════════════════════════════════════════════════════

async function detectSigning() {
  S.hasWallet = typeof window.ethereum !== 'undefined';
  try {
    const r = await invoke(ACT.signAsDemoRole, {});
    if (r.demo && Array.isArray(r.roles)) {
      S.mode = 'demo';
      S.demoRoles = r.roles;
      const saved = recall('pev.role');
      S.role = r.roles.some((x) => x.role === saved) ? saved : (r.roles.some((x) => x.role === 'learner') ? 'learner' : r.roles[0].role);
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
  }
}

async function loadBridge() {
  try {
    const r = await invoke(ACT.listScenarios, podArgs({}));
    S.pod = r.podUrl;
    S.bridge = r.bridge;
    S.needPod = false;
  } catch (e) {
    if (e instanceof Refused && e.code === 'no-pod') S.needPod = true;
    else throw e;
  }
}

async function main() {
  try {
    await loadManifest();
    await detectSigning();
    await loadBridge();
  } catch (e) {
    clear($('#bar')).append(refusalBox(e));
    return;
  }
  renderHeader();
  window.addEventListener('hashchange', route);
  await route();
}

main();
