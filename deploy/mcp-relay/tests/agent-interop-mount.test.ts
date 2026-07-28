#!/usr/bin/env tsx
/**
 * agent-interop mount — surface + security regression test.
 *
 * This adds NEW public surface to the relay (a discovery card plus wire routes) on
 * the heels of an audit that found six blockers, so the properties that audit taught
 * are pinned here rather than assumed:
 *
 *   - the mount is REGISTRY-DRIVEN, not protocol-named (adding a format is data);
 *   - every wire route demands a verified caller BEFORE touching the engine;
 *   - errors render from the profile's error table — no internal detail escapes;
 *   - the card is derived from LIVE affordances and cannot advertise a capability
 *     the substrate does not serve, nor a non-dereferenceable (urn:) id;
 *   - the card carries no conformance claim while the profile is unverified.
 *
 * Runs the real mount against a minimal Express double — no network, no pod.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/agent-interop-mount.test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mountAgentInterop } from '../agent-interop-mount.js';
import { PROFILES } from '@interego/agent-interop';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Minimal Express double ────────────────────────────────────────────────
type Handler = (req: any, res: any) => unknown;
const routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];
/** A route path may be a string OR a RegExp (custom methods compile to RegExp). */
const pstr = (p: string | RegExp): string => (typeof p === 'string' ? p : p.source);
const isCard = (p: string | RegExp): boolean => pstr(p).includes('/.well-known/');
const app: any = {
  get: (p: string | RegExp, h: Handler) => routes.push({ method: 'GET', path: p, handler: h }),
  post: (p: string | RegExp, h: Handler) => routes.push({ method: 'POST', path: p, handler: h }),
};

function mkRes() {
  const r: any = {
    statusCode: 200, body: undefined as any, headers: {} as Record<string, string>, ended: false,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    send(b: unknown) { r.body = b; return r; },
    type() { return r; },
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; },
    end() { r.ended = true; return r; },
  };
  return r;
}

const AFFORDANCES = [
  { action: 'https://relay.test/ns/iep/action/relay/publish_context', title: 'publish_context', comment: 'Publish a descriptor.', vertical: 'relay', requiresAuth: true },
  { action: 'https://relay.test/ns/iep/action/relay/get_descriptor', title: 'get_descriptor', comment: 'Read a descriptor.', vertical: 'relay', requiresAuth: false },
  // Must be dropped: a urn is not dereferenceable.
  { action: 'urn:iep:action:legacy', title: 'legacy', comment: 'legacy urn', vertical: 'relay' },
];

let verifiedCaller: string | undefined;
mountAgentInterop(app, {
  publicBase: 'https://relay.test',
  agent: { id: 'https://relay.test/.well-known/operations', name: 'Test Relay', description: 'test' },
  affordances: () => AFFORDANCES,
  verifyCaller: async () => verifiedCaller,
  auth: { oauth2: { metadataUrl: 'https://relay.test/.well-known/oauth-authorization-server', pkceRequired: true }, bearer: true },
  log: () => {},
});

console.log('\n1. the mount is registry-driven, not protocol-named');
const src = readFileSync(join(here, '..', 'agent-interop-mount.ts'), 'utf8');
check('the mount module names no wire protocol', !/\ba2a\b/i.test(src));
check('it iterates the profile registry', /Object\.values\(PROFILES\)/.test(src));
check('routes come from each profile\'s own wire table', /for \(const route of profile\.wire\)/.test(src));
// Two profiles ship, so both cards + both route sets must have appeared.
const cardPaths = routes.filter(r => isCard(r.path)).map(r => pstr(r.path));
check('every registered profile got its card path', cardPaths.length >= 2, cardPaths.join(','));
check('every registered profile got 4 wire routes',
  routes.filter(r => !isCard(r.path)).length >= 8,
  String(routes.length));

console.log('\n2. the card is a live projection, and only of things that dereference');
const cardRoute = routes.find(r => pstr(r.path) === '/.well-known/agent-card.json')!;
const cRes = mkRes();
cardRoute.handler({ headers: {}, query: {}, params: {} }, cRes);
const card = JSON.parse(cRes.body as string);
const skillIds: string[] = (card.skills ?? []).map((s: any) => s.id);
check('capabilities are projected from the live affordance set', skillIds.length === 2, String(skillIds.length));
check('every advertised id is a dereferenceable URL', skillIds.every(i => /^https?:\/\//.test(i)));
check('the urn-identified affordance is DROPPED, not advertised', !skillIds.some(i => i.startsWith('urn:')));
check('unimplemented optional capabilities are declared false',
  card.capabilities && card.capabilities.streaming === false && card.capabilities.pushNotifications === false);
check('no conformance claim while the profile is unverified',
  !/conformant|certified/i.test(JSON.stringify(card)));
check('the card is CORS-public (discovery precedes authentication)',
  cRes.headers['access-control-allow-origin'] === '*');
check('an ETag is served for conditional fetches', typeof cRes.headers['etag'] === 'string');

console.log('\n3. the ETag is content-derived (changes iff capability changes)');
const etag1 = cRes.headers['etag'];
const c2 = mkRes(); cardRoute.handler({ headers: {}, query: {}, params: {} }, c2);
check('stable across identical renders', c2.headers['etag'] === etag1);
const c304 = mkRes();
cardRoute.handler({ headers: { 'if-none-match': etag1 }, query: {}, params: {} }, c304);
check('a matching If-None-Match yields 304', c304.statusCode === 304);
AFFORDANCES.push({ action: 'https://relay.test/ns/iep/action/relay/new_verb', title: 'new_verb', comment: 'added', vertical: 'relay', requiresAuth: false });
const c3 = mkRes(); cardRoute.handler({ headers: {}, query: {}, params: {} }, c3);
check('a new capability changes it', c3.headers['etag'] !== etag1);
AFFORDANCES.pop();

console.log('\n4. every wire route demands a verified caller BEFORE the engine');
const wireRoutes = routes.filter(r => !isCard(r.path));
verifiedCaller = undefined;
for (const r of wireRoutes) {
  const res = mkRes();
  await r.handler({ headers: {}, query: {}, params: { id: 'x' }, body: { parts: [{ text: 'hi' }] } }, res);
  check(`${r.method} ${pstr(r.path)} refuses an unverified caller`, res.statusCode === 401, `got ${res.statusCode}`);
}

console.log('\n5. errors render from the profile table — no internal detail');
verifiedCaller = 'did:ethr:0xAAA';
const badRes = mkRes();
const send = wireRoutes.find(r => pstr(r.path) === '/a2a/v1/message:send')!;
await send.handler({ headers: {}, query: {}, params: {}, body: {} }, badRes);
check('a malformed body is a 400 from the profile table', badRes.statusCode === 400);
check('the error body carries a code + message, not a stack',
  !!(badRes.body as any)?.error?.code && !/stack|\bat \//i.test(JSON.stringify(badRes.body)));

console.log('\n6. engagements are owner-scoped (possession of an id is not authority)');
const okRes = mkRes();
await send.handler({ headers: {}, query: {}, params: {}, body: { parts: [{ text: 'hello' }] } }, okRes);
// send nests under the profile's declared envelope member; unwrap to the resource.
const created = ((okRes.body as any)?.task ?? okRes.body) as any;
check('a verified caller can open one', okRes.statusCode === 200 && typeof created?.id === 'string');
check('its id is a dereferenceable URL, never a urn', /^https:\/\/relay\.test\/engagements\//.test(created.id));
const getRoute = wireRoutes.find(r => pstr(r.path) === '/a2a/v1/tasks/:id')!;
const mineRes = mkRes();
await getRoute.handler({ headers: {}, query: {}, params: { id: created.id }, body: {} }, mineRes);
check('the owner can read it back', mineRes.statusCode === 200);
verifiedCaller = 'did:ethr:0xBBB';
const theirsRes = mkRes();
await getRoute.handler({ headers: {}, query: {}, params: { id: created.id }, body: {} }, theirsRes);
check('another principal cannot read it', theirsRes.statusCode === 404);
check('...and is told notFound, NOT forbidden (no existence oracle)',
  (theirsRes.body as any)?.error?.status === 'NOT_FOUND');
const listRes = mkRes();
const listRoute = wireRoutes.find(r => pstr(r.path) === '/a2a/v1/tasks')!;
await listRoute.handler({ headers: {}, query: {}, params: {}, body: {} }, listRes);
check('list returns only the caller\'s own', ((listRes.body as any)?.tasks ?? []).length === 0);


// ── REAL Express boot ─────────────────────────────────────────────────────
//
// The double above is fine for handler logic, but it hid a real defect: the
// custom-method path `/tasks/{id}:cancel` naively becomes `/tasks/:id:cancel`,
// which path-to-regexp REJECTS AT REGISTRATION ("Missing text before \"cancel\"
// param") — i.e. the relay would have crashed at boot, not mis-routed. A fake app
// object never calls path-to-regexp, so only a real Express instance catches it.
console.log('\n7. the mount registers on REAL Express (route compilation is exercised)');
{
  const express = (await import('express')).default;
  const realApp = express();
  realApp.use(express.json());
  let booted = true;
  try {
    mountAgentInterop(realApp as any, {
      publicBase: 'https://relay.test',
      agent: { id: 'https://relay.test/.well-known/operations', name: 'T', description: 't' },
      affordances: () => AFFORDANCES,
      verifyCaller: async () => 'did:ethr:0xAAA',
      log: () => {},
    });
  } catch (err) {
    booted = false;
    check('every profile route compiles under real Express', false, (err as Error).message);
  }
  if (booted) {
    check('every profile route compiles under real Express', true);
    const srv = realApp.listen(0);
    await new Promise(r => srv.once('listening', r));
    const port = (srv.address() as any).port;
    const B = `http://127.0.0.1:${port}`;

    const card = await fetch(`${B}/.well-known/agent-card.json`);
    check('the card is served over HTTP', card.status === 200, String(card.status));
    const cardBody: any = await card.json();
    check('...with skills whose ids dereference',
      Array.isArray(cardBody.skills) && cardBody.skills.every((s: any) => /^https?:\/\//.test(s.id)));

    // ── The discovery document must describe ITSELF ────────────────────────
    //
    // Asserting "a Link header is present" would pass on a header pointing at a
    // typo. These assert the pointer's SHAPE and that CORS actually lets a
    // browser read it — the card is the one CORS-open route, so a header the
    // default CORS safelist hides is a header that does not exist for the client
    // class discovery is for.
    const cardLink = card.headers.get('link') ?? '';
    const describedBy = /<([^>]+)>;\s*rel="describedby"/.exec(cardLink)?.[1];
    check('the card advertises the profile that describes it',
      !!describedBy, cardLink.slice(0, 140));
    check('...as a dereferenceable http(s) URL, never a bare token',
      /^https?:\/\//.test(describedBy ?? ''), String(describedBy));
    check('...matching the id the profile itself declares',
      describedBy === PROFILES.a2a.id, `${describedBy} vs ${PROFILES.a2a.id}`);
    check('the card advertises its own canonical self URL',
      /<[^>]*\/\.well-known\/agent-card\.json>;\s*rel="self"/.test(cardLink), cardLink.slice(0, 140));
    const exposed = (card.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    check('a cross-origin client can actually READ those headers',
      exposed.includes('link') && exposed.includes('etag'), exposed || '<unset>');

    // A 304 must not strip the pointer: a client that caches the card would
    // otherwise lose its route to the profile on every revalidation.
    const revalidated = await fetch(`${B}/.well-known/agent-card.json`, {
      headers: { 'if-none-match': card.headers.get('etag') ?? '' },
    });
    check('a conditional request is answered 304', revalidated.status === 304, String(revalidated.status));
    check('...and the 304 STILL carries the describedby pointer',
      (revalidated.headers.get('link') ?? '').includes('rel="describedby"'),
      (revalidated.headers.get('link') ?? '<unset>').slice(0, 140));

    const opened = await fetch(`${B}/a2a/v1/message:send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ text: 'hi' }] }),
    });
    check('the custom-method send route matches', opened.status === 200, String(opened.status));
    // send NESTS the resource under the profile's declared envelope member; GET and
    // cancel return it bare. Reading `.task` here is the assertion that the envelope
    // is applied per-operation rather than everywhere.
    const sent: any = await opened.json();
    check('...and nests the resource under the profile-declared envelope member',
      !!sent.task?.id && sent.id === undefined, JSON.stringify(sent).slice(0, 110));
    const task: any = sent.task ?? sent;

    // The bug this section exists for: cancel is a CUSTOM METHOD with a literal
    // `:cancel` suffix, and the id must survive it intact.
    const cancelled = await fetch(`${B}/a2a/v1/tasks/${encodeURIComponent(task.id)}:cancel`, { method: 'POST' });
    check('the custom-method cancel route matches', cancelled.status === 200, String(cancelled.status));
    const cbody: any = cancelled.status === 200 ? await cancelled.json() : {};
    check('...and cancels THAT engagement (id parsed out of the suffix)',
      cbody.id === task.id && cbody.status?.state === 'TASK_STATE_CANCELED',
      JSON.stringify(cbody).slice(0, 120));
    check('...and cancel returns the resource BARE (no envelope)',
      cbody.task === undefined, JSON.stringify(cbody).slice(0, 90));

    // A version this profile does not serve must be refused, not answered anyway.
    const wrongVersion = await fetch(`${B}/a2a/v1/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '9.9' },
      body: JSON.stringify({ parts: [{ text: 'hi' }] }),
    });
    check('an unsupported protocol version is refused, not served',
      wrongVersion.status === 400, String(wrongVersion.status));

    // A body in a media type we cannot parse is 415, distinguishable from 400.
    const wrongType = await fetch(`${B}/a2a/v1/message:send`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi',
    });
    check('an unparseable request media type is 415, not 400',
      wrongType.status === 415, String(wrongType.status));

    srv.close();
  }
}


console.log('\n8. HYPERMEDIA — a representation carries its own followable next steps');
{
  const express = (await import('express')).default;
  const a = express(); a.use(express.json());
  mountAgentInterop(a as any, {
    publicBase: 'https://relay.test',
    agent: { id: 'https://relay.test/.well-known/operations', name: 'T', description: 't' },
    affordances: () => AFFORDANCES,
    verifyCaller: async () => 'did:ethr:0xAAA',
    log: () => {},
  });
  const srv = a.listen(0);
  await new Promise(r => srv.once('listening', r));
  const B = `http://127.0.0.1:${(srv.address() as any).port}`;

  const open = await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ text: 'hi' }] }),
  });
  const link = open.headers.get('link') ?? '';
  // The envelope wraps the resource on send; the Link headers are on the RESPONSE,
  // so hypermedia navigation is unaffected by the body shape either way.
  const task: any = (await open.json() as any).task;
  check('an engagement response carries Link headers', link.length > 0);
  check('...including self + service-desc + describedby',
    link.includes('rel="self"') && link.includes('rel="service-desc"') && link.includes('rel="describedby"'));
  // The client must be able to FOLLOW cancel, not construct it.
  check('...and a cancel affordance while the engagement is live', link.includes(':cancel'));
  check('the link relation is itself a dereferenceable action URL (not a bare token)',
    /rel="https:\/\/relay\.test\/ns\/iep\/action\//.test(link));

  // Follow the advertised cancel target rather than building a URL.
  const m = /<([^>]+)>; rel="[^"]*cancel_task"/.exec(link);
  check('the cancel target is advertised and followable', !!m, link.slice(0, 200));
  if (m) {
    // The advertised target is the canonical PUBLIC url (that is correct — an
    // affordance must not advertise a loopback address); swap only the origin to
    // reach the ephemeral test server.
    const followed = await fetch(m[1]!.replace('https://relay.test', B), { method: 'POST' });
    check('following the advertised affordance cancels it', followed.status === 200, String(followed.status));
    const done: any = followed.status === 200 ? await followed.json() : {};
    check('...the same engagement', done.id === task.id, `${done.id} vs ${task.id}`);
    const doneLink = followed.headers.get('link') ?? '';
    // Terminal state: the engine's transition table says nothing further is legal,
    // so no next step may be advertised.
    check('a TERMINAL engagement advertises no cancel (derived from the engine table)',
      !doneLink.includes('cancel_task'), doneLink.slice(0, 160));
  }

  // The profile whose shape is ours carries them in-body too.
  const io = await fetch(`${B}/interego-agents/v1/engagements`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ text: 'hi' }] }),
  });
  const iobody: any = await io.json();
  check('our own profile carries affordances IN-BODY as iep:Affordance',
    Array.isArray(iobody['iep:affordance']) && iobody['iep:affordance'].length > 0
    && iobody['iep:affordance'][0]['@type'] === 'iep:Affordance'
    && typeof iobody['iep:affordance'][0]['hydra:target'] === 'string');
  srv.close();
}


console.log('\n9. MULTI-TURN — a continuation appends, it does not fork a new engagement');
{
  const express = (await import('express')).default;
  const a = express(); a.use(express.json());
  mountAgentInterop(a as any, {
    publicBase: 'https://relay.test',
    agent: { id: 'https://relay.test/.well-known/operations', name: 'T', description: 't' },
    affordances: () => AFFORDANCES,
    verifyCaller: async (req: any) => (req.headers['x-who'] as string) || 'did:ethr:0xAAA',
    log: () => {},
  });
  const srv = a.listen(0);
  await new Promise(r => srv.once('listening', r));
  const B = `http://127.0.0.1:${(srv.address() as any).port}`;
  const J = { 'content-type': 'application/json' };

  // send wraps in the profile's envelope member; unwrap to the resource.
  const un = (b: any) => b?.task ?? b;
  const first: any = un(await (await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: J, body: JSON.stringify({ parts: [{ text: 'one' }] }),
  })).json());
  const cont: any = un(await (await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: J, body: JSON.stringify({ taskId: first.id, parts: [{ text: 'two' }] }),
  })).json());
  check('a continuation returns the SAME engagement, not a new one', cont.id === first.id,
    `${first.id} vs ${cont.id}`);
  check('...with both turns recorded', (cont.history ?? []).length === 2, String((cont.history ?? []).length));

  // Ownership still governs: the engine refuses a continuation into another
  // principal's engagement, and reports it as a miss rather than a 403.
  const alien = await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: { ...J, 'x-who': 'did:ethr:0xBBB' },
    body: JSON.stringify({ taskId: first.id, parts: [{ text: 'intrude' }] }),
  });
  check('another principal cannot append to it', alien.status === 404, String(alien.status));

  // A send with no continuation ref still opens a fresh engagement.
  const fresh: any = un(await (await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: J, body: JSON.stringify({ parts: [{ text: 'new' }] }),
  })).json());
  check('a send with no ref still opens a NEW engagement', fresh.id !== first.id);
  srv.close();
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nAll agent-interop mount gates hold.\n');
