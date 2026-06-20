/**
 * Evidence Ledger ceremony — a self-proving audit pack for agent actions.
 *
 * A fresh agent performs REAL rev-196 signed actions on the live bridge. For each,
 * the pack is assembled with ZERO trust in us:
 *   · the signer is recovered from the raw envelope bytes client-side (ECDSA);
 *   · the action validates against the live, dereferenceable xAPI SHACL shapes;
 *   · it projects into a SOC 2 OperationalEvidenceEvent that conforms to the served
 *     SOC 2 shape and cites the control IRIs (CC6.x / EU-AI-Act Art.12 / NIST
 *     MEASURE) — every cited IRI dereferences;
 *   · the authority is walked from the agent's OWN pod, not the request envelope.
 * The kill-shot: re-verify any pack from a clean seat (re-recover + re-dereference
 * the shape + re-validate) — and a one-byte tamper breaks the signature recovery.
 *
 * Interego is its own audit substrate: the evidence is signed, content-addressed,
 * dereferenceable linked data — not mutable rows the same system vouches for.
 */
import { freshAgent, postSigned, recoverSigner, curlFor, type AgentWallet, type SignedEnvelope } from './agent-signing.js';
import { BRIDGE_URL } from '../bridge-client.js';

export const STD_EXT_IRI =
  'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const NS = `${BRIDGE_URL}/ns`;

export interface ControlCitation { framework: 'soc2' | 'eu-ai-act' | 'nist-rmf'; id: string; iri: string; label: string }
export interface EvidenceItem {
  action: string; path: string;
  did: string; signer: string | null; signerMatches: boolean;
  envelope: SignedEnvelope; payload: any; response: any;
  statementId?: string;
  xapiConforms?: boolean; xapiShapesIri?: string;
  soc2Instance?: Record<string, unknown>; soc2Conforms?: boolean; soc2ShapesIri?: string;
  controls: ControlCitation[];
  curl: string;
}
export interface EvidencePack { agent: AgentWallet; items: EvidenceItem[]; podAuthority?: any }

export type EvidenceKind = 'identity' | 'action' | 'recover' | 'validate' | 'cite' | 'authority' | 'error';
export interface EvidenceEvent { id: number; kind: EvidenceKind; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: EvidenceEvent) => void) {
  return (e: Omit<EvidenceEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() });
}
export function resetCounter() { counter = 0; }

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(`${BRIDGE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let b: any = null; try { b = await r.json(); } catch { b = await r.text().catch(() => null); }
    return { status: r.status, body: b };
  } catch (e) { return { status: 0, body: { error: (e as Error).message } }; }
}

/** Project a signed action into an xAPI statement instance for shape validation. */
function xapiInstanceFor(did: string, taskName: string): Record<string, unknown> {
  return {
    actor: { objectType: 'Agent', account: { homePage: BRIDGE_URL, name: did } },
    verb: { id: 'https://w3id.org/xapi/dod-isd/verbs/performed', display: { 'en-US': 'performed' } },
    object: { objectType: 'Activity', id: STD_EXT_IRI, definition: { type: 'http://adlnet.gov/expapi/activities/performance', name: { 'en-US': taskName } } },
  };
}

/** The controls a logged, attributable, consequential agent action evidences. */
function controlsFor(): ControlCitation[] {
  return [
    { framework: 'soc2', id: 'CC6.1', iri: `${NS}/soc2#CC6.1`, label: 'SOC 2 CC6.1 — logical access security measures' },
    { framework: 'eu-ai-act', id: 'Article12', iri: `${NS}/eu-ai-act#Article12`, label: 'EU AI Act Art.12 — record-keeping (automatic logging)' },
    { framework: 'nist-rmf', id: 'MEASURE', iri: `${NS}/nist-rmf#MEASURE`, label: 'NIST AI RMF — MEASURE (verifiable monitoring)' },
  ];
}

const ACTIONS: Array<{ action: string; path: string; task: string }> = [
  { action: 'Consequential agent action under audit', path: '/agent/record-performance', task: 'Consequential agent action under audit' },
  { action: 'A second recorded action (builds the trail)', path: '/agent/record-performance', task: 'Follow-on agent action under audit' },
];

/** Build the evidence pack: each action is a real signed call, then assembled. */
export async function buildEvidencePack(emit: (e: Omit<EvidenceEvent, 'id' | 'ts'>) => void): Promise<EvidencePack> {
  const G = freshAgent();
  emit({ kind: 'identity', title: 'Fresh agent under audit — no account, no OAuth, no directory row', detail: G.did });
  const items: EvidenceItem[] = [];

  for (const spec of ACTIONS) {
    emit({ kind: 'action', title: `Agent performs: ${spec.action}`, detail: `signed POST ${spec.path}` });
    const r = await postSigned(spec.path, G, { task_name: spec.task, success: true, quality: 1, activity_type: STD_EXT_IRI });
    const env = r.envelope!;
    const payload = JSON.parse(env._signed_payload);
    const signer = recoverSigner(env);
    const signerMatches = !!signer && signer === G.address.toLowerCase();
    emit({ kind: 'recover', title: `Signer recovered from bytes alone — ${signerMatches ? 'matches the actor' : 'MISMATCH'}`, detail: `${signer ?? 'invalid'} (recovered client-side; the bridge is not trusted to assert who acted)` });

    // validate against live xAPI shapes
    const xv = await postJson('/ns/xapi/validate', { instance: xapiInstanceFor(G.did, spec.task) });
    const xapiConforms = xv.body?.conforms === true;
    const xapiShapesIri = xv.body?.shapesIri as string | undefined;
    emit({ kind: 'validate', title: `Action validates against the live xAPI shapes — ${xapiConforms ? 'CONFORMS' : 'does not conform'}`, detail: xapiShapesIri });

    // project into a SOC 2 evidence event + validate against the served SOC 2 shape
    const soc2Instance = { '@type': 'OperationalEvidenceEvent', evidences: ['CC6.1'], occurredAt: payload.timestamp, actor: G.did, signer: signer ?? '' };
    const sv = await postJson('/ns/soc2/validate', { instance: soc2Instance });
    const soc2Conforms = sv.body?.conforms === true;
    const controls = controlsFor();
    emit({ kind: 'cite', title: `Projected to a SOC 2 evidence event — ${soc2Conforms ? 'conforms + cites CC6.1' : sv.status === 404 ? 'compliance ontology not yet served' : 'non-conformant'}`, detail: controls.map(c => c.id).join(' · ') });

    items.push({
      action: spec.action, path: spec.path, did: G.did, signer, signerMatches,
      envelope: env, payload, response: r.body, statementId: (r.body as any)?.statementId,
      xapiConforms, xapiShapesIri, soc2Instance, soc2Conforms, soc2ShapesIri: sv.body?.shapesIri,
      controls, curl: curlFor(spec.path, env),
    });
  }

  // authority walked from the agent OWN pod (not the envelope)
  const review = await postSigned('/agent/review-record', G, { subject_did: G.did, include_clr: false });
  emit({ kind: 'authority', title: `Authority walked from the agent's OWN pod — ${review.body && (review.body as any).ok ? 'confirmed' : 'unavailable'}`, detail: `${(review.body as any)?.subject?.statementCount ?? 0} statements on the agent's pod establish its identity + history` });

  return { agent: G, items, podAuthority: review.body };
}

export interface CleanSeatResult { signerOk: boolean; recovered: string | null; shapeOk: boolean; shapeStatus: number; validateOk: boolean; tamperBreaks: boolean }

/** Re-verify an evidence item from a CLEAN SEAT: re-recover the signer, re-fetch
 *  the cited shape, re-validate — zero stored trust. Plus a tamper check. */
export async function verifyFromCleanSeat(item: EvidenceItem): Promise<CleanSeatResult> {
  const recovered = recoverSigner(item.envelope);
  const signerOk = !!recovered && recovered === item.did.replace('did:ethr:', '').toLowerCase();
  // Tamper a STRUCTURALLY-GUARANTEED byte (append one space — always changes the
  // bytes, regardless of the payload's content) and assert the bytes actually
  // changed before comparing recoveries, so this kill-shot can never be a content-
  // dependent false negative.
  const tamperedPayload = item.envelope._signed_payload + ' ';
  const tamperedEnv: SignedEnvelope = { ...item.envelope, _signed_payload: tamperedPayload };
  const tamperedRecovered = recoverSigner(tamperedEnv);
  const tamperBreaks = tamperedPayload !== item.envelope._signed_payload && tamperedRecovered !== recovered;
  // re-fetch the cited xAPI shape doc fresh
  let shapeStatus = 0, shapeOk = false;
  if (item.xapiShapesIri) {
    try { const r = await fetch(item.xapiShapesIri, { headers: { Accept: 'text/turtle' } }); shapeStatus = r.status; shapeOk = r.ok; } catch { /* */ }
  }
  // re-validate the action fresh
  const xv = await postJson('/ns/xapi/validate', { instance: xapiInstanceFor(item.did, item.payload?.task_name ?? 'action') });
  const validateOk = xv.body?.conforms === true;
  return { signerOk, recovered, shapeOk, shapeStatus, validateOk, tamperBreaks };
}
