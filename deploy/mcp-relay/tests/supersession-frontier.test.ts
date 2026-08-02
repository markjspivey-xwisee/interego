#!/usr/bin/env tsx
/**
 * The supersession frontier — which descriptors are the CURRENT heads of a chain.
 *
 * ★ WHY THIS EXISTS. `publish_context`'s `if_match` compared the caller's assertion
 * against `descriptor.supersedes`, which under `auto_supersede_prior` holds EVERY prior
 * version of the graph. Membership in that list is not a compare-and-swap: an ancestor
 * satisfies it forever. Observed live against production, on a chain v0 → v1:
 *
 *     publish v2 with if_match = v0   →   { published: true, precondition: { passed: true } }
 *
 * Two writers who both read v1 both succeed, and the second overwrites a state it never
 * read. Worse than an absent guard: the response asserts that the swap was atomic, so a
 * caller checking the field it was told to check is told the wrong thing.
 *
 * `get_current_head` — the READ half of the same CAS — had the frontier right all along.
 * The halves now share this function so they cannot hold separate opinions about which
 * descriptor is the head.
 *
 * ★ TWO MORE HOLES IN THE SAME FIX, found by a later adversarial review and covered here:
 *
 *   1. The frontier was computed only when `graph_iri` was present, and a missing
 *      `currentHeads` means "no head check requested" downstream — so omitting one
 *      argument restored the membership test. `graph_iri` is `required` in the tool
 *      schema, but `tools/call` does no schema validation, so the schema was never the
 *      guard. `classifyCasRequest` / `casRefusal` make "cannot be evaluated" a 400
 *      instead of a silence.
 *
 *   2. `normalizeCssUrl` — the `normalize` this function is handed in production —
 *      matched `livelysky-<hex>` but substituted ONE hard-coded deployment id, so two
 *      genuinely different URLs compared equal and a citation naming one deployment
 *      retired the other's head.
 *
 * ★ A THIRD ROUND, from a second adversarial review, on the fix itself:
 *
 *   3. The frontier took an `exclude`, and its value came from `descriptor_id` — a
 *      caller-supplied argument. Excluding an entry removes it as a candidate head AND as
 *      a source of supersedes edges, so a stale writer could name the live head, watch its
 *      ancestor become a head again, and pass a CAS against it in ONE request. The same
 *      line refused a legitimate republisher from the other side: reuse one descriptor_id
 *      and you exclude your own only entry, `heads` is `[]`, and no if_match can ever be a
 *      member of the empty set.
 *
 *   4. The auto-supersede self-filter compared `descriptor_id` (a urn) against manifest
 *      entries (https URLs), so it never fired — a descriptor with a stable id lands in
 *      its own supersedes list and the chain reports no head from then on.
 *
 *   5. A publish with no precondition decides `supersedes` from a manifest snapshot and
 *      writes from a deferred task that queues behind later arrivals, so it links a state
 *      that has already moved and FORKS the chain.
 *
 * ★ Mutation-checked, each mutation applied and the suite re-run, then reverted:
 *   frontier —    every entry treated as a head (the original defect) 13 failures
 *                 `describes` filter dropped                           2
 *                 a non-describing entry allowed to retire a head      2
 *                 the normaliser ignored                               1
 *                 the `exclude` option re-added                        1
 *   graph_iri —   `ungraphed` collapsed back into `evaluable`          4
 *                 the `ungraphed` refusal envelope removed             4
 *   host —        the hard-coded single-deployment host restored       3
 *                 the trailing `(\/|$)` host anchor dropped            1
 *   collision —   `casSelfOverwriteRefusal` never refuses              8
 *                 `casSelfOverwriteRefusal` always refuses             2
 *   self-filter — `priorVersionsFor` keeps the descriptor's own URL     3
 *                 it compares raw strings instead of normalised ones    1
 *   re-decide —   `reDecidedSupersedes` never re-decides               4
 *                 it re-decides even when nothing moved                 1
 *
 * ★ NOT covered, and no test here can cover it: that the `reDecidedSupersedes` call sits
 *   INSIDE the mutex acquisition that performs the deferred write rather than just before
 *   it. That is a fact about `handlePublishContext`, which starts an HTTP listener on
 *   import. The decision is pinned here; its placement is reviewed, not tested.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/supersession-frontier.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import {
  supersessionFrontier, classifyIfMatch, classifyCasRequest, casRefusal,
  priorVersionsFor, reDecidedSupersedes, casSelfOverwriteRefusal, type FrontierEntry,
} from '../supersession-frontier.js';
import { normalizeCssUrl } from '../url-rewrite.js';

/**
 * Verbatim behaviour of `predictDescriptorUrl` + `slugFromIri`
 * (packages/solid/src/client.ts:154-179), reproduced here rather than imported so this
 * suite stays a single-file `tsx` run with no build of the solid package.
 *
 * It is reproduced AT ALL because it is the attacker's lever: `descriptor_id` is a
 * caller-supplied `publish_context` argument, and this function turns it into the exact
 * descriptor URL the relay will compare against the manifest.
 */
function predictDescriptorUrl(podUrl: string, descriptorId: string): string {
  const last = descriptorId.split(/[/:#]/).filter(Boolean).pop() ?? 'descriptor';
  return `${podUrl}context-graphs/${encodeURIComponent(last)}.ttl`;
}

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string): void {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}`);
  }
}

const G = 'https://relay.example/ws/alpha/stream/alice';
const OTHER = 'https://relay.example/ws/alpha/stream/bob';
const d = (n: number) => `https://pod.example/u/context-graphs/${n}.ttl`;

/** v0 ← v1 ← v2, written the way auto_supersede_prior writes them: each links ALL priors. */
const CHAIN: FrontierEntry[] = [
  { descriptorUrl: d(0), describes: [G] },
  { descriptorUrl: d(1), describes: [G], supersedes: [d(0)] },
  { descriptorUrl: d(2), describes: [G], supersedes: [d(1), d(0)] },
];

function main(): void {
  // eslint-disable-next-line no-console
  console.log('\nthe frontier of a linear chain');

  const f = supersessionFrontier(CHAIN, G);
  ok(f.heads.length === 1 && f.heads[0] === d(2), 'exactly one head, and it is the newest version');
  ok(f.superseded.length === 2, 'both ancestors are reported as superseded, not dropped');
  ok(f.all.length === 3, 'all three remain in `all` — superseded is not deleted');

  // ★ The defect, stated as an assertion. v0 IS in v2's supersedes list, which is why the
  // old membership test passed it. It must not be in the frontier.
  ok(!f.heads.includes(d(0)), '★ a superseded ancestor is NOT a head — this is the whole fix');
  ok(!f.heads.includes(d(1)), '★ the immediately-prior version is not a head either');

  // eslint-disable-next-line no-console
  console.log('\nscoping');

  ok(
    supersessionFrontier([...CHAIN, { descriptorUrl: d(9), describes: [OTHER] }], G).all.length === 3,
    'entries describing a different graph are not in this chain at all',
  );

  // A descriptor for an unrelated graph that happens to cite this one has not taken over
  // this chain. Letting it retire a head would let an unrelated publish silently
  // invalidate a live CAS token held by a writer who is doing nothing wrong.
  ok(
    supersessionFrontier(
      [...CHAIN, { descriptorUrl: d(9), describes: [OTHER], supersedes: [d(2)] }],
      G,
    ).heads[0] === d(2),
    'a citation from OUTSIDE this graph does not retire its head',
  );

  // There is no `exclude` option any more, and its absence is the fix for two defects at
  // once — see the `descriptor_id` section below. What replaced it is asserted there.

  // eslint-disable-next-line no-console
  console.log('\nforks are reported, never resolved by guessing');

  const forked = supersessionFrontier(
    [...CHAIN, { descriptorUrl: d(3), describes: [G], supersedes: [d(1), d(0)] }],
    G,
  );
  // Two writers both superseded v1. Neither supersedes the other, so both are heads.
  // Picking one here would be a storage layer guessing which write survived — the same
  // reason the roster fold reports divergence rather than applying last-write-wins.
  ok(forked.heads.length === 2, '★ two concurrent writers leave TWO heads, both reported');
  ok(
    forked.heads.includes(d(2)) && forked.heads.includes(d(3)),
    'both forked heads are named, so a caller can see the divergence and repair it',
  );

  // eslint-disable-next-line no-console
  console.log('\nhost-form normalisation');

  // Manifest entries and iep:supersedes targets can carry either the internal-FQDN host
  // or the legacy public one. Compared raw, no superseder is found and every ancestor
  // looks live — which on the write path is exactly the hole this fix closes, and on the
  // read path reports a healthy chain as forked.
  const INTERNAL = 'http://css.railway.internal:3456/u/context-graphs/';
  const PUBLIC = 'https://pod.example/u/context-graphs/';
  const normalize = (u: string) => u.replace(PUBLIC, INTERNAL);
  // v0 was registered under the public host; v1 cites it under the internal one.
  const mixed: FrontierEntry[] = [
    { descriptorUrl: `${PUBLIC}0.ttl`, describes: [G] },
    { descriptorUrl: `${INTERNAL}1.ttl`, describes: [G], supersedes: [`${INTERNAL}0.ttl`] },
  ];
  ok(
    supersessionFrontier(mixed, G, { normalize }).heads.length === 1,
    '★ a head written under the other host form is still recognised as superseding',
  );
  ok(
    supersessionFrontier(mixed, G).heads.length === 2,
    'without a normaliser the same chain looks forked — which is why one is threaded through',
  );

  // eslint-disable-next-line no-console
  console.log('\nedges');

  ok(supersessionFrontier([], G).heads.length === 0, 'an empty manifest has no heads');
  ok(
    supersessionFrontier([{ descriptorUrl: d(0), describes: [G] }], G).heads[0] === d(0),
    'a single version is its own head',
  );
  // Cannot happen from the publish path, but a hand-written descriptor could do it, and a
  // self-referential supersedes must not make the entry vanish from the frontier ONLY to
  // reappear as a phantom head elsewhere. Reporting no head is honest: the caller re-reads.
  ok(
    supersessionFrontier([{ descriptorUrl: d(0), describes: [G], supersedes: [d(0)] }], G)
      .heads.length === 0,
    'a self-superseding descriptor yields no head rather than a contradiction',
  );

  // eslint-disable-next-line no-console
  console.log('\nan unusable if_match is not a retryable failure');

  // ★ "Wrong head" and "unusable value" deserve opposite answers. A wrong head is 412 and
  // a re-read fixes it. Null can never work — reported as retryable, a caller loops until
  // it gives up, and what it gives up on is its own compare-and-swap.
  ok(classifyIfMatch(undefined) === 'absent', 'omitted is absent — the correct way to say "first version"');
  ok(classifyIfMatch(null) === 'unusable', '★ JSON null is unusable, not absent');
  ok(classifyIfMatch('') === 'unusable', 'an empty string is unusable');
  ok(classifyIfMatch('   ') === 'unusable', 'whitespace is unusable');
  ok(classifyIfMatch(0) === 'unusable', 'a number is unusable');
  ok(classifyIfMatch('bafkreiabc') === 'usable', 'a CID is usable');
  ok(classifyIfMatch('https://pod.example/c/1.ttl') === 'usable', 'a descriptor URL is usable');

  // eslint-disable-next-line no-console
  console.log('\nan if_match with no graph_iri cannot be evaluated');

  // ★ A head is only defined relative to a graph. With no graph_iri there is no chain,
  // `supersessionFrontier` has nothing to compute a frontier over, and the relay's
  // `casHeads` came out undefined — which `checkSupersessionPrecondition` reads as "no head
  // check requested" and answers with the pre-fix membership test an ancestor satisfies
  // forever. `graph_iri` is `required` in the tool schema, but `tools/call` does no schema
  // validation, so omitting it was one keystroke and turned the guard off in silence.
  const HEAD = 'https://pod.example/c/2.ttl';
  ok(classifyCasRequest(HEAD, G).kind === 'evaluable', 'if_match + graph_iri is evaluable');
  ok(
    classifyCasRequest(HEAD, undefined).kind === 'ungraphed',
    '★ if_match with graph_iri OMITTED is ungraphed — never silently evaluable',
  );
  ok(classifyCasRequest(HEAD, '').kind === 'ungraphed', 'an empty graph_iri is ungraphed too');
  ok(
    classifyCasRequest(HEAD, '   ').kind === 'ungraphed',
    'whitespace is ungraphed — `describes.includes("  ")` would empty the frontier without saying why',
  );
  ok(
    classifyCasRequest(HEAD, 42).kind === 'ungraphed',
    'a non-string graph_iri is ungraphed, not coerced into a chain nothing describes',
  );

  // A no-graph publish is still a perfectly good publish. Only the PRECONDITION is
  // impossible, so the ungraphed answer must be reachable only via a usable if_match.
  ok(classifyCasRequest(undefined, undefined).kind === 'absent', 'no if_match, no graph_iri: absent, publish normally');
  ok(classifyCasRequest(undefined, G).kind === 'absent', 'no if_match: absent regardless of graph_iri');
  // Unusable beats ungraphed: the value can never work, so say that rather than blaming an
  // argument the caller would then supply only to be refused a second time.
  ok(classifyCasRequest(null, undefined).kind === 'unusable', 'an unusable if_match is reported as unusable, not ungraphed');
  ok(classifyCasRequest('', G).kind === 'unusable', 'an empty if_match stays unusable when graph_iri is fine');

  const evaluable = classifyCasRequest(HEAD, G);
  ok(
    evaluable.kind === 'evaluable' && evaluable.graphIri === G && evaluable.ifMatch === HEAD,
    'the evaluable case carries both narrowed values, so the caller cannot re-derive them differently',
  );

  // eslint-disable-next-line no-console
  console.log('\nthe refusal a caller actually receives');

  // The envelope is what the relay returns verbatim, so assert on it directly rather than on
  // the predicate one call upstream. `retryable` is the field a caller loops on: getting it
  // wrong is how the original null-if_match bug wasted a caller's whole retry budget.
  ok(casRefusal(classifyCasRequest(HEAD, G), HEAD) === null, 'an evaluable request is not refused');
  ok(casRefusal(classifyCasRequest(undefined, G), undefined) === null, 'an absent precondition is not refused');

  const ungraphed = casRefusal(classifyCasRequest(HEAD, undefined), HEAD);
  ok(ungraphed !== null, '★ if_match without graph_iri IS refused — it no longer publishes silently');
  ok(ungraphed?.code === 400 && ungraphed.retryable === false, 'refused 400 non-retryable: resending the same request cannot fix it');
  ok(ungraphed?.error === 'precondition_not_evaluable', 'named distinctly from invalid_if_match — the VALUE was fine, the request was not');
  ok(
    /graph_iri/.test(ungraphed?.message ?? '') && /must never be reported as satisfied/.test(ungraphed?.message ?? ''),
    'the message names the missing argument and says why silence was not an option',
  );

  const unusable = casRefusal(classifyCasRequest(null, G), null);
  ok(unusable?.code === 400 && unusable.error === 'invalid_if_match', 'an unusable value keeps its own 400');
  ok(unusable?.retryable === false, 'and stays non-retryable — no retry turns null into a head');
  ok(/Received null/.test(unusable?.message ?? ''), 'the message quotes back what was actually received');
  ok(
    /Received number\./.test(casRefusal(classifyCasRequest(7, G), 7)?.message ?? ''),
    'a number is reported by its type, not mislabelled as an empty string',
  );

  // eslint-disable-next-line no-console
  console.log('\n`descriptor_id` must not be able to choose which head disappears');

  // ★ THE ATTACK. `descriptor_id` is an unvalidated `publish_context` argument. The relay
  // turned it into a descriptor URL and handed that to the frontier as `exclude`. Excluding
  // an entry removes it BOTH as a candidate head AND as a source of supersedes edges, so a
  // writer holding only the STALE token could name the live head and watch its ancestor
  // become a head again — then pass a compare-and-swap against it. One request, no
  // concurrency required. Reproduced against the shipped code before this changed.
  const POD = 'https://pod.example/u/';
  ok(
    predictDescriptorUrl(POD, 'urn:x:2') === d(2),
    'a caller-chosen descriptor_id predicts an EXISTING descriptor URL exactly — the lever is real',
  );

  const underAttack = supersessionFrontier(CHAIN, G, { normalize: normalizeCssUrl });
  ok(
    underAttack.heads.length === 1 && underAttack.heads[0] === d(2),
    '★ the real head stays the head — there is no longer an exclusion for descriptor_id to aim at',
  );
  ok(
    !underAttack.heads.includes(d(1)),
    '★ the superseded ancestor is NOT resurrected as a head, so the stale token still fails',
  );
  // The option is GONE, not merely unused by the one caller that had it. Asserted by
  // handing one over anyway: if someone re-adds the parameter, this is what breaks, rather
  // than the next review re-deriving the whole attack from scratch.
  ok(
    supersessionFrontier(
      CHAIN, G, { exclude: d(2) } as unknown as { normalize?: (u: string) => string },
    ).heads[0] === d(2),
    '★ an `exclude` supplied anyway is inert — there is nothing left to aim descriptor_id at',
  );

  // And the collision itself is refused before anything is written, because letting it
  // proceed corrupts the chain even when the caller's token is perfectly current: the write
  // would replace an existing version with one that supersedes its own successor.
  const aimedAtHead = casSelfOverwriteRefusal(CHAIN, G, predictDescriptorUrl(POD, 'urn:x:2'), normalizeCssUrl);
  ok(aimedAtHead !== null, '★ a CAS publish aimed at an existing version of the chain is refused');
  ok(aimedAtHead?.code === 409, 'refused 409 — the request contradicts itself; the assertion was not the problem');
  ok(aimedAtHead?.retryable === false, 'non-retryable: resending the same descriptor_id re-collides');
  ok(
    /descriptor_id/.test(aimedAtHead?.message ?? '') && /Omit descriptor_id/.test(aimedAtHead?.message ?? ''),
    'the message names the argument at fault and the one-word fix',
  );
  const aimedAtAncestor = casSelfOverwriteRefusal(CHAIN, G, predictDescriptorUrl(POD, 'urn:x:0'), normalizeCssUrl);
  ok(
    aimedAtAncestor !== null,
    '★ aiming at an ANCESTOR is refused too — that write makes v0 supersede v2 and kills the chain',
  );

  // Scoping: the refusal must not fire on the normal case, or every publish stops.
  ok(
    casSelfOverwriteRefusal(CHAIN, G, predictDescriptorUrl(POD, 'urn:iep:u:1785637357109'), normalizeCssUrl) === null,
    'a freshly minted descriptor id collides with nothing and is not refused',
  );
  ok(
    casSelfOverwriteRefusal(
      [{ descriptorUrl: d(7), describes: [OTHER] }], G, d(7), normalizeCssUrl,
    ) === null,
    'an entry for a DIFFERENT graph is not part of this chain, so it is not a chain collision',
  );

  // eslint-disable-next-line no-console
  console.log('\nthe same line, from the other side: an idempotent republisher');

  // ★ A client that reuses one `descriptor_id` — the natural idempotency pattern, and what
  // the relay itself does for trajectory steps and pod bootstrap — excluded its OWN only
  // entry. `heads` came out `[]`, and the substrate answered every possible `if_match` with
  // "Current heads: [] (none — every descriptor for this graph is superseded)". There is no
  // value that is a member of the empty set, and `get_current_head` kept reporting the
  // entry as the head, so the documented retry hint sent the caller straight back with the
  // value that had just failed. Unrecoverable except by abandoning the precondition.
  const onlyEntry: FrontierEntry[] = [{ descriptorUrl: d(5), describes: [G] }];
  ok(
    supersessionFrontier(onlyEntry, G).heads[0] === d(5),
    '★ the publisher\'s own entry is still the head — the frontier is no longer emptied by reusing an id',
  );
  const republish = casSelfOverwriteRefusal(onlyEntry, G, d(5), normalizeCssUrl);
  ok(republish !== null, 'the in-place overwrite is still refused — it would destroy the state being gated on');
  ok(
    !/every descriptor for this graph is superseded/.test(republish?.message ?? ''),
    '★ but NOT with the unrecoverable message — the caller is told what is actually wrong',
  );
  ok(
    /drop if_match/.test(republish?.message ?? ''),
    'and told the way out, which is the one thing the empty-frontier answer never said',
  );

  // eslint-disable-next-line no-console
  console.log('\na descriptor must not supersede itself, compared as a URL');

  // ★ The relay filtered the auto-supersede list on `descriptor_id` — `urn:iep:<pod>:<ts>` —
  // against manifest entries that are `https://…/<slug>.ttl`. The two shapes never compare
  // equal, so the self-filter never fired once in production.
  ok(
    priorVersionsFor(CHAIN, G, 'urn:iep:u:1785637357109').length === 3,
    '★ a urn matches no manifest entry — which is exactly why the old comparison filtered nothing',
  );
  ok(priorVersionsFor(CHAIN, G, d(9)).length === 3, 'a genuinely new URL supersedes every existing version');
  ok(
    !priorVersionsFor(CHAIN, G, d(2)).includes(d(2)),
    '★ comparing URLs, a descriptor is kept out of its own supersedes list',
  );
  ok(priorVersionsFor(CHAIN, G, d(2)).length === 2, 'and the other two priors are still linked');
  ok(
    priorVersionsFor([...CHAIN, { descriptorUrl: d(8), describes: [OTHER] }], G, d(9)).length === 3,
    'entries for another graph are never auto-superseded into this chain',
  );
  // The consequence of the filter not firing, stated as the state it leaves behind.
  ok(
    supersessionFrontier(
      [{ descriptorUrl: d(0), describes: [G] },
        { descriptorUrl: d(1), describes: [G], supersedes: [d(0), d(1)] }],
      G,
    ).heads.length === 0,
    '★ one self-superseding entry leaves the chain with NO head — every later if_match refused',
  );

  // Host forms. The predicted URL is built from CSS_URL (the internal FQDN); manifest
  // entries carry whichever host was current when they were written. Compared raw, the
  // self-filter misses under the other spelling and the descriptor supersedes itself again
  // — the same permanent-no-head state, reached by a route the URL comparison alone
  // does not cover. Which is why the relay threads the normaliser into both.
  const PUB = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/u/context-graphs/9.ttl';
  const legacyEntry: FrontierEntry[] = [{ descriptorUrl: PUB, describes: [G] }];
  const INT = normalizeCssUrl(PUB);
  ok(INT !== PUB, 'the two host forms really are different strings');
  ok(
    priorVersionsFor(legacyEntry, G, INT, normalizeCssUrl).length === 0,
    '★ an entry written under the legacy host is recognised as SELF and not superseded',
  );
  ok(
    priorVersionsFor(legacyEntry, G, INT).length === 1,
    'without the normaliser it is not — which is the descriptor superseding itself',
  );
  ok(
    casSelfOverwriteRefusal(legacyEntry, G, INT, normalizeCssUrl) !== null,
    'and the collision refusal sees across host forms too, rather than letting the write land',
  );

  // eslint-disable-next-line no-console
  console.log('\nsupersedes decided at read time forks the chain when the write happens later');

  // ★ The DEFAULT publish (no if_match) decides `supersedes` from a manifest snapshot inside
  // the handler's mutex, then writes from a deferred task that queues BEHIND every request
  // that arrived in between. Whatever those wrote is missing from the list, so the deferred
  // write supersedes nobody's latest and the chain grows a second head.
  //
  // This asserts the DECISION, which is what could be extracted: `reDecidedSupersedes` is
  // the call the deferred branch makes inside the same mutex acquisition that performs the
  // write. That the call sits inside that acquisition — rather than just before it, where
  // another writer can still slip in — is a fact about server.ts, which starts an HTTP
  // listener on import and so has no test. Said plainly rather than implied by coverage.
  const atReadTime: FrontierEntry[] = [
    { descriptorUrl: d(0), describes: [G] },
    { descriptorUrl: d(1), describes: [G], supersedes: [d(0)] },
  ];
  const frozenSnapshot = priorVersionsFor(atReadTime, G, d(3));
  // While our write sat in the queue, another writer landed v2 on top of v1.
  const atWriteTime: FrontierEntry[] = [
    ...atReadTime,
    { descriptorUrl: d(2), describes: [G], supersedes: [d(0), d(1)] },
  ];
  const forkedByStaleness = supersessionFrontier(
    [...atWriteTime, { descriptorUrl: d(3), describes: [G], supersedes: frozenSnapshot }], G,
  );
  ok(
    forkedByStaleness.heads.length === 2,
    '★ writing the read-time list after another writer landed leaves TWO heads — the fork',
  );

  ok(
    reDecidedSupersedes(frozenSnapshot, [], atReadTime, G, d(3), normalizeCssUrl) === null,
    'nothing landed in between: null, so the uncontended write stays the exact descriptor the 202 named',
  );
  const reDecided = reDecidedSupersedes(frozenSnapshot, [], atWriteTime, G, d(3), normalizeCssUrl);
  ok(reDecided !== null, '★ a version that landed while the write was queued forces a re-decide');
  ok(reDecided?.includes(d(2)) === true, 'and the re-decided list links it');
  const linear = supersessionFrontier(
    [...atWriteTime, { descriptorUrl: d(3), describes: [G], supersedes: reDecided ?? [] }], G,
  );
  ok(
    linear.heads.length === 1 && linear.heads[0] === d(3),
    '★ and the chain stays linear, with the last writer as the single head',
  );
  // Content-declared supersedes survive the re-decide. The relay unions
  // `preprocessed.supersedes` (lifted from the caller's own turtle) with the manifest
  // priors; dropping them here would silently delete a relationship the caller asserted.
  const withContent = reDecidedSupersedes(frozenSnapshot, ['urn:external:thing'], atWriteTime, G, d(3), normalizeCssUrl);
  ok(
    withContent?.includes('urn:external:thing') === true,
    'a supersedes the CALLER declared in content is carried through the re-decide, not dropped',
  );

  // eslint-disable-next-line no-console
  console.log('\nthe CSS host normaliser must not collapse two deployments into one');

  // ★ normalizeCssUrl is what the relay threads in as `normalize` above. Its regex matched
  // `livelysky-<hex>` but its replacement hard-coded ONE deployment id, so two genuinely
  // different hosts normalised to the same string. In the frontier that means a citation
  // naming deployment A retires deployment B's descriptor as a head — a live CAS token
  // invalidated by a write that never touched that chain. (On solidFetch it is worse: a
  // caller-chosen host was rewritten onto our real pod and fetched with relay credentials.)
  const A = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
  const B = 'https://interego-css.livelysky-deadbeef.eastus.azurecontainerapps.io';
  ok(
    normalizeCssUrl(`${A}/markj/c/1.ttl`) !== normalizeCssUrl(`${B}/markj/c/1.ttl`),
    '★ two different deployment ids do NOT normalise to the same URL',
  );
  ok(
    normalizeCssUrl(`${B}/markj/c/1.ttl`)
      === 'https://interego-css.internal.livelysky-deadbeef.eastus.azurecontainerapps.io/markj/c/1.ttl',
    'the rewrite inserts `internal.` and preserves the deployment id, region and path',
  );
  ok(
    normalizeCssUrl(`${A}/markj/c/1.ttl`)
      === 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/c/1.ttl',
    'the one deployment that actually exists rewrites exactly as it always did — no live path moves',
  );
  ok(
    normalizeCssUrl(normalizeCssUrl(`${A}/x`)) === normalizeCssUrl(`${A}/x`),
    'still idempotent — a second pass must not produce internal.internal.…',
  );
  ok(normalizeCssUrl(`${A}`) === `${A}`.replace('interego-css.', 'interego-css.internal.'), 'matches at end-of-string with no path');
  ok(normalizeCssUrl('https://pod.example/c/1.ttl') === 'https://pod.example/c/1.ttl', 'a non-CSS URL passes through');
  ok(normalizeCssUrl('urn:graph:memory:x') === 'urn:graph:memory:x', 'a urn passes through');
  // The trailing `(\/|$)` anchor is load-bearing: without it an attacker-registered
  // `…azurecontainerapps.io.evil.example` prefix-matches and gets rewritten onto our host.
  ok(
    normalizeCssUrl(`${A}.evil.example/x`) === `${A}.evil.example/x`,
    'a host that merely STARTS with the CSS host is not rewritten',
  );

  // The frontier consequence, stated end-to-end over the real normaliser.
  const crossDeployment: FrontierEntry[] = [
    { descriptorUrl: `${B}/markj/c/0.ttl`, describes: [G] },
    // A descriptor on deployment A supersedes A's own v0 — and nothing on B.
    { descriptorUrl: `${A}/markj/c/1.ttl`, describes: [G], supersedes: [`${A}/markj/c/0.ttl`] },
  ];
  const cross = supersessionFrontier(crossDeployment, G, { normalize: normalizeCssUrl });
  ok(
    cross.heads.length === 2,
    "★ a citation of deployment A's v0 does not retire deployment B's v0 — they are different URLs",
  );

  // eslint-disable-next-line no-console
  console.log('\na re-decide is about MEMBERS; a reordered manifest is not a change');

  // ★ The comparison was element-wise and positional, so a manifest that came back in a
  // different order — `getCachedManifest` unions the append-only container with the
  // monolithic manifest through a Map, and append-only entries are written asynchronously —
  // reported "changed" and forced a rewrite of an identical supersedes list. On the deferred
  // path a rewrite means the descriptor that lands is not the one the 202's CID names, so a
  // no-op reorder was enough to invalidate a content address for nothing.
  const orderA: FrontierEntry[] = [
    { descriptorUrl: d(0), describes: [G] },
    { descriptorUrl: d(1), describes: [G], supersedes: [d(0)] },
  ];
  const orderB: FrontierEntry[] = [orderA[1]!, orderA[0]!];
  const frozenInOrderA = priorVersionsFor(orderA, G, d(5), normalizeCssUrl);
  ok(
    reDecidedSupersedes(frozenInOrderA, [], orderB, G, d(5), normalizeCssUrl) === null,
    '★ the same targets in a different order is NOT a change — the 202 CID stays valid',
  );
  ok(
    reDecidedSupersedes(frozenInOrderA, [], [...orderB, { descriptorUrl: d(2), describes: [G] }], G, d(5), normalizeCssUrl) !== null,
    'and a genuinely new prior, reordered or not, still forces the re-decide',
  );
  ok(
    reDecidedSupersedes([...frozenInOrderA, d(0)], [], orderA, G, d(5), normalizeCssUrl) === null,
    'a frozen list carrying a duplicate compares equal and is written unchanged, not tidied',
  );

  // eslint-disable-next-line no-console
  console.log('\na padded graph_iri is refused, not silently evaluated against nothing');

  // ★ `classifyCasRequest` validated `graphIri.trim()` and returned `graphIri`. A padded
  // value was `evaluable`, matched no `describes` entry, and produced the 412 that reads
  // "(none — every descriptor for this graph is superseded)" — the unrecoverable-looking
  // answer this module exists to stop emitting, for one stray space.
  const padded = classifyCasRequest(HEAD, ` ${G} `);
  ok(padded.kind === 'unpadded-graph-required', `★ a padded graph_iri is not evaluable (got ${padded.kind})`);
  const paddedRefusal = casRefusal(padded, HEAD);
  ok(paddedRefusal?.code === 400 && paddedRefusal.retryable === false,
    '400 non-retryable — resending the same padded value cannot work');
  ok(paddedRefusal?.error === 'graph_iri_not_canonical', 'named for the argument that is wrong');
  ok(
    !/every descriptor for this graph is superseded/.test(paddedRefusal?.message ?? ''),
    '★ and NOT the empty-frontier message the padded value used to produce',
  );
  ok(
    /whitespace/.test(paddedRefusal?.message ?? '') && new RegExp(G).test(paddedRefusal?.message ?? ''),
    'the message names the problem and quotes the IRI the caller probably meant',
  );
  // Refused rather than trimmed on purpose: trimming here would evaluate the precondition
  // against one chain while the descriptor written still declares `iep:describes` from the
  // caller's raw argument and joins another.
  ok(classifyCasRequest(HEAD, G).kind === 'evaluable', 'an unpadded graph_iri is unaffected');

  // eslint-disable-next-line no-console
  console.log('\nthe collision refusal states the scope it actually checked');

  // ★ The message told the caller to "send a descriptor_id that does not resolve to an
  // existing version", which claims a completeness the guard does not have: it inspects only
  // entries describing THIS graph. `slugFromIri` takes the last `/ : #` segment, so a caller
  // can aim a G-publish at a descriptor belonging to OTHER and nothing here reports it. The
  // hole predates this work and is not closed here; the claim that it was covered is.
  const otherHead: FrontierEntry[] = [
    { descriptorUrl: d(0), describes: [G] },
    { descriptorUrl: d(7), describes: [OTHER] },
  ];
  ok(
    casSelfOverwriteRefusal(otherHead, G, d(7), normalizeCssUrl) === null,
    'a descriptor_id landing on ANOTHER graph\'s descriptor is genuinely not detected here',
  );
  const sameGraph = casSelfOverwriteRefusal(otherHead, G, d(0), normalizeCssUrl);
  ok(sameGraph?.code === 409, 'a collision within this graph still is');
  ok(
    !/does not resolve to an existing version/.test(sameGraph?.message ?? ''),
    '★ the message no longer claims a check over every existing version',
  );
  ok(
    /covers only the chain for/.test(sameGraph?.message ?? '')
    && /OTHER graph/.test(sameGraph?.message ?? ''),
    'and states the scope it did check, plus what it did not',
  );

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
