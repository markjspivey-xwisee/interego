#!/usr/bin/env tsx
/**
 * THE NOTIFICATION THAT SAID IT CARRIED THE DETAIL AND CARRIED NOTHING.
 *
 * ── ★★ THE DEFECT ────────────────────────────────────────────────────────────
 *
 * An external agent sent this maintainer findings summarised `P7 and P8 re-sent with FULL
 * DETAIL`. What arrived carried `as:summary` twice and NO `as:content`, and `notify_agent`
 * answered `delivered: true`. It was schema-valid: the tool declares `content` optional and
 * requires only `to` and `summary`, so a bodyless message is a PERMITTED INPUT rather than a
 * lost one. `buildNotification` also spreads `content` on truthiness, so `content: ""` produces
 * a document byte-identical to one that never had a body.
 *
 * The rule that closes it is `iep:NotificationBodyShape` in `docs/ns/iep.ttl` — DATA, read by
 * the relay at runtime — because this project's own principle audit named the pattern it would
 * otherwise repeat: "reliably publishes its VOCABULARY and reliably keeps its RULES in
 * TypeScript, then writes a note describing the rule".
 *
 * ── ★★ AND A FIRST ATTEMPT AT THIS WAS BUILT, DRIVEN AND REFUTED ─────────────
 *
 * Four of its defects have their own section below, each one MEASURED HERE BOTH WAYS — the
 * refuted spelling is reconstructed in the test and shown to be wrong on the same input the
 * shipped one gets right. A section that only showed the new behaviour would be a check that
 * passes two ways, which is evidence for neither:
 *
 *   §3  it asked "is this violation mine?" with `sourceShape === NOTIFICATION_BODY_SHAPE`, and
 *       that is blind to every constraint hung off an ordinary `sh:property`
 *   §4  it ran a synchronous SHACL parse over the whole 208,787-character ontology plus an
 *       unbounded body
 *   §5  it accepted `about: 'no'` where an IRI is required
 *   §6  it targeted `as:Note`, which on `type: 'Note'` selects the ACTIVITY as well and refused
 *       a completely correct message
 *
 * ── ★★ AND SO WAS THE SECOND ATTEMPT — THIS FILE'S OWN FIRST VERSION ─────────────
 *
 * Four more defects were reproduced against the gate this suite was written for, and each has a
 * section, each measured BOTH WAYS on the same input:
 *
 *   §11 the published antecedent was LOGICALLY WRONG. `sh:not [ sh:property [ sh:path as:summary ;
 *       sh:minCount 1 ; sh:pattern P ] ]` conforms when there is no summary OR when SOME summary
 *       fails P — so one extra value, the empty string included, delivered the claiming message
 *   §12 `MAX_GATED_BODY_CHARS` was an escape hatch for the exact defect the gate exists to catch:
 *       an EMPTY body plus 66,000 characters in `in_reply_to` answered `enforced: false`
 *   §13 the non-blank pattern was an ASCII character class, so U+00A0, U+3000, U+2028, U+000B and
 *       U+FEFF each passed as a body
 *   §14 a surviving mutant: deleting `rdf:first` and `rdf:rest` from SHAPE_VALUED_PREDICATES
 *       changed nothing, because Turtle's `( … )` sugar makes the list out of blank nodes
 *
 * ── ★★ AND A THIRD ROUND — IN WHICH THIS FILE ITSELF CERTIFIED A LIVE BYPASS AS CLOSED ────
 *
 * §12's fix for the size hatch dropped the ACTIVITY-level fields, and §12's own fixture padded
 * `inReplyTo` on the ACTIVITY — a position `agent-mesh.ts:buildNotification` has no path to. It
 * puts `inReplyTo`, `content` and `iep:about` on the BODY. So the fixture's pad was dropped by
 * the fix and the section went green while FIVE fields of the real writer's output still walked
 * through the bound, measured afterwards over the wire against a booted relay. The helper this
 * file builds every fixture with called itself "NOT A HAND-WRITTEN GRAPH" and was one.
 *
 * That is closed structurally rather than by care: `notif` now CALLS `buildNotification`, so no
 * fixture in this file can be a document the relay's own writer cannot emit, and the handful of
 * probes that deliberately are not go through `notifWith` and say which writer could once emit
 * them. §12 is rewritten around the five fields as the writer actually places them.
 *
 * ── WHY A UNIT SUITE ─────────────────────────────────────────────────────────
 *
 * `server.ts` opens a listener on import, so a refuse/report decision written there cannot be
 * executed by a test — the same reason `shape-body.ts` and `shapes-declared.ts` exist. And a
 * live run exercises the honest path only: production callers send well-formed notifications,
 * so production cannot tell a relay that refuses the bad one from a relay that does not. §9 is
 * the exception that has to be read off the source, and it anchors on function bodies rather
 * than on character distances — see tests/a-proxy-that-is-right-until-something-grows.test.ts
 * for the two production deploys the fixed-window spelling cost.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/notification-body-shape.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAgainstShape } from '@interego/core';

import { buildNotification, type NotificationInput } from '../agent-mesh.js';

import {
  isolateShapeClosure,
  prepareNotificationGate,
  projectNotification,
  notificationBodyReport,
  notificationBodyRefusal,
  notificationTextSize,
  reduceToConstrainedBody,
  shapeReach,
  MAX_GATED_BODY_CHARS,
  MAX_GATED_VALUE_CHARS,
  NOTIFICATION_BODY_CLASS,
  NOTIFICATION_BODY_SHAPE,
  NOTIFICATION_SHAPE_CANDIDATES,
  NOTIFICATION_SHAPE_DOCUMENT,
  type BodyVerdict,
} from '../notification-body.js';

let pass = 0;
let fail = 0;

/** The one place this file writes to stdout, so it carries one lint directive rather than
 *  fourteen identical ones. */
function say(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    pass += 1;
    say(`  ok  ${name}`);
  } else {
    fail += 1;
    say(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoFile = (...segs: string[]): string => readFileSync(join(here, '..', '..', '..', ...segs), 'utf8');

/** The real published ontology, not a fixture — the same bytes the running relay reads. */
const IEP_TTL = repoFile('docs', 'ns', 'iep.ttl');

const SENDER = 'did:ethr:0xsender';
const RECIPIENT = 'did:ethr:0xrecipient';
const PUBLISHED = '2026-08-27T00:00:00.000Z';
const ID_SLUG = '1756000000000-abc123';

type NotifArgs = Partial<NotificationInput> & { readonly summary: string };

/**
 * A notification exactly as `agent-mesh.ts:buildNotification` writes one — because it IS one.
 *
 * ★★ IT CALLS THE WRITER. IT DOES NOT IMITATE IT, AND THE VERSION IT REPLACES DID — WHICH IS
 * HOW §12 CAME TO CERTIFY A BYPASS AS CLOSED. That helper spread its first argument into the
 * ACTIVITY and its second into the object, and its comment claimed to be "NOT A HAND-WRITTEN
 * GRAPH" while being exactly one. §12's headline fixture then padded `inReplyTo` on the
 * ACTIVITY — a position `buildNotification` has no path to: it puts `inReplyTo`, `content` and
 * `iep:about` on the BODY. The gate dropped the activity fields, the fixture's pad went with
 * them, the section went green, and the real writer's shape walked straight through. Measured
 * afterwards over the wire against a booted relay: 66,000 characters in `in_reply_to` came back
 * `bodyShape.enforced: false`. A fixture shaped to the shape proves only that the shape matches
 * the fixture.
 *
 * Where a section needs a graph no writer in this tree can emit — a second `as:summary` value, a
 * body nested inside a body — it says so and uses {@link notifWith}, which starts from real
 * writer output and applies ONE named mutation.
 */
function notif(input: NotifArgs): Record<string, unknown> {
  return buildNotification({ from: SENDER, to: RECIPIENT, published: PUBLISHED, ...input }, ID_SLUG);
}

/**
 * Real writer output, plus one deliberate mutation of the BODY.
 *
 * ★ EVERY USE NAMES WHY IT IS NEEDED — either a writer that COULD once emit it (and the guard
 * that stopped it), or that the probe is about `projectNotification` rather than about a message
 * anybody sends. A fixture with no such note is a fixture nobody can defend.
 */
function notifWith(
  input: NotifArgs,
  mutate: (body: Record<string, unknown>) => void,
): Record<string, unknown> {
  const n = notif(input);
  mutate(n['object'] as Record<string, unknown>);
  return n;
}

const CLAIMS_DETAIL = 'P7 and P8 re-sent with FULL DETAIL';

const gate = prepareNotificationGate(IEP_TTL, validateAgainstShape);
const verdictOf = (n: Record<string, unknown>): BodyVerdict['verdict'] => gate.check(n).verdict;

// ─────────────────────────────────────────────────────────────────────────────
// §1  The published document is what enforces, and it is not enforcing vacuously
// ─────────────────────────────────────────────────────────────────────────────
function section1(): void {
  say('\n§1  the rule is the published document');

  ok(IEP_TTL.includes('iep:NotificationBodyShape a sh:NodeShape'),
    '§1 docs/ns/iep.ttl declares the shape the relay names, so the IRI it refuses with dereferences');
  ok(IEP_TTL.includes('iep:NotificationBody a owl:Class'),
    '§1 …and the class the projection asserts, so sh:targetClass has something declared to target');

  const iso = isolateShapeClosure(IEP_TTL, NOTIFICATION_BODY_SHAPE);
  ok(!('error' in iso), '§1 the shape and its closure can be cut out of the published ontology',
    'error' in iso ? iso.error : '');
  if ('error' in iso) return;

  ok(iso.triples > 10, '§1 the closure is not empty — a slice that produced nothing would make '
    + 'every message conform and look exactly like a clean pass', `${iso.triples} triples`);
  ok(iso.turtle.length < IEP_TTL.length / 10,
    '§1 …and it is a slice, not a copy: the isolated graph is under a tenth of the ontology',
    `${iso.turtle.length} of ${IEP_TTL.length} bytes`);
  // Non-vacuity of the SLICE itself: it has to still carry the three alternatives, or the rule
  // it enforces is not the rule that was published.
  for (const needle of ['#targetClass', '#or', '#pattern', '#nodeKind', '#minCount', '#not']) {
    ok(iso.turtle.includes(needle), `§1 the isolated graph still carries sh:${needle.slice(1)}`);
  }

  ok(gate.enforcing, '§1 and the gate reports itself ENFORCING against the real document', gate.why ?? '');

  /**
   * ★★ EVERY SIZE CLAIM MADE ABOUT THIS DOCUMENT IN PRODUCTION SOURCE HAS TO BE TRUE OF IT.
   *
   * Four sites said "205 K characters"; the file was 208,416 when that was re-counted, and it
   * moved again the moment a sentence in it was edited. A number in a comment that nothing
   * checks is a number that goes stale the next time anybody touches the file it describes —
   * and a reader has no way to tell a stale one from a measured one. So the claims are
   * COLLECTED out of the source and compared with the document itself: edit the ontology, and
   * this goes red naming the sites to update, rather than the numbers quietly becoming fiction.
   */
  const CLAIM_SITES: readonly (readonly [string, readonly string[]])[] = [
    ['deploy/mcp-relay/notification-body.ts', ['deploy', 'mcp-relay', 'notification-body.ts']],
    ['deploy/mcp-relay/server.ts', ['deploy', 'mcp-relay', 'server.ts']],
    ['this suite', ['deploy', 'mcp-relay', 'tests', 'notification-body-shape.test.ts']],
  ];
  const CLAIM = /([\d][\d,]{4,})[- ]character(?=-character|s? ontology|s of Turtle)/g;
  let claims = 0;
  for (const [who, file] of CLAIM_SITES) {
    const src = repoFile(...file);
    for (const m of src.matchAll(CLAIM)) {
      claims += 1;
      ok(Number(m[1]!.replace(/,/g, '')) === IEP_TTL.length,
        `§1 ★ ${who} says the ontology is ${m[1]} characters, and it is`,
        `${m[1]} claimed vs ${IEP_TTL.length.toLocaleString('en-US')} actual`);
    }
  }
  ok(claims >= 4, '§1 non-vacuous: the collector found every site that makes the claim',
    `${claims} found, 4 expected at least`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §2  The measured defect is refused; every real caller in this repo is not
// ─────────────────────────────────────────────────────────────────────────────
function section2(): void {
  say('\n§2  the defect is refused and nothing legitimate is');

  const bodyless = notif({ summary: CLAIMS_DETAIL });
  ok(verdictOf(bodyless) === 'violates',
    '§2 the measured message — a summary claiming the detail travels with it, and no detail — is REFUSED');

  const v = gate.check(bodyless);
  if (v.verdict === 'violates') {
    ok(v.violation.shape === NOTIFICATION_BODY_SHAPE && v.violation.declaredBy === NOTIFICATION_SHAPE_DOCUMENT,
      '§2 …and the refusal names a dereferenceable shape and the document that declares it');
    ok(IEP_TTL.includes(v.violation.message),
      '§2 …with the PUBLISHED sh:message verbatim, not a second copy of the sentence kept in TypeScript');
    const refusal = notificationBodyRefusal(v.violation, 'did:ethr:0xrecipient');
    ok(refusal['delivered'] === false, '§2 …and the refusal a sender reads leads with delivered: false');
    ok(!JSON.stringify(refusal).includes('inbox'),
      '§2 …and discloses no inbox path: a refusal is not the place to say where the mail would have gone');
  }

  ok(verdictOf(notif({ summary: CLAIMS_DETAIL, content: '   ' })) === 'violates',
    '§2 a body of nothing but whitespace is the empty-string case one character along, and is refused too');

  /**
   * ★★ EVERY `notify_agent` CALLER IN THIS TREE, WITH ITS REAL SUMMARY, AND EACH ONE MUST PASS.
   *
   * Adding a refusal is how an outage happens, so the callers are censused rather than assumed —
   * `git grep notify_agent` over the whole tree, not just one directory. The `sourceFile`/`marker`
   * pair is what stops this table drifting into fiction: the assertion fails if the string is no
   * longer in the file it was taken from, so a caller that CHANGED its summary cannot keep
   * passing here on the strength of the old one.
   */
  const CALLERS: readonly {
    readonly who: string;
    readonly notif: Record<string, unknown>;
    readonly sourceFile: readonly string[];
    readonly marker: string;
  }[] = [
    {
      who: 'packages/workspace-client/src/membership.ts — the workspace invitation Offer (summary + content)',
      notif: notif({
        type: 'Offer', summary: 'Invitation to Q3 planning', about: 'https://pod.example/grant/1',
        content: 'A membership grant naming you has been published at https://pod.example/grant/1.',
      }),
      sourceFile: ['packages', 'workspace-client', 'src', 'membership.ts'],
      marker: "summary: 'Invitation to '",
    },
    {
      who: 'packages/workspace-client/src/ask.ts — the workspace ask Question (summary + about, no body BY DESIGN)',
      notif: notif({ type: 'Question', summary: 'a question was raised on the channel', about: 'https://pod.example/ask/1' }),
      sourceFile: ['packages', 'workspace-client', 'src', 'ask.ts'],
      marker: "type: 'Question', about: args.about, summary: args.summary",
    },
    {
      who: 'applications/shared-workspace/discord/tools/drive-agents-live.ts — the non-author notice probe',
      notif: notif({ type: 'Question', summary: 'a notice from a party that did not write the record', about: 'https://pod.example/ask/2' }),
      sourceFile: ['applications', 'shared-workspace', 'discord', 'tools', 'drive-agents-live.ts'],
      marker: 'a notice from a party that did not write the record',
    },
    {
      who: 'applications/shared-workspace/discord/tools/drive-agents-live.ts — the published-route probe',
      notif: notif({ type: 'Question', summary: 'a stranger, holding only the DID, using the published route', about: 'https://pod.example/cap/1' }),
      sourceFile: ['applications', 'shared-workspace', 'discord', 'tools', 'drive-agents-live.ts'],
      marker: 'a stranger, holding only the DID, using the published route',
    },
    {
      who: 'applications/shared-workspace/discord/src/ask.ts — the Discord bot\'s ask notice (summary + about, no body BY DESIGN)',
      notif: notif({
        type: 'Question',
        summary: 'A request addressed to Mira was published in Q3 planning',
        about: 'https://pod.example/ask/4',
      }),
      sourceFile: ['applications', 'shared-workspace', 'discord', 'src', 'ask.ts'],
      marker: "summary: 'A request addressed to '",
    },
    {
      who: 'applications/shared-workspace/artifact/channel.html — the browser client\'s invitation Offer',
      notif: notif({
        type: 'Offer', summary: 'Invitation to Q3 planning', about: 'https://pod.example/grant/2',
        content: 'A membership grant naming you has been published at https://pod.example/grant/2.',
      }),
      sourceFile: ['applications', 'shared-workspace', 'artifact', 'channel.html'],
      marker: '"Invitation to " + args.workspaceTitle',
    },
    {
      who: 'applications/shared-workspace/artifact/channel.html — the browser client\'s ask Question, the SECOND bundled copy',
      notif: notif({ type: 'Question', summary: 'a question was raised on the channel', about: 'https://pod.example/ask/3' }),
      sourceFile: ['applications', 'shared-workspace', 'artifact', 'channel.html'],
      marker: 'to: pod,\n        type: "Question",\n        about: args.about,',
    },
    {
      who: 'a summary-only as:Announce, which is the type this relay advertises for exactly that shape of message',
      notif: notif({ type: 'Announce', summary: 'the Q3 planning workspace has a new head' }),
      sourceFile: ['deploy', 'mcp-relay', 'server.ts'],
      marker: 'ActivityStreams type: Create (default), Announce, Offer, Question, Update.',
    },
    {
      who: 'deploy/mcp-relay/server.ts — the ActivityPub route\'s SYNTHESISED summary, which is the relay\'s own words',
      notif: notif({ summary: 'Create via ActivityPub' }),
      sourceFile: ['deploy', 'mcp-relay', 'server.ts'],
      marker: 'via ActivityPub',
    },
    {
      who: 'a bare reachability probe, which every agent sends and which carries a summary and nothing else',
      notif: notif({ summary: 'checking whether this inbox is reachable' }),
      sourceFile: ['deploy', 'mcp-relay', 'notification-body.ts'],
      marker: 'checking whether this inbox is reachable',
    },
  ];

  for (const c of CALLERS) {
    ok(repoFile(...c.sourceFile).includes(c.marker),
      `§2 the census entry is still real — ${c.sourceFile.join('/')} still contains its marker`,
      c.marker);
    ok(verdictOf(c.notif) === 'conforms', `§2 NOT REFUSED: ${c.who}`,
      JSON.stringify(gate.check(c.notif)).slice(0, 240));
  }

  // ★ Non-vacuity for the table above: if the shape refused nothing at all, every row would pass
  // and the section would be worthless. The bodyless case above is the counterexample, and this
  // pins that the two are being decided by the SAME gate object.
  ok(verdictOf(bodyless) !== verdictOf(CALLERS[0]!.notif),
    '§2 non-vacuous: the same gate that clears every caller above refuses the measured defect');
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  REFUTED DEFECT 1 — "which violation is mine?" answered by sourceShape
// ─────────────────────────────────────────────────────────────────────────────
function section3(): void {
  say('\n§3  a constraint hung off an sh:property is VISIBLE (the refuted version could not see one)');

  /**
   * The published shape, plus one ordinary `sh:property` — the most unremarkable edit anybody
   * could make to it: a notification body must not carry an `as:inReplyTo`.
   *
   * ★ IT HAS TO BE A CONSTRAINT EVERY LOAD-TIME CANARY STILL DECIDES, AND TWO EARLIER DRAFTS OF
   * THIS SECTION FOUND THAT OUT BY FAILING. `sh:maxLength 8` refused the canary summaries, so
   * the gate correctly switched itself OFF (§8) and the question this section asks was never
   * reached. `sh:maxLength 100` cleared them — until the canary table grew rows carrying 70,000
   * characters, at which point `sh:maxLength` became a constraint the size reduction cannot
   * preserve (it is lexically sensitive: see MAX_GATED_VALUE_CHARS) and the gate switched off
   * for the other reason. `sh:maxCount 0` on `as:inReplyTo` is decided identically for every
   * canary: the one row that carries an `inReplyTo` is already a row that must be refused, and
   * no other row carries one at all.
   *
   * ★ AND THE PROBE'S SUMMARY DELIBERATELY DOES NOT CLAIM TO CARRY DETAIL, so the node-level
   * `sh:or` is satisfied and the ONLY violation available is the property one. If the `sh:or`
   * fired as well, a result carrying the node shape's IRI would exist and the second half of
   * this section would pass for the wrong reason.
   */
  const grown = IEP_TTL.replace(
    'sh:targetClass iep:NotificationBody ;',
    'sh:targetClass iep:NotificationBody ;\n    sh:property [ sh:path as:inReplyTo ; sh:maxCount 0 ] ;',
  );
  ok(grown !== IEP_TTL, '§3 the fixture actually added the property');

  const grownGate = prepareNotificationGate(grown, validateAgainstShape);
  ok(grownGate.enforcing, '§3 the grown shape still decides every canary, so this section is '
    + 'measuring attribution and not the gate switching itself off', grownGate.why ?? '');
  const longSummary = 'a channel update, summarised and nothing more';
  const probe = notif({ summary: longSummary, inReplyTo: 'https://pod.example/notif/1' });

  // ★ THE SHIPPED GATE SEES IT. It validates against a graph holding this shape and nothing
  // else, so there is no attribution question to get wrong.
  ok(grownGate.check(probe).verdict === 'violates',
    '§3 the isolated gate REFUSES on a violation raised by the shape\'s own sh:property');

  // ★ AND THE REFUTED SPELLING DOES NOT — measured, on the same shapes graph and the same data.
  // `results.find(r => r.sourceShape === NOTIFICATION_BODY_SHAPE)` is a claim about how this
  // engine labels results, and the claim is false: a property-shape violation reports the
  // PROPERTY shape, which here is an anonymous blank node.
  const wholeDocReport = validateAgainstShape(projectNotification(probe).turtle, grown);
  const raised = wholeDocReport.results.filter(r => (r.severity ?? 'Violation') === 'Violation');
  ok(raised.length > 0, '§3 non-vacuous: validating against the WHOLE document does raise a violation',
    `${raised.length}`);
  ok(!raised.some(r => r.sourceShape === NOTIFICATION_BODY_SHAPE),
    '§3 …and NONE of them carries sourceShape === the node shape, so the refuted `find` returned '
    + 'undefined and the gate reported a clean pass',
    raised.map(r => String(r.sourceShape)).join(', '));

  // The blindness is specifically about NESTED shapes: the node-level sh:or the shape already
  // has IS labelled with the node shape, which is exactly why the refuted version looked correct
  // on the only case anyone drove it with.
  const bodyless = notif({ summary: CLAIMS_DETAIL });
  const orReport = validateAgainstShape(projectNotification(bodyless).turtle, IEP_TTL);
  ok(orReport.results.some(r => r.sourceShape === NOTIFICATION_BODY_SHAPE),
    '§3 …and the node-level sh:or IS labelled with the node shape, which is how the blind spot '
    + 'stayed invisible: the one case it was driven on happened to be the one it could see');
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  REFUTED DEFECT 2 — an unbounded synchronous SHACL parse on the event loop
// ─────────────────────────────────────────────────────────────────────────────
function section4(): void {
  say('\n§4  what is BOUNDED is what is PARSED, and being over the bound still decides');

  // ★ THE BOUND IS 64 Ki AND NOT 4 Ki BECAUSE A BODY FAR LARGER THAN ANYTHING §2's CENSUS SENDS
  // (the longest is the workspace invitation Offer: 147 fixed characters plus one grant IRI)
  // must still be checked WHOLE, with nothing dropped to get there.
  const eightK = notif({ summary: CLAIMS_DETAIL, content: 'y'.repeat(8000) });
  const eightKv = gate.check(eightK);
  ok(eightKv.verdict === 'conforms',
    '§4 an 8000-character body — far past the longest one any caller in this tree sends — is CHECKED',
    eightKv.verdict);
  ok(eightKv.verdict === 'conforms' && eightKv.blindTo === undefined,
    '§4 …with nothing dropped or shortened to reach that verdict',
    JSON.stringify(eightKv));

  /**
   * ★★ OVER THE BOUND THE GATE STILL DECIDES, AND THE GRAPH IT HANDS THE ENGINE IS SMALL. A
   * verdict shows the decision was made; only the data graph the validator was actually given
   * shows the decision was CHEAP, and being cheap is the entire reason the bound exists. The
   * assertion is made through the validator itself, not inferred from a timing.
   */
  let widest = 0;
  const spy = (dataTurtle: string, shapeTurtle: string): ReturnType<typeof validateAgainstShape> => {
    widest = Math.max(widest, dataTurtle.length);
    return validateAgainstShape(dataTurtle, shapeTurtle);
  };
  const spied = prepareNotificationGate(IEP_TTL, spy);
  ok(spied.enforcing, '§4 the instrumented gate enforces', spied.why ?? '');

  const big = notif({ summary: CLAIMS_DETAIL, content: 'x'.repeat(MAX_GATED_BODY_CHARS + 1) });
  ok(notificationTextSize(big, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS,
    '§4 non-vacuous: the weight of this notification really is over the bound');
  widest = 0;
  const bigV = spied.check(big);
  ok(bigV.verdict === 'conforms',
    '§4 ★ a real body past the bound is DELIVERED — the check RAN, it did not give up', bigV.verdict);
  ok(widest > 0 && widest < MAX_GATED_BODY_CHARS,
    '§4 ★ …having handed the SHACL engine a graph INSIDE the bound, not the 64 KB document',
    `${widest} chars`);
  ok(bigV.verdict === 'conforms' && (bigV.blindTo ?? []).some(b => b.startsWith('object.content')),
    '§4 …and the answer NAMES the value it shortened rather than quietly judging a different one',
    JSON.stringify(bigV.verdict === 'conforms' ? bigV.blindTo : bigV));

  // The counter answers before anything is materialised — the point is to decide before the
  // 4 MB body has been serialized anywhere.
  ok(notificationTextSize(notif({ summary: 'hi' }), MAX_GATED_BODY_CHARS) < 500,
    '§4 …and an ordinary notification is nowhere near the bound');
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  REFUTED DEFECT 3 — `about: 'no'` accepted where an IRI is required
// ─────────────────────────────────────────────────────────────────────────────
function section5(): void {
  say("\n§5  iep:about has to BE an IRI, not merely be present");

  const notAnIri = notif({ summary: CLAIMS_DETAIL, about: 'no' });
  ok(verdictOf(notAnIri) === 'violates',
    "§5 `about: 'no'` is REFUSED — nothing is reachable, so the detail did not travel by reference");

  const realIri = notif({ summary: CLAIMS_DETAIL, about: 'https://pod.example/finding/7' });
  ok(verdictOf(realIri) === 'conforms',
    '§5 …and an IRI that could be dereferenced satisfies the same alternative');

  // ★ THE PROJECTION IS NOT WHERE THIS IS DECIDED, AND THAT IS THE POINT. It emits a
  // non-IRI as the literal it actually is — dropping it would make the graph claim the field was
  // absent — and the PUBLISHED shape is what refuses it, via sh:nodeKind sh:IRI.
  const projected = projectNotification(notAnIri).turtle;
  ok(projected.includes('"no"'), '§5 the projection emits the non-IRI as a literal rather than dropping it');
  ok(IEP_TTL.includes('sh:path iep:about ; sh:minCount 1 ; sh:nodeKind sh:IRI'),
    '§5 …and the rule that refuses it is in the published document, not in TypeScript');
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  REFUTED DEFECT 4 — targeting as:Note refused a correct message
// ─────────────────────────────────────────────────────────────────────────────
function section6(): void {
  say('\n§6  the shape judges the BODY, positionally — never the activity');

  // `type` is an advertised notify_agent parameter, and 'Note' is one of the values
  // NotificationInput's own doc comment lists. With it the ACTIVITY is an as:Note as well.
  const typedNote = notif({ type: 'Note', summary: CLAIMS_DETAIL, content: 'P7: the write path is unauthenticated. P8: the token is never cleared.' });
  ok(verdictOf(typedNote) === 'conforms',
    '§6 a correct message carrying a real body is DELIVERED even when the caller chose type: Note');

  // ★ AND THE REFUTED TARGETING IS SHOWN WRONG ON THE SAME INPUT. Rewriting the published shape
  // to target as:Note is a two-token edit, and it refuses that message.
  const asNoteTargeted = IEP_TTL.replace('sh:targetClass iep:NotificationBody ;', 'sh:targetClass as:Note ;');
  ok(asNoteTargeted !== IEP_TTL, '§6 the fixture actually retargeted the shape');
  const asNoteReport = validateAgainstShape(projectNotification(typedNote).turtle, asNoteTargeted);
  const refusedBy = asNoteReport.results.filter(r => (r.severity ?? 'Violation') === 'Violation');
  ok(refusedBy.length > 0,
    '§6 …because sh:targetClass as:Note selects the ACTIVITY too, and the body is on its as:object',
    `${refusedBy.length} violation(s)`);

  // The projection marks exactly one node, and that is the whole mechanism.
  const projection = projectNotification(typedNote);
  ok(projection.bodies === 1, '§6 the projection marks exactly one node as the body', `${projection.bodies}`);
  const marks = projection.turtle.split('\n').filter(l => l.includes(NOTIFICATION_BODY_CLASS));
  ok(marks.length === 1, '§6 …and emits exactly one iep:NotificationBody triple', `${marks.length}`);
  ok(marks[0]!.startsWith('_:n1 '),
    "§6 …on the activity's as:object and not on the activity", marks[0] ?? '');

  // A nested object deeper down is not a message body and must not be marked.
  // ★ A PROJECTION PROBE, NOT A MESSAGE. `buildNotification` never nests an object inside the
  // body; this asks `projectNotification` what it does when something else does, because the
  // "exactly one body" rule is positional and has to hold for any document it is handed — the
  // ActivityPub route hands it one built from a remote server's `object`.
  const nested = notifWith({ summary: 'hi' }, b => { b['object'] = { type: 'Note', summary: 'inner' }; });
  ok(projectNotification(nested).bodies === 1,
    '§6 …and an as:object inside the as:object is not a second body');
}

// ─────────────────────────────────────────────────────────────────────────────
// §7  A check that did not run is never reported as a pass
// ─────────────────────────────────────────────────────────────────────────────
function section7(): void {
  say('\n§7  unenforced is an answer, and it is not `conforms`');

  const absent = prepareNotificationGate(null, validateAgainstShape);
  ok(!absent.enforcing, '§7 a document that could not be read leaves the gate NOT enforcing');
  const v = absent.check(notif({ summary: CLAIMS_DETAIL }));
  ok(v.verdict === 'unenforced', '§7 …and every verdict it gives is `unenforced`', v.verdict);
  ok(notificationBodyReport(v)['enforced'] === false,
    '§7 …which the caller is told, rather than being told nothing');
  ok(typeof absent.why === 'string' && absent.why.includes('Dockerfile.relay'),
    '§7 …and the operator sentence names the thing to go and check');

  // A document that parses but does not describe the shape is the tarball case one step along:
  // the file arrived, the rule did not.
  const wrongDoc = prepareNotificationGate('@prefix ex: <http://example.org/#>.\nex:x ex:p "q" .\n', validateAgainstShape);
  ok(!wrongDoc.enforcing, '§7 a document that parses but does not declare the shape is also NOT enforcing');
  ok(wrongDoc.check({}).verdict === 'unenforced', '§7 …and still never answers `conforms`');
}

// ─────────────────────────────────────────────────────────────────────────────
// §8  The canaries decide — the gate can detect that its own rule stopped working
// ─────────────────────────────────────────────────────────────────────────────
function section8(): void {
  say('\n§8  the gate finds out at load whether the published rule still decides');

  // ★ THE TIDY-UP THAT LOOKS RIGHT AND IS NOT. sh:flags is NOT implemented by this engine and is
  // IGNORED rather than fatal, so the sh:pattern beside it keeps running case-SENSITIVELY: a
  // lower-cased pattern with `sh:flags "i"` stops matching `FULL DETAIL`, the antecedent is
  // negated, and the shape CONFORMS for the very message it exists to refuse.
  const lowered = IEP_TTL.replace(
    /sh:pattern "\(\[Ff\][^"]*"/,
    'sh:pattern "(full detail|in full|verbatim|attached|enclosed|as follows|see below)" ; sh:flags "i"',
  );
  ok(lowered !== IEP_TTL, '§8 the fixture actually rewrote the pattern');

  // First: the mechanism is real, measured on the engine rather than asserted.
  const loweredReport = validateAgainstShape(
    projectNotification(notif({ summary: CLAIMS_DETAIL })).turtle,
    lowered,
  );
  ok(loweredReport.conforms,
    '§8 the lower-cased + sh:flags spelling really does CONFORM for the defect — sh:flags is '
    + 'ignored, so the pattern beside it stays case-sensitive');

  // Then: the gate refuses to enforce it, loudly, rather than quietly stopping.
  const weakened = prepareNotificationGate(lowered, validateAgainstShape);
  ok(!weakened.enforcing, '§8 …and the canary table catches that at load: the gate switches OFF');
  ok(typeof weakened.why === 'string' && weakened.why.includes('answered CONFORMS'),
    '§8 …naming which case stopped being decided, and what it answered instead', weakened.why ?? '');
  ok(weakened.check({}).verdict === 'unenforced',
    '§8 …and delivers unvalidated while SAYING SO, rather than reporting a pass it did not make');

  // The other direction: a shape that started refusing legitimate traffic must switch the gate
  // off too, because enforcing it would be the outage.
  const overreaching = IEP_TTL.replace(
    'sh:targetClass iep:NotificationBody ;\n    sh:message',
    'sh:targetClass iep:NotificationBody ;\n    sh:property [ sh:path as:content ; sh:minCount 1 ] ;\n    sh:message',
  );
  ok(overreaching !== IEP_TTL, '§8 the fixture actually made the shape unconditional');
  const strict = prepareNotificationGate(overreaching, validateAgainstShape);
  ok(!strict.enforcing,
    '§8 a shape that would refuse an ordinary summary-only probe also switches the gate OFF — '
    + 'turning a rule on wrong is the outage, not the safe default');
  ok(typeof strict.why === 'string' && strict.why.includes('answered VIOLATES'),
    '§8 …and says which legitimate case it would have refused', strict.why ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// §9  The wiring: refused before anything is written, and shipped in the image
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A function's own body, from its signature to the first line-start `}`.
 *
 * ★ STRUCTURE, NOT DISTANCE. A `[\s\S]{0,2000}` window between two anchors measures how far
 * apart they happen to be today; it goes red the day somebody adds a paragraph between them,
 * over a property that is still perfectly intact. That shape cost this project two production
 * deploys past a red run in one day — see
 * tests/a-proxy-that-is-right-until-something-grows.test.ts, whose ratchet also refuses any new
 * file that uses it.
 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

function section9(): void {
  say('\n§9  the wiring in server.ts and in the image');

  const server = repoFile('deploy', 'mcp-relay', 'server.ts');
  const handler = bodyOf(server, 'async function handleNotifyAgent(');
  ok(handler.length > 0, '§9 handleNotifyAgent was found in server.ts — a zero-length slice would '
    + 'make every assertion below pass vacuously');

  const builtAt = handler.indexOf('buildNotification(input, idSlug)');
  const checkedAt = handler.indexOf('notificationGate().check(notif)');
  const refusedAt = handler.indexOf('notificationBodyRefusal(');
  const fannedAt = handler.indexOf('reachFanOut(');
  const deliveredAt = handler.indexOf('deliverLdn:');
  for (const [n, i] of [['built', builtAt], ['checked', checkedAt], ['refused', refusedAt], ['fanned out', fannedAt], ['delivered', deliveredAt]] as const) {
    ok(i >= 0, `§9 handleNotifyAgent still ${n} — the ordering assertions below need all five`, `${i}`);
  }
  ok(builtAt < checkedAt,
    '§9 the notification is BUILT before it is checked, so the shape sees what would be written '
    + 'rather than the arguments it was written from');
  ok(refusedAt < fannedAt && refusedAt < deliveredAt,
    '§9 ★ and the refusal RETURNS above reachFanOut and above the LDN write, so a refused '
    + 'notification is never half-delivered — no inbox write, no Discord webhook, no SMS');

  ok(handler.includes('bodyShape: notificationBodyReport(bodyVerdict)'),
    '§9 a SUCCESSFUL delivery also reports the contract, so a caller learns it without breaking it');

  // The ActivityPub route is the REPORT side of the split and must not refuse.
  const apRoute = ((): string => {
    const start = server.indexOf("app.post('/agents/:localPart/inbox'");
    if (start < 0) return '';
    const end = server.indexOf('\n});\n', start);
    return end < 0 ? server.slice(start) : server.slice(start, end);
  })();
  ok(apRoute.length > 0, '§9 the ActivityPub inbox route was found');
  ok(apRoute.includes('notificationGate().check(notif)'), '§9 …and it does evaluate the shape');
  ok(!apRoute.includes('notificationBodyRefusal('),
    '§9 ★ …and never refuses: that document is a foreign server\'s, and its summary is partly '
    + 'OURS — the route synthesises one when the remote omits it, so a refusal could fire on the '
    + 'relay\'s own words');
  ok(apRoute.includes('bodyShape: notificationBodyReport('),
    '§9 …it reports the verdict instead, so a peer sending bodyless notifications can be told');

  // ★★ THE ONE FIELD THIS ROUTE TOOK OFF A REMOTE DOCUMENT WITHOUT CHECKING ITS TYPE. It read
  // `(act.summary ?? obj.summary ?? …) as string` — a cast, not a check — while `content`,
  // `about`, `actor` and `type` beside it all guard. `buildNotification` copies `summary` onto
  // BOTH the activity and its object, so an ARRAY there put two `as:summary` values on the node
  // the shape targets, which is exactly what §11 shows defeating the old antecedent.
  // `notify_agent` masks the same input behind its MCP schema; this route has no schema.
  ok(apRoute.includes("if (typeof value === 'string') return true;")
    && apRoute.includes("remote('summary', act.summary"),
    '§9 ★ the ActivityPub route typeof-checks the summary it takes off a REMOTE document');
  // ★★ AND SAYS WHAT IT DROPPED. A guard that substitutes the relay's own synthesised sentence
  // for a sender's message and records nothing is a quieter version of the defect it closed:
  // this route REPORTS rather than refuses, so the report has to carry the substitution.
  ok(apRoute.includes('const apBlindTo: string[] = []') && apRoute.includes('blindTo: apBlindTo'),
    '§9 ★★ …and NAMES every remote field it could not use as sent, in the answer it returns');
  ok(apRoute.includes('this relay could not use as sent'),
    '§9 …and in the log, so an operator sees it without reading a response body');
  // The refuted spelling itself, by its exact text. A looser probe for ` as string` matches this
  // route's own comment ABOUT that spelling, which would pass for the wrong reason.
  ok(!apRoute.includes('summary: (act.summary'),
    '§9 …with the cast that stood in for that check gone from the code');
  ok(apRoute.includes("remote('type', act.type") && apRoute.includes("? act.type as string : 'Activity'"),
    '§9 …and the type interpolated into the synthesised sentence, which is the RELAY speaking, too');

  // ★ THE IMAGE. Repo data found by walking UP from the source tree is green on a developer's
  // machine and absent in every container; this is the assertion that makes the tarball case
  // fail in CI instead of in production.
  const dockerfile = repoFile('deploy', 'Dockerfile.relay');
  ok(dockerfile.includes('COPY deploy/mcp-relay/notification-body.ts ./'),
    '§9 Dockerfile.relay carries a per-file COPY for the module server.ts imports');
  // The first candidate is ['..','relay-docs','ns','iep.ttl'], resolved from the running
  // module's directory. Dockerfile.relay compiles to /app/dist and runs dist/server.js, so that
  // is /app/relay-docs/ns/iep.ttl — and `COPY --from=build /relay-docs ./relay-docs` under
  // WORKDIR /app is what puts it there.
  const first = NOTIFICATION_SHAPE_CANDIDATES[0]!;
  ok(first.join('/') === '../relay-docs/ns/iep.ttl',
    '§9 the production candidate path is the one this assertion is about', first.join('/'));
  ok(dockerfile.includes('COPY docs/ns/iep.ttl /relay-docs/ns/iep.ttl'),
    '§9 …and the ontology is COPYd to exactly where that path resolves from /app/dist');
  ok(dockerfile.includes('COPY --from=build /relay-docs ./relay-docs'),
    '§9 …and /relay-docs is carried into the runtime stage under WORKDIR /app');

  // The package.json test script must actually run this file, or it is a suite nobody executes.
  const pkg = repoFile('deploy', 'mcp-relay', 'package.json');
  ok(pkg.includes('tsx tests/notification-body-shape.test.ts'),
    '§9 and `npm test` in deploy/mcp-relay runs this suite');
}

// ─────────────────────────────────────────────────────────────────────────────
// §10  The slice is faithful — it drops nothing and imports nothing
// ─────────────────────────────────────────────────────────────────────────────
function section10(): void {
  say('\n§10  isolating the shape neither weakens it nor drags the ontology in');

  const iso = isolateShapeClosure(IEP_TTL, NOTIFICATION_BODY_SHAPE);
  if ('error' in iso) { ok(false, '§10 isolation failed', iso.error); return; }

  // ★ IT MUST NOT PULL IN A NEIGHBOUR. `sh:targetClass` names an IRI, and following named IRIs
  // indiscriminately would walk the closure into the rest of a 500-term ontology — and then a
  // violation from an unrelated shape would be quoted as this contract's refusal.
  ok(!iso.turtle.includes('#ContextDescriptor'),
    '§10 the closure does not reach unrelated ontology terms');
  ok(iso.subjects < 30, '§10 …and stays the size of a shape rather than of a document', `${iso.subjects}`);

  // ★ AND A SECOND SHAPE TARGETING THE SAME CLASS IS NOT QUOTED AS THIS ONE'S REFUSAL. This is
  // the flip side of §3: isolation is what makes "mine" true by construction, so it has to be
  // shown that something ELSE firing on the same node does not become a refusal here.
  const withDecoy = `${IEP_TTL}\niep:aDecoyShapeForTesting a sh:NodeShape ;\n`
    + '    sh:targetClass iep:NotificationBody ;\n'
    + '    sh:property [ sh:path as:summary ; sh:maxLength 3 ] .\n';
  const decoyGate = prepareNotificationGate(withDecoy, validateAgainstShape);
  ok(decoyGate.enforcing, '§10 the gate still enforces with a decoy shape in the document');
  const clean = notif({ summary: 'checking whether this inbox is reachable' });
  ok(decoyGate.check(clean).verdict === 'conforms',
    '§10 …and a message the decoy refuses is still DELIVERED, because the decoy is not this contract');
  // Non-vacuity: the decoy really would have fired against the whole document.
  const decoyReport = validateAgainstShape(projectNotification(clean).turtle, withDecoy);
  ok(decoyReport.results.some(r => (r.severity ?? 'Violation') === 'Violation'),
    '§10 …non-vacuous: against the WHOLE document that same message does raise a violation');

  // Re-serialization must not silently change a rule. The published pattern is the load-bearing
  // string, so it has to survive the round trip byte for byte.
  ok(iso.turtle.includes('[Ff][Uu][Ll][Ll] [Dd][Ee][Tt][Aa][Ii][Ll]'),
    '§10 the summary pattern survives the slice unchanged');
  ok(iso.turtle.includes(String.fromCharCode(92, 92) + 'S'),
    '§10 …and so does the non-blank content pattern, re-serialized as the ESCAPE it was written '
    + 'as — the round trip §13 measures both spellings through');
  ok(!iso.turtle.split('').some(ch => {
    const c = ch.charCodeAt(0);
    return c < 0x20 && c !== 0x0a;
  }), '§10 …and the isolated graph carries no raw control byte at all');
}

// ─────────────────────────────────────────────────────────────────────────────
// §11  REFUTED DEFECT 5 — the antecedent said something other than what it meant
// ─────────────────────────────────────────────────────────────────────────────
function section11(): void {
  say('\n§11  "no summary claims the detail" — and the spelling that did not mean it');

  /**
   * ★★ ONE EXTRA `as:summary` DELIVERED THE MESSAGE THE GATE EXISTS TO REFUSE.
   *
   * `sh:not [ sh:property [ sh:path as:summary ; sh:minCount 1 ; sh:pattern P ] ]` READS as
   * "no summary matches P". It is not: the inner property shape raises a violation when the
   * value count is 0 OR when ANY ONE value fails P, so its negation holds when there is no
   * summary at all or when SOME summary does not match. A second value — the empty string will
   * do — satisfied it, and the whole `sh:or` then passed.
   *
   * It is reachable. `buildNotification` copies the caller's summary onto the activity AND onto
   * its object, and the ActivityPub inbox route builds that summary from a REMOTE document, so
   * an array arrives as two values on the node the shape targets. §9 pins the typeof guard that
   * now stops it there as well; this section is about the shape being right either way.
   */
  // ★ WRITER OUTPUT PLUS THE ONE MUTATION `POST /agents/:localPart/inbox` COULD ONCE MAKE. It
  // read `(act.summary ?? obj.summary) as string` off a remote document — a cast, not a check —
  // and `buildNotification` copies `summary` onto the activity AND its object, so an array
  // arrived on the body as two values. §9 pins the `typeof` guard that stops it there now; this
  // section is about the SHAPE being right whether or not a writer guards.
  const twoSummaries = notifWith({ summary: CLAIMS_DETAIL }, b => { b['summary'] = [CLAIMS_DETAIL, '']; });
  const bodyLines = projectNotification(twoSummaries).turtle.split('\n')
    .filter(l => l.startsWith('_:n1 ') && l.includes('#summary'));
  ok(bodyLines.length === 2,
    '§11 non-vacuous: the body really does carry TWO as:summary values, one of them claiming',
    bodyLines.join(' | '));
  ok(verdictOf(twoSummaries) === 'violates',
    '§11 ★ and it is REFUSED — the antecedent asks whether ANY summary claims, not whether all do');

  // ★★ AND THE REFUTED SPELLING IS SHOWN WRONG ON THE SAME INPUT, rebuilt out of the published
  // document rather than restated here, so the comparison is against what was actually shipped.
  const QVS_OPEN = 'sh:qualifiedValueShape [ sh:pattern "';
  const QVS_TAIL = '" ] ;\n              sh:qualifiedMinCount 1 ] ] ]';
  const openAt = IEP_TTL.indexOf(QVS_OPEN);
  const tailAt = IEP_TTL.indexOf(QVS_TAIL, openAt);
  ok(openAt >= 0 && tailAt > openAt,
    '§11 the published shape spells its antecedent with sh:qualifiedValueShape + sh:qualifiedMinCount',
    `${openAt} / ${tailAt}`);
  if (openAt < 0 || tailAt < 0) return;
  const summaryPattern = IEP_TTL.slice(openAt + QVS_OPEN.length, tailAt);
  const refuted = `${IEP_TTL.slice(0, openAt)}sh:minCount 1 ;\n              sh:pattern "${summaryPattern}" ] ] ]${IEP_TTL.slice(tailAt + QVS_TAIL.length)}`;
  ok(refuted !== IEP_TTL && refuted.includes('sh:minCount 1 ;\n              sh:pattern "'),
    '§11 the fixture really did rebuild the refuted antecedent');

  // ★ MEASURED AGAINST THE ENGINE DIRECTLY, NOT THROUGH THE GATE, because the gate now REFUSES
  // to enforce this spelling — the canary table grew the two-summary row this defect walked
  // through. Going through prepareNotificationGate would measure the canary and not the shape.
  const refutedSlice = isolateShapeClosure(refuted, NOTIFICATION_BODY_SHAPE);
  ok(!('error' in refutedSlice), '§11 the refuted spelling still slices',
    'error' in refutedSlice ? refutedSlice.error : '');
  if ('error' in refutedSlice) return;
  const refutedReport = validateAgainstShape(projectNotification(twoSummaries).turtle, refutedSlice.turtle);
  ok(refutedReport.conforms,
    '§11 ★ the refuted spelling CONFORMS for the same message the shipped shape refuses');
  const singleReport = validateAgainstShape(
    projectNotification(notif({ summary: CLAIMS_DETAIL })).turtle,
    refutedSlice.turtle,
  );
  ok(!singleReport.conforms,
    '§11 …while still refusing the single-summary case, which is why nobody saw it');

  // ★★ AND THE GATE NOW CATCHES IT AT LOAD. A rule should not depend on being caught, but a rule
  // that CAN be caught is one this relay stops enforcing loudly instead of enforcing wrongly.
  const refutedGate = prepareNotificationGate(refuted, validateAgainstShape);
  ok(!refutedGate.enforcing,
    '§11 ★ the canary table refuses to enforce the refuted antecedent — it switches the gate OFF');
  ok((refutedGate.why ?? '').includes('SECOND summary value'),
    '§11 …naming the row that stopped being decided', refutedGate.why ?? '');

  // The other direction: extra summaries are not themselves a refusal. A body carrying two
  // summaries and claiming nothing must still be delivered, or this fix is its own outage.
  const twoBenign = notifWith({ summary: 'a channel update' }, b => { b['summary'] = ['a channel update', 'and a second line']; });
  ok(verdictOf(twoBenign) === 'conforms',
    '§11 two summaries that claim nothing are still DELIVERED — the count is not the rule');
}

// ─────────────────────────────────────────────────────────────────────────────
// §12  REFUTED DEFECT 6, TWICE — the size bound was a way past the gate, and the fix for it was
// ─────────────────────────────────────────────────────────────────────────────
function section12(): void {
  say('\n§12  over the bound is not past the gate — five fields, each measured walking through it');

  const pad = 'x'.repeat(66_000);

  /**
   * ★★ THE BOUND HAS BEEN A WAY PAST THIS GATE TWICE, AND THE SECOND TIME THIS SECTION SAID IT
   * WAS NOT.
   *
   * The FIRST spelling counted ALL of a notification's text, so a claiming summary with an empty
   * body plus a padded `in_reply_to` answered `enforced: false`. The SECOND dropped the
   * ACTIVITY-level fields and kept the `object` subtree whole — and `buildNotification` puts
   * `content`, `iep:about` AND `inReplyTo` on the OBJECT, so four more fields walked through the
   * same hole. This section certified that fix green while the fix was wrong, because its
   * fixture put `inReplyTo` on the ACTIVITY, where the writer never puts it (see the note on
   * `notif` above). Driven afterwards over the wire against a booted relay, signed
   * `POST /tool/notify_agent`, claiming summary and no body: `in_reply_to`, `about`, `type`, a
   * padded `summary` and a whitespace `content` were FIVE separate routes to
   * `bodyShape.enforced: false`.
   *
   * Every row below is real `buildNotification` output, and each carries the verdict its
   * UNPADDED twin carries. The last three are the other direction: a gate that simply refused
   * everything large would pass the first five and be its own outage.
   */
  const PADDED: readonly (readonly [string, Record<string, unknown>, 'violates' | 'conforms'])[] = [
    ['in_reply_to — which the writer puts on the BODY, not the activity',
      notif({ summary: CLAIMS_DETAIL, inReplyTo: pad }), 'violates'],
    ['the caller-chosen activity type, which the old reduction kept as "structure"',
      notif({ summary: CLAIMS_DETAIL, type: pad }), 'violates'],
    ['an iep:about that is not an IRI, so nothing is reachable and the size is not a rescue',
      notif({ summary: CLAIMS_DETAIL, about: `no-${pad}` }), 'violates'],
    ['the CLAIMING SUMMARY itself, where a plain truncation would have lost the claim',
      notif({ summary: `${pad} ${CLAIMS_DETAIL}` }), 'violates'],
    ['a body of 66,000 space characters, which is over the bound and still not a body',
      notif({ summary: CLAIMS_DETAIL, content: ' '.repeat(66_000) }), 'violates'],
    ['a real 66,000-character body, which must still be DELIVERED',
      notif({ summary: CLAIMS_DETAIL, content: pad }), 'conforms'],
    ['detail carried by reference, whose iep:about really is an IRI 66,000 characters long',
      notif({ summary: CLAIMS_DETAIL, about: `https://pod.example/finding/${pad}` }), 'conforms'],
    ['a 66,000-character summary that claims nothing, which must not be refused',
      notif({ type: 'Announce', summary: `the Q3 planning workspace has a new head ${pad}` }), 'conforms'],
  ];
  for (const [what, message, want] of PADDED) {
    ok(notificationTextSize(message, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS,
      `§12 non-vacuous: over the bound — ${what}`);
    const v = gate.check(message);
    ok(v.verdict === want, `§12 ★ ${want.toUpperCase()}: ${what}`,
      v.verdict === 'unenforced' ? v.why : v.verdict);
  }

  /**
   * ★ WHAT WAS DROPPED AND WHAT WAS SHORTENED ARE BOTH NAMED. An answer that judged a reduced
   * document and reported nothing about the reduction would be indistinguishable from one that
   * judged the message as sent.
   */
  const paddedWithBody = notif({ summary: CLAIMS_DETAIL, inReplyTo: pad, content: 'P7: the write path is unauthenticated.' });
  const v = gate.check(paddedWithBody);
  ok(v.verdict === 'conforms', '§12 an over-bound message with a real body is still DELIVERED', v.verdict);
  if (v.verdict === 'conforms') {
    ok((v.blindTo ?? []).includes('object.inReplyTo'),
      '§12 …with the BODY field the gate dropped to stay inside the bound NAMED — the position '
      + 'the writer actually puts it in', JSON.stringify(v.blindTo));
    ok((v.blindTo ?? []).includes('type') && (v.blindTo ?? []).includes('actor'),
      '§12 …and the activity fields too', JSON.stringify(v.blindTo));
    ok(notificationBodyReport(v)['notProjected'] !== undefined,
      '§12 …and the caller reads them as notProjected rather than being told nothing');
  }
  const shortenedAbout = gate.check(notif({ summary: CLAIMS_DETAIL, about: `https://pod.example/finding/${pad}` }));
  ok(shortenedAbout.verdict === 'conforms'
    && (shortenedAbout.blindTo ?? []).some(b => b.startsWith('object.iep:about') && b.includes('shortened')),
    '§12 …and a value that was SHORTENED rather than dropped says so, and says what was preserved',
    JSON.stringify(shortenedAbout.verdict === 'conforms' ? shortenedAbout.blindTo : shortenedAbout));

  /**
   * ★ THE REDUCTION IS DRIVEN BY THE PUBLISHED SHAPE, NOT BY A LIST IN THE MODULE. That is what
   * makes it something other than a second copy of the rule, so it is measured rather than
   * asserted: the keys it keeps come out of the document's own `sh:path` values.
   */
  const iso = isolateShapeClosure(IEP_TTL, NOTIFICATION_BODY_SHAPE);
  if ('error' in iso) { ok(false, '§12 isolation failed', iso.error); return; }
  const reach = shapeReach(iso.turtle);
  if ('error' in reach) { ok(false, '§12 the shape reach could not be read', reach.error); return; }
  ok([...reach.keys].sort().join(',') === 'content,iep:about,summary',
    '§12 the keys the reduction keeps are exactly the ones the PUBLISHED shape names via sh:path',
    [...reach.keys].join(','));
  ok(reach.lexical.length === 0,
    '§12 …and the published shape carries no constraint whose verdict depends on a value’s length',
    reach.lexical.join(', '));
  const cut = reduceToConstrainedBody(notif({ summary: CLAIMS_DETAIL, inReplyTo: pad, content: 'x' }), reach.keys);
  ok(!JSON.stringify(cut.notif).includes(pad),
    '§12 ★ the pad is GONE from the reduced document, size-independently');
  ok(cut.omitted.includes('object.inReplyTo') && cut.omitted.includes('object.type'),
    '§12 …and what went is returned rather than dropped in silence', cut.omitted.join(', '));
  ok(JSON.stringify(cut.notif).includes('"content":"x"'),
    '§12 …while everything the shape does look at survives', JSON.stringify(cut.notif).slice(0, 200));

  /**
   * ★★ THE RESIDUAL, STATED EXACTLY AND DRIVEN IN BOTH ITS FORMS. `unenforced` is still
   * reachable, and only when a shortening cannot be SHOWN to give the shape the same answer.
   * Both cases are properties of the published shape rather than of the message, so both are
   * driven by growing the document — and in both the gate switches itself OFF at load, loudly,
   * rather than delivering the case it exists to catch.
   */
  const lexical = IEP_TTL.replace(
    'sh:targetClass iep:NotificationBody ;',
    'sh:targetClass iep:NotificationBody ;\n    sh:property [ sh:path as:content ; sh:maxLength 1000000 ] ;',
  );
  ok(lexical !== IEP_TTL, '§12 the fixture added a lexically sensitive constraint');
  const lexicalGate = prepareNotificationGate(lexical, validateAgainstShape);
  ok(!lexicalGate.enforcing,
    '§12 ★ a shape carrying sh:maxLength makes every over-bound value unshortenable, and the gate '
    + 'switches OFF rather than answering from a value the shape would judge differently');
  ok((lexicalGate.why ?? '').includes('sh:maxLength'),
    '§12 …naming the constraint that made the reduction unsound', lexicalGate.why ?? '');
  // Non-vacuity: without that constraint the very same over-bound message is DECIDED.
  ok(gate.check(notif({ summary: CLAIMS_DETAIL, content: ' '.repeat(66_000) })).verdict === 'violates',
    '§12 …non-vacuous: the same message the grown shape could not judge is refused by the shipped one');

  const greedy = IEP_TTL.replace(
    'sh:targetClass iep:NotificationBody ;',
    `sh:targetClass iep:NotificationBody ;\n    sh:property [ sh:path as:inReplyTo ; sh:pattern "x{${MAX_GATED_VALUE_CHARS + 1},}" ] ;`,
  );
  ok(greedy !== IEP_TTL, '§12 the fixture added a pattern whose own match can outrun the per-value bound');
  const greedyGate = prepareNotificationGate(greedy, validateAgainstShape);
  ok(!greedyGate.enforcing,
    '§12 ★ …and so does a pattern whose match inside the value is longer than the window the gate '
    + 'will show the shape');
  ok((greedyGate.why ?? '').includes('longer than'),
    '§12 …naming that as the reason rather than reporting a pass', greedyGate.why ?? '');

  /**
   * ★ AND THE THIRD RESIDUAL, WHICH NO WRITER IN THIS TREE CAN REACH. Every value is inside
   * MAX_GATED_VALUE_CHARS and the document is still over the bound: that means thousands of
   * separate values on a property the shape COUNTS, and dropping any of them would change what
   * sh:qualifiedMinCount counts. `buildNotification` puts exactly one value on each of these
   * keys, so this is assembled rather than built — and the answer is `unenforced` with a
   * sentence that says which of the three cases it is.
   */
  const manyValues = notifWith({ summary: CLAIMS_DETAIL }, b => {
    b['summary'] = Array.from({ length: 40_000 }, (_v, i) => `s${i}`);
  });
  const mv = gate.check(manyValues);
  ok(mv.verdict === 'unenforced', '§12 a body carrying tens of thousands of summary values is not decided', mv.verdict);
  if (mv.verdict === 'unenforced') {
    ok(mv.why.includes('separate values'),
      '§12 …and the sentence says THAT is why, not that the message was merely large', mv.why);
    ok(!mv.why.includes('activity-level fields dropped'),
      '§12 …and no longer carries the sentence that was false for four of the five padded fields');
  }

  /**
   * ★★ THE ONE RESIDUAL A MESSAGE COULD REACH, AND THE DIRECTION IT CAN ERR IN.
   *
   * The shortening splices a head window onto a window around the first match of each published
   * pattern, and it refuses to substitute unless every pattern answers the same for both. A
   * splice can only ADD a match, never remove one — the witness the value has, the window has —
   * so the only way to reach `unenforced` this way is a value that did NOT match and starts
   * matching, which for `as:summary` means a summary that does not claim: not the defect.
   *
   * A CLAIMING summary must survive the reduction wherever the claim sits in it. That is not an
   * argument, it is a table: the phrase is placed at the front, at the head-window boundary, at
   * the witness-window boundary, deep in the middle and at the very end of a 66,000-character
   * summary, and every one must be REFUSED.
   */
  const claimAt = (offset: number): Record<string, unknown> => {
    const tail = Math.max(0, 66_000 - offset - CLAIMS_DETAIL.length);
    return notif({ summary: `${'q '.repeat(Math.ceil(offset / 2)).slice(0, offset)}${CLAIMS_DETAIL}${' w'.repeat(Math.ceil(tail / 2)).slice(0, tail)}` });
  };
  for (const offset of [0, 500, 511, 512, 513, 544, 545, 546, 4095, 4096, 4097, 33_000, 65_960]) {
    const v = gate.check(claimAt(offset));
    ok(v.verdict === 'violates',
      `§12 ★ a claiming summary keeps its claim through the reduction — phrase at offset ${offset}`,
      v.verdict === 'unenforced' ? v.why.slice(0, 160) : v.verdict);
  }
  // ★ And the same in the other direction, at the same offsets: a summary of exactly the same
  // shape that does NOT claim must not be refused. Without this the table above would pass for a
  // gate that refused every long summary.
  const benignAt = (offset: number): Record<string, unknown> => {
    const phrase = 'the head of the workspace changed';
    const tail = Math.max(0, 66_000 - offset - phrase.length);
    return notif({ type: 'Announce', summary: `${'q '.repeat(Math.ceil(offset / 2)).slice(0, offset)}${phrase}${' w'.repeat(Math.ceil(tail / 2)).slice(0, tail)}` });
  };
  for (const offset of [0, 512, 545, 4096, 33_000]) {
    const v = gate.check(benignAt(offset));
    ok(v.verdict === 'conforms',
      `§12 …and a summary that claims nothing is still DELIVERED — phrase at offset ${offset}`,
      v.verdict === 'unenforced' ? v.why.slice(0, 160) : v.verdict);
  }

  /**
   * ★ THE COUNTER AND THE PROJECTOR AGREE ON DEPTH. `notificationTextSize` stopped at depth 8
   * while `projectNotification` recursed with no limit at all, so text nested deeper than 8 was
   * projected and parsed WITHOUT being counted — the same hole one level along.
   */
  let deep: Record<string, unknown> = { type: 'Note', summary: 'x', content: 'x' };
  for (let i = 0; i < 12; i += 1) deep = { type: 'Note', summary: 'x', object: deep };
  // ★ A PROJECTION PROBE AGAIN: no writer nests bodies, and the question is what the projector
  // and the counter do with a document that does.
  const deepProjection = projectNotification(notifWith({ summary: 'hi' }, b => { b['object'] = deep; }));
  ok(deepProjection.blindTo.some(b => b.startsWith('object.object')),
    '§12 the projection stops where the counter stops counting, and REPORTS where it stopped',
    deepProjection.blindTo.join(', '));
  ok(deepProjection.turtle.split('\n').filter(l => l.includes('#object')).length <= 8,
    '§12 non-vacuous: nothing below that depth was emitted into the graph',
    `${deepProjection.turtle.split('\n').filter(l => l.includes('#object')).length} as:object triples`);

  /**
   * ★★ AND THEY AGREE AT THE DEEPEST LEVEL THE PROJECTOR STILL EMITS, WHICH IS WHERE THEY USED
   * TO PART. The counter measured depth per VALUE and the projector per NODE, so a literal on the
   * last node the projector reaches was EMITTED AND PARSED while the counter, one level further
   * along by its own reckoning, refused to look at it. 70,000 characters, placed exactly there.
   */
  const buried = 'q'.repeat(70_000);
  let chain: Record<string, unknown> = { type: 'Note', summary: 'x', content: buried };
  for (let i = 0; i < 6; i += 1) chain = { type: 'Note', summary: 'x', object: chain };
  const deeplyBuried = notifWith({ summary: 'hi' }, b => { b['object'] = chain; });
  ok(projectNotification(deeplyBuried).turtle.includes(buried),
    '§12 non-vacuous: the projector really does emit a literal at that depth');
  ok(notificationTextSize(deeplyBuried, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS,
    '§12 ★ and the counter really does count it — anything the projector emits is weighed',
    `${notificationTextSize(deeplyBuried, MAX_GATED_BODY_CHARS)} chars`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §13  REFUTED DEFECT 7 — whitespace that is not ASCII passed as a body
// ─────────────────────────────────────────────────────────────────────────────
function section13(): void {
  say('\n§13  a body of whitespace is not a body, in any script');

  const BSL = String.fromCharCode(92);
  // ★ BUILT AT RUNTIME FROM CODE POINTS, NEVER TYPED INTO THIS FILE. U+000B is a control
  // character and U+2028 a line separator; a source file carrying either raw is a file whose
  // bytes disagree with how it reads, which this repo has already been bitten by once.
  const ws = (code: number): string => String.fromCharCode(code);
  const WHITESPACE: readonly (readonly [string, string])[] = [
    ['U+00A0 no-break space', ws(0x00a0)],
    ['U+3000 ideographic space', ws(0x3000)],
    ['U+2028 line separator', ws(0x2028)],
    ['U+000B vertical tab', ws(0x000b)],
    ['U+FEFF zero-width no-break space', ws(0xfeff)],
  ];
  for (const [name, ch] of WHITESPACE) {
    ok(verdictOf(notif({ summary: CLAIMS_DETAIL, content: ch.repeat(3) })) === 'violates',
      `§13 a body of ${name} is refused`);
  }
  ok(verdictOf(notif({ summary: CLAIMS_DETAIL, content: '中' })) === 'conforms',
    '§13 …while a body of one non-ASCII CHARACTER is a body and is DELIVERED — the rule is '
    + 'whitespace, not ASCII');

  /**
   * ★★ THE REFUTED SPELLING, SHOWN WRONG ON THE SAME INPUT. The character class excluded exactly
   * four ASCII characters, so four of the five rows above passed as bodies.
   */
  const SHIPPED_PATTERN = `sh:pattern "${BSL}${BSL}S" ]`;
  const ASCII_CLASS = `sh:pattern "[^ ${BSL}t${BSL}r${BSL}n]" ]`;
  ok(IEP_TTL.includes(SHIPPED_PATTERN),
    '§13 the published document spells the non-blank rule as a regex escape');
  const asciiOnly = IEP_TTL.replace(SHIPPED_PATTERN, ASCII_CLASS);
  ok(asciiOnly !== IEP_TTL, '§13 the fixture really did put the character class back');
  const asciiGate = prepareNotificationGate(asciiOnly, validateAgainstShape);
  ok(asciiGate.enforcing,
    '§13 the character-class spelling passes every load-time canary, which is how it got published',
    asciiGate.why ?? '');
  ok(asciiGate.check(notif({ summary: CLAIMS_DETAIL, content: ws(0x00a0).repeat(2) })).verdict === 'conforms',
    '§13 ★ …and DELIVERS a body of U+00A0 with a claiming summary');

  /**
   * ★★ AND THE COMMENT THAT JUSTIFIED THE CLASS WAS FALSE IN BOTH HALVES. It said a Turtle
   * `"\\S"` "would have to survive an escape round trip to reach the regex, and the character
   * class does not". Both spellings go through the SAME round trip — this file's isolator
   * re-serializes every literal it slices — and both survive it, because `\t`, `\r` and `\n` are
   * escapes exactly as `\\` is.
   */
  const isoShipped = isolateShapeClosure(IEP_TTL, NOTIFICATION_BODY_SHAPE);
  const isoClass = isolateShapeClosure(asciiOnly, NOTIFICATION_BODY_SHAPE);
  if ('error' in isoShipped || 'error' in isoClass) {
    ok(false, '§13 both spellings can be isolated');
    return;
  }
  ok(isoShipped.turtle.includes(`${BSL}${BSL}S`),
    '§13 the escape spelling survives the slice, written back as the escape it came in as');
  ok(isoClass.turtle.includes(`${BSL}t`),
    '§13 …and so does the character class, through that same round trip');
}

// ─────────────────────────────────────────────────────────────────────────────
// §14  A SURVIVING MUTANT — the closure follows a list of NAMED shapes
// ─────────────────────────────────────────────────────────────────────────────
function section14(): void {
  say('\n§14  rdf:first / rdf:rest, and the spelling that needs them');

  /**
   * ★★ THE MUTANT: deleting BOTH `rdf:first` and `rdf:rest` from SHAPE_VALUED_PREDICATES left the
   * isolated graph byte-identical and the whole suite green, because Turtle's `( … )` sugar
   * builds this shape's `sh:or` list out of BLANK NODES and the closure follows those
   * unconditionally.
   *
   * They are not dead. `rdf:first` carries a list MEMBER, which is very often a named shape;
   * `rdf:rest` carries a CELL, which the sugar always makes anonymous but a document is free to
   * name. This section re-spells THIS shape's own `sh:or` that way — named cells, named members —
   * and requires the gate to decide identically. Delete either predicate and the slice loses the
   * alternatives, and both losses were MEASURED here rather than reasoned about. With no
   * `rdf:first` the members are unresolvable, which this engine treats as vacuously satisfied, so
   * the shape accepts everything and the canary table switches the gate off. With no `rdf:rest`
   * the closure stops after the first cell and the engine reads the shortened list without
   * complaint — the shape then enforces FEWER alternatives than the document published, which is
   * the quieter and worse failure, and here it costs the branches that clear ordinary traffic, so
   * the gate switches off for the opposite reason.
   */
  const OR_OPEN = '    sh:or (\n';
  const OR_CLOSE = '\n    ) .';
  const a = IEP_TTL.indexOf(OR_OPEN);
  const b = a < 0 ? -1 : IEP_TTL.indexOf(OR_CLOSE, a);
  ok(a >= 0 && b > a, '§14 the published sh:or block was located', `${a} / ${b}`);
  if (a < 0 || b < 0) return;
  const branches = IEP_TTL.slice(a + OR_OPEN.length, b);

  // The same three alternatives, reached through a list whose cells and members are all named.
  // The FIRST outer member can never be satisfied and the real branches are SECOND, deliberately:
  // an sh:or is satisfied by any member, so the rule in force is unchanged — but a closure that
  // stops following the list after cell one keeps only the unsatisfiable member, which is what
  // makes a missing rdf:rest visible as behaviour instead of only as a missing triple.
  const named = `${IEP_TTL.slice(0, a)}    sh:or iep:aTestNamedListCellOne .\n${IEP_TTL.slice(b + OR_CLOSE.length)}
iep:aTestNamedListCellOne rdf:first iep:aTestUnsatisfiableShape ; rdf:rest iep:aTestNamedListCellTwo .
iep:aTestNamedListCellTwo rdf:first iep:aTestBranchesShape ; rdf:rest rdf:nil .
iep:aTestBranchesShape a sh:NodeShape ;
    sh:or (\n${branches}\n    ) .
iep:aTestUnsatisfiableShape a sh:NodeShape ;
    sh:property [ sh:path as:summary ; sh:minCount 99 ] .
`;
  ok(named.includes('iep:aTestNamedListCellOne rdf:first'),
    '§14 the fixture spells the list with named cells and named members');

  const namedIso = isolateShapeClosure(named, NOTIFICATION_BODY_SHAPE);
  ok(!('error' in namedIso), '§14 the named spelling can still be sliced',
    'error' in namedIso ? namedIso.error : '');
  if ('error' in namedIso) return;
  ok(namedIso.turtle.includes('aTestUnsatisfiableShape'),
    '§14 rdf:first pulls a list MEMBER into the slice — without it every member is unresolvable');
  ok(namedIso.turtle.includes('aTestBranchesShape'),
    '§14 rdf:rest pulls the NEXT CELL in — without it the list stops at the first alternative');

  const namedGate = prepareNotificationGate(named, validateAgainstShape);
  ok(namedGate.enforcing,
    '§14 ★ and the gate still DECIDES against the named spelling — every canary, unchanged',
    namedGate.why ?? '');
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['the measured defect', notif({ summary: CLAIMS_DETAIL })],
    ['a real inline body', notif({ summary: CLAIMS_DETAIL, content: 'P7: the write path is unauthenticated.' })],
    ['detail by reference', notif({ summary: CLAIMS_DETAIL, about: 'https://pod.example/finding/7' })],
    ['a summary-only probe', notif({ summary: 'checking whether this inbox is reachable' })],
  ];
  for (const [what, m] of cases) {
    ok(namedGate.check(m).verdict === gate.check(m).verdict,
      `§14 …identically to the shipped spelling for ${what}`,
      `${namedGate.check(m).verdict} vs ${gate.check(m).verdict}`);
  }
}

say('notification body shape — the message that said it carried the detail and carried nothing');
section1();
section2();
section3();
section4();
section5();
section6();
section7();
section8();
section9();
section10();
section11();
section12();
section13();
section14();
say(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
