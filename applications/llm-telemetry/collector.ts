import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { CaptureError } from './capture.js';
export interface CollectorGrant { observer: string; id: string; hash: string; source: 'claude-code-otel' | 'claude-cowork-otel'; account_id?: string; mode: 'live' | 'validation'; expires_at: string; revoked: boolean }
export interface CollectorStore { load(): Promise<unknown[] | null>; persist(grant: CollectorGrant): Promise<boolean> }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const collectorResource = (actor: string) => `llm-collectors-${hash(actor).slice(0,32)}`;
function parseToken(token: string): { actor: string; id: string } {
  if (!/^iet1\.[A-Za-z0-9_-]{1,1024}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new CaptureError(401, 'Invalid collector credential');
  const parts = token.split('.'); const actor = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  if (!/^did:web:identity\.interego\.xwisee\.com:agents:[A-Za-z0-9_-]{1,160}$/.test(actor)) throw new CaptureError(401, 'Invalid collector observer');
  return { actor, id: parts[2]! };
}
export function collectorActor(token: string): string { return parseToken(token).actor; }
async function grants(store: CollectorStore, actor: string): Promise<CollectorGrant[]> {
  const records = await store.load();
  if (!records) throw new CaptureError(503, 'Collector registry unavailable');
  return records.map(value => {
    const r = value as CollectorGrant;
    if (!r || r.observer !== actor || !/^[a-f0-9]{32}$/.test(r.id) || !/^[a-f0-9]{64}$/.test(r.hash) || !['claude-code-otel', 'claude-cowork-otel'].includes(r.source) || !['live','validation'].includes(r.mode) || typeof r.revoked !== 'boolean' || !Number.isFinite(Date.parse(r.expires_at))) throw new CaptureError(503, 'Invalid collector registry');
    return r;
  });
}
export async function issueCollector(actor: string, mode: unknown, store: CollectorStore, now = Date.now(), source: unknown = 'claude-code-otel', accountId?: unknown) {
  if (!['claude-code-otel', 'claude-cowork-otel'].includes(String(source))) throw new CaptureError(400, 'Unsupported collector source');
  if (source === 'claude-cowork-otel' && (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(accountId))) throw new CaptureError(400, 'Cowork requires your exact user.account_uuid to exclude other users');
  if (mode !== 'live' && mode !== 'validation') throw new CaptureError(400, 'Choose live or validation capture mode');
  const old = await grants(store, actor);
  const revoked = new Set(old.filter(r => r.revoked).map(r => r.id));
  if (new Set(old.filter(r => !revoked.has(r.id) && Date.parse(r.expires_at) > now).map(r => r.id)).size >= 20) throw new CaptureError(409, 'Collector credential limit reached');
  const id = randomBytes(16).toString('hex'); const token = `iet1.${Buffer.from(actor).toString('base64url')}.${id}.${randomBytes(32).toString('base64url')}`;
  parseToken(token);
  const grant: CollectorGrant = { observer: actor, id, hash: hash(token), source: source as CollectorGrant['source'], ...(source === 'claude-cowork-otel' ? { account_id: accountId as string } : {}), mode, expires_at: new Date(now + (mode === 'validation' ? 3600000 : 30 * 86400000)).toISOString(), revoked: false };
  if (!await store.persist(grant)) throw new CaptureError(502, 'Collector credential persistence unconfirmed');
  await verifyCollector(token, store, now);
  return { token, collector_id: id, expires_at: grant.expires_at, source: grant.source, mode };
}
export async function verifyCollector(token: string, store: CollectorStore, now = Date.now()): Promise<CollectorGrant> {
  const { actor, id } = parseToken(token); const records = (await grants(store, actor)).filter(r => r.id === id);
  const r = records[0];
  if (!r || records.some(v => v.revoked || v.hash !== r.hash || v.mode !== r.mode || v.source !== r.source || v.account_id !== r.account_id || v.expires_at !== r.expires_at) || Date.parse(r.expires_at) <= now || !timingSafeEqual(Buffer.from(r.hash, 'hex'), Buffer.from(hash(token), 'hex'))) throw new CaptureError(401, 'Expired, revoked or invalid collector credential');
  return r;
}
export async function revokeCollector(actor: string, id: unknown, store: CollectorStore) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new CaptureError(400, 'Invalid collector ID');
  const records = (await grants(store, actor)).filter(r => r.id === id); const r = records[0];
  if (!r) throw new CaptureError(404, 'Unknown collector');
  if (!records.some(v => v.revoked) && !await store.persist({ ...r, revoked: true })) throw new CaptureError(502, 'Revocation unconfirmed');
  if (!(await grants(store, actor)).some(v => v.id === id && v.revoked)) throw new CaptureError(502, 'Revocation readback unconfirmed');
  return { ok: true, collector_id: id, revoked: true };
}
