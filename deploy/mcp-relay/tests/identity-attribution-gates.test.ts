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
/**
 * ★ COMMENTS ARE STRIPPED BEFORE ANY ASSERTION BELOW MATCHES, AND THAT IS NOT TIDINESS.
 *
 * Every check in this file is a regex over source TEXT, and several of them bound the
 * distance between two tokens (`guardedInvokeFetch[\s\S]{0,900}redirect: 'manual'`). That
 * makes them sensitive to something that is not behaviour: adding a long explanatory comment
 * between the two tokens pushes them apart and turns a security assertion RED while the code
 * it describes is unchanged. That happened — a production-incident note written inside
 * `guardedInvokeFetchLanded` failed both R4 redirect checks with the redirect handling fully
 * intact — and the pressure it creates is to shorten the comment, i.e. to delete the
 * explanation because a test cannot see past it.
 *
 * The converse is worse and this repo has already paid for it: a bare `/Strict-Transport-
 * Security/` was satisfied by a RATIONALE COMMENT left behind after the real `setHeader` was
 * deleted, so the mutant survived. A comment must be able neither to satisfy nor to defeat an
 * assertion about code.
 *
 * ★ AND THE STRIPPER ITSELF COULD DELETE CODE, WHICH IS THE SAME DEFECT INVERTED.
 *
 * This file used to carry its own `src.replace(/\/\*[\s\S]*?\*\//g,'')` over raw text.
 * `/*` is two ordinary characters and server.ts contains them inside `//` comments
 * (`// ── /amep/* — AMEP engine …`) and inside string literals, each of which opened a
 * phantom block comment that ran to the next real star-slash: 14,442 lines in, 9,068 out,
 * ~596 lines of executable code missing from the view these assertions read. So a comment
 * could no longer SATISFY an assertion but could now DEFEAT one — measured against
 * `tests/cors-allowlist.test.ts`, whose credentials guard passed with a real
 * `Access-Control-Allow-Credentials` middleware live inside an eaten span.
 *
 * The shared, parser-based stripper is in `./strip-comments.ts`, with its own suite
 * (`strip-comments.test.ts`) reconstructing that exploit. One implementation, so the next
 * gate that needs this cannot write a fourth broken copy.
 */
import { stripComments } from './strip-comments.js';

const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const REACH = readFileSync(join(here, '..', 'reachability.ts'), 'utf8');
/**
 * The outbound HTTP layer — pools, `solidFetch`, `assertInvokeTargetAllowed` and the
 * screen-every-hop redirect loop — moved out of server.ts into `egress.ts` so the SSRF
 * address screen's WIRING could be exercised by a real test rather than by a regex.
 * The R4 assertions below follow it: they are about the redirect loop, and the redirect
 * loop is here now. Concatenated rather than switched over so a check that names a token
 * from EITHER file keeps working, and so moving a function between the two cannot
 * silently turn one of these gates off.
 */
const EGRESS = readFileSync(join(here, '..', 'egress.ts'), 'utf8');

/**
 * ★ TWO VIEWS, ON PURPOSE — and the first attempt at this used only the stripped one and
 * broke four assertions, which is what taught the distinction.
 *
 * Some checks in this file are about PROSE and must read the raw text: "the misleading
 * 'carry no secret' comment is gone from reachability.ts" and "reachability.ts warns that
 * non-native values are secrets/PII" are assertions that a WARNING exists. Stripping
 * comments makes those unsatisfiable no matter what the file says.
 *
 * The DISTANCE checks are the opposite: they must not see comments at all. Use `SERVER_CODE`
 * for any assertion whose meaning is "these two tokens are near each other", and raw `SERVER`
 * for anything whose subject is the documentation.
 */
const SERVER_CODE = stripComments(SERVER, 'server.ts');
/** The same two views over the egress layer. */
const EGRESS_CODE = stripComments(EGRESS, 'egress.ts');

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

console.log('\n3. BOTH REST transports inject identity through ONE shared helper');
// /mcp injects inline (args._session_agent_did = authContext.agentId). /tool and
// /messages used to inject inline TOO — and /messages had drifted: it set
// _session_agent_did / owner_webid / pod_name but NOT _session_user_id, the one field
// requireOwnPod reads, so it refused every own-pod write on that transport as if the
// caller were unauthenticated. Both REST transports now route through
// injectRestVerifiedIdentity, so the fields cannot diverge per-transport again. These
// assertions bind to the helper's CODE (target.<field> = <source>), never its prose.
check('a shared REST identity-injection helper exists',
  /function injectRestVerifiedIdentity\(\s*target: Record<string, unknown>,\s*auth: SignedAuthResult,\s*viaSignature: boolean,?\s*\): void/.test(SERVER));
check('the helper sets _session_user_id in BOTH branches (the field the ownership gates read)',
  /target\._session_user_id = ownPod;/.test(SERVER)
  && /if \(auth\.userId\) target\._session_user_id = auth\.userId;/.test(SERVER));
check('the helper sets the _session_agent_did attribution identity in both branches',
  /target\._session_agent_did = auth\.recoveredDid;/.test(SERVER)
  && /if \(auth\.agentId\) target\._session_agent_did = auth\.agentId;/.test(SERVER));
check('/tool routes through the helper with NO inline _session_user_id copy left to drift',
  /injectRestVerifiedIdentity\(req\.body, auth, viaSignature\)/.test(SERVER)
  && !/req\.body\._session_user_id = auth\.userId/.test(SERVER));
check('/messages routes through the helper — this is what fixes its requireOwnPod refusal',
  /injectRestVerifiedIdentity\(args, auth, viaSignature\)/.test(SERVER)
  && !/args\._session_agent_did = auth\.recoveredDid/.test(SERVER));
check('/mcp still injects _session_agent_did for every tool',
  /args\._session_agent_did = authContext\.agentId;/.test(SERVER));
// ★ THIS USED TO MATCH AN INLINE `for (const reserved of ['_session_bearer', …])` LOOP,
// of which there were two — one on /mcp and one on /tool — each a hand-copy of
// RESERVED_WIRE_FIELDS. The check passed while the constant it was really about was NOT
// the single source of truth: adding a name to RESERVED_WIRE_FIELDS left both inline
// copies short, so the transports that used them kept accepting the new field from the
// wire. Both loops now call stripReservedWireFields, so the property belongs to the
// constant and this assertion reads it there.
check('_session_agent_did is in the reserved wire-strip list',
  /const RESERVED_WIRE_FIELDS = \[[\s\S]*?'_session_agent_did'[\s\S]*?\] as const/.test(SERVER));
check('...and no transport keeps a hand-copied duplicate of that list',
  !/for \(const reserved of \['_session_bearer'/.test(SERVER),
  'a second copy is a list that silently stops matching the first');

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
// Check the BODY, not the surrounding prose — the doc comment legitimately names
// args.pod_name when explaining why it must not be used.
const ownPodBody = (/async function callerOwnPod\(args: ToolArgs\)[^{]*\{([\s\S]*?)\n\}/.exec(SERVER) ?? [])[1] ?? '';
check('callerOwnPod body never reads args.pod_name',
  ownPodBody.length > 0 && !/args\.pod_name/.test(ownPodBody));
check('read_inbox ownership uses callerOwnPod, not selfPodUrl',
  /handleReadInbox[\s\S]{0,800}const ownPod = await callerOwnPod\(args\)/.test(SERVER));
check('channel redaction owner-check uses callerOwnPod',
  /const callerPod = await callerOwnPod\(args\)/.test(SERVER));

console.log('\n9. the signed-request branch binds attribution to the recovered DID');
// Both REST transports share the helper; its signature branch OVERRIDES agent_id AND
// _session_agent_did with the DID the signature recovered — a caller cannot claim one
// agent_id while signing with another wallet.
check('the shared helper overrides agent_id + _session_agent_did with the recovered DID',
  /target\.agent_id = auth\.recoveredDid;\s*target\._session_agent_did = auth\.recoveredDid;/.test(SERVER));

console.log('\n10. the federated-inbox gate runs BEFORE the agent lookup (no enumeration oracle)');
check('signature gate precedes cardForLocalPart',
  /unsigned_delivery_rejected[\s\S]{0,600}cardForLocalPart\(req\.params\.localPart\)/.test(SERVER));

console.log('\n11. R1 — the relay key is never handed to a caller-supplied URL (decryption oracle)');
// publish_context makes relayAgentKey a recipient of EVERY envelope (including
// visibility:'private'), so decrypting a caller-named URL with it returned any
// user's private plaintext — and get_descriptor needs no credential at all.
check('recipientKeyFor() exists and is own-pod-scoped + fail-closed',
  /async function recipientKeyFor\(/.test(SERVER)
  && /recipientKeyFor[\s\S]{0,900}callerOwnPod\(args\)/.test(SERVER));
const rawKeySinks = SERVER.match(/recipientKeyPair: relayAgentKey/g) ?? [];
check('at most ONE raw relayAgentKey sink remains (loadDynamicTools, startup-internal)',
  rawKeySinks.length <= 1, `found ${rawKeySinks.length}`);
check('get_descriptor decrypts only via recipientKeyFor',
  /handleGetDescriptor[\s\S]{0,3000}recipientKeyPair: await recipientKeyFor\(args, url\)/.test(SERVER));
check('the followed dcat:accessURL is scoped too',
  /recipientKeyPair: await recipientKeyFor\(args, link\.accessURL\)/.test(SERVER));
check('/render binds decryption to the token-verified identity',
  /recipientKeyFor\(\{ _session_user_id: auth\.userId \}/.test(SERVER));

console.log('\n12. R6 — the federated inbox gate is not a header-presence check');
// `-H 'Signature: x'` satisfied the previous gate in one curl flag.
check('no header-presence signature shortcut remains',
  !/hasHttpSignature/.test(SERVER));
check('the route fails closed on the env flag alone',
  /RELAY_FEDERATION_ACCEPT_UNSIGNED !== '1'/.test(SERVER));

console.log('\n13. R8 — the bearer branch injects the attribution identity');
// The helper's bearer branch (shared by /tool + /messages) sets _session_agent_did from
// the resolved agent, so callerAgentId() cannot fall through to a forgeable value.
check('the shared helper sets _session_agent_did from the resolved agent on the bearer path',
  /if \(auth\.agentId\) target\._session_agent_did = auth\.agentId;/.test(SERVER));

console.log('\n14. R4 — the egress guard screens EVERY redirect hop, not just the first URL');
// solidFetch calls fetch() with no `redirect` option → undici follows up to 20 hops
// unscreened, so `302 Location: http://169.254.169.254/…` defeated the guard in one hop.
// EGRESS_CODE, not EGRESS: both of these bound the DISTANCE between two tokens, so a long
// comment between them fails the check with the code unchanged. That is not hypothetical —
// the production-incident note sitting inside guardedInvokeFetchLanded failed both of these
// while the manual redirect loop and the per-hop screen were fully intact.
check('guardedInvokeFetch follows redirects manually',
  /guardedInvokeFetch[\s\S]{0,900}redirect: 'manual'/.test(EGRESS_CODE));
check('it re-screens each hop inside the loop',
  /for \(let hop = 0; hop <= GUARDED_MAX_REDIRECTS[\s\S]{0,200}assertInvokeTargetAllowed\(target\)/.test(EGRESS_CODE));
check('it bounds the hop count',
  /GUARDED_MAX_REDIRECTS/.test(EGRESS) && /too many redirects/.test(EGRESS));
check('relative Location values are resolved against the current hop',
  /new URL\(loc, target\)/.test(EGRESS));
// ★ AND THE ADDRESS SCREEN IS ELIGIBLE ON THE DISPATCHER THE LOOP DIALS THROUGH — but it
// is GATED, and this file must not imply otherwise. #260 turned it on and broke every
// shape-gated publish; #261 unwound it; #263 turned it on again and broke them again,
// caught by a live probe returning `iep:shapeUnfetchable`. It now sits behind
// `screenAddresses`, default OFF, so that the one missing measurement can be taken from a
// real deploy instead of guessed a third time — see `EgressConfig.screenAddresses`.
//
// This is a SOURCE-TEXT check, which is the weak kind: a regex exactly like this one was
// satisfied while the dispatcher was fully detached, and that is how M5 shipped. The real
// coverage is over a live socket in tests/egress-dns-screen.test.ts, including the DEFAULT
// being off. What this line is for is the reviewer who reads this file to answer "what
// does the egress guard cover" — the honest answer is "the name, always; the address, only
// when RELAY_ADDRESS_SCREEN=1".
check('the public branch is wired to the address-screening pool, gated by screenAddresses',
  /mode === 'public' && screenAddresses \? \{ dispatcher: guardedEgressAgent \}/.test(EGRESS_CODE));
check('and that gate defaults ON in the relay — only an explicit "0" turns the screen off',
  /screenAddresses:\s*process\.env\['RELAY_ADDRESS_SCREEN'\] !== '0'/.test(SERVER));

console.log('\n15. R4 — caller-supplied URLs no longer reach raw solidFetch');
check('get_descriptor fetches through the guard',
  /await guardedInvokeFetch\(url, \{/.test(SERVER));
check('the upstream status/statusText port-scan oracle is closed',
  !/error: `\$\{resp\.status\} \$\{resp\.statusText\}`/.test(SERVER)
  && /descriptor could not be retrieved/.test(SERVER));
check('webhook DELIVERY re-screens (was a bare global fetch)',
  /Re-screen at DELIVERY[\s\S]{0,500}assertInvokeTargetAllowed\(url\)/.test(SERVER));

console.log('\n16. R2 — relay-credentialed writes require a PROVEN own pod');
// solidFetch is root-equivalent against the internal CSS origin, so any handler that
// derived its write target from args.pod_name/pod_url was an "any caller writes any
// pod" primitive.
check('requireOwnPod() exists and is fail-closed on an unproven caller',
  /async function requireOwnPod\(/.test(SERVER)
  && /requireOwnPod[\s\S]{0,1400}authentication required/.test(SERVER));
check('it compares canonical pod keys',
  /requireOwnPod[\s\S]{0,1600}canonicalPodKey\(targetPodUrl\) !== canonicalPodKey\(own\)/.test(SERVER));
for (const tool of ['register_agent', 'revoke_agent', 'publish_directory', 'rebuild_manifest', 'pgsl_ingest']) {
  check(`${tool} is own-pod gated`,
    new RegExp(`requireOwnPod\\(args, podUrl, '${tool}'\\)`).test(SERVER));
}
check('publish_context restricts the SELF-GRANT (not the publish) to the own pod',
  /requireOwnPod\(args, podUrl, 'publish_context:self-grant'\)/.test(SERVER)
  && /if \(!me && selfGrantOk\)/.test(SERVER));
check('set_reachability derives its pod from callerOwnPod, not selfPodUrl',
  /const podUrl = await callerOwnPod\(args\);/.test(SERVER));
check('the cross-pod escape hatch is OFF by default and logs loudly',
  /RELAY_ALLOW_CROSS_POD_WRITES === '1'/.test(SERVER)
  && /\[SECURITY\] cross-pod \$\{tool\} ALLOWED/.test(SERVER));

console.log('\n17. R3 — state-mutating tools are auth-gated; the dead PUBLIC_TOOLS set is gone');
const authSet = (/const AUTH_REQUIRED_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(SERVER) ?? [])[1] ?? '';
for (const t of ['discover_directory', 'remove_pod', 'subscribe_all', 'unsubscribe_from_pod', 'pgsl_ingest']) {
  check(`${t} is in AUTH_REQUIRED_TOOLS`, new RegExp(`'${t}'`).test(authSet));
}
// Pure reads MUST stay public: live published artifacts call them unauthenticated,
// and R1 + R4 already removed their teeth.
for (const t of ['get_descriptor', 'discover_all', 'discover_context']) {
  check(`${t} stays PUBLIC (artifacts depend on it)`, !new RegExp(`'${t}'`).test(authSet));
}
check('the dead PUBLIC_TOOLS set is deleted (it looked like a gate but was never read)',
  !/const PUBLIC_TOOLS = new Set/.test(SERVER));

console.log('\n18. R7 — OAuth write-scope is enforced beyond /mcp');
check('/identity-token requires write scope (it returns a STRONGER credential)',
  /identity-token[\s\S]{0,1400}hasWriteOauthScope/.test(SERVER));
check('the revoke route requires write scope',
  /agents\/:agentIri\/revoke[\s\S]{0,1600}hasWriteOauthScope\(authInfo\.scopes\)/.test(SERVER));
const scopeCalls = SERVER.match(/hasWriteOauthScope\(/g) ?? [];
check('hasWriteOauthScope has >1 call site (was /mcp only)',
  scopeCalls.length >= 4, `found ${scopeCalls.length}`);

console.log('\n19. R9 — unbounded OAuth state is capped and swept');
const OAUTH = readFileSync(join(here, '..', 'oauth-provider.ts'), 'utf8');
check('the unauthenticated-write codeDpopJkt map is capped',
  /CODE_DPOP_MAX/.test(OAUTH) && /bindAuthorizationCodeDpop[\s\S]{0,700}CODE_DPOP_MAX/.test(OAUTH));
check('a periodic sweeper exists (there was none)',
  /setInterval\(\(\) => this\.sweepExpired\(\)/.test(OAUTH));
check('the sweeper honours the expiresAt fields nothing read',
  /sweepExpired[\s\S]{0,900}this\.authCodes[\s\S]{0,400}this\.pendingAuthorizations/.test(OAUTH));
check('the timer is unref\'d so it cannot hold the process open',
  /unref\?\.\(\)/.test(OAUTH));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log('\nAll identity-attribution + scoping gates hold.\n');
