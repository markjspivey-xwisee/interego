/**
 * WHO CAN STILL READ THE WORKSPACE RECORD AFTER SOMEBODY ELSE IS INVITED.
 *
 * ── ★★ THE LOCKOUT ──────────────────────────────────────────────────────────
 *
 * A reseal REPLACES the record's recipient set, and the record is what `verifyGrantIri` reads to
 * establish that a grant is real. So anybody the reseal omits cannot verify their own grant,
 * cannot accept it, and cannot ever become seated — a one-way door, opened by an operation
 * performed on behalf of somebody else entirely.
 *
 * `sendInvite` already carried seated members and outstanding invitations. What it did not carry
 * was the population in between: a member whose acceptance could not be READ. `foldRoster` marks
 * them `seated: false`, and `pending` is deliberately NOT set for a failed read, so they appeared
 * in neither list. A 502 from their pod during the fold — routine on this fleet — was enough.
 *
 * ── WHY THIS FILE IS NOT THE PLAN TEST ──────────────────────────────────────
 *
 * `workspace-recipients.test.ts` pins that the LIST is computed. Computing a correct list that
 * nothing passes to the reseal is the same lockout with better bookkeeping, so this drives the
 * real `sendInvite` and reads the recipients off the bytes it actually published.
 */
import { describe, it, expect } from 'vitest';
import { sendInvite, WorkspaceClient, type AnyTransport } from '@interego/workspace-client';

const RELAY = 'https://relay.example';
const CONV = 'u-conv';
const STUCK = 'u-stuck';
const NEW = 'u-new';
const WEBID = (p: string): string => 'https://identity.example/users/' + p + '/profile#me';
const WS = RELAY + '/ns/' + CONV + '/room';
const ROLES = WS + '-roles';
const SHAPE = WS + '-shapes';
const RECORD_URL = 'http://css.internal:3456/' + CONV + '/context-graphs/1.ttl';

const RECORD = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<' + WS + '> {\n<' + WS + '> a wsp:Workspace ; dct:title "Room" ; wsp:convener <' + WEBID(CONV) + '> ;\n'
  + '  wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + SHAPE + '> ; wsp:visibility "private" .\n}\n';

function recording(): { client: WorkspaceClient; published: Record<string, unknown>[] } {
  const published: Record<string, unknown>[] = [];
  /**
   * Mutable, because `publishAndConfirm` reads the head back and waits until it moves. A stub
   * whose store never changed did not fail the assertion — it spun for the whole confirm budget
   * and then timed out, which reads like a slow test rather than a fixture that cannot commit.
   */
  const store = new Map<string, { url: string; cid: string; content: string }>([
    [WS, { url: RECORD_URL, cid: 'cid-rec', content: RECORD }],
  ]);
  let n = 0;
  const answer = (name: string, input: Record<string, unknown>): unknown => {
    switch (name) {
      case 'resolve_webfinger': {
        const pod = String(input['resource'] ?? '').replace(/^acct:/, '').split('@')[0] ?? NEW;
        return { links: [{ rel: 'http://webfinger.net/rel/profile-page', href: 'http://css.internal:3456/' + pod + '/' }] };
      }
      case 'get_pod_status': {
        const pod = input['pod_name'] ? String(input['pod_name'])
          : String(input['pod_url'] ?? '').replace(/\/$/, '').split('/').pop() ?? CONV;
        return { pod: 'http://css.internal:3456/' + pod + '/', registry: { owner: WEBID(pod) } };
      }
      case 'get_current_head': {
        const d = store.get(String(input['urn']));
        return d ? { urn: input['urn'], head: { descriptorUrl: d.url, cid: d.cid } }
          : { urn: input['urn'], message: 'No descriptor on this pod describes the requested urn.' };
      }
      case 'get_descriptor': {
        for (const d of store.values()) if (d.url === String(input['url'])) return { graph: { content: d.content } };
        return { error: 'not_found' };
      }
      case 'publish_context': {
        published.push(input);
        n++;
        const iri = String(input['graph_iri']);
        const url = 'http://css.internal:3456/' + String(input['pod_name']) + '/context-graphs/' + (100 + n) + '.ttl';
        store.set(iri, { url, cid: 'cid-' + n, content: '<' + iri + '> {\n' + String(input['graph_content']) + '\n}\n' });
        return { status: 'committed', descriptorUrl: url, cid: 'cid-' + n };
      }
      case 'notify_agent': return { delivered: true };
      default: return {};
    }
  };
  const tx = {
    accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
    connect: async () => ({ granted: [] }),
    callTool: async (n: string, i: Record<string, unknown>) => answer(n, i),
  } as unknown as AnyTransport;
  return { client: new WorkspaceClient(RELAY, tx), published };
}

const viewer = { podName: CONV, webId: WEBID(CONV), podUrl: 'http://css.internal:3456/' + CONV + '/' } as never;

describe('★★ inviting somebody must not evict an existing member from the record', () => {
  it('★ seals the record to a member whose acceptance could not be read', async () => {
    const run = recording();
    const out = await sendInvite(run.client, {
      viewer, workspace: WS, workspaceTitle: 'Room', handle: 'acct:' + NEW + '@relay.example',
      role: ROLES + '#Contributor', entryShape: SHAPE, visibility: 'private',
      // The convener is seated. The stuck member is not — their pod answered 502 while the
      // roster was folded — so they appear in neither of the two older lists.
      shareWith: [WEBID(CONV)],
      pendingWebIds: [],
      grantedWebIds: [WEBID(CONV), WEBID(STUCK)],
    });
    expect(out.kind).toBe('invited');

    const reseal = run.published.find((p) => String(p['graph_iri']) === WS);
    expect(reseal, 'the private record was not re-sealed at all').toBeTruthy();
    const to = (reseal?.['share_with'] ?? []) as readonly string[];
    // ★ THE LOAD-BEARING ASSERTION, read off the bytes that were published rather than off the
    // plan that produced them.
    expect(to, 'an existing member was evicted from the record by somebody else being invited')
      .toContain(WEBID(STUCK));
    // And the two who were always right are still there.
    expect(to).toContain(WEBID(CONV));
    expect(to).toContain(WEBID(NEW));
  });

  it('and a caller that names nobody extra still reseals to exactly whom it named', async () => {
    // The other half: the widened set is a union, not a default. A caller passing only seated
    // members must not acquire recipients from anywhere.
    const run = recording();
    await sendInvite(run.client, {
      viewer, workspace: WS, workspaceTitle: 'Room', handle: 'acct:' + NEW + '@relay.example',
      role: ROLES + '#Contributor', entryShape: SHAPE, visibility: 'private',
      shareWith: [WEBID(CONV)],
    });
    const to = (run.published.find((p) => String(p['graph_iri']) === WS)?.['share_with'] ?? []) as readonly string[];
    expect([...to].sort()).toEqual([WEBID(CONV), WEBID(NEW)].sort());
  });
});
