/**
 * Residual gap 0: a record bound to the FIELDS CLAIMED FOR IT.
 *
 * Everything here exists because `Grant` and `Acceptance` used to arrive as caller-typed
 * JavaScript objects with an attestation sitting beside them covering none of their fields.
 * The stated blocker was that no code in the repo read a grant or an acceptance off a pod,
 * so there was no producer to bind against. `membership.ts` is that producer, and these
 * tests are what say whether it produces anything worth binding to.
 *
 * ★ THE SHAPE OF THE TESTS MATTERS AS MUCH AS THE COUNT. This area has been through four
 * adversarial rounds and every round of fixes shipped a new defect of the class it fixed,
 * including a "durability" fix that lost live data and a verifier that accused the code of
 * its own bug. So every refusal below is paired with a CONTROL asserting the genuine article
 * is ADMITTED — a suite where everything is refused establishes nothing, and that is exactly
 * how §6 of verify-can-live.ts used to pass.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  grantTurtle, acceptanceTurtle, readGrantRecord, readAcceptanceRecord,
  workspaceTurtle, readWorkspaceRecord, convenerEvidenceOf,
  publishMembershipRecord, WSP_TERMS, MEMBERSHIP_VISIBILITY_BUDGET_MS,
} from '../applications/shared-workspace/src/membership.js';
import {
  foldRoster, refuseFieldBinding, type Grant, type Acceptance, type Attestation,
} from '../applications/shared-workspace/src/roster.js';
import { entryTurtle, type StreamDeps } from '../applications/shared-workspace/src/stream.js';
import {
  scopesFromRegistry, signerIndexFromRegistry, CAPS, type RoleProfile, type RegisteredAgent,
} from '../applications/shared-workspace/src/can.js';
// ★ THE EMITTER, NOT A REPLICA OF IT. See `descriptorDeps`: a double that hand-rolls the wrap
// is a second double, and the two diverging is exactly how a defect hides. `publish()` calls
// this same function on the way to the pod.
import { wrapAsTriG } from '@interego/solid';

const P = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
const WS = 'https://relay.test/ws/alpha';
const CONV = 'https://conv.test/profile#me';
const CONV_KEY = 'did:web:agents.test:conv-1';
const bee = 'https://bee.test/profile#me';
const BEE_KEY = 'did:web:agents.test:bee-1';

const GRANT_URL = 'https://conv.test/c/g1.ttl';
const ACCEPT_URL = 'https://bee.test/c/a1.ttl';

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Contributor`, permits: [CAPS.read, CAPS.append] },
    { role: `${P}#Observer`, permits: [CAPS.read] },
  ],
};
const REGISTRY: { principal: string; agents: RegisteredAgent[] }[] = [
  { principal: CONV, agents: [{ did: CONV_KEY, scope: 'ReadWrite' }] },
  { principal: bee, agents: [{ did: BEE_KEY, scope: 'ReadWrite' }] },
];
const scopes = scopesFromRegistry(REGISTRY);
const signerOf = signerIndexFromRegistry(REGISTRY);

/** The graph IRI the relay would mint for a record served at this descriptor URL. */
const graphIriFor = (url: string): string =>
  `urn:iep:pod:${url.split('/').pop()!.replace(/\.ttl$/, '')}`;

/**
 * The descriptor Turtle a pod serves beside a payload: it names the graph it describes, and
 * carries the proof whose `iep:descriptorId` shares the URL's terminal segment — the
 * convention the live relay mints and the one `proofBindsToDescriptorUrl` compares on.
 */
const descriptorTurtleFor = (url: string): string =>
  `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .

<${url}>
  a iep:ContextDescriptor ;
  iep:describes <${graphIriFor(url)}> ;
  iep:authorshipProof [ iep:descriptorId <${graphIriFor(url)}> ] .
`;

/**
 * A `get_descriptor` double that serves a payload and a verdict about THAT payload.
 *
 * ★ Modelled on what the relay actually returns rather than on what is convenient. The
 * handler computes `contentBinding` by digesting the very `graph.content` it returns
 * (`observedGraphDigest({graphContent: graph?.content, descriptorTurtle: turtle})`), so a
 * double that let the two disagree would be testing a substrate that does not exist — and
 * this repo's standing lesson is that coverage measured against a double measures the double.
 *
 * ★★ AND `graph.content` IS THE WRAPPED DOCUMENT, BUILT BY THE EMITTER ITSELF. It used to be
 * the raw payload Turtle. That is not what any pod serves: `publish()` runs the payload
 * through `wrapAsTriG`, which puts the descriptor's triples in the DEFAULT graph and the
 * payload inside `<graphIri> { … }`. Every test in this file therefore exercised a document
 * with no default graph to hide anything in — and the defect they exist to catch is precisely
 * a reader parsing the default graph, which no digest reaches. Forty tests carrying the
 * headline claim were measuring the double. `wrapAsTriG` is imported from @interego/solid, not
 * replicated here, because a replica of the emitter IS a second double.
 *
 * `unwrapped: true` is available for the handful of cases that need to assert what happens to
 * a response whose payload is NOT in the shape a pod serves — and the answer must be refusal.
 */
const descriptorDeps = (
  records: Record<string, {
    content?: string; signedBy?: string; binding?: string; verified?: boolean; error?: string;
    /** Serve `content` verbatim instead of wrapping it — for the refusal cases only. */
    unwrapped?: boolean;
    /**
     * Also put `content` at the TOP LEVEL of the response, beside `graph`.
     *
     * ★ FOUND BY MUTATION, AND IT WAS A REAL SURVIVOR. `payloadOf` used to fall back to
     * `res.content` when `graph.content` was absent, and reintroducing that fallback broke
     * NOTHING: no double in this file ever set the field, so the branch the fallback lives on
     * was never reached. A refusal nothing can distinguish from an absence is not a refusal.
     */
    topLevelContent?: boolean;
    /** Inject these triples into the DEFAULT graph, outside the digested block. */
    outsideBlock?: string;
    /** Serve a descriptor with no `iep:describes` at all. */
    noDescribes?: boolean;
  }>,
): StreamDeps => ({
  publish: vi.fn(async () => ({})),
  discover: vi.fn(async () => ({ entries: [] })),
  getDescriptor: vi.fn(async (args: Record<string, unknown>) => {
    const url = String(args.url);
    const r = records[url];
    if (r === undefined) return { error: 'descriptor could not be retrieved' };
    if (r.error !== undefined) return { error: r.error };
    const turtle = r.noDescribes === true
      ? `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n\n<${url}> a iep:ContextDescriptor .\n`
      : descriptorTurtleFor(url) + (r.outsideBlock ?? '');
    const served = r.content === undefined
      ? undefined
      : r.unwrapped === true ? r.content : wrapAsTriG(turtle, r.content, graphIriFor(url));
    return {
      url,
      turtle,
      ...(r.topLevelContent === true && r.content !== undefined ? { content: r.content } : {}),
      ...(served === undefined ? {} : { graph: { url: 'https://x/g', mediaType: 'text/turtle', encrypted: false, content: served } }),
      authorship: {
        authorshipVerified: r.verified ?? true,
        signedBy: r.signedBy ?? CONV_KEY,
        contentBinding: r.binding ?? 'bound',
      },
    };
  }),
});

const GRANT_TTL = grantTurtle({
  grantIri: 'https://conv.test/g/1', workspace: WS, grantedTo: bee, role: `${P}#Contributor`,
});
const ACCEPT_TTL = acceptanceTurtle({
  acceptanceIri: 'https://bee.test/a/1', workspace: WS, member: bee,
  accepts: GRANT_URL, stream: 'https://bee.test/s',
});
// ★ THE SUBJECT IS `WS` ITSELF, not a record name minted beside it. See `workspaceTurtle`.
const WORKSPACE_TTL = workspaceTurtle({
  workspaceIri: WS, convener: CONV, roleProfile: P, title: 'alpha',
});
const WORKSPACE_URL = 'https://conv.test/c/ws.ttl';

// ── the serializer ───────────────────────────────────────────────────────────

describe('serializing a membership record', () => {
  it('renders a grant the published shape describes, with prefixed vocabulary terms', () => {
    expect(GRANT_TTL).toContain('a wsp:MembershipGrant ;');
    expect(GRANT_TTL).toContain(`wsp:workspace <${WS}> ;`);
    expect(GRANT_TTL).toContain(`wsp:grantedTo <${bee}> ;`);
    expect(GRANT_TTL).toContain(`wsp:role <${P}#Contributor> .`);
    expect(GRANT_TTL).toContain(`@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .`);
  });

  it('renders an acceptance naming the grant by its DESCRIPTOR url', () => {
    expect(ACCEPT_TTL).toContain('a wsp:MembershipAcceptance ;');
    expect(ACCEPT_TTL).toContain(`wsp:member <${bee}> ;`);
    expect(ACCEPT_TTL).toContain(`wsp:accepts <${GRANT_URL}> ;`);
    expect(ACCEPT_TTL).toContain('wsp:stream <https://bee.test/s> .');
  });

  it('emits a boolean flag only where the caller gave one, and emits false as well as true', () => {
    expect(grantTurtle({ grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`, revoked: true }))
      .toContain('wsp:revoked "true"^^xsd:boolean');
    // ★ `false` is emitted rather than dropped. Absent and false are the same to the fold and
    // NOT the same to a person auditing a chain: a superseding grant that deliberately
    // reinstates is a statement, and dropping it makes it look like an author who never
    // considered revocation at all.
    expect(grantTurtle({ grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`, revoked: false }))
      .toContain('wsp:revoked "false"^^xsd:boolean');
    expect(GRANT_TTL).not.toContain('wsp:revoked');
  });

  it('★ REFUSES an IRI that would close the reference and write a triple of its own', () => {
    // Turtle's IRIREF production has no escape for `>`, so the only correct handling is
    // refusal. An authorization record built by concatenation is a membership forged by
    // concatenation: this exact position is where a review wrote `<victim> acl:agent
    // <did:web:attacker>` into a published entry.
    expect(() => grantTurtle({
      grantIri: 'https://c/g', workspace: WS, role: `${P}#Observer`,
      grantedTo: 'https://x/p> ; <http://www.w3.org/ns/auth/acl#agent> <did:web:attacker',
    })).toThrow(/not serializable as a Turtle IRI/);
    expect(() => acceptanceTurtle({
      acceptanceIri: 'https://b/a', workspace: WS, member: bee, stream: 'https://b/s',
      accepts: 'https://c/g1> . <https://relay.test/ws/alpha> <https://x#convener> <https://attacker',
    })).toThrow(/not serializable as a Turtle IRI/);
  });

  it('refuses a relative or scheme-less identifier', () => {
    // A relative reference resolves against whatever base the consuming parser happens to
    // use, which is a different membership on a different pod.
    expect(() => grantTurtle({ grantIri: '/g/1', workspace: WS, grantedTo: bee, role: `${P}#Observer` }))
      .toThrow(/the record IRI is not serializable/);
  });

  it('constrains extraTriples to one predicate-object pair, like entryTurtle', () => {
    expect(grantTurtle({
      grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`,
      extraTriples: ['<https://x#note> "ok"'],
    })).toContain('<https://x#note> "ok" .');
    for (const bad of ['<https://x#a> "b" . <https://c> <https://d> <https://e>', '@prefix evil: <https://x#>', 'a\nb']) {
      expect(() => grantTurtle({
        grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`, extraTriples: [bad],
      })).toThrow(/extraTriples must be ONE predicate-object pair/);
    }
  });
});

// ── residual gap 6: the record that says who was entitled to grant ───────────

describe('the workspace record — who convenes here', () => {
  it('renders every term wspsh:WorkspaceShape requires, with the workspace as SUBJECT', () => {
    // ★ THE SUBJECT IS THE ASSERTION. A record carrying `wsp:workspace <W>` would be a record
    // ABOUT W, and any pod can write one of those about any workspace. The fold compares this
    // subject with the workspace it is folding, which is what makes it a record OF W.
    expect(WORKSPACE_TTL).toContain(`<${WS}>`);
    expect(WORKSPACE_TTL).toContain('a wsp:Workspace ;');
    expect(WORKSPACE_TTL).toContain(`wsp:convener <${CONV}> ;`);
    expect(WORKSPACE_TTL).toContain(`wsp:roleProfile <${P}> ;`);
    // `sh:minCount 1` on dct:title in the published shape, so a workspace without one is a 422
    // before it reaches a pod. Required in the signature here so it is a compile error instead.
    expect(WORKSPACE_TTL).toContain('dct:title "');
  });

  it('★ REFUSES an IRI that would close the reference — same guard as the other two', () => {
    expect(() => workspaceTurtle({
      workspaceIri: WS, roleProfile: P, title: 'x',
      convener: 'https://x/p> ; <https://markjspivey-xwisee.github.io/interego/applications/'
        + 'shared-workspace/wsp#convener> <did:web:attacker',
    })).toThrow(/not serializable as a Turtle IRI/);
  });

  it('★ reads the convener FROM THE PAYLOAD, with provenance naming the record', async () => {
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.problems).toEqual([]);
    expect(read.record).not.toBeNull();
    expect(read.record!.workspace).toBe(WS);
    expect(read.record!.convener).toBe(CONV);
    expect(read.record!.roleProfile).toBe(P);
    expect(read.record!.head).toBe(WORKSPACE_URL);
    expect(read.record!.fieldProvenance).toEqual({ source: 'payload', descriptor: WORKSPACE_URL });
    // Same read, same verdict: the fields came out of the bytes the digest covered.
    expect(read.record!.attestation?.contentBinding).toBe('bound');
  });

  it('★★ and it will not read one out of the UNDIGESTED part of the document', async () => {
    // The parse-scope defect, at the newest record. A convener declaration written into the
    // DEFAULT graph of a document whose named-graph block is somebody's real signed record
    // would come back `contentBinding: 'bound'` — the digest covers the block and nothing
    // else. If this reader looked outside the block, anyone could nominate themselves the
    // convener of anything without touching a single signed byte.
    const smuggled = `<${WS}> a <${WSP_TERMS.Workspace}> ; `
      + `<${WSP_TERMS.convener}> <https://attacker.test/#me> ; `
      + `<${WSP_TERMS.roleProfile}> <${P}> .`;
    const deps = descriptorDeps({
      [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY, outsideBlock: `\n${smuggled}\n` },
    });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    // The block's own declaration is what is read; the smuggled one is not seen at all, so
    // this is not even a "two subjects" ambiguity — it is outside the region entirely.
    expect(read.record!.convener).toBe(CONV);
  });

  it('a record declaring two conveners states none — order must not decide who may grant', async () => {
    // Through `extraTriples`, so the document is genuinely well-formed and genuinely carries
    // two declarations — not a string edit that only looks like one.
    const two = workspaceTurtle({
      workspaceIri: WS, convener: CONV, roleProfile: P, title: 'two',
      extraTriples: ['wsp:convener <https://attacker.test/#me>'],
    });
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: two, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.record).toBeNull();
    expect(read.problems.join(' ')).toMatch(/2 <.*convener> values/);
  });

  it('★ a record with no readable convener is NULL, not a half-record', async () => {
    // ★ WHERE THE TWO-TRACK RULE DOES NOT APPLY, AND WHY. A grant that cannot state its role
    // still REVOKES and a damaged acceptance still WITHDRAWS, so both survive with the
    // conferring field emptied. A workspace record has no restricting half — no revoked, no
    // withdrawn — so a record that does not say who convenes answers nothing, and keeping it
    // would hand the fold a row whose `convener: ''` matched no policy for reasons nobody
    // could see in `problems`.
    const noConvener = workspaceTurtle({ workspaceIri: WS, convener: CONV, roleProfile: P, title: 'x' })
      .replace(/\n  wsp:convener <[^>]+> ;/, '');
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: noConvener, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.record).toBeNull();
    expect(read.problems.join(' ')).toMatch(/carries no <.*convener>/);
  });

  it('★ a blank-node workspace subject is refused — FOUND BY MUTATION, and it survived', async () => {
    // ★ THIS GUARD HAD NO TEST AND DELETING IT BROKE NOTHING, which is the whole reason the
    // case exists. The fold happens to fail closed on the mutant — `workspace: null` compares
    // unequal to every real workspace IRI, so `refuseConvenerAuthority` refuses it on the
    // wrong-workspace branch — so the enumeration and every fold-level case stayed green while
    // the reader's own contract (`workspace: string`) was being violated. A `null` crossing a
    // JSON boundary into a federated composer is not a hazard the fold's coincidental refusal
    // covers, and a guard nothing can distinguish from its absence is not a guard.
    const bnode = `@prefix wsp: <${WSP_TERMS.workspace.replace(/workspace$/, '')}> .\n`
      + `@prefix dct: <http://purl.org/dc/terms/> .\n`
      + `[] a wsp:Workspace ; wsp:convener <${CONV}> ; wsp:roleProfile <${P}> ; dct:title "x" .\n`;
    const read = await readWorkspaceRecord(WORKSPACE_URL, descriptorDeps({ [WORKSPACE_URL]: { content: bnode } }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/blank node/);
  });

  it('an unreadable role profile is a PROBLEM, not a refusal — nothing in the fold reads it', async () => {
    // The other direction of the same rule: the conferring field of a workspace record is its
    // convener, so refusing the whole record over a field no code consults would withhold a
    // convener the record does state. Reported instead, so a caller that wants to compare the
    // profile can see it did not get one.
    const noProfile = workspaceTurtle({ workspaceIri: WS, convener: CONV, roleProfile: P, title: 'x' })
      .replace(/\n  wsp:roleProfile <[^>]+> ;/, '');
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: noProfile, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.record).not.toBeNull();
    expect(read.record!.convener).toBe(CONV);
    expect(read.record!.roleProfile).toBe('');
    expect(read.problems.join(' ')).toMatch(/roleProfile/);
  });

  it('one of the convener\'s own signed records is NOT readable as a workspace declaration', async () => {
    // The manufactured-participant attack, aimed one level up: an ordinary signed entry
    // offered as the workspace's statement of who convenes it. Genuinely the convener's,
    // genuinely content-bound, and it declares no wsp:Workspace.
    const entry = entryTurtle({ entryIri: `${WS}/s/e/0`, workspace: WS, seq: 0, draft: { body: 'hello' } });
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: entry, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.record).toBeNull();
    expect(read.problems.join(' ')).toMatch(/declares no <.*Workspace>/);
    // …and it really is a perfect record otherwise, which is why nothing weaker catches it.
    expect(read.attestation.authorshipVerified).toBe(true);
  });

  it('★ convenerEvidenceOf maps an unreadable workspace onto REFUSAL, never onto silence', async () => {
    // ★ THE BRANCH THAT MAKES THE HELPER WORTH HAVING. `record ? {declared} : undefined` would
    // let a transient get_descriptor failure silently reopen gap 6, with `unchecked` the only
    // trace. Asking and getting silence is not the same as not asking.
    const deps = descriptorDeps({ [WORKSPACE_URL]: { error: 'descriptor could not be retrieved' } });
    const evidence = convenerEvidenceOf(await readWorkspaceRecord(WORKSPACE_URL, deps));
    expect(evidence.kind).toBe('unreadable');
    expect(evidence.kind === 'unreadable' && evidence.why).toMatch(/could not be retrieved/);

    const good = convenerEvidenceOf(await readWorkspaceRecord(
      WORKSPACE_URL, descriptorDeps({ [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY } }),
    ));
    expect(good.kind).toBe('declared');
  });

  it('★★ the attack gap 6 permitted: BEE CONVENES ALICE\'S WORKSPACE, with everything signed', async () => {
    // ★ THE SHARPEST STATEMENT OF WHAT WAS OPEN, and the shape `verify-can-live.ts` §9 now runs
    // live. Folding alice's genuine records under `convener: bee` is the WEAK version — those
    // are signed by alice, so `refuseAttestation` refuses them first and the roster is empty
    // for a reason that has nothing to do with the convener.
    //
    // The real attack is bee writing BOTH HALVES on her own pod and naming herself convener.
    // Every guard this layer had before this round passes at full strength: bee's key signed
    // both records, the substrate re-digested both, every field was parsed. Nothing but the
    // workspace's own declaration stands between that and a membership in alice's workspace.
    const SELF_GRANT = 'https://bee.test/c/self-g.ttl';
    const SELF_ACCEPT = 'https://bee.test/c/self-a.ttl';
    const deps = descriptorDeps({
      [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY },
      [SELF_GRANT]: {
        content: grantTurtle({
          grantIri: 'https://bee.test/g/self', workspace: WS, grantedTo: bee, role: `${P}#Contributor`,
        }),
        signedBy: BEE_KEY,
      },
      [SELF_ACCEPT]: {
        content: acceptanceTurtle({
          acceptanceIri: 'https://bee.test/a/self', workspace: WS, member: bee,
          accepts: SELF_GRANT, stream: 'https://bee.test/s',
        }),
        signedBy: BEE_KEY,
      },
    });
    const base = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [(await readGrantRecord(SELF_GRANT, deps)).record!],
      acceptances: [(await readAcceptanceRecord(SELF_ACCEPT, deps)).record!],
    };

    // The gap, at full strength: the strictest policy that existed before this round.
    const open = foldRoster({
      ...base, attestation: { convener: bee, signerOf, requireFieldBinding: true },
    });
    expect(open.members).toHaveLength(1);
    expect(open.recordFieldBinding).toBe('bound');
    expect(open.recordContentBinding).toBe('bound');
    expect(open.convenerBinding).toBe('unchecked');
    expect(open.unattested).toHaveLength(0);

    // …and closed: same records, same policy, one field added.
    const evidence = convenerEvidenceOf(await readWorkspaceRecord(WORKSPACE_URL, deps));
    const closed = foldRoster({
      ...base,
      attestation: { convener: bee, signerOf, requireFieldBinding: true, workspaceEvidence: evidence },
    });
    expect(closed.members).toHaveLength(0);
    expect(closed.convenerBinding).toBe('refused');
    // ★ REFUSED BY THE CONVENER CHECK AND BY NOTHING ELSE. If the signer, the binding or the
    // provenance had refused first, this case would be pinning some other guard while looking
    // like it pins this one.
    expect(closed.unattested[0]!.because).toMatch(/The two disagree/);
    expect(closed.unattested[0]!.because).not.toMatch(/acts for|does not hold up/);
  });

  it('★★ end to end: the wrong convener is refused and the right one is ADMITTED', async () => {
    // ★ THE CONTROL FIRST. A suite where every configuration is refused establishes nothing,
    // which is exactly how §6 of verify-can-live.ts used to pass.
    const deps = descriptorDeps({
      [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY },
      [GRANT_URL]: { content: GRANT_TTL, signedBy: CONV_KEY },
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY },
    });
    const evidence = convenerEvidenceOf(await readWorkspaceRecord(WORKSPACE_URL, deps));
    const grants = [(await readGrantRecord(GRANT_URL, deps)).record!];
    const acceptances = [(await readAcceptanceRecord(ACCEPT_URL, deps)).record!];
    const base = { workspace: WS, profile: PROFILE, scopes, grants, acceptances };

    const right = foldRoster({
      ...base, attestation: { convener: CONV, signerOf, requireFieldBinding: true, workspaceEvidence: evidence },
    });
    expect(right.members).toHaveLength(1);
    expect(right.convenerBinding).toBe('bound');

    // ★ AND THE CASE verify-can-live.ts §8 DEMONSTRATED AS OPEN. Naming bee as convener used
    // to produce a field-bound roster of the wrong memberships with `recordFieldBinding:
    // 'bound'` either way. It now refuses, and says which of the three questions failed.
    const wrong = foldRoster({
      ...base, attestation: { convener: bee, signerOf, requireFieldBinding: true, workspaceEvidence: evidence },
    });
    expect(wrong.members).toHaveLength(0);
    expect(wrong.convenerBinding).toBe('refused');
    expect(wrong.recordFieldBinding).toBe('bound');   // the records were still perfectly parsed
    // Without the evidence, the same wrong policy is silent about the reason: it refuses the
    // grant for the SIGNER, and the roster reports the convener as unchecked. That difference
    // is the whole of gap 6.
    const unchecked = foldRoster({
      ...base, attestation: { convener: bee, signerOf, requireFieldBinding: true },
    });
    expect(unchecked.convenerBinding).toBe('unchecked');
    expect(unchecked.attributionNote).toMatch(/is the workspace's convener/);
  });
});

// ── the reader ───────────────────────────────────────────────────────────────

describe('reading a membership record back', () => {
  it('★ parses every field out of the payload and marks where they came from', async () => {
    const deps = descriptorDeps({ [GRANT_URL]: { content: GRANT_TTL } });
    const read = await readGrantRecord(GRANT_URL, deps);
    expect(read.problems).toEqual([]);
    expect(read.record).toEqual({
      head: GRANT_URL,
      workspace: WS,
      grantedTo: bee,
      role: `${P}#Contributor`,
      attestation: {
        authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true,
        // ★ ASSERTED, NOT MERELY TOLERATED. `boundToDescriptor: true` on its own covers both
        // "host, pod, container and name matched" and "one path segment matched and the host
        // was never looked at". The relay mints `urn:` descriptor ids, so every real record
        // lands on the weak basis — which is a fact about the substrate a reader must be able
        // to see, and used to be discarded at the boundary.
        descriptorBindingBasis: 'slug-only',
        contentBinding: 'bound',
      },
      fieldProvenance: { source: 'payload', descriptor: GRANT_URL },
    });
    // ONE call. The payload and the verdict about the payload come from the same read, which
    // is the only way `'bound'` is a statement about the bytes that were parsed.
    expect(deps.getDescriptor).toHaveBeenCalledTimes(1);
  });

  it('parses an acceptance, including a withdrawal', async () => {
    const withdrawnTtl = acceptanceTurtle({
      acceptanceIri: 'https://bee.test/a/2', workspace: WS, member: bee,
      accepts: GRANT_URL, stream: 'https://bee.test/s', withdrawn: true,
    });
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: withdrawnTtl, signedBy: BEE_KEY },
    }));
    expect(read.problems).toEqual([]);
    expect(read.record).toMatchObject({
      head: ACCEPT_URL, workspace: WS, member: bee, accepts: GRANT_URL,
      stream: 'https://bee.test/s', withdrawn: true,
      fieldProvenance: { source: 'payload', descriptor: ACCEPT_URL },
    });
  });

  it('★★ THE MANUFACTURED PARTICIPANT: an ordinary signed log entry is NOT an acceptance', async () => {
    // The attack that survived attestation and survived content binding. Bee's own entry,
    // genuinely hers, genuinely signed, genuinely content-bound — the strongest attestation
    // the substrate can produce. What it is not is an acceptance, and until something read
    // the record nobody had ever asked.
    const ordinary = entryTurtle({
      entryIri: `${WS}/stream/bee/e/0`, workspace: WS, seq: 0,
      draft: { body: 'an ordinary day at work' },
    });
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ordinary, signedBy: BEE_KEY, binding: 'bound' },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/declares no <.*MembershipAcceptance>/);
    expect(read.problems[0]).toMatch(/manufactured participant/);
    // The attestation is still returned, and it is still perfect. That is the whole point:
    // the signature was never the discriminator.
    expect(read.attestation.authorshipVerified).toBe(true);
    expect(read.attestation.contentBinding).toBe('bound');
  });

  it('★ CONTROL: the genuine acceptance at the same URL IS admitted', async () => {
    // Without this line the case above proves only that the reader can say no.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY },
    }));
    expect(read.record).not.toBeNull();
    expect(read.problems).toEqual([]);
  });

  it('★ refuses a record that names TWO grantees rather than picking the first', async () => {
    // `readIriValue` returns the first match, which on an authorization record is
    // last-write-wins wearing a different hat: the membership would depend on the order
    // triples happened to be written inside a document.
    const two = GRANT_TTL.replace(
      `wsp:grantedTo <${bee}> ;`,
      `wsp:grantedTo <${bee}> ;\n  wsp:grantedTo <https://mallory.test/profile#me> ;`,
    );
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: two } }));
    expect(read.record).toBeNull();
    expect(read.problems.join(' ')).toMatch(/carries 2 <.*grantedTo> values/);
    expect(read.problems.join(' ')).toMatch(/order its\s+triples happened to be written/);
  });

  it('★ an UNREADABLE revocation flag reads as SET, and says so', async () => {
    // Both tempting answers are wrong. Refusing the record deletes the revocation it was
    // trying to express; coercing to false reinstates a member on the strength of a typo.
    // Erring towards removal is the direction the fold already chose, for the same reason.
    const junk = grantTurtle({ grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`, revoked: true })
      .replace('"true"^^xsd:boolean', '"yes"');
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: junk } }));
    expect(read.record?.revoked).toBe(true);
    expect(read.problems.join(' ')).toMatch(/read as SET/);
  });

  it('★★ a record with no CONFERRING field keeps its power to restrict and loses its power to confer', async () => {
    // ★ THE TWO-TRACK RULE FROM roster.ts, APPLIED AT THE READER — and found by re-reading
    // this module rather than by a failing test. A grant that does not state a role was
    // still being handed a `fieldProvenance`, so under the strictest policy available it
    // CONFERRED membership on the strength of a field it does not have, while `role: ''`
    // quietly carried no capability and the roster reported `recordFieldBinding: 'bound'`
    // over a record that names no role at all.
    //
    // Both halves of the rule are asserted, because either on its own is a defect: dropping
    // the record would delete a revocation before the fold saw it (reinstating a removed
    // member — the failure shape of four consecutive rounds), and keeping the provenance
    // would confer from a record that says nothing.
    const noRole = grantTurtle({ grantIri: 'https://c/g', workspace: WS, grantedTo: bee, role: `${P}#Observer`, revoked: true })
      .replace(/\n  wsp:role <[^>]*> ;/, '');
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: noRole } }));
    expect(read.record).not.toBeNull();
    expect(read.record!.revoked).toBe(true);       // …restricts
    expect(read.record!.role).toBe('');            // never a declared role
    expect(read.record!.fieldProvenance).toBeUndefined();  // …and cannot confer
    expect(read.problems.join(' ')).toMatch(/wsp:role: it carries no/);

    // And end to end: the revocation lands, and no membership is manufactured from it.
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [read.record!],
      acceptances: [{
        head: ACCEPT_URL, workspace: WS, member: bee, accepts: GRANT_URL,
        stream: 'https://bee.test/s',
        attestation: { authorshipVerified: true, signedBy: BEE_KEY, boundToDescriptor: true, contentBinding: 'bound' },
        fieldProvenance: { source: 'payload', descriptor: ACCEPT_URL },
      }],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(0);
    expect(r.pendingInvitations).toHaveLength(0);   // removed, not "never answered"
    expect(r.unattested.find(u => u.kind === 'grant')?.restrictionStillApplied).toBe(true);
  });

  it('★ CONTROL: a record that DOES state its conferring field keeps its provenance', async () => {
    // Without this the rule above would be satisfied by a reader that never sets a
    // provenance at all, which would refuse every membership and look like a working gate.
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: GRANT_TTL } }));
    expect(read.record!.fieldProvenance).toEqual({ source: 'payload', descriptor: GRANT_URL });
  });
});

// ── parse scope vs digest scope ──────────────────────────────────────────────

/**
 * ★★ THE DEFECT THAT DEFEATED THE WHOLE CLOSE, AND THE ONE THIS FILE WAS BLIND TO.
 *
 * `contentBinding: 'bound'` is a statement about ONE REGION of the served document — the
 * `<graphIri> { … }` block that `wrapAsTriG` writes. The reader used to hand the WHOLE
 * document to `parseTrig`. The descriptor's own triples, and anything else a publisher put
 * beside them, sit in the DEFAULT graph, outside the block, parsed and never digested.
 *
 * Every double in this file used to serve the raw payload Turtle, which has no default graph
 * at all, so the gap was invisible here and the suite passed with the hole open. It is the
 * repo's standing lesson arriving one more time: a harness that stands in for a dependency
 * cannot verify it.
 */
describe('★★ parse scope must equal digest scope', () => {
  const FORGED_ACCEPTANCE = `
<https://conv.test/c/g1.ttl#planted>
  a <${WSP_TERMS.MembershipAcceptance}> ;
  <${WSP_TERMS.workspace}> <${WS}> ;
  <${WSP_TERMS.member}> <${bee}> ;
  <${WSP_TERMS.accepts}> <${GRANT_URL}> ;
  <${WSP_TERMS.stream}> <https://conv.test/planted-stream/> .
`;

  it('★★ a MembershipAcceptance planted OUTSIDE the digested block manufactures nothing', async () => {
    // The whole attack, with no cooperation from the member. The named-graph block is a
    // VERBATIM copy of one of bee's real signed records — so the relay re-digests it, matches
    // the signed contentHash, and honestly reports `contentBinding: 'bound'`. The forgery is
    // in the default graph, where no digest reaches. Measured before the fix: the digest was
    // the identical string before and after the insertion, and the roster reported
    // `members: [bee]`, `unattested: []`, `recordFieldBinding: 'bound'`.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: {
        content: entryTurtle({
          entryIri: `${WS}/stream/bee/e/0`, workspace: WS, seq: 0,
          draft: { body: 'an ordinary note bee really did sign' },
        }),
        signedBy: BEE_KEY, binding: 'bound', outsideBlock: FORGED_ACCEPTANCE,
      },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/declares no <.*MembershipAcceptance>/);
    // …and the attestation is untouched and still perfect, which is what made this survive
    // three rounds of attestation and content-binding work.
    expect(read.attestation.authorshipVerified).toBe(true);
    expect(read.attestation.contentBinding).toBe('bound');
  });

  it('★ the same region rule closes the DENIAL direction too', async () => {
    // Same root cause, pointing the other way: one decoy subject outside the block made an
    // HONEST acceptance read as "declares 2 … subjects" and vanish, while binding still said
    // `'bound'`. Silent removal of a real member by anyone who can write beside the block.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY, outsideBlock: FORGED_ACCEPTANCE },
    }));
    expect(read.problems).toEqual([]);
    expect(read.record).toMatchObject({ member: bee, stream: 'https://bee.test/s' });
  });

  it('★ CONTROL: the honest wrapped document still reads clean', async () => {
    // Without this the rule above is satisfied by a reader that refuses every wrapped
    // document — which would empty every roster and look like a working gate.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY },
    }));
    expect(read.problems).toEqual([]);
    expect(read.record).toMatchObject({ member: bee, accepts: GRANT_URL });
  });

  it('★ a payload that is NOT inside a named-graph block is refused, never read whole', async () => {
    // The fallback that used to exist. A response whose `graph.content` is bare Turtle has no
    // region the digest covers, so there is nothing here `'bound'` is a statement about.
    // Refusing costs a reader that could otherwise have parsed it; reading it costs the
    // guarantee.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY, unwrapped: true },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/no named-graph block/);
  });

  it('★ …and NOT out of a top-level `content` beside it either', async () => {
    // ★ THE MUTATION SURVIVOR. Restoring `payloadOf`'s old `?? res.content` fallback broke
    // nothing, because no double had ever set the field — so the branch it lives on was never
    // reached and the refusal above proved only that an absent payload is absent. The relay
    // digests `graph.content` and nothing else, so a top-level `content` is bytes no
    // `contentBinding` verdict is about, however perfectly formed the record inside it is.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY, unwrapped: true, topLevelContent: true },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/no named-graph block/);
  });

  it('★ a descriptor that does not say which graph it describes is refused', async () => {
    // Without `iep:describes` there is no way to tell which region the signature covers, and
    // guessing would be choosing the scope from the attacker's document.
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY, noDescribes: true },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/does not say which graph it describes/);
  });

  it('★ what a `slug-only` binding still buys, measured rather than assumed', async () => {
    // ★ THE DECISION THIS TEST RECORDS. `proofBindsToDescriptorUrl` grades a URN-form
    // descriptorId `slug-only`: one path segment compared, host and pod not. The tempting
    // rule is "field binding requires `exact-url`". It is not adopted, and this is why.
    //
    // (a) It would refuse EVERY record the substrate mints. `publish_context` mints
    //     `descriptor_id` as `urn:iep:<pod>:<epoch-ms>`, so every honest membership record in
    //     existence is `slug-only`. The rule fails closed on 100% of honest data.
    // (b) It would buy nothing that is conferred. With the parse-scope fix in place, every
    //     field comes out of the signed block, so relocating a VERBATIM copy of a genuinely
    //     signed acceptance onto a host the attacker chose produces the identical row.
    //
    // What it leaves open is named rather than folded away, and is asserted below: `head` —
    // the URL an operator dereferences to audit the record, and the URL printed in
    // `unattested` and every `divergence` — is chosen by whoever hosts the copy.
    const RELOCATED = 'https://attacker.example/anything/a1.ttl';
    const served = { content: ACCEPT_TTL, signedBy: BEE_KEY };
    const honest = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({ [ACCEPT_URL]: served }));
    const moved = await readAcceptanceRecord(RELOCATED, descriptorDeps({ [RELOCATED]: served }));

    // Bound, and bound weakly — the basis is visible now instead of collapsed into `true`.
    expect(moved.record!.attestation!.boundToDescriptor).toBe(true);
    expect(moved.record!.attestation!.descriptorBindingBasis).toBe('slug-only');

    // Every CONFERRED value is identical. The relocation changes none of them.
    for (const f of ['workspace', 'member', 'accepts', 'stream'] as const) {
      expect(moved.record![f]).toBe(honest.record![f]);
    }
    // The one thing it does change, and the reason this is residual gap 1 rather than closed.
    expect(moved.record!.head).toBe(RELOCATED);
    expect(honest.record!.head).toBe(ACCEPT_URL);
  });

  it('★ end to end: the roster refuses the manufactured participant', async () => {
    const grant = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: GRANT_TTL } }));
    const acc = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: {
        content: entryTurtle({
          entryIri: `${WS}/stream/bee/e/0`, workspace: WS, seq: 0, draft: { body: 'ordinary' },
        }),
        signedBy: BEE_KEY, binding: 'bound', outsideBlock: FORGED_ACCEPTANCE,
      },
    }));
    expect(acc.record).toBeNull();
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [grant.record!],
      // There is no acceptance to fold: the reader produced none.
      acceptances: [],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(0);
    // The grant is real, so bee shows as INVITED — which is the true state of affairs.
    expect(r.pendingInvitations.map(p => p.principal)).toEqual([bee]);
  });
});

describe('reading a membership record back (continued)', () => {

  it('★ an acceptance missing an IDENTIFYING field yields no record at all', async () => {
    // ★ FOUND BY MUTATION. Deleting this bail-out from `readAcceptanceRecord` left all 237
    // tests green: `tsc` catches it (the reader's `{iri} | {why}` union makes the branch
    // structurally required) but the suite's typecheck does not cover application source, so
    // nothing in the run said a word. The BEHAVIOUR is what matters and it was untested —
    // an acceptance with no `wsp:member` must produce NO record, because a half-membership
    // naming nobody is not a damaged membership, it is an absent one, and the empty string
    // sitting in `member` would silently never match any grantee.
    //
    // `wsp:member` is also the field the published shape does NOT require, so this reader is
    // the only thing enforcing it. That makes the case load-bearing rather than defensive.
    for (const drop of ['member', 'accepts', 'workspace'] as const) {
      const stripped = ACCEPT_TTL.replace(new RegExp(`\\n  wsp:${drop} <[^>]*> ;`), '');
      expect(stripped).not.toBe(ACCEPT_TTL);   // the fixture really did lose the triple
      const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
        [ACCEPT_URL]: { content: stripped, signedBy: BEE_KEY },
      }));
      expect(read.record, `dropping wsp:${drop} still produced a record`).toBeNull();
      expect(read.problems.join(' ')).toMatch(new RegExp(`wsp:${drop}: it carries no`));
    }
  });

  it('★ and a grant missing one yields no record either', async () => {
    // Same mutation, same reason, the other half. Without a workspace the fold cannot tell
    // whether the record is even ours; without a grantee a revocation has nobody to apply to.
    for (const drop of ['workspace', 'grantedTo'] as const) {
      const stripped = GRANT_TTL.replace(new RegExp(`\\n  wsp:${drop} <[^>]*> ;`), '');
      expect(stripped).not.toBe(GRANT_TTL);
      const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: stripped } }));
      expect(read.record, `dropping wsp:${drop} still produced a record`).toBeNull();
      expect(read.problems.join(' ')).toMatch(new RegExp(`wsp:${drop}: it carries no`));
    }
  });

  it('★ CONTROL: dropping a NON-IDENTIFYING field keeps the record, without its provenance', async () => {
    // The pair above must not be read as "any missing field drops the row". `wsp:role` and
    // `wsp:stream` are deliberately NOT identifying: a grant with no role still revokes and
    // an acceptance with no stream still withdraws, and dropping either record would delete
    // a restriction the fold is required to honour. Stated as its own case so a future
    // tightening of the bail-out fails here instead of silently reinstating members.
    //
    // `wsp:stream` is also the acceptance's CONFERRING field — roster.ts calls it out as the
    // one field that stays on the conferring track — so the row keeps its restriction and
    // loses its provenance, exactly as the grant's role does.
    const noStream = acceptanceTurtle({
      acceptanceIri: 'https://bee.test/a/3', workspace: WS, member: bee,
      accepts: GRANT_URL, stream: 'https://bee.test/s', withdrawn: true,
    }).replace(/\n  wsp:stream <[^>]*> ;/, '');
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: noStream, signedBy: BEE_KEY },
    }));
    expect(read.record).not.toBeNull();
    expect(read.record!.withdrawn).toBe(true);
    expect(read.record!.stream).toBe('');
    expect(read.record!.fieldProvenance).toBeUndefined();
    expect(read.problems.join(' ')).toMatch(/wsp:stream: it carries no/);
  });

  it('an unreadable payload is not an empty one', async () => {
    // The same rule readStream learned live: the substrate reports an unreachable pod as
    // DATA, and "this record has no fields" and "we could not see this record" are worlds
    // apart to anyone acting on the answer.
    for (const rec of [{ }, { error: 'descriptor could not be retrieved' }]) {
      const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: rec }));
      expect(read.record).toBeNull();
      expect(read.problems).toHaveLength(1);
      expect(read.problems[0]).toMatch(/no graph payload|get_descriptor failed/);
    }
  });

  it('refuses a blank-node grant, which has no identity an acceptance could name', async () => {
    const bnode = `@prefix wsp: <${WSP_TERMS.workspace.replace(/workspace$/, '')}> .\n`
      + `[] a wsp:MembershipGrant ; wsp:workspace <${WS}> ; wsp:grantedTo <${bee}> ; wsp:role <${P}#Observer> .\n`;
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({ [GRANT_URL]: { content: bnode } }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/blank node/);
  });

  it('refuses a payload declaring two grants, rather than letting the author choose by ordering', async () => {
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({
      [GRANT_URL]: { content: GRANT_TTL + grantTurtle({ grantIri: 'https://conv.test/g/2', workspace: WS, grantedTo: bee, role: `${P}#Observer` }) },
    }));
    expect(read.record).toBeNull();
    expect(read.problems[0]).toMatch(/declares 2 <.*MembershipGrant> subjects/);
  });

  it('reports a failed signature as an attestation, not as an absent record', async () => {
    const read = await readGrantRecord(GRANT_URL, descriptorDeps({
      [GRANT_URL]: { content: GRANT_TTL, verified: false, binding: 'mismatched' },
    }));
    // The fields are still readable; whether they may be BELIEVED is the fold's decision,
    // and the fold cannot make it if the reader has already thrown the row away.
    expect(read.record).not.toBeNull();
    expect(read.record!.attestation!.authorshipVerified).toBe(false);
    expect(read.record!.attestation!.contentBinding).toBe('mismatched');
  });

  it('refuses to answer at all without the tool the answer is read from', async () => {
    await expect(readGrantRecord(GRANT_URL, { publish: vi.fn(), discover: vi.fn() } as unknown as StreamDeps))
      .rejects.toThrow(/need a `getDescriptor` dependency/);
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('refuseFieldBinding', () => {
  const prov = { source: 'payload' as const, descriptor: GRANT_URL };

  it('permits everything when the policy did not ask', () => {
    expect(refuseFieldBinding(undefined, GRANT_URL, false)).toBeNull();
    expect(refuseFieldBinding(undefined, GRANT_URL)).toBeNull();
  });

  it('refuses a caller-typed row and names the attack it enables', () => {
    const why = refuseFieldBinding(undefined, GRANT_URL, true);
    expect(why).toMatch(/typed by whoever called this fold/);
    expect(why).toMatch(/ordinary signed records/);
  });

  it('★ refuses fields parsed from a DIFFERENT record than the row they are attached to', () => {
    // The one check here that is not self-certifying, and it catches a real shape: a
    // composer holding many parsed records at once, attaching <a>'s fields to <b>'s row.
    expect(refuseFieldBinding(prov, 'https://conv.test/c/g2.ttl', true))
      .toMatch(/came from different documents/);
  });

  it('refuses an unrecognised source, because this arrives as JSON in a composer', () => {
    expect(refuseFieldBinding({ source: 'trust-me' } as never, GRANT_URL, true))
      .toMatch(/unrecognised source/);
  });

  it('★ CONTROL: a genuinely parsed row is admitted', () => {
    expect(refuseFieldBinding(prov, GRANT_URL, true)).toBeNull();
  });
});

// ── end to end through the fold ──────────────────────────────────────────────

describe('foldRoster with requireFieldBinding', () => {
  const readBoth = async (grantTtl: string, acceptTtl: string): Promise<{ grant: Grant; acceptance: Acceptance }> => {
    const deps = descriptorDeps({
      [GRANT_URL]: { content: grantTtl, signedBy: CONV_KEY },
      [ACCEPT_URL]: { content: acceptTtl, signedBy: BEE_KEY },
    });
    const g = await readGrantRecord(GRANT_URL, deps);
    const a = await readAcceptanceRecord(ACCEPT_URL, deps);
    expect(g.record).not.toBeNull();
    expect(a.record).not.toBeNull();
    return { grant: g.record!, acceptance: a.record! };
  };

  it('★★ CONTROL FIRST: two records read off pods produce a field-bound member', async () => {
    const { grant, acceptance } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [acceptance],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.principal).toBe(bee);
    expect(r.members[0]!.role).toBe(`${P}#Contributor`);
    expect(r.recordFieldBinding).toBe('bound');
    // Everything below refuses. Without this line, none of it discriminates.
    expect(r.unattested).toEqual([]);
  });

  it('★★ and the ordinary log entry that used to pass is now refused at the reader', async () => {
    // Same convener, same grant, same signer, same content binding. The only difference is
    // that the "acceptance" is one of bee's real entries — which is the whole attack, and
    // which no signature check could ever have distinguished.
    const ordinary = entryTurtle({ entryIri: `${WS}/s/bee/e/0`, workspace: WS, seq: 0, draft: { body: 'hello' } });
    const read = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: { content: ordinary, signedBy: BEE_KEY },
    }));
    expect(read.record).toBeNull();

    // A caller who insists on folding it must hand-build the row, and the gate refuses that.
    const handBuilt: Acceptance = {
      head: ACCEPT_URL, workspace: WS, member: bee, accepts: GRANT_URL,
      stream: 'https://bee.test/s',
      attestation: { authorshipVerified: true, signedBy: BEE_KEY, boundToDescriptor: true, contentBinding: 'bound' },
    };
    const { grant } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [handBuilt],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested.find(u => u.kind === 'acceptance')?.because).toMatch(/typed by whoever called this fold/);
    // …and the SAME inputs under the previously-strongest policy still admit her, which is
    // what makes this a closed gap rather than a restated one.
    const before = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [handBuilt],
      attestation: { convener: CONV, signerOf, requireContentBinding: true },
    });
    expect(before.members).toHaveLength(1);
    expect(before.recordFieldBinding).toBe('unbound');
  });

  it('★ requireFieldBinding FORCES content binding on — the combination is not reachable', async () => {
    // Fields parsed out of bytes nobody re-digested are fields somebody may have edited
    // after signing, and the parse would report the edit faithfully. Enforced in code rather
    // than in a docstring, because a caller who could set one without the other would.
    const { grant, acceptance } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const unboundBytes = (r: Grant | Acceptance): typeof r => ({
      ...r, attestation: { ...r.attestation!, contentBinding: 'unbound' as const },
    });
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [unboundBytes(grant) as Grant], acceptances: [unboundBytes(acceptance) as Acceptance],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true, requireContentBinding: false },
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/requires the proof to cover the record's CONTENT/);
    expect(r.recordContentBinding).toBe('bound');   // reported as ENFORCED, because it was
  });

  it('★ a record whose fields came from another document is refused end to end', async () => {
    const { grant, acceptance } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const relabelled: Acceptance = { ...acceptance, head: 'https://bee.test/c/a2.ttl' };
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [relabelled],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/came from different documents/);
  });

  it('reports field binding as ENFORCED, never as merely observed', async () => {
    // The same rule `recordContentBinding` follows: rows that happen to arrive with a
    // provenance under a policy that never demanded one were not checked by this fold, and
    // reporting 'bound' off the back of them is data standing in for a guarantee.
    const { grant, acceptance } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const args = { workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [acceptance] };
    expect(foldRoster(args).recordFieldBinding).toBe('unbound');
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf } }).recordFieldBinding).toBe('unbound');
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf, requireContentBinding: true } }).recordFieldBinding).toBe('unbound');
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf, requireFieldBinding: true } }).recordFieldBinding).toBe('bound');
  });

  it('★ a convener-written acceptance is refused even when its fields ARE parsed', async () => {
    // Field binding and signer binding refuse different things, and this is the case that
    // shows the pair is needed: the convener publishes a perfectly well-formed
    // wsp:MembershipAcceptance naming bee, on their own pod. Every field is read from the
    // record. It is still not bee's.
    const deps = descriptorDeps({
      [GRANT_URL]: { content: GRANT_TTL, signedBy: CONV_KEY },
      // the forgery: same bytes, signed by the CONVENER's key
      [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: CONV_KEY },
    });
    const g = (await readGrantRecord(GRANT_URL, deps)).record!;
    const a = (await readAcceptanceRecord(ACCEPT_URL, deps)).record!;
    expect(a.fieldProvenance).toBeDefined();   // the fields really were parsed
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [g], acceptances: [a],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested.find(u => u.kind === 'acceptance')?.because).toMatch(/acts for/);
  });

  it('the attribution note states what was established and names the residual', async () => {
    const { grant, acceptance } = await readBoth(GRANT_TTL, ACCEPT_TTL);
    const note = foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: [grant], acceptances: [acceptance],
      attestation: { convener: CONV, signerOf, requireFieldBinding: true },
    }).attributionNote;
    expect(note).toMatch(/PARSED FROM THE\s+RECORD/);
    // ★ AND IT MUST NOT CLAIM THE HALF THAT IS STILL OPEN. Nothing checked that the convener
    // named in the policy is the workspace's convener.
    expect(note).toMatch(/is the workspace's convener/);
    expect(note).toMatch(new RegExp(CONV.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(note).not.toMatch(/CALLER TYPED IT/);
  });
});

// ── publishing ───────────────────────────────────────────────────────────────

describe('publishMembershipRecord', () => {
  const publishDeps = (over: Partial<StreamDeps> & { readableAfter?: number } = {}): StreamDeps & { calls: Record<string, unknown>[] } => {
    const calls: Record<string, unknown>[] = [];
    let reads = 0;
    let clock = 0;
    return {
      calls,
      publish: vi.fn(async (a: Record<string, unknown>) => { calls.push(a); return { descriptorUrl: GRANT_URL, status: 'pending', authorship: { signed: true } }; }),
      discover: vi.fn(async () => ({ entries: [] })),
      getDescriptor: vi.fn(async () => (reads++ >= (over.readableAfter ?? 0) ? { url: GRANT_URL, turtle: '<> a <urn:x> .' } : { error: 'not yet' })),
      sleep: vi.fn(async (ms: number) => { clock += ms; }),
      now: () => clock,
      ...over,
    } as StreamDeps & { calls: Record<string, unknown>[] };
  };

  it('sends the shape gate, the signature and public visibility', async () => {
    const deps = publishDeps();
    const out = await publishMembershipRecord({ graphIri: 'https://conv.test/g/1', graphContent: GRANT_TTL }, deps);
    expect(out.outcome).toBe('published');
    expect(deps.calls[0]).toMatchObject({
      visibility: 'public',
      auto_supersede_prior: false,
      sign_authorship: true,
      conforms_to_shapes: ['https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-shapes.ttl'],
    });
  });

  it('★ WAITS for the record to become readable before calling it published', async () => {
    // `publish_context` is DEFERRED unless compliance/sync/if_match is set — sign_authorship
    // does NOT force the synchronous path. Three live assertions in verify-can-live.ts once
    // passed because every read fired against a record that had not landed yet, so the fold
    // refused the genuine and the forged acceptance alike and "the forgery is refused"
    // certified nothing.
    const deps = publishDeps({ readableAfter: 3 });
    const out = await publishMembershipRecord({ graphIri: 'https://conv.test/g/1', graphContent: GRANT_TTL }, deps);
    expect(out.outcome).toBe('published');
    expect(out.outcome === 'published' && out.visibleAfterMs).toBeGreaterThan(0);
    expect(deps.getDescriptor).toHaveBeenCalledTimes(4);
  });

  it('reports never-readable as PENDING, and tells the caller not to publish again', async () => {
    const deps = publishDeps({ readableAfter: Number.MAX_SAFE_INTEGER });
    const out = await publishMembershipRecord({ graphIri: 'https://conv.test/g/1', graphContent: GRANT_TTL, budgetMs: 2000 }, deps);
    expect(out.outcome).toBe('pending');
    // A duplicate is a second head on an authorization chain, which the fold answers with
    // the intersection rather than a winner.
    expect(out.outcome === 'pending' && out.message).toMatch(/second head on an authorization chain/);
  });

  it('★ an unsigned publish is reported, not swallowed', async () => {
    // The relay catches a signing failure, warns, and publishes anyway. A membership record
    // written unsigned can never acquire a proof — the bytes are immutable and the key has
    // moved on — so no attestation policy will ever admit it, forever.
    // ★ `publish` is READONLY on StreamDeps, so the override goes in through the factory
    // rather than by assignment. `tsc` says so; the untypechecked vitest run did not, which
    // is the gap `tsconfig.check.json` exists to close.
    const deps = publishDeps({
      publish: vi.fn(async () => ({ descriptorUrl: GRANT_URL, authorship: { signed: false, reason: 'key down' } })),
    });
    const out = await publishMembershipRecord({ graphIri: 'https://conv.test/g/1', graphContent: GRANT_TTL }, deps);
    expect(out.outcome === 'published' && out.signed).toBe(false);
    expect(out.outcome === 'published' && out.note).toMatch(/unattributable FOREVER/);
  });

  it('a publish with no descriptorUrl is a refusal, not a success with an empty name', async () => {
    const deps = publishDeps({ publish: vi.fn(async () => ({ status: 'ok' })) });
    const out = await publishMembershipRecord({ graphIri: 'https://conv.test/g/1', graphContent: GRANT_TTL }, deps);
    expect(out.outcome).toBe('refused');
    expect(out.outcome === 'refused' && out.message).toMatch(/no descriptorUrl/);
  });

  it('the visibility budget is a real number of milliseconds', () => {
    expect(MEMBERSHIP_VISIBILITY_BUDGET_MS).toBeGreaterThanOrEqual(20_000);
  });
});
