#!/usr/bin/env tsx
/**
 * A pod selector must never be silently dropped, and an answer about a pod must name the
 * pod it is about.
 *
 * ★ WHY EVERY CASE BELOW CALLS THE RESOLVER RATHER THAN GREPPING FOR ITS ERROR TEXT.
 * The last round of this file's siblings had a mutant survive because the assertion only
 * checked that an error string EXISTED — which dead code satisfies. Each refusal here is
 * bound to its own membership test: the case that must refuse asserts the specific
 * `error` code AND a neighbouring case that must NOT refuse asserts a resolved subject,
 * so deleting the guard fails the first and widening it fails the second.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/pod-selector.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolvePodSubject, podNameOf, POD_URL_INJECTED, POD_NAME_INJECTED,
} from '../pod-selector.js';

const CSS = 'http://css.railway.internal:3456/';
const MINE = 'u-eth-9bf50894ff23';
const THEIRS = 'u-eth-8f3b8e939600';
const mineUrl = `${CSS}${MINE}/`;
const theirsUrl = `${CSS}${THEIRS}/`;

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** The args a `/mcp` call arrives with: the dispatcher has filled both, and said so. */
const injected = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  pod_url: mineUrl, [POD_URL_INJECTED]: true,
  pod_name: MINE, [POD_NAME_INJECTED]: true,
  ...extra,
});

console.log('\npod selector — honoured, never silently dropped, always named');

// ── 1. THE ORIGINAL DEFECT ───────────────────────────────────────────────────
// Measured live at f1ea9c2: this exact call answered `verified: true` about the
// CALLER's pod. The selector must now select.
{
  const r = resolvePodSubject(injected({ pod_name: THEIRS, [POD_NAME_INJECTED]: false }), { cssUrl: CSS, tool: 'verify_agent' });
  ok('a caller-supplied pod_name beats the relay-injected pod_url',
    r.subject?.podUrl === theirsUrl && r.subject?.source === 'pod_name',
    `got ${JSON.stringify(r)}`);
}
// ★ The membership half: with NOTHING caller-supplied the injected pair still resolves,
// so a guard that refused everything (or ignored the marker entirely) fails here.
{
  const r = resolvePodSubject(injected(), { cssUrl: CSS, tool: 'verify_agent' });
  ok('an untouched /mcp call still resolves to the session\'s own pod',
    r.subject?.podUrl === mineUrl && r.subject?.source === 'session',
    `got ${JSON.stringify(r)}`);
}
// ★ And the marker is what does it. Same args, marker absent ⇒ the pod_url is the
// caller's word, so the pair now disagrees and must refuse. This is the case that dies
// if someone deletes the `[POD_URL_INJECTED]` write at the dispatcher.
{
  const r = resolvePodSubject({ pod_url: mineUrl, pod_name: THEIRS }, { cssUrl: CSS, tool: 'verify_agent' });
  ok('without the injected marker the same pair is a conflict',
    r.refusal?.error === 'pod_selector_conflict', `got ${JSON.stringify(r)}`);
}

// ── 2. DISAGREEMENT REFUSES; IT DOES NOT PICK A WINNER ───────────────────────
{
  const r = resolvePodSubject({ pod_name: THEIRS, pod_url: mineUrl }, { cssUrl: CSS, tool: 'verify_agent' });
  ok('caller-supplied pod_name + pod_url naming different pods is refused',
    r.refusal?.error === 'pod_selector_conflict' && r.subject === undefined);
  ok('the refusal names BOTH pods so the caller can see which two',
    r.refusal !== undefined && r.refusal.message.includes(THEIRS) && r.refusal.message.includes(MINE));
  ok('the refusal is not retryable', r.refusal?.retryable === false && r.refusal?.code === 400);
}
// ★ Membership: AGREEING spellings must NOT refuse — a guard that refuses whenever both
// fields are present would pass the case above for the wrong reason.
{
  const r = resolvePodSubject({ pod_name: THEIRS, pod_url: theirsUrl }, { cssUrl: CSS, tool: 'verify_agent' });
  ok('the same pod spelled both ways resolves rather than refusing',
    r.subject?.podUrl === theirsUrl, `got ${JSON.stringify(r)}`);
}
// ★ Same path on a foreign ORIGIN is a DISAGREEMENT, not an agreement. server.ts's
// canonicalPodKey collapses only this store's two host spellings (right for de-dup); this
// comparator keeps even those apart, because a caller who names a pod twice should be
// answered about the string they typed.
{
  const r = resolvePodSubject(
    { pod_name: THEIRS, pod_url: `https://elsewhere.example/${THEIRS}/` },
    { cssUrl: CSS, tool: 'verify_agent' });
  ok('a matching path on a different host is a conflict, not an agreement',
    r.refusal?.error === 'pod_selector_conflict', `got ${JSON.stringify(r)}`);
}

// ── 3. NO PLACEHOLDER SUBJECT ────────────────────────────────────────────────
// `get_current_head` read `${CSS_URL}default/` — a pod belonging to nobody — and
// reported "No descriptor on this pod describes the requested urn" about it. Measured
// live on /messages at f1ea9c2.
{
  const r = resolvePodSubject({}, { cssUrl: CSS, tool: 'get_current_head' });
  ok('no selector and no session refuses instead of answering about <CSS>default/',
    r.refusal?.error === 'pod_subject_unresolved', `got ${JSON.stringify(r)}`);
  ok('the refusal explains that the old answer was about nobody\'s pod',
    r.refusal?.message.includes('default/') === true);
}

// ── 4. TARGET-ONLY TOOLS ─────────────────────────────────────────────────────
// Measured live: `remove_pod {}` on /mcp returned { removed: true } and deleted the
// caller's own federation record, because the dispatcher filled the TARGET parameter.
{
  const r = resolvePodSubject(injected(), { cssUrl: CSS, tool: 'remove_pod', targetOnly: true });
  ok('a target-only tool refuses a relay-injected pod_url',
    r.refusal?.error === 'pod_target_not_named', `got ${JSON.stringify(r)}`);
}
// ★ Membership: an EXPLICIT target still works, so the guard cannot be "always refuse".
{
  const r = resolvePodSubject(injected({ pod_url: theirsUrl, [POD_URL_INJECTED]: false }),
    { cssUrl: CSS, tool: 'remove_pod', targetOnly: true });
  ok('a target-only tool accepts an explicitly named peer',
    r.subject?.podUrl === theirsUrl && r.subject?.source === 'pod_url', `got ${JSON.stringify(r)}`);
}
// ★ And a target-only tool must NOT start honouring an injected pod_name either.
{
  const r = resolvePodSubject({ pod_name: MINE, [POD_NAME_INJECTED]: true },
    { cssUrl: CSS, tool: 'remove_pod', targetOnly: true });
  ok('a target-only tool refuses a relay-injected pod_name too',
    r.refusal?.error === 'pod_target_not_named', `got ${JSON.stringify(r)}`);
}

// ── 5. SPELLINGS AND SHAPES ──────────────────────────────────────────────────
{
  const r = resolvePodSubject({ podUrl: theirsUrl, [POD_URL_INJECTED]: true, pod_url: mineUrl },
    { cssUrl: CSS, tool: 'verify_agent' });
  ok('the camelCase podUrl alias is caller-supplied even when pod_url was injected',
    r.subject?.podUrl === theirsUrl, `got ${JSON.stringify(r)}`);
}
{
  const r = resolvePodSubject({ pod_url: `${CSS}${THEIRS}` }, { cssUrl: CSS, tool: 'verify_agent' });
  ok('a pod_url without a trailing slash is normalised', r.subject?.podUrl === theirsUrl);
}
{
  const r = resolvePodSubject({ pod_name: '' }, { cssUrl: CSS, tool: 'verify_agent' });
  ok('an empty pod_name is not a selector', r.refusal?.error === 'pod_subject_unresolved');
}
{
  const r = resolvePodSubject({ pod_name: 42 as unknown as string, pod_url: theirsUrl },
    { cssUrl: CSS, tool: 'verify_agent' });
  ok('a non-string pod_name is not a selector and does not manufacture a conflict',
    r.subject?.podUrl === theirsUrl, `got ${JSON.stringify(r)}`);
}
ok('podNameOf recovers the pod_name spelling of a pod url', podNameOf(theirsUrl) === THEIRS);
ok('podNameOf returns null for an origin with no pod segment', podNameOf('https://example.com/') === null);

// ── 6. THE WIRING, IN server.ts ──────────────────────────────────────────────
// The rules above are only real if the dispatchers set the markers and the handlers ask.
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');

ok('the injected markers are RESERVED wire fields, so a caller cannot forge one',
  /const RESERVED_WIRE_FIELDS = \[[\s\S]*?POD_URL_INJECTED[\s\S]*?POD_NAME_INJECTED[\s\S]*?\] as const/.test(SERVER),
  'without this, a caller could set _pod_url_injected and defeat the conflict refusal');

// Every site that writes a selector must also write its marker. Counting them binds the
// two together: adding an injection without its marker re-opens the original defect.
const urlWrites = SERVER.match(/args\.pod_url = |req\.body\.pod_url = /g) ?? [];
const urlMarks = SERVER.match(/\[POD_URL_INJECTED\] = true/g) ?? [];
ok('every pod_url injection site also sets POD_URL_INJECTED',
  urlWrites.length > 0 && urlMarks.length >= urlWrites.length,
  `${urlWrites.length} injection(s), ${urlMarks.length} marker(s)`);

const nameWrites = SERVER.match(/(?:args|req\.body)\.pod_name = (?!undefined)/g) ?? [];
const nameMarks = SERVER.match(/\[POD_NAME_INJECTED\] = true/g) ?? [];
ok('every pod_name injection site also sets POD_NAME_INJECTED',
  nameWrites.length > 0 && nameMarks.length >= nameWrites.length,
  `${nameWrites.length} injection(s), ${nameMarks.length} marker(s)`);

// Comments in these handlers QUOTE the old expression while explaining why it was wrong,
// so the check has to look at code. Strip line comments first.
const codeOf = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '');
for (const tool of ['handleVerifyAgent', 'handleGetCurrentHead', 'handleGetPodStatus', 'handleDiscoverContext']) {
  const body = SERVER.match(new RegExp(`async function ${tool}\\(args: ToolArgs\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  ok(`${tool} resolves its subject through the shared resolver`,
    body.length > 0 && /resolvePodSubject\(/.test(body));
  ok(`${tool} no longer reads args.pod_url directly`,
    body.length > 0 && !/args\.pod_url|args\.podUrl/.test(codeOf(body)),
    'reading it directly is how the selector got dropped in the first place');
}

// ★ The write tools' ownership gate must be UNTOUCHED. Honouring pod_name on the read
// tools is safe only because it discloses nothing new; letting it steer a WRITE would be
// a different decision entirely, and `requireOwnPod` is what stops that.
for (const tool of ['handleRegisterAgent', 'handleRevokeAgent', 'handlePublishDirectory']) {
  const body = SERVER.match(new RegExp(`async function ${tool}\\(args: ToolArgs\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  ok(`${tool} still gates its pod_name target with requireOwnPod`,
    body.length > 0 && /requireOwnPod\(args, podUrl/.test(body));
}

// ★ The answer names its subject. This is the property whose ABSENCE made the original
// defect invisible rather than merely wrong.
// ★ THIS ASSERTION SURVIVED ITS OWN MUTANT ONCE. It read `/subject_pod_url/.test(body)`,
// and the handler's explanatory COMMENT contains that string — so dropping the subject
// argument from the `buildVerifyAgentEnvelope(result, podUrl)` call still passed. An
// assertion that only checks a name APPEARS is satisfied by prose. It now checks the call
// site, in code with comments stripped, and the builder's actual output is asserted
// behaviourally in tests/verify-agent-envelope.test.ts at the repo root.
const verify = codeOf(SERVER.match(/async function handleVerifyAgent\(args: ToolArgs\)[\s\S]*?\n\}/)?.[0] ?? '');
// ★ AND IT PINS THE ARGUMENT, NOT THE ARGUMENT'S EXACT TEXT. This read
// `/buildVerifyAgentEnvelope\(result, podUrl\)/` and went red when the subject started being
// spelled publicly — `buildVerifyAgentEnvelope(result, asPublicPodUrl(podUrl))` — over a change
// that strengthens the very property it guards. A gate that fails on a legitimate refinement of
// what it is protecting teaches people to loosen it; the pattern below still fails if the second
// argument is DROPPED, which is the mutant that matters.
ok('verify_agent passes the resolved subject INTO the envelope builder',
  /buildVerifyAgentEnvelope\(\s*result\s*,[^)]*podUrl/.test(verify),
  'a verdict a caller cannot attribute to a pod is not checkable');
// ★ …AND NAMES IT AT AN ADDRESS THE READER CAN DEREFERENCE. verify_agent is the tool an OUTSIDE
// PEER calls to check whether an agent is who it says it is, and it was answering with
// `http://css.railway.internal:3456/…`, which resolves nowhere outside this cluster. Measured by a
// delegate after the same fix had landed on `sign_request` and not here.
ok('verify_agent names the subject pod in the PUBLIC spelling',
  /buildVerifyAgentEnvelope\(\s*result\s*,\s*asPublicPodUrl\(/.test(verify),
  'a verdict that names its subject at an unresolvable address has not really named it');
ok('verify_agent also reports which selector chose that subject',
  /subject_pod_name: subject\.podName/.test(verify) && /subject_pod_selected_by: subject\.source/.test(verify));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
