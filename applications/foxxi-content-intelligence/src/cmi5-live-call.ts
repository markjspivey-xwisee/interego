/**
 * A live voice call for a launched activity, asked for by the activity itself.
 *
 * Some activities are a conversation held by voice with a speech model: the learner speaks and the
 * model answers aloud. The model, and what it is told about who it is playing, belong to a practice
 * service, which also holds the key for the speech service. A unit in a browser holds only its cmi5
 * credential, which this LMS issued and only this LMS can check.
 *
 * So the unit asks here, with that credential, and the LMS asks the practice service, signing with
 * its own key: `POST /cmi5/live-call`. The LMS vouches for what only it knows (the credential is one
 * it issued, for this registration, and the session it belongs to is open and was launched Normal);
 * the practice service decides everything else and answers with what the unit needs to place the
 * call, or with why not. This is the footing `GET /cmi5/reviewed` stands on, for the other half of
 * the same kind of activity.
 *
 * Nothing here names a practice service, a speech service, a course or a profile: where to ask, on
 * which pod and for which action are settings. No audio passes through this LMS, and it keeps
 * nothing of a call.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import express from 'express';
import { sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import type { ReviewedSession } from './cmi5-reviewed.js';

export interface LiveCallAnswer { readonly status: number; readonly body: unknown }
export interface LiveCallQuestion { readonly registration: string; readonly sessionId: string; readonly scenarioIri: string; readonly scenarioVersion: number }

export interface LiveCallDeps {
  /** The session a cmi5 auth-token was issued for (never another session of its registration), or null for a token this LMS did not issue. */
  session(token: string): ReviewedSession | null;
  /** Ask the practice service. Absent when this deployment has none configured. */
  ask?: (q: LiveCallQuestion) => Promise<LiveCallAnswer>;
  limiter: RequestHandler;
}

export interface LiveCallServiceSettings {
  /** The practice service's act that opens a call for a registration (a POST target). */
  readonly url: string;
  /** The pod the practice service keeps its records on. */
  readonly podUrl: string;
  /** The action IRI that act is signed for. */
  readonly action: string;
  /** This LMS's own signing key. Its address is the principal the practice service registered. */
  readonly wallet: Wallet;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly timeoutMs?: number;
}

const ANSWER_MAX_BYTES = 200_000;
const SCENARIO_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]{1,190}$/;

/** The text of an answer of at most `max` bytes, or null for a longer one; a longer one is not buffered. */
async function textWithin(res: globalThis.Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    seen += value.byteLength;
    if (seen > max) { await reader.cancel().catch(() => undefined); return null; }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * The request the LMS signs: a signed-request envelope (`_signed_payload`, `_signature`: EIP-191
 * over `sha256:` and the hex sha256 of the exact payload JSON), by the LMS's own key.
 */
export async function signedLiveCallRequest(
  s: Pick<LiveCallServiceSettings, 'wallet' | 'podUrl' | 'action'>, q: LiveCallQuestion, at: string, nonce: string,
): Promise<{ _signed_payload: string; _signature: string }> {
  const payload = JSON.stringify({
    agent_id: `did:ethr:${s.wallet.address}`, v: 1, action: s.action, timestamp: at, nonce, pod_url: s.podUrl,
    scenarioIri: q.scenarioIri, scenarioVersion: q.scenarioVersion, registration: q.registration, sessionId: q.sessionId,
  });
  return { _signed_payload: payload, _signature: await signMessageRaw(s.wallet, `sha256:${sha256Hex(payload)}`) };
}

/** `ask` for a configured practice service. */
export function liveCallServiceAsk(s: LiveCallServiceSettings): NonNullable<LiveCallDeps['ask']> {
  const f = s.fetch ?? fetch;
  let n = 0;
  return async (q) => {
    const now = (s.now ?? (() => new Date()))();
    const nonce = s.nonce ? s.nonce() : `lms-call-${now.getTime().toString(36)}-${(++n).toString(36)}-${sha256Hex(`${q.registration}|${q.sessionId}|${now.getTime()}|${n}`).slice(0, 16)}`;
    const body = await signedLiveCallRequest(s, q, now.toISOString(), nonce);
    const res = await f(s.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(s.timeoutMs ?? 30_000),
    });
    const text = await textWithin(res, ANSWER_MAX_BYTES);
    if (text === null) return { status: 502, body: null };
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* answered below as unusable */ }
    return { status: res.status, body: parsed };
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/**
 * What of the practice service's `call` is passed to the unit: the fields a unit uses to place the
 * call and to say what the learner is talking to, each of the type and size expected, and nothing
 * else. null when a field the call cannot be placed without is missing or is not what it should be.
 */
function callForUnit(call: unknown): Record<string, unknown> | null {
  if (!isObj(call)) return null;
  const connect = isObj(call['connect']) ? call['connect'] : {};
  const credential = isObj(call['credential']) ? call['credential'] : {};
  const url = text(connect['url'], 500), dataChannel = text(connect['dataChannel'], 100);
  const value = text(credential['value'], 4000), expiresAt = text(credential['expiresAt'], 40);
  let https = false;
  try { https = url !== undefined && new URL(url).protocol === 'https:'; } catch { https = false; }
  if (!https || dataChannel === undefined || value === undefined || expiresAt === undefined || Number.isNaN(Date.parse(expiresAt))) return null;
  const turnLimit = call['turnLimit'];
  return {
    connect: { url, dataChannel }, credential: { value, expiresAt },
    ...Object.fromEntries((['provider', 'model', 'voice', 'transcriptionModel', 'language', 'promptTemplateHash'] as const)
      .map((k) => [k, text(call[k], 200)] as const).filter(([, v]) => v !== undefined)),
    ...(text(call['counterpartName'], 200) !== undefined ? { counterpartName: text(call['counterpartName'], 200) } : {}),
    ...(text(call['firstLine'], 2000) !== undefined ? { firstLine: text(call['firstLine'], 2000) } : {}),
    ...(typeof turnLimit === 'number' && Number.isInteger(turnLimit) && turnLimit > 0 && turnLimit <= 200 ? { turnLimit } : {}),
  };
}

/** What the unit is told when no call was opened: the practice service's reason code and its retry time, bounded, and no other field of its answer. */
function refusalOf(body: unknown): { reason?: string; retryAfterSeconds?: number } {
  if (!isObj(body)) return {};
  const reason = body['iep:refusalReason'];
  const retry = body['retryAfterSeconds'];
  return {
    ...(typeof reason === 'string' ? { reason: reason.slice(0, 200) } : {}),
    ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 && retry <= 86_400 ? { retryAfterSeconds: Math.ceil(retry) } : {}),
  };
}

export function attachLiveCallRoute(app: Express, deps: LiveCallDeps): void {
  app.post('/cmi5/live-call', deps.limiter, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const token = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const session = token ? deps.session(token) : null;
    if (!session) { res.status(401).json({ error: 'cmi5_credential_required', note: 'Send the cmi5 auth-token this LMS issued for the session, as a Bearer credential.' }); return; }
    if (!deps.ask) { res.status(501).json({ error: 'no_voice_service', note: 'This LMS is not set up to ask a practice service for a live call.' }); return; }
    // The LMS answers for what only it knows; anything else is the practice service's to decide.
    if (session.superseded) { res.status(409).json({ error: 'credential_of_an_earlier_session', note: 'This credential was issued for an earlier session of the registration. Use the credential of the session that is open now.' }); return; }
    if (session.closed) { res.status(409).json({ error: 'session_ended', note: 'This session has ended; a call cannot be held in it. Launch again to open a new session of the registration.' }); return; }
    // A call is a conversation that will be recorded and judged: only a Normal launch records a result.
    if (session.launchMode !== 'Normal') { res.status(409).json({ error: 'not_a_normal_launch', note: 'A live call is recorded and judged, which cmi5 allows only in a Normal launch.' }); return; }
    // Which scenario the unit plays is the unit's to say; whether there is such a scenario, and what its other person is like, is the practice service's.
    const b = isObj(req.body) ? req.body : {};
    const scenarioIri = b['scenarioIri'], scenarioVersion = b['scenarioVersion'];
    if (typeof scenarioIri !== 'string' || !SCENARIO_IRI.test(scenarioIri) || typeof scenarioVersion !== 'number' || !Number.isInteger(scenarioVersion) || scenarioVersion < 1 || scenarioVersion > 1_000_000) {
      res.status(400).json({ error: 'scenario_required', note: 'Send {scenarioIri, scenarioVersion}: the scenario version this unit plays, as the practice service names it.' });
      return;
    }
    let answer: LiveCallAnswer;
    try { answer = await deps.ask({ registration: session.registration, sessionId: session.sessionId, scenarioIri, scenarioVersion }); }
    catch { res.status(502).json({ error: 'practice_service_unreachable' }); return; }
    const body = answer.body;
    if (answer.status === 200 && isObj(body) && body['kind'] !== 'refusal') {
      const call = callForUnit(body['call']);
      if (call === null) { res.status(502).json({ error: 'practice_service_answer_unusable' }); return; }
      res.json({
        kind: 'cmi5-live-call', registration: session.registration, sessionId: session.sessionId, call,
        ...(text(body['disclosure'], 2000) !== undefined ? { disclosure: text(body['disclosure'], 2000) } : {}),
        note: 'Place the call with call.connect and call.credential before it expires. Write each exchange to the LRS with this session\'s credential, and end the session when the call ends.',
      });
      return;
    }
    // No call: the unit holds none, and says why in its own words.
    if (answer.status === 429) { res.status(429).json({ error: 'too_many_calls', ...refusalOf(body) }); return; }
    if (answer.status === 501) { res.status(501).json({ error: 'no_voice_service', ...refusalOf(body) }); return; }
    if (answer.status === 404 || answer.status === 409) { res.status(409).json({ error: 'no_call_for_this_registration', ...refusalOf(body) }); return; }
    res.status(502).json({ error: 'practice_service_refused', serviceStatus: answer.status, ...refusalOf(body) });
  });
}
