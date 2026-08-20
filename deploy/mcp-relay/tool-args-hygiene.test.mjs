#!/usr/bin/env node
/**
 * Transport plumbing must not look like a caller argument.
 *
 * ★ WHY. `POST /tool/:name` handed handlers `{...req.body, _req: req}` — the live
 * Express request, spread in as an ordinary enumerable property. sign_request folds
 * every unrecognised argument into the payload it SIGNS, so it called
 * JSON.stringify on a socket and died:
 *
 *   POST /tool/sign_request -> 500
 *   { error: "Converting circular structure to JSON
 *             --> starting at object with constructor 'Socket'
 *             |   property 'parser' -> object with constructor 'HTTPParser'
 *             --- property 'socket' closes the circle" }
 *
 * Two things were wrong at once, and the second is why this file is not just a
 * sign_request test:
 *
 *   1. The substrate's SIGNING PRIMITIVE was down on this transport. A
 *      relay-mediated agent holds no key of its own, so sign_request is the only
 *      way it can act on a signed-request affordance at all.
 *   2. The 500 handler echoed the raw message, publishing Node's internal object
 *      graph to an unauthenticated caller — the same leak class already fixed on
 *      the A2A mount, reappearing on a different route.
 *
 * Fixing sign_request alone would have left the trap armed for the next handler
 * that iterates its args, so the fix is at the source (non-enumerable `_req`) plus
 * a fail-closed prefix rule in sign_request.
 *
 * Run: node deploy/mcp-relay/tool-args-hygiene.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, 'server.ts'), 'utf8');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n/tool/:name — transport plumbing must not reach a signed payload');

// ── 1. The exact shape that broke ──────────────────────────────────────────
check('_req is not spread in as an enumerable property',
  !/tool\.handler\(\s*\{\s*\.\.\.req\.body\s*,\s*_req:\s*req\s*\}\s*\)/.test(server),
  'the literal `{...req.body, _req: req}` is what fed a socket to JSON.stringify');

check('_req is attached non-enumerably',
  /Object\.defineProperty\(\s*handlerArgs\s*,\s*'_req'[\s\S]{0,120}enumerable:\s*false/.test(server));

// ── 2. …and its consumers still work ───────────────────────────────────────
// Non-enumerable is only correct if property ACCESS still resolves. If a future
// change switches these to destructuring-with-rest or an args clone, they break
// silently — IPFS config would quietly fall back to defaults.
const consumers = [...server.matchAll(/resolveIpfsConfig\(\s*args\._req/g)];
check('resolveIpfsConfig still reads args._req by property access',
  consumers.length >= 2, `found ${consumers.length}, expected 2`);

// ── 3. Fail-closed rule in the signer ──────────────────────────────────────
// The `reserved` list can only name internals that existed when it was written.
// `_req` was not on it. A prefix rule covers the ones nobody has added yet, and
// keeps session state out of an artifact that is signed and forwarded onward.
/**
 * ★★ THE FUNCTION BODY, NOT A FIXED-SIZE WINDOW — and this is a bug this file HAD.
 *
 * It sliced 4000 characters from the signature. The rule it looks for sat at offset 4197 the day
 * somebody added a paragraph above it, so the check went red over a line that had not changed and a
 * rule that was still enforced. A guard that fails when a COMMENT grows teaches people to shorten
 * comments, or worse, to distrust the guard — and the failure looked exactly like a real regression
 * in the signer, which is how it got a deploy shipped past a red run.
 *
 * Signature to the first line-start `}` is the same shape every other source-level assertion in
 * this repo uses, and it cannot drift with the size of anything inside.
 */
const signStart = server.indexOf('async function handleSignRequest');
const signEnd = server.indexOf('\n}\n', signStart);
const signFn = server.slice(signStart, signEnd < 0 ? server.length : signEnd + 3);
check('sign_request exists', signFn.length > 0);
check('sign_request refuses underscore-prefixed keys',
  /k\.startsWith\('_'\)/.test(signFn),
  'an explicit deny-list cannot cover internals added later');

// ── 3b. The dispatcher's OWN pod default must not ride inside the signature ────
//
// ★ THE UNDERSCORE RULE DOES NOT COVER THIS ONE, and that gap shipped. `/mcp` fills `pod_url` on
// EVERY call from the INTERNAL store URL; `pod_url` has no underscore and was not in `reserved`,
// so the dispatcher's default was folded into the caller's signed assertion — emitting BOTH an
// internal `pod_url` and a public `subject_pod_url` as adjacent keys of one signed payload, with
// nothing saying which governs. Reported by a live delegate reading its own envelope.
//
// Deny-listing it would have been wrong: Foxxi's mesh enrolment READS a signed `pod_url` as the
// pod a caller is naming, which is the documented way to enrol the twin spelling of your own pod.
// So the rule is DISAMBIGUATION, keyed on the provenance marker `pod-selector.ts` already sets.
check('sign_request drops the dispatcher-INJECTED pod_url',
  /POD_URL_INJECTED\] === true/.test(signFn),
  'the marker is the only thing that distinguishes a caller-named pod from the relay default');
check('sign_request keeps a caller-NAMED pod_url, publicly spelled',
  /safe\['pod_url'\] = asPublicPodUrl\(askedPodUrl\)/.test(signFn),
  'denying it outright would break enrolment-by-pod_url on the only route relay-mediated agents have');
check('sign_request emits ONE pod key, never pod_url and podUrl together',
  /delete safe\['pod_url'\][\s\S]{0,120}delete safe\['podUrl'\]/.test(signFn),
  'two synonyms for one pod is the same ambiguity one casing along');

// ── 4. Thrown internals are not echoed ─────────────────────────────────────
// Handlers report EXPECTED failures by returning { error }, which takes the 200
// path. Anything that throws is internal by definition.
const catchBlock = server.slice(server.indexOf("'urn:iep:error:ToolFailure'") - 900,
  server.indexOf("'urn:iep:error:ToolFailure'") + 400);
check('the 500 body does not echo the raw error message',
  !/error:\s*\(err as Error\)\.message/.test(catchBlock),
  'this is what published Socket/HTTPParser to the caller');
check('the 500 body is a stable, tool-scoped message',
  /could not be completed/.test(catchBlock));
check('the detail is logged server-side rather than discarded',
  /console\.error\(`\[tool:\$\{toolName\}\] handler threw:`/.test(server),
  'suppressing the message must not mean losing it');

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nTransport plumbing stays out of caller args, and out of signed payloads.\n');
