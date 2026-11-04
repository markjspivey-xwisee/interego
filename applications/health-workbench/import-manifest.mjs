/** Offline preparation contract. No file discovery, parsing, host save or grant. */
import { createHash } from 'node:crypto';
import { prepareLocalHealthNote } from './local-context.mjs';

export const IMPORT_MANIFEST_FORMAT = 'interego.health.selected-import.v1';
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MEDIA_TYPES = new Set(['application/pdf', 'application/json', 'text/plain']);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function requireCondition(ok, message) {
  if (!ok) throw new TypeError(`Invalid selected import: ${message}`);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function uniqueList(value, maximum) {
  return Array.isArray(value) && value.length <= maximum
    && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1024)
    && new Set(value).size === value.length;
}

/**
 * Caller supplies selected attachment bytes in memory. A digest comparison
 * establishes integrity against a declaration, never publisher authenticity.
 * The returned manifest is detached: interego_save_note accepts only note.
 */
export function prepareSelectedHealthImport(packet, attachments, options) {
  requireCondition(record(options), 'explicit selection options required');
  requireCondition(uniqueList(options.selectedAttachmentIds, MAX_ATTACHMENTS), 'explicit unique attachment selection required');
  requireCondition(Array.isArray(attachments) && attachments.length <= MAX_ATTACHMENTS, 'bounded attachment catalog required');
  const note = prepareLocalHealthNote(packet, options);
  const context = JSON.parse(note.body);
  const caseId = context.case.id;
  const snapshotKey = context.snapshotKey;
  const entries = new Map(context.entries.map(row => [row.id, row]));
  const sourceIds = new Set(context.citations.map(row => row.id));
  const usedIds = new Set([
    ...entries.keys(), ...sourceIds, ...context.concepts.map(row => row.id),
    ...context.entries.flatMap(row => row.specimen ? [row.specimen.id] : []),
  ]);
  const catalog = new Map();
  for (const attachment of attachments) {
    requireCondition(record(attachment) && typeof attachment.id === 'string'
      && attachment.id.length <= 1024 && attachment.id.startsWith(`${caseId}#`)
      && /^[A-Za-z0-9._~-]+$/.test(attachment.id.slice(caseId.length + 1))
      && !catalog.has(attachment.id) && !usedIds.has(attachment.id), 'unique case-bound attachment identity required');
    catalog.set(attachment.id, attachment);
  }
  let totalBytes = 0;
  const selected = options.selectedAttachmentIds.map(id => {
    const row = catalog.get(id);
    requireCondition(Boolean(row), 'selected attachment missing');
    requireCondition(row.caseId === caseId && row.snapshotKey === snapshotKey, 'attachment case/checkpoint mismatch');
    requireCondition(uniqueList(row.entryIds, 12) && row.entryIds.length > 0
      && row.entryIds.every(entryId => entries.has(entryId)), 'attachment requires selected evidence entries');
    requireCondition(uniqueList(row.sourceIds, 384) && row.sourceIds.length > 0
      && row.sourceIds.every(sourceId => sourceIds.has(sourceId)), 'attachment requires selected citations');
    // Every claimed entry and citation must participate in this declared mapping.
    requireCondition(row.entryIds.every(entryId => entries.get(entryId).sourceIds.some(sourceId => row.sourceIds.includes(sourceId)))
      && row.sourceIds.every(sourceId => row.entryIds.some(entryId => entries.get(entryId).sourceIds.includes(sourceId))), 'attachment citation mapping mismatch');
    requireCondition(MEDIA_TYPES.has(row.mediaType), 'unsupported declared media type');
    requireCondition(row.bytes instanceof Uint8Array
      && !(typeof SharedArrayBuffer !== 'undefined' && row.bytes.buffer instanceof SharedArrayBuffer), 'ordinary byte buffer required');
    requireCondition(Number.isSafeInteger(row.byteLength) && row.byteLength > 0
      && row.byteLength <= MAX_ATTACHMENT_BYTES && row.bytes.byteLength === row.byteLength, 'attachment byte length mismatch or limit');
    totalBytes += row.byteLength;
    requireCondition(totalBytes <= MAX_IMPORT_BYTES, 'total attachment byte limit exceeded');
    requireCondition(typeof row.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.digest)
      && digest(row.bytes) === row.digest, 'attachment digest mismatch');
    return {
      id: row.id, caseId, snapshotKey, entryIds: [...row.entryIds], sourceIds: [...row.sourceIds],
      mediaType: row.mediaType, byteLength: row.byteLength, digest: row.digest,
    };
  });
  return {
    note,
    manifest: {
      format: IMPORT_MANIFEST_FORMAT, operation: 'prepare-only', caseId, snapshotKey,
      preparedNoteDigest: digest(JSON.stringify(note)), attachments: selected,
      selection: { selected: selected.length, unselected: attachments.length - selected.length, totalBytes },
      unverified: ['source-authenticity', 'citation-content-relationship', 'media-type-content',
        'attachment-safety', 'source-access-and-consent', 'native-attachment-storage',
        'resource-scoped-authorization', 'encryption-and-persistence'],
    },
  };
}
