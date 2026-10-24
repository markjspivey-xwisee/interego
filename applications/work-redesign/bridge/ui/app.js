/**
 * Work Redesign — the browser client for the work-redesign bridge.
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
 * A person with no wallet can sign in with their Interego account instead (mode 'interego'): the
 * page sends them to the relay's own sign-in page (PKCE S256, a random state it checks on return),
 * the bridge exchanges the code for the relay's OAuth access token (POST /ui/oauth/exchange), and
 * from then on every payload is signed by the relay through POST /ui/relay/sign (the relay's MCP
 * sign_request), and sent as the act's {_signed_payload, _signature}. Relay-attested, not a key
 * the person holds; the access token passes through the bridge on every signature, and for its
 * hour it lets its holder call the relay's tools as the person and trade it at the relay's
 * /identity-token for the identity-server token behind the sign-in (good on the account itself
 * for up to a day). It is kept in sessionStorage only (this tab), never in localStorage, a URL or
 * the page, and forgotten when it ends (a timer, and a check before each signature) or when the
 * person signs out. Nothing revokes it.
 *
 * The page is a product app in the Interego design system (served first in /ui/app.css): a
 * welcome screen when signed out, then a header, a grouped side navigation, a Home with a
 * checklist per role and what waits for the person, and one view per job. Every label is in
 * plain words; every protocol fact the bridge says (its refusals verbatim, raw values, the trust
 * note) stays inside #app in a closed "Technical details" disclosure, one click away.
 *
 * Untrusted text (anything read from the pod or typed by a person) reaches the page only as
 * text nodes. No innerHTML, no style attribute: widths and range positions are set through the
 * CSSOM, which the page's Content-Security-Policy allows. localStorage keeps unsigned drafts only
 * (the capture table and valuation inputs); nothing signed or authoritative is stored there, and
 * nothing at all is stored on boot or at sign-in (the theme follows the system).
 */

// ── Words the page uses (prose lives here, not in the logic) ─────────────────────────────

// Kept verbatim, in Technical details: what the demo server, the bridge and the relay are.
const DEMO_BANNER = 'DEMO — keys are generated and held by this demo server. These are not signatures by real people.';
const SIGN_IN = 'Sign in with your Interego account';
const SIGN_IN_OFFERED = 'Or sign in with your Interego account: your passkey, on the Interego relay\'s own sign-in page. The relay then signs each act for you (relay-attested, not a key you hold), and an admin registers your Interego user DID, which this page shows once you are signed in.';
const NOT_SIGNED_IN = 'No wallet, and not signed in: this page cannot sign yet, and it reads the pod only where the bridge serves unsigned reads.';
const SEND_TO_ADMIN = 'This is who you are to this bridge: send it to an admin of this pod to be registered.';
const SIGNED_OUT = 'Signed out: this tab no longer holds the relay\'s access token for your sign-in. Nothing was revoked: the relay offers no way to revoke it, so the token stays good at the relay until it ends, about an hour after you signed in, for anyone who kept a copy (it passed through this bridge with every signature). Until it ends a holder can also trade it at the relay for the identity-server token behind your sign-in, which works on your account itself (linking a wallet, removing sign-in methods, deleting the account) for up to a day, and one already traded stays good that long. "Sign out everywhere" on the identity server\'s dashboard ends every identity-server token, but not the relay\'s access token.';
const SIGN_IN_ENDED = 'Your Interego sign-in has ended: sign in again.';
const NOT_STARTED_HERE = 'This tab did not start this sign-in, so nothing in the answer was shown or exchanged.';
const SIGN_IN_BUSY = 'Signing in with your Interego account is not available at this moment: reload this page shortly to try again.';
const RELAY_STEPS_TECH = [
  'Press "Sign in with your Interego account" and sign in with your passkey on the Interego relay\'s own page.',
  'Ask an admin to add your Interego user DID (shown at the top of this page once you are signed in) to this pod\'s registry: until then the bridge refuses your requests, for reads as for changes.',
  'Then sign. The page shows the exact payload; the relay signs it for you, and the bridge records it as relay-delegated.',
];
const SESSION_KEY = 'wrd.interego.session';   // sessionStorage: the relay's access token and when it ends
const FLOW_KEY = 'wrd.interego.flow';         // sessionStorage: the PKCE verifier and state while the relay's page is open
const CALLBACK_PATH = '/ui/oauth/callback';
const FLOW_MS = 10 * 60 * 1000;
const EPHEMERAL = 'EPHEMERAL — records will not be trusted after this server restarts';
const DEMO_KEY = 'DEMO KEY — derived from a published seed';
const READ_ONLY = 'No wallet: this browser has no EIP-191 wallet, so this page cannot sign, and it reads the pod only where the bridge serves unsigned reads. Install or enable a wallet that supports personal_sign and reload; the bridge accepts only signed envelopes and never asks for a key.';
const READ_SIGNING = 'Reading this pod needs your signature too: the page asks your wallet to sign one read and reuses it for up to nine minutes.';
const READ_RELAYED = 'Reading this pod needs a signature too: the relay signs one read for you, and the page reuses it for up to nine minutes.';
const RELAY_TRUST = 'Relay-attested, not a key you hold: the Interego relay signs each act for you. This tab holds the relay\'s access token for your sign-in (about an hour), and it passes through this bridge with every signature: until it ends it lets whoever holds it call the relay\'s tools as you, and trade it at the relay for the identity-server token behind your sign-in, which works on your account itself for up to a day. So whoever runs this bridge is trusted with your account for up to a day, past signing out.';
const READ_ENVELOPE_MS = 9 * 60 * 1000;
const WALLET_STEPS_TECH = [
  'Use a browser wallet that supports personal_sign (EIP-191).',
  'Ask an admin to add your wallet address to this pod\'s registry: until then the bridge refuses your signature, for reads as for changes.',
  'Press "Connect wallet" at the top of the page, then sign. The page shows the exact payload before your wallet does.',
  READ_SIGNING,
];
const chainCuts = (n) => `${n} record chain(s) do not read back to their first version: an earlier version is missing, or is not trusted. Their history is shown as incomplete, never as whole.`;
const trustCuts = (n, keys) => `${n} of them reach a version signed by a platform key this bridge no longer trusts (${keys.join(', ')}). Every change to them is refused (409) until the operator lists that address in WRD_TRUSTED_PLATFORM_ADDRESSES again: an address that signed records on this pod stays trusted for as long as the pod is used.`;
const HOLDER_WITHOUT_READ = 'Your read was refused, but anyone named in a record, or who signed one, can still take a copy of every record about their work, registered here or not. The copy keeps the platform\'s original signature; verify a download against the platform address you expect (the README gives the command).';

// What a customer reads.
const DEMO_SENTENCE = 'Demo workspace: sample people and sample data. Nothing here is a real person\'s signature.';
const RELAY_STEPS = [
  'Press "Sign in with your Interego account" and confirm with your passkey on Interego\'s page.',
  'If you see "One more step", send your Interego ID to your admin.',
  'Then press the button for your action. Interego signs it for you, and the record says so.',
];
const WALLET_STEPS = [
  'Use a browser wallet that can sign messages.',
  'Ask your admin to add your wallet address to this workspace.',
  'Press "Connect wallet", then sign. You\'ll see exactly what you\'re signing first.',
];
const TRUST_PLAIN = 'When you sign in with your Interego account, Interego signs each action for you. Your sign-in stays valid for about an hour, and it passes through this Work Redesign service each time you sign. While it\'s valid, it could be used to act on your Interego account for up to a day, even after you sign out here. Signing out on this page doesn\'t cancel it. "Sign out everywhere" on your Interego dashboard ends the day-long part; the hour-long part runs out on its own. If you need signatures only you can make, use a crypto wallet.';
const SIGNING_MEANS = 'Confirming says this description of your work is right. Disputing records why it isn\'t. Either way your response is signed, anyone in the workspace can check it, and you can download it with your record.';
const NO_TOTALS = 'We don\'t add ranges across decisions. Ranges can\'t be summed honestly.';
const SIGNING_FOOTNOTE = 'Your action is signed and recorded permanently.';
// A decision whose walk back from its current version stops short (chainUnreadable) is never shown as its whole chain.
const CHAIN_WHOLE = 'History: every version of this decision';
const CHAIN_CUT = 'History so far: some earlier versions cannot be read, so this history is incomplete';
const CHAIN_CUT_PRINT = 'Incomplete history.';

const ROLE_NAMES = { operator: 'Process lead', worker: 'Team member', approver: 'Approver', agent: 'AI agent', admin: 'Admin' };
const ROLE_ORDER = ['admin', 'operator', 'approver', 'worker', 'agent'];
const REGIME_NAMES = { Evident: 'Routine', Knowable: 'Needs expertise', Emergent: 'Exploratory', Turbulent: 'Unstable' };
const REGIME_TONE = { Evident: 'success', Knowable: 'info', Emergent: 'warning', Turbulent: 'danger' };
const REGIME_NOTES = {
  Evident: 'Same steps, same result; the output can be checked and you find out fast. The only category where AI may work on its own.',
  Knowable: 'Can be worked out by someone who knows the work. Changes are priced only on expert answers. AI never works on its own here.',
  Emergent: 'Only clear in hindsight. Change happens through small, safe-to-fail trials, which are never priced.',
  Turbulent: 'Things are unstable right now. Stabilise first; no change is allowed until it is sorted again.',
};
const METHOD_NAMES = { standardise: 'Standardise and measure', 'expert-analysis': 'Expert review first', 'probe-portfolio': 'Run small trials', 'stabilise-first': 'Stabilise first' };
const LEVEL_NAMES = {
  person: 'A person',
  'person-with-agent-assist': 'A person, with AI assisting',
  'agent-drafts-person-decides': 'AI drafts, a person decides',
  'agent-acts-person-audits': 'AI acts, a person checks',
  'agent-acts-within-grant': 'AI on its own (earned permission)',
};
const TASK_STATUS = { ratified: ['Confirmed', 'success'], disputed: ['Disputed', 'danger'], captured: ['Waiting for confirmation', 'pending'], retired: ['Retired', ''] };
const CLASS_STATUS = { ratified: ['Confirmed', 'success'], disputed: ['Disputed', 'danger'], classified: ['Sorted', 'pending'] };
const DECISION_STATUS = { submitted: ['Waiting for approval', 'pending'], countersigned: ['Approved: results not yet measured', 'info'], measured: ['Results recorded', 'success'], declined: ['Declined', 'danger'] };
const VERDICT_NAMES = { 'in-band': ['Within prediction', 'success'], 'out-of-band': ['Outside prediction', 'warning'], inconclusive: ['Inconclusive', ''] };
const OUTCOME_NAMES = { kept: 'Kept', reverted: 'Reversed', 'stopped-early': 'Stopped early' };
const FREED_NAMES = { redeployed: 'Moved to other work', absorbed: 'Absorbed by the team', unfilled: 'Left unfilled (cash saving)', undecided: 'Not decided yet' };
const BASIS_NAMES = { measured: 'Measured', document: 'From a document', 'performer-reported': 'Reported by the person doing it', estimate: 'Estimate', 'not-applicable': 'Doesn\'t apply (zero)' };
/** The same sources, short enough for the narrow Source column of the inputs grid. */
const BASIS_SHORT = { measured: 'Measured', document: 'From a document', 'performer-reported': 'Self-reported', estimate: 'Estimate', 'not-applicable': 'Doesn\'t apply (0)' };
const COMPARISON_NAMES = { 'before-after': 'Before vs. after (no comparison group)', holdout: 'Compared with a held-back group', staggered: 'Phased rollout' };
const METRIC_NAMES = { 'weekly-cash-delta': 'Weekly cash impact', 'weekly-delta-if-redeployed': 'Weekly impact if freed time is redeployed' };
const metricName = (m) => METRIC_NAMES[m] ?? m;
const ASSIGNMENT_STATE = { 'not-acknowledged': ['Waiting for their response', 'pending'], acknowledged: ['Accepted', 'success'], objected: ['Objected', 'danger'] };
const PLAN_KIND = { valued: 'Priced change', probe: 'Trial plan' };
const SIGNAL_NAMES = { amplify: 'Scale up', dampen: 'Scale back', neither: 'No clear signal' };
const RUN_VERDICTS = [['accepted', 'Accept'], ['reworked', 'Needs rework'], ['critical-failure', 'Critical failure']];
const CAL_STATUS = { Asserted: ['Established', 'success'], Hypothetical: ['Early: fewer than 20 results', 'pending'] };
const SOURCE_NAMES = { 'approved-decision': 'Now: approved change, being measured', 'measured-decision': 'From a measured, kept decision' };
// The classification options as the bridge's vocabulary spells them. Values sent are unchanged; only the option text is plain.
const OPTION_NAMES = {
  always: 'Always', usually: 'Usually', rarely: 'Rarely', documented: 'Written down', 'expert-analysis': 'Worked out by an expert',
  'not-knowable': 'Not knowable until it is done', no: 'No', partly: 'Partly', yes: 'Yes', stable: 'Stable', shifting: 'Shifting', unstable: 'Unstable',
  'before-effect': 'Before it takes effect', 'after-effect': 'Only after it takes effect', 'not-checkable': 'Can\'t be checked', minutes: 'Within minutes',
  days: 'Within days', weeks: 'Within weeks', 'months-or-more': 'Months or more', minor: 'Minor', recoverable: 'Recoverable', critical: 'Critical', unknown: 'Unknown',
};
const optionName = (o) => OPTION_NAMES[o] ?? String(o).charAt(0).toUpperCase() + String(o).slice(1).replace(/-/g, ' ');
const STATE_FIELDS = [
  ['performerHoursPerRun', 'Hours a person spends per run'],
  ['oversightHoursPerRun', 'Hours someone spends checking or deciding per run'],
  ['agentCostPerRun', 'AI cost per run'],
  ['minorFailureRate', 'Share of runs with a minor problem (0 to 1)'],
  ['minorFailureCost', 'Cost of one minor problem'],
  ['criticalFailureRate', 'Share of runs with a critical failure (0 to 1)'],
  ['criticalFailureCost', 'Cost of one critical failure'],
];
// The intents a signature covers, as a person would name them (the payload panel).
const INTENT_NAMES = {
  'wrd:classify-task': 'Sort a task by predictability', 'wrd:value-plan': 'Price a plan', 'wrd:countersign-decision': 'Approve or decline a decision',
  'wrd:ratify-task': 'Confirm or dispute', 'wrd:propose-allocation': 'Propose a change', 'wrd:submit-decision': 'Submit for approval',
  'wrd:record-outcome': 'Record results', 'wrd:update-registry': 'Change people and roles', 'wrd:holder-copy': 'Copy my record',
};
const TITLES = {
  home: 'Home', tasks: 'Processes', capture: 'Map a process', plan: 'Plans', value: 'Business case', decisions: 'Decisions',
  calibration: 'Track record', agents: 'AI agents', roles: 'People & roles', me: 'My record',
};
// The side navigation: group label (none for the first), then [view id, exact button text, icon].
const NAV = [
  ['', [['home', 'Home', 'home']]],
  ['Work', [['tasks', 'Processes', 'clipboard'], ['capture', 'Map a process', 'document']]],
  ['Change', [['plan', 'Plans', 'arrow-right'], ['value', 'Business case', 'money'], ['decisions', 'Decisions', 'shield']]],
  ['Results', [['calibration', 'Track record', 'chart'], ['agents', 'AI agents', 'sparkle']]],
  ['Workspace', [['roles', 'People & roles', 'people']]],
  ['You', [['me', 'My record', 'user']]],
];
const TAB_OF = {
  'wrd.update_registry': 'roles', 'wrd.task_map_packet': 'capture', 'wrd.record_task_map': 'capture', 'wrd.capture_workflow': 'capture',
  'wrd.revise_task': 'tasks', 'wrd.ratify_task': 'tasks', 'wrd.classify_task': 'tasks', 'wrd.propose_allocation': 'plan',
  'wrd.value_plan': 'value', 'wrd.submit_decision': 'decisions', 'wrd.countersign_decision': 'decisions', 'wrd.record_outcome': 'decisions',
  'wrd.log_agent_run': 'agents', 'wrd.grant_autonomy': 'agents', 'wrd.revoke_grant': 'agents', 'wrd.holder_copy': 'me',
  'wrd.list_records': 'tasks', 'wrd.calibration': 'calibration', 'wrd.read_records': 'tasks', 'wrd.read_calibration': 'calibration',
  'wrd.envelope_template': 'tasks', 'wrd.read_envelope_template': 'tasks', 'wrd.demo_advance_clock': 'decisions',
};
// What each action is called while it is signed and sent (the manifest's own titles stay in Technical details).
const ACTION_NAMES = {
  'wrd.update_registry': 'people and roles', 'wrd.capture_workflow': 'your process map', 'wrd.record_task_map': 'your process map',
  'wrd.revise_task': 'the task change', 'wrd.ratify_task': 'your response', 'wrd.classify_task': 'your answers', 'wrd.propose_allocation': 'the plan',
  'wrd.value_plan': 'the business case', 'wrd.submit_decision': 'the decision', 'wrd.countersign_decision': 'your approval decision',
  'wrd.record_outcome': 'the results', 'wrd.log_agent_run': 'the AI work record', 'wrd.grant_autonomy': 'the AI permission', 'wrd.revoke_grant': 'the AI permission',
  'wrd.holder_copy': 'your record', 'wrd.read_records': 'the workspace', 'wrd.list_records': 'the workspace', 'wrd.read_calibration': 'the workspace',
  'wrd.calibration': 'the workspace', 'wrd.task_map_packet': 'the instructions for your AI', 'wrd.envelope_template': 'what you\'re signing',
  'wrd.read_envelope_template': 'what you\'re signing', 'wrd.demo_envelope': 'the demo', 'wrd.demo_advance_clock': 'the demo',
};
const DONE_TITLES = {
  'wrd.update_registry': 'People and roles updated', 'wrd.capture_workflow': 'Process recorded', 'wrd.record_task_map': 'Process recorded',
  'wrd.revise_task': 'Task updated', 'wrd.ratify_task': 'Your response is recorded', 'wrd.classify_task': 'Task sorted', 'wrd.propose_allocation': 'Plan proposed',
  'wrd.value_plan': 'Business case saved', 'wrd.submit_decision': 'Submitted for approval', 'wrd.countersign_decision': 'Decision recorded',
  'wrd.record_outcome': 'Results recorded', 'wrd.log_agent_run': 'AI work recorded', 'wrd.grant_autonomy': 'AI permission checked',
  'wrd.revoke_grant': 'AI permission withdrawn', 'wrd.demo_advance_clock': 'Demo time moved forward',
};
// Why a button is disabled, in the words the person sees.
const WHY = {
  operator: 'Only process leads can do this.', approver: 'Only approvers can do this.', named: 'Only the people named on this task can respond.',
  operatorOrNamed: 'Only process leads and the people named on this task can do this.',
  sortable: 'Process leads, approvers and the people named on the task can sort it.', signIn: 'Sign in to do this.',
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
/** This tab only: the Interego sign-in (the relay's access token, and the PKCE verifier while the relay's page is open). Never localStorage. */
const tab = {
  get(key) { try { const v = sessionStorage.getItem(key); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  drop(key) { try { sessionStorage.removeItem(key); } catch { /* nothing was kept */ } },
};
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomUrlSafe(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return base64url(a);
}

const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : String(a ?? ''));
const addrOfDid = (did) => String(did ?? '').replace(/^did:ethr:/, '');
/** The DID a principal signs records as: an Interego user DID as it is, an address as did:ethr. */
const didOfPrincipal = (a) => (/^did:web:/.test(String(a)) ? String(a) : `did:ethr:${a}`);
const num = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
function money(n, currency) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  try { return n.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }); } catch { return num(n, 0); }
}

const band = (b, f) => (b ? `Low ${f(b.p10)} · Likely ${f(b.p50)} · High ${f(b.p90)}` : '—');
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
const plusWeeks = (iso, w) => new Date(Date.parse(iso) + w * 7 * 86400000).toISOString();
/** A date as a person reads it ("22 Oct 2026"); the exact instant stays in Technical details. */
function day(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '—';
  try { return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return when(iso); }
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


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

// ── Design-system building blocks (text nodes and createElementNS only) ───────────────────

const ICONS = {
  'sign-in': ['M15 3h3a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-3', 'M10 17l5-5-5-5', 'M15 12H3'],
  'user': ['M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  'check': ['M5 12.5l4.5 4.5L19 7.5'],
  'warning': ['M10.27 3.98 2.3 17.8A2 2 0 0 0 4.03 20.8h15.94a2 2 0 0 0 1.73-3L13.73 3.98a2 2 0 0 0-3.46 0Z', 'M12 9.5v4', 'M12 17h.01'],
  'info': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  'document': ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  'people': ['M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', 'M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1', 'M16 4.2a3.8 3.8 0 0 1 0 7.6', 'M18 14.2a5 5 0 0 1 3 4.6V20'],
  'chart': ['M3 3v18h18', 'M8 17v-5', 'M12.5 17V7', 'M17 17v-8'],
  'shield': ['M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6Z', 'M9 12l2 2 4-4'],
  'sparkle': ['M12 3l1.8 5.2a3 3 0 0 0 1.9 1.9L21 12l-5.3 1.8a3 3 0 0 0-1.9 1.9L12 21l-1.8-5.3a3 3 0 0 0-1.9-1.9L3 12l5.3-1.9a3 3 0 0 0 1.9-1.9Z', 'M19 2.5v3', 'M17.5 4h3'],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'external': ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  'download': ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16'],
  'chat': ['M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12Z'],
  'clipboard': ['M9 3.5h6a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z', 'M16 5h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1', 'M9 14l2 2 4-4'],
  'close': ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'menu': ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  'home': ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  'money': ['M12 2.5v19', 'M17 6.5H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H6'],
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
/** A decorative icon (aria-hidden): `size` is '', 'sm' or 'lg'. */
function icon(name, size = '') {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: size ? `icon icon--${size}` : 'icon', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of ICONS[name] ?? ICONS.info) svg.append(svgEl('path', { d }));
  return svg;
}
/** The Interego mark; its colours come from .brand__mark in the stylesheet. */
function brandMark() {
  const svg = svgEl('svg', { viewBox: '0 0 32 32', class: 'brand__mark', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgEl('rect', { class: 'mark-tile', x: 0, y: 0, width: 32, height: 32, rx: 9 }), svgEl('path', { class: 'mark-edge', d: 'M10.5 11.5 21.5 11.5 16 21.5Z' }),
    svgEl('circle', { class: 'mark-node', cx: 10.5, cy: 11.5, r: 3 }), svgEl('circle', { class: 'mark-node', cx: 21.5, cy: 11.5, r: 3 }), svgEl('circle', { class: 'mark-node', cx: 16, cy: 21.5, r: 3 }));
  return svg;
}
const brandLink = () => h('a', { class: 'brand', href: '/' }, brandMark(), h('span', { class: 'brand__name' }, h('span', { class: 'brand__company', text: 'Interego' }), h('span', { class: 'brand__product', text: 'Work Redesign' })));
/** The other Interego product, from the shell's meta tags (one source: bridge/landing.ts). */
function sibling() {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? '';
  return { name: meta('wrd-sibling-name') || 'Practice Evidence', url: meta('wrd-sibling-url') || 'https://pev-bridge-production.up.railway.app/' };
}
const productSwitch = () => { const s = sibling(); return h('a', { class: 'product-switch', href: s.url }, h('span', { class: 'product-switch__dot', 'aria-hidden': 'true' }), h('span', { class: 'product-switch__prefix', text: 'Also from Interego:' }), ` ${s.name}`); };

/** A button whose text is exactly `label` (the tests click buttons by their text; an icon adds none). */
function btn(label, { variant = 'secondary', size = '', on, disabled = false, why = '', icon: lead = '', end = '', cls = '', attrs = {} } = {}) {
  const b = h('button', { type: 'button', class: `btn btn--${variant}${size ? ` btn--${size}` : ''}${cls ? ` ${cls}` : ''}`, disabled: Boolean(disabled), title: disabled && why ? why : undefined, on: on ? { click: on } : undefined, ...attrs });
  if (lead) b.append(icon(lead, 'sm'));
  b.append(document.createTextNode(label));
  if (end) b.append(icon(end, 'sm'));
  return b;
}
const whyNot = (text) => h('p', { class: 'hint why-not' }, h('strong', { text: 'Why can\'t I? ' }), text);
const status = (text, tone) => h('span', { class: `status${tone ? ` status--${tone}` : ''}`, text });
const badge = (text, tone) => h('span', { class: `badge${tone ? ` badge--${tone}` : ''}`, text });
const note = (text, tone, tag = 'p') => h(tag, { class: `note note--${tone}`, text });
const hint = (text) => h('p', { class: 'hint', text });
const footnote = () => hint(S.mode === 'interego' ? 'Signed via your Interego account.' : SIGNING_FOOTNOTE);

/** Every protocol fact, one click away: a closed disclosure whose body is set in monospace. Strings become paragraphs. */
function techDetails(summary = 'Technical details', ...kids) {
  return h('details', { class: 'disclosure' }, h('summary', { text: summary }),
    h('div', { class: 'disclosure__body disclosure__body--tech' }, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== '').map((k) => (typeof k === 'string' ? h('p', { text: k }) : k))));
}
/** A plain disclosure (not technical): a summary and a body. */
const disclosure = (summary, ...kids) => h('details', { class: 'disclosure' }, h('summary', { text: summary }), h('div', { class: 'disclosure__body' }, kids));

function callout({ tone = 'info', title, body, actions = [], tech = null, alert = false, onClose = null, iconName = '', extra = null, cls = '' }) {
  const ic = icon(iconName || (tone === 'warning' || tone === 'danger' ? 'warning' : tone === 'success' ? 'check' : 'info'));
  ic.classList.add('callout__icon');
  const acts = actions.filter(Boolean);
  return h('div', { class: `callout callout--${tone}${cls ? ` ${cls}` : ''}`, role: alert ? 'alert' : undefined },
    ic, h('p', { class: 'callout__title', text: title }),
    body ? (typeof body === 'string' ? h('p', { class: 'callout__body', text: body }) : h('div', { class: 'callout__body' }, body)) : null,
    extra,
    acts.length ? h('div', { class: 'callout__actions' }, acts) : null,
    onClose ? h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm callout__close', 'aria-label': 'Dismiss', on: { click: onClose } }, icon('close', 'sm')) : null,
    tech);
}

function emptyState({ icon: ic = 'info', title, text, actions = [], plain = false }) {
  const acts = actions.filter(Boolean);
  return h('div', { class: `empty${plain ? ' empty--plain' : ''}` }, h('span', { class: 'empty__icon' }, icon(ic)),
    h('h3', { class: 'empty__title', text: title }), text ? h('p', { class: 'empty__text', text }) : null, acts.length ? h('div', { class: 'empty__actions' }, acts) : null);
}

function pageHeader({ eyebrow = '', title, lede = '', meta = [], actions = [], crumbs = null }) {
  const m = meta.filter(Boolean);
  const a = actions.filter(Boolean);
  return h('header', { class: 'page-header' },
    h('div', { class: 'page-header__text' }, crumbs, eyebrow ? h('span', { class: 'eyebrow', text: eyebrow }) : null, h('h1', { class: 'page-title', text: title }),
      lede ? h('p', { class: 'page-lede', text: lede }) : null, m.length ? h('div', { class: 'page-header__meta' }, m) : null),
    a.length ? h('div', { class: 'page-header__actions' }, a) : null);
}
const viewSection = (title, lede, ...kids) => h('section', { class: 'view-section' }, h('h2', { class: 'view-section__title', text: title }), lede ? h('p', { class: 'text-secondary', text: lede }) : null, kids);

let fieldSeq = 0;
/** A labelled control: the control gets an id and its design-system class; a hint is tied to it. */
function field(label, control, { hint: help = '', optional = false } = {}) {
  fieldSeq += 1;
  const id = control.id || `f-${fieldSeq}`;
  control.id = id;
  if (!control.className) control.className = control.tagName === 'SELECT' ? 'select' : control.tagName === 'TEXTAREA' ? 'textarea' : 'input';
  if (help) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label, optional ? h('span', { class: 'label__optional', text: '(optional)' }) : null), control,
    help ? h('p', { class: 'hint', id: `${id}-hint`, text: help }) : null);
}
const select = (options, value, on, props) => h('select', { class: 'select', ...(props || {}), on: on ? { change: on } : undefined },
  options.map(([v, t, disabled, title]) => h('option', { value: v, text: t, selected: v === value, disabled: !!disabled, title })));
const input = (value, on, props) => h('input', { class: 'input', ...(props || {}), value: value ?? '', on: on ? { input: on } : undefined });
const textarea = (value, on, props) => h('textarea', { class: 'textarea', value: value ?? '', ...(props || {}), on: on ? { input: on } : undefined });
/** A checkbox or radio with its label (and an optional hint), as one target. */
function choice(type, name, label, { checked = false, help = '', on, card = false, disabled = false, value } = {}) {
  return h('label', { class: `choice${card ? ' choice--card' : ''}` },
    h('input', { type, name: name || undefined, checked, disabled, value, on: on ? { change: on } : undefined }),
    h('span', { class: 'choice__text' }, h('span', { text: label }), help ? h('span', { class: 'choice__hint', text: help }) : null));
}
/** A description list; null pairs are skipped. */
const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));

let tableSeq = 0;
/** A table in a scrolling, labelled region; every cell carries its column's name for the stacked mobile layout. */
function table(head, rows, { label = '', stack = true, compact = false, cls = '' } = {}) {
  tableSeq += 1;
  const names = head.map((c) => c.replace(/^#/, ''));
  const body = h('tbody', null, rows);
  for (const tr of body.querySelectorAll('tr')) [...tr.children].forEach((td, i) => { if (td.tagName === 'TD') td.setAttribute('data-label', names[i] ?? ''); });
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': label || `Table ${tableSeq}`, tabindex: '0' },
    h('table', { class: `table${stack ? ' table--stack' : ''}${compact ? ' table--compact' : ''}${cls ? ` ${cls}` : ''}` },
      h('thead', null, h('tr', null, head.map((c, i) => h('th', { scope: 'col', class: c.startsWith('#') ? 'num' : names[i] === '' ? 'actions' : '' }, names[i] === '' ? h('span', { class: 'visually-hidden', text: 'Actions' }) : names[i])))),
      body));
}
const td = (props, ...kids) => h('td', props, kids);

/** A short notice outside #app (the toast region), gone after five seconds. */
function toast(title, text, tone = 'success') {
  const region = document.getElementById('toasts');
  if (!region) return;
  const ic = icon(tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'warning');
  ic.classList.add('toast__icon');
  const el = h('div', { class: `toast toast--${tone}` }, ic, h('p', { class: 'toast__title', text: title }), text ? h('p', { class: 'toast__text', text }) : null);
  region.append(el);
  setTimeout(() => el.remove(), 5000);
}

// ── State ────────────────────────────────────────────────────────────────────────────────

const S = {
  tools: new Map(), data: null, cal: null, calFailed: false, mode: 'readonly', persona: '', personas: [], account: '', tab: 'home',
  workflow: '', plan: '', result: null, panel: null, busy: false, planForm: {}, packet: null, decisionOpen: '', decisionFilter: 'all',
  pod: new URLSearchParams(location.search).get('pod') ?? '',
  reads: new Map(),             // signed read envelopes by signer and pod, reused for up to READ_ENVELOPE_MS
  readRefused: false,           // the last signed read was refused (401 or 403): the holder's copy is still offered
  readSigned: false,            // the records shown came from a signed read (only an admin or a registered key gets one)
  bootError: '',                // the manifest could not be read: the page says so and asks nothing else
  signIn: null,                 // the bridge's GET /ui/oauth/config: whether, and through which relay, a person can sign in
  // Signed in with an Interego account: the relay's access token (this tab only), and who it is, as
  // the relay's signature (the agent) and the bridge (the person) say, learned from the first signature.
  interego: null,               // { token, expiresAt, principal, agentId, relaySigner }
  signInTimer: null,            // forgets the access token when it ends
  demoNow: '',                  // the demo server's clock, once moved here
  showSubmit: false,            // the Decisions view's submit form is open
  openKinds: false,             // People & roles opens its "Add a type of task" form once
};

// ── Who is who, from the read model ─────────────────────────────────────────────────────

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
  if (S.mode === 'interego') return S.interego?.principal ?? '';
  return S.mode === 'wallet' ? S.account : '';
}
const roles = (a) => member(a)?.roles ?? [];
const can = (role) => roles(actor()).includes(role) && !member(actor())?.softwareAgent;
const myRef = () => member(actor())?.personRef ?? '';
/** Roles in plain words, in a fixed order ("Process lead, Approver"). */
const rolesPlain = (list) => [...(list ?? [])].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).map((r) => ROLE_NAMES[r] ?? r);
/** Only an admin or a registered key gets a signed read; a signer who is no member and still read signed is an admin (the bridge checks everything again). */
const isAdmin = () => S.readSigned && actor() !== '' && !member(actor());
/** Every record here is sample data: then "Sample data" is said once per page, not on every row. */
const allDemo = () => { const d = data(); return d.demoRecords > 0 && d.demoRecords === d.records; };
const sampleBadge = (row) => (row && row.demo && !allDemo() ? badge('Sample data', 'demo') : null);
/** The workspace's name from its storage address: the last path segment, in words ("ap-team" → "AP Team"); else the host. */
function workspaceLabel(podUrl) {
  try {
    const u = new URL(String(podUrl ?? ''));
    const seg = u.pathname.split('/').filter(Boolean).at(-1);
    if (!seg) return u.hostname;
    return seg.split(/[-_]+/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  } catch { return 'Workspace'; }
}
/** The name a person goes by: a member's label before its first comma. */
const displayName = (a) => {
  const label = member(a)?.label ?? (S.mode === 'demo' ? personas().find((p) => p.address === a)?.label : '') ?? '';
  return String(label).split(',')[0].trim();
};
const initials = (name) => name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();
/** An Interego user DID as a person reads it: the id after ":users:". */
const userIdOf = (did) => { const m = /:users:(.+)$/.exec(String(did ?? '')); return m ? m[1] : short(did); };
const identityUrl = () => (S.signIn?.identityHost ? `https://${S.signIn.identityHost}/` : 'https://identity.interego.xwisee.com/');
const kindLabel = (slug) => reg().taskKinds.find((k) => k.slug === slug)?.label ?? slug;
const kindDefinition = (slug) => reg().taskKinds.find((k) => k.slug === slug)?.definition ?? '';
const nowMs = () => (S.demoNow ? Date.parse(S.demoNow) : Date.now());

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

/** Signing did not happen; `answer`, when there is one, is the refusal that says why. */
class NotSigned extends Error {
  constructor(message, answer) { super(message); this.answer = answer; }
}
const SIGN_IN_TOOL = 'Interego sign-in';
/** A relay-signed request ({_signed_payload, _signature}) rather than a key-held envelope ({payload, signature}). */
const isRelayForm = (e) => Boolean(e) && typeof e === 'object' && typeof e._signed_payload === 'string';

/** Sign a payload as the acting identity (or, in the demo, as a named persona). */
async function sign(payload, persona) {
  if (S.mode === 'demo') {
    // The demo server's clock is scripted: it fills issuedAt and the nonce itself.
    const r = await call('wrd.demo_envelope', { persona: persona || S.persona, payload });
    if (!r.ok) { showResult('wrd.demo_envelope', r); throw new NotSigned('demo signing refused'); }
    return r.body.envelope;
  }
  if (S.mode === 'interego' && S.interego) return relaySign(payload);
  if (S.mode === 'wallet' && S.account) {
    const full = { ...payload, issuedAt: new Date().toISOString(), nonce: randomHex(16) };
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [utf8Hex(canonicalJson(full)), S.account] });
    return { payload: full, signature };
  }
  showResult('sign', { ok: false, status: 0, body: { error: 'Nothing to sign with.', 'iep:refusalReason': S.mode === 'wallet' ? 'connect your wallet first' : S.signIn?.enabled ? NOT_SIGNED_IN : READ_ONLY } });
  throw new NotSigned('read only');
}

/** POST JSON to one of this bridge's own sign-in routes (the page never calls the relay: connect-src is 'self'). */
async function post(path, body, bearer) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res;
  try { res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }); } catch (e) {
    return { ok: false, status: 0, body: { error: 'The bridge could not be reached.', 'iep:refusalReason': String(e?.message ?? e) } };
  }
  let j;
  try { j = await res.json(); } catch { j = { error: `HTTP ${res.status}: the answer was not JSON.` }; }
  return { ok: res.ok && j?.kind !== 'refusal', status: res.status, body: j };
}

/**
 * Sign a payload through the Interego relay: POST /ui/relay/sign with this tab's access token,
 * which the bridge presents at the relay's /mcp to call sign_request. The relay's own timestamp
 * stands for issuedAt, so none is sent; the nonce is fresh. Returns {_signed_payload, _signature}: sent as an act's body,
 * or wherever an envelope goes. The first signature also says who signed: the agent from the text
 * the relay signed, and the person that agent belongs to from the bridge (POST /ui/relay/whoami),
 * never from anything this page assumes.
 */
async function relaySign(payload) {
  if (!(Date.parse(S.interego.expiresAt) > Date.now())) {
    endSignIn(SIGN_IN_ENDED);
    throw new NotSigned('signed out', { ok: false, status: 401, body: { error: SIGN_IN_ENDED } });
  }
  const r = await post('/ui/relay/sign', { payload: { ...payload, nonce: randomHex(16) } }, S.interego.token);
  if (!r.ok) {
    // 401 (interego-sign-in-expired, or a token that cannot sign): the relay no longer takes this tab's token, so it is forgotten.
    if (r.status === 401) endSignIn(r.body?.error ?? SIGN_IN_ENDED);
    showResult(SIGN_IN_TOOL, r);
    throw new NotSigned('the relay did not sign', r);
  }
  const form = { _signed_payload: r.body._signed_payload, _signature: r.body._signature };
  let signed = {};
  try { signed = JSON.parse(form._signed_payload); } catch { signed = {}; }
  const agentId = typeof signed?.agent_id === 'string' ? signed.agent_id : '';
  if (!S.interego.principal || S.interego.agentId !== agentId) {
    const who = await post('/ui/relay/whoami', form);
    if (!who.ok || who.body.agentId !== agentId || typeof who.body.principal !== 'string') {
      const answer = who.ok ? { ok: false, status: 0, body: { error: 'The bridge named another agent than the relay signed for.', 'iep:refusalReason': `the relay signed for ${agentId || '(none)'}; the bridge answered for ${who.body.agentId}` } } : who;
      showResult(SIGN_IN_TOOL, answer);
      throw new NotSigned('no person named', answer);
    }
    S.interego = { ...S.interego, principal: who.body.principal, agentId, relaySigner: who.body.relaySigner ?? '' };
  }
  return form;
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
    // A relay-signed request is the act's body itself, as the relay's own act sends it; a key-held envelope goes under envelope.
    r = await call(toolName, isRelayForm(envelope) ? { ...(extra || {}), ...envelope } : { envelope, ...(extra || {}) });
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

/** One field of a template, as a person reads it: names for what the page knows, a short form for the rest. */
function plainValue(key, v) {
  if (v === null || v === undefined || v === '') return 'Not set yet';
  if (key === 'intent') return INTENT_NAMES[v] ?? String(v);
  if (/podUrl|pod_url/.test(key)) return workspaceLabel(v);
  if (/taskIri$/.test(key)) return taskName(v);
  if (/planIri$/.test(key)) return planBy(v)?.title ?? 'A plan';
  if (/decisionIri$/.test(key)) { const d = (data().decisions ?? []).find((x) => x.decisionIri === v); return d ? planBy(d.planIri)?.title ?? 'A decision' : 'A decision'; }
  if (/Sha256$|Digest$|Hash$/.test(key)) return 'A fingerprint of the current version';
  if (/descriptorUrl|recordId/.test(key)) return 'The current version of this record';
  if (Array.isArray(v)) return plural(v.length, 'item');
  if (typeof v === 'object') return plural(Object.keys(v).length, 'detail');
  return short(String(v));
}
const FIELD_NAMES = {
  intent: 'What you are doing', podUrl: 'Workspace', taskIri: 'Task', planIri: 'Plan', decisionIri: 'Decision', taskTextSha256: 'The task description you read',
  answers: 'Your answers', notes: 'Your note', note: 'Your note', verdict: 'Your verdict', inputs: 'Your business case inputs', descriptorUrl: 'Version',
  graphDigest: 'Version fingerprint', recordId: 'Record', valuationHash: 'Business case', measurementPlan: 'How it will be measured',
};

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
  const tpl = r.body.template ?? {};
  const fill = r.body.fill ?? [];
  openPanel('Exactly what you\'re signing', h('div', { class: 'stack' },
    h('p', { text: 'Nothing is sent until you press the main button. Your signature will cover:' }),
    kv(Object.entries(tpl).filter(([k]) => k !== 'issuedAt' && k !== 'nonce').map(([k, v]) => [FIELD_NAMES[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), plainValue(k, v)])),
    h('p', { class: 'hint', text: `Fields you still decide: ${fill.length ? fill.map((f) => FIELD_NAMES[f] ?? f).join(', ') : 'none'}.` }),
    r.body.contextWithheld ? note(r.body.contextWithheld, 'warning') : null,
    techDetails('Technical details',
      `${r.body.signing ?? ''} Sent to ${r.body.toolName ?? ''}. Fields still yours to decide: ${fill.join(', ') || 'none'}.`,
      h('h4', { text: 'Template, filled from the pod' }), h('pre', { text: JSON.stringify(r.body.template, null, 2) }),
      Object.keys(r.body.context ?? {}).length ? [h('h4', { text: 'What the bridge read to fill it' }), h('pre', { text: JSON.stringify(r.body.context, null, 2) })] : null,
      h('h4', { text: 'JSON Schema' }), h('pre', { text: JSON.stringify(r.body.schema, null, 2) }))));
}
const payloadButton = (intent, args) => btn('See exactly what you\'re signing', { variant: 'secondary', on: () => showPayload(intent, args), attrs: { title: 'The precise information your signature will cover. Nothing is sent until you press the main button.' } });

/** Who would sign a read now, or '' when nothing can sign. */
function readSigner() {
  if (S.mode === 'demo') return S.persona ? `demo:${S.persona}` : '';
  if (S.mode === 'interego') return S.interego ? 'interego' : '';
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
        if (e instanceof NotSigned && e.answer) return e.answer;
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
  // Only an admin or a registered key reads signed (the admin heuristic and the read-exposure line use it).
  S.readSigned = r.ok && signed;
  if (r.ok) S.data = r.body;
  else if (!quiet) { S.data = null; S.result = { tool: signed ? 'wrd.read_records' : 'wrd.list_records', ...r }; }
  else S.data = null;
  if (S.data && S.tab === 'calibration') {
    const c = signed
      ? await signedRead((envelope) => call('wrd.read_calibration', { envelope, pod_url: pod }))
      : await call('wrd.calibration', { pod_url: pod });
    S.cal = c.ok ? c.body : null;
    S.calFailed = !c.ok;
    if (!c.ok) S.result = { tool: signed ? 'wrd.read_calibration' : 'wrd.calibration', ...c };
  }
  render();
}

async function boot() {
  // The relay's answer leaves the address bar (and this tab's sign-in flow leaves sessionStorage)
  // before this page sends any request, even the manifest's read, so a failure below leaves neither.
  const callback = takeCallback();
  // A printed decision is drawn into #print; once printed it goes, so a later print shows the page.
  window.addEventListener('afterprint', () => document.getElementById('print')?.replaceChildren());
  let m;
  try {
    const res = await fetch('/affordances?format=jsonld', { headers: { accept: 'application/ld+json' } });
    m = await res.json();
  } catch (e) {
    S.bootError = String(e?.message ?? e);
    render();
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
  } else {
    S.signIn = await signInConfig();
    if (callback) await finishSignIn(callback);
    S.interego = keptSignIn();
    if (S.interego) { S.mode = 'interego'; forgetAtExpiry(); } else if (window.ethereum) S.mode = 'wallet';
  }
  // A task link opened from the page (or the address bar) shows the task from its top.
  window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });
  // A sign-in that did not finish (or ended) stays on screen: the first read, refused or not, does not replace it.
  await refresh(S.result !== null);
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

// ── Sign in with your Interego account ───────────────────────────────────────────────────

/**
 * Whether, and through which relay, this bridge signs a person in: GET /ui/oauth/config (null when
 * it does not answer). A refusal (429: the bridge is keeping its calls to the relay under a limit)
 * is not set up right now, and says so with the bridge's own words.
 */
async function signInConfig() {
  try {
    const res = await fetch('/ui/oauth/config', { headers: { accept: 'application/json' } });
    const j = await res.json();
    if (j && typeof j === 'object' && j.kind === 'refusal') return { enabled: false, busy: true, why: String(j.error ?? `HTTP ${res.status}`) };
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** The sign-in this tab keeps, or null; one that has ended is forgotten, and the page says so. */
function keptSignIn() {
  const k = tab.get(SESSION_KEY);
  if (!k) return null;
  if (typeof k.token !== 'string' || k.token === '' || !(Date.parse(k.expiresAt) > Date.now())) {
    tab.drop(SESSION_KEY);
    S.result ??= { tool: SIGN_IN_TOOL, ok: false, status: 401, body: { error: SIGN_IN_ENDED } };
    return null;
  }
  // Who it is is learned again from this page's first signature: the agent from the relay's text, the person from the bridge.
  return { token: k.token, expiresAt: k.expiresAt, principal: '', agentId: '', relaySigner: '' };
}

/**
 * Send this tab to the relay's own sign-in page: PKCE S256 (the verifier stays in this tab) and a
 * random state, both kept in sessionStorage until the relay sends the person back.
 */
async function startSignIn() {
  const c = S.signIn;
  if (!c?.enabled) {
    showResult(SIGN_IN_TOOL, { ok: false, status: 0, body: { error: 'Signing in with an Interego account is not available on this bridge.', 'iep:refusalReason': c?.why ?? 'the bridge did not say how to sign in' } });
    return;
  }
  let verifier;
  let challenge;
  try {
    verifier = randomUrlSafe(32);
    challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  } catch (e) {
    showResult(SIGN_IN_TOOL, { ok: false, status: 0, body: { error: 'This browser cannot start the sign-in here.', 'iep:refusalReason': `PKCE needs crypto.subtle, which a browser offers over https or on localhost: ${e?.message ?? e}` } });
    return;
  }
  const state = randomUrlSafe(24);
  if (!tab.set(FLOW_KEY, { verifier, state, at: Date.now(), back: `${location.pathname}${location.search}${location.hash}` })) {
    showResult(SIGN_IN_TOOL, { ok: false, status: 0, body: { error: 'This browser keeps nothing for this tab, so the sign-in could not be finished.', 'iep:refusalReason': 'sessionStorage is off; the PKCE verifier and state must survive the visit to the relay\'s page' } });
    return;
  }
  const u = new URL(c.authorizationEndpoint);
  const params = [['response_type', 'code'], ['client_id', c.clientId], ['redirect_uri', c.redirectUri], ['scope', c.scope],
    ['state', state], ['code_challenge', challenge], ['code_challenge_method', 'S256']];
  for (const [k, v] of params) u.searchParams.set(k, v);
  // This tab goes to the relay's sign-in page (window.open with '_self' is location.assign by another name).
  window.open(u.href, '_self');
}

/**
 * When the relay sent this tab back to /ui/oauth/callback?code=…&state=…, take its answer: the
 * query out of the address bar at once, before boot() sends anything, and the flow this tab
 * stored when it sent the person to sign in. Anyone can send a person to this page, with no state
 * or another and an `error` of their choosing, so the flow leaves sessionStorage here only for the
 * answer that carries its state, or once it has expired (or cannot be read); otherwise it stays,
 * waiting for its own answer. Null on any other page.
 */
function takeCallback() {
  if (location.pathname !== CALLBACK_PATH) return null;
  const q = new URLSearchParams(location.search);
  const kept = tab.get(FLOW_KEY);
  const flow = kept && typeof kept.state === 'string' && typeof kept.verifier === 'string' ? kept : null;
  const ours = flow !== null && q.get('state') === flow.state;
  const expired = flow !== null && !(Date.now() - Number(flow.at) < FLOW_MS);
  if (ours || expired || flow === null) tab.drop(FLOW_KEY);
  const back = typeof flow?.back === 'string' && flow.back.startsWith('/ui') && !flow.back.startsWith(CALLBACK_PATH) ? flow.back : '/ui';
  history.replaceState(null, '', back);
  S.pod = new URLSearchParams(location.search).get('pod') ?? '';
  return { q, flow, ours, expired };
}

/**
 * Finish the sign-in takeCallback took out of the address bar: the state must be the one this tab
 * stored when it sent the person to sign in, and the bridge exchanges the code, with the verifier
 * only this tab holds, for the token. Nothing in an answer with another state is shown or acted on,
 * not even the relay's error: the page says only that this tab did not start this sign-in.
 */
async function finishSignIn({ q, flow, ours, expired }) {
  const fail = (error, why) => { S.result = { tool: SIGN_IN_TOOL, ok: false, status: 0, body: { error, 'iep:refusalReason': why } }; };
  const NOT_FINISHED = 'Sign-in was not finished, and nothing was exchanged.';
  if (!ours) {
    fail(NOT_STARTED_HERE, flow === null ? 'this tab holds no sign-in it started (none, or it was finished already)'
      : expired ? 'the answer does not carry the state this tab stored, and the sign-in this tab started is over ten minutes old, so it was dropped'
        : 'the answer does not carry the state this tab stored when it sent you to sign in, so it is not the sign-in you started; that sign-in is still waiting for its own answer');
    return;
  }
  // The answer to this tab's own sign-in: the relay's words are shown (as text), and the sign-in is over.
  const error = q.get('error');
  if (error) { const d = q.get('error_description'); fail('The Interego relay did not sign you in.', `${error.slice(0, 80)}${d ? `: ${d.slice(0, 300)}` : ''}`); return; }
  if (expired) { fail(NOT_FINISHED, 'the sign-in was started more than ten minutes ago'); return; }
  const code = q.get('code');
  if (!code) { fail(NOT_FINISHED, 'the relay sent back no code'); return; }
  const r = await post('/ui/oauth/exchange', { code, code_verifier: flow.verifier, state: flow.state });
  if (!r.ok) { S.result = { tool: SIGN_IN_TOOL, ...r }; return; }
  // The relay's access token and when it ends; no refresh token reaches this page (the bridge drops it).
  if (!tab.set(SESSION_KEY, { token: r.body.token, expiresAt: r.body.expiresAt })) fail('Signed in, but this tab cannot keep the access token.', 'sessionStorage is off in this browser');
}

/**
 * Forget the access token when it ends, as the bridge said when it handed it over: the tab's
 * sessionStorage and this page then hold it no longer, and the page offers the sign-in again.
 */
function forgetAtExpiry() {
  clearTimeout(S.signInTimer);
  const left = Date.parse(S.interego?.expiresAt ?? '') - Date.now();
  // setTimeout takes at most 2^31 - 1 ms; the bridge hands out at most a day.
  S.signInTimer = setTimeout(() => {
    S.signInTimer = null;
    if (!S.interego) return;
    endSignIn(SIGN_IN_ENDED);
    if (S.busy) render();
    else void refresh(true);
  }, Math.min(Math.max(Number.isFinite(left) ? left : 0, 0), 2 ** 31 - 1));
}

/** Forget this tab's sign-in (the access token, and every read the relay signed for it); `ok` when the person signed out. */
function endSignIn(note, ok = false) {
  clearTimeout(S.signInTimer);
  S.signInTimer = null;
  tab.drop(SESSION_KEY);
  tab.drop(FLOW_KEY);
  S.interego = null;
  for (const k of [...S.reads.keys()]) if (k.startsWith('interego|')) S.reads.delete(k);
  S.mode = window.ethereum ? 'wallet' : 'readonly';
  S.panel = null;
  S.result = ok ? { tool: SIGN_IN_TOOL, ok: true, status: 200, body: { status: 'signed out', note } } : { tool: SIGN_IN_TOOL, ok: false, status: 401, body: { error: note } };
}
async function signOut() {
  endSignIn(SIGNED_OUT, true);
  await refresh(true);
}

// ── Screens and the app frame ─────────────────────────────────────────────────────────────

/** Draw exactly one screen into #app: the workspace unreachable, one more step, the welcome, or the app. */
function render() {
  const root = document.getElementById('app');
  if (!root) return;
  let nodes;
  let title;
  if (S.bootError) { nodes = unreachableView(); title = 'Workspace unreachable'; }
  else if (!S.data && S.readRefused && actor()) { nodes = notAddedView(); title = 'One more step'; }
  else if (!S.data) { nodes = welcomeView(); title = 'Sign in'; }
  else {
    const iri = taskFromHash();
    nodes = appFrame(iri ? taskView(iri) : view());
    title = iri ? taskBy(iri)?.name ?? 'Task' : TITLES[S.tab] ?? 'Home';
  }
  root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  document.title = `${title} · Work Redesign`;
  if (S.panel?.focus) { S.panel.focus = false; document.getElementById('panel-title')?.focus(); }
}

function appFrame(content) {
  return [
    envBanner(),
    appHeader(),
    h('div', { class: 'app-shell' },
      sideNav(),
      h('main', { class: 'app-main', id: 'main' }, health(), resultNode(), panelNode(), content, appFooter())),
  ];
}

/** Demo only: a calm striped banner on every screen, with the persona picker and the demo clock. */
function envBanner() {
  if (S.mode !== 'demo') return null;
  const option = (p) => {
    const rs = roles(p.address);
    return h('option', { value: p.id, selected: p.id === S.persona, text: `${p.label} — ${rs.length ? rolesPlain(rs).join(', ') : p.id === 'admin' ? 'Admin' : 'not in this workspace'}` });
  };
  const weeks = input('4', null, { type: 'number', min: 1, max: 104, 'aria-label': 'Weeks to skip' });
  return h('div', { class: 'env-banner', role: 'note' },
    h('span', { class: 'env-banner__label', text: 'Demo' }),
    h('span', { text: DEMO_SENTENCE }),
    h('span', { class: 'env-banner__field' }, h('label', { for: 'persona', text: 'View as' }),
      h('select', { id: 'persona', class: 'select', on: { change: (e) => { S.persona = e.target.value; S.panel = null; S.result = null; refresh(); } } }, personas().map(option))),
    S.data && S.tools.has('wrd.demo_advance_clock') ? h('span', { class: 'env-banner__field' }, 'Demo time: ', h('code', { text: S.demoNow ? when(S.demoNow) : 'scripted' }), weeks,
      btn('Skip ahead', { size: 'sm', on: async () => {
        const out = await send('wrd.demo_advance_clock', { weeks: Number(weeks.value) });
        if (out) { S.demoNow = out.now; render(); }
      } })) : null);
}

function appHeader() {
  const d = data();
  const me = actor();
  const signedIn = (S.mode === 'interego' && S.interego) || (S.mode === 'demo' && me) || (S.mode === 'wallet' && S.account);
  return h('header', { class: 'app-header' }, h('div', { class: 'app-header__inner' },
    brandLink(),
    d.podUrl ? h('span', { class: 'workspace-name', title: d.podUrl, text: workspaceLabel(d.podUrl) }) : null,
    h('div', { class: 'app-header__actions' },
      S.data && allDemo() ? badge('Sample data', 'demo') : null,
      S.data ? btn('Refresh', { variant: 'ghost', size: 'sm', on: () => refresh() }) : null,
      productSwitch(),
      signedIn ? accountMenu() : null,
      !signedIn && S.mode === 'wallet' ? btn('Connect wallet', { size: 'sm', on: connectWallet }) : null,
      !signedIn && S.data ? signInButton('sm') : null)));
}

/** Who you are, how your actions are signed, and the way out; the exact identity strings stay in Technical details. */
function accountMenu() {
  const me = actor();
  const m = member(me);
  const name = displayName(me) || 'Your account';
  const rs = [...(m?.roles ?? []), ...(isAdmin() ? ['admin'] : [])];
  const s = sibling();
  const idLabel = S.mode === 'interego' ? 'Your Interego ID' : S.mode === 'wallet' ? 'Your wallet address' : 'Your signing address';
  const avatar = initials(displayName(me));
  const item = (label, ic, on, extra = {}) => h('button', { type: 'button', class: `menu__item${extra.danger ? ' menu__item--danger' : ''}`, on: { click: on } }, icon(ic), label);
  const link = (label, ic, href, blank) => h('a', { class: 'menu__item', href, target: blank ? '_blank' : undefined, rel: blank ? 'noopener' : undefined }, icon(ic), label);
  return [
    h('button', { type: 'button', class: 'user-button', popovertarget: 'account-menu', 'aria-haspopup': 'menu', 'aria-label': `Account: ${name}` },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, avatar || icon('user', 'sm')), h('span', { class: 'user-button__name', text: name }), icon('chevron-down', 'sm')),
    h('div', { class: 'menu', id: 'account-menu', popover: 'auto' },
      h('div', { class: 'menu__header' }, h('strong', { text: name }), h('span', { class: 'text-sm text-tertiary', text: rs.length ? rolesPlain(rs).join(' · ') : 'Not in this workspace yet' })),
      h('p', { class: 'menu__note' }, badge(S.mode === 'interego' ? 'Signed via Interego' : S.mode === 'wallet' ? 'Signed with your wallet' : 'Demo person', S.mode === 'demo' ? 'demo' : 'accent')),
      me ? h('div', { class: 'menu__id' }, h('span', { class: 'text-tertiary', text: idLabel }), h('code', { text: S.mode === 'interego' ? userIdOf(me) : short(me) }),
        btn('Copy ID', { variant: 'ghost', size: 'sm', on: () => copyText(me, idLabel) })) : null,
      item('Go to my record', 'user', () => goTab('me')),
      link('Help', 'info', '/ui/help', true),
      item('Open another workspace', 'external', () => openPanel('Open another workspace', podPicker())),
      link(`Also from Interego: ${s.name}`, 'arrow-right', s.url, false),
      techDetails('Technical details',
        S.mode === 'interego' && S.interego
          ? (S.interego.principal ? h('p', null, 'Signed in as ', h('code', { text: S.interego.principal }), ' via ', h('code', { text: S.interego.agentId })) : 'Signed in. We\'ll show your ID after your first action.')
          : null,
        me ? h('p', null, S.mode === 'interego' ? 'Your Interego user DID ' : 'Acting address ', h('code', { text: me })) : null,
        S.mode === 'interego' ? 'relay-attested, not a key you hold' : null,
        m ? h('p', null, `roles ${m.roles.join(', ')}`, m.personRef ? [' · person ', h('code', { text: m.personRef })] : null, m.principal ? ` · principal ${labelOf(m.principal)}` : null) : null,
        me && !m ? (S.persona === 'admin' || isAdmin() ? 'admin key (signs registry changes only)' : 'not in this pod\'s registry') : null),
      S.mode === 'interego' ? [h('hr', { class: 'menu__sep' }), item('Sign out', 'sign-in', signOut, { danger: true })] : null),
  ];
}

/** The views' counts: what waits for this person in each. Drawn by CSS from data-count, so a button's text never changes. */
function navCounts() {
  const c = {};
  for (const w of waitingItems()) c[w.tab] = (c[w.tab] ?? 0) + 1;
  return c;
}
function sideNav() {
  const taskIri = taskFromHash();
  const counts = navCounts();
  const link = ([id, label, ic]) => h('button', {
    type: 'button', class: 'side-nav__link', 'aria-current': !taskIri && S.tab === id ? 'page' : undefined, 'data-count': counts[id] > 0 ? String(counts[id]) : undefined,
    on: { click: () => goTab(id) },
  }, icon(ic), label);
  return h('nav', { class: 'side-nav', 'aria-label': 'Work Redesign' },
    NAV.map(([group, items]) => h('div', { class: 'side-nav__group' }, group ? h('span', { class: 'side-nav__label', text: group }) : null, items.map(link))),
    h('div', { class: 'side-nav__footer' }, h('a', { class: 'side-nav__link', href: '/ui/help', target: '_blank', rel: 'noopener' }, icon('info'), 'Help')));
}

/** Integrity notices, for every signed-in viewer: what failed, in a calm callout; the exact sentences collapsed. */
function health() {
  const d = data();
  const platform = d.bridge?.platform ?? {};
  const altered = (d.altered ?? []).length;
  const forked = (d.forked ?? []).length;
  const untrusted = (d.untrusted ?? []).length;
  // Every graph whose line is cut, whatever its kind (a bridge that reports chainCuts), else the decisions and grants that say so.
  const cuts = Array.isArray(d.chainCuts) ? d.chainCuts.length : [...(d.decisions ?? []), ...(d.grants ?? [])].filter((x) => x.chainUnreadable).length;
  const byKey = (d.chainCuts ?? []).filter((c) => c.untrustedKey);
  const items = [
    altered + forked + untrusted > 0 ? ['warning', `${altered} graph(s) altered after signing, ${forked} forked, ${untrusted} descriptor(s) set aside as untrusted. Altered or forked records are never used as a current version.`] : null,
    cuts > 0 ? ['danger', chainCuts(cuts)] : null,
    byKey.length > 0 ? ['danger', trustCuts(byKey.length, [...new Set(byKey.map((c) => c.untrustedKey))])] : null,
    (d.sealed ?? []).length > 0 ? ['danger', `${d.sealed.length} record(s) are sealed and this bridge cannot open them. ${d.sealedNote ?? ''}`] : null,
    d.recordKeyMismatch ? ['danger', `Another record key: ${d.recordKeyMismatch.why}`] : null,
    d.plaintext ? ['warning', `${d.plaintext.versions} record version(s) written before the record key are plaintext on the pod. ${d.plaintext.why}`] : null,
    d.unreadable ? ['danger', `Marked, not worked out without them, because records they depend on cannot be read: ${Object.keys(d.unreadable).join(', ')}.`] : null,
    platform.keyKind === 'ephemeral' ? ['warning', EPHEMERAL] : null,
  ].filter(Boolean);
  if (items.length === 0) return null;
  const danger = items.some(([t]) => t === 'danger');
  const ic = icon('warning');
  ic.classList.add('callout__icon');
  return h('section', { class: `callout callout--${danger ? 'danger' : 'warning'} health`, 'aria-labelledby': 'health-title' }, ic,
    h('p', { class: 'callout__title', id: 'health-title', text: danger ? 'Some records in this workspace failed an integrity check' : 'Notices about this workspace' }),
    h('p', { class: 'callout__body', text: `${danger ? 'They\'re shown as incomplete and are never used as a current version. Your admin or workspace provider should look into it.' : 'Nothing is wrong with your own work. Your admin or workspace provider may want to look at these.'}${isAdmin() ? ' Send the details below to your workspace provider.' : ''}` }),
    h('details', { class: 'disclosure' }, h('summary', { text: `What we found (${items.length})` }),
      h('div', { class: 'disclosure__body health__items' }, items.map(([tone, text]) => h('p', { class: `health__item health__item--${tone}`, text })))));
}

/** How actions are signed, who can read, and every protocol fact about this workspace, one click away. */
function appFooter() {
  const d = data();
  const platform = d.bridge?.platform ?? {};
  const closed = d.bridge?.reads === 'signed';
  return h('footer', { class: 'app-footer' },
    S.mode === 'interego' && S.interego ? [
      h('p', { class: 'app-footer__signin' }, icon('shield', 'sm'), 'Signed via your Interego account. Interego signs each action for you, and your records say so. While you\'re signed in, your sign-in can also act on your Interego account for up to a day, even after you sign out here.'),
      h('details', { class: 'disclosure' }, h('summary', { text: 'How Interego sign-in works' }), h('div', { class: 'disclosure__body' }, h('p', { text: S.signIn?.trust ?? RELAY_TRUST }))),
    ] : null,
    S.data ? h('p', { class: 'app-footer__exposure', text: closed ? 'Only people added to this workspace can see its records.' : 'This workspace is open: anyone with the link can see its records.' }) : null,
    S.data || S.mode !== 'demo' ? techDetails('Technical details',
      S.data ? kv([
        ['Workspace storage', h('code', { text: d.podUrl })],
        ['Platform signer', [h('code', { text: platform.address, title: platform.did }), ' ', badge(platform.keyKind ?? 'unknown'),
          platform.keyKind === 'ephemeral' ? [' ', EPHEMERAL] : null, platform.keyKind === 'demo' ? [' ', DEMO_KEY] : null]],
        ['Who can read it', d.readExposure],
        d.demoRecords > 0 ? ['Sample data', [`${d.demoRecords} of ${d.records} records here are ${d.demoLabel}.`, S.mode === 'demo' ? ` ${DEMO_BANNER}` : '']] : null,
        ['Records', `${d.records} record versions read`],
      ]) : null,
      S.mode === 'wallet' ? READ_SIGNING : S.mode === 'interego' ? READ_RELAYED : null) : null,
    h('p', { class: 'app-footer__links' }, h('a', { href: '/ui/help', target: '_blank', rel: 'noopener', text: 'Help' }), ' · ', h('a', { href: '/', text: 'About Work Redesign' }), ' · ',
      h('a', { href: '/affordances', text: 'For developers: agent manifest' })));
}

const signInButton = (size = '') => (S.signIn?.enabled ? btn(SIGN_IN, { variant: 'primary', size, on: startSignIn, icon: size === 'lg' ? 'sign-in' : '', cls: size === 'lg' ? 'btn--block' : '' }) : null);

/** Open another workspace: the choice lives in the page address (?pod=), not in storage. */
function podPicker() {
  const box = input(S.pod, null, { placeholder: 'https://…/your-team/' });
  return h('div', { class: 'stack stack--sm' }, field('Workspace address', box, { hint: 'Paste the address of a different Work Redesign workspace. Leave it blank for this one.' }),
    h('div', null, btn('Open workspace', { on: () => {
      S.pod = box.value.trim();
      const q = new URLSearchParams(location.search);
      if (S.pod) q.set('pod', S.pod); else q.delete('pod');
      history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`);
      S.result = null;
      S.panel = null;
      refresh();
    } })));
}

/** Screen 1: the manifest could not be read. Nothing else is asked of the bridge. */
function unreachableView() {
  return [h('main', { class: 'auth', id: 'main' }, h('div', { class: 'auth__card' }, brandMark(),
    h('h1', { class: 'auth__title', text: 'We can\'t reach this workspace right now' }),
    h('p', { class: 'auth__text', text: 'Please try again in a minute. If it keeps happening, contact your admin.' }),
    h('div', { class: 'auth__actions' }, btn('Try again', { variant: 'primary', on: () => location.reload() })),
    techDetails('Technical details', `The affordance manifest could not be read: ${S.bootError}`)))];
}

/** The sign-in result, the unsigned read's refusal, or another refusal folded into the welcome's Technical details. */
const isExpectedSignedOutRead = (r) => r && !r.pending && r.tool === 'wrd.list_records' && r.status === 401;
const isReadRefusal = (r) => r && !r.pending && !r.ok && (r.tool === 'wrd.read_records' || r.tool === 'wrd.list_records') && (r.status === 401 || r.status === 403);

/** Screen 3: signed out (or the sign-in did not finish): what this is, what you can do here, and one way in. */
function welcomeView() {
  const r = S.result;
  const namedYet = S.mode === 'interego' && S.interego;
  const enabled = Boolean(S.signIn?.enabled);
  const busy = Boolean(S.signIn?.busy);
  const wallet = Boolean(window.ethereum);
  const linkTask = /^#task=/.test(location.hash);
  const header = h('header', { class: 'app-header' }, h('div', { class: 'app-header__inner' }, brandLink(), h('div', { class: 'app-header__actions' }, productSwitch(), namedYet ? accountMenu() : null)));
  const ways = namedYet ? [btn('Sign out', { on: signOut })]
    : [
      enabled ? [signInButton('lg'), h('p', { class: 'text-sm text-secondary' }, 'New to Interego? ', h('a', { href: identityUrl(), text: 'Create your account' }), ': it takes two minutes with a passkey. No password.')] : null,
      !enabled && busy ? callout({ tone: 'warning', title: 'Sign-in is busy right now', body: `${SIGN_IN_BUSY} ${S.signIn.why}` }) : null,
      !enabled && !busy ? callout({ tone: 'neutral', title: 'Signing in isn\'t set up on this workspace yet', body: 'Contact your workspace provider.' }) : null,
      wallet ? h('details', { class: 'disclosure', open: !enabled ? true : undefined }, h('summary', { text: 'Other ways to sign in' }),
        h('div', { class: 'disclosure__body stack stack--sm' }, h('p', { text: 'Use a crypto wallet that supports message signing. Your admin adds your wallet address to this workspace.' }),
          h('div', null, btn('Connect wallet', { on: connectWallet })), h('ol', null, WALLET_STEPS.map((s) => h('li', { text: s }))))) : null,
    ];
  return [
    header,
    h('main', { class: 'auth', id: 'main' }, h('div', null,
      h('div', { class: 'auth__card auth__card--welcome' },
        brandMark(),
        h('h1', { class: 'auth__title', text: 'Welcome to Work Redesign' }),
        h('p', { class: 'auth__text', text: 'Decide, with your team, which work to hand to AI, and keep a signed record of every decision.' }),
        linkTask ? callout({ tone: 'info', title: 'You were sent a link to a task', body: 'Sign in and we\'ll open it for you.' }) : null,
        r && !r.pending && !isExpectedSignedOutRead(r) ? resultNode() : null,
        h('p', { class: 'welcome__lead', text: 'Here you can:' }),
        h('ul', { class: 'check-list welcome__list' }, [
          'See how your team\'s processes are mapped, and confirm or dispute how your own work is described',
          'Respond to plans that change your work',
          'Propose, price and approve changes, depending on your role',
          'Download a signed copy of every record about you',
        ].map((t) => h('li', null, icon('check'), h('span', { text: t })))),
        h('div', { class: 'auth__actions' }, ways),
        h('p', { class: 'auth__fine', text: 'Only people added to this workspace can see its records. Signing in with Interego means Interego signs your actions on your behalf, and your records will say so.' }),
        h('div', { class: 'welcome__more' },
          disclosure('Learn more about signing in', h('p', { text: TRUST_PLAIN })),
          disclosure('Open a different workspace', podPicker()),
          techDetails('Technical details',
            enabled && !wallet ? NOT_SIGNED_IN : wallet ? READ_SIGNING : READ_ONLY,
            !enabled && S.signIn?.why ? S.signIn.why : null,
            isExpectedSignedOutRead(r) ? refusalTech(r) : null))),
      h('p', { class: 'welcome__links' }, h('a', { href: '/ui/help', text: 'How Work Redesign works' }), ' · ', h('a', { href: '/', text: 'About Work Redesign' })))),
  ];
}

/** Screen 2: signed in, but this workspace has not added you yet. Your copy is still yours to take. */
function notAddedView() {
  const me = actor();
  const r = S.result;
  const readRefusal = isReadRefusal(r);
  const demo = S.mode === 'demo';
  const what = S.mode === 'interego' ? 'Interego ID' : 'wallet address';
  const message = `Hi, please add me to our Work Redesign workspace. My ${what} is ${me}.`;
  const header = h('header', { class: 'app-header' }, h('div', { class: 'app-header__inner' }, brandLink(), h('div', { class: 'app-header__actions' }, productSwitch(), accountMenu())));
  return [
    envBanner(),
    header,
    h('main', { class: 'auth', id: 'main' }, h('div', { class: 'auth__card auth__card--wide' },
      brandMark(),
      h('h1', { class: 'auth__title', text: 'You\'re signed in. One more step.' }),
      r && !readRefusal ? resultNode() : null,
      demo ? h('p', { class: 'auth__text', text: 'This person isn\'t in this workspace yet. Choose someone else under View as, or download their record below.' })
        : [h('p', { class: 'auth__text', text: `Your admin needs to add you to this workspace before you can see anything here. Send them your ${what}:` }),
          h('div', { class: 'input-group not-added__id' }, h('input', { class: 'input input--mono', readOnly: true, value: me, 'aria-label': `Your ${what}` }), btn('Copy ID', { on: () => copyText(me, `Your ${what}`) })),
          h('div', null, btn('Copy a message to send', { variant: 'ghost', icon: 'chat', on: () => copyText(message, 'A message for your admin') }))],
      h('section', { class: 'card not-added__record', 'aria-labelledby': 'holder-title' }, h('div', { class: 'card__body' },
        h('h2', { class: 'card__title', id: 'holder-title', text: 'My record' }),
        h('p', { class: 'text-secondary', text: 'Already named in records here? You can still download a signed copy of every record about your work, even if you\'re not in this workspace.' }),
        holderCard(null))),
      techDetails('Technical details',
        readRefusal ? refusalTech(r) : null,
        h('p', null, SEND_TO_ADMIN, ' ', h('code', { text: me })),
        HOLDER_WITHOUT_READ,
        demo ? DEMO_BANNER : null),
      appFooter())),
  ];
}

/** A form opened over the view (it stays until closed or its action succeeds). */
function panelNode() {
  if (!S.panel) return null;
  return h('section', { class: 'card card--highlight panel', 'aria-labelledby': 'panel-title' },
    h('div', { class: 'card__header' }, h('h2', { class: 'card__title', id: 'panel-title', tabindex: '-1', text: S.panel.title }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Close', on: { click: () => { S.panel = null; render(); } } }, icon('close', 'sm'))),
    h('div', { class: 'card__body' }, S.panel.node));
}
function openPanel(title, node) { S.panel = { title, node, focus: true }; render(); window.scrollTo({ top: 0 }); }

function goTab(id) {
  S.tab = id;
  S.panel = null;
  if (taskFromHash()) history.replaceState(null, '', `${location.pathname}${location.search}`);
  render();
  window.scrollTo({ top: 0 });
  if (id === 'calibration') refresh();
}

function view() {
  switch (S.tab) {
    case 'tasks': return tasksView();
    case 'roles': return rolesView();
    case 'capture': return captureView();
    case 'plan': return planView();
    case 'value': return valueView();
    case 'decisions': return decisionsView();
    case 'calibration': return calibrationView();
    case 'agents': return agentsView();
    case 'me': return meView();
    case 'home': return homeView();
    default: return homeView();
  }
}

/** Copy to the clipboard and say so; where the browser will not, show the text to copy by hand. */
async function copyText(s, what = 'Copied to your clipboard') {
  try { await navigator.clipboard.writeText(s); toast('Copied', what); }
  catch { openPanel('Copy this', h('textarea', { value: s, readOnly: true, class: 'textarea textarea--tall' })); }
}

// ── Results, refusals and errors ──────────────────────────────────────────────────────────

/** What happened, in plain words, after a write the bridge took. */
function plainSummary(tool, b) {
  if (tool === SIGN_IN_TOOL) return 'This tab no longer holds your sign-in. It isn\'t cancelled at Interego: it stays valid for up to an hour, and can act on your account for up to a day. To end it everywhere, use "Sign out everywhere" on your Interego dashboard.';
  switch (tool) {
    case 'wrd.update_registry': return 'The change is signed and saved.';
    case 'wrd.capture_workflow': case 'wrd.record_task_map': return [h('p', { text: `${plural((b.tasks ?? []).length, 'task')} recorded. Send each person named on a task their link so they can confirm it.` }), captureResultNode(b)];
    case 'wrd.revise_task': return 'Everyone named on it needs to confirm it again.';
    case 'wrd.ratify_task': return 'Thank you. Your response is signed, and you can download it with your record.';
    case 'wrd.classify_task': return `${taskName(b.taskIri)} is ${REGIME_NAMES[b.regime] ?? b.regime}: ${METHOD_NAMES[b.method] ?? b.method}.`;
    case 'wrd.propose_allocation': return `A ${(PLAN_KIND[b.planKind] ?? 'plan').toLowerCase()} changing ${plural((b.changedTasks ?? []).length, 'task')}. The people it names will see it under Plans and can accept or object.`;
    case 'wrd.value_plan': return b.reused ? 'These exact inputs were priced before, so the existing business case is shown.' : 'See the results below.';
    case 'wrd.submit_decision': return b.prediction ? `Likely ${metricName(b.prediction.metric).toLowerCase()} ${num(b.prediction.band?.p50, 0)} per week (${band(b.prediction.band, (n) => num(n, 0))}). It now waits for an independent approver.` : 'A trial decision. It now waits for an independent approver.';
    case 'wrd.countersign_decision': return b.verdict === 'decline' || /declin/i.test(String(b.statusLabel ?? '')) ? 'Declined.' : 'Approved. Results are due when the measurement period ends.';
    case 'wrd.record_outcome': return b.valued ? `Measured ${num(b.valued.measured?.weeklyValueDelta ?? b.valued.measured, 0)} a week: ${(VERDICT_NAMES[b.valued.verdict] ?? [b.valued.verdict])[0].toLowerCase()}.` : 'Trial results recorded.';
    case 'wrd.log_agent_run': return 'It counts toward the agent\'s track record once a person has reviewed it.';
    case 'wrd.grant_autonomy': return b.evaluation?.earned ? `Permission granted on ${kindLabel(b.taskKind ?? b.evaluation?.taskKind ?? '') || 'this type of task'}.` : `Not earned yet: ${plainGrantReason(b.evaluation)}.`;
    case 'wrd.revoke_grant': return 'Every later use is refused. Re-earning counts only work reviewed from now on.';
    case 'wrd.holder_copy': return b.status === 'copied'
      ? `${(b.copied ?? []).filter((c) => !c.skipped).length} new item(s) copied, ${(b.copied ?? []).filter((c) => c.skipped).length} were already there.`
      : [h('p', { text: `${plural((b.bundle ?? []).length, 'item')}. Each keeps its original signature. Your IT team can verify it offline against this workspace's signature ID: ${b.platform?.address ?? 'not reported'}.` }), hint('Your downloaded copy isn\'t encrypted. Store it somewhere safe.')];
    case 'wrd.demo_advance_clock': return `Demo time is now ${when(b.now)}.`;
    default: return '';
  }
}
const doneTitle = (tool, b) => (tool === SIGN_IN_TOOL ? 'You\'re signed out' : tool === 'wrd.holder_copy' ? (b.status === 'copied' ? 'Copied to your storage' : 'Your record is downloading') : DONE_TITLES[tool] ?? 'Done');
/** Why an agent has not earned permission yet, in plain words. */
function plainGrantReason(e) {
  if (!e) return 'its reviewed work doesn\'t meet the bar yet';
  const gp = data().vocabulary?.grantPolicy ?? {};
  const parts = [];
  if (gp.minSamples && e.samples < gp.minSamples) parts.push(`${e.samples} of ${gp.minSamples} pieces of work reviewed`);
  if (gp.floor && e.acceptedShare < gp.floor) parts.push(`${pct(e.acceptedShare)} accepted, below ${pct(gp.floor)}`);
  if (gp.minDistinctConfirmers && e.distinctConfirmers < gp.minDistinctConfirmers) parts.push(`${e.distinctConfirmers} of ${gp.minDistinctConfirmers} different reviewers`);
  return parts.length ? parts.join('; ') : 'its reviewed work doesn\'t meet the bar yet';
}

/** The bridge's answer as it said it (kept word for word in Technical details). */
function summaryOf(tool, b) {
  if (tool === SIGN_IN_TOOL && b.note) return h('p', { text: b.note });
  if (tool === 'wrd.classify_task') {
    return h('p', null, `${b.regime} — method ${b.method}; source ${b.regimeSource}; answered as ${b.answeredBy?.role}. Rules fired: `,
      (b.rulesFired ?? []).map((iri) => [badge(ruleLabel(iri)), ' ']), (b.notes ?? []).map((n) => h('div', { text: n })));
  }
  if (tool === 'wrd.record_task_map' || tool === 'wrd.capture_workflow') return h('p', { text: (b.tasks ?? []).map((t) => `${t.name}: quotes ${t.quoteStatus}`).join('; ') });
  if (tool === 'wrd.propose_allocation') return h('p', { text: `A ${b.planKind} plan changing ${(b.changedTasks ?? []).length} task(s). People it names see "named by the operator, not acknowledged" until they acknowledge.` });
  if (tool === 'wrd.value_plan') return h('p', { text: `${b.reused ? 'The same plan and inputs were valued before: the existing record is returned. ' : ''}Valuation hash ${short(b.valuationHash)}; see the Value view for the full result.` });
  if (tool === 'wrd.submit_decision' && b.prediction) return h('p', { text: `Predicted ${b.prediction.metric}: ${band(b.prediction.band, (n) => num(n, 0))} per week. Hypothetical until an approver countersigns.` });
  if (tool === 'wrd.countersign_decision') return h('p', { text: b.statusLabel });
  if (tool === 'wrd.record_outcome' && b.valued) {
    return h('p', null, badge(b.valued.verdict, b.valued.verdict === 'in-band' ? 'success' : 'warning'),
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

/** The roles a refusal names, in a sentence a person can act on. */
function roleSentence(error) {
  const e = String(error ?? '');
  if (/approver can/.test(e)) return 'Only approvers can do this.';
  if (/operator or approver/.test(e)) return 'Only process leads and approvers can do this.';
  if (/operator or agent can capture/.test(e)) return 'Only process leads can map a process.';
  if (/admin can/.test(e)) return 'Only an admin can change people and roles.';
  if (/named on this task/.test(e)) return 'Only the people named on this task can respond.';
  if (/plan names/.test(e)) return 'Only the person this plan names can respond to it.';
  if (/software agent can log/.test(e)) return 'Only a registered AI agent can record its own work.';
  return 'Your role doesn\'t allow this action.';
}

const SIGN_IN_ERRORS = [
  [NOT_STARTED_HERE, 'info', 'This sign-in didn\'t start in this tab', 'So we ignored it, and nothing was exchanged. Please sign in again.'],
  ['The Interego relay did not sign you in.', 'warning', 'Interego didn\'t sign you in', 'You can try again.'],
  ['Sign-in was not finished, and nothing was exchanged.', 'warning', 'Sign-in wasn\'t finished', 'It took longer than ten minutes, or the answer was incomplete. Please sign in again.'],
  ['Signed in, but this tab cannot keep the access token.', 'warning', 'Your browser is blocking sign-in', 'Allow this site to store data for this tab, then sign in again.'],
  ['This browser cannot start the sign-in here.', 'warning', 'This browser can\'t start sign-in', 'Open Work Redesign over https in an up-to-date browser.'],
  ['This browser keeps nothing for this tab', 'warning', 'Your browser is blocking sign-in', 'Allow this site to store data for this tab, then sign in again.'],
  ['Signing in with an Interego account is not available on this bridge.', 'neutral', 'Signing in isn\'t set up on this workspace yet', 'Contact your workspace provider.'],
];
const CLIENT_ERRORS = [
  ['This bridge does not declare ', 'This action isn\'t available on this workspace', 'Your workspace provider may have turned it off.'],
  ['The read was not signed.', 'Signing didn\'t finish', 'Nothing was sent. Please try again.'],
  ['Signing did not complete.', 'Signing didn\'t finish', 'Nothing was sent. Please try again.'],
  ['The wallet did not connect.', 'Your wallet didn\'t connect', 'Open your wallet, approve the connection, and try again.'],
  ['The draft is not JSON.', 'That draft isn\'t in the expected format', 'Paste the whole answer your AI gave you, exactly as it gave it.'],
  ['The document could not be hashed in this browser.', 'This browser can\'t check the document', 'Open Work Redesign over https in an up-to-date browser.'],
  ['Probe changes and valued changes go in separate plans.', 'Put trials and priced changes in separate plans', 'Exploratory tasks change through trials, which are never priced. Propose them in their own plan.'],
  ['The run envelope is not JSON.', 'That work record isn\'t in the expected format', 'Paste the signed work record exactly as the AI agent produced it.'],
  ['The bridge named another agent than the relay signed for.', 'We couldn\'t confirm who signed', 'Please sign out and sign in again.'],
];
const STATUS_TITLES = { 400: 'Something in this form isn\'t right', 401: 'Please sign in', 403: 'Your role doesn\'t include this', 404: 'We couldn\'t find that', 409: 'This can\'t be done yet', 422: 'Something didn\'t check out', 429: 'Busy right now' };

/**
 * A refusal in plain words: { tone, title, body, action }. The bridge's own words stay in Technical
 * details (refusalTech). First match wins: (status, code, error), then errors this page made, then
 * the status alone.
 */
function friendly(r) {
  const b = r?.body ?? {};
  const s = Number(r?.status ?? 0);
  const e = String(b.error ?? '');
  const code = b.code;
  const go = (label, tab) => btn(label, { size: 'sm', on: () => goTab(tab) });
  const fx = (tone, title, body, action = null) => ({ tone, title, body, action });
  const busy = () => fx('warning', 'Busy right now', `Please wait ${b.retryAfterSeconds ?? 60} seconds and try again.`);
  const unreachable = () => fx('danger', 'We can\'t reach Work Redesign right now', 'Check your connection and try again in a minute.', btn('Try again', { size: 'sm', on: () => refresh() }));
  if (code === 'interego-sign-in-expired' || code === 'interego-sign-in-refused' || e === SIGN_IN_ENDED) {
    return fx('warning', 'Your sign-in has ended', 'For your security, sign-ins last about an hour. Sign in again to continue. Your drafts in Map a process and Business case are kept in this browser.', signInButton('sm'));
  }
  if (r?.tool === SIGN_IN_TOOL) {
    const hit = SIGN_IN_ERRORS.find(([text]) => e.startsWith(text));
    if (hit) return fx(hit[1], hit[2], hit[3], hit[1] === 'neutral' ? null : signInButton('sm'));
    if (s === 429 || code === 'relay-calls-limited' || code === 'relay-busy') return busy();
    if (e === 'The bridge named another agent than the relay signed for.') return fx('warning', 'We couldn\'t confirm who signed', 'Please sign out and sign in again.');
    if (s === 0 && /could not be reached/.test(e)) return unreachable();
    return fx('warning', 'Sign-in didn\'t complete', 'Please try again.', signInButton('sm'));
  }
  if (/needs a signed read|Nothing to sign with/.test(e) && (s === 401 || s === 0)) {
    return fx('info', 'Please sign in', 'Sign in to see this workspace.', S.mode === 'wallet' && !S.account ? btn('Connect wallet', { size: 'sm', on: connectWallet }) : signInButton('sm'));
  }
  if (s === 403 && /Only an admin or a key in this pod|not in (this pod's )?registry/.test(e)) {
    const me = actor();
    const what = S.mode === 'wallet' ? 'wallet address' : 'Interego ID';
    return fx('warning', 'You haven\'t been added to this workspace yet', 'Send your Interego ID to your admin; they\'ll add you. You can still download any records about you.',
      me && (S.mode === 'interego' || S.mode === 'wallet') ? btn(`Copy my ${what}`, { size: 'sm', on: () => copyText(me, `Your ${what}`) }) : null);
  }
  if (s === 403 && /a chat agent signed it/.test(e)) return fx('info', 'Please do this in the Work Redesign app', 'For safety, approvals, role changes, results and AI permissions can\'t be done from a chat assistant.');
  if (s === 409 && /changed since (you read|it was read)/.test(e)) return fx('info', 'Someone updated this a moment ago', 'We\'ve refreshed it. Check the latest version, then try again.');
  if (s === 409 && /Classify every task before proposing/.test(e)) {
    const wf = currentWorkflow();
    const rows = wf ? wf.taskIris.map(taskBy).filter(Boolean) : [];
    const sorted = rows.filter((t) => t.classification?.state === 'ok').length;
    return fx('warning', 'Sort every task first', `A plan needs every task in this process sorted by predictability. ${sorted} of ${rows.length} are done.`, go('Go to Processes', 'tasks'));
  }
  if (s === 409 && /must be ratified by everyone named|disputed task description blocks|disputed classification blocks|ratified how knowable|disputes its classification/.test(e)) {
    return fx('warning', 'Waiting on the team', 'Everyone named on a changed task needs to confirm its description (and, before AI is assigned, its predictability). Someone hasn\'t yet, or disputes it.', go('Go to Processes', 'tasks'));
  }
  if (s === 403 && /cannot countersign|cannot grade|accountable for this agent cannot|cannot review its own run/.test(e)) {
    return fx('info', 'Someone else needs to do this', 'To keep approvals independent, you can\'t approve (or record results for) a decision you helped prepare, one that changes your own work, or one that uses an AI agent you own, and owners can\'t review or grant permission to their own agents. Ask another approver.');
  }
  if (s === 409 && /has not acknowledged their assignment|objects to their assignment|unacknowledgedConsidered|objectionsConsidered/.test(e)) {
    return fx('warning', 'Some people haven\'t agreed to their new assignment', 'Someone named in this plan hasn\'t responded, or has objected. Ask them to respond, or approve anyway by ticking that you\'ve considered it.', go('Go to Plans', 'plan'));
  }
  if (s === 422 && /None of the quoted spans/.test(e)) {
    return fx('warning', 'We couldn\'t find the AI\'s quotes in your document', 'None of the quotes in this draft match the document. Make sure you pasted the same document you gave your AI, or ask it to quote exactly.', go('Back to the draft', 'capture'));
  }
  if (s === 409 && /already used/.test(e)) return fx('info', 'Already done', 'This was already sent, so we didn\'t record it twice.');
  if (s === 401 && /stale or from the future/.test(e)) return fx('warning', 'That took a little too long', 'For security, actions must be sent within 15 minutes. Please try again.');
  if (s === 400 && /payload is malformed|not well-formed/.test(e)) return fx('warning', 'Something in this form isn\'t right', 'Please check the fields and try again.');
  if (s === 400 && /^Say why/.test(e)) return fx('warning', 'Please add a reason', 'A dispute or objection needs a short note so the team knows what to fix.');
  if (s === 400 && /No evidence places this task/.test(e)) return fx('warning', 'These answers don\'t fit a category yet', 'Replace some "Unknown" answers, or run a small trial to find out. We never guess a category.');
  if (s === 409 && /propose again|stale/.test(e)) return fx('warning', 'This plan is out of date', 'A task changed after the plan was made. Make a new plan from the current tasks.', go('Go to Plans', 'plan'));
  if (s === 409 && /has not earned a grant/.test(e)) return fx('info', 'Not earned yet', 'This agent\'s reviewed work doesn\'t meet the bar yet. See its progress under Track record.', go('Go to Track record', 'calibration'));
  if (s === 429 || code === 'relay-calls-limited' || code === 'relay-busy' || /Too many copies/.test(e)) return busy();
  if (s === 403 && /^Only (a registered|the person this plan names|a person or agent named|an admin can)|Grants are for registered software agents/.test(e)) {
    return fx('info', 'Your role doesn\'t include this', `${roleSentence(e)} Ask your admin if your role should change.`);
  }
  if (s === 409 && /This task was retired/.test(e)) return fx('info', 'This task was retired', 'It\'s no longer part of the process. Open the process to see the current tasks.', go('Go to Processes', 'tasks'));
  if (s === 404 && /^No such /.test(e)) return fx('info', 'We couldn\'t find that', 'It may have been changed or removed. We\'ve refreshed the workspace.');
  if (s === 0 && /could not be reached/.test(e)) return unreachable();
  if (s >= 500 || /^The pod /.test(e)) return fx('danger', 'Something went wrong saving this', 'Nothing was saved. Please try again. If it keeps happening, contact your workspace provider.');
  if (s === 0) {
    const hit = CLIENT_ERRORS.find(([text]) => e.startsWith(text));
    if (hit) return fx('warning', hit[1], hit[2]);
    return unreachable();
  }
  const fix = b['iep:resolvedBy']?.toolName;
  const tab = fix ? TAB_OF[fix] : '';
  return fx(s === 401 ? 'info' : 'warning', STATUS_TITLES[s] ?? 'Something didn\'t work', 'See Technical details for what happened.', tab ? go(`Go to ${TITLES[tab]}`, tab) : null);
}

/** The bridge's refusal word for word: status and tool, its error, why, and the whole answer. */
function refusalTech(r) {
  const b = r.body ?? {};
  const title = S.tools.get(r.tool)?.title;
  const fix = b['iep:resolvedBy'];
  return [
    h('p', { text: `${r.status ? `HTTP ${r.status}` : 'No answer from the server'} · ${r.tool}${title && title !== r.tool ? ` (${title})` : ''}` }),
    b.error ? h('p', { text: b.error }) : null,
    b['iep:refusalReason'] ? h('p', { text: `Why: ${b['iep:refusalReason']}` }) : null,
    b.evaluation ? evaluationNode(b.evaluation) : null,
    b.expectedPayload ? h('details', { class: 'disclosure' }, h('summary', { text: 'The payload this tool expects (JSON Schema)' }), h('pre', { text: JSON.stringify(b.expectedPayload, null, 2) })) : null,
    fix?.toolName ? h('p', { text: `What resolves it: ${S.tools.get(fix.toolName)?.title ?? fix.toolName}` }) : null,
    h('details', { class: 'disclosure' }, h('summary', { text: 'The full answer' }), h('pre', { text: JSON.stringify(b, null, 2) })),
  ];
}

/** The answer to the last action: signing and sending, done (in plain words), or refused (friendly, the bridge's words collapsed). */
function resultNode() {
  const r = S.result;
  if (!r) return null;
  const dismiss = () => { S.result = null; render(); };
  if (r.pending) {
    return h('div', { class: 'callout callout--neutral result', role: 'status' }, h('span', { class: 'spinner callout__icon', 'aria-hidden': 'true' }),
      h('p', { class: 'callout__title', text: `Signing and sending: ${ACTION_NAMES[r.tool] ?? 'your action'}…` }));
  }
  const b = r.body ?? {};
  if (r.ok) {
    const body = plainSummary(r.tool, b);
    return h('div', { class: 'result', role: 'status' }, callout({ tone: 'success', title: doneTitle(r.tool, b), body: body || null, onClose: dismiss,
      tech: techDetails('Technical details', summaryOf(r.tool, b), h('details', { class: 'disclosure' }, h('summary', { text: 'The full answer' }), h('pre', { text: JSON.stringify(b, null, 2) }))) }));
  }
  const f = friendly(r);
  return callout({ tone: f.tone, title: f.title, body: f.body, actions: [f.action], alert: true, onClose: dismiss, tech: techDetails('Technical details', refusalTech(r)), cls: 'result' });
}

// ── Home: what waits for you, and a checklist for each of your roles ─────────────────────

/** Decisions this approver may approve: submitted, not prepared by them, not changing their work, using no agent they own. */
function canApprove(d) {
  const me = actor();
  const ref = myRef();
  if (!can('approver') || d.status !== 'submitted') return false;
  const prepared = [...(d.preparedBy ?? []).map((x) => x.personRef), d.submittedBy?.personRef].filter(Boolean);
  if (ref && prepared.includes(ref)) return false;
  if ((d.subjects ?? []).some((s) => s.address === me || (ref && s.personRef === ref))) return false;
  const plan = planBy(d.planIri);
  const agents = (plan?.tasks ?? []).filter((r) => r.changed).map((r) => r.proposed?.agentAddress).filter(Boolean);
  return !agents.some((a) => { const owner = member(a)?.principal; return owner && (owner === me || (ref && member(owner)?.personRef === ref)); });
}
/** When a decision's measurement period ends (its trials' longest time limit, for a trial decision). */
function windowEnds(d) {
  const at = Date.parse(d.countersign?.at ?? '');
  if (!Number.isFinite(at)) return NaN;
  const weeks = d.measurementPlan?.windowWeeks ?? Math.max(0, ...(d.probes ?? []).map((p) => Number(p.timeboxWeeks) || 0));
  return at + weeks * 7 * 86400000;
}
function canRecordResults(d) {
  const ref = myRef();
  if (d.status !== 'countersigned' || !(can('operator') || can('approver'))) return false;
  if (!(windowEnds(d) <= nowMs())) return false;
  const prepared = [...(d.preparedBy ?? []).map((x) => x.personRef), d.submittedBy?.personRef].filter(Boolean);
  return !(ref && (prepared.includes(ref) || d.countersign?.personRef === ref));
}
const ownsAgent = (a) => { const me = actor(); const owner = member(a)?.principal; return Boolean(owner) && (owner === me || (myRef() && member(owner)?.personRef === myRef())); };

/** Everything that waits for this person, each opening the view where it is done (nothing here signs). */
function waitingItems() {
  const d = data();
  const me = actor();
  if (!me || !S.data) return [];
  const items = [];
  for (const t of tasks()) {
    if (t.status === 'retired') continue;
    const mine = [...t.namedParties, ...(t.owedRatification ?? [])].find((p) => p.address === me);
    if (mine && !mine.ratification) items.push({ tab: 'tasks', title: `Confirm or dispute: ${t.name}`, meta: (d.workflows ?? []).find((w) => w.workflowIri === t.workflowIri)?.title ?? '', tone: 'pending', state: 'Waiting for you', open: () => { location.hash = `task=${encodeURIComponent(t.taskIri)}`; } });
  }
  for (const p of d.plans ?? []) {
    if (p.stale) continue;
    for (const a of p.assignments ?? []) {
      if (a.personAddress === me && a.state === 'not-acknowledged') items.push({ tab: 'plan', title: `Respond to your new assignment: ${taskName(a.taskIri)}`, meta: p.title, tone: 'pending', state: 'Waiting for you', open: () => { S.workflow = p.workflowIri; goTab('plan'); } });
    }
  }
  for (const x of d.decisions ?? []) {
    const title = planBy(x.planIri)?.title ?? 'A decision';
    if (canApprove(x)) items.push({ tab: 'decisions', title: `Approve or decline: ${title}`, meta: PLAN_KIND[x.decisionKind] ?? '', tone: 'pending', state: 'Waiting for approval', open: () => { S.decisionOpen = x.decisionIri; S.decisionFilter = 'all'; goTab('decisions'); } });
    if (canRecordResults(x)) items.push({ tab: 'decisions', title: `Record results: ${title}`, meta: 'The measurement period has ended', tone: 'info', state: 'Results due', open: () => { S.decisionOpen = x.decisionIri; S.decisionFilter = 'all'; goTab('decisions'); } });
  }
  if (can('operator') || can('approver')) {
    for (const a of d.awaitingReview ?? []) {
      if (!ownsAgent(a.agentAddress)) items.push({ tab: 'agents', title: `Review AI work: ${labelOf(a.agentAddress)} on ${taskName(a.taskIri)}`, meta: kindLabel(a.taskKind), tone: 'pending', state: 'Waiting for review', open: () => goTab('agents') });
    }
  }
  return items;
}

/**
 * A first-run checklist: steps with a done condition; the first open step is "current". Optional and
 * link steps never count toward done. The checklist is left out once every counted step is done.
 */
function checklist(id, title, steps) {
  const counted = steps.filter((s) => !s.optional && !s.link);
  const done = counted.filter((s) => s.done).length;
  if (counted.length > 0 && done === counted.length) return null;
  let current = false;
  const item = (s) => {
    let state = '';
    if (s.done) state = 'done';
    else if (s.locked) state = 'locked';
    else if (!current && !s.optional && !s.link) { state = 'current'; current = true; }
    const prefix = { done: 'Done: ', current: 'Next step: ', locked: 'Not yet available: ' }[state] ?? '';
    return h('li', { class: 'checklist__item', 'data-state': state || undefined },
      h('span', { class: 'checklist__mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check') : null),
      h('p', { class: 'checklist__title-item' }, prefix ? h('span', { class: 'visually-hidden', text: prefix }) : null, s.title, s.optional ? h('span', { class: 'label__optional', text: '(optional)' }) : null),
      (!s.done && s.locked ? s.lockedText : s.text) ? h('p', { class: 'checklist__text', text: !s.done && s.locked ? s.lockedText : s.text }) : null,
      !s.done && !s.locked && s.action ? h('div', { class: 'checklist__action' }, btn(s.action[0], { variant: state === 'current' ? 'primary' : 'secondary', size: 'sm', on: s.action[1] })) : null);
  };
  return h('section', { class: 'checklist', 'aria-labelledby': `${id}-title` },
    h('div', { class: 'checklist__header' }, h('div', { class: 'split' }, h('h2', { class: 'checklist__title', id: `${id}-title`, text: title }), h('p', { class: 'checklist__meta', text: `${done} of ${counted.length} done` })),
      h('progress', { class: 'progress', max: counted.length, value: done, 'aria-label': `${title}: ${done} of ${counted.length} done` }, `${done} of ${counted.length}`)),
    h('ol', { class: 'checklist__list' }, steps.map(item)));
}

function homeChecklists() {
  const d = data();
  const me = actor();
  const waiting = waitingItems();
  const current = tasks().filter((t) => t.status !== 'retired');
  const sorted = current.filter((t) => t.classification?.state === 'ok');
  const firstUnsorted = current.find((t) => t.classification?.state !== 'ok');
  const out = [];
  if (isAdmin()) {
    out.push(checklist('setup', 'Set up your workspace', [
      { title: 'Add your team', text: 'Add people with their roles and a Person ID.', done: people().length > 0, action: ['Add people', () => { goTab('roles'); memberPanel(null); }] },
      { title: 'Add your AI agents', text: 'Give each one an accountable owner and the AI model it runs on.', done: agentsList().length > 0, action: ['Add an AI agent', () => { goTab('roles'); memberPanel(null, 'agent'); }] },
      { title: 'Define your types of task', text: 'For example "Invoice matching".', done: kindsList(false).length > 0, action: ['Define types of task', () => { S.openKinds = true; goTab('roles'); }] },
      { title: 'Make the AI permission rules stricter', text: 'Only if your organisation needs a higher bar than the standard one.', optional: true, done: Boolean(d.vocabulary?.podPolicy), action: ['Review the rules', () => goTab('roles')] },
      { title: 'Invite people', text: 'Copy the invitation, which asks each person to sign in and send you their Interego ID.', done: people().length >= 2,
        action: ['Copy the invitation', () => copyText(`Join our Work Redesign workspace: sign in at ${location.origin}/ui and send me the Interego ID it shows you.`, 'The invitation')] },
    ]));
  }
  if (can('approver')) {
    out.push(checklist('approve', 'Approve and measure', [
      { title: 'Approve or decline submitted plans', text: 'If someone objected or hasn\'t responded, name it to approve anyway.', done: !(d.decisions ?? []).some(canApprove), action: ['Review decisions', () => { S.decisionFilter = 'submitted'; goTab('decisions'); }] },
      { title: 'Record results when a measurement period ends', text: 'For decisions you neither prepared nor approved.', done: !(d.decisions ?? []).some(canRecordResults), action: ['See results due', () => { S.decisionFilter = 'due'; goTab('decisions'); }] },
      { title: 'Review AI work', text: 'Your verdict is what counts toward an agent\'s track record.', done: !waiting.some((w) => w.tab === 'agents'), action: ['Review AI work', () => goTab('agents')] },
      { title: 'Grant or withdraw AI permission when an agent has earned it', optional: true, done: (d.grants ?? []).length > 0, action: ['Open AI agents', () => goTab('agents')] },
      { title: 'Check the track record', text: 'Did our predictions land?', link: true, action: ['Open the track record', () => goTab('calibration')] },
    ]));
  }
  if (can('operator')) {
    const allSorted = current.length > 0 && sorted.length === current.length;
    const priced = (d.plans ?? []).some((p) => p.planKind === 'valued');
    out.push(checklist('lead', 'Map and change your process', [
      { title: 'Map your first process', text: 'By hand, or from a procedure document with your own AI.', done: (d.workflows ?? []).length > 0, action: ['Start mapping', () => goTab('capture')] },
      { title: 'Ask your team to confirm their tasks', text: 'Send each person their task link.', done: current.length > 0 && current.every((t) => t.status === 'ratified'), locked: current.length === 0, lockedText: 'Map a process first.', action: ['Open Processes', () => goTab('tasks')] },
      { title: 'Sort each task by predictability', text: `Seven questions per task. ${sorted.length} of ${current.length} tasks sorted.`, done: allSorted, locked: current.length === 0, lockedText: 'Map a process first.',
        action: firstUnsorted ? ['Sort the next task', () => { S.workflow = firstUnsorted.workflowIri; goTab('tasks'); classifyPanel(firstUnsorted); }] : null },
      { title: 'Propose who does what', text: 'Choose who does each task next.', done: (d.plans ?? []).length > 0, locked: !allSorted, lockedText: `Sort every task first: ${sorted.length} of ${current.length} done.`, action: ['Propose a change', () => goTab('plan')] },
      { title: 'Build the business case', text: 'Low, likely and high for every number, with where it came from.', done: (d.valuations ?? []).length > 0, locked: !priced, lockedText: 'Unlocks once a priced plan exists.', action: ['Open Business case', () => goTab('value')] },
      { title: 'Submit for approval', text: 'An independent approver then approves or declines it.', done: (d.decisions ?? []).length > 0, locked: (d.plans ?? []).length === 0, lockedText: 'Unlocks once a plan exists.', action: ['Submit a plan', () => { S.showSubmit = true; goTab('decisions'); }] },
      agentsList().length > 0 ? { title: 'Review AI work', text: 'Accept it, or say it needs rework.', done: !waiting.some((w) => w.tab === 'agents'), action: ['Review AI work', () => goTab('agents')] } : null,
    ].filter(Boolean)));
  }
  if (can('worker')) {
    const mineTasks = tasks().filter((t) => t.status !== 'retired' && [...t.namedParties, ...(t.owedRatification ?? [])].some((p) => p.address === me));
    const sortedMine = mineTasks.filter((t) => t.classification?.state === 'ok');
    out.push(checklist('part', 'Your part', [
      { title: 'You\'re in the workspace', text: 'Your admin has added you.', done: true },
      { title: 'Check the tasks that name you', text: 'Confirm each description, or dispute it with a note.', done: mineTasks.every((t) => [...t.namedParties, ...(t.owedRatification ?? [])].find((p) => p.address === me)?.ratification), action: ['See my tasks', () => goTab('me')] },
      { title: 'Check how your tasks are sorted', text: 'Confirm or dispute the predictability answers.', done: sortedMine.every((t) => (t.classification.ratifications ?? []).some((r) => r.party === me)), action: ['See my tasks', () => goTab('me')] },
      { title: 'Respond to new assignments', text: 'Accept, or object with a note.', done: !waiting.some((w) => w.tab === 'plan'), action: ['Open Plans', () => goTab('plan')] },
      { title: 'Download your record', text: 'Every record about your work, with its original signature.', link: true, action: ['Go to My record', () => goTab('me')] },
    ]));
  }
  const owned = agentsList().filter((a) => a.principal === me);
  if (owned.length > 0) {
    const runs = (d.runs ?? []).filter((r) => owned.some((a) => a.address === r.agentAddress));
    out.push(checklist('owner', 'Your AI agents', [
      { title: 'Ask your admin to register the agent', text: `${owned.map((a) => a.label).join(', ')} ${owned.length === 1 ? 'is' : 'are'} registered.`, done: true },
      { title: 'Have the agent record each piece of work', text: 'It signs these with its own key; Work Redesign never holds it.', done: runs.length > 0, action: ['Record AI work', () => goTab('agents')] },
      { title: 'Get its work reviewed by others', text: 'You can\'t review your own agent\'s work; it needs at least 5 different reviewers.', done: runs.length > 0 && !(d.awaitingReview ?? []).some((a) => owned.some((o) => o.address === a.agentAddress)), action: ['Open AI agents', () => goTab('agents')] },
      { title: 'Watch progress toward permission', link: true, action: ['Open the track record', () => goTab('calibration')] },
      { title: 'Tell your admin when the agent\'s model changes', text: 'Permission applies only to the model it was earned on.', link: true },
    ]));
  }
  return out.filter(Boolean);
}

function homeView() {
  const d = data();
  const me = actor();
  const name = displayName(me);
  const m = member(me);
  const rs = [...(m?.roles ?? []), ...(isAdmin() ? ['admin'] : [])];
  const waiting = waitingItems();
  const current = tasks().filter((t) => t.status !== 'retired');
  const confirmed = current.filter((t) => t.status === 'ratified').length;
  const disputed = current.filter((t) => t.status === 'disputed').length;
  const ds = d.decisions ?? [];
  const stat = (label, value, meta) => h('div', { class: 'stat' }, h('p', { class: 'stat__label', text: label }), h('p', { class: 'stat__value', text: value }), h('p', { class: 'stat__meta', text: meta }));
  const lists = homeChecklists();
  return h('div', { class: 'home' },
    pageHeader({ eyebrow: workspaceLabel(d.podUrl), title: name ? `Welcome, ${name}` : 'Welcome', lede: 'Here\'s what needs your attention.',
      meta: [...rolesPlain(rs).map((r) => badge(r, 'accent')), allDemo() ? badge('Sample data', 'demo') : null] }),
    !me ? callout({ tone: 'info', title: 'You\'re viewing this workspace without signing in', body: 'Sign in to respond to tasks, propose changes or download your record.', actions: [signInButton('sm')] }) : null,
    h('div', { class: 'home__grid' },
      h('div', { class: 'home__main' },
        viewSection('Waiting for you', '', h('div', { class: 'card' }, waiting.length
          ? h('ul', { class: 'list' }, waiting.map((w) => h('li', null, h('button', { type: 'button', class: 'list__item', on: { click: w.open } },
            h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: w.title }), w.meta ? h('span', { class: 'list__meta', text: w.meta }) : null),
            h('span', { class: 'list__end' }, status(w.state, w.tone), icon('arrow-right', 'sm'))))))
          : emptyState({ icon: 'check', title: 'You\'re all caught up', text: 'Nothing needs your response right now.', actions: [btn('Go to Processes', { size: 'sm', on: () => goTab('tasks') })], plain: true }))),
        lists.length ? h('section', { class: 'view-section home__checklists', 'aria-label': 'Getting started' }, lists) : null),
      h('aside', { class: 'home__side' },
        viewSection('This workspace', '', h('div', { class: 'stat-grid stat-grid--stack' },
          stat('Processes', String((d.workflows ?? []).length), plural(current.length, 'task')),
          stat('Tasks confirmed', `${confirmed} of ${current.length}`, `${disputed} disputed`),
          stat('Decisions', String(ds.length), `${ds.filter((x) => x.status === 'submitted').length} waiting for approval`),
          stat('Measured results', String(ds.filter((x) => x.status === 'measured').length), 'See Track record'))),
        h('div', { class: 'card home__help' }, h('div', { class: 'card__body' }, h('p', { class: 'card__title', text: 'New to Work Redesign?' }),
          h('p', { class: 'text-secondary text-sm', text: 'The guide walks through each role step by step: team members, process leads, approvers, admins and AI agent owners.' }),
          h('a', { class: 'btn btn--secondary btn--sm', href: '/ui/help', target: '_blank', rel: 'noopener' }, 'Read the guide', icon('arrow-right', 'sm')))))));
}

// ── Shared pickers and wording ───────────────────────────────────────────────────────────

const personOptions = (blank) => [['', blank], ...people().map((m) => [m.address, `${m.label} (${rolesPlain(m.roles).join(', ')})`])];
const agentOptions = (blank) => [['', blank], ...agentsList().map((m) => [m.address, `${m.label} — ${m.model}`])];
const kindOptions = () => [['', 'Choose a type of task'], ...kindsList(false).map((k) => [k.slug, k.label])];
const captureLevels = () => Object.entries(LEVEL_NAMES).filter(([l]) => l !== 'agent-acts-within-grant');
const levelRule = (level) => (data().vocabulary?.levels ?? []).find((l) => l.level === level) ?? {};
const ruleLabel = (iri) => {
  const r = (data().vocabulary?.rules ?? []).find((x) => x.iri === iri);
  return r ? `${r.id}: ${r.condition}` : short(iri);
};
const partiesText = (a) => [a.personAddress ? labelOf(a.personAddress) : null, a.agentAddress ? labelOf(a.agentAddress) : null].filter(Boolean).join(' + ');
const allocationText = (a) => (a ? `${LEVEL_NAMES[a.level] ?? a.level}${partiesText(a) ? ` — ${partiesText(a)}` : ''}` : '—');
const taskStatus = (s) => { const [t, tone] = TASK_STATUS[s] ?? [s, '']; return status(t, tone); };
const regimeBadge = (regime) => badge(REGIME_NAMES[regime] ?? regime, REGIME_TONE[regime]);
const QUOTE_BADGE = { verified: ['Sources checked', 'success'], none: ['No sources cited', ''], unverified: ['Source not found in the document', 'danger'], 'partly-verified': ['Some sources not found', 'warning'] };
const quotesBadge = (s) => { const [t, tone] = QUOTE_BADGE[s] ?? [s, '']; return badge(t, tone); };
const QUOTES_NEEDED = 'No quotes yet. Each task drafted from a document cites 1 to 5 passages from it.';
const workflowOf = (t) => (data().workflows ?? []).find((w) => w.workflowIri === t.workflowIri);
const draftedByText = (by) => {
  const v = typeof by === 'string' ? { kind: by } : by ?? { kind: 'not-declared' };
  if (v.kind === 'person') return 'a person';
  if (v.kind === 'agent') return `an AI${v.agent || v.model ? ` — ${[v.agent, v.model].filter(Boolean).join(', ')}` : ''}`;
  return 'not stated';
};
const isNamed = (t, me = actor()) => t.namedParties.some((p) => p.address === me);
const isOwed = (t, me = actor()) => (t.owedRatification ?? []).some((p) => p.address === me);
const myResponse = (t, me = actor()) => [...t.namedParties, ...(t.owedRatification ?? [])].find((p) => p.address === me)?.ratification ?? null;

function workflowPicker() {
  const wfs = data().workflows ?? [];
  // Default to the workflow with the most current tasks; the person's own choice sticks.
  if (!S.workflow || !wfs.some((w) => w.workflowIri === S.workflow)) S.workflow = [...wfs].sort((a, b) => b.taskIris.length - a.taskIris.length)[0]?.workflowIri ?? '';
  if (wfs.length < 2) return null;
  return h('div', { class: 'view-picker' }, field('Process', select(wfs.map((w) => [w.workflowIri, `${w.title} (${plural(w.taskIris.length, 'task')})`]), S.workflow, (e) => { S.workflow = e.target.value; S.panel = null; render(); })));
}
const currentWorkflow = () => (data().workflows ?? []).find((w) => w.workflowIri === S.workflow);

// ── Processes ─────────────────────────────────────────────────────────────────────────────

/** What stops this task or its current way of working, in plain words: [plain note, the bridge's words]. */
function taskNoteItems(t) {
  const e = t.effective ?? {};
  return [
    e.suspended ? [note('No one is currently allowed to do this task. A new decision is needed.', 'warning'), e.suspendedWhy] : null,
    e.unreadable ? [note('Some records this depends on can\'t be read.', 'danger'), e.unreadable] : null,
    t.currentNotPermitted ? [note('The way this task is done now isn\'t allowed for its category. Propose a change.', 'warning'), t.currentNotPermitted] : null,
    t.currentNotPermittedUnreadable ? [note('We can\'t check whether the way this task is done now is allowed.', 'danger'), t.currentNotPermittedUnreadable] : null,
  ].filter(Boolean);
}
/** The notes, then one Technical details holding the bridge's own words for all of them (and `extra`). */
function taskNotes(t, ...extra) {
  const items = taskNoteItems(t);
  const raw = [...items.map(([, why]) => why), ...extra.flat()].filter(Boolean);
  return [items.map(([n]) => n), raw.length ? techDetails('Technical details', raw) : null];
}

function predictabilityCell(t, canSort) {
  const c = t.classification;
  const sortBtn = () => h('div', null, btn('Sort by predictability', { variant: 'link', size: 'sm', on: () => classifyPanel(t) }));
  if (!c) return [h('span', { class: 'text-secondary', text: 'Not sorted yet' }), canSort ? sortBtn() : null];
  if (c.state !== 'ok') return [note('This answer was changed outside the app: sort again', 'danger'), canSort ? sortBtn() : null];
  const [st, tone] = CLASS_STATUS[c.status] ?? [c.status, ''];
  const redo = !c.current || c.contraryEvidence?.suggestReclassify;
  return h('div', { class: 'stack stack--sm' },
    h('div', { class: 'cluster' }, regimeBadge(c.regime), status(st, tone)),
    h('span', { class: 'table__secondary', text: METHOD_NAMES[c.method] ?? c.method }),
    c.current ? null : badge('Sorted before the description changed: sort again', 'warning'),
    c.disagreement.length ? badge(`${plural(c.disagreement.length, 'person', 'people')} ${c.disagreement.length === 1 ? 'disagrees' : 'disagree'}`, 'danger') : null,
    c.contraryEvidence?.suggestReclassify ? note('Reviewed AI work on this task is often rejected. Worth sorting it again.', 'warning') : null,
    c.contraryEvidence?.unreadable ? note('Some reviewed AI work on this task can\'t be read.', 'danger') : null,
    canSort && redo ? sortBtn() : null);
}

function tasksView() {
  const picker = workflowPicker();
  const wf = currentWorkflow();
  const op = can('operator');
  const header = pageHeader({ title: 'Processes', lede: 'Every task in the process, who does it now, whether the people named agree, and how predictable it is.',
    meta: [allDemo() ? badge('Sample data', 'demo') : null],
    actions: [wf ? btn('Add a task', { variant: 'primary', icon: 'clipboard', on: () => addTaskPanel(wf), disabled: !op, why: WHY.operator }) : null, btn('Map a process', { on: () => goTab('capture') })] });
  if (!wf) {
    return [header, emptyState({ icon: 'clipboard', title: 'No processes mapped yet', text: op ? 'Start by mapping one process your team runs every week, such as supplier invoices.' : 'Ask a process lead to map your first process.',
      actions: [op ? btn('Map a process', { variant: 'primary', on: () => goTab('capture') }) : null] })];
  }
  const me = actor();
  const rows = wf.taskIris.map(taskBy).filter(Boolean);
  const retired = wf.retiredTaskIris.map(taskBy).filter(Boolean);
  const person = (p, owed) => h('div', { class: 'person-line' }, h('span', { class: 'person-line__name', text: p.label }),
    owed ? badge('Removed from this task: needs their response', 'warning')
      : p.ratification ? status(p.ratification.verdict === 'ratify' ? 'Confirmed' : 'Disputed', p.ratification.verdict === 'ratify' ? 'success' : 'danger') : status('Hasn\'t responded', 'pending'));
  const summary = h('section', { class: 'card process-card', 'aria-labelledby': 'process-title' },
    h('div', { class: 'card__header' }, h('div', null, h('span', { class: 'eyebrow', text: 'Process' }), h('h2', { class: 'card__title', id: 'process-title', text: wf.title })), sampleBadge(wf)),
    h('div', { class: 'card__body' },
      kv([
        ['Unit of work', wf.unitLabel],
        ['Mapped', wf.captureMode === 'document' && wf.document ? `From the procedure document "${wf.document.title}" (${num(wf.document.chars, 0)} characters)` : 'By hand'],
        ['Mapped by', labelOf(addrOfDid(wf.capturedBy))],
        wf.captureMode === 'document' ? ['Drafted by', [draftedByText(wf.draftedBy), hint('As stated by the person who signed the map. Work Redesign records it but can\'t verify it.')]] : null,
        ['Tasks', `${plural(rows.length, 'task')}, ${rows.filter((t) => t.status === 'ratified').length} confirmed`],
      ]),
      techDetails('Technical details', wf.document ? [`document fingerprint (sha256) ${wf.document.sha256}`, `text ${wf.document.textStored ? 'stored with the record' : 'not stored'}`] : null,
        wf.captureMode === 'document' ? `drafted by: ${typeof wf.draftedBy === 'string' ? wf.draftedBy : JSON.stringify(wf.draftedBy)}` : null)));
  const tableRows = rows.map((t) => {
    const named = isNamed(t, me);
    const owed = isOwed(t, me);
    const canSort = op || named || can('approver');
    const e = t.effective ?? {};
    const c = t.classification;
    return h('tr', null,
      td(null, h('span', { class: 'table__primary', text: t.name }), h('span', { class: 'table__secondary', text: t.description }),
        h('div', { class: 'cluster task-tags' }, badge(kindLabel(t.taskKind)), quotesBadge(t.quoteStatus), sampleBadge(t)),
        taskNotes(t, c && c.state !== 'ok' ? `classification ${c.state}: not trusted${c.unreadable ? `; ${c.unreadable}` : ''}` : null, c?.contraryEvidence?.suggestReclassify ? c.contraryEvidence.note : null, c?.contraryEvidence?.unreadable ?? null)),
      td(null, h('span', { text: allocationText(e) }), e.source && e.source !== 'captured' ? h('span', { class: 'table__secondary', text: SOURCE_NAMES[e.source] ?? e.source }) : null),
      td(null, h('div', { class: 'stack stack--sm' }, taskStatus(t.status),
        t.namedParties.map((p) => person(p, false)), (t.owedRatification ?? []).map((p) => person(p, true)),
        t.revision ? h('span', { class: 'table__secondary', text: `Updated: answers ${plural(t.revision.answers.length, 'dispute')}` }) : null,
        (named || owed) && !myResponse(t, me) && t.status !== 'retired' ? h('div', null, btn('Confirm or dispute', { variant: 'link', size: 'sm', on: () => ratifyPanel(t, 'description') })) : null)),
      td(null, predictabilityCell(t, canSort)),
      td({ class: 'actions' }, h('div', { class: 'row-actions' }, btn('Open', { size: 'sm', on: () => { location.hash = `task=${encodeURIComponent(t.taskIri)}`; } }),
        btn('Copy link', { variant: 'ghost', size: 'sm', on: () => copyText(new URL(t.link, location.href).href, 'Task link') }))));
  });
  return [
    header, picker, summary,
    rows.length === 0
      ? emptyState({ icon: 'clipboard', title: 'This process has no tasks yet', text: 'Add the steps people actually do, starting each with a verb, for example "Match each invoice to its purchase order."',
        actions: [btn('Add a task', { variant: 'primary', on: () => addTaskPanel(wf), disabled: !op, why: WHY.operator })] })
      : h('div', { class: 'view-section' }, table(['Task', 'Who does it now', 'Confirmation', 'Predictability', ''], tableRows, { label: `Tasks in ${wf.title}`, cls: 'tasks-table' })),
    !op ? whyNot(`${WHY.operator} Anyone named on a task can confirm or dispute it.`) : null,
    retired.length ? h('details', { class: 'disclosure view-section' }, h('summary', { text: `Retired tasks (${retired.length})` }),
      h('div', { class: 'disclosure__body' }, h('ul', null, retired.map((t) => h('li', { text: `${t.name} — retired ${day(t.retirement?.at)}: ${t.retirement?.why ?? ''}` }))))) : null,
  ];
}

// ── The task page (#task=…): the link people named on a task receive ───────────────────────

function taskFromHash() {
  const m = /^#task=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : '';
}

function quotesNode(quotes) {
  return h('div', null, quotes.map((q) => h('blockquote', { class: `quote quote--${q.status === 'verified' ? 'checked' : 'unchecked'}` },
    h('div', { class: 'cluster' }, badge(q.status === 'verified' ? 'Source checked' : 'Source not found in the document', q.status === 'verified' ? 'success' : 'danger')),
    h('p', { class: 'quote__text', text: `“${q.quote}”` }),
    q.status === 'verified' ? null : hint('Flagged and never corrected.'))),
    techDetails('Technical details', quotes.map((q, i) => `Quote ${i + 1}: ${q.status === 'verified' ? `characters ${q.start}–${q.end} of the normalised document${q.occurrences > 1 ? `; ${q.occurrences} occurrences` : ''}` : `${q.why}; never corrected`}`)));
}

function classificationNode(t, named) {
  const c = t.classification;
  if (!c) return emptyState({ icon: 'chart', title: 'Not sorted yet', text: 'Seven questions decide how predictable this task is, and so what kind of change is allowed.', plain: true });
  if (c.state !== 'ok') return [note('This answer was changed outside the app, so it isn\'t trusted. Sort the task again.', 'danger'), techDetails('Technical details', `The classification record is ${c.state} (trusted: no): it was changed after the platform signed it, or more than one version claims to be current.`, c.unreadable ?? null)];
  const qs = data().vocabulary?.questions ?? [];
  const role = { performer: 'the person who does it', approver: 'an approver', agent: 'an AI agent' }[c.answeredBy.role] ?? c.answeredBy.role;
  const rules = (data().vocabulary?.rules ?? []).filter((r) => c.rulesFired.includes(r.iri));
  const [st, tone] = CLASS_STATUS[c.status] ?? [c.status, ''];
  return h('div', { class: 'stack' },
    callout({ tone: 'accent', title: `${REGIME_NAMES[c.regime] ?? c.regime}: ${METHOD_NAMES[c.method] ?? c.method}`, body: REGIME_NOTES[c.regime] ?? '', iconName: 'chart' }),
    h('div', { class: 'cluster' }, status(st, tone), c.current ? null : badge('Sorted before the description changed: sort again', 'warning'),
      c.disagreement.length ? badge(`${plural(c.disagreement.length, 'person', 'people')} ${c.disagreement.length === 1 ? 'disagrees' : 'disagree'}`, 'danger') : null),
    h('p', { text: `Answered by ${labelOf(c.answeredBy.address)} (${role}).` }),
    c.answeredBy.role === 'agent' ? hint('Answers from an AI agent never count as expert evidence.') : null,
    rules.length ? h('p', null, h('strong', { text: 'Why: ' }), rules.map((r) => r.condition.replace(/\s*\([^)]*=[^)]*\)/g, '').replace(/\b(Evident|Knowable|Emergent|Turbulent)\b/g, (w) => REGIME_NAMES[w])).join(' ')) : null,
    table(['Question', labelOf(c.answeredBy.address), ...c.disagreement.map((d) => labelOf(d.party))],
      qs.map((q) => h('tr', null, td(null, q.text), td(null, optionName(c.answers[q.id])), c.disagreement.map((d) => td(null, optionName(d.answers[q.id]))))), { label: 'Answers', compact: true }),
    c.ratifications.filter((r) => r.note).map((r) => h('blockquote', { class: 'quote' }, h('p', { text: `${labelOf(r.party)} ${r.verdict === 'ratify' ? 'confirmed' : 'disputed'}: “${r.note}”` }))),
    c.contraryEvidence?.suggestReclassify ? note('Reviewed AI work on this task is often rejected. Worth sorting it again.', 'warning') : null,
    named ? h('div', null, btn('Confirm or dispute how it\'s sorted', { on: () => ratifyPanel(t, 'classification') })) : null,
    techDetails('Technical details', `regime ${c.regime} · method ${c.method} · status ${c.status} · answered as ${c.answeredBy.role}`, c.rulesFired.map(ruleLabel), c.notes,
      c.contraryEvidence ? `${c.contraryEvidence.reviewedRuns} person-reviewed run(s); ${pct(c.contraryEvidence.reworkedShare)} not accepted; ${c.contraryEvidence.criticalFailures} critical failure(s). ${c.contraryEvidence.note ?? ''}` : null));
}

function taskView(iri) {
  const t = taskBy(iri);
  const crumbsTo = (label) => h('li', null, h('button', { type: 'button', class: 'btn btn--link', on: { click: () => goTab('tasks') } }, label));
  if (!t) {
    return [pageHeader({ crumbs: h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, crumbsTo('Processes'))), title: 'Task' }),
      emptyState({ icon: 'clipboard', title: 'We couldn\'t find this task', text: 'The link may be out of date, or the task was retired.', actions: [btn('All processes', { variant: 'primary', on: () => goTab('tasks') })] })];
  }
  const me = actor();
  const named = isNamed(t, me);
  const owed = isOwed(t, me);
  const op = can('operator');
  const sortable = op || named || can('approver');
  const wf = workflowOf(t);
  const c = t.classification;
  const typeBadge = badge(kindLabel(t.taskKind));
  if (kindDefinition(t.taskKind)) typeBadge.title = kindDefinition(t.taskKind);
  const steps = S.mode === 'interego' ? RELAY_STEPS : S.mode === 'demo' ? null : WALLET_STEPS;
  return [
    pageHeader({
      crumbs: h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, crumbsTo('Processes'), wf ? h('li', { text: wf.title }) : null, h('li', null, h('span', { 'aria-current': 'page', text: t.name })))),
      title: t.name, lede: t.description,
      meta: [taskStatus(t.status), typeBadge, quotesBadge(t.quoteStatus), sampleBadge(t), allDemo() ? badge('Sample data', 'demo') : null],
      actions: [
        btn('Confirm or dispute', { variant: 'primary', on: () => ratifyPanel(t, 'description'), disabled: !(named || owed) || t.status === 'retired', why: t.status === 'retired' ? 'This task was retired.' : WHY.named }),
        btn(c && c.state === 'ok' ? 'Sort again' : 'Sort by predictability', { on: () => classifyPanel(t), disabled: !sortable, why: WHY.sortable }),
        btn('Edit', { variant: 'ghost', on: () => revisePanel(t), disabled: !(op || named), why: WHY.operatorOrNamed }),
        btn('Copy link', { variant: 'ghost', on: () => copyText(new URL(t.link, location.href).href, 'Task link') }),
        op ? btn('Retire task', { variant: 'danger-quiet', on: () => retirePanel(t) }) : null,
      ],
    }),
    !(named || owed) && t.status !== 'retired' ? whyNot(`${WHY.named} You can still read everything here.`) : null,
    taskNotes(t),
    t.quotes?.length ? viewSection('What the document says', 'Each quote the map relies on, checked against the procedure document.', quotesNode(t.quotes)) : null,
    t.revision ? viewSection('Updated', `Answers ${plural(t.revision.answers.length, 'dispute')}${t.revision.note ? `: ${t.revision.note}` : ''}`,
      t.revision.answers.map((a) => h('blockquote', { class: 'quote' }, h('p', { text: `${labelOf(a.party)}: “${a.note}”` })))) : null,
    viewSection('Who is named on this task', 'Everyone named confirms the description, or disputes it with a note.', h('div', { class: 'card' }, h('ul', { class: 'list' },
      [...t.namedParties.map((p) => [p, false]), ...(t.owedRatification ?? []).map((p) => [p, true])].map(([p, isOwedParty]) => h('li', { class: 'list__item' },
        h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: p.label }), h('span', { class: 'list__meta', text: isOwedParty ? 'Removed from this task: needs their response' : p.kind === 'agent' ? 'AI agent' : 'Person' })),
        h('span', { class: 'list__end' }, p.ratification ? status(p.ratification.verdict === 'ratify' ? 'Confirmed' : 'Disputed', p.ratification.verdict === 'ratify' ? 'success' : 'danger') : status('Hasn\'t responded', 'pending')),
        p.ratification?.note ? h('p', { class: 'list__note text-sm text-secondary', text: `“${p.ratification.note}”` }) : null))))),
    viewSection('How predictable this work is', '', classificationNode(t, named)),
    h('section', { class: 'card view-section confirm-card', 'aria-labelledby': 'confirm-title' }, h('div', { class: 'card__body' },
      h('h2', { class: 'card__title', id: 'confirm-title', text: 'What confirming means' }),
      h('p', { class: 'text-secondary', text: SIGNING_MEANS }),
      steps ? h('ol', { class: 'steps steps--compact' }, steps.map((s) => h('li', { class: 'step' }, h('p', { class: 'step__text', text: s })))) : null,
      S.mode !== 'demo' && S.mode !== 'interego' ? signInButton('sm') : null,
      techDetails('Technical details', S.mode === 'interego' ? RELAY_STEPS_TECH : S.mode === 'demo' ? null : WALLET_STEPS_TECH,
        S.mode !== 'demo' && S.mode !== 'interego' && S.signIn?.enabled ? SIGN_IN_OFFERED : null))),
  ];
}

// ── Panels on a task ──────────────────────────────────────────────────────────────────────

function ratifyPanel(t, subject) {
  const head = subject === 'description' ? t.head : t.classification?.head;
  const qs = data().vocabulary?.questions ?? [];
  const own = {};
  const noteBox = textarea('', null, { placeholder: 'What should change?' });
  const withAnswers = h('input', { type: 'checkbox' });
  const sendVerdict = (verdict) => act('wrd.ratify_task', 'wrd:ratify-task', {
    subject, taskIri: t.taskIri, descriptorUrl: head.descriptorUrl, graphDigest: head.graphDigest, verdict,
    ...(noteBox.value.trim() ? { note: noteBox.value.trim() } : {}),
    ...(subject === 'classification' && verdict === 'dispute' && withAnswers.checked ? { answers: { ...own } } : {}),
  });
  openPanel(subject === 'description' ? `Confirm or dispute: ${t.name}` : `Confirm or dispute how "${t.name}" is sorted`, h('div', { class: 'stack' },
    h('p', { text: SIGNING_MEANS }),
    subject === 'description' ? h('blockquote', { class: 'quote' }, h('p', null, h('strong', { text: t.name })), h('p', { class: 'text-secondary', text: t.description })) : null,
    field('Why', noteBox, { hint: 'Needed if you dispute.' }),
    subject === 'classification' ? h('details', { class: 'disclosure' }, h('summary', { text: 'Dispute with your own answers' }),
      h('div', { class: 'disclosure__body stack stack--sm' }, h('label', { class: 'choice' }, withAnswers, h('span', { class: 'choice__text' }, h('span', { text: 'Send my answers with the dispute' }))),
        qs.map((q) => { own[q.id] = 'unknown'; return field(q.text, select(q.options.map((o) => [o, optionName(o)]), 'unknown', (e) => { own[q.id] = e.target.value; })); }))) : null,
    h('div', { class: 'btn-group' }, btn('Confirm', { variant: 'primary', on: () => sendVerdict('ratify') }), btn('Dispute', { variant: 'danger-quiet', on: () => sendVerdict('dispute') })),
    footnote()));
}

function classifyPanel(t) {
  const qs = data().vocabulary?.questions ?? [];
  const prior = t.classification?.state === 'ok' ? t.classification.answers : {};
  const answers = {};
  const notes = textarea('', null, { placeholder: 'Anything the next person should know' });
  openPanel(`Sort "${t.name}" by predictability`, h('div', { class: 'stack' },
    h('p', { text: 'Answer for the task as it\'s done today. "Unknown" is a real answer. If your answers don\'t fit a category, nothing is recorded, and we never guess.' }),
    h('div', { class: 'form-grid' }, qs.map((q) => { answers[q.id] = prior[q.id] ?? 'unknown'; return field(q.text, select(q.options.map((o) => [o, optionName(o)]), answers[q.id], (e) => { answers[q.id] = e.target.value; })); })),
    field('Note', notes, { optional: true }),
    h('details', { class: 'disclosure' }, h('summary', { text: 'How the category is decided' }), h('div', { class: 'disclosure__body' }, h('ul', null, (data().vocabulary?.rules ?? []).map((r) => h('li', { text: `${r.id}: ${r.condition}` }))))),
    hint('Your answers are tied to the description as it reads now. If it changes before you sign, nothing is recorded.'),
    h('div', { class: 'btn-group' },
      btn('Sign the answers', { variant: 'primary', on: () => act('wrd.classify_task', 'wrd:classify-task', { taskIri: t.taskIri, taskTextSha256: t.textSha256, answers: { ...answers }, ...(notes.value.trim() ? { notes: notes.value.trim() } : {}) }) }),
      payloadButton('wrd:classify-task', { task_iri: t.taskIri })),
    footnote()));
}

function revisePanel(t) {
  const st = { name: t.name, description: t.description, currentLevel: t.current.level, personAddress: t.current.personAddress ?? '', agentAddress: t.current.agentAddress ?? '', taskKind: t.taskKind, externalTaskTerm: t.externalTaskTerm ?? '', note: '' };
  const disputes = t.namedParties.filter((p) => p.ratification?.verdict === 'dispute');
  openPanel(`Edit "${t.name}"`, h('div', { class: 'stack' },
    disputes.length ? callout({ tone: 'warning', title: 'This change answers these open disputes:', body: h('ul', null, disputes.map((p) => h('li', { text: `${p.label}: ${p.ratification.note ?? ''}` }))) }) : null,
    hint('Changing the text without new quotes clears the quotes; their history is kept. Everyone named must confirm the new text, including anyone this change removes from the task: a dispute is answered, never edited away.'),
    field('Name', input(st.name, (e) => { st.name = e.target.value; })),
    field('Description', textarea(st.description, (e) => { st.description = e.target.value; })),
    h('div', { class: 'form-row' },
      field('Who does it today', select(captureLevels(), st.currentLevel, (e) => { st.currentLevel = e.target.value; })),
      field('Type of task', select(kindOptions(), st.taskKind, (e) => { st.taskKind = e.target.value; }))),
    h('div', { class: 'form-row' },
      field('Person', select(personOptions('Nobody'), st.personAddress, (e) => { st.personAddress = e.target.value; })),
      field('AI agent', select(agentOptions('None'), st.agentAddress, (e) => { st.agentAddress = e.target.value; }))),
    field('Standard task reference', input(st.externalTaskTerm, (e) => { st.externalTaskTerm = e.target.value.trim(); }), { optional: true, hint: 'For example an O*NET task statement.' }),
    field('What changed and why', textarea('', (e) => { st.note = e.target.value; })),
    h('div', null, btn('Sign the change', { variant: 'primary', on: () => {
      const changes = {};
      if (st.name !== t.name) changes.name = st.name;
      if (st.description !== t.description) changes.description = st.description;
      if (st.currentLevel !== t.current.level) changes.currentLevel = st.currentLevel;
      if (st.personAddress !== (t.current.personAddress ?? '')) changes.personAddress = st.personAddress || null;
      if (st.agentAddress !== (t.current.agentAddress ?? '')) changes.agentAddress = st.agentAddress || null;
      if (st.taskKind !== t.taskKind) changes.taskKind = st.taskKind;
      if (st.externalTaskTerm && st.externalTaskTerm !== (t.externalTaskTerm ?? '')) changes.externalTaskTerm = st.externalTaskTerm;
      act('wrd.revise_task', 'wrd:revise-task', { op: 'revise', taskIri: t.taskIri, descriptorUrl: t.head.descriptorUrl, graphDigest: t.head.graphDigest, ...changes, ...(st.note.trim() ? { note: st.note.trim() } : {}) });
    } })),
    footnote()));
}

function retirePanel(t) {
  const why = textarea('', null, { placeholder: 'Why this task is retired' });
  openPanel(`Retire "${t.name}"`, h('div', { class: 'stack' }, hint('Removes the task from the process from now on. Its history is kept. Plans that change it go out of date.'),
    field('Why', why),
    h('div', null, btn('Retire task', { variant: 'danger', on: () => act('wrd.revise_task', 'wrd:revise-task', { op: 'retire', taskIri: t.taskIri, descriptorUrl: t.head.descriptorUrl, graphDigest: t.head.graphDigest, why: why.value.trim() }) })),
    footnote()));
}

function addTaskPanel(wf) {
  const st = blankTask();
  openPanel(`Add a task to "${wf.title}"`, h('div', { class: 'stack' },
    field('Name', input('', (e) => { st.name = e.target.value; }), { hint: 'Start with a verb, for example "Match each invoice to its purchase order".' }),
    field('Description', textarea('', (e) => { st.description = e.target.value; })),
    h('div', { class: 'form-row' },
      field('Who does it today', select(captureLevels(), st.currentLevel, (e) => { st.currentLevel = e.target.value; })),
      field('Type of task', select(kindOptions(), '', (e) => { st.taskKind = e.target.value; }))),
    h('div', { class: 'form-row' },
      field('Person', select(personOptions('Nobody'), '', (e) => { st.personAddress = e.target.value; })),
      field('AI agent', select(agentOptions('None'), '', (e) => { st.agentAddress = e.target.value; }))),
    h('div', null, btn('Sign and add the task', { variant: 'primary', on: () => act('wrd.revise_task', 'wrd:revise-task', {
      op: 'add', workflowIri: wf.workflowIri, descriptorUrl: wf.head.descriptorUrl, graphDigest: wf.head.graphDigest,
      task: { name: st.name, description: st.description, currentLevel: st.currentLevel, taskKind: st.taskKind,
        ...(st.personAddress ? { personAddress: st.personAddress } : {}), ...(st.agentAddress ? { agentAddress: st.agentAddress } : {}) },
    }) })),
    footnote()));
}

// ── Drafts kept in this browser (unsigned) ──────────────────────────────────────────────

const CAPTURE_KEY = 'wrd.capture.draft';
const blankTask = () => ({ name: '', description: '', currentLevel: 'person', personAddress: '', agentAddress: '', taskKind: '', externalTaskTerm: '', sourceQuotes: [], suggestedTaskKind: '' });
function captureDraft() {
  return store.get(CAPTURE_KEY) ?? { mode: 'manual', workflow: { title: '', unitLabel: '', description: '' }, tasks: [blankTask()], doc: { title: '', text: '' }, storeText: false, draftText: '', draftedBy: null };
}

const activeGrant = (agent, kind) => (data().grants ?? []).find((g) => g.agentAddress === agent && g.taskKind === kind && g.active);
const grantWhy = (kind) => (data().grants ?? []).find((g) => g.taskKind === kind)?.why ?? 'no grant on this kind of task';

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

function triOut(t) {
  const n = (v) => (String(v).trim() === '' ? null : Number(v));
  const likely = n(t.likely);
  const low = String(t.low).trim() === '' ? likely : n(t.low);
  const high = String(t.high).trim() === '' ? likely : n(t.high);
  return { low, likely, high, basis: t.basis, ...(t.note ? { note: t.note } : {}), ...(t.source ? { source: t.source } : {}) };
}

// ── Map a process ─────────────────────────────────────────────────────────────────────────

function captureView() {
  const st = captureDraft();
  const save = () => store.set(CAPTURE_KEY, st);
  const normDoc = normaliseForQuote(st.doc.text || '');
  const docMode = st.mode === 'document';
  const rerender = () => { save(); render(); };
  const op = can('operator');
  const taskCard = (t, i) => h('li', { class: 'card task-draft' },
    h('div', { class: 'card__header' }, h('h3', { class: 'card__title', text: `Task ${i + 1}` }),
      btn('Remove task', { variant: 'ghost', size: 'sm', on: () => { st.tasks.splice(i, 1); if (st.tasks.length === 0) st.tasks.push(blankTask()); rerender(); } })),
    h('div', { class: 'card__body' },
      h('div', { class: 'form-row' },
        h('div', { class: 'stack' },
          field('Task name', input(t.name, (e) => { t.name = e.target.value; save(); }), { hint: 'Start with a verb, for example "Match each invoice to its purchase order".' }),
          field('Description', textarea(t.description, (e) => { t.description = e.target.value; save(); }))),
        h('div', { class: 'stack' },
          field('Who does it today', select(captureLevels(), t.currentLevel, (e) => { t.currentLevel = e.target.value; rerender(); })),
          levelRule(t.currentLevel).requiresPerson !== false ? field('Person', select(personOptions('Choose a person'), t.personAddress, (e) => { t.personAddress = e.target.value; save(); })) : null,
          levelRule(t.currentLevel).requiresAgent || t.currentLevel === 'person-with-agent-assist'
            ? field(t.currentLevel === 'person-with-agent-assist' ? 'Assisting AI agent' : 'AI agent', select(agentOptions('None'), t.agentAddress, (e) => { t.agentAddress = e.target.value; save(); }), { optional: t.currentLevel === 'person-with-agent-assist' }) : null,
          field('Type of task', select(kindOptions(), t.taskKind, (e) => { t.taskKind = e.target.value; save(); }), { hint: t.suggestedTaskKind ? `The draft suggests "${t.suggestedTaskKind}".` : '' }))),
      field('Standard task reference', input(t.externalTaskTerm, (e) => { t.externalTaskTerm = e.target.value.trim(); save(); }), { optional: true, hint: 'For example an O*NET task statement.' }),
      docMode ? h('div', { class: 'stack stack--sm' }, h('p', { class: 'label', text: 'Quotes from the draft' }),
        t.sourceQuotes.length === 0 ? (t.name ? note(QUOTES_NEEDED, 'warning') : hint(QUOTES_NEEDED)) : null,
        t.sourceQuotes.map((q) => { const p = previewQuote(normDoc, q); return h('blockquote', { class: `quote quote--${p.status === 'verified' ? 'checked' : 'unchecked'}` },
          badge(p.status === 'verified' ? 'Source checked (preview)' : 'Source not found in the document (preview)', p.status === 'verified' ? 'success' : 'danger'), h('p', { class: 'quote__text', text: `“${q}”` })); }),
        t.sourceQuotes.length ? hint('A preview: Work Redesign checks every quote again when you sign.') : null) : null));

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
  const closed = data().bridge?.reads === 'signed';
  const step = (n, title, ...kids) => h('li', { class: 'card capture-step' }, h('div', { class: 'card__body' },
    h('h2', { class: 'card__title' }, h('span', { class: 'capture-step__n', 'aria-hidden': 'true', text: String(n) }), title), kids));
  return [
    pageHeader({ title: 'Map a process', lede: 'Describe how the work is really done, by hand or from a procedure document. Your draft stays in this browser until you sign it.' }),
    op ? null : callout({ tone: 'info', title: 'Only process leads can record a process map', body: 'You can still look around. Ask your admin if your role should change.' }),
    h('fieldset', { class: 'fieldset view-block' }, h('legend', { class: 'legend', text: 'How do you want to start?' }),
      h('div', { class: 'choice-group choice-group--inline capture-modes' },
        choice('radio', 'capture-mode', 'By hand', { checked: !docMode, card: true, help: 'Type each task yourself', on: () => { st.mode = 'manual'; rerender(); } }),
        choice('radio', 'capture-mode', 'From a procedure document', { checked: docMode, card: true, help: 'Your own AI drafts the map; we check every quote', on: () => { st.mode = 'document'; rerender(); } }))),
    docMode ? h('ol', { class: 'capture-steps' },
      step(1, 'Add the document',
        field('Document title', input(st.doc.title, (e) => { st.doc.title = e.target.value; save(); })),
        field('Load a .txt or .md file', h('input', { type: 'file', class: 'input input--file', accept: '.txt,.md,text/plain,text/markdown', on: { change: loadFile } })),
        field('Or paste the text', textarea(st.doc.text, (e) => { st.doc.text = e.target.value; save(); }, { class: 'textarea textarea--tall' }))),
      step(2, 'Get instructions for your AI',
        h('p', { class: 'text-secondary', text: 'Copy these into your own AI assistant (Claude, ChatGPT…), together with the document. Work Redesign doesn\'t draft anything itself.' }),
        S.packet ? h('div', { class: 'stack stack--sm' }, callout({ tone: 'success', title: 'Instructions ready', body: 'Copy them into your AI assistant with the document.' }),
          h('div', { class: 'btn-group' }, btn('Copy instructions', { variant: 'primary', icon: 'clipboard', on: () => copyText(JSON.stringify(S.packet, null, 2), 'The instructions for your AI') }),
            btn('Get instructions again', { on: packet })),
          disclosure('Show the instructions', h('pre', { text: JSON.stringify(S.packet, null, 2) })))
          : h('div', null, btn('Get instructions for your AI', { variant: 'primary', on: packet, disabled: !st.doc.text, why: 'Add the document first.' }))),
      step(3, 'Paste the draft your AI gave you',
        st.draftText ? null : emptyState({ icon: 'sparkle', title: 'Waiting for your AI\'s draft', text: 'Get the instructions, give them to your AI assistant with the document, then paste its answer here.', plain: true }),
        field('The draft', textarea(st.draftText, (e) => { st.draftText = e.target.value; save(); }, { class: 'textarea textarea--tall textarea--mono' })),
        h('div', null, btn('Fill the tasks from the draft', { on: fillFromDraft })),
        st.draftedBy ? [h('p', null, h('strong', { text: 'Drafted by: ' }), draftedByText(st.draftedBy)), hint('As stated in the draft. Work Redesign records it but can\'t verify it.')] : null),
      step(4, 'Check and sign',
        choice('checkbox', '', 'Store the document text with the record', { checked: !!st.storeText, help: closed ? 'Only people added to this workspace can read it.' : 'Anyone with the link can read it.', on: (e) => { st.storeText = e.target.checked; save(); } }),
        techDetails('Technical details', data().readExposure))) : null,
    h('section', { class: 'card view-block', 'aria-labelledby': 'process-draft-title' },
      h('div', { class: 'card__header' }, h('h2', { class: 'card__title', id: 'process-draft-title', text: 'The process' })),
      h('div', { class: 'card__body' },
        h('div', { class: 'form-row' },
          field('Process name', input(st.workflow.title, (e) => { st.workflow.title = e.target.value; save(); }), { hint: 'For example "Supplier invoice processing".' }),
          field('Unit of work', input(st.workflow.unitLabel, (e) => { st.workflow.unitLabel = e.target.value; save(); }), { hint: 'What one run handles, for example "invoice".' })),
        field('Description', textarea(st.workflow.description, (e) => { st.workflow.description = e.target.value; save(); }), { optional: true }))),
    h('h2', { class: 'view-section__title view-block', text: `Tasks (${st.tasks.length})` }),
    h('ol', { class: 'capture-steps capture-tasks' }, st.tasks.map(taskCard)),
    h('div', { class: 'capture-actions' },
      btn('Add a task', { icon: 'clipboard', on: () => { st.tasks.push(blankTask()); rerender(); } }),
      hint('This is a draft kept in this browser only. Signing records it; the people named on each task then confirm or dispute it.'),
      h('div', null, btn(docMode ? 'Sign and record the process map' : 'Sign and record the process', { variant: 'primary', on: signCapture, disabled: S.busy || !op, why: WHY.operator })),
      op ? footnote() : whyNot(WHY.operator)),
  ];
}

/** The tasks a capture recorded, each with the link to send the people named on it. */
function captureResultNode(b) {
  if (!b?.tasks) return null;
  return h('ul', { class: 'list capture-result' }, b.tasks.map((t) => h('li', { class: 'list__item' },
    h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: t.name })), h('span', { class: 'list__end' }, quotesBadge(t.quoteStatus),
      btn('Copy link for the people named', { variant: 'ghost', size: 'sm', on: () => copyText(new URL(t.link, location.href).href, 'Task link') })))));
}

// ── Plans: who does each task next ────────────────────────────────────────────────────────

function planView() {
  const picker = workflowPicker();
  const wf = currentWorkflow();
  const op = can('operator');
  const header = pageHeader({ title: 'Plans', lede: 'Propose who does each task next. People named on a change accept it or object.', meta: [allDemo() ? badge('Sample data', 'demo') : null] });
  if (!wf) return [header, emptyState({ icon: 'arrow-right', title: 'No plans yet', text: 'Map a process and sort each task by predictability; then propose who should do what.', actions: [btn('Go to Processes', { variant: 'primary', on: () => goTab('tasks') })] })];
  const rows = wf.taskIris.map(taskBy).filter(Boolean);
  const classified = rows.filter((t) => t.classification && t.classification.state === 'ok').length;
  const allClassified = classified === rows.length;
  const f = S.planForm[wf.workflowIri] ??= { title: '', rows: {} };
  const regimes = data().vocabulary?.regimes ?? [];
  const rowState = (t) => f.rows[t.taskIri] ??= { level: '', personAddress: t.effective.personAddress ?? '', agentAddress: t.effective.agentAddress ?? '', probes: [] };
  const lockOf = (t) => {
    const c = t.classification;
    if (!c) return 'Sort this task first';
    if (c.state !== 'ok') return 'Its predictability answer was changed outside the app: sort it again';
    if (t.status === 'disputed') return 'Its description is disputed: edit it first';
    if (c.status === 'disputed') return 'Someone disputes how it\'s sorted: sort it again';
    if (!c.current) return 'Sorted before the description changed: sort again';
    if (c.regime === 'Turbulent') return 'Unstable: stabilise first; no change allowed';
    return '';
  };
  const agentLock = (t) => (t.classification?.status === 'ratified' ? '' : 'AI can be assigned only once everyone named has confirmed how predictable it is.');
  const editRow = (t) => {
    const s = rowState(t);
    const c = t.classification;
    const lock = lockOf(t);
    const permitted = regimes.find((r) => r.regime === c?.regime)?.permittedLevels ?? [];
    const rule = levelRule(s.level);
    const levelOpts = [['', 'No change'], ...permitted.map((l) => {
      const disabled = l === 'agent-acts-within-grant' && !(s.agentAddress && activeGrant(s.agentAddress, t.taskKind)) && !agentsList().some((a) => activeGrant(a.address, t.taskKind));
      return [l, LEVEL_NAMES[l] ?? l, disabled, disabled ? `No AI agent has earned permission on this type of task yet (${grantWhy(t.taskKind)}).` : ''];
    })];
    const g = s.level === 'agent-acts-within-grant' && s.agentAddress ? activeGrant(s.agentAddress, t.taskKind) : null;
    return h('tr', null,
      td(null, h('span', { class: 'table__primary', text: t.name }), h('span', { class: 'table__secondary', text: `Now: ${allocationText(t.effective)}` }),
        t.effective.source !== 'captured' ? h('span', { class: 'table__secondary', text: SOURCE_NAMES[t.effective.source] ?? t.effective.source }) : null,
        t.effective.suspended ? note('No one is currently allowed to do this task. A new decision is needed.', 'warning') : null,
        t.effective.unreadable ? note('Some records this depends on can\'t be read.', 'danger') : null),
      td(null, c?.regime && c.state === 'ok' ? [regimeBadge(c.regime), h('span', { class: 'table__secondary', text: METHOD_NAMES[c.method] ?? '' })] : h('span', { class: 'text-secondary', text: 'Not sorted yet' })),
      td(null, lock ? status(lock, 'warning') : h('div', { class: 'stack stack--sm' },
        select(levelOpts, s.level, (e) => { s.level = e.target.value; render(); }, { 'aria-label': `Proposed for ${t.name}` }),
        s.level && (rule.requiresPerson || s.level === 'person-with-agent-assist') ? field('Person', select(personOptions('Choose a person'), s.personAddress, (e) => { s.personAddress = e.target.value; })) : null,
        s.level && (rule.requiresAgent || s.level === 'person-with-agent-assist') ? field(s.level === 'person-with-agent-assist' ? 'Assisting AI agent' : 'AI agent', select(agentOptions('Choose an AI agent'), s.agentAddress, (e) => { s.agentAddress = e.target.value; render(); }), { optional: s.level === 'person-with-agent-assist' }) : null,
        s.level && (rule.requiresAgent || s.agentAddress) && agentLock(t) ? note(agentLock(t), 'warning') : null,
        g ? h('p', { class: 'text-sm' }, `Earned permission in force: ${plural(g.evaluation.samples, 'reviewed piece', 'reviewed pieces')} of work`, g.evidenceTaskIris.includes(t.taskIri) ? '' : [' ', badge('Earned on other tasks', 'warning')]) : null,
        c?.regime === 'Emergent' && s.level ? probesEditor(s) : null)));
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
  return [
    header, picker,
    allClassified ? null : callout({ tone: 'warning', title: 'Sort every task first', body: `A plan needs every task in this process sorted by predictability. ${classified} of ${rows.length} are done.`, actions: [btn('Go to Processes', { size: 'sm', on: () => goTab('tasks') })] }),
    h('section', { class: 'card view-block', 'aria-labelledby': 'propose-title' },
      h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title', id: 'propose-title', text: 'Propose a change' }), h('p', { class: 'card__subtitle', text: `For ${wf.title}. Choose who does each task next; leave a task at "No change" to keep it as it is.` }))),
      h('div', { class: 'card__body' }, h('fieldset', { class: 'fieldset stack', disabled: !allClassified || !op },
        h('legend', { class: 'visually-hidden', text: 'Propose a change' }),
        field('Plan name', input(f.title, (e) => { f.title = e.target.value; }), { hint: 'For example "AI drafts the GL coding, Dee decides".' }),
        table(['Task and who does it now', 'Predictability', 'Proposed'], rows.map(editRow), { label: 'Proposed changes' }),
        h('div', null, btn('Sign and propose', { variant: 'primary', on: submit })),
        footnote()),
        op ? null : whyNot(WHY.operator))),
    viewSection('Plans for this process', '', plans.length === 0
      ? emptyState({ icon: 'arrow-right', title: 'No plans yet', text: 'Once every task in a process is sorted by predictability, propose who should do what.', plain: true })
      : h('div', { class: 'stack' }, plans.map(planCard))),
  ];
}

function probesEditor(s) {
  const probe = () => ({ hypothesis: '', amplifyIf: '', dampenIf: '', timeboxWeeks: 4 });
  if (s.probes.length === 0) s.probes.push(probe());
  return h('div', { class: 'trials' }, hint('Exploratory work changes only through 1 to 5 small, safe-to-fail trials. They\'re never priced.'),
    s.probes.map((p, i) => h('div', { class: 'card trial' }, h('div', { class: 'card__body stack stack--sm' },
      field(`Trial ${i + 1}: what you expect to happen`, input(p.hypothesis, (e) => { p.hypothesis = e.target.value; })),
      field('Scale up if', input(p.amplifyIf, (e) => { p.amplifyIf = e.target.value; })),
      field('Scale back if', input(p.dampenIf, (e) => { p.dampenIf = e.target.value; })),
      field('Time limit (weeks, 1 to 26)', input(String(p.timeboxWeeks), (e) => { p.timeboxWeeks = e.target.value; }, { type: 'number', min: 1, max: 26 })),
      h('div', null, btn('Remove trial', { variant: 'ghost', size: 'sm', on: () => { s.probes.splice(i, 1); render(); } }))))),
    s.probes.length < 5 ? btn('Add a trial', { size: 'sm', on: () => { s.probes.push(probe()); render(); } }) : null);
}

function planCard(p) {
  const me = actor();
  const changed = p.tasks.filter((r) => r.changed);
  return h('article', { class: 'card plan-card' },
    h('div', { class: 'card__header' }, h('div', null, h('h3', { class: 'card__title', text: p.title }), h('p', { class: 'card__subtitle', text: `Proposed by ${labelOf(addrOfDid(p.proposedBy))}` })),
      h('div', { class: 'cluster' }, badge(PLAN_KIND[p.planKind] ?? p.planKind, p.planKind === 'probe' ? 'warning' : 'accent'), sampleBadge(p))),
    h('div', { class: 'card__body' },
      p.stale ? [note('Out of date: a task changed after this plan was made. Make a new plan.', 'warning'), techDetails('Technical details', p.stale)] : null,
      p.unreadable ? [note('Part of this plan can\'t be read.', 'danger'), techDetails('Technical details', p.unreadable)] : null,
      h('ul', { class: 'change-list' }, changed.map((r) => h('li', null,
        h('span', { class: 'change-list__task', text: taskName(r.taskIri) }),
        h('span', { class: 'change-list__move' }, h('span', { class: 'change-list__from', text: allocationText(r.current) }), icon('arrow-right', 'sm'), h('span', { class: 'change-list__to', text: allocationText(r.proposed) })),
        r.grant && !r.grant.evidenceFromThisTask ? badge('Earned on other tasks', 'warning') : null,
        r.probes ? h('ul', { class: 'trial-list' }, r.probes.map((pr) => h('li', { text: `${pr.hypothesis} · scale up if ${pr.amplifyIf} · scale back if ${pr.dampenIf} · ${plural(pr.timeboxWeeks, 'week')}` }))) : null))),
      p.assignments.length ? h('div', { class: 'stack stack--sm' }, h('p', { class: 'label', text: 'New assignments' }), p.assignments.map((a) => {
        const [st, tone] = ASSIGNMENT_STATE[a.state] ?? [a.label, ''];
        return h('div', { class: 'assignment' }, h('span', { text: `${labelOf(a.personAddress)} on ${taskName(a.taskIri)}` }), status(st, tone), a.note ? h('span', { class: 'text-secondary text-sm', text: `“${a.note}”` }) : null,
          a.personAddress === me && a.state === 'not-acknowledged' ? h('span', { class: 'btn-group' }, btn('Accept assignment', { variant: 'primary', size: 'sm', on: () => acknowledge(p, a.taskIri, 'acknowledge') }),
            btn('Object…', { variant: 'danger-quiet', size: 'sm', on: () => objectPanel(p, a.taskIri) })) : null);
      })) : null));
}

function acknowledge(p, taskIri, verdict, note) {
  return act('wrd.ratify_task', 'wrd:ratify-task', { subject: 'assignment', planIri: p.planIri, taskIri, descriptorUrl: p.head.descriptorUrl, graphDigest: p.head.graphDigest, verdict, ...(note ? { note } : {}) });
}
function objectPanel(p, taskIri) {
  const why = textarea('', null, { placeholder: 'Why you object' });
  openPanel(`Object to your assignment on "${taskName(taskIri)}"`, h('div', { class: 'stack' },
    hint('Objecting doesn\'t block the plan, but an approver can approve over your objection only by naming it.'),
    field('Why', why), h('div', null, btn('Sign the objection', { variant: 'primary', on: () => acknowledge(p, taskIri, 'object', why.value.trim()) })), footnote()));
}

// ── Business case ────────────────────────────────────────────────────────────────────────

/** A three-point input: low / likely / high, its source, a note and a link. One number in "likely" alone is kept as one number, marked "no range given". */
function triEditor(label, t, save) {
  const one = t.likely !== '' && t.low === '' && t.high === '';
  const num3 = (k, which) => input(t[k], (e) => { t[k] = e.target.value; save(); }, { type: 'number', step: 'any', placeholder: which, 'aria-label': `${label} ${which.toLowerCase()}` });
  return h('div', { class: 'tri' }, h('span', { class: 'tri__label', text: label }),
    num3('low', 'Low'), num3('likely', 'Likely'), num3('high', 'High'),
    select(Object.entries(BASIS_SHORT), t.basis, (e) => { t.basis = e.target.value; save(); }, { 'aria-label': `${label} source` }),
    input(t.note, (e) => { t.note = e.target.value; save(); }, { class: 'input tri__note', placeholder: 'Note', 'aria-label': `${label} note` }),
    input(t.source, (e) => { t.source = e.target.value.trim(); save(); }, { class: 'input tri__link', placeholder: 'Where it was measured (link)', 'aria-label': `${label} link` }),
    one ? badge('Single number: no range given', 'warning') : null);
}
const triHead = () => h('div', { class: 'tri tri--head', 'aria-hidden': 'true' }, ['', 'Low', 'Likely', 'High', 'Source', 'Note', 'Link'].map((x) => h('span', { text: x })));

/** An input's path in the valuation, as a person names it. */
function pathLabel(path) {
  const names = { 'unitsPerWeek.current': 'Volume a week now', 'unitsPerWeek.proposed': 'Volume a week after the change', valuePerUnit: 'Value of one unit', hourlyCost: 'Hourly cost of a person', oneOffCost: 'One-off cost of the change', runsPerUnit: 'Runs per unit' };
  const fields = Object.fromEntries(STATE_FIELDS);
  const m = /^tasks\[(.+?)\]\.(.+)$/.exec(path);
  if (!m) return names[path] ?? path;
  const [state, k] = m[2].split('.');
  if (!k) return `${taskName(m[1])}: ${names[state] ?? state}`;
  return `${taskName(m[1])}: ${fields[k] ?? k} (${state === 'proposed' ? 'proposed' : 'now'})`;
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
  const op = can('operator');
  if (!p) {
    return [pageHeader({ title: 'Business case', lede: 'Price a plan with honest ranges. Every number is low / likely / high, with where it came from.' }),
      emptyState({ icon: 'money', title: 'Nothing to price yet', text: 'Propose a plan first. Plans made of trials are never priced.', actions: [btn('Go to Plans', { variant: 'primary', on: () => goTab('plan') })] })];
  }
  const { key, st } = valueDraft(p);
  const save = () => store.set(key, st);
  const rerender = () => { save(); render(); };
  const latest = valuationsOf(p.planIri).at(-1);
  const wf = (data().workflows ?? []).find((w) => w.workflowIri === p.workflowIri);
  const unit = wf?.unitLabel || 'unit';
  const taskBlock = (r) => {
    const ti = st.tasks[r.taskIri] ??= { entered: r.changed, runsPerUnit: triBlank(), overrideHourly: false, hourlyCost: triBlank(), current: stateBlank(), proposed: stateBlank() };
    const needed = r.changed || st.throughputChanges;
    if (r.changed) st.freedHours[r.taskIri] ??= { disposition: 'undecided', note: '' };
    const body = h('div', { class: 'card__body' },
      triHead(),
      triEditor(`Runs of this task per ${unit}`, ti.runsPerUnit, save),
      choice('checkbox', '', 'This task has its own hourly cost', { checked: ti.overrideHourly, on: (e) => { ti.overrideHourly = e.target.checked; rerender(); } }),
      ti.overrideHourly ? triEditor('Hourly cost for this task', ti.hourlyCost, save) : null,
      h('p', { class: 'tri-group', text: `Now: ${allocationText(r.current)}` }),
      STATE_FIELDS.map(([k, label]) => triEditor(`${label} — now`, ti.current[k], save)),
      r.changed ? [
        h('div', { class: 'split tri-group' }, h('p', { text: `Proposed: ${allocationText(r.proposed)}` }),
          btn('Copy now to proposed', { variant: 'ghost', size: 'sm', on: () => { ti.proposed = JSON.parse(JSON.stringify(ti.current)); rerender(); } })),
        STATE_FIELDS.map(([k, label]) => triEditor(`${label} — proposed`, ti.proposed[k], save)),
        h('div', { class: 'form-row tri-group' },
          field('What happens to the hours this frees', select((data().vocabulary?.dispositions?.freedHours ?? Object.keys(FREED_NAMES)).map((x) => [x, FREED_NAMES[x] ?? x]), st.freedHours[r.taskIri]?.disposition, (e) => { st.freedHours[r.taskIri].disposition = e.target.value; save(); })),
          field('Note', input(st.freedHours[r.taskIri]?.note, (e) => { st.freedHours[r.taskIri].note = e.target.value; save(); }, { placeholder: 'e.g. who takes on what' }), { optional: true })),
      ] : null);
    if (needed) {
      return h('section', { class: 'card view-block' }, h('div', { class: 'card__header' }, h('h3', { class: 'card__title', text: taskName(r.taskIri) }),
        badge(r.changed ? 'Changes in this plan' : 'Volume changes: needed', r.changed ? 'accent' : 'warning')), body);
    }
    return h('details', { class: 'card view-block value-unchanged', open: ti.entered && !r.changed ? true : undefined },
      h('summary', { class: 'card__header' }, h('span', { class: 'card__title', text: taskName(r.taskIri) }), h('span', { class: 'text-sm text-tertiary', text: 'Not needed: unchanged tasks cancel out' })),
      h('div', { class: 'card__body' }, choice('checkbox', '', 'Enter it anyway (needed for the value-to-cost ratio)', { checked: ti.entered, on: (e) => { ti.entered = e.target.checked; save(); } })), body);
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
  return [
    pageHeader({ title: 'Business case', lede: 'Price a plan with honest ranges. Every number is low / likely / high, with where it came from.',
      meta: [allDemo() ? badge('Sample data', 'demo') : null],
      actions: [btn('Sign and price this plan', { variant: 'primary', on: run, disabled: S.busy || !op, why: WHY.operator }), payloadButton('wrd:value-plan', { plan_iri: p.planIri })] }),
    op ? null : whyNot(WHY.operator),
    h('div', { class: 'view-picker' }, field('Plan', select(plans.map((x) => [x.planIri, `${x.title}${x.stale ? ' — out of date' : x.unreadable ? ' — can\'t be read in full' : ''}`]), S.plan, (e) => { S.plan = e.target.value; render(); }))),
    p.stale ? [note('Out of date: a task changed after this plan was made. Make a new plan.', 'warning'), techDetails('Technical details', p.stale)] : null,
    p.unreadable ? [note('Part of this plan can\'t be read.', 'danger'), techDetails('Technical details', p.unreadable)] : null,
    latest ? valuationNode(latest) : null,
    h('h2', { class: 'view-section__title view-section', text: latest ? 'Your inputs' : 'Enter your ranges' }),
    hint('Give each number as low / likely / high, and say where it came from. A single number is kept as one number and marked "no range given". Your draft is saved in this browser until you sign it.'),
    h('section', { class: 'card view-block' }, h('div', { class: 'card__header' }, h('h3', { class: 'card__title', text: 'The whole process' })), h('div', { class: 'card__body' },
      field('Currency', input(st.currency, (e) => { st.currency = e.target.value.toUpperCase(); save(); }, { maxLength: 3, class: 'input input--short' }), { hint: '3 letters, for example USD.' }),
      triHead(),
      triEditor(`How many ${unit}s a week now`, st.unitsCurrent, save),
      choice('checkbox', '', `The change alters how many ${unit}s we handle`, { checked: st.throughputChanges, on: (e) => { st.throughputChanges = e.target.checked; rerender(); } }),
      st.throughputChanges ? triEditor(`How many ${unit}s a week after the change`, st.unitsProposed, save) : null,
      triEditor(`Value of one ${unit}`, st.valuePerUnit, save), triEditor('Hourly cost of a person', st.hourlyCost, save), triEditor('One-off cost of the change', st.oneOffCost, save),
      h('div', { class: 'form-row form-row--4' }, nInput('horizonMonths', 'Time horizon (months)', { min: 1, max: 120 }), nInput('rampMonths', 'Ramp-up (months)', { min: 0, max: 60 }),
        nInput('annualDiscountRate', 'Annual discount rate (0 to 1)'), nInput('criticalFailureCeiling', 'Highest acceptable critical-failure rate (for pilot sizing)')))),
    p.tasks.map(taskBlock),
    hint('Mark a zero that doesn\'t apply (for example a person\'s hours where AI does the work) as "Doesn\'t apply (0)". "Self-reported" means the person doing the work told you. A proposed state hasn\'t run yet, so "Measured" there needs a link to where it was measured. Where a person decides on or checks the AI\'s work, include their hours.'),
    h('div', { class: 'capture-actions' }, h('div', null, btn('Sign and price this plan', { variant: 'primary', on: run, disabled: S.busy || !op, why: WHY.operator })), op ? footnote() : null),
  ];
}

/** Two ranges on one scale: each a band from low to high with its likely value, and zero marked. */
function rangePair(items) {
  const vals = items.flatMap(([, b]) => (b ? [b.p10, b.p90] : [])).concat([0]).filter((v) => Number.isFinite(v));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const pos = (v) => `${(((v - min) / (max - min)) * 100).toFixed(2)}%`;
  return h('div', { class: `range-pair${items.length === 1 ? ' range-pair--single' : ''}` }, items.map(([label, b, f]) => {
    if (!b) return null;
    const bar = h('div', { class: 'range' }, h('div', { class: 'range__track' }), h('div', { class: 'range__zero' }), h('div', { class: 'range__band' }), h('div', { class: 'range__mid' }));
    bar.style.setProperty('--lo', pos(b.p10));
    bar.style.setProperty('--hi', pos(b.p90));
    bar.style.setProperty('--mid', pos(b.p50));
    bar.style.setProperty('--zero', pos(0));
    return h('div', null, h('p', { class: 'text-sm text-secondary', text: label }), bar,
      h('div', { class: 'range__legend' }, h('span', null, 'Low ', h('strong', { text: f(b.p10) })), h('span', null, 'Likely ', h('strong', { text: f(b.p50) })), h('span', null, 'High ', h('strong', { text: f(b.p90) }))));
  }));
}

function valuationNode(v) {
  const r = v.result;
  const cur = r.currency;
  const m = (n) => money(n, cur);
  const sc = r.scenarios;
  const stat = (label, value, meta) => h('div', { class: 'stat' }, h('p', { class: 'stat__label', text: label }), h('p', { class: 'stat__value', text: value }), meta ? h('p', { class: 'stat__meta', text: meta }) : null);
  const scenarioRows = [
    ['Weekly impact', band(sc.cash.weeklyDelta, m), band(sc.redeployed.weeklyDelta, m)],
    ['Net present value over the time horizon', band(sc.cash.npv, m), band(sc.redeployed.npv, m)],
    ['Chance it pays off', pct(sc.cash.probabilityNpvPositive), pct(sc.redeployed.probabilityNpvPositive)],
    ['Payback month (likely)', sc.cash.payback.p50Month ?? 'Not within the time horizon', sc.redeployed.payback.p50Month ?? 'Not within the time horizon'],
    ['Chance of paying back within the time horizon', pct(sc.cash.payback.probabilityWithinHorizon), pct(sc.redeployed.payback.probabilityWithinHorizon)],
  ];
  const breakdownRows = ['value', 'loss', 'personCost', 'oversightCost', 'agentCost'].map((k) => h('tr', null,
    td(null, { value: 'Value', loss: 'Expected loss from failures', personCost: 'People\'s time', oversightCost: 'Checking time', agentCost: 'AI cost' }[k]),
    td({ class: 'num' }, m(r.breakdown.current.total[k])), td({ class: 'num' }, m(r.breakdown.proposed.total[k]))));
  const sens = (s) => {
    const max = Math.max(1e-9, ...s.sensitivity.map((x) => x.swing));
    return s.sensitivity.map((x) => {
      const bar = h('div', { class: 'sens__bar' });
      bar.style.width = `${Math.max(0.5, (x.swing / max) * 100)}%`;
      return h('div', { class: 'sens__row' }, h('div', { class: 'cluster' }, h('span', { class: 'sens__label', text: pathLabel(x.input) }), badge(BASIS_NAMES[x.basis] ?? x.basis), x.basis === 'estimate' ? badge('Unmeasured estimate', 'warning') : null),
        h('span', { class: 'text-tertiary text-xs', text: `Net present value ${m(x.npvAtLow)} at low, ${m(x.npvAtHigh)} at high` }), h('div', { class: 'sens__track' }, bar));
    });
  };
  const byBasis = Object.entries(r.inputs.byBasis).filter(([, n]) => n > 0);
  return h('section', { class: 'card valuation view-block', 'aria-labelledby': 'valuation-title' },
    h('div', { class: 'card__header' }, h('div', null, h('h2', { class: 'card__title', id: 'valuation-title', text: 'Business case results' }), h('p', { class: 'card__subtitle', text: `Priced ${day(v.head?.validFrom)} · simulation of ${num(r.draws, 0)} runs` })), sampleBadge(v)),
    h('div', { class: 'card__body' },
      h('div', { class: 'stat-grid' },
        stat('Likely weekly cash impact', m(sc.cash.weeklyDelta?.p50), `Low ${m(sc.cash.weeklyDelta?.p10)} · High ${m(sc.cash.weeklyDelta?.p90)}`),
        stat('Net present value (likely)', m(sc.cash.npv?.p50), 'Cash, over the time horizon'),
        stat('Chance it pays off', pct(sc.cash.probabilityNpvPositive), 'Net present value above zero'),
        stat('Payback month (likely)', sc.cash.payback.p50Month ? `Month ${sc.cash.payback.p50Month}` : 'None', sc.cash.payback.p50Month ? 'Cash' : 'Not within the time horizon (cash)')),
      h('div', { class: 'split' }, h('h3', { text: 'Weekly impact' }), h('span', { class: 'text-sm text-tertiary', title: 'There\'s an 80% chance the result falls between Low and High; Likely is the middle.', text: '80% range' })),
      rangePair([['Weekly cash impact', sc.cash.weeklyDelta, m], ['Weekly impact if freed time is redeployed', sc.redeployed.weeklyDelta, m]]),
      hint('There\'s an 80% chance the result falls between Low and High; Likely is the middle.'),
      v.unratifiedTasks.length ? note(`Not yet confirmed by everyone named: ${v.unratifiedTasks.map(taskName).join(', ')}. You can't submit this for approval until they are.`, 'warning') : null,
      v.expertEvidence.length ? h('p', { text: `Expert answers for Needs-expertise changes: ${v.expertEvidence.map((e) => `${taskName(e.taskIri)} — ${e.satisfiedBy}`).join('; ')}` }) : null,
      table(['', 'Cash (freed hours count only where the work is left unfilled)', 'If freed time is redeployed'], scenarioRows.map((row) => h('tr', null, row.map((c) => td(null, String(c))))), { label: 'Scenarios', compact: true, cls: 'table--label' }),
      hint(NO_TOTALS),
      h('h3', { text: 'Freed hours per week' }),
      table(['Task', 'Hours freed (negative = added)', 'What happens to them'], [
        ...r.freedPersonHours.perTask.map((f) => h('tr', null, td(null, taskName(f.taskIri)), td(null, band(f.band, (n) => num(n, 1))), td(null, `${FREED_NAMES[f.disposition] ?? f.disposition}${f.note ? ` — ${f.note}` : ''}`))),
        h('tr', null, td(null, h('strong', { text: 'All changed tasks' })), td(null, band(r.freedPersonHours.total, (n) => num(n, 1))), td(null, '')),
      ], { label: 'Freed hours per week', compact: true }),
      h('h3', { text: 'Weekly breakdown at likely values' }),
      table(['', '#Now', '#Proposed'], breakdownRows, { label: 'Weekly breakdown', compact: true, cls: 'table--label' }),
      h('p', { class: 'text-sm' }, h('strong', { text: 'Value for money ' }), '(value minus expected loss, divided by cost): ',
        r.valueToCost.why ? r.valueToCost.why : `now ${band(r.valueToCost.current, (n) => num(n, 2))}; proposed ${band(r.valueToCost.proposed, (n) => num(n, 2))}`),
      h('div', { class: 'grid-2' }, h('div', null, h('h3', { text: 'Biggest drivers: cash' }), sens(sc.cash)), h('div', null, h('h3', { text: 'Biggest drivers: if freed time is redeployed' }), sens(sc.redeployed))),
      h('h3', { text: 'Where the inputs came from' }),
      h('div', { class: 'cluster' }, byBasis.map(([b, n]) => badge(`${BASIS_NAMES[b] ?? b}: ${n}`, b === 'estimate' ? 'warning' : b === 'measured' ? 'success' : ''))),
      r.inputs.noRange.length ? h('p', { class: 'text-sm', text: `Single number, no range given (${r.inputs.noRange.length}): ${r.inputs.noRange.map(pathLabel).join('; ')}` }) : null,
      r.inputs.topSensitivityEstimates.length ? note(`Unmeasured estimates among the three inputs that move the result most: ${r.inputs.topSensitivityEstimates.map(pathLabel).join('; ')}`, 'warning') : null,
      r.inputs.unconfirmed.map((u) => h('p', { class: 'text-sm', text: `${pathLabel(u.path)}: ${u.why}` })),
      (r.inputs.reportedAgentCost ?? []).map((c) => h('p', { class: 'text-sm', text: `Cost reported by the AI for ${kindLabel(c.taskKind)}: ${num(c.mean, 4)} ${c.currency} over ${plural(c.runs, 'run')} (reported by the agent, not metered)` })),
      r.pilot.length ? [h('h3', { text: 'Suggested pilot size' }), hint('How many clean runs show the failure rate is below your ceiling, with 95% confidence.'),
        r.pilot.map((x) => [h('p', { class: 'text-sm', text: `${taskName(x.taskIri)}: ${num(x.runsNeeded, 0)} runs with no critical failure; about ${x.weeksAtLikelyThroughput ?? '—'} week(s) at likely volume.` }),
          x.likelyRateExceedsCeiling ? note('The likely critical-failure rate is above your ceiling, so a pilot can\'t show it is below it.', 'warning') : null])] : null,
      h('details', { class: 'disclosure' }, h('summary', { text: 'Assumptions' }), h('div', { class: 'disclosure__body' }, h('ul', null, r.assumptions.map((a) => h('li', { text: a }))))),
      techDetails('Technical details', 'Reproducibility code: the same plan and inputs always give the same result.', `Seed ${r.seed}, ${r.draws} draws, method ${r.method}. Hash ${v.valuationHash}.`, `Unchanged tasks: ${r.inputs.unchangedTasks}`)));
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────

const decisionStatus = (d) => { const [t, tone] = DECISION_STATUS[d.status] ?? [d.statusLabel, '']; return status(t, tone); };
const decisionTitle = (d) => planBy(d.planIri)?.title ?? 'Decision';
/** Who signed a step: the member the step's DID names, else the first member with its person ID. */
const personOf = (x) => {
  if (!x) return '—';
  const m = x.did ? member(addrOfDid(x.did)) : null;
  if (m) return m.label;
  const p = people().find((q) => q.personRef === x.personRef);
  return p ? p.label : x.personRef ?? '—';
};
const shortName = (label) => String(label).split(',')[0].trim();
const preparedNames = (d) => [...new Set((d.preparedBy ?? (d.submittedBy ? [d.submittedBy] : [])).map((x) => shortName(personOf(x))))].join(', ');
const CHAIN_STATUS = { submitted: 'Submitted', countersigned: 'Approved', measured: 'Results recorded', declined: 'Declined' };
const FILTERS = [['all', 'All'], ['submitted', 'Waiting for approval'], ['due', 'Results due'], ['measured', 'Results recorded'], ['declined', 'Declined']];
const passesFilter = (d, f) => f === 'all' || (f === 'due' ? d.status === 'countersigned' && windowEnds(d) <= nowMs() : d.status === f);

function decisionsView() {
  const ds = data().decisions ?? [];
  const valuationOf = (d) => (data().valuations ?? []).find((v) => v.valuationIri === d.valuationIri);
  const op = can('operator');
  const shown = ds.filter((d) => passesFilter(d, S.decisionFilter));
  const result = (d) => {
    const o = d.outcome;
    if (o?.valued) { const [t, tone] = VERDICT_NAMES[o.valued.verdict] ?? [o.valued.verdict, '']; return [status(t, tone), h('span', { class: 'table__secondary', text: `Measured ${fmtOf(d)(o.valued.measured.weeklyValueDelta)} a week` })]; }
    if (o?.probes) return h('span', { text: o.probes.map((p) => `Trial ${p.index}: ${SIGNAL_NAMES[p.signal] ?? p.signal}`).join(' · ') });
    return h('span', { class: 'text-tertiary', text: '—' });
  };
  const fmtOf = (d) => { const c = valuationOf(d)?.result?.currency; return (n) => (c ? money(n, c) : num(n, 0)); };
  const rows = shown.map((d) => h('tr', { 'aria-selected': S.decisionOpen === d.decisionIri ? 'true' : undefined },
    td(null, h('span', { class: 'table__primary', text: decisionTitle(d) }), h('span', { class: 'table__secondary', text: `${PLAN_KIND[d.decisionKind] ?? d.decisionKind} · prepared by ${preparedNames(d) || '—'}` })),
    td(null, decisionStatus(d), sampleBadge(d)),
    td({ class: 'num' }, d.prediction ? [h('span', { class: 'table__primary', text: fmtOf(d)(d.prediction.band?.p50) }), h('span', { class: 'table__secondary', text: `Low ${fmtOf(d)(d.prediction.band?.p10)} · High ${fmtOf(d)(d.prediction.band?.p90)}` })] : h('span', { class: 'text-secondary', text: 'Trial: never priced' })),
    td(null, result(d)),
    td({ class: 'actions' }, btn(S.decisionOpen === d.decisionIri ? 'Hide' : 'Open', { size: 'sm', on: () => { S.decisionOpen = S.decisionOpen === d.decisionIri ? '' : d.decisionIri; render(); } }))));
  const filterChips = h('div', { class: 'cluster filter-chips', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([id, label]) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': S.decisionFilter === id ? 'true' : 'false', text: label, on: { click: () => { S.decisionFilter = id; render(); } },
  })));
  const empty = ds.length === 0
    ? emptyState({ icon: 'shield', title: 'No decisions yet', text: 'When a plan has a business case (or is a trial plan), submit it for approval here.', actions: [op ? btn('Submit for approval', { variant: 'primary', on: () => { S.showSubmit = true; render(); } }) : null] })
    : S.decisionFilter === 'submitted' && can('approver') && !ds.some(canApprove)
      ? emptyState({ icon: 'shield', title: 'Nothing waiting for your approval', text: 'You\'ll see plans here when a process lead submits one you\'re eligible to approve.', plain: true })
      : emptyState({ icon: 'shield', title: 'Nothing to show here', text: 'No decision matches this filter.', plain: true });
  return [
    pageHeader({ title: 'Decisions', lede: 'Plans submitted for approval, who approved them, and what actually happened.', meta: [allDemo() ? badge('Sample data', 'demo') : null],
      actions: [btn('Submit for approval', { variant: 'primary', disabled: !op, why: WHY.operator, on: () => { S.showSubmit = true; render(); document.getElementById('submit')?.scrollIntoView?.({ block: 'start' }); } })] }),
    ds.length ? filterChips : null,
    shown.length ? h('div', { class: 'view-block' }, table(['Plan', 'Status', '#Likely weekly impact', 'Result', ''], rows, { label: 'Decisions' })) : empty,
    ds.length ? hint(NO_TOTALS) : null,
    ds.filter((d) => d.decisionIri === S.decisionOpen).map((d) => decisionCard(d, valuationOf(d))),
    submitForm(),
  ];
}

function submitForm() {
  // A plan whose staleness cannot be read (a record it was proposed against does not open) is not offered: the bridge would refuse it (409).
  const plans = (data().plans ?? []).filter((p) => !p.stale && !p.unreadable);
  const st = { planIri: plans[0]?.planIri ?? '', valuationIri: '', metric: 'weekly-cash-delta', basis: '', windowWeeks: 8, description: '', note: '' };
  const op = can('operator');
  const body = h('div', { class: 'card__body stack' });
  const draw = () => {
    const p = planBy(st.planIri);
    const vals = valuationsOf(st.planIri);
    if (!vals.some((v) => v.valuationIri === st.valuationIri)) st.valuationIri = vals.at(-1)?.valuationIri ?? '';
    const v = vals.find((x) => x.valuationIri === st.valuationIri);
    body.replaceChildren(...[
      plans.length === 0 ? emptyState({ icon: 'arrow-right', title: 'No plan to submit', text: 'Propose a plan first, under Plans.', plain: true }) : null,
      plans.length ? field('Plan', select(plans.map((x) => [x.planIri, `${x.title} (${PLAN_KIND[x.planKind] ?? x.planKind})`]), st.planIri, (e) => { st.planIri = e.target.value; draw(); })) : null,
      p?.planKind === 'valued' ? [
        vals.length ? field('Business case', select(vals.map((x) => [x.valuationIri, `Priced ${day(x.head.validFrom)}`]), st.valuationIri, (e) => { st.valuationIri = e.target.value; draw(); })) : note('Price this plan first.', 'warning'),
        v ? techDetails('Technical details', `valuation fingerprint ${v.valuationHash}`) : null,
        h('div', { class: 'form-row' },
          field('What will be measured', select((data().vocabulary?.metrics ?? []).map((x) => [x, metricName(x)]), st.metric, (e) => { st.metric = e.target.value; })),
          field('How the change will be compared', select([['', 'Choose how you\'ll compare'], ...(data().vocabulary?.comparisonBases ?? []).map((x) => [x, COMPARISON_NAMES[x] ?? x])], st.basis, (e) => { st.basis = e.target.value; draw(); }),
            { hint: 'Only choose a held-back group or phased rollout if you\'ll really have one.' })),
        h('div', { class: 'form-row' },
          field('Measurement period (weeks after approval)', input(String(st.windowWeeks), (e) => { st.windowWeeks = Number(e.target.value); }, { type: 'number', min: 1, max: 104 })),
          field('How the comparison is made', input(st.description, (e) => { st.description = e.target.value; }), { optional: true })),
      ] : p ? h('div', null, h('p', { text: 'A trial decision has no business case and no prediction. Its trials:' }),
        h('ul', null, p.tasks.filter((r) => r.changed).flatMap((r) => (r.probes ?? []).map((pr) => h('li', { text: `${taskName(r.taskIri)}: ${pr.hypothesis}` }))))) : null,
      plans.length ? field('Note', input(st.note, (e) => { st.note = e.target.value; }), { optional: true }) : null,
      plans.length ? h('div', null, btn('Sign and submit for approval', { variant: 'primary', disabled: !p || !op || (p.planKind === 'valued' && !st.basis),
        why: !op ? WHY.operator : 'Choose how you\'ll compare first.', on: () => {
          const val = (data().valuations ?? []).find((x) => x.valuationIri === st.valuationIri);
          act('wrd.submit_decision', 'wrd:submit-decision', {
            planIri: st.planIri, ...(st.note ? { note: st.note } : {}),
            ...(p?.planKind === 'valued' ? { valuationIri: st.valuationIri, valuationHash: val?.valuationHash, measurementPlan: { metric: st.metric, comparisonBasis: st.basis, windowWeeks: st.windowWeeks, ...(st.description ? { comparisonDescription: st.description } : {}) } } : {}),
          });
        } })) : null,
      plans.length ? hint('Once submitted, a decision can\'t be withdrawn; an approver declines it instead.') : null,
      op ? null : whyNot(WHY.operator),
    ].flat().filter(Boolean));
  };
  draw();
  return h('details', { class: 'card view-section submit-card', id: 'submit', open: S.showSubmit ? true : undefined },
    h('summary', { class: 'card__header' }, h('span', { class: 'card__title', text: 'Submit a plan for approval' })), body);
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
  const csNote = input('', null, { placeholder: 'Anything the team should know' });
  const cur = v?.result?.currency;
  const fmt = (n) => (cur ? money(n, cur) : num(n, 0));
  const steps = new Map();
  for (const x of d.preparedBy ?? []) steps.set(personOf(x), [...(steps.get(personOf(x)) ?? []), { proposed: 'proposed', valued: 'priced', submitted: 'submitted' }[x.role] ?? x.role]);
  const prepared = [...steps].map(([who, did]) => `${who} (${did.join(', ')})`).join('; ');
  const cs = d.countersign;
  const approval = cs ? `${cs.verdict === 'approve' ? 'Approved' : 'Declined'} by ${personOf(cs)} on ${day(cs.at)}${cs.objectionsConsidered.length ? `, over the objection(s) named on ${cs.objectionsConsidered.map(taskName).join(', ')}` : ''}${(cs.unacknowledgedConsidered ?? []).length ? `, over the silence of the person named on ${cs.unacknowledgedConsidered.map(taskName).join(', ')}` : ''}` : 'Not yet';
  const nextText = d.next ? (d.decisionKind === 'probe' ? 'A trial signal fired: sort the task again before the next change.' : d.status === 'countersigned' ? 'Results are due when the measurement period ends.' : 'Something about this decision needs attention.') : '';
  return h('section', { class: 'card decision view-section', 'aria-labelledby': 'decision-title' },
    h('div', { class: 'card__header' }, h('div', null, h('span', { class: 'eyebrow', text: 'Decision' }), h('h2', { class: 'card__title', id: 'decision-title', text: decisionTitle(d) })),
      h('div', { class: 'cluster' }, decisionStatus(d), sampleBadge(d))),
    h('div', { class: 'card__body' },
      kv([
        d.prediction ? ['Prediction', [h('p', { text: `${metricName(d.prediction.metric)}: likely ${fmt(d.prediction.band?.p50)} a week` }), rangePair([['80% range, at full effect', d.prediction.band, fmt]]),
          h('p', { class: 'text-sm text-secondary', text: `Ramp-up ${plural(d.prediction.rampMonths, 'month')}.` })]] : ['Prediction', 'A trial decision: never priced.'],
        d.measurementPlan ? ['Measurement', `${plural(d.measurementPlan.windowWeeks, 'week')} after approval · ${COMPARISON_NAMES[d.measurementPlan.comparisonBasis] ?? d.basisLabel}`] : null,
        ['Prepared by', prepared || personOf(d.submittedBy)],
        ['Whose work it changes', d.subjects.map((s) => labelOf(s.address)).join(', ') || 'No one'],
        ['Level', LEVEL_NAMES[d.decisionLevel] ?? d.decisionLevel ?? '—'],
        d.assignments.length ? ['Assignments', h('div', { class: 'stack stack--sm' }, d.assignments.map((a) => { const [t, tone] = ASSIGNMENT_STATE[a.state] ?? [a.state, '']; return h('div', { class: 'assignment' }, h('span', { text: `${labelOf(a.personAddress)} on ${taskName(a.taskIri)}` }), status(t, tone), a.note ? h('span', { class: 'text-sm text-secondary', text: `“${a.note}”` }) : null); }))] : null,
        d.grantChecks.length ? ['AI permissions', h('div', { class: 'stack stack--sm' }, d.grantChecks.map((g) => h('div', { class: 'assignment' }, h('span', { text: `${taskName(g.taskIri)}: ${g.active ? 'active' : 'not active'}` }), g.evidenceFromThisTask ? null : badge('Earned on other tasks', 'warning'))))] : null,
        ['Approval', approval],
      ]),
      d.outcome ? outcomeNode(d, fmt) : null,
      d.next ? [note(nextText, 'warning'), techDetails('Technical details', d.next)] : null,
      d.status === 'submitted' ? h('div', { class: 'card decision__approve' }, h('div', { class: 'card__body stack' },
        h('h3', { text: 'Approve or decline' }),
        h('p', { text: 'You\'re approving the plan exactly as priced. Approval re-checks that every changed task is still confirmed and undisputed.' }),
        hint('You can approve only if you didn\'t prepare this plan, it doesn\'t change your own work, and it doesn\'t use an AI agent you own.'),
        liveObjections.map((a) => choice('checkbox', '', `Approve anyway, noting that ${labelOf(a.personAddress)} objected on ${taskName(a.taskIri)}: “${a.note ?? ''}”`, { on: (e) => { if (e.target.checked) considered.add(a.taskIri); else considered.delete(a.taskIri); } })),
        liveSilent.map((a) => choice('checkbox', '', `Approve anyway, noting that ${labelOf(a.personAddress)} hasn't responded on ${taskName(a.taskIri)}`, { on: (e) => { if (e.target.checked) overSilence.add(a.taskIri); else overSilence.delete(a.taskIri); } })),
        field('Note', csNote, { optional: true }),
        h('div', { class: 'btn-group' },
          btn('Approve', { variant: 'primary', disabled: !can('approver'), why: WHY.approver, on: () => act('wrd.countersign_decision', 'wrd:countersign-decision', { ...binding, verdict: 'approve', objectionsConsidered: [...considered], unacknowledgedConsidered: [...overSilence], ...(csNote.value ? { note: csNote.value } : {}) }) }),
          btn('Decline', { variant: 'danger-quiet', disabled: !can('approver'), why: WHY.approver, on: () => act('wrd.countersign_decision', 'wrd:countersign-decision', { ...binding, verdict: 'decline', ...(csNote.value ? { note: csNote.value } : {}) }) }),
          payloadButton('wrd:countersign-decision', { decision_iri: d.decisionIri })),
        footnote())) : null,
      d.status === 'countersigned' ? outcomeForm(d, binding) : null,
      h('h3', { class: 'decision__history-title', text: d.chainUnreadable ? CHAIN_CUT : CHAIN_WHOLE }),
      d.chainUnreadable ? note(d.chainUnreadable, 'danger') : null,
      table(['#', 'Status', 'Signed by', 'When'], d.chain.map((c) => h('tr', null, td({ class: 'num' }, String(c.version)), td(null, CHAIN_STATUS[c.status] ?? c.status), td(null, c.signedBy.map((x) => shortName(labelOf(addrOfDid(x)))).join(', ')), td(null, day(c.at)))),
        { label: 'History', compact: true }),
      techDetails('Technical details', `status ${d.status} · ${d.statusLabel}`, d.basisLabel ? `basis ${d.basisLabel}` : null, d.prediction ? `prediction ${d.prediction.status}` : null,
        d.chain.map((c) => `Version ${c.version}: Modal status ${c.modalStatus} · ${c.descriptorUrl} · ${when(c.at)}`))),
    h('div', { class: 'card__footer' }, btn('Print summary', { icon: 'document', on: () => printDecision(d, v) })));
}

function outcomeNode(d, fmt = (n) => num(n, 0)) {
  const o = d.outcome;
  const dispo = `${OUTCOME_NAMES[o.disposition] ?? o.disposition}${o.dispositionNote ? ` — ${o.dispositionNote}` : ''}`;
  if (o.valued) {
    const x = o.valued;
    const [t, tone] = VERDICT_NAMES[x.verdict] ?? [x.verdict, ''];
    return h('div', { class: 'outcome stack stack--sm' }, h('div', { class: 'split' }, h('h3', { text: 'Results' }), status(t, tone)),
      h('p', { text: `Measured ${fmt(x.measured.weeklyValueDelta)} a week${x.measured.interval ? ` (range ${fmt(x.measured.interval.low)} to ${fmt(x.measured.interval.high)})` : ''} against the prediction${x.rampAdjusted ? ' adjusted for ramp-up' : ''}: ${band(x.adjustedBand, fmt)}. Period ${day(x.measured.windowStart)} to ${day(x.measured.windowEnd)}; ${COMPARISON_NAMES[x.measured.comparisonBasis] ?? x.measured.comparisonBasis}${x.basisChanged ? ' (not how the plan said it would be compared)' : ''}.` }),
      x.measured.method ? h('p', { class: 'text-sm text-secondary', text: x.measured.method }) : null,
      x.windowShorterThanPlanned ? note(`Measured over less than the planned period (the change was ${(OUTCOME_NAMES[o.disposition] ?? o.disposition).toLowerCase()}): left out of the track record.`, 'warning') : null,
      x.pilotCheck ? h('p', { class: 'text-sm', text: `Pilot check: ${plural(x.pilotCheck.reviewedRuns, 'piece')} of reviewed AI work in the period, ${plural(x.pilotCheck.criticalFailures, 'critical failure')}; ${x.pilotCheck.ceilingSupported ? 'enough clean runs to show the failure rate is below the ceiling' : `not enough to show it (needs ${num(x.pilotCheck.runsNeeded, 0)} clean runs)`}.${x.pilotCheck.declared ? ` Declared by the person recording: ${x.pilotCheck.declared.runsObserved ?? '—'} runs, ${x.pilotCheck.declared.criticalFailuresObserved ?? '—'} critical failure(s) (not counted).` : ''}` }) : null,
      h('p', { class: 'text-sm', text: `What happened: ${dispo}. Recorded by ${personOf(o)} on ${day(o.at)}.` }),
      techDetails('Technical details', `verdict ${x.verdict}; ramp factor ${num(x.rampFactor, 3)}; window ${when(x.measured.windowStart)} to ${when(x.measured.windowEnd)}; basis ${x.measured.comparisonBasis}`));
  }
  return h('div', { class: 'outcome stack stack--sm' }, h('h3', { text: 'Results' }),
    (o.probes ?? []).map((p) => h('p', { text: `${taskName(p.taskIri)}, trial ${p.index}: ${SIGNAL_NAMES[p.signal] ?? p.signal}${p.pastTimebox ? ' (ran past its time limit)' : ''} — ${p.observed}` })),
    h('p', { class: 'text-sm', text: `What happened: ${dispo}. Recorded by ${personOf(o)}.` }));
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
  const due = windowEnds(d) <= nowMs();
  const dateHint = 'Date and time, for example 2027-03-01T00:00:00Z';
  return h('div', { class: 'card decision__record' }, h('div', { class: 'card__body stack' },
    h('h3', { text: 'Record results' }),
    h('p', { text: 'Record what actually happened over the whole measurement period. If the change was reversed or stopped early, say why.' }),
    hint('Only someone who neither prepared nor approved this decision, after the measurement period has ended.'),
    due ? null : note(`The measurement period ends on ${day(new Date(windowEnds(d)).toISOString())}.`, 'info'),
    h('div', { class: 'form-row' },
      field('What happened to the change', select((data().vocabulary?.dispositions?.outcome ?? Object.keys(OUTCOME_NAMES)).map((x) => [x, OUTCOME_NAMES[x] ?? x]), st.disposition, (e) => { st.disposition = e.target.value; })),
      field('Reason', input('', (e) => { st.note = e.target.value; }), { hint: 'Needed unless the change was kept.' })),
    d.decisionKind === 'valued' ? [
      h('div', { class: 'form-row form-row--3' },
        field(`Measured ${metricName(d.prediction?.metric ?? '').toLowerCase()} per week`, input('', (e) => { st.measured = e.target.value; }, { type: 'number', step: 'any' })),
        field('Range low', input('', (e) => { st.low = e.target.value; }, { type: 'number', step: 'any' }), { optional: true }),
        field('Range high', input('', (e) => { st.high = e.target.value; }, { type: 'number', step: 'any' }), { optional: true })),
      field('How it was compared', select((data().vocabulary?.comparisonBases ?? []).map((x) => [x, COMPARISON_NAMES[x] ?? x]), st.basis, (e) => { st.basis = e.target.value; })),
      h('div', { class: 'form-row' },
        field('Period start', input(st.windowStart, (e) => { st.windowStart = e.target.value.trim(); }), { hint: dateHint }),
        field('Period end', input(st.windowEnd, (e) => { st.windowEnd = e.target.value.trim(); }), { hint: dateHint })),
      field('How it was measured', input('', (e) => { st.method = e.target.value; })),
      h('div', { class: 'form-row' },
        field('AI runs seen (as declared)', input('', (e) => { st.runs = e.target.value; }, { type: 'number', min: 0 }), { optional: true }),
        field('Critical failures seen (as declared)', input('', (e) => { st.critical = e.target.value; }, { type: 'number', min: 0 }), { optional: true })),
    ] : st.probes.map((p) => h('div', { class: 'card trial' }, h('div', { class: 'card__body stack stack--sm' }, h('h4', { text: `Trial ${p.index} on ${taskName(p.taskIri)}` }),
      field('What happened', select(['amplify', 'dampen', 'neither'].map((x) => [x, SIGNAL_NAMES[x]]), p.signal, (e) => { p.signal = e.target.value; })),
      field('What you observed', input('', (e) => { p.observed = e.target.value; })),
      h('div', { class: 'form-row' },
        field('Period start', input(p.windowStart, (e) => { p.windowStart = e.target.value.trim(); }), { hint: dateHint }),
        field('Period end', input(p.windowEnd, (e) => { p.windowEnd = e.target.value.trim(); }), { hint: dateHint }))))),
    h('div', null, btn('Sign and record results', { variant: 'primary', on: send, disabled: !(can('operator') || can('approver')), why: 'Only process leads and approvers can record results.' })),
    footnote()));
}

function printDecision(d, v) {
  const target = document.getElementById('print');
  if (!target) return;
  const r = v?.result;
  const [st] = DECISION_STATUS[d.status] ?? [d.statusLabel];
  const fmt = (n) => (r ? money(n, r.currency) : num(n, 0));
  target.replaceChildren(h('article', { class: 'print-record' },
    h('div', { class: 'print-record__head' }, h('div', null, h('p', { class: 'print-record__brand', text: 'Interego · Work Redesign' }), h('h1', { class: 'print-record__title', text: `Decision: ${decisionTitle(d)}` })),
      h('span', { class: 'print-record__status', text: st })),
    d.demo ? note('Demo workspace: sample data, not real signatures.', 'warning') : null,
    h('dl', { class: 'print-record__meta' }, h('dt', { text: 'Workspace' }), h('dd', { text: workspaceLabel(data().podUrl) }), h('dt', { text: 'Kind' }), h('dd', { text: PLAN_KIND[d.decisionKind] ?? d.decisionKind }),
      h('dt', { text: 'Measurement' }), h('dd', { text: d.measurementPlan ? `${plural(d.measurementPlan.windowWeeks, 'week')} · ${COMPARISON_NAMES[d.measurementPlan.comparisonBasis] ?? d.basisLabel}` : 'Trials' })),
    h('section', { class: 'print-record__section' }, h('h2', { text: 'Prediction' }),
      d.prediction ? h('p', { text: `${metricName(d.prediction.metric)}: ${band(d.prediction.band, fmt)} a week; ramp-up ${plural(d.prediction.rampMonths, 'month')}.` }) : h('p', { text: 'A trial decision: never priced.' }),
      r ? h('p', { text: `Weekly cash impact ${band(r.scenarios.cash.weeklyDelta, fmt)}; if freed time is redeployed ${band(r.scenarios.redeployed.weeklyDelta, fmt)}. Net present value (cash) ${band(r.scenarios.cash.npv, fmt)}.` }) : null),
    d.outcome ? h('section', { class: 'print-record__section' }, outcomeNode(d, fmt)) : null,
    h('section', { class: 'print-record__section' },
      h('h2', { text: d.chainUnreadable ? CHAIN_CUT : CHAIN_WHOLE }),
      d.chainUnreadable ? note(`${CHAIN_CUT_PRINT} ${d.chainUnreadable}`, 'danger') : null,
      table(['#', 'Status', 'Signed by', 'When'], d.chain.map((c) => h('tr', null, td(null, String(c.version)), td(null, CHAIN_STATUS[c.status] ?? c.status), td(null, c.signedBy.join(', ')), td(null, when(c.at)))), { label: 'History', stack: false })),
    h('p', { text: NO_TOTALS }),
    h('div', { class: 'print-record__foot', text: `Workspace ${data().podUrl} · Decision ${d.decisionIri}${r ? ` · Reproducibility code: seed ${r.seed}, ${r.draws} runs` : ''}. Verify a downloaded record against the workspace signature ID ${data().bridge?.platform?.address ?? ''}.` })));
  window.print();
}

// ── Track record ─────────────────────────────────────────────────────────────────────────

const calStatus = (s, min) => {
  const [t, tone] = CAL_STATUS[s] ?? [s, ''];
  return status(s === 'Hypothetical' && min ? `Early: fewer than ${min} results` : t, tone);
};

/** One figure in a row of figures: label, value, and a short line under it. */
const tile = (label, value, meta) => h('div', { class: 'stat' }, h('p', { class: 'stat__label', text: label }), h('p', { class: 'stat__value', text: value }), meta ? h('p', { class: 'stat__meta', text: meta }) : null);

function calibrationView() {
  const c = S.cal;
  const header = pageHeader({ title: 'Track record', lede: 'Did our predictions land, and how reliable is each AI agent\'s work?',
    meta: [allDemo() || c?.predictionCells?.some((x) => x.scriptedLabel) || c?.agentCells?.some((x) => x.scriptedLabel) ? badge('Sample data', 'demo') : null] });
  if (!c) {
    if (S.calFailed) return [header, emptyState({ icon: 'chart', title: 'We couldn\'t load the track record', text: 'Please try again in a minute.', actions: [btn('Try again', { variant: 'primary', on: () => refresh() })] })];
    return [header, h('div', { 'aria-busy': 'true', class: 'stack' }, h('span', { class: 'visually-hidden', text: 'Loading the track record…' }),
      h('span', { class: 'skeleton skeleton--title' }), h('span', { class: 'skeleton skeleton--block' }), h('span', { class: 'skeleton skeleton--title' }), h('span', { class: 'skeleton skeleton--block' }))];
  }
  const cells = c.predictionCells ?? [];
  const agents = c.agentCells ?? [];
  const ps = c.probeSignals;
  return [
    header,
    c.recordKeyMismatch ? [note('Some records can\'t be opened, so the track record may be incomplete.', 'danger'), techDetails('Technical details', `Another record key: ${c.recordKeyMismatch.why}`)] : null,
    Object.keys(c.unreadable ?? {}).length ? [note('Some records can\'t be read, so parts of the track record are marked rather than worked out.', 'danger'), techDetails('Technical details', Object.values(c.unreadable))] : null,
    h('section', { class: 'view-section track-predictions' }, h('h2', { class: 'view-section__title', text: 'How our predictions landed' }),
      hint(`A result lands within prediction when it falls in the predicted 80% range, adjusted for ramp-up. We aim for about 80%. Ratings stay "Early" until there are ${c.minSamples ?? 20} results. Inconclusive results are left out, but counted.`),
      cells.length === 0
        ? emptyState({ icon: 'chart', title: 'No measured results yet', text: 'Your track record starts when the first approved decision\'s measurement period ends and someone records the results.', actions: [btn('Go to Decisions', { size: 'sm', on: () => goTab('decisions') })], plain: true })
        : [h('div', { class: 'track-cards', role: 'list', 'aria-label': 'Predictions' }, cells.map((x) => h('article', { class: 'card track-card', role: 'listitem' },
          h('div', { class: 'card__header' },
            h('div', null, h('h3', { class: 'card__title', text: x.metric ? metricName(x.metric) : x.label }), x.level ? h('p', { class: 'card__subtitle', text: LEVEL_NAMES[x.level] ?? x.level }) : null),
            h('div', { class: 'cluster' }, x.basisClass === 'uncontrolled' ? badge('No comparison group', 'warning') : null, calStatus(x.status, c.minSamples))),
          h('div', { class: 'card__body' }, h('div', { class: 'stat-grid stat-grid--flat' },
            tile('Results', String(x.samples), `Left out: ${x.excludedInconclusive} inconclusive, ${x.excludedShortWindow ?? 0} short period`),
            tile('Landed within prediction', pct(x.hitRate), 'Aim: about 80%'),
            tile('Accuracy score', num(x.meanBrier, 3), 'Lower is better')))))),
        techDetails('Technical details', cells.map((x) => `${x.label}: Mean Brier ${num(x.meanBrier, 3)}; mean level distance ${num(x.meanOrdinalDistance, 3)}; ramp-adjusted ${x.rampAdjusted}; dispositions ${Object.entries(x.dispositions).map(([k, n]) => `${k} ${n}`).join(', ')}; status ${x.status}${x.scriptedLabel ? `; ${x.scriptedLabel}` : ''}`), `nominal coverage ${c.nominalBandCoverage}`)]),
    h('section', { class: 'view-section' }, h('h2', { class: 'view-section__title', text: 'Trial results' }),
      h('p', { class: 'text-secondary', text: 'Trials don\'t predict, so they aren\'t scored.' }),
      ps ? h('p', { text: `${plural(ps.probes, 'trial')}: ${ps.amplify} scale up, ${ps.dampen} scale back, ${ps.neither} no clear signal; a declared condition fired ${plural(ps.conditionFired, 'time')}.` }) : h('p', { class: 'text-tertiary', text: 'No trial results yet.' }),
      ps ? techDetails('Technical details', ps.label, ps.scriptedLabel ?? null) : null),
    h('section', { class: 'view-section' }, h('h2', { class: 'view-section__title', text: 'AI agents' }),
      hint('"Accepted by reviewers" is what AI permission rests on. How often the AI judged itself correctly is shown for information only: an agent that honestly marks its own failures still earns nothing.'),
      agents.length === 0 ? emptyState({ icon: 'sparkle', title: 'No reviewed AI work yet', text: 'Once people review the work an AI agent does, its record shows here.', plain: true })
        : [h('div', { class: 'track-cards', role: 'list', 'aria-label': 'AI agents\' track record' }, agents.map((x) => h('article', { class: 'card track-card', role: 'listitem' },
          h('div', { class: 'card__header' },
            h('div', null, h('h3', { class: 'card__title', text: labelOf(x.agentAddress) }), h('p', { class: 'card__subtitle', text: `${kindLabel(x.taskKind)} · AI model ${x.model}` })),
            h('div', { class: 'cluster' }, x.currentModel ? null : badge('Not its current model', 'warning'), calStatus(x.status, c.minSamples))),
          h('div', { class: 'card__body' }, h('div', { class: 'stat-grid stat-grid--flat' },
            tile('Accepted by reviewers', pct(x.acceptedShare), `Out of ${x.samples} reviewed`),
            tile('Judged itself correctly', pct(x.hitRate), 'For information only'),
            tile('Said "ready"', String(x.readyClaims ?? '—'), `People agreed ${pct(x.readyClaimPrecision)}`),
            tile('Different reviewers', String(x.distinctConfirmers), 'Your admin vouches that these are different people. Work Redesign can\'t check that.')),
          h('p', { class: 'track-card__permission' }, h('strong', { text: 'AI permission: ' }), x.grant.active ? status('Active', 'success') : h('span', { class: 'text-secondary', text: plainGrantReason(x.grant.evaluation ?? x) })))))),
        techDetails('Technical details', agents.map((x) => `${labelOf(x.agentAddress)} on ${x.taskKind}: Mean Brier ${num(x.meanBrier, 3)}; ${x.distinctConfirmers} ${x.distinctConfirmersNote}; permission ${x.grant.active ? 'active' : x.grant.why}${x.scriptedLabel ? `; ${x.scriptedLabel}` : ''}`))]),
    (c.awaitingAPerson ?? []).length ? note(`${plural(c.awaitingAPerson.length, 'piece')} of AI work done on its own ${c.awaitingAPerson.length === 1 ? 'is' : 'are'} waiting for review. They count toward nothing until a person reviews them.`, 'warning') : null,
  ];
}

// ── AI agents ────────────────────────────────────────────────────────────────────────────

function agentsView() {
  const d = data();
  const header = pageHeader({ title: 'AI agents', lede: 'Record the work your AI agents do, have people review it, and grant or withdraw permission to work alone on one type of task.', meta: [allDemo() ? badge('Sample data', 'demo') : null] });
  if (agentsList().length === 0) {
    return [header, emptyState({ icon: 'sparkle', title: 'No AI agents yet', text: 'Your admin adds each agent with its accountable owner and AI model.',
      actions: [btn('Add an AI agent', { variant: 'primary', on: () => { goTab('roles'); memberPanel(null, 'agent'); } })] })];
  }
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
    const verdict = select(RUN_VERDICTS, 'accepted');
    const noteBox = input('', null, { placeholder: 'What you noticed' });
    openPanel(`Review ${labelOf(a.agentAddress)}'s work on "${taskName(a.taskIri)}"`, h('div', { class: 'stack' },
      hint(`The AI called it: ${(RUN_VERDICTS.find(([v]) => v === a.runEnvelope.payload.selfAssessment?.answer) ?? [0, a.runEnvelope.payload.selfAssessment?.answer ?? 'not stated'])[1]}. Your verdict is what counts. The agent's owner can't review its work.`),
      field('Your verdict', verdict), field('Note', noteBox, { optional: true }),
      h('div', null, btn('Sign the review', { variant: 'primary', on: async () => {
        let env;
        try { env = await sign({ intent: 'wrd:review-agent-run', podUrl: d.podUrl, runEnvelopeSha256: await envelopeSha256(a.runEnvelope), verdict: verdict.value, ...(noteBox.value ? { note: noteBox.value } : {}) }); } catch { return; }
        send('wrd.log_agent_run', { run_envelope: a.runEnvelope, review_envelope: env });
      } })), footnote()));
  };
  const grantForm = { agent: agentsList()[0]?.address ?? '', kind: kindsList(false)[0]?.slug ?? '' };
  const waiting = d.awaitingReview ?? [];
  const reviewer = can('operator') || can('approver');
  return [
    header,
    viewSection('Waiting for review', 'Work an agent did on its own, waiting for a person.',
      d.unreadable?.awaitingReview ? [note('Some AI work waiting for review can\'t be read.', 'danger'), techDetails('Technical details', d.unreadable.awaitingReview)] : null,
      waiting.length === 0
        ? h('div', { class: 'card' }, emptyState({ icon: 'check', title: 'No AI work waiting for review', text: 'Work an agent does on its own appears here until a person reviews it. Unreviewed work counts toward nothing.', plain: true }))
        : h('div', { class: 'card' }, h('ul', { class: 'list' }, waiting.map((a) => h('li', { class: 'list__item' },
          h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: `${labelOf(a.agentAddress)} on ${taskName(a.taskIri)}` }), h('span', { class: 'list__meta', text: kindLabel(a.taskKind) })),
          h('span', { class: 'list__end' }, sampleBadge(a), btn('Review', { variant: 'primary', size: 'sm', on: () => reviewPanel(a), disabled: !reviewer || ownsAgent(a.agentAddress), why: ownsAgent(a.agentAddress) ? 'You own this agent, so someone else must review its work.' : 'Only process leads and approvers review AI work.' })))))) ),
    viewSection('AI work so far', '', (d.runs ?? []).length === 0 ? h('p', { class: 'text-tertiary', text: 'No AI work recorded yet.' })
      : table(['AI agent', 'Type of task', 'AI model', '#Reviewed', '#Done on its own', 'Cost reported by the AI (reviewed work only)'], (d.runs ?? []).map((r) => h('tr', null,
        td(null, h('span', { class: 'table__primary', text: labelOf(r.agentAddress) })), td(null, kindLabel(r.taskKind)), td(null, r.model), td({ class: 'num' }, String(r.reviewed)), td({ class: 'num' }, String(r.actedUnderGrant)),
        td(null, r.reportedCost ? `${num(r.reportedCost.mean, 4)} ${r.reportedCost.currency} over ${plural(r.reportedCost.runs, 'run')}` : '—'))), { label: 'AI work' }),
      d.unreadable?.runs ? [note('Some AI work records can\'t be read, so these counts may be incomplete.', 'warning'), techDetails('Technical details', d.unreadable.runs)] : null),
    viewSection('AI permissions', 'Permission to work alone on one type of task, earned from reviewed work and re-checked on every use.',
      (d.grants ?? []).length === 0
        ? emptyState({ icon: 'shield', title: 'No AI permissions yet', text: 'An agent earns permission on one type of task from reviewed work: at least 20 pieces accepted at 90% or better, from at least 5 different reviewers.', plain: true })
        : table(['AI agent', 'Accountable owner', 'Status', 'Track record', ''], (d.grants ?? []).map((g) => h('tr', null,
          td(null, h('span', { class: 'table__primary', text: labelOf(g.agentAddress) }), h('span', { class: 'table__secondary', text: `${kindLabel(g.taskKind)} · ${g.model}` })),
          td(null, labelOf(g.principal)),
          td(null, status(g.active ? 'Active' : 'Withdrawn', g.active ? 'success' : 'danger'), g.active ? null : h('span', { class: 'table__secondary', text: g.revokedAt ? `Withdrawn ${day(g.revokedAt)}${g.revocationWhy ? `: ${g.revocationWhy}` : ''}` : 'Not in force' }), sampleBadge(g),
            g.chainUnreadable ? note(g.chainUnreadable, 'danger', 'div') : null),
          td(null, h('span', { class: 'text-sm', text: `${g.evaluation.samples} reviewed · ${pct(g.evaluation.acceptedShare)} accepted · ${g.evaluation.distinctConfirmers} different reviewers · ${g.evaluation.readyClaims ?? '—'} "ready" claims, ${pct(g.evaluation.readyClaimPrecision)} agreed` }),
            h('span', { class: 'table__secondary', text: `From ${g.evidenceTaskIris.map(taskName).join(', ')}` })),
          td({ class: 'actions' }, g.status === 'granted' ? btn('Withdraw…', { variant: 'danger-quiet', size: 'sm', on: () => revokePanel(g), disabled: !can('approver'), why: WHY.approver }) : null))), { label: 'AI permissions' }),
      (d.grants ?? []).length ? techDetails('Technical details', (d.grants ?? []).map((g) => `${labelOf(g.agentAddress)} on ${g.taskKind}: ${g.status}; ${g.why}${g.revokedAt ? `; revoked ${when(g.revokedAt)}: ${g.revocationWhy}` : ''}`)) : null),
    h('section', { class: 'card view-section', 'aria-labelledby': 'grant-title' }, h('div', { class: 'card__body stack' },
      h('h2', { class: 'card__title', id: 'grant-title', text: 'Grant AI permission' }),
      hint('Lets one AI agent do one type of task on its own, on the AI model it was checked on. Earned from reviewed work, re-checked on every use, and can be withdrawn at any time. The agent\'s owner can\'t grant it.'),
      h('div', { class: 'form-row' },
        field('AI agent', select(agentsList().map((m) => [m.address, `${m.label} — ${m.model}`]), grantForm.agent, (e) => { grantForm.agent = e.target.value; })),
        field('Type of task', select(kindsList(false).map((k) => [k.slug, k.label]), grantForm.kind, (e) => { grantForm.kind = e.target.value; }))),
      h('div', null, btn('Check the track record and grant', { variant: 'primary', disabled: !can('approver'), why: WHY.approver, on: () => act('wrd.grant_autonomy', 'wrd:grant-autonomy', { agentAddress: grantForm.agent, taskKind: grantForm.kind }) })),
      can('approver') ? footnote() : whyNot(WHY.approver))),
    h('details', { class: 'card view-section record-work' }, h('summary', { class: 'card__header' }, h('span', { class: 'card__title', text: 'Record AI work' })),
      h('div', { class: 'card__body stack' },
        S.mode === 'demo' ? [
          h('div', { class: 'form-row' },
            field('Signed by the AI agent (demo person)', select(agentPersonas.map((p) => [p.id, p.label]), st.persona, (e) => { st.persona = e.target.value; })),
            field('Task', select(tasks().filter((t) => t.status !== 'retired').map((t) => [t.taskIri, `${t.name} (${kindLabel(t.taskKind)})`]), st.taskIri, (e) => { st.taskIri = e.target.value; }))),
          field('Work ID', input(st.runId, (e) => { st.runId = e.target.value; })),
          field('The output (only its fingerprint is recorded)', textarea('', (e) => { st.output = e.target.value; })),
          field('The AI\'s own verdict', select([['accepted', 'Ready to accept'], ['reworked', 'Needs rework'], ['critical-failure', 'Critical failure']], st.answer, (e) => { st.answer = e.target.value; })),
          h('div', { class: 'form-row' }, field('Cost of this work', input('', (e) => { st.cost = e.target.value; }, { type: 'number', step: 'any', min: 0 }), { optional: true }), field('Currency', input(st.currency, (e) => { st.currency = e.target.value.toUpperCase(); }))),
          choice('checkbox', '', 'The agent did this on its own, under its permission', { help: 'Only work it calls ready, on a task an approved decision put under the permission.', on: (e) => { st.underGrant = e.target.checked; } }),
        ] : field('Paste the AI agent\'s signed work record', textarea('', (e) => { st.pasted = e.target.value; }, { class: 'textarea textarea--tall textarea--mono' }), { hint: 'The agent signs each work record with its own key; Work Redesign never holds it. Paste the JSON it produced.' }),
        choice('checkbox', '', 'Review it now, as me', { checked: true, on: (e) => { st.review = e.target.checked; } }),
        h('div', { class: 'form-row' },
          field('Your verdict', select(RUN_VERDICTS, st.verdict, (e) => { st.verdict = e.target.value; })),
          field('Review note', input('', (e) => { st.note = e.target.value; }), { optional: true })),
        h('div', null, btn('Sign and record', { variant: 'primary', on: logRun })), footnote())),
  ];
}

function revokePanel(g) {
  const why = textarea('', null, { placeholder: 'Why the permission is withdrawn' });
  openPanel(`Withdraw ${labelOf(g.agentAddress)}'s permission on ${kindLabel(g.taskKind)}`, h('div', { class: 'stack' },
    hint('Every later use is refused. Re-earning counts only work reviewed from now on.'),
    field('Why', why),
    h('div', null, btn('Withdraw permission', { variant: 'danger', on: () => act('wrd.revoke_grant', 'wrd:revoke-grant', { grantIri: g.grantIri, recordId: g.head.recordId, descriptorUrl: g.head.descriptorUrl, graphDigest: g.head.graphDigest, why: why.value.trim() }) })),
    footnote()));
}

function evaluationNode(e) {
  if (!e) return null;
  return h('div', { class: 'text-sm' }, h('div', null, e.earned ? badge('earned', 'success') : badge('not earned', 'warning'), ` ${e.why}`),
    h('div', { text: `${e.samples} person-reviewed run(s) on model ${e.model}${e.countedSince ? ` since ${when(e.countedSince)}` : ''}; ${pct(e.acceptedShare)} of them accepted by a person (the competence rating, ${num(e.rating, 3)}); ${e.distinctConfirmers} ${e.distinctConfirmersNote}; ${e.readyClaims ?? '—'} run(s) the agent called ready, ${pct(e.readyClaimPrecision)} of them accepted; ${e.criticalFailures} critical failure(s).` }));
}

// ── People & roles ───────────────────────────────────────────────────────────────────────

/** How a member signs in, as a person reads it; the full value is what Copy copies. */
function signsInWith(address) {
  if (/^did:web:/.test(address)) return h('div', { class: 'stack stack--sm' }, h('span', { text: 'Interego ID' }), h('span', { class: 'cluster' }, h('code', { text: userIdOf(address) }), btn('Copy', { variant: 'ghost', size: 'sm', on: () => copyText(address, 'Interego ID') })));
  return h('div', { class: 'stack stack--sm' }, h('span', { text: 'Wallet address' }), h('code', { text: short(address) }));
}

function rolesView() {
  const r = reg();
  const v = data().vocabulary ?? {};
  const gp = v.grantPolicy ?? {};
  const pp = v.podPolicy ?? null;
  const admins = data().bridge?.admins ?? 0;
  const remove = (m) => act('wrd.update_registry', 'wrd:update-registry', { entries: [{ address: m.address, roles: [] }] });
  const ppNames = { maxLevel: 'Highest level allowed', floor: 'Minimum acceptance rate', minSamples: 'Reviewed pieces of work needed', minHumanConfirmations: 'People confirmations needed', minDistinctConfirmers: 'Different reviewers needed' };
  return [
    pageHeader({ title: 'People & roles', lede: 'Who\'s in this workspace, what each person may do, the types of task you work with, and the rules for AI permission.',
      meta: [allDemo() ? badge('Sample data', 'demo') : null],
      actions: [btn('Add a person', { variant: 'primary', icon: 'people', on: () => memberPanel(null) }), btn('Add an AI agent', { icon: 'sparkle', on: () => memberPanel(null, 'agent') })] }),
    hint(`Only an admin's signature changes this page. Your workspace has ${plural(admins, 'admin')}.`),
    viewSection('People', '', people().length === 0
      ? emptyState({ icon: 'people', title: 'Add your team', text: 'Add the people who do, lead and approve the work, then your AI agents and your types of task.', actions: [btn('Add a person', { variant: 'primary', on: () => memberPanel(null) })] })
      : table(['Name', 'Signs in with', 'Roles', ''], people().map((m) => h('tr', null,
        td(null, h('span', { class: 'table__primary', text: m.label }), m.personRef ? h('span', { class: 'table__secondary', text: `Person ID ${m.personRef}` }) : null),
        td(null, signsInWith(m.address)),
        td(null, h('div', { class: 'cluster' }, rolesPlain(m.roles).map((x) => badge(x, 'accent')))),
        td({ class: 'actions' }, h('div', { class: 'row-actions row-actions--inline' }, btn('Edit', { variant: 'ghost', size: 'sm', on: () => memberPanel(m) }), btn('Remove', { variant: 'danger-quiet', size: 'sm', on: () => remove(m) }))))), { label: 'People' })),
    viewSection('AI agents', '', agentsList().length === 0
      ? emptyState({ icon: 'sparkle', title: 'No AI agents yet', text: 'Add each agent with its accountable owner and the AI model it runs on.', plain: true })
      : table(['Name', 'Accountable owner', 'AI model in use', 'Signs with', ''], agentsList().map((m) => h('tr', null,
        td(null, h('span', { class: 'table__primary', text: m.label })), td(null, m.principal ? labelOf(m.principal) : '—'), td(null, m.model ?? '—'), td(null, h('code', { text: short(m.address) })),
        td({ class: 'actions' }, h('div', { class: 'row-actions row-actions--inline' }, btn('Edit', { variant: 'ghost', size: 'sm', on: () => memberPanel(m) }), btn('Remove', { variant: 'danger-quiet', size: 'sm', on: () => remove(m) }))))), { label: 'AI agents' })),
    viewSection('Types of task', 'Types of task group similar work. AI permissions are earned one type at a time.',
      r.taskKinds.length === 0 ? emptyState({ icon: 'clipboard', title: 'No types of task yet', text: 'Types of task group similar work, for example "Invoice matching". AI permissions are earned one type at a time.', plain: true })
        : table(['Name', 'Definition', 'Status', ''], r.taskKinds.map((k) => h('tr', null,
          td(null, h('span', { class: 'table__primary', text: k.label }), h('span', { class: 'table__secondary', text: `ID: ${k.slug}` })), td(null, k.definition),
          td(null, k.retired ? badge('Retired') : status('In use', 'success')),
          td({ class: 'actions' }, k.retired ? null : btn('Retire', { variant: 'ghost', size: 'sm', on: () => act('wrd.update_registry', 'wrd:update-registry', { taskKinds: [{ slug: k.slug, retire: true }] }) })))), { label: 'Types of task' }),
      kindForm()),
    viewSection('Rules for earning AI permission', '',
      h('p', { text: `An AI agent earns permission on one type of task from at least ${gp.minSamples} pieces of work people reviewed on its current AI model, accepted at ${Math.round((gp.floor ?? 0) * 100)}% or better, confirmed by at least ${gp.minHumanConfirmations} people from at least ${gp.minDistinctConfirmers} different reviewers, and with "ready" claims accepted at ${Math.round((gp.minReadyClaimPrecision ?? 0) * 100)}% or better. Critical work needs ${gp.criticalWorkFailureCeiling ? Math.ceil(3 / gp.criticalWorkFailureCeiling) : '—'} clean runs.` }),
      h('h3', { class: 'rules-title', text: 'Workspace rules (stricter than standard)' }),
      pp && Object.keys(pp).length ? kv(Object.entries(pp).map(([k, x]) => [ppNames[k] ?? k, k === 'maxLevel' ? LEVEL_NAMES[x] ?? String(x) : k === 'floor' ? pct(x) : String(x)])) : h('p', { class: 'text-secondary', text: 'None: the standard rules apply.' }),
      policyForm(),
      techDetails('Technical details', r.head ? `Registry version ${r.head.versions}` : 'No registry yet', `Pod policy: ${pp ? JSON.stringify(pp) : 'none (the published policy applies)'}`, v.distinctPeopleNote ?? null)),
  ];
}

function memberPanel(m, kind) {
  const isAgentNow = m ? Boolean(m.softwareAgent) : kind === 'agent';
  const st = { address: m?.address ?? '', label: m?.label ?? '', roles: new Set(m?.roles ?? (isAgentNow ? ['agent'] : [])), personRef: m?.personRef ?? '', principal: m?.principal ?? '', model: m?.model ?? '' };
  const body = h('div', { class: 'stack' });
  const draw = () => {
    const agent = st.roles.has('agent');
    const box = (role, label, help) => choice('checkbox', '', label, { checked: st.roles.has(role), help, on: (e) => { if (e.target.checked) st.roles.add(role); else st.roles.delete(role); } });
    body.replaceChildren(...[
      h('fieldset', { class: 'fieldset' }, h('legend', { class: 'legend', text: 'This is' }), h('div', { class: 'choice-group choice-group--inline' },
        choice('radio', 'member-kind', 'A person', { checked: !agent, card: true, on: () => { st.roles.delete('agent'); draw(); } }),
        choice('radio', 'member-kind', 'An AI agent', { checked: agent, card: true, on: () => { st.roles = new Set(['agent']); draw(); } }))),
      h('div', { class: 'form-row' },
        field('Name', input(st.label, (e) => { st.label = e.target.value; }), { hint: agent ? 'For example "Matching agent".' : 'For example "Ana, AP operations lead".' }),
        field(agent ? 'Wallet address' : 'Interego ID or wallet address', input(st.address, (e) => { st.address = e.target.value.trim(); }),
          { hint: agent ? 'The address the agent signs its work with.' : 'An Interego ID looks like did:web:…:users:…; a wallet address starts with 0x. Ask the person to send theirs.' })),
      agent ? h('div', { class: 'form-row' },
        field('Accountable owner', select(personOptions('Choose a person'), st.principal, (e) => { st.principal = e.target.value; }), { hint: 'They can\'t review its work, approve plans that use it, or grant it permission.' }),
        field('AI model in use', input(st.model, (e) => { st.model = e.target.value; }), { hint: 'Its permission applies only to this model; a model change means earning it again.' }))
        : [h('fieldset', { class: 'fieldset' }, h('legend', { class: 'legend', text: 'Roles' }), h('div', { class: 'choice-group' },
          box('approver', 'Approver', 'Approves or declines plans they had no part in; grants and withdraws AI permissions.'),
          box('operator', 'Process lead', 'Maps processes, proposes changes and prices them.'),
          box('worker', 'Team member', 'Does the work; confirms how it\'s described.'))),
        field('Person ID', input(st.personRef, (e) => { st.personRef = e.target.value.trim(); }), { hint: 'Links one person\'s different sign-ins, so the rules treat them as one person.' })],
      techDetails('Technical details', 'Only an admin\'s signature changes the registry. A person is a key they hold (its 0x address) or, if they sign in with their Interego account, their user DID (did:web:<identity host>:users:<id>): relay-attested, not a key they hold, so whoever holds the relay\'s key or controls the identity host can act as them. A person needs a person reference (the admin\'s attestation of which human this is; a key and a user DID with one reference are one person). An agent is always a key: it needs the agent role only, an accountable principal (a registered person) and the model it runs on.'),
      h('div', null, btn('Sign and save', { variant: 'primary', on: () => {
        const isAgent = st.roles.has('agent');
        const entry = { address: st.address, roles: [...st.roles], label: st.label, softwareAgent: isAgent,
          ...(isAgent ? { principal: st.principal, model: st.model } : { personRef: st.personRef }) };
        act('wrd.update_registry', 'wrd:update-registry', { entries: [entry] });
      } })),
      footnote(),
    ].flat().filter(Boolean));
  };
  draw();
  openPanel(m ? `Change ${m.label}` : isAgentNow ? 'Add an AI agent' : 'Add a person', body);
}

function kindForm() {
  const st = { slug: '', label: '', definition: '' };
  const open = Boolean(S.openKinds);
  S.openKinds = false;
  return h('details', { class: 'card kind-form', open: open || undefined }, h('summary', { text: 'Add a type of task' }),
    h('div', { class: 'card__body stack' },
      h('div', { class: 'form-row' },
        field('Name', input('', (e) => { st.label = e.target.value; }), { hint: 'For example "Invoice matching".' }),
        field('Short ID', input('', (e) => { st.slug = e.target.value.trim(); }), { hint: 'Lowercase letters, digits and hyphens, for example invoice-matching.' })),
      field('Definition', input('', (e) => { st.definition = e.target.value; }), { hint: 'One sentence.' }),
      h('div', null, btn('Add type of task', { variant: 'primary', on: () => act('wrd.update_registry', 'wrd:update-registry', { taskKinds: [{ ...st }] }) }))));
}

function policyForm() {
  const st = {};
  const n = (key, label) => field(label, input('', (e) => { if (e.target.value === '') delete st[key]; else st[key] = Number(e.target.value); }, { type: 'number', step: key === 'floor' ? '0.01' : '1' }), { optional: true });
  return h('details', { class: 'card policy-form' }, h('summary', { text: 'Make the rules stricter (admin)' }),
    h('div', { class: 'card__body stack' },
      hint('Your admin can make the standard rules stricter, never looser.'),
      field('Highest level allowed', select([['', 'No limit'], ...Object.entries(LEVEL_NAMES)], '', (e) => { if (e.target.value) st.maxLevel = e.target.value; else delete st.maxLevel; })),
      h('div', { class: 'form-row' }, n('floor', 'Minimum acceptance rate'), n('minSamples', 'Reviewed pieces of work needed')),
      h('div', { class: 'form-row' }, n('minHumanConfirmations', 'People confirmations needed'), n('minDistinctConfirmers', 'Different reviewers needed')),
      h('div', { class: 'btn-group' },
        btn('Save stricter rules', { variant: 'primary', on: () => act('wrd.update_registry', 'wrd:update-registry', { podPolicy: { ...st } }) }),
        btn('Go back to standard rules', { on: () => act('wrd.update_registry', 'wrd:update-registry', { podPolicy: null }) }))));
}

// ── My record ────────────────────────────────────────────────────────────────────────────

function meView() {
  const me = actor();
  const header = pageHeader({ title: 'My record', lede: 'Every record that names you or carries your signature. Yours to keep: download it, or copy it to your own storage.', meta: [allDemo() ? badge('Sample data', 'demo') : null] });
  if (!me) return [header, emptyState({ icon: 'user', title: 'Sign in to see your record', text: 'Your record lists every task that names you and everything you signed.', actions: [signInButton()] }), techDetails('Technical details', READ_ONLY)];
  const did = didOfPrincipal(me);
  const d = data();
  const mine = tasks().filter((t) => t.namedParties.some((p) => p.address === me) || (t.owedRatification ?? []).some((p) => p.address === me));
  const signed = [
    ...(d.workflows ?? []).map((w) => ['Process', w.title, w]), ...tasks().map((t) => ['Task', t.name, t]),
    ...(d.plans ?? []).map((p) => ['Plan', p.title, p]), ...(d.decisions ?? []).map((x) => ['Decision', planBy(x.planIri)?.title ?? 'Decision', x]),
    ...(d.grants ?? []).map((g) => ['AI permission', `${labelOf(g.agentAddress)} on ${kindLabel(g.taskKind)}`, g]),
  ].filter(([, , row]) => row.head?.signedBy?.includes(did));
  const myPlans = (d.plans ?? []).filter((p) => p.tasks.some((r) => r.changed && [r.current.personAddress, r.current.agentAddress, r.proposed.personAddress, r.proposed.agentAddress].includes(me)));
  const freed = (d.valuations ?? []).filter((v) => myPlans.some((p) => p.planIri === v.planIri))
    .flatMap((v) => v.result.freedPersonHours.perTask.filter((f) => mine.some((t) => t.taskIri === f.taskIri)).map((f) => ({ ...f, plan: planBy(v.planIri)?.title })));
  return [
    header,
    h('div', { class: 'me-grid' },
      h('div', null,
        viewSection('Tasks that name me', '', mine.length === 0
          ? h('div', { class: 'card' }, emptyState({ icon: 'clipboard', title: 'Nothing names you yet', text: 'When you\'re named on a task or sign something, it appears here, and you can download a signed copy.', plain: true }))
          : h('div', { class: 'card' }, h('ul', { class: 'list' }, mine.map((t) => h('li', null, h('a', { class: 'list__item', href: t.link },
            h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: t.name }), h('span', { class: 'list__meta', text: workflowOf(t)?.title ?? '' })),
            h('span', { class: 'list__end' }, myResponse(t, me) ? status(myResponse(t, me).verdict === 'ratify' ? 'You confirmed' : 'You disputed', myResponse(t, me).verdict === 'ratify' ? 'success' : 'danger') : status('Waiting for you', 'pending'), sampleBadge(t), icon('arrow-right', 'sm')))))))),
        viewSection('Records I signed', '', signed.length === 0 ? h('p', { class: 'text-tertiary', text: 'Nothing yet.' })
          : h('div', { class: 'card' }, h('ul', { class: 'list' }, signed.map(([k, title, row]) => h('li', { class: 'list__item' }, badge(k), h('span', { class: 'list__main' }, h('span', { class: 'list__title', text: title })), sampleBadge(row)))))),
        freed.length ? viewSection('What plans say about hours on my work', '', h('ul', null, freed.map((f) => h('li', { text: `${f.plan}: ${taskName(f.taskIri)} — ${band(f.band, (n) => num(n, 1))} hours a week; ${FREED_NAMES[f.disposition] ?? f.disposition}${f.note ? ` (${f.note})` : ''}` })))) : null),
      h('section', { class: 'card me-copy', 'aria-labelledby': 'copy-title' }, h('div', { class: 'card__body' }, h('h2', { class: 'card__title', id: 'copy-title', text: 'Your copy' }), holderCard(d.podUrl)))),
  ];
}

/**
 * Copy to a pod, or download: wrd.holder_copy, signed as the acting identity. It needs no read
 * model, so it works for a signer whose read is refused: `podUrl` null asks the bridge which pod it
 * serves (the unsigned template names it), and a refused re-read afterwards leaves the answer shown.
 */
function holderCard(podUrl) {
  const me = actor();
  const platform = data().bridge?.platform ?? {};
  const target = input('', null, { placeholder: 'https://your-storage.example/you/' });
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
    const a = h('a', { href: url, download: `wrd-record-${String(me).replace(/[^A-Za-z0-9._-]+/g, '_')}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return h('div', { class: 'stack holder' },
    podUrl ? h('p', { class: 'text-secondary', text: 'Every record that names you or that you signed, with its original signature. Yours to keep.' }) : null,
    podUrl && platform.address ? h('div', { class: 'holder__id' }, h('p', { class: 'label', text: 'Workspace signature ID' }),
      h('div', { class: 'cluster' }, h('code', { text: short(platform.address) }), btn('Copy', { variant: 'ghost', size: 'sm', on: () => copyText(platform.address, 'Workspace signature ID') })),
      hint('Every record here is signed with this ID. Use it to check a downloaded record is genuine.')) : null,
    h('div', null, btn('Download my record', { variant: 'primary', icon: 'download', on: download })),
    hint('Your downloaded copy isn\'t encrypted. Store it somewhere safe.'),
    h('details', { class: 'disclosure' }, h('summary', { text: 'Copy to my own storage' }), h('div', { class: 'disclosure__body stack stack--sm' },
      field('Address of your own storage', target), h('div', null, btn('Sign and copy', { on: () => copy({ targetPodUrl: target.value.trim() }) })))),
    platform.address ? techDetails('Technical details', `The platform address these records should be signed by: ${platform.address} (${platform.keyKind ?? 'unknown'} key)`, 'This page doesn\'t verify a download: the README gives the offline command.') : null);
}

boot();
