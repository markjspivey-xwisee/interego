// Interego, live — the page. It renders what the local demo server says and asks it to act;
// every call to a real service is made by the server, and every one of them appears in the
// ledger as it happens. Nothing here holds a key or a token.

const $ = (id) => document.getElementById(id);

/** Build an element: h('div', { class: 'x', onclick }, child, 'text', [more]). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--c) only take through setProperty.
      for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const short = (s, n = 14) => { const t = String(s ?? ''); return t.length > n * 2 + 1 ? `${t.slice(0, n)}…${t.slice(-n)}` : t; };
const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener' }, text ?? short(href, 22)) : text ?? '');
const pct = (p) => `${Math.round(p * 100)}%`;

/** JSON with light highlighting, for payloads the reader may want to see. */
function codeBlock(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pre = h('pre', { class: 'code' });
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  pre.innerHTML = typeof value === 'string'
    ? esc(text).replace(/(^|\n)(@prefix[^\n]*)/g, '$1<span class="c">$2</span>').replace(/("(?:[^"\\]|\\.)*")/g, '<span class="s">$1</span>')
    : esc(text)
      .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="k">$1</span>$2')
      .replace(/(:\s*)("(?:[^"\\]|\\.)*")/g, '$1<span class="s">$2</span>')
      .replace(/(:\s*)(-?\d+(?:\.\d+)?|true|false|null)/g, '$1<span class="n">$2</span>');
  return pre;
}
const raw = (label, value) => h('details', { class: 'raw' }, h('summary', {}, label), codeBlock(value));

/**
 * The little markdown agents answer in: paragraphs, **bold**, `code` and pipe tables. Everything is
 * escaped before the few tags are added, so an answer can never inject markup into the page.
 */
function md(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i -= 1;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
      const [head, ...rest] = body;
      out.push(`<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (lines[i].trim()) {
      out.push(`<p>${inline(lines[i].replace(/^#+\s*/, ''))}</p>`);
    }
  }
  return h('div', { class: 'md', html: out.join('') });
}

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3600);
}

async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok && j.ok !== false) j.ok = false;
  return j;
}

// ── State from the server ─────────────────────────────────────────────────────

let state = { services: [], cast: [], facts: [], chapters: {} };
const busy = new Set();
const local = { goal: '', topic: '', answers: {}, tamper: false };

function setState(next) {
  state = next;
  render();
}

// ── The cast, the services, the facts ─────────────────────────────────────────

const COLORS = { you: 'var(--you)', claude: 'var(--claude)', verifier: 'var(--verifier)', jev: 'var(--jev)', bridge: 'var(--bridge)', relay: 'var(--relay)', pod: 'var(--pod)' };

function avatar(actor, size) {
  const c = state.cast.find((a) => a.id === actor);
  return h('div', { class: `avatar${size ? ' sm' : ''}`, style: { '--c': COLORS[actor] ?? 'var(--relay)' }, title: c?.name ?? actor }, c?.initials ?? actor.slice(0, 2).toUpperCase());
}

function renderServices() {
  const el = $('services');
  el.replaceChildren(...state.services.map((s) => h('span', { class: 'chip', title: s.detail ?? '' }, h('span', { class: `dot ${s.status}` }), s.label)));
}

function renderCast() {
  $('cast').replaceChildren(...state.cast.map((a) => h('div', { class: 'actor' },
    avatar(a.id),
    h('div', {},
      h('div', { class: 'name' }, a.name, h('span', { class: `dot ${a.status ?? ''}`, title: a.statusText ?? '' })),
      h('div', { class: 'role' }, a.role),
      a.identity ? h('div', { class: 'id' }, a.identityHref ? link(a.identityHref, a.identity) : a.identity) : null,
      a.pod ? h('div', { class: 'id' }, 'pod ', link(a.pod, short(a.pod.replace(/^https?:\/\//, ''), 16))) : null,
      a.note ? h('div', { class: 'role', style: { marginTop: '4px' } }, a.note) : null,
    ),
  )));
  const gap = document.createElement('div');
  gap.style.height = '2px';
  $('cast').append(gap);
  for (const el of $('cast').children) el.style.marginBottom = '10px';
}

function renderFacts() {
  $('facts').replaceChildren(...state.facts.map((f) => h('span', { class: 'chip' }, h('span', { class: 'muted' }, f.label), f.href ? link(f.href, f.value) : f.value)));
}

// ── The ledger ────────────────────────────────────────────────────────────────

const ledgerEntries = new Map();

function ledgerRow(e) {
  const statusText = e.status === 'pending' ? 'calling' : e.status === 'refused' ? `refused ${e.code ?? ''}` : e.status === 'err' ? `error ${e.code ?? ''}` : `${e.code ?? 'ok'}${e.ms !== undefined ? ` · ${e.ms}ms` : ''}`;
  return h('div', { class: 'entry', 'data-id': e.id },
    avatar(e.actor, true),
    h('div', {},
      h('div', { class: 'line' },
        h('span', { class: 'who' }, state.cast.find((a) => a.id === e.actor)?.name ?? e.actor),
        h('span', { class: 'arrow' }, '→'),
        h('span', {}, e.service),
        e.tool ? h('span', { class: 'tool' }, e.tool) : null,
        h('span', { class: `status ${e.status}` }, statusText),
      ),
      e.summary ? h('div', { class: 'sum' }, e.summary) : null,
      e.links?.length ? h('div', { class: 'links' }, e.links.map((l) => link(l.href, l.label))) : null,
      h('div', { class: 'time' }, new Date(e.at).toLocaleTimeString()),
      e.request || e.response ? h('details', { class: 'raw' }, h('summary', {}, 'request and response'),
        e.request ? codeBlock(e.request) : null, e.response ? codeBlock(e.response) : null) : null,
    ),
  );
}

function addLedger(e) {
  const list = $('ledger');
  if (list.querySelector('.empty')) list.replaceChildren();
  const existing = ledgerEntries.get(e.id);
  const row = ledgerRow(e);
  if (existing) existing.replaceWith(row); else list.prepend(row);
  ledgerEntries.set(e.id, row);
  $('ledger-count').textContent = `${ledgerEntries.size} call${ledgerEntries.size === 1 ? '' : 's'}`;
}

// ── Chapters ──────────────────────────────────────────────────────────────────

const CHAPTERS = [
  { id: 'signin', n: 1, title: 'Sign in as yourself', actors: ['you'],
    part: { title: 'Part one · A credential you can prove', lede: 'An agent teaches you, you earn a credential, a stranger checks it, and a forgery fails.' },
    lede: 'Your passkey signs you in to the Interego relay on the relay’s own page, exactly as a Claude connector does. Then you authorize this app’s session agent on your pod, so what it signs in your name can be verified. From here on, everything done as you goes through that connection.' },
  { id: 'author', n: 2, title: 'An agent writes a course and offers it', actors: ['claude', 'bridge'],
    lede: 'Name a topic. The Claude Code agent writes a short course with Claude, publishes it with its own wallet as a real SCORM 2004 package whose answers are hashed at authoring, and offers it from its pod as a HyprCat data product.' },
  { id: 'discover', n: 3, title: 'Find it across pods', actors: ['you', 'jev'],
    lede: 'Your connection walks the pods: each manifest is read with the relay’s ordinary discovery tool, catalogs are found by their type, and each catalog’s issuer is checked against who the pod says published it. No registry and no marketplace. Then Jev, a System One model, ranks what it found for what you want to learn.' },
  { id: 'learn', n: 4, title: 'Take the course', actors: ['you', 'bridge'],
    lede: 'The bridge’s SCORM sequencing engine delivers each section and grades your answers against the author’s hashes; this page never sees an answer key. Every call is your connection signing as you. The engine tags each result it grades, so a result anyone merely claims can never pass for one it graded.' },
  { id: 'claim', n: 5, title: 'Claim what you earned', actors: ['you', 'bridge'],
    lede: 'The tenant signs an Open Badges 3.0 credential only from what your own record shows, names that evidence and the course’s author, and writes it into the wallet on your pod, issued to you, not to the agent that carried the request.' },
  { id: 'verify', n: 6, title: 'Hand it to an agent nobody briefed', actors: ['verifier', 'bridge'],
    lede: 'A fresh Claude agent gets one thing: the skill generated from Foxxi’s affordance declarations. You send it a link to the credential in your wallet, the way a badge is shared. It has to find the right tool and check the credential the way a relying party should. Or tamper with a copy first, and see exactly what it ended up checking.' },
  { id: 'forgery', n: 7, title: 'Watch a forgery fail', actors: ['claude', 'bridge'],
    lede: 'The Claude Code agent writes its own “passed” for its own course into its own record and asks for the same credential. The record is its to write; the credential is not its to take.' },
  { id: 'teach', n: 8, title: 'You teach the agent', actors: ['you', 'bridge'],
    part: { title: 'Part two · Two learners, one record standard', lede: 'The same learning record, for a person and an AI agent side by side: xAPI 2.0 (IEEE 9274.1.1) experiences, work performance, competencies, credentials, and the IEEE P2997 learner record that rolls them up.' },
    lede: 'Now you write a course, or have Claude draft one for you to edit, and publish it as yours through your connection. The engine hashes your answers; the agent will have to find them by reading, exactly as you did.' },
  { id: 'agentLearns', n: 9, title: 'The agent takes your course', actors: ['claude', 'bridge'],
    lede: 'The Claude Code agent launches your course with its own wallet. A Claude reads each section the engine delivers and answers, seeing only what you saw; the engine grades it against your hashes. If it passes, it claims a credential into its own wallet, from its own record.' },
  { id: 'work', n: 10, title: 'Both of you at work', actors: ['you', 'claude', 'bridge'],
    lede: 'Each of you taught the other, and teaching is work. Each records it as a performance in the xAPI production context, citing the course taught as evidence the record checks can be fetched. You record as a person and stay private; the agent records as an agent, which makes its whole record public.' },
  { id: 'records', n: 11, title: 'Two learner records, side by side', actors: ['you', 'claude', 'bridge'],
    lede: 'The bridge assembles an IEEE P2997 Enterprise Learner Record for each of you from your own pod: the experiences, the work, the competencies they add up to, and the credentials in your wallet. Then each tries to read the other’s. Yours is private; the agent’s is not.' },
  { id: 'next', n: 12, title: 'What each should learn next', actors: ['jev'],
    lede: 'Jev decides each learner’s next course from their record alone: the competencies it shows and how they were earned, and the credentials already held. Same question, same courses, two records.' },
  { id: 'cmi5', n: 13, title: 'An activity launched the cmi5 way', actors: ['you', 'claude', 'bridge'],
    part: { title: 'Part three · The standards the rest of the learning world speaks', lede: 'Two more pieces of the ADL Total Learning Architecture, for both learners: cmi5 (IEEE 9274.2.1), how an LMS launches an activity and trusts what it reports, and LTI 1.3, how an LMS launches a tool and gets the grade back. Both land in the same learner records.' },
    lede: 'The bridge publishes a cmi5 course of its own. Each of you launches your next activity in it, signed as yourselves. The LMS stages the launch data, the activity trades a one-time URL for its auth-token and reports to the LRS, and when its statements meet the activity’s moveOn rule the LMS records satisfied. A cmi5 activity scores itself, so what it reports adds experience to your record, not evidence for a credential.' },
  { id: 'lti', n: 14, title: 'Your LMS launches a course, and the grade comes back', actors: ['you', 'claude', 'bridge'],
    lede: 'Foxxi also runs an LMS of its own. It launches the agent’s course for you and yours for the agent over LTI 1.3: the Tool’s login, the LMS’s authorization, an id_token the Tool checks against the LMS’s published keys, the course in the SCORM engine, and the grade back to the LMS gradebook over Assignment and Grade Services. The LMS knows who you are from your signature. There is no LMS password.' },
  { id: 'after', n: 15, title: 'The records, after everything', actors: ['you', 'claude', 'bridge'],
    lede: 'The two IEEE P2997 records from chapter 11, read again. The cmi5 activity and the LMS-launched course are in them now, beside everything else each of you learned, taught and earned.' },
];

function chapterStatus(id) { return state.chapters[id]?.status ?? 'locked'; }

/** An issued Open Badges 3.0 credential as a card, with the signed JSON behind it. */
function badgeCard(claim, walletLabel) {
  const vc = claim.vc ?? {};
  const subject = vc.credentialSubject ?? {};
  const ach = subject.achievement ?? {};
  return [
    h('div', { class: 'badge' },
      h('div', { class: 'seal' }, 'OPEN', h('br'), 'BADGE', h('br'), '3.0'),
      h('div', {},
        h('h3', {}, ach.name ?? 'Completion'),
        h('div', { class: 'by' }, 'issued by ', short(vc.issuer, 14), ' to ', short(subject.id, 14)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'criteria'), h('dd', { class: 'prose' }, ach.criteria?.narrative ?? ''),
          h('dt', {}, 'valid'), h('dd', {}, `${vc.validFrom ?? ''} → ${vc.validUntil ?? ''}`),
          h('dt', {}, 'evidence'), h('dd', {}, `${(subject.evidence ?? []).length} graded statement(s)`),
          h('dt', {}, walletLabel), h('dd', {}, link(claim.descriptorUrl, claim.descriptorUrl)),
          h('dt', {}, 'proof'), h('dd', {}, vc.proof?.cryptosuite ?? vc.proof?.type ?? '')))),
    raw('The signed credential', vc),
  ];
}
function chapterData(id) { return state.chapters[id]?.data ?? {}; }

function spinnerButton(label, onClick, opts = {}) {
  const running = busy.has(opts.key ?? label);
  return h('button', { class: `btn${opts.primary === false ? '' : ' primary'}`, type: 'button', disabled: running || opts.disabled, onclick: async () => {
    const key = opts.key ?? label;
    busy.add(key); render();
    try { await onClick(); } finally { busy.delete(key); render(); }
  } }, running ? h('span', { class: 'spin' }) : null, running ? (opts.runningLabel ?? 'Working…') : label);
}

async function run(chapter, body) {
  const r = await api(`/api/chapter/${chapter}`, body ?? {});
  if (r.ok === false) toast(r.error ?? 'That did not work');
  if (r.state) setState(r.state);
  return r;
}

function problem(d) {
  if (!d.error) return null;
  return h('div', { class: `note ${d.refused ? 'warn' : 'err'}` }, h('strong', {}, d.refused ? 'Refused: ' : 'Failed: '), d.error, d.hint ? h('div', { style: { marginTop: '4px' } }, d.hint) : null);
}

const BODIES = {
  signin() {
    const d = chapterData('signin');
    const you = state.cast.find((a) => a.id === 'you');
    if (!d.signedIn) {
      return [
        h('div', { class: 'actions' },
          spinnerButton('Sign in with your passkey', async () => {
            // Opened inside the click, so a popup blocker lets it through; it goes to the relay once
            // this app has registered there. Without a window, this page goes instead and comes back.
            const w = window.open('about:blank', 'interego-signin', 'width=520,height=760');
            const r = await api('/api/signin', {});
            if (r.authorizeUrl) {
              if (w && !w.closed) w.location.href = r.authorizeUrl; else location.href = r.authorizeUrl;
            } else { w?.close(); toast(r.error ?? 'Could not start sign-in'); }
          }, { runningLabel: 'Opening the relay…' }),
          h('span', { class: 'muted' }, 'A window opens on relay.interego.xwisee.com; your passkey never touches this page.')),
        problem(d),
      ];
    }
    return [
      h('div', { class: 'grid' },
        h('div', { class: 'card' }, h('h3', {}, 'Signed in'), h('div', { class: 'meta' }, 'through your relay connection'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'you'), h('dd', {}, you?.identity ?? ''),
            h('dt', {}, 'pod'), h('dd', {}, link(d.pod, d.pod)),
            h('dt', {}, 'session agent'), h('dd', {}, d.signer ?? ''),
            h('dt', {}, 'client'), h('dd', {}, d.surface ?? ''))),
        h('div', { class: 'card' }, h('h3', {}, d.authorized ? 'Authorized on your pod' : 'Not yet authorized'),
          h('div', { class: 'meta' }, d.authorized ? 'a delegation credential on your pod says this session agent acts for you' : 'Foxxi will not accept what this session signs until your pod says it acts for you'),
          d.credentialUrl ? h('dl', { class: 'kv' }, h('dt', {}, 'credential'), h('dd', {}, link(d.credentialUrl, d.credentialUrl))) : null),
      ),
      d.authorized ? null : h('div', { class: 'actions' }, spinnerButton('Authorize this app’s session agent', () => run('authorize'), { runningLabel: 'Writing the delegation…' }),
        h('span', { class: 'muted' }, 'Your connection’s register_agent writes a delegation credential to your own pod. You can revoke it with revoke_agent.')),
      problem(d),
    ];
  },

  author() {
    const d = chapterData('author');
    const out = [];
    if (!d.course && !d.writing) {
      out.push(h('div', { class: 'field', style: { marginTop: '6px' } },
        h('input', { class: 'input', placeholder: 'A topic for the agent to teach, e.g. why a credential should rest on evidence a third party graded', value: local.topic ?? '', oninput: (e) => { local.topic = e.target.value; } }),
        spinnerButton('Have the agent write it', () => run('author', { topic: local.topic ?? '' }), { runningLabel: 'The agent is writing…' })));
    }
    if (d.transcript?.length) {
      out.push(h('div', { class: 'transcript' }, d.transcript.map((t) => h('div', { class: 'turn' }, avatar('claude', true),
        h('div', { class: 'body' }, h('div', { class: 'kind' }, t.kind === 'started' ? 'started' : 'thinking'), h('div', {}, t.text ?? ''))))));
    }
    if (d.draft) {
      out.push(h('div', { class: 'card', style: { marginTop: '12px' } },
        h('h3', {}, d.draft.title), h('div', { class: 'meta' }, d.draft.summary ?? '', d.costUsd !== undefined ? ` · written for $${Number(d.costUsd).toFixed(3)}` : ''),
        d.draft.scos.map((s) => h('div', { class: 'sco' }, h('h3', {}, s.title), h('p', {}, s.body),
          (s.assessment ?? []).map((q) => h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `Question: ${q.question} — answer hashed at authoring`))))));
    }
    if (d.course) {
      out.push(h('div', { class: 'note ok' }, h('strong', {}, 'Authored. '), `${d.course.courseId} is a SCORM 2004 course on the bridge, authored by `, short(d.course.authoredBy, 12), '. ',
        link(d.course.manifest, 'imsmanifest.xml'), ' · ', link(d.course.hmd, 'HyperMarkdown'), d.course.scormZip ? [' · ', link(d.course.scormZip, 'SCORM package')] : null));
    }
    if (d.published) {
      out.push(h('div', { class: 'note ok' }, h('strong', {}, 'Offered. '), 'Its pod publishes a ', h('strong', {}, 'hyprcat:FederatedCatalog'), ' — ', link(d.published.descriptorUrl, 'the descriptor'), ' · ', link(d.published.graphUrl, 'the catalog graph'), `, issued by ${short(d.published.issuer ?? '', 14)}, ${d.published.products} course${d.published.products === 1 ? '' : 's'}.`));
      if (d.published.turtle) out.push(raw('The catalog, as Turtle', d.published.turtle));
    }
    if (d.course && !d.published) out.push(h('div', { class: 'actions' }, spinnerButton('Publish its catalog', () => run('publish'), { runningLabel: 'Publishing to its pod…' })));
    if (d.published) out.push(h('div', { class: 'actions' }, spinnerButton('Write another course', () => run('reset-author'), { primary: false })));
    out.push(problem(d));
    return out;
  },

  discover() {
    const d = chapterData('discover');
    const out = [h('div', { class: 'actions' }, spinnerButton(d.catalogs ? 'Walk the pods again' : 'Discover course catalogs', () => run('discover'), { runningLabel: 'Walking pods…', primary: !d.catalogs }))];
    if (d.pods) {
      out.push(h('div', { class: 'pods' }, d.pods.map((p) => h('span', { class: 'pod' },
        h('span', { class: `dot ${p.unreachable ? 'err' : p.catalogs > 0 ? 'ok' : ''}` }),
        h('span', { class: 'who' }, p.label ?? short(p.pod, 12)),
        h('span', { class: 'muted' }, p.unreachable ? 'unreachable' : `${p.entries} entries · ${p.catalogs} catalog${p.catalogs === 1 ? '' : 's'}`)))));
    }
    if (d.catalogs) {
      if (d.catalogs.length === 0) out.push(h('div', { class: 'note' }, 'No pod in this walk publishes a catalog yet. Chapter 2 has the agent publish one.'));
      out.push(h('div', { class: 'grid' }, d.catalogs.flatMap((c) => c.products.map((p) => {
        const picked = chapterData('learn').course?.courseId === p.courseId;
        return h('div', { class: `card pick${picked ? ' picked' : ''}`, onclick: () => run('pick', { courseId: p.courseId, catalogIri: c.iri }) },
          h('h3', {}, p.title ?? p.courseId),
          h('div', { class: 'meta' }, p.category ?? 'course', ' · from ', c.podLabel ?? short(c.pod, 10)),
          h('dl', { class: 'kv' },
            h('dt', {}, 'issuer'), h('dd', {}, short(c.issuedBy, 16)),
            h('dt', {}, 'check'), h('dd', {}, c.issuerMatches === true ? 'issuer matches the pod’s attribution' : c.issuerMatches === false ? 'issuer does NOT match the attribution' : 'the pod does not say'),
            h('dt', {}, 'port'), h('dd', {}, link(p.ports?.[0]?.target, 'GET the course'))),
          picked ? h('div', { class: 'tag', style: { marginTop: '8px', display: 'inline-block' } }, 'chosen') : null);
      }))));
      out.push(h('div', { class: 'field', style: { marginTop: '14px' } },
        h('input', { class: 'input', placeholder: 'What do you want to learn? e.g. why a denylist cannot stop inferred authority', value: local.goal, oninput: (e) => { local.goal = e.target.value; } }),
        spinnerButton('Ask Jev to rank them', () => run('rank', { goal: local.goal }), { runningLabel: 'Jev is judging…', disabled: !d.catalogs?.length })));
    }
    if (d.ranking) {
      out.push(h('div', { class: 'muted', style: { marginTop: '12px', fontSize: '12px' } }, `Jev ${d.ranking.model ?? ''}: a Choice over the discovered courses for “${d.ranking.goal}”, ${d.ranking.latencyMs ?? '?'} ms. Probabilities, not prose.`));
      out.push(...d.ranking.options.map((o, i) => h('div', { class: `rank${i === 0 ? ' top' : ''}` },
        h('div', {}, h('strong', {}, o.title), h('div', { class: 'bar' }, h('span', { style: { width: pct(o.p) } }))),
        h('div', { class: 'p' }, pct(o.p)))));
    }
    out.push(problem(d));
    return out;
  },

  learn() {
    const d = chapterData('learn');
    if (!d.course) return [h('div', { class: 'note' }, 'Choose a course in chapter 2.')];
    const out = [h('div', { class: 'card', style: { marginTop: '8px' } },
      h('h3', {}, d.course.title), h('div', { class: 'meta' }, `mastery ${d.course.masteryScore} · ${d.course.scoCount ?? d.course.scos?.length ?? '?'} sections · authored by `, short(d.course.authoredBy, 12)),
      h('div', { class: 'links', style: { marginTop: '6px', display: 'flex', gap: '12px', fontSize: '12px' } },
        link(d.course.manifest, 'imsmanifest.xml'), link(d.course.hmd, 'HyperMarkdown'), d.course.scormZip ? link(d.course.scormZip, 'SCORM package') : null))];
    if (!d.sessionId && !d.result) {
      out.push(h('div', { class: 'actions' }, spinnerButton('Start the course', () => run('launch'), { runningLabel: 'The engine is starting an attempt…' })));
    }
    if (d.sco && !d.result) {
      const qs = Array.isArray(d.sco.assessment) ? d.sco.assessment : [];
      out.push(h('div', { class: 'sco' }, h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '4px' } }, `SECTION ${d.sco.id} · delivered by the SCORM 2004 sequencing engine`), h('h3', {}, d.sco.title), h('p', {}, d.sco.body),
        qs.map((q) => h('div', { class: 'question' }, h('label', {}, q.question),
          h('input', { class: 'input', style: { width: '100%' }, placeholder: 'your answer', value: local.answers[q.index] ?? '', oninput: (e) => { local.answers[q.index] = e.target.value; } })))));
      out.push(h('div', { class: 'actions' }, spinnerButton(qs.length ? 'Submit your answers' : 'Continue', async () => {
        const answers = qs.slice().sort((a, b) => a.index - b.index).map((q) => local.answers[q.index] ?? '');
        await run('submit', { answers });
        local.answers = {};
      }, { runningLabel: 'The engine is grading…' }), qs.length ? h('span', { class: 'muted' }, 'Graded remotely against the author’s answer hashes.') : null));
      if (d.lastGraded) out.push(h('div', { class: `note ${d.lastGraded.passed ? 'ok' : 'warn'}` }, `Last section: ${d.lastGraded.correct} of ${d.lastGraded.total} correct.`));
    }
    if (d.result) {
      out.push(h('div', { class: `note ${d.result.passed ? 'ok' : 'warn'}` }, h('strong', {}, d.result.passed ? 'Passed. ' : 'Not passed. '),
        `Score ${d.result.score}; the engine rolled this up from what it graded and recorded ${d.result.recordedStatements ?? 0} statements in your record, each carrying its grading tag.`));
      if (!d.result.passed) out.push(h('div', { class: 'actions' }, spinnerButton('Try again', () => run('launch'), { primary: false })));
      if (d.statements?.length) out.push(raw(`The graded statements (${d.statements.length})`, d.statements));
    }
    out.push(problem(d));
    return out;
  },

  claim() {
    const d = chapterData('claim');
    const out = [h('div', { class: 'actions' },
      spinnerButton('Where do my courses stand?', () => run('standings'), { primary: !d.standings, runningLabel: 'Reading your record and wallet…' }))];
    if (d.standings) {
      out.push(...d.standings.map((s) => h('div', { class: 'standing' },
        h('div', {}, h('strong', {}, s.courseTitle), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${s.statements} statements about it · ${s.mastery} graded mastery${s.lapsed ? ' · a lapsed credential' : ''}`)),
        h('span', { class: `state ${s.state}` }, s.state.replace('-', ' ')))));
      const claimable = d.standings.find((s) => s.state === 'claimable');
      if (claimable) out.push(h('div', { class: 'actions' }, spinnerButton(`Claim the credential for ${claimable.courseTitle}`, () => run('claim', { courseId: claimable.courseId }), { runningLabel: 'The tenant is signing…' })));
    }
    if (d.credential) out.push(...badgeCard(d.credential, 'in your wallet'));
    if (d.alreadyHeld) out.push(h('div', { class: 'note ok' }, 'You already hold this credential and it is in force, so nothing new was issued: ', link(d.alreadyHeld.descriptorUrl, 'the one in your wallet')));
    out.push(problem(d));
    return out;
  },

  verify() {
    const d = chapterData('verify');
    const claim = chapterData('claim');
    const has = claim.credential || claim.alreadyHeld;
    const out = [];
    if (!has) out.push(h('div', { class: 'note' }, 'Claim a credential in chapter 4 first.'));
    out.push(h('div', { class: 'actions' },
      spinnerButton(d.transcript ? 'Ask a fresh agent again' : 'Hand it to the agent', () => run('verify', { tamper: local.tamper }), { runningLabel: 'The agent is working…', disabled: !has }),
      h('label', { class: 'muted', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: local.tamper, onchange: (e) => { local.tamper = e.target.checked; } }),
        'tamper with it first (change the achievement name)')));
    if (d.skill) out.push(raw(`The only instructions it has: the generated skill ${d.skill.name} (${d.skill.bytes} bytes)`, d.skill.text));
    if (d.link) out.push(h('div', { class: 'note' }, d.tampered
      ? 'Handed over as JSON, with the achievement’s name changed: a copy has no link. The agent has to retype it into its tool call.'
      : h('span', {}, 'Handed over as a link to the credential in your wallet, the way a badge is shared: ', link(d.link, short(d.link, 26)))));
    if (d.transcript) {
      out.push(h('div', { class: 'transcript' }, d.transcript.map((t) => h('div', { class: 'turn' }, avatar('verifier', true),
        h('div', { class: 'body' }, h('div', { class: 'kind' }, t.kind), t.text ? (t.kind === 'says' ? md(t.text) : h('div', {}, t.text)) : null, t.detail ? codeBlock(t.detail) : null)))));
    }
    if (d.checks) {
      out.push(h('div', { class: 'checks' }, Object.entries(d.checks).map(([k, v]) => h('div', { class: `check ${v ? 'pass' : 'fail'}` }, h('span', { class: 'ic' }, v ? '✓' : '✕'), k))));
    }
    if (d.readFrom) out.push(h('div', { class: 'note ok' }, 'The bridge read the credential from your wallet itself, so it checked the bytes the issuer signed: ', link(d.readFrom, short(d.readFrom, 26))));
    if (d.differences) {
      out.push(d.differences.length === 0
        ? h('div', { class: 'note ok' }, 'What the agent sent to the verifier is exactly the credential in your wallet.')
        : h('div', { class: 'note warn' },
          h('strong', {}, `What the agent sent differs from the credential in your wallet in ${d.differences.length} place${d.differences.length === 1 ? '' : 's'}: `),
          d.tampered ? 'the change made before handing it over, and anything the agent changed while retyping it.' : 'the agent changed it while retyping it.',
          h('div', { class: 'diffs' }, d.differences.map((x) => h('div', { class: 'diff' },
            h('code', {}, x.path),
            h('div', { class: 'side' }, h('span', { class: 'muted' }, 'yours '), x.holder === undefined ? h('em', {}, 'absent') : short(JSON.stringify(x.holder), 40)),
            h('div', { class: 'side' }, h('span', { class: 'muted' }, 'checked '), x.checked === undefined ? h('em', {}, 'absent') : short(JSON.stringify(x.checked), 40)))))));
    }
    if (d.verdict) out.push(h('div', { class: `note ${d.valid ? 'ok' : 'warn'}` }, h('strong', {}, 'The agent’s answer'), md(d.verdict)));
    out.push(problem(d));
    return out;
  },

  forgery() {
    const d = chapterData('forgery');
    const out = [h('div', { class: 'actions' }, spinnerButton(d.attempted ? 'Let it try again' : 'Let the agent try', () => run('forgery'), { runningLabel: 'The agent is forging…' }))];
    if (d.statement) out.push(raw('The statement it wrote into its own record', d.statement));
    if (d.refusal) out.push(h('div', { class: 'note warn' }, h('strong', {}, `Refused, ${d.refusal.status}: `), d.refusal.error));
    if (d.issued) out.push(h('div', { class: 'note err' }, h('strong', {}, 'Issued. '), 'That should not have happened; the ledger has the call.'));
    out.push(problem(d));
    return out;
  },

  teach() {
    const d = chapterData('teach');
    if (d.published) {
      const c = d.published;
      return [
        h('div', { class: 'card' }, h('h3', {}, c.title),
          h('div', { class: 'meta' }, `${c.scoCount ?? '?'} sections · mastery ${c.masteryScore ?? ''} · authored by `, short(c.authoredBy ?? c.authorDid, 14)),
          h('div', { class: 'links', style: { marginTop: '6px', display: 'flex', gap: '12px', fontSize: '12px' } },
            link(c.courseIri, 'the course'), link(c.manifest, 'imsmanifest.xml'), c.scormZip ? link(c.scormZip, 'SCORM package') : null)),
        h('div', { class: 'note ok' }, h('strong', {}, 'Published as yours. '), 'Signed by your session agent, which your pod says acts for you. The engine keeps your answers only as hashes.'),
        problem(d),
      ];
    }
    const out = [h('div', { class: 'actions' },
      h('input', { class: 'input', style: { flex: '1 1 240px' }, placeholder: 'a topic you know well', value: local.teachTopic ?? '', oninput: (e) => { local.teachTopic = e.target.value; } }),
      spinnerButton('Draft it with Claude', () => run('draft-course', { topic: local.teachTopic ?? '' }), { primary: !local.course, runningLabel: 'Claude is drafting…' }),
      h('button', { class: 'btn', type: 'button', onclick: () => { local.course = blankCourse(); render(); } }, 'Write it yourself'))];
    if (d.drafting && d.transcript?.length) out.push(transcriptView(d.transcript, 'claude'));
    // A new draft replaces the form once; after that, the form is yours.
    if (d.draft && local.draftId !== d.draft.courseId) { local.course = JSON.parse(JSON.stringify(d.draft)); local.draftId = d.draft.courseId; }
    if (local.course) {
      out.push(courseForm(local.course));
      out.push(h('div', { class: 'actions' },
        spinnerButton('Publish it as your course', () => run('publish-course', { course: local.course }), { runningLabel: 'Signing and publishing…' }),
        h('span', { class: 'muted' }, 'Put each answer in its section, so a careful reader can find it.')));
    }
    out.push(problem(d));
    return out;
  },

  agentLearns() {
    const d = chapterData('agentLearns');
    const out = [];
    if (!d.running && !d.result) out.push(h('div', { class: 'actions' }, spinnerButton('Send the agent to class', () => run('agent-learn'), { runningLabel: 'The agent is reading…' })));
    if (d.sections?.length) {
      out.push(h('div', { class: 'sections' }, d.sections.map((s) => h('div', { class: 'sco-result' },
        h('strong', {}, `${s.id} · ${s.title}`),
        s.questions?.length
          ? s.questions.map((q, i) => {
            const g = s.graded?.detail?.[i];
            return h('div', { class: 'qa-result' }, h('span', { class: 'muted' }, q), ' → ', h('code', {}, s.answers?.[i] ?? '…'),
              g ? h('span', { class: `mark ${g.correct ? 'ok' : 'err'}` }, g.correct ? ' correct' : ' wrong') : null);
          })
          : h('div', { class: 'muted' }, 'No questions here; it read on.')))));
    }
    if (d.transcript?.length) out.push(h('details', { class: 'raw' }, h('summary', {}, `What the agent thought while it read (${d.transcript.length})`), transcriptView(d.transcript, 'claude')));
    if (d.result) {
      out.push(h('div', { class: `note ${d.result.passed ? 'ok' : 'warn'}` }, h('strong', {}, d.result.passed ? 'The agent passed your course. ' : 'The agent did not pass. '),
        `Score ${d.result.score}, graded by the engine against the hashes of your answers.`));
      if (!d.result.passed) out.push(h('div', { class: 'actions' }, spinnerButton('Let it try again', () => run('agent-learn'), { primary: false, runningLabel: 'The agent is reading…' })));
    }
    if (d.credential?.vc) out.push(...badgeCard(d.credential, 'in the agent’s wallet'));
    if (d.claimError) out.push(h('div', { class: 'note warn' }, h('strong', {}, 'Claim refused: '), d.claimError));
    out.push(problem(d));
    return out;
  },

  work() {
    const d = chapterData('work');
    const card = (who, title, sub, r) => h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'meta' }, sub),
      r?.recorded ? h('dl', { class: 'kv' },
        h('dt', {}, 'task'), h('dd', { class: 'prose' }, r.taskName ?? ''),
        h('dt', {}, 'evidence'), h('dd', {}, link(r.taskId, r.taskId)),
        h('dt', {}, 'competency'), h('dd', {}, short(r.activityType, 24)),
        h('dt', {}, 'statement'), h('dd', {}, r.statementId ?? ''),
        h('dt', {}, 'context'), h('dd', {}, 'production (xAPI, TLA master object model)'),
        h('dt', {}, 'on the pod'), h('dd', {}, link(r.durable, r.durable))) : null,
      r?.error ? h('div', { class: 'note warn' }, r.error) : null,
      !r?.recorded ? h('div', { class: 'actions' }, spinnerButton(who === 'you' ? 'Record your work' : 'Have the agent record its work', () => run('record-work', { who }), { key: `work-${who}`, runningLabel: 'Recording…' })) : null,
      r?.recordVisibility ? h('div', { class: 'note warn' }, r.recordVisibility.note)
        : r?.recorded ? h('div', { class: 'note ok' }, 'Recorded as a person, so your record stays yours alone.') : null);
    return [h('div', { class: 'grid' },
      card('you', 'Your work', 'You taught the agent a course.', d.you),
      card('agent', 'The agent’s work', 'The agent taught you one.', d.agent)), problem(d)];
  },

  records() {
    const d = chapterData('records');
    const out = [h('div', { class: 'actions' }, spinnerButton(d.you ? 'Assemble them again' : 'Assemble both records', () => run('review-records'), { primary: !d.you, runningLabel: 'Reading two pods…' }))];
    if (d.you || d.agent) out.push(h('div', { class: 'grid' }, recordColumn('Your record', 'private to you', d.you), recordColumn('The agent’s record', 'public', d.agent)));
    if (d.cross) {
      const a = d.cross.agentReadYou;
      const y = d.cross.youReadAgent;
      out.push(h('div', { class: `note ${a.status >= 400 ? 'ok' : 'err'}` }, h('strong', {}, `The agent tried to read yours: ${a.status}. `), a.status >= 400 ? a.error : 'It could. That should not happen; the ledger has the call.'));
      out.push(h('div', { class: `note ${y.status < 400 ? 'ok' : 'warn'}` }, h('strong', {}, `You read the agent’s: ${y.status}. `), y.status < 400 ? 'An agent’s capability record is public, so anyone deciding whether to rely on it can look.' : y.error));
    }
    out.push(problem(d));
    return out;
  },

  next() {
    const d = chapterData('next');
    const out = [h('div', { class: 'actions' }, spinnerButton(d.you ? 'Ask again' : 'Ask Jev', () => run('recommend'), { primary: !d.you, runningLabel: 'Jev is weighing two records…' }))];
    const col = (title, r, n) => (!r ? null : r.none ? h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'muted' }, r.none))
      : h('div', { class: 'card' }, h('h3', {}, title),
        h('div', { class: 'meta' }, `${r.model} · ${r.latencyMs} ms · a Choice over ${n ?? '?'} courses this learner did not write`),
        r.options.map((o, i) => h('div', { class: `rank${i === 0 ? ' top' : ''}` },
          h('div', {}, h('strong', {}, o.title), h('div', { class: 'bar' }, h('span', { style: { width: pct(o.p) } }))),
          h('div', { class: 'p' }, pct(o.p))))));
    if (d.you || d.agent) out.push(h('div', { class: 'grid' }, col('For you', d.you, d.youCourses), col('For the agent', d.agent, d.agentCourses)));
    out.push(problem(d));
    return out;
  },

  cmi5() {
    const d = chapterData('cmi5');
    const launchYou = async () => {
      // Opened inside the click, so a popup blocker lets it through; the activity loads once the LMS has launched it.
      const w = window.open('about:blank', 'interego-cmi5', 'width=760,height=860');
      const r = await run('cmi5-launch', { who: 'you' });
      const url = r.state?.chapters?.cmi5?.data?.you?.launchUrl;
      if (r.ok !== false && url) { if (w && !w.closed) w.location.href = url; else window.open(url, '_blank', 'noopener'); } else w?.close();
    };
    const card = (who, title, sub, x) => h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'meta' }, sub),
      x ? h('dl', { class: 'kv' },
        h('dt', {}, 'activity'), h('dd', { class: 'prose' }, x.auTitle),
        h('dt', {}, 'moveOn'), h('dd', {}, x.moveOn),
        h('dt', {}, 'launch data'), h('dd', { class: 'prose' }, x.launchDataStaged ? 'staged in the State resource, where the activity reads it' : 'not staged'),
        h('dt', {}, 'registration'), h('dd', {}, link(x.progress, short(x.registration, 10)))) : null,
      x?.score ? h('div', { class: 'sections' }, x.score.detail.map((q) => h('div', { class: 'sco-result' },
        h('div', { class: 'qa-result' }, h('span', { class: 'muted' }, q.question), ' → ', h('code', {}, q.reply || '…'), h('span', { class: `mark ${q.right ? 'ok' : 'err'}` }, q.right ? ' right' : ' not right')),
        !q.right ? h('div', { class: 'muted' }, `The answer: ${q.key}.`) : null))) : null,
      x?.note ? h('div', { class: 'note' }, h('strong', {}, 'What it takes from the lesson: '), x.note) : null,
      x?.transcript?.length ? h('details', { class: 'raw' }, h('summary', {}, `What the agent thought while it read (${x.transcript.length})`), transcriptView(x.transcript, 'claude')) : null,
      x?.state === 'launched' ? h('div', { class: 'muted', style: { marginTop: '8px' } }, 'Work through it in the window that opened. This updates when the LMS records satisfied.') : null,
      x?.state === 'reading' ? h('div', { class: 'muted', style: { marginTop: '8px' } }, 'The agent is reading…') : null,
      x?.state === 'reported' ? h('div', { class: 'muted', style: { marginTop: '8px' } }, `Reported ${(x.sent ?? []).join(', ')}; waiting for the LMS.`) : null,
      x?.state === 'satisfied' ? h('div', { class: 'note ok' }, h('strong', {}, 'Satisfied. '), `The LMS recorded it${x.satisfiedAt ? ` at ${new Date(x.satisfiedAt).toLocaleTimeString()}` : ''}: the activity’s statements met its moveOn rule (${x.moveOn}).`) : null,
      h('div', { class: 'actions' }, who === 'you'
        ? spinnerButton(x ? 'Launch your next activity' : 'Launch it for yourself', launchYou, { key: 'cmi5-you', primary: !x || x.state === 'satisfied', runningLabel: 'Launching…' })
        : spinnerButton(x ? 'Send the agent to its next one' : 'Send the agent', () => run('cmi5-launch', { who: 'agent' }), { key: 'cmi5-agent', primary: !x || x.state === 'satisfied', runningLabel: 'The agent is at it…' })));
    return [
      d.course ? h('div', { class: 'meta' }, `${d.course.title} · ${d.course.aus?.length ?? '?'} activities, taken in order · published by the bridge`) : null,
      h('div', { class: 'grid' }, card('you', 'Your activity', 'Launched for you, run in your browser', d.you), card('agent', 'The agent’s activity', 'Launched with its wallet, run by its own process', d.agent)),
      problem(d),
    ];
  },

  lti() {
    const d = chapterData('lti');
    const openYou = async () => {
      const w = window.open('about:blank', 'interego-lti', 'width=760,height=860');
      const r = await run('lti-launch', { who: 'you' });
      const url = r.state?.chapters?.lti?.data?.you?.initiationUrl;
      if (r.ok !== false && url) { if (w && !w.closed) w.location.href = url; else window.open(url, '_blank', 'noopener'); } else w?.close();
    };
    const y = d.you;
    const a = d.agent;
    const youCard = h('div', { class: 'card' }, h('h3', {}, 'Your launch'), h('div', { class: 'meta' }, 'The agent’s course, launched from your LMS'),
      y ? h('dl', { class: 'kv' },
        h('dt', {}, 'course'), h('dd', { class: 'prose' }, y.course?.title ?? ''),
        h('dt', {}, 'gradebook column'), h('dd', { class: 'prose' }, y.lineItem?.label ?? ''),
        h('dt', {}, 'LMS'), h('dd', {}, link(y.platform?.configuration, y.platform?.issuer)),
        h('dt', {}, 'you, to the LMS'), h('dd', {}, short(y.learner ?? '', 16))) : null,
      y ? h('div', { class: 'muted', style: { marginTop: '8px' } }, 'The launch runs in the window: the Tool’s login, the LMS’s authorization, the id_token, then the course. When you finish, read the gradebook.') : null,
      h('div', { class: 'actions' }, spinnerButton(y ? 'Launch it again' : 'Open it from your LMS', openYou, { key: 'lti-you', primary: !y, runningLabel: 'Launching…' })));
    const agentCard = h('div', { class: 'card' }, h('h3', {}, 'The agent’s launch'), h('div', { class: 'meta' }, 'Your course, launched from its LMS'),
      a?.hops?.length ? h('ol', { class: 'hops' }, a.hops.map((x) => h('li', {}, h('strong', {}, x.step), ' ', h('code', {}, String(x.status)), h('div', { class: 'muted' }, x.detail)))) : null,
      a?.claims ? raw('The id_token the LMS signed, as claims', a.claims) : null,
      a?.sections?.length ? h('div', { class: 'sections' }, a.sections.map((s) => h('div', { class: 'sco-result' },
        h('strong', {}, `${s.id} · ${s.title}`),
        s.questions?.length
          ? s.questions.map((q, i) => {
            const g = s.graded?.detail?.[i];
            return h('div', { class: 'qa-result' }, h('span', { class: 'muted' }, q), ' → ', h('code', {}, s.answers?.[i] ?? '…'),
              g ? h('span', { class: `mark ${g.correct ? 'ok' : 'err'}` }, g.correct ? ' correct' : ' wrong') : null);
          })
          : h('div', { class: 'muted' }, 'No questions here; it read on.')))) : null,
      a?.result ? h('div', { class: `note ${a.result.passed ? 'ok' : 'warn'}` }, h('strong', {}, a.result.passed ? 'Passed. ' : 'Not passed. '),
        `Score ${a.result.score}, graded by the SCORM engine. `, a.result.gradebook?.posted ? `The Tool posted ${a.result.gradebook.scoreGiven} of ${a.result.gradebook.scoreMaximum} to the LMS gradebook.` : `The grade did not reach the LMS: ${a.result.gradebook?.why ?? 'unknown'}.`) : null,
      h('div', { class: 'actions' }, spinnerButton(a ? 'Send it through again' : 'Send the agent through the LMS', () => run('lti-launch', { who: 'agent' }), { key: 'lti-agent', primary: !a, runningLabel: 'The agent is in class…' })));
    const out = [h('div', { class: 'grid' }, youCard, agentCard)];
    const gb = d.gradebook;
    if (gb) {
      const columns = new Map();
      for (const who of ['you', 'agent']) for (const row of gb[who]?.rows ?? []) columns.set(row.lineItem?.id, row.lineItem?.label ?? row.courseId);
      const cell = (who, id) => {
        const row = (gb[who]?.rows ?? []).find((r) => r.lineItem?.id === id);
        return row?.result ? `${row.result.resultScore ?? '—'} / ${row.result.resultMaximum}` : '—';
      };
      out.push(h('table', { class: 'gradebook' },
        h('thead', {}, h('tr', {}, h('th', {}, 'The LMS gradebook'), [...columns.values()].map((label) => h('th', {}, label)))),
        h('tbody', {}, [['you', 'You'], ['agent', 'The agent']].map(([who, name]) => h('tr', {}, h('td', {}, name), gb[who]?.error ? h('td', { colspan: String(columns.size || 1) }, gb[who].error) : [...columns.keys()].map((id) => h('td', {}, cell(who, id))))))));
    }
    out.push(h('div', { class: 'actions' }, spinnerButton('Read the gradebook', () => run('lti-gradebook'), { key: 'lti-gradebook', primary: false, runningLabel: 'Reading…' }),
      h('span', { class: 'muted' }, 'Each of you reads your own row, signed; the LMS shows nobody else’s.')));
    out.push(problem(d));
    return out;
  },

  after() {
    const d = chapterData('after');
    const out = [h('div', { class: 'actions' }, spinnerButton(d.you ? 'Read them again' : 'Read both records again', () => run('records-after'), { primary: !d.you, runningLabel: 'Reading two pods…' }))];
    const change = (label, key, before, now) => {
      const b = before?.[key];
      const n = now?.[key];
      if (n === undefined) return null;
      const diff = typeof b === 'number' && typeof n === 'number' ? n - b : undefined;
      return h('div', {}, `${label}: `, b === undefined ? String(n) : `${b} → ${n}`, diff ? h('span', { class: 'mark ok' }, ` (+${diff})`) : null);
    };
    const changes = (title, before, now) => h('div', { class: 'card delta' }, h('h3', {}, title),
      before ? null : h('div', { class: 'muted' }, 'Chapter 11 was not read, so there is nothing to compare with.'),
      change('experiences', 'experienceCount', before, now), change('at work', 'performanceCount', before, now),
      change('competencies', 'competencyCount', before, now), change('credentials verified', 'verifiedCredentialCount', before, now));
    if (d.you || d.agent) {
      out.push(h('div', { class: 'grid' }, changes('Your record, since chapter 11', d.before?.you, d.you?.summary), changes('The agent’s record, since chapter 11', d.before?.agent, d.agent?.summary)));
      out.push(h('div', { class: 'grid' }, recordColumn('Your record', 'private to you', d.you), recordColumn('The agent’s record', 'public', d.agent)));
    }
    out.push(problem(d));
    return out;
  },

};

/** An empty course for writing your own: three sections, a question in the last two. */
function blankCourse() {
  return { title: '', scos: [
    { title: '', body: '' },
    { title: '', body: '', assessment: [{ question: '', answer: '' }] },
    { title: '', body: '', assessment: [{ question: '', answer: '' }] },
  ] };
}

/** The course you are writing, as a form bound to it: every keystroke edits the object you publish. */
function courseForm(c) {
  const field = (label, value, set, area) => h('label', { class: 'field' }, h('span', { class: 'muted' }, label),
    area ? h('textarea', { class: 'input', rows: 4, oninput: (e) => set(e.target.value) }, value ?? '')
      : h('input', { class: 'input', value: value ?? '', oninput: (e) => set(e.target.value) }));
  return h('div', { class: 'course-form' },
    field('Course title', c.title, (v) => { c.title = v; }),
    c.scos.map((s, i) => h('div', { class: 'sco-form' },
      h('div', { class: 'muted', style: { fontSize: '11px' } }, `SECTION ${i + 1}`),
      field('Title', s.title, (v) => { s.title = v; }),
      field('Text', s.body, (v) => { s.body = v; }, true),
      (s.assessment ?? []).map((q) => h('div', { class: 'qa' },
        field('Question', q.question, (v) => { q.question = v; }),
        field('One-word answer', q.answer, (v) => { q.answer = v; }))))));
}

/** A Claude agent's steps, as they streamed. */
function transcriptView(items, actor) {
  return h('div', { class: 'transcript' }, items.map((t) => h('div', { class: 'turn' }, avatar(actor, true),
    h('div', { class: 'body' }, h('div', { class: 'kind' }, t.section ? `${t.kind} · ${t.section}` : t.kind), t.text ? h('div', {}, t.text) : null))));
}

const stat = (n, label) => h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n ?? 0)), h('div', { class: 'muted' }, label));

/** One IEEE P2997 record, as the page shows it: counts, competencies with how they were earned, credentials. */
function recordColumn(title, sub, r) {
  if (!r) return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'muted' }, 'reading…'));
  if (r.error) return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'note warn' }, r.error));
  const s = r.summary ?? {};
  return h('div', { class: 'card record' },
    h('h3', {}, title), h('div', { class: 'meta' }, `${sub} · classified ${r.subjectKind || '?'}`),
    h('div', { class: 'id' }, short(r.learner, 26)),
    h('div', { class: 'stats' },
      stat(s.experienceCount, 'experiences'), stat(s.performanceCount, 'at work'), stat(s.competencyCount, 'competencies'),
      stat(`${s.verifiedCredentialCount ?? 0}/${s.credentialCount ?? 0}`, 'credentials verified')),
    r.competencies?.length ? h('div', { class: 'comps' }, h('div', { class: 'muted' }, 'Competencies'),
      r.competencies.map((c) => h('div', { class: 'comp' }, h('span', {}, c.label.replace(/^(Inferred|Performance|Credential)[^:]*:\s*/, '')),
        h('span', { class: `pill ${c.basis ?? ''}` }, [c.basis, c.level].filter(Boolean).join(' · '))))) : null,
    r.credentials?.length ? h('div', { class: 'creds' }, h('div', { class: 'muted' }, 'Credentials'),
      r.credentials.map((c) => h('div', { class: 'cred' }, h('span', { class: c.verified ? 'mark ok' : 'mark err' }, c.verified ? '✓ ' : '✕ '), link(c.id, c.name)))) : null);
}

function renderChapters() {
  $('chapters').replaceChildren(...CHAPTERS.flatMap((c) => {
    const status = chapterStatus(c.id);
    const part = c.part ? h('div', { class: 'part' }, h('h2', {}, c.part.title), h('p', {}, c.part.lede)) : null;
    return [part, h('section', { class: `chapter ${status}`, id: `ch-${c.id}` },
      h('div', { class: 'chapter-head' },
        h('div', { class: 'num' }, status === 'done' ? '✓' : String(c.n)),
        h('div', {},
          h('h2', {}, c.title),
          h('p', { class: 'lede' }, c.lede),
          h('div', { class: 'tags' }, c.actors.map((a) => h('span', { class: 'tag' }, h('span', { class: 'sw', style: { '--c': COLORS[a] } }), state.cast.find((x) => x.id === a)?.name ?? a))))),
      status === 'locked' ? null : h('div', { class: 'chapter-body' }, BODIES[c.id]()))].filter(Boolean);
  }));
}

function render() {
  renderServices();
  renderCast();
  renderFacts();
  // Keep focus, caret and scroll in a text field across re-renders: the course form is typed into
  // while the page keeps updating.
  const FIELDS = 'input, textarea';
  const active = document.activeElement;
  const focusKey = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? [...document.querySelectorAll(FIELDS)].indexOf(active) : -1;
  const caret = focusKey >= 0 ? active.selectionStart : null;
  const scrollTop = focusKey >= 0 ? active.scrollTop : 0;
  renderChapters();
  if (focusKey >= 0) {
    const again = document.querySelectorAll(FIELDS)[focusKey];
    if (again) { again.focus(); if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret); again.scrollTop = scrollTop; }
  }
}

// ── Live updates ──────────────────────────────────────────────────────────────

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('state', (e) => setState(JSON.parse(e.data)));
  es.addEventListener('ledger', (e) => addLedger(JSON.parse(e.data)));
  es.addEventListener('toast', (e) => toast(JSON.parse(e.data).text));
  es.onopen = () => { $('ledger-dot').className = 'dot ok'; };
  es.onerror = () => { $('ledger-dot').className = 'dot err'; };
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}
try { applyTheme(localStorage.getItem('interego-live.theme')); } catch { /* storage unavailable */ }
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('interego-live.theme', next); } catch { /* storage unavailable */ }
});

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  const s = await api('/api/state');
  if (s.state) setState(s.state);
  for (const e of s.ledger ?? []) addLedger(e);
  connect();
})();
