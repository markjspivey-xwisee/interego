import { describe, expect, it, vi } from 'vitest';
import { parseHypermediaMarkdown } from '@interego/core';
import { ResourceCompositions, type ResourceDescriptor, type ResourceWriteContext, type ResourceView } from '../../../deploy/mcp-relay/resource-compositions.js';
import { signedJsonGraph } from '../../application-runtime/application-lab-runtime.js';
import composition from '../resource-composition.js';
import { protectResourcePublication } from '../../../deploy/mcp-relay/resource-publication.js';

const G = 'urn:interego:game:';
const H = 'http://www.w3.org/ns/hydra/core#';
function fixture(size = 9, columns = 3, marks = ['X', 'O']) {
  const root = 'urn:fixture:' + size + ':' + marks.join('');
  const ids = { surface: root + ':surface', registry: root + ':knowledge', contract: root + ':choices', engine: root + ':rules', state: root + ':session' };
  const pod = 'https://pod.example/test/'; const signer = 'did:example:surface-owner';
  const urls = Object.fromEntries(Object.keys(ids).map(key => [key, pod + key + '.ttl'])) as Record<keyof typeof ids, string>;
  const target = root + ':generic-target'; const actions = { state: root + ':read', move: root + ':place', reset: root + ':restart' };
  const docs = new Map<string, ResourceDescriptor>(); const heads = new Map<string, { cid: string; descriptorUrl: string }>();
  const trust = { authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true }, effectiveTrustLevel: 'CryptographicallyVerified', signedBy: signer };
  const put = (key: keyof typeof ids, content: string, cid = key + '-cid', url = urls[key]) => { docs.set(url, { url, cid, content, authorship: trust }); heads.set(ids[key], { cid, descriptorUrl: url }); };
  const lines = size === 9 ? ['0,1,2', '3,4,5', '6,7,8', '0,3,6', '1,4,7', '2,5,8', '0,4,8', '2,4,6'] : ['0,1', '2,3', '0,2', '1,3'];
  put('engine', `<${ids.engine}> <${G}positions> ${size}; <${G}empty> "."; <${G}players> "${marks.join(',')}"; <${G}startBoard> "${'.'.repeat(size)}"; <${G}startTurn> "${marks[0]}";
    <${G}winLine> ${lines.map(line => JSON.stringify(line)).join(', ')};
    <${G}legalRule> "move only to an empty position while status is in-progress";
    <${G}turnRule> "alternate players after each non-terminal move";
    <${G}terminalRule> "evaluate win first, then draw; terminal states expose no moves";
    <${G}resetRule> "board=startBoard; turn=startTurn; status=in-progress; winner absent; moveNumber=0" .`);
  const state = (board = '.'.repeat(size), moveNumber = 0, version = 0, status = 'in-progress', winner?: string, winningLine?: string) => `<${ids.state}> <${G}engine> <${ids.engine}>; <${G}board> "${board}";
    ${status === 'in-progress' ? `<${G}turn> "${marks[moveNumber % marks.length]}";` : ''} <${G}status> "${status}";
    ${winner ? `<${G}winner> "${winner}"; <${G}winningLine> "${winningLine}";` : ''} <${G}moveNumber> ${moveNumber}; <${G}sessionVersion> ${version} .`;
  put('state', state());
  put('contract', `<${ids.contract}> <${G}engine> <${ids.engine}>; <${G}session> <${ids.state}>; <${G}policy> "verified-minimal-edit"; <${G}requires> "cryptographically-verified-engine", "cryptographically-verified-session", "current-head-CAS" .\n` + Object.entries(actions).map(([operation, action]) => `<${action}:affordance> <https://markjspivey-xwisee.github.io/interego/ns/iep#action> <${action}>; <${G}operation> "${operation}"; <${H}method> "${operation === 'state' ? 'GET' : 'POST'}"; <${H}target> <${target}>
    ${operation === 'state' ? '' : `; <${H}expects> <${root}:shape:${operation}>; <${G}requires> ${operation === 'move' ? '"position-exposed-as-legal", "expected-head-matches-current-head", "engine-derived-successor"' : '"expected-head-matches-current-head", "engine-derived-reset"'}`} .`).join('\n')
    + `\n<${root}:shape:move> <${G}field> "position:integer[0..positions-1]", "expected_cid:CIDv1" .\n<${root}:shape:reset> <${G}field> "expected_cid:CIDv1" .`);
  const holons = Object.entries(actions).map(([operation, action]) => {
    const goal = operation === 'state' ? 'resume' : operation === 'move' ? 'play' : 'reset';
    const graph = [['?request', 'urn:reuse:goal', 'urn:reuse:' + goal], ['?request', 'urn:reuse:target', ids.state],
      ['?request', 'urn:reuse:requires', 'urn:reuse:authoritative'], ['?request', 'urn:reuse:requires', 'urn:reuse:verified'],
      [ids.state, G + 'currentHead', '?head'], [ids.state, G + 'engine', ids.engine]];
    if (operation !== 'state') graph.push(['?request', 'urn:reuse:requires', 'urn:reuse:cas']);
    if (operation === 'move') graph.push(['?request', G + 'selectedPosition', '?position'], [ids.state, G + 'legalPosition', '?position']);
    return { id: root + ':holon:' + operation, evidence: { successes: 8, failures: 0 }, views: [{ id: root + ':lens:' + operation, graph,
      preconditions: graph.filter(t => t[1] === 'urn:reuse:goal' || t[1] === G + 'legalPosition'),
      affordance: { descriptor_url: urls.contract, action_iri: action, method: operation === 'state' ? 'GET' : 'POST', target,
        payload: operation === 'state' ? {} : operation === 'move' ? { expected_cid: '?head', position: '?position' } : { expected_cid: '?head' } } }] };
  });
  put('registry', `<${ids.registry}> a <urn:nsdr:HolonRegistry>; <urn:nsdr:actionContract> <${ids.contract}> .\n` + holons.map(holon => `<${holon.id}> <urn:nsdr:registry> <${ids.registry}>; <urn:nsdr:jsonBase64> "${Buffer.from(JSON.stringify(holon)).toString('base64')}" .`).join('\n'));
  const surface = { schema: 'interego.resource-surface/v1', id: root + ':presentation', title: 'Resource board ' + size, interpreter: 'finite-board/v1',
    authority: { podUrl: pod, signer, actionTarget: target, registryGraphIri: ids.registry, contractGraphIri: ids.contract, engineGraphIri: ids.engine, stateGraphIri: ids.state }, presentation: { kind: 'grid', columns } };
  put('surface', signedJsonGraph(ids.surface, surface.schema, surface).graphContent);
  const publish = vi.fn(async (request: { expectedHead: string; graphContent: string }) => {
    if (request.expectedHead !== heads.get(ids.state)!.cid) return { error: 'precondition_failed', code: 412 };
    put('state', request.graphContent, 'successor-cid', pod + 'state-successor.ttl'); return { published: true, descriptorUrl: pod + 'state-successor.ttl' };
  });
  const context: ResourceWriteContext = { principal: signer, now: '2026-09-12T00:00:00Z', identityUrl: 'https://identity.example', reads: {
    currentHead: async (_pod, graph) => ({ forked: false, head: heads.get(graph) }), descriptor: async url => docs.get(url) ?? Promise.reject(new Error('missing descriptor')),
    discover: async () => [], discoverGraph: async () => [],
  }, publish };
  const modules = new ResourceCompositions([composition]);
  const open = () => modules.render(urls.surface, context, docs.get(urls.surface));
  return { ids, urls, docs, heads, put, state, context, publish, modules, open, actions };
}
function control(view: ResourceView, id: string) { return view.controls.find(control => control['id'] === id)!; }
async function invoke(f: ReturnType<typeof fixture>, c: Record<string, unknown>, payload = c['payload']) { return f.modules.invoke(String(c['descriptorUrl']), String(c['action']), payload, f.context); }

describe('signed resource surface composition', () => {
  it.each(['public', 'private', 'shared'] as const)('applies generic audience preservation to a %s board successor', async visibility => {
    const f = fixture();
    const view = (await f.open())!;
    const reads = { ...f.context.reads, descriptor: async (url: string) => {
      const descriptor = await f.context.reads.descriptor(url);
      const audience = url === f.urls.state || url.endsWith('/state-successor.ttl') ? visibility : 'public';
      const payload = url + '.payload';
      return { ...descriptor, distribution: { url: payload, encrypted: audience !== 'public' }, turtle: `
        @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
        @prefix dcat: <http://www.w3.org/ns/dcat#> .
        <> iep:affordance [ a dcat:Distribution; dcat:accessURL <${payload}>;
          iep:encrypted ${audience !== 'public'}; iep:visibility "${audience}" ] .` };
    } };
    const sink = vi.fn(async (request: Parameters<ResourceWriteContext['publish']>[0], _audience: 'public' | 'private') => f.publish(request));
    const context = { ...f.context, ...protectResourcePublication(reads, f.context.principal, sink) };
    const c = control(view, 'position-4');
    const result = await f.modules.invoke(String(c['descriptorUrl']), String(c['action']), c['payload'], context);
    if (visibility === 'shared') {
      expect(result).toMatchObject({ error: 'publication_refused', committed: false });
      expect(f.publish).not.toHaveBeenCalled();
      expect(sink).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ committed: true, verified: true });
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ graphIri: f.ids.state, expectedHead: 'state-cid' }), visibility);
      expect((result!['view'] as ResourceView)['snapshot']).toMatchObject({ state: { board: '....X....', sessionVersion: 1 } });
    }
  });
  it('opens arbitrary graph/action IDs with verified evidence and zero writes; HMD carries typed authority-closed controls', async () => {
    const f = fixture(); const view = (await f.open())!;
    expect(view['snapshot']).toMatchObject({ trust: { verified: true, artifactsVerified: 5, artifactsTotal: 5 } });
    expect(view['views']).toMatchObject([{ columns: 3, cells: expect.any(Array) }]);
    expect(f.publish).not.toHaveBeenCalled();
    const parsed = parseHypermediaMarkdown(view.hmd); expect(parsed.controls).toHaveLength(1); expect(parsed.controls[0]!.action).toBe(f.actions.state);
    expect(view['planning']).toMatchObject({ policy: 'verified-minimal-edit', reaction: { frontier: expect.any(Array) }, decision: { disposition: 'invoke' } });
    const refresh = control(view, 'refresh'); expect((await invoke(f, refresh))!['snapshot']).toMatchObject({ trust: { verified: true } }); expect(f.publish).not.toHaveBeenCalled();
  });
  it('interprets a second 2×2 signed engine with other player marks', async () => {
    const f = fixture(4, 2, ['A', 'B']); const view = (await f.open())!;
    expect(view['views']).toMatchObject([{ columns: 2, cells: [{ label: '0' }, { label: '1' }, { label: '2' }, { label: '3' }] }]);
    const result = await invoke(f, control(view, 'position-2')); expect(result).toMatchObject({ committed: true, verified: true });
    expect((result!['view'] as ResourceView)['snapshot']).toMatchObject({ state: { board: '..A.', turn: 'B', sessionVersion: 1 } });
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ graphIri: f.ids.state, expectedHead: 'state-cid' }));
  });
  it('renders each selected action as a typed HMD review bound to unchanged inputs', async () => {
    const f = fixture(); const view = (await f.open())!; const cell = control(view, 'position-4');
    const review = (await f.modules.render(String(cell['descriptorUrl']), f.context))!;
    expect(parseHypermediaMarkdown(review.hmd).controls[0]).toMatchObject({ action: f.actions.move, method: 'POST', fields: expect.arrayContaining([expect.objectContaining({ name: 'expected_cid' }), expect.objectContaining({ name: 'position' })]) });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(['authorshipVerified', 'contentBinding', 'signedBy', 'descriptorBinding'])('refuses forged or unbound %s evidence', async field => {
    const f = fixture(); const original = f.docs.get(f.urls.engine)!;
    f.docs.set(f.urls.engine, { ...original, authorship: { ...original.authorship, [field]: field === 'authorshipVerified' ? false : field === 'descriptorBinding' ? { bound: false } : 'forged' } });
    await expect(f.open()).rejects.toThrow(/signature/); expect(f.publish).not.toHaveBeenCalled();
  });
  it('refuses current-head forks and CID substitution', async () => {
    const f = fixture(); f.context.reads.currentHead = async () => ({ forked: true, head: f.heads.get(f.ids.state) });
    await expect(f.open()).rejects.toThrow(/fork/); expect(f.publish).not.toHaveBeenCalled();
    const g = fixture(); g.docs.set(g.urls.state, { ...g.docs.get(g.urls.state)!, cid: 'other-cid' });
    await expect(g.open()).rejects.toThrow(/content address/);
  });
  it('rejects stale clicks with 412 before publication', async () => {
    const f = fixture(); const view = (await f.open())!; const cell = control(view, 'position-1');
    f.put('state', f.state('X........', 1, 1), 'newer-state');
    expect(await invoke(f, cell)).toMatchObject({ committed: false, statusCode: 412 }); expect(f.publish).not.toHaveBeenCalled();
  });
  it('rejects forged payloads, selected targets and contract drift before writing', async () => {
    const f = fixture(); const view = (await f.open())!; const cell = control(view, 'position-1');
    expect(await invoke(f, cell, { expected_cid: 'state-cid', position: 2 })).toMatchObject({ statusCode: 412 });
    const url = String(cell['descriptorUrl']); const prefix = 'urn:interego:resource-surface:v1:';
    const decoded = JSON.parse(Buffer.from(url.slice(prefix.length), 'base64url').toString()); decoded.selected.target = 'urn:attacker';
    expect(await invoke(f, { ...cell, descriptorUrl: prefix + Buffer.from(JSON.stringify(decoded)).toString('base64url') })).toMatchObject({ statusCode: 412 });
    const contract = f.docs.get(f.urls.contract)!; f.put('contract', contract.content!.replace(/urn:fixture:9:XO:generic-target/g, 'urn:replacement'), 'changed-contract');
    expect(await invoke(f, cell)).toMatchObject({ committed: false }); expect(f.publish).not.toHaveBeenCalled();
  });
  it('terminal boards expose no executable cells and opening never resets', async () => {
    const f = fixture(); f.put('state', f.state('XXXOO....', 5, 14, 'won', 'X', '0,1,2'));
    const view = (await f.open())!; const grids = view['views'] as { cells: { control?: string }[] }[];
    expect(grids[0]!.cells.every(cell => cell.control === undefined)).toBe(true); expect(control(view, 'reset')['confirmation']).toMatch(/Reset/);
    expect(view['snapshot']).toMatchObject({ state: { sessionVersion: 14, status: 'won' } }); expect(f.publish).not.toHaveBeenCalled();
  });
  it('fails closed on unknown rule DSL and mismatched registry method/target', async () => {
    const f = fixture(); const engine = f.docs.get(f.urls.engine)!; f.put('engine', engine.content!.replace('move only to an empty position while status is in-progress', 'execute arbitrary script'));
    await expect(f.open()).rejects.toThrow(/unsupported signed engine rule/);
    const g = fixture(); const contract = g.docs.get(g.urls.contract)!; g.put('contract', contract.content!.replace(/urn:fixture:9:XO:generic-target/g, 'urn:other-target'));
    await expect(g.open()).rejects.toThrow(/target/);
  });
  it('keeps publication truthful when successor verification fails and never repeats the write', async () => {
    const f = fixture(); const view = (await f.open())!;
    f.publish.mockImplementationOnce(async () => ({ published: true, descriptorUrl: 'https://pod.example/committed.ttl' }));
    expect(await invoke(f, control(view, 'position-0'))).toMatchObject({ error: 'successor_verification_failed', committed: true, published: { published: true } }); expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('preserves uncertain transport outcomes and explicit CAS refusal', async () => {
    const f = fixture(); const view = (await f.open())!; f.publish.mockRejectedValueOnce(new Error('connection lost'));
    expect(await invoke(f, control(view, 'position-0'))).toMatchObject({ error: 'publication_outcome_unknown', committed: 'unknown' });
    f.publish.mockResolvedValueOnce({ error: 'precondition_failed', code: 412 });
    expect(await invoke(f, control(view, 'position-0'))).toMatchObject({ committed: false, statusCode: 412 });
  });
  it('rejects forged read references even though read actions cannot publish', async () => {
    const f = fixture(); const view = (await f.open())!; const c = control(view, 'refresh');
    const prefix = 'urn:interego:resource-surface:v1:'; const ref = JSON.parse(Buffer.from(String(c['descriptorUrl']).slice(prefix.length), 'base64url').toString());
    ref.selected.target = 'urn:forged-read-target'; const url = prefix + Buffer.from(JSON.stringify(ref)).toString('base64url');
    expect(await invoke(f, { ...c, descriptorUrl: url })).toMatchObject({ statusCode: 412, committed: false });
    await expect(f.modules.render(url, f.context)).rejects.toThrow(/tuple/); expect(f.publish).not.toHaveBeenCalled();
  });
  it('rejects input-shape/condition drift and signed contract pointer substitution', async () => {
    for (const [before, after] of [['expected_cid:CIDv1', 'admin_key:string'], ['engine-derived-successor', 'skip-verification'], [':session>', ':other-session>']] as const) {
      const f = fixture(); const contract = f.docs.get(f.urls.contract)!; f.put('contract', contract.content!.replaceAll(before, after));
      await expect(f.open()).rejects.toThrow(); expect(f.publish).not.toHaveBeenCalled();
    }
  });
  it('blocks a different actor before publish and disables write controls', async () => {
    const f = fixture(); const view = (await f.open())!; const c = control(view, 'position-0');
    const other = { ...f.context, principal: 'did:example:another-actor' };
    expect(await f.modules.invoke(String(c['descriptorUrl']), String(c['action']), c['payload'], other)).toMatchObject({ statusCode: 403, committed: false });
    const otherView = (await f.modules.render(f.urls.surface, other, f.docs.get(f.urls.surface)))!;
    expect(control(otherView, 'position-0')['executable']).toBe(false); expect(f.publish).not.toHaveBeenCalled();
  });
  it('rejects an impossible alternating-player state without claiming historical replay', async () => {
    const f = fixture(); f.put('state', f.state('XX.......', 2, 2));
    await expect(f.open()).rejects.toThrow(/inconsistent/); expect(f.publish).not.toHaveBeenCalled();
  });
  it('preserves signed session metadata and reads legacy wrapped-prefix payloads', async () => {
    const f = fixture(); const state = f.docs.get(f.urls.state)!;
    f.put('state', state.content! + `\n<${f.ids.state}> <http://purl.org/dc/terms/title> "Existing session title"; <urn:fixture:metadata> [ <urn:fixture:value> "retained" ] .`);
    const engine = f.docs.get(f.urls.engine)!;
    f.put('engine', `<${f.ids.engine}> {\n    @prefix kept: <urn:fixture:kept:> .\n${engine.content}\n}\n`);
    const view = (await f.open())!; const result = await invoke(f, control(view, 'position-0'));
    expect(result).toMatchObject({ committed: true });
    const written = f.publish.mock.calls[0]![0].graphContent; expect(written).toContain('Existing session title'); expect(written).toContain('retained');
  });
});
