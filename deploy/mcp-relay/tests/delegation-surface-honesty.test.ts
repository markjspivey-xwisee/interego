#!/usr/bin/env tsx
/**
 * The delegation surface says what it does — six defects, all found by staging a demo
 * against the LIVE fleet and none of them visible from the source.
 *
 * ── WHAT WAS MEASURED, AND AGAINST WHAT ──────────────────────────────────────
 *
 * Every claim below was reproduced on relay.interego.xwisee.com build 412a432 with
 * disposable wallet identities (the maintainer pod is too contended to stage on), reading
 * the DISCRIMINATING field off each response rather than a status code:
 *
 *   1. `register_agent {agent_id: <own session agent>, scope: "DiscoverOnly"}` answered
 *      `{"registered":false,"repaired":true}`, `verify_agent` still read `ReadWrite`, and an
 *      own-pod `publish_context` committed. Reported as "a role is a ceiling does not hold
 *      on your own pod". It is not: with the row actually narrowed — revoke, then register
 *      DiscoverOnly — the same own-pod publish is REFUSED, `{"error":"scope_violation",
 *      "scope":"DiscoverOnly","requiredScope":["ReadWrite","PublishOnly"]}`. The gate was
 *      never the problem. There was no way to SET the ceiling, because (2).
 *
 *   2. A re-register silently discarded the scope. `addAuthorizedAgent` throws on a live
 *      row, the handler swallowed the throw, and `repaired:true` reads like success. Both
 *      directions measured: DiscoverOnly→(ReadOnly) stayed DiscoverOnly,
 *      ReadWrite→(DiscoverOnly) stayed ReadWrite. The tightening direction is the one that
 *      hands an agent authority its owner believes they withdrew.
 *
 *   3. The scope enum was `["ReadWrite","Read"]`. Storage takes ReadWrite / ReadOnly /
 *      PublishOnly / DiscoverOnly. `Read` — the only narrow value the schema OFFERED — is
 *      not one of them, so `safeScope` degraded it to DiscoverOnly and the call reported
 *      success. Sent-vs-stored, measured on a fresh agent each: ReadWrite→ReadWrite,
 *      Read→DiscoverOnly, ReadOnly→ReadOnly, PublishOnly→PublishOnly,
 *      DiscoverOnly→DiscoverOnly, Bogus→DiscoverOnly.
 *
 *   4. `verify_agent` and the publish gate disagreed about the same fact. A registration
 *      whose credential names a delegator with no authority on the pod reads
 *      `{"verified":false,"delegationChain":null}` while the same agent's write to that pod
 *      commits — the gate falls back to the pod's own (owner-written) agent registry.
 *
 *   5. `get_pod_status.agents` is the identity server's per-surface session agents;
 *      `get_pod_status.registry.agents` is a COUNT of the pod delegation registry, which is
 *      what the gate reads. Measured on one pod: `agents` 1 entry, `registry.agents` 3, and
 *      the two agents added by `register_agent` in neither the array nor anything listed.
 *
 *   6. The publish 412 `retryHint` said to "call get_current_head with the urn:graph IRI".
 *      `get_current_head {graph_iri}` answers `{"error":"urn is required"}` — measured
 *      beside a `{urn}` call that resolved the head. A retry hint that cannot be followed.
 *
 * ── WHY THE GATE STILL FALLS BACK TO THE UNSIGNED REGISTRY ───────────────────
 *
 * ★ THE FAIL-CLOSED VERSION OF (4) WAS MEASURED AND REJECTED, NOT ASSUMED SAFE. Every agent
 * registry in the live tree was enumerated — 276 pods with a readable registry, 293 rows —
 * and each row put through `verify_agent`. 274 verify. Of the 17 that do not, 13 are "No
 * signed delegation credential found" and 4 name an unanchorable delegator. The 13 are not
 * an anomaly: `bootstrapPod` writes every new pod's first surface agent into `<pod>/agents`
 * at ReadWrite and writes no credential, so the first session on any fresh pod lands there
 * (5 of 5 identities minted for this round did). Refusing an unanchored chain would have
 * revoked write on 13 live rows, among them the shared workspace's own convener and
 * reviewer agents. So the gate keeps the fallback, `verify_agent` reports the enforcement
 * answer beside the cryptographic one, and `register_agent` stops MANUFACTURING the
 * contradiction by naming a delegator the registry is about to overwrite.
 *
 * ── WHY THESE ARE TEXT ASSERTIONS ────────────────────────────────────────────
 *
 * The fixes live inside handlers that server.ts does not export, and importing server.ts
 * starts a listener. This package's precedent for that is a regex over source text with
 * comments stripped first, so a comment can neither satisfy nor defeat a check — see the
 * long note in tests/identity-attribution-gates.test.ts and tests/strip-comments.ts.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/delegation-surface-honesty.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const SERVER_CODE = stripComments(SERVER, 'server.ts');
const VALIDATOR = stripComments(
  readFileSync(join(here, '..', '..', 'validator', 'server.ts'), 'utf8'),
  'validator/server.ts',
);

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\n1. register_agent RE-SCOPES an existing agent instead of reporting repaired:true');
// The whole defect is that the already-authorized branch fell through with the old row
// intact. It must now rewrite the live row's scope.
check('the already-authorized branch rewrites authorizedAgents',
  /already authorized[\s\S]{0,900}authorizedAgents: Object\.freeze\(profile\.authorizedAgents\.map\(/.test(SERVER_CODE));
check('it re-scopes only when a scope was EXPLICITLY supplied',
  /already authorized[\s\S]{0,900}if \(requestedScope !== undefined\) \{/.test(SERVER_CODE));
check('the response reports the scope the registry now holds',
  /scope: effectiveScope/.test(SERVER_CODE));
check('effectiveScope is read back off the written profile, not echoed from args',
  /const effectiveScope = profile\.authorizedAgents\.find\(a => a\.agentId === agentId && !a\.revoked\)\?\.scope/.test(SERVER_CODE));
check('the response distinguishes a re-scope from a no-op repair',
  /rescoped: true, previousScope/.test(SERVER_CODE) && /rescoped: false/.test(SERVER_CODE));

console.log('\n2. …and the new scope reaches the GATE, not just the pod');
// A tightened row behind a 60s memo is an agent that keeps writing for a minute after its
// owner was told the tightening landed.
check('register_agent invalidates the scope-gate cache for (pod, agent)',
  /agentScopeCache\.delete\(`\$\{podUrl\}\|\$\{agentId\}`\)/.test(SERVER_CODE));
check('register_agent invalidates the registration cache for (pod, agent)',
  /agentRegistrationCache\.delete\(`\$\{podUrl\}\|\$\{agentId\}`\)/.test(SERVER_CODE));

console.log('\n3. the scope enum is the substrate\'s four, and an unknown scope is refused');
check('the enum offers the four real DelegationScope values',
  /enum: \['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'\]/.test(SERVER_CODE));
check('"Read" is gone from the enum',
  !/enum: \['ReadWrite', 'Read'\]/.test(SERVER_CODE));
check('an unrecognised scope is refused rather than stored as DiscoverOnly',
  /error: 'invalid_scope'/.test(SERVER_CODE));
// ★ AND THE REFUSAL IS BOUND TO ITS CONDITION. The check above passed a mutant that
// replaced the guard with `if (false)` — the refusal envelope was still in the file, just
// unreachable. A check that only asks whether an error string EXISTS is satisfied by dead
// code; this one requires the membership test to be what reaches it.
check('…and the refusal is gated on the membership test, not merely present',
  /!\(DELEGATION_SCOPES as readonly string\[\]\)\.includes\(requestedScope\)\) \{[\s\S]{0,500}error: 'invalid_scope'/.test(SERVER_CODE));
check('the refusal names the supported scopes',
  /supportedScopes: DELEGATION_SCOPES/.test(SERVER_CODE));
check('the one in-repo caller of the removed spelling was fixed in the same change',
  /scope: 'DiscoverOnly'/.test(VALIDATOR) && !/scope: 'Read'/.test(VALIDATOR));

console.log('\n4. verify_agent and the publish gate answer from ONE resolution');
check('the shared resolver exists',
  /async function resolveDelegationAuthority\(agentId: string, podUrl: string\): Promise<DelegationAuthority>/.test(SERVER_CODE));
check('runScopeGate consumes it',
  /runScopeGate[\s\S]{0,1400}const authority = await resolveDelegationAuthority\(agentId, podUrl\)/.test(SERVER_CODE));
check('runScopeGate no longer inlines its own chain-then-registry walk',
  !/const registryOnly = await verifyAgentDelegation\([\s\S]{0,200}\n\s*\);\n\s*valid = registryOnly\.valid;\n\s*scope = registryOnly\.scope \?\? scope;\n\s*\}\n\s*\} catch/.test(SERVER_CODE));
/**
 * ★★ THE FUNCTION BODY, NOT A FIXED WINDOW — the fourth instance of one error this week.
 *
 * This read `/handleVerifyAgent[\s\S]{0,2000}enforcement: \{/` and went red the day a THIRD stated
 * answer was added to the same handler, because the new block pushed `enforcement: {` past
 * character 2000. Nothing it guards had changed. Same shape as the 4000-character slice in
 * `tool-args-hygiene.test.mjs`, as the prune probing `/.well-known/context-graphs` for "does this
 * pod exist", and as a row count standing in for a byte bound: A PROXY THAT IS RIGHT UNTIL
 * SOMETHING LEGITIMATE GROWS. Worse here than elsewhere, because a gate that reddens over an
 * unrelated addition trains people to read red as noise — and this week that cost two deploys past
 * a red run.
 *
 * Signature to the first line-start `}` cannot drift with the size of anything inside it.
 */
const verifyAgentBody = (() => {
  const at = SERVER_CODE.indexOf('async function handleVerifyAgent');
  if (at < 0) return '';
  const end = SERVER_CODE.indexOf('\n}\n', at);
  return SERVER_CODE.slice(at, end < 0 ? SERVER_CODE.length : end + 3);
})();
check('handleVerifyAgent is findable (the body slice above is not silently empty)',
  verifyAgentBody.length > 0);
check('verify_agent reports the enforcement answer',
  /enforcement: \{/.test(verifyAgentBody));
/**
 * ★ AND THE THIRD ANSWER, which a live delegate needed and neither of the other two gave:
 * `verified` says the chain anchors, `enforcement` says the relay will grant scope — and a
 * delegated call was still 401'd because the relay's CURRENT signing key was not the anchor
 * recorded in the credential. Measured: `verified: true`, `writeEligible: true`, and every
 * `/agent/*` call refused, in the same minute. A green light that does not predict the next call.
 */
check('…and whether the agent can actually sign a delegated request right now',
  /canSignDelegatedRequests/.test(verifyAgentBody) && /credentialAnchor/.test(verifyAgentBody));
check('…including the basis the relay is acting on',
  /basis: enforcement\.basis/.test(SERVER_CODE));
check('…and whether that scope may actually write',
  /writeEligible: enforcement\.writeEligible/.test(SERVER_CODE));
// The fallback is deliberate and measured. If someone deletes it, 13 live rows lose write.
check('the registry-only fallback is still reachable (fail-closed was measured and rejected)',
  /if \(valid\) basis = 'registry-only';/.test(SERVER_CODE));

console.log('\n5. register_agent stops manufacturing the credential/registry disagreement');
// ownerProfileToTurtle writes iep:delegatedBy <profile.webId> for every row and discards the
// agent's own. A credential naming anything else can never anchor.
check('a supplied delegator must be anchorable',
  /const anchorableDelegator = ownerWebId === profile\.webId/.test(SERVER_CODE));
check('…or name a live registered agent on this pod (genuine sub-delegation still works)',
  /anchorableDelegator[\s\S]{0,300}profile\.authorizedAgents\.some\(a => a\.agentId === ownerWebId && !a\.revoked\)/.test(SERVER_CODE));
check('the credential is signed for the delegator the registry will record',
  /const effectiveDelegator = anchorableDelegator \? ownerWebId : profile\.webId/.test(SERVER_CODE)
  && /delegatedBy: effectiveDelegator/.test(SERVER_CODE));

console.log('\n6. get_pod_status names its two agent lists distinctly');
check('the array says which source it came from',
  /agentsSource,/.test(SERVER_CODE));
check('agentsSource is set on the identity-server branch',
  /agentsSource = 'identity-server'/.test(SERVER_CODE));
check('…and on the pod-registry fallback branch',
  /agentsSource = 'pod-delegation-registry'/.test(SERVER_CODE));
check('the delegation registry is returned as ROWS, not only a count',
  /delegationRegistry: profile \? \{[\s\S]{0,600}rows: profile\.authorizedAgents/.test(SERVER_CODE));
check('each row carries the scope the gate will enforce',
  /rows: profile\.authorizedAgents[\s\S]{0,300}scope: a\.scope/.test(SERVER_CODE));
check('the count field says it is not the array',
  /note: 'A COUNT of the pod delegation registry, not the `agents` array above/.test(SERVER_CODE));

console.log('\n7. the 412 retry hint can be followed');
check('the hint names the PARAMETER',
  /retryHint: '[^']*get_current_head \{ urn:/.test(SERVER_CODE));
check('the hint no longer names only the value',
  !/call get_current_head with the urn:graph IRI/.test(SERVER_CODE));
check('get_current_head accepts graph_iri as an alias',
  /const urn = \(args\.urn as string \| undefined\) \?\? \(args\.graph_iri as string \| undefined\)/.test(SERVER_CODE));
check('the missing-argument refusal names both spellings',
  /urn is required — pass the urn:graph:\* IRI as `urn`/.test(SERVER_CODE));
check('the schema requires one of the two rather than `urn` alone',
  /anyOf: \[\{ required: \['urn'\] \}, \{ required: \['graph_iri'\] \}\]/.test(SERVER_CODE));

console.log(
  failures === 0
    ? '\nAll delegation-surface assertions passed.\n'
    : `\n${failures} delegation-surface assertion(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
