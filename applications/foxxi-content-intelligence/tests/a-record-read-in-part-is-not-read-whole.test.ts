/**
 * Part of a record is not the whole of it, and a reader that decides something from all of a
 * record's work must be able to tell the two apart.
 *
 * ★ WHY. After work is recorded as an agent's, the bridge says whether the performer's record is now
 * public: it is when all of its own work says an agent did it, and a person's work anywhere in it
 * keeps it private. The record is read from three places: the lattice (loaded from the pod), the
 * in-memory lens, and the durable records on the pod. The first and the last are best-effort, and
 * said nothing when they fell short. So over an unreachable pod, a cold lens held only the unit just
 * written, the record read as all agent's work, and the performer was told "PUBLIC" with
 * `readFromRecord: true`, while a person's work the pod could not give back kept it private.
 *
 * Each reader now says whether it read the whole: the lattice by whether it holds its pod copy
 * (latticeReadWhole), the durable records by whether every one it lists was fetched and decoded
 * (readDurableRecordedStatementsDetailed). The pod is stood in for here; the readers are the real ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pod = vi.hoisted(() => ({
  reachable: new Set<string>(),
  entries: new Map<string, Array<{ descriptorUrl?: string; conformsTo?: string[] }>>(),
  descriptors: new Map<string, string>(),
  graphs: new Map<string, string>(),
}));

vi.mock('@interego/solid', async (original) => ({
  ...(await original<typeof import('@interego/solid')>()),
  discover: async (podUrl: string) => {
    if (!pod.reachable.has(podUrl)) throw new Error(`${podUrl} did not answer`);
    return pod.entries.get(podUrl) ?? [];
  },
  fetchGraphContent: async (url: string) => ({ content: pod.graphs.get(url) ?? null, encrypted: false, mediaType: 'application/trig' }),
}));
vi.mock('../src/ssrf-guard.js', () => ({
  assertSafeFetchTarget: async () => undefined,
  guardedFetchFn: (f: unknown) => f,
  safeFetch: async (url: string) => (pod.descriptors.has(url) ? new Response(pod.descriptors.get(url), { status: 200 }) : new Response('', { status: 503 })),
  safePublicUrlOrUndefined: (u: string) => u,
  isPrivateHostname: () => false,
}));
// No bridge key: the lattice cannot read its pod copy, and must say so.
vi.mock('../src/foundation-holon-altitude.js', async (original) => ({
  ...(await original<typeof import('../src/foundation-holon-altitude.js')>()),
  bridgeEncryptionKeypair: () => null,
}));

const { readDurableRecordedStatements, readDurableRecordedStatementsDetailed } = await import('../src/durable-records.js');
const { ensureResident, latticeReadWhole } = await import('../src/foundation-shared-lattice.js');

const RECORDED = 'https://markjspivey-xwisee.github.io/interego/applications/foxxi-content-intelligence/ns/foxxi#RecordedPerformance';
const statement = (id: string, kind: 'human' | 'agent') => ({ id, actor: { account: { name: 'did:ethr:0x1111111111111111111111111111111111111111' } }, context: { extensions: { kind } } });
/** A durable record as the bridge persists it: a descriptor that targets a graph holding the statement, base64-encoded. */
function keep(podUrl: string, n: number, s: Record<string, unknown>, opts: { descriptor?: boolean; graph?: boolean } = {}): void {
  const descriptorUrl = `${podUrl}records/${n}.ttl`;
  const graphUrl = `${podUrl}records/${n}-graph.trig`;
  pod.entries.set(podUrl, [...(pod.entries.get(podUrl) ?? []), { descriptorUrl, conformsTo: [RECORDED] }]);
  if (opts.descriptor !== false) pod.descriptors.set(descriptorUrl, `<> hydra:target <${graphUrl}> .`);
  if (opts.graph !== false) pod.graphs.set(graphUrl, `<${graphUrl}#s> <${graphUrl}#statementJson> "${Buffer.from(JSON.stringify(s)).toString('base64')}" .`);
}

describe("a pod's durable records say whether they were all read", () => {
  it('is whole when every record the pod lists was read, and the plain read is unchanged', async () => {
    const at = 'https://whole.example/p/';
    pod.reachable.add(at);
    keep(at, 1, statement('s1', 'human'));
    keep(at, 2, statement('s2', 'agent'));
    // An entry that is not a Statement record is not a record that went unread.
    pod.entries.set(at, [...pod.entries.get(at)!, { conformsTo: [RECORDED] }]);
    const read = await readDurableRecordedStatementsDetailed({ podUrl: at });
    expect(read.complete).toBe(true);
    expect(read.statements.map(s => s.id)).toEqual(['s1', 's2']);
    expect((await readDurableRecordedStatements({ podUrl: at })).map(s => s.id)).toEqual(['s1', 's2']);
  });

  it('is not whole when the pod does not answer', async () => {
    const read = await readDurableRecordedStatementsDetailed({ podUrl: 'https://silent.example/p/' });
    expect(read).toEqual({ statements: [], complete: false });
  });

  it("is not whole when a record's descriptor or graph could not be fetched, and keeps what it could read", async () => {
    const at = 'https://partial.example/p/';
    pod.reachable.add(at);
    keep(at, 1, statement('s1', 'agent'));
    keep(at, 2, statement('s2', 'human'), { descriptor: false });
    let read = await readDurableRecordedStatementsDetailed({ podUrl: at });
    expect(read.complete).toBe(false);
    expect(read.statements.map(s => s.id)).toEqual(['s1']);
    const at2 = 'https://partial2.example/p/';
    pod.reachable.add(at2);
    keep(at2, 1, statement('s1', 'agent'));
    keep(at2, 2, statement('s2', 'human'), { graph: false });
    read = await readDurableRecordedStatementsDetailed({ podUrl: at2 });
    expect(read.complete).toBe(false);
    expect(read.statements.map(s => s.id)).toEqual(['s1']);
  });

  it('is not whole when a record it found could not be decoded', async () => {
    const at = 'https://garbled.example/p/';
    pod.reachable.add(at);
    keep(at, 1, statement('s1', 'agent'));
    pod.graphs.set(`${at}records/1-graph.trig`, `<x> <${at}records/1-graph.trig#statementJson> "bm90IGpzb24=" .`);   // "not json"
    const read = await readDurableRecordedStatementsDetailed({ podUrl: at });
    expect(read).toEqual({ statements: [], complete: false });
  });
});

describe('a lattice says whether it holds its pod copy', () => {
  it('does not, before it is loaded, or when its pod copy could not be read', async () => {
    expect(latticeReadWhole('never-loaded')).toBe(false);
    await ensureResident('https://keyless.example/p/', 'did:ethr:0x1111111111111111111111111111111111111111', 'keyless');
    expect(latticeReadWhole('keyless')).toBe(false);
  });

  it('is resident and not fenced, by definition', () => {
    const src = readFileSync(new URL('../src/foundation-shared-lattice.ts', import.meta.url), 'utf8');
    expect(src).toContain('export function latticeReadWhole(label: string): boolean { return resident.has(label) && !unreadable.has(label); }');
  });
});

describe('what a record is said to be after an agent\'s write is read from the whole of it, or said to be unread', () => {
  it('classifies only a whole read, and reads the union the review routes read', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const union = server.slice(server.indexOf('async function learnerStatementsReadWhole'), server.indexOf('\n}\n', server.indexOf('async function learnerStatementsReadWhole')));
    expect(union).toContain('const durable = await readDurableRecordedStatementsDetailed({ podUrl });');
    expect(union).toContain('complete: durable.complete && latticeReadWhole(label),');
    expect(union.indexOf('await ensureResident(podUrl, did, label);')).toBeLessThan(union.indexOf('latticeReadWhole(label)'));
    // The plain union is the same read, without the verdict.
    expect(server).toContain('  return (await learnerStatementsReadWhole(podUrl, did)).statements;');
    const route = server.slice(server.indexOf("app.post('/agent/record-performance'"), server.indexOf("app.get('/agent/ingest-course/affordance'"));
    expect(route).toMatch(/const read = await learnerStatementsReadWhole\(subjectPod, callerDid\);\s+if \(read\.complete\) kindNow = classifySubjectKind\(\{ isSelf: false, statements: read\.statements, subjectPodUrl: subjectPod \}\);/);
    expect(route).toContain('recordVisibility = recordVisibilityAfterAgentWork(kindNow);');
  });
});
