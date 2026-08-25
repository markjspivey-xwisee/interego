/**
 * THE BROWSER ARTIFACT'S OWN SCRIPT: what it publishes, and which run is allowed to write.
 *
 * ★ THE HEADLINE, AND IT IS THE REASON THIS FILE GREW. `channel.html` published PLAINTEXT
 * into private workspaces. Its own `post()`, `saveCanvas()` and `mergeForward()` called the
 * module's writers with no `visibility`, no `shareWith` and no `seal`, so the library's
 * fail-closed guard — which tests `visibility === 'private'` — never fired, because
 * `undefined` is not that. `visibilityFor('entry', undefined ?? 'public')` then published
 * every message and every canvas revision with `acl:Read` for `foaf:Agent`, in a workspace
 * the viewer had declared private, and the panel painted green. `sendInvite()` had made the
 * `recipientsFor` join since it was written; the other three never had.
 *
 * A page that cannot READ the record cannot know the workspace is private, and that is half
 * of why it went unnoticed: the composer gate asked `!!(S.record && !S.record.error)`, which
 * three resolved not-read shapes walk straight through — a head whose body could not be
 * fetched (`{missing:true, unreadable:true}`, no `error` key at all), a forked chain, and a
 * record object that is `withheld`, which is the ORDINARY state for this page on a private
 * workspace because a browser artifact holds no key.
 *
 * ★ AND SEALING MUST NEVER SILENTLY DEGRADE. This page cannot seal at all: sealing needs an
 * opener and there is none here, so what goes out is `share_with` and the RELAY builds the
 * envelope with its own key inside it. That is ESCROW, and it is a state the viewer must
 * SEE. The tests below read the sentence out of the DOM before the write and off the result
 * panel after it, rather than asserting that some flag was set.
 *
 * ★ WHICH RUN MAY WRITE. The page carried a private `S.wsGen` — an IDENTITY guard, bumped
 * when a workspace was torn down — and its comment cited the desktop's `S.wsGen` as the
 * precedent, for a design the desktop had already superseded. Identity alone does not order
 * two folds of the SAME workspace, and the invite panel, the revoke panel and two retry
 * links all re-fold the open one: a reviewer reproduced an older fold landing last and
 * restoring the roster a newer one had replaced. It now holds `WSPC.EpochCounter` from the
 * generated block — the module's own primitive, so this page and the desktop cannot drift —
 * on three subjects: `wsEpoch` (the open workspace), `canvasEpoch` (the canvas document,
 * read from four call sites) and `bootEpoch` (the viewer). `loadCanvas` was outside the old
 * counter altogether.
 *
 * ★ WHAT DID NOT GO WRONG, because a test that overstates its subject is its own defect. On
 * the `foldRoster()`-throws exit the stale counts changed the REASON a private write was
 * refused and never the decision — with `S.members` empty `recipientsFor` refuses either
 * way. No grant was ever written under a stale count. The in-flight fold is the case with
 * teeth, because it restores seats and counts TOGETHER.
 *
 * ★ WHAT IS REAL HERE. The shipping `channel.html`, parsed and executed as a document — its
 * own `S`, `teardownWorkspace()`, `openWorkspace()`, `loadRoster()`, `post()`,
 * `saveCanvas()`, `mergeForward()`, `loadCanvas()`, `checkDelegation()` and
 * `checkAffordance()`, and the real `foldRoster`, `recipientsFor`, `postEntry`, `saveCanvas`
 * and `EpochCounter` out of the generated `@interego/workspace-client` block, none of them
 * re-typed. What is substituted is one level down: `CLIENT`, the page's single substrate
 * client, whose calls are the promises these tests hold open to make the ordering
 * deterministic. So the module folds a real 40-grant scan under its real `GRANT_READ_CAP`
 * of 25, and `publish_context` is inspected exactly as the relay would receive it.
 *
 * The only thing absent is `window.claude`, so `boot()` fails at its first read exactly as it
 * does in a browser opened without a connector; that failure is caught by the page and is not
 * what is under test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(import.meta.dirname, '..');
const ARTIFACT = join(ROOT, 'applications/shared-workspace/artifact/channel.html');
const SOURCE = readFileSync(ARTIFACT, 'utf8');

/** The fold's accounting, as the page holds it. */
interface GrantCounts {
  grantsFound: unknown;
  grantsRead: unknown;
  grantReadCap: unknown;
  unread: number;
  members: number;
}

/** What `recipientsFor` hands back — `why` only on the refusals. */
interface Plan {
  ok: boolean;
  why?: string;
  retryable?: boolean;
  visibility?: string;
  shareWith?: string[];
  sealing?: { mode: string; why: string };
}

/** One recorded substrate call. */
interface Call { name: string; args: Record<string, unknown> }

let dom: JSDOM;

/**
 * `S` is a top-level `const`, so it is in the script's global LEXICAL scope and never becomes
 * a property of `window` — reading it off `dom.window` would answer `undefined` and every
 * assertion below would pass against nothing. An indirect `eval` in the same realm does see
 * it, and the same is true of `wsEpoch` / `canvasEpoch` / `bootEpoch`. Values come back as
 * JSON rather than as live cross-realm objects so a `null` stays a `null` and cannot be
 * confused with an absent property.
 */
const read = <T>(expr: string): T => JSON.parse(String(dom.window.eval('JSON.stringify(' + expr + ')'))) as T;
const run = (stmts: string): void => { dom.window.eval(stmts); };

/**
 * Let the realm's microtasks drain. A resolved fold runs one `currentHead` round per grant it
 * reads, so "the promise I just resolved has finished being handled" is a good many turns
 * away, not one.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const counts = (): GrantCounts => read<GrantCounts>(
  '{ grantsFound: S.grantsFound, grantsRead: S.grantsRead, grantReadCap: S.grantReadCap,'
  + ' unread: (S.rosterUnread || []).length, members: S.members.length }',
);

/** Every `publish_context` the page sent, exactly as the relay would have received it. */
const publishes = (): Call[] => read<Call[]>('(__M.calls || []).filter((c) => c.name === "publish_context")');

/** The arguments of the one `publish_context` a write path should have sent, having first
    established that it sent exactly one. */
const soleArgs = (): Record<string, unknown> => {
  const sent = publishes();
  expect(sent.length, 'expected exactly one publish_context').toBe(1);
  return (sent[0] as Call).args;
};

/**
 * Workspace A: a fold that found more grants than it read, and seated somebody.
 *
 * ★ `S.rosterFolded` IS PART OF THE ARRANGEMENT AND NOT A DETAIL. Seats and counts are what a
 * fold LEFT; the flag is the statement that a fold happened at all, and `writeAudience()` reads
 * a roster only on the strength of it. Arranging the first without the second describes a state
 * the page cannot be in.
 */
const FOLDED_A = 'S.grantsFound = 40; S.grantsRead = 25; S.grantReadCap = 25;'
  + ' S.rosterUnread = [{ graph: "g", pod: "pod-z", kind: "transient", clears: "read-again", why: "the head read did not complete." }];'
  + ' S.grantPod = "pod-a"; S.grantPodDerivedFrom = "wsp:convener in the record";'
  + ' S.members = [{ seated: true, grantedTo: "https://identity.example/a#me", encryptionKey: "k" }];'
  + ' S.rosterFolded = true;'
  + ' S.record = { visibility: "private", regionFound: true, convener: "https://identity.example/a#me" };';

/** Workspace B, as `openWorkspace()` leaves it when `foldRoster()` throws: a record that read
    fine, private, and no roster at all. */
const RECORD_B_ONLY = 'S.record = { visibility: "private", regionFound: true, convener: "https://identity.example/b#me" };';

/**
 * A record good enough for `loadRoster()` to fold from: not error / missing / forked, and
 * naming a convener whose pod the grants are read from.
 */
const RECORD_A = 'S.record = { visibility: "private", regionFound: true, title: "Alpha",'
  + ' convener: "https://css.example/pod-a/profile/card#me", convenerPod: "pod-a" };';

/** The viewer, as `boot()` would have left it had there been a connector to read one from. */
const VIEWER = 'S.viewer = { podName: "pod-me", podUrl: "https://css.example/pod-me/",'
  + ' webId: "https://css.example/pod-me/profile/card#me", css: "https://css.example" };';

/** The viewer's own log, resolved and found — so `post()` has somewhere to append. */
const MY_STREAM = 'S.viewer.stream = "https://css.example/pod-me/pod-a--alpha-stream";'
  + ' S.viewer.streamNaming = "qualified"; S.viewer.streamFound = true; S.viewer.streamUnread = null;';

/** One seated member with a key of their own: the roster that WOULD seal end to end. */
const SEATED_A = 'S.members = [{ seated: true, basis: "answered", pod: "pod-a",'
  + ' grantedTo: "https://css.example/pod-a/profile/card#me", encryptionKey: "kA",'
  + ' stream: "https://css.example/pod-a/pod-a--alpha-stream" }];'
  + ' S.grantsFound = 1; S.grantsRead = 1; S.rosterUnread = []; S.rosterFolded = true;';

/**
 * `CLIENT` stands in for the substrate, and for nothing above it: `foldRoster` and
 * `recipientsFor` are the real module's throughout. `tool` never settles on its own — the
 * test holds `__M.pending` and decides when the scan comes back, which is what makes the
 * ordering under test a fact rather than a hope.
 *
 * 40 grant rows in and `GRANT_READ_CAP` of 25 applied by the module, so the counts under test
 * are 40 found and 25 read.
 *
 * ★ EACH OF THOSE 25 IS ANSWERED WITH A DESCRIPTOR WHOSE SIGNED REGION THE MODULE CAN LOCATE,
 * and that is deliberate rather than decorative. A probe answering with an unreadable head
 * would count 25 under the bundled block's old definition of `grantsRead` and 0 under the
 * current one, which counts the grants whose region was actually read. Handing back a
 * locatable region makes it 25 under both, because it is 25 by either definition. The region
 * names no `wsp:grantedTo`, so no row seats anybody — this measures the page's control flow,
 * not the module's seating rules.
 */
const CLIENT_DEFERRED_SCAN = `
  __M.grantRows = (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push({ describes: [WORKSPACE + "-grant-pod" + i] });
    return out;
  };
  __M.graphOf = (url) => decodeURIComponent(url.slice(url.indexOf("/d/") + 3));
  CLIENT = {
    tool: () => new Promise((res, rej) => { __M.scan = { resolve: res, reject: rej }; }),
    currentHead: (graph) => Promise.resolve({
      url: "https://css.example/pod-a/d/" + encodeURIComponent(graph),
      cid: "bafyProbe",
    }),
    descriptor: (url) => Promise.resolve({
      graph: { content: "<" + __M.graphOf(url) + "> {\\n  <" + __M.graphOf(url) + "> a wsp:MembershipGrant .\\n}\\n" },
      authorship: null,
    }),
    resolveMemberDoc: () => Promise.resolve({ iri: "https://relay.example/x", naming: "qualified", found: false }),
    tx: { label: "probe" },
  };
`;

/**
 * A client that records every tool call and answers `publish_context` with an accepted write
 * that names NO descriptor URL. That last part is what keeps these tests fast: `post()` and
 * `drawSaveOutcome()` only enter their read-back loops — up to 34 × 700 ms — when there is a
 * descriptor to match the head against, and what is under test here is the request, not the
 * confirmation.
 */
const CLIENT_RECORDING = `
  __M.calls = [];
  CLIENT = {
    manifest: () => Promise.resolve([]),
    currentHead: () => Promise.resolve({ url: null, message: "nothing is published at that name" }),
    descriptor: () => Promise.resolve({ graph: { content: "" }, authorship: null }),
    tool: (name, args) => { __M.calls.push({ name: name, args: args }); return Promise.resolve({ status: "accepted" }); },
    tx: { label: "probe", invalidate: () => Promise.resolve() },
  };
`;

beforeAll(async () => {
  // jsdom reports the page's own boot failure as an uncaught error on the virtual console.
  // Swallowed on purpose: without `window.claude` there is nothing for `boot()` to read, and
  // that is the condition this harness wants, not a fault in it.
  const quiet = new VirtualConsole();
  dom = new JSDOM(SOURCE, { runScripts: 'dangerously', url: 'https://artifact.example/', virtualConsole: quiet });
  // ★ LET `boot()` FINISH FAILING BEFORE ANYTHING ELSE HAPPENS. Its rejection is handled by the
  // page, but the handler draws — and it lands a tick or two after the script returns. Closing
  // the window while that is still queued runs `$("stream")` against a torn-down document and
  // throws out of a callback nobody can catch, failing the file for a reason that has nothing
  // to do with what it measures.
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Non-vacuity: if the script had thrown before its declarations landed, everything below
  // would be asserting against an empty realm.
  expect(typeof dom.window.teardownWorkspace, 'the page script did not finish loading').toBe('function');
  expect(typeof dom.window.WSPC, 'the generated workspace-client block did not load').toBe('object');
  // The counters are the module's, not a private re-derivation. If the generated block ever
  // stops exporting one, every ordering assertion below would be measuring a page that no
  // longer compiles rather than one that guards correctly.
  expect(read<string>('typeof WSPC.EpochCounter')).toBe('function');
  expect(read<string>('typeof wsEpoch.begin')).toBe('function');
});

beforeEach(() => {
  // Each test arranges its own state; what it must not inherit is the previous one's.
  dom.window.teardownWorkspace();
  run('globalThis.__M = {}; CLIENT = null; WORKSPACE = null; IRI_OWNER = null; SLUG = null; S.viewer = null;');
  // ★★ AND THE TWO WRITE CONTROLS, WHICH WERE THE ONE PIECE OF DOM STATE NOTHING RESPELT — the
  // reason the gate's coverage below was ORDER-DEPENDENT and landed green over a live defect.
  // One document serves the whole file, `teardownWorkspace()` does not touch these two, and
  // `#send` ships `disabled` in the markup besides — so "the gate shut them" was satisfied for
  // free by the previous test's `post()`, or by the document's own initial state. MEASURED:
  // deleting the `applyWriteGate()` call from `renderConfidentiality()` survived all 61 tests
  // and died only when the headline test was run alone with `-t "fold still in flight"`.
  // Armed LIVE, so a shut control below can only be one this run's code shut; the tests that
  // measure the gate HANDING them back arm the opposite themselves, for the same reason.
  run('$("send").disabled = false; $("composer").disabled = false;');
});

afterAll(() => {
  // The boot checklist arms a 1s setInterval; leaving it running holds the worker open.
  dom?.window.close();
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ★★ WHAT A PRIVATE WORKSPACE ACTUALLY PUBLISHES
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('★★ a private workspace is not published in the clear', () => {
  const privateOpen = (): void => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(RECORD_A);
    run(MY_STREAM);
    run(SEATED_A);
    run(CLIENT_RECORDING);
  };

  it('post() sends visibility private and names the recipients — it used to send neither', async () => {
    privateOpen();
    run('$("composer").value = "the message";');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'post() threw').toBe(null);
    const args = soleArgs();
    // ★ THE ASSERTION THE WHOLE FILE IS FOR. Before the fix this was `"public"`, because the
    // page passed no `visibility` and the module's argument defaults to it. `"shared"` is the
    // RELAY's wire value for a private entry — `visibilityFor("entry", "private")` maps it —
    // and reading the wire word as though it were the page's own is part of how this defect
    // stayed invisible, so the mapping is asserted here rather than paraphrased.
    expect(args.visibility).toBe('shared');
    // …and the recipients, without which the module's own guard refuses the write outright.
    expect(args.share_with).toEqual(['https://css.example/pod-a/profile/card#me']);
    // The body really is in the request — this page cannot seal, which is the next test's
    // subject. What must never be true is that it is there under `visibility: "public"`.
    expect(String(args.graph_content)).toContain('the message');
  });

  it('★ and it SAYS the relay can read it, before the write and on the result', async () => {
    privateOpen();
    // Before: the standing line above the composer. `loadRoster()` re-draws it off the fold
    // it just committed, which is the run that has a roster to answer from.
    run('renderRoster(); renderConfidentiality();');
    const banner = read<string>('$("writes-to").textContent');
    expect(banner).toContain('This workspace is private');
    expect(banner).toContain('holds no key');
    expect(banner).toContain('relay can read this');
    // The canvas panel carries it too — it is the same relay and the same envelope.
    expect(read<string>('$("canvas-where").textContent')).toContain('holds no key');

    // After: the outcome's own sentence, recomputed for THIS write.
    run('$("composer").value = "the message";');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    const panel = read<string>('$("postresult").textContent');
    expect(panel).toContain('NOT end-to-end encrypted');
    expect(panel).toContain('relay can read this');
    // And who it was addressed to, which no panel on this page reported.
    expect(panel).toContain('https://css.example/pod-a/profile/card#me');
  });

  it('★ a member whose acceptance could not be read stops the write rather than degrading it', async () => {
    privateOpen();
    // One seated member with a key, and one whose acceptance 502'd. The module would
    // otherwise have sealed end to end; sealing without the second shuts them out for good
    // and publishing anyway hands the relay everything, so neither is done on an unfinished
    // read. This is the exact state that once turned one 502 into a workspace-wide downgrade.
    run('S.members = S.members.concat([{ seated: false, basis: "unestablished", unreadKind: "transient",'
      + ' pod: "pod-b", grantedTo: "https://css.example/pod-b/profile/card#me",'
      + ' why: "their acceptance could not be resolved: 502 Bad Gateway" }]);');
    run('$("composer").value = "the message";');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    // ★ THE WRITE FIRST, before anything about how the panel reads. A refusal this page
    // walked past does publish — `visibility` arrives at `postEntry` as `undefined`, which
    // is its default for PUBLIC — and it only fails later, on the sealing sentence. Asserting
    // the outgoing call first is what makes the failure say what actually went wrong.
    expect(publishes(), 'a write went out over an unfinished read').toEqual([]);
    expect(read<string | null>('__M.err || null')).toBe(null);
    const panel = read<string>('$("postresult").textContent');
    expect(panel).toContain('Nothing was written');
    expect(panel).toContain('pod-b');
    // Refusals with a real exit offer it; this one clears by re-folding the roster.
    expect(panel).toContain('Read the members list again');
  });

  it('saveCanvas() sends the same two arguments — it used to republish world-readable', async () => {
    privateOpen();
    run('S.canvas.iri = "https://css.example/pod-me/pod-a--alpha-canvas"; S.canvas.head = "bafyOld"; S.canvas.loaded = "bafyOld";');
    run('$("canvas").value = "the document";');
    run('__M.p = saveCanvas(false).catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'saveCanvas() threw').toBe(null);
    const args = soleArgs();
    expect(args.visibility).toBe('shared');
    expect(args.share_with).toEqual(['https://css.example/pod-a/profile/card#me']);
    // ★ WHY THIS ONE IS WORSE THAN AN ENTRY: a canvas save supersedes. Publishing it public
    // retired the sealed head and made the world-readable copy current.
    expect(args.auto_supersede_prior).toBe(true);
  });

  it('mergeForward() does too, and it is the control offered after every 412', async () => {
    privateOpen();
    run('S.canvas.iri = "https://css.example/pod-me/pod-a--alpha-canvas";');
    run('CLIENT.currentHead = () => Promise.resolve({ url: "https://css.example/pod-me/d/x", cid: "bafyTheirs" });');
    run('$("canvas").value = "merged";');
    run('__M.p = mergeForward().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'mergeForward() threw').toBe(null);
    const args = soleArgs();
    expect(args.visibility).toBe('shared');
    expect(args.share_with).toEqual(['https://css.example/pod-a/profile/card#me']);
    expect(args.if_match).toBe('bafyTheirs');
  });

  /**
   * ★★ AND THE CANVAS SAYS IT TOO, ON ITS OWN RESULT PANEL. Two mutants survived every test in
   * this file: applying the escrow correction to the `'entry'` verb ALONE — so a canvas save
   * reports `sealing.mode === 'seal'`, end-to-end encryption this page cannot perform — and
   * deleting the sealing note from `drawSaveOutcome()` outright. The entry's disclosure was
   * measured twice over and the canvas's not at all, which is the shape the last one hid in: a
   * plan field with no UI surface. Both halves are asserted here, the verdict and the sentence
   * the viewer actually meets.
   */
  it('★★ the canvas write discloses the escrow — the verdict AND the panel', async () => {
    privateOpen();
    // The roster WOULD seal end to end: one seated member, and they published a key. What
    // makes this escrow is the page, not the roster, which is why the correction lives in
    // `writeAudience` and why a verb-conditional one is a defect rather than an optimisation.
    const verdict = read<Plan & { keys?: unknown[] }>('writeAudience("canvas")');
    expect(verdict.ok).toBe(true);
    expect(verdict.sealing?.mode, 'the canvas verb reports a seal this page cannot perform').toBe('escrow');
    expect(verdict.sealing?.why).toContain('holds no key');
    // Emptied for the reason the module empties it: a key list beside a mode that is not
    // `seal` is a list somebody will eventually seal from.
    expect(verdict.keys).toEqual([]);

    run('S.canvas.iri = "https://css.example/pod-me/pod-a--alpha-canvas"; S.canvas.head = "bafyOld"; S.canvas.loaded = "bafyOld";');
    // One poll of `awaitHead` answers with a head that moved; the RELOAD that
    // `drawSaveOutcome()` ends with is parked, so the panel under test is the one it drew and
    // not whatever a second read would have replaced it with.
    run('__M.n = 0; CLIENT.currentHead = () => { __M.n += 1;'
      + ' return __M.n === 1 ? Promise.resolve({ url: "https://css.example/pod-me/d/x", cid: "bafyNew" })'
      + ' : new Promise(() => {}); };');
    run('$("canvas").value = "the document";');
    run('__M.p = saveCanvas(false).catch((e) => { __M.err = String((e && e.message) || e); });');
    // `awaitHead` sleeps 700 ms before its first poll and the page passes it no override.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await settle();

    expect(read<string | null>('__M.err || null'), 'saveCanvas() threw').toBe(null);
    const panel = read<string>('$("canvasresult").textContent');
    // Non-vacuity: the accepted branch really did draw. Its heading depends on what the head
    // did, so the row that is always there is the one naming the graph that was written.
    expect(panel, 'the canvas result panel drew no outcome at all')
      .toContain('https://css.example/pod-me/pod-a--alpha-canvas');
    expect(panel, 'the canvas write claims a seal, or discloses nothing').toContain('NOT end-to-end encrypted');
    expect(panel).toContain('holds no key');
    expect(panel).toContain('relay can read this');
    // And who it named, which is the other half of what an escrowed write owes the viewer.
    expect(panel).toContain('https://css.example/pod-a/profile/card#me');
  });

  it('★ and before the roster is folded it says THAT, rather than answering from no seats', () => {
    privateOpen();
    // openWorkspace() draws this as soon as the record settles — which is before
    // `loadRoster()`. Asking the audience here would print the module's honest answer about
    // an EMPTY seat list, "no member of this private workspace resolves to an encryption
    // address", as though it were a finding about the workspace rather than about the fold.
    run('S.rosterFolded = false;');
    run('renderConfidentiality();');
    const banner = read<string>('$("writes-to").textContent');
    expect(banner).toContain('roster has not been folded yet');
    expect(banner).not.toContain('resolves to an encryption address');

    // …and drawn a second time it REPLACES rather than appends, so one write has one sentence.
    run('S.rosterFolded = true; renderRoster(); renderConfidentiality();');
    const after = read<string>('$("writes-to").textContent');
    expect(after).not.toContain('roster has not been folded yet');
    expect(after.split('This workspace is private').length - 1).toBe(1);
  });

  /**
   * ★★ THE CONTROL AND THE COPY BESIDE IT, DRIVEN THROUGH THE REAL `openWorkspace()` WITH THE
   * GRANT SCAN HELD IN FLIGHT — the ordinary first seconds of every private workspace.
   *
   * Measured before the fix: `sendOff: false, composerOff: false` under a banner reading
   * "Nothing is offered to write until it is." Pressing that live Send met "no member of this
   * private workspace resolves to an encryption address", `retryable: false`, no act offered —
   * a positive claim about the membership of a workspace whose roster had not been read.
   */
  it('★★ a private workspace with its fold still in flight offers no write, and says the same thing twice', async () => {
    run(VIEWER);
    run(`CLIENT = {
      resolveMemberDoc: () => Promise.resolve({ iri: "https://relay.example/ns/pod-me/doc", naming: "qualified", found: false }),
      readWorkspaceRecord: () => new Promise((res) => { __M.record = res; }),
      currentHead: () => new Promise(() => {}),
      tool: () => new Promise((res) => { __M.scan = res; }),
      tx: { label: "probe" },
    };`);
    run('__M.o = openWorkspace(RELAY + "/ns/pod-a/alpha").catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.record'), 'the run never reached the record read').toBe(true);
    // ★ NON-VACUITY FOR THE TWO ASSERTIONS BELOW, and the whole reason this test used to pass
    // against a gate that was never called at all: both controls are LIVE at this point, so
    // whatever shuts them is this run's own code. `#send` ships `disabled` in the markup and one
    // document serves the file, which is what made "it is shut" free — see `beforeEach`.
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'),
      'the controls were already shut before the record settled, so shutting them proves nothing')
      .toEqual({ send: false, composer: false });

    run('__M.record({ kind: "record", record: { title: "Alpha", visibility: "private",'
      + ' regionFound: true, convener: "https://css.example/pod-a/profile/card#me", convenerPod: "pod-a" } });');
    await settle();

    // The state under test: the record says private, and `foldRoster`'s grant scan has not
    // come back. Non-vacuity — if the fold had landed there would be nothing to measure.
    expect(read<boolean>('!!__M.scan'), 'the fold never reached the grant scan').toBe(true);
    expect(read<boolean>('S.rosterFolded')).toBe(false);

    const state = read<{ sendOff: boolean; composerOff: boolean; banner: string }>(
      '{ sendOff: $("send").disabled, composerOff: $("composer").disabled, banner: $("writes-to").textContent }',
    );
    expect(state.banner).toContain('Nothing is offered to write until it is');
    // ★ THE TWO ASSERTIONS THE SENTENCE ABOVE WAS FALSE ABOUT.
    expect(state.sendOff, 'Send is live under a banner saying nothing is offered').toBe(true);
    expect(state.composerOff, 'the composer is live under a banner saying nothing is offered').toBe(true);

    // …and the refusal behind the control names the state it is actually in, with an act.
    const plan = read<Plan>('writeAudience("entry")');
    expect(plan.ok).toBe(false);
    expect(plan.why).toContain('no roster has been folded here');
    expect(plan.why).not.toContain('resolves to an encryption address');
    expect(plan.retryable).toBe(true);
  });

  /**
   * ★ AND THE COMPOSER IS HANDED BACK BY THE WORKSPACE THAT OWNS IT. `post()`'s `reopen()` set
   * `disabled = !!S.writeBlocked` and nothing else, and it ran on the path that had just
   * DETECTED the run was stale — so a post belonging to a workspace the viewer had left
   * re-opened the composer of the one now on screen, over whatever that workspace's own
   * record said and over its own write in flight.
   */
  it('★ a post finishing after a switch does not hand back the composer it no longer owns', async () => {
    privateOpen();
    run('$("composer").value = "the message";');
    // The append is held open, so the switch happens with the write genuinely in flight.
    run('CLIENT.tool = (name, args) => { __M.calls.push({ name: name, args: args });'
      + ' return new Promise((res) => { __M.pub = res; }); };');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.pub'), 'the post never reached the append').toBe(true);

    // The switch, and then the state workspace B is really in: readable, folded, offering a
    // write.
    dom.window.teardownWorkspace();
    run('WORKSPACE = RELAY + "/ns/pod-b/beta"; IRI_OWNER = "pod-b"; SLUG = "beta";');
    run(RECORD_A);
    run(SEATED_A);
    // ★ AND THE TEARDOWN DROPPED A'S HOLD, so B's own gate can act — B is not left with a
    // composer a departed post is holding shut for the up to 24 s its readback can take.
    expect(read<boolean>('!!S.writeHeldBy'), 'the workspace being left kept its hold on the controls').toBe(false);
    run('renderConfidentiality();');
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'),
      'the workspace now on screen could not set its own controls').toEqual({ send: false, composer: false });

    // …and now B's OWN post takes them, which is what `post()` does at its first line. Taken
    // through the page's own function rather than by writing the two flags, because a shut
    // control nobody owns is a state this page cannot be in.
    run('__M.heldByB = takeWriteControls("B\'s own post");');

    run('__M.pub({ status: "accepted" });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'post() threw').toBe(null);
    // ★ B's write is still in flight, so B's controls are still locked. A run that no longer
    // owns them must not be the thing that unlocks them — and must not clear B's hold either,
    // which would hand the next fold that lands the same power.
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'))
      .toEqual({ send: true, composer: true });
    expect(read<boolean>('S.writeHeldBy === __M.heldByB'), "A's post released B's hold").toBe(true);
  });

  /**
   * ★★ THE DEFECT THE FIX ABOVE WROTE, DRIVEN TO THE HARM IT DOES.
   *
   * `renderConfidentiality()` ends by applying the write gate, and `loadRoster()` calls
   * `renderConfidentiality()` — so the gate is re-applied every time a fold LANDS, which is
   * `openWorkspace()`'s own `await loadRoster()` on every workspace, plus the invite panel, the
   * revoke panel and two retry links. `post()` holds Send and the composer across its append AND
   * a readback of up to 34 × 700 ms, and the gate knew nothing of a write in flight: MEASURED
   * `{send: false, composer: false}` — both live — with the publish still unresolved.
   *
   * The harm is a second append of ONE message, through the page's own click handler and with no
   * user action needed to reach the state. `postEntry` sends `auto_supersede_prior: false`, so
   * nothing joins the two entries back up and there is no unpublish. The second harm is on the
   * same window: the first post's readback then runs `ta.value = ""` over the box the fold handed
   * back, discarding whatever was typed into it — the loss the comment at that very site says it
   * is protecting against.
   *
   * PUBLIC on purpose. It is the more reachable half: `writeStanding()` offers a write here
   * without consulting a roster at all, so the fold changes nothing about the ANSWER and the
   * re-enable is the gate call itself.
   */
  it('★★ a fold landing during a post does not hand the controls back, and one message is appended once', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run('S.record = { visibility: "public", regionFound: true, title: "Alpha",'
      + ' convener: "https://css.example/pod-a/profile/card#me", convenerPod: "pod-a" };');
    run(MY_STREAM);
    // The real `foldRoster()`'s probes, a `manifest` for `postEntry`, and one `tool` that routes:
    // the append parks on `__M.pub` and the grant scan on `__M.scan`, so the test decides which
    // of the two comes back and when. Both are the real module's throughout.
    run(CLIENT_DEFERRED_SCAN);
    run(`__M.calls = [];
      CLIENT.manifest = () => Promise.resolve([]);
      CLIENT.tool = (name, args) => { __M.calls.push({ name: name, args: args });
        if (name === "publish_context") return new Promise((res) => { __M.pub = res; });
        return new Promise((res) => { __M.scan = { resolve: res }; }); };`);

    // Started through the page's own click handler, so the press further down is the same path
    // and not a second thing this test invented.
    run('$("composer").value = "the message"; $("send").click();');
    await settle();
    expect(read<boolean>('!!__M.pub'), 'the click never reached the append').toBe(true);
    expect(publishes().length, 'the click did not post').toBe(1);
    // Non-vacuity: they were live a moment ago — `beforeEach` arms them so — and this is the
    // operation that shut them.
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'))
      .toEqual({ send: true, composer: true });

    // …and now a fold lands underneath it.
    run('__M.f = loadRoster().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.scan'), 'the fold never reached the grant scan').toBe(true);
    run('__M.scan.resolve({ entries: __M.grantRows(3) });');
    await settle();
    expect(read<boolean>('S.rosterFolded'), 'the fold never landed, so nothing re-drew').toBe(true);
    // The write really is still in flight: this panel is the one `post()` draws before the
    // append and replaces the moment it answers.
    expect(read<string>('$("postresult").textContent'), 'the post finished, so nothing was held')
      .toContain('Deriving your position');

    // ★ THE TWO ASSERTIONS. The controls belong to the write, not to the fold.
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'))
      .toEqual({ send: true, composer: true });
    // ★★ AND THE HARM, through the page's own handler under the composer's own Enter guard.
    run('if (!$("send").disabled) $("send").click();');
    await settle();
    expect(publishes().length, 'one message was appended twice, and nothing joins the two back up').toBe(1);
    // The second harm: the text is still where the person left it, so the readback below has
    // nothing of theirs to discard.
    expect(read<string>('$("composer").value')).toBe('the message');

    // …and when the write finishes it gives them back — to the gate's answer, which is the
    // workspace's own, and not to a plain `false`.
    run('__M.pub({ status: "accepted" });');
    await settle();
    expect(read<string | null>('__M.err || null'), 'loadRoster() threw').toBe(null);
    expect(read<unknown>('{ send: $("send").disabled, composer: $("composer").disabled }'),
      'the post never handed the controls back')
      .toEqual({ send: false, composer: false });
    expect(read<boolean>('!!S.writeHeldBy'), 'the post kept its hold after finishing').toBe(false);
  });

  it('a PUBLIC workspace still publishes in the clear, and says so', async () => {
    privateOpen();
    run('S.record.visibility = "public";');
    run('$("composer").value = "the message";');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    const args = soleArgs();
    // Non-vacuity for the four tests above: the fix did not make everything private.
    expect(args.visibility).toBe('public');
    expect(args.share_with).toBeUndefined();
    run('renderConfidentiality();');
    expect(read<string>('$("writes-to").textContent')).toContain('This workspace is public');
  });
});

describe('★ the invite path asks the RESEAL question, which is a different one', () => {
  it('the record re-seal is not escrow-corrected, and it carries repairBy', () => {
    run(VIEWER);
    run(RECORD_A);
    run(SEATED_A);
    // A grant whose bytes will never be readable: PERMANENT, so the module does not refuse —
    // it hands back the pod to keep in the record's recipients, and `sendInvite` unions it in.
    run('S.grantsFound = 2; S.grantsRead = 1;'
      + ' S.rosterUnread = [{ graph: WORKSPACE + "-grant-pod-b", pod: "pod-b", kind: "permanent",'
      + ' clears: "republish", why: "the relay states nothing is published at that grant IRI." }];');
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha";');

    const reseal = read<Plan & { repairBy?: Array<{ pod: string }> }>('writeAudience("reseal")');
    expect(reseal.ok).toBe(true);
    // ★ NOT escrow. The workspace record is relay-sealed by design — its recipients are chosen
    // before the write — so correcting its mode would be this page inventing a downgrade.
    expect(reseal.sealing?.mode).toBe('unsealed');
    // ★ AND THE UN-BRICKING: the permanently unreadable pod is repaired INTO the recipients
    // rather than refused over, which is what stops the re-seal evicting its holder.
    expect(reseal.repairBy?.map((r) => r.pod)).toEqual(['pod-b']);
  });

  it('an ENTRY over the same roster is not refused by the reseal question', () => {
    run(VIEWER);
    run(RECORD_A);
    run(SEATED_A);
    run('S.grantsFound = 2; S.grantsRead = 1;'
      + ' S.rosterUnread = [{ graph: "g", pod: "pod-b", kind: "permanent", clears: "republish",'
      + ' why: "the relay states nothing is published at that grant IRI." }];');
    // ★ THE VERB DECIDES. An entry evicts nobody — `postEntry` sets
    // `auto_supersede_prior: false` — so a grant it cannot read is reported, not refused.
    const entry = read<Plan>('writeAudience("entry")');
    expect(entry.ok).toBe(true);
    expect(entry.sealing?.mode).toBe('escrow');
  });
});

describe('★ a read that did not complete is not a finding about a member', () => {
  const UNESTABLISHED = 'S.members = [{ seated: false, basis: "unestablished", unreadKind: "transient",'
    + ' pod: "pod-b", graph: "https://relay.example/ns/pod-a/alpha-grant-pod-b",'
    + ' grantedTo: "https://css.example/pod-b/profile/card#me",'
    + ' why: "their acceptance could not be resolved: 502 Bad Gateway" }];';

  it('the roster chip says the seat is not established, not "not seated"', () => {
    run(VIEWER);
    run(RECORD_A);
    run(UNESTABLISHED);
    run('S.grantsFound = 1; S.grantsRead = 1; renderRoster();');
    const pane = read<string>('$("roster").textContent');
    expect(pane).toContain('seat not established');
    expect(pane).not.toContain('not seated');
  });

  it('the revoke panel says so too, and prints the row\'s own reason', () => {
    run(VIEWER);
    run(RECORD_A);
    run(UNESTABLISHED);
    run('renderRevokeList();');
    const pane = read<string>('$("revokelist").textContent');
    // ★ "granted, not accepted" is a positive statement about the member's OWN pod, printed
    // to the convener who is deciding whether to revoke. It was printed for every read that
    // did not complete, and `m.why` — which the roster pane beside it does render — was not.
    expect(pane).toContain('seat not established');
    expect(pane).not.toContain('granted, not accepted');
    expect(pane).toContain('502 Bad Gateway');
  });

  it('a log whose rows this reader cannot interpret has not "written nothing"', () => {
    run(VIEWER);
    run(RECORD_A);
    run('S.members = [{ seated: true, basis: "answered", pod: "pod-b", grantedTo: "https://css.example/pod-b/profile/card#me",'
      + ' stream: "https://css.example/pod-b/log", role: null }];');
    run('S.streamsOpened = true;');
    run('streams.set(streamKey("pod-b", "https://css.example/pod-b/log"),'
      + ' { p: participants()[0], rows: [], error: null, loaded: true, unreadRows: 3 });');
    run('renderStream();');
    const pane = read<string>('$("stream").textContent');
    expect(pane).toContain('no descriptor set this reader can interpret');
    expect(pane).not.toContain('has written nothing to this workspace yet');
  });
});

describe('★ the composer does not open onto a record that was not read', () => {
  /** Every not-read shape `readWorkspaceRecord` can produce, as `openWorkspace()` flattens it. */
  const NOT_READ: Array<[string, string, string]> = [
    ['a head whose body could not be fetched',
      'S.record = { missing: true, unreadable: true, message: "the body could not be fetched: 502" };',
      'the body could not be fetched'],
    ['a forked supersession chain',
      'S.record = { forked: true, message: "3 unresolved heads", heads: [1, 2, 3] };',
      'unresolved heads'],
    ['a record published encrypted to somebody else',
      'S.record = { regionFound: false, withheld: true, visibility: "unknown", sealedReadFailed: "no key for this identity" };',
      'not among its recipients'],
    ['a descriptor with no signed region for this workspace',
      'S.record = { regionFound: false, withheld: false, visibility: "unknown" };',
      'not found inside it'],
  ];

  it.each(NOT_READ)('%s leaves nothing offered to write', (_name, arrange, phrase) => {
    run(VIEWER);
    run(arrange);
    // ★ NOT ONE OF THESE CARRIES AN `error` KEY, which is the whole of what the old gate
    // asked. Each read as settled, the composer opened, and post() published in the clear.
    expect(read<boolean>('!!(S.record && !S.record.error)'), 'this shape no longer needs the fix').toBe(true);
    expect(read<string | null>('recordUnread()')).toContain(phrase);
    // And the write path refuses in the module's own terms rather than defaulting to public.
    const plan = read<Plan>('writeAudience("entry")');
    expect(plan.ok).toBe(false);
    expect(plan.why).toContain('whether it is private is not established');
  });

  it('a record that WAS read offers the composer — so the four above are refusals', () => {
    run(VIEWER);
    run(RECORD_A);
    run(SEATED_A);
    expect(read<string | null>('recordUnread()')).toBe(null);
    expect(read<Plan>('writeAudience("entry")').ok).toBe(true);
  });

  /**
   * ★ WHICH REFUSAL AN UNREAD RECORD MEETS, pinned because `teardownWorkspace()` carries a
   * comment about it and the comment was measured FALSE. It read: "such a record carries no
   * visibility, so recipientsFor short-circuits to public and never reads the counts at all"
   * — which states the plaintext defect D7 closed as though it were current behaviour. What
   * happens is that `recordUnread()` answers, `writeAudience` passes `'unknown'`, and the
   * module refuses at its FIRST branch, before a roster or a count is looked at.
   */
  it('★ a stale count from a previous fold is not quoted at an unread record', () => {
    // Workspace A's fold, still standing — which is the state the comment is about.
    run(FOLDED_A);
    run('S.record = { missing: true, unreadable: true, message: "the body could not be fetched: 502" };');
    expect(counts().grantsFound, 'the counts under test are not there').toBe(40);

    const plan = read<Plan>('writeAudience("entry")');
    expect(plan.ok).toBe(false);
    // The `'unknown'` arm, not the public one and not a count.
    expect(plan.why).toContain('whether it is private is not established');
    expect(plan.why).not.toContain('40');
    expect(plan.why).not.toContain('grants');
    expect(plan.visibility, 'a visibility was resolved for a record nobody read').toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// WHICH RUN MAY WRITE
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('switching workspaces cannot carry the previous one\'s grant counts across', () => {
  it('teardownWorkspace() clears the fold\'s accounting, and where it read the grants', () => {
    run(FOLDED_A);
    expect(counts()).toEqual({ grantsFound: 40, grantsRead: 25, grantReadCap: 25, unread: 1, members: 1 });
    expect(read<unknown>('[S.grantPod, S.grantPodDerivedFrom]')).toEqual(['pod-a', 'wsp:convener in the record']);

    dom.window.teardownWorkspace();

    expect(counts()).toEqual({ grantsFound: 0, grantsRead: 0, grantReadCap: null, unread: 0, members: 0 });
    // The pod the grants were read from is the same class of fact and the same defect:
    // renderRoster() prints it as "Grants below were read from pod X".
    expect(read<unknown>('[S.grantPod, S.grantPodDerivedFrom]')).toEqual([null, null]);
  });

  it('★ the refusal a private write meets is about the workspace being refused', () => {
    // First, that the harness can see the defect at all. With A's counts in hand the module
    // really does refuse in those numbers — so the absence asserted afterwards is an absence
    // and not a check that could never have fired.
    run(FOLDED_A);
    run('S.members = [];');
    const stale = read<Plan>('writeAudience("entry")');
    expect(stale.ok).toBe(false);
    expect(stale.why).toContain('40 grants');

    // Now `openWorkspace()`'s order, with the fold's exit taken: teardown, then B's record,
    // and no roster because `foldRoster()` threw before one existed.
    dom.window.teardownWorkspace();
    run(RECORD_B_ONLY);
    const plan = read<Plan>('writeAudience("entry")');

    // Still refused — that was never in question, and this fix does not change it.
    expect(plan.ok).toBe(false);
    // ★★ AND REFUSED FOR THE STATE B IS ACTUALLY IN. This read "no member of this private
    // workspace resolves to an encryption address" — a positive finding about B's MEMBERSHIP,
    // reached from `seats: S.members || []` passed for a fold that never ran. An empty array
    // is a claim that somebody read the roster; not having folded is the absence of one, and
    // the two license opposite sentences. See `S.rosterFolded`.
    expect(plan.why).toContain('no roster has been folded here');
    expect(plan.why, 'the absence of a fold is being reported as a finding about the members')
      .not.toContain('resolves to an encryption address');
    // …and it names an act, where the fabricated version named none.
    expect(plan.why).toContain('Retry the members read');
    expect(plan.retryable, 'a refusal nothing can clear, for a read that has not happened').toBe(true);
    // ★ THE ASSERTION THIS PAIR EXISTS FOR. Not "the copy differs" — that the numbers A's fold
    // arrived at appear nowhere in a sentence about B.
    expect(plan.why).not.toContain('40');
    expect(plan.why).not.toContain('pod-z');
  });

  /**
   * ★ THE CONTROL FOR THE PAIR ABOVE, so "no roster has been folded" is not simply what this
   * page now says to everybody. A fold that LANDED and seats nobody is a finding about the
   * workspace, and it is still stated as one.
   */
  it('★ a fold that landed and seats nobody still says so — the flag is not a blanket', () => {
    run(FOLDED_A);
    run('S.members = [];');
    const plan = read<Plan>('writeAudience("entry")');
    expect(plan.ok).toBe(false);
    expect(plan.why).toContain('no member of this private workspace resolves to an encryption address');
    expect(plan.why).not.toContain('no roster has been folded here');
  });
});

describe('a fold for the workspace the viewer left cannot land in the one they opened', () => {
  /** Park the real `loadRoster()` on the real `foldRoster()`'s grant scan. */
  const startFold = (): void => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(RECORD_A);
    run(CLIENT_DEFERRED_SCAN);
    run('__M.p = loadRoster().catch((e) => { __M.err = String((e && e.message) || e); });');
  };

  it('the same fold, with nobody switching away, does assign — so the absence below is one', async () => {
    startFold();
    await settle();
    expect(read<boolean>('!!__M.scan'), 'the fold never reached the grant scan').toBe(true);

    run('__M.scan.resolve({ entries: __M.grantRows(40) });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'loadRoster() threw').toBe(null);
    // 40 found, 25 read: the module's own GRANT_READ_CAP applied to the 40 rows above.
    expect(read<unknown>('{ found: S.grantsFound, readN: S.grantsRead, cap: S.grantReadCap,'
      + ' members: S.members.length }')).toEqual({ found: 40, readN: 25, cap: 25, members: 25 });
    expect(read<string>('S.grantPod')).toBe('pod-a');
    // And the page really would quote that shortfall at a private write.
    expect(read<Plan>('writeAudience("entry")').why).toContain('40 grants');
  });

  /**
   * ★ THE SENTENCE ABOVE THE COMPOSER IS ABOUT THIS ROSTER. `openWorkspace()` draws it as
   * soon as the record settles, which is before any fold exists, so the fold has to draw it
   * again — and so does every RE-fold, because a member joining or being revoked changes who
   * a write here is encrypted to.
   */
  it('★ the confidentiality line is re-drawn off the fold that decides it', async () => {
    startFold();
    run('renderConfidentiality();');
    expect(read<string>('$("writes-to").textContent')).toContain('roster has not been folded yet');
    await settle();

    run('__M.scan.resolve({ entries: __M.grantRows(40) });');
    await settle();

    const line = read<string>('$("writes-to").textContent');
    expect(line, 'loadRoster() did not re-draw it').not.toContain('roster has not been folded yet');
    // 25 rows folded and none of them seats anybody — the probe's region names no
    // `wsp:grantedTo` — so the honest answer about THIS roster is that there is nobody to
    // encrypt to, and it is now said as a finding about a fold that happened.
    expect(line).toContain('nothing is offered to write into it yet');
  });

  it('★ a fold in flight when the viewer switches away assigns nothing', async () => {
    startFold();
    await settle();
    expect(read<boolean>('!!__M.scan'), 'the fold never reached the grant scan').toBe(true);

    // The switch: `openWorkspace()` for the next workspace begins with exactly this call.
    dom.window.teardownWorkspace();
    run(RECORD_B_ONLY);

    // …and only now does A's scan come back.
    run('__M.scan.resolve({ entries: __M.grantRows(40) });');
    await settle();

    expect(read<string | null>('__M.err || null'), 'loadRoster() threw').toBe(null);
    expect(counts()).toEqual({ grantsFound: 0, grantsRead: 0, grantReadCap: null, unread: 0, members: 0 });
    expect(read<unknown>('[S.grantPod, S.grantPodDerivedFrom]')).toEqual([null, null]);
    const plan = read<Plan>('writeAudience("entry")');
    expect(plan.ok).toBe(false);
    expect(plan.why).not.toContain('40');
  });

  it('★ and a fold that FAILS in flight does not draw its failure over the open workspace', async () => {
    startFold();
    await settle();

    dom.window.teardownWorkspace();
    // What the workspace the viewer actually opened has drawn into the roster pane.
    run('clear($("roster")).appendChild(el("div", "note", "PANE BELONGS TO B"));');

    run('__M.scan.reject(new Error("the convener\'s pod did not answer"));');
    await settle();

    expect(read<string | null>('__M.err || null'), 'loadRoster() threw').toBe(null);
    expect(read<string>('$("roster").textContent')).toBe('PANE BELONGS TO B');
  });

  /**
   * ★★ THE ORDERING AXIS, WHICH THE IDENTITY GUARD NEVER HAD. Nobody switches workspace
   * here: two folds of the SAME one, which is what the invite panel, the revoke panel and
   * both retry links produce. Under `S.wsGen` the two shared a generation and the older
   * landing last restored the roster the newer had already replaced — a revoked member back
   * on the list, with the live watches openStreams() opens for each seat.
   */
  it('★★ an older fold of the SAME workspace landing last assigns nothing', async () => {
    startFold();
    await settle();
    const first = read<{ resolve: boolean }>('{ resolve: !!__M.scan }');
    expect(first.resolve, 'the first fold never reached the grant scan').toBe(true);
    run('__M.scanA = __M.scan; __M.scan = null;');

    // The second fold, of the same workspace — no teardown, no switch.
    run('__M.p2 = loadRoster().catch((e) => { __M.err2 = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.scan'), 'the second fold never reached the grant scan').toBe(true);

    // The NEWER one comes back first and seats 25.
    run('__M.scan.resolve({ entries: __M.grantRows(40) });');
    await settle();
    expect(read<number>('S.members.length')).toBe(25);

    // …and only now the OLDER one, with a different roster.
    run('__M.scanA.resolve({ entries: __M.grantRows(3) });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<string | null>('__M.err2 || null')).toBe(null);
    // ★ 25, not 3. Under an identity-only guard this read 3 — the older fold's roster, and
    // its counts, written over the newer one's.
    expect(read<unknown>('{ found: S.grantsFound, readN: S.grantsRead, members: S.members.length }'))
      .toEqual({ found: 40, readN: 25, members: 25 });
  });
});

describe('the per-member checks the fold fires cannot repaint a workspace that was left', () => {
  const MEMBER = '__M.m = { seated: true, pod: "pod-x", memberAgent: "did:key:zProbe",'
    + ' podBase: "https://css.example/pod-x/" };';

  /** `verify_agent` for one member, held open, stamped with the fold's own Epoch. */
  const startDelegation = (): void => {
    run(VIEWER);
    run(RECORD_A);
    run(MEMBER);
    run('CLIENT = { tool: () => new Promise((res) => { __M.verify = res; }), tx: { label: "probe" } };');
    run('__M.e = wsEpoch.begin();');
    run('__M.d = checkDelegation(__M.m, __M.e).catch((e) => { __M.err = String((e && e.message) || e); });');
  };

  /** The member's capability document, held open. */
  const startAffordance = (): void => {
    run(VIEWER);
    run(RECORD_A);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(MEMBER);
    run('CLIENT = { resolveMemberDoc: () => new Promise((res) => { __M.doc = res; }), tx: { label: "probe" } };');
    run('__M.e = wsEpoch.begin();');
    run('__M.a = checkAffordance(__M.m, __M.e).catch((e) => { __M.err = String((e && e.message) || e); });');
  };

  it('checkDelegation() assigns and repaints when nobody switched away', async () => {
    startDelegation();
    await settle();
    run('__M.verify({ enforcement: { scope: "pod" }, verified: true });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ enf: !!__M.m.enforcement, verified: __M.m.verified, rendered: S.rosterRendered }'))
      .toEqual({ enf: true, verified: true, rendered: true });
  });

  it('★ checkDelegation() landing after the switch assigns nothing and draws nothing', async () => {
    startDelegation();
    await settle();
    dom.window.teardownWorkspace();
    run('__M.verify({ enforcement: { scope: "pod" }, verified: true });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ enf: !!__M.m.enforcement, verified: __M.m.verified === undefined, rendered: S.rosterRendered }'))
      .toEqual({ enf: false, verified: true, rendered: false });
  });

  /**
   * ★ AND AFTER A NEWER FOLD OF THE SAME WORKSPACE, which is the half the identity guard
   * could not see. These close over the row object, so they went on mutating rows
   * `S.members` no longer holds and repainting the roster pane off them.
   */
  it('★ checkDelegation() landing after a NEWER FOLD of the same workspace assigns nothing', async () => {
    startDelegation();
    await settle();
    run('wsEpoch.begin();');   // exactly what the next loadRoster() does
    run('__M.verify({ enforcement: { scope: "pod" }, verified: true });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ enf: !!__M.m.enforcement, rendered: S.rosterRendered }'))
      .toEqual({ enf: false, rendered: false });
  });

  it('checkAffordance() reports what it read when nobody switched away', async () => {
    startAffordance();
    await settle();
    run('__M.doc({ iri: "https://relay.example/ns/pod-x/doc", naming: "qualified", found: false,'
      + ' error: "the pod did not answer" });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ note: !!__M.m.affordanceNote, rendered: S.rosterRendered }'))
      .toEqual({ note: true, rendered: true });
  });

  it('★ checkAffordance() landing after the switch assigns nothing and draws nothing', async () => {
    startAffordance();
    await settle();
    dom.window.teardownWorkspace();
    run('__M.doc({ iri: "https://relay.example/ns/pod-x/doc", naming: "qualified", found: false,'
      + ' error: "the pod did not answer" });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ note: !!__M.m.affordanceNote, rendered: S.rosterRendered }'))
      .toEqual({ note: false, rendered: false });
  });

  /**
   * ★ AN UNFINISHED CHECK IS NOT A PUBLISHED ABSENCE. `loadRoster()` fires these unawaited,
   * so after any re-fold the flags are unset because nothing has been asked yet — and the
   * panel stated that as a finding about other people's pods.
   */
  it('★ "nobody published a way to be asked" is not said while the reads are in flight', async () => {
    run(VIEWER);
    run(SEATED_A);
    run('S.members[0].pod = "pod-a";');
    run('__M.p = askEveryMemberWhoOfferedTo().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    const pending = read<string>('$("agentresult").textContent');
    expect(pending).toContain('not established yet');
    expect(pending).not.toContain('has published a way to be asked');

    // Once the check HAS finished and found nothing, the flat statement is honest.
    run('S.members[0].affordanceChecked = true;');
    run('__M.p2 = askEveryMemberWhoOfferedTo().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<string>('$("agentresult").textContent')).toContain('Nobody here has published a way to be asked');
  });
});

describe('openWorkspace() reads for the workspace it was called for, or for nothing', () => {
  /**
   * The two `resolveMemberDoc` calls answer at once and the record read is held open, so the
   * run parks exactly where `S.record` — which carries the VISIBILITY every private write is
   * decided on — is about to be assigned.
   */
  const startOpenParkedOnRecord = (): void => {
    run(VIEWER);
    run(`CLIENT = {
      resolveMemberDoc: () => Promise.resolve({ iri: "https://relay.example/ns/pod-me/doc", naming: "qualified", found: false }),
      readWorkspaceRecord: () => new Promise((res) => { __M.record = res; }),
      currentHead: () => new Promise(() => {}),
      tool: () => new Promise(() => {}),
      tx: { label: "probe" },
    };`);
    run('__M.o = openWorkspace(RELAY + "/ns/pod-a/alpha").catch((e) => { __M.err = String((e && e.message) || e); });');
  };

  const RECORD_ANSWER = '__M.record({ kind: "record", record: { title: "Alpha", visibility: "private",'
    + ' regionFound: true, convener: "https://css.example/pod-a/profile/card#me", convenerPod: "pod-a" } });';

  it('the record it read is the record it holds, when nobody switched away', async () => {
    startOpenParkedOnRecord();
    await settle();
    expect(read<boolean>('!!__M.record'), 'the run never reached the record read').toBe(true);

    run(RECORD_ANSWER);
    await settle();

    expect(read<unknown>('S.record && S.record.title')).toBe('Alpha');
    expect(read<unknown>('S.record && S.record.visibility')).toBe('private');
  });

  it('★ a record arriving after the viewer switched away is not adopted', async () => {
    startOpenParkedOnRecord();
    await settle();
    expect(read<boolean>('!!__M.record'), 'the run never reached the record read').toBe(true);

    dom.window.teardownWorkspace();
    run(RECORD_ANSWER);
    await settle();

    // ★ Not "a different record" — none. Adopting A's would have told the private-write path
    // that the workspace on screen is private, or public, on a read of a different workspace.
    expect(read<unknown>('S.record')).toBe(null);
    expect(read<unknown>('S.recordResult')).toBe(null);
  });

  it('★ the viewer\'s own stream IRI is not overwritten by the workspace they left', async () => {
    run(VIEWER);
    run(`CLIENT = {
      resolveMemberDoc: () => new Promise((res) => { __M.doc = res; }),
      readWorkspaceRecord: () => new Promise(() => {}),
      tx: { label: "probe" },
    };`);
    run('__M.o = openWorkspace(RELAY + "/ns/pod-a/alpha").catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.doc'), 'the run never reached the stream read').toBe(true);

    dom.window.teardownWorkspace();
    // What the workspace the viewer actually opened put there. `S.viewer` survives a teardown
    // — it is the person, not the workspace — which is exactly why a late write into it is
    // not undone by anything.
    run('S.viewer.stream = "https://css.example/pod-me/BELONGS-TO-B";');

    run('__M.doc({ iri: "https://css.example/pod-me/pod-a--alpha-stream", naming: "qualified", found: true });');
    await settle();

    // ★ `S.viewer.stream` is where a post lands when the viewer holds no seat on the roster
    // (`sIri` in the send handler), so A's answer arriving here would put B's next message in
    // A's log.
    expect(read<string>('S.viewer.stream')).toBe('https://css.example/pod-me/BELONGS-TO-B');
  });

  /**
   * ★★ THE SECOND `resolveMemberDoc`, WHICH THE OLD FILE COVERED ONLY BY A TEXT GATE. A lens
   * moved this guard one line past the three assignments it protects and all 23 shipped tests
   * still passed: the source-shape rule saw a guard after the await and asked nothing about
   * what it stood in front of. `S.canvas.iri` is the IRI the Create control publishes to.
   */
  it('★★ the canvas IRI is not overwritten by the workspace the viewer left', async () => {
    run(VIEWER);
    run(`__M.n = 0;
      CLIENT = {
        resolveMemberDoc: () => {
          __M.n += 1;
          if (__M.n === 1) return Promise.resolve({ iri: "https://css.example/pod-me/A-stream", naming: "qualified", found: true });
          return new Promise((res) => { __M.canvasDoc = res; });
        },
        readWorkspaceRecord: () => new Promise(() => {}),
        tx: { label: "probe" },
      };`);
    run('__M.o = openWorkspace(RELAY + "/ns/pod-a/alpha").catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.canvasDoc'), 'the run never reached the canvas read').toBe(true);

    dom.window.teardownWorkspace();
    run('S.canvas.iri = "https://css.example/pod-me/BELONGS-TO-B-canvas"; S.canvas.naming = "legacy"; S.canvas.found = true;');

    run('__M.canvasDoc({ iri: "https://css.example/pod-me/A-canvas", naming: "qualified", found: false, error: "the pod did not answer" });');
    await settle();

    expect(read<unknown>('{ iri: S.canvas.iri, naming: S.canvas.naming, found: S.canvas.found, unread: S.canvas.nameUnread }'))
      .toEqual({
        iri: 'https://css.example/pod-me/BELONGS-TO-B-canvas', naming: 'legacy', found: true, unread: null,
      });
  });

  /**
   * ★ `found: false` HAS THREE CAUSES AND THE PAGE KEPT ONE FLAG. The relay STATING nothing
   * is published licenses Create; a probe that did not complete does not, because the real
   * document may be living under the name whose probe failed and Create publishes a second.
   */
  it('★ a naming probe that did not complete is not an absence', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    // A workspace whose record WAS read and whose roster WAS folded, so what this measures is
    // the naming probe and not the confidentiality refusal one panel over.
    run(RECORD_A);
    run(SEATED_A);
    run('S.canvas.iri = "https://css.example/pod-me/pod-a--alpha-canvas";'
      + ' S.canvas.found = false; S.canvas.nameUnread = "the pod did not answer";');
    run('CLIENT = { currentHead: () => Promise.resolve({ url: null, message: "nothing is published at that name" }), tx: { label: "probe" } };');
    run('__M.p = loadCanvas(true, canvasEpoch.begin()).catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    // Not "Create on your pod".
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled }'))
      .toEqual({ label: 'Save', off: true });
    expect(read<string>('$("canvasresult").textContent')).toContain('Where this document lives is not established');

    // Control: with the absence STATED, Create is offered.
    run('S.canvas.nameUnread = null;');
    run('__M.p2 = loadCanvas(true, canvasEpoch.begin()).catch((e) => { __M.err2 = String((e && e.message) || e); });');
    await settle();
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled }'))
      .toEqual({ label: 'Create on your pod', off: false });
  });

  /**
   * ★ AND THE POST PATH MAKES THE SAME DISTINCTION, because with no seat on the roster the
   * entry is appended to `S.viewer.stream`.
   */
  it('★ post() will not create a log at a name chosen because a probe failed', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(RECORD_A);
    run(SEATED_A);
    run(CLIENT_RECORDING);
    run('S.viewer.stream = "https://css.example/pod-me/pod-a--alpha-stream";'
      + ' S.viewer.streamFound = false; S.viewer.streamUnread = "the pod did not answer";');
    run('$("composer").value = "the message";');
    run('__M.p = post().catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(publishes()).toEqual([]);
    expect(read<string>('$("postresult").textContent')).toContain('Where your log lives is not established');
  });
});

describe('the canvas is read on its own schedule, and lands for the workspace it read', () => {
  const startCanvasRead = (): void => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    // The record and the fold, because the absent branch asks `writeAudience("canvas")` — a
    // Create offered over a workspace whose confidentiality is not established is the defect
    // one describe down. What is under test here is which READ lands, not which write is
    // offered, so the write is arranged to be offered.
    run(RECORD_A);
    run(SEATED_A);
    run('S.canvas.iri = "https://css.example/pod-me/A-canvas";');
    run('CLIENT = { currentHead: () => new Promise((res) => { __M.head = res; }), tx: { label: "probe" } };');
    run('__M.e = canvasEpoch.begin();');
    run('__M.c = loadCanvas(true, __M.e).catch((e) => { __M.err = String((e && e.message) || e); });');
  };

  it('the read lands when nobody switched away — so the absence below is one', async () => {
    startCanvasRead();
    await settle();
    expect(read<boolean>('!!__M.head'), 'the read never reached the head').toBe(true);

    run('__M.head({ url: null, message: "nothing is published at that name" });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled, msg: !!S.canvas.absentMessage }'))
      .toEqual({ label: 'Create on your pod', off: false, msg: true });
  });

  /**
   * ★ THE REPRODUCED DEFECT. `loadCanvas(true)` is fired unawaited by `openWorkspace()` and
   * was outside the page's counter altogether: A's read landed after the switch, set
   * `S.canvas.absentMessage`, flipped Save from disabled to enabled, relabelled it "Create on
   * your pod" and titled it with the NEW workspace's canvas IRI. One press published this
   * workspace's unsaved text into that one, and there is no unpublish.
   */
  it('★ a canvas read landing after the switch does not touch the Save control', async () => {
    startCanvasRead();
    await settle();

    dom.window.teardownWorkspace();
    // What the workspace the viewer actually opened has left there.
    run('S.canvas.iri = "https://css.example/pod-me/B-canvas";');
    run('$("save").disabled = true; $("save").textContent = "Save"; $("save").title = "B has not been read yet";');

    run('__M.head({ url: null, message: "nothing is published at that name" });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled, title: $("save").title,'
      + ' msg: S.canvas.absentMessage }'))
      .toEqual({ label: 'Save', off: true, title: 'B has not been read yet', msg: null });
  });

  /**
   * ★ AND THE ATTEMPT AXIS: two canvas reads of the SAME workspace are alternatives — a
   * save's reload racing the "Discard mine, reload theirs" control — and only the newest may
   * commit. This is why the canvas holds a counter of its own rather than sharing the
   * workspace's: `begin()` on that one inside `openWorkspace()` would supersede the roster
   * fold `openWorkspace()` then awaits.
   */
  it('★ an older canvas read of the same document does not overwrite a newer one', async () => {
    startCanvasRead();
    await settle();
    run('__M.headA = __M.head; __M.head = null;');

    run('__M.e2 = canvasEpoch.begin();');
    run('__M.c2 = loadCanvas(true, __M.e2).catch((e) => { __M.err2 = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.head'), 'the second read never reached the head').toBe(true);

    // The newer read finds a document that exists and cannot be created over.
    run('CLIENT.descriptor = () => Promise.resolve({ graph: { content: "" }, authorship: null });');
    run('__M.head({ url: "https://css.example/pod-me/d/x", cid: "bafyNew" });');
    await settle();
    expect(read<string>('S.canvas.head')).toBe('bafyNew');

    // …and only now the OLDER one, which read an absence.
    run('__M.headA({ url: null, message: "nothing is published at that name" });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    expect(read<unknown>('{ head: S.canvas.head, exists: S.canvas.exists, label: $("save").textContent }'))
      .toEqual({ head: 'bafyNew', exists: true, label: 'Save' });
  });

  /**
   * ★ CREATE IS A WRITE, SO IT ASKS THE WRITE PATH. The absent branch re-derived
   * confidentiality privately — `!S.record || S.record.visibility !== 'private'` — and drove
   * the editor placeholder and the Save title off it. On an unread record the two readers
   * disagreed: this one offered "press Create — that publishes this text to your pod as a
   * public graph anyone can read" in a state where `writeAudience` refuses outright. A second
   * reader of one question is a defect even where both agree; these did not.
   */
  it('★ Create is not offered over a record nobody read, and does not promise a public publish', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run('S.record = { missing: true, unreadable: true, message: "the body could not be fetched: 502" };');
    run('S.canvas.iri = "https://css.example/pod-me/pod-a--alpha-canvas";');
    run('CLIENT = { currentHead: () => Promise.resolve({ url: null, message: "nothing is published at that name" }), tx: { label: "probe" } };');
    run('__M.p = loadCanvas(true, canvasEpoch.begin()).catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();

    expect(read<string | null>('__M.err || null')).toBe(null);
    const shown = read<{ label: string; off: boolean; placeholder: string; panel: string }>(
      '{ label: $("save").textContent, off: $("save").disabled, placeholder: $("canvas").placeholder,'
      + ' panel: $("canvasresult").textContent }',
    );
    expect(shown.off, 'Create is live over a workspace whose confidentiality is not established').toBe(true);
    expect(shown.label).toBe('Save');
    expect(shown.placeholder, 'the editor promises a publication the write path refuses')
      .not.toContain('public graph anyone can read');
    // The refusal is the module's own, in its words, so the two surfaces cannot drift apart.
    expect(shown.panel).toContain('could not be read here');

    // Control: with the record read and the roster folded, Create IS offered — and it names
    // the encryption rather than defaulting to the public sentence.
    run(RECORD_A);
    run(SEATED_A);
    run('__M.p2 = loadCanvas(true, canvasEpoch.begin()).catch((e) => { __M.err2 = String((e && e.message) || e); });');
    await settle();
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled }'))
      .toEqual({ label: 'Create on your pod', off: false });
    expect(read<string>('$("canvas").placeholder')).toContain('encrypted to this workspace\'s members');
  });

  /**
   * ★★ THE SAVE'S STAMP IS TAKEN BEFORE THE WRITE, AND THIS ONE COST A DOCUMENT.
   *
   * `drawSaveOutcome()` ended with `canvasEpoch.begin()` minted after everything it awaited. A
   * stamp minted last is current by construction, so it ordered nothing and cancelled whatever
   * was in flight: a save belonging to a workspace the viewer had LEFT superseded the newly
   * opened workspace's own canvas read. Reproduced — B was left with an EMPTY editor while
   * `S.canvas.head` held B's real head and Save was live and titled with it. One press
   * published `dct:description ""` at B's canvas with a MATCHING `if_match` and
   * `auto_supersede_prior`, so the relay accepted it rather than answering 412.
   */
  it('★★ a canvas save answering after the switch neither draws into the new workspace nor cancels its read', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(RECORD_A);
    run(SEATED_A);
    run(CLIENT_RECORDING);
    run('S.canvas.iri = "https://css.example/pod-me/A-canvas"; S.canvas.head = "bafyA"; S.canvas.loaded = "bafyA";');
    // A's append is held open; B's canvas read is held open separately, keyed on which
    // document is being read, so the two can be answered in the order under test.
    run('CLIENT.tool = (name, args) => { __M.calls.push({ name: name, args: args });'
      + ' return new Promise((res) => { __M.pub = res; }); };');
    run('CLIENT.currentHead = (iri) => {'
      + ' if (String(iri).indexOf("B-canvas") >= 0) {'
      + '   if (!__M.headB) return new Promise((res) => { __M.headB = res; });'
      + '   return new Promise(() => {});'
      + ' }'
      + ' return Promise.resolve({ url: "https://css.example/pod-me/d/a-moved", cid: "bafyMoved" }); };');
    run('$("canvas").value = "A\'s document";');
    run('__M.p = saveCanvas(false).catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.pub'), 'the save never reached the append').toBe(true);

    // The switch, and B's own canvas read started by its `openWorkspace()`.
    dom.window.teardownWorkspace();
    run('WORKSPACE = RELAY + "/ns/pod-b/beta"; IRI_OWNER = "pod-b"; SLUG = "beta";');
    run(RECORD_A);
    run(SEATED_A);
    run('S.canvas.iri = "https://css.example/pod-me/B-canvas";');
    run('__M.eB = canvasEpoch.begin();');
    run('__M.b = loadCanvas(true, __M.eB).catch((e) => { __M.errB = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.headB'), 'B never reached its own canvas read').toBe(true);

    // …and only now A's save answers. One `awaitHead` poll of 700 ms sits inside it.
    run('__M.pub({ status: "accepted" });');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await settle();

    expect(read<string | null>('__M.err || null'), 'saveCanvas() threw').toBe(null);
    // ★ A's outcome is not drawn into B's shell, and A's save does not claim B's document
    // exists. `S.canvas.exists` is set by the accepted branch before anything else it does.
    expect(read<unknown>('{ exists: S.canvas.exists, panel: $("canvasresult").textContent }'))
      .toEqual({ exists: false, panel: '' });

    // ★ AND B'S OWN READ STILL COMMITS. This is the half the mint made worse: B's read was
    // dropped by B's own guard because A's save had superseded it.
    run('__M.headB({ url: null, message: "nothing is published at that name" });');
    await settle();

    expect(read<string | null>('__M.errB || null')).toBe(null);
    expect(read<unknown>('{ label: $("save").textContent, off: $("save").disabled, msg: !!S.canvas.absentMessage }'))
      .toEqual({ label: 'Create on your pod', off: false, msg: true });
  });

  /**
   * ★ AND THE MERGE, WHICH ADOPTS A HEAD OF ITS OWN BEFORE IT DRAWS. `S.canvas.head` is what
   * the Save control asserts as `if_match`; a head read for the workspace the viewer left,
   * adopted here, points the OPEN workspace's Save at another document's revision — the same
   * hazard `drawSaveOutcome()` carries, one call earlier and with nothing between it and the
   * button.
   */
  it('★ a merge answering after the switch adopts no head and draws no panel', async () => {
    run(VIEWER);
    run('WORKSPACE = RELAY + "/ns/pod-a/alpha"; IRI_OWNER = "pod-a"; SLUG = "alpha";');
    run(RECORD_A);
    run(SEATED_A);
    run(CLIENT_RECORDING);
    run('S.canvas.iri = "https://css.example/pod-me/A-canvas"; S.canvas.head = "bafyA"; S.canvas.loaded = "bafyA";');
    // The merge's own head read answers first; every later call is `awaitHead` polling, and it
    // must report a head that MOVED or the module keeps polling for 40 × 700 ms and this test
    // measures a merge that never finished.
    run('__M.n = 0; CLIENT.currentHead = () => { __M.n += 1; return Promise.resolve(__M.n === 1'
      + ' ? { url: "https://css.example/pod-me/d/theirs", cid: "bafyTheirs" }'
      + ' : { url: "https://css.example/pod-me/d/moved", cid: "bafyMoved" }); };');
    run('CLIENT.tool = (name, args) => { __M.calls.push({ name: name, args: args });'
      + ' return new Promise((res) => { __M.pub = res; }); };');
    run('$("canvas").value = "merged";');
    run('__M.p = mergeForward().then(() => { __M.done = true; }).catch((e) => { __M.err = String((e && e.message) || e); });');
    await settle();
    expect(read<boolean>('!!__M.pub'), 'the merge never reached the resend').toBe(true);

    dom.window.teardownWorkspace();
    run('S.canvas.iri = "https://css.example/pod-me/B-canvas"; S.canvas.head = "bafyB"; S.canvas.loaded = "bafyB";');

    run('__M.pub({ status: "accepted" });');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await settle();

    expect(read<string | null>('__M.err || null'), 'mergeForward() threw').toBe(null);
    // Non-vacuity: the merge really did finish, so what follows is a decision and not a wait.
    expect(read<boolean>('!!__M.done'), 'the merge never came back').toBe(true);
    // ★ B's revision, not the head A's merge resolved — and no outcome drawn into B's panel.
    expect(read<unknown>('{ head: S.canvas.head, loaded: S.canvas.loaded, panel: $("canvasresult").textContent }'))
      .toEqual({ head: 'bafyB', loaded: 'bafyB', panel: '' });
  });
});

describe('teardownWorkspace() leaves nothing of the workspace behind', () => {
  it('★ the editor is emptied, not only S.canvas', () => {
    run(VIEWER);
    run('S.canvas.iri = "https://css.example/pod-me/A-canvas"; S.canvas.naming = "qualified";'
      + ' S.canvas.found = true; S.canvas.absentMessage = "nothing published"; S.canvas.exists = true;');
    run('$("canvas").value = "MY UNSAVED TEXT"; $("save").disabled = false; $("save").textContent = "Create on your pod";');

    dom.window.teardownWorkspace();

    // ★ The box and the control together. `loadCanvas()`'s `absent` branch returns before the
    // line that would replace the editor's contents, so text left here stayed under a live
    // Create button now aimed at a DIFFERENT workspace's canvas IRI.
    expect(read<unknown>('{ box: $("canvas").value, off: $("save").disabled, label: $("save").textContent }'))
      .toEqual({ box: '', off: true, label: 'Save' });
    expect(read<unknown>('{ iri: S.canvas.iri, naming: S.canvas.naming, found: S.canvas.found,'
      + ' unread: S.canvas.nameUnread, msg: S.canvas.absentMessage, exists: S.canvas.exists }'))
      .toEqual({ iri: null, naming: null, found: false, unread: null, msg: null, exists: false });
  });

  /**
   * ★ THE BODY QUEUE, which outlived every other piece of a workspace. `S.bodies` is replaced
   * and `streams` is cleared, and the queue was module state nothing emptied — so the
   * previous workspace's descriptor URLs drained into the NEW workspace's map, every one of
   * them with `body: null`, because `ownerStreamOf` iterates the streams just cleared.
   */
  it('★ the body queue is drained, and a read already in flight does not land in the new map', async () => {
    run(VIEWER);
    run('__M.hold = []; CLIENT = { descriptor: (u) => new Promise((res) => { __M.hold.push({ url: u, res: res }); }), tx: { label: "probe" } };');
    // Five rows: four go out at once (the pump's concurrency is 4), the fifth stays queued.
    run('queueBodies([{ url: "https://css.example/pod-a/d/1" }, { url: "https://css.example/pod-a/d/2" },'
      + ' { url: "https://css.example/pod-a/d/3" }, { url: "https://css.example/pod-a/d/4" },'
      + ' { url: "https://css.example/pod-a/d/5" }]);');
    await settle();
    expect(read<number>('__M.hold.length'), 'the pump never started').toBe(4);

    dom.window.teardownWorkspace();
    // The queued fifth is gone…
    expect(read<number>('queue.length')).toBe(0);

    // …and the four already in flight land into nothing.
    run('__M.hold.forEach((h) => h.res({ graph: { content: "" }, authorship: null }));');
    await settle();
    expect(read<number>('S.bodies.size'), 'a previous workspace\'s record was cached into the new map').toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE STRUCTURAL HALF
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * ★ WHAT A TEXT GATE CAN AND CANNOT DO, stated because the previous version of this file got
 * it wrong. It substituted a source-shape rule for behavioural coverage at seven of fourteen
 * guard sites, and a lens then moved `openWorkspace()`'s canvas guard one line PAST the three
 * assignments it protects: every rule below still passed, because "there is a guard after
 * this await" says nothing about what the guard stands in front of. That case is now driven
 * through jsdom above ("the canvas IRI is not overwritten"), and so is every other one whose
 * commit decides a write.
 *
 * What survives here is the rule a behavioural test genuinely cannot express: that a LATER
 * EDIT adding an await to one of these functions does not leave it unguarded. That is how the
 * defect was written the first time, and it is a claim about the source, not about a run.
 */
describe('every await on the record-and-roster path re-reads its Epoch', () => {
  /** A top-level function's source, from its signature to the `}` in column 0 that ends it. */
  const fnBody = (signature: string): string => {
    const at = SOURCE.indexOf('\n' + signature);
    expect(at, 'channel.html no longer declares `' + signature + '`').toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\n}\n', at);
    expect(end, '`' + signature + '` has no closing brace in column 0').toBeGreaterThan(at);
    return SOURCE.slice(at + 1, end + 2);
  };

  /**
   * Comments and string bodies blanked, line structure kept, so `\bawait\b` in prose is not
   * mistaken for one in code — several of the comments this fix added use the word.
   *
   * It does not track regular-expression literals. The one regex in these functions is
   * `/^https:\/\//` in `openWorkspace()` and `post()`, whose trailing `//` blanks the
   * remainder of a line that carries no await, no catch and no guard.
   */
  const blank = (src: string): string => {
    let out = '';
    let i = 0;
    let mode = 'code';
    let quote = '';
    while (i < src.length) {
      const c = src[i];
      const two = src.slice(i, i + 2);
      if (mode === 'code') {
        if (two === '/*') { mode = 'block'; out += '  '; i += 2; continue; }
        if (two === '//') { mode = 'line'; out += '  '; i += 2; continue; }
        if (c === '"' || c === '\'' || c === '`') { mode = 'str'; quote = c; out += ' '; i += 1; continue; }
        out += c; i += 1; continue;
      }
      if (mode === 'block') {
        if (two === '*/') { mode = 'code'; out += '  '; i += 2; continue; }
        out += (c === '\n' ? '\n' : ' '); i += 1; continue;
      }
      if (mode === 'line') {
        if (c === '\n') { mode = 'code'; out += '\n'; i += 1; continue; }
        out += ' '; i += 1; continue;
      }
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { mode = 'code'; out += ' '; i += 1; continue; }
      out += (c === '\n' ? '\n' : ' '); i += 1;
    }
    return out;
  };

  /** Signature → the exact guard statement that function is required to use. */
  const GUARDED: Array<[string, string]> = [
    ['async function openWorkspace(iri) {', 'if (!wsEpoch.sameSubject(e)) return;'],
    ['async function loadRoster() {', 'if (!wsEpoch.current(e)) return;'],
    ['async function checkAffordance(m, e) {', 'if (!wsEpoch.current(e)) return;'],
    ['async function checkDelegation(m, e) {', 'if (!wsEpoch.current(e)) return;'],
  ];

  it.each(GUARDED)('%s guards every await it makes', (signature, guard) => {
    const lines = blank(fnBody(signature)).split('\n');
    const awaits = lines.map((l, i) => ({ l, i })).filter((x) => /\bawait\b/.test(x.l)).map((x) => x.i);
    const guards = new Set(lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() === guard).map((x) => x.i));

    expect(awaits.length, signature + ' awaits nothing, so this rule is measuring nothing').toBeGreaterThan(0);
    awaits.forEach((a, n) => {
      const next = awaits[n + 1] ?? lines.length;
      const covered = [...guards].some((g) => g > a && g < next);
      expect(covered, signature + ' — the await on line ' + (a + 1) + ' of the function is not '
        + 'followed by `' + guard + '` before the next one').toBe(true);
    });
  });

  it.each(GUARDED)('%s guards every catch it opens', (signature, guard) => {
    const lines = blank(fnBody(signature)).split('\n');
    const catches = lines.map((l, i) => ({ l, i })).filter((x) => /^\s*\}?\s*catch\s*\(/.test(x.l)).map((x) => x.i);

    expect(catches.length, signature + ' catches nothing, so this rule is measuring nothing').toBeGreaterThan(0);
    catches.forEach((c) => {
      const after = lines.slice(c + 1).find((l) => l.trim() !== '');
      expect((after ?? '').trim(), signature + ' — the catch on line ' + (c + 1) + ' of the function '
        + 'does not open with `' + guard + '`').toBe(guard);
    });
  });

  /**
   * ★★ MINTING IS NOT INTERROGATING, and this is the rule a run genuinely cannot express.
   * `begin()` takes a NEW attempt and supersedes every older one; `current()` asks about one
   * already taken. A `begin()` written after the awaits it is meant to guard is current by
   * construction — it cannot answer no — so it orders nothing and cancels whatever else is in
   * flight. That is how `drawSaveOutcome()` came to supersede the newly opened workspace's own
   * canvas read with a save from the workspace the viewer had left. The behavioural half is
   * driven above; this is the claim about the source, which is where the mistake is made.
   *
   * TWO RULES, AND WHAT EACH IS WORTH:
   *  · `drawSaveOutcome` is HANDED a stamp and its first statement asks it. "First statement"
   *    is stricter than the hazard — inserting a harmless local read above the guard trips it
   *    — and that strictness is the point: this file already watched a lens move a guard one
   *    line past the assignments it protected while every softer rule stayed green.
   *  · its two callers take the stamp BEFORE the write they are about to make. A stamp taken
   *    afterwards is current by construction and orders nothing.
   *
   * Neither rule forbids a `canvasEpoch.begin()` inside a CLICK HANDLER — "Discard mine,
   * reload theirs" mints one and is right to: a person starting a fresh read is a fresh
   * attempt. That is why the rule is about where the guard and the mint STAND rather than a
   * ban on the word.
   */
  it('a canvas write takes its stamp before the write, and the panel is handed one', () => {
    const draw = blank(fnBody('async function drawSaveOutcome(out, btn, ifMatch, audience, e) {')).split('\n');
    const first = draw.slice(1).find((l) => l.trim() !== '');
    expect((first ?? '').trim(), 'drawSaveOutcome no longer opens by asking whether its save is still the one on screen')
      .toBe('if (!canvasEpoch.current(e)) return;');

    (['async function saveCanvas(useStale) {', 'async function mergeForward() {'] as const).forEach((signature) => {
      const body = blank(fnBody(signature));
      const mint = body.indexOf('canvasEpoch.begin()');
      const firstAwait = body.search(/\bawait\b/);
      expect(mint, signature + ' takes no canvas stamp at all, so its write is ordered by nothing').toBeGreaterThan(-1);
      expect(firstAwait, signature + ' awaits nothing, so this rule is measuring nothing').toBeGreaterThan(-1);
      expect(mint, signature + ' mints its stamp after an await, where it can only ever be current')
        .toBeLessThan(firstAwait);
    });
  });

  /**
   * ★ THE COUNTERS ARE THE MODULE'S. The page held a private `S.wsGen` and cited the desktop
   * as the precedent for it; the whole point of adopting `EpochCounter` is that the artifact
   * and the desktop receive one implementation, so a re-derived counter is the defect
   * returning under another name.
   */
  it('the page re-derives no counter of its own', () => {
    const script = SOURCE.slice(SOURCE.indexOf('/* ══ END GENERATED'));
    expect(script).toContain('const wsEpoch = new WSPC.EpochCounter();');
    expect(script).toContain('const canvasEpoch = new WSPC.EpochCounter();');
    expect(script).toContain('const bootEpoch = new WSPC.EpochCounter();');
    expect(script, 'the hand-rolled generation counter is back').not.toContain('S.wsGen++');
    expect(script, 'the hand-rolled generation counter is back').not.toContain('wsGen: 0,');
  });

  it('teardownWorkspace() bumps both workspace axes and clears what a fold left behind', () => {
    const body = fnBody('function teardownWorkspace() {');
    // Without the bumps nothing above can tell one workspace from the next.
    expect(body).toContain('wsEpoch.bumpSubject();');
    expect(body).toContain('canvasEpoch.bumpSubject();');
    [
      'S.grantsFound = 0;', 'S.grantsRead = 0;', 'S.grantReadCap = null;', 'S.rosterUnread = [];',
      'S.grantPod = null;', 'S.grantPodDerivedFrom = null;', 'dropQueuedBodies();',
      // ★ AND THE HOLD ON THE WRITE CONTROLS. Without this the workspace being opened cannot set
      // its own composer while a post for the workspace being LEFT is still holding it shut —
      // up to the 24 s that post's readback can take.
      'S.writeHeldBy = null;',
    ].forEach((stmt) => { expect(body, 'teardownWorkspace() no longer does it').toContain(stmt); });
  });

  /**
   * ★★ ONE OWNER FOR SEND AND THE COMPOSER. The behavioural tests above prove that the two
   * operations which exist today do not fight over these controls; this is the rule for the
   * third somebody adds. Every write of either control's `disabled` in the page's own script
   * stands inside one of four functions, and each answers a different question: the gate (what
   * is OFFERED), `takeWriteControls` (a write is in flight and holds them), `applyWriteVerdict`
   * (the relay's sticky verdict about this agent) and `paneFailure` (the read the whole channel
   * is waiting on failed). `post()` used to set them itself, which is how a fold landing came to
   * overrule a write in flight and append one message twice.
   *
   * ITS BLIND SPOT, SAID RATHER THAN LEFT UNSAID: `post()` holds the composer in a local (`ta`),
   * so the ban names that alias too — but any OTHER alias walks past this rule. It is a claim
   * about the shape of the file, and the driven tests above are what measure the behaviour.
   */
  it('★ Send and the composer are written in one place, and taken in another', () => {
    // `blank()` cannot serve here: it blanks STRING BODIES too, and these two controls are
    // named by string — `$("send")` comes back as `$(      )`, indistinguishable from
    // `$("save")`. What has to go is the comments, since a sentence quoting the code is not a
    // write. The `[^:]` keeps a `//` inside an http(s) string from reading as one.
    const decomment = (src: string): string => src
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const script = decomment(SOURCE.slice(SOURCE.indexOf('/* ══ END GENERATED')));
    const CONTROL = /(?:\$\("(?:send|composer)"\)|\bta)\.disabled\s*=/g;
    const all = (script.match(CONTROL) ?? []).length;
    expect(all, 'nothing writes these two controls at all, so this rule is measuring nothing')
      .toBeGreaterThan(0);
    const owned = [
      'function applyWriteGate() {', 'function takeWriteControls(who) {',
      'function applyWriteVerdict(why) {', 'function paneFailure(err, where, again) {',
    ].reduce((n, signature) => n + (decomment(fnBody(signature)).match(CONTROL) ?? []).length, 0);
    expect(owned, 'a write to Send or the composer stands outside the four functions that own them')
      .toBe(all);

    // ★ AND `post()` TAKES THEM RATHER THAN SETTING THEM, which is the whole of the fix: a
    // control it sets is one the gate can set back.
    const posted = decomment(fnBody('async function post() {'));
    expect(posted.match(CONTROL) ?? [], 'post() sets the controls it is supposed to be taking').toEqual([]);
    expect(posted, 'post() no longer takes the controls it holds across its write')
      .toContain('takeWriteControls(');
  });

  /**
   * ★★ NO WRITER MAY DECIDE CONFIDENTIALITY FOR ITSELF. The behavioural tests at the top
   * prove the four call sites that exist today pass the right thing; this is the rule for the
   * fifth somebody adds. Every `visibility:` in the page's own script comes from an audience
   * `writeAudience()` resolved, and `writeAudience` is the only caller of `recipientsFor`.
   */
  it('the page has exactly one join to recipientsFor, and every writer goes through it', () => {
    const script = SOURCE.slice(SOURCE.indexOf('/* ══ END GENERATED'));
    const joins = script.split('WSPC.recipientsFor(').length - 1;
    expect(joins, 'a second caller of recipientsFor appeared; there is one audience or there are two policies').toBe(1);
    // Every `visibility:` argument in the page's own script is the resolved one.
    const visibilities = script.match(/^\s*visibility: .*$/gm) ?? [];
    expect(visibilities.length, 'no writer passes a visibility any more').toBeGreaterThan(0);
    visibilities.forEach((line) => {
      expect(line.trim(), 'a writer decides its own visibility').toBe('visibility: audience.visibility,');
    });
    // Four writers name their recipients: post(), saveCanvas(), mergeForward() — the three
    // that used to pass nothing — and sendInvite(), which always did.
    expect(script.split('shareWith: audience.shareWith,').length - 1,
      'a writer stopped naming its recipients, or a fifth appeared without doing so').toBe(4);
    // ★ AND THE RESEAL CARRIES THE REPAIR. Passing the verb without passing `repairBy` turns
    // the module's refusal into a silent eviction: where a grant is PERMANENTLY unreadable the
    // reseal does not refuse, it hands back the pods to keep, and only sendInvite can use them.
    expect(script, 'sendInvite() takes the reseal verb without the repair it depends on')
      .toContain('repairBy: audience.repairBy,');
  });
});
