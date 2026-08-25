/**
 * `/workspace show` said "newest 12 shown" and showed the tail of ONE member's log.
 *
 * ★ FOUND BY A SIX-LENS REVIEW OF THIS VERTICAL, then reproduced here against the real function.
 *
 * `showWorkspace` builds its row list seat by seat — each member's whole ordered chain appended
 * in turn — so the list is in SEAT order, not time order. It then took `rows.slice(-12)`. If the
 * last seat folded has twelve entries of its own, that slice is entirely theirs and **no other
 * member appears at all**, including the convener. The footer still says "newest 12 shown".
 *
 * The sort by `dct:created` that existed ran AFTER the slice, so it only ever reordered an
 * already-wrong twelve. Sorting after capping cannot repair a cap that chose the wrong twelve.
 *
 * ★ AND THE ORIGINAL TRADE-OFF DID NOT APPLY. The comment there said reading before capping
 * would cost a descriptor round trip per entry — true, and unnecessary: `validFrom` is already in
 * the manifest row the chain walk carried. The interleave now uses what has been fetched, and
 * only the twelve that survive are dereferenced.
 *
 * ── WHAT THIS ORDER IS ───────────────────────────────────────────────────────
 *
 * Each entry's own declared time and nothing stronger. Between two members the substrate
 * establishes no happens-before, which the function's own header says; within one member the
 * chain order is authoritative and survives, because a stable sort leaves equal keys alone.
 */
import { describe, it, expect } from 'vitest';
import { WorkspaceClient, type AnyTransport } from '@interego/workspace-client';
import { showWorkspace, SHOW_ENTRY_CAP } from '../src/workspace.js';
import type { ThreadBinding } from '../src/links.js';

const RELAY = 'https://relay.interego.xwisee.com';
const CONV = 'u-eth-c0nvenerc0nv';
const OTHER = 'u-eth-0thermemberx';
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const SLUG = 'thread-9';
const WS = RELAY + '/ns/' + CONV + '/' + SLUG;
const ROLES = WS + '-roles';
const SHAPE = WS + '-shapes';
const grantOf = (pod: string): string => WS + '-grant-' + pod;
const accOf = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-acceptance';
const streamOf = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-stream';

const DESC = (pod: string, n: string): string =>
  'http://css.railway.internal:3456/' + pod + '/context-graphs/' + n + '.ttl';

const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '@prefix prov: <http://www.w3.org/ns/prov#> .\n'
  + '<' + iri + '> {\n' + body + '\n}\n';

interface Doc { graph: string; url: string; cid: string; content: string; validFrom: string;
  sup?: readonly string[] }

/**
 * Two seats. The CONVENER wrote once and most recently; the other member wrote a full cap's
 * worth, all of it older. Seat order folds the convener FIRST, so their single newest entry sat
 * at the head of the row list and was the first thing a tail-slice discarded.
 */
function store(opts: { readonly otherClaimsFuture?: boolean; readonly otherClaimsPast?: boolean } = {}): Doc[] {
  const docs: Doc[] = [];
  const at = (n: number): string => '2026-08-2' + '0T' + String(n).padStart(2, '0') + ':00:00.000Z';

  docs.push({ graph: WS, url: DESC(CONV, 'ws'), cid: 'c1', validFrom: at(1),
    content: trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "T" ; wsp:convener <' + WEBID(CONV)
      + '> ; wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + SHAPE + '> .') });

  for (const pod of [CONV, OTHER]) {
    docs.push({ graph: grantOf(pod), url: DESC(CONV, 'grant-' + pod), cid: 'g-' + pod, validFrom: at(1),
      content: trig(grantOf(pod), '<' + grantOf(pod) + '> a wsp:MembershipGrant ; wsp:workspace <' + WS
        + '> ; wsp:grantedTo <' + WEBID(pod) + '> ; wsp:role <' + ROLES + '#Contributor> .') });
    docs.push({ graph: accOf(pod), url: DESC(pod, 'acc'), cid: 'a-' + pod, validFrom: at(1),
      content: trig(accOf(pod), '<' + accOf(pod) + '> a wsp:MembershipAcceptance ; wsp:workspace <' + WS
        + '> ; wsp:member <' + WEBID(pod) + '> ; wsp:accepts <' + grantOf(pod) + '> ; wsp:acceptsCid "g-'
        + pod + '" ; wsp:stream <' + streamOf(pod) + '> .') });
  }

  // The other member: a full cap of OLD entries, hours 02..13.
  for (let i = 0; i < SHOW_ENTRY_CAP; i++) {
    // ★ THE MANIFEST TIME IS THE AUTHOR'S TO CHOOSE — `publish_context` takes `valid_from`.
    // `dct:created` inside the signed region stays honest; only the manifest row is steered,
    // which is exactly the shape a member wanting the whole window would publish.
    const t = at(2 + i);
    const manifestAt = opts.otherClaimsFuture ? '2099-01-0' + (i % 9 + 1) + 'T00:00:00.000Z'
      : opts.otherClaimsPast ? '1971-01-0' + (i % 9 + 1) + 'T00:00:00.000Z'
      : t;
    docs.push({ graph: streamOf(OTHER), url: DESC(OTHER, 'other-' + i), cid: 'e-other-' + i, validFrom: manifestAt,
      sup: i === 0 ? [] : [DESC(OTHER, 'other-' + (i - 1))],
      content: trig(streamOf(OTHER), '<' + streamOf(OTHER) + '/e/' + i + '> a wsp:Entry ; wsp:seq ' + i
        + ' ; dct:created "' + t + '" ; dct:description "other ' + i + '" ; prov:wasAttributedTo <' + WEBID(OTHER) + '> .') });
  }
  // The convener: ONE entry, the NEWEST in the workspace.
  const newest = at(23);
  docs.push({ graph: streamOf(CONV), url: DESC(CONV, 'conv-0'), cid: 'e-conv-0', validFrom: newest,
    content: trig(streamOf(CONV), '<' + streamOf(CONV) + '/e/0> a wsp:Entry ; wsp:seq 0 ; dct:created "'
      + newest + '" ; dct:description "the convener speaks last" ; prov:wasAttributedTo <' + WEBID(CONV) + '> .') });
  return docs;
}

function scripted(opts: { readonly otherClaimsFuture?: boolean; readonly otherClaimsPast?: boolean } = {}): WorkspaceClient {
  const docs = store(opts);
  const answer = (name: string, input: Record<string, unknown>): unknown => {
    switch (name) {
      case 'get_pod_status': {
        const pod = input['pod_name'] ? String(input['pod_name'])
          : input['pod_url'] ? (String(input['pod_url']).replace(/\/$/, '').split('/').pop() ?? CONV) : CONV;
        return {
          pod: 'http://css.railway.internal:3456/' + pod + '/',
          registry: { owner: WEBID(pod) },
          delegationRegistry: { owner: WEBID(pod), rows: [] },
        };
      }
      case 'get_current_head': {
        const d = docs.filter((x) => x.graph === String(input['urn'])).pop();
        return d ? { urn: input['urn'], head: { descriptorUrl: d.url, cid: d.cid } }
          : { urn: input['urn'], message: 'No descriptor on this pod describes the requested urn.' };
      }
      case 'get_descriptor': {
        const d = docs.find((x) => x.url === String(input['url']));
        return d ? { graph: { content: d.content } } : { error: 'not_found' };
      }
      case 'discover_context': {
        const pod = String(input['pod_name']);
        const graph = input['graph_iri'] ? String(input['graph_iri']) : null;
        const rows = docs.filter((d) => graph
          ? d.graph === graph
          : d.url.indexOf('/' + pod + '/') > 0);
        return {
          pod: 'http://css.railway.internal:3456/' + pod + '/',
          entries: rows.map((d) => ({ descriptorUrl: d.url, cid: d.cid, validFrom: d.validFrom, describes: [d.graph], supersedes: d.sup ?? [] })),
        };
      }
      case 'dereference':
        return String(input['iri']) === ROLES
          ? { status: 'ok', contentType: 'text/turtle', representation:
            '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
            + '<' + ROLES + '#Contributor> a wsp:Role ; wsp:permits <' + ROLES + '#Post> .\n' }
          : { status: 'error', httpStatus: 404 };
      default: return {};
    }
  };
  const tx = {
    accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
    connect: async () => ({ granted: [] }),
    callTool: async (n: string, i: Record<string, unknown>) => answer(n, i),
  } as unknown as AnyTransport;
  return new WorkspaceClient(RELAY, tx);
}

const binding = (): ThreadBinding => ({
  threadId: 't9', convenerPod: CONV, workspace: WS, slug: SLUG, title: 'T', startedAt: '', startedBy: '1',
});

describe('/workspace show, when one member has written a whole cap\'s worth', () => {
  it('shows the NEWEST entries across everybody, not the tail of one log', async () => {
    const out = await showWorkspace(
      { relay: RELAY, client: scripted(), agentId: 'did:web:bot', store: { threadOf: () => binding() } as never },
      't9');

    expect(out.kind).toBe('view');
    if (out.kind !== 'view') return;

    // ★ THE ASSERTION THAT MATTERS. The convener wrote the single most recent entry in the
    // workspace; a view claiming to show the newest that omits it is claiming something false.
    const bodies = out.entries.map((e) => e.body);
    expect(bodies, 'the newest entry in the workspace was not shown')
      .toContain('the convener speaks last');

    // It is capped, and the cap is what was claimed.
    expect(out.entries).toHaveLength(SHOW_ENTRY_CAP);
    expect(out.truncated).toBe(true);

    // And what was dropped is the OLDEST, not somebody's whole participation.
    expect(bodies, 'the oldest entry survived a newest-N cap').not.toContain('other 0');
  });

  it('and keeps one member\'s own entries in their chain order', async () => {
    // The interleave must not reshuffle within a log: inside one pod the supersession chain is
    // authoritative, and nothing outside that pod can rewrite it.
    const out = await showWorkspace(
      { relay: RELAY, client: scripted(), agentId: 'did:web:bot', store: { threadOf: () => binding() } as never },
      't9');
    if (out.kind !== 'view') throw new Error('expected a view');
    const seqs = out.entries
      .filter((e) => String(e.body ?? '').startsWith('other '))
      .map((e) => e.seq);
    expect(seqs, 'one member\'s entries came back out of their own chain order')
      .toEqual([...seqs].sort((a, b) => Number(a) - Number(b)));
  });
});

describe('★★ the window cannot be taken by one member', () => {
  /**
   * ── THE SUPPRESSION PRIMITIVE THE SECOND VERSION OF THIS CODE HANDED OUT ────
   *
   * The first fix for the seat-order bug sorted by the manifest's `validFrom` before capping.
   * `valid_from` is a CALLER-SUPPLIED argument to `publish_context` — the relay stores
   * `(args.valid_from) ?? now` — so any member could date one entry far in the future, take the
   * entire twelve-row window with it, and evict every other member from `/workspace show` and
   * from the Discord mirror. That is strictly worse than the bug it replaced, which at least
   * could not be aimed.
   *
   * Selection is now by chain position, round-robin across logs. Nothing an author writes decides
   * who appears.
   */
  it('★ a member dating entries far in the future does not evict anybody', async () => {
    const out = await showWorkspace(
      { relay: RELAY, client: scripted({ otherClaimsFuture: true }), agentId: 'did:web:bot',
        store: { threadOf: () => binding() } as never },
      't9');
    if (out.kind !== 'view') throw new Error('expected a view');
    const bodies = out.entries.map((e) => e.body);
    expect(bodies, 'a member claiming a future validFrom evicted the convener')
      .toContain('the convener speaks last');
  });

  it('★ and a member dating them in the deep past cannot hide their own log either', async () => {
    // The mirror image: backdating used to push your rows off the oldest end of the window.
    const out = await showWorkspace(
      { relay: RELAY, client: scripted({ otherClaimsPast: true }), agentId: 'did:web:bot',
        store: { threadOf: () => binding() } as never },
      't9');
    if (out.kind !== 'view') throw new Error('expected a view');
    const fromOther = out.entries.filter((e) => String(e.body ?? '').startsWith('other '));
    expect(fromOther.length, 'a backdated log vanished from the channel entirely').toBeGreaterThan(0);
  });

  it('gives every log a turn before any log gets a second', async () => {
    // The fairness property stated directly: one member with a full cap of entries and one with a
    // single entry both appear, and the single one is not crowded out.
    const out = await showWorkspace(
      { relay: RELAY, client: scripted(), agentId: 'did:web:bot',
        store: { threadOf: () => binding() } as never },
      't9');
    if (out.kind !== 'view') throw new Error('expected a view');
    const pods = new Set(out.entries.map((e) => e.pod));
    expect(pods.size, 'only one member survived the cap').toBe(2);
  });
});
