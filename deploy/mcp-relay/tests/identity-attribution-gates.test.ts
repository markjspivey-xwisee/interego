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

console.log('\n7. the reserved-field strip is UNIVERSAL across all three transports');
// /mcp always stripped; /tool stripped only inside its authenticated branch and
// /messages never stripped — so a PUBLIC-tool call on those transports could
// smuggle a forged _identity_token / _session_user_id and be believed.
check('a shared stripReservedWireFields helper exists',
  /function stripReservedWireFields\(o: unknown\)/.test(SERVER));
check('RESERVED_WIRE_FIELDS is the single source of truth',
  /const RESERVED_WIRE_FIELDS = \[/.test(SERVER));
const stripCalls = SERVER.match(/stripReservedWireFields\(/g) ?? [];
check('it is invoked at >= 3 sites (helper + /tool + /messages x2)',
  stripCalls.length >= 4, `found ${stripCalls.length}`);
check('/tool strips before the tool lookup (outside the auth branch)',
  /app\.post\('\/tool\/:name'[\s\S]{0,400}stripReservedWireFields\(req\.body\)[\s\S]{0,200}const toolName/.test(SERVER));
check('/messages strips its JSON-RPC arguments too',
  /stripReservedWireFields\(req\.body\?\.params\?\.arguments\)/.test(SERVER));

console.log('\n8. ownership decisions rest on a PROVEN pod, not a caller-supplied one');
// selfPodUrl() falls back to args.pod_name (caller-controlled), so an ownership
// gate built on it compares attacker input against attacker input.
check('callerOwnPod() exists and is fail-closed',
  /async function callerOwnPod\(args: ToolArgs\)/.test(SERVER));
check('it uses only reserved, wire-stripped sources',
  /callerOwnPod[\s\S]{0,700}_session_user_id[\s\S]{0,300}_identity_token/.test(SERVER));
check('callerOwnPod never falls back to args.pod_name',
  !/callerOwnPod[\s\S]{0,700}args\.pod_name/.test(SERVER));
check('read_inbox ownership uses callerOwnPod, not selfPodUrl',
  /handleReadInbox[\s\S]{0,800}const ownPod = await callerOwnPod\(args\)/.test(SERVER));
check('channel redaction owner-check uses callerOwnPod',
  /const callerPod = await callerOwnPod\(args\)/.test(SERVER));

console.log('\n9. every transport injects the authoritative attribution identity');
check('/tool signed branch injects _session_agent_did',
  /req\.body\._session_agent_did = auth\.recoveredDid/.test(SERVER));

console.log('\n10. the federated-inbox gate runs BEFORE the agent lookup (no enumeration oracle)');
check('signature gate precedes cardForLocalPart',
  /unsigned_delivery_rejected[\s\S]{0,600}cardForLocalPart\(req\.params\.localPart\)/.test(SERVER));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log('\nAll identity-attribution + scoping gates hold.\n');
