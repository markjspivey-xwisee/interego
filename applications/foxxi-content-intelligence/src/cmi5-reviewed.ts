/**
 * The reviewed statements of a launched activity, for the activity itself to send.
 *
 * Some activities are judged after the session: a practice conversation, say, whose result a person
 * reviews. cmi5 gives passed, failed and completed to the assignable unit to send, so such a unit
 * ends its first session without them, and sends them in a later session of the same registration
 * once the review stands. The review lives in another service. A unit in a browser holds only its
 * cmi5 credential, which this LMS issued and only this LMS can check.
 *
 * So the unit asks here, with that credential, and the LMS asks the review service, signing with its
 * own key: `GET /cmi5/reviewed`. The LMS vouches for what only it knows (the credential is one it
 * issued, for this registration, and the session it belongs to is open and was launched Normal);
 * the review service decides everything else and answers with the documents, or with why not.
 *
 * Nothing here names a review service, a course or a profile: where to ask, on which pod and for
 * which action are settings. The LMS writes none of these statements itself.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { sha256Hex, signMessageRaw, type Wallet } from '@interego/core';

/** The session a cmi5 credential belongs to, as the LMS holds it. */
export interface ReviewedSession {
  readonly registration: string;
  readonly sessionId: string;
  readonly launchMode: 'Normal' | 'Browse' | 'Review';
  /** True once the session was terminated, abandoned or waived, or the registration has a later session. */
  readonly closed: boolean;
  /** True when the registration has moved on to a later session than the one this credential is for. */
  readonly superseded: boolean;
}

export interface ReviewAnswer { readonly status: number; readonly body: unknown }

export interface ReviewedStatementsDeps {
  /** The session a cmi5 auth-token was issued for (never another session of its registration), or null for a token this LMS did not issue. */
  session(token: string): ReviewedSession | null;
  /** Ask the review service. Absent when this deployment has none configured. */
  ask?: (q: { registration: string; sessionId: string }) => Promise<ReviewAnswer>;
  limiter: RequestHandler;
}

export interface ReviewServiceSettings {
  /** The review service's act that hands out a registration's reviewed statements (a POST target). */
  readonly url: string;
  /** The pod the review service keeps its records on. */
  readonly podUrl: string;
  /** The action IRI that act is signed for. */
  readonly action: string;
  /** This LMS's own signing key. Its address is the principal the review service registered. */
  readonly wallet: Wallet;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly timeoutMs?: number;
}

const ANSWER_MAX_BYTES = 1_000_000;

/**
 * The text of an answer of at most `max` bytes, or null for a longer one. The count is of bytes as
 * they arrive, not of the decoded string, and the read stops at the first chunk that passes the
 * limit: the rest is cancelled, not buffered. An answer that declares a longer length is not read.
 */
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
export async function signedReviewRequest(
  s: Pick<ReviewServiceSettings, 'wallet' | 'podUrl' | 'action'>, q: { registration: string; sessionId: string }, at: string, nonce: string,
): Promise<{ _signed_payload: string; _signature: string }> {
  const payload = JSON.stringify({
    agent_id: `did:ethr:${s.wallet.address}`, v: 1, action: s.action, timestamp: at, nonce, pod_url: s.podUrl,
    registration: q.registration, sessionId: q.sessionId,
  });
  return { _signed_payload: payload, _signature: await signMessageRaw(s.wallet, `sha256:${sha256Hex(payload)}`) };
}

/** `ask` for a configured review service. */
export function reviewServiceAsk(s: ReviewServiceSettings): NonNullable<ReviewedStatementsDeps['ask']> {
  const f = s.fetch ?? fetch;
  let n = 0;
  return async (q) => {
    const now = (s.now ?? (() => new Date()))();
    const nonce = s.nonce ? s.nonce() : `lms-${now.getTime().toString(36)}-${(++n).toString(36)}-${sha256Hex(`${q.registration}|${q.sessionId}|${now.getTime()}|${n}`).slice(0, 16)}`;
    const body = await signedReviewRequest(s, q, now.toISOString(), nonce);
    const res = await f(s.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(s.timeoutMs ?? 20_000),
    });
    const text = await textWithin(res, ANSWER_MAX_BYTES);
    if (text === null) return { status: 502, body: null };
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* answered below as unusable */ }
    return { status: res.status, body: parsed };
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the unit is told when the review service has nothing to hand out, without passing its words through whole. */
function refusalOf(body: unknown): { reason?: string; problems?: string[] } {
  if (!isObj(body)) return {};
  const reason = body['iep:refusalReason'];
  const problems = body['problems'];
  return {
    ...(typeof reason === 'string' ? { reason: reason.slice(0, 200) } : {}),
    ...(Array.isArray(problems) ? { problems: problems.filter((p): p is string => typeof p === 'string').slice(0, 20).map((p) => p.slice(0, 400)) } : {}),
  };
}

export function attachReviewedStatementsRoute(app: Express, deps: ReviewedStatementsDeps): void {
  app.get('/cmi5/reviewed', deps.limiter, async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const token = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const session = token ? deps.session(token) : null;
    if (!session) { res.status(401).json({ error: 'cmi5_credential_required', note: 'Send the cmi5 auth-token this LMS issued for the session, as a Bearer credential.' }); return; }
    if (!deps.ask) { res.status(501).json({ error: 'no_review_service', note: 'This LMS is not set up to ask a review service.' }); return; }
    // The LMS answers for what only it knows; anything else is the review service's to decide.
    // A credential speaks for the session it was issued in. One from an earlier session of the registration is not asked about the current one.
    if (session.superseded) { res.status(409).json({ error: 'credential_of_an_earlier_session', note: 'This credential was issued for an earlier session of the registration. Use the credential of the session that is open now.' }); return; }
    if (session.closed) { res.status(409).json({ error: 'session_ended', note: 'This session has ended; a statement cannot be sent in it. Launch again to open a new session of the registration.' }); return; }
    if (session.launchMode !== 'Normal') { res.status(409).json({ error: 'not_a_normal_launch', note: 'cmi5 allows passed, failed and completed only in a Normal launch.' }); return; }
    let answer: ReviewAnswer;
    try { answer = await deps.ask({ registration: session.registration, sessionId: session.sessionId }); }
    catch { res.status(502).json({ error: 'review_service_unreachable' }); return; }
    const body = answer.body;
    if (answer.status === 200 && isObj(body) && body['kind'] !== 'refusal' && Array.isArray(body['statements'])) {
      res.json({
        kind: 'cmi5-reviewed-statements', registration: session.registration, sessionId: session.sessionId,
        statements: body['statements'],
        // False when they were fixed earlier for another session: then they are for comparing with what the LRS holds, not for sending.
        usableInSession: body['usableInSession'] === true,
        ...(typeof body['usableOnlyIn'] === 'string' ? { usableOnlyIn: body['usableOnlyIn'] } : {}),
        note: body['usableInSession'] === true
          ? 'Send these in this order, in this session, with this credential. If the LRS answers that a statement with one of these ids already exists, read it back and compare: only an equal one is this result recorded.'
          : 'Do not send these. They were fixed for another session of the registration and are here only to compare with what the LRS already holds.',
      });
      return;
    }
    // Not taken, not reviewed yet, or not buildable: the unit sends nothing and may ask again later.
    if (answer.status === 404 || answer.status === 409) {
      res.status(409).json({ error: answer.status === 404 ? 'registration_not_under_review' : 'no_reviewed_statements', ...refusalOf(body) });
      return;
    }
    res.status(502).json({ error: 'review_service_refused', reviewStatus: answer.status, ...refusalOf(body) });
  });
}
