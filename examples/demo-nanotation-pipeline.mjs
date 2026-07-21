// Cool demo: Nanotation-in-markdown → typed Interego descriptor.
//
// Kingsley Idehen's nanotation pattern: embed RDF (Turtle) inside
// markdown using delimiter markers, so a blog post or README can
// carry structured facts that get lifted into a knowledge graph
// when published. His delimiters:
//
//    |## {Structured Data Notation} Start ##|
//    ... Turtle ...
//    |## {Structured Data Notation} End ##|
//
// This demo extends the idea: the embedded Turtle uses RDF 1.2
// triple-term annotations (`{| ... |}`) to attach facet metadata
// to each triple, and the pipeline lifts the whole thing into a
// full `iep:ContextDescriptor` with all seven facets — not just
// flat RDF. Nanotation's portability + Interego's typed context.
//
// Result: a blog post becomes federated, attributable, trust-tagged,
// queryable memory for any agent.

import {
  ContextDescriptor,
  toTurtle,
  validate,
  withRdf12VersionDirective,
  detectRdf12Features,
  langString,
} from '../dist/index.js';

// ── Example source: a markdown blog post with nanotation ──

const markdownSource = `# On the curious emergence of vocabulary alignment

By Mark Spivey, 2026-04-24.

I've been running the vocabulary-emergence demo with different parameters.
A few observations worth sharing:

|## Nanotation Start ##|

@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix cts:  <https://markjspivey-xwisee.github.io/interego/ns/cts#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <urn:observation:> .

ex:convergence-rate-obs-1
    a cts:Pattern ;
    cts:observation "45 rounds with 9 subjects and threshold 3 reaches reliable convergence"@en ;
    cts:confidence "0.92"^^xsd:double ;
    cts:observedBy <urn:agent:mark> {| iep:modalStatus iep:Asserted ; iep:epistemicConfidence "0.92"^^xsd:double |} .

ex:threshold-sensitivity-obs-2
    a cts:Pattern ;
    cts:observation "Lowering threshold from 3 to 2 accelerates convergence but increases false-positive alignments"@en ;
    cts:confidence "0.75"^^xsd:double ;
    cts:observedBy <urn:agent:mark> {| iep:modalStatus iep:Hypothetical ; iep:epistemicConfidence "0.75"^^xsd:double |} .

|## Nanotation End ##|

These are preliminary; I'd love if others would re-run with different
parameters and attest to or dispute the findings.

|## Nanotation Start ##|

ex:call-for-replication
    a cts:Pattern ;
    cts:observation "Call for replication on convergence-rate-obs-1"@en ;
    cts:relatesTo ex:convergence-rate-obs-1 ;
    cts:observedBy <urn:agent:mark> {| iep:modalStatus iep:Asserted |} .

|## Nanotation End ##|
`;

// ── Step 1: Extract nanotation blocks ──

function extractNanotation(markdown) {
  const re = /\|## Nanotation Start ##\|([\s\S]*?)\|## Nanotation End ##\|/g;
  const blocks = [];
  let m;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

console.log('=== Nanotation-in-markdown → Interego descriptor ===\n');
console.log(`Source: blog post (${markdownSource.length} chars, ${markdownSource.split('\n').length} lines).\n`);

const blocks = extractNanotation(markdownSource);
console.log(`Step 1 — extracted ${blocks.length} nanotation block(s) from the post.\n`);

// ── Step 2: Detect RDF 1.2 features + concatenate ──

const rawTtl = blocks.join('\n\n# ── block boundary ──\n\n');
const features = detectRdf12Features(rawTtl);

console.log(`Step 2 — RDF 1.2 feature detection on the extracted Turtle:`);
console.log(`   hasTripleAnnotations:    ${features.hasTripleAnnotations}`);
console.log(`   hasDirectionalLangTags:  ${features.hasDirectionalLangTags}`);
console.log(`   hasVersionDirective:     ${features.hasVersionDirective}`);
console.log(`   isRdf12 overall:         ${features.isRdf12}\n`);

// ── Step 3: Wrap with the @version directive so downstream parsers
// know this is 1.2 content (triple-annotations require 1.2 semantics). ──

const normalized = withRdf12VersionDirective(rawTtl);
console.log(`Step 3 — normalized Turtle with RDF 1.2 version directive prepended:`);
console.log('─'.repeat(60));
console.log(normalized.split('\n').slice(0, 10).join('\n'));
console.log('   ... (truncated) ...');
console.log('─'.repeat(60));
console.log();

// ── Step 4: Build a iep:ContextDescriptor for the whole piece. ──
//
// Nanotation gives us the GRAPH (the triples). Interego wraps it
// with the seven facets: who authored, when, what modal state, what
// trust, where it lives. That's the lift from "some RDF in a blog
// post" to "a first-class federated typed-context descriptor".

const postGraphIri = 'urn:graph:blog:mark/vocabulary-emergence-notes-2026-04-24';
const postDescriptorIri = 'urn:iep:blog:mark/vocabulary-emergence-notes-2026-04-24';
const author = 'urn:agent:mark';
const ownerWebId = 'https://identity.interego.xwisee.com/users/markj/profile#me';
const podUrl = 'https://gate.interego.xwisee.com/markj/';
const postedAt = new Date().toISOString();

const descriptor = ContextDescriptor.create(postDescriptorIri)
  .describes(postGraphIri)
  .temporal({ validFrom: postedAt })
  .validFrom(postedAt)
  .delegatedBy(ownerWebId, author, { endedAt: postedAt })
  .semiotic({
    // Post-level semiotic: the post itself is Asserted (the author
    // meant to publish this). Individual claims within carry their
    // own per-triple modal status via triple annotations.
    modalStatus: 'Asserted',
    epistemicConfidence: 0.9,
    groundTruth: true,
  })
  .trust({ trustLevel: 'SelfAsserted', issuer: ownerWebId })
  .federation({
    origin: podUrl,
    storageEndpoint: podUrl,
    syncProtocol: 'SolidNotifications',
  })
  .version(1)
  .build();

const ttl = toTurtle(descriptor);
console.log('Step 4 — iep:ContextDescriptor wrapping the blog post\'s graph:');
console.log('─'.repeat(60));
console.log(ttl.split('\n').slice(0, 20).join('\n'));
console.log('   ... (truncated) ...');
console.log('─'.repeat(60));
console.log();

// ── Step 5: Validate against SHACL (our existing validator). ──

const validation = validate(descriptor);
console.log(`Step 5 — validation: ${validation.conforms ? '✓ descriptor conforms' : `✗ violations: ${validation.violations.length}`}`);
if (!validation.conforms) {
  for (const v of validation.violations) console.log(`   ${v.message}`);
}
console.log();

// ── Step 6: Demonstrate directional-language-tag support (a demo-specific
// bonus showing RDF 1.2 coverage extends to multilingual blog posts). ──

console.log('Step 6 — RDF 1.2 directional language tags for multilingual content:');
console.log(`   English:  ${langString('emergence is magic', 'en', 'ltr')}`);
console.log(`   Arabic:   ${langString('الظهور سحر', 'ar', 'rtl')}`);
console.log(`   Hebrew:   ${langString('ההופעה היא קסם', 'he', 'rtl')}`);
console.log('   A nanotation block could embed any of these as object literals.');
console.log();

// ── Output ──

console.log('── What this demonstrates ──');
console.log('   The blog post is plain markdown a human can read.');
console.log('   The nanotation blocks carry structured data a machine can parse.');
console.log('   RDF 1.2 triple annotations on each observation carry its');
console.log('   modal status + confidence — so downstream agents know which');
console.log('   claims the author is committing to (Asserted) vs floating');
console.log('   (Hypothetical).');
console.log('');
console.log('   The pipeline lifts the whole thing into a typed iep:ContextDescriptor');
console.log('   with seven facets. The post becomes federated, queryable,');
console.log('   attributable memory — discoverable by any agent on the user\'s pod.');
console.log('');
console.log('   Idehen\'s original nanotation pattern plus Interego\'s typed-context');
console.log('   wrapper. Neither alone is sufficient; together they produce the');
console.log('   story: write a blog post; your claims are first-class AI memory.');
