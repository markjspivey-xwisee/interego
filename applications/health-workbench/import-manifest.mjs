/** Offline preparation contract. No file discovery, parsing, host save or grant. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { prepareLocalHealthNote } from './local-context.mjs';

export const IMPORT_MANIFEST_FORMAT = 'interego.health.selected-import.v1';
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const NOTE_SELECTION_LIMIT = 12; // local-context.mjs SELECTION_LIMIT
const MEDIA_TYPES = new Set(['application/pdf', 'application/json', 'text/plain']);
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function requireCondition(ok, message) {
  if (!ok) throw new TypeError(`Invalid selected import: ${message}`);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
// Inputs are read once, as own data properties, into plain copies; validation and the
// manifest both use the copies. A getter is never invoked and is refused, so the value
// checked is the value recorded, and an array hole is refused rather than skipped.
function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  requireCondition('value' in descriptor, 'accessor properties are not accepted');
  return descriptor.value;
}
function denseCopy(value, maximum) {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copy.push(descriptor.value);
  }
  return copy;
}
function uniqueList(value, maximum) {
  const copy = denseCopy(value, maximum);
  return copy !== null
    && copy.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1024)
    && new Set(copy).size === copy.length ? copy : null;
}
const ROW_FIELDS = ['caseId', 'snapshotKey', 'entryIds', 'sourceIds', 'mediaType', 'bytes', 'byteLength', 'digest'];
// The note adapter reads its options with ordinary lookups, so it receives a plain copy.
function noteOptions(options) {
  const copy = {};
  const entryIds = dataValue(options, 'selectedEntryIds');
  if (entryIds !== undefined) {
    const dense = Array.isArray(entryIds) ? denseCopy(entryIds, NOTE_SELECTION_LIMIT) : entryIds;
    requireCondition(dense !== null, 'explicit dense entry selection required');
    copy.selectedEntryIds = dense;
  }
  const includeReaderQuestion = dataValue(options, 'includeReaderQuestion');
  if (includeReaderQuestion !== undefined) copy.includeReaderQuestion = includeReaderQuestion;
  return copy;
}
// A byte view's type, size and memory come from its internal slots through the intrinsic
// getters, never from properties a subclass or the caller could redefine.
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicGetter = key => Object.getOwnPropertyDescriptor(TYPED_ARRAY, key).get;
const VIEW_TAG = intrinsicGetter(Symbol.toStringTag);
const VIEW_BUFFER = intrinsicGetter('buffer');
const VIEW_BYTE_LENGTH = intrinsicGetter('byteLength');
function ordinaryViewLength(value) {
  if (!(value instanceof Uint8Array) || Reflect.apply(VIEW_TAG, value, []) !== 'Uint8Array') return null;
  if (types.isSharedArrayBuffer(Reflect.apply(VIEW_BUFFER, value, []))) return null;
  return Reflect.apply(VIEW_BYTE_LENGTH, value, []);
}

/**
 * Caller supplies selected attachment bytes in memory. A digest comparison
 * establishes integrity against a declaration, never publisher authenticity.
 * The returned manifest is detached: interego_save_note accepts only note.
 */
export function prepareSelectedHealthImport(packet, attachments, options) {
  requireCondition(record(options), 'explicit selection options required');
  const selectedAttachmentIds = uniqueList(dataValue(options, 'selectedAttachmentIds'), MAX_ATTACHMENTS);
  requireCondition(selectedAttachmentIds !== null, 'explicit unique attachment selection required');
  const catalogRows = denseCopy(attachments, MAX_ATTACHMENTS);
  requireCondition(catalogRows !== null, 'bounded attachment catalog required');
  const note = prepareLocalHealthNote(packet, noteOptions(options));
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
  for (const attachment of catalogRows) {
    const id = record(attachment) ? dataValue(attachment, 'id') : undefined;
    requireCondition(typeof id === 'string'
      && id.length <= 1024 && id.startsWith(`${caseId}#`)
      && /^[A-Za-z0-9._~-]+$/.test(id.slice(caseId.length + 1))
      && !catalog.has(id) && !usedIds.has(id), 'unique case-bound attachment identity required');
    catalog.set(id, attachment);
  }
  let totalBytes = 0;
  const selected = selectedAttachmentIds.map(id => {
    const source = catalog.get(id);
    requireCondition(Boolean(source), 'selected attachment missing');
    // Only a selected row's fields are read, each once; unselected rows stay uninspected.
    const row = Object.fromEntries(ROW_FIELDS.map(key => [key, dataValue(source, key)]));
    requireCondition(row.caseId === caseId && row.snapshotKey === snapshotKey, 'attachment case/checkpoint mismatch');
    const entryIds = uniqueList(row.entryIds, 12);
    requireCondition(entryIds !== null && entryIds.length > 0
      && entryIds.every(entryId => entries.has(entryId)), 'attachment requires selected evidence entries');
    const citedIds = uniqueList(row.sourceIds, 384);
    requireCondition(citedIds !== null && citedIds.length > 0
      && citedIds.every(sourceId => sourceIds.has(sourceId)), 'attachment requires selected citations');
    // Every claimed entry and citation must participate in this declared mapping.
    requireCondition(entryIds.every(entryId => entries.get(entryId).sourceIds.some(sourceId => citedIds.includes(sourceId)))
      && citedIds.every(sourceId => entryIds.some(entryId => entries.get(entryId).sourceIds.includes(sourceId))), 'attachment citation mapping mismatch');
    requireCondition(MEDIA_TYPES.has(row.mediaType), 'unsupported declared media type');
    const viewLength = ordinaryViewLength(row.bytes);
    requireCondition(viewLength !== null, 'ordinary byte buffer required');
    requireCondition(Number.isSafeInteger(row.byteLength) && row.byteLength > 0
      && row.byteLength <= MAX_ATTACHMENT_BYTES && viewLength === row.byteLength, 'attachment byte length mismatch or limit');
    totalBytes += row.byteLength;
    requireCondition(totalBytes <= MAX_IMPORT_BYTES, 'total attachment byte limit exceeded');
    requireCondition(typeof row.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.digest)
      && digest(row.bytes) === row.digest, 'attachment digest mismatch');
    return {
      id, caseId, snapshotKey, entryIds, sourceIds: citedIds,
      mediaType: row.mediaType, byteLength: row.byteLength, digest: row.digest,
    };
  });
  return {
    note,
    manifest: {
      format: IMPORT_MANIFEST_FORMAT, operation: 'prepare-only', caseId, snapshotKey,
      preparedNoteDigest: digest(JSON.stringify(note)), attachments: selected,
      selection: { selected: selected.length, unselected: catalogRows.length - selected.length, totalBytes },
      unverified: ['source-authenticity', 'citation-content-relationship', 'media-type-content',
        'attachment-safety', 'source-access-and-consent', 'native-attachment-storage',
        'resource-scoped-authorization', 'encryption-and-persistence'],
    },
  };
}
