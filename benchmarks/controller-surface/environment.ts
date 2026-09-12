/**
 * Local benchmark transport, not a Railway or full Interego protocol implementation.
 * Descriptor trust flags below are calculated from Ed25519 verification and raw
 * SHA-256 CID binding. Controller handoff leaves this authoritative store intact.
 * The baseline path never loads an Interego module.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { CID } from 'multiformats/cid';
import { create as digest } from 'multiformats/hashes/digest';
import type { ResourceDescriptor, ResourceView, ResourceWriteContext } from '../../deploy/mcp-relay/resource-compositions.js';

export type Arm = 'interego' | 'baseline';
export type Scenario = 'stable' | 'rebind' | 'stale' | 'handoff';
export interface BoardState {
  board: string; turn: string | null; status: string; winner: string | null; winningLine: string | null;
  moveNumber: number; sessionVersion: number; lastPosition: number | null; lastMark: string | null;
}
export interface PublicControl { operation: 'move'; position: number; binding: string }
interface AuditEntry {
  actor: 'task' | 'external'; position: number; mark: string; before: BoardState; after: BoardState;
  expectedHead: string; beforeHead: string; afterHead: string;
}
export interface SignedBenchmarkDescriptor {
  schema: 'benchmark.signed-descriptor/v1'; graph: string; url: string; cid: string; content: string; signer: string; signature: string;
}
const G = 'urn:interego:game:';
const H = 'http://www.w3.org/ns/hydra/core#';
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function contentCid(content: string): string { return CID.createV1(0x55, digest(0x12, createHash('sha256').update(content).digest())).toString(); }
function signedBytes(value: Omit<SignedBenchmarkDescriptor, 'signature'>): Buffer { return Buffer.from(canonical(value)); }
export function verifyBenchmarkDescriptor(record: SignedBenchmarkDescriptor, publicKey: KeyObject, expectedSigner: string): boolean {
  const { signature, ...body } = record;
  return record.schema === 'benchmark.signed-descriptor/v1' && record.signer === expectedSigner && record.cid === contentCid(record.content)
    && verify(null, signedBytes(body), publicKey, Buffer.from(signature, 'base64'));
}

/** Seeded keys are reproducible public benchmark fixtures, never production keys. */
export class BenchmarkDescriptorStore {
  readonly publicKey: KeyObject;
  readonly signer: string;
  readonly documents = new Map<string, SignedBenchmarkDescriptor>();
  readonly heads = new Map<string, string>();
  backendReads = 0;
  verifiedReads = 0;
  signatureFailures = 0;
  private readonly privateKey: KeyObject;
  private serial = 0;
  constructor(readonly pod: string, seed: number) {
    const seedBytes = createHash('sha256').update('interego-public-benchmark-fixture:' + seed).digest();
    this.privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedBytes]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.privateKey);
    this.signer = 'did:example:benchmark:' + hash(this.publicKey.export({ type: 'spki', format: 'pem' }).toString()).slice(0, 24);
  }
  put(graph: string, content: string): SignedBenchmarkDescriptor {
    const body = { schema: 'benchmark.signed-descriptor/v1' as const, graph, url: this.pod + 'descriptors/' + (++this.serial) + '.ttl', cid: contentCid(content), content, signer: this.signer };
    const record = { ...body, signature: sign(null, signedBytes(body), this.privateKey).toString('base64') };
    this.documents.set(record.url, record); this.heads.set(graph, record.url); return record;
  }
  current(graph: string): SignedBenchmarkDescriptor {
    this.backendReads++;
    const url = this.heads.get(graph); if (!url) throw new Error('unknown resource');
    const record = this.checked(url);
    if (record.graph !== graph) throw new Error('current head does not bind the requested graph');
    return record;
  }
  descriptor(url: string): SignedBenchmarkDescriptor { this.backendReads++; return this.checked(url); }
  private checked(url: string): SignedBenchmarkDescriptor {
    const record = this.documents.get(url);
    if (!record || record.url !== url || !verifyBenchmarkDescriptor(record, this.publicKey, this.signer)) { this.signatureFailures++; throw new Error('benchmark descriptor signature or content binding failed'); }
    this.verifiedReads++; return clone(record);
  }
}

function outcome(board: string) {
  const line = LINES.find(line => board[line[0]!] !== '.' && line.every(position => board[position] === board[line[0]!]));
  return line ? { status: 'won', winner: board[line[0]!]!, winningLine: line.join(',') }
    : { status: board.includes('.') ? 'in-progress' : 'draw', winner: null, winningLine: null };
}
function reduce(state: BoardState, position: number): BoardState {
  if (!Number.isSafeInteger(position) || position < 0 || position >= 9 || state.status !== 'in-progress' || state.board[position] !== '.') throw new Error('illegal move');
  const cells = [...state.board]; const mark = state.turn!; cells[position] = mark;
  const board = cells.join(''); const terminal = outcome(board);
  return { board, ...terminal, turn: terminal.status === 'in-progress' ? mark === 'X' ? 'O' : 'X' : null,
    moveNumber: state.moveNumber + 1, sessionVersion: state.sessionVersion + 1, lastPosition: position, lastMark: mark };
}
function stateRdf(graph: string, engine: string, state: BoardState): string {
  return `<${graph}> <${G}engine> <${engine}> .\n` + Object.entries(state).filter(([, value]) => value !== null).map(([key, value]) => `<${graph}> <${G}${key}> ${JSON.stringify(value)} .`).join('\n');
}
function signedJsonRdf(graph: string, value: Record<string, unknown>): string {
  const json = canonical(value);
  return `@prefix ia: <urn:interego:application:> .\n<${graph}> { <${graph}> a ia:SignedJsonDocument; ia:format "canonical-json/v1"; ia:documentType "interego.resource-surface/v1"; ia:sha256 "${hash(json)}"; ia:jsonBase64 "${Buffer.from(json).toString('base64')}" . }`;
}

export async function createEnvironment(options: { arm: Arm; scenario: Scenario; seed: number }) {
  const { arm, scenario, seed } = options;
  if (!['interego', 'baseline'].includes(arm) || !['stable', 'rebind', 'stale', 'handoff'].includes(scenario) || !Number.isSafeInteger(seed)) throw new Error('invalid benchmark configuration');
  const root = 'urn:graph:benchmark:controller-surface:case-' + seed;
  const pod = 'https://benchmark.invalid/case-' + seed + '/';
  const ids = { surface: root + ':surface', registry: root + ':registry', contract: root + ':contract:0', engine: root + ':engine', state: root + ':state', receipts: root + ':receipts' };
  const store = new BenchmarkDescriptorStore(pod, seed);
  let generation = 0;
  let state: BoardState = { board: seed % 2 ? '........X' : '.........', turn: seed % 2 ? 'O' : 'X', status: 'in-progress', winner: null, winningLine: null,
    moveNumber: seed % 2 ? 1 : 0, sessionVersion: seed % 2 ? 1 : 0, lastPosition: seed % 2 ? 8 : null, lastMark: seed % 2 ? 'X' : null };
  const initialState = clone(state);
  const audit: AuditEntry[] = [];
  const events: Record<string, unknown>[] = [];
  const nativeControls = new Map<string, { publicControl: PublicControl; native: Record<string, unknown> }>();
  let injected = false;
  let staleRejections = 0;
  let invalidRejections = 0;
  let taskMoves = 0;
  let externalMoves = 0;
  let mutationAttempts = 0;
  const target = () => root + ':target:' + generation;
  const actions = () => ({ state: root + ':read:' + generation, move: root + ':place:' + generation });
  const rawHead = (graph: string) => store.documents.get(store.heads.get(graph)!)!;
  function publishState(proposed?: string): SignedBenchmarkDescriptor {
    return store.put(ids.state, arm === 'interego' ? proposed ?? stateRdf(ids.state, ids.engine, state) : canonical({ engine: ids.engine, state }));
  }
  function publishReceipts() { store.put(ids.receipts, canonical({ schema: 'benchmark.task-receipts/v1', stateCid: rawHead(ids.state).cid, taskMoves, externalMoves, history: audit })); }
  function contractDocuments() {
    ids.contract = root + ':contract:' + generation;
    const a = actions();
    const contract = { schema: 'benchmark.action-contract/v1', engine: ids.engine, session: ids.state, target: target(), actions: a, fields: ['position', 'expected_cid'], requires: ['legal-position', 'current-authority', 'current-head-CAS'] };
    if (arm === 'baseline') {
      store.put(ids.contract, canonical(contract));
      store.put(ids.registry, canonical({ schema: 'benchmark.registry/v1', contract: ids.contract, target: target(), actions: a }));
      store.put(ids.surface, canonical({ schema: 'benchmark.surface/v1', registry: ids.registry, contract: ids.contract, engine: ids.engine, state: ids.state, target: target() }));
      return;
    }
    const contractContent = `<${ids.contract}> <${G}engine> <${ids.engine}>; <${G}session> <${ids.state}>; <${G}policy> "verified-minimal-edit"; <${G}requires> "cryptographically-verified-engine", "cryptographically-verified-session", "current-head-CAS" .\n`
      + Object.entries(a).map(([operation, action]) => `<${action}:affordance> <https://markjspivey-xwisee.github.io/interego/ns/iep#action> <${action}>; <${G}operation> "${operation}"; <${H}method> "${operation === 'state' ? 'GET' : 'POST'}"; <${H}target> <${target()}>${operation === 'move' ? `; <${H}expects> <${root}:move-shape>; <${G}requires> "position-exposed-as-legal", "expected-head-matches-current-head", "engine-derived-successor"` : ''} .`).join('\n')
      + `\n<${root}:move-shape> <${G}field> "position:integer[0..positions-1]", "expected_cid:CIDv1" .`;
    const contractRecord = store.put(ids.contract, contractContent);
    const holons = Object.entries(a).map(([operation, action]) => {
      const triples = [['?request', 'urn:reuse:goal', 'urn:reuse:' + (operation === 'state' ? 'resume' : 'play')], ['?request', 'urn:reuse:target', ids.state], ['?request', 'urn:reuse:requires', 'urn:reuse:authoritative'], ['?request', 'urn:reuse:requires', 'urn:reuse:verified'], [ids.state, G + 'currentHead', '?head'], [ids.state, G + 'engine', ids.engine]];
      if (operation === 'move') triples.push(['?request', 'urn:reuse:requires', 'urn:reuse:cas'], ['?request', G + 'selectedPosition', '?position'], [ids.state, G + 'legalPosition', '?position']);
      return { id: root + ':holon:' + operation, evidence: { successes: 1, failures: 0 }, views: [{ id: root + ':lens:' + operation, graph: triples,
        preconditions: triples.filter(t => t[1] === 'urn:reuse:goal' || t[1] === G + 'legalPosition'), affordance: { descriptor_url: contractRecord.url, action_iri: action, method: operation === 'state' ? 'GET' : 'POST', target: target(), payload: operation === 'state' ? {} : { expected_cid: '?head', position: '?position' } } }] };
    });
    store.put(ids.registry, `<${ids.registry}> a <urn:nsdr:HolonRegistry>; <urn:nsdr:actionContract> <${ids.contract}> .\n` + holons.map(holon => `<${holon.id}> <urn:nsdr:registry> <${ids.registry}>; <urn:nsdr:jsonBase64> "${Buffer.from(JSON.stringify(holon)).toString('base64')}" .`).join('\n'));
    store.put(ids.surface, signedJsonRdf(ids.surface, { schema: 'interego.resource-surface/v1', id: ids.surface, title: 'Benchmark board', interpreter: 'finite-board/v1', authority: { podUrl: pod, signer: store.signer, actionTarget: target(), registryGraphIri: ids.registry, contractGraphIri: ids.contract, engineGraphIri: ids.engine, stateGraphIri: ids.state }, presentation: { kind: 'grid', columns: 3 } }));
  }
  if (arm === 'baseline') store.put(ids.engine, canonical({ positions: 9, empty: '.', players: ['X', 'O'], startBoard: '.........', startTurn: 'X', winLines: LINES }));
  else store.put(ids.engine, `<${ids.engine}> <${G}positions> 9; <${G}empty> "."; <${G}players> "X,O"; <${G}startBoard> "........."; <${G}startTurn> "X"; <${G}winLine> ${LINES.map(line => JSON.stringify(line.join(','))).join(', ')}; <${G}legalRule> "move only to an empty position while status is in-progress"; <${G}turnRule> "alternate players after each non-terminal move"; <${G}terminalRule> "evaluate win first, then draw; terminal states expose no moves"; <${G}resetRule> "board=startBoard; turn=startTurn; status=in-progress; winner absent; moveNumber=0" .`);
  publishState(); contractDocuments(); publishReceipts();

  function commit(position: number, expectedHead: string, actor: 'task' | 'external', proposed?: string) {
    mutationAttempts++;
    const beforeHead = rawHead(ids.state).cid;
    if (beforeHead !== expectedHead) return { code: 412, error: 'precondition_failed', published: false };
    if (actor === 'task' && taskMoves >= 3) return { code: 422, error: 'task_move_budget_exhausted', published: false };
    const before = clone(state); const after = reduce(state, position);
    state = after;
    const record = publishState(proposed);
    audit.push({ actor, position, mark: after.lastMark!, before, after: clone(after), expectedHead, beforeHead, afterHead: record.cid });
    if (actor === 'task') taskMoves++; else externalMoves++;
    publishReceipts(); return { published: true, descriptorUrl: record.url };
  }
  function normalizeControl(native: Record<string, unknown>, position: number): PublicControl {
    const binding = 'control:' + hash(canonical(native));
    const publicControl: PublicControl = { operation: 'move', position, binding };
    nativeControls.set(binding, { native: clone(native), publicControl }); return clone(publicControl);
  }
  function receipts() {
    const record = store.current(ids.receipts);
    const doc = JSON.parse(record.content) as { stateCid: string; taskMoves: number; externalMoves: number; history: AuditEntry[] };
    if (doc.stateCid !== rawHead(ids.state).cid) throw new Error('signed receipt does not bind current state');
    return { taskProgress: { completedMoves: doc.taskMoves }, history: doc.history.map(({ actor, position, mark, after }) => ({ actor, position, mark, moveNumber: after.moveNumber })) };
  }
  function inject() {
    if (injected) return;
    injected = true;
    if (scenario === 'rebind') { generation++; contractDocuments(); events.push({ event: 'contract-rebound', generation }); }
    if (scenario === 'stale') { const position = state.board.lastIndexOf('.'); commit(position, rawHead(ids.state).cid, 'external'); events.push({ event: 'external-move', position }); }
  }
  // Runtime imports are deliberately restricted to the Interego arm.
  const interego = arm === 'interego' ? await Promise.all([import('../../deploy/mcp-relay/resource-compositions.js'), import('../../integrations/affordance-surface/resource-composition.js'), import('n3')]) : undefined;
  const modules = interego ? new interego[0].ResourceCompositions([interego[1].default]) : undefined;
  const descriptor = (url: string): ResourceDescriptor => {
    const value = store.descriptor(url);
    return { url: value.url, cid: value.cid, content: value.content, authorship: { authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true }, effectiveTrustLevel: 'CryptographicallyVerified', signedBy: value.signer, verificationMethod: value.signer + '#benchmark-ed25519' } };
  };
  const context: ResourceWriteContext = { principal: store.signer, identityUrl: 'https://benchmark.invalid/identity', now: '2026-09-12T00:00:00Z', reads: {
    currentHead: async (_pod, graph) => { const current = store.current(graph); return { forked: false, head: { cid: current.cid, descriptorUrl: current.url } }; },
    descriptor: async url => descriptor(url),
    discover: async graph => { const current = store.current(graph); return [{ podUrl: pod, entry: { descriptorUrl: current.url, cid: current.cid, describes: [graph] } }]; },
    discoverGraph: async (_pod, graph) => { const current = store.current(graph); return [{ descriptorUrl: current.url, cid: current.cid, describes: [graph] }]; },
  }, publish: async request => {
    if (!interego || request.actor !== store.signer || request.podUrl !== pod || request.graphIri !== ids.state) return { error: 'unauthorised', code: 403 };
    if (request.expectedHead !== rawHead(ids.state).cid) return { error: 'precondition_failed', code: 412 };
    const quads = new interego[2].Parser().parse(request.graphContent);
    const data: Record<string, string> = {};
    for (const quad of quads) {
      if (quad.subject.value !== ids.state || !quad.predicate.value.startsWith(G) || data[quad.predicate.value.slice(G.length)] !== undefined) return { error: 'unexpected_proposed_state', code: 422 };
      data[quad.predicate.value.slice(G.length)] = quad.object.value;
    }
    const position = Number(data['lastPosition']);
    let after: BoardState; try { after = reduce(state, position); } catch { return { error: 'illegal_move', code: 422 }; }
    const expected = Object.fromEntries(Object.entries({ engine: ids.engine, ...after }).filter(([, value]) => value !== null).map(([key, value]) => [key, String(value)]));
    if (canonical(data) !== canonical(expected)) return { error: 'successor_mismatch', code: 422 };
    return commit(position, request.expectedHead, 'task', request.graphContent);
  } };
  function baselineSnapshot() {
    const surface = store.current(ids.surface); const doc = JSON.parse(surface.content);
    const registry = store.current(doc.registry); const contract = store.current(doc.contract); const engine = store.current(doc.engine); const current = store.current(doc.state);
    const r = JSON.parse(registry.content); const c = JSON.parse(contract.content); const e = JSON.parse(engine.content); const s = JSON.parse(current.content);
    if (r.contract !== contract.graph || r.target !== c.target || canonical(r.actions) !== canonical(c.actions) || c.target !== doc.target || c.engine !== engine.graph || c.session !== current.graph || s.engine !== engine.graph || e.positions !== 9 || canonical(s.state) !== canonical(state)) throw new Error('baseline signed authority mismatch');
    return { state: s.state as BoardState, heads: [surface, registry, contract, engine, current].map(item => item.cid), action: c.actions.move as string, target: c.target as string, expected_cid: current.cid };
  }
  async function read() {
    let result;
    if (modules) {
      const current = store.current(ids.surface);
      const view = await modules.render(current.url, context, descriptor(current.url));
      if (!view) throw new Error('Interego did not recognize signed benchmark surface');
      const snapshot = view['snapshot'] as { state: BoardState; trust: { verified: boolean } };
      if (!snapshot.trust.verified) throw new Error('Interego view did not verify');
      result = { state: snapshot.state, controls: view.controls.filter(control => control['executable'] === true && /^position-\d+$/.test(String(control['id']))).map(control => normalizeControl({ descriptorUrl: control['descriptorUrl'], action: control['action'], payload: control['payload'] }, Number((control['payload'] as Record<string, unknown>)['position']))).sort((a, b) => a.position - b.position), verified: true, ...receipts() };
    } else {
      const snapshot = baselineSnapshot();
      const { state: visibleState, ...authority } = snapshot;
      result = { state: visibleState, controls: [...visibleState.board].flatMap((mark, position) => mark === '.' && visibleState.status === 'in-progress' ? [normalizeControl({ ...authority, position }, position)] : []), verified: true, ...receipts() };
    }
    const captured = clone(result); inject(); return captured;
  }
  async function invoke(control: PublicControl) {
    const cached = nativeControls.get(control?.binding);
    if (!cached || canonical(control) !== canonical(cached.publicControl)) { invalidRejections++; return { status: 422, committed: false, error: 'unadvertised_control' }; }
    let result: Record<string, unknown>;
    if (modules) {
      const native = cached.native;
      result = await modules.invoke(String(native['descriptorUrl']), String(native['action']), native['payload'], context) ?? { error: 'unhandled_control', statusCode: 422, committed: false };
    } else {
      const snapshot = baselineSnapshot(); const native = cached.native;
      if (canonical(native['heads']) !== canonical(snapshot.heads) || native['action'] !== snapshot.action || native['target'] !== snapshot.target || native['expected_cid'] !== snapshot.expected_cid) result = { statusCode: 412, committed: false, error: 'stale_authority' };
      else {
        const published = commit(control.position, snapshot.expected_cid, 'task');
        result = { statusCode: published['published'] === true ? 200 : published['code'] ?? 409, committed: published['published'] === true };
      }
    }
    const status = typeof result['statusCode'] === 'number' ? result['statusCode'] : result['error'] ? 409 : 200;
    if (status === 412) staleRejections++;
    else if (status >= 400) invalidRejections++;
    if (result['committed'] === true) {
      // Interego's native write returns a fresh view; discard its controls for both
      // arms so the controller must make the same explicit next observation.
      const nativeView = result['view'] as ResourceView | undefined;
      const after = nativeView ? (nativeView['snapshot'] as { state: BoardState }).state : baselineSnapshot().state;
      return { status, committed: true, state: clone(after) };
    }
    return { status, committed: result['committed'] ?? false, ...(result['error'] ? { error: String(result['error']) } : {}) };
  }
  return {
    handle: ids.surface,
    async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const started = performance.now(); const before = store.backendReads;
      try {
        let result: Record<string, unknown>;
        if (tool === 'discover' && args['handle'] === ids.surface) { store.current(ids.surface); result = { resource: ids.surface }; }
        else if (tool === 'read' && args['resource'] === ids.surface) result = await read();
        else if (tool === 'invoke') result = await invoke(args['control'] as PublicControl);
        else { invalidRejections++; result = { status: 422, committed: false, error: 'unknown_tool_or_resource' }; }
        events.push({ event: 'tool', tool, args: clone(args), result: clone(result), backendReads: store.backendReads - before, elapsedMs: performance.now() - started });
        return result;
      } catch (error) {
        const result = { status: 409, committed: false, error: (error as Error).message };
        events.push({ event: 'tool', tool, args: clone(args), result, backendReads: store.backendReads - before, elapsedMs: performance.now() - started }); return result;
      }
    },
    inspect() {
      let oracle = initialState.board; let invalidAccepted = 0; let staleAccepted = 0; let lowestPositionViolations = 0;
      for (const entry of audit) {
        const differences = [...entry.after.board].flatMap((mark, position) => mark !== oracle[position] ? [position] : []);
        if (entry.before.board !== oracle || differences.length !== 1 || differences[0] !== entry.position || oracle[entry.position] !== '.' || entry.after.board[entry.position] !== entry.mark || entry.mark !== entry.before.turn || entry.after.moveNumber !== entry.before.moveNumber + 1 || entry.after.sessionVersion !== entry.before.sessionVersion + 1) invalidAccepted++;
        if (entry.expectedHead !== entry.beforeHead) staleAccepted++;
        if (entry.actor === 'task' && entry.position !== oracle.indexOf('.')) lowestPositionViolations++;
        oracle = entry.after.board;
      }
      const durableDescriptorsVerified = [...store.documents.values()].every(value => verifyBenchmarkDescriptor(value, store.publicKey, store.signer));
      return clone({ arm, scenario, seed, initialState, state, taskMoves, externalMoves, generation, audit, events,
        backendReads: store.backendReads, verifiedReads: store.verifiedReads, signatureFailures: store.signatureFailures, durableDescriptorsVerified,
        descriptorCount: store.documents.size, mutationAttempts, staleRejections, invalidRejections, invalidAccepted, staleAccepted, lowestPositionViolations,
        completed: taskMoves === 3 && invalidAccepted === 0 && staleAccepted === 0 && lowestPositionViolations === 0 && durableDescriptorsVerified && oracle === state.board });
    },
  };
}
