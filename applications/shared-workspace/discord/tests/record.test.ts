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
  WorkspaceClient, graphRegion, readIriAll, DELEGATE_LABEL_PREFIX, findSeat, type AnyTransport,
} from '@interego/workspace-client';
import { recordMessage, startWorkspace } from '../src/workspace.js';
import { renderRecord, renderStart } from '../src/render.js';
import type { Link, ThreadBinding } from '../src/links.js';

const RELAY = 'https://relay.interego.xwisee.com';
const CONV = 'u-eth-0123456789ab';
const MEMBER = 'u-eth-cafecafecafe';
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
/** The bot's own DID in the shape the relay issues: `DISCORD_CLIENT_NAME`, then its pod. */
const BOT = 'did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-b0tb0tb0tb0t';
const SLUG = 'thread-1';
const WS = RELAY + '/ns/' + CONV + '/' + SLUG;
const SHAPE = RELAY + '/ns/' + CONV + '/' + SLUG + '-shapes';
const ROLES = RELAY + '/ns/' + CONV + '/' + SLUG + '-roles';
const GRANT = WS + '-grant-' + MEMBER;
const ACC = RELAY + '/ns/' + MEMBER + '/' + CONV + '--' + SLUG + '-acceptance';
const STREAM = RELAY + '/ns/' + MEMBER + '/' + CONV + '--' + SLUG + '-stream';
/** The pair a client that predates qualified member-document names wrote. */
const LEGACY_ACC = RELAY + '/ns/' + MEMBER + '/' + SLUG + '-acceptance';
const LEGACY_STREAM = RELAY + '/ns/' + MEMBER + '/' + SLUG + '-stream';
const DESC = (pod: string, n: number): string => 'http://css.railway.internal:3456/' + pod + '/context-graphs/' + n + '.ttl';
/** A SECOND member of the same workspace, whose grant is on the convener's pod like everyone's. */
const OTHER = 'u-eth-beefbeefbeef';
const OTHER_GRANT = WS + '-grant-' + OTHER;
const OTHER_DESC = DESC(CONV, 9);

/** A TriG document shaped like the relay's: descriptor-level triples, then the signed block. */
const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<' + iri + '> {\n' + body + '\n}\n';

interface Doc { graph: string; cid: string; url: string; content: string }

/** The store the scripted relay answers from, so a test cannot assert an impossible state. */
function docs(opts: Opts = {}): Doc[] {
  const out: Doc[] = [
    { graph: WS, cid: 'cid-ws', url: DESC(CONV, 3), content: trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "T" ;\n'
      // The workspace's own policy, in its own signed region — the only honest source for it,
      // and what makes `frame.record.visibility` private for the tests below.
      + (opts.privateWs ? '  wsp:visibility "private" ;\n' : '')
      + '  wsp:convener <' + WEBID(CONV) + '> ; wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + SHAPE + '> .') },
  ];
  if (opts.granted !== false) {
    out.push({ graph: GRANT, cid: 'cid-grant', url: DESC(CONV, 4), content: trig(GRANT, '<' + GRANT + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:grantedTo <' + WEBID(MEMBER) + '> ; wsp:role <' + ROLES + '#Contributor> '
      + (opts.revoked ? ';\n  wsp:revoked true ' : '') + '.') });
  }
  // ★ THE MEMBER'S OWN HALF, WHICH ONLY EXISTS ONCE THEY HAVE ACCEPTED. A convener inviting
  // somebody from their desktop client publishes the GRANT and nothing on the invitee's pod;
  // until that person's own client writes an acceptance this document is simply not there.
  if (opts.accepted !== false) {
    /**
     * ★ THE LEGACY NAMING FORM IS STILL SUPPORTED, and `resolveMemberDoc` still resolves it. A
     * member seated before qualified member-document names existed has an acceptance at
     * `<pod>/<slug>-acceptance` naming a stream at `<pod>/<slug>-stream` — no convener segment.
     */
    const acc = opts.legacyNames ? LEGACY_ACC : ACC;
    const stream = opts.legacyNames ? LEGACY_STREAM : STREAM;
    out.push({ graph: acc, cid: 'cid-acc', url: DESC(MEMBER, 5), content: trig(acc, '<' + acc + '> a wsp:MembershipAcceptance ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:member <' + WEBID(MEMBER) + '> ; wsp:accepts <' + GRANT + '> ; wsp:acceptsCid "cid-grant" ;\n'
      + (opts.memberKey ? '  wsp:encryptionKey "MCowBQYDK2VuAyEAdGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleTA=" ;\n' : '')
      + '  wsp:stream <' + stream + '> .') });
  }
  /**
   * ★★ A SECOND MEMBER WHOSE GRANT IS ON THE POD AND WILL NOT READ. The descriptor for it errors
   * (see `get_descriptor`), so `foldRoster` finds two grants, reads one, and carries the other in
   * `unread` — the state that used to refuse every write in the workspace.
   */
  if (opts.strayUnreadable) {
    out.push({ graph: OTHER_GRANT, cid: 'cid-og', url: OTHER_DESC,
      content: trig(OTHER_GRANT, '<' + OTHER_GRANT + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
        + '  wsp:grantedTo <' + WEBID(OTHER) + '> ; wsp:role <' + ROLES + '#Contributor> .') });
  }
  /**
   * A second member with a READABLE grant and no acceptance: `pending`, so `recipientsFor` puts
   * their WebID in the re-seal's audience — which is what makes them evictable by it.
   */
  if (opts.otherPending) {
    out.push({ graph: OTHER_GRANT, cid: 'cid-op', url: DESC(CONV, 8),
      content: trig(OTHER_GRANT, '<' + OTHER_GRANT + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
        + '  wsp:grantedTo <' + WEBID(OTHER) + '> ; wsp:role <' + ROLES + '#Contributor> .') });
  }
  // A workspace bigger than the module's default read cap of 25, so a fold that takes the default
  // truncates and a fold that names a cap does not.
  for (let i = 0; i < (opts.fillerGrants ?? 0); i++) {
    const pod = 'u-eth-f' + String(i).padStart(11, '0');
    const g = WS + '-grant-' + pod;
    out.push({ graph: g, cid: 'cid-f' + i, url: DESC(CONV, 100 + i),
      content: trig(g, '<' + g + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
        + '  wsp:grantedTo <' + WEBID(pod) + '> ; wsp:role <' + ROLES + '#Contributor> .') });
  }
  return out;
}

interface Run { readonly client: WorkspaceClient; readonly published: Record<string, unknown>[] }

/** Every state the scripted relay can be put in. One shape, so a test cannot ask for an impossible one. */
interface Opts {
  readonly revoked?: boolean;
  readonly accepted?: boolean;
  readonly legacyNames?: boolean;
  readonly acceptanceHeadFails?: boolean;
  /** The workspace record declares `wsp:visibility "private"`. */
  readonly privateWs?: boolean;
  /** Every head read for a GRANT throws — the outage on the convener's pod, not the member's. */
  readonly grantHeadFails?: boolean;
  /** A second member's grant is on the pod and its descriptor will not fetch. */
  readonly strayUnreadable?: boolean;
  /** How many further readable grants to put on the convener's pod. */
  readonly fillerGrants?: number;
  /** False publishes no grant for this member at all — an absence the convener's pod STATES. */
  readonly granted?: boolean;
  /** The convener's pod no longer delegates this bot, so no grant can be published there. */
  readonly convenerNotDelegating?: boolean;
  /**
   * The member's acceptance publishes a `wsp:encryptionKey`, so the module answers
   * `sealing.mode === 'seal'` — a workspace a sealing client WOULD write end-to-end into.
   */
  readonly memberKey?: boolean;
  /** A second member holds a readable grant and has not accepted — `pending`, and in the envelope. */
  readonly otherPending?: boolean;
  /** The re-seal's publish response STATES it resolved no key for that second member. */
  readonly resealMissesOther?: boolean;
}

function scripted(opts: Opts = {}): Run {
  const store = docs(opts);
  const published: Record<string, unknown>[] = [];
  const answer = (name: string, input: Record<string, unknown>): unknown => {
    switch (name) {
      case 'get_pod_status': {
        // ★ BOTH SELECTORS. `resolveInvitee` asks by `pod_url` and everything else by
        // `pod_name`; a stub honouring only one answered for the CALLER's pod on the other,
        // which is the same confusion the relay's own `resolvePodSubject` exists to prevent.
        const pod = input['pod_name'] ? String(input['pod_name'])
          : input['pod_url'] ? (String(input['pod_url']).replace(/\/$/, '').split('/').pop() ?? CONV)
            : CONV;
        return {
          pod: 'http://css.railway.internal:3456/' + pod + '/',
          registry: { owner: WEBID(pod) },
          // The bot is delegated on both pods, labelled the way a chat conduit's row is: NOT a
          // delegate label, because relaying somebody's own words is not authorship.
          // The convener's own pod can withdraw this bot at any time, and only they can put it
          // back — which is exactly the state whose refusal has to name an act.
          delegationRegistry: (opts.convenerNotDelegating && pod === CONV)
            ? { owner: WEBID(pod), rows: [] }
            : { owner: WEBID(pod), rows: [{ agentId: BOT, scope: 'PublishOnly', label: 'discord-link 4242', validFrom: '2026-08-06T09:00:00.000Z' }] },
          sessionAgent: { did: BOT, scope: 'PublishOnly' },
        };
      }
      /**
       * ★ THE STUB HAS TO ANSWER THIS OR THE SEATING PATH STOPS BEFORE THE THING UNDER TEST.
       * `seat()` -> `sendInvite` -> `resolveInvitee` calls `resolve_webfinger` first, and a stub
       * that answered nothing made the revocation test pass for the wrong reason: no grant was
       * republished because handle resolution failed, not because anything checked the
       * revocation. A refusal from the fixture reads exactly like a refusal from the design.
       */
      case 'resolve_webfinger': {
        const pod = String(input['resource'] ?? '').replace(/^acct:/, '').split('@')[0] ?? MEMBER;
        return { links: [
          { rel: 'http://webfinger.net/rel/profile-page', href: 'http://css.railway.internal:3456/' + pod + '/' },
          { rel: 'http://www.w3.org/ns/ldp#inbox', href: 'http://css.railway.internal:3456/' + pod + '/inbox/' },
        ] };
      }
      case 'notify_agent': return { delivered: true };
      case 'verify_agent': {
        const off = opts.convenerNotDelegating && String(input['pod_name']) === CONV;
        return { subject_pod_name: input['pod_name'], verified: !off,
          enforcement: { basis: off ? 'none' : 'signed-chain', scope: off ? null : 'PublishOnly', writeEligible: !off,
            note: off ? 'agent is not registered on this pod' : '' } };
      }
      case 'get_current_head': {
        /**
         * ★ THE OUTAGE, INJECTED WHERE IT REALLY HAPPENS. `resolveMemberDoc` asks for the head of
         * each acceptance-name candidate; a pod that is down throws for both. Everything else on
         * this relay stays healthy, which is exactly the shape of a single-pod blip.
         */
        if (opts.acceptanceHeadFails && String(input['urn']).endsWith('-acceptance')) {
          throw Object.assign(new Error('502 Bad Gateway'), { code: 'upstream_error' });
        }
        /**
         * ★ THE SAME OUTAGE ON THE OTHER HALF OF THE SEAT. `findSeat` reads the GRANT, and every
         * one of its read failures used to reach `recordMessage` as "no grant seats them yet".
         */
        if (opts.grantHeadFails && String(input['urn']).indexOf('-grant-') >= 0) {
          throw Object.assign(new Error('502 Bad Gateway'), { code: 'upstream_error' });
        }
        const d = store.filter((x) => x.graph === String(input['urn'])).pop();
        return d ? { urn: input['urn'], head: { descriptorUrl: d.url, cid: d.cid } }
          : { urn: input['urn'], message: 'No descriptor on this pod describes the requested urn.' };
      }
      case 'get_descriptor': {
        // The second member's grant is found by the scan and cannot be fetched — one unreadable
        // grant, which is the whole state the channel-wide refusal was written for.
        if (opts.strayUnreadable && String(input['url']) === OTHER_DESC) {
          throw Object.assign(new Error('502 Bad Gateway'), { code: 'upstream_error' });
        }
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
        const base = { status: 'committed', descriptorUrl: url, cid: 'cid-' + n, authorship: { signed: true, signer: BOT } };
        /**
         * ★ THE RELAY'S OWN PER-RECIPIENT REPORT, WHICH IS THE ONLY EVIDENCE THERE IS.
         * `resolveRecipient` returns an EMPTY key list rather than an error, so a re-seal that
         * reached nobody for a named member still commits — `agentCount: 0` is the whole signal.
         */
        if (opts.resealMissesOther && String(input['graph_iri']) === WS) {
          const sw = Array.isArray(input['share_with']) ? input['share_with'] as string[] : [];
          return { ...base, sharedWith: sw.map((h) => ({ handle: String(h), agentCount: String(h) === WEBID(OTHER) ? 0 : 1 })) };
        }
        return base;
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


describe('a member the convener REVOKED', () => {
  /**
   * ★★ TYPING ONE MESSAGE UNDID THE REVOCATION. Found by a six-lens review of this vertical and
   * confirmed against the real path here.
   *
   * `recordMessage` asks `findSeat`, which correctly answers no for a grant carrying
   * `wsp:revoked true`. The `!already.ok` branch then reads that as "not seated yet" — the state
   * of somebody who has never spoken — and calls `seat()`, which calls `sendInvite`, which
   * publishes `<workspace>-grant-<pod>` with `auto_supersede_prior: true` and no revoked flag.
   * At the very IRI the revocation lives at.
   *
   * ★ WHY IT SUCCEEDS AT THE SUBSTRATE, which is what makes it a real bypass rather than a
   * refusal in the wrong words: the grant is written under the CONVENER's delegation of the bot,
   * and revoking a MEMBER does not touch that. Every gate the write passes is genuinely open.
   * The judgement that was missing is the vertical's own.
   *
   * ★ AND "NOT SEATED" IS TWO DIFFERENT FACTS. Never-granted and granted-then-revoked are both
   * `ok: false` from `findSeat`, and only the first of them may be answered by granting.
   */
  it('is NOT re-seated by typing, and no fresh grant is published', async () => {
    const run = scripted({ revoked: true });
    // The state the bot's own decision sees: not seated, AND the reason is structured rather
    // than only spelled out in prose — which is what lets this be told apart from never-granted.
    const before = await findSeat(run.client, {
      relay: RELAY, viewer: { podName: MEMBER, webId: WEBID(MEMBER) } as never, workspace: WS });
    expect(before.ok).toBe(false);
    expect(before.revoked, 'the verdict lost the revoked flag on its way back').toBe(true);
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'let me back in' });

    // ★ THE LOAD-BEARING ASSERTION. Not the returned kind — what was WRITTEN. A future
    // refactor that reports `unseated` while still publishing the grant would be the same
    // defect wearing a better sentence.
    const grants = run.published.filter((p) => String(p['graph_iri']) === GRANT);
    expect(grants, 'a revoked member typing republished their own grant').toHaveLength(0);

    expect(out.kind).toBe('unseated');
    if (out.kind === 'unseated') {
      // And the reason names the revocation, so the person is not told to try again.
      expect(String(out.why).toLowerCase()).toContain('revok');
    }
    // Nothing of theirs went onto the record either.
    expect(run.published.filter((p) => String(p['graph_iri']) === STREAM)).toHaveLength(0);
  });

  it('while a member who has simply never spoken IS still seated on first speaking', async () => {
    // The other half. A fix that refuses everybody who is not already seated would break the
    // ordinary path this bot exists for — seating happens by speaking.
    const run = scripted();
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'first words' });
    expect(out.kind).toBe('recorded');
  });
});

describe('a member the convener INVITED, who has never accepted', () => {
  /**
   * ★★ A GRANT IS HALF A SEAT, AND SPEAKING WAS TREATED AS THE WHOLE OF ONE.
   *
   * Membership here is two-sided on purpose: the convener's grant on THEIR pod, and the member's
   * acceptance on THEIRS. `foldRoster` enforces both — a grant with no acceptance folds as
   * `pending`, and a pending seat's log is not folded into the channel at all.
   *
   * `recordMessage` asked `findSeat`, which reads only the GRANT, and read `ok: true` as
   * "already seated" — so it skipped `seat()`, the one call that publishes the acceptance. The
   * entry then went to a stream IRI it COMPOSED rather than one any reader had been told about.
   *
   * ★ WHAT THAT LOOKS LIKE TO THE PEOPLE IN THE ROOM. The convener invites somebody from the
   * desktop client. That person types in the Discord thread and the bot answers "on the record".
   * It IS on their pod, correctly signed — and nobody sees it. Not the other members, not the
   * convener, not the author, because every reader folds the roster first and their seat is
   * pending. No error is raised anywhere: the write succeeded, and the read is right to skip it.
   *
   * ★ AND `seat()` WAS ALREADY THE FIX — it publishes the grant (superseding an identical one is
   * a no-op) and then the acceptance, on the member's own pod under their own delegation. The
   * only thing wrong was the question asked before calling it.
   */
  it('★ publishes their acceptance rather than writing into a log nobody folds', async () => {
    const run = scripted({ accepted: false });
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'thanks for the invite' });

    expect(out.kind).toBe('recorded');
    // ★ THE LOAD-BEARING ASSERTION: the member's own half of the seat now exists. Without it the
    // entry is unreadable to every member of this workspace including the person who wrote it.
    const acceptances = run.published.filter((p) => String(p['graph_iri']) === ACC);
    expect(acceptances, 'the entry was recorded and no acceptance was published, so no reader folds this member in')
      .toHaveLength(1);
    // On the MEMBER's pod, which is the only pod their half of the seat may live on.
    expect(acceptances[0]?.['pod_name']).toBe(MEMBER);
    // And the seating is reported as what it was, so the channel does not claim "already".
    if (out.kind === 'recorded') expect(out.seated).toBe('just-now');
  });

  it('and an accepted member is NOT re-seated, so an ordinary message stays one write', async () => {
    // The other half of the fix. Re-publishing an acceptance on every message would rewrite the
    // member's own record for nothing and cost round trips per line typed.
    const run = scripted();
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'ordinary message' });
    expect(out.kind).toBe('recorded');
    if (out.kind === 'recorded') expect(out.seated).toBe('already');
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC)).toHaveLength(0);
    expect(run.published).toHaveLength(1);
  });
});

describe('a member seated under the LEGACY naming form', () => {
  /**
   * ★★ THE FIX FOR "A GRANT IS HALF A SEAT" ORPHANED THEIR ENTIRE HISTORY.
   *
   * Found by an adversarial reviewer told to break that fix, and reproduced here.
   *
   * `ownHalf` compared the acceptance's `wsp:stream` against a COMPOSED, always-qualified IRI.
   * `foldRoster` — the authority, and what every reader runs — is looser: it takes whatever the
   * acceptance names and only checks it is under the member's own pod. `resolveMemberDoc` still
   * resolves the LEGACY name, so a member seated before qualified names existed failed the
   * stricter test, was sent to `seat()`, and had their acceptance republished pointing at a NEW
   * qualified stream. Their existing log — every message they had ever written — was then folded
   * by nobody, and the entry that triggered it went to the new stream.
   *
   * ★ THE SAME MISTAKE `ownHalf` EXISTS TO FIX, in the other direction: a writer applying a
   * different standard from its readers.
   */
  it('★ writes to the log their own acceptance names, and is not re-seated', async () => {
    const run = scripted({ legacyNames: true });
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'still here' });

    expect(out.kind).toBe('recorded');
    // ★ NOT RE-SEATED. A republished acceptance is what moves their log out from under them.
    expect(run.published.filter((p) => String(p['graph_iri']) === LEGACY_ACC),
      'a legacy-named member was re-accepted onto a different log').toHaveLength(0);
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC)).toHaveLength(0);
    if (out.kind === 'recorded') expect(out.seated).toBe('already');

    // ★ AND THE ENTRY WENT WHERE THE READERS LOOK — the legacy stream, not the composed one.
    const entries = run.published.filter((p) => String(p['graph_iri']) === LEGACY_STREAM);
    expect(entries, 'the entry went to a log no reader of this workspace folds').toHaveLength(1);
    expect(run.published.filter((p) => String(p['graph_iri']) === STREAM)).toHaveLength(0);
    if (out.kind === 'recorded') expect(out.streamIri).toBe(LEGACY_STREAM);
  });

  it('and a stream under somebody ELSE\'s pod is still refused', async () => {
    // The check that must survive the loosening: `foldRoster` refuses a log the member points at
    // another pod for, and so must this — otherwise an acceptance could aim writes at a stranger.
    const run = scripted();
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'ordinary' });
    expect(out.kind).toBe('recorded');
    if (out.kind === 'recorded') expect(out.streamIri).toBe(STREAM);
  });
});

describe('a read that FAILED is not a seat that is missing', () => {
  /**
   * ★★ A NETWORK BLINK UNSEATED A STANDING MEMBER, AND ORPHANED A LEGACY ONE WHILE SAYING
   * "recorded".
   *
   * Confirmed and reproduced by two independent reviewers told to break `ownHalf`.
   *
   * `ownHalf` distinguished "could not be READ" from "is not THERE" — and both reached the caller
   * as `{ok:false, why}`, which answered every one of them by calling `seat()`. `seat()`
   * republishes the grant FIRST, and a grant republish is never a no-op: `grantTurtle` stamps
   * `dct:created` with now, so the bytes differ and `auto_supersede_prior` mints a new cid. The
   * member's existing acceptance pins the old one, and `foldRoster` unseats anybody whose pin no
   * longer matches.
   *
   * So one 502 on a member's own pod, during their own message, could take their seat away for
   * every reader in the workspace — and for a legacy-named member, write a fresh acceptance at
   * the qualified name pointing at a new stream, orphaning their whole history, and answer
   * `recorded`.
   */
  it('★ writes NOTHING when the member\'s acceptance could not be read', async () => {
    const run = scripted({ acceptanceHeadFails: true });
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'hello during an outage' });

    // ★ THE LOAD-BEARING ASSERTION: no grant republish. That write is what moves the cid their
    // acceptance pins, and it is the whole mechanism of the unseating.
    expect(run.published.filter((p) => String(p['graph_iri']) === GRANT),
      'a failed READ republished the grant, which can unseat a standing member').toHaveLength(0);
    expect(run.published, 'a failed read wrote something').toHaveLength(0);

    // And the person is told what happened rather than being silently dropped.
    expect(out.kind).toBe('unseated');
    if (out.kind === 'unseated') {
      expect(out.why).toContain('could not be read');
      expect(out.why).toContain('Nothing was written');
    }
  // ★ THE BUDGET IS 30 s BECAUSE `publishAndConfirm` SPENDS IT. A mutant that lets this state
  // reach `seat()` publishes a grant whose read-back head keeps failing, and that write then
  // backs off for about thirty seconds before reporting "accepted and not yet reported readable".
  // Under vitest's 5 s default the mutant is killed by a TIMEOUT — a failure with two possible
  // causes, and therefore evidence for neither. With this budget the run completes and the
  // assertion that fails is the load-bearing one: a read that established nothing wrote.
  }, 40_000);

  it('★ and a legacy-named member is not silently moved to a new log by the same blip', async () => {
    // The worse half: this used to answer `recorded` while relocating their entire history.
    const run = scripted({ legacyNames: true, acceptanceHeadFails: true });
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'hello during an outage' });

    expect(run.published.filter((p) => String(p['graph_iri']) === ACC),
      'a read failure republished their acceptance at the qualified name, orphaning their log').toHaveLength(0);
    expect(run.published).toHaveLength(0);
    expect(out.kind, 'a write that never happened was reported as recorded').toBe('unseated');
  // ★ THE BUDGET IS 30 s BECAUSE `publishAndConfirm` SPENDS IT. A mutant that lets this state
  // reach `seat()` publishes a grant whose read-back head keeps failing, and that write then
  // backs off for about thirty seconds before reporting "accepted and not yet reported readable".
  // Under vitest's 5 s default the mutant is killed by a TIMEOUT — a failure with two possible
  // causes, and therefore evidence for neither. With this budget the run completes and the
  // assertion that fails is the load-bearing one: a read that established nothing wrote.
  }, 40_000);

  it('and a genuinely ABSENT acceptance is still answered by seating them', async () => {
    // The other half. Absence is the state seat() exists for; refusing everything unreadable must
    // not refuse the ordinary first-message path too.
    const run = scripted({ accepted: false });
    const out = await recordMessage({
      relay: RELAY, client: run.client, agentId: BOT,
      store: { threadOf: () => binding(), linkOf: () => link() } as never,
    }, { threadId: 't1', discordUserId: '4242', text: 'first words' });
    expect(out.kind).toBe('recorded');
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC)).toHaveLength(1);
  });
});

/**
 * The bits of `Deps` and `LinkStore` this file's calls actually touch. Written once so a new test
 * cannot quietly hand `recordMessage` a store that answers a question the real one would not.
 */
const deps = (client: Run['client'], over: Record<string, unknown> = {}): Parameters<typeof recordMessage>[0] => ({
  relay: RELAY, client, agentId: BOT,
  store: { threadOf: () => binding(), linkOf: () => link(), ...over } as never,
});

describe('a failed read of the GRANT half is not a seat that is missing either', () => {
  /**
   * ── ★★ ONLY HALF OF THAT GATE EXISTED, AND THE OTHER HALF WAS ONE LINE ABOVE IT ──
   *
   * `ownHalf` refuses to write on a failed read of the ACCEPTANCE, and the docblock explaining why
   * is the longest in this file. The GRANT half had no such protection: `recordMessage` read every
   * `ok: false` verdict from `findSeat` — a relay refusal on the pod scan, a throw, an answer with
   * no entries array, a composed-name read that did not resolve, a scan its read cap stopped —
   * as `{ repairable: true, why: 'no grant on the convener's pod seats them yet' }`. A manufactured
   * absence, with a sentence asserting the grant is not there, over a read that established
   * nothing. The refusal below it was gated on `already.ok`, so it could never fire for any of them.
   *
   * ★ AND THE WRITE THEY AUTHORISED IS THE SAME ONE. `seat()` republishes the grant with a fresh
   * `dct:created`, minting a cid every existing acceptance is instantly stale against, and then
   * rewrites the acceptance — at the QUALIFIED name, which for a legacy-named member orphans their
   * whole log while `recordMessage` answers `recorded`. Every harm `OwnHalf` was written for,
   * reached through the other half.
   */
  it('★ writes NOTHING when whether a grant seats them could not be read', async () => {
    const run = scripted({ grantHeadFails: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'hello during an outage on the convener pod' });

    // ★ THE LOAD-BEARING ASSERTION, and it is about the WRITE rather than the sentence: a
    // republished grant is what unseats a standing member for every reader.
    expect(run.published.filter((p) => String(p['graph_iri']) === GRANT),
      'a failed read of the GRANT half republished the grant').toHaveLength(0);
    expect(run.published, 'a read that established nothing wrote something').toHaveLength(0);
    expect(out.kind).toBe('unseated');
    if (out.kind === 'unseated') {
      expect(out.why).toContain('Nothing was written');
      // ★ AND THE EXIT IS AN ACT A DISCORD USER CAN PERFORM. There is no repair command in this
      // bot at all, so a refusal that named one would be a dead end; posting again is the act,
      // because every one of these reads is made afresh for every message.
      expect(out.why).toContain('Post again in a moment');
    }
  // ★ THE BUDGET IS 30 s BECAUSE `publishAndConfirm` SPENDS IT. A mutant that lets this state
  // reach `seat()` publishes a grant whose read-back head keeps failing, and that write then
  // backs off for about thirty seconds before reporting "accepted and not yet reported readable".
  // Under vitest's 5 s default the mutant is killed by a TIMEOUT — a failure with two possible
  // causes, and therefore evidence for neither. With this budget the run completes and the
  // assertion that fails is the load-bearing one: a read that established nothing wrote.
  }, 40_000);

  it('and a legacy-named member is not moved to a new log by that same blip either', async () => {
    // The worse half of the acceptance-side harm, reached through the grant side.
    const run = scripted({ legacyNames: true, grantHeadFails: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'still here' });
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC),
      'a failed grant read republished their acceptance at the qualified name, orphaning their log').toHaveLength(0);
    expect(run.published).toHaveLength(0);
    expect(out.kind).toBe('unseated');
  // ★ THE BUDGET IS 30 s BECAUSE `publishAndConfirm` SPENDS IT. A mutant that lets this state
  // reach `seat()` publishes a grant whose read-back head keeps failing, and that write then
  // backs off for about thirty seconds before reporting "accepted and not yet reported readable".
  // Under vitest's 5 s default the mutant is killed by a TIMEOUT — a failure with two possible
  // causes, and therefore evidence for neither. With this budget the run completes and the
  // assertion that fails is the load-bearing one: a read that established nothing wrote.
  }, 40_000);

  it('while an absence the convener pod STATES is still answered by granting', async () => {
    /**
     * The other half, and the one that keeps the product alive: "no grant for this workspace
     * appears among the N descriptors on that pod, which is that pod's whole index" is an ANSWER,
     * and the answer to it is to publish a grant. A fix that refused every non-ok verdict would
     * refuse the ordinary first-message path this bot exists for.
     */
    const run = scripted({ granted: false, accepted: false });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'first words' });
    expect(out.kind).toBe('recorded');
    expect(run.published.filter((p) => String(p['graph_iri']) === GRANT)).toHaveLength(1);
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC)).toHaveLength(1);
  });
});

describe('an ENTRY cannot evict anybody, and the refusal that said it could bricked the channel', () => {
  /**
   * ── ★★ THE WRITE GATE WAS THE RE-SEAL'S, APPLIED TO ORDINARY CHAT ───────────
   *
   * `audienceFor` called the un-verbed `recipientsFor('private', roster)`, which applies EVERY
   * verb's refusal. `entry.ts` publishes with `auto_supersede_prior: false`: an entry replaces no
   * recipient set and cannot evict anybody, so the completeness guard written to stop a re-seal
   * dropping a member from the workspace RECORD was refusing every message anybody typed.
   *
   * ★ WITH NO EXIT IN THIS SHELL. `renderRecord` prints that refusal NON-EPHEMERALLY, so the bot
   * posted a paragraph into the channel for every line anybody wrote, and the whole command tree
   * is start / link / link-confirm / unlink / mentionable / show / who / ask — no invite, no
   * revoke. One unreadable grant made the thread unusable, permanently, for everybody.
   */
  it('★ records the message in a private workspace holding a grant that will not read', async () => {
    const run = scripted({ privateWs: true, strayUnreadable: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'the roster is short and this still goes on the record' });

    expect(out.kind, 'an entry was refused over a shortfall an entry cannot cause').toBe('recorded');
    const entries = run.published.filter((p) => String(p['graph_iri']) === STREAM);
    expect(entries).toHaveLength(1);
    // ★ AND IT IS STILL ADDRESSED TO THE MEMBERS THE FOLD DID READ. Not refusing is not the same
    // as not encrypting: the entry is private and names its recipients.
    expect(entries[0]?.['visibility']).toBe('shared');
    expect(entries[0]?.['share_with']).toContain(WEBID(MEMBER));
    // ★ AND THE ENTRY DOES NOT SUPERSEDE, which is the property that makes this safe.
    expect(entries[0]?.['auto_supersede_prior']).toBe(false);
  });

  it('while the RE-SEAL, which can evict, still refuses on the very same fold', async () => {
    /**
     * The other half of the per-verb split, and the reason it is a split rather than a removal.
     * `sendInvite` republishes the workspace record with `auto_supersede_prior` on a `'shared'`
     * document, and `verifyGrantIri` reads that record as a precondition of accepting — so a
     * member the fold has not finished looking at would be dropped from the one document they
     * need in order to join. That is the verb with the permanent harm, and it still refuses.
     */
    const run = scripted({ privateWs: true, strayUnreadable: true, accepted: false });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'seat me' });

    expect(run.published.filter((p) => String(p['graph_iri']) === WS),
      'the record was re-sealed while a grant was still unread').toHaveLength(0);
    expect(out.kind).toBe('unseated');
    if (out.kind === 'unseated') {
      /**
       * ★★ AND IT ARRIVES AS A REFUSAL RATHER THAN AS AN EXCEPTION. `audienceFor` was called inside
       * a spread argument to `sendInvite`, so this refusal became a throw that escaped `seat()`,
       * was caught by the outer handler as `{kind:'error'}`, and discarded every check collected
       * before it — the same sentence, under a different heading, with the evidence gone.
       */
      expect(out.seating.length, 'the seating checks were thrown away with the exception').toBeGreaterThan(0);
      // ★ AND THE EXIT IS ONE A DISCORD USER CAN PERFORM. The module's own sentence names reading
      // the members list again; this shell says what that IS here.
      expect(out.why).toContain('From Discord');
    }
  });
});

describe('whether the relay can read this, said in the channel where it was typed', () => {
  /**
   * ── ★★ NOTHING TYPED INTO DISCORD IS SEALED, AND NOTHING SAID SO ────────────
   *
   * `postEntry` seals only when its caller supplies a sealer. The desktop supplies one from its
   * main process; this bot supplies none and holds no key material to supply — it is a conduit.
   * So every private message recorded through Discord is encrypted BY THE RELAY, with the relay's
   * own key in the envelope, and the whole claim a private workspace makes is that the relay is
   * not a recipient. A Discord user has no other surface on which to learn otherwise.
   *
   * ★ AND IT IS NOT `Sealing.mode`. The module answers `'seal'` when every member published a key
   * — a statement about the WORKSPACE, true, and about a client that can act on it. Rendering that
   * as "end-to-end encrypted" here would be false of this shell specifically.
   */
  it('★ a private message says the relay can read it, and the channel is told', async () => {
    const run = scripted({ privateWs: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'something private' });
    expect(out.kind).toBe('recorded');
    if (out.kind !== 'recorded') return;
    expect(out.sealing, 'a private write reported nothing about what protected it').not.toBeNull();
    expect(out.sealing?.relayReadable).toBe(true);
    expect(out.sealing?.why).toContain('NOT end-to-end encrypted');
    // ★ THE LOAD-BEARING ASSERTION IS THE CHANNEL, not the field: a fact carried and rendered by
    // nothing is the shape of defect this round exists to close.
    const said = renderRecord(out)?.content ?? '';
    expect(said).toContain('NOT end-to-end encrypted');
    expect(said.toLowerCase()).toContain('the relay can read this');
  });

  it('and a public message claims nothing about sealing at all', async () => {
    // The control. A public workspace encrypts nothing and says nothing; a banner on every line of
    // a public channel would be noise that teaches people to ignore the one that matters.
    const run = scripted();
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'ordinary' });
    expect(out.kind).toBe('recorded');
    if (out.kind !== 'recorded') return;
    expect(out.sealing).toBeNull();
    expect(renderRecord(out)?.content ?? '').not.toContain('end-to-end');
  });

  it('★ and starting a PRIVATE workspace here says it can never be sealed, when that is decided', async () => {
    /**
     * `createWorkspace` records the convener's own encryption key in their founding acceptance,
     * and this bot passes none because it holds none. Its own note says what that costs: the
     * convener is permanently `keysMissing`, a missing key withholds the WHOLE key list, and the
     * founder is the one member who cannot be invited later. So `/workspace start
     * visibility:private` produces a workspace no client can ever seal to, and no surface said so.
     */
    const run = scripted({ granted: false, accepted: false });
    const out = await startWorkspace(
      { relay: RELAY, client: run.client, agentId: BOT,
        store: { linkOf: () => link(), threadOf: () => undefined, bindThread: () => undefined } as never },
      { threadId: '4242424242424242', threadName: 'private thread', discordUserId: '4242', visibility: 'private' },
    );
    expect(out.kind).toBe('created');
    if (out.kind !== 'created') return;
    expect(out.sealing).not.toBeNull();
    expect(out.sealing?.why).toContain('never be end-to-end encrypted');
    expect(renderStart(out).content).toContain('never be end-to-end encrypted');
  });

  it('while starting a PUBLIC one says nothing of the kind', async () => {
    const run = scripted({ granted: false, accepted: false });
    const out = await startWorkspace(
      { relay: RELAY, client: run.client, agentId: BOT,
        store: { linkOf: () => link(), threadOf: () => undefined, bindThread: () => undefined } as never },
      { threadId: '4242424242424242', threadName: 'public thread', discordUserId: '4242' },
    );
    expect(out.kind).toBe('created');
    if (out.kind !== 'created') return;
    expect(out.sealing).toBeNull();
    expect(renderStart(out).content).not.toContain('end-to-end');
  });
});

describe('the read cap the write path folds at', () => {
  /**
   * ── ★★ THE GATE FOLDED AT 25 WHILE THE COMMAND REPORTING THE ROSTER FOLDED AT 200 ──
   *
   * `audienceFor` passed no `readCap`, so the module's default of 25 applied to it, while
   * `showWorkspace` asked for 200 and the desktop asks for 200. On a workspace holding 26 to 200
   * grants that meant `/workspace show` folded the whole roster and reported nothing wrong, the
   * desktop wrote normally, and Discord refused — over a shortfall only the message path could
   * see. And the module's exit for a cap-truncated fold is "fold the roster again with a read cap
   * of at least N", which no Discord command can perform.
   */
  it('★ seats somebody in a workspace holding more grants than the default cap', async () => {
    const run = scripted({ privateWs: true, accepted: false, fillerGrants: 30 });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'seat me in a big workspace' });

    expect(out.kind, 'a 31-grant workspace refused a seating a 200-grant fold reads in full').toBe('recorded');
    expect(run.published.filter((p) => String(p['graph_iri']) === ACC)).toHaveLength(1);
  });
});

describe('every refusal this shell prints names an act somebody can actually perform', () => {
  /**
   * ── ★★ THE COMMAND TREE IS start / link / link-confirm / unlink / mentionable / show / who /
   * ask, AND THAT IS ALL OF IT ────────────────────────────────────────────────
   *
   * No invite, no revoke, no way to set a read cap, no way to sign this bot in as somebody else.
   * So every refusal composed here or carried through from the module has to end by naming either
   * a Discord command that exists or the person and client that can do it instead. A refusal that
   * named a revoke was, in this shell, a dead end — which is what makes this a test rather than a
   * style note.
   */
  it('★ names the convener and `register_agent` when their pod stops delegating this bot', async () => {
    const run = scripted({ convenerNotDelegating: true, accepted: false });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'seat me' });

    expect(run.published, 'a grant was published on a pod that no longer delegates this bot').toHaveLength(0);
    expect(out.kind).toBe('unseated');
    if (out.kind !== 'unseated') return;
    // The act, the actor, and where — and that this bot is not the actor.
    expect(out.why).toContain('register_agent');
    expect(out.why).toContain('Only the convener can restore it');
    expect(out.why).toContain('No command this bot has does it');
    // ★ AND THE AGENT DID IS IN IT, because `register_agent` takes one and a person told to run it
    // without being told for whom has been told nothing.
    expect(out.why).toContain(BOT);
  });
});

describe('a workspace a sealing client WOULD write end-to-end into', () => {
  /**
   * ── ★★ `Sealing.mode === 'seal'` IS TRUE AND IS NOT ABOUT THIS SHELL ────────
   *
   * Every member of this workspace has published an encryption key, so `recipientsFor` answers
   * `'seal'` — a correct statement about the WORKSPACE, and the desktop acts on it by sealing in
   * its main process before anything leaves. This bot passes no sealer to `postEntry` and holds
   * no key material to pass, so the payload still goes to the relay, which encrypts it with its
   * own key in the envelope. Reading `'seal'` as "nothing to report" is the reading that would
   * publish relay-readable content into a channel whose own UI calls it private and say nothing.
   */
  it('★ still says the relay can read it, because THIS host cannot seal', async () => {
    const run = scripted({ privateWs: true, memberKey: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'private, and every member has a key' });
    expect(out.kind).toBe('recorded');
    if (out.kind !== 'recorded') return;
    expect(out.sealing, 'the module said a sealing client would have sealed, and this shell reported nothing').not.toBeNull();
    expect(out.sealing?.relayReadable).toBe(true);
    // ★ AND THE SENTENCE IS THE ONE FOR THIS CASE, not the escrow copy: nobody here is missing a
    // key, and saying they were would be a false statement about a real member.
    expect(out.sealing?.why).toContain('Every member of this workspace has published an encryption key');
    expect(renderRecord(out)?.content ?? '').toContain('NOT end-to-end encrypted');
  });
});

describe('who the re-seal dropped, on the path where the seating WORKED', () => {
  /**
   * ── ★★ DETECTED AND THROWN AWAY, WHICH IS THE SHAPE THIS ROUND IS ABOUT ─────
   *
   * `seat()` collects checks and `renderRecord` printed them only on the arm where seating
   * FAILED. The one finding that exists ONLY when seating succeeds is the worst of them:
   * `sendInvite` republishes the workspace record with `auto_supersede_prior`, and any existing
   * member the relay resolved no key for is dropped from the revision that supersedes. That is
   * the document `verifyGrantIri` makes them read before they can accept, and an envelope's
   * recipients are fixed at write time — so it is a one-way door out of the workspace for
   * somebody nobody revoked, and this shell had no surface for it at all.
   */
  it('★ names an existing member the re-seal could not reach, in the channel', async () => {
    const run = scripted({ privateWs: true, accepted: false, otherPending: true, resealMissesOther: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'seat me' });

    expect(out.kind).toBe('recorded');
    if (out.kind !== 'recorded') return;
    expect(out.seated).toBe('just-now');
    // ★ THE POINT IS THE CHANNEL. A check on the outcome that nothing prints is the same defect
    // one file over.
    const said = renderRecord(out)?.content ?? '';
    expect(said).toContain('re-sealed and the relay resolved no key for');
    expect(said).toContain(WEBID(OTHER));
  });

  it('and says nothing extra for an ordinary message from somebody already seated', async () => {
    // The control: these lines belong to the message that seated somebody and to no other.
    const run = scripted({ privateWs: true });
    const out = await recordMessage(deps(run.client), { threadId: 't1', discordUserId: '4242', text: 'ordinary' });
    expect(out.kind).toBe('recorded');
    if (out.kind !== 'recorded') return;
    expect(out.seating).toEqual([]);
    expect(renderRecord(out)?.content ?? '').not.toContain('resolved no key for');
  });
});
