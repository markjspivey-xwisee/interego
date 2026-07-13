// A private note, decrypted, projected as a complete HyperMarkdown document —
// the fix for "why is there a URN, and no links or controls?". Proves the
// projection an authorized owner gets from GET /render?format=markdown:
// dereferenceable HTTPS identity, the note's own prose, its controls (from the
// descriptor's affordances), describedby/alternate links, private state,
// authority-closed control targets, and no transport endpoint in the bytes.
import { noteToHyperMarkdown } from './note-view.js';
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

console.log(`\n${ok}/${ok + bad} note-view checks passed`);
process.exit(bad === 0 ? 0 : 1);
