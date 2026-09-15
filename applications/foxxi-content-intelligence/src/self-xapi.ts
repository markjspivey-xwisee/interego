/** Signed-agent adapter over the existing xAPI Statements Resource.
 * The adapter changes authentication/transport only. The LRS remains the validator,
 * immutable statement store, query engine and source of the returned statements.
 * A successful write additionally requires an awaited encrypted PGSL persistence.
 */
import { validateStatement } from './xapi-validate.js';

type Json = Record<string, unknown>;
export interface SelfXapiReply { status: number; body: unknown }
export interface SelfXapiDependencies {
  request(method: 'GET' | 'POST', query: URLSearchParams, body?: unknown): Promise<SelfXapiReply>;
  persist(statement: Json): Promise<{ persisted: boolean; descriptorUrl?: string; holonUri?: string } | null>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_KEYS = new Set(['statementId', 'verb', 'activity', 'registration', 'since', 'until', 'ascending', 'limit', 'cursor']);
const failure = (status: number, error: string): SelfXapiReply => ({ status, body: { ok: false, error } });

/** Bounded, self-attributed, JSON Activity statements. No attachment/voiding/substatement
 * transport is claimed here; those remain on the standard xAPI surface. Require ids and
 * timestamps so a caller can reconcile/retry the same write after a transport failure. */
export async function writeSelfXapi(callerDid: string, input: unknown, deps: SelfXapiDependencies): Promise<SelfXapiReply> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) return failure(400, 'statements must contain 1 to 20 xAPI Activity statements');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 131072) return failure(413, 'statement batch exceeds 128 KiB');
  const ids = new Set<string>();
  for (const value of input) {
    const errors = validateStatement(value);
    if (errors.length) return failure(400, errors.join('; '));
    const s = value as Json;
    const actor = s.actor as { objectType?: string; account?: { name?: string } };
    if (actor.objectType === 'Group' || actor.account?.name !== callerDid) return failure(403, 'every statement actor must be the authenticated agent (account.name = your DID)');
    if (typeof s.id !== 'string' || !UUID.test(s.id) || ids.has(s.id)) return failure(400, 'each statement requires a distinct UUID id');
    if (typeof s.timestamp !== 'string') return failure(400, 'each statement requires its observed timestamp');
    if (s.authority !== undefined || s.stored !== undefined) return failure(400, 'authority and stored are assigned by the LRS');
    if (s.attachments !== undefined || (s.object as Json).objectType && (s.object as Json).objectType !== 'Activity') return failure(400, 'this signed adapter accepts Activity statements without attachments; use the standard xAPI surface for other transports');
    ids.add(s.id);
  }
  const accepted = await deps.request('POST', new URLSearchParams(), input);
  if (accepted.status < 200 || accepted.status >= 300) return accepted;
  const receipts: Array<{ statementId: string; persisted: boolean; descriptorUrl?: string; holonUri?: string }> = [];
  // Read the actual LRS-enriched envelopes, never persist a caller-authored substitute.
  for (const id of ids) {
    const read = await deps.request('GET', new URLSearchParams({ statementId: id }));
    if (read.status !== 200 || !read.body || typeof read.body !== 'object' || (read.body as Json).id !== id) {
      return { status: 502, body: { ok: false, lrsAccepted: true, statementIds: [...ids], durable: false, error: 'LRS accepted the batch but read-back failed; reconcile these same ids before retrying' } };
    }
    let persisted: Awaited<ReturnType<SelfXapiDependencies['persist']>> = null;
    try { persisted = await deps.persist(read.body as Json); } catch { /* report partial commit below */ }
    receipts.push({ statementId: id, persisted: persisted?.persisted === true, ...(persisted?.descriptorUrl ? { descriptorUrl: persisted.descriptorUrl } : {}), ...(persisted?.holonUri ? { holonUri: persisted.holonUri } : {}) });
  }
  const durable = receipts.every(r => r.persisted);
  return { status: durable ? 200 : 502, body: { ok: durable, lrsAccepted: true, statementIds: [...ids], durable, receipts, ...(!durable ? { error: 'LRS accepted the batch but pod persistence is incomplete; retry the same ids and content' } : {}) } };
}

/** Queries the actual caller's LRS lens. Never silently blends in a pod/lattice snapshot. */
export async function readSelfXapi(input: unknown, deps: SelfXapiDependencies): Promise<SelfXapiReply> {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return failure(400, 'query must be an object');
  const query = (input ?? {}) as Json;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEYS.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) return failure(400, `unsupported query parameter ${key}`);
    params.set(key, String(value));
  }
  if (!params.has('statementId')) {
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return failure(400, 'limit must be an integer from 1 to 200');
    params.set('limit', String(limit));
  }
  return deps.request('GET', params);
}
