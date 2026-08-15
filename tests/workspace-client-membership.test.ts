/**
 * The documents a workspace is made of, and the flows that read them back.
 *
 * These cover the half of `@interego/workspace-client` that moved out of the published
 * artifact's hand-written script: the Turtle writers, grant verification, the canvas outcomes
 * and the role-label rule. Every case is a defect the move either closed or must not reopen.
 *
 * ★ THE LIVE COUNTERPART. Nothing here talks to a relay. The same functions are driven against
 * the real fleet with two real identities by
 * `applications/shared-workspace/tools/drive-membership-live.ts` — create, invite, accept,
 * switch, post from both, canvas save, forced stale 412, merge forward, revoke. That run is
 * what establishes the relay behaves as these tests assume; this file pins the reasoning that
 * sits on top of it.
 */

import { describe, it, expect } from 'vitest';
import {
  acceptanceTurtle, canvasTurtle, entryTurtle, grantTurtle, rolesTurtle, shapesTurtle, turtleIri,
  workspaceTurtle, graphRegion, readIri, readLiteral, hasTrue, parseRoleProfile,
  roleKnown, roleName, roleWhy, checkRoleForWorkspace, staleDetail, awaitHead, readCanvas,
  verifyGrantIri, findSeat, listWorkspaces, WorkspaceClient,
  type RoleTable, type Viewer, type AnyTransport,
} from '@interego/workspace-client';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-8f3b8e939600';
const OTHER = 'u-eth-e9dfa2a9e44f';
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const WS = RELAY + '/ns/' + POD + '/room';
const ROLES = RELAY + '/ns/' + POD + '/room-roles';
const GRANT = WS + '-grant-' + OTHER;

const viewer = (pod: string): Viewer => ({
  podName: pod, podUrl: 'http://css.railway.internal:3456/' + pod + '/', displayName: null,
  css: '', webId: WEBID(pod), agentDid: 'did:ethr:0x1', agentScope: 'ReadWrite',
});

/** A transport that answers from a table. Only the SHAPES the live run produced are used. */
function transport(answers: Record<string, (input: Record<string, unknown>) => unknown>): AnyTransport {
  return {
    accepts: 'relay-oauth-bearer',
    label: 'stub',
    watchDescription: 'not watched in this test',
    connect: async () => ({ granted: [] }),
    callTool: async (name, input) => {
      const fn = answers[name];
      if (!fn) throw new Error('this test scripted no answer for ' + name);
      return fn(input);
    },
  } as AnyTransport;
}
const client = (answers: Record<string, (input: Record<string, unknown>) => unknown>): WorkspaceClient =>
  new WorkspaceClient(RELAY, transport(answers));

const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<urn:x> dct:title "descriptor level" .\n<' + iri + '> {\n' + body + '\n}\n';

// ── the writers ──────────────────────────────────────────────────────────────

describe('★ every interpolated IRI is refused rather than escaped', () => {
  /**
   * A Turtle IRI reference ends at the first `>` and the production has NO escape for one, so
   * refusal is the only correct handling. The concrete path this closes: `resolveInvitee` reads
   * the invitee's WebID out of `get_pod_status.registry.owner` — a field on the INVITEE's own
   * pod — and hands it to `grantTurtle`, which wrote it into a document published on the
   * CONVENER's pod under the convener's signature. The artifact's copies of these six writers
   * interpolated all of it unchecked; only `entryTurtle` guarded.
   */
  const HOSTILE = 'https://evil.example/me> a <urn:x> . <urn:y> <urn:z> <urn:w';

  it('refuses a hostile grantee WebID instead of writing a document with extra triples', () => {
    expect(() => grantTurtle({ grant: GRANT, workspace: WS, granteeWebId: HOSTILE, role: ROLES + '#Reader' }))
      .toThrow(/not serializable as a Turtle IRI reference/);
  });
  it('names WHICH argument was refused, because the writer cannot fix what it cannot find', () => {
    expect(() => grantTurtle({ grant: GRANT, workspace: WS, granteeWebId: HOSTILE, role: ROLES + '#Reader' }))
      .toThrow(/grantee WebID, which was read from the invitee's own pod/);
  });
  it('refuses a hostile convener, role profile, shape, stream, acceptance and canvas IRI', () => {
    expect(() => workspaceTurtle({ workspace: WS, title: 't', convenerWebId: HOSTILE, rolesIri: ROLES, shapeIri: WS + '-s' })).toThrow();
    expect(() => workspaceTurtle({ workspace: WS, title: 't', convenerWebId: WEBID(POD), rolesIri: HOSTILE, shapeIri: WS + '-s' })).toThrow();
    expect(() => acceptanceTurtle({ acceptance: WS + '-a', workspace: WS, memberWebId: WEBID(POD), grant: GRANT, grantCid: null, stream: HOSTILE })).toThrow();
    expect(() => canvasTurtle({ canvas: HOSTILE, workspace: WS, slug: 'room', body: 'x' })).toThrow();
    expect(() => rolesTurtle(HOSTILE)).toThrow();
    expect(() => shapesTurtle(HOSTILE)).toThrow();
  });
  it('applies the SAME character class `entryTurtle` has always applied', () => {
    // Two implementations of one rule is how they come apart. This pins them together.
    for (const bad of ['a b', 'a<b', 'a>b', 'a"b', 'a{b', 'a}b', 'a|b', 'a\\b', 'a^b', 'a`b', 'a\nb']) {
      expect(() => turtleIri(bad, 'x'), bad + ' should be refused by turtleIri').toThrow();
      expect(() => entryTurtle({ streamIri: 'https://r/s', workspace: bad, seq: 0, body: 'b', prior: null, author: { kind: 'principal', webId: 'https://identity/users/p/profile#me' } }),
        bad + ' should be refused by entryTurtle').toThrow();
    }
    expect(turtleIri('https://ok/x#y', 'x')).toBe('<https://ok/x#y>');
  });
  it('escapes a hostile LITERAL rather than refusing it — a literal has an escape and an IRI does not', () => {
    const t = canvasTurtle({ canvas: WS + '-canvas', workspace: WS, slug: 'room', body: 'he said "hi" .\n<urn:a> <urn:b> <urn:c> .' });
    const region = graphRegion(trig(WS + '-canvas', t.split('\n\n')[1] as string), WS + '-canvas');
    expect(readLiteral(region, 'dct:description')).toContain('he said "hi"');
    // The injected triple stayed inside the literal: it is not a term.
    expect(readIri(region, 'urn:b')).toBe(null);
  });
});

describe('the five documents a create publishes are readable by this package\'s own readers', () => {
  it('round-trips the workspace record', () => {
    const t = workspaceTurtle({ workspace: WS, title: 'Family room', convenerWebId: WEBID(POD), rolesIri: ROLES, shapeIri: WS + '-shapes', createdIso: '2026-08-06T00:00:00.000Z' });
    const r = graphRegion(trig(WS, t), WS);
    expect(readLiteral(r, 'dct:title')).toBe('Family room');
    expect(readIri(r, 'wsp:convener')).toBe(WEBID(POD));
    expect(readIri(r, 'wsp:entryShape')).toBe(WS + '-shapes');
    expect(readIri(r, 'wsp:grantCapability')).toBe(ROLES + '#Convene');
  });
  it('round-trips a grant and its revocation', () => {
    const live = graphRegion(trig(GRANT, grantTurtle({ grant: GRANT, workspace: WS, granteeWebId: WEBID(OTHER), role: ROLES + '#Contributor' })), GRANT);
    expect(hasTrue(live, 'wsp:revoked')).toBe(false);
    expect(readIri(live, 'wsp:grantedTo')).toBe(WEBID(OTHER));
    const dead = graphRegion(trig(GRANT, grantTurtle({ grant: GRANT, workspace: WS, granteeWebId: WEBID(OTHER), role: ROLES + '#Contributor', revoked: true })), GRANT);
    expect(hasTrue(dead, 'wsp:revoked')).toBe(true);
  });
  it('★ pins the accepted revision separately, so a re-grant unseats a stale acceptance', () => {
    const acc = RELAY + '/ns/' + OTHER + '/' + POD + '--room-acceptance';
    const t = acceptanceTurtle({ acceptance: acc, workspace: WS, memberWebId: WEBID(OTHER), grant: GRANT, grantCid: 'bafkreiabc', stream: RELAY + '/ns/' + OTHER + '/' + POD + '--room-stream' });
    const r = graphRegion(trig(acc, t), acc);
    // `wsp:accepts` is a URL anybody can open — it used to be the grant's internal descriptor
    // URL, which no reader outside the fleet can dereference.
    expect(readIri(r, 'wsp:accepts')).toBe(GRANT);
    expect(readLiteral(r, 'wsp:acceptsCid')).toBe('bafkreiabc');
  });
  it('emits a role table this package can parse back into roles and capabilities', () => {
    const parsed = parseRoleProfile(rolesTurtle(ROLES));
    expect([...parsed.roles.values()].map((r) => r.label).sort()).toEqual(['Contributor', 'Convener', 'Reader']);
    expect(parsed.caps.size).toBe(3);
    expect(parsed.roles.get(ROLES + '#Reader')?.permits).toEqual([ROLES + '#Read']);
  });
});

// ── grant verification ───────────────────────────────────────────────────────

function podWith(docs: Record<string, { cid: string; url: string; content: string }>): Record<string, (i: Record<string, unknown>) => unknown> {
  return {
    get_current_head: (i) => {
      const d = docs[String(i['urn'])];
      const podUrl = 'http://css.railway.internal:3456/' + String(i['pod_name']) + '/';
      return d ? { urn: i['urn'], podUrl, head: { descriptorUrl: d.url, cid: d.cid } }
        : { urn: i['urn'], podUrl, message: 'No descriptor on this pod describes the requested urn.' };
    },
    get_descriptor: (i) => {
      for (const d of Object.values(docs)) if (d.url === String(i['url'])) return { graph: { content: d.content }, authorship: null };
      return { error: 'not_found', message: 'no such descriptor' };
    },
  };
}

const WS_DOC = {
  cid: 'cid-ws', url: 'http://css.railway.internal:3456/' + POD + '/context-graphs/1.ttl',
  content: trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "Room" ; wsp:convener <' + WEBID(POD) + '> ;\n'
    + '  wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + WS + '-shapes> .'),
};
const grantDoc = (iri: string, grantee: string, extra = ''): { cid: string; url: string; content: string } => ({
  cid: 'cid-' + iri.slice(-6), url: 'http://css.railway.internal:3456/' + POD + '/context-graphs/2.ttl',
  content: trig(iri, '<' + iri + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:grantedTo <' + grantee + '> ; wsp:role <' + ROLES + '#Contributor> .' + extra),
});

/**
 * ★★ "WITHHELD" AND "MALFORMED" ARE OPPOSITE CLAIMS, AND THIS CLIENT USED TO MAKE THE WRONG ONE.
 *
 * `get_descriptor` answers `{ content: null, encrypted: true }` for a payload the caller is not
 * entitled to. The flag was read on the way in and dropped on the way to the reader, so every
 * client in this vertical rendered an ENCRYPTED record as "the signed region could not be
 * located" — which says the author published bytes nobody signed. It is an accusation, about a
 * record that is perfectly well formed and simply not yours, in a system whose entire argument is
 * that it does not assert what it has not established.
 *
 * This has to hold BEFORE any private byte exists, which is why it ships ahead of the workspace
 * visibility choice rather than with it.
 */
describe('★★ an encrypted record is withheld, not malformed', () => {
  /**
   * A pod that serves the GRANT normally and withholds only the WORKSPACE RECORD — which is the
   * real shape of a private workspace. The grant is what tells you a workspace exists and that you
   * were invited; the record is what is encrypted to its members. A fixture that withheld both
   * would fail earlier, on reading the grant, and never reach the line under test.
   */
  const withheldRecord = (docs: Record<string, { cid: string; url: string; content: string }>) =>
    (): Record<string, (i: Record<string, unknown>) => unknown> => {
      const base = podWith(docs);
      return {
        ...base,
        get_descriptor: (i) => (String(i['url']) === WS_DOC.url
          ? { graph: { content: null, encrypted: true }, authorship: null }
          : (base['get_descriptor'] as (x: Record<string, unknown>) => unknown)(i)),
      };
    };

  it('★ says the record is private and not yours, rather than accusing it of being unsigned', async () => {
    const pod = withheldRecord({ [WS]: WS_DOC, [GRANT]: grantDoc(GRANT, WEBID(OTHER)) })();
    const v = await verifyGrantIri(client(pod), { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.why).toContain('private');
      expect(v.why).toContain('not yours to read');
      // ★ The accusation must be gone, not merely accompanied by a nicer sentence.
      expect(v.why).not.toContain('could not be located');
    }
  });

  it('★ and a genuinely malformed record still says so — the two must not collapse the other way', async () => {
    // Regression guard in the opposite direction: it would be just as wrong to start telling
    // people their broken records are "private", which is what a careless fix would do.
    const broken = { ...WS_DOC, content: 'this is not the graph you are looking for' };
    const v = await verifyGrantIri(client(podWith({ [WS]: broken, [GRANT]: grantDoc(GRANT, WEBID(OTHER)) })),
      { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.why).toContain('could not be located');
      expect(v.why).not.toContain('private');
    }
  });
});

describe('★ an inbox item is a claim: verifyGrantIri is what turns one into a seat, or refuses', () => {
  it('verifies a grant that names this viewer, on the convener\'s own pod', async () => {
    const c = client(podWith({ [WS]: WS_DOC, [GRANT]: grantDoc(GRANT, WEBID(OTHER)) }));
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok).toBe(true);
    expect(v.checks.map((x) => x.mark)).not.toContain('n');
    expect(v.title).toBe('Room');
    expect(v.entryShape).toBe(WS + '-shapes');
  });

  it('refuses a grant delivered into the inbox that is addressed to somebody else', async () => {
    // The measured attack: the inbox is world-writable — a fresh wallet with no prior
    // relationship delivered into another account's inbox — so the ONLY thing taken out of it
    // is a URL, and the name has to target the reader before it is even dereferenced.
    const c = client(podWith({ [WS]: WS_DOC, [GRANT]: grantDoc(GRANT, WEBID(OTHER)) }));
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer('u-eth-cccccccccccc'), grantIri: GRANT });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/addressed to pod u-eth-e9dfa2a9e44f, and you are u-eth-cccccccccccc/);
  });

  it('refuses a grant whose IRI is not one this workspace\'s readers look under', async () => {
    // ★ Accepting one of these publishes a REAL acceptance that seats you on nobody's roster:
    // every reader composes `<workspace>-grant-…` and would never look here.
    const odd = RELAY + '/ns/' + POD + '/somethingelse-grant-' + OTHER;
    const c = client(podWith({ [WS]: WS_DOC, [odd]: grantDoc(odd, WEBID(OTHER)) }));
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer(OTHER), grantIri: odd });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/not one of that workspace's own/);
  });

  it('refuses a grant sitting on a pod that is not the convener\'s', async () => {
    const elsewhere = RELAY + '/ns/' + OTHER + '/room';
    const iri = elsewhere + '-grant-' + OTHER;
    const c = client(podWith({
      [elsewhere]: { ...WS_DOC, content: trig(elsewhere, '<' + elsewhere + '> a wsp:Workspace ; wsp:convener <' + WEBID(POD) + '> .') },
      [iri]: { cid: 'c', url: 'http://css.railway.internal:3456/' + OTHER + '/context-graphs/9.ttl',
        content: trig(iri, '<' + iri + '> a wsp:MembershipGrant ; wsp:workspace <' + elsewhere + '> ;\n  wsp:grantedTo <' + WEBID(OTHER) + '> ; wsp:role <' + ROLES + '#Contributor> .') },
    }));
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer(OTHER), grantIri: iri });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/A grant only counts on the convener's own pod/);
  });

  it('refuses a revoked grant and says so in those words', async () => {
    const c = client(podWith({ [WS]: WS_DOC, [GRANT]: grantDoc(GRANT, WEBID(OTHER), '\n<' + GRANT + '> wsp:revoked true .') }));
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('wsp:revoked true');
  });

  it('★ distinguishes "nothing is published there" from "that read did not resolve"', async () => {
    const absent = client(podWith({ [WS]: WS_DOC }));
    const a = await verifyGrantIri(absent, { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(a.why).toMatch(/no grant is published at that IRI/);
    const opaque = client({ get_current_head: (i) => ({ urn: i['urn'] }) });
    const o = await verifyGrantIri(opaque, { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(o.why).toMatch(/did not resolve, so whether a grant is published there is not established/);
    expect(o.why).not.toMatch(/no grant is published/);
  });
});

describe('findSeat: the honest path, and what it may now say about absence', () => {
  /**
   * ★ THIS CASE USED TO ASSERT THE HEDGE, AND NOW ASSERTS THAT THE HEDGE IS GONE — because the
   * thing it hedged about is gone.
   *
   * It pinned "that scan came back full at 400 descriptors, so an older grant may lie past the end
   * of it", which was the honest thing to say while this client asked for `limit: 400`. It no
   * longer asks for a limit: the relay's own default is unbounded, it builds and caches the whole
   * manifest either way, and it applies `limit` LAST as a slice over the finished set — so the cap
   * truncated the answer and bought nothing.
   *
   * What makes the new sentence honest rather than merely shorter is a separate fact, and it is
   * the only reason this may be asserted at all: `discover()` follows the manifest's archive chain
   * and THROWS rather than return a partial pod. A short answer is a real answer. Absence is
   * evidence only where the read could not have missed anything.
   */
  it('★ asks for the pod\'s whole index, and says so rather than hedging about a window', async () => {
    const entries = Array.from({ length: 400 }, (_, i) => ({ descriptorUrl: 'u' + i, describes: ['https://x/unrelated'] }));
    const seen: Record<string, unknown>[] = [];
    const c = client({
      ...podWith({ [WS]: WS_DOC }),
      discover_context: (i) => { seen.push(i); return { pod: 'http://css.railway.internal:3456/' + POD + '/', entries }; },
    });
    const v = await findSeat(c, { relay: RELAY, viewer: viewer(OTHER), workspace: WS });
    expect(v.ok).toBe(false);
    // The cap is not merely absent from the copy — it is absent from the CALL. A message that
    // stopped hedging while the request stayed capped would be the worst of both.
    expect(seen.some((i) => 'limit' in i)).toBe(false);
    expect(v.why).toMatch(/whole index and not a window into it/);
    expect(v.why).not.toMatch(/came back full|may lie past the end/);
  });
  it('reports the grant that IS about you ahead of the one read last', async () => {
    const mine = WS + '-grant-' + OTHER;
    const theirs = WS + '-grant-u-eth-999999999999';
    const c = client({
      ...podWith({
        [WS]: WS_DOC,
        [mine]: grantDoc(mine, WEBID(OTHER), '\n<' + mine + '> wsp:revoked true .'),
        [theirs]: grantDoc(theirs, WEBID('u-eth-999999999999')),
      }),
      discover_context: () => ({
        pod: 'http://css.railway.internal:3456/' + POD + '/',
        entries: [{ descriptorUrl: 'a', describes: [mine] }, { descriptorUrl: 'b', describes: [theirs] }],
      }),
    });
    const v = await findSeat(c, { relay: RELAY, viewer: viewer(OTHER), workspace: WS });
    expect(v.ok).toBe(false);
    // "this grant names somebody else" would have buried the reason that is actually about you.
    expect(v.why).toMatch(/a grant for this workspace does name you, and it does not seat you: that grant carries wsp:revoked true/);
  });
});

describe('listWorkspaces reads the switcher off the viewer\'s OWN pod', () => {
  /** The manifest row the maintainer's pod actually returns for an acceptance. */
  const row = (n: string, iri: string): Record<string, unknown> => ({ descriptorUrl: n, describes: [iri] });
  const listing = (pod: string, ...entries: Record<string, unknown>[]): Record<string, unknown> =>
    ({ pod: 'http://css.railway.internal:3456/' + pod + '/', entries });

  it('takes the workspace apart out of a qualified FILENAME, never out of the document', async () => {
    const acc = RELAY + '/ns/' + OTHER + '/' + POD + '--room-acceptance';
    // ★ THE DOCUMENT NAMES A DIFFERENT WORKSPACE ON PURPOSE. The qualified name is what every
    // other reader composes acceptance, stream and canvas IRIs from, so the filename settles
    // which workspace this is for and the document does not get to move it. This is the
    // assertion the old "zero descriptor reads" count was standing in for; the read itself is
    // now made for a different fact (see the retraction cases below) and counting it would only
    // pin an implementation detail.
    const c = client({
      discover_context: () => listing(OTHER,
        row('d1', acc),
        // The pod's own profile is NOT a workspace, and must not be listed as one.
        row('d2', RELAY + '/ns/' + OTHER + '/profile')),
      get_descriptor: () => ({ graph: { content: trig(acc, '<' + acc + '> wsp:workspace <' + RELAY + '/ns/' + POD + '/somewhere-else> .') } }),
    });
    const list = await listWorkspaces(c, RELAY, OTHER);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.workspace).toBe(WS);
    expect(list.entries[0]?.naming).toBe('qualified');
    expect(list.withheld).toHaveLength(0);
  });

  it('reads the workspace out of the DOCUMENT when the name is the older unqualified form', async () => {
    const acc = RELAY + '/ns/' + OTHER + '/room-acceptance';
    const c = client({
      discover_context: () => listing(OTHER, row('d1', acc)),
      get_descriptor: () => ({ graph: { content: trig(acc, '<' + acc + '> wsp:workspace <' + WS + '> .') } }),
    });
    const list = await listWorkspaces(c, RELAY, OTHER);
    expect(list.entries[0]?.naming).toBe('legacy');
    expect(list.entries[0]?.workspace).toBe(WS);
  });

  /**
   * ★ THE DEFECT THIS BLOCK EXISTS FOR, MEASURED ON THE MAINTAINER'S OWN POD (2026-08-11).
   *
   * Twenty test memberships were retired by superseding each acceptance with a tombstone
   * carrying `iep:modalStatus "Retracted"` and no `wsp:workspace`. The desktop still listed all
   * twenty — each with an honest sentence about why it was not a workspace — and the ONE real
   * workspace was lost among them. Honest, and useless.
   */
  describe('★ a candidate that is not a place to go is not offered as one', () => {
    /**
     * The tombstone byte for byte as the live pod serves it: prefixes at the top of the TriG
     * document, the literal form of the status inside the signed block, and no `wsp:workspace`.
     * Copied from `.../u-eth-8f3b8e939600--drive-hyvocq-acceptance`, read 2026-08-11.
     */
    const retiredDoc = (iri: string): string =>
      '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
      + '@prefix dct: <http://purl.org/dc/terms/> .\n'
      + '<' + iri + '> {\n'
      + '    <' + iri + '>\n'
      + '      iep:modalStatus "Retracted" ;\n'
      + '      dct:description "Test membership created by an automated driver; retired during cleanup." .\n'
      + '}\n';

    const twentyRetiredAndOneReal = (): { readonly c: WorkspaceClient; readonly real: string } => {
      const retiredIris = Array.from({ length: 20 }, (_, i) => RELAY + '/ns/' + POD + '/' + POD + '--drive-x' + i + '-acceptance');
      const real = RELAY + '/ns/' + POD + '/' + POD + '--room-acceptance';
      const byUrl = new Map<string, string>();
      const entries = retiredIris.map((iri, i) => {
        byUrl.set('d' + i, retiredDoc(iri));
        return row('d' + i, iri);
      });
      byUrl.set('dreal', trig(real, '<' + real + '> a wsp:MembershipAcceptance ; wsp:workspace <' + WS + '> .'));
      entries.push(row('dreal', real));
      return {
        real,
        c: client({
          discover_context: () => listing(POD, ...entries),
          get_descriptor: (i) => ({ graph: { content: byUrl.get(String(i['url'])) ?? '' } }),
        }),
      };
    };

    it('leaves exactly the one live workspace in `entries` when twenty beside it were retired', async () => {
      const { c } = twentyRetiredAndOneReal();
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries.map((e) => e.workspace)).toEqual([WS]);
      expect(list.withheld).toHaveLength(20);
      expect(list.withheld.every((w) => w.kind === 'retired')).toBe(true);
    });

    it('keeps the diagnostic rather than dropping it — every retired one carries its reason', async () => {
      const { c } = twentyRetiredAndOneReal();
      const list = await listWorkspaces(c, RELAY, POD);
      for (const w of list.withheld) {
        expect(w.modalStatus).toBe('Retracted');
        expect(w.why).toContain('iep:modalStatus "Retracted"');
        expect(w.why).toContain('withdrawn it');
        expect(w.acceptanceIri).toMatch(/-acceptance$/);
      }
    });

    it('★ reads the status and never infers it: no wsp:workspace and no status is NOT a retraction', async () => {
      // A truncated read looks identical to a tombstone from outside. The only thing that
      // separates them is what the record says about itself, so a record that says nothing is
      // reported as unread — never as withdrawn.
      const acc = RELAY + '/ns/' + POD + '/legacy-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => ({ graph: { content: trig(acc, '<' + acc + '> dct:description "half a document" .') } }),
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries).toHaveLength(0);
      expect(list.withheld).toHaveLength(1);
      expect(list.withheld[0]?.kind).toBe('unreadable');
      expect(list.withheld[0]?.modalStatus).toBe(null);
      expect(list.withheld[0]?.why).toContain('names no wsp:workspace');
      expect(list.withheld[0]?.why).toContain('NOT being read as withdrawn');
    });

    it('tells a failed FETCH apart from a retraction too', async () => {
      const acc = RELAY + '/ns/' + POD + '/legacy-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => { throw new Error('socket hang up'); },
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.withheld[0]?.kind).toBe('unreadable');
      expect(list.withheld[0]?.why).toContain('socket hang up');
      expect(list.withheld[0]?.why).toContain('NOT being read as withdrawn');
      expect(list.withheld[0]?.modalStatus).toBe(null);
    });

    it('honours the IRI form of the status as well as the literal one', async () => {
      // `iep:modalStatus iep:Retracted` is what the ontology's own owl:oneOf enumerates; the
      // live tombstones use the literal. A reader that knew one form would call a withdrawn
      // record current.
      const acc = RELAY + '/ns/' + POD + '/' + POD + '--room-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => ({ graph: { content:
          '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
          + '<' + acc + '> {\n<' + acc + '> iep:modalStatus iep:Retracted .\n}\n' } }),
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries).toHaveLength(0);
      expect(list.withheld[0]?.kind).toBe('retired');
      expect(list.withheld[0]?.modalStatus).toBe('Retracted');
    });

    it('a QUALIFIED name does not exempt a record from being read as retired', async () => {
      // The whole reason the bug survived: the qualified filename answered "which workspace",
      // so the document was never opened and its own retraction was never seen.
      const acc = RELAY + '/ns/' + POD + '/' + POD + '--room-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => ({ graph: { content: retiredDoc(acc) } }),
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries).toHaveLength(0);
      expect(list.withheld[0]?.kind).toBe('retired');
      // The name still told us which workspace it was for, and that is carried through.
      expect(list.withheld[0]?.workspace).toBe(WS);
    });

    it('an ordinary Asserted acceptance is untouched', async () => {
      const acc = RELAY + '/ns/' + POD + '/' + POD + '--room-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => ({ graph: { content:
          '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
          + '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
          + '<' + acc + '> {\n<' + acc + '> iep:modalStatus "Asserted" ; wsp:workspace <' + WS + '> .\n}\n' } }),
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]?.modalStatus).toBe('Asserted');
      expect(list.withheld).toHaveLength(0);
    });

    it('★ never reads a status out of the UNSIGNED descriptor level', async () => {
      // The relay serves the descriptor and the payload in one document, and the descriptor
      // carries its own `iep:modalStatus` facet. Only the signed block is the record's own
      // statement — a reader that matched the whole document would take the relay's default
      // for the author's word, in both directions.
      const acc = RELAY + '/ns/' + POD + '/' + POD + '--room-acceptance';
      const c = client({
        discover_context: () => listing(POD, row('d1', acc)),
        get_descriptor: () => ({ graph: { content:
          '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
          + '<urn:iep:descriptor> iep:modalStatus "Retracted" .\n'
          + '<' + acc + '> {\n<' + acc + '> iep:modalStatus "Asserted" .\n}\n' } }),
      });
      const list = await listWorkspaces(c, RELAY, POD);
      expect(list.entries, 'a qualified name still supplies the workspace').toHaveLength(1);
      expect(list.entries[0]?.modalStatus).toBe('Asserted');
    });
  });
});

describe('★ a grant its own author retracted seats nobody, and it is not a revocation', () => {
  const grantDoc = (extra: string): string =>
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
    + '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
    + '<' + GRANT + '> {\n<' + GRANT + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:grantedTo <' + WEBID(OTHER) + '> ; wsp:role <' + ROLES + '#Contributor> ;\n' + extra + '\n}\n';

  const withGrant = (extra: string): WorkspaceClient => client({
    get_current_head: (i) => ({ urn: i['urn'], head: { descriptorUrl: 'g1', cid: 'cid-g' } }),
    get_descriptor: () => ({ graph: { content: grantDoc(extra) } }),
  });

  it('refuses a grant that states iep:modalStatus "Retracted"', async () => {
    const v = await verifyGrantIri(withGrant('  iep:modalStatus "Retracted" .'), { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok).toBe(false);
    expect(v.modalStatus).toBe('Retracted');
    expect(v.why).toContain('withdrawn it as an assertion');
  });

  it('does not call it a revocation — the two withdrawals are different statements', async () => {
    const v = await verifyGrantIri(withGrant('  iep:modalStatus "Retracted" .'), { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.why).not.toContain('wsp:revoked');
    expect(v.revoked, 'nobody revoked it; its author retired the record').toBe(false);
  });

  it('leaves an Asserted grant alone, so the check cannot pass by refusing everything', async () => {
    // Without this the two cases above would be green for a verifier that refused every grant.
    const c = client({
      get_current_head: (i) => ({ urn: i['urn'], head: { descriptorUrl: String(i['urn']).endsWith('/room') ? 'w1' : 'g1', cid: 'cid-g' } }),
      get_descriptor: (i) => ({ graph: { content: String(i['url']) === 'w1'
        ? trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "Room" ; wsp:convener <' + WEBID(POD) + '> .')
        : grantDoc('  iep:modalStatus "Asserted" .') } }),
    });
    const v = await verifyGrantIri(c, { relay: RELAY, viewer: viewer(OTHER), grantIri: GRANT });
    expect(v.ok, v.why).toBe(true);
    expect(v.modalStatus).toBe('Asserted');
  });
});

// ── the canvas ───────────────────────────────────────────────────────────────

describe('the canvas keeps its six read outcomes apart', () => {
  const CANVAS = RELAY + '/ns/' + POD + '/room-canvas';
  it('an unwritten document is ABSENT, which is the only state that licenses Create', async () => {
    const c = client(podWith({}));
    const r = await readCanvas(c, CANVAS, POD);
    expect(r.kind).toBe('absent');
  });
  it('★ an answer with neither a head nor a reason is UNRESOLVED, and does not license Create', async () => {
    const c = client({ get_current_head: (i) => ({ urn: i['urn'] }) });
    const r = await readCanvas(c, CANVAS, POD);
    expect(r.kind).toBe('unresolved');
  });
  it('a head with a URL, no CID and an error is not a readable revision', async () => {
    const c = client({
      get_current_head: () => ({ podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'u', error: 'the body could not be fetched' } }),
    });
    const r = await readCanvas(c, CANVAS, POD);
    expect(r.kind).toBe('head-unreadable');
  });
  it('distinguishes a revision with no description from one whose description is empty', async () => {
    const mk = async (body: string): Promise<unknown> => {
      const c = client({
        get_current_head: () => ({ podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'u', cid: 'c' } }),
        get_descriptor: () => ({ graph: { content: trig(CANVAS, body) } }),
      });
      const r = await readCanvas(c, CANVAS, POD);
      return r.kind === 'revision' ? r.text : r.kind;
    };
    expect(await mk('<' + CANVAS + '> a <urn:t> .')).toBe(null);
    expect(await mk('<' + CANVAS + '> dct:description "" .')).toBe('');
  });
});

describe('★ "Saved" means the head is YOURS, not that the head moved', () => {
  const CANVAS = RELAY + '/ns/' + POD + '/room-canvas';
  const nap = async (): Promise<void> => { /* the wait is not what is under test */ };
  it('reports `mine` when the head is the descriptor this write returned', async () => {
    const c = client({ get_current_head: () => ({ podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'mine', cid: 'c2' } }) });
    const out = await awaitHead(c, { canvasIri: CANVAS, podName: POD, previousCid: 'c1', mine: 'mine', tries: 2, sleep: nap });
    expect(out.kind).toBe('mine');
  });
  it('reports `moved-elsewhere` when a CONCURRENT writer took the head', async () => {
    // The CID changed, which is exactly what a panel watching for movement would call Saved.
    const c = client({ get_current_head: () => ({ podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'theirs', cid: 'c2' } }) });
    const out = await awaitHead(c, { canvasIri: CANVAS, podName: POD, previousCid: 'c1', mine: 'mine', tries: 2, sleep: nap });
    expect(out.kind).toBe('moved-elsewhere');
  });
  it('reports `timed-out` when nothing moved at all, rather than guessing', async () => {
    const c = client({ get_current_head: () => ({ podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'old', cid: 'c1' } }) });
    const out = await awaitHead(c, { canvasIri: CANVAS, podName: POD, previousCid: 'c1', mine: 'mine', tries: 2, sleep: nap });
    expect(out.kind).toBe('timed-out');
  });
  it('a failing poll is not a verdict — it keeps waiting rather than reporting a fork', async () => {
    let n = 0;
    const c = client({ get_current_head: () => {
      if (n++ < 1) throw new Error('transient');
      return { podUrl: 'http://css.railway.internal:3456/' + POD + '/', head: { descriptorUrl: 'mine', cid: 'c2' } };
    } });
    const out = await awaitHead(c, { canvasIri: CANVAS, podName: POD, previousCid: 'c1', mine: 'mine', tries: 3, sleep: nap });
    expect(out.kind).toBe('mine');
  });
});

describe('a 412 is unpacked field by field, and an absent field says so', () => {
  it('reads both revisions and the retryHint out of the relay\'s own body', () => {
    // The exact body the live relay returned, 2026-08-06.
    const d = staleDetail({
      error: 'precondition_failed', code: 412,
      expected: { cid: 'bafkreigkombpam653uiughlowczejnw6iy65p6ujgjtekhjwl3eegn6ikm' },
      currentHead: { cid: 'bafkreignfw4wpjo422dpmnladboayujiinzpcuim34fztajmtrdhrg5sya', descriptorUrl: 'http://css.railway.internal:3456/x/1.ttl' },
      retryHint: 'call get_current_head { urn, pod_name } then resend with the returned head cid as if_match',
      message: 'the revision you asserted is not the current head',
    });
    expect(d.expectedCid).toMatch(/^bafkreigko/);
    expect(d.currentHeadCid).toMatch(/^bafkreignf/);
    expect(d.retryHint).toContain('get_current_head');
  });
  it('reports a field the response omitted as null rather than as a value', () => {
    const d = staleDetail({ error: 'precondition_failed', code: 412 });
    expect(d.expectedCid).toBe(null);
    expect(d.currentHeadCid).toBe(null);
    expect(d.retryHint).toBe(null);
  });
});

// ── roles are data ───────────────────────────────────────────────────────────

describe('★ a role label is read from the table, or it is not a label', () => {
  const table: RoleTable = { roles: parseRoleProfile(rolesTurtle(ROLES)).roles, caps: parseRoleProfile(rolesTurtle(ROLES)).caps };
  const unresolved: RoleTable = { roles: null, caps: null };
  it('reads the label the workspace\'s own table declares', () => {
    expect(roleName(table, ROLES + '#Convener')).toBe('Convener');
    expect(roleKnown(table, ROLES + '#Convener')).toBe(true);
  });
  it('never falls back to the IRI FRAGMENT for a role from another workspace\'s table', () => {
    const foreign = 'https://relay.interego.xwisee.com/ns/u-eth-zzz/other-roles#Convener';
    expect(roleName(table, foreign)).toBe('role not in this table');
    expect(roleWhy(table, foreign)).toMatch(/this workspace's role table does not define it/);
    expect(roleKnown(table, foreign)).toBe(false);
  });
  it('keeps "not resolved" apart from "not in this table"', () => {
    expect(roleName(unresolved, ROLES + '#Convener')).toBe('role not resolved');
    expect(roleName(table, null)).toBe('no role');
  });
  it('re-checks a role at click and names the roles that DO exist', () => {
    const bad = checkRoleForWorkspace(table, 'https://x/y#Nope');
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/Nothing was published and nobody was notified/);
    expect(bad.why).toMatch(/Convener, Contributor, Reader/);
    expect(checkRoleForWorkspace(table, ROLES + '#Reader').ok).toBe(true);
  });
});
