import { afterAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import AdmZip from 'adm-zip';
import { attachAgentScormArtifacts, hashScormAnswer, scormArtifactManifest, scormArtifactZip, scormScoFilename, scormScoHtml } from '../applications/foxxi-content-intelligence/src/scorm-artifacts.js';
import { generateScormZip, generateAuHtml, generateCmi5Xml } from '../applications/foxxi-content-intelligence/src/content-package.js';
import { attachContentDeliveryRoutes, _publishedCourses, _publishedJobAids, type ContentPublicationSource, type ContentPublicationStore } from '../applications/foxxi-content-intelligence/src/content-delivery.js';
import type { Course } from '../applications/foxxi-content-intelligence/src/emergent-content.js';
import { courseHmd } from '../applications/foxxi-content-intelligence/src/hypermedia.js';
import { foxxiAffordances } from '../applications/foxxi-content-intelligence/affordances.js';
import { parseHypermediaMarkdown } from '@interego/core';
import { PodKeyValueStore } from '../applications/foxxi-content-intelligence/src/pod-kv-store.js';
import { loadLatestSnapshot } from '../applications/foxxi-content-intelligence/src/pod-snapshot-publisher.js';
import type { IRI } from '@interego/core';

const composedCourse = { id: 'durable-composed', title: 'Composed', competency: 'Check artifacts', syntagm: [{ paradigm: [{ id: 'module', title: 'Module', syntagm: [{ paradigm: [{ id: 'lesson', title: 'Lesson', competency: 'Check artifacts', syntagm: [{ paradigm: [{ modality: 'assessment-item', level: 'test', body: 'Marker? ::: alpha' }] }] }] }] }] }], moveOn: 'Passed' } as unknown as Course;

const course = { courseId: 'integrity-test', title: 'Artifact integrity', authoredBy: 'did:web:tester.example', masteryScore: 1,
  scos: [{ id: 'heldout-ten', title: 'Assessment', body: 'Answer both questions.', assessment: [
    { question: 'First disclosed marker?', answerHash: hashScormAnswer('alpha') },
    { question: 'Second disclosed marker?', answerHash: hashScormAnswer('beta') },
  ] }] };
const rte = readFileSync(new URL('../deploy/foxxi-scorm-player/site/scorm-rte.js', import.meta.url), 'utf8');
const servers: Server[] = [];
const windows: JSDOM[] = [];
afterAll(async () => { for (const d of windows) d.window.close(); await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))); });
async function serve(app: express.Express): Promise<string> {
  const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server); return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
interface Api { Initialize(p: string): string; SetValue(k: string, v: string): string; GetValue(k: string): string; Commit(p: string): string; Terminate(p: string): string; GetLastError(): string }
function runSco(html: string, failure?: 'Initialize' | 'SetValue' | 'Commit' | 'Terminate' | 'no-api') {
  const committed: Record<string, string>[] = [];
  const dom = new JSDOM(html, { url: 'https://lms.example/course/sco.html', runScripts: 'dangerously', beforeParse(w) {
    Object.defineProperty(w, 'crypto', { value: webcrypto });
    Object.defineProperty(w, 'TextEncoder', { value: TextEncoder });
    Object.defineProperty(w, 'AbortSignal', { value: AbortSignal });
    Object.defineProperty(w, '__foxxiPlayerConfig', { value: { bridge: 'https://lrs.example', courseIri: 'https://course.example', learnerDid: 'did:web:tester.example', registration: 'test-registration' } });
    Object.defineProperty(w, 'fetch', { value: async () => ({ ok: true, status: 204 }) });
    if (failure === 'no-api') return;
    w.eval(rte);
    const api = (w as unknown as { API_1484_11: Api }).API_1484_11;
    const original = api.Commit.bind(api);
    api.Commit = p => { committed.push(Object.fromEntries(['cmi.score.scaled', 'cmi.success_status', 'cmi.completion_status'].map(k => [k, api.GetValue(k)]))); return original(p); };
    if (failure) api[failure] = () => 'false';
  } });
  windows.push(dom);
  return { dom, committed, async submit(answers: string[]) {
    [...dom.window.document.querySelectorAll('input')].forEach((e, i) => { e.value = answers[i] ?? ''; });
    dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toMatch(/Recorded:|Could not finish/);
  } };
}

describe('the emitted SCORM artifact, executed against the shipped RTE', () => {
  it.each([['wrong', 'wrong', '0', 'failed'], ['alpha', 'wrong', '0.5', 'failed'], ['ALPHA', 'beta', '1', 'passed']])('scores %s / %s as %s and %s', async (a, b, score, success) => {
    const zip = new AdmZip(scormArtifactZip(course));
    const sco = runSco(zip.readAsText('sco-heldout-ten.html'));
    await sco.submit([a!, b!]);
    expect(sco.committed).toEqual([{ 'cmi.score.scaled': score, 'cmi.success_status': success, 'cmi.completion_status': 'completed' }]);
  });
  it.each(['SetValue', 'Commit', 'Terminate'] as const)('does not report success when %s refuses', async failure => {
    const sco = runSco(scormScoHtml(course, course.scos[0]!), failure);
    await sco.submit(['alpha', 'beta']);
    expect(sco.dom.window.document.querySelector('#status')!.textContent).toContain('Could not finish recording');
    expect(sco.dom.window.document.querySelector('#status')!.textContent).not.toContain('Recorded:');
  });
  it('records completion without inventing a score or passed outcome for an unassessed SCO', async () => {
    const unassessed = { ...course, scos: [{ id: 'reading', title: 'Reading', body: 'Read this guidance.' }] };
    const sco = runSco(scormScoHtml(unassessed, unassessed.scos[0]!));
    await sco.submit([]);
    expect(sco.committed).toEqual([{ 'cmi.score.scaled': '', 'cmi.success_status': 'unknown', 'cmi.completion_status': 'completed' }]);
    expect(sco.dom.window.document.querySelector('#status')!.textContent).toBe('Recorded: completed. No assessment score.');
  });
  it('matches the native player normalization and salient-token answer rule', async () => {
    const sco = runSco(scormScoHtml(course, course.scos[0]!));
    await sco.submit(['The answer is ALPHA!', '  BETA.  ']);
    expect(sco.committed[0]!['cmi.score.scaled']).toBe('1');
  });
  it.each(['Initialize', 'no-api'] as const)('cannot submit in %s mode', failure => {
    const sco = runSco(scormScoHtml(course, course.scos[0]!), failure);
    expect((sco.dom.window.document.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(sco.committed).toEqual([]);
  });
  it('renders authored content as text without executing it', () => {
    const c = { ...course, scos: [{ ...course.scos[0]!, body: '</script><script>window.pwned=true</script>' }] };
    const sco = runSco(scormScoHtml(c, c.scos[0]!));
    expect((sco.dom.window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(sco.dom.window.document.querySelector('#body')!.textContent).toBe(c.scos[0]!.body);
  });
  it('rejects filename collisions and incomplete assessments instead of emitting corrupt packages', () => {
    expect(() => scormArtifactZip({ ...course, scos: ['one two', 'one-two'].map(id => ({ id, title: id, body: '' })) })).toThrow(/collide/);
    expect(() => scormArtifactZip({ ...course, scos: [{ ...course.scos[0]!, assessment: [{ question: '?', answerHash: '' }] }] })).toThrow(/verifier/);
  });
});

describe('course links resolve to the actual package contents', () => {
  it('follows every HMD artifact link, resolves every manifest file and compares served SCO bytes to ZIP entries', async () => {
    const app = express();
    attachAgentScormArtifacts(app, async id => id === course.courseId ? course : null);
    const base = await serve(app);
    const hmd = courseHmd(course, base, base + '/player', foxxiAffordances.find(a => a.toolName === 'foxxi.scorm_launch')!);
    const links = parseHypermediaMarkdown(hmd).links!;
    const manifestUrl = links.find(l => l.label === 'imsmanifest.xml')!.href;
    const response = await fetch(manifestUrl);
    expect(response.status).toBe(200);
    const xml = await response.text();
    const manifestDom = new JSDOM(xml, { contentType: 'application/xml' }); windows.push(manifestDom);
    const zipResponse = await fetch(links.find(l => l.type === 'application/zip')!.href);
    expect(zipResponse.headers.get('content-type')).toContain('application/zip');
    const zip = new AdmZip(Buffer.from(await zipResponse.arrayBuffer()));
    expect(zip.readAsText('imsmanifest.xml')).toBe(xml);
    for (const file of manifestDom.window.document.querySelectorAll('resource, file')) {
      const path = file.getAttribute('href')!;
      expect(zip.getEntry(path)).not.toBeNull();
      const result = await fetch(new URL(path, manifestUrl));
      expect(result.status).toBe(200); expect(result.headers.get('content-type')).toContain('text/html');
      expect(await result.text()).toBe(zip.readAsText(path));
    }
    const encoded = await (await fetch(links.find(l => l.label === 'SCORM package bytes and digest')!.href)).json() as { data: string; byteLength: number };
    expect(Buffer.from(encoded.data, 'base64')).toHaveLength(encoded.byteLength);
    expect(new AdmZip(Buffer.from(encoded.data, 'base64')).readAsText('imsmanifest.xml')).toBe(xml);
    expect((await fetch(`${base}/agent/scorm/course/${course.courseId}/missing.html`)).status).toBe(404);
    expect((await fetch(`${base}/agent/scorm/course/missing/imsmanifest.xml`)).status).toBe(404);
    const legacy = new JSDOM(scormArtifactManifest(course, `${base}/agent/scorm/course/${course.courseId}/`), { contentType: 'application/xml' }); windows.push(legacy);
    expect((await fetch(legacy.window.document.querySelector('resource')!.getAttribute('href')!)).status).toBe(200);
  });
  it('wires production artifact reads to the existing authoritative course resolver', () => {
    const source = readFileSync(new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('attachAgentScormArtifacts(app, resolveCourseForRead)');
    expect(source).toContain('return scormArtifactManifest(course)');
  });
  it('the other course model exports an assessment that can fail', async () => {
    const composed = { id: 'composed', title: 'Composed', syntagm: [{ paradigm: [{ id: 'module', title: 'Module', syntagm: [{ paradigm: [{ id: 'lesson', title: 'Lesson', competency: 'Check artifacts', syntagm: [{ paradigm: [{ modality: 'assessment-item', level: 'test', body: 'Marker? ::: alpha' }] }] }] }] }] }] } as unknown as Course;
    const zip = new AdmZip(generateScormZip(composed));
    const sco = runSco(zip.readAsText(scormScoFilename('lesson')));
    await sco.submit(['wrong']);
    expect(sco.committed[0]!['cmi.success_status']).toBe('failed');
  });
});

describe('delivery claims require an actual delivery', () => {
  it('does not report delivery or record experience when no transport sent anything', async () => {
    const statements: unknown[] = [];
    const app = express(); app.use(express.json());
    attachContentDeliveryRoutes(app, { selfBaseUrl: 'https://foxxi.example', authoritativeSource: 'https://owner.example', authorizeInstrumentation: () => true, emitStatement: s => { statements.push(s); } });
    const base = await serve(app);
    const r = await fetch(base + '/content/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'chat', learner: 'did:web:tester.example', unit: { title: 'A reference', kind: 'reference', blocks: [{ text: 'Read this.' }] } }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ rendered: true, delivered: false, instrumented: false, transport: { sent: false } });
    expect(statements).toEqual([]);
  });
});

describe('publication survives cache loss and refuses storage failures', () => {
  it('restores the ZIP, AU and job aid from persisted source after clearing all artifact caches', async () => {
    const source = new Map<string, ContentPublicationSource>();
    const store: ContentPublicationStore = { get: async key => source.get(key) ?? null, put: async (key, value) => { source.set(key, structuredClone(value)); return { descriptorUrl: 'https://pod.example/descriptor' }; } };
    const app = express(); app.use(express.json());
    const base = await serve(app);
    attachContentDeliveryRoutes(app, { selfBaseUrl: base, authoritativeSource: 'https://owner.example', publicationStore: store });
    const post = async (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const created = await (await post('/content/publish-course', { course: composedCourse })).json() as { persisted: boolean; artifacts: { scormZip: string; cmi5Xml: string }; aus: { auUrl: string }[] };
    expect(created.persisted).toBe(true);
    const aid = await (await post('/content/job-aid', { competencyPoint: 'Artifact checks', body: 'Verify every file.' })).json() as { url: string; persisted: boolean };
    expect(aid.persisted).toBe(true);
    const zipBefore = new AdmZip(Buffer.from(await (await fetch(created.artifacts.scormZip)).arrayBuffer()));
    _publishedCourses().clear(); _publishedJobAids().clear();
    const zipAfter = new AdmZip(Buffer.from(await (await fetch(created.artifacts.scormZip)).arrayBuffer()));
    for (const entry of zipBefore.getEntries()) expect(zipAfter.readFile(entry.entryName)).toEqual(entry.getData());
    expect((await fetch(created.aus[0]!.auUrl)).status).toBe(200);
    expect((await fetch(created.artifacts.cmi5Xml)).status).toBe(200);
    expect(await (await fetch(aid.url)).text()).toContain('Verify every file.');
  });
  it('does not claim publication or absence when storage is unavailable', async () => {
    const store: ContentPublicationStore = { get: async () => { throw new Error('read refused'); }, put: async () => { throw new Error('write refused'); } };
    const app = express(); app.use(express.json());
    attachContentDeliveryRoutes(app, { selfBaseUrl: 'https://foxxi.example', authoritativeSource: 'https://owner.example', publicationStore: store });
    const base = await serve(app);
    const publication = await fetch(base + '/content/publish-course', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ course: { ...composedCourse, id: 'storage-refusal' } }) });
    expect(publication.status).toBe(503); expect(await publication.json()).not.toHaveProperty('published', true);
    expect((await fetch(base + '/content/package/missing-pub/scorm.zip')).status).toBe(503);
  });
  it('the pod store distinguishes 404 from an unavailable or corrupt payload', async () => {
    for (const [status, body] of [[404, ''], [503, 'unavailable'], [200, 'not a payload']] as const) {
      const store = new PodKeyValueStore<{ id: string }>({ podUrl: 'https://pod.example/', authoritativeSource: 'https://owner.example' as IRI, typeIri: 'https://schema.org/CreativeWork' as IRI, containerPath: 'artifacts/', iriPrefix: 'urn:artifact:', strictReads: true, fetch: async () => new Response(body, { status }) });
      if (status === 404) expect(await store.get('missing')).toBeNull();
      else await expect(store.get('missing')).rejects.toThrow();
    }
  });
});

describe('cmi5 artifacts honor launch and scoring conditions', () => {
  it('retries an interrupted submission without duplicating or changing its outcome', async () => {
    const statements: Array<{ id: string; verb: { id: string }; result?: { score?: { scaled: number } } }> = [];
    let refused = false;
    const html = generateAuHtml('Course', { id: 'retry', title: 'Retry', competency: 'Check', fragments: [{ modality: 'assessment-item', level: 'test', body: 'Marker? ::: alpha' }] });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://foxxi.example/au?fetch=https://foxxi.example/token&endpoint=https://lrs.example/&activityId=https://course.example/retry', beforeParse(w) {
      Object.defineProperty(w, 'fetch', { value: async (url: string, init?: RequestInit) => {
        if (String(url).includes('/token')) return { ok: true, json: async () => ({ 'auth-token': 'test-token' }) };
        const statement = JSON.parse(String(init?.body)); statements.push(statement);
        if (statement.verb.id.endsWith('/completed') && !refused) { refused = true; return { ok: false, status: 503 }; }
        return { ok: true, status: 204 };
      } });
    } }); windows.push(dom);
    const button = dom.window.document.querySelector('button') as HTMLButtonElement;
    await expect.poll(() => button.disabled).toBe(false);
    const input = dom.window.document.querySelector('input') as HTMLInputElement; input.value = 'alpha'; button.click();
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('Could not record completion');
    input.value = 'wrong'; button.click();
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('scored 100% (passed)');
    expect(statements.filter(s => s.verb.id.endsWith('/passed'))).toHaveLength(1);
    expect(statements.filter(s => s.verb.id.endsWith('/failed'))).toHaveLength(0);
    const completions = statements.filter(s => s.verb.id.endsWith('/completed'));
    expect(completions).toHaveLength(2); expect(completions[0]).toEqual(completions[1]);
    expect(completions[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([['wrong', 0, 'failed'], ['The answer is ALPHA!', 1, 'passed']] as const)('grades %s using the native answer rule', async (answer, score, outcome) => {
    const statements: Array<{ verb: { id: string }; result?: { score?: { scaled: number }; success?: boolean } }> = [];
    const html = generateAuHtml('Course', { id: 'assessment', title: 'Assessment', competency: 'Check', fragments: [{ modality: 'assessment-item', level: 'test', body: 'Marker? ::: alpha' }] });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://foxxi.example/au?fetch=https://foxxi.example/token&endpoint=https://lrs.example/&activityId=https://course.example/assessment', beforeParse(w) {
      Object.defineProperty(w, 'fetch', { value: async (url: string, init?: RequestInit) => {
        if (String(url).includes('/token')) return { ok: true, json: async () => ({ 'auth-token': 'test-token' }) };
        statements.push(JSON.parse(String(init?.body))); return { ok: true, status: 204 };
      } });
    } }); windows.push(dom);
    const button = dom.window.document.querySelector('button') as HTMLButtonElement;
    await expect.poll(() => button.disabled).toBe(false);
    (dom.window.document.querySelector('input') as HTMLInputElement).value = answer; button.click();
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('Assessment submitted');
    const graded = statements.find(s => s.verb.id.endsWith('/' + outcome))!;
    expect(graded.result?.score?.scaled).toBe(score); expect(graded.result?.success).toBe(outcome === 'passed');
  });
  it('records an unassessed lesson as completed without emitting a pass or perfect score', async () => {
    const statements: Array<{ verb: { id: string }; result?: Record<string, unknown> }> = [];
    const html = generateAuHtml('Course', { id: 'reading', title: 'Reading', competency: 'Check', fragments: [{ modality: 'text', level: 'test', body: 'Read.' }] });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://foxxi.example/au?fetch=https://foxxi.example/token&endpoint=https://lrs.example/&activityId=https://course.example/reading&registration=reg&actor=%7B%22objectType%22%3A%22Agent%22%2C%22mbox%22%3A%22mailto%3Atest%40example.com%22%7D', beforeParse(w) {
      Object.defineProperty(w, 'fetch', { value: async (url: string, init?: RequestInit) => {
        if (String(url).includes('/token')) return { ok: true, json: async () => ({ 'auth-token': 'test-token' }) };
        statements.push(JSON.parse(String(init?.body))); return { ok: true, status: 204 };
      } });
    } }); windows.push(dom);
    const button = dom.window.document.querySelector('button') as HTMLButtonElement;
    await expect.poll(() => button.disabled).toBe(false); button.click();
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('Lesson completed');
    expect(statements.map(s => s.verb.id.split('/').pop())).toEqual(['initialized', 'completed', 'terminated']);
    expect(statements.find(s => s.verb.id.endsWith('/completed'))!.result).toEqual({ completion: true });
    expect(statements.every(s => !s.result?.score && s.result?.success === undefined)).toBe(true);
  });
  it('declares the same mastery threshold that its runnable assessment uses', () => {
    const xml = generateCmi5Xml(composedCourse, () => 'https://foxxi.example/au');
    expect(xml).toContain('masteryScore="0.6"');
  });
  it('cannot submit after a failed token exchange', async () => {
    let requests = 0;
    const html = generateAuHtml('Course', { id: 'lesson', title: 'Lesson', competency: 'Check', fragments: [{ modality: 'text', level: 'test', body: 'Read.' }] });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://foxxi.example/au?fetch=https://foxxi.example/token', beforeParse(w) { Object.defineProperty(w, 'fetch', { value: async () => { requests++; return { ok: false, status: 401 }; } }); } }); windows.push(dom);
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('cmi5 launch failed');
    expect((dom.window.document.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    (dom.window.document.querySelector('button') as HTMLButtonElement).click(); expect(requests).toBe(1);
  });
});


describe('pod publishers read their own persisted bytes', () => {
  it('rehydrates a cold key-value store and snapshot using full-IRI bundle predicates', async () => {
    const files = new Map<string, string>();
    const transport: typeof fetch = async (url, init) => {
      const key = String(url);
      if (init?.method === 'PUT') { files.set(key, String(init.body)); return new Response(null, { status: 201 }); }
      if (init?.method === 'PATCH' || init?.method === 'POST') return new Response(null, { status: 204 });
      return files.has(key) ? new Response(files.get(key), { headers: { etag: '"stored"' } }) : new Response('', { status: 404 });
    };
    const config = { podUrl: 'https://pod.example/', authoritativeSource: 'https://owner.example' as IRI, typeIri: 'https://schema.org/CreativeWork' as IRI, containerPath: 'artifacts/', iriPrefix: 'urn:artifact:', strictReads: true, fetch: transport };
    const value = { title: 'A persisted artifact', nested: { content: 'Unicode ✓' } };
    const writer = new PodKeyValueStore<typeof value>(config);
    const published = await writer.put('read-back', value);
    expect(await new PodKeyValueStore<typeof value>(config).get('read-back')).toEqual(value);
    files.set('https://pod.example/foxxi/snapshots/integrity-snapshot-graph.trig', files.get(published.graphUrl)!);
    expect(await loadLatestSnapshot('integrity', config)).toEqual(value);
    await writer.delete('read-back');
    expect(await new PodKeyValueStore<typeof value>(config).get('read-back')).toBeNull();
  });
});

describe('runtime acknowledgement and recovery', () => {
  it('retains failed records across a reload, retries identical IDs and does not duplicate commit/terminate outcomes', async () => {
    let accepting = false;
    const accepted: string[] = [], requests: string[] = [];
    function runtime(saved?: string) {
      const dom = new JSDOM('', { url: 'https://lms.example', runScripts: 'dangerously' }); windows.push(dom);
      const w = dom.window;
      Object.defineProperty(w, 'crypto', { value: webcrypto }); Object.defineProperty(w, 'AbortSignal', { value: AbortSignal });
      Object.defineProperty(w, '__foxxiPlayerConfig', { value: { bridge: 'https://lrs.example', courseIri: 'https://course.example', learnerDid: 'did:web:tester.example', registration: 'retry-registration' } });
      Object.defineProperty(w, 'fetch', { value: async (_url: string, init: { body: string }) => { const id = (JSON.parse(init.body) as { id: string }).id; requests.push(id); if (accepting) accepted.push(id); return { ok: accepting, status: accepting ? 204 : 503 }; } });
      if (saved) { const [key, value] = JSON.parse(saved) as [string, string]; w.localStorage.setItem(key, value); }
      w.eval(rte); return { dom, api: (w as unknown as { API_1484_11: Api & { __foxxiFlush(): Promise<void> } }).API_1484_11 };
    }
    const first = runtime(); expect(first.api.Initialize('')).toBe('true');
    await expect(first.api.__foxxiFlush()).rejects.toThrow('503');
    first.api.SetValue('cmi.completion_status', 'completed'); first.api.SetValue('cmi.success_status', 'passed'); first.api.SetValue('cmi.score.scaled', '1');
    expect(first.api.Commit('')).toBe('true'); expect(first.api.Terminate('')).toBe('true');
    await expect(first.api.__foxxiFlush()).rejects.toThrow('503');
    const key = first.dom.window.localStorage.key(0)!;
    const saved = first.dom.window.localStorage.getItem(key)!;
    const queued = JSON.parse(saved) as { outbox: { statement: { id: string; verb: { id: string } } }[] };
    expect(queued.outbox).toHaveLength(4);
    const second = runtime(JSON.stringify([key, saved])); accepting = true;
    await second.api.__foxxiFlush();
    expect(accepted).toEqual(queued.outbox.map(x => x.statement.id));
    expect(new Set(accepted).size).toBe(4); expect(requests[0]).toBe(accepted[0]);
    await second.api.__foxxiFlush(); expect(accepted).toHaveLength(4);
  });
});

describe('the slide player reports only acknowledged completion', () => {
  it.each([false, true])('handles bearer=%s without claiming a passed assessment', async authenticated => {
    let accepting = false;
    const statements: { id: string; verb: { id: string }; result?: { success?: boolean; score?: unknown } }[] = [];
    const markup = readFileSync(new URL('../deploy/foxxi-scorm-player/site/index.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../deploy/foxxi-scorm-player/site/player.js', import.meta.url), 'utf8');
    const dom = new JSDOM(markup, { runScripts: 'outside-only', url: 'https://player.example/' + (authenticated ? '?bearer=test-session' : '') }); windows.push(dom);
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    Object.defineProperty(dom.window, 'fetch', { value: async (_url: string, init: { body: string }) => { const statement = JSON.parse(init.body) as typeof statements[number]; statements.push(statement); return { ok: accepting, status: accepting ? 200 : 503, text: async () => 'unavailable', json: async () => [statement.id] }; } });
    dom.window.eval(script);
    await expect.poll(() => dom.window.document.querySelector('#progress')!.textContent).toContain('viewed 1');
    const count = dom.window.document.querySelectorAll('#toc li').length;
    for (let i = 1; i < count; i++) { (dom.window.document.querySelector('#btn-next') as HTMLButtonElement).click(); await expect.poll(() => dom.window.document.querySelector('#progress')!.textContent).toContain(`viewed ${i + 1}`); }
    const button = dom.window.document.querySelector('#btn-complete') as HTMLButtonElement;
    button.click(); await expect.poll(() => button.textContent).toContain(authenticated ? 'Recording failed' : 'Preview complete');
    expect(button.disabled).toBe(false);
    if (authenticated) { accepting = true; button.click(); await expect.poll(() => button.textContent).toBe('✓ Completion recorded'); expect(button.disabled).toBe(true); }
    expect(statements.some(s => s.verb.id.endsWith('/passed'))).toBe(false);
    const completions = statements.filter(s => s.verb.id.endsWith('/completed'));
    for (const s of completions) { expect(s.result?.success).toBeUndefined(); expect(s.result?.score).toBeUndefined(); }
    if (authenticated) expect(completions[0]!.id).toBe(completions[1]!.id);
    else expect(statements).toEqual([]);
  });
});
