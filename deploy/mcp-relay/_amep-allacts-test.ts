// Exercises ALL SIX acts end-to-end and validates every projection with the
// reference validator: Ask → Assert → Challenge → Compose → Accept → Fork.
// In-memory CSS stub. This is the completeness gate for the act surface.
import { mountAmep } from './amep.js';
// @ts-ignore
import * as validator from './amep-vendor/validator.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
const amepContext = JSON.parse(readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'));

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
const OP = 'allacts-operator-secret-000000000';
mountAmep(fakeApp, { solidFetch: cssFetch as any, withPodMutex: async (_k: string, fn: any) => fn(), introspect: () => null, cssUrl: 'http://css.local:3456/', maintainerPod: 'maintainer', publicBase: 'https://relay.interego.xwisee.com', actSecret: OP, log: () => {} });

const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const now = '2026-07-12T20:00:00Z';
function mkRes() { return { _s: 200, _b: '', status(c: number) { this._s = c; return this; }, type() { return this; }, setHeader() {}, send(b: string) { this._b = b; return this; } }; }
async function post(obj: any) { const res = mkRes(); await routes['POST /amep/acts']({ headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/affordance+yaml' }, body: yaml.dump(obj), query: {} }, res); return res; }
let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
async function conforms(body: string) { const rep = await validator.validateDocument(yaml.load(body), amepContext, { validateHashes: true }); if (!rep['sh:conforms']) console.log('      ' + JSON.stringify(rep['sh:result'].slice(0, 2))); return rep['sh:conforms']; }

const p = (id: string) => ({ '@type': 'iep:SignedAuthorship', verificationMethod: `${id}#k`, created: now, proofValue: 'z' });
const A = 'did:key:z6MkA', B = 'did:key:z6MkB', hum = 'did:key:z6MkH';
const ac = (id: string, t: string, n: string) => ({ '@id': id, '@type': t, displayName: n });
const mem = (id: string, body: string, by: string, extra: any = {}) => ({ '@id': id, '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body, epistemicStatus: 'iep:Asserted', attributedTo: by }, ...extra });

// 1. Ask
const rAsk = await post({ '@context': [CTX], '@id': 'urn:exchange:all:ask', '@type': 'amep:Exchange', actor: ac(hum, 'prov:Person', 'H'), act: { '@id': 'urn:act:all:ask', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: hum, createdAt: now, proof: p(hum) } });
check('1. Ask → 201 + conforms', rAsk._s === 201 && await conforms(rAsk._b), `(${rAsk._s})`);
const hAsk = (yaml.load(rAsk._b) as any).head;

// 2. Assert A
const mA = 'urn:memory:all:A';
const rA = await post({ '@context': [CTX], '@id': 'urn:exchange:all:A', '@type': 'amep:Exchange', actor: ac(A, 'prov:SoftwareAgent', 'A'), act: { '@id': 'urn:act:all:assertA', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: A, expectedHead: hAsk, createdAt: now, proof: p(A) }, memory: mem(mA, 'Alpha claim.', A) });
check('2. Assert → 201 + conforms', rA._s === 201 && await conforms(rA._b), `(${rA._s})`);
const hA = (yaml.load(rA._b) as any).head;

// 3. Challenge B (sibling)
const mB = 'urn:memory:all:B';
const rB = await post({ '@context': [CTX], '@id': 'urn:exchange:all:B', '@type': 'amep:Exchange', actor: ac(B, 'prov:SoftwareAgent', 'B'), act: { '@id': 'urn:act:all:challengeB', '@type': 'amep:ProtocolAct', actType: 'amep:Challenge', actor: B, expectedHead: hA, challengedAct: 'urn:act:all:assertA', createdAt: now, proof: p(B) }, memory: mem(mB, 'Beta counter-claim.', B) });
check('3. Challenge → 201 + conforms', rB._s === 201 && await conforms(rB._b), `(${rB._s})`);
const hB = (yaml.load(rB._b) as any).head;

// 4. Compose — the SERVER deterministically merges the two open OPERAND HEADS
//    (hA + hB) into one composed memory. The client supplies only the heads and
//    operator; it does NOT supply the composed material (that would be
//    unverifiable). Same heads + operator replay to the same body + semanticCid.
const operands = [hA, hB].sort();
const rC = await post({ '@context': [CTX], '@id': 'urn:exchange:all:C', '@type': 'amep:Exchange', actor: ac(hum, 'prov:Person', 'H'),
  act: { '@id': 'urn:act:all:compose', '@type': 'amep:ProtocolAct', actType: 'amep:Compose', actor: hum, expectedHead: hA, operands, operator: 'union', createdAt: now, proof: p(hum) } });
check('4. Compose (server-computed deterministic merge of 2 heads) → 201 + conforms', rC._s === 201 && await conforms(rC._b), `(${rC._s}${rC._s >= 400 ? ' ' + rC._b.slice(0, 200) : ''})`);
const cDoc: any = yaml.load(rC._b);
const hC = cDoc.head;
check('   composed memory is SERVER-computed (merges BOTH operand bodies)',
  /Alpha claim/.test(cDoc.memory?.semantic?.body || '') && /Beta counter-claim/.test(cDoc.memory?.semantic?.body || ''));
// Determinism: the validator (an independent party) recomputes semanticCid over
// the composed semantic and it matches — proving the merge is verifiable, not
// trusted. (conforms() above already asserts this.)
check('   composed act carries the 2 sorted operand HEADS (provenance)',
  Array.isArray(cDoc.act?.operands) && cDoc.act.operands.length === 2 && cDoc.act.operands.every((o: string) => /\/amep\/heads\//.test(o)));
// Both merged heads are now CLOSED. Probe: an Assert targeting the consumed
// sibling head hB must be rejected (stale CAS) — proving Compose closed it.
const rStale = await post({ '@context': [CTX], '@id': 'urn:exchange:all:stale', '@type': 'amep:Exchange', actor: ac(A, 'prov:SoftwareAgent', 'A'), act: { '@id': 'urn:act:all:stale', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: A, expectedHead: hB, createdAt: now, proof: p(A) }, memory: mem('urn:memory:all:stale', 'late', A) });
check('   consumed operand head hB rejects further acts (merge closed it)', rStale._s === 409 || rStale._s === 412, `(${rStale._s})`);

// 5. Accept the composed candidate → Committed.
const rAcc = await post({ '@context': [CTX], '@id': 'urn:exchange:all:acc', '@type': 'amep:Exchange', actor: ac(hum, 'prov:Person', 'H'), act: { '@id': 'urn:act:all:accept', '@type': 'amep:ProtocolAct', actType: 'amep:Accept', actor: hum, expectedHead: hC, acceptedAct: 'urn:act:all:compose', createdAt: now, proof: p(hum) } });
check('5. Accept composed → 201 + Committed + conforms', rAcc._s === 201 && (yaml.load(rAcc._b) as any).memory?.governanceStatus === 'amep:Committed' && await conforms(rAcc._b), `(${rAcc._s}${rAcc._s >= 400 ? ' ' + rAcc._b.slice(0, 160) : ''})`);
const hCommitted = (yaml.load(rAcc._b) as any).head;

// 6. Fork the committed head → a named Candidate branch.
const mF = 'urn:memory:all:F';
const rF = await post({ '@context': [CTX], '@id': 'urn:exchange:all:F', '@type': 'amep:Exchange', actor: ac(A, 'prov:SoftwareAgent', 'A'), act: { '@id': 'urn:act:all:fork', '@type': 'amep:ProtocolAct', actType: 'amep:Fork', actor: A, expectedHead: hCommitted, parentHead: hCommitted, branch: 'what-if-monday', createdAt: now, proof: p(A) }, memory: mem(mF, 'What if we shipped Monday instead.', A) });
check('6. Fork (branch) → 201 + Candidate + conforms', rF._s === 201 && (yaml.load(rF._b) as any).memory?.governanceStatus === 'amep:Candidate' && await conforms(rF._b), `(${rF._s}${rF._s >= 400 ? ' ' + rF._b.slice(0, 160) : ''})`);

console.log(`\n${ok}/${ok + bad} checks passed — all six acts exercised`);
process.exit(bad === 0 ? 0 : 1);
