import { describe, expect, it } from 'vitest';
import { createLearningCourseMapSnapshot, LEARNING_MAP_LIMITS, validateLearningCourseMap, validateLearningCourseMapSnapshot } from '../src/i2idlx-learning-map.js';

const OWNER = 'did:web:identity.example.test:users:owner-1';
const CONNECTOR = 'a'.repeat(32);
const save = () => ({ owner: OWNER, connector_id: CONNECTOR, saved_at: '2026-11-08T18:00:00.000Z', revision: 'b'.repeat(32) });
function map() { return { schema_version: 1, course_id: 'course-alpha', version: 2, title: 'Fictional practice', release_quiz_review: true,
  instructional_locations: [{ id: 'incident', label: 'Incident logging', source_file: 'lessons/incident.html', fragment: 'incident-code' }],
  review_items: [{ activity_id: 'item-quiz', interaction_id: 'incident-code', question_label: 'Which incident code should be recorded?',
    response_labels: [{ response: 'A', label: 'BLUE-27' }, { response: 'B', label: 'GREEN-12' }], location_ids: ['incident'] }],
  objectives: [{ id: 'record-incident', label: 'Record the fictional incident', competency_iris: ['urn:example:competency:record-incident', 'https://example.test/competencies#incident'], location_ids: ['incident'] }],
  prerequisites: [{ course_id: 'intro', version: 1, relation: 'required', label: 'Introduction' }, { course_id: 'reference', relation: 'recommended' }],
  curriculum: { label: 'Owner supplied suggested order', sequence: [{ course_id: 'intro', version: 1 }, { course_id: 'course-alpha', version: 2 }] } }; }
const rejects = (value: unknown) => expect(() => validateLearningCourseMap(value)).toThrowError(expect.objectContaining({ status: 400, code: 'learning_map_invalid' }));
const corrupted = (value: unknown) => expect(() => validateLearningCourseMapSnapshot(value)).toThrowError(expect.objectContaining({ status: 503, code: 'learning_map_state_invalid' }));

describe('owner-authored versioned learning maps', () => {
  it('keeps declared locations, objectives, competency references and distinct required/recommended relations', () => {
    const source = map(), result = validateLearningCourseMap(source, { course_id: 'course-alpha', version: 2 });
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    source.instructional_locations[0]!.label = 'Changed later';
    expect(result.instructional_locations[0]!.label).toBe('Incident logging');
    expect(result.prerequisites.map(value => value.relation)).toEqual(['required', 'recommended']);
  });
  it('does not invent a review release, curriculum, objective, competency, prerequisite or location', () => {
    expect(validateLearningCourseMap({ schema_version: 1, course_id: 'course-alpha', version: 0 })).toEqual({
      schema_version: 1, course_id: 'course-alpha', version: 0, release_quiz_review: false,
      instructional_locations: [], review_items: [], objectives: [], prerequisites: [],
    });
    const value = map(); value.release_quiz_review = false;
    expect(validateLearningCourseMap(value).release_quiz_review).toBe(false);
  });
  it('binds input to the exact provider course version when requested', () => {
    expect(() => validateLearningCourseMap(map(), { course_id: 'other', version: 2 })).toThrow();
    expect(() => validateLearningCourseMap(map(), { course_id: 'course-alpha', version: 3 })).toThrow();
  });
  it('keeps provider interaction identity distinct from instructional locations without including outcome or answer-key data', () => {
    const result = validateLearningCourseMap(map());
    expect(result.review_items[0]).toMatchObject({ activity_id: 'item-quiz', interaction_id: 'incident-code', location_ids: ['incident'] });
    expect(Object.keys(result.review_items[0]!)).toEqual(['activity_id', 'interaction_id', 'question_label', 'response_labels', 'location_ids']);
    expect(JSON.stringify(result)).not.toMatch(/correct_responses|answerHash|assessment_results|learner_id/);
  });
  it('keeps identical interaction IDs distinct in different provider activities and permits several authored fragments in one instructional file', () => {
    const value = map();
    value.review_items.push({ ...value.review_items[0]!, activity_id: 'item-other-practice' });
    value.instructional_locations.push({ ...value.instructional_locations[0]!, id: 'incident-second', fragment: 'second-reference' });
    const result = validateLearningCourseMap(value);
    expect(result.review_items).toHaveLength(2);
    expect(result.review_items.map(item => item.activity_id)).toEqual(['item-quiz', 'item-other-practice']);
    expect(result.instructional_locations.map(location => location.fragment)).toEqual(['incident-code', 'second-reference']);
  });
  it('accepts safe Unicode labels and relative source paths without fetching or normalizing them to URLs', () => {
    const value = map(); value.instructional_locations[0]!.source_file = 'leçons/étape 1.html'; value.instructional_locations[0]!.label = 'Étape 1';
    expect(validateLearningCourseMap(value).instructional_locations[0]!.source_file).toBe('leçons/étape 1.html');
  });
  it('preserves traditional HTTP vocabulary IRIs and DID competency references as identifiers without dereferencing them', () => {
    const value = map(); value.objectives[0]!.competency_iris = ['http://example.test/competencies/incident', 'did:web:competencies.example.test:incident'];
    expect(validateLearningCourseMap(value).objectives[0]!.competency_iris).toEqual(value.objectives[0]!.competency_iris);
  });
  it.each(['../secret.html', 'x/../lesson.html', '/lesson.html', '//example.test/lesson.html', 'https://example.test/a.html',
    'x\\lesson.html', 'x//lesson.html', './lesson.html', 'lesson.html?token=a', 'lesson.html#part', '%2e%2e/lesson.html',
    'lesson.html%3ftoken=x', 'x/ lesson.html', 'x/lesson.html ', 'quiz.html', 'assessments/part.html', 'question-bank/item.html',
    'answer_key.html', 'exam/part.html', 'test/part.html', 'lesson.js', 'lesson.exe'])('refuses unsafe or assessment source path %s', path => {
    const value = map(); value.instructional_locations[0]!.source_file = path; rejects(value);
  });
  it.each(['#part', 'part?x=1', '../part', 'https://example.test', 'part%20name'])('treats fragments as advisory IDs, rejecting %s', fragment => {
    const value = map(); value.instructional_locations[0]!.fragment = fragment; rejects(value);
  });
  it.each(['javascript:alert(1)', 'data:text/plain,hello', 'file:///tmp/secret',
    'https://user:secret@example.test/competency', 'relative-competency', 'urn:no namespace:value'])('refuses unsafe or unsupported competency IRI %s', iri => {
    const value = map(); value.objectives[0]!.competency_iris = [iri]; rejects(value);
  });
  it.each(['answer_key', 'correctResponses', 'correct_response', 'answerHash', 'score', 'result', 'learner_id', 'assessment'])('rejects additional assessment or runtime field %s', key => {
    rejects({ ...map(), [key]: 'not allowed' });
    const value = map(); (value.review_items[0] as unknown as Record<string, unknown>)[key] = 'not allowed'; rejects(value);
  });
  it('refuses duplicate IDs, repeated activity/interaction pairs and contradictory prerequisite duplicates', () => {
    let value = map(); value.instructional_locations.push({ ...value.instructional_locations[0]! }); rejects(value);
    value = map(); value.review_items.push({ ...value.review_items[0]! }); rejects(value);
    value = map(); value.objectives.push({ ...value.objectives[0]! }); rejects(value);
    value = map(); value.prerequisites.push({ course_id: 'intro', version: 1, relation: 'recommended', label: 'Other' }); rejects(value);
    value = map(); value.review_items[0]!.response_labels.push({ response: 'A', label: 'Another label' }); rejects(value);
    value = map(); value.curriculum.sequence.push({ course_id: 'intro', version: 1 }); rejects(value);
  });
  it('requires exact references to instructional locations and rejects self prerequisites', () => {
    let value = map(); value.review_items[0]!.location_ids = ['unknown']; rejects(value);
    value = map(); value.review_items[0]!.location_ids = []; rejects(value);
    value = map(); value.objectives[0]!.location_ids = ['unknown']; rejects(value);
    value = map(); value.prerequisites[0]!.course_id = 'course-alpha'; rejects(value);
  });
  it('rejects unknown nested fields, untyped relation, empty curriculum and malformed input versions', () => {
    rejects({ ...map(), schema_version: 2 }); rejects({ ...map(), version: -1 }); rejects({ ...map(), version: 0.5 });
    rejects({ ...map(), release_quiz_review: 'true' }); rejects({ ...map(), curriculum: { label: 'Unknown', sequence: [] } });
    rejects({ ...map(), prerequisites: [{ course_id: 'other', relation: 'equivalent' }] });
    rejects({ ...map(), instructional_locations: [{ ...map().instructional_locations[0], url: 'https://example.test' }] });
    rejects({ ...map(), review_items: [{ ...map().review_items[0], response_labels: [{ response: 'A', label: 'Display', correct: true }] }] });
  });
  it('refuses prototype pollution keys at every depth and accessor/non-JSON data without running getters', () => {
    rejects(JSON.parse('{"schema_version":1,"course_id":"a","version":0,"__proto__":{"polluted":true}}'));
    rejects(JSON.parse('{"schema_version":1,"course_id":"a","version":0,"curriculum":{"label":"x","constructor":{}}}'));
    rejects({ ...map(), title: new Date() }); rejects({ ...map(), objectives: [undefined] });
    let calls = 0; const value = Object.defineProperty(map(), 'title', { enumerable: true, get() { calls++; return 'Should not read'; } });
    rejects(value); expect(calls).toBe(0);
    const symbolic = map(); Object.defineProperty(symbolic, Symbol('secret'), { value: 'not JSON' }); rejects(symbolic);
    const inherited = map(); Object.setPrototypeOf(inherited.objectives, { map() { throw new Error('Must not execute'); } }); rejects(inherited);
    const cyclic: Record<string, unknown> = map(); cyclic['cycle'] = cyclic; rejects(cyclic);
    rejects({ ...map(), title: '\ud800' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('refuses oversized, sparse and deeply nested inputs before expensive application processing', () => {
    rejects({ ...map(), instructional_locations: Array.from({ length: LEARNING_MAP_LIMITS.locations + 1 }, (_, id) => ({ id: 'x' + id, label: 'X', source_file: 'x.html' })) });
    rejects({ ...map(), review_items: new Array(4) });
    rejects({ ...map(), title: 'x'.repeat(LEARNING_MAP_LIMITS.bytes + 1) });
    rejects({ schema_version: 1, course_id: 'course-alpha', version: 0,
      instructional_locations: Array.from({ length: 100 }, (_, id) => ({ id: 'location-' + id, label: 'x'.repeat(399), source_file: 'lesson.html' })) });
    rejects({ ...map(), review_items: [{ ...map().review_items[0], response_labels: Array.from({ length: LEARNING_MAP_LIMITS.responseLabels + 1 }, (_, id) => ({ response: String(id), label: 'Display' })) }] });
    let deep: unknown = 'x'; for (let n = 0; n < 20; n++) deep = { nested: deep }; rejects({ ...map(), unknown: deep });
  });
  it('creates an immutable hash-bound owner-authored snapshot, never a provider/achievement claim', () => {
    const snapshot = createLearningCourseMapSnapshot(map(), save());
    expect(snapshot.provenance).toMatchObject({ ...save(), kind: 'connector-owner-authored', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.map.review_items[0]!.response_labels)).toBe(true);
    expect(validateLearningCourseMapSnapshot(snapshot, { owner: OWNER, connector_id: CONNECTOR, course_id: 'course-alpha', version: 2 })).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/LMS-asserted|mastered|provider-derived/);
  });
  it('hashes canonical object field order while retaining declared list order and save-event identity', () => {
    const first = createLearningCourseMapSnapshot(map(), save());
    const reversedFields = Object.fromEntries(Object.entries(map()).reverse());
    expect(createLearningCourseMapSnapshot(reversedFields, save()).provenance.sha256).toBe(first.provenance.sha256);
    const reordered = map(); reordered.curriculum.sequence.reverse();
    expect(createLearningCourseMapSnapshot(reordered, save()).provenance.sha256).not.toBe(first.provenance.sha256);
    expect(createLearningCourseMapSnapshot(map(), { ...save(), revision: 'c'.repeat(32) }).provenance.sha256).not.toBe(first.provenance.sha256);
  });
  it('refuses tampered content, save metadata, hashes, expected bindings and unnormalized persisted defaults', () => {
    const snapshot = createLearningCourseMapSnapshot(map(), save());
    for (const change of [
      (value: typeof snapshot) => { value.map.title = 'Tampered'; },
      (value: typeof snapshot) => { value.provenance.owner = 'did:web:identity.example.test:users:another'; },
      (value: typeof snapshot) => { value.provenance.connector_id = 'd'.repeat(32); },
      (value: typeof snapshot) => { value.provenance.saved_at = '2026-11-08T18:01:00.000Z'; },
      (value: typeof snapshot) => { value.provenance.revision = 'd'.repeat(32); },
      (value: typeof snapshot) => { value.provenance.sha256 = '0'.repeat(64); },
    ]) { const copy = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot; change(copy); corrupted(copy); }
    for (const expected of [{ owner: 'other' }, { connector_id: 'd'.repeat(32) }, { course_id: 'other' }, { version: 3 }]) {
      expect(() => validateLearningCourseMapSnapshot(snapshot, expected)).toThrowError(expect.objectContaining({ status: 503 }));
    }
    const minimal = createLearningCourseMapSnapshot({ schema_version: 1, course_id: 'course-alpha', version: 0 }, save());
    const copy = JSON.parse(JSON.stringify(minimal)) as Record<string, Record<string, unknown>>; delete copy['map']!['release_quiz_review']; corrupted(copy);
    corrupted({ ...snapshot, trusted: true });
  });
  it('requires server save metadata with a canonical human owner, connector, UTC event and revision', () => {
    for (const bad of [{ ...save(), owner: 'a-browser-label' }, { ...save(), owner: 'did:web:identity.example.test:agents:agent' },
      { ...save(), connector_id: 'another connector' }, { ...save(), saved_at: '2026-11-08T18:00:00Z' },
      { ...save(), saved_at: '2026-02-30T18:00:00.000Z' }, { ...save(), revision: 'arbitrary' }]) {
      expect(() => createLearningCourseMapSnapshot(map(), bad)).toThrowError(expect.objectContaining({ status: 400 }));
    }
    rejects({ ...map(), provenance: save() });
  });
});
