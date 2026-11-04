import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fixture from '../fixtures/fictional-packet.json' with { type: 'json' };
import { prepareLocalHealthNote } from '../local-context.mjs';
import { prepareSelectedHealthImport, MAX_ATTACHMENT_BYTES } from '../import-manifest.mjs';

function setup() {
  const packet = structuredClone(fixture);
  const options = { selectedEntryIds: [packet.entries[0].id], selectedAttachmentIds: [`${packet.case.id}#attachment-1`] };
  const context = JSON.parse(prepareLocalHealthNote(packet, options).body);
  const row = {
    id: options.selectedAttachmentIds[0], caseId: packet.case.id, snapshotKey: context.snapshotKey,
    entryIds: options.selectedEntryIds, sourceIds: packet.entries[0].sourceIds,
    mediaType: 'text/plain', bytes: new TextEncoder().encode('Invented order source, for contract testing only.'),
  };
  rehash(row);
  return { packet, options, row };
}
function rehash(row) {
  row.byteLength = row.bytes.byteLength;
  row.digest = `sha256:${createHash('sha256').update(row.bytes).digest('hex')}`;
}
const prepare = ({ packet, options, row }) => prepareSelectedHealthImport(packet, [row], options);

test('manifest binds selected bytes to exact context and excludes bytes, paths, credentials and unknown fields', () => {
  const input = setup();
  input.row.path = 'C:/private/secret.pdf';
  input.row.token = 'NEVER-REFLECT';
  const before = structuredClone(input);
  const result = prepare(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.note, prepareLocalHealthNote(input.packet, input.options));
  assert.equal(result.manifest.preparedNoteDigest, `sha256:${createHash('sha256').update(JSON.stringify(result.note)).digest('hex')}`);
  assert.equal(result.manifest.attachments[0].snapshotKey, JSON.parse(result.note.body).snapshotKey);
  assert.deepEqual(result.manifest.selection, { selected: 1, unselected: 0, totalBytes: input.row.byteLength });
  assert.equal(result.manifest.operation, 'prepare-only');
  assert.ok(result.manifest.unverified.includes('citation-content-relationship'));
  assert.ok(!JSON.stringify(result).includes('NEVER-REFLECT'));
  assert.ok(!JSON.stringify(result).includes('C:/private'));
  assert.equal(Object.hasOwn(result.manifest.attachments[0], 'bytes'), false);
  result.manifest.attachments[0].sourceIds.push('changed');
  assert.deepEqual(input, before);
});

test('explicit empty selection never inspects unselected content', () => {
  const input = setup();
  input.options.selectedAttachmentIds = [];
  delete input.row.bytes;
  const result = prepare(input);
  assert.deepEqual(result.manifest.attachments, []);
  assert.deepEqual(result.manifest.selection, { selected: 0, unselected: 1, totalBytes: 0 });
});

test('tampering, cross-case/checkpoint references and unselected evidence fail atomically', () => {
  const mutations = [
    x => { delete x.options.selectedAttachmentIds; },
    x => { x.options.selectedAttachmentIds.push(x.row.id); },
    x => { x.options.selectedAttachmentIds = ['missing']; },
    x => { x.row.caseId = 'urn:another:case'; },
    x => { x.row.id = 'urn:another:case#attachment-1'; },
    x => { x.row.id = `${x.packet.case.id}#bad/../id`; },
    x => { x.row.id = x.packet.entries[0].id; },
    x => { x.row.snapshotKey += ' changed'; },
    x => { x.row.entryIds = [x.packet.entries[1].id]; },
    x => { x.row.sourceIds = [x.packet.citations[1].id]; },
    x => { x.row.sourceIds = []; },
    x => { x.row.bytes[0] ^= 1; },
    x => { x.row.byteLength += 1; },
    x => { x.row.bytes = 'not bytes'; },
    x => { x.row.mediaType = 'text/html'; },
    x => { x.row.bytes = new Uint8Array(new SharedArrayBuffer(4)); rehash(x.row); },
  ];
  for (const mutate of mutations) {
    const input = setup(); mutate(input);
    const before = structuredClone(input);
    assert.throws(() => prepare(input), TypeError);
    assert.deepEqual(input, before);
  }
});

test('many-to-many mappings reject unrelated citations even when both entries are selected', () => {
  const input = setup();
  input.options.selectedEntryIds = input.packet.entries.map(row => row.id);
  input.row.sourceIds = [input.packet.citations[1].id];
  assert.throws(() => prepare(input), /citation mapping/);
});

test('per-file and aggregate bounds include the exact selected byte views', () => {
  const input = setup();
  const allocation = new Uint8Array(MAX_ATTACHMENT_BYTES + 2);
  input.row.bytes = allocation.subarray(1, -1);
  rehash(input.row);
  assert.equal(prepare(input).manifest.selection.totalBytes, MAX_ATTACHMENT_BYTES);
  const second = { ...input.row, id: `${input.packet.case.id}#attachment-2` };
  input.options.selectedAttachmentIds.push(second.id);
  const result = prepareSelectedHealthImport(input.packet, [input.row, second], input.options);
  assert.equal(result.manifest.selection.totalBytes, 8 * 1024 * 1024);
  const third = { ...input.row, id: `${input.packet.case.id}#attachment-3` };
  input.options.selectedAttachmentIds.push(third.id);
  assert.throws(() => prepareSelectedHealthImport(input.packet, [input.row, second, third], input.options), /total attachment/);
  input.row.bytes = allocation;
  rehash(input.row);
  assert.throws(() => prepare(input), /byte length/);
});

test('duplicate catalog identifiers and oversized catalogs are rejected', () => {
  const { packet, row, options } = setup();
  assert.throws(() => prepareSelectedHealthImport(packet, [row, row], options), /unique case-bound/);
  assert.throws(() => prepareSelectedHealthImport(packet, Array(9).fill(row), options), /bounded attachment/);
});
