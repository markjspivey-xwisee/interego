#!/usr/bin/env tsx
/**
 * A notification fan-out must know WHO MAY SEE an entry, and it must know it in the STORE.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `server.ts` held `let notificationLog: ContextChangeEvent[] = []` — one process-global
 * array appended to by `emitNotification` for every pod on the fleet. Two surfaces read it
 * and neither knew whose bearer was asking:
 *
 *   GET /sse                              `slice(-5)`, re-sent every 2 s, behind `mcpGate`
 *                                         (any VALID bearer, never whose)
 *   get_pod_status → recentNotifications  `slice(-10)`
 *
 * Reproduced on the deployed relay with two disposable wallets — the verbatim frame is in
 * `../notification-log.ts`, the driver in `tools/probe-notification-scope-live.ts`. A
 * stranger's stream carried the maintainer's writes and, live, a second stranger's.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY IN TWO HALVES ────────────────────────────
 *
 * §1–§9 exercise the real `NotificationLog` — the actual class the relay constructs, not a
 * stand-in for it. A harness that reimplemented the ring could not have caught the eviction
 * bug in §7.
 *
 * §10–§16 are source-text assertions over `server.ts`, which is self-starting and cannot be
 * imported. They read the COMMENT-STRIPPED text: this repo has already had a mutant survive
 * because a bare regex matched a handler's own explanatory prose after the code it described
 * had been deleted. Every check below is bound to a CALL SITE inside an extracted region, so
 * a rationale comment can neither satisfy nor defeat one.
 *
 * ★ §16 is the one that protects the NEXT consumer. It pins the number of readers at two and
 * names where each lives. A third reader of this store does not merely fail review — it fails
 * the build, and the person adding it has to decide that reader's authorization on purpose.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/notification-scope.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NotificationLog, podKey, type RecentChange } from '../notification-log.js';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const SERVER_CODE = stripComments(SERVER, 'server.ts');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The text between two anchors, so an assertion is about ONE call site and not the file. */
function region(src: string, from: string, to: string, label: string): string {
  const a = src.indexOf(from);
  if (a < 0) { failures++; console.error(`  FAIL region ${label} — anchor not found: ${from}`); return ''; }
  const b = src.indexOf(to, a + from.length);
  if (b < 0) { failures++; console.error(`  FAIL region ${label} — end anchor not found: ${to}`); return ''; }
  return src.slice(a, b);
}

const INTERNAL = 'http://css.railway.internal:3456/';
const GATE = 'https://interego-css-gate.example.com/';
const MINE = 'u-eth-9bf50894ff23';
const THEIRS = 'u-eth-8f3b8e939600';
const ev = (resource: string, type: RecentChange['type'] = 'Add', timestamp = '2026-08-07T04:00:00.000Z'): RecentChange =>
  ({ resource, type, timestamp });

console.log('\nnotification scope — the store is keyed by pod, and both readers name one');

// ── 1. THE ORIGINAL DEFECT, AS A UNIT ────────────────────────────────────────
// One store, two pods, and a read that names one of them.
console.log('\n1. one pod\'s activity does not reach another pod\'s reader');
{
  const logStore = new NotificationLog();
  logStore.record(`${INTERNAL}${MINE}/`, ev(`${INTERNAL}${MINE}/context-graphs/1.ttl`));
  logStore.record(`${INTERNAL}${THEIRS}/`, ev(`${INTERNAL}${THEIRS}/context-graphs/2.ttl`));

  const mine = logStore.recentForPod(`${INTERNAL}${MINE}/`, 10);
  check('my read returns my own event',
    mine.length === 1 && mine[0]!.resource.includes(MINE), JSON.stringify(mine));
  // ★ THE DISCRIMINATING FIELD, and it is the other pod's NAME — not the count. A store that
  // returned two entries would fail the check above; a store that returned ONE entry which
  // happened to be the wrong pod's would pass it. Both have to be asserted or the pair
  // passes for two different reasons.
  check('my read does not name the other pod',
    !JSON.stringify(mine).includes(THEIRS), JSON.stringify(mine));
  const theirs = logStore.recentForPod(`${INTERNAL}${THEIRS}/`, 10);
  // The membership half: a store that returned nothing to anybody would satisfy every
  // leak assertion above and be useless. It must still deliver to the right reader.
  check('their read returns their own event',
    theirs.length === 1 && theirs[0]!.resource.includes(THEIRS), JSON.stringify(theirs));
}

// ── 2. HOST FORMS OF ONE POD ARE ONE POD ─────────────────────────────────────
console.log('\n2. the gate-host and internal-host spellings of one pod share a key');
{
  const logStore = new NotificationLog();
  logStore.record(`${INTERNAL}${MINE}/`, ev('a'));
  const viaGate = logStore.recentForPod(`${GATE}${MINE}/`, 10);
  // Without this, an owner authenticated under one host form reads an empty ring while
  // their events pile up under the other — and the fix presents as "notifications broke".
  check('an event recorded on the internal host is readable on the gate host',
    viaGate.length === 1, JSON.stringify(viaGate));
  check('a trailing slash is not a different pod',
    logStore.recentForPod(`${INTERNAL}${MINE}`, 10).length === 1);
  check('case is not a different pod',
    logStore.recentForPod(`${INTERNAL}${MINE.toUpperCase()}/`, 10).length === 1);
  // …and the negative, or the normaliser could be `() => ''` and every check above passes.
  check('a genuinely different pod is still a different key',
    logStore.recentForPod(`${INTERNAL}${THEIRS}/`, 10).length === 0);
  check('podKey normalises to the path', podKey(`${GATE}${MINE}`) === `/${MINE}/`, podKey(`${GATE}${MINE}`));
}

// ── 3. AN UNKNOWN POD GETS NOTHING, NOT A FALLBACK ───────────────────────────
console.log('\n3. an unknown pod reads empty');
{
  const logStore = new NotificationLog();
  logStore.record(`${INTERNAL}${THEIRS}/`, ev('x'));
  check('a pod with no entries returns []', logStore.recentForPod(`${INTERNAL}u-eth-000000000000/`, 10).length === 0);
  check('an unparseable pod string returns []', logStore.recentForPod('not a url', 10).length === 0);
  check('an empty pod string returns []', logStore.recentForPod('', 10).length === 0);
}

// ── 4. THE LIMIT IS THE MOST RECENT N, OLDEST-FIRST ──────────────────────────
console.log('\n4. the limit takes the most recent N');
{
  const logStore = new NotificationLog();
  for (let i = 1; i <= 8; i++) logStore.record(`${INTERNAL}${MINE}/`, ev(`r${i}`));
  const five = logStore.recentForPod(`${INTERNAL}${MINE}/`, 5);
  check('five are returned', five.length === 5, String(five.length));
  check('they are the LAST five, oldest-first',
    five.map(e => e.resource).join(',') === 'r4,r5,r6,r7,r8', five.map(e => e.resource).join(','));
  check('a limit above the population returns the population',
    logStore.recentForPod(`${INTERNAL}${MINE}/`, 100).length === 8);
  check('a zero limit returns []', logStore.recentForPod(`${INTERNAL}${MINE}/`, 0).length === 0);
  check('a negative limit returns []', logStore.recentForPod(`${INTERNAL}${MINE}/`, -5).length === 0);
  check('a NaN limit returns []', logStore.recentForPod(`${INTERNAL}${MINE}/`, Number.NaN).length === 0);
}

// ── 5. THE READ HANDS BACK A COPY ────────────────────────────────────────────
console.log('\n5. a reader cannot mutate another reader\'s history');
{
  const logStore = new NotificationLog();
  logStore.record(`${INTERNAL}${MINE}/`, ev('a'));
  logStore.record(`${INTERNAL}${MINE}/`, ev('b'));
  const first = logStore.recentForPod(`${INTERNAL}${MINE}/`, 10) as RecentChange[];
  first.reverse();
  first.push(ev('injected'));
  const second = logStore.recentForPod(`${INTERNAL}${MINE}/`, 10);
  check('a mutated result does not reorder the store',
    second.map(e => e.resource).join(',') === 'a,b', second.map(e => e.resource).join(','));
  check('a mutated result cannot inject an entry', second.length === 2, String(second.length));
}

// ── 6. PER-POD CAP ───────────────────────────────────────────────────────────
console.log('\n6. one pod cannot grow without bound');
{
  const logStore = new NotificationLog({ maxPerPod: 4 });
  for (let i = 1; i <= 10; i++) logStore.record(`${INTERNAL}${MINE}/`, ev(`r${i}`));
  const all = logStore.recentForPod(`${INTERNAL}${MINE}/`, 1000);
  check('the ring holds maxPerPod', all.length === 4, String(all.length));
  check('it keeps the NEWEST, not the oldest',
    all.map(e => e.resource).join(',') === 'r7,r8,r9,r10', all.map(e => e.resource).join(','));
}

// ── 7. POD CAP EVICTS LEAST-RECENTLY-WRITTEN ─────────────────────────────────
//
// ★ Keying by pod removed the old global 1024-entry ceiling — one Map entry per pod the
// relay ever emits for — so the cap had to move to the KEYS or the disclosure fix would
// have traded itself for a slow memory leak.
console.log('\n7. the pod table evicts the least-recently-WRITTEN pod');
{
  const logStore = new NotificationLog({ maxPods: 2 });
  logStore.record(`${INTERNAL}pod-a/`, ev('a1'));
  logStore.record(`${INTERNAL}pod-b/`, ev('b1'));
  // pod-a writes again: it is now the most recent, and pod-b is the stale one.
  logStore.record(`${INTERNAL}pod-a/`, ev('a2'));
  logStore.record(`${INTERNAL}pod-c/`, ev('c1'));
  check('the table holds maxPods', logStore.podCount === 2, String(logStore.podCount));
  // A first-seen ("FIFO") eviction would drop pod-a here, which is the busy one. This is the
  // assertion that distinguishes the two policies; without it, deleting the delete-then-set
  // re-insertion in `record` is invisible.
  check('the pod that wrote most recently survives',
    logStore.recentForPod(`${INTERNAL}pod-a/`, 10).length === 2,
    JSON.stringify(logStore.recentForPod(`${INTERNAL}pod-a/`, 10)));
  check('the pod that has gone longest without a write is the one evicted',
    logStore.recentForPod(`${INTERNAL}pod-b/`, 10).length === 0);
  check('the newest pod is present', logStore.recentForPod(`${INTERNAL}pod-c/`, 10).length === 1);
}

// ── 8. THE PROTOTYPE-POLLUTION SEAT A PLAIN OBJECT WOULD HAVE OPENED ─────────
console.log('\n8. a pod key derived from a URL path cannot reach the prototype');
{
  const logStore = new NotificationLog();
  logStore.record(`${INTERNAL}__proto__/`, ev('poison'));
  check('a __proto__-named pod is an ordinary key',
    logStore.recentForPod(`${INTERNAL}__proto__/`, 10).length === 1);
  check('it does not become visible to another pod',
    logStore.recentForPod(`${INTERNAL}${MINE}/`, 10).length === 0);
}

// ── 9. THERE IS NO "GIVE ME EVERYTHING" READ ─────────────────────────────────
//
// The structural half of the fix. A `.filter()` on `/sse` would have closed `/sse` and left
// the array holding every pod's activity for the next reader to forget about.
console.log('\n9. the store offers no unscoped read');
{
  const logStore = new NotificationLog();
  const surface = [
    ...Object.getOwnPropertyNames(logStore),
    ...Object.getOwnPropertyNames(NotificationLog.prototype),
  ];
  const unscoped = surface.filter(k => /^(all|entries|values|toArray|list|dump|slice|getAll)$/.test(k));
  check('no all()/entries()/dump()-shaped accessor exists', unscoped.length === 0, unscoped.join(','));
  check('the store is not iterable',
    (logStore as unknown as Record<symbol, unknown>)[Symbol.iterator] === undefined);
  check('recentForPod is the read', typeof logStore.recentForPod === 'function');
}

// ── 10. THE STORE IN server.ts IS THE KEYED ONE ──────────────────────────────
console.log('\n10. server.ts constructs the keyed store and never a bare array');
{
  check('notificationLog is a NotificationLog',
    /const notificationLog = new NotificationLog\(/.test(SERVER_CODE));
  check('NotificationLog is imported from the module',
    /import \{ NotificationLog \} from '\.\/notification-log\.js';/.test(SERVER_CODE));
  // The exact shape of the defect, pinned so it cannot come back by reversion.
  check('no `let notificationLog: ...[] = []` remains',
    !/notificationLog\s*:\s*\w+\[\]/.test(SERVER_CODE));
  check('nothing pushes onto it as an array', !/notificationLog\.push\(/.test(SERVER_CODE));
  check('nothing slices it as an array', !/notificationLog\.slice\(/.test(SERVER_CODE));
  check('nothing reads its length as an array', !/notificationLog\.length/.test(SERVER_CODE));
}

// ── 11. THE PRODUCER KEEPS THE POD ───────────────────────────────────────────
console.log('\n11. emitNotification records against the pod the event happened on');
{
  const emit = region(SERVER_CODE, 'function emitNotification(', 'const pgslProvenance', 'emitNotification');
  check('it records with podUrl as the key', /notificationLog\.record\(podUrl,/.test(emit), emit.slice(-400));
  // `record(event.descriptorUrl, …)` would typecheck, key on a DESCRIPTOR path, and quietly
  // give every pod a ring of one entry that no owner could ever read. Naming the argument
  // is what makes the difference visible.
  check('it does not key on the descriptor URL', !/notificationLog\.record\(event\./.test(emit));
}

// ── 12. /sse SERVES THIS CONNECTION'S OWN POD ────────────────────────────────
console.log('\n12. GET /sse reads only the connection\'s own pod');
{
  const sse = region(SERVER_CODE, "app.get('/sse'", "app.get('/notifications/:podSlug'", '/sse');
  check('the pod comes from the request\'s verified auth',
    /const ownPodUrl = callerOwnPodFromRequest\(req\);/.test(sse), sse.slice(0, 600));
  check('the read names that pod',
    /notificationLog\.recentForPod\(ownPodUrl, 5\)/.test(sse), sse);
  // ★ THE FAIL-CLOSED BRANCH, bound to the call site. Without it, an unauthenticated-pod
  // connection (the legacy API-key path sets no `req.auth`) would call `recentForPod` with
  // `undefined` — which is empty today by accident of the normaliser, and would stop being
  // empty the day someone made `podKey` tolerant of a missing argument.
  check('no proven pod means no frames',
    /if \(!ownPodUrl\) return;/.test(sse), sse);
  check('the pod is resolved once, outside the interval',
    sse.indexOf('callerOwnPodFromRequest') < sse.indexOf('setInterval'), 'resolution must precede the timer');
}

// ── 13. THE HELPER FAILS CLOSED ──────────────────────────────────────────────
console.log('\n13. callerOwnPodFromRequest returns undefined rather than a default');
{
  const helper = region(SERVER_CODE, 'function callerOwnPodFromRequest(', "app.get('/sse'", 'helper');
  check('no auth extra → undefined', /if \(!extra\) return undefined;/.test(helper), helper);
  check('the identity-authoritative podUrl wins', /if \(extra\.podUrl\) return extra\.podUrl;/.test(helper), helper);
  check('userId is only the reconstruction',
    helper.indexOf('extra.podUrl') < helper.indexOf('extra.userId'), helper);
  check('it never falls back to a pod it invented',
    /return undefined;\s*\}\s*$/.test(helper.trimEnd()), helper.slice(-200));
}

// ── 14. get_pod_status GATES ON PROVEN OWNERSHIP, NOT ON NAMING A POD ────────
//
// ★ THE SECOND READER, AND THE ONE A `/sse`-ONLY FIX WOULD HAVE MISSED. Keying alone is not
// sufficient here: `resolvePodSubject` in this handler is not `targetOnly`, so a caller may
// legitimately resolve SOMEONE ELSE'S pod — and a keyed read would then have handed over
// that pod's activity, correctly keyed and still a disclosure.
console.log('\n14. get_pod_status returns recentNotifications only to the pod\'s owner');
{
  const status = region(SERVER_CODE, 'async function handleGetPodStatus(', 'async function handleSubscribeToPod(', 'get_pod_status');
  check('ownership comes from the proven-pod helper',
    /const ownPodForNotifications = await callerOwnPod\(args\)/.test(status), status.slice(0, 400));
  check('the gate compares canonical pod keys',
    /canonicalPodKey\(ownPodForNotifications\) === canonicalPodKey\(podUrl\)/.test(status), status);
  check('an unproven caller has no ownership',
    /!!ownPodForNotifications\s*\n?\s*&&/.test(status), status);
  check('the read is keyed to the resolved pod',
    /notificationLog\.recentForPod\(podUrl, 10\)/.test(status), status);
  check('it is undefined, not [], when the gate refuses',
    /: undefined;/.test(status.slice(status.indexOf('mayReadActivity'))), status);
  check('the field is spread conditionally into the response',
    /\.\.\.\(recentNotifications \? \{ recentNotifications \} : \{\}\)/.test(status), status);
  // The membership half of §14: a handler that dropped the field entirely would satisfy
  // every leak assertion above. The owner must still get it.
  check('the field still exists for an owner',
    /recentNotifications = mayReadActivity/.test(status), status);
}

// ── 15. THE OTHER FAN-OUTS STAY SCOPED ───────────────────────────────────────
//
// Audited alongside the two readers above: the per-pod SSE channel and the webhook
// registration both run `requireAuthorizedPodUrl`, and the LDN inbox has its own ownership
// gate. Pinned here so a later edit cannot quietly drop one while this file's attention is
// on `notificationLog`.
console.log('\n15. the per-pod channel and the webhook remain pod-authorized');
{
  //
  // ★ THE 4th ARGUMENT IS PART OF THE ASSERTION, NOT NOISE. Both of these read their pod URL out
  // of `podSlugToUrl` — a map the relay filled from CSS_URL — so the value is RELAY-MINTED and
  // must be authorized as ours rather than screened as an attacker's. Screening it is what made
  // this endpoint answer 400 `pod_url_rejected` to every caller while publish_context handed the
  // same URL out as `notifications.sse_url`. Dropping the flag reinstates that, so it is pinned
  // here; the rule itself is tested directly in tests/pod-authorization.test.ts.
  const perPod = region(SERVER_CODE, "app.get('/notifications/:podSlug'", "app.post('/notifications/:podSlug/webhook'", 'per-pod SSE');
  check('/notifications/:podSlug authorizes the pod as relay-minted',
    /requireAuthorizedPodUrl\(req, res, podUrl, true\)/.test(perPod), perPod.slice(0, 800));
  const hook = region(SERVER_CODE, "app.post('/notifications/:podSlug/webhook'", "app.post('/messages'", 'webhook');
  check('webhook registration authorizes the pod as relay-minted',
    /requireAuthorizedPodUrl\(req, res, podUrl, true\)/.test(hook), hook.slice(0, 800));
  check('webhook delivery is keyed by pod',
    /notificationWebhooks\.get\(podUrl\)/.test(SERVER_CODE));
  check('SSE fan-out is keyed by pod slug', /sseSubscribers\.get\(slug\)/.test(SERVER_CODE));
}

// ── 16. THE READER COUNT IS PINNED ───────────────────────────────────────────
//
// ★ THIS IS THE CHECK FOR THE NEXT CONSUMER. The defect was never that one reader forgot to
// filter — it was that the store let every reader decide, and one of the two never did. A
// third `recentForPod` call site is a new disclosure decision, and it should cost a
// deliberate edit to this file rather than nothing at all.
console.log('\n16. exactly two readers, each in a region that authorizes');
{
  const sites = SERVER_CODE.match(/notificationLog\.recentForPod\(/g) ?? [];
  check('there are exactly 2 reads of the store', sites.length === 2,
    `found ${sites.length} — a new reader must add its own authorization and update this count`);
  const writes = SERVER_CODE.match(/notificationLog\.record\(/g) ?? [];
  check('there is exactly 1 write', writes.length === 1, `found ${writes.length}`);
  // Every producer already funnels through emitNotification; assert that stays true, since a
  // producer that recorded directly would bypass the podUrl argument discipline in §11.
  const emitCalls = SERVER_CODE.match(/\bemitNotification\(/g) ?? [];
  check('every producer goes through emitNotification (1 definition + 4 call sites)',
    emitCalls.length === 5, `found ${emitCalls.length}`);
}

console.log(failures === 0
  ? '\nnotification scope: all checks passed'
  : `\nnotification scope: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
