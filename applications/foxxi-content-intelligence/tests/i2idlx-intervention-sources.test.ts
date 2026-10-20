import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { filesOfZip, type ImportedPackage } from '../src/package-import.js';
import { readAnyPackage } from '../src/tool-exports.js';
import { publicAuthoredIntervention, publicPackageIntervention } from '../src/i2idlx-intervention-sources.js';

const base = 'https://bridge.example/';
const sha = 'a'.repeat(64);

describe('read-only intervention source projections', () => {
  it('reads the committed Golf SCORM ZIP into instructional source context without exposing its question banks', () => {
    const bytes = readFileSync(new URL('../imported/golf-explained.zip', import.meta.url));
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    const root = `https://bridge.example/scorm/packages/${actualSha}`;
    const imported = readAnyPackage(filesOfZip(new AdmZip(bytes)), {
      fileUrl: path => `${root}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
    });
    const result = publicPackageIntervention(imported, actualSha, base);
    expect(imported.title).toBe('Golf Explained - CP Single SCO');
    expect(imported.topics.flatMap(topic => topic.questions)).toHaveLength(15);
    expect(result).toMatchObject({
      id: actualSha, title: imported.title, kind: 'Hosted package', source_uri: root, version: `sha256:${actualSha}`,
    });
    expect(result.sections).toHaveLength(14);
    const courseCare = result.sections.find(section => section.id === 'Etiquette/Course.html');
    expect(courseCare).toMatchObject({
      title: 'Etiquette - Care For the Course', locator: 'Etiquette/Course.html',
      source_uri: `${root}/files/Etiquette/Course.html`,
    });
    expect(courseCare?.body).toContain('Golf carts are considered a convenience');
    expect(result.sections.every(section => Object.keys(section).sort().join(',') === 'body,id,locator,source_uri,title')).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['id', 'kind', 'missing_context', 'sections', 'source_uri', 'title', 'version']);
    expect(JSON.stringify(result)).not.toContain('When another player is attempting a shot, it is best to stand:');
    expect(JSON.stringify(result)).not.toMatch(/"(?:questions|answers|answer|answerHash|correctAnswer|verifiers|blind)"\s*:/);
  });

  it('projects authored instructional sections without accessing assessments or outcome metadata', () => {
    const section = { id: 'record', title: 'Record a task', body: 'Retain the observed task result.' };
    Object.defineProperty(section, 'assessment', { get() { throw new Error('assessment must not be read'); } });
    const course = { courseId: 'learning data', title: 'Learning data', scos: [section] };
    Object.defineProperty(course, 'masteryScore', { get() { throw new Error('mastery must not be read'); } });
    Object.defineProperty(course, 'answerHash', { get() { throw new Error('verifier must not be read'); } });
    const result = publicAuthoredIntervention(course, base);
    expect(result).toEqual({
      id: 'learning data', title: 'Learning data', kind: 'SCORM course',
      source_uri: 'https://bridge.example/agent/scorm/course/learning%20data',
      sections: [{
        id: 'record', title: 'Record a task', body: section.body,
        source_uri: 'https://bridge.example/agent/scorm/course/learning%20data/sco-record.html', locator: 'record',
      }],
    });
  });

  it('never copies authored answers, hashes, explanations or unrelated properties', () => {
    const result = publicAuthoredIntervention({
      courseId: 'c', title: 'Course',
      scos: [{ id: 's', title: 'Section', body: 'A teaching passage.', assessment: [{
        question: 'HIDDEN_QUESTION', answerHash: 'b'.repeat(64), explanation: 'HIDDEN_EXPLANATION',
      }] }],
    }, base);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_|assessment|answerHash|bbbbbbbb/);
    expect(result.sections[0]!.body).toBe('A teaching passage.');
  });

  it('projects package pages and immutable source links without reading separate question banks', () => {
    const topic: ImportedPackage['topics'][number] = {
      id: 'intro', title: 'Introduction',
      pages: [{ path: 'intro/first page.html', title: 'First page', body: 'Observe the task before choosing an intervention.' }],
      get questions(): ImportedPackage['topics'][number]['questions'] { throw new Error('question bank must not be read'); },
    };
    const result = publicPackageIntervention({ title: 'Task support', topics: [topic], unread: [] }, sha, base);
    expect(result).toEqual({
      id: sha, title: 'Task support', kind: 'Hosted package',
      source_uri: `https://bridge.example/scorm/packages/${sha}`, version: `sha256:${sha}`,
      sections: [{
        id: 'intro/first page.html', title: 'First page', body: topic.pages[0]!.body,
        source_uri: `https://bridge.example/scorm/packages/${sha}/files/intro/first%20page.html`, locator: 'intro/first page.html',
      }],
    });
  });

  it('omits package question answers and unconverted resource details from the output', () => {
    const imported: ImportedPackage = {
      title: 'Package',
      topics: [{ id: 'intro', title: 'Introduction', pages: [{ path: 'intro.html', title: 'Intro', body: 'A public teaching passage.' }],
        questions: [{ question: 'HIDDEN_QUESTION', type: 'choice', options: ['HIDDEN_OPTION'], answer: 'HIDDEN_ANSWER' }] }],
      unread: [{ path: 'HIDDEN_PATH', why: 'HIDDEN_RAW_DATA' }],
    };
    const result = publicPackageIntervention(imported, sha, base);
    expect(result.sections).toHaveLength(1);
    expect(result.missing_context).toEqual(['1 package resource(s) were not converted into readable instructional pages.']);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN_|questions|options|blind|verifier/);
  });

  it('keeps missing instructional content explicit instead of using title or assessment text', () => {
    const authored = publicAuthoredIntervention({ courseId: 'c', title: 'Course title', scos: [{ id: 's', title: 'Title only', body: '  ' }] }, base);
    expect(authored.sections).toEqual([]);
    expect(authored.missing_context?.join(' ')).toContain('No authored instructional section bodies');
    const packaged = publicPackageIntervention({ title: 'Runtime-only package', topics: [{ id: 'a', title: 'Assessment', pages: [],
      questions: [{ question: 'HIDDEN_QUESTION', type: 'true-false', answer: true }] }], unread: [] }, sha, base);
    expect(packaged.sections).toEqual([]);
    expect(packaged.missing_context?.join(' ')).toContain('No readable instructional pages');
    expect(JSON.stringify(packaged)).not.toContain('HIDDEN_QUESTION');
  });

  it('keeps source paths inside the addressed package and omits duplicate/empty pages', () => {
    const pages = [
      { path: '../escape.html', title: 'Unsafe', body: 'UNSAFE_BODY' },
      { path: '/absolute.html', title: 'Unsafe', body: 'UNSAFE_BODY' },
      { path: 'lesson.html', title: 'Lesson', body: 'The teaching passage.' },
      { path: 'lesson.html', title: 'Duplicate', body: 'DUPLICATE_BODY' },
      { path: 'empty.html', title: 'Title only', body: '' },
    ];
    const result = publicPackageIntervention({ title: 'Package', topics: [{ id: 't', title: 'Topic', pages, questions: [] }], unread: [] }, sha, base);
    expect(result.sections.map(section => section.id)).toEqual(['lesson.html']);
    expect(JSON.stringify(result)).not.toMatch(/UNSAFE_BODY|DUPLICATE_BODY/);
    expect(result.missing_context?.join(' ')).toContain('2 parsed page path(s)');
  });

  it('rejects invalid package identity or a source base with credentials', () => {
    const imported: ImportedPackage = { title: 'Package', topics: [], unread: [] };
    expect(() => publicPackageIntervention(imported, 'not-a-sha', base)).toThrow(/SHA-256/);
    expect(() => publicPackageIntervention(imported, sha, 'https://user:secret@bridge.example/')).toThrow(/without credentials/);
  });
});
