/**
 * THE LINE THIS BOT MUST NOT CROSS: A CONDUIT IS NOT AN AUTHOR.
 *
 * ★ WHY THIS FILE EXISTS AT ALL. The round that introduced delegates changed who an entry is
 * attributed to across the whole vertical, and the one place that had to stay EXACTLY as it was
 * is this one. A person types a message into Discord; this bot carries it to their pod. They
 * wrote the words, so the entry is theirs — `prov:wasAttributedTo <their WebID>`, and nothing
 * acted on anybody's behalf. Attributing it to the bot would be a lie in the opposite direction
 * from the one being fixed, and it is exactly the lie a careless application of "agents are
 * delegates" produces.
 *
 * ★ AND IT IS THE REAL PATH, NOT THE FORMATTER. `render.test.ts` pins what the bot SAYS about a
 * write; this drives `recordMessage` through every gate it has — the delegation check, the
 * workspace record, the seat, the chain derivation — against a scripted relay, and reads the
 * bytes that would have been published. A test on the sentence alone would keep passing while
 * the triple underneath it changed.
 *
 * SCRIPTED: the relay's tool surface, from the shapes the live drivers produced. REAL: every
 * line of `@interego/workspace-client` and of `workspace.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkspaceClient, graphRegion, readIriAll, DELEGATE_LABEL_PREFIX, type AnyTransport,
} from '@interego/workspace-client';
import { recordMessage } from '../src/workspace.js';
import type { Link, ThreadBinding } from '../src/links.js';

const RELAY = 'https://relay.interego.xwisee.com';
const CONV = 'u-eth-0123456789ab';
const MEMBER = 'u-eth-cafecafecafe';
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const BOT = 'did:web:identity.interego.xwisee.com:agents:interego-workspace-discord-u-eth-b0tb0tb0tb0t';
const SLUG = 'thread-1';
const WS = RELAY + '/ns/' + CONV + '/' + SLUG;
const SHAPE = RELAY + '/ns/' + CONV + '/' + SLUG + '-shapes';
const ROLES = RELAY + '/ns/' + CONV + '/' + SLUG + '-roles';
const GRANT = WS + '-grant-' + MEMBER;
const ACC = RELAY + '/ns/' + MEMBER + '/' + CONV + '--' + SLUG + '-acceptance';
const STREAM = RELAY + '/ns/' + MEMBER + '/' + CONV + '--' + SLUG + '-stream';
const DESC = (pod: string, n: number): string => 'http://css.railway.internal:3456/' + pod + '/context-graphs/' + n + '.ttl';

/** A TriG document shaped like the relay's: descriptor-level triples, then the signed block. */
const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<' + iri + '> {\n' + body + '\n}\n';

interface Doc { graph: string; cid: string; url: string; content: string }

/** The store the scripted relay answers from, so a test cannot assert an impossible state. */
function docs(): Doc[] {
  return [
    { graph: WS, cid: 'cid-ws', url: DESC(CONV, 3), content: trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "T" ;\n'
      + '  wsp:convener <' + WEBID(CONV) + '> ; wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + SHAPE + '> .') },
    { graph: GRANT, cid: 'cid-grant', url: DESC(CONV, 4), content: trig(GRANT, '<' + GRANT + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:grantedTo <' + WEBID(MEMBER) + '> ; wsp:role <' + ROLES + '#Contributor> .') },
    { graph: ACC, cid: 'cid-acc', url: DESC(MEMBER, 5), content: trig(ACC, '<' + ACC + '> a wsp:MembershipAcceptance ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:member <' + WEBID(MEMBER) + '> ; wsp:accepts <' + GRANT + '> ; wsp:acceptsCid "cid-grant" ; wsp:stream <' + STREAM + '> .') },
  ];
}

interface Run { readonly client: WorkspaceClient; readonly published: Record<string, unknown>[] }

function scripted(): Run {
  const store = docs();
  const published: Record<string, unknown>[] = [];
  const answer = (name: string, input: Record<string, unknown>): unknown => {
    switch (name) {
      case 'get_pod_status': {
        const pod = input['pod_name'] ? String(input['pod_name']) : CONV;
        return {
          pod: 'http://css.railway.internal:3456/' + pod + '/',
          registry: { owner: WEBID(pod) },
          // The bot is delegated on both pods, labelled the way a chat conduit's row is: NOT a
          // delegate label, because relaying somebody's own words is not authorship.
          delegationRegistry: { owner: WEBID(pod), rows: [{ agentId: BOT, scope: 'PublishOnly', label: 'discord-link 4242', validFrom: '2026-08-06T09:00:00.000Z' }] },
          sessionAgent: { did: BOT, scope: 'PublishOnly' },
        };
      }
      case 'verify_agent':
        return { subject_pod_name: input['pod_name'], verified: true, enforcement: { basis: 'signed-chain', scope: 'PublishOnly', writeEligible: true, note: '' } };
      case 'get_current_head': {
        const d = store.filter((x) => x.graph === String(input['urn'])).pop();
        return d ? { urn: input['urn'], head: { descriptorUrl: d.url, cid: d.cid } }
          : { urn: input['urn'], message: 'No descriptor on this pod describes the requested urn.' };
      }
      case 'get_descriptor': {
        const d = store.find((x) => x.url === String(input['url']));
        return d ? { graph: { content: d.content } } : { error: 'not_found', message: 'no descriptor at that url' };
      }
      case 'discover_context': {
        const pod = String(input['pod_name']);
        const graph = input['graph_iri'] ? String(input['graph_iri']) : null;
        const rows = store.filter((d) => d.url.includes('/' + pod + '/') && (!graph || d.graph === graph));
        return {
          pod: 'http://css.railway.internal:3456/' + pod + '/',
          entries: rows.map((d) => ({ descriptorUrl: d.url, cid: d.cid, validFrom: '2026-08-06T12:00:00.000Z', describes: [d.graph], supersedes: [] })),
        };
      }
      case 'dereference':
        return String(input['iri']) === ROLES
          ? { status: 'ok', contentType: 'text/turtle', representation:
            '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
            + '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n'
            + '<' + ROLES + '#Contributor> a wsp:Role ; rdfs:label "Contributor" ; wsp:permits <' + ROLES + '#Post> .\n' }
          : { status: 'error', httpStatus: 404 };
      case 'publish_context': {
        published.push(input);
        const n = 1000 + store.length;
        const url = DESC(String(input['pod_name']), n);
        store.push({ graph: String(input['graph_iri']), cid: 'cid-' + n, url, content: trig(String(input['graph_iri']), String(input['graph_content'])) });
        return { status: 'committed', descriptorUrl: url, cid: 'cid-' + n, authorship: { signed: true, signer: BOT } };
      }
      default: return { error: 'unknown_tool', message: name };
    }
  };
  const tx = {
    accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched in this test',
    connect: async () => ({ granted: [] }),
    callTool: async (name: string, input: Record<string, unknown>) => answer(name, input),
  } as unknown as AnyTransport;
  return { client: new WorkspaceClient(RELAY, tx), published };
}

const link = (): Link => ({ discordUserId: '4242', pod: MEMBER, webId: WEBID(MEMBER), boundAt: '', scopeAtBinding: 'PublishOnly', basisAtBinding: 'signed-chain' });
const binding = (): ThreadBinding => ({ threadId: 't1', convenerPod: CONV, workspace: WS, slug: SLUG, title: 'T', startedAt: '', startedBy: '4242' });

describe('a relayed message is the PERSON\'s entry, not the bot\'s', () => {
  it('★ attributes it to the human who typed it, and states no delegation at all', async () => {
    const run = scripted();
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'we should re-tile in spring' });

    expect(out.kind).toBe('recorded');
    expect(run.published).toHaveLength(1);
    const ttl = String(run.published[0]?.['graph_content']);
    const region = graphRegion(trig(STREAM, ttl), STREAM);

    // ★ THE PERSON. Not the bot's agent DID, and not an unstated author.
    expect(readIriAll(region, 'prov:wasAttributedTo')).toEqual([WEBID(MEMBER)]);
    // ★ AND NOTHING ACTED ON ANYBODY'S BEHALF. A conduit is not a delegate; asserting a
    // delegation here would put the bot in the author position of somebody's own sentence.
    expect(readIriAll(region, 'prov:actedOnBehalfOf')).toEqual([]);
    expect(ttl).not.toContain(BOT);
    // The write still lands on the PERSON's pod, under the bot's delegation.
    expect(run.published[0]?.['pod_name']).toBe(MEMBER);
  });

  it('the bot\'s own row is not a delegate row, so it is never read as an author', async () => {
    // The rows a chat conduit and a delegate write are deliberately labelled differently. A
    // reader folding this pod sees the bot as an agent that may write, and sees no delegate.
    const run = scripted();
    const status = await run.client.tool('get_pod_status', { pod_name: MEMBER }) as Record<string, unknown>;
    const rows = (status['delegationRegistry'] as { rows: Record<string, unknown>[] }).rows;
    expect(rows[0]?.['label']).toBe('discord-link 4242');
    expect(String(rows[0]?.['label'])).not.toContain(DELEGATE_LABEL_PREFIX);
  });
});
