#!/usr/bin/env tsx
/**
 * `sign_request` called on its own, through the /mcp dispatcher, signs what `act` with
 * `sign_payload: true` signs.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * A chat app can keep an old copy of the connector's tool list, in which `act` shows no
 * `sign_payload` input. The prompts the verticals hand a person's own assistant (the shared
 * chat-agent helpers in applications/_shared/chat-agent/) then tell it to make the same signed
 * request in two calls: `sign_request` with the step's payload, then `act` with the
 * `_signature` and `_signed_payload` it returned, unchanged. That instruction is only true if
 * the two ways sign the same fields, and they reach `handleSignRequest` with different
 * arguments:
 *
 *   - `act … sign_payload: true` hands it ONLY the underscore session fields plus `payload`
 *     (signed-act.ts filters every other argument out);
 *   - `sign_request`, called directly, sees EVERY top-level argument the /mcp dispatcher left
 *     there, including the defaults the dispatcher injected itself: `agent_id`, `owner_webid`,
 *     `pod_name` and `pod_url`.
 *
 * They agree only because each of those four names is reserved, deleted, or marked as the
 * dispatcher's own inside `handleSignRequest`. Nothing pinned that. The shared chat-agent test
 * hands one stub signer to both ways, so it shows that `signedActPayload` passes two fields
 * through and cannot see this difference; this file runs the shipped characters of both.
 *
 * It also pins why the prompts say to call `sign_request` with `payload` ALONE: a caller's other
 * top-level arguments are folded into what it signs (`handleSignRequest` accepts options at the
 * top level as well as under `payload`, because MCP clients vary), so an assistant that also
 * passes `descriptor_url` and `action_iri` signs those two as well.
 *
 * ── WITH WHICH INSTRUMENT ────────────────────────────────────────────────────
 *
 * server.ts calls app.listen() at module scope and cannot be imported, so the /mcp dispatcher's
 * argument injection (from its `const args` to the federation auto-registration after it) and
 * the declarations it and `handleSignRequest` need are sliced out by source anchors into a temp
 * module, the instrument same-pod-means-same-pod and follow-the-directory use. signed-act.ts is
 * imported as it ships. What the slices reach elsewhere is supplied as the smallest stand-ins:
 * the identity server's `/me` (which answers, the ordinary case), the relay's delegation signer
 * (which records the message it signs) and the store's two spellings. §0 checks the wiring the
 * slices stand for: the tool table maps each name to the handler sliced here, `act` composes
 * `signedActPayload` over them exactly as §2 does, and nothing between the end of the injection
 * slice and the tool's handler call writes to `args`, so what the slice hands `sign_request` is
 * what the shipped dispatcher hands it.
 *
 * ── THE RESIDUAL, STATED PLAINLY ─────────────────────────────────────────────
 *
 * `subject_pod_url` comes from `selfPodUrl`, which asks the identity server and, when that gives
 * no answer, falls back to `pod_name`. `sign_request` called directly has the dispatcher's
 * `pod_name`; `act`'s composition does not pass it on. So while the identity server cannot be
 * reached, the two ways can differ in `subject_pod_url` alone. §3 bounds that: every other field
 * still agrees. No bridge reads `subject_pod_url` as the pod an act targets.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/sign-request-alone-signs-what-act-signs.test.ts
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

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The source between two anchors, or a loud stop: a slice that finds nothing tests nothing. */
function between(from: string, to: string, label: string, startAt = 0): string {
  const a = SERVER.indexOf(from, startAt);
  const b = a < 0 ? -1 : SERVER.indexOf(to, a + from.length);
  if (a < 0 || b < 0) {
    console.error(`\nFAIL — cannot locate ${label} in server.ts (from=${a}, to=${b}).`);
    console.error('  If it was renamed or moved, this suite is testing nothing. Re-anchor it.');
    process.exit(1);
  }
  return SERVER.slice(a, b);
}

// ── The fixture deployment ───────────────────────────────────────────────────
const CSS = 'http://css.fixture.internal:3456/';
const PUB = 'https://gate.fixture.example/';
const USER = 'u-pk-aaaa11112222';
const AGENT = `did:web:identity.fixture.example:agents:chatgpt-${USER}`;
const IDENTITY_TOKEN = 'identity-token-of-this-fixture';
const AUTH = {
  agentId: AGENT,
  ownerWebId: `${PUB}${USER}/profile/card#me`,
  userId: USER,
  podUrl: `${CSS}${USER}/`,
  identityToken: IDENTITY_TOKEN,
  accessToken: 'access-token-of-this-fixture',
  oauthScopes: new Set(['mcp']),
};
const DESCRIPTOR = 'https://bridge.fixture.example/affordances';
const ACTION = 'urn:example:action:save-lines';

// ── The slices ───────────────────────────────────────────────────────────────
const callAt = SERVER.indexOf('async function callWithSession(');
const INJECTION_END = '      if (!authContext.provisionalPlay && !isReadOnlyResourceCall(name, args) && !isDelegationRepairRequest(name, args)) {';
const injection = between('const args: ToolArgs = { ...(rawArgs ?? {}) };', INJECTION_END, "the /mcp dispatcher's argument injection", Math.max(callAt, 0));
// The slice stops inside `if (authContext) {`: close what it leaves open, and say how much that
// is, so a restructured block fails here rather than compiling into something else.
const injectionCode = stripComments(injection, 'injection.ts');
const open = (injectionCode.match(/\{/g) ?? []).length - (injectionCode.match(/\}/g) ?? []).length;
check('the injection slice starts in callWithSession and stops inside exactly one open block', callAt > -1 && open === 1, `callAt=${callAt}, open=${open}`);

const slices = [
  between('const RESERVED_WIRE_FIELDS = [', 'function unwrapSignedPayloadInto(', 'stripReservedWireFields'),
  between('const asPublicPodUrl = (url: string | undefined): string | undefined =>', 'const IDENTITY_URL', 'asPublicPodUrl'),
  between('async function selfPodUrl(args: ToolArgs): Promise<string | undefined> {', '// Build the per-call synthetic', 'selfPodUrl'),
  between('function normalizeActPayload(payload: unknown): unknown {', '/** Add a recipient wrap', 'normalizeActPayload'),
  between('async function handleSignRequest(args: ToolArgs): Promise<string> {', 'async function handleSetReachability(', 'handleSignRequest'),
];

interface Extracted {
  install(deps: Record<string, unknown>): void;
  mcpArgs(name: string, rawArgs: Record<string, unknown>, authContext: typeof AUTH): Record<string, unknown>;
  handleSignRequest(args: Record<string, unknown>): Promise<string>;
  normalizeActPayload(payload: unknown): unknown;
  signedMessages: string[];
  identityAnswers: { on: boolean };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'sign-request-alone-'));
const tmpModule = join(tmpDir, 'sign-request-extracted.ts');
let mod: Extracted;
try {
  writeFileSync(
    tmpModule,
    // tsx transpiles rather than typechecks, so type positions are erased. The values the
    // slices name from elsewhere arrive through install(), from the relay's own modules.
    'type ToolArgs = Record<string, unknown>;\n'
    + 'let POD_URL_INJECTED: string; let POD_NAME_INJECTED: string;\n'
    + 'let principalIri: any; let discoverySelectorRefusal: any; let publicStoreSpelling: any; let createHash: any;\n'
    + `const CSS_URL = ${JSON.stringify(CSS)};\n`
    + `const CSS_PUBLIC_URL = ${JSON.stringify(PUB)};\n`
    + 'export const identityAnswers = { on: true };\n'
    + `async function fetchIdentityMe(token: string) { return identityAnswers.on && token === ${JSON.stringify(IDENTITY_TOKEN)} ? { userId: ${JSON.stringify(USER)} } : undefined; }\n`
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
    + 'export { handleSignRequest, normalizeActPayload };\n',
    'utf8',
  );
  mod = await import(pathToFileURL(tmpModule).href) as Extracted;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
mod.install({ POD_URL_INJECTED, POD_NAME_INJECTED, principalIri, discoverySelectorRefusal, publicStoreSpelling, createHash });

/** The two ways, each through the dispatcher as a chat app's tools/call reaches it. */
async function bySignRequest(raw: Record<string, unknown>): Promise<{ text: string; signed: Record<string, unknown>; args: Record<string, unknown> }> {
  const args = mod.mcpArgs('sign_request', raw, AUTH);
  const text = await mod.handleSignRequest(args);
  const out = JSON.parse(text) as Record<string, unknown>;
  return { text, signed: JSON.parse(String(out['_signed_payload'])) as Record<string, unknown>, args };
}
async function byActSignPayload(payload: Record<string, unknown>): Promise<{ pair: Record<string, unknown>; signed: Record<string, unknown> }> {
  // As handleKernelAct composes it (checked in §0).
  const args = mod.mcpArgs('act', { descriptor_url: DESCRIPTOR, action_iri: ACTION, sign_payload: true, payload }, AUTH);
  const pair = await signedActPayload(args, mod.normalizeActPayload(args['payload'] ?? {}), mod.handleSignRequest) as Record<string, unknown>;
  return { pair, signed: JSON.parse(String(pair['_signed_payload'])) as Record<string, unknown> };
}
const withoutTimestamp = (o: Record<string, unknown>): Record<string, unknown> => {
  const { timestamp: _t, ...rest } = o;
  return rest;
};
/** The parsed fields, compared as fields: the order a signer happened to write them in is not a difference. */
const fields = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

// ── §0 THE WIRING THE SLICES STAND FOR ───────────────────────────────────────
console.log('\n0. the shipped tool table and act composition are the ones sliced here');
{
  const code = stripComments(SERVER, 'server.ts');
  check('§0 sign_request is handled by handleSignRequest', /\bsign_request:\s*\{[^}]*handler:\s*handleSignRequest\b/.test(code));
  check('§0 act is handled by handleKernelAct', /\bact:\s*\{[^}]*handler:\s*handleKernelAct\b/.test(code));
  const actFrom = code.indexOf('async function handleKernelAct(');
  const actBody = actFrom < 0 ? '' : code.slice(actFrom, code.indexOf('\nasync function ', actFrom + 1));
  check('§0 act signs with signedActPayload over the normalized payload and handleSignRequest',
    actBody.includes('signedActPayload(args, normalizeActPayload(rawPayload ?? {}), handleSignRequest)')
      && actBody.includes("const rawPayload = args['payload'];"),
    actBody.slice(0, 120));
  // The injection slice stops at the federation auto-registration, and the handler runs after the
  // lazy pod-init block and the act / invoke_affordance plumbing. A field written to `args` in that
  // gap would be signed by sign_request called alone and never reach this file, so §2 would still
  // pass: nothing there may assign to, delete from or Object.assign onto `args`.
  const gapFrom = code.indexOf(INJECTION_END, code.indexOf('async function callWithSession('));
  const gapTo = gapFrom < 0 ? -1 : code.indexOf('await tool.handler(args)', gapFrom);
  const gap = gapFrom < 0 || gapTo < 0 ? '' : code.slice(gapFrom + INJECTION_END.length, gapTo);
  const ARGS_WRITE = /\bargs\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])|\bdelete\s+args\b|\bObject\.(?:assign|defineProperty|defineProperties)\(\s*args\b/g;
  const writes = gap.match(ARGS_WRITE) ?? [];
  check('§0 nothing between the end of the injection slice and the tool handler call writes to args',
    gap.includes('autoRegisterAgentCard(') && gap.includes('ensurePodInitialized(') && writes.length === 0,
    gap === '' ? `gap not found (from=${gapFrom}, to=${gapTo})` : writes.join(' | '));
  // The pattern itself, on the spellings it must catch and the reads it must not.
  for (const [src, isWrite] of [
    ["args.injected_late = 'x';", true], ["args['x'] = 1;", true], ['args.x ??= 1;', true], ['delete args.x;', true],
    ['Object.assign(args, extra);', true], ['args.x += 1;', true],
    ['const p = normalizeActPayload(args.payload ?? {});', false], ["if (args.x === 'y' || args.y >= 2 || args.z != 1 || args.w == null) {}", false],
    ['const id = (args._session_agent_id as string | undefined) ?? \'\';', false],
  ] as const) {
    check(`§0 the args-write pattern reads ${JSON.stringify(src)} as ${isWrite ? 'a write' : 'no write'}`, (src.match(ARGS_WRITE) ?? []).length > 0 === isWrite);
  }
}

// ── §1 THE DISPATCHER REALLY HANDS sign_request ITS OWN DEFAULTS ─────────────
//
// Without this, §2 could pass because the injection slice stopped injecting, not because
// handleSignRequest keeps those fields out.
console.log('\n1. called alone, sign_request sees the defaults the dispatcher injected');
const PAYLOAD = { v: 1, action: ACTION, pod_url: `${PUB}${USER}/`, nonce: 'save-lines-4-q8Xr2mVp7LkA9dTz', turnIndex: 4, lines: ['Hello.'] };
{
  const { args } = await bySignRequest({ payload: PAYLOAD });
  check('§1 agent_id, owner_webid, pod_name and pod_url are all at its top level',
    args['agent_id'] === AGENT && args['owner_webid'] === AUTH.ownerWebId && args['pod_name'] === USER && args['pod_url'] === AUTH.podUrl,
    JSON.stringify({ agent_id: args['agent_id'], owner_webid: args['owner_webid'], pod_name: args['pod_name'], pod_url: args['pod_url'] }));
  check('§1 …beside the session fields act passes on', args['_session_agent_did'] === AGENT && args['_identity_token'] === IDENTITY_TOKEN);
}

// ── §2 THE TWO WAYS SIGN THE SAME FIELDS ─────────────────────────────────────
console.log('\n2. sign_request with payload alone signs what act with sign_payload: true signs');
for (const [label, payload] of [
  ['a payload that names its pod', PAYLOAD],
  // No pod_url in the payload: the dispatcher's default pod_url must not be signed by either way.
  ['a payload that names no pod', { v: 1, action: ACTION, nonce: 'save-lines-0-q8Xr2mVp7LkA9dTz' }],
] as const) {
  const alone = await bySignRequest({ payload });
  const composed = await byActSignPayload(payload);
  check(`§2 ${label}: the same fields, apart from the relay's timestamp`,
    fields(withoutTimestamp(alone.signed)) === fields(withoutTimestamp(composed.signed)),
    `alone ${JSON.stringify(alone.signed)} vs act ${JSON.stringify(composed.signed)}`);
  check(`§2 ${label}: the session's agent and the caller's own pod, in its public spelling`,
    alone.signed['agent_id'] === AGENT && alone.signed['subject_pod_url'] === `${PUB}${USER}/`, JSON.stringify(alone.signed));
  for (const injected of ['owner_webid', 'pod_name', 'payload', 'sign_payload', 'descriptor_url', 'action_iri']) {
    check(`§2 ${label}: ${injected} is in neither signed payload`, !(injected in alone.signed) && !(injected in composed.signed));
  }
  check(`§2 ${label}: a pod is signed only when the payload names one`,
    'pod_url' in payload ? alone.signed['pod_url'] === payload.pod_url : !('pod_url' in alone.signed), JSON.stringify(alone.signed));
  // act sends exactly the two fields, so the second of the two calls passes them on unchanged.
  check(`§2 ${label}: act's payload is exactly the _signature and _signed_payload pair`,
    JSON.stringify(Object.keys(composed.pair).sort()) === JSON.stringify(['_signature', '_signed_payload']));
  const returned = JSON.parse(alone.text) as Record<string, unknown>;
  check(`§2 ${label}: sign_request returns that pair, the signature over the text it returned`,
    typeof returned['_signature'] === 'string'
      && mod.signedMessages.includes(`sha256:${createHash('sha256').update(String(returned['_signed_payload']), 'utf8').digest('hex')}`));
}

// ── §2b WHY "payload ALONE" ──────────────────────────────────────────────────
console.log('\n2b. other top-level arguments to sign_request are signed too');
{
  const extra = await bySignRequest({ descriptor_url: DESCRIPTOR, action_iri: ACTION, payload: PAYLOAD });
  const composed = await byActSignPayload(PAYLOAD);
  check('§2b descriptor_url and action_iri passed beside payload are folded into what it signs',
    extra.signed['descriptor_url'] === DESCRIPTOR && extra.signed['action_iri'] === ACTION, JSON.stringify(extra.signed));
  check('§2b …so that request is not the one act signs, and the prompts say to pass payload alone',
    fields(withoutTimestamp(extra.signed)) !== fields(withoutTimestamp(composed.signed)));
}

// ── §3 THE RESIDUAL, BOUNDED ─────────────────────────────────────────────────
console.log('\n3. with the identity server unreachable, only subject_pod_url can differ');
{
  mod.identityAnswers.on = false;
  try {
    const alone = await bySignRequest({ payload: PAYLOAD });
    const composed = await byActSignPayload(PAYLOAD);
    const rest = (o: Record<string, unknown>): string => {
      const { subject_pod_url: _s, ...r } = withoutTimestamp(o);
      return fields(r);
    };
    check('§3 every field but subject_pod_url still agrees', rest(alone.signed) === rest(composed.signed),
      `alone ${JSON.stringify(alone.signed)} vs act ${JSON.stringify(composed.signed)}`);
    check('§3 …and the pod the payload names is signed either way', alone.signed['pod_url'] === PAYLOAD.pod_url && composed.signed['pod_url'] === PAYLOAD.pod_url);
  } finally {
    mod.identityAnswers.on = true;
  }
}

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
