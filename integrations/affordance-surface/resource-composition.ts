/** Optional L3 finite-board interpreter. Signed resources supply every application identity. */
import { parseTrig, renderHypermediaMarkdown, turtleIriRef, type ParsedSubject, type ParsedTerm } from '@interego/core';
import { extractNamedGraphTurtle } from '@interego/solid';
import type { ResourceComposition, ResourceContext, ResourceDescriptor, ResourceView, ResourceWriteContext } from '../../deploy/mcp-relay/resource-compositions.js';
import { canonicalJson, parseSignedJsonDocument } from '../application-runtime/application-lab-runtime.js';
import { DifferentialKernel, type Triple } from './differential-kernel.js';
import { verifySurfaceEvidence } from './evidence.js';

const GAME = 'urn:interego:game:';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const NSDR = 'urn:nsdr:';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const PREFIX = 'urn:interego:resource-surface:v1:';
const SCHEMA = 'interego.resource-surface/v1';
const RULES = {
  legalRule: 'move only to an empty position while status is in-progress',
  turnRule: 'alternate players after each non-terminal move',
  terminalRule: 'evaluate win first, then draw; terminal states expose no moves',
  resetRule: 'board=startBoard; turn=startTurn; status=in-progress; winner absent; moveNumber=0',
};
type Operation = 'state' | 'move' | 'reset';
export interface ResourceSurface {
  schema: typeof SCHEMA;
  id: string;
  title: string;
  interpreter: 'finite-board/v1';
  authority: { podUrl: string; signer: string; actionTarget: string; registryGraphIri: string; contractGraphIri: string; engineGraphIri: string; stateGraphIri: string };
  presentation: { kind: 'grid'; columns: number };
  related?: { label: string; descriptorUrl: string; graphIri?: string }[];
  evidence?: unknown;
}
interface Artifact { graphIri: string; cid: string; descriptorUrl: string; descriptor: ResourceDescriptor; content: string; subjects: readonly ParsedSubject[] }
interface Engine { positions: number; empty: string; players: string[]; startBoard: string; startTurn: string; winLines: number[][] }
interface Session { board: string; turn: string | null; status: string; winner: string | null; winningLine: string | null; moveNumber: number; sessionVersion: number; lastPosition: number | null; lastMark: string | null }
interface Action { action: string; method: 'GET' | 'POST'; target: string; operation: Operation; label: string; descriptorUrl: string }
interface Binding { surface: string; surfaceGraph: string; heads: Record<'surface' | 'registry' | 'contract' | 'engine' | 'state', string>; selected: { action: string; method: string; target: string; descriptorUrl: string; operation: Operation; payload: Record<string, unknown> } }
export interface LoadedSurface { surface: ResourceSurface; surfaceArtifact: Artifact; registry: Artifact; contract: Artifact; engineArtifact: Artifact; stateArtifact: Artifact; engine: Engine; session: Session; holons: unknown[]; actions: Action[] }
export class SurfaceError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
const fail = (message: string, status = 409): never => { throw new SurfaceError(message, status); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('expected an object');
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 16384 ? value : fail('expected a nonempty string');
const iri = (value: unknown): string => { const result = text(value); if (!turtleIriRef(result)) fail('invalid resource IRI'); return result; };
const webUrl = (value: unknown): string => { const result = text(value); const url = new URL(result); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('invalid descriptor URL'); return result; };
const exact = (object: Record<string, unknown>, required: string[], optional: string[] = []) => {
  if (required.some(key => !(key in object)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) fail('unexpected or missing surface fields');
};
function surfaceSchema(value: unknown): ResourceSurface {
  const doc = record(value); exact(doc, ['schema', 'id', 'title', 'interpreter', 'authority', 'presentation'], ['related', 'evidence']);
  if (doc['schema'] !== SCHEMA || doc['interpreter'] !== 'finite-board/v1') fail('unsupported resource surface interpreter');
  const a = record(doc['authority']); exact(a, ['podUrl', 'signer', 'actionTarget', 'registryGraphIri', 'contractGraphIri', 'engineGraphIri', 'stateGraphIri']);
  webUrl(a['podUrl']); for (const key of Object.keys(a).filter(key => key !== 'podUrl')) iri(a[key]);
  const p = record(doc['presentation']); exact(p, ['kind', 'columns']);
  if (p['kind'] !== 'grid' || !Number.isSafeInteger(p['columns']) || Number(p['columns']) < 1 || Number(p['columns']) > 12) fail('unsupported grid presentation');
  iri(doc['id']); text(doc['title']);
  if (doc['related'] !== undefined) {
    if (!Array.isArray(doc['related']) || doc['related'].length > 32) fail('invalid related resource list');
    for (const raw of doc['related'] as unknown[]) { const link = record(raw); exact(link, ['label', 'descriptorUrl'], ['graphIri']); text(link['label']); webUrl(link['descriptorUrl']); if (link['graphIri']) iri(link['graphIri']); }
  }
  return doc as unknown as ResourceSurface;
}
function subject(artifact: Artifact, id: string): ParsedSubject {
  return artifact.subjects.find(value => value.subject === id) ?? fail(`signed graph does not describe ${id}`);
}
function values(subject: ParsedSubject, predicate: string): readonly ParsedTerm[] {
  return [...subject.properties].find(([key]) => String(key) === predicate)?.[1] ?? [];
}
function scalar(subject: ParsedSubject, predicate: string, kind: 'literal' | 'iri', optional = false): string | null {
  const found = values(subject, predicate);
  if (optional && !found.length) return null;
  if (found.length !== 1 || found[0]!.kind !== kind) return fail(`ambiguous or missing signed predicate ${predicate}`);
  return found[0]!.kind === 'iri' ? found[0]!.iri : (found[0] as { value: string }).value;
}
const lit = (subject: ParsedSubject, name: string, optional = false) => scalar(subject, GAME + name, 'literal', optional);
function integer(subject: ParsedSubject, name: string, optional = false): number | null {
  const value = lit(subject, name, optional); if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail(`invalid ${name}`);
  return Number(value);
}
function trusted(descriptor: ResourceDescriptor, signer: string): void {
  const trust = descriptor.authorship;
  if (trust?.authorshipVerified !== true || trust.contentBinding !== 'bound' || trust.descriptorBinding?.bound !== true
    || trust.effectiveTrustLevel !== 'CryptographicallyVerified' || trust.signedBy !== signer) fail('resource signature, signer or content binding did not verify');
}
async function artifact(context: ResourceContext, podUrl: string, graphIri: string, signer: string): Promise<Artifact> {
  const current = await context.reads.currentHead(podUrl, graphIri);
  if (current.forked) fail('authority has multiple current heads; refusing to choose a fork');
  const cid = current.head?.cid; const descriptorUrl = current.head?.descriptorUrl;
  if (!cid || !descriptorUrl) fail(`no current head for ${graphIri}`);
  const descriptor = await context.reads.descriptor(descriptorUrl!); trusted(descriptor, signer);
  if (descriptor.url !== descriptorUrl || descriptor.cid !== cid) fail('descriptor does not match the current content address');
  const content = descriptor.content; if (!content || content.length > 2_000_000) fail('signed graph payload is absent or too large');
  // Invert the publisher's envelope using its own helper; older payloads carry
  // prefix declarations inside the graph wrapper. Signature bytes stay intact.
  const payload = extractNamedGraphTurtle(content!, graphIri) ?? content!;
  return { graphIri, cid: cid!, descriptorUrl: descriptorUrl!, descriptor, content: content!, subjects: parseTrig(payload).subjects };
}
function parseEngine(artifact: Artifact): Engine {
  const node = subject(artifact, artifact.graphIri);
  for (const [name, expected] of Object.entries(RULES)) if (lit(node, name) !== expected) fail(`unsupported signed engine rule: ${name}`);
  const positions = integer(node, 'positions')!; const empty = lit(node, 'empty')!; const players = lit(node, 'players')!.split(',');
  const startBoard = lit(node, 'startBoard')!; const startTurn = lit(node, 'startTurn')!;
  const winLines = values(node, GAME + 'winLine').map(term => {
    if (term.kind !== 'literal' || !/^[0-9]+(?:,[0-9]+)*$/.test(term.value)) return fail('invalid win line');
    return term.value.split(',').map(Number);
  });
  if (positions < 1 || positions > 64 || [...empty].length !== 1 || players.length < 2 || players.length > 8
    || new Set(players).size !== players.length || players.some(mark => [...mark].length !== 1 || mark === empty)
    || !players.includes(startTurn) || [...startBoard].length !== positions || [...startBoard].some(mark => mark !== empty)
    || !winLines.length || winLines.length > 256 || winLines.some(line => !line.length || new Set(line).size !== line.length || line.some(pos => pos >= positions))) fail('inconsistent finite-board engine');
  return { positions, empty, players, startBoard, startTurn, winLines };
}
function outcome(board: string, engine: Engine) {
  const cells = [...board];
  const line = engine.winLines.find(line => cells[line[0]!] !== engine.empty && line.every(pos => cells[pos] === cells[line[0]!]));
  return line ? { status: 'won', winner: cells[line[0]!]!, winningLine: line.join(',') }
    : { status: cells.includes(engine.empty) ? 'in-progress' : 'draw', winner: null, winningLine: null };
}
function parseSession(artifact: Artifact, engine: Engine, engineGraph: string): Session {
  const node = subject(artifact, artifact.graphIri);
  if (scalar(node, GAME + 'engine', 'iri') !== engineGraph) fail('state refers to a different signed engine');
  const session: Session = { board: lit(node, 'board')!, turn: lit(node, 'turn', true), status: lit(node, 'status')!, winner: lit(node, 'winner', true), winningLine: lit(node, 'winningLine', true),
    moveNumber: integer(node, 'moveNumber')!, sessionVersion: integer(node, 'sessionVersion')!, lastPosition: integer(node, 'lastPosition', true), lastMark: lit(node, 'lastMark', true) };
  const cells = [...session.board]; const terminal = outcome(session.board, engine);
  const expectedCounts = engine.players.map(() => 0);
  for (let index = 0; index < session.moveNumber && index < engine.positions; index++) expectedCounts[(engine.players.indexOf(engine.startTurn) + index) % engine.players.length]!++;
  if (cells.length !== engine.positions || cells.some(mark => mark !== engine.empty && !engine.players.includes(mark))
    || session.moveNumber !== cells.filter(mark => mark !== engine.empty).length
    || engine.players.some((mark, index) => cells.filter(cell => cell === mark).length !== expectedCounts[index])
    || session.status !== terminal.status || session.winner !== terminal.winner || session.winningLine !== terminal.winningLine
    || (session.status === 'in-progress' ? session.turn !== engine.players[(engine.players.indexOf(engine.startTurn) + session.moveNumber) % engine.players.length] : session.turn !== null)
    || (session.lastPosition === null) !== (session.lastMark === null)
    || (session.lastPosition !== null && (session.lastPosition >= engine.positions || session.lastMark !== cells[session.lastPosition]
      || session.lastMark !== engine.players[(engine.players.indexOf(engine.startTurn) + session.moveNumber - 1) % engine.players.length]))) fail('current state is inconsistent with the signed engine');
  return session;
}
function parseActions(contract: Artifact, surface: ResourceSurface): Action[] {
  const root = subject(contract, contract.graphIri);
  if (scalar(root, GAME + 'engine', 'iri') !== surface.authority.engineGraphIri
    || scalar(root, GAME + 'session', 'iri') !== surface.authority.stateGraphIri) fail('contract does not bind the surface engine and state');
  if (lit(root, 'policy') !== 'verified-minimal-edit') fail('unsupported signed resolution policy');
  const literalSet = (node: ParsedSubject, predicate: string, expected: string[]) => {
    const terms = values(node, predicate);
    if (terms.some(term => term.kind !== 'literal') || canonicalJson(terms.map(term => (term as { value: string }).value).sort()) !== canonicalJson([...expected].sort())) fail('unsupported signed contract fields or conditions');
  };
  const knownPredicates = (node: ParsedSubject, allowed: string[]) => {
    if ([...node.properties.keys()].some(predicate => !allowed.includes(String(predicate)))) fail('unsupported signed action contract semantics');
  };
  const metadata = [RDF + 'type', 'http://purl.org/dc/terms/title', 'http://purl.org/dc/terms/description', 'http://www.w3.org/2000/01/rdf-schema#label'];
  knownPredicates(root, [...metadata, ...['engine', 'session', 'executor', 'policy', 'requires'].map(key => GAME + key)]);
  literalSet(root, GAME + 'requires', ['cryptographically-verified-engine', 'cryptographically-verified-session', 'current-head-CAS']);
  const actions = contract.subjects.filter(node => values(node, GAME + 'operation').length).map(node => {
    const operation = lit(node, 'operation'); if (!['state', 'move', 'reset'].includes(operation!)) return fail('unsupported signed action operation');
    const method = scalar(node, HYDRA + 'method', 'literal');
    if (method !== (operation === 'state' ? 'GET' : 'POST') || typeof node.subject !== 'string') fail('unsupported signed action method or identity');
    knownPredicates(node, [...metadata, IEP + 'action', GAME + 'operation', GAME + 'requires', ...['method', 'target', 'returns', 'expects'].map(key => HYDRA + key)]);
    if (scalar(node, HYDRA + 'target', 'iri') !== surface.authority.actionTarget) fail('contract target is not bound to this surface interpreter');
    literalSet(node, GAME + 'requires', operation === 'state' ? [] : operation === 'move'
      ? ['position-exposed-as-legal', 'expected-head-matches-current-head', 'engine-derived-successor'] : ['expected-head-matches-current-head', 'engine-derived-reset']);
    const expects = scalar(node, HYDRA + 'expects', 'iri', operation === 'state');
    if (operation === 'state' ? expects !== null : !expects) fail('unsupported signed action input shape');
    if (expects) {
      const shape = subject(contract, expects); knownPredicates(shape, [...metadata, GAME + 'field']);
      literalSet(shape, GAME + 'field', operation === 'move' ? ['position:integer[0..positions-1]', 'expected_cid:CIDv1'] : ['expected_cid:CIDv1']);
    }
    return { action: scalar(node, IEP + 'action', 'iri')!, operation: operation as Operation, method: method as 'GET' | 'POST', target: scalar(node, HYDRA + 'target', 'iri')!,
      label: scalar(node, 'http://www.w3.org/2000/01/rdf-schema#label', 'literal', true) ?? operation!, descriptorUrl: contract.descriptorUrl };
  });
  if (!actions.some(action => action.operation === 'state') || new Set(actions.map(action => action.action)).size !== actions.length) fail('contract has no unique read operation');
  return actions;
}
function parseRegistry(registry: Artifact, contractGraph: string): unknown[] {
  const root = subject(registry, registry.graphIri);
  if (!values(root, RDF + 'type').some(term => term.kind === 'iri' && term.iri === NSDR + 'HolonRegistry')) fail('resource is not a signed holon registry');
  if (scalar(root, NSDR + 'actionContract', 'iri') !== contractGraph) fail('registry does not bind the surface action contract');
  const holons: Record<string, unknown>[] = registry.subjects.flatMap(node => values(node, NSDR + 'jsonBase64').map(term => {
    if (term.kind !== 'literal' || !/^[A-Za-z0-9+/]+={0,2}$/.test(term.value)) return fail('invalid registry holon encoding');
    const holon = record(JSON.parse(Buffer.from(term.value, 'base64').toString('utf8')));
    iri(holon['id']); if (!Array.isArray(holon['views'])) fail('invalid registry holon views');
    if (node.subject !== holon['id'] || scalar(node, NSDR + 'registry', 'iri') !== registry.graphIri) fail('holon identity or membership differs from signed RDF');
    return { ...holon, registryDescriptor: registry.descriptorUrl };
  }));
  if (!holons.length || holons.length > 128 || new Set(holons.map(holon => holon['id'])).size !== holons.length) fail('empty, duplicate or excessive registry holons');
  return holons;
}
export async function loadSurface(url: string, context: ResourceContext): Promise<LoadedSurface> {
  const descriptor = await context.reads.descriptor(webUrl(url));
  if (!descriptor.content) fail('surface has no signed payload');
  const envelope = parseSignedJsonDocument(descriptor.content!);
  if (!envelope.digestVerified || !envelope.graphIri) fail('surface JSON digest or graph identity did not verify');
  const surface = surfaceSchema(envelope.document); trusted(descriptor, surface.authority.signer);
  const a = surface.authority;
  const [surfaceArtifact, registry, contract, engineArtifact, stateArtifact] = await Promise.all([
    artifact(context, a.podUrl, envelope.graphIri!, a.signer), artifact(context, a.podUrl, a.registryGraphIri, a.signer),
    artifact(context, a.podUrl, a.contractGraphIri, a.signer), artifact(context, a.podUrl, a.engineGraphIri, a.signer), artifact(context, a.podUrl, a.stateGraphIri, a.signer),
  ]);
  // A requested old surface must not silently acquire the authority of a new head.
  if (surfaceArtifact.descriptorUrl !== url || surfaceArtifact.cid !== descriptor.cid || surfaceArtifact.content !== descriptor.content) fail('surface descriptor is not its current signed head', 412);
  const engine = parseEngine(engineArtifact); if (engine.positions % surface.presentation.columns !== 0) fail('grid columns do not divide signed positions');
  const loaded = { surface, surfaceArtifact, registry, contract, engineArtifact, stateArtifact, engine,
    session: parseSession(stateArtifact, engine, a.engineGraphIri), holons: parseRegistry(registry, a.contractGraphIri), actions: parseActions(contract, surface) };
  await assertCurrent(loaded, context); return loaded;
}
function artifacts(loaded: LoadedSurface): Artifact[] { return [loaded.surfaceArtifact, loaded.registry, loaded.contract, loaded.engineArtifact, loaded.stateArtifact]; }
async function assertCurrent(loaded: LoadedSurface, context: ResourceContext) {
  await Promise.all(artifacts(loaded).map(async item => {
    const head = await context.reads.currentHead(loaded.surface.authority.podUrl, item.graphIri);
    if (head.forked || head.head?.cid !== item.cid || head.head?.descriptorUrl !== item.descriptorUrl) fail('signed authority changed during verification', 412);
  }));
}
function legal(loaded: LoadedSurface): number[] { return loaded.session.status === 'in-progress' ? [...loaded.session.board].flatMap((mark, pos) => mark === loaded.engine.empty ? [pos] : []) : []; }
function plan(loaded: LoadedSurface, operation: Operation, position?: number) {
  const goal = operation === 'state' ? 'resume' : operation === 'move' ? 'play' : 'reset';
  const request = 'urn:interego:resource-request:' + goal; const state = loaded.surface.authority.stateGraphIri;
  const graph: Triple[] = [[request, 'urn:reuse:goal', 'urn:reuse:' + goal], [request, 'urn:reuse:target', state],
    [request, 'urn:reuse:requires', 'urn:reuse:authoritative'], [request, 'urn:reuse:requires', 'urn:reuse:verified'],
    [state, GAME + 'currentHead', loaded.stateArtifact.cid], [state, GAME + 'engine', loaded.engineArtifact.graphIri]];
  if (operation !== 'state') graph.push([request, 'urn:reuse:requires', 'urn:reuse:cas']);
  if (operation === 'move') {
    if (!Number.isSafeInteger(position) || !legal(loaded).includes(position!)) fail('position is not a currently exposed legal move', 422);
    graph.push([request, GAME + 'selectedPosition', String(position)]);
    for (const pos of legal(loaded)) graph.push([state, GAME + 'legalPosition', String(pos)]);
  }
  const kernel = new DifferentialKernel(loaded.holons); const reaction = kernel.react({ graph, context: { goal, authority: state }, limit: 100 });
  const decision = kernel.resolve({ reactionId: reaction.id, policy: 'verified-minimal-edit' });
  const execution = decision.selected?.execution;
  if (decision.disposition !== 'invoke' || !execution) return fail('verified registry did not resolve to an executable affordance');
  if (decision.selected!.invocations.length !== 1) fail('selected composition contains multiple invocations; a single reviewed operation is required');
  const action = loaded.actions.find(action => action.action === execution.action_iri && action.operation === operation);
  if (!action || execution.descriptor_url !== loaded.contract.descriptorUrl || execution.method !== action.method || execution.target !== action.target) return fail('selected registry tuple does not exactly match the signed contract');
  const payload = operation === 'state' ? {} : operation === 'move' ? { expected_cid: loaded.stateArtifact.cid, position } : { expected_cid: loaded.stateArtifact.cid };
  const selectedPayload = record(execution.payload);
  // Registry term bindings are strings; position is the sole understood integer input.
  if (selectedPayload['position'] !== undefined && typeof selectedPayload['position'] === 'string' && /^(0|[1-9][0-9]*)$/.test(selectedPayload['position'])) selectedPayload['position'] = Number(selectedPayload['position']);
  if (canonicalJson(selectedPayload) !== canonicalJson(payload)) fail('selected registry payload does not match reviewed operation inputs');
  return { action, payload, reaction, decision };
}
function binding(loaded: LoadedSurface, selected: ReturnType<typeof plan>): Binding {
  return { surface: loaded.surfaceArtifact.descriptorUrl, surfaceGraph: loaded.surfaceArtifact.graphIri,
    heads: { surface: loaded.surfaceArtifact.cid, registry: loaded.registry.cid, contract: loaded.contract.cid, engine: loaded.engineArtifact.cid, state: loaded.stateArtifact.cid },
    selected: { ...selected.action, payload: selected.payload } };
}
function reference(value: Binding): string { return PREFIX + Buffer.from(canonicalJson(value)).toString('base64url'); }
function parseReference(url: string): Binding {
  if (!url.startsWith(PREFIX) || url.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(url.slice(PREFIX.length))) fail('invalid surface reference');
  const raw = record(JSON.parse(Buffer.from(url.slice(PREFIX.length), 'base64url').toString('utf8')));
  exact(raw, ['surface', 'surfaceGraph', 'heads', 'selected']); webUrl(raw['surface']); iri(raw['surfaceGraph']);
  const heads = record(raw['heads']); exact(heads, ['surface', 'registry', 'contract', 'engine', 'state']); Object.values(heads).forEach(text);
  const selected = record(raw['selected']); exact(selected, ['action', 'method', 'target', 'descriptorUrl', 'operation', 'payload'], ['label']);
  iri(selected['action']); iri(selected['target']); webUrl(selected['descriptorUrl']); record(selected['payload']);
  if (!['state', 'move', 'reset'].includes(String(selected['operation'])) || selected['method'] !== (selected['operation'] === 'state' ? 'GET' : 'POST')) fail('invalid surface operation binding');
  return raw as unknown as Binding;
}
const escape = (value: unknown): string => String(value ?? '').replace(/[\\`*_{}[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
function control(loaded: LoadedSurface, selected: ReturnType<typeof plan>, id: string) {
  const b = binding(loaded, selected); const operation = selected.action.operation;
  return { id, action: selected.action.action, method: selected.action.method, label: operation === 'state' ? 'Refresh and verify' : operation === 'move' ? `Place ${loaded.session.turn} at position ${selected.payload['position']}` : 'Reset game',
    descriptorUrl: reference(b), target: selected.action.target, payload: selected.payload, executable: true, source: loaded.contract.descriptorUrl,
    ...(operation === 'reset' ? { confirmation: 'Reset this game? This publishes a new empty board.' } : {}), fields: [] };
}
async function view(loaded: LoadedSurface, context: ResourceContext, reviewed?: ReturnType<typeof plan>): Promise<ResourceView> {
  const selected = reviewed ?? plan(loaded, 'state'); const main = control(loaded, selected, 'reviewed');
  const refresh = control(loaded, plan(loaded, 'state'), 'refresh'); const controls: ReturnType<typeof control>[] = [refresh];
  const cells = [...loaded.session.board].map((mark, pos) => {
    const playable = legal(loaded).includes(pos);
    if (playable) controls.push(control(loaded, plan(loaded, 'move', pos), 'position-' + pos));
    return { label: mark === loaded.engine.empty ? String(pos) : mark, ...(playable ? { control: 'position-' + pos } : {}), emphasis: loaded.session.winningLine?.split(',').map(Number).includes(pos) ?? false };
  });
  if (loaded.actions.some(action => action.operation === 'reset')) controls.push(control(loaded, plan(loaded, 'reset'), 'reset'));
  if (context.principal !== loaded.surface.authority.signer) for (const item of controls) if (item.method !== 'GET') item.executable = false;
  const evidence = loaded.surface.evidence === undefined ? undefined : await verifySurfaceEvidence(loaded.surface.evidence, context, { stateHeadCid: loaded.stateArtifact.cid });
  if (evidence && !evidence.verified) fail('surface evidence did not verify');
  const body = ['# ' + escape(loaded.surface.title), `${loaded.session.status === 'won' ? escape(loaded.session.winner) + ' wins' : loaded.session.status === 'draw' ? 'Draw' : escape(loaded.session.turn) + ' to move'}. Version ${loaded.session.sessionVersion}.`,
    'Five current signed resources verified: surface, registry, action contract, engine and state. Historical transition replay is not claimed.',
    `Current state CID: ${escape(loaded.stateArtifact.cid)}.`, evidence?.body ?? '',
    'Controls are resolved through the signed registry with verified-minimal-edit. Opening and refreshing perform no publication.'].filter(Boolean).join('\n\n');
  const links = [...controls.filter(item => item.descriptorUrl !== main.descriptorUrl).map(item => ({ label: item.label, href: item.descriptorUrl, rel: item.action })),
    ...(loaded.surface.related ?? []).map(link => ({ label: link.label, href: link.descriptorUrl, rel: 'http://www.w3.org/2000/01/rdf-schema#seeAlso' })),
    ...(evidence?.links ?? []).map(link => ({ ...link, rel: 'http://www.w3.org/2007/05/powder-s#describedby' }))];
  const fields = Object.entries(selected.payload).map(([key, value]) => ({ path: GAME + key, name: key, description: `Reviewed value: ${String(value)}; submit using the advertised payload unchanged.`,
    datatype: 'http://www.w3.org/2001/XMLSchema#' + (typeof value === 'number' ? 'integer' : 'string'), minCount: 1, maxCount: 1 }));
  const columns = loaded.surface.presentation.columns;
  const grid = [Array.from({ length: columns }, (_, index) => `Column ${index + 1}`), Array.from({ length: columns }, () => '---'),
    ...Array.from({ length: cells.length / columns }, (_, row) => cells.slice(row * columns, (row + 1) * columns).map(cell => escape(cell.label)))].map(row => '| ' + row.join(' | ') + ' |').join('\n');
  const markdownBody = body + '\n\n' + grid;
  const hmd = renderHypermediaMarkdown({ id: main.descriptorUrl, descriptorUrl: main.descriptorUrl, title: loaded.surface.title,
    type: 'urn:interego:resource-surface:Projection', body: markdownBody, links, controls: [{ id: 'reviewed', action: selected.action.action, method: selected.action.method, fields,
      source: loaded.contract.descriptorUrl, whenToUse: selected.action.operation === 'reset' ? 'Only after explicitly confirming reset.' : 'Follow this reviewed, descriptor-bound operation.' }] });
  await assertCurrent(loaded, context);
  return { descriptorUrl: main.descriptorUrl, title: loaded.surface.title, body, markdownBody, hmd, controls,
    views: [{ kind: 'grid', id: loaded.surface.id, label: loaded.surface.title, columns: loaded.surface.presentation.columns, cells }],
    snapshot: { trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 }, ...(evidence ? { relatedEvidence: evidence } : {}),
      state: loaded.session, authority: artifacts(loaded).map(item => ({ graphIri: item.graphIri, descriptorUrl: item.descriptorUrl, cid: item.cid, verified: true })) },
    planning: { policy: 'verified-minimal-edit', reaction: selected.reaction, decision: selected.decision }, authorship: null,
    derivedFrom: artifacts(loaded).map(item => item.descriptorUrl) };
}
function successor(loaded: LoadedSurface, operation: Operation, payload: Record<string, unknown>): Session {
  const { session, engine } = loaded;
  if (operation === 'reset') return { board: engine.startBoard, turn: engine.startTurn, status: 'in-progress', winner: null, winningLine: null, moveNumber: 0, sessionVersion: session.sessionVersion + 1, lastPosition: null, lastMark: null };
  const position = payload['position']; if (!Number.isSafeInteger(position) || !legal(loaded).includes(Number(position))) return fail('move is not currently legal', 422);
  const cells = [...session.board]; const mark = session.turn!; cells[Number(position)] = mark;
  const terminal = outcome(cells.join(''), engine);
  return { board: cells.join(''), ...terminal, turn: terminal.status === 'in-progress' ? engine.players[(engine.players.indexOf(mark) + 1) % engine.players.length]! : null,
    moveNumber: session.moveNumber + 1, sessionVersion: session.sessionVersion + 1, lastPosition: Number(position), lastMark: mark };
}
function sessionGraph(loaded: LoadedSurface, next: Session): string {
  const graph = turtleIriRef(loaded.surface.authority.stateGraphIri)!;
  const node = subject(loaded.stateArtifact, loaded.stateArtifact.graphIri);
  const changed = new Set(Object.keys(next).map(key => GAME + key));
  const extra: string[] = []; const seen = new Set<string>();
  const serialize = (term: ParsedTerm): string => {
    if (term.kind === 'iri') return turtleIriRef(term.iri) ?? fail('unsafe preserved IRI');
    if (term.kind === 'literal') return JSON.stringify(term.value) + (term.language ? '@' + term.language : term.datatype ? '^^' + turtleIriRef(term.datatype) : '');
    if (term.kind === 'triple') return fail('unsupported state metadata triple term');
    if (!/^[A-Za-z0-9_-]+$/.test(term.id)) return fail('unsafe state metadata blank node');
    if (!seen.has(term.id)) {
      seen.add(term.id); const blank = loaded.stateArtifact.subjects.find(item => typeof item.subject !== 'string' && item.subject.bnode === term.id);
      if (!blank) fail('missing preserved blank node');
      for (const [predicate, terms] of blank!.properties) for (const value of terms) extra.push(`_:${term.id} ${turtleIriRef(predicate)} ${serialize(value)} .`);
    }
    return '_:' + term.id;
  };
  const triples: string[] = [];
  for (const [predicate, terms] of node.properties) if (!changed.has(predicate)) for (const term of terms) triples.push(`${graph} ${turtleIriRef(predicate)} ${serialize(term)} .`);
  for (const [key, value] of Object.entries(next)) if (value !== null) triples.push(`${graph} <${GAME}${key}> ${typeof value === 'number' ? value : JSON.stringify(value)} .`);
  return [...triples, ...extra].join('\n') + '\n';
}
const composition: ResourceComposition = {
  claims: url => url.startsWith(PREFIX),
  access(url, action) { try { const ref = parseReference(url); if (ref.selected.action !== action) return undefined; return ref.selected.operation === 'state' ? 'read' : 'write'; } catch { return undefined; } },
  async render(url, context, descriptor) {
    if (url.startsWith(PREFIX)) {
      const ref = parseReference(url); const loaded = await loadSurface(ref.surface, context);
      const selected = ref.selected.operation === 'state' ? plan(loaded, 'state') : plan(loaded, ref.selected.operation, Number(ref.selected.payload['position']));
      if (canonicalJson(binding(loaded, selected).selected) !== canonicalJson(ref.selected)) fail('reference tuple differs from the current signed selection', 412);
      // A read view can refresh; rendering a write review must not quietly rebind stale inputs.
      if (ref.selected.operation !== 'state' && canonicalJson(binding(loaded, selected)) !== canonicalJson(ref)) fail('reviewed authority is stale; refresh the surface', 412);
      return view(loaded, context, selected);
    }
    if (!descriptor?.content) return undefined;
    let envelope; try { envelope = parseSignedJsonDocument(descriptor.content); } catch { return undefined; }
    if (envelope.document['schema'] !== SCHEMA) return undefined;
    return view(await loadSurface(url, context), context);
  },
  async invoke(url, action, rawPayload, context) {
    try {
    const ref = parseReference(url); if (!composition.access(url, action)) fail('undeclared surface operation');
    const payload = record(rawPayload);
    if (canonicalJson(payload) !== canonicalJson(ref.selected.payload)) fail('payload differs from the displayed descriptor-bound inputs', 412);
    const loaded = await loadSurface(ref.surface, context); const operation = ref.selected.operation;
    if (operation === 'state') {
      if (Object.keys(payload).length) fail('read operation takes no inputs');
      const selected = plan(loaded, 'state');
      if (canonicalJson(binding(loaded, selected).selected) !== canonicalJson(ref.selected)) fail('read tuple differs from current signed selection', 412);
      return view(loaded, context, selected);
    }
    if (payload['expected_cid'] !== loaded.stateArtifact.cid || ref.heads.state !== loaded.stateArtifact.cid) fail('stale state; refresh and review before retrying', 412);
    if (context.principal !== loaded.surface.authority.signer || !('publish' in context)) fail('the current surface signer must authenticate to publish a successor', 403);
    const selected = plan(loaded, operation, Number(payload['position']));
    if (canonicalJson(binding(loaded, selected)) !== canonicalJson(ref)) fail('signed authority or selected tuple changed; refresh before submitting', 412);
    if (loaded.surface.evidence !== undefined) {
      const evidence = await verifySurfaceEvidence(loaded.surface.evidence, context, { stateHeadCid: loaded.stateArtifact.cid });
      if (!evidence.verified) fail('surface evidence did not verify');
    }
    const next = successor(loaded, operation, payload); const graphContent = sessionGraph(loaded, next);
    await assertCurrent(loaded, context);
    let published: Record<string, unknown>;
    try {
      published = await (context as ResourceWriteContext).publish({ podUrl: loaded.surface.authority.podUrl, graphIri: loaded.stateArtifact.graphIri, graphContent,
        expectedHead: loaded.stateArtifact.cid, actor: context.principal });
    } catch (error) {
      return { error: 'publication_outcome_unknown', statusCode: 502, committed: 'unknown', message: (error as Error).message };
    }
    if (published['code'] === 412 || published['error'] === 'precondition_failed') fail('CAS publication refused a stale state', 412);
    if (published['published'] !== true) return { error: 'publication_refused', committed: false, published };
    // Publication has already happened. Never describe a postwrite verification failure as safe to retry.
    try {
      const after = await loadSurface(ref.surface, context);
      if (after.stateArtifact.cid === loaded.stateArtifact.cid || canonicalJson(after.session) !== canonicalJson(next)) fail('published successor did not verify as current');
      return { status: 200, verified: true, committed: true, published, beforeHead: loaded.stateArtifact.cid, view: await view(after, context) };
    } catch (error) { return { error: 'successor_verification_failed', statusCode: 502, committed: true, published, message: (error as Error).message }; }
    } catch (error) {
      if (error instanceof SurfaceError) return { error: 'surface_operation_refused', statusCode: error.status, committed: false, message: error.message };
      throw error;
    }
  },
};
export default composition;
