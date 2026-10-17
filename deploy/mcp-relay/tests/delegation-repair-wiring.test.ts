/** Production wiring remains separate from the importable repair's runtime tests. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './strip-comments.js';
import { isDelegationRepairRequest } from '../delegation-repair-only.js';

const server = stripComments(readFileSync(new URL('../server.ts', import.meta.url), 'utf8'), 'server.ts');
const helper = stripComments(readFileSync(new URL('../delegation-repair-only.ts', import.meta.url), 'utf8'), 'delegation-repair-only.ts');
const handler = server.slice(server.indexOf('async function handleRegisterAgent('), server.indexOf('async function handleVerifyAgent('));
assert.ok(handler.length > 1000, 'locate the actual registration handler');
const ownGate = handler.indexOf("requireOwnPod(args, podUrl, 'register_agent')");
const repair = handler.indexOf('if (args.repair_only === true)');
const legacyMutation = handler.indexOf('const grantTenantAdmin');
assert.ok(ownGate >= 0 && repair > ownGate && legacyMutation > repair,
  'repair is own-pod gated and returns before ordinary registration mutations');
assert.match(handler, /Object\.hasOwn\(args, 'repair_only'\) && typeof args\.repair_only !== 'boolean'/,
  'malformed flags cannot silently select ordinary registration');
const branch = handler.slice(repair, legacyMutation);
assert.match(branch, /return JSON\.stringify\(await repairOnlySessionDelegation\(args,/);
assert.match(branch, /ownPodUrl: await callerOwnPod\(args\)/,
  'the helper receives authenticated ownership rather than a caller pod claim');
assert.match(branch, /identityBaseUrl: IDENTITY_URL/);
assert.match(branch, /canonicalPodKey, fetch: solidFetch, getSigner: getDelegationSigner/);
assert.match(branch, /verifier: delegationVerifier/);
const repairOnly = helper.slice(helper.indexOf('export async function repairOnlySessionDelegation('));
assert.doesNotMatch(repairOnly, /writeAgentRegistry|addAuthorizedAgent|writeDelegationCredential|callerAgentId|relayProfileCache/,
  'repair has no registry writer, ordinary credential PUT or caller-identity fallback');
assert.match(helper, /typeof args\._session_agent_did !== 'string'/);
assert.match(helper, /args\.agent_id !== session/);
assert.match(helper, /args\._session_owner_webid !== profile\.webId/,
  'the owner comes from stripped authenticated context, independently of caller owner_webid');
assert.match(server, /'_session_owner_webid'/);
assert.match(server, /args\._session_owner_webid = authContext\.ownerWebId/);
assert.match(server, /target\._session_owner_webid = auth\.recoveredDid/);
assert.match(server, /target\._session_owner_webid = `\$\{IDENTITY_URL\}\/users\/\$\{auth\.userId\}\/profile#me`/);
assert.equal((server.match(/!isDelegationRepairRequest\(name, args\)/g) ?? []).length, 2,
  'MCP directory registration and lazy bootstrap both exclude repair calls');
assert.match(server, /!isDelegationRepairRequest\(toolName, req\.body\)/,
  'REST directory registration excludes repair calls');
for (const repair_only of [true, null, 'true', 1]) {
  assert.equal(isDelegationRepairRequest('register_agent', { repair_only }), true);
}
assert.equal(isDelegationRepairRequest('register_agent', {}), false);
assert.equal(isDelegationRepairRequest('register_agent', { repair_only: false }), false);
assert.equal(isDelegationRepairRequest('verify_agent', { repair_only: true }), false);
assert.match(handler.slice(legacyMutation), /writeRegistrationDelegationCredential\(credential, podUrl, \{\s*fetch: solidFetch, verifier: delegationVerifier, profile, agent/,
  'the existing explicitly authorized full-registration path can update a repaired native-managed VC');
const status = server.slice(server.indexOf('async function handleGetPodStatus('), server.indexOf('async function handleSubscribe('));
assert.match(status, /capabilities: \{ register_agent_repair_only: true \}/);
const statusSchema = server.slice(server.indexOf('const GET_POD_STATUS_OUTPUT'), server.indexOf('const ANALYZE_QUESTION_OUTPUT'));
assert.match(statusSchema, /register_agent_repair_only: \{ type: 'boolean'/);
const definition = server.slice(server.indexOf("name: 'register_agent'"), server.indexOf("name: 'revoke_agent'"));
assert.match(definition, /repair_only: \{ type: 'boolean'/);
assert.match(readFileSync(new URL('../../Dockerfile.relay', import.meta.url), 'utf8'),
  /COPY deploy\/mcp-relay\/delegation-repair-only\.ts \.\//);
process.stdout.write('Delegation repair ownership, implicit-write exclusion, schema and image wiring passed.\n');
