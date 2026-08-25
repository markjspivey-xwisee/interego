#!/usr/bin/env tsx
/**
 * A caller-named identifier cannot break out of the Turtle IRI reference it is written
 * into — and the handlers that write one say so out loud instead of dropping it.
 *
 * ── ★★ WHAT WAS ACTUALLY REACHABLE ───────────────────────────────────────────
 *
 * Three sinks in `server.ts` interpolated a caller-influenced value straight into `<…>`.
 * An IRI reference ends at the FIRST `>` and Turtle defines no escape for it, so
 *
 *     agent_id = 'urn:x> ; prov:wasAttributedTo <did:someone-else'
 *
 * closed the reference, opened a new predicate, and wrote a triple the caller was never
 * authorised to assert:
 *
 *   remember                — `prov:wasAttributedTo <…>` in an `ieh:AgentMemory` graph
 *                             the handler then publishes with sign_authorship TRUE.
 *                             ★ It reads `args.agent_id` DIRECTLY, not callerAgentId(),
 *                             and the two dispatchers that DEFAULT that field — `/mcp` and
 *                             `injectRestVerifiedIdentity`’s bearer branch — leave a
 *                             caller-sent value in place. Not "every dispatcher": the
 *                             SIGNED branch assigns the recovered DID unconditionally, so
 *                             a caller cannot keep one there. Saying "every" was the
 *                             headline false comment of the round that added this file,
 *                             corrected in server.ts and left standing here.
 *   record_trajectory_step  — the same triple, plus `agentSlug`, which is a SUFFIX of the
 *                             value and names the step's own subject and the trajectory
 *                             graph. Delimiters there land in SUBJECT position.
 *   publish_context         — `owner_webid` reaches `writePublicReadAcl`, which builds
 *                             `acl:agent <…>` and PUTs it AS THE RELAY. That document is a
 *                             Web Access Control policy, and `ensurePodAcls` records that
 *                             `.acl` files become the storage-side authority as soon as
 *                             CSS moves off allow-all — so a second `acl:Authorization`
 *                             appended through a closed reference is a grant the caller
 *                             composed and the relay installed. `descriptor_id` reaches
 *                             the inline HyperMarkdown render, whose affordances an MCP
 *                             client displays as controls.
 *
 * ── ★★ AND WHAT THE FIRST VERSION OF THE GATE BROKE ─────────────────────────
 *
 * `turtleIriRef` refuses two different things: a value carrying a character IRIREF
 * forbids, and a value with no scheme. Only the first is an injection. Shipping both as
 * one rule took `remember` and `record_trajectory_step` OFF THE AIR on `/tool/:name` and
 * `/messages` for every identity-server bearer, because the relay's own
 * `injectRestVerifiedIdentity` injects the identity server's `agentId` — a BARE SLUG,
 * `mcp-client-<userId>` — as `agent_id`. The gate refused the relay's own value and told
 * the caller to send an absolute IRI for a field the caller had never sent.
 *
 * That is why the last section of this file DRIVES A TRANSPORT. Every assertion above it
 * feeds values into the module by hand or reads server.ts as text, and not one of them
 * could see a value the RELAY supplies — which is the only value class a gate can break
 * rather than protect.
 *
 * ── WHY THE REFUSAL, AND WHY IT IS NOT A DROPPED TRIPLE ──────────────────────
 *
 * `turtleIriRef` returns null rather than escaping, because escaping an IRI is guessing.
 * Both remaining options are then the caller's problem to hear about: a memory with no
 * `prov:wasAttributedTo`, or an ACL with no `acl:agent`, is a record that quietly says
 * less than the call claimed while still reporting success. So these three refuse, in the
 * envelope this relay already uses for a call that cannot work.
 *
 * The three OPTIONAL back-references in `record_trajectory_step`
 * (`parent_step_id` / `supersedes_step_id` / `was_derived_from`) still drop, deliberately
 * and unchanged — a step is worth recording without a parent, and is not worth recording
 * without an author.
 *
 * ── WHY THE SERVER HALF IS SOURCE-TEXT, AND WHY THAT WAS NOT ENOUGH ──────────
 *
 * `server.ts` starts an HTTP listener on import, so these handlers cannot be CALLED from a
 * unit test in this process. The module half below is behavioural against the real module;
 * the server half pins that each sink USES it, before it builds anything, and that no raw
 * interpolation of the same value survives beside it. Comments are stripped first, so an
 * explanation can neither satisfy nor defeat an assertion about code.
 *
 * Neither half can see a relay-INJECTED value, so the last section spawns `server.ts` as
 * the child process it is designed to be, against a fake identity server and a fake pod,
 * and speaks to it over the two REST transports.
 *
 * ── MUTATION-CHECKED ─────────────────────────────────────────────────────────
 *
 *     turtleIriArgs never pushes to `unusable` (accept everything)      fails 7
 *     remember's attribution line reverted to a raw interpolation       fails 2
 *     writePublicReadAcl's acl:agent reverted to a raw interpolation    fails 2 (+ tsc)
 *     turtleIriToken loses its scheme-less branch (the shipped outage)  fails 5
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/turtle-iri-args.test.ts
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listenLoopback } from './listen-loopback.js';
import { stripComments } from './strip-comments.js';
import { turtleIriArgs } from '../turtle-iri-args.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = stripComments(readFileSync(join(here, '..', 'server.ts'), 'utf8'), 'server.ts');

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); return; }
  fail++; failures.push(name);
  console.log(`  FAIL  ${name}${detail ? `  :: ${detail}` : ''}`);
}

/**
 * The needle for a RAW interpolation of `expr` into an IRI reference — ASSEMBLED, never
 * written out.
 *
 * ★ `tools/turtle-iri-ratchet.mjs` counts that literal text across the whole tree. A test
 * that spells the pattern it is forbidding would ADD eleven entries to the population it
 * exists to shrink, and the gate would fail on the fix. The ratchet's own error reporter
 * concatenates for the same reason.
 */
const rawIri = (expr: string): string => `<${'$'}{${expr}}>`;

/** The body of a top-level function in server.ts, from its declaration to the next one. */
function bodyOf(decl: string, until: string): string {
  const from = serverSrc.indexOf(decl);
  if (from < 0) return '';
  const to = serverSrc.indexOf(until, from + decl.length);
  return to < 0 ? serverSrc.slice(from) : serverSrc.slice(from, to);
}

// ── The module ───────────────────────────────────────────────────────────────

console.log('\nturtleIriArgs — the refusal');
{
  const hostile = 'urn:x> ; prov:wasAttributedTo <did:someone-else';
  const r = turtleIriArgs('remember', { agent_id: hostile });
  ok('a value that closes its own IRI reference is refused, not serialized',
    r.ok === false, JSON.stringify(r));
  if (!r.ok) {
    ok('the envelope is the relay\'s: error / code 400 / retryable false',
      r.refusal.error === 'unusable_iri_argument' && r.refusal.code === 400 && r.refusal.retryable === false,
      JSON.stringify(r.refusal));
    ok('it names the argument the caller sent, machine-readably and in prose',
      r.refusal.unusable.length === 1 && r.refusal.unusable[0]!.name === 'agent_id'
      && r.refusal.message.includes('`agent_id`') && r.refusal.message.includes('remember'),
      r.refusal.message);
    ok('and it does NOT tell the caller to retry',
      /Resending will not help/.test(r.refusal.message));
  }
}
{
  // Every character Turtle's IRIREF production forbids, and nothing else. `no scheme` is
  // NOT in this list and must not go back into it — see the accepted set below.
  const rejected: Array<[string, unknown]> = [
    ['closing delimiter', 'urn:a>b'],
    ['opening delimiter', 'urn:a<b'],
    ['double quote', 'urn:a"b'],
    ['brace', 'urn:a{b}'],
    ['pipe', 'urn:a|b'],
    ['caret', 'urn:a^b'],
    ['backtick', 'urn:a`b'],
    ['backslash', 'urn:a\\b'],
    ['space', 'urn:a b'],
    ['newline', 'urn:a\nb'],
    ['tab', 'urn:a\tb'],
    ['NUL', 'urn:a\u0000b'],
    // `<>` is a reference to the document itself — an empty identifier would attribute a
    // record to the file it is written in, which is a false statement, not a missing one.
    ['empty', ''],
    ['a number', 42],
    ['an object', { '@id': 'urn:graph:x' }],
    ['an array', ['urn:graph:x']],
    ['null', null],
    ['undefined', undefined],
  ];
  let refused = 0;
  for (const [, v] of rejected) if (turtleIriArgs('t', { x: v }).ok === false) refused++;
  ok(`every one of the ${rejected.length} unusable shapes is refused`,
    refused === rejected.length, `${refused}/${rejected.length}`);
}
{
  const legit = [
    'did:ethr:0x8f3b8e939600F4Ae1E6d6E4F14eF0Bb1C21679Fd',
    'https://identity.interego.xwisee.com/users/u-pk-abc/profile#me',
    'did:web:identity.interego.xwisee.com:agents:chatgpt-u-pk-abc',
    'urn:iep:trajectory-step:u-pk-abc:1750000000000',
    'urn:graph:memory:a-note-1750000000000',
    'https://css.interego.xwisee.com/eth-8f3b8e939600/context-graphs/v1.ttl',
    'https://example.org/a(b)c,d;e',
  ];
  let good = 0, closedOnce = 0;
  for (const v of legit) {
    const r = turtleIriArgs('t', { x: v });
    if (!r.ok) continue;
    good++;
    const tok = r.refs.x;
    // ★ THE PROPERTY THAT MATTERS: the token cannot end early. One `<` at the start, one
    // `>` and it is the last character — anything else is a reference the parser closes
    // somewhere the relay did not choose.
    if (tok.indexOf('<') === 0 && tok.indexOf('>') === tok.length - 1
      && tok.lastIndexOf('<') === 0 && tok.lastIndexOf('>') === tok.length - 1
      && tok.slice(1, -1) === v) closedOnce++;
  }
  ok(`all ${legit.length} legitimate identifiers round-trip unchanged`, good === legit.length, `${good}/${legit.length}`);
  ok('and every accepted token opens and closes exactly once, at its two ends',
    closedOnce === legit.length, `${closedOnce}/${legit.length}`);
}
{
  /**
   * ★★ THE SCHEME-LESS SET, WHICH IS THE RELAY'S OWN IDENTITY AND MUST BE ACCEPTED.
   *
   * Every shape `deploy/identity/server.ts` mints for `agentId`, which `verifyBearerToken`
   * returns verbatim and `injectRestVerifiedIdentity` injects as `agent_id`. A rule that
   * demanded a scheme refused all of them, which is what took `remember` and
   * `record_trajectory_step` down on both REST transports.
   *
   * `../../../someone/profile#me` is in here deliberately, and it is the uncomfortable
   * one: a relative reference DOES resolve against the reading parser's base, so accepting
   * it writes an identifier the relay did not choose the meaning of. It is accepted anyway
   * because that is precisely what the relay wrote before this gate existed, and because
   * this gate is not the place to change which identity lands in `prov:wasAttributedTo` on
   * a live transport. Nothing here can BREAK OUT of the reference, which is the property
   * this module exists to guarantee — and the assertion below is about exactly that.
   */
  const schemeless = [
    'mcp-client-u-pk-test',
    'mcp-client-u-try-4f2a91c0bb31',
    'chatgpt-u-pk-abc',
    'claude-code-vscode-eth-8f3b8e939600',
    'wallet-0x8f3b8e939600F4Ae1E6d6E4F14eF0Bb1C21679Fd',
    '../../../someone/profile#me',
  ];
  let written = 0;
  for (const v of schemeless) {
    const r = turtleIriArgs('remember', { agent_id: v });
    // Assembled, not interpolated — see `rawIri` above: the ratchet counts that literal
    // text tree-wide and a test must not add to the population it is defending.
    if (r.ok && r.refs.agent_id === '<' + v + '>') written += 1;
  }
  ok('★★ the identity server\'s bare-slug agentIds are WRITTEN, not refused — the relay '
    + 'must not reject the identity it injected itself',
    written === schemeless.length, `${written}/${schemeless.length}`);

  // The pair that states the rule in one line: same value, one character apart.
  ok('…and the rule is the delimiter, not the scheme: adding `>` to an accepted slug '
    + 'refuses it',
    turtleIriArgs('remember', { agent_id: 'mcp-client-u-pk-test' }).ok === true
    && turtleIriArgs('remember', { agent_id: 'mcp-client-u-pk-test> ; a b <c' }).ok === false);
}
{
  const r = turtleIriArgs('publish_context', {
    owner_webid: 'https://id.example.com/u/profile#me',
    descriptor_id: 'urn:x> . <urn:victim> iep:trustLevel iep:High',
  });
  ok('ALL-OR-NOTHING: one unusable value refuses the call and yields no refs',
    r.ok === false && r.refs === undefined);
  if (!r.ok) {
    ok('and the refusal names ONLY the argument that was unusable',
      r.refusal.unusable.length === 1 && r.refusal.unusable[0]!.name === 'descriptor_id',
      JSON.stringify(r.refusal.unusable));
  }
}
{
  // A caller who pastes a whole payload into an id field must not get it back, at length,
  // inside an error string that is also going into the relay's logs.
  const huge = `urn:x>${'A'.repeat(5000)}`;
  const r = turtleIriArgs('t', { x: huge });
  const received = r.ok ? '' : r.refusal.unusable[0]!.received;
  ok('the echoed value is bounded, not the caller\'s whole payload',
    r.ok === false && received.length < 200 && received.includes('urn:x>'),
    `${received.length} chars`);
}

// ── The three sinks in server.ts ─────────────────────────────────────────────

console.log('\nserver.ts — each sink gates before it builds');
{
  const body = bodyOf('async function handleRemember', 'async function handleRecordTrajectoryStep');
  const gateAt = body.indexOf("turtleIriArgs('remember', { agent_id: agentId })");
  const buildAt = body.indexOf('const graphContent = [');
  ok('remember gates `agent_id` before it builds the memory graph',
    gateAt > 0 && buildAt > gateAt, `gate@${gateAt} build@${buildAt}`);
  ok('remember refuses rather than continuing without an author',
    /if \(!iriArgs\.ok\) return JSON\.stringify\(iriArgs\.refusal\);/.test(body));
  ok('and the attribution triple carries the validated token, not the raw argument',
    body.includes('prov:wasAttributedTo ${iriArgs.refs.agent_id}')
    && !body.includes(rawIri('agentId')),
    body.includes(rawIri('agentId')) ? 'a raw agentId interpolation survives in handleRemember' : '');
}
{
  const body = bodyOf('async function handleRecordTrajectoryStep', 'async function handlePgslDecide');
  const gateAt = body.indexOf("turtleIriArgs('record_trajectory_step', { agent_id: agentId })");
  const slugAt = body.indexOf('const agentSlug =');
  const buildAt = body.indexOf('const graphContent = `@prefix traj:');
  ok('record_trajectory_step gates `agent_id` before it derives agentSlug from it',
    gateAt > 0 && slugAt > gateAt, `gate@${gateAt} slug@${slugAt}`);
  ok('...and before it builds the step graph',
    gateAt > 0 && buildAt > gateAt, `gate@${gateAt} build@${buildAt}`);
  ok('the attribution triple carries the validated token, not the raw argument',
    body.includes('prov:wasAttributedTo ${iriArgs.refs.agent_id}')
    && !body.includes(rawIri('agentId')),
    body.includes(rawIri('agentId')) ? 'a raw agentId interpolation survives in handleRecordTrajectoryStep' : '');
  ok('★ the three OPTIONAL back-references still DROP rather than refuse — a step '
    + 'without a parent is still worth recording',
    /const parentRef = turtleIriRef\(args\.parent_step_id\);/.test(body)
    && /parentRef \? `.*` : ''/.test(body)
    && /const supersedesRef = turtleIriRef\(args\.supersedes_step_id\);/.test(body)
    && /\.map\(u => turtleIriRef\(u\)\)/.test(body));
}
{
  const body = bodyOf('async function handlePublishContext', 'async function handleRemember');
  const gateAt = body.indexOf("turtleIriArgs('publish_context', {");
  const bootstrapAt = body.indexOf('if (!bootstrappedPods.has(podUrl))');
  const mutexAt = body.indexOf('return await withPodMutex(podUrl');
  ok('publish_context gates `owner_webid` + `descriptor_id` at the door',
    gateAt > 0 && body.includes('owner_webid: ownerWebId') && body.includes('descriptor_id: descId'),
    `gate@${gateAt}`);
  // ★ ONE RULE, ONE PLACE. `agent_id` is not interpolated by hand anywhere in this
  // handler — it reaches Turtle through the descriptor serializer, which PERCENT-ENCODES
  // a hostile value rather than refusing it. So `remember` refused a value that
  // `publish_context`, the function `remember` delegates to, wrote through silently. The
  // two doors now apply the same test to the value each of them emits.
  ok('★ …and `agent_id` too, so the rule is not enforced at one of two adjacent doors',
    body.includes('agent_id: agentId'), `gate@${gateAt}`);
  ok('★ and it refuses BEFORE the pod-bootstrap PUT and before the per-pod mutex — a call '
    + 'that can never write must not create a container or take the write lock',
    gateAt > 0 && gateAt < bootstrapAt && gateAt < mutexAt,
    `gate@${gateAt} bootstrap@${bootstrapAt} mutex@${mutexAt}`);
  ok('the inline HyperMarkdown render names the descriptor with the validated token',
    body.includes('${descIdRef} a iep:ContextDescriptor')
    && !body.includes(rawIri('descriptor.id')));
  const aclCalls = body.split('writePublicReadAcl(').length - 1;
  const withRef = body.split('writePublicReadAcl(').slice(1)
    .filter(s => /^[A-Za-z.]+, ownerWebIdRef\)/.test(s)).length;
  ok('all four .acl writes (synchronous + deferred) are handed the validated owner token, '
    + 'not the WebID string',
    aclCalls === 4 && withRef === 4, `${withRef}/${aclCalls} call sites pass ownerWebIdRef`);
}
{
  const body = bodyOf('async function writePublicReadAcl', 'function buildRootAcl');
  ok('★ writePublicReadAcl accepts a TurtleIriRef, so an unchecked WebID is a COMPILE error '
    + 'rather than an ACL the relay signs its name to',
    /async function writePublicReadAcl\(targetUrl: string, ownerRef: TurtleIriRef\)/.test(body),
    body.slice(0, 200));
  ok('the ACL body interpolates no raw owner and no raw target',
    !body.includes(rawIri('ownerWebId')) && !body.includes(rawIri('targetUrl'))
    && body.includes('acl:agent ${ownerRef}') && body.includes('acl:accessTo ${targetRef}'));
  ok('an unusable target URL throws — the shape this function already uses when it cannot '
    + 'write the policy — instead of PUTting a half-formed one',
    /const targetRef = turtleIriRef\(targetUrl\);/.test(body)
    && /if \(targetRef === null\) \{\s*throw new Error\(/.test(body));
}

// ── The transports ───────────────────────────────────────────────────────────
//
// ★★ EVERYTHING ABOVE THIS LINE PASSED WHILE `remember` WAS DEAD IN PRODUCTION.
//
// Feeding values into `turtleIriArgs` by hand tests the rule the author had in mind, and
// grepping server.ts tests that the rule is wired in. Neither can see the value that
// actually arrives, because on `/tool/:name` and `/messages` the caller does not supply
// `agent_id` at all — `injectRestVerifiedIdentity` does, from the identity server, and it
// is a bare slug. So the only value class this gate could BREAK rather than protect was
// the one class no assertion could reach.
//
// This section therefore boots the real `server.ts` as a child process against a fake
// identity server and a fake pod, and drives both REST transports with a bearer.
//
// ★ IT SPAWNS THE PRODUCTION ENTRY POINT, WHICH BINDS EVERY INTERFACE — `app.listen(PORT)`
// with no host. `listen-loopback.test.ts`'s scope note puts every `server.ts` under
// `deploy/` outside its scan for exactly that reason: being reachable from outside the box
// is a production entry point's job. Here the exposure is BOUNDED rather than prevented —
// the child is killed in a `finally` every path reaches, and again on process exit, so it
// cannot become one of the six-day orphaned listeners that suite was written about. The
// two FIXTURES are loopback-only, through the shared helper, like every other suite here.

/** The identity server's answer, in the shape `deploy/identity/server.ts` actually mints. */
const FAKE_USER_ID = 'u-pk-test';
/** ★ A BARE SLUG, NOT A DID. `mcp-client-${userId}` — identity/server.ts. This is the value. */
const FAKE_AGENT_ID = `mcp-client-${FAKE_USER_ID}`;

/** An unused loopback port, released immediately before the child claims it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

interface ToolCall { readonly status: number; readonly text: string }

async function transportSuite(): Promise<void> {
  console.log('\nthe REST transports — with the identity the RELAY injects');

  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (_req, res) => {
    res.json({ valid: true, userId: FAKE_USER_ID, agentId: FAKE_AGENT_ID, scope: 'ReadWrite' });
  });
  identityApp.use((_req, res) => { res.status(404).json({ error: 'not part of this fixture' }); });

  // A pod that accepts writes and holds nothing. The publish gets no further than the
  // registry check, which is fine: this suite is about the DOOR, and a call that reaches
  // the registry has already passed it.
  const podApp = express();
  podApp.use((req, res) => {
    if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') { res.status(201).end(); return; }
    res.status(404).end();
  });

  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a
  // long-lived private key into a path it does not own, and on a runner where `/app`
  // exists it would.
  const keyFile = join(tmpdir(), `turtle-iri-args-relay-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CSS_URL: `${pod.base}/`,
      IDENTITY_URL: identity.base,
      RELAY_AGENT_KEY_FILE: keyFile,
    },
    // stderr is KEPT, not discarded. If the child cannot boot — a missing loader, a port
    // taken between `freePort` and here — the readiness poll would otherwise fail with
    // nothing but "up=false", and the next person's first move would be to re-run it
    // locally to find out why. The tail is reported in the failure detail instead.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childErr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { childErr = (childErr + chunk).slice(-1_500); });
  // The backstop for the path the `finally` below cannot reach: an interrupted run. Every
  // exit — including the `process.exit()` in listenLoopback's own signal teardown — runs
  // this, so the relay cannot survive the suite that started it.
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);

  const call = async (transport: 'tool' | 'messages', name: string, args: unknown): Promise<ToolCall> => {
    const [url, body] = transport === 'tool'
      ? [`${base}/tool/${name}`, args]
      : [`${base}/messages`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }];
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer any-token-the-fixture-accepts' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, text: await res.text() };
  };

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    ok('the relay boots against the fixtures and answers /health', up,
      `${base} — child stderr tail: ${childErr || '(none)'}`);
    if (!up) return;

    // ── ★★ THE REGRESSION ────────────────────────────────────────────────────
    for (const transport of ['tool', 'messages'] as const) {
      const r = await call(transport, 'remember', { title: 'an ordinary note', body: 'nothing unusual' });
      ok(`★★ /${transport}: an ordinary authenticated \`remember\` is NOT refused — the `
        + 'caller sent no `agent_id`, the relay injected its own bare slug, and the gate '
        + 'used to reject it with `unusable_iri_argument`',
        !r.text.includes('unusable_iri_argument'),
        `${r.status} ${r.text.slice(0, 220)}`);
    }

    {
      const r = await call('tool', 'record_trajectory_step', { verb: 'analyzed', object_name: 'the quarterly report' });
      ok('★★ /tool: `record_trajectory_step` likewise', !r.text.includes('unusable_iri_argument'),
        `${r.status} ${r.text.slice(0, 220)}`);
      // ★ AND THE INJECTED IDENTITY REALLY IS WHAT REACHED THE SINK. `stepId` is minted
      // from `agentSlug`, a suffix of the gated `agent_id`, so seeing the slug in the step
      // id proves the relay's own value went THROUGH the gate rather than around it.
      ok('…and the step id is minted from that injected slug, so the value under test is '
        + 'the value the gate saw',
        r.text.includes(`urn:iep:trajectory-step:${FAKE_AGENT_ID}:`),
        r.text.slice(0, 300));
    }

    // ── …AND THE GATE STILL BITES, THROUGH THE SAME TRANSPORT ────────────────
    //
    // `remember` reads `args.agent_id` directly and the bearer branch only DEFAULTS that
    // field, so a caller-sent value survives here — which is what makes this sink the one
    // worth gating. (On `record_trajectory_step` and `publish_context` the session
    // identity wins via `callerAgentId`, so the hostile value never reaches the gate on an
    // authenticated transport at all.)
    {
      const hostile = 'urn:x> ; prov:wasAttributedTo <did:someone-else';
      const r = await call('tool', 'remember', { title: 'forged', body: 'x', agent_id: hostile });
      ok('★★ /tool: a caller-supplied `agent_id` that closes its own IRI reference IS '
        + 'refused — the property the gate exists for, over the wire',
        r.text.includes('unusable_iri_argument') && r.text.includes('agent_id'),
        `${r.status} ${r.text.slice(0, 220)}`);
    }
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    // The child mints an X25519 keypair when the file is absent and persists it — and the
    // ECDSA compliance wallet lands NEXT TO IT, at the same path with `-ecdsa` spliced in
    // (`RELAY_COMPLIANCE_WALLET_FILE` derives from this one). Removing only the file this
    // suite named left half the litter behind, one private key per run. Both, or neither.
    for (const f of [keyFile, keyFile.replace(/\.json$/, '-ecdsa.json')]) {
      try { rmSync(f, { force: true }); } catch { /* the child may never have written it */ }
    }
  }
}

transportSuite()
  .catch((err: unknown) => {
    ok('the transport suite ran to completion', false, err instanceof Error ? err.message : String(err));
  })
  .then(() => {
    if (fail > 0) {
      console.log(`\n${pass} passed, ${fail} failed`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log(`\n${pass} passed, 0 failed\n`);
  })
  .catch(() => process.exit(1));
