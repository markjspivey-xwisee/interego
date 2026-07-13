// Integration test: the OAuth session bridge driving REAL AMEP acts in-process.
// Mounts the amep engine with a mock introspect (simulating an OAuth mcp:write
// bearer), then routes withAmepSession's fetch straight into the /amep/acts
// handler — exercising the exact chain a ChatGPT `act` call takes:
//   bridge attaches the caller's bearer + stamps act.actor
//     -> amep authenticate() introspect resolves the token -> principal userId
//     -> actor-binding (act.actor === principal) passes
//     -> Compose is server-computed -> 201, attributed to the OAuth user.
// Run: tsx _amep-oauth-bridge-integration-test.ts
import { mountAmep } from './amep.js';
import { withAmepSession } from './amep-session-bridge.js';
// @ts-ignore
import * as validator from './amep-vendor/validator.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const amepContext = JSON.parse(readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'));

const BASE = 'https://relay.interego.xwisee.com';
const ALICE = 'did:key:z6MkAliceOAuthUser';
const ALICE_TOKEN = 'oauth-access-token-alice';

// ── in-memory CSS + amep mount (same pattern as _amep-allacts-test.ts) ──
const store = new Map<string, { body: string; etag: string }>();
let etagN = 0;
const cssFetch = async (url: string, init: any = {}): Promise<any> => {
  const m = (init.method ?? 'GET').toUpperCase(); const cur = store.get(url);
  const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  if (m === 'GET') return cur ? { ok: true, status: 200, statusText: 'OK', headers: H({ etag: cur.etag }), text: async () => cur.body, json: async () => JSON.parse(cur.body) } : { ok: false, status: 404, statusText: 'NF', headers: H({}), text: async () => '', json: async () => ({}) };
  if (m === 'PUT') {
    const im = init.headers?.['If-Match']; const inm = init.headers?.['If-None-Match'];
    if (inm === '*' && cur) return { ok: false, status: 412, statusText: 'x', headers: H({}), text: async () => '', json: async () => ({}) };
    if (im && (!cur || cur.etag !== im)) return { ok: false, status: 412, statusText: 'x', headers: H({}), text: async () => '', json: async () => ({}) };
    const etag = `"e${++etagN}"`; store.set(url, { body: init.body, etag });
    return { ok: true, status: cur ? 205 : 201, statusText: 'OK', headers: H({ etag }), text: async () => '', json: async () => ({}) };
  }
  return { ok: false, status: 405, statusText: 'x', headers: H({}), text: async () => '', json: async () => ({}) };
};
const routes: Record<string, any> = {};
const fakeApp: any = { get: (p: string, ...h: any[]) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p: string, ...h: any[]) => { routes[`POST ${p}`] = h[h.length - 1]; } };
// The mock introspect: ALICE_TOKEN → an mcp:write OAuth principal. Anything else → null.
const introspect = (tok: string) => (tok === ALICE_TOKEN ? { userId: ALICE, scope: ['mcp:write'], clientId: 'chatgpt-client' } : null);
mountAmep(fakeApp, { solidFetch: cssFetch as any, withPodMutex: async (_k: string, fn: any) => fn(), introspect: introspect as any, cssUrl: 'http://css.local:3456/', maintainerPod: 'maintainer', publicBase: BASE, actSecret: 'unused-operator-secret-000000', log: () => {} });

// ── fetch → in-memory /amep/acts handler adapter ─────────────
// Translates the bridge's solidFetch(url, init) POST into a direct call of the
// mounted route handler, returning a FetchResponse. This is the seam that lets
// the bridge's auto-attached Authorization header reach amep's authenticate().
function mkRes() { return { _s: 200, _b: '', _h: {} as Record<string, string>, status(c: number) { this._s = c; return this; }, type() { return this; }, setHeader(k: string, v: string) { this._h[k.toLowerCase()] = v; }, send(b: string) { this._b = b; return this; } }; }
const handlerFetch = async (url: string, init: any = {}): Promise<any> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const u = new URL(url);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (!headers['content-type']) headers['content-type'] = 'application/affordance+yaml';
  const handler = routes[`${method} ${u.pathname}`];
  if (!handler) return { ok: false, status: 404, statusText: 'NF', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  const res = mkRes();
  await handler({ headers, body: init.body ?? '', query: {} }, res);
  return { ok: res._s < 400, status: res._s, statusText: 'OK', headers: { get: (n: string) => res._h[n.toLowerCase()] ?? null }, text: async () => res._b, json: async () => JSON.parse(res._b || '{}') };
};

let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
async function conforms(body: string) { const rep = await validator.validateDocument(yaml.load(body), amepContext, { validateHashes: true }); return rep['sh:conforms']; }
const now = '2026-07-12T23:00:00Z';
const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const proof = { '@type': 'iep:SignedAuthorship', verificationMethod: `${ALICE}#k`, created: now, proofValue: 'z' };
// act @id must be an absolute dereferenceable URL (amep gate).
const AID = (n: string) => `${BASE}/amep/acts/bt/${n}`;

// Submit an act THROUGH the bridge as the OAuth user (NO explicit actor, NO
// explicit auth — exactly what a chat `act` call carries; the relay fills both).
async function submitViaBridge(actNoActor: any, memory?: any, opts: { bearer?: string; principal?: string; explicitActor?: string } = {}) {
  const bearer = 'bearer' in opts ? opts.bearer : ALICE_TOKEN;
  const principal = 'principal' in opts ? opts.principal : ALICE;
  const act = opts.explicitActor ? { ...actNoActor, actor: opts.explicitActor } : actNoActor;
  const doc: any = { '@context': [CTX], '@id': `urn:ex:${actNoActor['@id']}`, '@type': 'amep:Exchange', act, ...(memory ? { memory } : {}) };
  const { fetch, payload } = withAmepSession(`${BASE}/amep/acts`, doc, { sessionBearer: bearer, principalId: principal }, { solidFetch: handlerFetch as any, publicBaseUrl: BASE });
  const resp = await fetch(`${BASE}/amep/acts`, { method: 'POST', headers: { 'content-type': 'application/affordance+yaml' }, body: JSON.stringify(payload) });
  return { status: resp.status, body: await resp.text(), stampedActor: (payload as any)?.act?.actor };
}
const mem = (id: string, body: string) => ({ '@id': id, '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body, epistemicStatus: 'iep:Asserted', attributedTo: ALICE } });

console.log('=== OAuth session bridge → real AMEP acts (in-process) ===');

// 1. Ask as the OAuth user — no actor, no bearer pasted.
const rAsk = await submitViaBridge({ '@id': AID('ask'), '@type': 'amep:ProtocolAct', actType: 'amep:Ask', createdAt: now, proof });
check('1. Ask via bridge → 201 (bridge supplied bearer + actor)', rAsk.status === 201 && await conforms(rAsk.body), `(${rAsk.status}${rAsk.status >= 400 ? ' ' + rAsk.body.slice(0, 160) : ''})`);
check('   bridge stamped act.actor = OAuth userId', rAsk.stampedActor === ALICE);
const hAsk = (yaml.load(rAsk.body) as any).head;

// 2. Assert.
const rA = await submitViaBridge({ '@id': AID('assertA'), '@type': 'amep:ProtocolAct', actType: 'amep:Assert', expectedHead: hAsk, createdAt: now, proof }, mem('urn:m:A', 'Ship Friday.'));
check('2. Assert via bridge → 201', rA.status === 201, `(${rA.status})`);
const hA = (yaml.load(rA.body) as any).head;
check('   served memory attributedTo = OAuth userId', (yaml.load(rA.body) as any).memory?.semantic?.attributedTo === ALICE);

// 3. Challenge (sibling).
const rB = await submitViaBridge({ '@id': AID('challengeB'), '@type': 'amep:ProtocolAct', actType: 'amep:Challenge', expectedHead: hA, challengedAct: AID('assertA'), createdAt: now, proof }, mem('urn:m:B', 'Ship Monday.'));
check('3. Challenge via bridge → 201', rB.status === 201, `(${rB.status})`);
const hB = (yaml.load(rB.body) as any).head;

// 4. Compose — THE payoff: OAuth user merges two heads with no bearer, no actor.
const rC = await submitViaBridge({ '@id': AID('compose'), '@type': 'amep:ProtocolAct', actType: 'amep:Compose', expectedHead: hA, operands: [hA, hB].sort(), operator: 'union', createdAt: now, proof });
check('4. Compose via bridge → 201 + conforms', rC.status === 201 && await conforms(rC.body), `(${rC.status}${rC.status >= 400 ? ' ' + rC.body.slice(0, 200) : ''})`);
const cDoc: any = yaml.load(rC.body);
check('   composed memory attributedTo = OAuth userId (not forged)', cDoc.memory?.semantic?.attributedTo === ALICE);
check('   composed body merged BOTH operand heads', /Ship Friday/.test(cDoc.memory?.semantic?.body || '') && /Ship Monday/.test(cDoc.memory?.semantic?.body || ''));

// 5. NEGATIVE (no bridge): same Ask, no bearer, no actor → 401 (proves the bridge is load-bearing).
const rNo = await submitViaBridge({ '@id': AID('noauth'), '@type': 'amep:ProtocolAct', actType: 'amep:Ask', createdAt: now, proof }, undefined, { bearer: undefined, principal: undefined });
check('5. WITHOUT bridge (no bearer) → 401 (bridge is what authorizes)', rNo.status === 401, `(${rNo.status})`);

// 6. SECURITY: user tries to stamp a DIFFERENT actor → bridge leaves it → amep 403 (no impersonation).
const rForge = await submitViaBridge({ '@id': AID('forge'), '@type': 'amep:ProtocolAct', actType: 'amep:Ask', createdAt: now, proof }, undefined, { explicitActor: 'did:key:z6MkSomeoneElse' });
check('6. forged actor != principal → 403 (bridge never rewrites a stated actor)', rForge.status === 403, `(${rForge.status})`);

// 7. SECURITY: a read-only-style token that introspect rejects → 401 (real token still enforced).
const rBadTok = await submitViaBridge({ '@id': AID('badtok'), '@type': 'amep:ProtocolAct', actType: 'amep:Ask', createdAt: now, proof }, undefined, { bearer: 'not-a-real-token', principal: ALICE });
check('7. unknown token forwarded → 401 (amep introspect still gates)', rBadTok.status === 401, `(${rBadTok.status})`);

console.log(`\n${ok}/${ok + bad} OAuth-bridge integration checks passed`);
process.exit(bad === 0 ? 0 : 1);
