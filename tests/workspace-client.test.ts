/**
 * The standing contract of `@interego/workspace-client`, expressed as the defects it closes.
 *
 * Every case below reproduces something that was once TRUE of a hand-written reader in the
 * published artifact and rendered as fact something the graph does not state. They are written
 * against the module because the module is now the only copy — the artifact's script is
 * generated from it (see `workspace-artifact-no-drift.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  graphRegion, readLiteral, readIri, readIriList, readInt, hasTrue, hasType, masked,
  literalAt, parseRoleProfile, escapeTurtleLiteral, WSP,
  orderChain, entryTurtle, preconditionLine, entryShapeAnswer,
  podOfWebid, podOfNsIri, podOfDescriptorUrl, parseAcceptanceIri, assignPodMarks, slugProblem,
  parseWorkspaceIri, memberDocIris, RelayMcpTransport, ConnectorTransport, asRefusal, refusal,
  shortRef, grantPodFor, WorkspaceClient,
  type ChainRow, type RelayOAuthBearer, type AnyTransport,
} from '@interego/workspace-client';

const RELAY = 'https://relay.interego.xwisee.com';
const trig = (iri: string, body: string): string =>
  `@prefix wsp: <${WSP}> .\n@prefix dct: <http://purl.org/dc/terms/> .\n`
  + `<urn:iep:x> dct:title "DESCRIPTOR LEVEL" .\n<${iri}> {\n${body}\n}\n`;

describe('the mask: a comment and a literal carry no triples', () => {
  const G = 'https://r/ns/p/w';
  it('does not read a description out of a comment', () => {
    const r = graphRegion(trig(G, `# dct:description "SPOOFED"\n<${G}> dct:title "real" .`), G);
    expect(readLiteral(r, 'dct:description')).toBe(null);
    expect(readLiteral(r, 'dct:title')).toBe('real');
  });
  it('does not read a convener out of a comment', () => {
    const r = graphRegion(trig(G, `# wsp:convener <https://evil.example/me>\n<${G}> dct:title "t" .`), G);
    expect(readIri(r, 'wsp:convener')).toBe(null);
  });
  it('does not read a revocation out of a comment', () => {
    const r = graphRegion(trig(G, `# wsp:revoked true\n<${G}> dct:title "t" .`), G);
    expect(hasTrue(r, 'wsp:revoked')).toBe(false);
  });
  it('does not read a term quoted inside a long literal', () => {
    const r = graphRegion(trig(G, `<${G}> dct:title """a dct:description "SPOOF" inside""" .`), G);
    expect(readLiteral(r, 'dct:description')).toBe(null);
  });
  it('is length-preserving, so recovered offsets still line up', () => {
    const src = `<a> dct:title "hello" . # trailing\n`;
    expect(masked(src)).toHaveLength(src.length);
  });
});

describe('literals: both syntaxes, and an unterminated one is not a literal', () => {
  it('reads a long literal rather than the empty string between the first two quotes', () => {
    expect(literalAt('"""multi\nline"""', 0)).toBe('multi\nline');
  });
  it('reports an unterminated short literal as absent', () => {
    expect(literalAt('"never closed\n', 0)).toBe(null);
  });
  it('unescapes \\u sequences', () => {
    expect(literalAt('"caf\\u00e9"', 0)).toBe('café');
  });
});

describe('the region locator walks, so a publisher cannot move it', () => {
  const G = 'https://r/ns/p/w';
  it('ignores a fake block opener hidden inside an earlier literal', () => {
    const doc = `<urn:x> dct:title "<${G}> { <${G}> dct:title \\"SPOOF\\" }" .\n<${G}> {\n<${G}> dct:title "real" .\n}\n`;
    expect(readLiteral(graphRegion(doc, G), 'dct:title')).toBe('real');
  });
  it('is not truncated by a stray brace inside a literal', () => {
    const doc = `<${G}> {\n<${G}> dct:description "a { brace" ;\n  dct:title "kept" .\n}\n`;
    expect(readLiteral(graphRegion(doc, G), 'dct:title')).toBe('kept');
  });
  it('tolerates a comment between the graph IRI and its brace', () => {
    const doc = `<${G}> # a legal comment\n{\n<${G}> dct:title "found" .\n}\n`;
    expect(readLiteral(graphRegion(doc, G), 'dct:title')).toBe('found');
  });
  it('returns null — not a wrong region — for a graph IRI that is not a legal IRI reference', () => {
    const bad = 'https://r/ns/p/w{x';
    expect(graphRegion(`<${bad}> {\n<a> dct:title "x" .\n}\n`, bad)).toBe(null);
  });
  it('distinguishes a located EMPTY region from one that was not located', () => {
    // A located region is a STRING (here just the newline between the braces); a region that
    // was not located is `null`. Callers must not collapse the two — reporting a located
    // empty block as "could not be located" is a false statement about a region that WAS
    // found, and it happened at three separate call sites.
    const located = graphRegion(`<${G}> {\n}\n`, G);
    expect(located).not.toBe(null);
    expect((located ?? 'x').trim()).toBe('');
    expect(graphRegion(`<other> {\n}\n`, G)).toBe(null);
  });
  it('does not let an earlier block make this one look top-level', () => {
    const doc = `<https://r/other> {\n  <a> dct:title "x" .\n}\n<${G}> {\n<${G}> dct:title "mine" .\n}\n`;
    expect(readLiteral(graphRegion(doc, G), 'dct:title')).toBe('mine');
  });
});

describe('readers accept both predicate forms and both value syntaxes', () => {
  it('reads a full-IRI predicate', () => {
    expect(readLiteral('<a> <http://purl.org/dc/terms/title> "t" .', 'dct:title')).toBe('t');
  });
  it('reads a native boolean, not only the quoted lexical form', () => {
    expect(hasTrue('<a> wsp:revoked true .', 'wsp:revoked')).toBe(true);
    expect(hasTrue('<a> wsp:revoked "true" .', 'wsp:revoked')).toBe(true);
    expect(hasTrue('<a> wsp:revoked false .', 'wsp:revoked')).toBe(false);
  });
  it('reads an integer written bare or typed, and reports absence as null rather than 0', () => {
    expect(readInt('<a> wsp:seq 7 .', 'wsp:seq')).toBe(7);
    expect(readInt('<a> wsp:seq "7"^^xsd:nonNegativeInteger .', 'wsp:seq')).toBe(7);
    expect(readInt('<a> dct:title "x" .', 'wsp:seq')).toBe(null);
  });
  it('walks an IRI list rather than splitting on "." — every http IRI contains one', () => {
    const list = readIriList('<a> wsp:permits <https://x.example/a#p>, <https://x.example/a#q> .', 'wsp:permits');
    expect(list).toEqual(['<https://x.example/a#p>', '<https://x.example/a#q>']);
  });
  it('rejects an IRI object containing a brace instead of returning it', () => {
    expect(readIri('<a> wsp:convener <https://x/{evil}> .', 'wsp:convener')).toBe(null);
  });
  it('reads a type in either form', () => {
    expect(hasType('<a> a wsp:Entry .', 'wsp:Entry')).toBe(true);
    expect(hasType(`<a> a <${WSP}Entry> .`, 'wsp:Entry')).toBe(true);
    expect(hasType('<a> a wsp:EntryDraft .', 'wsp:Entry')).toBe(false);
  });
});

describe('the role profile is data, not an enum', () => {
  it('reads roles and capabilities, and a role permitting nothing is not invented', () => {
    const ttl = `@prefix wsp: <${WSP}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`
      + `wsp:Post a wsp:Capability ; rdfs:label "Post" ; rdfs:comment "write an entry" .\n`
      + `wsp:Contributor a wsp:Role ; rdfs:label "Contributor" ; wsp:permits wsp:Post .\n`
      + `wsp:Reader a wsp:Role ; rdfs:label "Reader" ; rdfs:comment "read only" .\n`;
    const p = parseRoleProfile(ttl);
    expect(p.caps.get(WSP + 'Post')?.label).toBe('Post');
    expect(p.roles.get(WSP + 'Contributor')?.permits).toEqual([WSP + 'Post']);
    expect(p.roles.get(WSP + 'Reader')?.permits).toEqual([]);
  });
  it('is not fooled by a comment that trails a triple', () => {
    const ttl = `@prefix wsp: <${WSP}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`
      + `wsp:R a wsp:Role ; rdfs:label "R" . # wsp:Fake a wsp:Role ; rdfs:label "Fake" .\n`;
    expect([...parseRoleProfile(ttl).roles.keys()]).toEqual([WSP + 'R']);
  });
});

describe('the chain walk imposes order from the links, never from a clock', () => {
  const row = (url: string, supersedes: string[]): ChainRow => ({ url, cid: url, supersedes });
  it('orders a linear chain regardless of manifest order', () => {
    const walk = orderChain([row('c', ['b']), row('a', []), row('b', ['a'])]);
    expect(walk.ordered.map((r) => r.url)).toEqual(['a', 'b', 'c']);
    expect(walk.forked).toBe(false);
    expect(walk.walked).toBe(3);
  });
  it('reports a fork rather than picking a winner', () => {
    const walk = orderChain([row('a', []), row('b', [])]);
    expect(walk.forked).toBe(true);
    expect(walk.heads).toBe(2);
  });
  it('reports how far it walked when the chain falls short of the manifest', () => {
    // 'orphan' is superseded by nothing and supersedes nothing reachable, so the walk from the
    // single head cannot cover it. `walked` must be the real number, not `ordered.length`.
    const walk = orderChain([row('a', []), row('b', ['a']), row('c', ['b']), row('d', ['zz'])]);
    expect(walk.forked).toBe(true);   // two heads: c and d
    expect(walk.walked).toBe(0);
  });
});

describe('entry composition escapes literals and refuses unserialisable IRIs', () => {
  const base = { streamIri: 'https://r/ns/p/s', workspace: 'https://r/ns/p/w', seq: 0, prior: null, createdIso: '2026-01-01T00:00:00.000Z' };
  it('escapes quotes and newlines in the body', () => {
    const t = entryTurtle({ ...base, body: 'he said "hi"\nthen left' });
    expect(t).toContain('dct:description "he said \\"hi\\"\\nthen left"');
  });
  it('refuses a body that tries to close the literal and open a new triple', () => {
    const t = entryTurtle({ ...base, body: '" . <victim> <http://www.w3.org/ns/auth/acl#agent> <did:web:attacker> . <x> dct:description "' });
    // The quote that would have closed the literal is ESCAPED, so the whole payload stays
    // inside one literal and `<victim>` never becomes a subject. This is the shape of a real
    // finding elsewhere in this repo: a well-formed document carrying a top-level
    // `<victim> acl:agent <did:web:attacker> .` written by string concatenation.
    expect(t).toContain('dct:description "\\" . <victim>');
    expect(t).not.toMatch(/\n<victim>/);
    // Exactly one statement terminator at the end of the document, so nothing was opened.
    expect(t.trimEnd().endsWith('" .')).toBe(true);
  });
  it('refuses an IRI that would close its own reference', () => {
    expect(() => entryTurtle({ ...base, body: 'x', workspace: 'https://r/ns/p/w> <a> <b' })).toThrow(/not serializable/);
  });
  it('declares the prior head when there is one', () => {
    expect(entryTurtle({ ...base, body: 'x', prior: 'https://css/1.ttl' })).toContain('iep:supersedes <https://css/1.ttl>');
  });
  it('escapes a backslash before anything else', () => {
    expect(escapeTurtleLiteral('a\\b')).toBe('a\\\\b');
  });
});

describe('absence is not evidence', () => {
  it('a missing precondition block is reported as not reported, not as "first entry"', () => {
    expect(preconditionLine(undefined, 'bafyabc', 'the prior entry\'s content CID'))
      .toMatch(/did not report a precondition result/);
    expect(preconditionLine(undefined, null, null)).toBe(null);
  });
  it('compares the CIDs itself rather than trusting the passed flag', () => {
    const line = preconditionLine({ passed: true, expectedCid: 'bafyaaaaaaaaaa', observedCid: 'bafybbbbbbbbbb' }, 'x', null);
    expect(line).toContain('CIDs DO NOT MATCH');
    expect(line).toContain('AND THESE DISAGREE');
  });
  it('says the block had nothing to compare when it carried one CID', () => {
    expect(preconditionLine({ passed: true, expectedCid: 'bafyaaaaaaaaaa' }, 'x', null))
      .toMatch(/an expected CID and no observed one/);
  });
  it('has a separate answer for "the record has not been read"', () => {
    expect(entryShapeAnswer(null, null, 'https://r/ns/p/w')).toMatch(/has not been read/);
    expect(entryShapeAnswer(null, { kind: 'error' }, 'https://r/ns/p/w')).toMatch(/read of the workspace record failed/);
    expect(entryShapeAnswer(null, { kind: 'missing' }, 'https://r/ns/p/w')).toMatch(/no workspace record is published/);
    expect(entryShapeAnswer('https://shape', null, 'https://r/ns/p/w')).toBe('https://shape');
  });
});

describe('the naming scheme takes itself apart again', () => {
  it('resolves a pod out of both WebID shapes and refuses anything else', () => {
    expect(podOfWebid('https://identity.example/users/u-eth-abc/profile#me')).toBe('u-eth-abc');
    expect(podOfWebid('https://relay.example/agents:x-u-pk-abc')).toBe('u-pk-abc');
    expect(podOfWebid('https://identity.example/users/u-eth-{evil}/profile#me')).toBe(null);
    expect(podOfWebid('mailto:nobody@example.com')).toBe(null);
  });
  it('reads the pod segment out of an /ns/ IRI and out of a descriptor URL', () => {
    expect(podOfNsIri(RELAY + '/ns/u-eth-abc/thing')).toBe('u-eth-abc');
    expect(podOfDescriptorUrl('http://css.railway.internal:3456/u-eth-abc/context-graphs/1.ttl')).toBe('u-eth-abc');
  });
  it('parses a qualified acceptance without a fetch, and marks a legacy one as legacy', () => {
    const q = parseAcceptanceIri(RELAY, RELAY + '/ns/u-pk-me/u-eth-c0ffee--room-acceptance', 'u-pk-me');
    expect(q).toEqual({ naming: 'qualified', owner: 'u-eth-c0ffee', slug: 'room', workspace: RELAY + '/ns/u-eth-c0ffee/room' });
    expect(parseAcceptanceIri(RELAY, RELAY + '/ns/u-pk-me/room-acceptance', 'u-pk-me')?.naming).toBe('legacy');
    expect(parseAcceptanceIri(RELAY, RELAY + '/ns/u-pk-other/x-acceptance', 'u-pk-me')).toBe(null);
  });
  it('offers the qualified name first and the legacy name as a fallback', () => {
    const [first, second] = memberDocIris(RELAY, 'u-pk-me', 'u-eth-c0ffee', 'room', 'stream');
    expect(first?.iri).toBe(RELAY + '/ns/u-pk-me/u-eth-c0ffee--room-stream');
    expect(second?.iri).toBe(RELAY + '/ns/u-pk-me/room-stream');
  });
  it('refuses a slug that would make the split ambiguous', () => {
    expect(slugProblem('a--b')).toMatch(/separator/);
    expect(slugProblem('trailing-')).toMatch(/trailing hyphen/);
    expect(slugProblem('ok-name')).toBe(null);
  });
  it('widens a badge until it is unique across the pods being rendered', () => {
    const marks = assignPodMarks(['u-eth-abcd', 'u-pk-abce']);
    expect(new Set(marks.values()).size).toBe(2);
  });
  it('only accepts a workspace IRI on this relay', () => {
    expect(parseWorkspaceIri(RELAY, RELAY + '/ns/u-eth-a/room')).toEqual({ owner: 'u-eth-a', slug: 'room' });
    expect(parseWorkspaceIri(RELAY, RELAY + '/ns/u-eth-a/room/extra')).toBe(null);
    expect(parseWorkspaceIri(RELAY, 'https://elsewhere/ns/u-eth-a/room')).toBe(null);
  });
});

describe('the transport declares which credential drives it', () => {
  const bearer: RelayOAuthBearer = { kind: 'relay-oauth-bearer', accessToken: 't', method: 'siwe', expiresAt: null };
  it('couples the relay HTTP transport to a relay OAuth bearer', () => {
    expect(new RelayMcpTransport(RELAY, bearer).accepts).toBe('relay-oauth-bearer');
  });
  it('couples the connector transport to a connector grant', () => {
    const noop = new ConnectorTransport({ listTools: async () => ({ servers: [] }), callTool: async () => ({}) });
    expect(noop.accepts).toBe('connector-grant');
  });
  it('cannot watch over plain HTTP, and says so rather than registering a no-op', () => {
    expect(new RelayMcpTransport(RELAY, bearer).watchTool()).toBe(null);
  });
  it('unwraps a refusal that arrived as a rejection', () => {
    const rejection = { code: 'tool_error', result: { payload: { error: 'precondition_failed', code: 412 } } };
    expect(asRefusal(rejection)?.['code']).toBe(412);
    expect(asRefusal({ code: 'server_unavailable' })).toBe(null);
    expect(refusal({ ok: true })).toBe(null);
  });
  it('names the remedy for a page nobody connected, because only one host has that remedy', async () => {
    // The published artifact is the only host this transport serves, so the instruction belongs
    // with it. A shell that supplied the sentence would be a second place to keep it true.
    const none = new ConnectorTransport({ listTools: async () => ({ servers: [] }), callTool: async () => ({}) });
    await expect(none.connect(['get_pod_status'], 'get_pod_status')).rejects.toThrow(/Settings → Connectors/);
  });
});

// ── what the artifact's own I/O wrappers used to decide for themselves ───────

/** A transport whose answers are scripted, so a call sequence can be asserted exactly. */
function scripted(answers: Record<string, unknown[]>): { tx: AnyTransport; calls: { name: string; input: Record<string, unknown> }[] } {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const tx = {
    accepts: 'connector-grant' as const,
    label: 'scripted',
    connect: async () => ({ granted: [] as readonly string[] }),
    callTool: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      const q = answers[name];
      if (!q || !q.length) throw new Error('the script has no further answer for ' + name);
      return q.shift();
    },
  } as unknown as AnyTransport;
  return { tx, calls };
}

describe('a member document that could not be read is not a member document that is absent', () => {
  const relay = RELAY;
  const client = (answers: Record<string, unknown[]>): { c: WorkspaceClient; calls: { name: string }[] } => {
    const { tx, calls } = scripted(answers);
    return { c: new WorkspaceClient(relay, tx), calls };
  };

  it('carries the reason forward as an error, so no caller can call it "not published yet"', async () => {
    // MEASURED SHAPE: a head the relay could not explain comes back as a RESOLVED body with
    // neither a head nor a message. `currentHead` calls that `unreadable`. This used to arrive
    // at `resolveMemberDoc` as a plain no-url answer and leave `error: null`, and every caller
    // reads `error: null` as licence to print "granted, but no acceptance published on their pod
    // yet" — a positive statement about somebody else's pod from a read that established nothing.
    const { c } = client({ get_current_head: [{ podUrl: '/u-eth-b' }, { podUrl: '/u-eth-b' }] });
    const got = await c.resolveMemberDoc('u-eth-b', 'u-eth-a', 'room', 'acceptance');
    expect(got.found).toBe(false);
    expect(got.error).toMatch(/neither a head nor a reason/);
  });

  it('still reports a clean absence as an absence, which is what licenses offering Create', async () => {
    const absent = { podUrl: '/u-eth-b', message: 'No descriptor on this pod describes the requested urn.' };
    const { c } = client({ get_current_head: [absent, absent] });
    const got = await c.resolveMemberDoc('u-eth-b', 'u-eth-a', 'room', 'acceptance');
    expect(got.found).toBe(false);
    expect(got.error).toBe(null);
  });

  it('tries the qualified name first and reports which one answered', async () => {
    const { c, calls } = client({
      get_current_head: [
        { podUrl: '/u-eth-b', message: 'nothing here' },
        { podUrl: '/u-eth-b', head: { descriptorUrl: 'http://css/x.ttl', cid: 'bafy' } },
      ],
    });
    const got = await c.resolveMemberDoc('u-eth-b', 'u-eth-a', 'room', 'acceptance');
    expect(calls.length).toBe(2);
    expect(got.found).toBe(true);
    expect(got.naming).toBe('legacy');
  });
});

describe('the grant pod is decided once, so a diagnostic cannot name a pod nothing was asked for', () => {
  it('prefers the convener the record names over the pod segment in the IRI', () => {
    expect(grantPodFor('u-eth-convener', 'u-eth-iri')).toBe('u-eth-convener');
    expect(grantPodFor(null, 'u-eth-iri')).toBe('u-eth-iri');
  });
});

describe('shortening tells a revision apart from a storage address', () => {
  it('keeps a URL\'s last segment rather than its head and tail', () => {
    expect(shortRef('http://css.railway.internal:3456/u-eth-a/context-graphs/17.ttl')).toBe('…/17.ttl');
  });
  it('shortens a CID as an opaque string, which a URL formatter would misrepresent', () => {
    expect(shortRef('bafkreighlmnopqrstuvwxyz3bt65q')).toBe('bafkreighl…3bt65q');
  });
});
