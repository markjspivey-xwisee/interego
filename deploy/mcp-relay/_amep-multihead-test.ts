// Multiparty Challenge over concurrent branch heads. Two agents produce
// competing Candidates against one inquiry; a human Accepts the NON-latest
// sibling. Proves the multi-head CAS: expectedHead is membership in the open
// set, not equality to a single tip. In-memory CSS stub.
import { mountAmep } from './amep.js';
// @ts-ignore
import * as validator from './amep-vendor/validator.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const amepContext = JSON.parse(readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'));

const store = new Map<string, { body: string; etag: string }>();
let etagN = 0;
const cssFetch = async (url: string, init: any = {}): Promise<any> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const cur = store.get(url);
  const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  if (method === 'GET') return cur
    ? { ok: true, status: 200, statusText: 'OK', headers: H({ etag: cur.etag }), text: async () => cur.body, json: async () => JSON.parse(cur.body) }
    : { ok: false, status: 404, statusText: 'NF', headers: H({}), text: async () => '', json: async () => ({}) };
  if (method === 'PUT') {
    const ifm = init.headers?.['If-Match']; const ifn = init.headers?.['If-None-Match'];
    if (ifn === '*' && cur) return { ok: false, status: 412, statusText: 'PC', headers: H({}), text: async () => '', json: async () => ({}) };
    if (ifm && (!cur || cur.etag !== ifm)) return { ok: false, status: 412, statusText: 'PC', headers: H({}), text: async () => '', json: async () => ({}) };
    const etag = `"e${++etagN}"`; store.set(url, { body: init.body, etag });
    return { ok: true, status: cur ? 205 : 201, statusText: 'OK', headers: H({ etag }), text: async () => '', json: async () => ({}) };
  }
  return { ok: false, status: 405, statusText: 'x', headers: H({}), text: async () => '', json: async () => ({}) };
};

const routes: Record<string, any> = {};
const fakeApp: any = { get: (p: string, ...h: any[]) => { routes[`GET ${p}`] = h[h.length - 1]; }, post: (p: string, ...h: any[]) => { routes[`POST ${p}`] = h[h.length - 1]; } };
const OP = 'multihead-operator-secret-00000000';
mountAmep(fakeApp, { solidFetch: cssFetch as any, withPodMutex: async (_k: string, fn: any) => fn(), introspect: () => null, cssUrl: 'http://css.local:3456/', maintainerPod: 'maintainer', publicBase: 'https://relay.interego.xwisee.com', actSecret: OP, log: () => {} });

const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const now = '2026-07-12T15:00:00Z';
// _s defaults to 200 like express (a success send() sets no explicit status).
function mkRes() { return { _s: 200, _h: {} as any, _b: '', status(c: number) { this._s = c; return this; }, type() { return this; }, setHeader(k: string, v: string) { this._h[k] = v; }, send(b: string) { this._b = b; return this; } }; }
async function post(obj: any) {
  const res = mkRes();
  await routes['POST /amep/acts']({ headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/affordance+yaml' }, body: yaml.dump(obj), query: {} }, res);
  return res;
}
async function getHeads(slug: string) { const res = mkRes(); await routes['GET /amep/exchanges/:slug/heads']({ params: { slug }, query: {}, headers: {} }, res); return JSON.parse(res._b); }

let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

const human = 'did:key:z6MkHumanArbiter';
const agentA = 'did:key:z6MkAgentAlpha';
const agentB = 'did:key:z6MkAgentBeta';
const ex = 'urn:exchange:mp';
const actor = (id: string, t = 'prov:SoftwareAgent', name = 'x') => ({ '@id': id, '@type': t, displayName: name });
const proof = (id: string) => ({ '@type': 'iep:SignedAuthorship', verificationMethod: `${id}#k`, created: now, proofValue: 'z' });
const mem = (id: string, body: string, by: string) => ({ '@id': id, '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body, epistemicStatus: 'iep:Asserted', attributedTo: by } });

// 1. Human Asks.
const rAsk = await post({ '@context': [CTX], '@id': `${ex}:ask`, '@type': 'amep:Exchange', actor: actor(human, 'prov:Person', 'Arbiter'),
  act: { '@id': 'urn:act:mp:ask', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: human, createdAt: now, proof: proof(human) } });
check('Ask → 201', rAsk._s === 201, `(${rAsk._s})`);
const askHead = (yaml.load(rAsk._b) as any).head;
const slug = /urn:head:([a-z0-9]+):/.exec(askHead)![1];

// 2. Agent A Asserts a candidate.
const rA = await post({ '@context': [CTX], '@id': `${ex}:assertA`, '@type': 'amep:Exchange', actor: actor(agentA, 'prov:SoftwareAgent', 'Alpha'),
  act: { '@id': 'urn:act:mp:assertA', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: agentA, expectedHead: askHead, createdAt: now, proof: proof(agentA) },
  memory: mem('urn:memory:mp:A', 'Ship on Friday after the checksum passes.', agentA) });
check('Agent A Assert → 201', rA._s === 201, `(${rA._s})`);
const headA = (yaml.load(rA._b) as any).head;

// 3. Agent B Challenges A's candidate → a SIBLING candidate (A stays open).
const rB = await post({ '@context': [CTX], '@id': `${ex}:challengeB`, '@type': 'amep:Exchange', actor: actor(agentB, 'prov:SoftwareAgent', 'Beta'),
  act: { '@id': 'urn:act:mp:challengeB', '@type': 'amep:ProtocolAct', actType: 'amep:Challenge', actor: agentB, expectedHead: headA, challengedAct: 'urn:act:mp:assertA', createdAt: now, proof: proof(agentB) },
  memory: mem('urn:memory:mp:B', 'No — ship Monday; the rollback drill is not done.', agentB) });
check('Agent B Challenge → 201 (sibling candidate)', rB._s === 201, `(${rB._s}${rB._s>=400?' '+rB._b.slice(0,120):''})`);
const headB = (yaml.load(rB._b) as any).head;

// 4. BOTH candidates are open + dereferenceable.
const heads = await getHeads(slug);
const openSet = new Set(heads.openHeads);
check('both A and B heads are OPEN concurrently', openSet.has(headA) && openSet.has(headB), `open=${heads.openHeads.length}`);
check('heads map lists 3 heads (ask, A, B)', heads.heads.length === 3);

// 5. The human Accepts AGENT A's candidate — the NON-latest sibling. This is the
//    multi-head payoff: expectedHead=headA even though headB is more recent.
const rAcc = await post({ '@context': [CTX], '@id': `${ex}:accept`, '@type': 'amep:Exchange', actor: actor(human, 'prov:Person', 'Arbiter'),
  act: { '@id': 'urn:act:mp:accept', '@type': 'amep:ProtocolAct', actType: 'amep:Accept', actor: human, expectedHead: headA, acceptedAct: 'urn:act:mp:assertA', createdAt: now, proof: proof(human) } });
check('human Accepts the NON-latest sibling (A) → 201', rAcc._s === 201, `(${rAcc._s}${rAcc._s>=400?' '+rAcc._b.slice(0,140):''})`);
if (rAcc._s === 201) {
  const doc: any = yaml.load(rAcc._b);
  const rep = await validator.validateDocument(doc, amepContext, { validateHashes: true });
  check('committed representation CONFORMS', rep['sh:conforms'], rep['sh:conforms'] ? '' : JSON.stringify(rep['sh:result'].slice(0, 2)));
  check('accepted memory is Committed + A’s content', doc.memory?.governanceStatus === 'amep:Committed' && /Friday/.test(doc.memory?.semantic?.body || ''));
}

// 6. Challenge's losing sibling (B) is still dereferenceable as a Candidate.
const bView = mkRes();
await routes['GET /amep/heads/:slug/:headId']({ params: { slug, headId: encodeURIComponent(headB) }, query: {}, headers: { accept: 'application/affordance+yaml' } }, bView);
const bDoc: any = yaml.load(bView._b);
check('losing sibling B still dereferenceable as Candidate', bView._s === 200 && bDoc.memory?.governanceStatus === 'amep:Candidate', `(${bView._s})`);

console.log(`\n${ok}/${ok + bad} checks passed`);
process.exit(bad === 0 ? 0 : 1);
