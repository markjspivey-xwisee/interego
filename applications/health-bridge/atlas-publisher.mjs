import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildAtlasProjection } from './atlas-projection.mjs';
import { reconcileAtlasRecord } from './atlas-reconciliation.mjs';
import { AtlasReviewError, atlasQuestionId, buildAtlasReviewContext, validateAtlasReviewSubmission } from './atlas-review.mjs';

const TARGET = 'mayya';
const STATE_KEY = 'atlas:mayya:publication-state:v1';
const DRAFT_PREFIX = 'atlas:mayya:draft:';
const TTL = 30 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
// One target, one process/replica. The queue is shared by factory instances, not
// attached to a browser session. Durable state supplies restart continuity.
let atlasQueue = Promise.resolve();
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const plainName = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class AtlasError extends Error {
  constructor(status, code, message) { super(message); this.name = 'AtlasError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AtlasError(status, code, message); };
async function queued(task) {
  const previous = atlasQueue;
  let release;
  atlasQueue = new Promise(resolve => { release = resolve; });
  await previous.catch(() => {});
  try { return await task(); } finally { release(); }
}

/** Fixed-destination publication authority. All persistence uses the bridge's
 * encrypted store. Browser markers must be injected by the HTTP session layer,
 * never reconstructed from caller JSON or signed MCP operation parameters. */
export function createAtlasPublisher({ store, loadOwner, loadRecord, baseRecord, now = Date.now, adminPrincipal, publicBase, atlasUrl, expectedSubject } = {}) {
  if (!store?.get || !store?.put || typeof loadOwner !== 'function' || typeof loadRecord !== 'function' || !object(baseRecord)) throw new TypeError('Atlas requires an encrypted store, owned-record callbacks and a curated base.');
  if (typeof adminPrincipal !== 'string' || !adminPrincipal) throw new TypeError('Atlas requires a fixed administrator principal.');
  if (typeof expectedSubject?.name !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expectedSubject?.birthDate ?? '')) throw new TypeError('Atlas requires an operator-configured expected subject.');
  const service = new URL(publicBase), atlas = new URL(atlasUrl);
  if (![service, atlas].every(url => url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || service.username || service.password || atlas.username || atlas.password) throw new TypeError('Atlas URLs must be trusted HTTPS service addresses.');
  const base = service.origin;
  const target = Object.freeze({ id: TARGET, label: 'Mayya’s Health Atlas', url: atlas.href });
  const recordUrl = `${base}/public/atlas/${TARGET}/record.json`;
  const curated = clone(baseRecord);
  const stamp = () => new Date(now()).toISOString();
  const state = async () => (await store.get(STATE_KEY)) ?? { version: 1, target: TARGET, revision: 0, binding: null, grant: null, autoPublish: false, publication: null, agentReview: null, reviewRevision: 0 };
  const principal = actor => { if (typeof actor?.principal !== 'string' || !actor.principal) fail(401, 'atlas_sign_in_required', 'Sign in to manage Atlas publication.'); return actor.principal; };
  const browser = actor => {
    principal(actor);
    const time = typeof actor.authenticatedAt === 'string' ? Date.parse(actor.authenticatedAt) : actor.authenticatedAt;
    if (actor.transport !== 'browser' || !Number.isFinite(time) || time < now() - 60 * 60_000 || time > now() + 5_000) fail(403, 'atlas_browser_required', 'Use a recently verified browser session to review or publish the Atlas.');
  };
  const bound = (saved, actor) => {
    if (!saved.binding) fail(409, 'atlas_not_linked', 'Use the administrator’s one-time Atlas link first.');
    if (saved.binding.principal !== principal(actor)) fail(403, 'atlas_owner_forbidden', 'This account cannot publish this Atlas.');
  };
  const own = async actor => {
    const owner = await loadOwner(actor);
    if (!object(owner) || owner.principal !== principal(actor)) fail(403, 'atlas_owner_forbidden', 'The source records do not belong to this account.');
    return owner;
  };
  const sourceRevision = owner => digest({
    patient: owner.sources?.duke?.patientId ?? null,
    connected: owner.sources?.duke?.connected === true,
    consent: owner.consent?.enabled === true,
    lastAttempt: owner.sources?.duke?.lastAttempt ?? null,
    lastSync: owner.sources?.duke?.lastSync ?? null,
    records: (Array.isArray(owner.records) ? owner.records : []).filter(item => item?.source === 'duke').map(item => ({ id: item.id, digest: item.digest ?? null, resourceType: item.resourceType ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
  const connection = (owner, saved) => {
    const source = owner.sources?.duke;
    if (owner.consent?.enabled !== true || source?.connected !== true || typeof source.patientId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(source.patientId)) fail(409, 'atlas_duke_required', 'Connect and import the intended Duke patient chart before publishing.');
    if (saved?.binding && source.patientId !== saved.binding.patientId) fail(409, 'atlas_chart_changed', 'The Duke chart changed. Publication is paused; this Atlas cannot be rebound from the browser.');
    return source;
  };
  const nameMatches = patient => {
    const wanted = plainName(expectedSubject.name), parts = wanted.split(' '), first = parts[0], last = parts.at(-1);
    return (Array.isArray(patient.name) ? patient.name : []).some(name => {
      if (name?.use === 'old' || name?.use === 'maiden') return false;
      return (plainName(name?.given?.[0]) === first && plainName(name?.family) === last) || plainName(name?.text) === wanted;
    });
  };
  const identity = (records, patientId) => {
    const patients = records.map(item => item?.raw).filter(raw => raw?.resourceType === 'Patient' && raw.id === patientId);
    if (!patients.length) fail(409, 'atlas_patient_import_required', 'Import the current Duke Patient record before linking this Atlas.');
    if (patients.some(patient => patient.birthDate !== expectedSubject.birthDate || !nameMatches(patient) || patient.active === false || patient.modifierExtension?.length)) fail(409, 'atlas_subject_mismatch', 'The imported Duke chart does not match the configured Atlas subject.');
    return { name: expectedSubject.name, birthDate: expectedSubject.birthDate };
  };
  const recordsFor = async (actor, owner, onlyPatient = false) => {
    const index = (Array.isArray(owner.records) ? owner.records : []).filter(item => item?.source === 'duke' && (!onlyPatient || item.resourceType === 'Patient'));
    if (index.length > 20_000) fail(413, 'atlas_record_limit', 'This source import exceeds the Atlas record limit.');
    const records = [];
    for (const item of index) {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 2048 || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)) fail(409, 'atlas_source_changed', 'The source index changed. Sync again before publishing.');
      // Document bodies are never public in this projection. The source revision
      // already pins their private index digests; do not decrypt large payloads
      // merely to count their exclusion. Sentinel fields carry no private IDs.
      if (!onlyPatient && ['Binary', 'DocumentAttachment'].includes(item.resourceType)) {
        records.push({ source: 'duke', resourceType: item.resourceType, raw: { resourceType: item.resourceType } });
        continue;
      }
      const value = await loadRecord(actor, item.id);
      if (!object(value) || value.source !== 'duke' || value.id !== item.id || digest(JSON.stringify(value.raw ?? value)) !== item.digest) fail(409, 'atlas_source_changed', 'An imported source record changed. Sync and preview again.');
      records.push(clone(value));
    }
    return records;
  };
  const snapshot = async (actor, saved, onlyPatient = false) => {
    const owner = await own(actor), source = connection(owner, saved), revision = sourceRevision(owner);
    const records = await recordsFor(actor, owner, onlyPatient), subject = identity(records, source.patientId);
    const reread = await own(actor);
    connection(reread, saved);
    if (sourceRevision(reread) !== revision) fail(409, 'atlas_source_changed', 'Source records changed during preparation. Preview again.');
    return { owner, source, records, subject, sourceRevision: revision };
  };
  const prepare = (loaded, saved) => {
    const createdAt = stamp(), revision = saved.revision + 1;
    const result = buildAtlasProjection({ baseRecord: curated, records: loaded.records, patientId: loaded.source.patientId, publishedAt: createdAt, revision, sourceSyncAt: loaded.source.lastSync ?? null });
    const projection = clone(result.record);
    // Presentation reconciliation and an editorial overlay are derived artifacts,
    // not new source facts. Clock/sync metadata must not trigger a clinical
    // release or invalidate an otherwise current editorial review.
    const { reconciliation: ignoredReconciliation, agentReview: ignoredReview, ...sourceContent } = projection;
    const contentDigest = digest(sourceContent);
    projection.meta = { ...projection.meta, publication: { target: TARGET, revision, contentDigest: `sha256:${contentDigest}`, publishedAt: createdAt, preparedAt: createdAt, managementUrl: base, publicRecordUrl: recordUrl, sourceSyncAt: loaded.source.lastSync ?? null, latestClinicalDate: result.latestClinicalDate ?? null } };
    if (Buffer.byteLength(JSON.stringify(projection)) > MAX_BYTES) fail(413, 'atlas_snapshot_too_large', 'This public snapshot is too large. Narrow the source import.');
    return { projection, contentDigest, stats: clone(result.stats), exclusions: clone(result.exclusions), latestClinicalDate: result.latestClinicalDate ?? null };
  };
  const receipt = saved => ({ target: clone(target), revision: saved.revision, publishedAt: saved.publication.publishedAt, committedAt: saved.publication.committedAt, digest: saved.publication.digest, autoPublish: saved.autoPublish, publicRecordUrl: recordUrl });
  const commit = async (saved, draft, automatic, autoPublishPreference) => {
    const committedAt = stamp();
    const next = { ...saved, agentReview: null, reviewAuthority: null, revision: draft.baseRevision + 1, autoPublish: automatic ? saved.autoPublish : autoPublishPreference, publication: { record: clone(draft.projection), digest: draft.digest, contentDigest: draft.contentDigest, sourceRevision: draft.sourceRevision, sourceSyncAt: draft.projection.meta.publication.sourceSyncAt, latestClinicalDate: draft.latestClinicalDate, stats: draft.stats, publishedAt: draft.projection.meta.publication.publishedAt, committedAt, draftId: draft.draftId, automatic } };
    if (!automatic) next.lastReceipt = { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision, autoPublish: next.autoPublish, receipt: receipt(next) };
    await store.put(STATE_KEY, next);
    return receipt(next);
  };

  const publicBinding = saved => ({ sourceRevision: saved.revision, sourceDigest: saved.publication.record.meta.publication.contentDigest });
  const activeReview = saved => {
    const binding = publicBinding(saved), review = saved.agentReview;
    return review?.sourceRevision === binding.sourceRevision && review?.sourceDigest === binding.sourceDigest ? review : null;
  };
  const reviewStatus = saved => {
    const review = activeReview(saved);
    return { target: TARGET, ...publicBinding(saved), reviewRevision: saved.reviewRevision ?? 0, reviewStatus: review ? 'reviewed' : 'pending', reviewedAt: review?.reviewedAt ?? null, scope: 'public-summary-review', clinicianReviewed: false };
  };
  const publicRecord = saved => {
    // Derived presentation fields are separate from the immutable approved
    // clinical copy. Its original publication.contentDigest remains unchanged.
    const record = { ...saved.publication.record };
    delete record.agentReview;
    if (Array.isArray(record.faq)) record.faq = record.faq.map(faq => ({ ...faq, questionId: atlasQuestionId(faq) }));
    record.reconciliation = reconcileAtlasRecord(record);
    const review = activeReview(saved);
    if (review) record.agentReview = clone(review);
    return record;
  };
  const reviewContext = saved => buildAtlasReviewContext({ record: publicRecord(saved), ...publicBinding(saved), reviewRevision: saved.reviewRevision ?? 0, agentReview: activeReview(saved) });

  const api = {
    async status(actor) {
      principal(actor);
      const saved = await state(), ownerAllowed = saved.binding?.principal === actor.principal;
      let eligible = false, sourceSyncAt = null, recordCount = 0, pendingChanges = false;
      // Never read another bound owner's records merely to report status.
      if (!saved.binding || ownerAllowed) {
        try {
          const loaded = await snapshot(actor, saved, true);
          eligible = true; sourceSyncAt = loaded.source.lastSync ?? null;
          recordCount = loaded.owner.records.filter(item => item?.source === 'duke').length;
          pendingChanges = !saved.publication || saved.publication.sourceRevision !== loaded.sourceRevision;
        } catch (error) { if (!(error instanceof AtlasError) || error.status >= 500) throw error; }
      }
      return { target: clone(target), ownerAllowed: !!ownerAllowed, linked: !!saved.binding, eligible, lastPublishedAt: saved.publication?.committedAt ?? null, sourceSyncAt, latestClinicalDate: saved.publication?.latestClinicalDate ?? null, revision: saved.revision, autoPublish: ownerAllowed ? saved.autoPublish : false, pendingChanges, recordCount };
    },
    async createLink(actor) {
      if (principal(actor) !== adminPrincipal) fail(403, 'atlas_admin_required', 'Only the configured administrator can create an Atlas link.');
      return queued(async () => {
        const saved = await state();
        if (saved.binding) fail(409, 'atlas_already_linked', 'This Atlas is already linked. Browser relinking is disabled.');
        const token = randomBytes(32).toString('base64url'), expiresAt = new Date(now() + TTL).toISOString();
        await store.put(STATE_KEY, { ...saved, grant: { tokenHash: digest(token), createdAt: stamp(), expiresAt } });
        return { target: clone(target), url: `${base}/#atlas-link=${token}`, expiresAt };
      });
    },
    async claim(actor, { token } = {}) {
      browser(actor);
      return queued(async () => {
        const saved = await state();
        if (saved.binding) fail(409, 'atlas_already_linked', 'This Atlas is already linked. Browser relinking is disabled.');
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !saved.grant || Date.parse(saved.grant.expiresAt) <= now() || !equal(saved.grant.tokenHash, digest(token))) fail(403, 'atlas_link_invalid', 'The one-time Atlas link is invalid or expired.');
        const loaded = await snapshot(actor, saved, true);
        await store.put(STATE_KEY, { ...saved, grant: null, binding: { principal: actor.principal, patientId: loaded.source.patientId, linkedAt: stamp() } });
        return { target: clone(target), linked: true, ownerAllowed: true, autoPublish: false };
      });
    },
    async preview(actor) {
      browser(actor);
      return queued(async () => {
        const saved = await state(); bound(saved, actor);
        const loaded = await snapshot(actor, saved), prepared = prepare(loaded, saved);
        const draft = { draftId: randomBytes(24).toString('base64url'), target: TARGET, principal: actor.principal, patientId: loaded.source.patientId, digest: digest(prepared.projection), baseRevision: saved.revision, createdAt: stamp(), expiresAt: new Date(now() + TTL).toISOString(), sourceRevision: loaded.sourceRevision, ...prepared };
        await store.put(DRAFT_PREFIX + draft.draftId, draft);
        const { principal: ignoredPrincipal, patientId: ignoredPatient, contentDigest: ignoredContent, target: ignoredTarget, ...review } = draft;
        return { ...clone(review), subject: loaded.subject, diff: { previousRevision: saved.revision, changed: !saved.publication || saved.publication.contentDigest !== draft.contentDigest } };
      });
    },
    async publish(actor, { draftId, digest: reviewedDigest, baseRevision, autoPublish = false } = {}) {
      browser(actor);
      if (typeof autoPublish !== 'boolean') fail(400, 'atlas_auto_publish_invalid', 'Choose whether future sanitized updates may be published automatically.');
      if (typeof draftId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(draftId) || typeof reviewedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedDigest) || !Number.isSafeInteger(baseRevision) || baseRevision < 0) fail(400, 'atlas_draft_invalid', 'Publish an unchanged Atlas preview.');
      return queued(async () => {
        const saved = await state(); bound(saved, actor);
        // Even a retry must still refer to the bound, connected patient chart.
        const current = await own(actor); connection(current, saved);
        const prior = saved.lastReceipt;
        if (prior?.draftId === draftId) {
          if (!equal(prior.digest, reviewedDigest) || prior.baseRevision !== baseRevision || prior.autoPublish !== autoPublish) fail(409, 'atlas_receipt_conflict', 'This preview was already published with different publication choices.');
          return { ...clone(prior.receipt), duplicate: true };
        }
        const draft = await store.get(DRAFT_PREFIX + draftId);
        if (!draft || draft.principal !== actor.principal || draft.patientId !== saved.binding.patientId || draft.target !== TARGET || !equal(draft.digest, reviewedDigest) || !equal(digest(draft.projection), reviewedDigest) || draft.baseRevision !== baseRevision) fail(409, 'atlas_draft_invalid', 'The Atlas preview does not match this publication request.');
        if (Date.parse(draft.expiresAt) <= now()) fail(409, 'atlas_draft_expired', 'This Atlas preview expired. Prepare a fresh preview.');
        if (saved.revision !== baseRevision) fail(409, 'atlas_revision_conflict', 'A newer Atlas revision exists. Prepare a fresh preview.');
        // The reviewed projection is immutable. Recheck Patient identity and the
        // full index revision without rereading every clinical/body resource.
        const loaded = await snapshot(actor, saved, true);
        if (loaded.sourceRevision !== draft.sourceRevision) fail(409, 'atlas_source_changed', 'Source records changed after review. Prepare a fresh preview.');
        // Last owner-index read immediately before the single atomic state write.
        const latest = await own(actor); connection(latest, saved);
        if (sourceRevision(latest) !== draft.sourceRevision) fail(409, 'atlas_source_changed', 'Source records changed after review. Prepare a fresh preview.');
        return commit(saved, draft, false, autoPublish);
      });
    },
    async setAutomatic(actor, { enabled } = {}) {
      browser(actor);
      if (typeof enabled !== 'boolean') fail(400, 'atlas_auto_publish_invalid', 'Choose whether sanitized updates may be published automatically.');
      return queued(async () => {
        const saved = await state(); bound(saved, actor);
        if (enabled) {
          if (!saved.publication) fail(409, 'atlas_initial_publication_required', 'Review and publish the first snapshot before enabling automatic updates.');
          await snapshot(actor, saved, true);
        }
        await store.put(STATE_KEY, { ...saved, autoPublish: enabled });
        return { target: clone(target), autoPublish: enabled, revision: saved.revision };
      });
    },
    async autoPublish(actor) {
      principal(actor);
      return queued(async () => {
        const saved = await state();
        if (!saved.binding) return { updated: false, reason: 'atlas_not_linked' };
        bound(saved, actor);
        if (!saved.autoPublish || !saved.publication) return { updated: false, reason: 'atlas_auto_publish_not_enabled' };
        // Most syncs leave the source index unchanged. Validate the bound
        // Patient and index first; only a changed source needs full projection.
        const checked = await snapshot(actor, saved, true);
        if (checked.sourceRevision === saved.publication.sourceRevision) return { updated: false, reason: 'atlas_source_unchanged', revision: saved.revision };
        const loaded = await snapshot(actor, saved);
        const prepared = prepare(loaded, saved);
        if (prepared.contentDigest === saved.publication.contentDigest) {
          await store.put(STATE_KEY, { ...saved, publication: { ...saved.publication, sourceRevision: loaded.sourceRevision } });
          return { updated: false, reason: 'atlas_public_content_unchanged', revision: saved.revision };
        }
        const latest = await own(actor); connection(latest, saved);
        if (sourceRevision(latest) !== loaded.sourceRevision) fail(409, 'atlas_source_changed', 'Source records changed during preparation. Retry after syncing.');
        const draft = { ...prepared, draftId: `auto-${randomBytes(16).toString('hex')}`, digest: digest(prepared.projection), baseRevision: saved.revision, sourceRevision: loaded.sourceRevision };
        return { updated: true, ...await commit(saved, draft, true, true) };
      });
    },
    async review(actor, params = {}) {
      if (principal(actor) !== adminPrincipal) fail(403, 'atlas_admin_required', 'Only the configured administrator can submit an Atlas editorial review.');
      if (!object(params) || !['context', 'submit'].includes(params.mode)) fail(400, 'atlas_review_request_invalid', 'Choose the review context or submit a source-bound editorial review.');
      return queued(async () => {
        const saved = await state();
        if (!saved.publication) fail(404, 'atlas_not_published', 'Publish the first browser-reviewed snapshot before preparing an agent review.');
        if (params.mode === 'context') {
          if (Object.keys(params).some(key => key !== 'mode')) fail(400, 'atlas_review_request_invalid', 'Review context does not accept owner or destination fields.');
          return reviewContext(saved);
        }
        const binding = publicBinding(saved);
        const content = validateAtlasReviewSubmission({ record: publicRecord(saved), ...binding, params });
        const reviewDigest = content.reviewDigest.startsWith('sha256:') ? content.reviewDigest : `sha256:${content.reviewDigest}`;
        const prior = activeReview(saved);
        if (prior?.reviewDigest === reviewDigest) return { ...reviewStatus(saved), reviewDigest, duplicate: true };
        const reviewRevision = (saved.reviewRevision ?? 0) + 1;
        const agentReview = { scope: 'public-summary-review', clinicianReviewed: false, ...binding, reviewRevision, reviewDigest, reviewedAt: stamp(), reviewer: 'Atlas editorial agent', summaryBullets: content.summaryBullets, questionAnswers: content.questionAnswers };
        const next = { ...saved, reviewRevision, agentReview, reviewAuthority: { principal: actor.principal, agentId: typeof actor.agentId === 'string' ? actor.agentId : null } };
        await store.put(STATE_KEY, next);
        return { ...reviewStatus(next), reviewDigest, duplicate: false };
      });
    },
    async getPublic(format = 'json') {
      if (!['json', 'md', 'jsonld', 'ttl', 'review', 'review-status'].includes(format)) fail(404, 'atlas_format_not_found', 'This public record format is not available.');
      const saved = await state();
      if (!saved.publication) fail(404, 'atlas_not_published', 'No reviewed public snapshot has been published yet.');
      if (format === 'review-status') return { body: JSON.stringify(reviewStatus(saved)), contentType: 'application/json; charset=utf-8', revision: saved.revision, reviewRevision: saved.reviewRevision ?? 0 };
      if (format === 'review') return { body: JSON.stringify(reviewContext(saved)), contentType: 'application/json; charset=utf-8', revision: saved.revision, reviewRevision: saved.reviewRevision ?? 0 };
      const record = publicRecord(saved), publication = record.meta.publication, json = JSON.stringify(record);
      if (format === 'json') return { body: json, contentType: 'application/json; charset=utf-8', revision: saved.revision };
      if (format === 'jsonld') return { body: JSON.stringify({ '@context': { schema: 'https://schema.org/', dct: 'http://purl.org/dc/terms/' }, '@id': recordUrl, '@type': 'schema:Dataset', 'schema:name': 'Mayya Health Atlas reviewed public snapshot', 'dct:hasVersion': saved.revision, 'schema:datePublished': publication.publishedAt, 'schema:encoding': { '@type': 'schema:MediaObject', 'schema:encodingFormat': 'application/json', 'schema:contentUrl': recordUrl, 'schema:text': json } }), contentType: 'application/ld+json; charset=utf-8', revision: saved.revision };
      if (format === 'ttl') return { body: `@prefix schema: <https://schema.org/> .\n@prefix dct: <http://purl.org/dc/terms/> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n<${recordUrl}> a schema:Dataset ; schema:name "Mayya Health Atlas reviewed public snapshot" ; dct:hasVersion ${saved.revision} ; schema:datePublished ${JSON.stringify(publication.publishedAt)} ; schema:text ${JSON.stringify(json)}^^rdf:JSON .\n`, contentType: 'text/turtle; charset=utf-8', revision: saved.revision };
      const blocks = [`# Mayya Health Atlas`, `Publication revision: ${saved.revision}\n\nPublished snapshot prepared: ${publication.publishedAt}\n\n[Canonical JSON](${recordUrl})`, ...Object.entries(record).map(([key, value]) => `## ${key}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``)];
      return { body: blocks.join('\n\n') + '\n', contentType: 'text/markdown; charset=utf-8', revision: saved.revision };
    },
  };
  // Never expose provider/store exceptions or raw records through HTTP errors.
  return Object.fromEntries(Object.entries(api).map(([key, method]) => [key, async (...args) => { try { return await method(...args); } catch (error) { if (error instanceof AtlasError) throw error; if (error instanceof AtlasReviewError) throw new AtlasError(error.status, error.code, error.message); throw new AtlasError(503, 'atlas_operation_unavailable', 'Atlas publication could not finish. Check the source connection and retry.'); } }]));
}
