/** Offline comparison only. A caller-supplied response cannot prove its origin. */
import { createHash } from 'node:crypto';
import fixture from './fixtures/fictional-packet.json' with { type: 'json' };
import { prepareLocalHealthNote } from './local-context.mjs';

const NOTE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function requireCondition(condition, message) {
  if (!condition) throw new TypeError(message);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function timestamp(value) {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Exact native save arguments, generated exclusively from the bundled fiction. */
export function prepareFictionalLocalHealthCheck() {
  return prepareLocalHealthNote(fixture, { selectedEntryIds: fixture.entries.map(row => row.id) });
}

/**
 * Accept the native tool's structuredContent ({note}), not an MCP envelope or
 * prose. Expected connection identity comes from independently observed status.
 * An optional note ID binds a later response to the original save response.
 */
export function verifyFictionalLocalHealthResponse(response, options) {
  requireCondition(record(options), 'Expected independently observed connection options.');
  const { expectedConnectionId, expectedNoteId } = options;
  requireCondition(typeof expectedConnectionId === 'string' && CONNECTION_ID.test(expectedConnectionId), 'Expected a native connection identifier.');
  requireCondition(expectedNoteId === undefined || (typeof expectedNoteId === 'string' && NOTE_ID.test(expectedNoteId)), 'Expected a native note identifier.');
  requireCondition(record(response) && Object.keys(response).join(',') === 'note' && record(response.note), 'Expected a successful native note response only.');
  const note = response.note;
  const expected = prepareFictionalLocalHealthCheck();
  requireCondition(note.title === expected.title && note.body === expected.body, 'The response does not exactly match the fictional note.');
  requireCondition(typeof note.id === 'string' && NOTE_ID.test(note.id), 'The response has no valid native note identifier.');
  requireCondition(expectedNoteId === undefined || note.id === expectedNoteId, 'The response belongs to a different native note.');
  requireCondition(timestamp(note.createdAt) && timestamp(note.updatedAt) && Date.parse(note.updatedAt) >= Date.parse(note.createdAt), 'The response has invalid native note timestamps.');
  requireCondition(record(note.author) && note.author.connectionId === expectedConnectionId
    && typeof note.author.name === 'string' && note.author.name.trim().length > 0 && note.author.name.length <= 80,
  'The response does not name the expected native connection.');
  return {
    schemaVersion: 1,
    result: 'fictional-content-match',
    scope: 'offline-comparison-of-caller-supplied-response',
    noteId: note.id,
    expectedNoteIdMatched: expectedNoteId === undefined ? null : true,
    preparedNoteDigest: `sha256:${createHash('sha256').update(JSON.stringify(expected)).digest('hex')}`,
    checks: ['exact-title-and-body', 'native-note-id-shape', 'timestamp-shape-and-order', 'expected-author-connection'],
    unverified: [
      'response-origin-and-authenticity', 'installed-app-version', 'connection-permissions',
      'encrypted-storage', 'persistence-after-restart', 'grant-expiry', 'grant-revocation',
      'private-chart-integration',
    ],
  };
}
