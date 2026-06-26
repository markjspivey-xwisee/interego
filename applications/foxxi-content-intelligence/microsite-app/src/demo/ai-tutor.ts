/**
 * AI tutor → VERIFIABLE xAPI — the Foxxi (L&D) instantiation of the emergent
 * AI-in-eLearning profile.
 *
 * A real AI tutor and a real learner (both BYOK LLM agents) run a micro-session;
 * the tutor's evaluation is recorded as an xAPI statement that carries the profile's
 * verifiable layer, then:
 *   1. the verifiable record is VALIDATED against the live /ns/ai-elearning shapes
 *      (and the self-asserted version is shown being REJECTED), and
 *   2. the signed xAPI statement is LANDED in the live Foxxi LRS and read back.
 *
 * Layering: this is the VERTICAL composing the substrate. The page calls the Foxxi
 * bridge (validate + LRS) AND the substrate interego-bridge (content-address a source,
 * attest the model, prove the confidence range) — a vertical may compose substrate
 * primitives; the substrate never calls an L&D route. The emergence of the vocabulary
 * itself lives on the substrate demo (/profile); here we USE the ratified profile.
 *
 * HONEST: signing proves who recorded it + that it was not altered, not that the
 * feedback is correct; the content-addressed citation resolves to exact bytes, not to
 * a real-world work; the confidence threshold proof shows the value cleared the bar
 * (revealing only the gap above — a hash-chain proof, not ZK/Pedersen), not a
 * calibration against ground truth.
 */
import { ethers } from 'ethers';
import { BRIDGE_URL as FOXXI_BRIDGE } from '../bridge-client.js';
import { deriveUserWallet, mintSessionToken } from '../session-token.js';

const SUBSTRATE_BRIDGE =
  (import.meta.env.VITE_INTEREGO_BRIDGE_URL as string | undefined) ??
  'https://interego-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SUBSTRATE_MICROSITE =
  (import.meta.env.VITE_INTEREGO_MICROSITE_URL as string | undefined) ??
  'https://interego-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const NS = `${FOXXI_BRIDGE}/ns/ai-elearning#`;
const MODEL = 'claude-opus-4-8';

export type AtKind = 'phase' | 'tutor' | 'learner' | 'sign' | 'atom' | 'attest' | 'prove' | 'validate' | 'land' | 'link' | 'done' | 'error';
export interface AtEvent { id: number; actor: string; kind: AtKind; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: AtEvent) => void) { return (e: Omit<AtEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }
type Emit = (e: Omit<AtEvent, 'id' | 'ts'>) => void;

export interface AtResult {
  topic: string; question: string; answer: string; feedback: string;
  confidence: number; citation: string;
  verifiable: { signer: string; sourceAtom?: string; attestedBy?: string; proofOk?: boolean };
  validVerifiable?: { conforms: boolean; violations: number };
  validSelfAsserted?: { conforms: boolean; violations: number; paths: string[] };
  statement: Record<string, unknown>;
  landed?: { stored: boolean; statementId?: string; readBack: boolean; status: number };
  substrateDemo: string;
}

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
function signEnvelope(wallet: ethers.Wallet, args: Record<string, unknown>): Promise<{ _signature: string; _signed_payload: string; did: string }> {
  const did = `did:ethr:${wallet.address.toLowerCase()}`;
  const _signed_payload = JSON.stringify({ ...args, agent_id: did, timestamp: new Date().toISOString() });
  return wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`).then(_signature => ({ _signature, _signed_payload, did }));
}

async function oneShot(apiKey: string, prompt: string, maxTokens = 400): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => '')).slice(0, 180)}`);
  const j = await r.json();
  return (j.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text?: string }) => b.text ?? '').join('').trim();
}

async function sub(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SUBSTRATE_BRIDGE}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const t = j.result?.content?.[0]?.text;
  return t ? JSON.parse(t) : j.result;
}

async function validate(instance: Record<string, unknown>): Promise<{ conforms: boolean; results: Array<{ path: string }> }> {
  const r = await fetch(`${FOXXI_BRIDGE}/ns/ai-elearning/validate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance }),
  });
  const j = await r.json();
  return { conforms: !!j.conforms, results: j.results ?? [] };
}

export async function runAiTutor(apiKey: string, emit: Emit, topic = 'spaced retrieval practice'): Promise<AtResult> {
  // 1 — a real AI tutor poses a question; a real learner answers; the tutor evaluates.
  emit({ actor: 'sys', kind: 'phase', title: `A real AI tutor and learner run a micro-session on "${topic}"` });
  const question = (await oneShot(apiKey, `You are an AI tutor. Ask ONE focused, open-ended question that checks a learner's understanding of "${topic}". Output ONLY the question.`)).split('\n')[0].slice(0, 400);
  emit({ actor: 'AI tutor', kind: 'tutor', title: 'poses a question', detail: question });

  const answer = (await oneShot(apiKey, `You are a learner being tutored on "${topic}". Answer this question in 2-3 sentences, with a plausible but slightly incomplete understanding:\n"${question}"\nOutput ONLY your answer.`)).slice(0, 600);
  emit({ actor: 'Learner', kind: 'learner', title: 'answers', detail: answer });

  const evalRaw = await oneShot(apiKey, `You are the AI tutor. Evaluate the learner's answer to "${question}".\nLearner answer: "${answer}"\nReply in EXACTLY this format:\nFEEDBACK: <one or two sentences of specific feedback>\nCONFIDENCE: <your confidence in this evaluation as a decimal 0..1>\nSOURCE: <one specific citation you grounded the evaluation in — author, year, title, locator>`, 500);
  const feedback = (/FEEDBACK:\s*([\s\S]*?)(?:\nCONFIDENCE:|$)/i.exec(evalRaw)?.[1] ?? evalRaw).trim().slice(0, 600);
  const confidence = Math.max(0, Math.min(1, parseFloat(/CONFIDENCE:\s*([0-9.]+)/i.exec(evalRaw)?.[1] ?? '0.8') || 0.8));
  const citation = (/SOURCE:\s*([\s\S]*)$/i.exec(evalRaw)?.[1] ?? 'Roediger & Karpicke (2006), "Test-enhanced learning", Psychological Science 17(3)').trim().split('\n')[0].slice(0, 240);
  emit({ actor: 'AI tutor', kind: 'tutor', title: `evaluates — self-reported confidence ${confidence}`, detail: feedback });
  emit({ actor: 'AI tutor', kind: 'tutor', title: 'cites a source', detail: citation });

  // 2 — build the verifiable layer (each a real call).
  emit({ actor: 'sys', kind: 'phase', title: 'the verifiable layer — sign · content-address · attest · prove' });
  const tutor = deriveUserWallet('foxxi-ai-tutor');
  const env = await signEnvelope(tutor, { kind: 'AiTutorEvaluation', question, answer, feedback, confidence });
  const signer = env.did;
  const signedEnvelope = JSON.stringify({ _signature: env._signature, _signed_payload: env._signed_payload });
  const recordedAt = JSON.parse(env._signed_payload).timestamp as string;
  emit({ actor: 'AI tutor', kind: 'sign', title: 'signs the evaluation (rev-196 envelope)', detail: signer });

  const verifiable: AtResult['verifiable'] = { signer };
  try { verifiable.sourceAtom = (await sub('protocol.pgsl_mint_atom', { value: citation })).atom_iri; emit({ actor: 'substrate', kind: 'atom', title: 'source → content-addressed atom', detail: verifiable.sourceAtom }); }
  catch (e) { emit({ actor: 'substrate', kind: 'error', title: `atom: ${(e as Error).message}` }); }
  try {
    const claimEnv = await signEnvelope(tutor, { kind: 'ModelAttestation', model: MODEL, provider: 'Anthropic' });
    const a = await sub('protocol.attest', { envelope: { _signature: claimEnv._signature, _signed_payload: claimEnv._signed_payload } });
    if (a?.ok) { verifiable.attestedBy = a.attestedBy; emit({ actor: 'substrate', kind: 'attest', title: `model/provider attested (${MODEL} · Anthropic)`, detail: a.attestedBy }); }
  } catch (e) { emit({ actor: 'substrate', kind: 'error', title: `attest: ${(e as Error).message}` }); }
  try {
    const threshold = 0.7;
    const p = await sub('protocol.zk_prove_confidence_above_threshold', { confidence, threshold });
    const v = await sub('protocol.zk_verify_confidence_proof', { proof: p.proof ?? p });
    verifiable.proofOk = !!(v?.ok ?? v?.valid);
    emit({ actor: 'substrate', kind: 'prove', title: `confidence threshold proof (≥ ${threshold})`, detail: verifiable.proofOk ? 'verified — reveals only the gap above, not the value' : 'unverified' });
  } catch (e) { emit({ actor: 'substrate', kind: 'error', title: `proof: ${(e as Error).message}` }); }

  // 3 — validate the verifiable record vs the SELF-ASSERTED one against the live profile.
  emit({ actor: 'sys', kind: 'phase', title: 'validate against the live /ns/ai-elearning profile' });
  const record = { '@type': 'SignedInteractionRecord', signedEnvelope, signer, recordedAt };
  const selfAsserted = { '@type': 'SignedInteractionRecord', assertedConfidence: confidence, model: MODEL, sources: [citation] };
  let validVerifiable: AtResult['validVerifiable']; let validSelfAsserted: AtResult['validSelfAsserted'];
  try {
    const v = await validate(record); validVerifiable = { conforms: v.conforms, violations: v.results.length };
    emit({ actor: 'Foxxi profile', kind: 'validate', title: v.conforms ? '✓ the SIGNED record CONFORMS' : `✗ signed record failed (${v.results.length})`, detail: 'SignedInteractionRecord' });
    const s = await validate(selfAsserted); validSelfAsserted = { conforms: s.conforms, violations: s.results.length, paths: [...new Set(s.results.map(r => r.path))] };
    emit({ actor: 'Foxxi profile', kind: 'validate', title: s.conforms ? 'self-asserted conforms (!)' : `✗ the SELF-ASSERTED record is REJECTED (${s.results.length})`, detail: `missing: ${validSelfAsserted.paths.join(', ')}` });
  } catch (e) { emit({ actor: 'Foxxi profile', kind: 'error', title: `validate: ${(e as Error).message}` }); }

  // 4 — build the conformant xAPI 2.0 statement carrying the verifiable layer as extensions.
  const statementId = (crypto as Crypto & { randomUUID(): string }).randomUUID();
  const statement: Record<string, unknown> = {
    id: statementId,
    actor: { objectType: 'Agent', name: 'Demo learner', account: { homePage: SUBSTRATE_MICROSITE, name: 'demo-learner' } },
    verb: { id: `${NS}answered-ai-question`, display: { 'en-US': 'answered AI question' } },
    object: { id: `urn:foxxi:ai-question:${statementId}`, definition: { type: `${NS}ai-question`, name: { 'en-US': 'AI-generated question' }, description: { 'en-US': question } } },
    result: { response: answer, extensions: { [`${NS}assertedConfidence`]: confidence } },
    context: { extensions: {
      [`${NS}signedEnvelope`]: signedEnvelope,
      [`${NS}signer`]: signer,
      ...(verifiable.sourceAtom ? { [`${NS}sourceAtom`]: verifiable.sourceAtom } : {}),
      ...(verifiable.attestedBy ? { [`${NS}attestedModel`]: { model: MODEL, provider: 'Anthropic', modelClaimSigner: verifiable.attestedBy } } : {}),
      [`${NS}confidenceProof`]: { confidenceThreshold: 0.7, proofVerified: !!verifiable.proofOk },
    } },
    timestamp: recordedAt,
    version: '2.0.0',
  };

  // 5 — LAND it in the live Foxxi LRS (self-minted session token → DEFAULT_TENANT) + read back.
  emit({ actor: 'sys', kind: 'phase', title: 'land the signed statement in the live Foxxi LRS' });
  let landed: AtResult['landed'];
  try {
    const token = await mintSessionToken({ userId: 'demo-learner', webId: `${SUBSTRATE_MICROSITE}/demo-learner#me` });
    const headers = { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'x-experience-api-version': '2.0.0' };
    const post = await fetch(`${FOXXI_BRIDGE}/xapi/statements`, { method: 'POST', headers, body: JSON.stringify(statement) });
    const stored = post.ok;
    emit({ actor: 'Foxxi LRS', kind: 'land', title: stored ? `stored statement ${statementId.slice(0, 8)}…` : `store rejected (${post.status})`, detail: stored ? undefined : (await post.text().catch(() => '')).slice(0, 160) });
    let readBack = false;
    if (stored) {
      const got = await fetch(`${FOXXI_BRIDGE}/xapi/statements?statementId=${statementId}`, { headers });
      const gj = await got.json().catch(() => ({}));
      readBack = (gj?.id === statementId) || (Array.isArray(gj?.statements) && gj.statements.some((s: { id?: string }) => s.id === statementId));
      emit({ actor: 'Foxxi LRS', kind: 'land', title: readBack ? 'read the statement back from the LRS — it landed' : 'stored, read-back inconclusive' });
    }
    landed = { stored, statementId, readBack, status: post.status };
  } catch (e) { emit({ actor: 'Foxxi LRS', kind: 'error', title: `land: ${(e as Error).message}` }); }

  emit({ actor: 'sys', kind: 'link', title: 'the vocabulary this used was emergently ratified on the substrate', detail: `${SUBSTRATE_MICROSITE}/profile` });
  emit({ actor: 'sys', kind: 'done', title: landed?.readBack ? 'a real AI-tutor interaction, recorded as verifiable xAPI, landed + read back' : 'verifiable record built + validated against the live profile' });

  return { topic, question, answer, feedback, confidence, citation, verifiable, validVerifiable, validSelfAsserted, statement, landed, substrateDemo: `${SUBSTRATE_MICROSITE}/profile` };
}
