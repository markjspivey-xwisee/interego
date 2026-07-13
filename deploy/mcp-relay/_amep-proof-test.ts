// Genuine session-bound AMEP proofs — the security gate. Proves that the
// relay-attestation model yields integrityStatus: Verified ONLY for a real
// relay signature over the exact act, and fails CLOSED to Unverified for every
// forgery/tamper/replay: placeholder proof, different content, different actor,
// a client's own key, and survives a YAML round-trip.
import { makeWalletDelegationSigner, makeWalletDelegationVerifier, importWallet } from '@interego/core';
import { Wallet as EthersWallet } from 'ethers';
import yaml from 'js-yaml';
import { stampAmepProof, amepAuthPayload } from './amep-session-bridge.js';

// importWallet registers the private key in the in-process signing registry
// (the same path ensureRelayComplianceWallet uses), so makeWalletDelegationSigner
// can sign with it. Two distinct wallets: the relay (trusted) and a client (attacker).
const relayWallet = importWallet(EthersWallet.createRandom().privateKey, 'agent', 'relay-test');
const clientWallet = importWallet(EthersWallet.createRandom().privateKey, 'agent', 'client-test');
const relaySign = makeWalletDelegationSigner(relayWallet);
const clientSign = makeWalletDelegationSigner(clientWallet);
const verifier = makeWalletDelegationVerifier();

const wrap = (s: ReturnType<typeof makeWalletDelegationSigner>) =>
  async (p: string) => { const { signature, verificationMethod } = await s(p); return { signature, verificationMethod }; };

// The engine's verify path: recover from (payload, proofValue), require the
// RELAY's own wallet address (unforgeable by any other key).
const verify = async (canonical: string, proof: Record<string, unknown>): Promise<boolean> => {
  const pv = proof['proofValue'], vm = proof['verificationMethod'];
  if (typeof pv !== 'string' || typeof vm !== 'string') return false;
  const block = { type: 'EcdsaSecp256k1Signature2019' as const, created: String(proof['created'] ?? ''), proofPurpose: 'assertionMethod' as const, verificationMethod: vm, proofValue: pv, signerAddress: relayWallet.address };
  try { return await verifier(canonical, block as never); } catch { return false; }
};

const PUBLIC = 'https://relay.interego.xwisee.com';
const TARGET = `${PUBLIC}/amep/acts`;
const mkAct = () => ({
  '@context': ['https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld'],
  '@type': 'amep:Exchange',
  actor: { '@id': 'did:key:z6MkActor', '@type': 'prov:SoftwareAgent' },
  act: { '@id': 'urn:act:demo:1', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: 'did:key:z6MkActor', expectedHead: 'https://relay.interego.xwisee.com/amep/heads/x/h1', createdAt: '2026-07-13T00:00:00Z' },
  memory: { '@id': 'urn:m:demo:1', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body: 'A genuine claim.', epistemicStatus: 'iep:Asserted' } },
});
type Act = ReturnType<typeof mkAct>;
const canonicalOf = (o: Act) => amepAuthPayload(o.act as Record<string, unknown>, (o as Record<string, unknown>)['memory']);

let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

// 1. valid relay-signed act → Verified
const signed = await stampAmepProof(mkAct(), TARGET, { signer: wrap(relaySign), publicBaseUrl: PUBLIC }) as Act;
check('relay-signed proof was stamped', !!signed.act['proof'] && (signed.act['proof'] as Record<string, unknown>)['proofValue'] !== 'z');
check('1. valid relay-signed proof VERIFIES (→ integrityStatus Verified)', await verify(canonicalOf(signed), signed.act['proof'] as Record<string, unknown>));

// 2. placeholder proof → Unverified
check('2. placeholder proofValue "z" does NOT verify', !(await verify(canonicalOf(signed), { '@type': 'iep:SignedAuthorship', verificationMethod: 'did:key:zx#k', created: '2026-07-13T00:00:00Z', proofValue: 'z' })));

// 3. tampered CONTENT (memory changed after signing) → Unverified
const tContent = JSON.parse(JSON.stringify(signed)) as Act; (tContent.memory.semantic as Record<string, unknown>)['body'] = 'A DIFFERENT claim.';
check('3. proof over DIFFERENT content does NOT verify (content binding)', !(await verify(canonicalOf(tContent), tContent.act['proof'] as Record<string, unknown>)));

// 4. tampered ACTOR → Unverified
const tActor = JSON.parse(JSON.stringify(signed)) as Act; (tActor.act as Record<string, unknown>)['actor'] = 'did:key:z6MkEVIL';
check('4. proof over DIFFERENT actor does NOT verify (identity binding)', !(await verify(canonicalOf(tActor), tActor.act['proof'] as Record<string, unknown>)));

// 5. tampered LINEAGE (expectedHead) → Unverified
const tHead = JSON.parse(JSON.stringify(signed)) as Act; (tHead.act as Record<string, unknown>)['expectedHead'] = 'https://relay.interego.xwisee.com/amep/heads/x/EVIL';
check('5. proof over DIFFERENT expectedHead does NOT verify (lineage binding)', !(await verify(canonicalOf(tHead), tHead.act['proof'] as Record<string, unknown>)));

// 6. CLIENT-signed proof (different wallet) → Unverified against the relay address
const clientSigned = await stampAmepProof(mkAct(), TARGET, { signer: wrap(clientSign), publicBaseUrl: PUBLIC }) as Act;
check('6. a CLIENT-signed proof does NOT verify against the relay (unforgeable Verified)', !(await verify(canonicalOf(clientSigned), clientSigned.act['proof'] as Record<string, unknown>)));

// 7. non-/amep target → no proof stamped (no-op; would never claim Verified)
const nonAmep = await stampAmepProof(mkAct(), 'https://foxxi.example/capability', { signer: wrap(relaySign), publicBaseUrl: PUBLIC }) as Act;
check('7. non-/amep target: no proof stamped (no-op)', !nonAmep.act['proof']);

// 8. YAML round-trip: sign → dump → load → still Verified (serialization robustness)
const signed2 = await stampAmepProof(mkAct(), TARGET, { signer: wrap(relaySign), publicBaseUrl: PUBLIC }) as Act;
const rt = yaml.load(yaml.dump(signed2)) as Act;
check('8. proof survives a YAML round-trip (Verified across serialization)', await verify(canonicalOf(rt), rt.act['proof'] as Record<string, unknown>));

// ── Engine integration: mount AMEP with the verifier, POST a stamped act, and
//    confirm the SERVED memory is integrityStatus: amep:Verified (end to end). ──
const { mountAmep } = await import('./amep.js');
const store = new Map<string, { body: string; etag: string }>();
let etagN = 0;
const cssFetch = async (url: string, init: Record<string, unknown> = {}): Promise<unknown> => {
  const m = String((init['method'] as string) ?? 'GET').toUpperCase();
  const cur = store.get(url);
  const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  if (m === 'GET') return cur ? { ok: true, status: 200, statusText: 'OK', headers: H({ etag: cur.etag }), text: async () => cur.body, json: async () => JSON.parse(cur.body) } : { ok: false, status: 404, statusText: 'NF', headers: H({}), text: async () => '', json: async () => ({}) };
  if (m === 'PUT') {
    const hdrs = (init['headers'] as Record<string, string>) ?? {};
    const im = hdrs['If-Match']; const inm = hdrs['If-None-Match'];
    if (inm === '*' && cur) return { ok: false, status: 412, headers: H({}), statusText: 'x', text: async () => '', json: async () => ({}) };
    if (im && (!cur || cur.etag !== im)) return { ok: false, status: 412, headers: H({}), statusText: 'x', text: async () => '', json: async () => ({}) };
    const etag = `"e${++etagN}"`; store.set(url, { body: String(init['body']), etag });
    return { ok: true, status: cur ? 205 : 201, statusText: 'OK', headers: H({ etag }), text: async () => '', json: async () => ({}) };
  }
  return { ok: false, status: 405, statusText: 'x', headers: H({}), text: async () => '', json: async () => ({}) };
};
const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
const fakeApp = { get: (p: string, ...h: unknown[]) => { routes[`GET ${p}`] = h[h.length - 1] as never; }, post: (p: string, ...h: unknown[]) => { routes[`POST ${p}`] = h[h.length - 1] as never; } };
const OP = 'amep-proof-operator-secret-00000';
mountAmep(fakeApp as never, {
  solidFetch: cssFetch as never, withPodMutex: async (_k: string, fn: () => Promise<unknown>) => fn(),
  introspect: () => null, cssUrl: 'http://css.local/', maintainerPod: 'maintainer',
  publicBase: PUBLIC, actSecret: OP, verifyActProof: verify, log: () => {},
} as never);
const mkRes = () => ({ _s: 200, _b: '', status(c: number) { this._s = c; return this; }, type() { return this; }, setHeader() {}, send(b: string) { this._b = b; return this; } });
async function postAct(obj: unknown) { const res = mkRes(); await routes['POST /amep/acts']({ headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/affordance+yaml' }, body: yaml.dump(obj), query: {} } as never, res as never); return res; }

const CTX = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1/context.jsonld';
const DID = 'did:key:z6MkProofActor';
const askAct = { '@context': [CTX], '@id': 'urn:ex:pf:ask', '@type': 'amep:Exchange', actor: { '@id': DID, '@type': 'prov:SoftwareAgent', displayName: 'P' }, act: { '@id': 'urn:act:pf:ask', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: DID, createdAt: '2026-07-13T00:00:00Z' } };
const askSigned = await stampAmepProof(askAct, TARGET, { signer: wrap(relaySign), publicBaseUrl: PUBLIC });
const rAsk = await postAct(askSigned);
const hAsk = (yaml.load(rAsk._b) as { head: string }).head;
check('9. engine: stamped Ask applied (201)', rAsk._s === 201, String(rAsk._s));

const assertAct = { '@context': [CTX], '@id': 'urn:ex:pf:a', '@type': 'amep:Exchange', actor: { '@id': DID, '@type': 'prov:SoftwareAgent', displayName: 'P' }, act: { '@id': 'urn:act:pf:assert', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: DID, expectedHead: hAsk, createdAt: '2026-07-13T00:00:01Z' }, memory: { '@id': 'urn:m:pf:a', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body: 'A relay-attested claim.', epistemicStatus: 'iep:Asserted', attributedTo: DID } } };
const assertSigned = await stampAmepProof(assertAct, TARGET, { signer: wrap(relaySign), publicBaseUrl: PUBLIC });
const rA = await postAct(assertSigned);
const served = yaml.load(rA._b) as { memory?: { integrityStatus?: string } };
check('10. engine: relay-signed Assert → served memory is integrityStatus amep:Verified', rA._s === 201 && served.memory?.integrityStatus === 'amep:Verified', `${rA._s} ${served.memory?.integrityStatus}`);

// A placeholder-proof Assert on a fresh exchange stays Unverified through the engine.
const askAct2 = { '@context': [CTX], '@id': 'urn:ex:pf:ask2', '@type': 'amep:Exchange', actor: { '@id': DID, '@type': 'prov:SoftwareAgent', displayName: 'P' }, act: { '@id': 'urn:act:pf:ask2', '@type': 'amep:ProtocolAct', actType: 'amep:Ask', actor: DID, createdAt: '2026-07-13T00:00:02Z', proof: { '@type': 'iep:SignedAuthorship', verificationMethod: 'did:key:zx#k', created: '2026-07-13T00:00:02Z', proofValue: 'z' } } };
const rAsk2 = await postAct(askAct2);
const hAsk2 = (yaml.load(rAsk2._b) as { head: string }).head;
const assertAct2 = { '@context': [CTX], '@id': 'urn:ex:pf:a2', '@type': 'amep:Exchange', actor: { '@id': DID, '@type': 'prov:SoftwareAgent', displayName: 'P' }, act: { '@id': 'urn:act:pf:assert2', '@type': 'amep:ProtocolAct', actType: 'amep:Assert', actor: DID, expectedHead: hAsk2, createdAt: '2026-07-13T00:00:03Z', proof: { '@type': 'iep:SignedAuthorship', verificationMethod: 'did:key:zx#k', created: '2026-07-13T00:00:03Z', proofValue: 'z' } }, memory: { '@id': 'urn:m:pf:a2', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'], memoryKind: 'amep:Claim', semantic: { '@type': 'amep:SemanticMaterial', body: 'A placeholder-proof claim.', epistemicStatus: 'iep:Asserted', attributedTo: DID } } };
const rA2 = await postAct(assertAct2);
const served2 = yaml.load(rA2._b) as { memory?: { integrityStatus?: string } };
check('11. engine: placeholder-proof Assert stays amep:Unverified (honest)', rA2._s === 201 && served2.memory?.integrityStatus === 'amep:Unverified', `${rA2._s} ${served2.memory?.integrityStatus}`);

console.log(`\n${ok}/${ok + bad} AMEP-proof security checks passed`);
process.exit(bad === 0 ? 0 : 1);
