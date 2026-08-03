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
// The published shape is read from disk rather than restated, so the reader's copy of its
// constraints can be compared with the file we actually deploy. See the last describe block.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  grantTurtle, acceptanceTurtle, readGrantRecord, readAcceptanceRecord,
  workspaceTurtle, readWorkspaceRecord, convenerEvidenceOf,
  publishMembershipRecord, WSP_TERMS, WSP_PUBLISHED_IRI_PATTERNS,
  MEMBERSHIP_VISIBILITY_BUDGET_MS,
  dereferenceWorkspaceRecord, nsOwnerSegmentOf, dereferenceRoleProfile,
} from '../applications/shared-workspace/src/membership.js';
import {
  foldRoster, refuseFieldBinding, type Grant, type Acceptance, type Attestation,
  type FieldProvenance,
} from '../applications/shared-workspace/src/roster.js';
import { entryTurtle, WSP, type StreamDeps } from '../applications/shared-workspace/src/stream.js';
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

/**
 * ★★ THE HAND-BUILT `FieldProvenance` THIS FILE EXISTS TO PROVE IS WORTHLESS — and which no
 * longer typechecks without this cast.
 *
 * `FieldProvenance` intersects a private-membered ambient class that `roster.ts` does not
 * export, so the literal `{source: 'payload', descriptor}` is a compile error outside
 * `membership.ts`. That closes the residue this file's header describes: a caller can no longer
 * put the claim beside invented fields by writing it. The suite still has to be able to,
 * because `refuseFieldBinding`'s whole job is to answer questions about rows a producer would
 * never make, and a rung that can only be fed honest input tests nothing.
 *
 * ★ SO THE ONE CAST LIVES HERE AND IS NAMED `forge`, for the reason
 * `tests/workspace-adversarial.test.ts` gives at greater length: a grep for the cast should
 * find the honest producer and the two suites that lie on purpose, and nothing else. Anything
 * that reads like the honest producer gets copied as one.
 *
 * `source` is a plain `string` so the JSON-boundary case (`'trust-me'`) does not need a second,
 * differently-spelled cast of its own.
 */
const forgeFieldProvenance = (source: string, descriptor: string): FieldProvenance =>
  ({ source, descriptor } as unknown as FieldProvenance);

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
// ★ THE ROLE THE `dereferenceRoleProfile` CASES GRANT, and it has to be the one the role tables
// down there actually declare. `verify-can-live.ts` §10 shipped a demonstration that measured
// `0 > 1` because its rogue document named a role its own grant never mentioned; the same
// mistake here would make the closing case pass on an empty roster.
const OBSERVER_GRANT_TTL = grantTurtle({
  grantIri: 'https://conv.test/g/obs', workspace: WS, grantedTo: bee, role: `${P}#Observer`,
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
      .replace(/\n {2}wsp:convener <[^>]+> ;/, '');
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

  it('an unreadable role profile is a PROBLEM, not a refusal — and the FOLD is what refuses on it', async () => {
    // The other direction of the same rule: the conferring field of a workspace record is its
    // convener, so refusing the whole record over a second field would withhold a convener the
    // record does state. Reported instead, and the record still answers the convener question.
    //
    // ★ THE SECOND HALF OF THIS CASE IS NEW, AND THE SENTENCE IT REPLACES WAS "nothing in the
    // fold reads it". Something does now: `refuseRoleProfileAuthority` compares the declared
    // profile against the one the fold was handed, so `''` has to be refused EXPLICITLY rather
    // than left to an equality test — a caller whose own `RoleProfile.profile` is also `''`
    // would otherwise compare equal to this record and be reported as bound off two blanks.
    const noProfile = workspaceTurtle({ workspaceIri: WS, convener: CONV, roleProfile: P, title: 'x' })
      .replace(/\n {2}wsp:roleProfile <[^>]+> ;/, '');
    const deps = descriptorDeps({ [WORKSPACE_URL]: { content: noProfile, signedBy: CONV_KEY } });
    const read = await readWorkspaceRecord(WORKSPACE_URL, deps);
    expect(read.record).not.toBeNull();
    expect(read.record!.convener).toBe(CONV);
    expect(read.record!.roleProfile).toBe('');
    expect(read.problems.join(' ')).toMatch(/roleProfile/);

    const blankBoth = foldRoster({
      workspace: WS, scopes, grants: [], acceptances: [],
      profile: { profile: '', roles: PROFILE.roles },
      attestation: { convener: CONV, signerOf, workspaceEvidence: convenerEvidenceOf(read) },
    });
    expect(blankBoth.roleProfileBinding).toBe('refused');
    // …and the convener the record DOES state is still checked and still bound, so the two
    // questions are not answered with one another's verdict.
    expect(blankBoth.convenerBinding).toBe('bound');
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
    // ★ ANNOTATED, BECAUSE `toEqual` TAKES `unknown` AND CHECKS NOTHING AT COMPILE TIME.
    // `Attestation` was imported when this file was written and then used nowhere, and this
    // is the one place in it where an Attestation is spelled out by hand rather than
    // contextually typed by a `foldRoster` argument. Inside the `toEqual` literal a field
    // renamed in roster.ts, or a `contentBinding: 'bounded'` typo, is a runtime diff whose
    // obvious repair is to edit the expectation until it matches — and the type is what makes
    // the wrong repair fail. `boundToDescriptor` is required, so dropping it fails here too.
    const attestation: Attestation = {
      authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true,
      // ★ ASSERTED, NOT MERELY TOLERATED. `boundToDescriptor: true` on its own covers both
      // "host, pod, container and name matched" and "one path segment matched and the host
      // was never looked at". The relay mints `urn:` descriptor ids, so every real record
      // lands on the weak basis — which is a fact about the substrate a reader must be able
      // to see, and used to be discarded at the boundary.
      descriptorBindingBasis: 'slug-only',
      contentBinding: 'bound',
    };
    expect(read.record).toEqual({
      head: GRANT_URL,
      workspace: WS,
      grantedTo: bee,
      role: `${P}#Contributor`,
      attestation,
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
      .replace(/\n {2}wsp:role <[^>]*> ;/, '');
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
        fieldProvenance: forgeFieldProvenance('payload', ACCEPT_URL),
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
    }).replace(/\n {2}wsp:stream <[^>]*> ;/, '');
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
  const prov = forgeFieldProvenance('payload', GRANT_URL);

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

// ── ★ the reader and the published contract must refuse the same values ──────
//
// ★ THE RECORDED DEFECT WAS ONE FIELD AND IT WAS SEVEN. The ledger said "`oneIri` applies no
// scheme pattern to `wsp:member`, and the published shape now does — so on this ONE field the
// shape refuses more than the reader". Reproduced against the readers rather than re-read: a
// grant naming `<urn:example:ws>`, `<urn:example:who>` and `<urn:example:role>` parsed with an
// EMPTY `problems` array, and so did a workspace record declaring `<urn:example:conv>` and
// `<urn:example:roles>`. `wsp-shapes.ttl` patterns seven of the eight terms `oneIri` reads.
//
// Not exploitable through our own publish path — the gate validates first — and the readers
// are pointed at pods we do not control, which is the whole reason a reader exists rather than
// a trust assumption. Two mechanisms hold the two in step now: the TYPE makes a term with no
// table entry a compile error, and the first case below compares the table with the published
// file byte for byte.
describe('★ oneIri applies the published shape\'s own sh:pattern', () => {
  const SHAPES_TTL = readFileSync(
    fileURLToPath(new URL('../docs/applications/shared-workspace/wsp-shapes.ttl', import.meta.url)),
    'utf8',
  );

  /** Every `sh:path wsp:NAME` property block in the published file, with its pattern or null. */
  const publishedPatterns = (): Map<string, (string | null)[]> => {
    const found = new Map<string, (string | null)[]>();
    for (const block of SHAPES_TTL.split('sh:property [').slice(1)) {
      const body = block.slice(0, block.indexOf(']'));
      const path = /sh:path\s+wsp:(\w+)/.exec(body);
      if (path === null) continue;
      const pattern = /sh:pattern\s+"([^"]*)"/.exec(body);
      const prior = found.get(`${WSP_TERMS.workspace.replace(/workspace$/, '')}${path[1]!}`) ?? [];
      prior.push(pattern === null ? null : pattern[1]!);
      found.set(`${WSP_TERMS.workspace.replace(/workspace$/, '')}${path[1]!}`, prior);
    }
    return found;
  };

  it('★★ the table in membership.ts IS what wsp-shapes.ttl publishes — checked, not asserted in prose', () => {
    // ★ THE DRIFT CHECK, AND IT IS THE POINT OF THE WHOLE TABLE. A hand-copied constraint is a
    // second source of truth that goes stale the first time the published file moves, which is
    // exactly how the gap this closes was created: `wsp:member` gained `sh:pattern` in the
    // deployed shape and nothing in the reader moved with it. This fails on the next such
    // change instead of a paragraph nobody re-greps.
    const published = publishedPatterns();
    // A sanity floor first: a regex that matched nothing would make every assertion below
    // vacuous, which is the failure mode this repo names most often.
    expect(published.size).toBeGreaterThanOrEqual(6);

    for (const [term, expected] of Object.entries(WSP_PUBLISHED_IRI_PATTERNS)) {
      const occurrences = published.get(term);
      expect(occurrences, `<${term}> is in the reader's table and in no sh:property of the published shape`).toBeDefined();
      for (const actual of occurrences!) {
        expect(
          actual,
          `<${term}>: the reader applies ${JSON.stringify(expected)} and wsp-shapes.ttl `
          + `publishes ${JSON.stringify(actual)}. One of the two moved without the other — `
          + 'which is the defect this table exists to make impossible',
        ).toBe(expected);
      }
    }
  });

  it('★ a urn: value is refused on every term the shape patterns — measured one field at a time', async () => {
    // Each of these parsed CLEAN before the table existed. `wsp:stream` is the control in the
    // other direction and lives in its own case below.
    const urnGrant = await readGrantRecord(GRANT_URL, descriptorDeps({
      [GRANT_URL]: {
        content: grantTurtle({
          grantIri: 'https://conv.test/g/1', workspace: WS, grantedTo: bee, role: `${P}#Contributor`,
        }).replace(`<${bee}>`, '<urn:example:who>'),
      },
    }));
    // `wsp:grantedTo` is identifying, so the whole record goes: a revocation naming nobody
    // revokes nothing. Same cost, and the same reading, as a grant naming TWO grantees.
    expect(urnGrant.record).toBeNull();
    expect(urnGrant.problems.join(' ')).toMatch(/urn:example:who.*sh:pattern/);

    const urnRole = await readGrantRecord(GRANT_URL, descriptorDeps({
      [GRANT_URL]: {
        content: grantTurtle({
          grantIri: 'https://conv.test/g/1', workspace: WS, grantedTo: bee, role: `${P}#Contributor`,
          revoked: true,
        }).replace(`<${P}#Contributor>`, '<urn:example:role>'),
      },
    }));
    // ★ AND THE TWO-TRACK RULE SURVIVES THE TIGHTENING, which is the half a refusal test alone
    // would miss. `wsp:role` is the grant's CONFERRING field, so a refused role empties it and
    // withholds the provenance — and the record still reaches the fold carrying its REVOCATION.
    expect(urnRole.record).not.toBeNull();
    expect(urnRole.record!.role).toBe('');
    expect(urnRole.record!.revoked).toBe(true);
    expect(urnRole.record!.fieldProvenance).toBeUndefined();

    const urnMember = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: {
        content: acceptanceTurtle({
          acceptanceIri: 'https://bee.test/a/1', workspace: WS, member: bee,
          accepts: GRANT_URL, stream: 'https://bee.test/s',
        }).replace(`wsp:member <${bee}>`, 'wsp:member <urn:example:nobody>'),
      },
    }));
    expect(urnMember.record).toBeNull();
    expect(urnMember.problems.join(' ')).toMatch(/urn:example:nobody/);

    const urnConvener = await readWorkspaceRecord(WORKSPACE_URL, descriptorDeps({
      [WORKSPACE_URL]: {
        content: WORKSPACE_TTL.replace(`wsp:convener <${CONV}>`, 'wsp:convener <urn:example:conv>'),
      },
    }));
    expect(urnConvener.record).toBeNull();
    expect(urnConvener.problems.join(' ')).toMatch(/urn:example:conv/);

    // ★ AND THE ROLE PROFILE, which is the term residual gap 8's check compares. A `urn:`
    // profile admitted here would be a governance document nobody outside this pod can fetch,
    // offered as the thing `roleProfileBinding` reports as bound.
    const urnProfile = await readWorkspaceRecord(WORKSPACE_URL, descriptorDeps({
      [WORKSPACE_URL]: {
        content: WORKSPACE_TTL.replace(`wsp:roleProfile <${P}>`, 'wsp:roleProfile <urn:example:roles>'),
      },
    }));
    // Non-identifying, like `wsp:role`: the record survives with the field emptied, the problem
    // named, and `refuseRoleProfileAuthority` refusing to confer on a profile it cannot read.
    expect(urnProfile.record).not.toBeNull();
    expect(urnProfile.record!.roleProfile).toBe('');
    expect(urnProfile.problems.join(' ')).toMatch(/urn:example:roles/);
  });

  it('★ and the reader does NOT refuse more than the contract — the other direction of the same defect', async () => {
    // ★ MUTATED BOTH WAYS, because a guard that only ever refuses is an outage rather than a
    // guard. A single reader-wide `^https?://|^did:` would have looked strict and been wrong
    // twice over: `wsp:stream` carries NO pattern in the published shape, and `wsp:member`
    // carries one that ADMITS `did:`. Both are asserted here so that tightening the table
    // further cannot be done by reflex.
    const didMember = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: {
        content: acceptanceTurtle({
          acceptanceIri: 'https://bee.test/a/1', workspace: WS, member: 'did:ethr:0xabc',
          accepts: GRANT_URL, stream: 'https://bee.test/s',
        }),
      },
    }));
    expect(didMember.record).not.toBeNull();
    expect(didMember.record!.member).toBe('did:ethr:0xabc');
    expect(didMember.problems).toEqual([]);

    // `wsp:stream` is unconstrained by the shape, so the reader constrains nothing either.
    const oddStream = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({
      [ACCEPT_URL]: {
        content: acceptanceTurtle({
          acceptanceIri: 'https://bee.test/a/1', workspace: WS, member: bee,
          accepts: GRANT_URL, stream: 'urn:example:stream',
        }),
      },
    }));
    expect(oddStream.record).not.toBeNull();
    expect(oddStream.record!.stream).toBe('urn:example:stream');
    expect(oddStream.problems).toEqual([]);
    // …and it still confers, which is what "no pattern" has to mean if it means anything.
    expect(oddStream.record!.fieldProvenance).toBeDefined();

    // The ordinary record, unchanged. Without this the three cases above are satisfied by a
    // reader that refuses everything with a scheme.
    const honest = await readAcceptanceRecord(ACCEPT_URL, descriptorDeps({ [ACCEPT_URL]: { content: ACCEPT_TTL } }));
    expect(honest.record).not.toBeNull();
    expect(honest.problems).toEqual([]);
  });
});

// ── the producer: dereferencing a workspace to FIND its record ───────────────
//
// ★★ THESE CASES EXIST BECAUSE THREE MUTANTS SURVIVED WITHOUT THEM, and the survivors were
// found the way this file's other survivors were: by breaking the thing and watching nothing
// go red. `dereferenceWorkspaceRecord` was written, wired into `verify-can-live.ts` §11 and run
// green against production — and the entire double suite still passed with the owner segment
// deleted from its `get_current_head` call, with its forked-chain refusal removed, and with its
// `/ns/<owner>/<slug>` matcher replaced by a regex accepting any string at all. A live run
// exercises the honest path; nothing exercised the four refusals, or the one ARGUMENT that
// makes the honest path honest.
describe('dereferenceWorkspaceRecord — asking the workspace instead of the caller', () => {
  // A workspace IRI of the shape the relay actually serves. The rest of this file uses
  // `https://relay.test/ws/alpha`, which carries no owner segment and is therefore the
  // fail-closed case below rather than the honest one.
  const NS_WS = 'https://relay.test/ns/u-eth-alice/wsp-alpha';
  const ALICE_DESC = 'https://alice.test/c/ws.ttl';
  const BEE_DESC = 'https://bee.test/c/ws.ttl';
  const NS_WORKSPACE_TTL = workspaceTurtle({
    workspaceIri: NS_WS, convener: CONV, roleProfile: P, title: 'alpha',
  });
  const BEE_WORKSPACE_TTL = workspaceTurtle({
    workspaceIri: NS_WS, convener: bee, roleProfile: P, title: 'bee claims alpha',
  });

  /**
   * A substrate where BOTH principals have published a `wsp:Workspace` at the SAME graph IRI,
   * each on their own pod — which is the live situation residual gap 9 was measured in.
   *
   * ★ THE DOUBLE KEYS ON `pod_name`, AND THAT IS THE WHOLE POINT OF IT. A double that ignored
   * the pod and returned "the" head would let the producer drop the owner segment and still
   * pass, which is exactly the mutant that survived. Here the two pods answer differently, so
   * asking the wrong one — or asking none — cannot return alice's record.
   */
  const twoPods = (over: { forked?: boolean; error?: string; noHead?: boolean } = {}) => {
    const calls: Record<string, unknown>[] = [];
    const heads: Record<string, string> = { 'u-eth-alice': ALICE_DESC, 'u-eth-bee': BEE_DESC };
    const deps = {
      ...descriptorDeps({
        [ALICE_DESC]: { content: NS_WORKSPACE_TTL, signedBy: CONV_KEY },
        [BEE_DESC]: { content: BEE_WORKSPACE_TTL, signedBy: BEE_KEY },
      }),
      currentHead: vi.fn(async (args: Record<string, unknown>) => {
        calls.push(args);
        if (over.error !== undefined) return { error: over.error, message: over.error };
        if (over.forked === true) {
          return { urn: args.urn, forked: true, heads: [{ descriptorUrl: ALICE_DESC }, { descriptorUrl: BEE_DESC }] };
        }
        if (over.noHead === true) return { urn: args.urn, forked: false };
        // An unknown pod holds nothing at this IRI — which is what the substrate answers, and
        // what a producer that forgot to name the pod would be asking for.
        const url = heads[String(args.pod_name ?? '')];
        return url === undefined
          ? { urn: args.urn, forked: false }
          : { urn: args.urn, forked: false, head: { descriptorUrl: url } };
      }),
    } as unknown as StreamDeps;
    return { deps, calls };
  };

  it('★ resolves the workspace through the pod its own /ns owner segment names', async () => {
    const { deps, calls } = twoPods();
    const evidence = await dereferenceWorkspaceRecord(NS_WS, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    // ALICE's record, and both principals have published at this IRI in this substrate.
    expect(evidence.record.convener).toBe(CONV);
    expect(evidence.record.head).toBe(ALICE_DESC);
    // ★ AND THE ARGUMENT IS ASSERTED, NOT ONLY THE OUTCOME. `pod_name` IS the security property
    // here: the /ns owner segment selects a pod, and asking any other pod — or asking without
    // naming one — is asking a party with no authority over this IRI. Dropping it from the call
    // was a surviving mutant.
    expect(calls).toEqual([{ urn: NS_WS, pod_name: 'u-eth-alice' }]);
    // The provenance names this dereference and this document, not anything a caller chose.
    expect(evidence.provenance).toEqual({ dereferenced: NS_WS, resolvedTo: ALICE_DESC });
  });

  it('★ the rival record at the same IRI is never what the dereference returns', async () => {
    // The control that makes the case above a measurement: bee's record is readable, parses
    // clean, and is signed by her own registered agent — it is simply on the wrong pod.
    const { deps } = twoPods();
    const bees = await readWorkspaceRecord(BEE_DESC, deps);
    expect(bees.record).not.toBeNull();
    expect(bees.problems).toEqual([]);
    expect(bees.record!.convener).toBe(bee);
    expect(bees.record!.workspace).toBe(NS_WS);
    const evidence = await dereferenceWorkspaceRecord(NS_WS, deps);
    expect(evidence.kind === 'declared' && evidence.record.head).not.toBe(BEE_DESC);
  });

  it('★ an IRI with no owner segment fails CLOSED rather than guessing a pod', async () => {
    // Guessing an authority for an IRI that names none would be choosing whose record to
    // believe, which is the whole of what this function exists not to do. `'unreadable'`
    // refuses to confer, so the failure direction is the safe one.
    const { deps, calls } = twoPods();
    for (const bad of [WS, 'https://relay.test/ns/only-one-segment', 'urn:example:ws', '']) {
      const evidence = await dereferenceWorkspaceRecord(bad, deps);
      expect(evidence.kind, `<${bad}> was accepted as an /ns IRI`).toBe('unreadable');
      if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/is not a <relay>\/ns\/<owner>\/<slug> IRI/);
    }
    // …and nothing was asked of the substrate, because there was no pod to ask.
    expect(calls).toEqual([]);
  });

  it('★ a FORKED workspace chain refuses rather than picking a head', async () => {
    // Two unresolved heads mean the workspace states two conveners. Picking either would make
    // who-may-grant depend on which descriptor the supersedes walk reached first — the same
    // rule the fold applies to a forked grant chain, one record earlier.
    const { deps } = twoPods({ forked: true });
    const evidence = await dereferenceWorkspaceRecord(NS_WS, deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') {
      expect(evidence.why).toMatch(/2 unresolved chain heads/);
      expect(evidence.why).toMatch(/Republish a single clean head/);
    }
  });

  it('a substrate error, an empty chain and a non-workspace document all refuse', async () => {
    const failed = await dereferenceWorkspaceRecord(NS_WS, twoPods({ error: 'pod unreachable' }).deps);
    expect(failed.kind).toBe('unreadable');
    if (failed.kind === 'unreadable') expect(failed.why).toMatch(/failed: pod unreachable/);

    const empty = await dereferenceWorkspaceRecord(NS_WS, twoPods({ noHead: true }).deps);
    expect(empty.kind).toBe('unreadable');
    if (empty.kind === 'unreadable') expect(empty.why).toMatch(/nothing is published at/);

    // The head resolves and the document at it is a grant rather than a workspace.
    const notAWorkspace = {
      ...descriptorDeps({ [ALICE_DESC]: { content: GRANT_TTL } }),
      currentHead: vi.fn(async () => ({ forked: false, head: { descriptorUrl: ALICE_DESC } })),
    } as unknown as StreamDeps;
    const wrongType = await dereferenceWorkspaceRecord(NS_WS, notAWorkspace);
    expect(wrongType.kind).toBe('unreadable');
    if (wrongType.kind === 'unreadable') expect(wrongType.why).toMatch(/declares no <.*wsp#Workspace>/);
  });

  it('★ a missing currentHead dependency refuses loudly instead of falling back', async () => {
    // The same posture `getDescriptor` takes. Returning the record at a caller-chosen URL when
    // the dereference dependency is absent would report a check that did not happen — which is
    // residual gap 9 wearing the closed gap's report.
    const noDep = descriptorDeps({ [ALICE_DESC]: { content: NS_WORKSPACE_TTL, signedBy: CONV_KEY } });
    const evidence = await dereferenceWorkspaceRecord(NS_WS, noDep);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/no `currentHead` dependency/);
  });

  it('★ a currentHead that THROWS is a refusal, not an exception out of the authorization path', async () => {
    const throws = {
      ...descriptorDeps({}),
      currentHead: vi.fn(async () => { throw new Error('socket hang up'); }),
    } as unknown as StreamDeps;
    const evidence = await dereferenceWorkspaceRecord(NS_WS, throws);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/threw: socket hang up/);
  });

  it('nsOwnerSegmentOf reads exactly the segment the deployed route reads, and nothing else', () => {
    // A verbatim copy of a deployed derivation is only worth something if it stays verbatim.
    // `resolveNsGraph` matches `/ns/<owner>/<slug>` and percent-decodes the owner; replacing
    // the matcher with one that accepts anything was a surviving mutant.
    expect(nsOwnerSegmentOf('https://relay.test/ns/u-eth-alice/wsp-alpha')).toBe('u-eth-alice');
    expect(nsOwnerSegmentOf('http://relay.test/ns/a/b')).toBe('a');
    expect(nsOwnerSegmentOf('https://relay.test/ns/u%2Deth/x')).toBe('u-eth');
    // …and every shape that is NOT that route.
    for (const bad of [
      'https://relay.test/ns/a/b/c',   // three segments — /ns/pgsl/:kind/:hash is a different route
      'https://relay.test/ns/a',       // one
      'https://relay.test/nss/a/b',    // not /ns
      'https://relay.test/a/b',        // no /ns at all
      'urn:example:ws',
      'ftp://relay.test/ns/a/b',
    ]) expect(nsOwnerSegmentOf(bad), bad).toBeNull();
  });
});

// ── the producer: dereferencing a PROFILE IRI to find its role table ─────────
//
// ★★ THE DOUBLE'S TWO SOURCES ANSWER DIFFERENTLY, AND THAT IS THE WHOLE DESIGN OF IT. The last
// round's lesson, recorded one describe block up: `dereferenceWorkspaceRecord` was written, run
// green against production and reviewed, and three mutants still survived because the
// `get_current_head` double returned "the" head for any input — so dropping the owner segment
// changed nothing observable. A live run exercises the honest path and nothing else.
//
// So `roleProfileDeps` below serves a DIFFERENT TABLE at every URL it knows and 404s at every
// URL it does not, and its `currentHead` serves a different descriptor per pod. Fetching the
// wrong URL, following a redirect, or asking the wrong pod each produces a table this file can
// distinguish from the right one — which is what makes the refusals测 testable rather than
// merely present.
describe('dereferenceRoleProfile — reading the document the profile IRI names', () => {
  const NS_PROFILE = 'https://relay.test/ns/u-eth-alice/wsp-roles-x';
  const PROFILE_DESC = 'https://alice.test/c/roles.ttl';
  const RIVAL_DESC = 'https://bee.test/c/roles.ttl';

  /** A role profile document, in the shape the DEPLOYED artifact is actually written in. */
  const profileTtl = (subject: string, rows: readonly [string, readonly string[]][]): string =>
    `@prefix wsp: <${WSP}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\n`
    + `<${subject}> a wsp:RoleProfile ; rdfs:label "roles" .\n\n`
    + rows.map(([role, permits]) =>
      `<${role}> a wsp:Role ;\n  wsp:permits ${permits.map(c => `<${c}>`).join(', ')} .\n`).join('\n');

  const NARROW = profileTtl(P, [[`${P}#Observer`, [CAPS.read]]]);
  const WIDE = profileTtl(P, [[`${P}#Observer`, [CAPS.read, CAPS.grant, CAPS.revoke]]]);

  /**
   * The human-readable projection GitHub Pages serves at an extensionless IRI, written the way
   * `docs/applications/shared-workspace/wsp-roles-default.html` writes it.
   *
   * ★ A RELATIVE HREF, BECAUSE THAT IS WHAT THE DEPLOYED PAGE CARRIES. An absolute one here
   * would let a follower that never resolved against the page URL pass every case below, and
   * that follower fetches nothing at all in production. `tests/alternate-turtle.test.ts` pins
   * the resolution itself against the real file on disk.
   */
  const pageAdvertising = (href: string): string =>
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
    + `<link rel="alternate" type="text/turtle" href="${href}" />\n`
    + '</head>\n<body><h1>Default workspace role profile</h1></body>\n</html>\n';

  /**
   * A web where every URL answers with something DIFFERENT, and unknown URLs 404.
   *
   * `redirects` maps a requested URL onto the URL the response actually came from — the only
   * way to express "the fetch landed somewhere else", which is the single guard a double that
   * echoed the request back could not test at all.
   */
  const roleProfileDeps = (
    web: Record<string, { status?: number; body?: string; contentType?: string; landedAt?: string }>,
    over: {
      throws?: boolean; heads?: Record<string, string>; forked?: boolean;
      /** Triples put in the DEFAULT graph of the pod record — outside the digested block. */
      outsideBlock?: string;
      /** Also serve the payload at the TOP LEVEL of the response, beside `graph`. */
      topLevelContent?: boolean;
      /** Serve this instead of NARROW inside the digested block. */
      podBody?: string;
    } = {},
  ) => {
    const asked: string[] = [];
    const headCalls: Record<string, unknown>[] = [];
    const deps = {
      ...descriptorDeps({
        [PROFILE_DESC]: {
          content: over.podBody ?? NARROW, signedBy: CONV_KEY,
          ...(over.outsideBlock === undefined ? {} : { outsideBlock: over.outsideBlock }),
          ...(over.topLevelContent === true ? { topLevelContent: true } : {}),
        },
        [RIVAL_DESC]: { content: WIDE, signedBy: BEE_KEY },
      }),
      fetchDocument: vi.fn(async (url: string) => {
        asked.push(url);
        if (over.throws === true) throw new Error('socket hang up');
        const r = web[url];
        if (r === undefined) {
          return { status: 404, url, contentType: 'text/html', body: '<!doctype html><h1>404</h1>' };
        }
        return {
          status: r.status ?? 200,
          url: r.landedAt ?? url,
          contentType: r.contentType ?? 'text/turtle',
          body: r.body ?? '',
        };
      }),
      currentHead: vi.fn(async (args: Record<string, unknown>) => {
        headCalls.push(args);
        if (over.forked === true) {
          return { forked: true, heads: [{ descriptorUrl: PROFILE_DESC }, { descriptorUrl: RIVAL_DESC }] };
        }
        const url = (over.heads ?? { 'u-eth-alice': PROFILE_DESC, 'u-eth-bee': RIVAL_DESC })[String(args.pod_name ?? '')];
        return url === undefined ? { forked: false } : { forked: false, head: { descriptorUrl: url } };
      }),
    } as unknown as StreamDeps;
    return { deps, asked, headCalls };
  };

  it('★ reads the table out of the document at the IRI, and records the IRI it asked for', async () => {
    const { deps, asked } = roleProfileDeps({ [P]: { body: NARROW } });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    expect(evidence.document.dereferenced).toBe(P);
    expect(evidence.document.roles).toEqual([{ role: `${P}#Observer`, permits: [CAPS.read] }]);
    // ★ NEVER `'signed-record'` ON THIS PATH. A plain GET returns no proof, and the label is
    // what decides whether `refuseRoleTableAuthority` runs its signature branch at all.
    expect(evidence.document.authority).toBe('transport-only');
    expect(evidence.document.attestation).toBeUndefined();
    // The ARGUMENT, not only the outcome: it asked for exactly the declared IRI. A producer
    // that helpfully appended `.ttl` would pass every assertion above against a document the
    // workspace never named.
    expect(asked).toEqual([P]);
  });

  it('★★ the roles are collected from the WHOLE document, the way the deployed profile is written', async () => {
    // ★ MEASURED AGAINST THE REAL FILE, NOT AGAINST A CONVENIENT ONE.
    // `docs/applications/shared-workspace/wsp-roles-default.ttl` declares its five `wsp:Role`s
    // as TOP-LEVEL subjects with NO predicate linking them back to the `wsp:RoleProfile`. A
    // reader that walked outwards from the profile subject would read the published profile as
    // declaring no roles at all, refuse every honest fold, and look exactly like a working
    // check until somebody opened the file.
    const published = readFileSync(
      fileURLToPath(new URL('../docs/applications/shared-workspace/wsp-roles-default.ttl', import.meta.url)),
      'utf8',
    );
    const { deps } = roleProfileDeps({ [P]: { body: published } });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    const table = Object.fromEntries(evidence.document.roles.map(r => [r.role, [...r.permits].sort()]));
    expect(Object.keys(table).sort()).toEqual([
      `${P}#Contributor`, `${P}#Convener`, `${P}#Delegate`, `${P}#Observer`, `${P}#Steward`,
    ]);
    expect(table[`${P}#Observer`]).toEqual([CAPS.read]);
    expect(table[`${P}#Convener`]).toEqual(
      [CAPS.admit, CAPS.append, CAPS.assign, CAPS.grant, CAPS.read, CAPS.revoke].sort(),
    );
    // …and the `wsp:Capability` subjects beside them are NOT roles. A reader that collected
    // every subject would hand the fold six phantom roles permitting nothing.
    expect(evidence.document.roles).toHaveLength(5);
  });

  it('★★ a profile IRI that does not dereference at all is a refusal rather than a pass', async () => {
    // ★ THIS USED TO BE A STATEMENT ABOUT THE DEPLOYED ARTIFACT, AND IT IS NOT ONE ANY MORE.
    // What stood here said `GET <https://…/wsp-roles-default>` answers 404 while only
    // `<…/wsp-roles-default.ttl>` answers 200 — measured, true when written, and made false by
    // `docs/applications/shared-workspace/wsp-roles-default.html`. The BEHAVIOUR it pins is
    // unchanged and still worth pinning: an IRI that returns nothing states no governance, and a
    // producer that fell back to `<IRI>.ttl` would be guessing a URL on the workspace's behalf,
    // which is what `nsOwnerSegmentOf` refuses to do one document over. The case is simply
    // hypothetical now instead of live. The deployed shape is the test below.
    const { deps, asked } = roleProfileDeps({ [`${P}.ttl`]: { body: NARROW } });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/answered 404/);
    // …and it did not go looking. The `.ttl` twin is RIGHT THERE in this double's web and was
    // never asked for, which is the assertion that would fail if a fallback were added.
    expect(asked).toEqual([P]);
  });

  it('★★ the DEPLOYED shape — 200 text/html advertising its Turtle — is FOLLOWED, and the roles parsed', async () => {
    // ★★ THE REGRESSION THIS CLOSES, MEASURED. The day the `.html` page shipped so the
    // vocabulary's extensionless IRIs would dereference, this reader started answering
    // `unreadable: … answered 200 with text/html … unknown bareword "Default"` for the only role
    // profile in existence. GitHub Pages serves no extensionless path and falls back to
    // `<name>.html`, so the declared IRI returns the human-readable projection — with
    // `<link rel="alternate" type="text/turtle">` pointing at the Turtle beside it, which is the
    // mechanism the relay's shape gate has followed since the identical problem bit the publish
    // path three times.
    const { deps, asked } = roleProfileDeps({
      [P]: { body: pageAdvertising('wsp-roles-default.ttl'), contentType: 'text/html' },
      [`${P}.ttl`]: { body: NARROW },
    });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    expect(evidence.document.roles).toEqual([{ role: `${P}#Observer`, permits: [CAPS.read] }]);
    // TWO fetches, the second the URL the page named. `dereferenced` is still the IRI the
    // workspace declares; `head` is where the bytes came from, and the two differing is the hop.
    expect(asked).toEqual([P, `${P}.ttl`]);
    expect(evidence.document.dereferenced).toBe(P);
    expect(evidence.document.head).toBe(`${P}.ttl`);
    // ★ AND THE GRADE DOES NOT MOVE. Following an advertised link is transport and nothing more:
    // a static page carries no authorship proof and no digested region at either end of it. A
    // reader that graded a followed document above an unfollowed one would be reporting a
    // guarantee nobody made.
    expect(evidence.document.authority).toBe('transport-only');
    expect(evidence.document.attestation).toBeUndefined();
  });

  it('★★ it follows the href the PAGE names, which is what makes it a follower and not a guesser', async () => {
    // ★ THE CASE THE LIVE RUN CANNOT MAKE. Our own page advertises `wsp-roles-default.ttl`,
    // which is also what appending `.ttl` derives, so production cannot tell following from
    // guessing. Here the advertised name is DIFFERENT and the guessable URL answers with a WIDER
    // table, so a guesser does not fail — it silently confers `grant` and `revoke` on the
    // strength of a document the workspace never named.
    const { deps, asked } = roleProfileDeps({
      [P]: { body: pageAdvertising('governance-v2.ttl'), contentType: 'text/html' },
      [`${P}.ttl`]: { body: WIDE },
      'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/governance-v2.ttl':
        { body: NARROW },
    });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    expect(evidence.document.roles).toEqual([{ role: `${P}#Observer`, permits: [CAPS.read] }]);
    expect(asked[1]).toBe(
      'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/governance-v2.ttl',
    );
    expect(asked).toHaveLength(2);
  });

  it('★★ a page that advertises NO Turtle is refused, and the `.ttl` twin is still not guessed', async () => {
    // The guard that keeps the hop from becoming the fallback it was introduced instead of. An
    // HTML body with no alternate is the shape a misconfigured host and a soft-404 both produce,
    // and the `.ttl` sitting beside it in this double's web is never asked for.
    const { deps, asked } = roleProfileDeps({
      [P]: { body: '<!doctype html><html><body><h1>Not found</h1></body></html>', contentType: 'text/html' },
      [`${P}.ttl`]: { body: NARROW },
    });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/advertises no <link rel="alternate"/);
    expect(asked).toEqual([P]);
  });

  it('★★ a CROSS-ORIGIN alternate is refused, and a chain of pages is not chased', async () => {
    // A role profile carries no signature, so its origin IS its authority — and an alternate
    // link is the DOCUMENT choosing where the answer comes from, which is a claim written by
    // whoever can write the page. Refused on the same grounds as the cross-origin redirect one
    // test up, and separately from it, because they are different parties choosing.
    const foreign = roleProfileDeps({
      [P]: { body: pageAdvertising('https://evil.test/roles.ttl'), contentType: 'text/html' },
      'https://evil.test/roles.ttl': { body: WIDE },
    });
    const refused = await dereferenceRoleProfile(P, foreign.deps);
    expect(refused.kind).toBe('unreadable');
    if (refused.kind === 'unreadable') expect(refused.why).toMatch(/different origin/);
    expect(foreign.asked).toEqual([P]);

    // …and a page whose alternate is ANOTHER page stops after one hop rather than being chased
    // for as long as its publisher keeps the chain going. Asserted on the fetch COUNT, because
    // the refusal alone is satisfied by any bound at all.
    const chain = roleProfileDeps({
      [P]: { body: pageAdvertising('wsp-roles-default.ttl'), contentType: 'text/html' },
      [`${P}.ttl`]: { body: pageAdvertising('wsp-roles-default.ttl'), contentType: 'text/html' },
    });
    const chained = await dereferenceRoleProfile(P, chain.deps);
    expect(chained.kind).toBe('unreadable');
    if (chained.kind === 'unreadable') expect(chained.why).toMatch(/bounded at 1 hop/);
    expect(chain.asked).toEqual([P, `${P}.ttl`]);
  });

  it('★ a redirect OFF THE ORIGIN refuses; one that stays on it is followed', async () => {
    // A role profile carries no signature, so its ORIGIN is the whole of its authority.
    // Following a redirect off it hands the answer to a different party while the fold still
    // reports the declared profile as read — and the double answers differently at the two
    // URLs, so this is observable rather than merely asserted.
    const off = roleProfileDeps({ [P]: { body: WIDE, landedAt: 'https://evil.test/roles.ttl' } });
    const refused = await dereferenceRoleProfile(P, off.deps);
    expect(refused.kind).toBe('unreadable');
    if (refused.kind === 'unreadable') expect(refused.why).toMatch(/is a different origin/);
    // …and the CONTROL: same-origin is fine, and `head` reports where the bytes really came
    // from rather than the name that was asked for.
    const same = roleProfileDeps({ [P]: { body: NARROW, landedAt: `${P}.ttl` } });
    const ok = await dereferenceRoleProfile(P, same.deps);
    expect(ok.kind).toBe('declared');
    if (ok.kind !== 'declared') return;
    expect(ok.document.head).toBe(`${P}.ttl`);
    expect(ok.document.dereferenced).toBe(P);
  });

  it('★ a cleartext profile IRI is refused, deliberately stricter than the published shape', async () => {
    // `wsp-shapes.ttl` patterns `wsp:roleProfile` as `^https?://`, so a workspace may legally
    // declare an http:// profile — and for a document whose entire evidence is the transport, a
    // cleartext fetch is evidence of nothing. This is the one place the reader is stricter than
    // the contract, which `PUBLISHED_IRI_PATTERN` exists to stop happening silently, so it is
    // pinned here and stated in the reader's own docstring.
    const { deps, asked } = roleProfileDeps({ 'http://roles.test/x': { body: NARROW } });
    const evidence = await dereferenceRoleProfile('http://roles.test/x', deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/cleartext/);
    expect(asked).toEqual([]);
    // …and the same fail-closed answer for anything that is neither an /ns IRI nor https.
    for (const bad of ['urn:example:roles', '', 'ftp://roles.test/x']) {
      expect((await dereferenceRoleProfile(bad, deps)).kind, bad).toBe('unreadable');
    }
  });

  it('★ a document that is not a role profile refuses, and so does one that declares two', async () => {
    const notAProfile = roleProfileDeps({ [P]: { body: GRANT_TTL } });
    const wrongType = await dereferenceRoleProfile(P, notAProfile.deps);
    expect(wrongType.kind).toBe('unreadable');
    if (wrongType.kind === 'unreadable') expect(wrongType.why).toMatch(/declares no <.*wsp#RoleProfile>/);

    // An HTML error page served with a 200 — the shape a misconfigured host produces, and the
    // one a reader that only checked the status would parse as an empty table.
    const html = roleProfileDeps({ [P]: { body: '<!doctype html><h1>Not found</h1>', contentType: 'text/html' } });
    expect((await dereferenceRoleProfile(P, html.deps)).kind).toBe('unreadable');

    const two = roleProfileDeps({ [P]: { body: `${NARROW}\n<${P}#other> a wsp:RoleProfile .\n` } });
    const twoRead = await dereferenceRoleProfile(P, two.deps);
    expect(twoRead.kind).toBe('unreadable');
    if (twoRead.kind === 'unreadable') expect(twoRead.why).toMatch(/declares 2 <.*wsp#RoleProfile> subjects/);

    // A profile with no roles at all is refused rather than read as permitting nothing: every
    // grant in the workspace would name a role it does not declare, and "the table is empty" and
    // "the document is not a role profile" are answers an operator acts on differently.
    const empty = roleProfileDeps({ [P]: { body: `@prefix wsp: <${WSP}> .\n<${P}> a wsp:RoleProfile .` } });
    const emptyRead = await dereferenceRoleProfile(P, empty.deps);
    expect(emptyRead.kind).toBe('unreadable');
    if (emptyRead.kind === 'unreadable') expect(emptyRead.why).toMatch(/not one <.*wsp#Role>/);
  });

  it('★★ a malformed wsp:permits refuses the DOCUMENT rather than being skipped', async () => {
    // ★ THE DIRECTION IS THE POINT. Skipping the bad value narrows the published table, and a
    // narrower document makes an honest caller's table look WIDER than it is — so a typo in the
    // governance document would manufacture exactly the disagreement this whole check reports,
    // against a fold that had done nothing wrong. Refusing is loud; dropping is a wrong answer
    // wearing a right one's clothes.
    const literal = `@prefix wsp: <${WSP}> .\n<${P}> a wsp:RoleProfile .\n`
      + `<${P}#Observer> a wsp:Role ; wsp:permits <${CAPS.read}>, "read" .\n`;
    const { deps } = roleProfileDeps({ [P]: { body: literal } });
    const evidence = await dereferenceRoleProfile(P, deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/is not an IRI/);

    // …and a blank-node role, which can never be the role a grant names.
    const bnode = `@prefix wsp: <${WSP}> .\n<${P}> a wsp:RoleProfile .\n`
      + `[] a wsp:Role ; wsp:permits <${CAPS.read}> .\n`;
    const bn = await dereferenceRoleProfile(P, roleProfileDeps({ [P]: { body: bnode } }).deps);
    expect(bn.kind).toBe('unreadable');
    if (bn.kind === 'unreadable') expect(bn.why).toMatch(/is a blank node/);
  });

  it('★ a missing fetchDocument dependency refuses loudly instead of falling back', async () => {
    // The posture `getDescriptor` and `currentHead` take. Returning a table from anywhere else
    // when the dependency is absent would report a check that did not happen.
    const noDep = descriptorDeps({});
    const evidence = await dereferenceRoleProfile(P, noDep);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') expect(evidence.why).toMatch(/no `fetchDocument` dependency/);
    // …and a fetch that THROWS is a refusal, not an exception out of the authorization path.
    const throws = await dereferenceRoleProfile(P, roleProfileDeps({}, { throws: true }).deps);
    expect(throws.kind).toBe('unreadable');
    if (throws.kind === 'unreadable') expect(throws.why).toMatch(/threw: socket hang up/);
  });

  it('★★ a POD-HOSTED profile takes the substrate path, resolves through its OWN owner segment, and is SIGNED', async () => {
    // ★ THE POD DOUBLE ANSWERS DIFFERENTLY PER POD, which is the mutant that survived on
    // `dereferenceWorkspaceRecord`: alice's pod serves the NARROW table and bee's serves the
    // WIDE one at the same IRI. Dropping `pod_name` from the call, or naming the wrong pod,
    // cannot return alice's table here.
    const { deps, headCalls, asked } = roleProfileDeps({});
    const evidence = await dereferenceRoleProfile(NS_PROFILE, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    expect(evidence.document.roles).toEqual([{ role: `${P}#Observer`, permits: [CAPS.read] }]);
    expect(evidence.document.head).toBe(PROFILE_DESC);
    expect(evidence.document.dereferenced).toBe(NS_PROFILE);
    // ★ THE GRADE IS THE STRONGER ONE HERE, and it is the only path that can honestly claim it:
    // the table came out of `payloadOf`, so out of the region the substrate digested, with the
    // verifier's answer beside it.
    expect(evidence.document.authority).toBe('signed-record');
    expect(evidence.document.attestation?.authorshipVerified).toBe(true);
    expect(headCalls).toEqual([{ urn: NS_PROFILE, pod_name: 'u-eth-alice' }]);
    // …and it never went to the open web for an IRI the substrate answers for.
    expect(asked).toEqual([]);
  });

  it('★★ PARSE SCOPE MUST EQUAL DIGEST SCOPE for a role profile too — the widened role outside the block is not read', async () => {
    // ★★ FOUND BY MUTATION, AND IT IS THE MANUFACTURED PARTICIPANT ONE DOCUMENT OUT. Replacing
    // `payloadOf(res)` with `res.graph.content` — the whole served document — survived every
    // other case in this describe block, because none of them put anything outside the digested
    // block for the wider parse to find.
    //
    // The attack is the same one that cost this module its headline property for a round: the
    // relay digests only the `<graphIri> { … }` region, so a `wsp:Role` written into the DEFAULT
    // graph beside a verbatim copy of a real signed profile is content-bound at full strength
    // and says whatever its writer likes. On a governance document that is not a forged
    // membership — it is a forged CAPABILITY, on every member of the workspace at once.
    const widenedOutside =
      `<${P}#Observer> a <${WSP}Role> ; <${WSP}permits> <${CAPS.grant}>, <${CAPS.revoke}> .\n`;
    const { deps } = roleProfileDeps({}, { outsideBlock: widenedOutside });
    const evidence = await dereferenceRoleProfile(NS_PROFILE, deps);
    expect(evidence.kind).toBe('declared');
    if (evidence.kind !== 'declared') return;
    // The digested block says `#Observer` permits `read`, and that is the whole of what is read.
    expect(evidence.document.roles).toEqual([{ role: `${P}#Observer`, permits: [CAPS.read] }]);

    // ★ AND NO FALLBACK TO THE TOP-LEVEL `content`, which is the other half of the same hole and
    // was itself a surviving mutant on the membership readers. `get_descriptor` digests
    // `graph.content` and nothing else, so a record served only as top-level content has no
    // covered region and must be refused rather than read.
    const noGraph = {
      ...descriptorDeps({}),
      getDescriptor: vi.fn(async () => ({
        url: PROFILE_DESC,
        turtle: `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n<${PROFILE_DESC}> a iep:ContextDescriptor .\n`,
        content: WIDE,
        authorship: { authorshipVerified: true, signedBy: CONV_KEY, contentBinding: 'bound' },
      })),
      currentHead: vi.fn(async () => ({ forked: false, head: { descriptorUrl: PROFILE_DESC } })),
    } as unknown as StreamDeps;
    const refused = await dereferenceRoleProfile(NS_PROFILE, noGraph);
    expect(refused.kind).toBe('unreadable');
  });

  it('★ the rival table on another pod is never what the /ns dereference returns', async () => {
    // The control that makes the case above a measurement: bee's document is readable, parses
    // clean, is signed by her own registered agent, and gives `#Observer` `grant` and `revoke`.
    // It is simply on the wrong pod.
    const { deps } = roleProfileDeps({});
    const rival = await dereferenceRoleProfile(
      'https://relay.test/ns/u-eth-bee/wsp-roles-x', deps,
    );
    expect(rival.kind).toBe('declared');
    if (rival.kind !== 'declared') return;
    expect(rival.document.roles[0]!.permits).toContain(CAPS.revoke);
    const mine = await dereferenceRoleProfile(NS_PROFILE, deps);
    expect(mine.kind === 'declared' && mine.document.roles[0]!.permits).not.toContain(CAPS.revoke);
  });

  it('★ a FORKED profile chain refuses rather than picking a table', async () => {
    // The same rule the fold applies to a forked grant chain and `dereferenceWorkspaceRecord`
    // applies to a forked workspace: two unresolved heads mean the IRI states two role tables,
    // and picking one would make what a role permits depend on the order of a supersedes walk.
    const { deps } = roleProfileDeps({}, { forked: true });
    const evidence = await dereferenceRoleProfile(NS_PROFILE, deps);
    expect(evidence.kind).toBe('unreadable');
    if (evidence.kind === 'unreadable') {
      expect(evidence.why).toMatch(/2 unresolved chain heads/);
      expect(evidence.why).toMatch(/Republish a single clean head/);
    }
    // …an empty chain, and a missing currentHead, refuse too.
    const none = await dereferenceRoleProfile(NS_PROFILE, roleProfileDeps({}, { heads: {} }).deps);
    expect(none.kind).toBe('unreadable');
    if (none.kind === 'unreadable') expect(none.why).toMatch(/nothing is published at/);
    const noDep = await dereferenceRoleProfile(NS_PROFILE, descriptorDeps({}));
    expect(noDep.kind).toBe('unreadable');
    if (noDep.kind === 'unreadable') expect(noDep.why).toMatch(/no `currentHead` dependency/);
  });

  it('★★ end to end: the read table refuses the widened fold and ADMITS the published one', async () => {
    // ★ THE CONTROL FIRST, for the reason this file states at the top: a suite where every
    // configuration is refused establishes nothing, and that is exactly how §6 of
    // verify-can-live.ts used to pass.
    // ★ THE TWO DOUBLES ARE COMPOSED IN THIS ORDER ON PURPOSE. `roleProfileDeps` carries its own
    // `getDescriptor` (which knows only the two profile descriptors), so spreading it SECOND
    // would silently replace the one that serves the grant and the acceptance — and every read
    // below would fail for a reason having nothing to do with the role table. Only
    // `fetchDocument` is taken from it.
    const grant = OBSERVER_GRANT_TTL;
    const deps = {
      ...descriptorDeps({
        [WORKSPACE_URL]: { content: WORKSPACE_TTL, signedBy: CONV_KEY },
        [GRANT_URL]: { content: grant, signedBy: CONV_KEY },
        [ACCEPT_URL]: { content: ACCEPT_TTL, signedBy: BEE_KEY },
      }),
      fetchDocument: roleProfileDeps({ [P]: { body: NARROW } }).deps.fetchDocument,
    } as unknown as StreamDeps;
    const roleTableEvidence = await dereferenceRoleProfile(P, deps);
    const base = {
      workspace: WS, scopes,
      grants: [(await readGrantRecord(GRANT_URL, deps)).record!],
      acceptances: [(await readAcceptanceRecord(ACCEPT_URL, deps)).record!],
    };
    const policy = {
      convener: CONV, signerOf, requireFieldBinding: true,
      workspaceEvidence: convenerEvidenceOf(await readWorkspaceRecord(WORKSPACE_URL, deps)),
    };
    // The published table, read off the wire, folded against a caller that agrees with it.
    const honest: RoleProfile = { profile: P, roles: [{ role: `${P}#Observer`, permits: [CAPS.read] }] };
    const admitted = foldRoster({ ...base, profile: honest, attestation: { ...policy, roleTableEvidence } });
    expect(admitted.members).toHaveLength(1);
    expect(admitted.roleTableBinding).toBe('bound');
    expect(admitted.members[0]!.effective).toEqual([CAPS.read]);

    // …and residual gap 10, closed against a document nobody in this test wrote by hand: the
    // caller claims the same IRI and gives `#Observer` three more capabilities.
    const widened: RoleProfile = {
      profile: P, roles: [{ role: `${P}#Observer`, permits: [CAPS.read, CAPS.append, CAPS.grant] }],
    };
    const open = foldRoster({ ...base, profile: widened, attestation: policy });
    expect(open.members).toHaveLength(1);
    expect(open.roleProfileBinding).toBe('bound');
    expect(open.members[0]!.effective.length).toBeGreaterThan(1);
    const closed = foldRoster({ ...base, profile: widened, attestation: { ...policy, roleTableEvidence } });
    expect(closed.members).toHaveLength(0);
    expect(closed.roleTableBinding).toBe('refused');
    expect(closed.unattested[0]!.because).toMatch(/it PERMITS MORE than the document does/);
    expect(closed.convenerBinding).toBe('bound');
  });
});
