import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  snapshot, pairs, memberships, evidence, mappings, associations, diff, changed_fields,
  releases, touched, totals, reconcile, KINDS, KIND_CODES, pyRepr, pyTupleRepr, pyEventRepr, compareText,
  type JsonObject, type Release,
} from './history.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/history.json', import.meta.url), 'utf8')) as { before: JsonObject; after: JsonObject };
const before = snapshot(fixture.before), after = snapshot(fixture.after);
test('direction-normalizes symmetric and inverse SKOS relationships', () => {
  assert.deepEqual([...pairs(before)['skos:related']], ['["c:a","c:z"]']);
  assert.deepEqual([...pairs(before)['skos:broader']], ['["c:a","c:b"]']);
  assert.equal(pairs(after)['skos:related'].size, 1);
  assert.equal(pairs(after)['skos:broader'].size, 1);
  assert.equal(memberships(before).size, 3);
});
test('keeps repeated evidence records distinct and proposed associations separate', () => {
  assert.equal(evidence(before).size, 4);
  assert.equal(before.concepts['c:a']!.ev.get('["src:revise","duplicate",0]'), 'supporting');
  assert.equal(before.concepts['c:a']!.ev.get('["src:revise","duplicate",1]'), null);
  assert.equal(mappings(before).size, 2);
  assert.equal(associations(before).size, 2);
  assert.equal(mappings(after).size, 2);
});
test('emits every change family in the same ordered phases as the Python history', () => {
  const events = diff(before, after);
  assert.deepEqual(events.map(e => e.kind), [
    'concept-added', 'concept-removed',
    'label-changed', 'definition-revised', 'explanation-revised', 'type-changed', 'field-changed', 'status-changed',
    'alt-label-added', 'alt-label-removed',
    'relationship-added', 'relationship-removed', 'relationship-added', 'relationship-removed',
    'membership-added', 'membership-added', 'membership-removed', 'membership-removed',
    'collection-added', 'collection-removed', 'collection-revised',
    'source-added', 'source-removed', 'source-revised',
    'evidence-added', 'evidence-removed', 'evidence-reclassified', 'evidence-classified', 'evidence-reclassified',
    'external-mapping-added', 'external-mapping-revised', 'external-mapping-revised',
    'association-added', 'association-revised', 'association-removed',
  ]);
  assert.deepEqual(new Set(events.map(e => e.kind)), new Set(KIND_CODES));
  assert.equal(KINDS.length, 29);
  const nullRelation = events.find(e => e.kind === 'evidence-reclassified' && e.source === null);
  assert.deepEqual(nullRelation, { kind: 'evidence-reclassified', concept: 'c:a', source: null, prior: 'direct', new: 'unclassified' });
  assert.deepEqual(events.find(e => e.kind === 'source-revised')!.fields, {
    'dcterms:title': ['Old source', 'New source'],
    rights: ['withdrawn', null],
    url: [null, 'https://example.invalid/new'],
  });
  assert.deepEqual(events.find(e => e.kind === 'external-mapping-revised' && e.target === 'ext:withdrawn'), {
    kind: 'external-mapping-revised', concept: 'c:a', target: 'ext:withdrawn', prior: 'skos:exactMatch', new: null,
  });
});
test('all count families reconcile across additions, removals and revisions', () => {
  const rels: Release[] = [
    { version: '0.1', commits: 1, commit: 'a', date: '2026-01-01', snap: before, previous: null, events: [] },
    { version: '0.2', commits: 1, commit: 'b', date: '2026-01-02', snap: after, previous: '0.1', events: diff(before, after) },
  ];
  assert.deepEqual(totals(after), { concepts: 4, related: 1, broader: 1, memberships: 3, evidence: 4, sources: 2, collections: 2, mappings: 2, associations: 2 });
  for (const [name, [replayed, actual]] of Object.entries(reconcile(rels))) assert.equal(replayed, actual, name);
  assert.deepEqual(touched({ kind: 'relationship-added', a: 'a', b: 'b' }), ['a', 'b']);
  assert.deepEqual(touched({ kind: 'concept-added', concept: 'a' }), ['a']);
  assert.deepEqual(touched({ kind: 'source-added', source: 's' }), []);
});
test('record equality ignores key order and absent fields compare as None', () => {
  assert.deepEqual(changed_fields({ record: { a: 1, b: 2 }, missing: null }, { record: { b: 2, a: 1 } }), {});
  assert.deepEqual(diff(before, before), []);
});

test('tracks a cited CreativeWork source and active-only definition without inventing metadata', () => {
  const concept = 'https://id.i2idl.org/concepts/learning-management-systems';
  const definition = 'https://id.i2idl.org/definitions/learning-management-systems';
  const source = 'https://id.i2idl.org/sources/eric-thesaurus-2025';
  const doc: JsonObject = { '@graph': [
    { '@id': concept, '@type': ['skos:Concept', 'schema:DefinedTerm'],
      'skos:prefLabel': 'Learning Management Systems', 'gs:activeDefinition': { '@id': definition } },
    { '@id': definition, '@type': ['gs:Definition'], 'rdf:value': 'A learning platform.',
      'gs:evidence': [{ 'dcterms:source': { '@id': source }, 'gs:evidenceRelation': 'supporting' }] },
    { '@id': source, '@type': ['schema:CreativeWork'], 'dcterms:title': 'ERIC Thesaurus (2025)', 'dcterms:rights': 'Public domain' },
    { '@id': 'https://id.i2idl.org/sources/not-cited', '@type': ['schema:CreativeWork'], 'dcterms:title': 'An unrelated work' },
  ] };
  const original = JSON.stringify(doc), first = snapshot(doc);
  assert.deepEqual(Object.keys(first.sources), [source]);
  assert.equal(first.concepts[concept]!.definition, 'A learning platform.');
  assert.equal(first.concepts[concept]!.status, null);
  assert.equal(totals(first).sources, 1);
  const changed = structuredClone(doc);
  (changed['@graph'] as JsonObject[]).find(n => n['@id'] === definition)!['rdf:value'] = 'An updated learning platform.';
  assert.deepEqual(diff(first, snapshot(changed)).filter(e => e.kind === 'definition-revised'), [
    { kind: 'definition-revised', concept, prior: 'A learning platform.', new: 'An updated learning platform.' },
  ]);
  assert.equal(JSON.stringify(doc), original);
});
test('Python repr and Unicode ordering preserve history event identity', () => {
  assert.equal(pyRepr("O'Brien"), '"O\'Brien"');
  assert.equal(pyRepr('both " and \''), "'both \" and \\'" + "'");
  assert.equal(pyRepr('\n\t\r\u00a0'), "'\\n\\t\\r\\xa0'");
  assert.equal(pyTupleRepr(['c:a', null, "O'Brien\n", 0]), "('c:a', None, \"O'Brien\\n\", 0)");
  assert.equal(pyRepr({ kind: 'concept-added', concept: 'c:a' }), "{'kind': 'concept-added', 'concept': 'c:a'}");
  assert.equal(pyEventRepr({ kind: 'source-revised', fields: { title: ['before', 'after'] } }), "{'kind': 'source-revised', 'fields': {'title': ('before', 'after')}}");
  assert.ok(compareText('\u{10000}', '\uffff') > 0);
});
test('git history selects the final commit for each first-seen version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i2idlx-history-'));
  const git = (args: string[], date?: string): string => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  try {
    git(['init', '--quiet']);
    git(['config', 'user.email', 'history-test@example.invalid']);
    git(['config', 'user.name', 'History test']);
    mkdirSync(join(dir, 'public'));
    const commit = (doc: JsonObject, date: string): string => {
      writeFileSync(join(dir, 'public/glossary.jsonld'), JSON.stringify(doc));
      git(['add', 'public/glossary.jsonld']);
      git(['commit', '--quiet', '-m', 'fixture'], date);
      return git(['rev-parse', 'HEAD']);
    };
    commit(fixture.before, '2026-01-01T00:00:00+00:00');
    const changedBefore = structuredClone(fixture.before);
    (changedBefore['@graph'] as JsonObject[]).find(n => n['@id'] === 'c:a')!['skos:prefLabel'] = 'Final v0.1';
    const finalFirst = commit(changedBefore, '2026-01-02T00:00:00+00:00');
    const finalSecond = commit(fixture.after, '2026-01-03T00:00:00+00:00');
    const rels = releases(dir, 'public/glossary.jsonld');
    assert.equal(rels.length, 2);
    assert.equal(rels[0]!.commits, 2);
    assert.equal(rels[0]!.commit, finalFirst);
    assert.equal(rels[0]!.date, git(['show', '--no-patch', '--format=%cI', finalFirst]));
    assert.equal(rels[1]!.commit, finalSecond);
    assert.equal(rels[1]!.previous, '0.1');
    assert.equal(rels[0]!.previous, null);
    assert.deepEqual(rels[0]!.events, []);
    assert.equal(rels[1]!.events.find(e => e.kind === 'label-changed')!.prior, 'Final v0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
