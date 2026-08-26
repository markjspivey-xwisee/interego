#!/usr/bin/env tsx
/**
 * A note projection may not tell a reader something that is not true of the note.
 *
 * ── ★★ WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────
 *
 * An external agent probed the live fleet and reported two things about the HyperMarkdown a
 * `publish_context` hands back. Both were real, and both had already survived a green suite:
 *
 *   1. A `visibility: "public"` note rendered as "Private note — encrypted at rest … the note
 *      stays private." `note-view.ts` reads the audience class off the descriptor Turtle it is
 *      given, and the descriptor `publish_context` SYNTHESIZES for the inline hand-back carried
 *      neither `iep:visibility` nor `iep:encrypted` — so both probes failed unconditionally and
 *      every note took the private branch. The direction is the unsafe one: `visibility:
 *      "public"` grants `acl:Read` to `foaf:Agent` and there is no unpublish, so a reader was
 *      being assured of privacy for a world-readable resource.
 *
 *      ★ HOW IT SURVIVED, WHICH IS THE PART WORTH KEEPING. `_note-view-test.ts` already asserted
 *      that a public note projects `state: "public"` — feeding it a REAL persisted descriptor,
 *      which does carry both triples (packages/solid/src/client.ts). The broken path feeds a
 *      SYNTHESIZED one the test never constructed. A green test over the shape somebody thought
 *      to check. So the cases below are built from the shape `publish_context` actually emits,
 *      and §5 asserts against server.ts's own source that it still emits it.
 *
 *   2. "4 controls rendered, 0 invocable." The document's `descriptorUrl` — the authority a
 *      reader is told to hand to `invoke_affordance` — was the `/render/<id>` URL. `/render` is
 *      a PROJECTION: it carries no `iep:Affordance` blocks to re-resolve, and it is bearer-gated
 *      while `invoke_affordance` forwards a bearer only to same-origin `/amep`. Following the
 *      footer 401'd. Note that widening `invoke_affordance`'s catch would NOT have helped: its
 *      signed-graph fallback re-resolves by calling `get_descriptor` on that SAME field.
 *
 * And one the report was half right about: the markdown advertises "To act: call
 * `invoke_affordance(descriptorUrl, rel)`" for EVERY control, target-less ones included. The
 * structured `render_hmd` output has distinguished executable from declarative for a year; the
 * markdown bytes never did.
 *
 * Every refusal below is paired with a case that must still succeed, so deleting a guard fails
 * one and widening it fails the other.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/note-projection-honesty.test.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteToHyperMarkdown, inlineRenderedForDescriptor, publishableAuthority } from '../note-view.js';
import { parseHypermediaMarkdown } from '@interego/core';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const HMD = 'https://markjspivey-xwisee.github.io/interego/ns/hmd#';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── Fixtures: exactly what publish_context builds ────────────────────────────
//
// `descIdRef`, `viewUrl` and the affordance lines are copied from the hand-back block in
// server.ts. The two policy triples are the fix; §5 keeps this copy honest.
const DESC_ID = 'urn:iep:eth-8f3b8e939600:1787000000000';
const RELAY = 'https://relay.interego.xwisee.com';
const VIEW_URL = `${RELAY}/render/${encodeURIComponent(DESC_ID)}`;
const PUBLIC_DESCRIPTOR = 'https://css-gate.interego.xwisee.com/eth-8f3b8e939600/context-graphs/n-1.ttl';
const INTERNAL_DESCRIPTOR = 'http://css.railway.internal:3456/eth-8f3b8e939600/context-graphs/n-1.ttl';
const PUBLIC_GRAPH_URL = 'https://css-gate.interego.xwisee.com/eth-8f3b8e939600/context-graphs/n-1.graph.ttl';
const INTERNAL_GRAPH_URL = 'http://css.railway.internal:3456/eth-8f3b8e939600/context-graphs/n-1.graph.ttl';

/**
 * The synthesized hand-back descriptor. `withPolicy: false` reproduces the pre-fix bytes.
 *
 * ★ THE AFFORDANCE SET IS PART OF THE FIXTURE, NOT SCENERY. It mirrors the branches in
 * packages/solid/src/client.ts that decide what the PERSISTED descriptor advertises — the fetch
 * affordance is `iep:canDecrypt` when encrypted and `iep:canFetchPayload` when not, and
 * `iep:renderView` appears only for an encrypted, not-publisher-sealed payload. The hand-back
 * used to emit `<#renderView>` unconditionally and no fetch affordance at all, so a PUBLIC note's
 * document offered the one control that cannot work and hid the one that does. §6 reads server.ts
 * to keep this copy honest, and §8 asserts the projection that comes out of it.
 */
const affTurtle = (opts: {
  encrypted: boolean;
  visibility: 'public' | 'private' | 'shared';
  withPolicy?: boolean;
  /** Publisher-sealed: the relay is not a recipient, so /render answers 403 and renderView is omitted. */
  sealed?: boolean;
  /** The fetch affordance's target — the graph URL in its outward spelling. */
  graphUrl?: string;
}): string => {
  const enc = opts.encrypted;
  const policy = (opts.withPolicy ?? true)
    ? ` iep:encrypted ${enc ? 'true' : 'false'}`
      + `${opts.visibility === 'public' || opts.visibility === 'private' ? ` ; iep:visibility "${opts.visibility}"` : ''}`
      + ' ;'
    : '';
  const fetchAction = enc ? 'canDecrypt' : 'canFetchPayload';
  const graphUrl = opts.graphUrl ?? PUBLIC_GRAPH_URL;
  const offersRenderView = enc && !opts.sealed;
  const refs = [`<#${fetchAction}>`, ...(offersRenderView ? ['<#renderView>'] : [])];
  return [
    `@prefix iep: <${IEP}> .`,
    `@prefix hydra: <http://www.w3.org/ns/hydra/core#> .`,
    `@prefix dcat: <http://www.w3.org/ns/dcat#> .`,
    `<${DESC_ID}> a iep:ContextDescriptor ;${policy} iep:affordance ${refs.join(', ')} .`,
    `<#${fetchAction}> a iep:Affordance ; iep:action <${IEP}${fetchAction}> ; hydra:target <${graphUrl}> ; hydra:method "GET" .`,
    ...(offersRenderView
      ? [`<#renderView> a iep:Affordance ; iep:action <${IEP}renderView> ; hydra:target <${VIEW_URL}> ; hydra:method "GET" ; dcat:mediaType "text/markdown; charset=UTF-8; variant=CommonMark" .`]
      : []),
  ].join('\n');
};

/** The hand-back descriptor as it was emitted BEFORE this round: `<#renderView>` unconditionally,
 *  and no fetch affordance at all. Kept so the agreement checks in §5 cannot go vacuous. */
const PRE_FIX_AFF_TURTLE = [
  `@prefix iep: <${IEP}> .`,
  `@prefix hydra: <http://www.w3.org/ns/hydra/core#> .`,
  `@prefix dcat: <http://www.w3.org/ns/dcat#> .`,
  `<${DESC_ID}> a iep:ContextDescriptor ; iep:encrypted false ; iep:visibility "public" ; iep:affordance <#renderView> .`,
  `<#renderView> a iep:Affordance ; iep:action <${IEP}renderView> ; hydra:target <${VIEW_URL}> ; hydra:method "GET" ; dcat:mediaType "text/markdown; charset=UTF-8; variant=CommonMark" .`,
].join('\n');

const NOTE_GRAPH = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
<urn:graph:memory:policy-probe> a ieh:AgentMemory, schema:NoteDigitalDocument ;
  schema:name "Release notes for the substrate" ;
  schema:text "Anyone may read this." .`;

// ── 1. THE BUG: a public note may not be labelled private ────────────────────
{
  const pub = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: NOTE_GRAPH,
    isPublic: true,
  });
  ok('public note: state is "public"', /^state: "public"$/m.test(pub));
  ok('public note: never says "Private note"', !pub.includes('Private note'), pub.slice(0, 200));
  ok('public note: never says "encrypted at rest"', !pub.includes('encrypted at rest'));
  ok('public note: says plainly that anyone can read it', pub.includes('readable by anyone'));

  // The synthesized descriptor ALONE must carry it — the caller flag is a second path, not the
  // only one. Drop `isPublic` and the two triples must still decide correctly, because
  // `get_descriptor`'s projection has no flag to pass and reads exactly these bytes.
  const byTurtleOnly = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: NOTE_GRAPH,
  });
  ok('public note: the descriptor triples alone are enough (no isPublic flag)', /^state: "public"$/m.test(byTurtleOnly));

  // And the flag ALONE must be enough, because it is the authoritative one: the publish handler
  // holds the audience class as a value and should not depend on a regex over bytes it wrote.
  const byFlagOnly = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public', withPolicy: false }),
    plaintextTurtle: NOTE_GRAPH,
    isPublic: true,
  });
  ok('public note: the caller flag alone is enough (policy triples absent)', /^state: "public"$/m.test(byFlagOnly));

  // THE PRE-FIX BYTES, asserted as the defect they were: no triples and no flag reads private.
  // Kept so the fix cannot be "make everything public", which would pass every check above.
  const preFix = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public', withPolicy: false }),
    plaintextTurtle: NOTE_GRAPH,
  });
  ok('a descriptor that states no policy at all still reads private (fail-closed)', /^state: "private"$/m.test(preFix));
}

// ── 2. A private note is still private ───────────────────────────────────────
{
  const priv = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: true, visibility: 'private' }),
    plaintextTurtle: NOTE_GRAPH,
    isPublic: false,
  });
  ok('private note: state is "private"', /^state: "private"$/m.test(priv));
  ok('private note: still says encrypted at rest', priv.includes('encrypted at rest'));

  // 'shared' is the default audience class and is encrypted — it must not read as public.
  const shared = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: true, visibility: 'shared' }),
    plaintextTurtle: NOTE_GRAPH,
    isPublic: false,
  });
  ok('shared note: state is "private" (no iep:visibility triple is emitted for shared)', /^state: "private"$/m.test(shared));
}

// ── 3. THE BUG: the authority must be something a reader can dereference ─────
{
  const followable = (t: string): boolean => /^https:\/\//i.test(t) && !/\.internal\b/i.test(t) && !/localhost|127\.0\.0\.1/i.test(t);

  ok('authority: a public descriptor URL is accepted',
    publishableAuthority(PUBLIC_DESCRIPTOR, VIEW_URL, followable) === PUBLIC_DESCRIPTOR);
  ok('authority: an internal-host descriptor URL is REFUSED (falls back)',
    publishableAuthority(INTERNAL_DESCRIPTOR, VIEW_URL, followable) === VIEW_URL);
  ok('authority: a loopback descriptor URL is REFUSED by the invoke screen',
    publishableAuthority('http://localhost:3456/eth-x/n-1.ttl', VIEW_URL, followable) === VIEW_URL);
  ok('authority: an absent candidate falls back',
    publishableAuthority(undefined, VIEW_URL, followable) === VIEW_URL);
  ok('authority: an unparseable candidate falls back (internal-label probe is fail-closed)',
    publishableAuthority('not a url', VIEW_URL, followable) === VIEW_URL);

  /**
   * ★★ THE INTERNAL-LABEL PROBE IS NOT REDUNDANT WITH THE SCREEN, and every fixture above let
   * the screen do the refusing — so deleting `hasInternalHostLabel` from `publishableAuthority`
   * left this file, and `_note-view-test.ts`, entirely green.
   *
   * The LIVE screen is `isFollowableTarget` → `assertInvokeTargetAllowed`, which returns
   * `'pinned'` for the relay's own CSS origin BEFORE it reaches its internal-label check. On this
   * fleet that origin IS `css.railway.internal`, so the live screen says YES to the store host
   * (deliberately: the relay has to fetch its own store). `pinnedStoreScreen` reproduces exactly
   * that shape. Only the probe keeps the internal host out of store-and-forward bytes.
   */
  const pinnedStoreScreen = (t: string): boolean =>
    t.startsWith('http://css.railway.internal:3456/')
    || (/^https:\/\//i.test(t) && !/\.internal\b/i.test(t));
  ok('authority: an internal host is refused even when the invoke screen ACCEPTS it (pinned origin)',
    publishableAuthority(INTERNAL_DESCRIPTOR, VIEW_URL, pinnedStoreScreen) === VIEW_URL,
    publishableAuthority(INTERNAL_DESCRIPTOR, VIEW_URL, pinnedStoreScreen));
  // Paired, so "refuse everything" fails too: the pin is not what does the refusing.
  ok('authority: that same screen still accepts a public descriptor',
    publishableAuthority(PUBLIC_DESCRIPTOR, VIEW_URL, pinnedStoreScreen) === PUBLIC_DESCRIPTOR);
  // And the label, not the scheme, is the reason: an https internal host with a bare http(s)
  // screen (the permissive fallback any caller without an egress screen gets) is still refused.
  ok('authority: an https internal-label host is refused by the probe, not by the scheme',
    publishableAuthority('https://store.internal/eth-x/context-graphs/n-1.ttl', VIEW_URL, (t) => /^https?:\/\//i.test(t)) === VIEW_URL);

  // End to end: the document must NAME the descriptor, in both the places a reader looks.
  const md = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: publishableAuthority(PUBLIC_DESCRIPTOR, VIEW_URL, followable),
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: NOTE_GRAPH,
    isPublic: true,
  });
  const doc = parseHypermediaMarkdown(md);
  ok('authority: frontmatter descriptorUrl is the DESCRIPTOR, not the /render projection',
    doc.descriptorUrl === PUBLIC_DESCRIPTOR, doc.descriptorUrl);
  ok('authority: the "Signed descriptor (authority)" link points at the descriptor',
    md.includes(`[Signed descriptor (authority)](${PUBLIC_DESCRIPTOR}){rel="describedby"`));
  ok('authority: the identity is still the render URL (only the authority moved)',
    doc.id === VIEW_URL, doc.id);
  ok('authority: /render is no longer offered as the thing to invoke against',
    !new RegExp(`^descriptorUrl: "${VIEW_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm').test(md));
}

// ── 4. A control nothing can follow may not be advertised as actionable ──────
//
// The renderer emits one standing "To act: call invoke_affordance(...)" footer for the whole
// document. Controls it cannot be true of must say so themselves.
{
  const mixedPayload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <${HMD}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:graph:memory:mixed> a ieh:AgentMemory ;
  schema:name "Mixed" ; schema:text "one runs, one does not." ;
  hmd:control <#echo>, <#acknowledge> .
<#echo> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}echo> ;
  hydra:method "POST" ; hydra:target <${RELAY}/hmd/echo> .
<#acknowledge> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}acknowledge> ;
  hydra:method "POST" .`;
  const md = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: mixedPayload,
    graphIri: 'urn:graph:memory:mixed',
    isPublic: true,
    isFollowable: (t) => /^https:\/\//i.test(t),
  });
  const controls = parseHypermediaMarkdown(md).controls;
  const echo = controls.find((c) => c.action === `${IEP}echo`);
  const ack = controls.find((c) => c.action === `${IEP}acknowledge`);
  ok('declarative: both controls still project', !!echo && !!ack);
  ok('declarative: the target-less control is marked DECLARATIVE',
    !!ack?.whenToUse && ack.whenToUse.includes('DECLARATIVE'), String(ack?.whenToUse));
  ok('declarative: the control with a real target is NOT marked',
    !!echo && echo.whenToUse === undefined, String(echo?.whenToUse));
  ok('declarative: the prose qualifies the standing execution footer',
    md.includes('Controls marked DECLARATIVE below have no execution endpoint'));
  // ★ THE SENTENCE ABOUT THE *UNMARKED* ONES IS THE HALF THAT CAN GO FALSE. It claimed they
  // "re-resolve a live target from the signed descriptor": wrong about WHERE (a payload
  // control's target is in the signed GRAPH) and over-claiming about WHAT (unmarked means the
  // egress screen would let the fetch out, not that the call is authorized — `/render` is
  // unmarked and answers 401 to a caller invoke does not authenticate).
  ok('declarative: the qualifier names both sources for an unmarked control',
    md.includes('in the signed descriptor or in the signed graph'), md.slice(-400));
  ok('declarative: the qualifier does not promise an unmarked control will succeed',
    !md.includes('re-resolve a live target from the signed descriptor')
      && md.includes('not a promise the call is authorized'), md.slice(-400));

  // A document whose controls are ALL followable needs no qualifier — otherwise the marker
  // becomes noise that means nothing, which is the same defect in the other direction.
  const allFollowable = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <${HMD}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:graph:memory:allrun> a ieh:AgentMemory ; schema:name "All run" ; schema:text "x" ;
  hmd:control <#echo> .
<#echo> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}echo> ;
  hydra:method "POST" ; hydra:target <${RELAY}/hmd/echo> .`;
  const clean = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: allFollowable,
    graphIri: 'urn:graph:memory:allrun',
    isPublic: true,
    isFollowable: (t) => /^https:\/\//i.test(t),
  });
  ok('declarative: no qualifier when every control is followable',
    !clean.includes('Controls marked DECLARATIVE'));

  /**
   * ★★ THE TRAP. Payload controls are extracted with `requireTarget:false` so target-less ones
   * project at all, and in that mode the extractor SYNTHESIZES a target — the control's own
   * subject IRI. Compute executability from that list and a control published under an https
   * subject IRI marks itself executable purely because its NAME is an https URL. The controls
   * here are byte-for-byte the target-less ones above with https subject IRIs; all three must
   * still read declarative.
   */
  const httpsSubjects = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <${HMD}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://pods.example/eth-x/g/note.ttl> a ieh:AgentMemory ; schema:name "https subjects" ;
  schema:text "y" ; hmd:control <https://pods.example/eth-x/g/note.ttl#ask> .
<https://pods.example/eth-x/g/note.ttl#ask> a hmd:Control, iep:Affordance, hydra:Operation ;
  iep:action <${IEP}ask> ; hydra:method "POST" .`;
  const trap = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: httpsSubjects,
    graphIri: 'https://pods.example/eth-x/g/note.ttl',
    isPublic: true,
    isFollowable: (t) => /^https:\/\//i.test(t),
  });
  const askControl = parseHypermediaMarkdown(trap).controls.find((c) => c.action === `${IEP}ask`);
  ok('declarative: an https SUBJECT IRI is not a hydra:target (synthesized-target trap)',
    !!askControl?.whenToUse && askControl.whenToUse.includes('DECLARATIVE'), String(askControl?.whenToUse));

  // The screen is the caller's. Hand in one that refuses everything and nothing may claim to run.
  const refused = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: mixedPayload,
    graphIri: 'urn:graph:memory:mixed',
    isPublic: true,
    isFollowable: () => false,
  });
  ok('declarative: a refusing invoke screen marks every control declarative',
    (refused.match(/whenToUse: "DECLARATIVE/g) ?? []).length === parseHypermediaMarkdown(refused).controls.length);
}

// ── 5. get_descriptor's projection reaches the same answers ──────────────────
//
// The two projections are required to be byte-shape-identical. An authority that differed
// between the publish hand-back and the re-fetch would be the same defect wearing new clothes.
{
  const persisted = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<${DESC_ID}> a iep:ContextDescriptor ; iep:describes <urn:graph:memory:policy-probe> ;
  iep:affordance [ a iep:Affordance, hydra:Operation ; iep:action iep:canFetchPayload ;
    hydra:method "GET" ; hydra:target <${INTERNAL_DESCRIPTOR.replace('n-1.ttl', 'n-1.graph.ttl')}> ;
    iep:encrypted false ; iep:visibility "public" ] .`;
  const followable = (t: string): boolean => /^https:\/\//i.test(t) && !/\.internal\b/i.test(t);

  const withPublicSpelling = inlineRenderedForDescriptor({
    descriptorUrl: INTERNAL_DESCRIPTOR,
    authorityUrl: PUBLIC_DESCRIPTOR,
    descriptorTurtle: persisted,
    plaintextTurtle: NOTE_GRAPH,
    publicBase: RELAY,
    port: 8080,
    isFollowable: followable,
  });
  ok('get_descriptor: projects', !!withPublicSpelling);
  ok('get_descriptor: authority is the outward descriptor spelling',
    !!withPublicSpelling && parseHypermediaMarkdown(withPublicSpelling.rendered).descriptorUrl === PUBLIC_DESCRIPTOR,
    withPublicSpelling ? parseHypermediaMarkdown(withPublicSpelling.rendered).descriptorUrl : 'null');
  ok('get_descriptor: no internal host in the bytes',
    !!withPublicSpelling && !withPublicSpelling.rendered.includes('css.railway.internal'));

  // No outward spelling configured: the previous identity-as-authority behaviour, never the
  // internal host. A deployment without CSS_PUBLIC_URL must not start leaking one.
  const noSpelling = inlineRenderedForDescriptor({
    descriptorUrl: INTERNAL_DESCRIPTOR,
    authorityUrl: INTERNAL_DESCRIPTOR,
    descriptorTurtle: persisted,
    plaintextTurtle: NOTE_GRAPH,
    publicBase: RELAY,
    port: 8080,
    isFollowable: followable,
  });
  ok('get_descriptor: an internal authorityUrl is refused, and never reaches the bytes',
    !!noSpelling && !noSpelling.rendered.includes('css.railway.internal')
      && parseHypermediaMarkdown(noSpelling.rendered).descriptorUrl !== INTERNAL_DESCRIPTOR);

  /**
   * ★★ THE SAME NOTE, THE SAME CONTROLS — MEASURED, not asserted in a comment.
   *
   * The hand-back and `get_descriptor` are required to be byte-shape-identical, and they were
   * not: for a PUBLIC note the hand-back listed `control-renderview` (which the persisted
   * descriptor does not advertise, so invoking it answers `AffordanceNotFoundError`) while
   * `get_descriptor` listed `control-canfetchpayload` (which works). The hand-back offered the
   * broken control and hid the working one.
   *
   * The screen here is the LIVE shape — pinned on the store origin — so both projections also
   * agree on the MARKING, not just on the set: `get_descriptor` screens the persisted internal
   * target, the hand-back screens the outward spelling, and on this fleet the egress guard
   * accepts both.
   */
  const pinned = (t: string): boolean =>
    t.startsWith('http://css.railway.internal:3456/')
    || (/^https:\/\//i.test(t) && !/\.internal\b/i.test(t));
  const reFetch = inlineRenderedForDescriptor({
    descriptorUrl: INTERNAL_DESCRIPTOR,
    authorityUrl: PUBLIC_DESCRIPTOR,
    descriptorTurtle: persisted,
    plaintextTurtle: NOTE_GRAPH,
    publicBase: RELAY,
    port: 8080,
    isFollowable: pinned,
  });
  const handBack = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: NOTE_GRAPH,
    graphIri: 'urn:graph:memory:policy-probe',
    isPublic: true,
    isFollowable: pinned,
  });
  const actions = (md: string): string[] =>
    parseHypermediaMarkdown(md).controls.map((c) => c.action).sort();
  ok('the two projections of ONE note list the same control set',
    !!reFetch && actions(reFetch.rendered).join('|') === actions(handBack).join('|'),
    reFetch ? `get_descriptor=[${actions(reFetch.rendered)}] handback=[${actions(handBack)}]` : 'null');
  ok('the two projections also agree that the fetch control is NOT declarative',
    !!reFetch
      && parseHypermediaMarkdown(reFetch.rendered).controls.every((c) => c.whenToUse === undefined)
      && parseHypermediaMarkdown(handBack).controls.every((c) => c.whenToUse === undefined));
  // ★ AND THE AGREEMENT CHECK MUST NOT BE VACUOUS. A mutation that empties BOTH control sets
  // makes "they agree" trivially true, which is how an equality assertion stops being a test.
  // The pre-fix hand-back shape is kept as the counter-example: it MUST still disagree.
  const preFixHandBack = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: PRE_FIX_AFF_TURTLE,
    plaintextTurtle: NOTE_GRAPH,
    graphIri: 'urn:graph:memory:policy-probe',
    isPublic: true,
    isFollowable: pinned,
  });
  ok('the agreement above is not vacuous: the PRE-FIX hand-back shape still disagrees',
    !!reFetch && actions(preFixHandBack).join('|') !== actions(reFetch.rendered).join('|'),
    `prefix=[${actions(preFixHandBack)}] get_descriptor=[${reFetch ? actions(reFetch.rendered) : ''}]`);
}

// ── 6. The publish hand-back in server.ts still builds what §1–4 assume ──────
//
// §1 reconstructs `affTurtle` from server.ts. A fixture cannot notice the original changing
// underneath it, and the original is where the defect was, so read it.
{
  const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(relayDir, 'server.ts'), 'utf8');
  const block = /const fetchAction = enc \?[\s\S]*?renderedNote = noteToHyperMarkdown\(\{[\s\S]*?\}\);/.exec(src)?.[0] ?? '';
  ok('server.ts: the hand-back block is still recognisable', block.length > 0);
  ok('server.ts: the synthesized descriptor states iep:encrypted', /iep:encrypted \$\{enc \? 'true' : 'false'\}/.test(block));
  ok('server.ts: the synthesized descriptor states iep:visibility for public/private',
    /iep:visibility "\$\{visibility\}"/.test(block) && /visibility === 'public' \|\| visibility === 'private'/.test(block));
  ok('server.ts: the hand-back passes the audience class it already holds',
    /isPublic: visibility === 'public'/.test(block));
  ok('server.ts: the hand-back passes the invoke screen so the marking cannot over-promise',
    /isFollowable: isFollowableTarget/.test(block));
  ok('server.ts: the authority is derived through publishableAuthority, from the outward spelling',
    /publishableAuthority\(\s*asPublicPodUrl\(result\.descriptorUrl\),\s*viewUrl,\s*isFollowableTarget,?\s*\)/.test(src));
  // Both spellings of the original defect: the property shorthand it was written as, and the
  // binding a revert would more plausibly reach for.
  ok('server.ts: THE DEFECT — the /render URL is no longer handed over as the authority',
    !/authority(?::|\s*=)\s*viewUrl\b/.test(src));
  ok('server.ts: get_descriptor passes the outward spelling too',
    /authorityUrl: asPublicPodUrl\(url\)/.test(src));

  // ── The affordance set the hand-back CLAIMS must follow the persisted descriptor's branches
  // (packages/solid/src/client.ts). §8 asserts the projection; these assert the source that
  // §1–§5's `affTurtle` fixture is a copy of, because a fixture cannot notice its original
  // changing underneath it — and the original is where this defect was.
  ok('server.ts: the fetch affordance follows encryption (canDecrypt vs canFetchPayload)',
    /const fetchAction = enc \? 'canDecrypt' : 'canFetchPayload';/.test(block));
  ok('server.ts: renderView is claimed ONLY for an encrypted, not-publisher-sealed payload',
    /const offersRenderView = enc && !sealed;/.test(block));
  ok('server.ts: THE DEFECT — renderView is no longer emitted unconditionally',
    /offersRenderView\s*\n?\s*\?\s*\[`<#renderView>/.test(block)
      || /offersRenderView\s*\?\s*\[`<#renderView>/.test(block),
    block.slice(block.indexOf('<#renderView>') - 120, block.indexOf('<#renderView>') + 40));
  ok('server.ts: the fetch target is the outward spelling, and refused rather than emitted broken',
    /turtleIriRef\(asPublicPodUrl\(result\.graphUrl\) \?\? result\.graphUrl\)/.test(block));
  ok('server.ts: an unusable fetch target omits the affordance instead of naming it',
    /fetchTargetRef\s*\n?\s*\?\s*\[`<#\$\{fetchAction\}>/.test(block)
      || /fetchTargetRef \? \[`<#\$\{fetchAction\}>/.test(block));
}

// ── 7. ONE AUTHORITY RULE, AT EVERY CALL SITE ────────────────────────────────
//
// ★★ THE FAILURE MODE THIS SECTION EXISTS FOR. The round that introduced `publishableAuthority`
// fixed the two call sites the report named — the publish hand-back and `get_descriptor` — and
// left the two it did not: BOTH branches of `GET /render/:descriptorIri`, which still computed
// the authority with the older `publishableDescriptorUrl(descriptorUrl, viewUrl)`. That rule
// keeps the descriptor only when `assertPublicPodUrl` accepts it and otherwise falls back to its
// second argument — so on any deployment whose store is on an internal host, which is this
// fleet, it handed a reader the bearer-gated `/render/<id>` URL as the thing to invoke against.
// That is the surface a raw HTTP reader gets: the one the document's own `@id` and its "Turtle"
// link point at.
//
// ★ AND THE GUARD THAT MISSED IT WAS THE OTHER HALF OF THE DEFECT. §6's `!/authority(?::|\s*=)\s*
// viewUrl\b/` scans the whole file and passes, because at those two sites the same mistake is
// spelled through a helper. So this section does not grep for a spelling: it ENUMERATES every
// `noteToHyperMarkdown` call in the relay and checks each one. A site added later that forgets
// the rule fails here without anyone having to think of it.
{
  const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Comments are blanked, not removed: a `noteToHyperMarkdown({…})` written in prose must not
  // count as a call site, but every offset (and therefore every line number this section
  // reports) has to stay the one a maintainer will find in the file.
  const blank = (m: string, keep = ''): string => keep + ' '.repeat(m.length - keep.length);
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, (m, p1: string) => blank(m, p1));
  const sources: Array<[string, string]> = [
    ['server.ts', strip(readFileSync(join(relayDir, 'server.ts'), 'utf8'))],
    ['note-view.ts', strip(readFileSync(join(relayDir, 'note-view.ts'), 'utf8'))],
  ];

  /** The argument object of a `noteToHyperMarkdown({ … })` call, by brace balance. */
  const callArgs = (src: string, openBrace: number): string => {
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(openBrace, i + 1); }
    }
    return '';
  };

  let sites = 0;
  for (const [file, src] of sources) {
    const re = /noteToHyperMarkdown\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      sites++;
      const at = `${file}@${src.slice(0, m.index).split('\n').length}`;
      const args = callArgs(src, m.index + 'noteToHyperMarkdown('.length);
      // WHICH FUNCTION produced this call's authority — named, not merely "the right one appears
      // somewhere nearby", so a site that switched back to `publishableDescriptorUrl` reports the
      // name it switched to. Either written inline in the argument object (note-view.ts) or bound
      // just above it (server.ts, where `authority` is passed by shorthand); the LAST preceding
      // binding is the nearest one, which is this call's.
      const before = src.slice(Math.max(0, m.index - 12000), m.index);
      const inline = /(?:^|[{,\s])authority:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(args);
      const binds = [...before.matchAll(/\bconst\s+authority\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g)];
      const producer = inline?.[1] ?? binds[binds.length - 1]?.[1];
      ok(`call site ${at}: the authority is produced by publishableAuthority`,
        producer === 'publishableAuthority', `produced by: ${producer ?? '(none found)'}`);
      ok(`call site ${at}: passes the invoke screen (isFollowable)`, /\bisFollowable\b/.test(args),
        args.slice(0, 220));
    }
  }
  // Four is what the relay has today: the publish hand-back, both /render branches, and
  // inlineRenderedForDescriptor. Fewer means a projection was deleted (or the scan broke and
  // every check above passed vacuously) — the failure that would make this whole section a lie.
  ok('all four relay projections were actually scanned', sites >= 4, `found ${sites}`);
}

// ── 8. A hand-back may not offer an affordance its own authority does not have ─
//
// The document names an authority and tells the reader to hand it to `invoke_affordance`. Every
// control it renders unmarked is a claim about THAT authority — so the synthesized descriptor
// this block builds has to claim what the PERSISTED one advertises, not what is convenient.
// Measured before the fix: a public note's hand-back rendered `control-renderview` unmarked, and
// invoking it against the authority the same document named answered `AffordanceNotFoundError …
// Available actions: - iep#canFetchPayload` — the working control being the one the hand-back
// left out.
{
  const screen = (t: string): boolean => /^https:\/\//i.test(t);
  const project = (turtle: string): string[] =>
    parseHypermediaMarkdown(noteToHyperMarkdown({
      viewUrl: VIEW_URL,
      authority: PUBLIC_DESCRIPTOR,
      descriptorTurtle: turtle,
      plaintextTurtle: NOTE_GRAPH,
      graphIri: 'urn:graph:memory:policy-probe',
      isFollowable: screen,
    })).controls.map((c) => c.action);

  const pub = project(affTurtle({ encrypted: false, visibility: 'public' }));
  ok('public hand-back: THE DEFECT — iep:renderView is not offered (the persisted descriptor emits it only when encrypted)',
    !pub.includes(`${IEP}renderView`), pub.join(','));
  ok('public hand-back: iep:canFetchPayload IS offered (the control that works, previously missing)',
    pub.includes(`${IEP}canFetchPayload`), pub.join(','));

  const encrypted = project(affTurtle({ encrypted: true, visibility: 'shared' }));
  ok('encrypted hand-back: offers canDecrypt and renderView, as the persisted descriptor does',
    encrypted.includes(`${IEP}canDecrypt`) && encrypted.includes(`${IEP}renderView`), encrypted.join(','));
  ok('encrypted hand-back: does NOT offer canFetchPayload (that action is the plaintext path)',
    !encrypted.includes(`${IEP}canFetchPayload`), encrypted.join(','));

  // Publisher-sealed: the relay is not a recipient, so /render answers 403 NotARecipient and
  // client.ts omits renderView. "A document promising a capability that is guaranteed to fail …
  // is worse than silence" is that file's rule, and it is this one's too.
  const sealedSet = project(affTurtle({ encrypted: true, visibility: 'shared', sealed: true }));
  ok('publisher-sealed hand-back: no renderView — nobody could honour it',
    !sealedSet.includes(`${IEP}renderView`) && sealedSet.includes(`${IEP}canDecrypt`), sealedSet.join(','));

  // And the unmarked/marked split has to survive the prose: with every descriptor control
  // followable and no target-less payload control, the qualifier must not appear at all.
  const md = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public' }),
    plaintextTurtle: NOTE_GRAPH,
    graphIri: 'urn:graph:memory:policy-probe',
    isPublic: true,
    isFollowable: screen,
  });
  ok('public hand-back: no control is left both unmarked and unbacked',
    !md.includes('Controls marked DECLARATIVE'), md.slice(0, 400));
  // The internal spelling never reaches the bytes even though it is what the target would be on
  // an unconfigured deployment — `controlsFromAffordances` drops `hydra:target` on the floor.
  const internalTarget = noteToHyperMarkdown({
    viewUrl: VIEW_URL,
    authority: PUBLIC_DESCRIPTOR,
    descriptorTurtle: affTurtle({ encrypted: false, visibility: 'public', graphUrl: INTERNAL_GRAPH_URL }),
    plaintextTurtle: NOTE_GRAPH,
    graphIri: 'urn:graph:memory:policy-probe',
    isPublic: true,
    isFollowable: screen,
  });
  ok('a fetch target never reaches the document bytes (the projection drops hydra:target)',
    !internalTarget.includes('css.railway.internal'));
}

console.log(fail === 0
  ? `\n${'-'.repeat(60)}\n${pass} checks passed — a note projection says only true things.\n`
  : `\n${fail} of ${pass + fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
