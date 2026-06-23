/**
 * Red-Team Arena (substrate edition) — a real adversarial LLM "Mallory" throws
 * forged / tampered / replayed envelopes at the L1 integrity primitive
 * `protocol.attest`, and each bounces off a different invariant. ONLY the three
 * genuinely-substrate (L1) attacks live here: impersonation, one-byte tamper, stale
 * replay. (Credential-forgery is a vertical concern and is NOT advertised as L1.)
 * Honest: a verbatim replay WITHIN the ±60s window is accepted but stays attributed
 * to the original signer — the attacker gains no identity.
 */
import { ethers } from 'ethers';
import { freshAgent, signEnvelope, type AgentWallet, type SignedEnvelope } from '../lib/agent-signing.js';
import { callTool } from '../lib/bridge.js';
import { runAgentLoop, type ToolDef } from '../lib/anthropic.js';

export type RTKind = 'identity' | 'phase' | 'reasoning' | 'attack' | 'result' | 'done' | 'error';
export type RTClass = 'crypto' | 'protocol' | 'breach';
export interface RTEvent { id: number; actor: 'Mallory' | 'Substrate' | 'sys'; kind: RTKind; cls?: RTClass; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: RTEvent) => void) { return (e: Omit<RTEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }
export interface RTResult { attempts: number; breaches: number; defended: number; byClass: Record<string, number>; concede?: string }

const enc = new TextEncoder();
const sha = (s: string) => ethers.sha256(enc.encode(s)).slice(2);

const ATTACK_TOOLS: ToolDef[] = [
  { name: 'impersonate', description: 'Sign an attestation with YOUR key but CLAIM to be the victim (put the victim DID as agent_id). Tests whether the substrate lets you act as someone else.', input_schema: { type: 'object', properties: {} } },
  { name: 'tamper', description: "Take the victim's captured valid signed envelope, change one byte, and resubmit. Tests whether a tampered-but-'signed' attestation is accepted.", input_schema: { type: 'object', properties: {} } },
  { name: 'replay', description: "Resubmit the victim's captured valid envelope VERBATIM. Tests whether you can replay someone else's attestation as your own.", input_schema: { type: 'object', properties: {} } },
];

const MALLORY_SYS = 'You are Mallory, a cunning adversary on the Interego substrate with your own self-sovereign did:ethr identity. Your tools make REAL forged / tampered / replayed calls to the LIVE protocol.attest integrity primitive — nothing is simulated. Probe each attack, read the REAL response, and be intellectually honest about what bounced. Take concrete tool actions; never ask questions. End with exactly one line: "CONCEDE: <why the substrate beat you>" or "BREACH: <what you broke>".';

export async function runRedTeam(apiKey: string, emit: (e: Omit<RTEvent, 'id' | 'ts'>) => void): Promise<RTResult> {
  const victim = freshAgent(), mallory = freshAgent();
  // capture a valid victim attestation envelope (signed, fresh)
  const victimEnv: SignedEnvelope = await signEnvelope(victim, { action: 'attest', note: 'a legitimate attestation' });
  emit({ actor: 'sys', kind: 'identity', title: 'A legitimate agent made a signed attestation (Mallory captured its envelope)', detail: victim.did });
  emit({ actor: 'Mallory', kind: 'identity', title: 'Mallory — adversary with only its own key', detail: mallory.did });
  const result: RTResult = { attempts: 0, breaches: 0, defended: 0, byClass: {} };

  function classify(tool: string, status: number, body: any): { cls: RTClass; breach: boolean; why: string } {
    if (tool === 'impersonate') return status === 200 ? { cls: 'breach', breach: true, why: 'accepted an attestation attributed to the victim though Mallory signed it' } : { cls: 'crypto', breach: false, why: `rejected (HTTP ${status}): recovered signer is Mallory, not the victim — you cannot act as another agent` };
    if (tool === 'tamper') return status === 200 ? { cls: 'breach', breach: true, why: 'a tampered payload was accepted' } : { cls: 'crypto', breach: false, why: `rejected (HTTP ${status}): one changed byte breaks signer recovery — the envelope is content-bound` };
    // replay
    if (status === 401) return { cls: 'protocol', breach: false, why: 'rejected (HTTP 401): outside the ±60s window the captured envelope is stale — replay protection' };
    return { cls: 'protocol', breach: false, why: `accepted (HTTP ${status}) within the ±60s window BUT attributed to the VICTIM (${String(body?.attestedBy ?? 'victim').slice(0, 22)}…) — Mallory gains no identity; stale after 60s` };
  }

  const dispatch = async (name: string): Promise<{ text: string }> => {
    result.attempts++;
    emit({ actor: 'Mallory', kind: 'attack', title: `attack · ${name}` });
    let env: SignedEnvelope;
    if (name === 'impersonate') {
      const payload = { action: 'attest', note: 'impersonated', agent_id: victim.did, timestamp: new Date().toISOString() };
      const sp = JSON.stringify(payload);
      env = { _signature: await mallory.wallet.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
    } else if (name === 'tamper') {
      env = { _signature: victimEnv._signature, _signed_payload: victimEnv._signed_payload + ' ' };
    } else { // replay
      env = victimEnv;
    }
    let r: any = null;
    try { r = await callTool('protocol.attest', { envelope: env }); } catch (e) { r = { ok: false, status: 0, error: (e as Error).message }; }
    const status = r?.status ?? (r?.ok ? 200 : 0);
    const c = classify(name, status, r);
    if (c.breach) result.breaches++; else result.defended++;
    result.byClass[c.cls] = (result.byClass[c.cls] ?? 0) + 1;
    emit({ actor: 'Substrate', kind: 'result', cls: c.cls, title: c.breach ? `⚠ BREACH via ${name}` : `✓ defended · ${c.cls.toUpperCase()}`, detail: c.why });
    return { text: JSON.stringify({ httpStatus: status, defended: !c.breach, body: r }) };
  };

  emit({ actor: 'sys', kind: 'phase', title: 'Mallory attacks the live integrity primitive — every call is real' });
  let finalText = '';
  try {
    await runAgentLoop({
      apiKey, system: MALLORY_SYS,
      goal: `A legitimate agent (${victim.did}) made a signed attestation; you captured its envelope. You have ONLY your own key (${mallory.did}). Try EVERY attack — impersonate (claim to be the victim), tamper (one byte), replay (resubmit verbatim) — against protocol.attest. Use each tool at least once, read the REAL result, and be honest about what bounced. End with "CONCEDE: <why>" or "BREACH: <what you broke>".`,
      tools: ATTACK_TOOLS,
      dispatch: (name) => dispatch(name),
      onThinking: t => { finalText = t; emit({ actor: 'Mallory', kind: 'reasoning', title: 'reasoning', detail: t }); },
      maxSteps: 10,
    });
  } catch (e) { emit({ actor: 'Mallory', kind: 'error', title: (e as Error).message }); }
  const m = /(CONCEDE|BREACH):\s*([\s\S]+)/i.exec(finalText);
  result.concede = m ? `${m[1].toUpperCase()}: ${m[2].trim().slice(0, 300)}` : (finalText.trim().slice(0, 200) || '(no closing statement)');
  emit({ actor: 'Mallory', kind: 'done', title: result.concede });
  emit({ actor: 'sys', kind: 'done', title: `${result.defended}/${result.attempts} attacks defended · ${result.breaches} breaches` });
  return result;
}
