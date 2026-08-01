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
import { PROFILES, EngagementEngine, isEngineError } from '@interego/agent-interop';

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
/** Find a registered route by the URL it actually SERVES. A custom-method route is a
 *  RegExp now, so string equality against the compiled form no longer locates it. */
const routeFor = (rs: typeof routes, url: string) =>
  rs.find(r => (typeof r.path === 'string' ? r.path === url : r.path.test(url)))!;
/** Declined routes are refusals the profile registers for operations it does not
 *  implement. They answer BEFORE auth because "this agent does not offer that" is
 *  true for every caller and the card already declares the capability false. */
const DECLINED_URLS = /pushNotificationConfigs|:stream\$/;
const app: any = {
  get: (p: string | RegExp, h: Handler) => routes.push({ method: 'GET', path: p, handler: h }),
  post: (p: string | RegExp, h: Handler) => routes.push({ method: 'POST', path: p, handler: h }),
  // The double must support every verb the mount can register. It lacked `delete`,
  // and the mount CRASHED AT BOOT the first time a profile declared a DELETE route
  // — the double earning its keep. A silent miss would have shipped a route that
  // 404s exactly like the confusion it exists to remove.
  delete: (p: string | RegExp, h: Handler) => routes.push({ method: 'DELETE', path: p, handler: h }),
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
const allNonCard = routes.filter(r => !isCard(r.path));
const wireRoutes = allNonCard.filter(r => !DECLINED_URLS.test(pstr(r.path)));
const declinedRoutes = allNonCard.filter(r => DECLINED_URLS.test(pstr(r.path)));
check('the profile registered declined routes for what it does not implement',
  declinedRoutes.length >= 5, String(declinedRoutes.length));
verifiedCaller = undefined;
for (const r of declinedRoutes) {
  const res = mkRes();
  await r.handler({ headers: {}, query: {}, params: { id: 'x' }, body: {} }, res);
  // 400, not 401: refusing an operation this agent does not offer does not depend on
  // who is asking, and the card already publishes that capability as false.
  check(`${r.method} ${pstr(r.path)} refuses as unimplemented, for anyone`,
    res.statusCode === 400, `got ${res.statusCode}`);
  check('  ...and never reaches the engine', !(res.body as any)?.id);
}
for (const r of wireRoutes) {
  const res = mkRes();
  await r.handler({ headers: {}, query: {}, params: { id: 'x' }, body: { parts: [{ text: 'hi' }] } }, res);
  check(`${r.method} ${pstr(r.path)} refuses an unverified caller`, res.statusCode === 401, `got ${res.statusCode}`);
}

console.log('\n5. errors render from the profile table — no internal detail');
verifiedCaller = 'did:ethr:0xAAA';
const badRes = mkRes();
const send = routeFor(wireRoutes, '/a2a/v1/message:send');
await send.handler({ headers: {}, query: {}, params: {}, body: {} }, badRes);
check('a malformed body is a 400 from the profile table', badRes.statusCode === 400);
check('the error body carries a code + message, not a stack',
  !!(badRes.body as any)?.error?.code && !/stack|\bat \//i.test(JSON.stringify(badRes.body)));

console.log('\n5b. the engine\'s own ids RESOLVE (they used to 404)');
{
  // ★ mintId's own comment promises "a URL that resolves to the record, never a urn:" —
  // and nothing served it. Every engagement id handed to a peer 404'd, measured live
  // against production. A urn: would at least be honestly undereferenceable; this was a
  // URL that promised and refused.
  // Located by its registered form: this one is an ordinary Express `:id` path, not a
  // RegExp, because the trailing segment of a minted id contains no slashes.
  const resolver = routes.find(r => r.method === 'GET' && r.path === '/engagements/:id');
  check('a route exists for engine-minted ids', resolver !== undefined);

  verifiedCaller = 'did:ethr:0xAAA';
  const openRes = mkRes();
  await send.handler({ headers: {}, query: {}, params: {}, body: { parts: [{ text: 'resolve me' }] } }, openRes);
  const eng = ((openRes.body as any)?.task ?? openRes.body) as any;
  const tail = String(eng.id).split('/engagements/')[1];

  const mine = mkRes();
  await resolver!.handler({ headers: {}, query: {}, params: { id: tail }, body: {} }, mine);
  check('the owner resolves their own engagement', mine.statusCode === 200, String(mine.statusCode));
  check('...and it carries rel=self plus a per-profile alternate',
    /rel="self"/.test(String(mine.headers['link'])) && /rel="alternate"/.test(String(mine.headers['link'])),
    String(mine.headers['link']).slice(0, 90));

  // ★ NOT-YOURS AND NOT-FOUND MUST BE THE SAME ANSWER. Distinguishing them would turn
  // this route into an existence oracle over every engagement in the deployment.
  verifiedCaller = 'did:ethr:0xBBB';
  const theirs = mkRes();
  await resolver!.handler({ headers: {}, query: {}, params: { id: tail }, body: {} }, theirs);
  const bogus = mkRes();
  await resolver!.handler({ headers: {}, query: {}, params: { id: 'no-such-engagement' }, body: {} }, bogus);
  check('another principal gets notFound, not forbidden', theirs.statusCode === 404, String(theirs.statusCode));
  check('...and a genuine miss is INDISTINGUISHABLE from it',
    theirs.statusCode === bogus.statusCode && JSON.stringify(theirs.body) === JSON.stringify(bogus.body));

  verifiedCaller = undefined;
  const anon = mkRes();
  await resolver!.handler({ headers: {}, query: {}, params: { id: tail }, body: {} }, anon);
  check('an unverified caller is refused before the engine is touched', anon.statusCode === 401);
  verifiedCaller = 'did:ethr:0xAAA';
}

console.log('\n6. engagements are owner-scoped (possession of an id is not authority)');
const okRes = mkRes();
await send.handler({ headers: {}, query: {}, params: {}, body: { parts: [{ text: 'hello' }] } }, okRes);
// send nests under the profile's declared envelope member; unwrap to the resource.
const created = ((okRes.body as any)?.task ?? okRes.body) as any;
check('a verified caller can open one', okRes.statusCode === 200 && typeof created?.id === 'string');
check('its id is a dereferenceable URL, never a urn', /^https:\/\/relay\.test\/engagements\//.test(created.id));
// Located by the URL it SERVES, not by its compiled form: the task route is a RegExp now,
// because an id that is a URL does not fit in a single `:id` path segment.
const getRoute = routeFor(wireRoutes, '/a2a/v1/tasks/anything');
const mineRes = mkRes();
await getRoute.handler({ headers: {}, query: {}, params: { id: created.id }, body: {} }, mineRes);
check('the owner can read it back', mineRes.statusCode === 200);
verifiedCaller = 'did:ethr:0xBBB';
const theirsRes = mkRes();
await getRoute.handler({ headers: {}, query: {}, params: { id: created.id }, body: {} }, theirsRes);
check('another principal cannot read it', theirsRes.statusCode === 404);

// ★ THE ID WE HAND OUT MUST BE THE ID THAT WORKS.
//
// Our engagement ids are absolute URLs, because every identifier here is meant to be
// dereferenceable. A2A binds the lookup as GET /tasks/{id}, and a single-segment `:id`
// cannot hold one: a peer echoing back the very id we gave it builds
//   /a2a/v1/tasks/https://relay.test/engagements/abc
// which used to 404. Measured against the running SUT: percent-encoded returned 200, raw
// returned 404. The conformance suite hid it behind an unrelated skip, so the surface
// looked green while a peer could not dereference a task it had just been handed.
// Restore the owner for these two checks, then hand state back exactly as found —
// this block sits mid-scenario and later assertions depend on the caller.
const callerBefore = verifiedCaller;
verifiedCaller = 'did:ethr:0xAAA';
const taskUrl = `/a2a/v1/tasks/${created.id}`;
check('a raw URL id still matches the task route (no 404 from split segments)',
  routeFor(wireRoutes, taskUrl) !== undefined);
const rawRes = mkRes();
await getRoute.handler(
  { headers: {}, query: {}, params: { 0: created.id }, body: {} }, rawRes);
check('...and the raw id resolves to the task', rawRes.statusCode === 200);
const encRes = mkRes();
await getRoute.handler(
  { headers: {}, query: {}, params: { 0: encodeURIComponent(created.id) }, body: {} }, encRes);
check('...and so does the percent-encoded spelling (both reach the same task)',
  encRes.statusCode === 200);
verifiedCaller = callerBefore;
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
    // Whether a cross-origin client can READ those headers is NOT decided here and
    // must not be asserted here. server.ts freezes every access-control-* header, so
    // a setHeader in this mount is a silent no-op in production — this test booting
    // the mount alone would happily go green on a header the real relay drops. That
    // exact false pass shipped once. The behaviour is owned and tested by
    // tests/public-cors-carveout.test.ts, with the freeze in place.
    //
    // What IS this mount's job: not pretending otherwise. If someone re-adds the
    // header here it will look fixed and be broken, so fail if it comes back.
    check('the mount does NOT try to set a frozen CORS header (it would silently no-op)',
      !src.split(String.fromCharCode(10))
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .some(l => /Access-Control-Expose-Headers/i.test(l)),
      'set it in cors-allowlist.ts instead');

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

console.log('\n10. ROUTE SHADOWING — only a DECLARED url may reach a handler');
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
  const J = { 'content-type': 'application/json' };
  const body = JSON.stringify({ message: { parts: [{ text: 'probe' }] } });

  // The defect: `/message:send` compiled to `^/a2a/v1/message([^/]+)$`, so EVERY
  // `/a2a/v1/message<anything>` reached the state-mutating send handler and created
  // a real, persisted engagement. Undeclared URLs mutating state.
  const declared = await fetch(`${B}/a2a/v1/message:send`, { method: 'POST', headers: J, body });
  check('the DECLARED custom-method url is served', declared.status === 200, String(declared.status));
  for (const bad of ['messageZZZ', 'messages', 'message-send', 'messageX']) {
    const r = await fetch(`${B}/a2a/v1/${bad}`, { method: 'POST', headers: J, body });
    check(`/a2a/v1/${bad} cannot reach the send handler`, r.status === 404, String(r.status));
  }

  // Declared-but-unimplemented answers with the protocol's refusal, not a bare 404 —
  // "no such URL" and "that operation exists and I do not offer it" are different facts.
  const stream = await fetch(`${B}/a2a/v1/message:stream`, { method: 'POST', headers: J, body });
  check('an unimplemented DECLARED operation refuses (not 404)', stream.status === 400, String(stream.status));
  const sBody: any = await stream.json();
  check('...and names itself in the protocol\'s own error vocabulary',
    sBody?.error?.details?.[0]?.reason === 'UNSUPPORTED_OPERATION', JSON.stringify(sBody).slice(0, 120));
  // The DELETE declined route is the per-CONFIG one, so it needs both ids.
  const push = await fetch(`${B}/a2a/v1/tasks/t1/pushNotificationConfigs/c1`, { method: 'DELETE' });
  check('a DELETE declined route registers and refuses', push.status === 400, String(push.status));

  // MULTI-TURN AT THE REAL NESTING LEVEL. The continuation id lives INSIDE the
  // request envelope. Reading it from the top level made every continuation fork a
  // new engagement — and the old test passed because it sent the id where the code
  // looked, confirming the implementation rather than the protocol.
  const one: any = await (await fetch(`${B}/a2a/v1/message:send`, { method: 'POST', headers: J,
    body: JSON.stringify({ message: { parts: [{ text: 'one' }], messageId: 'm1' } }) })).json();
  const two: any = await (await fetch(`${B}/a2a/v1/message:send`, { method: 'POST', headers: J,
    body: JSON.stringify({ message: { parts: [{ text: 'two' }], messageId: 'm2', taskId: one.task.id } }) })).json();
  check('a continuation nested in the request envelope APPENDS, it does not fork',
    two.task.id === one.task.id, `${one.task.id} vs ${two.task.id}`);
  check('...and both turns are recorded', (two.task.history ?? []).length === 2,
    String((two.task.history ?? []).length));
  const ghost = await fetch(`${B}/a2a/v1/message:send`, { method: 'POST', headers: J,
    body: JSON.stringify({ message: { parts: [{ text: 'x' }], taskId: 'https://relay.test/engagements/nope' } }) });
  check('an unknown continuation id is notFound, NOT a silently-created new engagement',
    ghost.status === 404, String(ghost.status));

  // ── Content parts are never silently discarded ──────────────────────────
  //
  // A part shape we do not accept used to vanish, and the caller was then told "at
  // least one content part is required" — a different problem than the one that
  // occurred, describing a request they had not sent.
  const inlineBytes = await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: J,
    body: JSON.stringify({ message: { parts: [{ raw: 'dGNr', mediaType: 'application/x-thing' }] } }),
  });
  check('a request of only inline-bytes parts is refused', inlineBytes.status === 400,
    String(inlineBytes.status));
  const ibBody: any = await inlineBytes.json();
  check('...with a reason naming the actual problem, not a wrong one',
    /inline binary/i.test(String(ibBody?.error?.detail)), JSON.stringify(ibBody?.error?.detail));
  check('...that tells the caller what to do instead (url part)',
    /url part/i.test(String(ibBody?.error?.detail)), String(ibBody?.error?.detail).slice(0, 90));
  const emptyParts = await fetch(`${B}/a2a/v1/message:send`, {
    method: 'POST', headers: J, body: JSON.stringify({ message: { parts: [] } }),
  });
  const epBody: any = await emptyParts.json();
  check('...and a genuinely empty parts array still says THAT',
    /at least one content part/i.test(String(epBody?.error?.detail)), String(epBody?.error?.detail));

  srv.close();
}

console.log("\n11. THE CARD'S PROMISE — an advertised capability is actually PERFORMED");
{
  const express = (await import('express')).default;
  const a = express(); a.use(express.json());
  const invoked: string[] = [];
  mountAgentInterop(a as any, {
    publicBase: 'https://relay.test',
    agent: { id: 'https://relay.test/.well-known/operations', name: 'T', description: 't' },
    affordances: () => AFFORDANCES,
    verifyCaller: async () => 'did:ethr:0xAAA',
    // A real implementation: the result is COMPUTED from the input, never canned.
    invokeCapability: async ({ capability, caller, parts }) => {
      invoked.push(`${capability}|${caller}`);
      const verb = capability.split('/').pop() ?? '';
      // A deliberate refusal is RETURNED — its reason is chosen for publication.
      if (verb === 'publish_context') {
        return { ok: false as const, reason: `capability "${verb}" writes on behalf of its caller` };
      }
      // An unexpected crash is THROWN — its message is internal and must not escape.
      if (verb === 'new_verb') throw new Error('INTERNAL-DETAIL-a1b2c3 at /srv/relay/server.ts:9999');
      const text = parts.map(p => (p.kind === 'text' ? p.text ?? '' : '')).join('');
      return { ok: true as const, output: { name: verb, parts: [{ kind: 'text' as const, text: text.toUpperCase() }] } };
    },
    log: () => {},
  });
  const srv2 = a.listen(0);
  await new Promise(r => srv2.once('listening', r));
  const B2 = `http://127.0.0.1:${(srv2.address() as any).port}`;
  const J2 = { 'content-type': 'application/json' };
  const send = (skillId: string | undefined, text: string) => fetch(`${B2}/a2a/v1/message:send`, {
    method: 'POST', headers: J2,
    body: JSON.stringify({ message: { parts: [{ text }], ...(skillId ? { skillId } : {}) } }),
  }).then(r => r.json() as any);

  const done = await send('https://relay.test/ns/iep/action/relay/get_descriptor', 'hello');
  check('a task naming a capability reaches a TERMINAL state, not submitted-forever',
    done.task.status.state === 'TASK_STATE_COMPLETED', done.task.status.state);
  check('...and carries an artifact', (done.task.artifacts ?? []).length === 1,
    String((done.task.artifacts ?? []).length));
  check('...whose content is DERIVED from the input, not canned',
    done.task.artifacts?.[0]?.parts?.[0]?.text === 'HELLO',
    JSON.stringify(done.task.artifacts?.[0]?.parts));
  check('...with a dereferenceable artifact id, never an opaque handle',
    /^https:\/\/relay\.test\/engagements\/.+\/outputs\/0$/.test(done.task.artifacts?.[0]?.artifactId ?? ''),
    done.task.artifacts?.[0]?.artifactId);
  check('the VERIFIED caller is what reaches the invoker (never the payload)',
    invoked.some(i => i.endsWith('|did:ethr:0xAAA')), invoked.join(','));

  // A refused capability is an outcome of the exchange, not a transport error: the
  // peer asked a valid question and the answer is "that did not work".
  const refused = await send('https://relay.test/ns/iep/action/relay/publish_context', 'x');
  check('a refused capability FAILS the task rather than erroring the transport',
    refused.task.status.state === 'TASK_STATE_FAILED', refused.task.status.state);
  check('...and the reason is recorded ON the record, visible to the peer',
    JSON.stringify(refused.task.history).includes('writes on behalf of its caller'),
    JSON.stringify(refused.task.history).slice(0, 120));
  check('...and a failed task produces no artifact', !(refused.task.artifacts ?? []).length);

  // ★ A CRASH MUST NOT REACH THE CALLER. The first version echoed the thrown
  // message, so a live run returned an internal "Cannot read properties of
  // undefined" to an external peer — through a comment claiming it could not
  // happen. Refusal-vs-crash is now a structural distinction, and this is the
  // assertion that keeps it one.
  AFFORDANCES.push({ action: 'https://relay.test/ns/iep/action/relay/new_verb', title: 'new_verb', comment: 'throws', vertical: 'relay', requiresAuth: false });
  const crashed = await send('https://relay.test/ns/iep/action/relay/new_verb', 'x');
  AFFORDANCES.pop();
  check('an unexpected crash still FAILS the task cleanly',
    crashed.task.status.state === 'TASK_STATE_FAILED', crashed.task.status.state);
  const crashText = JSON.stringify(crashed.task);
  check('...and NO internal detail reaches the caller',
    !/INTERNAL-DETAIL-a1b2c3|server\.ts|:9999/.test(crashText), crashText.slice(0, 140));
  check('...only a generic, caller-safe reason',
    /could not be completed/i.test(crashText), crashText.slice(0, 140));

  // Naming nothing must stay exactly as before — this is additive.
  const plain = await send(undefined, 'x');
  check('a task naming NO capability is unchanged (submitted, no artifacts)',
    plain.task.status.state === 'TASK_STATE_SUBMITTED' && !plain.task.artifacts,
    plain.task.status.state);

  srv2.close();
}


console.log('\n9. an evicted engagement is GONE, not "never existed"');
{
  // ★ The engine's store is bounded, so a long-running relay silently drops the oldest
  // engagements. The id it minted is a URL, and after eviction that URL answered 404 —
  // which asserts it never existed. For a peer holding the id, or a workspace entry citing
  // it, that assertion is FALSE, and the two facts need different answers: "we no longer
  // keep this" is a retention limit somebody can raise; "you made this up" is a caller bug.
  //
  // Same defect class as the 404 fixed in 5b above, one layer down: there the route was
  // missing, here the record is. Both made a minted URL lie.
  const tiny = new EngagementEngine('https://relay.test', { maxEngagements: 2 });
  const A = tiny.open({ caller: 'did:ethr:0xAAA', parts: [{ text: 'first' }] });
  const B = tiny.open({ caller: 'did:ethr:0xAAA', parts: [{ text: 'second' }] });
  check('two engagements fit', A.ok && B.ok);
  const firstId = A.ok ? A.value.id : '';

  // The third open evicts the first.
  tiny.open({ caller: 'did:ethr:0xAAA', parts: [{ text: 'third' }] });

  const evicted = tiny.get(firstId, 'did:ethr:0xAAA');
  check('★ the OWNER is told it was evicted, not that it never existed',
    isEngineError(evicted) && evicted.error.kind === 'gone',
    isEngineError(evicted) ? evicted.error.kind : 'ok');
  check('...and the reason names when, so a retention limit is diagnosable',
    isEngineError(evicted) && /dropped at \d{4}-/.test(evicted.error.detail),
    isEngineError(evicted) ? evicted.error.detail.slice(0, 70) : '');

  // ★ AND NOT TO ANYONE ELSE. A tombstone visible to a stranger would rebuild the
  // existence oracle the owner-scoping exists to close — the same rule 5b enforces.
  const stranger = tiny.get(firstId, 'did:ethr:0xBBB');
  const invented = tiny.get('https://relay.test/engagements/never', 'did:ethr:0xBBB');
  check('★ a stranger gets notFound for the evicted id',
    isEngineError(stranger) && stranger.error.kind === 'notFound',
    isEngineError(stranger) ? stranger.error.kind : 'ok');
  check('...INDISTINGUISHABLE from an id that never existed',
    JSON.stringify(stranger) === JSON.stringify(invented));

  // The tombstone set is itself bounded: an unbounded record of what was dropped for
  // space would defeat the bound it exists to explain.
  const capped = new EngagementEngine('https://relay.test', { maxEngagements: 1, maxTombstones: 1 });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = capped.open({ caller: 'did:ethr:0xAAA', parts: [{ text: `e${i}` }] });
    if (r.ok) ids.push(r.value.id);
  }
  const oldestGone = capped.get(ids[0]!, 'did:ethr:0xAAA');
  const newestGone = capped.get(ids[2]!, 'did:ethr:0xAAA');
  check('the tombstone set is itself bounded — the oldest marker is dropped',
    isEngineError(oldestGone) && oldestGone.error.kind === 'notFound',
    isEngineError(oldestGone) ? oldestGone.error.kind : 'ok');
  check('...while a recent eviction still reports gone',
    isEngineError(newestGone) && newestGone.error.kind === 'gone',
    isEngineError(newestGone) ? newestGone.error.kind : 'ok');
}

console.log('\n10. the engine is injectable, so durability needs no second change here');
{
  // ★ The default engine does not survive a restart, so every id this relay minted stops
  // resolving. A deployment that needs cited engagements to keep resolving supplies its
  // own; the seam is what makes that possible without touching the mount again.
  const injected = new EngagementEngine('https://relay.test');
  const pre = injected.open({ caller: 'did:ethr:0xAAA', parts: [{ text: 'from before the restart' }] });
  check('an engagement exists in the injected engine before mounting', pre.ok);

  // Every verb the mount can register, for the same reason the first double carries
  // `delete`: a missing one crashes at boot rather than silently skipping a route.
  const r2: any[] = [];
  const app2: any = {
    get: (p: any, h: any) => r2.push({ method: 'GET', path: p, handler: h }),
    post: (p: any, h: any) => r2.push({ method: 'POST', path: p, handler: h }),
    delete: (p: any, h: any) => r2.push({ method: 'DELETE', path: p, handler: h }),
  };
  mountAgentInterop(app2, {
    publicBase: 'https://relay.test',
    agent: { id: 'https://relay.test/.well-known/operations', name: 'Test Relay', description: 'test' },
    affordances: () => AFFORDANCES,
    verifyCaller: async () => 'did:ethr:0xAAA',
    engine: injected,
    log: () => {},
  });
  const resolver2 = r2.find((r: any) => r.method === 'GET' && r.path === '/engagements/:id');
  const tail2 = pre.ok ? String(pre.value.id).split('/engagements/')[1] : '';
  const got = mkRes();
  await resolver2.handler({ headers: {}, query: {}, params: { id: tail2 }, body: {} }, got);
  check('★ a mount given an engine resolves engagements it did not create',
    got.statusCode === 200, String(got.statusCode));

  // The seam must be a DEFAULT, not a requirement — every existing caller omits it.
  check('omitting the engine still works (the default is in-memory)',
    routes.some(r => r.method === 'GET' && r.path === '/engagements/:id'));
}


if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nAll agent-interop mount gates hold.\n');
