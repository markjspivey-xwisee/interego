/** Read-only relay handoff for the primary Interego account, never the app's agent. */
import { createHmac, timingSafeEqual } from 'node:crypto';

const hex = /^[0-9a-f]{64}$/;
function mac(secret: string, purpose: string, raw: string): string {
  return createHmac('sha256', secret).update(purpose).update('\n').update(raw).digest('hex');
}
function exactProof(proof: unknown, expected: string): boolean {
  return typeof proof === 'string' && hex.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
}
export function verifySessionRead(body: unknown, proof: unknown, config: {
  secret?: string; ownStore: (pod: string) => boolean; tenantPod: string; now?: number;
}): { user: string; pod: string; query: Record<string, unknown> } | null {
  const { secret } = config;
  if (!secret || secret.length < 32 || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw) > 8192 || !exactProof(proof, mac(secret, 'interego-account-self-records-v1', raw))) return null;
  const { time, user, pod, query } = body as Record<string, unknown>;
  if (Object.keys(body).length !== 4 || typeof time !== 'number' || !Number.isSafeInteger(time) || Math.abs((config.now ?? Date.now()) - time) > 30_000 ||
    typeof user !== 'string' || !/^u-(?:pk|eth|did)-[a-z0-9-]{1,100}$/.test(user) ||
    typeof pod !== 'string' || !query || typeof query !== 'object' || Array.isArray(query)) return null;
  try {
    const u = new URL(pod);
    if (u.username || u.password || u.search || u.hash || !['https:', 'http:'].includes(u.protocol) ||
      u.pathname !== '/' + user + '/' || !config.ownStore(u.href) || new URL(config.tenantPod).pathname === u.pathname) return null;
    return { user, pod: u.href, query: query as Record<string, unknown> };
  } catch { return null; }
}

const cursorProof = (secret: string, user: string, cursor: string) => mac(secret, 'interego-account-self-records-cursor-v1', user + '\n' + cursor);
export function scopedCursor(secret: string, user: string, raw: string): string {
  return raw + '.' + cursorProof(secret, user, raw);
}
export function verifyScopedCursor(secret: string, user: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 6000) return null;
  const i = value.lastIndexOf('.');
  if (i <= 0) return null;
  const raw = value.slice(0, i);
  return exactProof(value.slice(i + 1), cursorProof(secret, user, raw)) ? raw : null;
}
