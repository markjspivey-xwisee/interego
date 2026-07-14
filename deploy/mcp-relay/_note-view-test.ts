// A private note, decrypted, projected as a complete HyperMarkdown document —
// the fix for "why is there a URN, and no links or controls?". Proves the
// projection an authorized owner gets from GET /render?format=markdown:
// dereferenceable HTTPS identity, the note's own prose, its controls (from the
// descriptor's affordances), describedby/alternate links, private state,
// authority-closed control targets, and no transport endpoint in the bytes.
import { noteToHyperMarkdown, inlineRenderedForDescriptor } from './note-view.js';
import { parseHypermediaMarkdown, HYPERMEDIA_MARKDOWN_MEDIA_TYPE } from '@interego/core';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

// A realistic encrypted-note descriptor: two affordances the render endpoint
// surfaces (canDecrypt, renderView), each with a real hydra:target that MUST NOT
// leak into the document.
const descriptorTurtle = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
<https://relay.interego.xwisee.com/u-pk-abc/desc-1.ttl> a iep:ContextDescriptor ;
  iep:describes <urn:graph:note:inline-markdown-presentation:20260713T163954024Z> ;
  iep:affordance <#canDecrypt>, <#renderView> .
<#canDecrypt> a iep:Affordance, hydra:Operation ;
  iep:action <${IEP}canDecrypt> ;
  hydra:target <https://css.internal:3456/u-pk-abc/notes/x.envelope.jose.json> ;
  hydra:method "GET" .
<#renderView> a iep:Affordance, hydra:Operation ;
  iep:action <${IEP}renderView> ;
  hydra:target <https://relay.interego.xwisee.com/render/urn%3Agraph%3Anote> ;
  hydra:method "GET" .`;

// The decrypted note graph (the owner's own content), including a hostile-looking
// ::: line to prove the fence guard is neutralized, not crashed.
const plaintextTurtle = `@prefix schema: <https://schema.org/> .
@prefix dct: <http://purl.org/dc/terms/> .
<urn:graph:note:inline-markdown-presentation:20260713T163954024Z>
  schema:name "Inline Markdown presentation preference" ;
  schema:text """When showing Interego memories or notes in ChatGPT, render the Markdown inline.
Do not display raw HMD source unless explicitly requested.
:::not-a-real-fence""" ;
  dct:created "2026-07-13T16:39:54Z" .`;

const viewUrl = 'https://relay.interego.xwisee.com/render/https%3A%2F%2Frelay.interego.xwisee.com%2Fu-pk-abc%2Fdesc-1.ttl';
const authority = 'https://relay.interego.xwisee.com/u-pk-abc/desc-1.ttl';
const md = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle });

check('media type constant is the RFC-honest string', HYPERMEDIA_MARKDOWN_MEDIA_TYPE === 'text/markdown; charset=UTF-8; variant=CommonMark');
check('renders as a HyperMarkdown document', md.startsWith('---\n"@context":'));
check('the note prose is present (rung 1)', md.includes('# Inline Markdown presentation preference') && md.includes('render the Markdown inline'));
check('private state (rung 2)', /^state: "private"$/m.test(md));
check('describedby + alternate LINKS present (the missing links)', md.includes('{rel="describedby"') && md.includes('{rel="alternate"'));
check('CONTROLS present from the descriptor affordances (the missing controls)', md.includes(':::control ') && md.includes(`rel: "${IEP}canDecrypt"`) && md.includes(`rel: "${IEP}renderView"`));
check('the hostile ::: line did NOT crash + is neutralized (not a live fence)', md.includes(' :::not-a-real-fence'));

const doc = parseHypermediaMarkdown(md);
check('parses back; identity is the dereferenceable HTTPS view URL (NOT a urn)', doc.id === viewUrl && !doc.id.startsWith('urn:'), doc.id);
check('two controls parsed', doc.controls.length === 2, String(doc.controls.length));
check('authority closure: every control target is a fragment of the view URL', md.match(/^target: "([^"]+)"$/gm)!.every((l) => l.includes(`"${viewUrl}#control-`)));
check('NO transport endpoint leaked (the descriptor hydra:targets never appear)', !md.includes('css.internal') && !md.includes('envelope.jose.json') && !md.includes('hydra/core#target'));

// The exact graph shape `remember` builds: schema:text as a JSON-escaped
// single-quoted literal with embedded newlines. Confirms the memory body
// renders as multi-line prose (rung 1), not a mangled single line.
const memBody = 'First line of the memory.\nSecond line with a "quote".\nThird line.';
const rememberGraph = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix dct: <http://purl.org/dc/terms/> .
<urn:graph:memory:example-123> a ieh:AgentMemory, schema:NoteDigitalDocument ;
  schema:name "A remembered note" ;
  schema:text ${JSON.stringify(memBody)} ;
  dct:created "2026-07-13T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`;
const memMd = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle: rememberGraph });
check('remember-shaped memory: title becomes the H1', memMd.includes('# A remembered note'));
check('remember-shaped memory: multi-line body renders as prose (newlines survive)', memMd.includes('First line of the memory.') && memMd.includes('Second line with a "quote".') && memMd.includes('Third line.'));
check('remember-shaped memory: still private + parses', /^state: "private"$/m.test(memMd) && parseHypermediaMarkdown(memMd).id === viewUrl);

// PAYLOAD-level controls declared in the signed graph must be projected too,
// tagged with their source (signed-payload) distinct from descriptor controls
// (canDecrypt/renderView). Regression for georgio's "signed payload controls are
// not projected" gap.
const payloadGraph = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:graph:memory:with-controls> a ieh:AgentMemory ;
  schema:name "Memory with payload controls" ;
  schema:text "A claim you can ask about or propose a correction to." ;
  iep:affordance <#ask>, <#propose-correction> .
<#ask> a iep:Affordance, hydra:Operation ;
  iep:action <${IEP}ask> ; hydra:target <urn:graph:memory:with-controls#ask> ;
  hydra:method "POST" ; hydra:expects <${IEP}AskInputShape> .
<#propose-correction> a iep:Affordance, hydra:Operation ;
  iep:action <${IEP}proposeCorrection> ; hydra:target <urn:graph:memory:with-controls#pc> ;
  hydra:method "POST" .`;
// graphIri = the payload's canonical graph IRI (in production the descriptor's
// iep:describes; here the shared descriptorTurtle describes a different graph, so
// pass it explicitly — exercising the override path).
const pmMd = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle: payloadGraph, graphIri: 'urn:graph:memory:with-controls' });
check('payload controls PROJECTED: ask present (was dropped before)', pmMd.includes(`rel: "${IEP}ask"`));
check('payload controls PROJECTED: proposeCorrection present', pmMd.includes(`rel: "${IEP}proposeCorrection"`));
check('descriptor controls STILL present (canDecrypt/renderView)', pmMd.includes(`rel: "${IEP}canDecrypt"`) && pmMd.includes(`rel: "${IEP}renderView"`));
check('payload control carries source = the signed payload graph (authority distinction)', /source: "urn:graph:memory:with-controls"/.test(pmMd));
check('descriptor control carries source = the signed descriptor', new RegExp(`source: "${authority.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"`).test(pmMd));
check('payload control input shape (expects) surfaced', pmMd.includes(`expects: "${IEP}AskInputShape"`));
{
  const back = parseHypermediaMarkdown(pmMd);
  const ask = back.controls.find((c) => c.action === `${IEP}ask`);
  check('round-trips: ask control parses with its source', !!ask && ask.source === 'urn:graph:memory:with-controls');
  check('still authority-closed + no transport leak', !pmMd.includes('hydra/core#target'));
}

// ── georgio's live-projection bugs (fresh-publish smoke test) ──────────────────
const HMD = 'https://markjspivey-xwisee.github.io/interego/ns/hmd#';

// BUG X: authority-closed HMD controls carry NO hydra:target by design (the target
// is re-computed as <@id>#control-*). The target-required extractor silently
// dropped them, so georgio's three payload controls projected as ZERO — only the
// 2 descriptor controls showed, with no error.
const targetlessPayload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <${HMD}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:graph:memory:tl> a ieh:AgentMemory ;
  schema:name "Target-less controls" ;
  schema:text "acknowledge / ask / correct — none carry a transport target." ;
  hmd:control <#acknowledge>, <#ask>, <#propose-correction> .
<#acknowledge> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}acknowledge> ; hydra:method "POST" .
<#ask> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}ask> ; hydra:method "POST" ; hydra:expects <#AskShape> .
<#propose-correction> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}proposeCorrection> ; hydra:method "POST" .`;
const tlMd = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle: targetlessPayload, graphIri: 'urn:graph:memory:tl' });
check('BUG X: target-less payload controls PROJECT (were silently dropped)', tlMd.includes(`rel: "${IEP}acknowledge"`) && tlMd.includes(`rel: "${IEP}ask"`) && tlMd.includes(`rel: "${IEP}proposeCorrection"`));
check('BUG X: all 5 controls present (2 descriptor + 3 target-less payload)', (tlMd.match(/:::control /g) || []).length === 5, String((tlMd.match(/:::control /g) || []).length));
check('BUG X: still authority-closed — every control target is a fragment of the view URL, no transport leak', !tlMd.includes('hydra/core#target') && (tlMd.match(/^target: "([^"]+)"$/gm) || []).every((l) => l.includes(`"${viewUrl}#control-`)));

// BUG Y: a control whose input shape is a RELATIVE fragment IRI (`#AskShape`) must
// NOT throw (my PR #22 pushed expects through the throwing term-resolver), and the
// emitted expects must be resolved absolute against the payload source.
check('BUG Y: relative #AskShape expects does NOT throw + resolves absolute', tlMd.includes('expects: "urn:graph:memory:tl#AskShape"'), 'want urn:graph:memory:tl#AskShape');
check('BUG Y: expects round-trips back on the parsed control', parseHypermediaMarkdown(tlMd).controls.some((c) => c.expects === 'urn:graph:memory:tl#AskShape'));

// BUG Z: a note whose OWN text opens with an ATX H1 must render exactly one H1 —
// prepending `# ${title}` on top of it produced a duplicate (georgio saw H1 x2).
const h1Payload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
<urn:graph:memory:h1> a ieh:AgentMemory ;
  schema:name "Progressive enhancement" ;
  schema:text "# Progressive enhancement\\n\\nProse first, then front matter, then controls." .`;
const zMd = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle: h1Payload });
check('BUG Z: note text opening with its own H1 yields exactly ONE H1 (no dup title)', (zMd.match(/^# /gm) || []).length === 1, String((zMd.match(/^# /gm) || []).length));
check('BUG Z: a plain-prose note still gets the title H1', /^# Inline Markdown presentation preference$/m.test(md));

// ── get_descriptor inline projection (inlineRenderedForDescriptor) ─────────────
// The verifiable, no-bearer re-fetch surface. Must project payload controls AND
// never leak the internal pod host that a normalized descriptor URL carries.
const PUBLIC_BASE = 'https://relay.interego.xwisee.com';
const DESC_ID = 'urn:graph:memory:georgio-progressive-enhancement-demo-20260714';
const RENDER_TARGET = `${PUBLIC_BASE}/render/${encodeURIComponent(DESC_ID)}`;
const INTERNAL_DESC_URL = 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/context-graphs/desc-geo.ttl';
// Persisted-descriptor shape: a host-free renderView target + a canDecrypt whose
// hydra:target is the INTERNAL envelope accessURL (must never be picked as identity).
const persistedDescriptor = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
<> a iep:ContextDescriptor ; iep:describes <${DESC_ID}> ;
  iep:affordance [ a iep:Affordance, hydra:Operation ; iep:action iep:canDecrypt ; hydra:target <https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/context-graphs/geo.envelope.jose.json> ; hydra:method "GET" ] ,
    [ a iep:Affordance, hydra:Operation ; iep:action iep:renderView ; hydra:method "GET" ; hydra:target <${RENDER_TARGET}> ; dcat:mediaType "text/markdown; charset=UTF-8; variant=CommonMark" ] .`;
const georgioPayload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <https://markjspivey-xwisee.github.io/interego/ns/hmd#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<${DESC_ID}> a ieh:AgentMemory, schema:NoteDigitalDocument ;
  schema:name "Progressive enhancement" ;
  schema:text "A claim you can acknowledge, ask about, or propose a correction to." ;
  hmd:control <#acknowledge>, <#ask-question>, <#propose-correction> .
<#acknowledge> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}acknowledge> ; hydra:method "POST" ; hydra:expects <${IEP}AcknowledgeInputShape> .
<#ask-question> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}askQuestion> ; hydra:method "POST" ; hydra:expects <${IEP}AskQuestionInputShape> .
<#propose-correction> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}proposeCorrection> ; hydra:method "POST" ; hydra:expects <${IEP}ProposeCorrectionInputShape> .`;

const gd = inlineRenderedForDescriptor({ descriptorUrl: INTERNAL_DESC_URL, descriptorTurtle: persistedDescriptor, plaintextTurtle: georgioPayload, publicBase: PUBLIC_BASE, port: 8080 });
check('get_descriptor: private note projects (non-null) with HMD media type', !!gd && gd.mediaType === HYPERMEDIA_MARKDOWN_MEDIA_TYPE);
check('get_descriptor: all three payload controls project', !!gd && gd.rendered.includes(`rel: "${IEP}acknowledge"`) && gd.rendered.includes(`rel: "${IEP}askQuestion"`) && gd.rendered.includes(`rel: "${IEP}proposeCorrection"`));
check('get_descriptor: input shapes surface', !!gd && gd.rendered.includes(`expects: "${IEP}AcknowledgeInputShape"`) && gd.rendered.includes(`expects: "${IEP}AskQuestionInputShape"`));
check('get_descriptor: descriptor renderView control still projects', !!gd && gd.rendered.includes(`rel: "${IEP}renderView"`));
check('get_descriptor: NO internal-host leak (envelope accessURL / .internal. host never enter)', !!gd && !gd.rendered.includes('.internal.') && !gd.rendered.includes('envelope'));
check('get_descriptor: identity is the advertised HOST-FREE render target (not a urn, not internal)', !!gd && parseHypermediaMarkdown(gd.rendered).id === RENDER_TARGET);
check('get_descriptor: authority closure — every control target is a fragment of the host-free identity', !!gd && (gd.rendered.match(/^target: "([^"]+)"$/gm) || []).every((l) => l.includes(`"${RENDER_TARGET}#control-`)));
// Fail-closed + gate cases.
check('get_descriptor: null payload → null (E2EE fail-closed for a non-recipient)', inlineRenderedForDescriptor({ descriptorUrl: INTERNAL_DESC_URL, descriptorTurtle: persistedDescriptor, plaintextTurtle: null, publicBase: PUBLIC_BASE, port: 8080 }) === null);
check('get_descriptor: non-note-like payload → null', inlineRenderedForDescriptor({ descriptorUrl: PUBLIC_BASE + '/u/x.ttl', descriptorTurtle: persistedDescriptor, plaintextTurtle: '@prefix owl: <http://www.w3.org/2002/07/owl#> . <urn:x> a owl:Ontology .', publicBase: PUBLIC_BASE, port: 8080 }) === null);
check('get_descriptor: internal descriptor URL + NO renderView target → null (leak-safe skip)', inlineRenderedForDescriptor({ descriptorUrl: INTERNAL_DESC_URL, descriptorTurtle: `@prefix iep: <${IEP}> . <> a iep:ContextDescriptor .`, plaintextTurtle: georgioPayload, publicBase: PUBLIC_BASE, port: 8080 }) === null);
{
  const pubDesc = `${PUBLIC_BASE}/u-pk-x/context-graphs/1.ttl`;
  const gpub = inlineRenderedForDescriptor({ descriptorUrl: pubDesc, descriptorTurtle: `@prefix iep: <${IEP}> . <> a iep:ContextDescriptor .`, plaintextTurtle: georgioPayload, publicBase: PUBLIC_BASE, port: 8080 });
  check('get_descriptor: public descriptor URL + no renderView target → non-null, host-free fallback identity', !!gpub && parseHypermediaMarkdown(gpub.rendered).id === `${PUBLIC_BASE}/render/${encodeURIComponent(pubDesc)}`);
}

// ── georgio retest residuals: stable canonical provenance + body dedent ────────
// #2: the control `source` + relative-shape base must be the CANONICAL graph IRI
// (descriptor's iep:describes), IDENTICAL across the publish hand-back (authored
// subject) and a re-fetch (relay-reminted subject) — georgio saw them disagree
// (urn:memory:… vs urn:iep:…), neither equal to the named graph IRI.
const CANON = 'urn:graph:memory:stable-canon-xyz';
const descWithDescribes = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://relay/desc.ttl> a iep:ContextDescriptor ; iep:describes <${CANON}> ; iep:affordance <#renderView> .
<#renderView> a iep:Affordance ; iep:action <${IEP}renderView> ; hydra:target <https://relay/render/x> ; hydra:method "GET" .`;
const authoredPayload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <https://markjspivey-xwisee.github.io/interego/ns/hmd#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:memory:authored-form> a ieh:AgentMemory ; schema:name "Stable" ; schema:text "x" ; hmd:control <#ask> .
<#ask> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}ask> ; hydra:method "POST" ; hydra:expects <#AskShape> .`;
const remintedPayload = authoredPayload.replace(/urn:memory:authored-form/g, 'urn:iep:u-pk-x:1784000000000');
const pubMd = noteToHyperMarkdown({ viewUrl: 'https://relay/render/x', authority: 'https://relay/desc.ttl', descriptorTurtle: descWithDescribes, plaintextTurtle: authoredPayload });
const getMd = noteToHyperMarkdown({ viewUrl: 'https://relay/render/x', authority: 'https://relay/desc.ttl', descriptorTurtle: descWithDescribes, plaintextTurtle: remintedPayload });
check('residual #2: control source is the CANONICAL describes IRI, not the payload subject', pubMd.includes(`source: "${CANON}"`) && !pubMd.includes('urn:memory:authored-form"'));
check('residual #2: relative #AskShape resolves against the CANONICAL IRI', pubMd.includes(`expects: "${CANON}#AskShape"`));
check('residual #2: publish hand-back + re-fetch tag IDENTICAL source/expects bases', getMd.includes(`source: "${CANON}"`) && getMd.includes(`expects: "${CANON}#AskShape"`) && !getMd.includes('urn:iep:u-pk-x'));
const descNoDescribes = `@prefix iep: <${IEP}> . <https://relay/desc.ttl> a iep:ContextDescriptor .`;
const ovMd = noteToHyperMarkdown({ viewUrl: 'https://relay/render/x', authority: 'https://relay/desc.ttl', descriptorTurtle: descNoDescribes, plaintextTurtle: authoredPayload, graphIri: CANON });
check('residual #2: explicit graphIri override (publish_context) tags the canonical base', ovMd.includes(`source: "${CANON}"`) && ovMd.includes(`expects: "${CANON}#AskShape"`));

// #3: a uniformly-indented stored text literal must NOT render as a CommonMark
// code block on re-fetch (georgio: "    This signed…" became a code block).
const indentedTextPayload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
<urn:graph:memory:z> a ieh:AgentMemory ; schema:name "Indented" ;
  schema:text """    This signed note
    spans two lines.""" .`;
const idMd = noteToHyperMarkdown({ viewUrl: 'https://relay/render/x', authority: 'https://relay/desc.ttl', descriptorTurtle: descWithDescribes, plaintextTurtle: indentedTextPayload });
check('residual #3: note prose present, dedented (no >=4-space code-block indent)', idMd.includes('This signed note') && idMd.includes('spans two lines') && !/\n {4,}This signed note/.test(idMd) && !/\n {4,}spans two lines/.test(idMd));

console.log(`\n${ok}/${ok + bad} note-view checks passed`);
process.exit(bad === 0 ? 0 : 1);
