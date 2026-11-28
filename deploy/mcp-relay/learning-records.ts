/** Workbench OAuth grant. It is not a general MCP/pod grant. */
import { createHmac } from 'node:crypto';
import type { RequestHandler } from 'express';

export const LEARNING_RECORDS_SCOPE = 'foxxi:xapi:self:read';
export const LEARNING_RECORDS_PATH = '/learning-records/statements';
export const FOXXI_SESSION_READ_PATH = '/internal/learning-records/statements';

export interface LearningRecordsConfig {
  redirect: URL;
  resource: URL;
  bridge: URL;
  secret: string;
}
export function learningRecordsConfig(env: NodeJS.ProcessEnv): LearningRecordsConfig | undefined {
  try {
    const { INTEREGO_LEARNING_RECORDS_REDIRECT, PUBLIC_BASE_URL, FOXXI_BRIDGE_URL, FOXXI_RELAY_TRUST_SECRET } = env;
    if (!INTEREGO_LEARNING_RECORDS_REDIRECT || !PUBLIC_BASE_URL || !FOXXI_BRIDGE_URL || !FOXXI_RELAY_TRUST_SECRET || FOXXI_RELAY_TRUST_SECRET.length < 32) return;
    const redirect = new URL(INTEREGO_LEARNING_RECORDS_REDIRECT);
    const resource = new URL(LEARNING_RECORDS_PATH, PUBLIC_BASE_URL);
    const bridge = new URL(FOXXI_SESSION_READ_PATH, FOXXI_BRIDGE_URL);
    if (redirect.hash || redirect.search || [redirect, resource, bridge].some(u => u.protocol !== 'https:' || u.username || u.password)) return;
    return { redirect, resource, bridge, secret: FOXXI_RELAY_TRUST_SECRET };
  } catch { return; }
}

type Grant = { scopes: string[]; resource?: URL; extra?: Record<string, unknown> };
export function learningRecordsReader(
  config: LearningRecordsConfig,
  verify: (token: string) => Promise<Grant>,
  send = fetch,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refuse = (status: number, error: string) => { res.status(status).json({ error }); };
    if (req.get('origin') !== config.redirect.origin) { refuse(403, 'invalid_workbench_origin'); return; }
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.get('authorization') ?? '')?.[1];
    if (!token) { refuse(401, 'interego_sign_in_required'); return; }
    let grant: Grant;
    try { grant = await verify(token); } catch { refuse(401, 'interego_sign_in_required'); return; }
    const extra = grant.extra;
    if (grant.scopes.length !== 1 || grant.scopes[0] !== LEARNING_RECORDS_SCOPE ||
        grant.resource?.href !== config.resource.href || !extra || extra.cnf || extra.provisionalPlay ||
        typeof extra.userId !== 'string' || typeof extra.podUrl !== 'string') {
      refuse(403, 'own_learning_records_grant_required'); return;
    }
    if (!req.is('application/json') || !req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 ||
        !req.body.query || Array.isArray(req.body.query) || typeof req.body.query !== 'object') {
      refuse(400, 'expected_learning_records_query'); return;
    }
    const body = JSON.stringify({ time: Date.now(), user: extra.userId, pod: extra.podUrl, query: req.body.query });
    if (Buffer.byteLength(body) > 8192) { refuse(413, 'query_too_large'); return; }
    const proof = createHmac('sha256', config.secret).update('foxxi-xapi-self-read-v1\n').update(body).digest('hex');
    try {
      const upstream = await send(config.bridge, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), body,
        headers: { 'Content-Type': 'application/json', 'X-Interego-Learning-Read': proof },
      });
      if (![200, 400, 403, 404, 429, 503].includes(upstream.status)) { refuse(503, 'learning_records_unavailable'); return; }
      res.status(upstream.status).json(await upstream.json());
    } catch { refuse(503, 'learning_records_unavailable'); }
  };
}
