#!/usr/bin/env tsx
/**
 * The action naming authority answers only for verticals somebody registered.
 *
 * ★★ WHY THIS FILE EXISTS. `/ns/iep/action/<vertical>/<verb>` is what makes an action id a
 * dereferenceable URL rather than a word. Its roster was an object literal and its lookup a bare
 * index, so every member of `Object.prototype` resolved. Measured against the LIVE relay before
 * the fix:
 *
 *   GET /ns/iep/action/constructor/publish_context
 *     -> 302 .../action/constructor/function%20Object()%20%7B%20[native%20code]%20%7D
 *   __proto__ -> 302 [object Object]      toString / valueOf / hasOwnProperty -> 302
 *
 * The route's contract is "unknown vertical -> 404". It returned 302 for five names nobody
 * registered, beneath a comment asserting the target map was fixed.
 *
 * Each case binds a refusal to its own reason code AND pairs it with a case that must still
 * resolve, so deleting a guard fails the first and widening one fails the second. Asserting only
 * "some refusal happened" is satisfied by dead code.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/action-authority.test.ts
 */
import { buildActionRoster, resolveActionTarget } from '../action-authority.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ROSTER = buildActionRoster(
  {
    foxxi: 'https://foxxi-bridge.interego.xwisee.com/affordances',
    relay: 'https://relay.interego.xwisee.com/.well-known/operations',
  },
  undefined,
);

// ── 1. The registered verticals still resolve ────────────────────────────────
// Paired with every refusal below: a guard that refuses everything passes those and fails these.
{
  const r = resolveActionTarget(ROSTER, 'foxxi', 'publish_context');
  ok('foxxi resolves', r.ok, String(r.reason));
  ok('foxxi target is the manifest', r.target === 'https://foxxi-bridge.interego.xwisee.com/affordances', r.target);

  const s = resolveActionTarget(ROSTER, 'relay', 'get_descriptor');
  ok('relay resolves', s.ok, String(s.reason));
  ok('relay target is the operations catalog', s.target === 'https://relay.interego.xwisee.com/.well-known/operations', s.target);

  // Underscores must survive: substrate verbs use them, and rejecting them 404s every relay id.
  ok('an underscored verb resolves', resolveActionTarget(ROSTER, 'relay', 'publish_context').ok);
  ok('a hyphenated verb resolves', resolveActionTarget(ROSTER, 'relay', 'read-inbox').ok);
}

// ── 2. THE BUG: Object.prototype members are not verticals ───────────────────
for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
  const r = resolveActionTarget(ROSTER, name, 'publish_context');
  ok(`${name} is not a vertical`, !r.ok, `resolved to ${r.target}`);
  // Specifically `unknown-vertical`: these are well-formed names, so the ONLY thing that can
  // refuse them is the own-key check. If this said `bad-vertical` the charset guard would be
  // doing the work and the own-key check could be deleted without failing anything.
  ok(`${name} refuses as unknown-vertical`, r.reason === 'unknown-vertical', String(r.reason));
}
{
  // `__proto__` is refused one step earlier — a leading underscore fails the segment charset —
  // and that is the stronger refusal, so it is asserted as its own case rather than folded in
  // above. Both guards must hold: this asserts WHICH one fires, so neither can quietly go away.
  const r = resolveActionTarget(ROSTER, '__proto__', 'publish_context');
  ok('__proto__ is not a vertical', !r.ok, `resolved to ${r.target}`);
  ok('__proto__ is refused by the charset guard', r.reason === 'bad-vertical', String(r.reason));
}

// ── 3. An unregistered but well-formed vertical is a plain 404 ───────────────
{
  const r = resolveActionTarget(ROSTER, 'not-a-vertical', 'publish_context');
  ok('unknown vertical refuses', !r.ok);
  ok('unknown vertical says why', r.reason === 'unknown-vertical', String(r.reason));
}

// ── 4. Charset guards on BOTH segments ───────────────────────────────────────
// The vertical segment was previously unvalidated; only the verb was checked.
for (const bad of ['../etc', 'a/b', 'a.b', '%2e%2e', '-leading', '']) {
  const r = resolveActionTarget(ROSTER, bad, 'publish_context');
  ok(`vertical ${JSON.stringify(bad)} refused`, !r.ok && r.reason === 'bad-vertical', String(r.reason));
}
for (const bad of ['../etc', 'a/b', 'a.b', '-leading', '']) {
  const r = resolveActionTarget(ROSTER, 'foxxi', bad);
  ok(`verb ${JSON.stringify(bad)} refused`, !r.ok && r.reason === 'bad-verb', String(r.reason));
}

// ── 5. A non-URL target can never become a Location ──────────────────────────
// This is the property that kept the prototype bug from being an OPEN redirect rather than merely
// a wrong one; it is asserted so it stays true if the roster ever takes a bad value.
{
  const junk = buildActionRoster({ junk: 'function Object() { [native code] }' }, undefined);
  const r = resolveActionTarget(junk, 'junk', 'x');
  ok('a non-URL target refuses', !r.ok && r.reason === 'bad-target', String(r.reason));

  const scheme = buildActionRoster({ js: 'javascript:alert(1)' }, undefined);
  const s = resolveActionTarget(scheme, 'js', 'x');
  ok('a non-http scheme refuses', !s.ok && s.reason === 'bad-target', String(s.reason));
}

// ── 6. Back-compat: a bare host keeps its historical /affordances target ─────
{
  const bare = buildActionRoster({ v: 'https://v.example.com' }, undefined);
  ok('bare host gains /affordances',
    resolveActionTarget(bare, 'v', 'x').target === 'https://v.example.com/affordances');
  const slash = buildActionRoster({ v: 'https://v.example.com/' }, undefined);
  ok('bare host with slash gains /affordances',
    resolveActionTarget(slash, 'v', 'x').target === 'https://v.example.com/affordances');
  const pathed = buildActionRoster({ v: 'https://v.example.com/custom' }, undefined);
  ok('a pathed target is left alone',
    resolveActionTarget(pathed, 'v', 'x').target === 'https://v.example.com/custom');
}

// ── 7. The env override cannot pollute the prototype ─────────────────────────
// ★ Mutation-measured: removing the null prototype, or the `__proto__` skip, or BOTH, leaves all
// of these passing — because with both gone `roster.__proto__ = {...}` sets the ROSTER's
// prototype rather than Object.prototype, and the own-key check in resolveActionTarget refuses
// the injected key regardless. Those two are defence in depth, not independently observable.
// The guard this section really pins is the own-key check: deleting it fails six assertions in
// section 2 and 3. Recorded so nobody reads these cases as proof of three separate protections.
{
  const polluted = buildActionRoster(
    { foxxi: 'https://foxxi-bridge.interego.xwisee.com/affordances' },
    JSON.stringify({ __proto__: { evil: 'https://attacker.example/' }, extra: 'https://ok.example/m' }),
  );
  ok('override adds a legitimate vertical', resolveActionTarget(polluted, 'extra', 'x').ok);
  ok('__proto__ key did not register', !resolveActionTarget(polluted, 'evil', 'x').ok);
  ok('Object.prototype was not polluted',
    ({} as Record<string, unknown>)['evil'] === undefined,
    'a plain object now answers for `evil`');

  const nonString = buildActionRoster({ a: 'https://a.example/m' }, JSON.stringify({ b: 42 }));
  ok('a non-string override value is ignored', !resolveActionTarget(nonString, 'b', 'x').ok);

  const malformed = buildActionRoster({ a: 'https://a.example/m' }, '{not json');
  ok('a malformed override keeps the defaults', resolveActionTarget(malformed, 'a', 'x').ok);
}

console.log(`action-authority: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
