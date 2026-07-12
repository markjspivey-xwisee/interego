// Integration test of POST /amep/acts against an in-memory CSS stub. Exercises
// auth, CAS, conditional write, replay idempotency, and response conformance —
// all locally, before any deploy.
import { mountAmep } from './amep.js';
// @ts-ignore
import * as validator from './amep-vendor/validator.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const amepContext = JSON.parse(readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'));

// In-memory CSS with ETag + If-Match semantics.
const store = new Map<string, { body: string; etag: string }>();
let etagN = 0;
const cssFetch = async (url: string, init: any = {}): Promise<any> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const cur = store.get(url);
  const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  if (method === 'GET') {
    if (!cur) return { ok: false, status: 404, statusText: 'NF', headers: H({}), text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, statusText: 'OK', headers: H({ etag: cur.etag }), text: async () => cur.body, json: async () => JSON.parse(cur.body) };
  }
  if (method === 'PUT') {
    const ifMatch = init.headers?.['If-Match']; const ifNone = init.headers?.['If-None-Match'];
    if (ifNone === '*' && cur) return { ok: false, status: 412, statusText: 'PC', headers: H({}), text: async () => '', json: async () => ({}) };
    if (ifMatch && (!cur || cur.etag !== ifMatch)) return { ok: false, status: 412, statusText: 'PC', headers: H({}), text: async () => '', json: async () => ({}) };
    const etag = `"e${++etagN}"`;
    store.set(url, { body: init.body, etag });
    return { ok: true, status: cur ? 205 : 201, statusText: 'OK', headers: H({ etag }), text: async () => '', json: async () => ({}) };
  }
  return { ok: false, status: 405, statusText: 'MNA', headers: H({}), text: async () => '', json: async () => ({}) };
};

const routes: Record<string, any> = {};
const mws: Record<string, any[]> = {};
const fakeApp: any = {
  get: (p: string, ...h: any[]) => { routes[`GET ${p}`] = h[h.length - 1]; },
  post: (p: string, ...h: any[]) => { routes[`POST ${p}`] = h[h.length - 1]; mws[`POST ${p}`] = h.slice(0, -1); },
};
const OP = 'test-operator-secret-000000000000';
mountAmep(fakeApp, {
  solidFetch: cssFetch as any, withPodMutex: async (_k: string, fn: any) => fn(),
  introspect: () => null, cssUrl: 'http://css.local:3456/', maintainerPod: 'maintainer',
  publicBase: 'https://relay.interego.xwisee.com', actSecret: OP,
  log: () => {},
});

function mkRes() {
  return { _s: 0, _h: {} as Record<string, string>, _b: '',
    status(c: number) { this._s = c; return this; }, type() { return this; },
    setHeader(k: string, v: string) { this._h[k] = v; }, send(b: string) { this._b = b; return this; } };
}
async function post(bodyObj: any, auth = `Bearer ${OP}`) {
  const req: any = { headers: { authorization: auth, 'content-type': 'application/affordance+yaml' }, body: yaml.dump(bodyObj), query: {} };
  const res = mkRes();
  await routes['POST /amep/acts'](req, res);
  return res;
}

let ok = 0, bad = 0;
const check = (name: string, pass: boolean, extra = '') => { pass ? ok++ : bad++; console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const now = '2026-07-12T00:00:00Z';
const agent = 'did:key:z6MkTestAgent';
const askAct = {
  '@context': [CTX], '@id': 'urn:exchange:test:ask', '@type': 'amep:Exchange',
  actor: { '@id': agent, '@type': 'prov:SoftwareAgent', displayName: 'Test' },
  act: { '@id': 'urn:act:test:ask1', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: agent, createdAt: now,
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${agent}#k`, created: now, proofValue: 'zAsk' } },
};

// 1. anonymous rejected
const anon = await post(askAct, '');
check('anonymous POST → 401', anon._s === 401);

// 2. Ask opens the exchange → 201; capture its head.
const rAsk = await post(askAct);
check('operator Ask → 201', rAsk._s === 201, `(got ${rAsk._s})`);
const askHead = rAsk._s === 201 ? (yaml.load(rAsk._b) as any).head : null;

// Assert against the ask head.
const assertAct = {
  '@context': [CTX], '@id': 'urn:exchange:test:assert', '@type': 'amep:Exchange',
  actor: { '@id': agent, '@type': 'prov:SoftwareAgent', displayName: 'Test' },
  act: { '@id': 'urn:act:test:assert1', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: agent, expectedHead: askHead, createdAt: now,
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${agent}#k`, created: now, proofValue: 'zTest' } },
  memory: { '@id': 'urn:memory:test:m1', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim',
    semantic: { '@type': 'amep:SemanticMaterial', body: 'A durable test claim about the system.', epistemicStatus: 'iep:Asserted', attributedTo: agent } },
};

// 3. operator Assert applied → 201 + conformant
const r1 = await post(assertAct);
check('operator Assert → 201', r1._s === 201, `(got ${r1._s}${r1._s >= 400 ? ' ' + r1._b.slice(0, 160) : ''})`);
if (r1._s === 201) {
  const doc = yaml.load(r1._b);
  const rep = await validator.validateDocument(doc, amepContext, { validateHashes: true });
  check('201 body conforms to AMEP validator', rep['sh:conforms'], rep['sh:conforms'] ? '' : JSON.stringify(rep['sh:result'].slice(0, 2)));
  check('201 has Location + ETag', !!r1._h['Location'] && !!r1._h['ETag']);
}

// 3. replay (same act, same bytes) → 200 same receipt
const r2 = await post(assertAct);
check('replay same act → 200', r2._s === 200, `(got ${r2._s})`);

// 4. same act id, different bytes → 409
const tampered = JSON.parse(JSON.stringify(assertAct));
tampered.memory.semantic.body = 'A DIFFERENT claim.';
const r3 = await post(tampered);
check('same act id, different bytes → 409', r3._s === 409, `(got ${r3._s})`);

// 5. YAML anchor bomb → 400
const bombReq: any = { headers: { authorization: `Bearer ${OP}` }, body: 'act: &a {x: 1}\nb: *a\n', query: {} };
const bombRes = mkRes();
await routes['POST /amep/acts'](bombReq, bombRes);
check('YAML anchor rejected → 400', bombRes._s === 400, `(got ${bombRes._s})`);

// 6. nested @context → 400
const nested = JSON.parse(JSON.stringify(assertAct));
nested.memory.semantic['@context'] = 'http://evil.local/ctx';
const r6 = await post(nested);
check('nested @context rejected → 400', r6._s === 400, `(got ${r6._s})`);

// 7. TORN-WRITE PREVENTION: a malformed memory (missing attributedTo) that fails
//    the reference validator must be rejected 422 BEFORE any write — not 500
//    with the head advanced. Fresh exchange so we can assert the head is intact.
const ask2 = await post({ ...askAct, '@id': 'urn:exchange:test2:ask', act: { ...askAct.act, '@id': 'urn:act:test2:ask' } });
const ask2Head = ask2._s === 201 ? (yaml.load(ask2._b) as any).head : null;
const badAssert = {
  '@context': [CTX], '@id': 'urn:exchange:test2:assert', '@type': 'amep:Exchange',
  actor: { '@id': agent, '@type': 'prov:SoftwareAgent', displayName: 'Test' },
  act: { '@id': 'urn:act:test2:assert1', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: agent, expectedHead: ask2Head, createdAt: now,
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${agent}#k`, created: now, proofValue: 'zTest' } },
  // memory.semantic MISSING attributedTo → non-conformant
  memory: { '@id': 'urn:memory:test2:m1', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim',
    semantic: { '@type': 'amep:SemanticMaterial', body: 'Malformed: no attributedTo.', epistemicStatus: 'iep:Asserted' } },
};
const rBad = await post(badAssert);
check('malformed memory → 422 (not 500 torn write)', rBad._s === 422, `(got ${rBad._s})`);
// Re-POST the SAME bad assert: if the first had been a torn write the head would
// have advanced and this would 412; a clean pre-write reject stays 422.
const rBad2 = await post(badAssert);
check('re-submit malformed → still 422 (head never advanced)', rBad2._s === 422, `(got ${rBad2._s})`);

// 8. RESERVED-KEY STRIPPING: a client-injected amep:submittedBy in memory must
//    not survive into the served representation (forged attribution).
const ask3 = await post({ ...askAct, '@id': 'urn:exchange:test3:ask', act: { ...askAct.act, '@id': 'urn:act:test3:ask' } });
const ask3Head = ask3._s === 201 ? (yaml.load(ask3._b) as any).head : null;
const forged = {
  '@context': [CTX], '@id': 'urn:exchange:test3:assert', '@type': 'amep:Exchange',
  actor: { '@id': agent, '@type': 'prov:SoftwareAgent', displayName: 'Test' },
  act: { '@id': 'urn:act:test3:assert1', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: agent, expectedHead: ask3Head, createdAt: now,
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${agent}#k`, created: now, proofValue: 'zTest' } },
  memory: { '@id': 'urn:memory:test3:m1', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim',
    'amep:submittedBy': 'did:key:zForgedTrustedMaintainer',
    semantic: { '@type': 'amep:SemanticMaterial', body: 'A claim with a forged submitter.', epistemicStatus: 'iep:Asserted', attributedTo: agent } },
};
const rForge = await post(forged);
check('injected amep:submittedBy → 201 (accepted, key stripped)', rForge._s === 201, `(got ${rForge._s})`);
check('forged submitter NOT in served memory', rForge._s === 201 && !rForge._b.includes('zForgedTrustedMaintainer'));

console.log(`\n${ok}/${ok + bad} checks passed`);
process.exit(bad === 0 ? 0 : 1);
