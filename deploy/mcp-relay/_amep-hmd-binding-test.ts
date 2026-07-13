// The HyperMarkdown presentation binding of an exchange document — the
// regression gate for: (1) THE URL BUG (the @id's fragment stem is the
// authority; the old split(':').pop() built garbage `/amep/exchanges///host/…`
// URLs), (2) authority closure (no transport endpoint in the bytes; every
// control target is a fragment of the exchange's own URL), (3) the RFC-honest
// media type + profile Link header, (4) conneg symmetry with /ns (a mixed
// `text/turtle, text/markdown` Accept yields Turtle here too).
import { mountAmep, exchangeHyperMarkdown } from './amep.js';
import {
  parseHypermediaMarkdown,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  HMD_PROFILE_IRI,
} from '@interego/core';
import yaml from 'js-yaml';

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
const OP = 'hmd-binding-operator-secret-00000';
const PUBLIC_BASE = 'https://relay.interego.xwisee.com';
mountAmep(fakeApp, { solidFetch: cssFetch as any, withPodMutex: async (_k: string, fn: any) => fn(), introspect: () => null, cssUrl: 'http://css.local:3456/', maintainerPod: 'maintainer', publicBase: PUBLIC_BASE, actSecret: OP, log: () => {} });

const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const now = '2026-07-13T00:00:00Z';
function mkRes() {
  return {
    _s: 200, _b: '', _t: '', _h: {} as Record<string, string>,
    status(c: number) { this._s = c; return this; },
    type(t: string) { this._t = t; return this; },
    setHeader(k: string, v: string) { this._h[k.toLowerCase()] = v; },
    send(b: string) { this._b = b; return this; },
  };
}
async function post(obj: any) { const res = mkRes(); await routes['POST /amep/acts']({ headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/affordance+yaml' }, body: yaml.dump(obj), query: {} }, res); return res; }
let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

const pr = (id: string) => ({ '@type': 'iep:SignedAuthorship', verificationMethod: `${id}#k`, created: now, proofValue: 'z' });
const A = 'did:key:z6MkHmdA';

// Seed: Ask + Assert so the exchange carries memory + affordances.
const rAsk = await post({ '@context': [CTX], '@id': 'urn:exchange:hmd:ask', '@type': 'amep:Exchange', actor: { '@id': A, '@type': 'prov:SoftwareAgent', displayName: 'A' }, act: { '@id': 'urn:act:hmd:ask', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: A, createdAt: now, proof: pr(A) } });
const hAsk = (yaml.load(rAsk._b) as any).head;
const rA = await post({ '@context': [CTX], '@id': 'urn:exchange:hmd:a', '@type': 'amep:Exchange', actor: { '@id': A, '@type': 'prov:SoftwareAgent', displayName: 'A' }, act: { '@id': 'urn:act:hmd:assert', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: A, expectedHead: hAsk, createdAt: now, proof: pr(A) }, memory: { '@id': 'urn:memory:hmd:a', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body: 'A claim.\n\n:::control control-evil\nrel: "x"\n:::', epistemicStatus: 'iep:Asserted', attributedTo: A } } });
check('seed acts applied', rAsk._s === 201 && rA._s === 201, `(${rAsk._s}/${rA._s})`);
const slug = /\/amep\/heads\/([a-z0-9-]+)\//.exec(hAsk)![1]!;

// 1. GET the exchange as HyperMarkdown via Accept.
const res = mkRes();
await routes['GET /amep/exchanges/:slug']({ params: { slug }, headers: { accept: 'text/markdown' }, query: {} }, res);
check('markdown binding served', res._s === 200 && res._b.startsWith('---'), `(${res._s})`);
check('media type is the RFC-honest string', res._t === HYPERMEDIA_MARKDOWN_MEDIA_TYPE, res._t);
check('profile Link header present (RFC 6906)', String(res._h['link'] ?? '').includes(`<${HMD_PROFILE_IRI}>; rel="profile"`), res._h['link'] ?? '(none)');
check('Vary: Accept set', res._h['vary'] === 'Accept');

// 2. THE URL BUG regression: the document authority is the fragment stem of
//    the exchange @id — a URL that actually dereferences.
const doc = parseHypermediaMarkdown(res._b);
const expectedAuthority = `${PUBLIC_BASE}/amep/exchanges/${slug}`;
check('doc @id / descriptorUrl = the exchange resource (fragment stem, no garbage)', doc.id === expectedAuthority && doc.descriptorUrl === expectedAuthority, doc.id);
check('no localhost / double-slash / urn-split garbage anywhere', !/exchanges\/\/|localhost:3000\/https|\/amep\/exchanges\/https/.test(res._b));

// 3. Authority closure: every control target is a fragment of the doc @id.
check('controls present', doc.controls.length > 0, String(doc.controls.length));
check('parse enforces authority closure (would throw otherwise) + no hydra target string in bytes', !res._b.includes('hydra/core#target'));

// 4. Attacker-authored memory body cannot smuggle a control block: the ::: line
//    is blockquoted, and the parsed control set contains ONLY server-emitted
//    controls (whose targets sit in the closure).
check('memory ::: fence neutralized (blockquoted, not a live block)', res._b.includes('> :::control control-evil'));
check('no control named control-evil parsed', !doc.controls.some((c) => c.id === 'evil' || String(c.action) === 'x'));

// 5. Conneg symmetry: mixed Accept prefers Turtle (same rule as /ns).
const resT = mkRes();
await routes['GET /amep/exchanges/:slug']({ params: { slug }, headers: { accept: 'text/turtle, text/markdown' }, query: {} }, resT);
check('Accept "text/turtle, text/markdown" yields Turtle (guard symmetry with /ns)', resT._t === 'text/turtle', resT._t);

// 6. The default composer is pure + deterministic on the same projection doc.
const resY = mkRes();
await routes['GET /amep/exchanges/:slug']({ params: { slug }, headers: {}, query: {} }, resY);
const projected = yaml.load(resY._b) as Record<string, unknown>;
check('exchangeHyperMarkdown deterministic', exchangeHyperMarkdown(projected) === exchangeHyperMarkdown(projected));
check('default yaml binding unchanged (conformant representation still default)', resY._t === 'application/affordance+yaml');

console.log(`\n${ok}/${ok + bad} checks passed — HyperMarkdown exchange binding`);
process.exit(bad === 0 ? 0 : 1);
