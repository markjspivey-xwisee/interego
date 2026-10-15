/**
 * Exercise the actual authored-course HTTP handler without importing the listening server.
 * The pod-composition transport is controlled so acknowledgement, refusal and absent receipts
 * are checked at their real async boundary. No course, statement or pod is written by these tests.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Receipt = { persisted: boolean; holonUri: string; persistError?: string };
type Reply = { status: number; body: Record<string, unknown> };
interface TestResponse {
  status(code: number): TestResponse;
  json(body: Record<string, unknown>): TestResponse;
}
type Handler = (req: Record<string, unknown>, res: TestResponse) => Promise<void>;
const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
const first = server.indexOf("app.post('/agent/scorm/author',");
const next = server.indexOf("app.post('/agent/scorm/launch',", first + 1);
if (first < 0 || next <= first) throw new Error('The actual SCORM author route was not found.');
const javascript = ts.transpileModule(server.slice(first, next), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function route(compose: () => Promise<Receipt | null>) {
  const replies: Reply[] = [];
  let code = 200, handler: Handler | undefined;
  const response: TestResponse = {
    status(value) { code = value; return this; },
    json(body) { replies.push({ status: code, body }); return this; },
  };
  const course = { courseId: 'persistence-response-fixture', title: 'Persistence response fixture',
    scos: [{ id: 'section-one', title: 'One section', body: 'Test fixture content only.' }] };
  const author = 'did:ethr:0x2222222222222222222222222222222222222222';
  const dependencies = {
    verifyDelegatedCaller: async () => ({ ok: true, callerDid: author, payload: { course } }),
    checkAgenticRateLimit: () => ({ ok: true }),
    COURSE_LIMITS: { sections: 100, body: 20000, questions: 40 },
    QuestionError: Error,
    authorQuestion: (value: unknown) => value,
    parseManifest: () => ({}),
    buildAgentScormManifest: () => '<manifest/>',
    courseAuthors: new Map<string, string>(),
    loadCourseAuthors: async () => undefined,
    seatScormCourse: () => undefined,
    selfBoundPod: () => 'https://pod.example/author/',
    recordCourseAuthor: () => undefined,
    courseIri: (id: string) => 'https://bridge.example/agent/scorm/course/' + id,
    emitAgentActivity: async () => 'fixture-authored-statement',
    AUTHORED_VERB: 'urn:test:authored',
    composeIntoSharedLattice: compose,
    actorForPod: () => 'fixture-author',
    MESH_ACTOR_LABELS: {},
    sendActionResult: (_request: unknown, res: TestResponse, body: Record<string, unknown>) => res.json(body),
    bridgeBaseUrl: 'https://bridge.example',
    activeAffordances: [],
    sendServerError: (_res: unknown, error: unknown) => { throw error; },
  };
  const bindings = Object.keys(dependencies).join(',');
  new Function('app', 'dependencies', 'const {' + bindings + '} = dependencies;\n' + javascript)(
    { post(path: string, value: Handler) {
      if (path !== '/agent/scorm/author') throw new Error('Unexpected route: ' + path);
      handler = value;
    } }, dependencies);
  return {
    replies,
    async invoke() {
      if (!handler) throw new Error('No actual route handler was installed.');
      await handler({ body: { course }, headers: {}, ip: '127.0.0.1' }, response);
    },
  };
}

describe('SCORM author response follows actual pod persistence', () => {
  it('does not acknowledge a pending compose, and refuses its failed receipt unchanged', async () => {
    let release!: (value: Receipt | null) => void;
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<Receipt | null>(resolve => { release = resolve; });
    const h = route(() => { entered(); return pending; });
    const run = h.invoke();
    await called;
    expect(h.replies).toEqual([]);
    const receipt = { persisted: false, holonUri: 'urn:test:course', persistError: 'pod refused the conditional write' };
    release(receipt);
    await run;
    expect(h.replies).toEqual([{ status: 503, body: expect.objectContaining({
      ok: false, code: 'persistence-unconfirmed', manifestValid: true,
      authoredStatementId: 'fixture-authored-statement', sharedLattice: receipt,
    }) }]);
    expect(h.replies[0].body).not.toHaveProperty('durable');
  });

  it('does not turn an absent composition receipt into success or a durable destination', async () => {
    const h = route(async () => null);
    await h.invoke();
    expect(h.replies[0]).toEqual({ status: 503, body: expect.objectContaining({
      ok: false, code: 'persistence-unconfirmed', manifestValid: true,
    }) });
    expect(h.replies[0].body).not.toHaveProperty('durable');
    expect(h.replies[0].body).not.toHaveProperty('sharedLattice');
  });

  it('acknowledges a confirmed composition and preserves its real receipt', async () => {
    const receipt = { persisted: true, holonUri: 'urn:test:course' };
    const h = route(async () => receipt);
    await h.invoke();
    expect(h.replies).toEqual([{ status: 200, body: expect.objectContaining({
      ok: true, durable: 'https://pod.example/author/', manifestValid: true,
      courseId: 'persistence-response-fixture', sharedLattice: receipt,
    }) }]);
  });
});
