#!/usr/bin/env tsx
/**
 * Relay Increment-0 security regression test — caller-identity attribution +
 * inbox/directory scoping.
 *
 * Five confirmed defects, all reachable by ANY authenticated caller (and one by
 * an anonymous caller). Their shared root cause is the SAME mistake: a
 * caller-supplied argument that the injection sites only fill in WHEN ABSENT was
 * later trusted as an authoritative identity or target.
 *
 *   1. args.agent_id as ATTRIBUTION. `agent_id` cannot be stripped at the wire —
 *      it is a legitimate TARGET parameter for verify_agent / revoke_agent_access
 *      / register_agent. But attribution sinks (notify_agent's AS2 actor,
 *      publish_context's author, record_trajectory_step, pgsl_decide/ingest) read
 *      it as an identity CLAIM, so any authenticated caller could act as anyone.
 *      Fixed by routing EVERY attribution sink through one shared helper,
 *      callerAgentId(), which prefers the reserved, wire-stripped
 *      `_session_agent_did` and only falls back to the caller's value when there
 *      is no session identity at all (open / local-dev mode).
 *
 *   2. set_reachability stamped a forgeable `did`/`webId` onto the caller's
 *      federation entry, and resolveTargetPodUrl() maps a DID to a pod by
 *      scanning exactly those fields — so claiming a victim's DID poisons the
 *      directory and can route the victim's inbound mail to the claimant.
 *
 *   3. read_inbox honored an explicit `pod_url`, reading ANY agent's private
 *      inbox with the relay's own pod credential.
 *
 *   4. list_known_pods emitted channels[].value verbatim — a discord/telegram
 *      webhook URL is a bearer secret; email/sms are PII.
 *
 *   5. POST /agents/:localPart/inbox accepted UNSIGNED activities from anonymous
 *      callers with the actor taken from the request body.
 *
 * These assertions pin the INVARIANTS rather than re-deriving handler internals,
 * so they keep holding as the handlers evolve.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/identity-attribution-gates.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const REACH = readFileSync(join(here, '..', 'reachability.ts'), 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\n1. callerAgentId() exists and is the single attribution helper');
check('callerAgentId is defined', /function callerAgentId\(args: ToolArgs\)/.test(SERVER));
check('it prefers the wire-stripped session identity',
  /callerAgentId[\s\S]{0,600}_session_agent_did/.test(SERVER));

console.log('\n2. every ATTRIBUTION sink routes through it (no per-sink copies)');
// The forgeable read must not survive at any attribution sink. Target-parameter
// handlers (verify/revoke/register) legitimately keep reading args.agent_id, so
// we assert on the specific attribution patterns that were vulnerable.
check('notify_agent sender is not args.agent_id',
  !/const from = \(args\.agent_id as string\)/.test(SERVER));
check('no attribution sink uses the old urn:agent:remote:unknown fallback on args.agent_id',
  !/const agentId = \(args\.agent_id as string\) \?\? 'urn:agent:remote:unknown'/.test(SERVER));
check('set_reachability derives its did from callerAgentId',
  /set_reachability[\s\S]{0,1200}const did = callerAgentId\(args\)/.test(SERVER)
  || /const did = callerAgentId\(args\)/.test(SERVER));

console.log('\n3. BOTH transports inject the server-authoritative identity');
// /mcp already set it unconditionally; /messages did not, so callerAgentId()
// would have fallen through to the forgeable value on that transport.
const injections = SERVER.match(/args\._session_agent_did = /g) ?? [];
check('_session_agent_did is injected at >= 2 sites (/mcp + /messages)',
  injections.length >= 2, `found ${injections.length}`);
check('_session_agent_did is in the reserved wire-strip list',
  /for \(const reserved of \[[^\]]*'_session_agent_did'/.test(SERVER));

console.log('\n4. read_inbox is ownership-scoped');
check('an explicit pod_url is compared against the caller\'s own pod',
  /handleReadInbox[\s\S]{0,1200}canonicalPodKey\(explicit\) !== canonicalPodKey\(ownPod\)/.test(SERVER));
check('it refuses an explicit target when no identity is derivable',
  /handleReadInbox[\s\S]{0,1600}explicit && !ownPod/.test(SERVER));

console.log('\n5. list_known_pods redacts non-native channel values for non-owners');
check('a redaction pass exists', /\[redacted — visible to the owning agent only\]/.test(SERVER));
check('native channels stay visible', /NATIVE_CHANNELS = \['ldn', 'activitypub', 'acct'\]/.test(SERVER));
check('the misleading "carry no secret" comment is gone from reachability.ts',
  !/carry no secret in their value and are safe to store\/show/.test(REACH));
check('reachability.ts warns that non-native values are secrets/PII',
  /bearer[\s*]+secret/.test(REACH) && /NATIVE_CHANNEL_TYPES/.test(REACH));

console.log('\n6. federated inbox rejects unsigned deliveries (fail-closed)');
check('unsigned POSTs are rejected unless explicitly opted in',
  /unsigned_delivery_rejected/.test(SERVER));
check('the opt-in is env-gated, not the default',
  /RELAY_FEDERATION_ACCEPT_UNSIGNED !== '1'/.test(SERVER));
check('the old accept-anything TODO is gone',
  !/For now we accept \+ map the activity/.test(SERVER));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log('\nAll identity-attribution + scoping gates hold.\n');
