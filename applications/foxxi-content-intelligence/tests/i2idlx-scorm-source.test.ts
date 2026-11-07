import { describe, expect, it, vi } from 'vitest';
import { readScormSource, SCORM_SOURCE_LIMITS, ScormSourceError, type ScormSourceInput } from '../src/i2idlx-scorm-source.js';

type Page = { path: string; title: string; body: string };
const pages: Page[] = [
  { path: 'lesson-a.html', title: 'Beacon fault procedure', body: '<h1>Beacon fault</h1><p>Set STANDBY, record BLUE-27 and notify the Orion desk.</p>' },
  { path: 'lesson-b.html', title: 'Resuming the exercise', body: '<h1>Resuming</h1><p>Resume only when the display says READY-9.</p>' },
  { path: 'quiz/lesson-c.html', title: 'Knowledge quiz', body: '<p>Hidden answer key: SECRET-ANSWER.</p>' },
];
function fixture(values: Page[] = pages, extras: Record<string, Buffer> = {}) {
  const manifest = '<manifest identifier="fixture"><organizations default="org"><organization identifier="org"><title>Published course</title>' +
    values.map((page, i) => `<item identifier="i${i}" identifierref="r${i}"><title>${page.title}</title></item>`).join('') +
    '</organization></organizations><resources>' + values.map((page, i) => `<resource identifier="r${i}" type="webcontent" href="${page.path}"><file href="${page.path}"/></resource>`).join('') +
    '</resources></manifest>';
  const files = new Map<string, Buffer>([['imsmanifest.xml', Buffer.from(manifest)], ...values.map(page => [page.path, Buffer.from('<html><head><title>' + page.title + '</title></head><body>' + page.body + '</body></html>')] as [string, Buffer]), ...Object.entries(extras)]);
  let list: unknown = { files: [...files].map(([path, data]) => ({ path, size: data.length, modified: '2026-11-07T00:00:00Z' })) };
  const request = vi.fn(async (path: string, _limit: number, _signal: AbortSignal): Promise<Buffer> => {
    if (path.endsWith('/asset/list')) return Buffer.isBuffer(list) ? list : Buffer.from(JSON.stringify(list));
    const url = new URL(path, 'https://cloud.scorm.com/api/v2');
    if (!url.pathname.endsWith('/asset')) throw new Error('Unexpected non-asset operation');
    const file = files.get(url.searchParams.get('relativePath') ?? '');
    if (!file) throw new Error('Unlisted file requested');
    return file;
  });
  const input = (question = 'What is the beacon fault procedure?', overrides: Partial<ScormSourceInput> = {}): ScormSourceInput => ({
    sourceScope: 'connection-alpha', courseId: 'owned-course', version: 0, title: 'Published course', question,
    signal: new AbortController().signal, request, ...overrides,
  });
  return { files, request, input, setList: (value: unknown) => { list = value; } };
}

describe('SCORM Cloud native source reader', () => {
  it('reads only the versioned manifest and question-matched lesson, without package or media export', async () => {
    const f = fixture(pages, { 'movie.mp4': Buffer.alloc(300_000) });
    const result = await readScormSource(f.input());
    expect(result.material.sections).toHaveLength(1);
    expect(result.material.sections[0]!.body).toContain('BLUE-27');
    expect(result.retrieval.fetched_files.map(file => file.path)).toEqual(['imsmanifest.xml', 'lesson-a.html']);
    expect(result.retrieval).toMatchObject({ listed_files: 5, candidate_files: 2, unselected_candidate_files: 1,
      excluded_assessment_files: 1, package_downloaded: false, retained_content: false, full_course_fingerprint: false });
    expect(f.request.mock.calls.map(call => call[0])).toEqual([
      '/courses/owned-course/versions/0/asset/list',
      '/courses/owned-course/versions/0/asset?relativePath=imsmanifest.xml',
      '/courses/owned-course/versions/0/asset?relativePath=lesson-a.html',
    ]);
    expect(result.material.missing_context.join(' ')).toContain('not a source-native natural-language search');
    expect(JSON.stringify(result)).not.toContain('SECRET-ANSWER');
  });

  it('binds identity to connection/course/version while separate projections vary by question', async () => {
    const f = fixture();
    const first = await readScormSource(f.input());
    const second = await readScormSource(f.input('When may I resume the exercise?'));
    expect(second.material.sections[0]!.body).toContain('READY-9');
    expect(second.material.id).toBe(first.material.id);
    expect(second.material.version).toBe('course-version:0');
    expect(second.projectionSha256).not.toBe(first.projectionSha256);
    expect(second.material.source_uri).toBe(first.material.source_uri);
    const other = await readScormSource(f.input(undefined, { sourceScope: 'connection-beta' }));
    expect(other.material.id).not.toBe(first.material.id);
    expect(other.material.source_uri).not.toBe(first.material.source_uri);
    expect(second.material.sections[0]!.source_uri).toContain(':file:lesson-b.html');
  });

  it('has no retained asset cache between calls, even for the same question', async () => {
    const f = fixture();
    const first = await readScormSource(f.input()), second = await readScormSource(f.input());
    expect(first.projectionSha256).toBe(second.projectionSha256);
    expect(f.request.mock.calls.filter(call => call[0].endsWith('/asset/list'))).toHaveLength(2);
    expect(f.request.mock.calls.filter(call => call[0].includes('relativePath=lesson-a.html'))).toHaveLength(2);
  });

  it('uses manifest titles to find distant generically-named lessons and does not infer adjacency', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: 'page-' + i + '.html', title: i === 17 ? 'Evacuation response' : 'Section ' + i,
      body: '<p>Instructional section ' + i + '</p>' }));
    const f = fixture(many);
    const result = await readScormSource(f.input('Explain the evacuation response.'));
    expect(result.retrieval.fetched_files.map(file => file.path)).toEqual(['imsmanifest.xml', 'page-17.html']);
    expect(result.graph.edges.every(edge => edge.relation === 'contains' || edge.relation === 'has-heading')).toBe(true);
    expect(JSON.stringify(result.graph)).not.toMatch(/prerequisite|next-in-source/);
  });

  it('excludes an assessment identified by its manifest title even when its filename looks instructional', async () => {
    const f = fixture([{ path: 'lesson-1.html', title: 'Final assessment', body: '<p>SECRET-ANSWER</p>' }, pages[0]!]);
    const result = await readScormSource(f.input('What is in the final assessment?'));
    expect(result.retrieval.excluded_assessment_files).toBe(1);
    expect(result.retrieval.fetched_files.map(row => row.path)).not.toContain('lesson-1.html');
    expect(JSON.stringify(result)).not.toContain('SECRET-ANSWER');
  });

  it('does not mistake the synthetic External Course Test title for an assessment', async () => {
    const f = fixture([{ path: 'index.html', title: 'I2IDL-X External Course Test', body: '<p>Record BLUE-27.</p>' }]);
    const result = await readScormSource(f.input('Which incident code should I record?'));
    expect(result.material.sections[0]!.body).toContain('BLUE-27');
    expect(result.retrieval.excluded_assessment_files).toBe(0);
  });

  it('caps the selected files at eight including the manifest, reporting omitted candidates', async () => {
    const f = fixture(Array.from({ length: 20 }, (_, i) => ({ path: 'page-' + i + '.html', title: 'Section ' + i, body: '<p>Section ' + i + '</p>' })));
    const result = await readScormSource(f.input('Unrelated vocabulary'));
    expect(result.retrieval.fetched_files).toHaveLength(8);
    expect(result.retrieval.unselected_candidate_files).toBe(13);
    expect(result.retrieval.total_bytes).toBe(result.retrieval.fetched_files.reduce((total, row) => total + row.bytes, 0));
    expect(result.retrieval.fetched_files.every(row => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
  });

  it.each(['../outside.html', '/root.html', 'folder\\file.html', 'https://example.com/a.html', 'a.html?key=x', 'a.html#part', 'a/%2e%2e/b.html', 'a//b.html', 'a/./b.html'])('refuses unsafe listed path %s before reading assets', async path => {
    const f = fixture(); f.setList({ files: [{ path, size: 20 }] });
    await expect(readScormSource(f.input())).rejects.toMatchObject({ code: 'course_source_invalid' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('refuses ambiguous case-folded paths and invalid file metadata', async () => {
    const duplicate = fixture(); duplicate.setList({ files: [{ path: 'lesson.html', size: 10 }, { path: 'LESSON.html', size: 10 }] });
    await expect(readScormSource(duplicate.input())).rejects.toMatchObject({ code: 'course_source_invalid' });
    const invalid = fixture(); invalid.setList({ files: [{ path: 'lesson.html', size: -1 }] });
    await expect(readScormSource(invalid.input())).rejects.toMatchObject({ code: 'course_source_invalid' });
  });

  it('refuses a file-list count or byte overflow before requesting assets', async () => {
    const count = fixture(); count.setList({ files: Array.from({ length: 2001 }, (_, i) => ({ path: 'file-' + i + '.html', size: 0 })) });
    await expect(readScormSource(count.input())).rejects.toMatchObject({ status: 413, code: 'course_source_too_large' });
    expect(count.request).toHaveBeenCalledTimes(1);
    const bytes = fixture(); bytes.setList(Buffer.alloc(SCORM_SOURCE_LIMITS.listBytes + 1));
    await expect(readScormSource(bytes.input())).rejects.toMatchObject({ status: 413 });
    expect(bytes.request).toHaveBeenCalledTimes(1);
  });

  it('refuses declared oversized selected files without requesting them', async () => {
    const f = fixture([{ path: 'big.html', title: 'Beacon fault', body: 'x'.repeat(SCORM_SOURCE_LIMITS.fileBytes + 1) }]);
    await expect(readScormSource(f.input())).rejects.toMatchObject({ status: 413, code: 'course_source_too_large' });
    expect(f.request.mock.calls.some(call => call[0].includes('relativePath=big.html'))).toBe(false);
    expect(f.request.mock.calls.every(call => !call[0].includes('/zip'))).toBe(true);
  });

  it('enforces actual returned byte size and consistent listing metadata', async () => {
    const overflow = fixture(); overflow.files.set('lesson-a.html', Buffer.alloc(SCORM_SOURCE_LIMITS.fileBytes + 1));
    await expect(readScormSource(overflow.input())).rejects.toMatchObject({ status: 413 });
    const changed = fixture(); changed.files.set('lesson-a.html', Buffer.from('<p>Changed after listing</p>'));
    await expect(readScormSource(changed.input())).rejects.toMatchObject({ status: 409, code: 'course_source_changed' });
  });

  it('enforces the aggregate budget before reading the next selected asset', async () => {
    const f = fixture(Array.from({ length: 5 }, (_, i) => ({ path: 'lesson-' + i + '.html', title: 'Beacon ' + i, body: '<p>' + 'x'.repeat(60_000) + '</p>' })));
    await expect(readScormSource(f.input())).rejects.toMatchObject({ status: 413 });
    expect(f.request.mock.calls.filter(call => call[0].includes('/asset?')).length).toBe(4); // manifest + three lessons
  });

  it('stops before any request when cancelled and withholds a result if cancellation occurs during a read', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(readScormSource(f.input(undefined, { signal: controller.signal }))).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.request).not.toHaveBeenCalled();
    const during = fixture(), active = new AbortController(), original = during.request.getMockImplementation()!;
    during.request.mockImplementation(async (path, limit, signal) => { const bytes = await original(path, limit, signal); if (path.includes('relativePath=lesson-a.html')) active.abort(); return bytes; });
    await expect(readScormSource(during.input(undefined, { signal: active.signal }))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('never retries an unsupported or unreadable source through a package export', async () => {
    const noManifest = fixture(); noManifest.setList({ files: [{ path: 'index.html', size: 4 }] });
    await expect(readScormSource(noManifest.input())).rejects.toBeInstanceOf(ScormSourceError);
    expect(noManifest.request).toHaveBeenCalledTimes(1);
    const noText = fixture([{ path: 'index.html', title: 'Beacon fault', body: '<script>window.player = true;</script>' }]);
    // The title itself is metadata; no instructional body is invented from it.
    await expect(readScormSource(noText.input())).rejects.toMatchObject({ code: 'course_source_unsupported' });
    expect(noText.request.mock.calls.every(call => !call[0].includes('/zip'))).toBe(true);
  });

  it('refuses document declarations and non-text selected assets', async () => {
    const dtd = fixture();
    const manifest = Buffer.from('<!DOCTYPE manifest [<!ENTITY x "value">]><manifest/>');
    dtd.files.set('imsmanifest.xml', manifest); dtd.setList({ files: [{ path: 'imsmanifest.xml', size: manifest.length }] });
    await expect(readScormSource(dtd.input())).rejects.toMatchObject({ code: 'course_source_unsupported' });
    const binary = fixture(); binary.files.set('lesson-a.html', Buffer.from([0xc0, 0xff, 0xfe]));
    binary.setList({ files: [...binary.files].map(([path, value]) => ({ path, size: value.length })) });
    await expect(readScormSource(binary.input())).rejects.toMatchObject({ code: 'course_source_unsupported' });
  });

  it('encodes course and asset identifiers only as native API parameters and accepts multiline questions', async () => {
    const f = fixture([{ path: 'lessons/beacon fault.html', title: 'Beacon fault', body: '<p>BLUE-27</p>' }]);
    const result = await readScormSource(f.input('Beacon\nfault?', { courseId: 'account/course?x=1' }));
    expect(f.request.mock.calls[0]![0]).toBe('/courses/account%2Fcourse%3Fx%3D1/versions/0/asset/list');
    expect(f.request.mock.calls[2]![0]).toContain('relativePath=lessons%2Fbeacon+fault.html');
    expect(result.material.sections[0]!.body).toContain('BLUE-27');
  });
});
