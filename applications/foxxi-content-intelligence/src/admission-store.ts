/**
 * Where a learner's kept admissions live (admission-records.ts): one resource on their own pod,
 * sealed by the bridge's key to itself and to the pod's owner.
 *
 * ★ NOTHING COUNTS UNTIL THE POD HOLDS IT. A kept admission decides what a learner is shown, down
 * to nothing at all. So it is written read, add, write: the whole list is read, the record added,
 * and the list written back under a condition on what was read. Nothing about it is held anywhere
 * else in the meantime, so a write that fails leaves no trace, now or at a later write.
 *
 * ★ UNREADABLE IS NOT EMPTY. A resource that is absent means nothing was kept. One that cannot be
 * fetched, opened or parsed is unreadable, and the reader is told so; resolution then refuses
 * rather than treat a learner who limited their content as one who did not.
 *
 * ★ ONLY WHAT THE BRIDGE SEALED IS TAKEN BACK. Anyone can wrap a key to the bridge's public key; only
 * the bridge can wrap one from it. The owner is a recipient, so they can read their own list, and a
 * list the bridge did not seal is unreadable, not trusted.
 */
import { createEncryptedEnvelope, envelopeFromJson, envelopeToJson, openEncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import { admissionRecordFrom, type AdmissionRecord } from './admission-records.js';

/** The resource on a learner's pod that holds their kept admissions. */
export const ADMISSIONS_RESOURCE = 'foxxi-lattice/content-admissions.envelope.json';

/** How many records a list keeps beyond the one standing for each competency: the most recent. */
export const ADMISSION_HISTORY_KEPT = 200;

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type AdmissionsRead =
  | { ok: true; records: AdmissionRecord[]; exists: boolean; etag?: string }
  | { ok: false; error: string };

const resourceOn = (podUrl: string): string => `${podUrl.endsWith('/') ? podUrl : `${podUrl}/`}${ADMISSIONS_RESOURCE}`;

/** The records a list sealed by `key` holds, or undefined when it was not sealed by it or cannot be opened. */
function openList(text: string, key: EncryptionKeyPair): AdmissionRecord[] | undefined {
  try {
    const envelope = envelopeFromJson(text);
    const own = envelope.wrappedKeys.filter(w => w.recipientPublicKey === key.publicKey && w.senderPublicKey === key.publicKey);
    if (!own.length) return undefined;
    const plain = openEncryptedEnvelope({ ...envelope, wrappedKeys: own }, key);
    if (plain === null) return undefined;
    const list = (JSON.parse(plain) as { records?: unknown }).records;
    if (!Array.isArray(list)) return undefined;
    const records: AdmissionRecord[] = [];
    for (const r of list) { try { records.push(admissionRecordFrom(r)); } catch { /* a record that no longer reads is passed over */ } }
    return records;
  } catch { return undefined; }
}

/** Read a learner's kept admissions from their pod. */
export async function readAdmissions(podUrl: string, key: EncryptionKeyPair | null, fetchFn: Fetch): Promise<AdmissionsRead> {
  let r: Awaited<ReturnType<Fetch>>;
  try { r = await fetchFn(resourceOn(podUrl), { headers: { Accept: 'application/json' } }); }
  catch (e) { return { ok: false, error: `the pod could not be reached: ${(e as Error).message}` }; }
  if (r.status === 404) return { ok: true, records: [], exists: false };
  if (!r.ok) return { ok: false, error: `the pod answered ${r.status}` };
  if (!key) return { ok: false, error: 'this bridge holds no key to open them with' };
  const records = openList(await r.text().catch(() => ''), key);
  if (!records) return { ok: false, error: 'what the pod holds could not be opened as a list this bridge sealed' };
  const etag = r.headers.get('etag');
  return { ok: true, records, exists: true, ...(etag ? { etag } : {}) };
}

/** The list with a record added: every record standing for its competency kept, and the most recent of the rest. */
export function withRecord(records: readonly AdmissionRecord[], record: AdmissionRecord, history = ADMISSION_HISTORY_KEPT): AdmissionRecord[] {
  const all = [...records, record];
  const latest = new Map<string, number>();
  all.forEach((r, i) => { const at = latest.get(r.competency); if (at === undefined || Date.parse(r.at) >= Date.parse(all[at]!.at)) latest.set(r.competency, i); });
  const standing = new Set(latest.values());
  const rest = all.map((r, i) => ({ r, i })).filter(x => !standing.has(x.i));
  const keptRest = new Set(rest.slice(Math.max(0, rest.length - history)).map(x => x.i));
  return all.filter((_, i) => standing.has(i) || keptRest.has(i));
}

/**
 * Add a record to a learner's list on their pod, sealed to the bridge and, when it is known, the
 * pod's owner. The write is conditional on the list read, and is tried again from the read when
 * another write came between; it succeeds only once the pod has answered that it holds the list.
 */
export async function keepAdmission(podUrl: string, record: AdmissionRecord, key: EncryptionKeyPair, fetchFn: Fetch,
  ownerKey?: string | null, attempts = 3): Promise<{ ok: true; records: AdmissionRecord[] } | { ok: false; error: string }> {
  const url = resourceOn(podUrl);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const read = await readAdmissions(podUrl, key, fetchFn);
    if (!read.ok) return read;
    const records = withRecord(read.records, record);
    const recipients = [key.publicKey, ...(ownerKey && ownerKey !== key.publicKey ? [ownerKey] : [])];
    const body = envelopeToJson(createEncryptedEnvelope(JSON.stringify({ records }), recipients, key));
    // The container may not exist yet on a learner's pod; creating it is idempotent.
    await fetchFn(url.replace(/[^/]+$/, ''), { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' }).catch(() => undefined);
    let w: Awaited<ReturnType<Fetch>>;
    try {
      w = await fetchFn(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(read.etag ? { 'If-Match': read.etag } : read.exists ? {} : { 'If-None-Match': '*' }) },
        body,
      });
    } catch (e) { return { ok: false, error: `the pod could not be reached: ${(e as Error).message}` }; }
    if (w.ok) return { ok: true, records };
    if (w.status !== 412) return { ok: false, error: `the pod answered ${w.status}` };
  }
  return { ok: false, error: 'other writes kept coming between; try again' };
}
