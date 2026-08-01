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
 * ★ Mutation-checked, each mutation applied and the suite re-run: treating every entry as
 * a head (the defect itself) fails 9 assertions; dropping the `describes` filter fails 2;
 * letting a non-describing entry retire a head fails 2; ignoring the normaliser fails 1.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/supersession-frontier.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { supersessionFrontier, classifyIfMatch, type FrontierEntry } from '../supersession-frontier.js';

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

  ok(
    supersessionFrontier(CHAIN, G, { exclude: d(2) }).heads[0] === d(1),
    'excluding the publish being prepared leaves the head it is about to supersede',
  );

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
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
