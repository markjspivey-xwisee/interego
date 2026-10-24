// Practice Evidence web client.
//
// A Path-A client: it reads this bridge's affordance manifest (GET affordances?format=jsonld),
// indexes it by action IRI, and invokes every act at the path the manifest names, on this page's
// own origin. It adds no endpoint of its own and decides nothing the bridge does not: which
// controls an attempt shows comes from the attempt's own `nextActions`, every refusal is the
// bridge's (shown in plain words, with the bridge's own text under "Technical details"), and every
// score on the page was computed by the bridge from the rubric.
//
// Signing. Every act that changes or reveals a person's record is signed by that person:
//   · demo mode: the bridge holds demo role keys and signs as the role picked here (and every
//     record it writes says so); detected by asking pev.sign_as_demo_role for its roles;
//   · wallet mode: an EIP-191 personal_sign over canonicalJson(payload) by the connected wallet;
//   · paste mode: the page shows the exact text to sign; the person pastes the signature. It is
//     opt-in ("Sign manually (advanced)") wherever another way to sign in exists; until then a
//     signed act shows a sign-in screen and sends nothing;
//   · interego mode: the person signs in with their Interego account on the relay's own sign-in
//     page (PKCE S256, a random state checked on return), and the relay signs every act for the
//     agent of that session, through this bridge's ui/relay/sign (relay-attested, not user-held).
//     The relay's OAuth access token for that sign-in (it lasts about an hour) is kept in
//     sessionStorage only, forgotten when it expires, and sent only to ui/relay/sign.
// The page never holds a private key. Every request it makes goes to this bridge's own origin.
//
// Untrusted text (everything that came from a pod, a person or a model) is rendered through
// textContent only. No markup is ever parsed from a string anywhere in this file, and every icon
// is built with createElementNS.

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
  mode: 'paste',                // 'demo' | 'wallet' | 'paste' | 'interego'
  manual: false,                // paste mode chosen on purpose ("Sign manually (advanced)"); until then a signed act asks to sign in
  interego: null,               // { accessToken, at, expiresAt, agentId, principal } while signed in with an Interego account
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
  lastRoute: '',
  copiedMemberId: false,        // memory only: ticks the checklist's Member ID step
  sessions: null,               // memory only: { any, own } from the last attempt list read as this person; null until one is read
  checklistOpen: null,          // memory only: the person opened (true) or collapsed (false) Getting started; null: the default
  queueCount: null,             // memory only: the To review count in the navigation
  checklistRole: null,          // which role's Getting started steps are shown
  checklistAll: false,          // every step shown, not just the next few
};

const READ_ENVELOPE_MS = 9 * 60 * 1000;
const DEMO_SENTENCE = 'DEMO MODE: this bridge holds these role keys and signs as whichever role you pick. Records it writes say so. Do not run demo mode on a shared deployment.';
const SIBLING = { name: 'Work Redesign', href: 'https://wrd-bridge-production.up.railway.app/' };
const STATE_WORDS = {
  'in-conversation': 'In conversation', 'ended': 'Finished: not assessed yet', 'judged': 'Assessed by AI: provisional',
  'countersigned': 'Confirmed by a reviewer', 'overridden': 'Levels set by a reviewer', 'contested': 'Second review requested',
  'review-retracted': 'Review withdrawn', 'redacted': 'Conversation text deleted',
};
const STATE_TONE = { 'in-conversation': 'accent', 'ended': 'pending', 'judged': 'warning', 'countersigned': 'success',
  'overridden': 'success', 'contested': 'warning', 'review-retracted': 'warning', 'redacted': 'danger' };
const REGIME_WORDS = {   // [label, hint]
  evident: ['Obvious', 'Anyone in the role would recognize a good answer.'],
  knowable: ['Expert-judged', 'Experienced people can say what good looks like.'],
  emergent: ['Situational', 'What works only becomes clear afterwards.'],
  turbulent: ['Unsettled', 'No stable pattern to judge against yet.'],
  unclassified: ['Not decided yet', ''],
};
const CHOSEN_BY_WORDS = { 'bridge-config': "this workspace's settings", 'judge-registry': 'an appointed judge',
  'learner': 'the learner, with their own key', 'reviewer': 'a reviewer, with their own key' };
const FACTOR_WORDS = { unverified: "A quote didn't match", notQuoted: 'Criteria at the lowest level with nothing checked',
  disagreement: 'AI assessments disagree', nearThreshold: 'Close to the pass mark', uncertainty: 'The AI was unsure',
  cellNeed: 'Few reviewed sessions for this AI judge', learnerControlled: "The learner's own AI played a part", auditSample: 'Blind check' };
const QUOTE_STATUS = { verified: ['success', 'Quote checked'], unverified: ['danger', "Quote didn't match"],
  'no-quote-needed': ['pending', 'Lowest level, nothing to check'] };
const ROLE_WORDS = { reviewer: 'Reviewer', author: 'Author', judge: 'Judge', agent: 'AI agent (not a person)', learner: 'Learner', admin: 'Admin' };
const ROLE_HINTS = {
  reviewer: "Reviewers approve rubrics they didn't write and sign off practice sessions.",
  author: 'Authors write, try and publish scenarios.',
  judge: 'Judges assess the sessions they are given. A reviewer always has the final say.',
  agent: 'Marks a member as software. Software can never approve a rubric or sign off a review.',
  learner: "Learners practice. On some workspaces the built-in AI is only for people on the team.",
};
const KEY_WORDS = { configured: 'Permanent', ephemeral: "Temporary (records won't be trusted after a restart)", 'demo-fixture': 'Demo key (records prove nothing outside this demo)' };
const NEXT_WORDS = {   // client labels for nextActions, keyed by ACT key; the server's label and why move to Technical details
  judgeAttempt: ['Get AI assessment', 'The AI suggests a level for each criterion and quotes your words. Practice Evidence checks every quote and works out the result.'],
  judgePacket: ['Hand-off for an independent judge', 'Gives an appointed judge, or their AI assistant, what they need to assess this session.'],
  exportRecord: ['Download my record', 'Every saved version with its signature, so you can check it on your own.'],
  holderCopy: ['Copy to my storage', 'Works only with storage that accepts copies from this service. Otherwise, download.'],
  contestReview: ['Request another review', 'A different reviewer will look again. You can ask up to twice.'],
  retractReview: ['Withdraw the review (admin)', 'The learner sees your reason, and the session goes back to To review.'],
  redactAttempt: ['Delete conversation text', "Deletes the words from this workspace. Levels and fingerprints stay, so a downloaded copy still checks out. This can't be undone."],
  countersignAttempt: ['Review this session', 'Choose a level for every criterion and sign off.'],
  overrideAttempt: ['Review this session', 'Choose a level for every criterion and sign off.'],
};
const ACTION_WORDS = {  // the paste panel's plain "What you're confirming"
  registerRole: 'Change a role', authorScenario: 'Save a scenario', draftScenario: 'Draft a scenario with AI', ratifyScenario: 'Approve a rubric',
  startAttempt: 'Start practice', say: 'Send your line', counterpartPacket: 'Get instructions for your AI', recordTurns: 'Save both lines',
  endConversation: 'Finish the conversation', judgeAttempt: 'Get AI assessment', judgePacket: 'Get the judge hand-off', reviewQueue: 'Open your review list',
  countersignAttempt: "Confirm the AI's levels", overrideAttempt: 'Sign off your levels', contestReview: 'Request another review',
  retractReview: 'Withdraw a review', scenarioResults: 'Open results', projectAttempt: 'Create a learning record', holderCopy: 'Copy to your storage',
  exportRecord: 'Download your record', redactAttempt: 'Delete conversation text', getAttempt: 'Open your practice sessions',
};
const EVIDENCE_PLAIN = {  // the server's reasons a session cannot leave as evidence yet, in plain words
  'an author trying their own scenario is a test; it never leaves as evidence': "it's a test run",
  'the transcript was removed from this pod, so this attempt no longer leaves as evidence': 'the conversation text was deleted',
  'a qualified reviewer has not countersigned or set the levels of this attempt': "it hasn't been reviewed yet",
  'the standing review does not check out against the record and the role registry as it stood when it was signed': "the review couldn't be verified",
  'the rubric version this attempt used has not been ratified by a reviewer': "the rubric hasn't been approved",
};
const ACCESS = {
  'not-a-reviewer': 'Reviewing is for reviewers.',
  'not-an-author': 'Writing scenarios is for authors.',
  'not-an-admin': 'Only admins can change roles.',
  'not-a-judge': 'Assessing sessions is for appointed judges.',
  'not-entitled': 'Results are for reviewers, authors and admins.',
  'not-the-learner': 'Only the learner can do this for their own session.',
  'not-learner-or-reviewer': 'Only the learner or a reviewer can open this session.',
  'not-learner-or-admin': 'Only the learner or an admin can do this.',
};
const SOMEONE_ELSE = {
  'reviewer-is-the-learner': "You can't review your own practice.",
  'reviewer-is-the-judge': "You can't review a session you assessed.",
  'reviewer-requested-the-judgment': "You can't review a session you asked to have assessed.",
  'reviewer-already-reviewed': "You've already reviewed this session; a different reviewer will look again.",
  'ratifier-is-the-author': "You can't approve a rubric you wrote.",
  'judge-is-the-learner': "You can't assess your own practice.",
  'agent-cannot-countersign': 'Approving and signing off must be done by a person.',
  'agent-cannot-ratify': 'Approving and signing off must be done by a person.',
};
const NOT_AVAILABLE = "This action isn't available on this workspace.";
const NEED_STORAGE = "Choose this workspace's storage first (Workspace settings).";
const CLIENT_TITLES = {   // a message the client itself throws → [title, body]
  'Signing was cancelled; nothing was sent.': ['Cancelled', 'Nothing was sent.'],
  'No wallet was found in this browser.': ['No crypto wallet found', 'Install a wallet extension, or sign in with Interego.'],
  'Connect a wallet first.': ['Connect your wallet first', 'Choose Use a crypto wallet from the sign-in menu, then try again.'],
  'The wallet offered no account.': ['Your wallet offered no account', 'Unlock your wallet or choose an account in it, then try again.'],
  [NEED_STORAGE]: ["Choose this workspace's storage first", 'Open Workspace settings and enter the storage address your admin gave you.'],
  [NOT_AVAILABLE]: ["This isn't available here", "This workspace doesn't offer this step. If you expected it, tell your admin."],
};
const BY = { 'own-agent': 'their own AI assistant', model: 'another AI', person: 'another person' };

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
const actKey = (action) => Object.keys(ACT).find((k) => ACT[k] === action);
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'n/a');
const num = (x) => (typeof x === 'number' ? (Math.round(x * 1000) / 1000).toString() : 'n/a');
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function levelLabel(rubric, criterionId, levelId) {
  const c = (rubric && rubric.criteria || []).find((x) => x.id === criterionId);
  const l = c && c.levels.find((x) => x.id === levelId);
  return l ? l.label : String(levelId);
}

function criterionTitle(rubric, criterionId) {
  const c = (rubric && rubric.criteria || []).find((x) => x.id === criterionId);
  return c ? c.title : String(criterionId);
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

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A member's short name: the user id of an Interego Member ID, or a shortened address. */
function memberShort(did) {
  const s = String(did || '');
  const i = s.indexOf(':users:');
  return i >= 0 ? s.slice(i + ':users:'.length) : short(s);
}

/** Which app signed for a person, from the agent the relay named. */
function agentWords(id) {
  if (!id) return 'Interego';
  const s = String(id);
  const i = s.indexOf(':agents:');
  const slug = i >= 0 ? s.slice(i + ':agents:'.length) : s;
  if (slug.startsWith('practice-evidence-')) return 'the Practice Evidence web app';
  if (slug.startsWith('claude-')) return 'Claude';
  if (slug.startsWith('chatgpt-')) return 'ChatGPT';
  if (slug.startsWith('openai-codex-')) return 'Codex';
  if (slug.startsWith('cursor-')) return 'Cursor';
  return 'another app';
}

/** Who an AI judge is, in plain words; the raw id stays in Technical details. */
function judgeWords(id, kind) {
  const s = String(id || '');
  if (s.startsWith('model:scripted')) return 'Sample AI judge (demo)';
  const m = /^model:[^/]+\/(.+)$/.exec(s);
  if (m) return `${m[1]} (AI)`;
  return kind === 'agent' ? 'An appointed AI judge' : 'An appointed judge';
}

/** The visible label on the other person's line: who wrote it. */
function replyWords(t) {
  if (t.source === 'authored-first-line') return { text: "Opening line, written by the scenario's author", tone: '' };
  const d = t.disclosure;
  if (!d) return null;
  if (d.route === 'scripted') return { text: 'Sample reply: no AI ran', tone: 'demo' };
  if (d.route === 'client-packet') return { text: `Written by your own AI (${[d.provider, d.model].filter(Boolean).join(' ')}), as you declared`, tone: 'warning' };
  if (d.keySource === 'per-request-byok') return { text: `Reply by ${d.model || d.requestedModel}, with your own key`, tone: '' };
  return { text: `Reply by ${d.model || d.requestedModel}, via Practice Evidence`, tone: '' };
}

/** Which AI drafted a scenario, in plain words. */
function draftWords(d) {
  if (!d) return 'an AI';
  if (d.route === 'scripted') return 'the sample AI (demo; no AI ran)';
  return [d.provider, d.model || d.requestedModel].filter(Boolean).join(' ') || 'an AI';
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Design-system pieces: icons, the mark, badges, callouts, page headers, fields, toasts
// ════════════════════════════════════════════════════════════════════════════════════════════

const ICONS = {
  'sign-in':      ['M15 3h3a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-3', 'M10 17l5-5-5-5', 'M15 12H3'],
  'user':         ['M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  'check':        ['M5 12.5l4.5 4.5L19 7.5'],
  'warning':      ['M10.27 3.98 2.3 17.8A2 2 0 0 0 4.03 20.8h15.94a2 2 0 0 0 1.73-3L13.73 3.98a2 2 0 0 0-3.46 0Z', 'M12 9.5v4', 'M12 17h.01'],
  'info':         ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  'document':     ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  'people':       ['M5.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', 'M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1', 'M16 4.2a3.8 3.8 0 0 1 0 7.6', 'M18 14.2a5 5 0 0 1 3 4.6V20'],
  'chart':        ['M3 3v18h18', 'M8 17v-5', 'M12.5 17V7', 'M17 17v-8'],
  'shield':       ['M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6Z', 'M9 12l2 2 4-4'],
  'sparkle':      ['M12 3l1.8 5.2a3 3 0 0 0 1.9 1.9L21 12l-5.3 1.8a3 3 0 0 0-1.9 1.9L12 21l-1.8-5.3a3 3 0 0 0-1.9-1.9L3 12l5.3-1.9a3 3 0 0 0 1.9-1.9Z', 'M19 2.5v3', 'M17.5 4h3'],
  'arrow-right':  ['M5 12h14', 'M13 6l6 6-6 6'],
  'external':     ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  'download':     ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16'],
  'chat':         ['M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12Z'],
  'clipboard':    ['M9 3.5h6a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z', 'M16 5h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1', 'M9 14l2 2 4-4'],
  'close':        ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'menu':         ['M4 7h16', 'M4 12h16', 'M4 17h16'],
};
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A decorative icon (the text beside it carries the meaning). */
function icon(name, size) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: size ? `icon icon--${size}` : 'icon', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of ICONS[name] || []) svg.append(svgEl('path', { d }));
  return svg;
}

/** The Interego mark: three connected nodes on an accent tile. */
function brandMark() {
  const svg = svgEl('svg', { viewBox: '0 0 32 32', class: 'brand__mark', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(
    svgEl('rect', { class: 'mark-tile', x: 0, y: 0, width: 32, height: 32, rx: 9 }),
    svgEl('path', { class: 'mark-edge', d: 'M10.5 11.5 21.5 11.5 16 21.5Z' }),
    svgEl('circle', { class: 'mark-node', cx: 10.5, cy: 11.5, r: 3 }),
    svgEl('circle', { class: 'mark-node', cx: 21.5, cy: 11.5, r: 3 }),
    svgEl('circle', { class: 'mark-node', cx: 16, cy: 21.5, r: 3 }),
  );
  return svg;
}

function badge(text, tone, title, iconName) {
  return h('span', { class: tone ? `badge badge--${tone}` : 'badge', title }, iconName ? icon(iconName, 'sm') : null, text);
}

function statusPill(text, tone, id) { return h('span', { class: `status status--${tone || 'pending'}`, id, text }); }

function para(text, cls) { return h('p', { class: cls === undefined ? 'text-secondary' : cls, text }); }

/** Protocol detail, one click away: text only. */
function tech(lines) {
  const shown = (lines || []).filter((x) => x !== null && x !== undefined && x !== '');
  return h('details', { class: 'disclosure' }, h('summary', { text: 'Technical details' }),
    h('div', { class: 'disclosure__body disclosure__body--tech' }, shown.map((x) => h('div', { text: String(x) }))));
}

function callout(o) {
  const tone = o.tone || 'info';
  const ic = icon(tone === 'success' ? 'check' : tone === 'danger' || tone === 'warning' ? 'warning' : 'info');
  ic.classList.add('callout__icon');
  const box = h('div', { class: `callout callout--${tone}${o.extraClass ? ` ${o.extraClass}` : ''}`, role: o.alert ? 'alert' : o.role, id: o.id, dataset: o.dataset }, ic);
  if (o.title) box.append(h('p', { class: o.titleClass ? `callout__title ${o.titleClass}` : 'callout__title', text: o.title }));
  if (o.body) box.append(typeof o.body === 'string' ? h('p', { class: 'callout__body', text: o.body }) : o.body);
  for (const k of o.kids || []) if (k) box.append(k);
  const actions = (o.actions || []).filter(Boolean);
  if (actions.length) box.append(h('div', { class: 'callout__actions' }, actions));
  if (o.techLines && o.techLines.filter(Boolean).length) box.append(tech(o.techLines));
  return box;
}

function pageHeader(o) {
  document.title = `${o.title} · Practice Evidence`;
  const text = h('div', { class: 'page-header__text' });
  if (o.crumbs) {
    text.append(h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' }, h('ol', {}, o.crumbs.map(([href, label]) => h('li', {},
      href ? h('a', { href, text: label }) : h('span', { 'aria-current': 'page', text: label }))))));
  }
  text.append(h('h1', { class: 'page-title', text: o.title }));
  if (o.lede) text.append(h('p', { class: 'page-lede', text: o.lede }));
  if (o.meta && o.meta.length) text.append(h('div', { class: 'page-header__meta' }, o.meta));
  const head = h('header', { class: 'page-header' }, text);
  if (o.actions && o.actions.length) head.append(h('div', { class: 'page-header__actions' }, o.actions));
  return head;
}

function emptyState(o) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty__icon' }, icon(o.icon)), h('h2', { class: 'empty__title', text: o.title }),
    o.text ? h('p', { class: 'empty__text', text: o.text }) : null, o.actions && o.actions.length ? h('div', { class: 'empty__actions' }, o.actions) : null);
}

/** A labelled control: label → control → hint. */
function formField(o) {
  if (!o.control.id) o.control.id = o.id || nextId('f');
  const f = h('div', { class: 'field', dataset: o.dataField ? { field: o.dataField } : undefined },
    h('label', { class: o.hideLabel ? 'label visually-hidden' : 'label', for: o.control.id }, o.label, o.optional ? h('span', { class: 'label__optional', text: '(optional)' }) : null),
    o.control);
  if (o.hint) {
    const hid = `${o.control.id}-hint`;
    f.append(h('p', { class: 'hint', id: hid, text: o.hint }));
    o.control.setAttribute('aria-describedby', hid);
  }
  return f;
}

function errorText(text) { return h('p', { class: 'error-text', role: 'alert' }, icon('warning'), text); }

/** Say what is wrong under one control (null clears it); the control is marked invalid and points at the text. */
function fieldError(control, text) {
  const id = `${control.id}-error`;
  const old = document.getElementById(id);
  if (old) old.remove();
  const described = (control.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id);
  if (!text) {
    control.removeAttribute('aria-invalid');
    if (described.length) control.setAttribute('aria-describedby', described.join(' ')); else control.removeAttribute('aria-describedby');
    return;
  }
  const p = errorText(text);
  p.id = id;
  control.setAttribute('aria-invalid', 'true');
  control.setAttribute('aria-describedby', [...described, id].join(' '));
  control.after(p);
  if (typeof control.focus === 'function') control.focus();
}

function linkButton(href, label, cls, iconName) {
  const ic = iconName ? icon(iconName, 'sm') : null;
  return h('a', { class: `btn ${cls || 'btn--secondary'}`, href }, iconName === 'arrow-right' ? null : ic, label, iconName === 'arrow-right' ? ic : null);
}

/** A short confirmation in the corner. Errors never use one: they get a callout where they happened. */
function toast(o) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const tone = o.tone || 'info';
  const ic = icon(tone === 'success' ? 'check' : tone === 'warning' || tone === 'danger' ? 'warning' : 'info');
  ic.classList.add('toast__icon');
  const close = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm toast__close', 'aria-label': 'Dismiss notification' }, icon('close'));
  const t = h('div', { class: `toast toast--${tone}` }, ic, h('p', { class: 'toast__title', text: o.title }), close);
  if (o.text) t.append(h('p', { class: 'toast__text', text: o.text }));
  let timer = 0;
  const dismiss = () => { clearTimeout(timer); t.classList.add('is-leaving'); setTimeout(() => t.remove(), 400); };
  const arm = () => { timer = setTimeout(dismiss, 6000); };
  close.addEventListener('click', dismiss);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', arm);
  t.addEventListener('focusin', () => clearTimeout(timer));
  region.append(t);
  arm();
}

function openDialog(d) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
function closeDialog(d) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }

/** Close the menu a control sits in (a native popover), where the browser has the popover API. */
function closeMenuOf(el) {
  const m = el && el.closest ? el.closest('[popover]') : null;
  if (m && typeof m.hidePopover === 'function') { try { m.hidePopover(); } catch { /* it was not open */ } }
}

/** Where the browser has no CSS anchor positioning, place each menu under its button when it opens. */
function placeMenus() {
  if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('anchor-name: --a')) return;
  for (const menu of document.querySelectorAll('.menu[popover]')) {
    const place = () => {
      if (!menu.isConnected) return;
      const btn = document.querySelector(`[popovertarget="${menu.id}"]`);
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      menu.style.setProperty('--menu-top', `${Math.round(r.bottom + 4)}px`);
      menu.style.setProperty('--menu-right', `${Math.round(document.documentElement.clientWidth - r.right)}px`);
    };
    menu.addEventListener('beforetoggle', (e) => {
      if (e.newState === 'open') { place(); addEventListener('scroll', place, { passive: true }); addEventListener('resize', place); }
      else { removeEventListener('scroll', place); removeEventListener('resize', place); }
    });
  }
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ tone: 'success', title: `${what} copied` });
  } catch {
    toast({ tone: 'warning', title: 'Select the text and copy it yourself' });
  }
}

function scrollToEl(sel) {
  const el = $(sel);
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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

/** A signed act asked of a visitor who has not signed in: nothing is signed and nothing is sent. */
class NeedsSignIn extends Error { constructor() { super('Sign in to continue.'); } }

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
  if (!a) { const e = new Error(NOT_AVAILABLE); e.detail = `This bridge does not offer ${toolOf(action)}.`; throw e; }
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
  if (S.mode === 'interego') return `interego:${S.interego ? S.interego.at : ''}`;
  return 'paste';
}

async function sign(action, fields, read) {
  if (!S.pod) throw new Error(NEED_STORAGE);
  if (S.mode === 'paste' && !S.manual) throw new NeedsSignIn();
  const payload = { v: 1, action, podUrl: S.pod, ...fields };
  const cacheKey = read ? `${signerKey()}|${S.pod}|${canonicalJson(payload)}` : null;
  if (cacheKey) {
    const hit = S.readEnvelopes.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_ENVELOPE_MS) return hit.envelope;
  }
  let envelope;
  if (S.mode === 'demo') {
    envelope = (await invoke(ACT.signAsDemoRole, { role: S.role, payload })).envelope;
  } else if (S.mode === 'interego') {
    // The relay sets the time it signed (`timestamp`); the bridge reads freshness from that.
    envelope = await relaySign({ ...payload, nonce: freshNonce() });
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
  // A request the relay signed goes as the relay posts one: its two fields at the top of the body.
  const signed = typeof envelope._signed_payload === 'string'
    ? { _signed_payload: envelope._signed_payload, _signature: envelope._signature } : { envelope };
  return invoke(action, { ...signed, ...(opts.byok ? byokArgs() : {}) });
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
  S.sessions = null;
}

/** Paste mode (chosen on purpose): show the exact text to sign, wait for the signature. */
function pasteSign(payload) {
  return new Promise((resolve, reject) => {
    const sec = clear($('#signing'));
    const text = canonicalJson(payload);
    const key = actKey(payload.action);
    const exact = h('textarea', { class: 'textarea textarea--mono', rows: 3, readOnly: true, value: text });
    const pasted = h('textarea', { id: 'paste-signature', class: 'textarea textarea--mono', rows: 3, placeholder: '0x… (the signature), or {"payload": …, "signature": "0x…"}', 'aria-label': 'Signature' });
    const problem = h('p', { class: 'error-text' });
    const done = () => clear(sec);
    const use = h('button', { type: 'button', class: 'btn btn--primary', text: 'Use this signature', onclick: () => {
      const raw = pasted.value.trim();
      if (/^0x[0-9a-fA-F]{130}$/.test(raw)) { done(); resolve({ payload, signature: raw }); return; }
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.signature === 'string' && j.payload && typeof j.payload === 'object') { done(); resolve({ payload: j.payload, signature: j.signature }); return; }
      } catch { /* not JSON: said below */ }
      problem.textContent = 'Paste a 0x signature of 130 hex digits, or {"payload": …, "signature": "0x…"}.';
    } });
    const cancel = h('button', { type: 'button', class: 'btn btn--ghost', text: 'Cancel', onclick: () => { done(); reject(new Error('Signing was cancelled; nothing was sent.')); } });
    sec.append(h('section', { class: 'card card--highlight signing', 'aria-labelledby': 'signing-title' },
      h('div', { class: 'card__header' }, h('div', {},
        h('h2', { class: 'card__title', id: 'signing-title', text: 'Confirm this step with your signature' }),
        h('p', { class: 'card__subtitle', text: 'Manual signing (advanced): sign the exact text below with a tool that supports EIP-191 personal_sign, then paste the signature.' }))),
      h('div', { class: 'card__body' },
        h('p', {}, "What you're confirming: ", h('strong', { text: ACTION_WORDS[key] || 'This step' })),
        formField({ label: 'Exact text to sign', control: exact }),
        h('div', { class: 'btn-group' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Copy text', onclick: () => copyText(text, 'Text to sign') })),
        h('details', { class: 'disclosure' }, h('summary', { text: 'Show the request as JSON' }), jsonBlock(payload)),
        h('details', { class: 'disclosure' }, h('summary', { text: 'How to get a key' }),
          h('div', { class: 'disclosure__body' }, h('p', { text: 'You need an Ethereum-style key held in a wallet that supports personal_sign, or a tool that signs the text shown with EIP-191. This page links to nothing outside this service and never sees your key.' }))),
        formField({ label: 'Signature', control: pasted }),
        problem),
      h('div', { class: 'card__footer' }, cancel, use)));
    if (typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'nearest' });
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Interego sign-in: the relay signs for the agent of the person's session
// ════════════════════════════════════════════════════════════════════════════════════════════

// sessionStorage only: the token ends with the tab, and no other page of this origin keeps it.
const SESSION_KEY = 'pev.interego.session';
const PENDING_KEY = 'pev.interego.pending';
/** localStorage, a per-viewer convenience: Getting started hidden in this browser until the account menu brings it back. */
const CHECKLIST_HIDDEN_KEY = 'pev.checklist.hidden';
const PENDING_MS = 15 * 60 * 1000;
/** The longest this tab keeps a sign-in, whatever it is told: the relay's access tokens last an hour. */
const SIGN_IN_MAX_MS = 60 * 60 * 1000;
const CALLBACK_PATH = /\/ui\/oauth\/callback$/;
const SIGN_IN_ENDED = 'Your Interego sign-in has ended: the relay\'s access token this tab held lasts about an hour, and the tab has forgotten it. Sign in again to go on.';
/** The timer that forgets the sign-in at its expiry, and whether the page is up to say so. */
let signInTimer = null;
let pageReady = false;

function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionPut(k, v) { try { sessionStorage.setItem(k, v); return true; } catch { return false; } }
function sessionDrop(k) { try { sessionStorage.removeItem(k); } catch { /* nothing kept */ } }
function sessionJson(k) { try { const v = JSON.parse(sessionGet(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } }

/** True when this bridge offers Interego sign-in in its web UI (it names the relay to sign in through). */
function interegoOffered() {
  const i = S.bridge && S.bridge.interegoSignIn;
  return Boolean(i && typeof i.relayUrl === 'string' && i.relayUrl);
}

function randomB64url(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The PKCE S256 challenge of a verifier (RFC 7636): base64url of its SHA-256. */
async function s256(verifier) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A JSON call to one of this bridge's sign-in routes; a refusal throws as one. */
async function uiCall(path, init) {
  const r = await fetch(path, init);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok || !body || body.kind === 'refusal') throw new Refused(r.status, body);
  return body;
}

/** The button: send the person to the relay's own sign-in page, with a PKCE challenge and a fresh state. */
async function startInteregoSignIn() {
  if (!globalThis.crypto || !crypto.getRandomValues || !crypto.subtle) {
    throw new Error('This browser offers no Web Crypto (crypto.subtle), so it cannot start a secure sign-in. Use a current browser, over https.');
  }
  const cfg = await uiCall('ui/oauth/start', { headers: { accept: 'application/json' } });
  const verifier = randomB64url(32);
  const state = randomB64url(24);
  const challenge = await s256(verifier);
  const back = /^#\/[a-z]/.test(location.hash) && location.hash !== '#/signin' ? location.hash : '#/practice';
  if (!sessionPut(PENDING_KEY, JSON.stringify({ verifier, state, back, at: Date.now() }))) {
    throw new Error('This browser keeps no session storage for this page (a private window may block it), so it could not finish a sign-in.');
  }
  const u = new URL(cfg.authorizationEndpoint);
  const query = {
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code_challenge: challenge, code_challenge_method: 'S256',
    state, scope: cfg.scope, resource: cfg.resource,
  };
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  clear($('#signing')).append(callout({
    tone: 'info', title: 'Taking you to Interego to sign in',
    body: `You're going to Interego to sign in (${u.host}). Practice Evidence never sees your passkey.`,
    actions: [h('a', { id: 'interego-continue', class: 'btn btn--primary btn--sm', href: u.href, rel: 'noreferrer', text: 'Continue to Interego' })],
  }));
  location.assign(u.href);
}

/** A note about a sign-in that did not finish: plain words, today's exact sentence under Technical details. */
function signInNote(body, sentence) {
  return callout({ tone: 'warning', title: "Sign-in didn't finish", body, alert: true, extraClass: 'refusal',
    actions: [signInButton('interego', 'Sign in again', 'sm')], techLines: [sentence] });
}

/**
 * The callback page: take the code out of the address bar first, check the state against the one
 * this tab sent, then have the bridge exchange the code. Returns a note for the page, or null.
 * Nothing in the answer is trusted before its state is the tab's: anyone can send a person to this
 * page with an `error` of their choosing, so the relay's error is shown only for an answer to the
 * sign-in this tab started, and a sign-in in progress is dropped only by that answer (or once it
 * has expired), never by one it did not ask for.
 */
async function finishInteregoSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const pending = sessionJson(PENDING_KEY);
  const waiting = Boolean(pending && typeof pending.state === 'string' && typeof pending.verifier === 'string' && Date.now() - Number(pending.at) <= PENDING_MS);
  const ours = waiting && typeof state === 'string' && state === pending.state;
  // Kept for a later answer only while it waits and this answer is not its own; an expired or unreadable one goes.
  if (ours || !waiting) sessionDrop(PENDING_KEY);
  const back = pending && typeof pending.back === 'string' && /^#\/[a-z]/.test(pending.back) ? pending.back : '#/practice';
  // Back to the page itself: the code leaves the address bar and the history before anything else.
  history.replaceState(null, '', `${new URL('../../ui', location.href).pathname}${back}`);
  if (!waiting) {
    return signInNote("This tab didn't start a sign-in in the last 15 minutes, so we ignored this one. Nothing was saved.",
      'Interego sign-in did not finish: this tab did not start a sign-in in the last 15 minutes, so this answer is not one it is waiting for. Nothing was kept; sign in again.');
  }
  if (!ours) {
    return signInNote("This sign-in wasn't started from this tab, so we ignored it for your safety. Nothing was saved.",
      'Interego sign-in was refused: the answer did not carry the state this tab sent, so it may not be the sign-in you started. Nothing was kept, and the sign-in this tab started is still waiting for its own answer.');
  }
  if (error) {
    return signInNote("Interego didn't complete the sign-in. Nothing was saved. Please try again.",
      `Interego sign-in did not finish: the relay answered "${error.slice(0, 80)}". Nothing was kept; sign in again to try once more.`);
  }
  if (!code) return signInNote('Please sign in again.', 'Interego sign-in did not finish: the relay sent no code back. Sign in again.');
  try {
    const r = await uiCall('ui/oauth/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: pending.verifier, state }),
    });
    const expiresIn = Number(r.expiresIn);
    if (typeof r.accessToken !== 'string' || !r.accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return signInNote('Please sign in again.', 'Interego sign-in did not finish: this bridge gave back no access token.');
    }
    const at = Date.now();
    const kept = { accessToken: r.accessToken, at, expiresAt: at + Math.min(expiresIn * 1000, SIGN_IN_MAX_MS) };
    if (!sessionPut(SESSION_KEY, JSON.stringify(kept))) {
      return signInNote('Please sign in again.', 'This browser keeps no session storage for this page, so the sign-in cannot be kept.');
    }
    keepInterego(kept);
    return null;
  } catch (e) {
    return problemCallout(e, { alert: true });
  }
}

/** Hold a sign-in in this tab until its expiry, when a timer forgets it. */
function keepInterego(k) {
  S.interego = { accessToken: k.accessToken, at: k.at, expiresAt: k.expiresAt, agentId: null, principal: null };
  if (signInTimer !== null) clearTimeout(signInTimer);
  signInTimer = setTimeout(() => { signInTimer = null; interegoEnded(); }, Math.max(0, k.expiresAt - Date.now()));
}

function sessionEndedCallout() {
  return callout({ tone: 'warning', title: 'Your sign-in has ended', body: 'Sign-ins last up to an hour. Sign in again; your practice is saved.',
    alert: true, extraClass: 'refusal', actions: [signInButton('interego', 'Sign in again', 'sm')], techLines: [SIGN_IN_ENDED] });
}

/** A sign-in kept in this tab, if any. One past its expiry, or claiming to last past an hour from now, is forgotten here. */
function restoreInteregoSession() {
  const k = sessionJson(SESSION_KEY);
  if (!k) return null;
  const expiresAt = Number(k.expiresAt);
  const now = Date.now();
  if (typeof k.accessToken !== 'string' || !k.accessToken || !Number.isFinite(expiresAt) || expiresAt > now + SIGN_IN_MAX_MS) {
    sessionDrop(SESSION_KEY);
    return null;
  }
  if (expiresAt <= now) {
    sessionDrop(SESSION_KEY);
    return sessionEndedCallout();
  }
  keepInterego({ accessToken: k.accessToken, at: Number(k.at) || 0, expiresAt });
  return null;
}

/** The sign-in reached its expiry: forget it and, once the page is up, say so. */
function interegoEnded() {
  if (!S.interego) return;
  forgetInterego();
  if (!pageReady) return;
  renderHeader();
  route();
  clear($('#signing')).append(sessionEndedCallout());
}

/** Have the relay sign one unsigned act, through this bridge (the page reaches nothing else). */
async function relaySign(payload) {
  const i = S.interego;
  if (!i || !i.accessToken) throw new Error('Sign in with your Interego account first.');
  if (Date.now() >= i.expiresAt) {
    forgetInterego();
    renderHeader();
    throw new Error(SIGN_IN_ENDED);
  }
  let r;
  try {
    r = await uiCall('ui/relay/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${i.accessToken}` },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    if (e instanceof Refused && (e.code === 'interego-sign-in-expired' || e.code === 'interego-bearer-missing')) {
      forgetInterego();
      renderHeader();
    }
    throw e;
  }
  // Which agent the relay signed for, read from what it signed, not supposed.
  let signed = null;
  try { signed = JSON.parse(r._signed_payload); } catch { signed = null; }
  if (S.interego && signed && typeof signed.agent_id === 'string') S.interego.agentId = signed.agent_id;
  return { _signed_payload: r._signed_payload, _signature: r._signature };
}

/** Ask the bridge who this sign-in is: a signed read whose answer names the principal it was read as. */
async function confirmInteregoSignIn() {
  if (!S.interego || !S.pod) return;
  try {
    const r = await act(ACT.getAttempt, {}, { read: true });
    learnSessions(r);
    const who = r.signedAs;
    if (S.interego && who && who.authority === 'relay-delegated' && typeof who.principal === 'string') S.interego.principal = who.principal;
  } catch (e) {
    $('#signing').append(problemCallout(e, {}));
  }
  renderHeader();
}

/** Drop the sign-in from this tab: the token, its timer, the agent and every read signed with it. */
function forgetInterego() {
  if (signInTimer !== null) { clearTimeout(signInTimer); signInTimer = null; }
  sessionDrop(SESSION_KEY);
  sessionDrop(PENDING_KEY);
  S.interego = null;
  if (S.mode === 'interego') S.mode = S.demoRoles.length ? 'demo' : S.account ? 'wallet' : 'paste';
  S.readEnvelopes.clear();
  S.sessions = null;
  S.checklistOpen = null;
}

/** What signing out does and does not do, in plain words: it revokes nothing at the relay. */
function signedOutWords(expiresAt) {
  const until = Number.isFinite(expiresAt) && expiresAt > Date.now() ? ` at ${new Date(expiresAt).toLocaleTimeString()}` : '';
  return 'Signed out of this tab: it no longer holds your sign-in and will send it nowhere. Nothing was revoked. '
    + `The Interego relay offers no way to revoke the access token this tab held, so the relay accepts it until it expires${until}, an hour at most after you signed in, `
    + 'and until then whoever has a copy can call the relay\'s tools as you. This bridge carried it on every act it signed and was trusted with it for that hour; it keeps no copy. '
    + 'Your Interego account, your passkey and your other sign-ins are unchanged.';
}

function signOutInterego() {
  const expiresAt = S.interego ? S.interego.expiresAt : Number.NaN;
  forgetInterego();
  renderHeader();
  route();
  clear($('#signing')).append(callout({
    tone: 'neutral', id: 'interego-signed-out', role: 'status', title: "You're signed out of this tab",
    body: "Your Interego sign-in isn't ended early: it stays valid until it expires (within an hour), and anyone with a copy could use it until then. Practice Evidence keeps no copy.",
    kids: [h('details', { class: 'disclosure' }, h('summary', { text: 'What this means' }), h('div', { class: 'disclosure__body' }, h('p', { text: signedOutWords(expiresAt) })))],
  }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Signing in: the buttons, the screens and the callout a signed-out visitor sees
// ════════════════════════════════════════════════════════════════════════════════════════════

/** A sign-in button; one document-level click handler acts on every [data-sign-in]. */
function signInButton(how, label, size, variant, block) {
  return h('button', { type: 'button', class: `btn ${variant || 'btn--primary'}${size ? ` btn--${size}` : ''}${block ? ' btn--block' : ''}`, dataset: { signIn: how } },
    how === 'interego' ? icon('sign-in') : null, label);
}

function onSignInClick(e) {
  const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-sign-in]') : null;
  if (!t) return;
  e.preventDefault();
  const how = t.getAttribute('data-sign-in');
  closeMenuOf(t);
  if (how === 'interego') {
    t.setAttribute('aria-busy', 'true');
    t.disabled = true;
    startInteregoSignIn().catch((err) => {
      t.removeAttribute('aria-busy');
      t.disabled = false;
      clear($('#signing')).append(problemCallout(err, { alert: true }));
    });
  } else if (how === 'wallet') {
    connectWallet().then(() => { renderHeader(); route(); }, (err) => clear($('#signing')).append(problemCallout(err, { alert: true })));
  } else if (how === 'manual') {
    S.manual = true;
    S.readEnvelopes.clear();
    renderHeader();
    route();
  }
}

const GATE_TITLES = {
  mine: 'Sign in to see your practice sessions', review: 'Sign in to review sessions', results: 'Sign in to see results',
  attempt: 'Sign in to open this session', roles: 'Sign in to manage your team', signin: 'Sign in to Practice Evidence',
};

/** The screen a signed-out visitor sees in place of a view that needs to know who they are. */
function signInGate(view) {
  const full = view === 'signin';
  const card = h('div', { class: 'auth__card' }, brandMark(), h(full ? 'h1' : 'h2', { class: 'auth__title', text: GATE_TITLES[view] || 'Sign in to continue' }));
  card.append(h('p', { class: 'auth__text', text: interegoOffered()
    ? "Use your Interego account. You'll confirm it's you with your passkey on Interego's sign-in page."
    : 'Sign each step with a crypto wallet, or sign it manually with your own key.' }));
  const actions = h('div', { class: 'auth__actions' });
  if (interegoOffered()) actions.append(signInButton('interego', 'Sign in with Interego', 'lg', 'btn--primary', true), h('div', { class: 'auth__divider', text: 'or' }));
  if (S.hasWallet) actions.append(signInButton('wallet', 'Use a crypto wallet', '', interegoOffered() ? 'btn--secondary' : 'btn--primary', true));
  actions.append(signInButton('manual', 'Sign manually (advanced)', '', 'btn--ghost', true));
  card.append(actions);
  if (interegoOffered()) card.append(h('p', { class: 'auth__fine', text: "First time? You'll create your Interego account during sign-in. No password, no email." }));
  return h('div', { class: full ? 'auth' : 'auth auth--inline' }, card);
}

/** Shown where an action was pressed by a visitor who has not signed in. Nothing was signed or sent. */
function signInCallout() {
  const actions = [];
  if (interegoOffered()) actions.push(signInButton('interego', 'Sign in with Interego', 'sm'));
  if (S.hasWallet) actions.push(signInButton('wallet', 'Use a crypto wallet', 'sm', actions.length ? 'btn--secondary' : 'btn--primary'));
  actions.push(signInButton('manual', 'Sign manually (advanced)', 'sm', 'btn--ghost'));
  return callout({ tone: 'accent', title: 'Sign in to continue', alert: true, extraClass: 'signin-needed', actions,
    body: interegoOffered() ? "Use your Interego account. You'll come straight back here." : 'Choose how to sign this step.' });
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Problems and outcomes: plain words first, the bridge's own words under Technical details
// ════════════════════════════════════════════════════════════════════════════════════════════

function waitWords(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 'a few minutes';
  if (n < 90) return `${Math.ceil(n)} ${Math.ceil(n) === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(n / 60);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

function memberIdButton() {
  const principal = S.interego && S.interego.principal;
  if (!principal) return null;
  return h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Copy my Member ID', onclick: () => { S.copiedMemberId = true; copyText(principal, 'Member ID'); } });
}

function retryButton(o, label) {
  return o.retry ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: label || 'Try again', onclick: () => o.retry() }) : null;
}

const OUT_OF_DATE = ['turn-out-of-order', 'record-changed', 'chain-moved', 'scenario-revised', 'scenario-changed'];
const MODEL_FAULT = ['model-unreachable', 'model-rate-limited', 'model-output-empty', 'model-output-cut-off', 'model-declined', 'model-billing'];
const STEP_ORDER = {
  'attempt-not-ended': ['Finish the conversation first', ''], 'no-learner-turns': ['Say something first', "There's nothing to assess yet."],
  'attempt-not-judged': ["This session hasn't been assessed yet", ''], 'scenario-not-published': ['This scenario is still a draft', ''],
  'attempt-already-reviewed': ['This session has been reviewed', 'To reopen it, request another review.'],
};
const FORM_CHECKS = {
  'coached-undeclared': 'Please say whether anyone helped you prepare.', 'draft-assistance-undeclared': 'Please say who helped write this scenario.',
  'why-too-short': 'Please add a reason (at least 10 characters).', 'override-why-missing': 'Please add a reason (at least 10 characters).',
  'levels-differ-from-judge': "Your levels differ from the AI's, so this is \"Sign off my levels\" with reasons.",
  'override-changes-nothing': "Your levels match the AI's: use Confirm all levels.",
  'address-format': "That isn't a Member ID or a wallet address. Ask the person to copy their Member ID from their account menu (it starts with did:web: and contains :users:), or paste a wallet address (0x followed by 40 letters and digits).",
};

/** A refusal's plain title, message and the one action that resolves it. */
function friendly(err, o) {
  const code = err.code || '';
  const b = err.body || {};
  if (code === 'envelope-missing' || code === 'signature-unrecoverable') {
    return { tone: 'accent', title: 'Please sign in to continue', message: "This step needs to know it's you.",
      actions: [interegoOffered() ? signInButton('interego', 'Sign in with Interego', 'sm') : null] };
  }
  if (code === 'interego-sign-in-expired' || code === 'interego-bearer-missing') {
    return { tone: 'warning', title: 'Your sign-in has ended', message: 'Sign-ins last up to an hour. Sign in again; your practice is saved.',
      actions: [signInButton('interego', 'Sign in again', 'sm')] };
  }
  if (code === 'envelope-expired') {
    return { tone: 'warning', title: 'That took a little too long', message: 'For your security, each step has to be confirmed within a few minutes. Please try again.', actions: [retryButton(o)] };
  }
  if (ACCESS[code]) {
    return { tone: 'neutral', title: "You don't have access to this", message: `${ACCESS[code]} Ask your admin to add you, and share your Member ID with them.`, actions: [memberIdButton()] };
  }
  if (code === 'chat-agent-may-not-decide') {
    return { tone: 'neutral', title: 'Please do this in the web app',
      message: 'Approving rubrics, signing off reviews, changing roles and withdrawing reviews are done in the Practice Evidence web app, so a person makes those decisions directly.' };
  }
  if (SOMEONE_ELSE[code]) {
    return { tone: 'neutral', title: 'Someone else needs to do this', message: SOMEONE_ELSE[code],
      actions: [code.startsWith('reviewer-') ? linkButton('#/review', 'Back to To review', 'btn--secondary btn--sm') : null] };
  }
  if (code === 'no-model-route') {
    return { tone: 'info', title: "AI isn't available for this step",
      message: 'This workspace has no built-in AI. Use your own AI assistant for this step, or add your own AI provider key in Workspace settings.',
      actions: [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Workspace settings', onclick: () => openSettings('') })] };
  }
  if (code === 'bridge-model-for-registered-only') {
    return { tone: 'info', title: "AI isn't available for this step", message: 'The built-in AI is for people on your team. Ask your admin to add you, or use your own AI.', actions: [memberIdButton()] };
  }
  if (code === 'model-budget-spent' || code === 'attempt-budget-spent') {
    return { tone: 'warning', title: 'Please wait a moment', message: `You've reached the hourly limit for this. Try again in ${waitWords(b.retryAfterSeconds)}.`, actions: [retryButton(o)] };
  }
  if (code === 'relay-calls-limited' || code === 'relay-busy') {
    return { tone: 'warning', title: 'Please wait a moment', message: `Lots of people are signing in right now. Try again in ${waitWords(b.retryAfterSeconds)}.`, actions: [retryButton(o)] };
  }
  if (OUT_OF_DATE.includes(code)) {
    return { tone: 'warning', title: 'This page is out of date', message: 'Something changed since you opened this page. Refresh it, check, and try again. Your unsent line is kept.',
      actions: [h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Refresh', onclick: () => route() })] };
  }
  if (MODEL_FAULT.includes(code)) {
    return { tone: 'danger', title: "The AI didn't respond properly", message: 'Nothing was saved. Please try again in a moment.', actions: [retryButton(o)] };
  }
  if (code === 'judge-output-unusable' || code === 'draft-output-unusable') {
    return { tone: 'danger', title: "The AI didn't respond properly",
      message: "The AI's answer didn't follow the rules, so we didn't save it or patch it up. Try again, or ask for a second opinion.", actions: [retryButton(o)] };
  }
  if (code === 'pod-unreachable' || code === 'pod-refused-read' || code === 'pod-refused-write') {
    return { tone: 'danger', title: "We couldn't reach this workspace's storage", message: 'Nothing was saved. Please try again; if it keeps happening, tell your admin.', actions: [retryButton(o)] };
  }
  if (code === 'record-key-mismatch' || code === 'record-not-trusted' || code === 'records-sealed') {
    return { tone: 'danger', title: "Some records here can't be opened", message: "Some records here can't be opened by this service. Please tell your admin." };
  }
  if (STEP_ORDER[code]) return { tone: 'warning', title: STEP_ORDER[code][0], message: STEP_ORDER[code][1] };
  if (code === 'unverified-criteria-need-override') {
    const rb = b['iep:resolvedBy'];
    const which = rb && Array.isArray(rb.criteria) ? rb.criteria.join(', ') : 'some criteria';
    return { tone: 'warning', title: `A quote didn't match for ${which}. Set those levels yourself and add a reason.`, message: '' };
  }
  if (FORM_CHECKS[code]) return { tone: 'warning', title: FORM_CHECKS[code], message: '' };
  return { tone: 'danger', title: 'Something went wrong', message: 'Nothing was saved. Please try again. If it keeps happening, tell your admin and include the details below.', actions: [retryButton(o)] };
}

/** Every failure, as a callout: what happened and what to do, then the bridge's own words under Technical details. */
function problemCallout(err, o) {
  const opt = o || {};
  if (err instanceof NeedsSignIn) return signInCallout();
  if (!(err instanceof Refused)) {
    const msg = String(err && err.message || err);
    if (msg === SIGN_IN_ENDED) return sessionEndedCallout();
    const t = CLIENT_TITLES[msg];
    return callout({ tone: 'neutral', title: t ? t[0] : 'Something went wrong', body: t ? t[1] : msg, alert: opt.alert, extraClass: 'refusal',
      techLines: err && err.detail ? [err.detail] : [] });
  }
  const f = friendly(err, opt);
  const b = err.body;
  let message = f.message || '';
  if (opt.write && !/nothing was saved/i.test(message)) {
    message = message ? `${message} Nothing was saved.` : 'Nothing was saved.';
  }
  const lines = [`Code: ${err.code || 'none'} · Status: HTTP ${err.status}`, err.message];
  const rb = b['iep:resolvedBy'];
  if (rb && typeof rb === 'object') {
    const parts = [];
    if (rb.action) parts.push(`use ${toolOf(rb.action)}`);
    if (rb.then) parts.push(`then ${toolOf(rb.then)}`);
    if (rb.env) parts.push(`the operator sets ${rb.env}`);
    if (Array.isArray(rb.criteria)) parts.push(`criteria: ${rb.criteria.join(', ')}`);
    if (parts.length) lines.push(`What resolves it: ${parts.join('; ')}.`);
  }
  if (b.disclosure) lines.push(`The model call that was made: ${disclosureWords(b.disclosure)}. Nothing was recorded.`);
  const problems = Array.isArray(b.problems) && b.problems.length
    ? h('ul', { class: 'callout__body' }, b.problems.map((p) => h('li', { text: typeof p === 'string' ? p : (p.message || JSON.stringify(p)) }))) : null;
  return callout({ tone: f.tone, title: f.title, body: message || null, kids: [problems], actions: f.actions, techLines: lines,
    alert: opt.alert, extraClass: 'refusal', dataset: { code: err.code || '' } });
}

/** Run an act from a button: disable it, show progress, then the outcome or the problem. */
async function busy(btn, out, fn, opts) {
  const o = opts || {};
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  clear(out).append(h('p', { class: 'text-tertiary busy-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), o.progress || 'One moment…'));
  try {
    const node = await fn();
    clear(out);
    if (node) out.append(node);
  } catch (e) {
    clear(out).append(problemCallout(e, { alert: true, write: true, retry: () => busy(btn, out, fn, opts) }));
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
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
//  Header, settings and navigation
// ════════════════════════════════════════════════════════════════════════════════════════════

function routeWords(route, b) {
  if (route === 'scripted') return 'SCRIPTED: offline fixture, no model ran';
  if (route === 'none') return 'No model on this bridge: use your own agent';
  return `this bridge's model: ${b.provider || '?'} ${b.requestedModel || ''}`.trim();
}

function routePlain(route, b) {
  if (route === 'scripted') return 'Sample replies (demo; no AI is running)';
  if (route === 'none') return 'None built in: use your own AI assistant';
  return `${b.provider || ''} ${b.requestedModel || ''}`.trim();
}

const demoLabel = (r) => String(r.label || r.role).replace(/ \(demo key\)$/, '');

function actingAs() {
  if (S.mode === 'demo') {
    const r = S.demoRoles.find((x) => x.role === S.role);
    return r ? `Viewing as ${r.label}` : `Viewing as ${S.role}`;
  }
  if (S.mode === 'wallet') return `Signed in with wallet ${short(S.account)}`;
  if (S.mode === 'interego') {
    const i = S.interego;
    if (i && i.principal) return `Signed in as ${memberShort(i.principal)} via ${agentWords(i.agentId)}`;
    return 'Signed in with Interego. Checking your Member ID…';
  }
  return S.manual ? 'Signing manually' : 'Not signed in';
}

function userShort() {
  if (S.mode === 'demo') {
    const r = S.demoRoles.find((x) => x.role === S.role);
    return r ? demoLabel(r).split(',')[0] : S.role;
  }
  if (S.mode === 'wallet') return short(S.account);
  const i = S.interego;
  return i && i.principal ? memberShort(i.principal) : 'Checking…';
}

function openSettings(focusId) {
  const d = $('#workspace-settings');
  if (!d) return;
  openDialog(d);
  if (focusId) { const el = document.getElementById(focusId); if (el) el.focus(); }
}

function productSwitch() {
  return h('a', { class: 'product-switch', href: SIBLING.href }, h('span', { class: 'product-switch__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'product-switch__prefix', text: 'Also from Interego:' }), ` ${SIBLING.name}`);
}

function menuItem(label, iconName, onclick, extra) {
  return h('button', { type: 'button', class: 'menu__item', onclick: (e) => { closeMenuOf(e.currentTarget); onclick(); }, ...(extra || {}) }, icon(iconName), label);
}

function menuLink(label, iconName, href) { return h('a', { class: 'menu__item', href }, icon(iconName), label); }

function demoBanner() {
  const r = S.demoRoles.find((x) => x.role === S.role);
  const sel = h('select', { id: 'role', class: 'select', 'aria-label': 'Demo role', onchange: (e) => {
    S.role = e.target.value; remember('pev.role', S.role); S.readEnvelopes.clear(); S.checklistRole = null; S.queueCount = null; S.sessions = null; S.checklistOpen = null;
    renderHeader(); route();
  } }, S.demoRoles.map((x) => h('option', { value: x.role, text: demoLabel(x) })));
  sel.value = S.role;
  return h('div', { class: 'env-banner', role: 'note' },
    h('span', { class: 'env-banner__label', text: 'Demo' }),
    h('span', { text: 'Demo workspace: sample people and sample replies. Nothing here counts outside this demo.' }),
    h('label', { class: 'env-banner__picker' }, 'View as', sel),
    tech([DEMO_SENTENCE, r ? `Signing as ${r.label} ${r.address}` : null]));
}

function signedOutActions() {
  const out = [h('span', { id: 'acting-as', class: S.manual ? 'badge' : 'visually-hidden', text: actingAs() })];
  if (interegoOffered()) {
    out.push(h('button', { type: 'button', id: 'interego-sign-in', class: 'btn btn--primary btn--sm', dataset: { signIn: 'interego' } },
      icon('sign-in'), h('span', {}, 'Sign in', h('span', { class: 'hide-below-md', text: ' with Interego' }))));
  } else if (S.hasWallet) {
    out.push(h('button', { type: 'button', id: 'connect-wallet', class: 'btn btn--primary btn--sm', dataset: { signIn: 'wallet' }, text: 'Use a crypto wallet' }));
  }
  out.push(h('button', { type: 'button', id: 'signin-other', class: 'btn btn--ghost btn--icon btn--sm', popovertarget: 'signin-menu', 'aria-haspopup': 'menu', 'aria-label': 'Other ways to sign in' }, icon('chevron-down')));
  out.push(h('div', { class: 'menu', id: 'signin-menu', popover: true },
    h('div', { class: 'menu__header' }, h('strong', { text: 'Other ways to sign in' }), h('span', { class: 'text-sm text-tertiary', text: 'For people who sign with their own key.' })),
    interegoOffered() && S.hasWallet ? h('button', { type: 'button', id: 'connect-wallet', class: 'menu__item', dataset: { signIn: 'wallet' } }, icon('shield'), 'Use a crypto wallet') : null,
    h('button', { type: 'button', id: 'sign-manually', class: 'menu__item', dataset: { signIn: 'manual' } }, icon('document'), 'Sign manually (advanced)'),
    h('hr', { class: 'menu__sep' }),
    menuLink('How signing in works', 'info', 'ui/help#before'),
    menuItem('Workspace settings', 'clipboard', () => openSettings('')),
    menuLink(SIBLING.name, 'external', SIBLING.href)));
  return out;
}

function accountActions() {
  const name = userShort();
  const r = S.demoRoles.find((x) => x.role === S.role);
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' }, S.mode === 'demo' ? (r ? demoLabel(r) : S.role).slice(0, 1) : icon('user', 'sm'));
  const btn = h('button', { type: 'button', class: 'user-button', popovertarget: 'user-menu', 'aria-haspopup': 'menu', 'aria-label': `Account: ${name}` },
    avatar, h('span', { class: 'user-button__name', text: name }), icon('chevron-down', 'sm'));
  const how = S.mode === 'interego' ? "Interego confirms it's you on each step." : S.mode === 'wallet' ? 'Your wallet asks you to approve each step.' : 'Sample people with demo keys.';
  const menu = h('div', { class: 'menu', id: 'user-menu', popover: true },
    h('div', { class: 'menu__header' }, h('strong', { id: 'acting-as', text: actingAs() }), h('span', { class: 'text-sm text-tertiary', text: how })));
  const i = S.interego;
  if (S.mode === 'interego' && i) {
    if (i.principal) {
      menu.append(h('div', { class: 'menu__field' },
        h('label', { class: 'label', for: 'interego-did', text: 'Your Member ID' }),
        h('div', { class: 'input-group' },
          h('input', { type: 'text', id: 'interego-did', class: 'input input--mono', readOnly: true, value: i.principal, 'aria-label': 'Your Member ID' }),
          h('button', { type: 'button', id: 'copy-member-id', class: 'btn btn--secondary btn--sm', text: 'Copy', onclick: () => {
            S.copiedMemberId = true;
            copyText(i.principal, 'Member ID');
          } })),
        h('p', { class: 'hint', text: 'Send it to your admin so they can give you a role.' })));
    }
    const until = new Date(i.expiresAt).toLocaleTimeString();
    menu.append(h('p', { class: 'menu__text', text: `Signed in until ${until}.` }),
      h('details', { class: 'disclosure' }, h('summary', { text: 'About this sign-in' }),
        h('div', { class: 'disclosure__body disclosure__body--tech' },
          h('p', { text: `Relay-attested, not user-held: the Interego relay signs each act for this agent and this bridge reads it as you. This tab holds the relay's access token for this sign-in until ${until} (an hour at most): it passes through this bridge on every act it signs, and while it lasts whoever holds it can call the relay's tools as you.` }),
          h('p', { text: `Member ID: ${i.principal || 'not known yet'}` }),
          h('p', {}, 'Signed by agent: ', h('span', { id: 'interego-agent', text: i.agentId || 'not known yet' })))));
  }
  if (S.mode === 'wallet') menu.append(h('p', { class: 'menu__text mono', text: S.account }));
  menu.append(...(S.mode === 'demo' ? [] : [h('hr', { class: 'menu__sep' })]),
    menuItem('Getting started', 'check', () => { forget(CHECKLIST_HIDDEN_KEY); S.checklistOpen = true; go('#/practice'); }),
    menuItem('Use my own AI provider key', 'sparkle', () => openSettings('byok')),
    menuItem('Workspace settings', 'clipboard', () => openSettings('')),
    menuLink('Help and guides', 'info', 'ui/help'),
    menuLink(SIBLING.name, 'external', SIBLING.href));
  if (S.mode === 'interego') {
    menu.append(h('hr', { class: 'menu__sep' }),
      h('button', { type: 'button', id: 'interego-sign-out', class: 'menu__item menu__item--danger', onclick: () => signOutInterego() }, icon('sign-in'), 'Sign out'));
  }
  return [btn, menu];
}

/**
 * Which AI steps a key of your own is used for here. A workspace offers replies and assessments in
 * the web app only when it has a built-in AI (the attempt's own next steps say so), so on one with
 * none a key is used for drafts only.
 */
function byokHint(b) {
  const replies = !b || b.counterpartRoute !== 'none';
  const assessments = !b || b.judgeRoute !== 'none';
  if (!replies && !assessments) return 'Used for AI drafts of scenarios. To practice or be assessed here, use your own AI assistant. Sent with each draft, used once, never stored.';
  const steps = [replies ? 'replies' : null, assessments ? 'assessments' : null, 'drafts'].filter(Boolean);
  return `AI steps this workspace offers: ${steps.length === 3 ? 'replies, assessments and drafts' : steps.join(' and ')}. Sent with each one, used once, never stored.`;
}

function workspaceDialog() {
  const d = h('dialog', { id: 'workspace-settings', class: 'modal', 'aria-labelledby': 'ws-title', 'aria-describedby': 'ws-desc' });
  const b = S.bridge;
  const podInput = h('input', { type: 'url', id: 'pod-url', class: 'input', value: S.pod, placeholder: 'https://storage.example/practice/' });
  const useStorage = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Use this storage', onclick: () => {
    S.pod = podInput.value.trim(); S.needPod = !S.pod; S.readEnvelopes.clear();
    if (S.mode === 'interego' && S.interego && !S.interego.principal) confirmInteregoSignIn();
    closeDialog(d);
    route();
  } });
  const key = h('input', { type: 'password', class: 'input', autocomplete: 'off', value: S.byok.key, 'aria-label': 'Your model key', oninput: (e) => { S.byok.key = e.target.value; } });
  const model = h('input', { type: 'text', class: 'input', value: S.byok.model, 'aria-label': 'Your model id', oninput: (e) => { S.byok.model = e.target.value; } });
  const fields = h('div', { class: 'form', hidden: !S.byok.on },
    formField({ label: 'API key', control: key, hint: 'Kept in this tab only, and sent only with the step you press.' }),
    formField({ label: 'Model ID', control: model }));
  const toggle = h('input', { type: 'checkbox', id: 'byok', class: 'switch', role: 'switch', checked: S.byok.on, onchange: (e) => {
    S.byok.on = e.target.checked;
    fields.hidden = !S.byok.on;
    renderStatusLines();
  } });
  const about = [];
  if (b) {
    about.push(h('dl', { class: 'kv' },
      h('dt', { text: 'AI role-player' }), h('dd', { text: routePlain(b.counterpartRoute, b) }),
      h('dt', { text: 'AI judge' }), h('dd', { text: routePlain(b.judgeRoute, b) }),
      h('dt', { text: 'Service signing key' }), h('dd', { text: KEY_WORDS[b.keyKind] || b.keyKind })));
    about.push(tech([`other person: ${routeWords(b.counterpartRoute, b)}`, `judge: ${routeWords(b.judgeRoute, b)}`, `platform key: ${b.keyKind} ${b.platformAddress}`,
      `pod: ${S.pod}`, `served pods: ${Array.isArray(b.servedPods) ? b.servedPods.join(', ') : b.servedPods}`,
      b.attemptsPerHour ? `attempts per hour: ${JSON.stringify(b.attemptsPerHour)}` : null]));
  }
  d.append(
    h('div', { class: 'modal__header' }, h('div', {},
      h('h2', { class: 'modal__title', id: 'ws-title', text: 'Workspace settings' }),
      h('p', { class: 'modal__desc', id: 'ws-desc', text: 'These settings apply to this browser tab only.' })),
    h('button', { type: 'button', class: 'btn btn--ghost btn--icon modal__close', 'aria-label': 'Close', onclick: () => closeDialog(d) }, icon('close'))),
    h('div', { class: 'modal__body settings' },
      h('section', { class: 'settings__section' }, h('h3', { text: 'Storage' }),
        formField({ label: 'Storage address', control: podInput, hint: 'Where this workspace keeps its records. Interego calls this a pod.' }), useStorage),
      about.length ? h('section', { class: 'settings__section' }, h('h3', { text: 'About this workspace' }), about) : null,
      h('section', { class: 'settings__section', id: 'byok-section' }, h('h3', { text: 'Your own AI provider key (advanced)' }),
        h('label', { class: 'choice' }, toggle, h('span', { class: 'choice__text' }, 'Use my own AI provider key for AI steps in this tab',
          h('span', { class: 'choice__hint', text: byokHint(b) }))),
        fields)),
    h('div', { class: 'modal__footer' }, h('button', { type: 'button', class: 'btn btn--primary', text: 'Done', onclick: () => closeDialog(d) })));
  d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });
  return d;
}

function statusLines() {
  const b = S.bridge;
  const out = [];
  if (S.byok.on) {
    out.push(h('div', { class: 'status-line' }, h('span', {}, icon('sparkle', 'sm'), 'Your own AI key is on for this tab.'),
      h('button', { type: 'button', class: 'btn btn--link', text: 'Turn off', onclick: () => { S.byok.on = false; renderHeader(); } })));
  }
  if (!b) return out;
  if (b.counterpartRoute === 'none') {
    out.push(h('div', { class: 'status-line' }, h('span', {}, icon('info', 'sm'), 'AI role-player: use your own AI assistant.'), h('a', { href: 'ui/help#claude-chatgpt', text: 'How?' })));
  }
  if (b.keyKind === 'ephemeral') {
    out.push(h('div', { class: 'status-line status-line--warning' },
      h('span', {}, icon('warning', 'sm'), "This service's signing key is temporary, so records written now won't be trusted after it restarts. Tell your workspace administrator."),
      tech(['This bridge\'s signing key is ephemeral: records it writes now become untrusted after it restarts, unless the operator adds its address to PEV_TRUSTED_PLATFORM_ADDRESSES.'])));
  }
  if (b.keyKind === 'demo-fixture' && S.mode !== 'demo') {
    out.push(h('div', { class: 'status-line status-line--warning' }, h('span', {}, icon('warning', 'sm'), 'This service signs with a public demo key, so its records prove nothing outside this demo.')));
  }
  return out;
}

function renderStatusLines() {
  const box = $('#status-lines');
  if (box) clear(box).append(...statusLines());
}

function renderHeader() {
  const bar = clear($('#bar'));
  if (S.mode === 'demo') bar.append(demoBanner());
  const actions = h('div', { class: 'app-header__actions' }, productSwitch(), S.mode === 'paste' ? signedOutActions() : accountActions());
  const brand = h('a', { class: 'brand', href: '#/practice' }, brandMark(),
    h('span', { class: 'brand__name' }, h('span', { class: 'brand__company', text: 'Interego' }), h('span', { class: 'brand__product', text: 'Practice Evidence' })));
  bar.append(h('header', { class: 'app-header' }, h('div', { class: 'app-header__inner' }, brand, actions)));
  bar.append(workspaceDialog());
  bar.append(h('div', { id: 'status-lines' }, statusLines()));
  placeMenus();
}

function remember(k, v) { try { localStorage.setItem(k, v); } catch { /* storage is optional */ } }
function forget(k) { try { localStorage.removeItem(k); } catch { /* storage is optional */ } }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

const NAV = [
  ['Practice', [['practice', '#/practice', 'Practice', 'chat'], ['mine', '#/mine', 'My practice', 'user']]],
  ['Review', [['review', '#/review', 'To review', 'clipboard'], ['calibration', '#/calibration', 'AI judge quality', 'chart']]],
  ['Author', [['author', '#/author', 'Write a scenario', 'document']]],
  ['Admin', [['roles', '#/roles', 'Team', 'people']]],
];

/** Which navigation item a hash belongs to. */
function navOf(hash) {
  const [, name] = /^#\/([a-z]+)/.exec(hash || '') || [];
  if (name === 'signin') return null;
  if (name === 'mine' || name === 'attempt') return 'mine';
  if (name === 'review' || name === 'calibration' || name === 'author' || name === 'roles') return name;
  return 'practice';
}

function renderTabs() {
  const nav = clear($('#tabs'));
  const here = navOf(location.hash);
  for (const [group, items] of NAV) {
    nav.append(h('div', { class: 'side-nav__group' }, h('span', { class: 'side-nav__label', text: group }), items.map(([key, href, label, ic]) => h('a', {
      class: 'side-nav__link', href, 'aria-current': key === here ? 'page' : null,
    }, icon(ic), label, key === 'review' && typeof S.queueCount === 'number' ? h('span', { class: 'side-nav__count', text: String(S.queueCount) }) : null))));
  }
  nav.append(h('div', { class: 'side-nav__footer' }, h('a', { class: 'side-nav__link', href: 'ui/help' }, icon('info'), 'Help')));
  nav.append(h('a', { class: 'side-nav__link side-nav__mobile-only', href: 'ui/help' }, icon('info'), 'Help'));
  if (!nav.dataset.watched) {
    nav.dataset.watched = '1';
    nav.addEventListener('scroll', () => markTabEdges(nav), { passive: true });
    addEventListener('resize', () => { revealCurrentTab(nav); markTabEdges(nav); });
  }
  revealCurrentTab(nav);
  markTabEdges(nav);
}

/** On a phone the navigation is one scrolling row: the current item is scrolled into it, clear of the edge fade. */
function revealCurrentTab(nav) {
  const cur = nav.querySelector('.side-nav__link[aria-current="page"]');
  if (!cur || !(nav.scrollWidth > nav.clientWidth)) return;
  const pad = 48;
  const left = cur.offsetLeft;
  const right = left + cur.offsetWidth;
  if (left < nav.scrollLeft + pad) nav.scrollLeft = Math.max(0, left - pad);
  else if (right > nav.scrollLeft + nav.clientWidth - pad) nav.scrollLeft = right - nav.clientWidth + pad;
}

/** Which ends of that row have more items past them, for the fade that says so (app.css). */
function markTabEdges(nav) {
  const more = nav.scrollWidth > nav.clientWidth + 1;
  const mark = (name, on) => { if (on) nav.setAttribute(name, ''); else nav.removeAttribute(name); };
  mark('data-more-start', more && nav.scrollLeft > 1);
  mark('data-more-end', more && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
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
  // A new view starts at the top; the same view drawn again keeps its place.
  if (hash !== S.lastRoute) {
    S.lastRoute = hash;
    const se = document.scrollingElement || document.documentElement;
    if (se) se.scrollTop = 0;
  }
  // Signed reads can take seconds (each is a signing round trip, then the workspace's storage): the
  // view says it is loading until its data is in, below whatever it could draw at once.
  const loading = loadingLine();
  root.append(loading);
  try {
    if (S.needPod && name !== 'roles' && name !== 'signin') { root.append(needStorageNote()); return; }
    let pending;
    if (name === 'signin') viewSignIn(root);
    else if (name === 'attempt' && param) pending = viewAttempt(root, param, seq);
    else if (name === 'review' && param) pending = viewReview(root, param, seq);
    else if (name === 'review') pending = viewQueue(root);
    else if (name === 'results' && param) pending = viewResults(root, param);
    else if (name === 'calibration') pending = viewCalibration(root);
    else if (name === 'author') pending = viewAuthor(root, param);
    else if (name === 'roles') viewRoles(root);
    else if (name === 'mine') pending = viewMine(root);
    else pending = viewPractice(root);
    // Below the page header and anything else the view drew before its first wait.
    if (pending && loading.isConnected) root.append(loading);
    else loading.remove();
    await pending;
  } catch (e) {
    if (seq !== S.seq) return;
    if (e instanceof NeedsSignIn) root.append(signInGate(name || 'practice'));
    else root.append(problemCallout(e, { retry: () => route() }));
  } finally {
    loading.remove();
  }
}

function loadingLine() {
  return h('div', { class: 'view-loading', role: 'status' },
    h('p', { class: 'busy-line text-tertiary' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'),
    h('span', { class: 'skeleton skeleton--block', 'aria-hidden': 'true' }));
}

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const attemptHash = (iri) => `#/attempt/${encodeURIComponent(iri)}`;
const podArgs = (extra) => ({ ...(S.pod ? { pod_url: S.pod } : {}), ...(extra || {}) });

function needStorageNote() {
  document.title = 'Choose storage · Practice Evidence';
  return callout({ tone: 'warning', title: "Choose this workspace's storage", body: 'This workspace has no storage set up yet. Enter the storage address your admin gave you in Workspace settings.',
    actions: [h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Workspace settings', onclick: () => openSettings('pod-url') })] });
}

function viewSignIn(root) {
  if (S.mode !== 'paste') { go('#/practice'); return; }
  document.title = 'Sign in · Practice Evidence';
  root.append(signInGate('signin'));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Practice: the scenarios, the welcome and the Getting started checklist
// ════════════════════════════════════════════════════════════════════════════════════════════

function welcomeCard() {
  const primary = interegoOffered() ? signInButton('interego', 'Sign in with Interego', 'lg')
    : S.hasWallet ? signInButton('wallet', 'Use a crypto wallet', 'lg') : signInButton('manual', 'Sign manually (advanced)', 'lg');
  const point = (ic, lead, rest) => h('li', {}, h('span', { class: 'icon-tile' }, icon(ic)), h('p', {}, h('strong', { text: lead }), rest));
  const card = h('section', { class: 'card card--highlight welcome', 'aria-labelledby': 'welcome-title' },
    h('h2', { class: 'welcome__title', id: 'welcome-title', text: 'Welcome to Practice Evidence' }),
    h('p', { class: 'welcome__lede', text: 'Rehearse real workplace conversations, get feedback against a clear rubric, and keep a signed record of your progress.' }),
    h('h3', { class: 'visually-hidden', text: 'What you can do here' }),
    h('ul', { class: 'welcome__list' },
      point('chat', 'Practice', " a conversation you're preparing for, with an AI playing the other person."),
      point('check', 'Get feedback', ' that quotes your own words, then a sign-off from a qualified reviewer.'),
      point('document', 'Keep your record.', ' Download it, check it, or ask for another review.')),
    h('div', { class: 'welcome__actions' }, primary, h('a', { class: 'btn btn--secondary btn--lg', href: 'ui/help', text: 'See how it works' })));
  if (interegoOffered()) {
    card.append(h('p', { class: 'welcome__fine', text: "First time? You'll create your Interego account with a passkey (your device's fingerprint, face or PIN) during sign-in. No password, no email." }));
  }
  if (primary.dataset.signIn !== 'manual') {
    const other = h('p', { class: 'text-sm text-secondary welcome__other' }, 'Other ways to sign in: ');
    if (S.hasWallet && primary.dataset.signIn !== 'wallet') other.append(signInButton('wallet', 'Use a crypto wallet', '', 'btn--link'), ' · ');
    other.append(signInButton('manual', 'Sign manually (advanced)', '', 'btn--link'));
    card.append(other);
  }
  return card;
}

function manualNote() {
  const other = interegoOffered() || S.hasWallet;
  return callout({ tone: 'neutral', title: "You're signing each step manually.", body: 'Each step shows the exact text to sign.',
    actions: other ? [h('button', { type: 'button', class: 'btn btn--link', text: 'Stop signing manually', onclick: () => { S.manual = false; renderHeader(); route(); } })] : [] });
}

const DEMO_CHECKLIST_ROLE = { learner: 'learner', 'second-learner': 'learner', reviewer: 'reviewer', 'second-reviewer': 'reviewer', author: 'author', admin: 'admin', 'judge-agent': 'judge' };
const CHECKLIST_ROLES = [['learner', 'Learner'], ['reviewer', 'Reviewer'], ['author', 'Author'], ['admin', 'Admin'], ['judge', 'Judge']];
const MEMBER_STEP = { member: true, title: 'Send your Member ID to your admin', text: 'Your admin uses it to give you a role.' };
/** Each role's first steps: [title, text, target] where the target is a link, a scroll, or nothing. */
const CHECKLISTS = {
  learner: [
    { signIn: true, title: 'Sign in with Interego', text: "Your Interego account is how Practice Evidence knows it's you." },
    { member: true, title: 'Copy your Member ID and send it to your admin', text: 'Your admin uses this to give you a role.' },
    { practice: true, title: 'Pick a scenario', text: "Read what you're practicing and open the rubric.", scroll: '#scenarios', label: 'See scenarios' },
    { practice: true, title: 'Start', text: 'Say whether anyone helped you prepare, then press Start practice.' },
    { practice: true, title: 'Have the conversation', text: 'Type your line and press Send, or let your own AI play the other person. Finish when you are ready.' },
    { title: 'Get your feedback', text: 'Press Get AI assessment when the workspace has built-in AI. Otherwise, your appointed judge will assess the session.' },
    { title: 'After review', text: 'Download your record, request another review, or share it as a learning record.' },
    { title: 'Practice again', text: 'Start again from the session page whenever you like.', href: '#/mine', label: 'My practice' },
  ],
  reviewer: [
    { ...MEMBER_STEP, text: 'Done when your admin has added you as a Reviewer.' },
    { title: 'Approve a rubric', text: "Open a scenario and choose Approve this rubric. You can approve only versions you didn't write.", scroll: '#scenarios', label: 'See scenarios' },
    { title: 'Open your review list', text: 'To review lists the sessions waiting for a person, most urgent first.', href: '#/review', label: 'To review' },
    { title: 'Review your first session', text: "Choose a level for every criterion, and give a reason where yours differs or a quote didn't match." },
    { title: 'Sign off', text: 'Confirm all levels, or Sign off my levels.' },
    { title: 'See results and AI judge quality', text: 'Spot patterns across sessions and AI judges.', href: '#/calibration', label: 'AI judge quality' },
  ],
  author: [
    { ...MEMBER_STEP, text: 'Done when your admin has added you as an Author.' },
    { title: 'Write your first scenario', text: 'Describe the situation, the person to practice with, and the rubric.', href: '#/author', label: 'Write a scenario' },
    { title: 'Optional: start from an AI draft', text: 'Draft with AI, draft with your own AI, or paste a draft.' },
    { title: 'Make the two decisions', text: 'How it will be used, and how clear-cut good performance is.' },
    { title: 'Write the rubric', text: 'Up to 12 criteria, each with 2 to 6 levels from lowest to highest.' },
    { title: 'Say who helped write it', text: "Required: saying nothing isn't the same as \"no one\"." },
    { title: 'Save a draft, then try it yourself', text: 'Your own sessions are test runs: never reviewed, counted or shared.' },
    { title: 'Publish', text: 'Learners can start it once it is published.' },
    { title: 'Ask a reviewer to approve the rubric', text: "Results won't count as evidence until a reviewer who didn't write it approves it." },
    { title: 'Check results', text: 'Each scenario card has a Results link.' },
  ],
  admin: [
    { title: "Check you're an admin", text: 'Admin access is set up with your workspace. If Team says only an admin can change roles, ask the person who set it up.', href: '#/roles', label: 'Team' },
    { title: 'Add your authors', text: 'Team: paste their Member ID, choose Author, then Save change.', href: '#/roles', label: 'Team' },
    { title: 'Add at least two reviewers', text: "Two or more, so a rubric can be approved by someone who didn't write it, and a re-review can go to a different person." },
    { title: 'Add your learners', text: "Recommended. If your workspace has a built-in AI, it's usually available only to people on your team." },
    { title: 'Optional: appoint a judge', text: "Needed if your workspace has no built-in AI. A judge can't assess their own practice, or review a session they assessed." },
    { title: 'Know your admin tools', text: 'On any session: Withdraw the review (the learner sees your reason) and Delete conversation text (a reason is required).' },
    { title: 'Check AI judge quality', text: 'How often each AI judge agrees with your reviewers.', href: '#/calibration', label: 'AI judge quality' },
  ],
  judge: [
    { ...MEMBER_STEP, text: 'Done when your admin has added you as a Judge.' },
    { title: 'Connect Claude or ChatGPT', text: 'Add the Interego connector, then sign in.', href: 'ui/help#claude-chatgpt', label: 'How to connect' },
    { title: "Assess a session you've been given", text: "Ask your assistant for the judge hand-off, assess, and save it. You can't assess your own practice, and a reviewer has the final say." },
  ],
};

function checklistVisible() { return S.mode !== 'paste' && recall(CHECKLIST_HIDDEN_KEY) !== '1'; }

/** True when an attempt in a list is the signer's own: an address as its did:ethr (case-insensitive), a DID as it is. */
function isOwnAttempt(a, principal) {
  if (typeof principal !== 'string' || !principal || typeof a.learner !== 'string') return false;
  const did = /^0x[0-9a-fA-F]{40}$/.test(principal) ? `did:ethr:${principal}` : principal;
  return did.startsWith('did:ethr:') ? a.learner.toLowerCase() === did.toLowerCase() : a.learner === did;
}

/** What an attempt list read as this person says about them: any session they can see, and any of their own. */
function learnSessions(r) {
  if (!r || !Array.isArray(r.attempts)) return;
  const me = r.signedAs && r.signedAs.principal;
  S.sessions = { any: r.attempts.length > 0, own: r.attempts.some((a) => isOwnAttempt(a, me)) };
}

/**
 * Getting started: each role's first steps. Done-ness comes only from what the app knows (signed
 * in, the Member ID copied, sessions of one's own), so it shows no count that could stall. Once the
 * person can see any session the card starts collapsed. It paints itself into `slot`.
 */
function paintChecklist(slot) {
  const repaint = () => paintChecklist(slot);
  clear(slot);
  const role = S.checklistRole || (S.mode === 'demo' ? DEMO_CHECKLIST_ROLE[S.role] : null) || 'learner';
  const practiced = Boolean(S.sessions && S.sessions.own);
  const hide = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Hide', onclick: () => { remember(CHECKLIST_HIDDEN_KEY, '1'); clear(slot); } });
  const collapsed = S.checklistOpen === false || (S.checklistOpen === null && Boolean(S.sessions && S.sessions.any));
  if (collapsed) {
    slot.append(h('section', { class: 'checklist checklist--collapsed', 'aria-labelledby': 'gs-title' },
      h('div', { class: 'checklist__header' },
        h('div', { class: 'split' }, h('div', {}, h('h2', { class: 'checklist__title', id: 'gs-title', text: 'Getting started' }),
          h('p', { class: 'checklist__meta', text: 'The first steps for each role, whenever you need them.' })),
        h('div', { class: 'btn-group' },
          h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'aria-expanded': 'false', text: 'Show steps', onclick: () => { S.checklistOpen = true; repaint(); } }),
          hide)))));
    return;
  }
  const steps = CHECKLISTS[role];
  const isDone = (s) => (s.signIn && S.mode !== 'paste') || (s.member && (S.copiedMemberId || S.mode === 'demo' || (role === 'learner' && practiced)))
    || (s.practice && practiced);
  const current = steps.findIndex((s) => !isDone(s));
  const picker = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show steps for' }, CHECKLIST_ROLES.map(([k, label]) => h('button', {
    type: 'button', 'aria-pressed': k === role ? 'true' : 'false', text: label, onclick: () => { S.checklistRole = k; repaint(); },
  })));
  const memberText = S.mode === 'demo' ? 'Demo people already have roles.' : null;
  const item = (s, i) => {
    const d = isDone(s);
    const state = d ? 'done' : i === current ? 'current' : null;
    const cls = state === 'current' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm';
    let action = null;
    if (!d && s.member) {
      const principal = S.interego && S.interego.principal;
      const value = principal || S.account;
      if (value) action = h('button', { type: 'button', class: cls, text: principal ? 'Copy my Member ID' : 'Copy my wallet address', onclick: () => { S.copiedMemberId = true; copyText(value, principal ? 'Member ID' : 'Wallet address'); repaint(); } });
    } else if (s.href) action = h('a', { class: cls, href: s.href, text: s.label });
    else if (s.scroll && !d) action = h('button', { type: 'button', class: cls, text: s.label, onclick: () => scrollToEl(s.scroll) });
    return h('li', { class: 'checklist__item', 'data-state': state },
      h('span', { class: 'checklist__mark' }, d ? icon('check') : null),
      h('p', { class: 'checklist__title-item' }, h('span', { class: 'visually-hidden', text: d ? 'Done: ' : i === current ? 'Next step: ' : '' }), s.title),
      h('p', { class: 'checklist__text', text: s.member && memberText ? memberText : s.text }),
      action ? h('div', { class: 'checklist__action' }, action) : null);
  };
  const limit = S.checklistAll || current < 0 ? steps.length : current + 3;
  const hidden = steps.length - Math.min(limit, steps.length);
  const collapse = S.sessions && S.sessions.any
    ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-expanded': 'true', text: 'Collapse', onclick: () => { S.checklistOpen = false; repaint(); } }) : null;
  slot.append(h('section', { class: 'checklist', 'aria-labelledby': 'gs-title' },
    h('div', { class: 'checklist__header' },
      h('div', { class: 'split' }, h('h2', { class: 'checklist__title', id: 'gs-title', text: 'Getting started' }), h('div', { class: 'btn-group' }, collapse, hide)),
      h('div', { class: 'checklist__picker' }, h('span', { text: 'Show steps for' }), picker)),
    h('ol', { class: 'checklist__list' }, steps.slice(0, limit).map(item)),
    hidden > 0 || S.checklistAll ? h('div', { class: 'checklist__footer' }, h('button', { type: 'button', class: 'btn btn--link',
      text: S.checklistAll ? 'Show fewer steps' : `Show all ${steps.length} steps`, onclick: () => { S.checklistAll = !S.checklistAll; repaint(); } })) : null));
}

/**
 * The Getting started card's place on Practice. When it is not yet known whether the person has
 * any session and the bridge signs for demo roles (so asking costs no one a signature), it asks
 * first, then paints; otherwise it paints at once.
 */
function checklistSlot() {
  const slot = h('div', { class: 'checklist-slot' });
  if (S.sessions === null && S.mode === 'demo') {
    act(ACT.getAttempt, {}, { read: true }).then(learnSessions, () => {}).finally(() => { if (slot.isConnected) paintChecklist(slot); });
  } else paintChecklist(slot);
  return slot;
}

async function viewPractice(root) {
  const drafts = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: S.showDrafts, onchange: (e) => { S.showDrafts = e.target.checked; route(); } });
  root.append(pageHeader({ title: 'Practice scenarios', lede: 'Pick a scenario, read what it asks of you, and have the conversation. AI plays the other person.',
    actions: [h('label', { class: 'choice' }, drafts, h('span', { class: 'choice__text', text: 'Include drafts (authors can try their own)' }))] }));
  if (S.mode === 'paste' && !S.manual) root.append(welcomeCard(), para("Browse the scenarios below. You'll need to sign in to start one."));
  else if (S.mode === 'paste') root.append(manualNote());
  else if (checklistVisible()) root.append(checklistSlot());
  const r = await invoke(ACT.listScenarios, podArgs({ include_drafts: S.showDrafts ? 'true' : undefined }));
  S.pod = r.podUrl;
  S.bridge = r.bridge;
  renderHeader();
  if (r.bridge && r.bridge.counterpartRoute === 'none') {
    root.append(callout({ tone: 'info', title: 'This workspace has no built-in AI role-player',
      body: 'You can still practice: start a scenario and choose Let my AI play the other person, using Claude or ChatGPT with the Interego connector.',
      actions: [linkButton('ui/help#claude-chatgpt', 'How to use Claude or ChatGPT', 'btn--secondary btn--sm')] }));
  }
  // A scenario this bridge cannot open (sealed to another record key, or not read) is never shown as absent.
  root.append(...coverageNotes(r));
  if (!r.scenarios.length && whole(r)) {
    root.append(emptyState({ icon: 'chat', title: 'No practice scenarios yet', text: "Your team's authors haven't published one yet. Check back soon.",
      actions: [linkButton('#/author', 'Write the first one (authors)')] }));
  }
  if (r.scenarios.length) root.append(h('div', { class: 'scenario-list', id: 'scenarios' }, r.scenarios.map(scenarioCard)));
}

/**
 * What an answer read from the pod says about how much of the pod it covers. When it is not the
 * whole pod (`complete: false`: records sealed to another key, records the pod would not serve, or
 * the act's read limit reached) the page says so first, and shows no "none yet" prompt: an empty
 * list then means only that nothing could be read.
 */
function coverageNotes(r) {
  const out = [];
  if (!whole(r)) {
    out.push(callout({ tone: 'warning', role: 'status', extraClass: 'incomplete', title: 'This list may be incomplete',
      body: "Some records couldn't be opened, so this list may be incomplete. If something you expect is missing, tell your admin." }));
  }
  if (r.untrustedRecordsSkipped) out.push(para(`${r.untrustedRecordsSkipped} records were skipped because their signature couldn't be verified.`, 'text-sm text-secondary'));
  const notes = [r.readLimitReached && r.readLimitReached.note, r.sealedRecords && r.sealedRecords.note, r.recordKeyMismatch && r.recordKeyMismatch.note].filter(Boolean);
  if (notes.length) out.push(tech(notes));
  return out;
}

/** True unless the answer says it is not the whole pod. */
function whole(r) { return r.complete !== false; }

function rubricView(rubric, use) {
  const gate = use === 'pass-gate';
  const wrap = h('div', { class: 'rubric' });
  for (const c of rubric.criteria) {
    wrap.append(h('div', { class: 'criterion' },
      h('h4', {}, c.title, gate && c.weight !== null && c.weight !== undefined ? badge(`Weight ${c.weight}`, '', 'How much this criterion counts toward the score.') : null),
      c.description ? para(c.description) : null,
      h('ol', {}, c.levels.map((l) => h('li', {}, h('strong', { text: l.label }), gate && l.value !== null && l.value !== undefined ? ` (${l.value} points)` : '', `: ${l.descriptor}`)))));
  }
  if (gate && rubric.passRule) {
    const req = Object.entries(rubric.passRule.requiredLevels || {});
    wrap.append(h('p', { class: 'label', text: `Pass mark: at least ${rubric.passRule.minPercent}%${req.length ? `, and ${req.map(([c, l]) => `${criterionTitle(rubric, c)} at least ${levelLabel(rubric, c, l)}`).join(', ')}` : ''}.` }));
  }
  return wrap;
}

/** "Did anyone help you prepare?", then Start. The radios are read when Start is pressed. */
function startForm(scenarioIri, versionOf, label) {
  const name = nextId('coached');
  const yes = h('input', { type: 'radio', name, value: 'yes' });
  const no = h('input', { type: 'radio', name, value: 'no' });
  const help = h('input', { type: 'text', class: 'input', name: 'assistance', maxlength: 300, placeholder: 'For example: a coach helped me' });
  const out = h('div', { class: 'outcome' });
  const legendId = nextId('coached-legend');
  const btn = h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: ACT.startAttempt }, onclick: () => busy(btn, out, async () => {
    if (!yes.checked && !no.checked) return errorText('Please say whether anyone helped you prepare.');
    const version = await versionOf();
    const r = await act(ACT.startAttempt, { scenarioIri, scenarioVersion: version, coached: yes.checked, ...(help.value.trim() ? { assistance: help.value.trim() } : {}) });
    S.sessions = { any: true, own: true };
    go(attemptHash(r.attemptIri));
    return null;
  }, { progress: 'Starting…' }) }, icon('chat'), label);
  return [
    h('fieldset', { class: 'fieldset', 'aria-describedby': legendId },
      h('legend', { class: 'legend', text: 'Did anyone help you prepare for this session?' }),
      h('p', { class: 'hint', id: legendId, text: "This is recorded with your result. Saying nothing isn't the same as \"no help\"." }),
      h('div', { class: 'choice-group choice-group--inline' },
        h('label', { class: 'choice' }, no, h('span', { class: 'choice__text', text: 'No' })),
        h('label', { class: 'choice' }, yes, h('span', { class: 'choice__text', text: 'Yes' })))),
    formField({ label: 'What help?', optional: true, control: help }),
    btn, out,
  ];
}

function scenarioCard(s) {
  const card = h('article', { class: 'card scenario', dataset: { scenario: s.scenarioIri } });
  const gate = s.assessmentUse === 'pass-gate';
  const regime = REGIME_WORDS[s.workRegime] || [s.workRegime, ''];
  card.append(h('div', { class: 'card__header' },
    h('div', {}, h('h2', { class: 'card__title', text: s.title }), h('p', { class: 'card__subtitle', text: `Version ${s.version} · You'll talk with ${s.counterpart.name}` })),
    s.status === 'draft' ? statusPill('Draft', 'pending') : statusPill('Published', 'success')));
  const body = h('div', { class: 'card__body' });
  body.append(h('dl', { class: 'kv' },
    h('dt', { text: "What you're practicing" }), h('dd', { text: s.learnerGoal }),
    h('dt', { text: 'Your part' }), h('dd', { text: s.learnerPart }),
    h('dt', { text: 'The situation' }), h('dd', { text: s.situation }),
    h('dt', { text: "You'll talk with" }), h('dd', { text: s.counterpart.name }),
    h('dt', { text: 'How they open' }), h('dd', { text: `“${s.firstLine}”` })));
  body.append(h('div', { class: 'cluster' },
    gate ? badge(`Scored · pass mark ${s.rubric.passRule ? s.rubric.passRule.minPercent : '?'}%`, '', 'Only for scored scenarios: how much each criterion counts, and how many points each level is worth.') : badge('Feedback only (no score)'),
    badge(`Good performance is: ${regime[0]}`, '', regime[1] || "How clear-cut it is to say what good looks like here."),
    s.ratified ? badge('Rubric approved by a reviewer', 'success', 'A reviewer who did not write it approved the rubric, so results can count as evidence.', 'check')
      : badge("Rubric awaiting approval: results won't count as evidence yet", 'warning')));
  if (s.passGateWhy) body.append(para(`Why a pass mark fits: ${s.passGateWhy}`, 'text-sm text-secondary'));
  const da = s.draftAssistance || {};
  body.append(para(da.measured
    ? `Drafted with ${da.provider === 'scripted' ? 'the sample AI (demo)' : `AI (${[da.provider, da.model].filter(Boolean).join(' ')})`}; ${da.editedAfterDraft ? 'edited by the author afterwards' : 'not edited afterwards'}.`
    : da.used ? `The author declared help from ${BY[da.by] || da.by}${da.provider ? ` (${da.provider}${da.model ? ` ${da.model}` : ''})` : ''}.`
      : 'The author declared no AI help.', 'text-sm text-secondary'));
  body.append(h('details', { class: 'disclosure rubric-view' }, h('summary', { text: `Read the rubric (${s.rubric.criteria.length} ${s.rubric.criteria.length === 1 ? 'criterion' : 'criteria'})` }),
    h('div', { class: 'disclosure__body' }, rubricView(s.rubric, s.assessmentUse),
      tech([`Rubric fingerprint ${s.rubricHash}`, `Scenario ${s.scenarioIri}`, `Status ${s.status}`, s.ratifiedBy ? `Approved by ${s.ratifiedBy}` : null,
        `Criterion ids: ${s.rubric.criteria.map((c) => c.id).join(', ')}`]))));
  body.append(h('div', { class: 'evidence-note' }, para(s.ratified ? 'Reviewed results on this version can count as practice evidence.'
    : 'Results on this version will count as evidence once a reviewer approves the rubric.', 'text-sm text-tertiary'), tech([s.evidenceNote])));
  card.append(body);
  if (s.status !== 'draft' || S.showDrafts) {
    card.append(h('div', { class: 'card__footer scenario__start' },
      startForm(s.scenarioIri, async () => s.version, s.status === 'draft' ? 'Try it yourself (test run)' : 'Start practice')));
  }
  // Results, editing and approving are team tools: a demo learner, whose roles are known, never sees them.
  if (S.mode === 'demo' && DEMO_CHECKLIST_ROLE[S.role] === 'learner') return card;
  const out = h('div', { class: 'outcome' });
  const links = h('div', { class: 'card__footer scenario__links', role: 'group', 'aria-label': 'For authors, reviewers and admins' },
    h('span', { class: 'scenario__links-label', text: 'For authors, reviewers and admins' }),
    linkButton(`#/results/${encodeURIComponent(s.scenarioIri)}`, 'Results', 'btn--ghost btn--sm', 'chart'),
    linkButton(`#/author/${encodeURIComponent(s.scenarioIri)}`, 'Edit (authors)', 'btn--ghost btn--sm', 'document'));
  if (s.status === 'published') {
    const rat = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Approve this rubric (reviewers)', dataset: { action: ACT.ratifyScenario }, onclick: () => busy(rat, out, async () => {
      const r = await act(ACT.ratifyScenario, { scenarioIri: s.scenarioIri, version: s.version, scenarioHash: s.scenarioHash });
      toast({ tone: 'success', title: 'Rubric approved', text: `Version ${r.version} is approved.` });
      setTimeout(route, 0);
      return callout({ tone: 'success', title: 'Rubric approved', body: `Version ${r.version} is approved. Reviewed results on it can now count as evidence.` });
    }, { progress: 'Saving…' }) });
    links.append(rat);
  }
  links.append(out);
  card.append(links);
  return card;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  A practice session: conversation, feedback, result, reviews, sharing, the learner's record
// ════════════════════════════════════════════════════════════════════════════════════════════

async function viewAttempt(root, iri, seq) {
  const v = await act(ACT.getAttempt, { attemptIri: iri }, { read: true });
  if (seq !== S.seq) return;
  root.append(renderAttempt(v, {}));
}

function attemptLede(v) {
  const name = v.counterpartName;
  const withdrawn = [...(v.reopenings || [])].reverse().find((r) => r.kind === 'retract-for-cause');
  switch (v.state) {
    case 'in-conversation': return `Talk it through with ${name}. Finish when you're ready.`;
    case 'ended': return 'The conversation is finished. Next: get your feedback.';
    case 'judged': return 'The AI has suggested levels. A reviewer still needs to sign off before this counts.';
    case 'countersigned': case 'overridden': return 'A reviewer has signed off. This is your final result.';
    case 'contested': return 'You asked for another review. A different reviewer will look at it.';
    case 'review-retracted': return `The review was withdrawn: ${(withdrawn && withdrawn.why) || 'no reason given'}. The session is back in the review list.`;
    case 'redacted': return v.finalAssessment ? 'The conversation text was deleted from this workspace. The reviewed result is kept.' : 'The conversation text was deleted from this workspace.';
    default: return '';
  }
}

function attemptMeta(v) {
  const scored = v.assessmentUse === 'pass-gate';
  return [
    statusPill(STATE_WORDS[v.state] || v.state, STATE_TONE[v.state] || 'pending', 'state'),
    badge(`Session ${v.attemptNumber}`, '', 'Counted per person per scenario. Starting over with a different sign-in (a new wallet, say) restarts the count.'),
    badge(v.coached ? 'Had help preparing' : 'No help preparing'),
    badge(scored ? 'Scored · pass mark' : 'Feedback only'),
    // From the result itself: a review that still stands is final, whatever happened to the text since.
    v.finalAssessment ? badge('Final: reviewed', 'success', 'A qualified reviewer stood behind every level.')
      : v.provisional && v.state !== 'judged' ? badge('Provisional', '', 'Not yet reviewed by a person.') : null,
    v.scenario.rubricRatified ? badge('Rubric approved', 'success') : badge('Rubric awaiting approval', 'warning'),
  ];
}

function renderAttempt(v, o) {
  const frag = h('div', { class: 'attempt', dataset: { attempt: v.attemptIri, state: v.state } });
  if (!o.review) {
    frag.append(pageHeader({ crumbs: [['#/mine', 'My practice'], [null, v.scenario.title]], title: v.scenario.title, lede: attemptLede(v), meta: attemptMeta(v) }));
  }
  const notes = h('div', { class: 'attempt__notes' }, h('p', { class: 'integrity' }, icon('shield', 'sm'), 'Practice record: rehearsal, not a credential.'));
  if (v.assistance) notes.append(para(`Help declared at the start: ${v.assistance}`));
  frag.append(notes);
  if (v.authorTest) frag.append(callout({ tone: 'neutral', title: 'This is a test run', body: 'Your own sessions on your scenario are never reviewed, counted or shared.' }));
  if (v.counterpartControlledBy === 'learner') frag.append(callout({ tone: 'warning', title: "Your own AI wrote the other person's lines", body: 'The record says so, and reviewers can see it.' }));
  if (v.counterpartControlledBy === 'learner-model') frag.append(callout({ tone: 'neutral', title: "The other person's lines came from an AI you chose (your own key), following Practice Evidence's instructions." }));
  if (v.redaction) frag.append(callout({ tone: 'warning', title: 'The conversation text was deleted', body: 'Levels and fingerprints remain, so a copy you downloaded still checks out.' }));

  if (v.state === 'in-conversation') {
    frag.append(conversationPanel(v));
    const more = actionsPanel(v, o, true);
    if (more) frag.append(more);
  } else {
    if (o.hideJudge) {
      frag.append(h('section', { class: 'card' }, h('div', { class: 'card__body' }, h('h2', { class: 'card__title', text: "The AI's levels" }),
        para("Hidden until you've chosen a level for every criterion. This session is a blind check."))));
    } else {
      const a = assessmentPanel(v);
      if (a) frag.append(a);
    }
    const next = actionsPanel(v, o, false);
    if (next) frag.append(next);
    frag.append(transcriptPanel(v, o));
    if (!o.hideJudge) frag.append(judgmentsPanel(v));
    frag.append(reviewsPanel(v));
    frag.append(projectionsPanel(v));
  }
  frag.append(versionsPanel(v));
  return frag;
}

function bubble(v, t, textNode) {
  const mine = t.speaker === 'learner';
  const side = mine ? 'me' : 'them';
  const msg = h('div', { class: `chat__msg chat__msg--${side} bubble ${side}`, dataset: { turn: String(t.index) } },
    h('span', { class: 'chat__who', text: mine ? 'You' : v.counterpartName }),
    h('p', { class: 'chat__bubble text' }, textNode || (t.text !== undefined ? t.text : '(text deleted)')));
  if (!mine) {
    const rw = replyWords(t);
    if (rw) {
      const meta = h('div', { class: 'chat__meta' }, badge(rw.text, rw.tone));
      if (t.disclosure) {
        meta.append(h('details', { class: 'disclosure' }, h('summary', { text: 'Details' }),
          h('div', { class: 'disclosure__body disclosure__body--tech', text: disclosureWords(t.disclosure) })));
      }
      msg.append(meta);
    }
  }
  if (t.endSignal) msg.append(h('div', { class: 'chat__meta', text: "They signaled they're ready to wrap up." }));
  return msg;
}

function conversationPanel(v) {
  const name = v.counterpartName;
  const learnerLines = v.turns.filter((t) => t.speaker === 'learner').length;
  const out = h('div', { class: 'outcome' });
  const turnIndex = v.turns.length;
  const end = () => act(ACT.endConversation, { attemptIri: v.attemptIri, turnIndex });
  const body = h('div', { class: 'card__body' }, h('div', { class: 'chat bubbles' }, v.turns.map((t) => bubble(v, t))));

  if (v.endProposedAtTurn !== undefined && hasNext(v, 'endConversation')) {
    const banner = h('div', { class: 'callout callout--accent', id: 'end-proposed' });
    const ic = icon('info');
    ic.classList.add('callout__icon');
    const endBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Finish conversation', dataset: { action: ACT.endConversation },
      onclick: () => busy(endBtn, out, async () => { await end(); route(); return null; }, { progress: 'Finishing…' }) });
    banner.append(ic, h('p', { class: 'callout__title', text: `${name} is ready to wrap up` }),
      h('p', { class: 'callout__body', text: "They've signaled they're ready to wrap up. Finish now, or keep going." }),
      h('div', { class: 'callout__actions' }, endBtn, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Keep going', onclick: () => banner.remove() })));
    body.append(banner);
  }

  if (hasNext(v, 'say') || hasNext(v, 'recordTurns')) {
    const box = h('textarea', { id: 'line', class: 'textarea', rows: 3, maxlength: 4000, placeholder: "Type what you'd say…", 'aria-label': 'Your line' });
    box.value = S.unsent.get(v.attemptIri) || '';
    box.addEventListener('input', () => S.unsent.set(v.attemptIri, box.value));
    const composer = h('div', { class: 'composer' }, h('div', { class: 'field' }, h('label', { class: 'label visually-hidden', for: 'line', text: 'Your line' }), box));
    const send = (endAfter) => async () => {
      const text = box.value;
      if (!text.trim()) return errorText('Write your line first.');
      const r = await act(ACT.say, { attemptIri: v.attemptIri, turnIndex, text, ...(endAfter ? { endAfter: true } : {}) }, { byok: true });
      S.unsent.delete(v.attemptIri);
      afterExchange(v, r);
      return null;
    };
    if (hasNext(v, 'say')) {
      const sendBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'send', text: 'Send', dataset: { action: ACT.say }, onclick: () => busy(sendBtn, out, send(false), { progress: 'Getting a reply…' }) });
      const sendEnd = h('button', { type: 'button', class: 'btn btn--secondary', id: 'send-end', text: 'Send and finish', dataset: { action: ACT.say }, onclick: () => busy(sendEnd, out, send(true), { progress: 'Getting a reply…' }) });
      composer.append(h('div', { class: 'composer__actions' }, sendBtn, sendEnd));
    }
    body.append(composer);
    if (!hasNext(v, 'say') && hasNext(v, 'recordTurns')) {
      body.append(callout({ tone: 'info', title: 'No built-in AI here', body: `Use Let my AI play the other person below to have ${name}'s lines written by Claude or ChatGPT.` }));
    }
    if (hasNext(v, 'counterpartPacket') && hasNext(v, 'recordTurns')) body.append(packetTurnForm(v, box, out, turnIndex));
  }
  if (hasNext(v, 'endConversation') && v.endProposedAtTurn === undefined) {
    const endBtn = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Finish conversation', dataset: { action: ACT.endConversation },
      onclick: () => busy(endBtn, out, async () => { await end(); route(); return null; }, { progress: 'Finishing…' }) });
    body.append(h('div', { class: 'split conversation__finish' }, para("Finish when you've said what you need to. Then you can get your feedback.", 'text-sm text-tertiary'), endBtn));
  }
  body.append(out);
  return h('section', { class: 'card conversation' },
    h('div', { class: 'card__header' }, h('div', {}, h('h2', { class: 'card__title', text: `Conversation with ${name}` }),
      h('p', { class: 'card__subtitle', text: `${learnerLines} of ${v.turnLimit} lines used` }))),
    body);
}

/**
 * After a recorded exchange that leaves the conversation going, the attempt is shown as the act's
 * own answer leaves it (its two new lines, the end proposal, the acts that follow and the new
 * version), without reading the attempt again. An exchange that ended the conversation, or an
 * answer without those fields, reads the attempt again. A page that has moved to another view
 * meanwhile is left as it is.
 */
function afterExchange(v, r) {
  if (!r || r.state !== 'in-conversation' || !r.learnerTurn || !r.counterpartTurn || !Array.isArray(r.nextActions)) { route(); return; }
  const shown = $('#view .attempt');
  if (!shown || shown.dataset.attempt !== v.attemptIri) return;
  const them = r.counterpartTurn;
  const next = {
    ...v, state: r.state, nextActions: r.nextActions, counterpartControlledBy: r.counterpartControlledBy, currentTarget: r.currentTarget,
    headDescriptorUrl: r.descriptorUrl,
    turns: [...v.turns,
      { index: r.learnerTurn.index, speaker: 'learner', text: r.learnerTurn.text },
      { index: them.index, speaker: 'counterpart', text: them.text, ...(them.disclosure ? { disclosure: them.disclosure } : {}), ...(them.endSignal ? { endSignal: true } : {}) }],
    versions: [...(v.versions || []), { descriptorUrl: r.descriptorUrl, recordId: r.currentTarget ? r.currentTarget.recordId : null, state: r.state, modalStatus: v.modalStatus, contentDeleted: false }],
  };
  if (r.endProposed) next.endProposedAtTurn = them.index; else delete next.endProposedAtTurn;
  shown.replaceWith(renderAttempt(next, {}));
  const line = $('#line');
  if (line && typeof line.focus === 'function') line.focus();
}

function packetTurnForm(v, box, out, turnIndex) {
  const packetOut = h('div', { class: 'outcome' });
  const theirs = h('textarea', { class: 'textarea', rows: 2, maxlength: 4000, placeholder: 'Their line, as your AI wrote it (or "(end of conversation)")', 'aria-label': 'Their line' });
  const provider = h('input', { type: 'text', class: 'input', maxlength: 60, placeholder: 'For example: Anthropic', 'aria-label': 'Provider' });
  const model = h('input', { type: 'text', class: 'input', maxlength: 120, placeholder: 'As your AI app names it', 'aria-label': 'Model' });
  const endAfter = h('input', { type: 'checkbox' });
  const getBtn = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Get instructions for my AI', dataset: { action: ACT.counterpartPacket }, onclick: () => busy(getBtn, packetOut, async () => {
    if (!box.value.trim()) return errorText('Write your line first: the instructions include it.');
    const p = await act(ACT.counterpartPacket, { attemptIri: v.attemptIri, turnIndex, learnerText: box.value }, { read: true });
    // The server's instructions are written for an agent with the connector; a person gets plain steps.
    return callout({ tone: 'info', title: 'Instructions ready',
      body: `Copy these instructions into Claude or ChatGPT. Paste the line it writes for ${v.counterpartName} below, and say which AI wrote it (its provider and model).`,
      actions: [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Copy for my AI', onclick: () => copyText(JSON.stringify(p.request, null, 2), 'Instructions') })],
      kids: [h('details', { class: 'disclosure' }, h('summary', { text: 'Show the request (JSON)' }), jsonBlock(p.request))],
      techLines: [p.instructions] });
  }) });
  const recBtn = h('button', { type: 'button', class: 'btn btn--primary', text: 'Save both lines', dataset: { action: ACT.recordTurns }, onclick: () => busy(recBtn, out, async () => {
    const r = await act(ACT.recordTurns, {
      attemptIri: v.attemptIri, turnIndex, learnerText: box.value, counterpartText: theirs.value,
      counterpartDisclosure: { provider: provider.value.trim(), model: model.value.trim() }, ...(endAfter.checked ? { endAfter: true } : {}),
    });
    S.unsent.delete(v.attemptIri);
    afterExchange(v, r);
    return null;
  }, { progress: 'Saving…' }) });
  return h('details', { class: 'disclosure packet', open: !hasNext(v, 'say') },
    h('summary', { text: 'Let my AI play the other person' }),
    h('div', { class: 'disclosure__body form' },
      h('p', { text: 'Gives your AI assistant the exact instructions. The record will say your AI wrote their lines.' }),
      h('div', {}, getBtn), packetOut,
      formField({ label: 'Their line, as your AI wrote it', control: theirs }),
      h('div', { class: 'form-row' }, formField({ label: 'AI provider', control: provider }), formField({ label: 'Model', control: model })),
      h('label', { class: 'choice' }, endAfter, h('span', { class: 'choice__text', text: 'Finish after this' })),
      h('div', {}, recBtn)));
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
  const chat = h('div', { class: 'chat' });
  for (const t of v.turns) {
    const own = t.speaker === 'learner' && t.normalisedText !== undefined;
    const node = own ? marked(t.normalisedText, hl.filter((x) => x.turnIndex === t.index)) : null;
    chat.append(bubble(v, t, node));
  }
  const body = h('div', { class: 'card__body' }, chat);
  if (v.turns.some((t) => t.normalisedText !== undefined)) {
    body.append(h('p', { class: 'hint', text: 'Your lines are shown with quote marks and spacing tidied, so highlights line up exactly with what was checked.' }));
  }
  if (v.transcriptHash) body.append(tech([`Conversation fingerprint ${v.transcriptHash} (ended by ${v.endedBy || '?'})`]));
  return h('section', { class: 'card transcript' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Conversation' })), body);
}

const judgmentName = (j) => (j.index === 0 ? 'First AI assessment' : `Opinion ${j.index + 1}`);

function judgmentsPanel(v) {
  const final = Boolean(v.finalAssessment);
  const sec = h('section', { class: 'card judgments' },
    h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Feedback' }), statusPill(final ? 'Final' : 'Provisional', final ? 'success' : 'warning')));
  const body = h('div', { class: 'card__body' });
  sec.append(body);
  if (!v.judgments.length) {
    body.append(para(v.state === 'ended' && hasNext(v, 'judgeAttempt') ? 'Not assessed yet. Use Get AI assessment above.'
      : v.state === 'ended' ? 'Waiting for an appointed judge to assess this session.' : 'No assessment.'));
    return sec;
  }
  const shown = S.judgmentShown.get(v.attemptIri) || 0;
  if (v.judgments.length > 1) {
    body.append(h('div', { class: 'cluster' }, h('span', { class: 'text-sm text-secondary', text: 'Show quotes from' }),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show quotes from' }, v.judgments.map((j) => h('button', {
        type: 'button', 'aria-pressed': j.index === shown ? 'true' : 'false', text: judgmentName(j),
        onclick: () => { S.judgmentShown.set(v.attemptIri, j.index); route(); },
      })))));
  }
  const sj = v.judgments.find((j) => j.index === shown) || v.judgments[0];
  const list = h('div', { class: 'criteria-feedback' });
  for (const c of v.rubric.criteria) {
    const cj = sj.criteria.find((x) => x.criterionId === c.id);
    const block = h('div', { class: 'criterion-feedback', dataset: { criterion: c.id } });
    const head = h('div', { class: 'criterion-feedback__head' }, h('h3', { text: c.title }));
    if (cj) {
      const [tone, words] = QUOTE_STATUS[cj.status] || ['pending', cj.status];
      head.append(badge(`Level: ${levelLabel(v.rubric, c.id, cj.levelId)}`, 'accent'), statusPill(words, tone));
    }
    block.append(head);
    if (v.judgments.length > 1) {
      for (const j of v.judgments) {
        const x = j.criteria.find((y) => y.criterionId === c.id);
        if (!x) continue;
        const [tone, words] = QUOTE_STATUS[x.status] || ['pending', x.status];
        block.append(h('p', { class: 'text-sm text-secondary' }, `${judgmentName(j)}: `, h('strong', { text: levelLabel(v.rubric, c.id, x.levelId) }), ' ', statusPill(words, tone)));
      }
    }
    if (cj) {
      if (cj.status === 'unverified' && cj.why) block.append(errorText(`Not counted: ${cj.why}.`));
      if (cj.quotes.length) {
        block.append(h('ul', { class: 'quotes' }, cj.quotes.map((q) => h('li', { class: q.verified ? 'quote ok' : 'quote bad' },
          icon(q.verified ? 'check' : 'warning', 'sm'),
          h('q', { text: q.text !== undefined ? q.text : '(deleted with the conversation text)' }),
          q.verified
            ? (q.occurrences > 1 || q.declaredTurnIndex !== undefined
              ? h('span', { class: 'text-tertiary', text: [q.occurrences > 1 ? `Found ${q.occurrences} times; the first is highlighted.` : '',
                q.declaredTurnIndex !== undefined ? `The AI named line ${q.declaredTurnIndex}; it was found in line ${q.turnIndex}.` : ''].filter(Boolean).join(' ') }) : null)
            : h('span', { class: 'quote__why', text: `Didn't match: ${q.why || ''}` })))));
      } else block.append(para('No quote given.'));
      block.append(h('div', { class: 'rationale' }, h('p', { class: 'rationale__label', text: "The AI's explanation (not part of the score)" }),
        h('p', { text: cj.rationale !== undefined ? cj.rationale : '(deleted with the conversation text)' })));
      block.append(para(cj.confidence !== null && cj.confidence !== undefined ? `The AI's stated confidence: ${pct(cj.confidence)}` : "The AI didn't state its confidence.", 'text-sm text-tertiary'));
    }
    const step = (v.nextSteps || []).find((x) => x.criterionId === c.id);
    if (step) block.append(h('p', { class: 'next-step', text: `To reach ${step.nextLevelLabel}: ${step.nextLevelDescriptor}${step.basis === 'provisional' ? ' (based on the provisional levels)' : ''}` }));
    if (v.standingReview) {
      const fl = v.standingReview.finalLevels.find((x) => x.criterionId === c.id);
      if (fl) {
        block.append(h('p', { class: 'final-level' }, 'Final level: ', h('strong', { text: levelLabel(v.rubric, c.id, fl.levelId) }),
          fl.from === 'judge' ? " (the AI's level, confirmed by the reviewer)" : ' (set by the reviewer)'));
        if (fl.why) block.append(para(`Reviewer's reason: ${fl.why}`));
      }
    }
    list.append(block);
  }
  body.append(list);
  if (v.judgments.length > 1) {
    body.append(h('h3', { text: 'How the AI assessments compare' }), h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'How the AI assessments compare', tabindex: '0' },
      h('table', { class: 'table table--compact agreement' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Criterion' }), v.judgments.map((j) => h('th', { scope: 'col', text: judgmentName(j) })), h('th', { scope: 'col', text: 'Difference' }))),
        h('tbody', {}, (v.agreement || []).map((a) => h('tr', {},
          h('td', { text: criterionTitle(v.rubric, a.criterionId) }), a.levels.map((l) => h('td', { text: levelLabel(v.rubric, a.criterionId, l) })),
          h('td', { text: a.agree ? 'Agree' : `${a.spread} ${a.spread === 1 ? 'level' : 'levels'} apart` })))))));
  }
  body.append(tech(v.judgments.map((j) => `Who assessed: ${judgmentName(j)}${j.repeatOf !== null && j.repeatOf !== undefined ? ` (repeat of ${j.repeatOf + 1})` : ''}: ${j.judge.id} (${j.judge.kind}); ${disclosureWords(j.disclosure)}; chosen by ${CHOSEN_BY_WORDS[j.chosenBy] || j.chosenBy}; prompt ${j.promptTemplateHash === 'own-prompt' ? 'the judge\'s own (declared)' : `${shortHash(j.promptTemplateHash)}…`}`)));
  return sec;
}

function assessmentPanel(v) {
  const final = v.finalAssessment;
  const a = final || v.provisional;
  if (!a) return null;
  const body = h('div', { class: 'card__body' },
    statusPill(final ? 'Final: a qualified reviewer signed off every level.' : 'Provisional: not yet reviewed', final ? 'success' : 'warning'));
  if (a.use === 'pass-gate') {
    body.append(h('p', { class: 'result-score' }, h('span', { class: 'nowrap', text: `${a.points} of ${a.maxPoints} points` }), ' · ', h('span', { class: 'nowrap', text: `${a.percent}%` })));
    const verdict = final
      ? (a.meetsPassRule ? 'Meets the pass mark' : 'Below the pass mark')
      : (a.meetsPassRule ? 'Would meet the pass mark (provisional)' : 'Would not meet the pass mark (provisional)');
    body.append(h('p', { class: 'verdict', text: `${verdict}: at least ${a.minPercent}% is needed.` }));
    if (a.unmetRequirements.length) {
      body.append(h('ul', {}, a.unmetRequirements.map((x) => {
        const m = /^(\S+) needs at least (\S+)$/.exec(x);
        return h('li', { text: m ? `${criterionTitle(v.rubric, m[1])} needs at least ${levelLabel(v.rubric, m[1], m[2])}.` : x });
      })), tech(a.unmetRequirements));
    }
    body.append(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Points by criterion', tabindex: '0' }, h('table', { class: 'table table--compact' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Criterion' }), h('th', { scope: 'col', text: 'Level' }), h('th', { scope: 'col', class: 'num', text: 'Points' }))),
      h('tbody', {}, a.perCriterion.map((p) => h('tr', {}, h('td', { text: criterionTitle(v.rubric, p.criterionId) }), h('td', { text: levelLabel(v.rubric, p.criterionId, p.levelId) }),
        h('td', { class: 'num', title: `${p.value} × ${p.weight}`, text: String(p.points) })))))));
  } else {
    body.append(h('p', { class: 'verdict', text: 'Feedback only: levels, no score.' }));
    body.append(h('ul', {}, a.levels.map((l) => h('li', { text: `${criterionTitle(v.rubric, l.criterionId)}: ${levelLabel(v.rubric, l.criterionId, l.levelId)}` }))));
  }
  body.append(para("The AI suggests levels only. Practice Evidence works out the result from the rubric. If a quote didn't match, that criterion counts at its lowest level until a reviewer sets it.", 'text-sm text-tertiary'));
  if (final && v.provisional && v.provisional.use === 'pass-gate') body.append(para(`Before review, the provisional result was ${v.provisional.percent}%.`, 'text-sm text-tertiary'));
  return h('section', { class: 'card assessment', id: 'assessment' },
    h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Result' }),
      badge('Calculated by Practice Evidence', 'accent', 'Practice Evidence works out the result from the rubric. The AI only suggests levels.')),
    body);
}

function reviewsPanel(v) {
  const body = h('div', { class: 'card__body' });
  if (!v.reviews.length) body.append(para("No one has reviewed this session yet. It won't count as evidence until a reviewer signs off."));
  const items = [];
  for (const r of v.reviews) {
    const reopening = r.withdrawn ? (v.reopenings || []).find((x) => x.index === r.withdrawn.reopeningIndex) : null;
    items.push(h('li', {}, h('div', { class: 'list__item' },
      h('span', { class: 'icon-tile icon-tile--success' }, icon('people')),
      h('div', { class: 'list__main' }, h('span', { class: 'list__title', text: r.outcome === 'countersigned' ? "Confirmed the AI's levels" : 'Set different levels' }),
        h('span', { class: 'list__meta', text: `By a reviewer · ${fmtDate(r.reviewedAt)} · ${r.sawJudgeLevelsFirst ? "saw the AI's levels first" : 'blind check: chose levels first'}` }),
        r.withdrawn ? h('p', { class: 'text-sm', text: `Reason: ${reopening && reopening.why ? reopening.why : '(reason deleted)'}` }) : null),
      h('div', { class: 'list__end' }, r.reviewer.serverHeldDemoKey ? badge('Demo key', 'demo') : null, r.withdrawn ? statusPill('Withdrawn', 'warning') : null))));
  }
  for (const r of v.reopenings || []) {
    if (r.kind !== 'contest') continue;
    items.push(h('li', {}, h('div', { class: 'list__item' }, h('span', { class: 'icon-tile' }, icon('user')),
      h('div', { class: 'list__main' }, h('span', { class: 'list__title', text: 'You asked for another review' }),
        h('span', { class: 'list__meta', text: `${fmtDate(r.at)} · ${r.why || '(reason deleted)'}` })))));
  }
  if (items.length) body.append(h('ul', { class: 'list' }, items));
  if (v.reviews.length) body.append(tech(v.reviews.map((r) => `Review ${r.index + 1}: reviewer ${r.reviewer.did}`)));
  return h('section', { class: 'card reviews' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Reviews' })), body);
}

function projectionsPanel(v) {
  const can = v.projectable && hasNext(v, 'projectAttempt');
  const body = h('div', { class: 'card__body' });
  if (v.projectable) body.append(para('A reviewer signed off on an approved rubric, so this can be shared as practice evidence.'));
  else {
    body.append(callout({ tone: 'neutral', title: `Not ready to share yet: ${EVIDENCE_PLAIN[v.projectableWhy] || 'see the details'}.`, techLines: [v.projectableWhy] }));
  }
  const out = h('div', { class: 'outcome', id: 'projection' });
  const button = (format, label, cls) => {
    const b = h('button', { type: 'button', class: `btn ${cls}`, text: label, disabled: !can, title: v.projectableWhy, dataset: { action: ACT.projectAttempt, format }, onclick: () => busy(b, out, async () => {
      const r = await act(ACT.projectAttempt, { attemptIri: v.attemptIri, format });
      const text = JSON.stringify(r.statement, null, 2);
      return h('div', { class: 'stack' },
        callout({ tone: 'success', title: 'Statement created', body: "It was checked against Practice Evidence's rules and logged. Nothing was sent anywhere.",
          actions: [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => download(`statement-${r.statementId}.json`, text, 'application/json') }, icon('download', 'sm'), 'Download statement')] }),
        h('h3', { text: 'What this record includes' }),
        para('It includes your final levels and result, and a link to your full record. It leaves out your quotes, the conversation text and the reviewer\'s reasons. Download your record for those.'),
        format === 'cmi5' ? para("No learning platform launched this session, so a platform won't match it to a course enrolment.") : null,
        h('details', { class: 'disclosure' }, h('summary', { text: 'Show the statement (JSON)' }), h('pre', { class: 'json statement', text })),
        h('details', { class: 'disclosure' }, h('summary', { text: 'How to send it to your learning record store' }),
          h('div', { class: 'disclosure__body' }, h('p', { text: 'Nothing was sent anywhere. To record it in your learning record store, send it with your own credentials:' }), jsonBlock(r.lrsRequest))),
        tech([`Statement ${r.statementId}`, 'What the statement leaves out, in full:', ...(Array.isArray(r.lossy) ? r.lossy : []).map((x) => `· ${x}`)]));
    }, { progress: 'Creating…' }) });
    return b;
  };
  body.append(h('div', { class: 'btn-group' }, button('xapi', 'Create xAPI statement', 'btn--primary'), button('cmi5', 'xAPI statement (cmi5 style)', 'btn--secondary'),
    h('button', { type: 'button', class: 'btn btn--secondary', disabled: true, text: 'SCORM: not supported', title: 'A SCORM result is written by content in the browser, so it would carry a score without its record.' })), out);
  return h('section', { class: 'card projections' },
    h('div', { class: 'card__header' }, h('div', {}, h('h2', { class: 'card__title', text: 'Share as a learning record' }),
      h('p', { class: 'card__subtitle', text: 'xAPI is the standard format learning record stores accept. We create it; you send it.' }))),
    body);
}

function reasonField(label, hint) {
  const t = h('textarea', { class: 'textarea textarea--short', rows: 2, maxlength: 1000 });
  return [t, formField({ label, control: t, hint })];
}

/** What can be done next, from the attempt's own nextActions; `inConversation` draws it only when there is something. */
function actionsPanel(v, o, inConversation) {
  const handled = new Set([ACT.say, ACT.counterpartPacket, ACT.recordTurns, ACT.endConversation, ACT.projectAttempt]);
  const items = (v.nextActions || []).filter((n) => !handled.has(n.action));
  const again = !inConversation && v.state !== 'in-conversation' && !o.review && hasNext(v, 'exportRecord');
  if (inConversation && !items.length) return null;
  const list = h('ul', { class: 'list' });
  let reviewLinked = false;
  for (const n of items) {
    const key = actKey(n.action);
    const words = NEXT_WORDS[key] || [n.label, n.why];
    const out = h('div', { class: 'outcome' });
    const end = h('div', { class: 'list__end' });
    const after = [];
    const btn = (label, fn, cls, progress, ic) => {
      const b = h('button', { type: 'button', class: `btn ${cls || 'btn--secondary'}`, dataset: { action: n.action }, onclick: () => busy(b, out, fn, { progress }) }, ic ? icon(ic, 'sm') : null, label);
      return b;
    };
    let title = words[0];
    if (n.action === ACT.judgeAttempt) {
      title = v.judgments.length > 0 ? 'Get a second opinion' : 'Get AI assessment';
      end.append(btn(title, async () => { await act(ACT.judgeAttempt, { attemptIri: v.attemptIri }, { byok: true }); route(); return null; }, 'btn--primary', 'Assessing…', 'sparkle'));
    } else if (n.action === ACT.judgePacket) {
      end.append(btn('Get the hand-off', async () => {
        const p = await act(ACT.judgePacket, { attemptIri: v.attemptIri }, { read: true });
        return callout({ tone: 'info', title: 'Hand-off ready',
          body: "Send this to your appointed judge with the session's link. They assess the session in Claude or ChatGPT with the Interego connector and save the result. A reviewer still signs off.",
          actions: [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Copy hand-off', onclick: () => copyText(JSON.stringify(p, null, 2), 'Hand-off') }),
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Copy session link', onclick: () => copyText(location.href, 'Session link') })],
          kids: [h('details', { class: 'disclosure' }, h('summary', { text: 'Show the request (JSON)' }), jsonBlock(p))],
          techLines: [p.instructions] });
      }, 'btn--secondary', 'One moment…'));
    } else if (n.action === ACT.exportRecord) {
      end.append(btn('Download', async () => {
        const r = await act(ACT.exportRecord, { attemptIri: v.attemptIri }, { read: true });
        const text = JSON.stringify(r, null, 2);
        const saved = download(`pev-record-${v.attemptIri.split(':').pop()}.json`, text, 'application/json');
        const n2 = r.versions.length;
        return callout({ tone: 'success', title: saved ? `Downloaded ${n2} saved versions.` : `Your record has ${n2} saved versions, but this browser couldn't save the file.`, techLines: r.verify });
      }, 'btn--secondary', 'Preparing…', 'download'));
    } else if (n.action === ACT.holderCopy) {
      const target = h('input', { type: 'url', class: 'input', placeholder: 'https://your-storage.example/', 'aria-label': 'Your storage address' });
      end.append(formField({ label: 'Your storage address', control: target, hideLabel: true }), btn('Copy', async () => {
        const r = await act(ACT.holderCopy, { attemptIri: v.attemptIri, targetPodUrl: target.value.trim() });
        return callout({ tone: 'success', title: `Copied ${r.copies.length} saved versions to your storage.`,
          body: `${r.copiesVerified} checked after copying${r.skippedContentDeleted ? `; ${r.skippedContentDeleted} skipped because their text was deleted` : ''}.`, techLines: [`Copied to ${r.targetPodUrl}`] });
      }, 'btn--secondary', 'Copying…'));
    } else if (n.action === ACT.contestReview) {
      const [why, f] = reasonField('Why should another reviewer look again?', '10 to 1000 characters');
      end.append(f, btn('Request another review', async () => {
        await act(ACT.contestReview, { attemptIri: v.attemptIri, target: v.currentTarget, why: why.value });
        route();
        return null;
      }, 'btn--secondary', 'Saving…'));
    } else if (n.action === ACT.retractReview) {
      const [why, f] = reasonField('Reason (shown to the learner)', '10 to 1000 characters');
      end.append(f, btn('Withdraw review', async () => {
        await act(ACT.retractReview, { attemptIri: v.attemptIri, target: v.currentTarget, why: why.value });
        route();
        return null;
      }, 'btn--danger-quiet', 'Saving…'));
    } else if (n.action === ACT.redactAttempt) {
      const [why, f] = reasonField('Reason (required for admins, optional for you)', '');
      const ask = h('button', { type: 'button', class: 'btn btn--danger-quiet', text: 'Delete conversation text' });
      const confirm = h('div', { class: 'redact-confirm', hidden: true });
      confirm.append(callout({ tone: 'warning', title: 'Download your record first.', body: 'After this, the full text exists only in copies you hold.',
        kids: [f], actions: [
          btn('Delete it', async () => {
            const r = await act(ACT.redactAttempt, { attemptIri: v.attemptIri, target: v.currentTarget, ...(why.value.trim() ? { why: why.value } : {}) });
            setTimeout(route, 0);
            return callout({ tone: 'success', title: 'The conversation text was deleted.',
              techLines: [r.note, `${r.graphsDeleted} earlier versions deleted`, r.graphsStillPresent.length ? `still present: ${r.graphsStillPresent.join(', ')}` : null] });
          }, 'btn--danger btn--sm', 'Deleting…'),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Cancel', onclick: () => { confirm.hidden = true; ask.disabled = false; } })] }));
      ask.addEventListener('click', () => { confirm.hidden = false; ask.disabled = true; });
      end.append(ask);
      after.push(confirm);
    } else if (n.action === ACT.countersignAttempt || n.action === ACT.overrideAttempt) {
      if (reviewLinked || o.review) continue;
      reviewLinked = true;
      end.append(linkButton(`#/review/${encodeURIComponent(v.attemptIri)}`, 'Review this session', 'btn--primary'));
    }
    list.append(h('li', {}, h('div', { class: 'list__item next', dataset: { action: n.action } },
      h('div', { class: 'list__main' }, h('span', { class: 'list__title', text: title }), h('span', { class: 'list__meta', text: words[1] })),
      end, after, out)));
  }
  if (again) {
    list.append(h('li', {}, h('div', { class: 'list__item next practice-again' },
      h('div', { class: 'list__main' }, h('span', { class: 'list__title', text: 'Practice again' }), h('span', { class: 'list__meta', text: 'Start a new session on the latest published version of this scenario.' })),
      h('div', { class: 'start-row' }, startForm(v.scenario.scenarioIri, async () => (await invoke(ACT.listScenarios, podArgs({ scenario_iri: v.scenario.scenarioIri }))).scenario.version, 'Start again')))));
  }
  const body = h('div', { class: 'card__body' });
  if (list.children.length) body.append(list);
  else body.append(para(v.nextActions && v.nextActions.length ? 'Use the controls above.' : 'Nothing more to do here for now.'));
  if (items.length) body.append(tech(items.map((n) => `${n.label}: ${n.why}`)));
  return h('section', { class: 'card actions' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'What you can do next' })), body);
}

/** One saved version, in plain words: its state, and whether it was final or provisional when saved. */
function versionWords(x) {
  if (x.contentDeleted) return 'Earlier version: text deleted';
  if (x.trusted === false) return "Earlier version: couldn't be verified";
  const state = STATE_WORDS[x.state] || 'Saved version';
  // A withdrawn review or deleted text is said by the state itself; only these two add a word.
  if (x.modalStatus === 'Asserted') return `${state} · Final`;
  if (x.modalStatus === 'Hypothetical') return `${state} · Provisional`;
  return state;
}

function versionsPanel(v) {
  const a = v.authorship || {};
  const bound = a.valid && a.contentBinding === 'bound' && a.platformKnown;
  return h('section', { class: 'card versions' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Signed record' })), h('div', { class: 'card__body' },
    h('div', { class: 'cluster' }, bound ? statusPill('Signature verified: unchanged since it was signed', 'success') : statusPill("Signature couldn't be verified", 'danger')),
    bound ? null : para("This record doesn't match its signature. Don't rely on it; contact your admin.", 'text-sm'),
    h('details', { class: 'disclosure' }, h('summary', { text: `History (${v.versions.length} saved versions)` }),
      h('div', { class: 'disclosure__body' }, h('ol', { class: 'list' }, v.versions.map((x) => h('li', {}, h('div', { class: 'list__item' },
        h('div', { class: 'list__main' }, h('span', { class: 'list__title', text: versionWords(x) }),
          h('code', { class: 'mono list__meta', text: x.descriptorUrl })))))))),
    tech([`Session ${v.attemptIri}`, `Learner ${v.learner.did} (${v.learner.kind})`, `Modal status ${v.modalStatus}`, `Service signing key ${v.keyKind}`, `Content binding ${a.contentBinding}`])));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  To review and the review form
// ════════════════════════════════════════════════════════════════════════════════════════════

async function viewQueue(root) {
  root.append(pageHeader({ title: 'To review', lede: 'Sessions waiting for a person to sign off, with the ones that most need a person first.' }));
  let q;
  try { q = await act(ACT.reviewQueue, { limit: 50 }, { read: true }); } catch (e) { S.queueCount = null; renderTabs(); throw e; }
  for (const e of q.entries) S.queueEntries.set(e.attemptIri, e);
  S.queueCount = q.awaitingReview;
  renderTabs();
  root.append(...coverageNotes(q));
  const n = q.awaitingReview;
  const excluded = q.excludedAsConflicted;
  root.append(para(`${whole(q) ? '' : 'At least '}${n} ${n === 1 ? 'session' : 'sessions'} waiting for review.${excluded > 0
    ? ` ${excluded} ${excluded === 1 ? 'is' : 'are'} hidden because you can't review them (your own, or ones you assessed or reviewed before).` : ''}`));
  root.append(h('details', { class: 'disclosure' }, h('summary', { text: 'How the order is worked out' }),
    h('div', { class: 'disclosure__body disclosure__body--tech' },
      h('div', { text: `Priority = ${Object.entries(q.weights).map(([k, w]) => `${w} × ${FACTOR_WORDS[k] || k}`).join(' + ')}.` }),
      h('div', { text: 'Reopened sessions come first.' }))));
  if (!q.entries.length && whole(q)) {
    root.append(emptyState({ icon: 'clipboard', title: "You're all caught up", text: 'No sessions are waiting for your review.',
      actions: [linkButton('#/calibration', 'See AI judge quality')] }));
  }
  const cards = [];
  for (const e of q.entries) {
    const first = e.judges && e.judges[0];
    const factors = Object.entries(q.weights).filter(([k]) => typeof e.why[k] === 'number' && e.why[k] > 0)
      .sort(([a, wa], [b, wb]) => wb * e.why[b] - wa * e.why[a]);
    const body = h('div', { class: 'card__body' });
    if (e.reopened) body.append(h('div', {}, badge('Back for another look', 'warning')));
    if (e.blindFirst) body.append(callout({ tone: 'accent', title: "Blind check: choose your levels before you see the AI's." }));
    body.append(h('div', {}, h('p', { class: 'label', text: 'Why this is near the top' }),
      h('div', { class: 'cluster' }, factors.length ? factors.map(([k]) => badge(FACTOR_WORDS[k] || k, k === 'unverified' ? 'danger' : '')) : badge('In the queue'))));
    if (!e.blindFirst && e.unverifiedCriteria.length) {
      body.append(errorText(`A quote didn't match for ${e.unverifiedCriteria.length} ${e.unverifiedCriteria.length === 1 ? 'criterion' : 'criteria'}.`));
    }
    if (e.counterpartControlledBy === 'learner') body.append(callout({ tone: 'warning', title: "The learner's own AI wrote the other person's lines." }));
    body.append(tech([`priority score ${e.priority}`,
      ...Object.entries(q.weights).map(([k, w]) => `${FACTOR_WORDS[k] || k}: ${num(e.why[k])} × ${w}${k === 'uncertainty' && !e.why.uncertaintyDeclared ? ' (not declared: counted as 0.2)' : ''}`),
      ...(e.judges || []).map((j) => `judge ${j.judgeId} (${j.kind}, chosen by ${CHOSEN_BY_WORDS[j.chosenBy] || j.chosenBy})`),
      e.unverifiedCriteria.length ? `Unverified: ${e.unverifiedCriteria.join(', ')}` : null, `Session ${e.attemptIri}`]));
    cards.push(h('article', { class: 'card queue-entry', dataset: { attempt: e.attemptIri } },
      h('div', { class: 'card__header' },
        h('div', {}, h('h2', { class: 'card__title', text: e.scenarioTitle }),
          h('p', { class: 'card__subtitle', text: e.blindFirst ? 'Blind check' : `Assessed by ${first ? judgeWords(first.judgeId, first.kind) : 'an AI judge'}` })),
        statusPill(STATE_WORDS[e.state] || e.state, STATE_TONE[e.state] || 'pending')),
      body,
      h('div', { class: 'card__footer' }, linkButton(`#/review/${encodeURIComponent(e.attemptIri)}`, 'Open and review', 'btn--primary', 'arrow-right'))));
  }
  if (cards.length) root.append(h('div', { class: 'scenario-list' }, cards));
}

async function viewReview(root, iri, seq) {
  let entry = S.queueEntries.get(iri);
  if (!entry) {
    try {
      const q = await act(ACT.reviewQueue, { limit: 100 }, { read: true });
      for (const e of q.entries) S.queueEntries.set(e.attemptIri, e);
      entry = S.queueEntries.get(iri);
    } catch (e) {
      // Not a reviewer, or not signed in: the attempt read below says what this caller can do.
      if (e instanceof NeedsSignIn) throw e;
    }
  }
  const v = await act(ACT.getAttempt, { attemptIri: iri }, { read: true });
  if (seq !== S.seq) return;
  const blind = Boolean(entry && entry.blindFirst);
  let st = S.reviewDrafts.get(iri);
  if (!st || st.target !== v.currentTarget.descriptorUrl) {
    st = { picks: {}, whys: {}, revealed: !blind, target: v.currentTarget.descriptorUrl };
    S.reviewDrafts.set(iri, st);
  }
  const canReview = hasNext(v, 'overrideAttempt');
  root.append(pageHeader({
    crumbs: [['#/review', 'To review'], [null, v.scenario.title]], title: `Review: ${v.scenario.title}`,
    lede: blind ? "Blind check: choose a level for every criterion first. Then you'll see the AI's levels."
      : "Choose a level for every criterion. Where yours differs from the AI's, or a quote didn't match, say why.",
    meta: attemptMeta(v),
    actions: canReview ? [h('button', { type: 'button', class: 'btn btn--primary', text: 'Go to your review', onclick: () => scrollToEl('#review-form') })] : [],
  }));
  if (!canReview) {
    root.append(callout({ tone: 'neutral', title: 'Someone else needs to review this session',
      body: "Reviewers can't review their own practice, a session they assessed or asked to have assessed, or one they've already reviewed.",
      actions: [linkButton('#/review', 'Back to To review', 'btn--secondary btn--sm')] }));
    root.append(renderAttempt(v, { hideJudge: !st.revealed, review: true }));
    return;
  }
  root.append(renderAttempt(v, { hideJudge: !st.revealed, review: true }));
  const form = h('section', { class: 'card review-form', id: 'review-form' });
  root.append(form);
  paintReviewForm(form, v, st, blind);
}

function paintReviewForm(form, v, st, blind) {
  clear(form);
  const primary = v.judgments[0];
  const criteria = v.rubric.criteria;
  form.append(h('div', { class: 'card__header' }, h('div', {}, h('h2', { class: 'card__title', text: 'Your review' }),
    h('p', { class: 'card__subtitle', text: blind && !st.revealed ? "Choose your levels first. The AI's levels appear after." : 'Choose a level for every criterion.' }))));
  const body = h('div', { class: 'card__body' });
  form.append(body);
  const allPicked = criteria.every((c) => st.picks[c.id]);
  for (const c of criteria) {
    const cj = primary && primary.criteria.find((x) => x.criterionId === c.id);
    const sel = h('select', { class: 'select', 'aria-label': `Level for ${c.title}`, dataset: { criterion: c.id }, onchange: (e) => { st.picks[c.id] = e.target.value; paintReviewForm(form, v, st, blind); } },
      h('option', { value: '', text: 'Choose a level' }), c.levels.map((l) => h('option', { value: l.id, text: `${l.label}: ${l.descriptor}` })));
    sel.value = st.picks[c.id] || '';
    const row = h('div', { class: 'review-criterion criterion' }, h('h3', { text: c.title }), c.description ? para(c.description) : null, formField({ label: 'Your level', control: sel }));
    if (st.revealed && cj) {
      const [tone, words] = QUOTE_STATUS[cj.status] || ['pending', cj.status];
      row.append(h('p', { class: 'cluster' }, h('span', {}, "The AI chose ", h('strong', { text: levelLabel(v.rubric, c.id, cj.levelId) })), statusPill(words, tone)));
      const needsWhy = Boolean(st.picks[c.id]) && (st.picks[c.id] !== cj.levelId || cj.status === 'unverified');
      const why = h('textarea', { class: 'textarea textarea--short', rows: 2, maxlength: 1000, dataset: { why: c.id },
        placeholder: needsWhy ? 'Why your level stands (10 to 1000 characters)' : 'Anything the learner should know', oninput: (e) => { st.whys[c.id] = e.target.value; } });
      why.value = st.whys[c.id] || '';
      row.append(formField({ label: needsWhy ? 'Reason (required)' : 'Note (optional)', control: why }));
      if (needsWhy) row.append(h('p', { class: 'hint', text: cj.status === 'unverified' ? "The AI's quote didn't match here: say why your level stands." : "Your level differs from the AI's: say why." }));
      if (cj.status === 'no-quote-needed') row.append(h('p', { class: 'hint', text: "The AI put this at the lowest level and quoted nothing, so nothing was checked. Read the learner's lines for anything that reaches higher." }));
    }
    body.append(row);
  }
  const out = h('div', { class: 'outcome' });
  const footer = h('div', { class: 'card__footer review-form__footer' });
  if (!st.revealed) {
    const reveal = h('button', { type: 'button', id: 'reveal', class: 'btn btn--primary', text: "Show the AI's levels", disabled: !allPicked, onclick: () => { st.revealed = true; route(); } });
    footer.append(...(allPicked ? [] : [h('p', { class: 'hint', text: 'Choose a level for every criterion first.' })]), reveal);
    form.append(footer);
    return;
  }
  const asJudged = primary && primary.unverifiedCriteria.length === 0 && criteria.every((c) => {
    const cj = primary.criteria.find((x) => x.criterionId === c.id);
    return cj && st.picks[c.id] === cj.levelId;
  });
  const action = asJudged ? ACT.countersignAttempt : ACT.overrideAttempt;
  const submit = h('button', { type: 'button', class: 'btn btn--primary', id: 'submit-review', disabled: !allPicked, dataset: { action },
    text: asJudged ? 'Confirm all levels' : 'Sign off my levels',
    onclick: () => busy(submit, out, async () => {
      const r = await act(action, {
        attemptIri: v.attemptIri, target: v.currentTarget, sawJudgeLevelsFirst: !blind,
        levels: criteria.map((c) => ({ criterionId: c.id, levelId: st.picks[c.id], ...((st.whys[c.id] || '').trim() ? { why: st.whys[c.id] } : {}) })),
      });
      S.reviewDrafts.delete(v.attemptIri);
      S.queueEntries.delete(v.attemptIri);
      const x = r.assessment;
      toast({ tone: 'success', title: 'Review saved' });
      return callout({ tone: 'success', titleClass: 'recorded',
        title: x.use === 'pass-gate' ? `Review saved. Final result: ${x.percent}%, ${x.meetsPassRule ? 'meets' : 'is below'} the pass mark.` : 'Review saved. Levels recorded (feedback only).',
        body: r.projectable ? 'It can now be shared as a learning record.' : `It can't be shared as evidence yet: ${EVIDENCE_PLAIN[r.projectableWhy] || r.projectableWhy}.`,
        actions: [linkButton(attemptHash(v.attemptIri), 'Open the session', 'btn--secondary btn--sm'), linkButton('#/review', 'Back to To review', 'btn--ghost btn--sm')] });
    }, { progress: 'Saving…' }) });
  footer.append(h('p', { class: 'hint', text: asJudged ? "Every level matches the AI's and every quote checked out, so this confirms its levels."
    : "Some levels differ from the AI's, or a quote didn't match, so you're signing off your own levels with reasons." }), submit, out);
  form.append(footer);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Results and AI judge quality
// ════════════════════════════════════════════════════════════════════════════════════════════

function distributionTable(rows, k, label) {
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': label, tabindex: '0' }, h('table', { class: 'table distribution' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Criterion' }), h('th', { scope: 'col', text: 'Levels' }))),
    h('tbody', {}, rows.map((d) => h('tr', {},
      h('td', {}, h('span', { class: 'table__primary', text: d.title }), h('span', { class: 'table__secondary', text: `${d.n} ${d.n === 1 ? 'session' : 'sessions'}` })),
      h('td', {}, d.withheld
        ? h('span', { class: 'text-tertiary', text: 'Split hidden to protect privacy' })
        : d.levels.some((l) => l.suppressed)
          ? h('span', { class: 'text-tertiary', text: `Hidden to protect privacy (a group has fewer than ${k})` })
          : h('div', { class: 'cluster' }, d.levels.map((l) => badge(`${l.label} ${l.count}`)))))))));
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

function resultCard(title, kids) {
  return h('section', { class: 'card' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: title })), h('div', { class: 'card__body' }, kids));
}

async function viewResults(root, scenarioIri) {
  const titleP = invoke(ACT.listScenarios, podArgs({ scenario_iri: scenarioIri })).then((x) => x.scenario && x.scenario.title, () => null);
  let r = null;
  let failed = null;
  try { r = await act(ACT.scenarioResults, { scenarioIri }, { read: true }); } catch (e) { failed = e; }
  const title = await titleP;
  root.append(pageHeader({
    crumbs: [['#/practice', 'Practice scenarios'], [null, 'Results']], title: title ? `Results: ${title}` : 'Results',
    lede: r ? r.label : 'What happened in practice on this scenario.',
    actions: r ? [
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => download('results.csv', resultsCsv(r), 'text/csv') }, icon('download', 'sm'), 'Download CSV'),
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => download('results.json', JSON.stringify(r, null, 2), 'application/json') }, icon('download', 'sm'), 'Download JSON'),
    ] : [],
  }));
  if (failed) throw failed;
  root.append(...coverageNotes(r));
  const c = r.counts;
  const stat = (label, value, meta) => h('div', { class: 'stat' }, h('p', { class: 'stat__label', text: label }), h('p', { class: 'stat__value', text: String(value) }), meta ? h('p', { class: 'stat__meta', text: meta }) : null);
  const mp = r.final.meetsPassRule;
  root.append(h('div', { class: 'stat-grid' },
    stat('Practice sessions', c.attempts, `${c.authorTestExcluded} test ${c.authorTestExcluded === 1 ? 'run' : 'runs'} not counted · ${c.redacted} with text deleted`),
    stat('Reviewed', r.final.reviewedAttempts),
    stat('Assessed by AI', r.provisional.judgedAttempts),
    mp ? stat('Met the pass mark', mp.suppressed ? 'Hidden' : `${mp.count} of ${mp.of}`, mp.suppressed ? `Hidden to protect privacy (a group has fewer than ${r.k})` : null) : null));
  const states = Object.entries(c.byState).filter(([, n]) => n > 0);
  if (states.length) root.append(h('div', { class: 'cluster' }, states.map(([s, n]) => badge(`${STATE_WORDS[s] || s}: ${n}`))));
  if (c.attempts === 0 && whole(r)) {
    root.append(emptyState({ icon: 'chart', title: 'No practice sessions on this scenario yet', text: 'Results appear here once people practice and reviewers sign off.' }));
    return;
  }
  const titles = Object.fromEntries(r.final.perCriterion.map((d) => [d.criterionId, d.title]));
  const t = (id) => titles[id] || id;
  const labels = new Map();
  for (const d of [...r.final.perCriterion, ...r.provisional.perCriterion]) for (const l of d.levels || []) labels.set(`${d.criterionId}|${l.levelId}`, l.label);
  const lvl = (c, l) => labels.get(`${c}|${l}`) || String(l);
  root.append(resultCard('Final levels (reviewed sessions)', [distributionTable(r.final.perCriterion, r.k, 'Final levels')]));
  root.append(h('div', { class: 'grid-2' },
    resultCard('With help preparing', [distributionTable(r.final.byCoached.coached, r.k, 'With help preparing')]),
    resultCard('Without help', [distributionTable(r.final.byCoached.notCoached, r.k, 'Without help')])));
  root.append(h('div', { class: 'grid-2' },
    resultCard('First session', [distributionTable(r.final.byAttemptNumber.first, r.k, 'First session')]),
    resultCard('Later sessions', [distributionTable(r.final.byAttemptNumber.later, r.k, 'Later sessions')])));
  root.append(resultCard(`Provisional levels (AI-assessed: ${r.provisional.judgedAttempts})`, [
    para(r.provisional.label === 'provisional, not reviewed' ? 'Not yet reviewed by a person.' : r.provisional.label, 'text-sm text-secondary'),
    distributionTable(r.provisional.perCriterion, r.k, 'Provisional levels')]));
  const changes = [];
  if (r.reviewerChangesShown === 'each') {
    if (!r.reviewerChanges.length) changes.push(para("Reviewers haven't changed any AI levels on this scenario."));
    else {
      // Every level a reviewer set by hand: a different one is a change; the AI's own level kept is said as kept.
      changes.push(h('ul', {}, r.reviewerChanges.map((x) => h('li', { text: [
        `${t(x.criterionId)}: ${x.judgeLevelId === x.finalLevelId ? `kept the AI's level, ${lvl(x.criterionId, x.finalLevelId)}`
          : `changed ${lvl(x.criterionId, x.judgeLevelId)} to ${lvl(x.criterionId, x.finalLevelId)}`}`,
        fmtDate(x.reviewedAt),
        x.why === null ? 'no reason available' : `reason: ${x.why}`].join(' · ') }))));
    }
  } else {
    changes.push(para('Each change and its reason are shown to reviewers and admins only.'));
    changes.push(h('ul', {}, r.reviewerChangeCounts.map((x) => h('li', { text: x.suppressed
      ? `${t(x.criterionId)}: hidden to protect privacy` : `${t(x.criterionId)}: raised in ${x.raised}, lowered in ${x.lowered}` }))));
  }
  changes.push(h('ul', {}, r.changedByReviewer.map((x) => h('li', { text: x.suppressed
    ? `${t(x.criterionId)}: changed in a hidden number of ${x.reviewedAttempts} reviewed sessions`
    : `${t(x.criterionId)}: changed in ${x.changed} of ${x.reviewedAttempts} reviewed sessions` }))));
  root.append(resultCard('What reviewers changed', changes));
  root.append(h('details', { class: 'disclosure' }, h('summary', { text: 'How small numbers are protected' }), h('div', { class: 'disclosure__body', text: r.suppressionRule })));
  if (r.personJudgeCells && r.personJudgeCells.length) {
    root.append(resultCard('People who assessed sessions', [calibrationSimple(r.personJudgeCells),
      h('details', { class: 'disclosure' }, h('summary', { text: 'All measures' }), calibrationTable(r.personJudgeCells))]));
  }
}

function calibrationSimple(cells) {
  const td = (label, kids, cls) => h('td', { 'data-label': label, class: cls }, kids);
  const rate = (x) => (typeof x === 'number' ? pct(x) : '—');
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'AI judge agreement with reviewers', tabindex: '0' }, h('table', { class: 'table table--stack calibration' },
    h('thead', {}, h('tr', {}, ['AI judge', 'Criterion', 'Reviewed sessions', 'Agreement with reviewers', 'Average gap (levels)', "Quote didn't match", 'Status']
      .map((x, i) => h('th', { scope: 'col', class: i >= 2 && i <= 5 ? 'num' : null, text: x })))),
    h('tbody', {}, cells.map((c) => h('tr', {},
      td('AI judge', h('span', { class: 'table__primary', text: judgeWords(c.judgeId, c.judgeKind) })),
      td('Criterion', c.criterionTitle),
      td('Reviewed sessions', [h('span', { text: String(c.samples) }), h('span', { class: 'table__secondary', text: `from ${c.distinctHumanConfirmers} ${c.distinctHumanConfirmers === 1 ? 'reviewer' : 'reviewers'}` })], 'num'),
      td('Agreement with reviewers', rate(c.agreementRate), 'num'),
      td('Average gap (levels)', typeof c.meanLevelDistance === 'number' ? num(c.meanLevelDistance) : '—', 'num'),
      td("Quote didn't match", rate(c.unverifiedRate), 'num'),
      td('Status', [c.status === 'Asserted' ? statusPill('Established', 'success') : h('span', { title: 'Early: fewer than 20 reviewed sessions' }, statusPill('Early', 'pending')),
        h('span', { class: 'table__secondary', text: `${c.status === 'Asserted' ? '' : 'Fewer than 20 reviewed sessions. '}Track record: ${c.standing && c.standing.evaluated ? (c.standing.clears ? 'meets the bar (for information only)' : 'not yet') : 'not evaluated'}` })]))))));
}

function calibrationTable(cells) {
  const head = ['judge', 'prompt', 'rubric', 'criterion', 'samples', 'distinct reviewers', 'agreement with the reviewer', 'mean Brier', 'mean level distance', 'unverified', 'blind agreement', 'test-retest', 'audit sample', 'status', 'standing'];
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'All measures', tabindex: '0' }, h('table', { class: 'table table--compact calibration-all' },
    h('thead', {}, h('tr', {}, head.map((x) => h('th', { scope: 'col', text: x })))),
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
  const pooled = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: S.pooled, onchange: (e) => { S.pooled = e.target.checked; route(); } });
  root.append(pageHeader({ title: 'AI judge quality',
    lede: "How often each AI judge's levels match what reviewers decided, by criterion. This measures agreement, not accuracy: reviewers usually see the AI's levels first.",
    actions: [h('label', { class: 'choice' }, pooled, h('span', { class: 'choice__text', text: 'Combine rubric versions with the same wording' }))] }));
  const r = await invoke(ACT.calibration, podArgs({ group_by: S.pooled ? 'criterion-content' : undefined }));
  root.append(...coverageNotes(r));
  if (r.cells.length) root.append(calibrationSimple(r.cells));
  else if (whole(r)) {
    root.append(emptyState({ icon: 'chart', title: 'No data yet', text: "Once reviewers sign off on sessions, you'll see how often each AI judge's levels matched theirs." }));
  }
  root.append(para(r.metricNote, 'text-sm text-secondary'));
  if (r.cells.length) root.append(h('details', { class: 'disclosure' }, h('summary', { text: 'All measures (technical)' }), calibrationTable(r.cells)));
  root.append(h('details', { class: 'disclosure' }, h('summary', { text: 'How to read this' }), h('div', { class: 'disclosure__body' },
    h('p', { text: `Each row is one AI judge on one criterion. Agreement is how often the reviewer kept the AI's level. A row is Early until it rests on ${r.minSamplesForAsserted} reviewed sessions. The track record asks for agreement of at least ${pct(r.policy.floor)} over at least ${r.policy.minSamples} reviewed sessions, from at least ${r.policy.minDistinctHumanConfirmers} different reviewers. It is shown for information only and never lets an AI skip a human review.` }),
    h('p', { text: `Figures that rest on fewer than ${r.k} reviewed sessions are hidden, so no one review can be read back. ${r.attemptsRead} sessions were read for this page.` }),
    tech([`Policy for standing: agreement of at least ${r.policy.floor} over at least ${r.policy.minSamples} reviewed outcomes, from at least ${r.policy.minDistinctHumanConfirmers} different people. A cell stays Hypothetical below ${r.minSamplesForAsserted} samples.`,
      r.smallCountRule ? r.smallCountRule.replace(/k − 1/g, String(r.k - 1)) : null,
      `${r.attemptsRead} attempt(s) and ${r.outcomesRead} outcome row(s) read; ${r.personJudgeCellsWithheld} cell(s) of people who judged are left out here.`]))));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Write a scenario: drafting, the form, saving, publishing
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

/** A form field bound to one key of the model; `data-field` names the key. */
function modelField(model, key, label, o) {
  const opts = o || {};
  const id = nextId(`f-${key}`);
  const input = opts.long
    ? h('textarea', { id, class: opts.rows > 2 ? 'textarea' : 'textarea textarea--short', rows: opts.rows || 2, maxlength: opts.max, placeholder: opts.placeholder, oninput: (e) => { model[key] = e.target.value; } })
    : h('input', { id, class: 'input', type: opts.type || 'text', maxlength: opts.max, placeholder: opts.placeholder, disabled: opts.disabled, oninput: (e) => { model[key] = e.target.value; } });
  input.value = model[key] === undefined || model[key] === null ? '' : String(model[key]);
  const f = h('div', { class: 'field', dataset: { field: key } },
    h('label', { class: 'label', for: id }, label, opts.optional ? h('span', { class: 'label__optional', text: '(optional)' }) : null), input);
  if (opts.hint) f.append(h('p', { class: 'hint', text: opts.hint }));
  return f;
}

function radios(model, key, legend, options, onchange, hint) {
  const name = nextId(key);
  return h('fieldset', { class: 'fieldset', dataset: { field: key } }, h('legend', { class: 'legend', text: legend }), hint ? h('p', { class: 'hint', text: hint }) : null,
    h('div', { class: 'choice-group' }, options.map(([value, text, sub]) => h('label', { class: 'choice choice--card' },
      h('input', { type: 'radio', name, value, checked: model[key] === value, onchange: () => { model[key] = value; if (onchange) onchange(); } }),
      h('span', { class: 'choice__text' }, text, sub ? h('span', { class: 'choice__hint', text: sub }) : null)))));
}

function stepCard(n, title, kids, extraClass) {
  return h('section', { class: `card${extraClass ? ` ${extraClass}` : ''}` },
    h('div', { class: 'card__header' }, h('div', {}, h('span', { class: 'eyebrow', text: `Step ${n} of 5` }), h('h2', { class: 'card__title', text: title }))),
    h('div', { class: 'card__body form' }, kids));
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
  const v = A.basedOnVersion;
  out.push(pageHeader({
    title: v ? `Edit: ${m.title || 'scenario'}` : 'Write a scenario',
    lede: v ? `You're editing version ${v}. Saving creates version ${v + 1}; earlier results stay tied to the version they used. While your new draft is unpublished, learners can't start this scenario, so publish when you're ready.`
      : "Describe a conversation your people need to get right. You decide how it's used and how it's assessed. AI can help draft, but it never makes those decisions.",
    actions: [h('button', { type: 'button', class: 'btn btn--ghost', text: 'Start a new scenario', onclick: () => { S.author = null; go('#/author'); } })],
  }));
  if (S.mode === 'paste' && !S.manual) {
    const actions = [];
    if (interegoOffered()) actions.push(signInButton('interego', 'Sign in with Interego', 'sm'));
    if (S.hasWallet) actions.push(signInButton('wallet', 'Use a crypto wallet', 'sm', actions.length ? 'btn--secondary' : 'btn--primary'));
    actions.push(signInButton('manual', 'Sign manually (advanced)', 'sm', 'btn--ghost'));
    out.push(callout({ tone: 'info', title: "You'll need to sign in, and be an author, to save", body: 'You can fill in the form now.', actions }));
  }

  // Drafting help
  const brief = h('textarea', { id: 'draft-brief', class: 'textarea', rows: 3, maxlength: 4000, placeholder: 'For example: a project manager tells a client sponsor that two defects block the payment flow.' });
  const source = h('textarea', { id: 'draft-source', class: 'textarea', rows: 3, maxlength: 20000 });
  const pasted = h('textarea', { id: 'draft-json', class: 'textarea textarea--mono', rows: 3, 'aria-label': 'Draft JSON' });
  const draftOut = h('div', { class: 'outcome' });
  const draftBtn = h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: ACT.draftScenario }, onclick: () => busy(draftBtn, draftOut, async () => {
    const r = await act(ACT.draftScenario, { brief: brief.value, ...(source.value.trim() ? { sourceText: source.value } : {}) }, { byok: true });
    A.model = { ...modelFrom(r.draft), assessmentUse: '', workRegime: '', passGateWhy: '' };
    A.receipt = r.receipt;
    A.receiptDisclosure = r.disclosure;
    A.assistance.choice = 'receipt';
    paint();
    return null;
  }, { progress: 'Drafting…' }) }, icon('sparkle'), 'Draft with AI');
  const packetBtn = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Draft with my own AI', dataset: { action: ACT.draftScenarioPacket }, onclick: () => busy(packetBtn, draftOut, async () => {
    const p = await invoke(ACT.draftScenarioPacket, { brief: brief.value, ...(source.value.trim() ? { source_text: source.value } : {}) });
    return callout({ tone: 'info', title: 'Instructions ready',
      body: 'Copy these instructions into Claude or ChatGPT. Paste the draft it writes under Paste a draft (advanced), then read and edit it before you save.',
      techLines: [p.instructions, p.recordWith && p.recordWith.note],
      actions: [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Copy for my AI', onclick: () => copyText(JSON.stringify(p.request, null, 2), 'Instructions') })],
      kids: [h('details', { class: 'disclosure' }, h('summary', { text: 'Show the request (JSON)' }), jsonBlock(p.request))] });
  }) });
  const pasteBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Load the pasted draft', onclick: () => busy(pasteBtn, draftOut, async () => {
    let d;
    try { d = JSON.parse(pasted.value); } catch { return errorText("That isn't a draft in JSON."); }
    A.model = { ...modelFrom(d), assessmentUse: '', workRegime: '', passGateWhy: '' };
    A.receipt = null;
    A.assistance.choice = '';
    paint();
    return null;
  }) });
  out.push(h('details', { class: 'card disclosure draft-card', open: !A.model.title },
    h('summary', {}, icon('sparkle'), 'Start from an AI draft (optional)'),
    h('div', { class: 'card__body form' },
      para("AI can draft the conversation, the other person and the criteria. It never decides how the scenario is used, how clear-cut good performance is, or how it's scored. You do."),
      formField({ label: 'What should people practice?', control: brief }),
      formField({ label: 'Material to draw on', optional: true, control: source }),
      h('div', { class: 'btn-group' }, draftBtn, packetBtn),
      h('details', { class: 'disclosure' }, h('summary', { text: 'Paste a draft (advanced)' }), h('div', { class: 'disclosure__body form' }, pasted, h('div', {}, pasteBtn))),
      draftOut)));
  if (A.receiptDisclosure) {
    out.push(callout({ tone: 'accent', title: 'AI draft loaded',
      body: `Drafted by ${draftWords(A.receiptDisclosure)}. Read and edit it. The record will note which AI drafted it and whether you changed it.`,
      techLines: [disclosureWords(A.receiptDisclosure)] }));
  }

  out.push(stepCard(1, 'The scenario', [
    h('div', { class: 'form-row' },
      modelField(m, 'scenarioKey', 'Short name', { max: 64, disabled: Boolean(A.basedOnVersion), hint: "Lowercase letters, digits and hyphens. It can't change after the first save." }),
      modelField(m, 'title', 'Title', { max: 120 })),
    modelField(m, 'learnerGoal', "What you're practicing", { long: true, max: 600 }),
    modelField(m, 'learnerPart', 'Your part', { long: true, max: 300 }),
    modelField(m, 'situation', 'The situation', { long: true, rows: 3, max: 2000 }),
    h('div', { class: 'form-row' }, modelField(m, 'language', 'Language', { max: 20, hint: 'For example: en' })),
  ]));
  out.push(stepCard(2, 'The person you practice with', [
    h('div', { class: 'form-row' }, modelField(m.counterpart, 'name', 'Name', { max: 60 }), modelField(m, 'turnLimit', 'Line limit', { type: 'number', hint: 'Your lines, 1 to 40' })),
    modelField(m.counterpart, 'profile', 'Who they are', { long: true, max: 1500 }),
    modelField(m.counterpart, 'wants', 'What they want', { long: true, max: 800 }),
    modelField(m.counterpart, 'knows', 'What they know', { long: true, max: 1500 }),
    modelField(m.counterpart, 'reactions', 'How they react', { long: true, max: 1500 }),
    modelField(m, 'firstLine', 'How they open', { long: true, max: 600 }),
    modelField(m, 'endsWhen', 'The conversation ends when', { long: true, max: 600 }),
  ]));

  // Classify first
  const decide = [
    radios(m, 'assessmentUse', 'How will this be used?', [['feedback-only', 'Feedback only', 'Levels, no score.'], ['pass-gate', 'Scored, with a pass mark', 'A score and a pass mark.']], paint),
    radios(m, 'workRegime', 'Good performance is…', Object.entries(REGIME_WORDS).map(([k, [label, sub]]) => [k, label, sub]), paint),
  ];
  if (gate && m.workRegime && !['evident', 'knowable'].includes(m.workRegime)) {
    decide.push(callout({ tone: 'warning', title: 'A pass mark assumes a clear-cut good answer',
      body: "You've said this work is situational or unsettled. Give the reason a pass mark fits (it's recorded), or use feedback only." }),
    modelField(m, 'passGateWhy', 'Why a pass mark fits this work', { long: true, max: 600, hint: '10 to 600 characters' }));
  }
  out.push(stepCard(3, 'Two decisions before the rubric', decide));

  // The rubric
  const rub = [h('p', { class: 'hint', text: gate ? 'Levels go from lowest to highest. Give each criterion a weight (1 to 100) and each level points (0 to 100, rising).'
    : 'Levels go from lowest to highest. Feedback only: no weights, points or pass mark.' })];
  m.rubric.criteria.forEach((c, ci) => {
    const box = h('fieldset', { class: 'fieldset rubric-criterion' }, h('legend', { class: 'legend', text: `Criterion ${ci + 1}` }),
      h('div', { class: 'form-row' }, modelField(c, 'title', 'Title', { max: 120 }), modelField(c, 'id', 'ID', { max: 40, hint: 'Used in exports, for example names-the-constraint' })),
      gate ? h('div', { class: 'form-row' }, modelField(c, 'weight', 'Weight', { type: 'number' })) : null,
      modelField(c, 'description', 'What it looks at', { long: true, max: 600 }));
    c.levels.forEach((l, li) => {
      box.append(h('div', { class: 'rubric-level' },
        h('div', { class: gate ? 'form-row form-row--3' : 'form-row' },
          modelField(l, 'label', `Level ${li + 1} name`, { max: 60 }), modelField(l, 'id', 'ID', { max: 40 }), gate ? modelField(l, 'value', 'Points', { type: 'number' }) : null),
        modelField(l, 'descriptor', 'What this level looks like', { long: true, max: 600 }),
        c.levels.length > 2 ? h('div', {}, h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Remove level', onclick: () => { c.levels.splice(li, 1); paint(); } })) : null));
    });
    box.append(h('div', { class: 'btn-group' },
      c.levels.length < 6 ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', text: 'Add a level', onclick: () => { c.levels.push(blankLevel('', '', '')); paint(); } }) : null,
      m.rubric.criteria.length > 1 ? h('button', { type: 'button', class: 'btn btn--danger-quiet btn--sm', text: 'Remove criterion', onclick: () => { m.rubric.criteria.splice(ci, 1); paint(); } }) : null));
    rub.push(box);
  });
  if (m.rubric.criteria.length < 12) rub.push(h('div', {}, h('button', { type: 'button', class: 'btn btn--secondary', text: 'Add a criterion', onclick: () => { m.rubric.criteria.push(blankCriterion()); paint(); } })));
  if (gate) {
    const pr = m.rubric.passRule;
    rub.push(h('h3', { text: 'Pass mark' }), h('div', { class: 'form-row' }, modelField(pr, 'minPercent', 'Pass mark (%)', { type: 'number' })));
    for (const c of m.rubric.criteria) {
      const sel = h('select', { class: 'select', onchange: (e) => { pr.requiredLevels[c.id] = e.target.value; } },
        h('option', { value: '', text: 'No minimum' }), c.levels.map((l) => h('option', { value: l.id, text: l.label || l.id })));
      sel.value = pr.requiredLevels[c.id] || '';
      rub.push(formField({ label: `Minimum level for ${c.title || c.id || 'this criterion'}`, control: sel }));
    }
  }
  out.push(stepCard(4, 'The rubric', rub));

  // Draft assistance (required)
  const as = A.assistance;
  const choices = [['none', 'No one'], ['own-agent', 'My AI assistant'], ['model', 'Another AI'], ['person', 'Another person']];
  if (A.receipt) choices.unshift(['receipt', "Practice Evidence's AI drafted it (record attached)"]);
  const assist = [radios(as, 'choice', 'Who helped write this? (required)', choices, paint, "Saying nothing isn't the same as \"no one\".")];
  if (as.choice === 'own-agent' || as.choice === 'model') assist.push(h('div', { class: 'form-row' }, modelField(as, 'provider', 'AI provider', { max: 60 }), modelField(as, 'model', 'Model', { max: 120 })));
  if (as.choice && as.choice !== 'none' && as.choice !== 'receipt') assist.push(modelField(as, 'note', 'Note', { max: 300, optional: true }));
  out.push(stepCard(5, 'Who helped write this?', assist));

  // Save / publish / try
  const result = h('div', { class: 'outcome', id: 'author-result' });
  const save = (status) => async () => {
    if (!m.assessmentUse || !m.workRegime) return errorText('Decide how this will be used, and how clear-cut good performance is, before saving.');
    if (!as.choice) return errorText('Please say who helped write this scenario.');
    const assistance = as.choice === 'receipt' ? { draftReceipt: A.receipt }
      : as.choice === 'none' ? { draftAssistance: { used: false } }
        : { draftAssistance: { used: true, by: as.choice, ...(as.provider.trim() ? { provider: as.provider.trim() } : {}), ...(as.model.trim() ? { model: as.model.trim() } : {}), ...(as.note.trim() ? { note: as.note.trim() } : {}) } };
    const r = await act(ACT.authorScenario, { scenario: scenarioPayload(m), status, ...(A.basedOnVersion ? { basedOnVersion: A.basedOnVersion } : {}), ...assistance });
    A.basedOnVersion = r.version;
    A.saved = { scenarioIri: r.scenarioIri, version: r.version, status: r.status };
    A.loadedFrom = r.scenarioIri;
    const lines = [`Modal status ${r.modalStatus}`, `Rubric fingerprint ${r.rubricHash}`, r.supersedes ? `Replaces ${r.supersedes}` : 'First version'];
    A.lastSaved = r.changed === false
      ? { title: `Nothing changed: version ${r.version} is already ${r.status === 'published' ? 'published' : 'a draft'}.`, lines }
      : r.status === 'published'
        ? { title: `Published version ${r.version}.`, body: "Results won't count as evidence until a reviewer who didn't write it approves the rubric.", lines, rubricChanged: r.rubricChanged }
        : { title: `Saved version ${r.version} as a draft.`, body: "Learners can't start it; you can try it yourself.", lines, rubricChanged: r.rubricChanged };
    toast({ tone: 'success', title: A.lastSaved.title });
    paint();
    return null;
  };
  if (A.lastSaved) {
    result.append(callout({ tone: 'success', title: A.lastSaved.title, body: A.lastSaved.body,
      kids: [A.lastSaved.rubricChanged ? h('p', { class: 'callout__body', text: 'The rubric changed, so AI judge quality is tracked separately for this version.' }) : null],
      techLines: A.lastSaved.lines }));
  }
  const saveBtn = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Save draft', dataset: { action: ACT.authorScenario, status: 'draft' }, onclick: () => busy(saveBtn, result, save('draft'), { progress: 'Saving…' }) });
  const pubBtn = h('button', { type: 'button', class: 'btn btn--primary', text: 'Publish', dataset: { action: ACT.authorScenario, status: 'published' }, onclick: () => busy(pubBtn, result, save('published'), { progress: 'Saving…' }) });
  const tryBtn = h('button', { type: 'button', class: 'btn btn--ghost', text: 'Try it yourself (test run)', disabled: !A.saved, dataset: { action: ACT.startAttempt }, onclick: () => busy(tryBtn, result, async () => {
    const r = await act(ACT.startAttempt, { scenarioIri: A.saved.scenarioIri, scenarioVersion: A.saved.version, coached: false });
    go(attemptHash(r.attemptIri));
    return null;
  }, { progress: 'Starting…' }) });
  out.push(h('section', { class: 'card author-actions' }, h('div', { class: 'card__body' },
    h('div', { class: 'btn-group' }, pubBtn, saveBtn, tryBtn),
    h('p', { class: 'hint', text: 'Your own sessions on your scenario are test runs: never reviewed, counted or shared.' }),
    result)));
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Team and My practice
// ════════════════════════════════════════════════════════════════════════════════════════════

function viewRoles(root) {
  root.append(pageHeader({ title: 'Team', lede: 'Add people by their Member ID and choose their role. Only admins can make changes, and every change is recorded.' }));
  if (S.mode === 'paste' && !S.manual) { root.append(signInGate('roles')); return; }
  const address = h('input', { type: 'text', id: 'member-id', class: 'input input--mono', placeholder: 'did:web:identity.interego.xwisee.com:users:u-pk-… or 0x…' });
  const role = h('select', { id: 'member-role', class: 'select', onchange: (e) => { const hint = $('#member-role-hint'); if (hint) hint.textContent = ROLE_HINTS[e.target.value] || ''; } },
    ['reviewer', 'author', 'judge', 'agent', 'learner'].map((r) => h('option', { value: r, text: ROLE_WORDS[r] })));
  const change = h('select', { id: 'member-change', class: 'select' }, h('option', { value: 'add', text: 'Add this role' }), h('option', { value: 'remove', text: 'Remove this role' }));
  const out = h('div', { class: 'outcome' });
  const form = h('div', { class: 'card__body form' },
    h('div', { class: 'form-row' },
      formField({ label: 'Member ID or wallet address', control: address, hint: 'Ask the person to copy it from their account menu.' }),
      formField({ label: 'Role', control: role, hint: ROLE_HINTS.reviewer })),
    h('div', { class: 'form-row' }, formField({ label: 'Change', control: change })));
  if (S.mode === 'demo') {
    const pick = h('select', { class: 'select', 'aria-label': 'Fill from a demo role', onchange: (e) => { address.value = e.target.value; } },
      h('option', { value: '', text: 'Choose a demo person…' }), S.demoRoles.map((r) => h('option', { value: r.address, text: demoLabel(r) })));
    form.lastChild.append(formField({ label: 'Fill from a demo person', control: pick }));
  }
  address.addEventListener('input', () => fieldError(address, null));
  const btn = h('button', { type: 'button', class: 'btn btn--primary', text: 'Save change', dataset: { action: ACT.registerRole }, onclick: () => busy(btn, out, async () => {
    const value = address.value.trim();
    // Checked here first, so an empty field is never signed and sent.
    if (!value) { fieldError(address, 'Enter their Member ID or wallet address.'); return null; }
    fieldError(address, null);
    let r;
    try {
      r = await act(ACT.registerRole, { address: value, role: role.value, change: change.value });
    } catch (e) {
      // A mistyped ID is the field's problem, said under the field: trying the same again cannot succeed.
      if (e instanceof Refused && e.code === 'address-format') { fieldError(address, FORM_CHECKS['address-format']); return null; }
      throw e;
    }
    return h('div', { class: 'stack' },
      r.changed ? callout({ tone: 'success', title: 'Saved' }) : callout({ tone: 'neutral', title: 'Nothing changed: they already had that.' }),
      h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Team members', tabindex: '0' }, h('table', { class: 'table members' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Member' }), h('th', { scope: 'col', text: 'Roles' }))),
        h('tbody', {}, r.entries.map((e) => h('tr', {},
          h('td', {}, h('code', { class: 'mono', text: e.address }), h('span', { class: 'table__secondary', text: String(e.address).startsWith('did:') ? 'Interego member' : 'Wallet' })),
          h('td', {}, h('div', { class: 'cluster' }, e.roles.map((x) => badge(ROLE_WORDS[x] || x))))))))),
      tech([`Team list version ${r.seq}`]));
  }, { progress: 'Saving…' }) });
  form.append(h('div', {}, btn), out);
  root.append(h('section', { class: 'card' }, h('div', { class: 'card__header' }, h('h2', { class: 'card__title', text: 'Add or remove a person' })), form));
  root.append(h('p', { class: 'hint', text: 'The member list appears after your first change.' }));
}

async function viewMine(root) {
  root.append(pageHeader({ title: 'My practice', lede: "Your own practice sessions. Reviewers and admins see every session in the workspace, except authors' test runs." }));
  const r = await act(ACT.getAttempt, {}, { read: true });
  learnSessions(r);
  root.append(...coverageNotes(r));
  if (!r.attempts.length) {
    if (whole(r)) root.append(emptyState({ icon: 'chat', title: "You haven't practiced yet", text: 'Pick a scenario to start.', actions: [linkButton('#/practice', 'Browse scenarios', 'btn--primary')] }));
    return;
  }
  const resultOf = (a) => {
    if (a.finalPercent !== undefined) return `${a.finalPercent}% · ${a.finalMeetsPassRule ? 'meets the pass mark' : 'below the pass mark'}`;
    // Text deleted: whatever result it had is kept on the session page, never shown here as a provisional one.
    if (a.state === 'redacted') return a.provisionalPercent !== undefined ? 'Result kept: open to see' : 'Open to see';
    if (a.provisionalPercent !== undefined) return `${a.provisionalPercent}% · provisional`;
    if (['judged', 'countersigned', 'overridden', 'contested', 'review-retracted'].includes(a.state)) return 'Feedback only';
    return '—';
  };
  root.append(h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Practice sessions', tabindex: '0' }, h('table', { class: 'table table--stack mine' },
    h('thead', {}, h('tr', {}, ['Scenario', 'Status', 'Started', 'Result'].map((x) => h('th', { scope: 'col', text: x })), h('th', { scope: 'col', class: 'actions' }, h('span', { class: 'visually-hidden', text: 'Actions' })))),
    h('tbody', {}, r.attempts.map((a) => h('tr', {},
      h('td', { 'data-label': 'Scenario' }, h('a', { class: 'table__primary', href: attemptHash(a.attemptIri), text: a.scenarioTitle }),
        h('span', { class: 'table__secondary', text: `Session ${a.attemptNumber}${a.authorTest ? ' · test run' : ''}` })),
      h('td', { 'data-label': 'Status' }, statusPill(STATE_WORDS[a.state] || a.state, STATE_TONE[a.state] || 'pending')),
      h('td', { 'data-label': 'Started', text: fmtDate(a.startedAt) }),
      h('td', { 'data-label': 'Result', text: resultOf(a) }),
      h('td', { class: 'actions' }, linkButton(attemptHash(a.attemptIri), 'Open', 'btn--secondary btn--sm'))))))));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  Start
// ════════════════════════════════════════════════════════════════════════════════════════════

async function detectSigning() {
  S.hasWallet = typeof window.ethereum !== 'undefined';
  // The bridge already said whether it holds demo keys; ask for its roles only when it does, or when it could not say.
  if (S.bridge && S.bridge.demoSigning === false) return;
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
  document.addEventListener('click', onSignInClick);
  const skip = document.querySelector('.skip-link');
  // The skip link moves focus to the content; it never changes the route.
  if (skip) skip.addEventListener('click', (e) => { e.preventDefault(); const m = $('#main'); if (m) m.focus(); });
  // The relay's answer to a sign-in arrives here; the page turns itself back into /ui first.
  const signInNoteNode = CALLBACK_PATH.test(location.pathname) ? await finishInteregoSignIn() : restoreInteregoSession();
  try {
    await loadManifest();
    await loadBridge();
    await detectSigning();
  } catch (e) {
    renderHeader();
    renderTabs();
    document.title = 'Practice Evidence';
    clear($('#view')).append(callout({ tone: 'danger', title: "We couldn't load Practice Evidence", body: 'Please try again in a moment. If it keeps happening, tell your admin.',
      actions: [h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Try again', onclick: () => location.reload() })],
      techLines: [e instanceof Refused ? `Code: ${e.code || 'none'} · Status: HTTP ${e.status}` : null, String(e && e.message || e)] }));
    return;
  }
  // Signing manually is opt-in wherever another way to sign in exists; a bridge with none starts in it.
  S.manual = !interegoOffered() && !S.hasWallet;
  if (S.interego && interegoOffered()) S.mode = 'interego';
  else if (S.interego) forgetInterego();
  renderHeader();
  pageReady = true;
  if (signInNoteNode) $('#signing').append(signInNoteNode);
  // Only app routes re-route; an in-page anchor (the skip link, #scenarios) does not.
  window.addEventListener('hashchange', () => { if (!location.hash || location.hash.startsWith('#/')) route(); });
  if (S.mode === 'interego') await confirmInteregoSignIn();
  await route();
}

main();
