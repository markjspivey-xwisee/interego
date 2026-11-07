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

test('sparse identifier arrays fail instead of skipping their holes', () => {
  const mutations = [
    x => { x.row.entryIds = Array(1); x.row.sourceIds = Array(1); },
    x => { x.row.entryIds = [x.packet.entries[0].id, , ]; }, // eslint-disable-line no-sparse-arrays
    x => { x.row.sourceIds = [...x.row.sourceIds, , ]; }, // eslint-disable-line no-sparse-arrays
    x => { x.options.selectedEntryIds = [x.packet.entries[0].id, , ]; }, // eslint-disable-line no-sparse-arrays
    x => { x.options.selectedAttachmentIds = Array(1); },
  ];
  for (const mutate of mutations) {
    const input = setup(); mutate(input);
    assert.throws(() => prepare(input), /Invalid selected import/);
  }
  const { packet, row, options } = setup();
  assert.throws(() => prepareSelectedHealthImport(packet, Array(1), { ...options, selectedAttachmentIds: Array(1) }), /attachment selection/);
  assert.throws(() => prepareSelectedHealthImport(packet, [row, , ], options), /bounded attachment/); // eslint-disable-line no-sparse-arrays
});

test('accessor properties are refused without being invoked, so the manifest records only what was checked', () => {
  const real = setup();
  const reads = { count: 0 };
  const getter = value => ({ enumerable: true, get() { reads.count += 1; return reads.count > 1 ? `sha256:${'0'.repeat(64)}` : value; } });
  const cases = [
    x => Object.defineProperty(x.row, 'digest', getter(real.row.digest)),
    x => Object.defineProperty(x.row, 'byteLength', getter(real.row.byteLength)),
    x => Object.defineProperty(x.row, 'entryIds', getter(real.row.entryIds)),
    x => Object.defineProperty(x.row, 'id', getter(real.row.id)),
    x => Object.defineProperty(x.options, 'selectedAttachmentIds', getter([real.row.id])),
    x => Object.defineProperty(x.options, 'selectedEntryIds', getter(real.options.selectedEntryIds)),
    x => Object.defineProperty(x.options, 'includeReaderQuestion', getter(false)),
    x => { const ids = [x.row.sourceIds[0]]; Object.defineProperty(ids, 0, getter(x.row.sourceIds[0])); x.row.sourceIds = ids; },
  ];
  for (const install of cases) {
    const input = setup(); reads.count = 0; install(input);
    assert.throws(() => prepare(input), /Invalid selected import/);
    assert.equal(reads.count, 0);
  }
  const result = prepare(setup());
  assert.equal(result.manifest.attachments[0].digest, real.row.digest);
});

test('byte views are measured from their internal slots, not from properties a caller can redefine', () => {
  const spoofs = [
    x => { x.row.bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1); Object.defineProperty(x.row.bytes, 'byteLength', { value: 1 }); rehash(x.row); x.row.byteLength = 1; },
    x => { class Short extends Uint8Array { get byteLength() { return 3; } } x.row.bytes = new Short(1000); rehash(x.row); x.row.byteLength = 3; },
    x => { x.row.bytes = new Uint8Array(new SharedArrayBuffer(16)); Object.defineProperty(x.row.bytes, 'buffer', { value: new ArrayBuffer(16) }); rehash(x.row); x.row.byteLength = 16; },
    x => { x.row.bytes = new Proxy(x.row.bytes, {}); },
  ];
  for (const spoof of spoofs) {
    const input = setup(); spoof(input);
    assert.throws(() => prepare(input), /Invalid selected import: (?:ordinary byte buffer|attachment byte length)/);
  }
  const buffer = setup();
  buffer.row.bytes = Buffer.from('Invented order source, for contract testing only.');
  rehash(buffer.row);
  assert.equal(prepare(buffer).manifest.attachments[0].byteLength, buffer.row.bytes.length);
});

test('array lengths must be exact nonnegative integers within the bound', () => {
  const lying = values => { let reads = 0; return new Proxy(values, { get: (target, key, receiver) => key === 'length' ? { valueOf: () => (++reads === 1 ? 1 : target.length) } : Reflect.get(target, key, receiver) }); };
  const { packet, row, options } = setup();
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...row, id: `${packet.case.id}#attachment-${index + 1}` }));
  const ids = rows.map(entry => entry.id);
  assert.throws(() => prepareSelectedHealthImport(packet, lying(rows), { ...options, selectedAttachmentIds: lying(ids) }), /Invalid selected import/);
  for (const length of [NaN, -1, 1.5]) {
    const catalog = new Proxy([], { get: (target, key, receiver) => key === 'length' ? length : Reflect.get(target, key, receiver) });
    assert.throws(() => prepareSelectedHealthImport(packet, catalog, { ...options, selectedAttachmentIds: [] }), /bounded attachment/);
  }
});
