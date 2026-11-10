#!/usr/bin/env tsx
/**
 * What the relay signs says WHICH OAuth client asked: `client_id`, the session's own, never the
 * caller's.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `sign_request` (and `act` with `sign_payload: true`, which composes it) signs a payload with the
 * relay's delegation key and names the agent of the caller's session in `agent_id`. That agent is
 * `<surface>-<userId>`, and the surface comes from the `client_name` an OAuth client picked for
 * itself when it registered. A vertical that read "an agent named practice-evidence-…" as "our own
 * web app asked" could be answered by any other app that registered under that name.
 *
 * A client's id is not picked that way: a Client ID Metadata Document client is identified by the
 * https URL of its metadata document (the relay fetches it and requires it to name that URL), and a
 * dynamically registered client by an id the relay generated. So the relay now signs the client_id
 * its session's access token was issued to, under `client_id`. This file pins that contract:
 *
 *   §1 an OAuth session's client_id is signed, verbatim, by sign_request and by act alike;
 *   §2 a caller's own `client_id` (top level, under `payload` as an object or as JSON text, through
 *      act) and a caller's own `_session_client_id` never reach the signed payload;
 *   §3 with no OAuth client (the legacy API key, a token naming none, the REST transports) the field
 *      is absent, not invented;
 *   §4 the result's hint does not talk an assistant out of the urn form a site handed it;
 *   §5 the operator's switch: nothing is signed as `client_id` until RELAY_SIGN_CLIENT_ID=1, because
 *      the verticals that accept the field ship in other images and roll out on their own;
 *   §6 a caller's dropped `client_id` is not dropped silently: the result says it was not signed;
 *   §0 the wiring the slices stand for: one writer of the session field, reserved on every
 *      transport, and absent from the REST injection and from an observer's follow-up act; and the
 *      contract tells a bridge that a DCR id is not stable across registrations.
 *
 * ── WITH WHICH INSTRUMENT ────────────────────────────────────────────────────
 *
 * The one sign-request-alone-signs-what-act-signs.test.ts uses: server.ts calls app.listen() at
 * module scope and cannot be imported, so the /mcp dispatcher's argument injection and the
 * declarations it and `handleSignRequest` need are sliced out by source anchors into a temp module;
 * signed-act.ts is imported as it ships. The relay's delegation signer is a stand-in that records
 * what it was asked to sign.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/sign-request-names-the-oauth-client.test.ts
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { signedActPayload } from '../signed-act.js';
import { POD_URL_INJECTED, POD_NAME_INJECTED } from '../pod-selector.js';
import { discoverySelectorRefusal } from '../required-args.js';
import { principalIri } from '../amep-session-bridge.js';
import { publicStoreSpelling } from '../url-rewrite.js';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
const CODE = stripComments(SERVER, 'server.ts');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The source between two anchors, or a loud stop: a slice that finds nothing tests nothing. */
function between(text: string, from: string, to: string, label: string, startAt = 0): string {
  const a = text.indexOf(from, startAt);
  const b = a < 0 ? -1 : text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) {
    console.error(`\nFAIL — cannot locate ${label} in server.ts (from=${a}, to=${b}).`);
    console.error('  If it was renamed or moved, this suite is testing nothing. Re-anchor it.');
    process.exit(1);
  }
  return text.slice(a, b);
}

// ── The fixture deployment ───────────────────────────────────────────────────
const CSS = 'http://css.fixture.internal:3456/';
const PUB = 'https://gate.fixture.example/';
const USER = 'u-pk-aaaa11112222';
const IDENTITY_TOKEN = 'identity-token-of-this-fixture';
/** The web app of a fictional bridge, signed in by its Client ID Metadata Document. */
const CIMD_CLIENT = 'https://bridge.fixture.example/ui/oauth/client.json';
/** An id the relay's dynamic registration would generate (16 random bytes, hex). */
const DCR_CLIENT = '0123456789abcdef0123456789abcdef';
/** What a caller would like the relay to say instead. */
const IMPOSTOR = 'https://impostor.fixture.example/ui/oauth/client.json';

type Auth = Record<string, unknown> & { agentId: string; ownerWebId: string; userId: string };
const oauth = (clientId: string | undefined, surface = 'practice-evidence'): Auth => ({
  agentId: `did:web:identity.fixture.example:agents:${surface}-${USER}`,
  ownerWebId: `${PUB}${USER}/profile/card#me`,
  userId: USER,
  podUrl: `${CSS}${USER}/`,
  identityToken: IDENTITY_TOKEN,
  accessToken: 'access-token-of-this-fixture',
  oauthScopes: new Set(['mcp']),
  ...(clientId !== undefined ? { clientId } : {}),
});
/** The shape checkMcpApiKey returns: an operator identity, no OAuth client, no token. */
const LEGACY_API_KEY: Auth = {
  agentId: 'urn:agent:fixture:relay-apikey:maintainer',
  ownerWebId: 'https://identity.fixture.example/users/maintainer/profile#me',
  userId: 'maintainer',
};
const DESCRIPTOR = 'https://bridge.fixture.example/affordances';
const ACTION = 'urn:iep:action:pev:start-attempt';
const PAYLOAD = { v: 1, action: ACTION, pod_url: `${PUB}${USER}/`, nonce: 'start-attempt-q8Xr2mVp7LkA9dTz' };

// ── The slices ───────────────────────────────────────────────────────────────
const callAt = SERVER.indexOf('async function callWithSession(');
const INJECTION_END = '      if (!authContext.provisionalPlay && !isReadOnlyResourceCall(name, args) && !isDelegationRepairRequest(name, args)) {';
const injection = between(SERVER, 'const args: ToolArgs = { ...(rawArgs ?? {}) };', INJECTION_END, "the /mcp dispatcher's argument injection", Math.max(callAt, 0));
const injectionCode = stripComments(injection, 'injection.ts');
const open = (injectionCode.match(/\{/g) ?? []).length - (injectionCode.match(/\}/g) ?? []).length;
check('the injection slice starts in callWithSession and stops inside exactly one open block', callAt > -1 && open === 1, `callAt=${callAt}, open=${open}`);

const slices = [
  between(SERVER, 'function relaySignsClientId(): boolean {', 'async function handleSignRequest(', 'relaySignsClientId'),
  between(SERVER, 'const RESERVED_WIRE_FIELDS = [', 'function unwrapSignedPayloadInto(', 'stripReservedWireFields'),
  between(SERVER, 'const asPublicPodUrl = (url: string | undefined): string | undefined =>', 'const IDENTITY_URL', 'asPublicPodUrl'),
  between(SERVER, 'async function selfPodUrl(args: ToolArgs): Promise<string | undefined> {', '// Build the per-call synthetic', 'selfPodUrl'),
  between(SERVER, 'function normalizeActPayload(payload: unknown): unknown {', '/** Add a recipient wrap', 'normalizeActPayload'),
  between(SERVER, 'async function handleSignRequest(args: ToolArgs): Promise<string> {', 'async function handleSetReachability(', 'handleSignRequest'),
];

interface Extracted {
  install(deps: Record<string, unknown>): void;
  mcpArgs(name: string, rawArgs: Record<string, unknown>, authContext: Auth): Record<string, unknown>;
  stripReservedWireFields(o: unknown): void;
  handleSignRequest(args: Record<string, unknown>): Promise<string>;
  normalizeActPayload(payload: unknown): unknown;
  signedMessages: string[];
}

const tmpDir = mkdtempSync(join(tmpdir(), 'sign-request-client-'));
const tmpModule = join(tmpDir, 'sign-request-client-extracted.ts');
let mod: Extracted;
try {
  writeFileSync(
    tmpModule,
    'type ToolArgs = Record<string, unknown>;\n'
    + 'let POD_URL_INJECTED: string; let POD_NAME_INJECTED: string;\n'
    + 'let principalIri: any; let discoverySelectorRefusal: any; let publicStoreSpelling: any; let createHash: any;\n'
    + `const CSS_URL = ${JSON.stringify(CSS)};\n`
    + `const CSS_PUBLIC_URL = ${JSON.stringify(PUB)};\n`
    + `async function fetchIdentityMe(token: string) { return token === ${JSON.stringify(IDENTITY_TOKEN)} ? { userId: ${JSON.stringify(USER)} } : undefined; }\n`
    + 'export const signedMessages: string[] = [];\n'
    + 'async function getDelegationSigner() {\n'
    + '  return async (message: string) => { signedMessages.push(message); return { signature: `0xsig-${signedMessages.length}`, signerAddress: "0x00000000000000000000000000000000000000aa" }; };\n'
    + '}\n'
    + 'export function install(d: any): void {\n'
    + '  ({ POD_URL_INJECTED, POD_NAME_INJECTED, principalIri, discoverySelectorRefusal, publicStoreSpelling, createHash } = d);\n'
    + '}\n'
    + slices.join('\n')
    + '\nexport function mcpArgs(name: string, rawArgs: Record<string, unknown> | undefined, authContext: any): any {\n'
    + injection
    + '\n    }\n    return args;\n}\n'
    + 'export { handleSignRequest, normalizeActPayload, stripReservedWireFields };\n',
    'utf8',
  );
  mod = await import(pathToFileURL(tmpModule).href) as Extracted;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
mod.install({ POD_URL_INJECTED, POD_NAME_INJECTED, principalIri, discoverySelectorRefusal, publicStoreSpelling, createHash });

/** sign_request through the dispatcher, as a chat app's tools/call reaches it. */
async function bySignRequest(raw: Record<string, unknown>, auth: Auth): Promise<{ out: Record<string, unknown>; signed: Record<string, unknown>; args: Record<string, unknown> }> {
  const args = mod.mcpArgs('sign_request', raw, auth);
  const out = JSON.parse(await mod.handleSignRequest(args)) as Record<string, unknown>;
  check('(the relay signed)', typeof out['_signed_payload'] === 'string', JSON.stringify(out));
  return { out, signed: JSON.parse(String(out['_signed_payload'])) as Record<string, unknown>, args };
}
/** act with sign_payload: true, composed the way handleKernelAct composes it. */
async function byActSignPayload(payload: unknown, auth: Auth, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const args = mod.mcpArgs('act', { descriptor_url: DESCRIPTOR, action_iri: ACTION, sign_payload: true, payload, ...extra }, auth);
  const pair = await signedActPayload(args, mod.normalizeActPayload(args['payload'] ?? {}), mod.handleSignRequest) as Record<string, unknown>;
  return JSON.parse(String(pair['_signed_payload'])) as Record<string, unknown>;
}
/** The operator's switch (relaySignsClientId reads it on every call). */
const SWITCH = 'RELAY_SIGN_CLIENT_ID';
const switchAsFound = process.env[SWITCH];
const setSwitch = (value: string | undefined): void => {
  if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value;
};
const withoutTimestamp = (o: Record<string, unknown>): string => {
  const { timestamp: _t, ...rest } = o;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
};

// ── §0 THE WIRING THE SLICES STAND FOR ───────────────────────────────────────
console.log('\n0. one writer of the session client, reserved on every transport');
{
  const probe: Record<string, unknown> = { _session_client_id: IMPOSTOR, client_id: IMPOSTOR, keep: 1 };
  mod.stripReservedWireFields(probe);
  check('§0 _session_client_id is a reserved wire field (every transport strips it)',
    !('_session_client_id' in probe) && probe['keep'] === 1, JSON.stringify(probe));
  const writers = CODE.match(/_session_client_id\s*=(?!=)/g) ?? [];
  check('§0 exactly one place assigns _session_client_id: the /mcp injection, from the access token\'s client',
    writers.length === 1 && /if \(authContext\.clientId\) args\._session_client_id = authContext\.clientId;/.test(CODE),
    `${writers.length} assignment(s)`);
  check('§0 resolveAuthContext takes the client from the verified access token (reqAuth.clientId)',
    /typeof reqAuth\.clientId === 'string' && reqAuth\.clientId \? \{ clientId: reqAuth\.clientId \}/.test(CODE));
  const rest = between(CODE, 'function injectRestVerifiedIdentity(', '\n}\n', 'injectRestVerifiedIdentity');
  check('§0 the REST injection (identity bearer or wallet signature) names no OAuth client', !rest.includes('_session_client_id') && !rest.includes('clientId'));
  const follow = between(CODE, 'follow: (descriptor: string, selectedAction: string, payload: Record<string, unknown>) => handleKernelAct({', '}),', "the observer's follow-up act");
  check('§0 an observer\'s follow-up act names no client: the client did not ask for it', follow.includes('_session_agent_did') && !follow.includes('_session_client_id'));
  check('§0 signed-act.ts forwards the underscore session fields to sign_request (so act signs the client too)',
    /Object\.entries\(args\)\.filter\(\(\[k\]\) => k\.startsWith\('_'\)\)/.test(readFileSync(join(here, '..', 'signed-act.ts'), 'utf8')));
  // The contract a bridge reads: a DCR id belongs to one registration, so an exact comparison with
  // only the id a bridge holds now refuses tokens issued to its earlier one while they are live.
  // As prose: the comment's line breaks and leading stars folded to single spaces.
  const contract = between(SERVER, '── `client_id`: WHICH OAuth CLIENT ASKED', 'const sessionClientId', "handleSignRequest's client_id contract")
    .replace(/\s*\n\s*\*\s?/g, ' ');
  check('§0 the contract tells a bridge to compare against every id it used within a token\'s lifetime',
    /every id the bridge has used within a token's lifetime/.test(contract), 'missing');
  check('§0 …that a DCR id belongs to one registration and changes when the bridge registers again',
    /A DCR id belongs to one registration/.test(contract) && /registers again/.test(contract), 'missing');
  check('§0 …and to prefer CIMD, whose id is the same after a restart', /prefer CIMD/.test(contract), 'missing');
  check('§0 …and that absent never means "the web UI"', /never "the web UI"/.test(contract), 'missing');
}

// Sections 1 to 4 and 6 are about what the relay signs once the operator has turned it on (§5).
setSwitch('1');

// ── §1 AN OAuth SESSION'S CLIENT IS SIGNED ───────────────────────────────────
console.log('\n1. the session\'s client_id is signed, verbatim, both ways');
for (const [label, clientId] of [['a Client ID Metadata Document client', CIMD_CLIENT], ['a dynamically registered client', DCR_CLIENT]] as const) {
  const auth = oauth(clientId);
  const alone = await bySignRequest({ payload: PAYLOAD }, auth);
  check(`§1 ${label}: the dispatcher hands sign_request the token's client as _session_client_id`, alone.args['_session_client_id'] === clientId);
  check(`§1 ${label}: sign_request signs client_id = the token's client_id`, alone.signed['client_id'] === clientId, JSON.stringify(alone.signed));
  check(`§1 ${label}: beside the session's agent and the relay's timestamp`,
    alone.signed['agent_id'] === auth.agentId && typeof alone.signed['timestamp'] === 'string' && alone.signed['pod_url'] === PAYLOAD.pod_url);
  check(`§1 ${label}: the signature is over the text returned`,
    mod.signedMessages.includes(`sha256:${createHash('sha256').update(String(alone.out['_signed_payload']), 'utf8').digest('hex')}`));
  const composed = await byActSignPayload(PAYLOAD, auth);
  check(`§1 ${label}: act with sign_payload: true signs the same client_id`, composed['client_id'] === clientId, JSON.stringify(composed));
  check(`§1 ${label}: …and the same fields as sign_request called alone`, withoutTimestamp(alone.signed) === withoutTimestamp(composed));
  check(`§1 ${label}: no session plumbing rides in the signed payload`,
    Object.keys(alone.signed).every((k) => !k.startsWith('_')) && Object.keys(composed).every((k) => !k.startsWith('_')));
}
{
  // Same person, same surface name, two different clients: the agent is the same, the client is not.
  const real = await bySignRequest({ payload: PAYLOAD }, oauth(CIMD_CLIENT));
  const namesake = await bySignRequest({ payload: PAYLOAD }, oauth(DCR_CLIENT));
  check('§1 a client that registered under the same name signs the same agent_id but another client_id',
    real.signed['agent_id'] === namesake.signed['agent_id'] && real.signed['client_id'] !== namesake.signed['client_id']);
}

// ── §2 A CALLER'S OWN client_id NEVER REACHES THE SIGNED PAYLOAD ─────────────
console.log('\n2. a caller cannot choose the client_id that is signed');
const forged: Array<[string, Record<string, unknown>]> = [
  ['top-level client_id', { client_id: IMPOSTOR, payload: PAYLOAD }],
  ['client_id under payload (an object)', { payload: { ...PAYLOAD, client_id: IMPOSTOR } }],
  ['client_id under payload (JSON text)', { payload: JSON.stringify({ ...PAYLOAD, client_id: IMPOSTOR }) }],
  ['a wire _session_client_id', { _session_client_id: IMPOSTOR, payload: PAYLOAD }],
  ['_session_client_id under payload', { payload: { ...PAYLOAD, _session_client_id: IMPOSTOR } }],
  ['every one of them at once', { client_id: IMPOSTOR, _session_client_id: IMPOSTOR, payload: { ...PAYLOAD, client_id: IMPOSTOR, _session_client_id: IMPOSTOR } }],
];
for (const [label, raw] of forged) {
  const withClient = await bySignRequest(raw, oauth(CIMD_CLIENT));
  check(`§2 sign_request, ${label}: the session's client is signed, not the caller's`,
    withClient.signed['client_id'] === CIMD_CLIENT && !JSON.stringify(withClient.signed).includes(IMPOSTOR), JSON.stringify(withClient.signed));
  const noClient = await bySignRequest(raw, oauth(undefined));
  check(`§2 sign_request, ${label}, on a session with no client: no client_id at all`,
    !('client_id' in noClient.signed) && !JSON.stringify(noClient.signed).includes(IMPOSTOR), JSON.stringify(noClient.signed));
}
// (act's sign_payload signs an object payload only; JSON text there is refused before anything is
// signed, by signed-act.ts, so the JSON-text spelling is covered by sign_request above.)
for (const [label, payload] of [
  ['client_id in the payload', { ...PAYLOAD, client_id: IMPOSTOR }],
  ['_session_client_id in the payload', { ...PAYLOAD, _session_client_id: IMPOSTOR }],
] as const) {
  const withClient = await byActSignPayload(payload, oauth(CIMD_CLIENT));
  check(`§2 act sign_payload, ${label}: the session's client is signed`,
    withClient['client_id'] === CIMD_CLIENT && !JSON.stringify(withClient).includes(IMPOSTOR), JSON.stringify(withClient));
  const noClient = await byActSignPayload(payload, oauth(undefined));
  check(`§2 act sign_payload, ${label}, on a session with no client: no client_id at all`,
    !('client_id' in noClient) && !JSON.stringify(noClient).includes(IMPOSTOR), JSON.stringify(noClient));
}
{
  const viaAct = await byActSignPayload(PAYLOAD, oauth(undefined), { _session_client_id: IMPOSTOR, client_id: IMPOSTOR });
  check('§2 act sign_payload with a wire _session_client_id and client_id beside the payload: neither is signed',
    !('client_id' in viaAct) && !JSON.stringify(viaAct).includes(IMPOSTOR), JSON.stringify(viaAct));
}

// ── §3 ABSENT WHEN NO OAuth CLIENT IS KNOWN ──────────────────────────────────
console.log('\n3. no OAuth client, no client_id');
{
  const legacy = await bySignRequest({ payload: PAYLOAD }, LEGACY_API_KEY);
  check('§3 the legacy API key (no OAuth client): no client_id, and no session field for one',
    !('client_id' in legacy.signed) && !('_session_client_id' in legacy.args), JSON.stringify(legacy.signed));
  const tokenWithout = await bySignRequest({ payload: PAYLOAD }, oauth(undefined));
  check('§3 an access token that names no client: no client_id', !('client_id' in tokenWithout.signed));
  const empty = await bySignRequest({ payload: PAYLOAD }, oauth(''));
  check('§3 an empty client id is no client: no client_id', !('client_id' in empty.signed) && !('_session_client_id' in empty.args));
  // The REST transports (/tool, /messages) strip reserved fields first, then bind an identity-server
  // bearer or a wallet signature, neither of which names an OAuth client (§0). What sign_request
  // then sees, a caller's attempts included:
  const restArgs: Record<string, unknown> = {
    payload: { ...PAYLOAD, client_id: IMPOSTOR }, client_id: IMPOSTOR, _session_client_id: IMPOSTOR,
  };
  mod.stripReservedWireFields(restArgs);
  Object.assign(restArgs, { _session_agent_did: `did:web:identity.fixture.example:agents:mcp-client-${USER}`, _session_user_id: USER, pod_name: USER });
  const rest = JSON.parse(await mod.handleSignRequest(restArgs)) as Record<string, unknown>;
  const restSigned = JSON.parse(String(rest['_signed_payload'])) as Record<string, unknown>;
  check('§3 a REST call (no OAuth client), even one sending client_id and _session_client_id: no client_id',
    !('client_id' in restSigned) && !JSON.stringify(restSigned).includes(IMPOSTOR), JSON.stringify(restSigned));
}

// ── §4 THE HINT ──────────────────────────────────────────────────────────────
console.log('\n4. the hint keeps a site\'s urn form usable');
{
  const { out } = await bySignRequest({ payload: PAYLOAD }, oauth(CIMD_CLIENT));
  const hint = String(out['hint'] ?? '');
  check('§4 the hint says act takes the urn:iep:action form', hint.includes('urn:iep:action:') && /act takes/.test(hint), hint);
  check('§4 …and the URL form alike', /URL form/.test(hint), hint);
  check('§4 it points at what the site or the descriptor gives, as given', /site's instructions/.test(hint) && /descriptor/.test(hint) && /as given/.test(hint), hint);
  check('§4 it still says not to compose one by hand', /do not compose one by hand/.test(hint), hint);
  check('§4 it no longer says to prefer the URL form over the one a site gave', !/rather than composing/.test(hint) && !/iep:action \(a URL\)/.test(hint), hint);
  check('§4 it still names the envelope inputs and the act payload', hint.includes('`_signed_payload`') && hint.includes('`_signature`') && hint.includes('`payload` of `act`'), hint);
  check('§4 it stays short (at most 450 characters)', hint.length <= 450, `${hint.length} characters`);
}

// ── §5 THE OPERATOR'S SWITCH ─────────────────────────────────────────────────
console.log('\n5. nothing is signed as client_id until RELAY_SIGN_CLIENT_ID=1');
for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
  setSwitch(value);
  const label = value === undefined ? 'unset' : JSON.stringify(value);
  for (const [kind, clientId] of [['CIMD', CIMD_CLIENT], ['DCR', DCR_CLIENT]] as const) {
    const alone = await bySignRequest({ payload: PAYLOAD }, oauth(clientId));
    check(`§5 switch ${label}, a ${kind} client: sign_request signs no client_id`, !('client_id' in alone.signed), JSON.stringify(alone.signed));
    check(`§5 switch ${label}, a ${kind} client: …but signs everything else as before`,
      alone.signed['agent_id'] === oauth(clientId).agentId && typeof alone.signed['timestamp'] === 'string' && alone.signed['pod_url'] === PAYLOAD.pod_url);
    const composed = await byActSignPayload(PAYLOAD, oauth(clientId));
    check(`§5 switch ${label}, a ${kind} client: act with sign_payload signs no client_id`, !('client_id' in composed), JSON.stringify(composed));
  }
  const forgedOff = await bySignRequest({ client_id: IMPOSTOR, payload: { ...PAYLOAD, client_id: IMPOSTOR } }, oauth(CIMD_CLIENT));
  check(`§5 switch ${label}: a caller's client_id is still dropped, not signed in the relay's place`,
    !('client_id' in forgedOff.signed) && !JSON.stringify(forgedOff.signed).includes(IMPOSTOR), JSON.stringify(forgedOff.signed));
}
setSwitch('1');
{
  const on = await bySignRequest({ payload: PAYLOAD }, oauth(CIMD_CLIENT));
  check('§5 switch "1": the session\'s client is signed', on.signed['client_id'] === CIMD_CLIENT, JSON.stringify(on.signed));
  const health = between(CODE, "app.get('/health', (_req, res) => {", '\n});', 'the /health handler');
  check('§5 /health reports the switch as signsClientId', /signsClientId: relaySignsClientId\(\)/.test(health), 'missing');
  check('§5 handleSignRequest reads the switch on every call, before it takes the session client',
    /const sessionClientId = relaySignsClientId\(\) &&/.test(CODE), 'missing');
}

// ── §6 A DROPPED client_id IS NOT DROPPED SILENTLY ───────────────────────────
console.log('\n6. a caller\'s client_id is reported as not signed');
for (const [label, raw] of [
  ['top-level client_id', { client_id: 'lti-platform-client-7', payload: PAYLOAD }],
  ['client_id under payload (an object)', { payload: { ...PAYLOAD, client_id: 'lti-platform-client-7' } }],
  ['client_id under payload (JSON text)', { payload: JSON.stringify({ ...PAYLOAD, client_id: 'lti-platform-client-7' }) }],
] as const) {
  for (const value of ['1', undefined]) {
    setSwitch(value);
    const { out, signed } = await bySignRequest(raw, oauth(CIMD_CLIENT));
    const note = String(out['notSigned'] ?? '');
    check(`§6 ${label} (switch ${value ?? 'unset'}): the result says the caller's client_id was not signed`,
      /client_id/.test(note) && /not signed/.test(note) && /another name/.test(note), JSON.stringify(out));
    check(`§6 ${label} (switch ${value ?? 'unset'}): and it was not`, !JSON.stringify(signed).includes('lti-platform-client-7'), JSON.stringify(signed));
    check(`§6 ${label} (switch ${value ?? 'unset'}): the note is outside what is signed`, !('notSigned' in signed));
  }
}
setSwitch('1');
for (const [label, raw] of [
  ['no client_id at all', { payload: PAYLOAD }],
  ['only a forged _session_client_id', { _session_client_id: IMPOSTOR, payload: { ...PAYLOAD, _session_client_id: IMPOSTOR } }],
] as const) {
  const { out } = await bySignRequest(raw, oauth(CIMD_CLIENT));
  check(`§6 ${label}: no notSigned note`, !('notSigned' in out), JSON.stringify(out));
}
setSwitch(switchAsFound);

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
