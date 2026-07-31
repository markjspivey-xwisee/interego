#!/usr/bin/env tsx
/**
 * Following a page's own advertised Turtle representation.
 *
 * ★ WHY THIS EXISTS. Our ontology IRIs do not content-negotiate — GitHub Pages ignores
 * Accept and serves `text/html` for `https://…/ns/iep`. That bit the publish path three
 * separate times: a good shape looked unreachable, an `owl:imports` of one corrupted the
 * graph it was glued into, and last-known-good had to distrust any body that did not parse.
 *
 * The fix follows the `<link rel="alternate" type="text/turtle">` the page already
 * publishes. That parsing is a regex over untrusted markup — exactly the kind of thing
 * that quietly matches nothing and reports success. So the first case below is the REAL
 * published markup, byte for byte, not a hand-written approximation of it.
 *
 * ★ Both functions were mutation-checked: an ordered rel-then-type regex (the version
 * first written here) fails 'attribute order' and 'unquoted attributes'; a looksLikeHtml
 * that matches any leading '<' fails 'does NOT mistake Turtle for HTML'.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/alternate-turtle-link.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { alternateTurtleHref, looksLikeHtml } from '../alternate-turtle.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string): void {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}`);
  }
}

/**
 * Captured verbatim from https://markjspivey-xwisee.github.io/interego/ns/iep.
 * If the generator changes how it writes these tags this test fails — which is the point.
 * A live shape fetch would otherwise start silently returning nothing.
 */
const REAL_PUBLISHED_HEAD = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<title>Interego Protocol 1.0</title>
<link rel="alternate" type="text/turtle" href="iep.ttl" />
<link rel="describedby" type="text/turtle" href="iep.ttl" />
`;

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\nalternateTurtleHref');

  ok(
    alternateTurtleHref(REAL_PUBLISHED_HEAD) === 'iep.ttl',
    'finds the Turtle our own published ontology pages advertise',
  );

  ok(
    new URL(
      alternateTurtleHref(REAL_PUBLISHED_HEAD)!,
      'https://markjspivey-xwisee.github.io/interego/ns/iep',
    ).toString() === 'https://markjspivey-xwisee.github.io/interego/ns/iep.ttl',
    'resolves that href against the IRI that served it',
  );

  // HTML does not fix attribute order. An ordered rel-then-type regex passes a
  // hand-written test and then misses real markup written the other way round.
  ok(
    alternateTurtleHref('<link type="text/turtle" rel="alternate" href="a.ttl">') === 'a.ttl'
    && alternateTurtleHref('<link href="b.ttl" rel="describedby" type="text/turtle">') === 'b.ttl',
    'does not depend on attribute order',
  );

  ok(
    alternateTurtleHref('<link  rel = alternate  type = text/turtle  href="c.ttl" >') === 'c.ttl',
    'tolerates unquoted attributes and odd whitespace',
  );

  ok(
    alternateTurtleHref([
      '<link rel="stylesheet" href="s.css">',
      '<link rel="alternate" type="application/rdf+xml" href="x.rdf">',
      '<link rel="icon" href="f.png">',
    ].join('\n')) === null,
    'ignores links that are not Turtle',
  );

  // rel=preload names a resource to go fetch, not an alternate encoding of THIS page.
  // Following one would glue an unrelated graph into the shapes graph.
  ok(
    alternateTurtleHref('<link rel="preload" type="text/turtle" href="other.ttl">') === null,
    'ignores a Turtle link that is not a representation of this resource',
  );

  ok(
    alternateTurtleHref('<html><body><p>404</p></body></html>') === null
    && alternateTurtleHref('') === null,
    'returns null rather than throwing on markup with no links',
  );

  // eslint-disable-next-line no-console
  console.log('\nlooksLikeHtml');

  ok(looksLikeHtml(REAL_PUBLISHED_HEAD), 'recognises the real published page');

  ok(
    looksLikeHtml('\n\n  <!DOCTYPE html><html>')
    && looksLikeHtml('﻿<html lang="en">')
    && looksLikeHtml('<!-- generated --><html>'),
    'recognises HTML behind leading whitespace, a BOM, or a comment',
  );

  // ★ The dangerous direction is a FALSE POSITIVE here: Turtle is full of angle brackets,
  // and a careless predicate sends a perfectly good shape down the HTML path and drops it.
  ok(
    !looksLikeHtml('<https://example.org/s> a <https://example.org/C> .')
    && !looksLikeHtml('@prefix sh: <http://www.w3.org/ns/shacl#> .\n<#S> a sh:NodeShape .')
    && !looksLikeHtml('# a comment\n<#S> sh:closed true .'),
    'does NOT mistake Turtle for HTML',
  );

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
