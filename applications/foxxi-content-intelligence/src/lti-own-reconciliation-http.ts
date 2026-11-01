/** Signed transport for an explicitly reviewed, new own-account recovery entry. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Options } from 'express-rate-limit';
import type { OwnSubjectXapiAuthority } from './own-subject-xapi-auth.js';
import { canonicalRecoveryJson, OwnLtiReconciliationError, type RecoveryPreview, type RecoveryReadResult, type RecoveryApplyResult } from './lti-own-reconciliation.js';

export type RecoveryOperation = 'preview' | 'apply' | 'read';
interface RecoveryWorkflow {
  preview(input: unknown): Promise<RecoveryPreview>;
  apply(input: unknown): Promise<RecoveryApplyResult>;
  read(entryId: string): Promise<RecoveryReadResult>;
}
type Refusal = { ok: false; status: number; error: string };
export interface RecoveryHttpPorts {
  verify(body: unknown, write: boolean): Promise<OwnSubjectXapiAuthority | Refusal>;
  compose(authority: OwnSubjectXapiAuthority, readOnly: boolean): RecoveryWorkflow;
  allow(key: string, limit: number): boolean;
}

/** Construct the two standard limiters ONCE and mount total, then client on all
 * three recovery routes. Total admission bounds distinct client-store keys;
 * MemoryStore expires its rotating windows. The library's default IP key uses
 * Express's existing trust policy and IPv6 /56, never a raw forwarded header.
 * These are additional pre-authentication limits; subject and active-work guards
 * remain in the signed handler. This factory never changes Express proxy trust. */
export function ownLtiReconciliationRateLimitOptions(): { total: Partial<Options>; client: Partial<Options> } {
  const exceeded: RequestHandler = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(429).json({ error: 'reconciliation_rate_limited' });
  };
  return {
    total: { windowMs: 60000, limit: 300, keyGenerator: () => 'own-lti-reconciliation',
      identifier: 'own-lti-reconciliation-total', standardHeaders: 'draft-8', legacyHeaders: false, handler: exceeded },
    client: { windowMs: 60000, limit: 120, ipv6Subnet: 56,
      identifier: 'own-lti-reconciliation-client', standardHeaders: 'draft-8', legacyHeaders: false, handler: exceeded },
  };
}
const TRANSPORT = new Set(['subject_did', 'purpose', 'subject_pod_url', 'timestamp', 'agent_id']);
const unavailable = () => new OwnLtiReconciliationError('attestation-unavailable', 503);

/** Domain-separated integrity under the existing stable service key; not a public signature. */
export function createRecoveryAttestation(privateKey: string) {
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey) || /^0+$/.test(privateKey.replace(/^0x/, ''))) throw unavailable();
  const key = createHmac('sha256', Buffer.from(privateKey.replace(/^0x/, ''), 'hex'))
    .update('foxxi/own-lti-reconciliation/private-attestation/v1').digest();
  const mac = (body: string) => createHmac('sha256', key).update(body).digest();
  return {
    attest(claims: Record<string, unknown>): string {
      const body = Buffer.from(canonicalRecoveryJson(claims), 'utf8').toString('base64url');
      return `${body}.${mac(body).toString('base64url')}`;
    },
    verify(token: string): unknown {
      if (typeof token !== 'string' || token.length > 400_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
      const [body, signature] = token.split('.');
      const actual = Buffer.from(signature!, 'base64url');
      if (actual.toString('base64url') !== signature || !timingSafeEqual(mac(body!), actual)) throw unavailable();
      let value: unknown;
      try { value = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')); } catch { throw unavailable(); }
      if (Buffer.from(canonicalRecoveryJson(value), 'utf8').toString('base64url') !== body) throw unavailable();
      return value;
    },
  };
}

export function ownLtiReconciliationHandler(operation: RecoveryOperation, ports: RecoveryHttpPorts): RequestHandler {
  let active = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!ports.allow(`recovery:ip:${req.ip ?? 'unknown'}`, 120)) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'reconciliation_rate_limited' }); return; }
      if (typeof req.body?._signed_payload !== 'string' || Buffer.byteLength(req.body._signed_payload, 'utf8') > 262144) { res.status(400).json({ error: 'invalid_signed_reconciliation' }); return; }
      if (active >= 8) { res.setHeader('Retry-After', '2'); res.status(429).json({ error: 'reconciliation_busy' }); return; }
      active++;
      try {
        const authority = await ports.verify(req.body, operation === 'apply');
        if (!authority.ok) { res.status(authority.status).json({ error: 'reconciliation_authority_unverified' }); return; }
        if (!ports.allow(`recovery:subject:${authority.subjectDid}`, 30)) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'reconciliation_rate_limited' }); return; }
        const input = Object.fromEntries(Object.entries(authority.payload).filter(([key]) => !TRANSPORT.has(key)));
        const workflow = ports.compose(authority, operation !== 'apply');
        let result;
        if (operation === 'preview') result = await workflow.preview(input);
        else if (operation === 'apply') result = await workflow.apply(input);
        else {
          if (Object.keys(input).length !== 1 || typeof input.entryId !== 'string' || !/^[a-f0-9]{64}$/.test(input.entryId)) throw new OwnLtiReconciliationError('invalid-input', 400);
          result = await workflow.read(input.entryId);
        }
        res.json(result);
      } finally { active--; }
    } catch (error) {
      const known = error instanceof OwnLtiReconciliationError;
      const declared = error instanceof Error && 'status' in error ? error.status : undefined;
      const status = known ? error.status : typeof declared === 'number' && [400, 403, 409, 413, 429, 503].includes(declared) ? declared : error instanceof Error && error.name === 'ConflictError' ? 409 : 503;
      res.status(status).json({ error: known ? `reconciliation_${error.code}` : 'reconciliation_unconfirmed', confirmed: false });
    }
  };
}
