#!/usr/bin/env tsx
/**
 * A conformance PASS says what it was tested against — or it is refused.
 *
 * ── ★★ THE DEFECT THIS SUITE PINS ────────────────────────────────────────────
 *
 * Validating against a shapes graph that declares no shapes conforms. That is arguably
 * correct SHACL — §1.5, nothing is violated when nothing constrains — and the verdict is not
 * the defect. The defect is that the answer could not be told apart from a real one.
 * Re-measured here rather than taken on report, against `@interego/core`'s own engine and
 * this repo's own published documents:
 *
 *     data: an ieh:AgentTurn missing its REQUIRED ieh:turnOutcome
 *     vs docs/ns/harness-shapes.ttl   conforms=false  results=1
 *     vs docs/ns/harness.ttl          conforms=true   results=0    ← the ONTOLOGY, 0 shapes
 *     vs a descriptor document        conforms=true   results=0
 *     vs "# nothing\n"                conforms=true   results=0
 *
 * The last three are byte-identical to a clean pass on every field the report used to carry.
 * A caller who named the wrong URL was told their contract held when it had never run — a
 * success that ends the enquiry without answering it, which is worse than a failure, because
 * a failure sends the caller back to look.
 *
 * ── ★★ WHY "A 422 CAME BACK" AND "conforms IS TRUE" PROVE NOTHING HERE ───────
 *
 * Both hold before and after the change, for every case. A check that passes two ways is
 * evidence for neither. So §1 asserts that the OLD fields are INDISTINGUISHABLE across a real
 * pass and a vacuous one — if that assertion ever fails, the discrimination this suite claims
 * for `shapesDeclared` is coming from somewhere else and the rest of the suite is measuring
 * the wrong thing.
 *
 * ── WHY A UNIT SUITE ─────────────────────────────────────────────────────────
 *
 * `server.ts` opens a listener on import, so nothing decided there can be executed by a test
 * — the same reason `shape-body.ts` exists — which is why the refuse/report decision lives in
 * `shapes-declared.ts`. And a live run exercises the honest path only: production callers
 * name real shape files, so production cannot tell a relay that detects a shapeless one from
 * a relay that does not. §5 is the exception that has to be read off the source, and it pins
 * an ordering hazard that a behavioural test of this module structurally cannot see.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/shapes-declared-not-silent.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { validateAgainstShape } from '@interego/core';

import {
  refusesEmptyShapesGraph,
  emptyShapesGraphViolation,
  summarizeConformance,
  iriObjectsOf,
  type ShapeCoverage,
  type ConformanceSummary,
} from '../shapes-declared.js';
import { listenLoopback } from './listen-loopback.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const nsDoc = (f: string): string =>
  readFileSync(join(here, '..', '..', '..', 'docs', 'ns', f), 'utf8');

/**
 * A turn record MISSING `ieh:turnOutcome`, which `ieh:AgentTurnShape` declares `sh:minCount 1`.
 *
 * ★ NOT A SYNTHETIC FIXTURE, ON PURPOSE. This is the shape of the document
 * `packages/workspace-client/src/turnrecord.ts` publishes, and the constraint its own ★★
 * comment says is enforced at the relay. Using the real published shapes file means the
 * measurement below cannot be an artefact of a fixture written to produce it.
 */
const TURN_MISSING_OUTCOME = `
@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<https://relay.example/ns/p/agent-turns/t/x1> a ieh:AgentTurn ;
  prov:wasAssociatedWith <did:ethr:0xabc> ;
  prov:startedAtTime "2026-08-24T00:00:00Z"^^xsd:dateTime ;
  iep:modalStatus "Asserted" .
`;

/** A descriptor document — good Turtle, real vocabulary, and not a shapes graph. */
const DESCRIPTOR_DOC = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
<https://pod.example/ctx/desc-graph> a iep:ContextDescriptor ;
  dct:title "What descriptorUrl actually serves" ;
  iep:hasTemporalFacet [ a iep:TemporalFacet ] .
`;

const OPTS = { entailment: 'rdfs', conformanceDisallows: ['Violation'] } as const;

async function main(): Promise<void> {
  // ── §1 The silence, reproduced — and proved to BE silence ──────────────────
  {
    const real = validateAgainstShape(TURN_MISSING_OUTCOME, nsDoc('harness-shapes.ttl'), OPTS);
    const ontology = validateAgainstShape(TURN_MISSING_OUTCOME, nsDoc('harness.ttl'), OPTS);
    const descriptor = validateAgainstShape(TURN_MISSING_OUTCOME, DESCRIPTOR_DOC, OPTS);
    const blank = validateAgainstShape(TURN_MISSING_OUTCOME, '# nothing here\n', OPTS);

    ok(real.conforms === false && real.results.length === 1,
      '§1 the REAL shapes file rejects a turn record with no outcome',
      `conforms=${real.conforms} results=${real.results.length}`);

    // A clean pass against a shapes file that genuinely applies: same document, an outcome added.
    const clean = validateAgainstShape(
      TURN_MISSING_OUTCOME.replace('iep:modalStatus "Asserted" .',
        'ieh:turnOutcome ieh:Posted ; iep:modalStatus "Asserted" .'),
      nsDoc('harness-shapes.ttl'), OPTS);
    ok(clean.conforms === true && clean.results.length === 0,
      '§1 a genuine clean pass: real shapes, real target, nothing wrong');

    // ★★ THE LOAD-BEARING NEGATIVE. Every field the report carried BEFORE this change reads
    // identically for the genuine pass and for all three vacuous ones. If this ever fails,
    // the discrimination asserted below is coming from somewhere else.
    for (const [name, r] of [['the ontology', ontology], ['a descriptor', descriptor], ['a blank doc', blank]] as const) {
      ok(r.conforms === clean.conforms
        && r.results.length === clean.results.length
        && r.fullyChecked === clean.fullyChecked,
        `§1 validating against ${name} is INDISTINGUISHABLE from a clean pass on conforms/results/fullyChecked`,
        `conforms=${r.conforms} results=${r.results.length} fullyChecked=${r.fullyChecked}`);
    }

    // ── The field that ends the silence ──
    ok(ontology.shapesDeclared === 0,
      '§1 docs/ns/harness.ttl declares ZERO shapes — the shapes live in harness-shapes.ttl',
      `declared=${ontology.shapesDeclared}`);
    ok(descriptor.shapesDeclared === 0,
      '§1 a descriptor document declares ZERO shapes');
    ok(blank.shapesDeclared === 0, '§1 a blank document declares ZERO shapes');
    ok(real.shapesDeclared > 0 && clean.shapesDeclared > 0,
      '§1 the real shapes file declares shapes, so zero is not simply what this engine always says',
      `real=${real.shapesDeclared}`);
    ok(clean.shapesApplied > 0,
      '§1 and a genuine pass reports that a shape ACTUALLY selected the turn record',
      `applied=${clean.shapesApplied}`);
  }

  // ── §2 declared > 0 with applied === 0 is ORDINARY, not a fault ────────────
  //
  // This is the case a blanket refusal would break, and the reason the gate keys on
  // `declared` alone. A contract targeting classes this graph does not carry applies nothing
  // and conforms — measured on two shapes files this repo actually publishes.
  {
    for (const f of ['iep-shapes.ttl', 'harness-shapes.ttl']) {
      const r = validateAgainstShape('@prefix dct: <http://purl.org/dc/terms/> .\n'
        + '<https://pod.example/n> dct:title "a plain note" .\n', nsDoc(f), OPTS);
      ok(r.shapesDeclared > 0 && r.shapesApplied === 0 && r.conforms === true,
        `§2 ${f} declares shapes, applies none to an unrelated graph, and conforms`,
        `declared=${r.shapesDeclared} applied=${r.shapesApplied}`);
    }
  }

  // ── §3 The decision: refuse the CALLER, report the CONTAINER ───────────────
  {
    const cov = (source: 'caller' | 'container', declared: number, applied = 0): ShapeCoverage =>
      ({ shapeIri: 'https://example.test/s', source, declared, applied });

    ok(refusesEmptyShapesGraph(cov('caller', 0)) === true,
      '§3 a CALLER-named document declaring no shapes is REFUSED');
    ok(refusesEmptyShapesGraph(cov('container', 0)) === false,
      '§3 a CONTAINER-declared one is NOT refused — a pod dct:conformsTo is a profile '
      + 'assertion, and refusing it locks the pod out of the write that would fix it');
    ok(refusesEmptyShapesGraph(cov('caller', 20, 0)) === false,
      '§3 a caller-named file that declares shapes and applies none is NOT refused');
    ok(refusesEmptyShapesGraph(cov('caller', 1, 1)) === false,
      '§3 nor is one that applied');

    // ★ The 422 must name the LIKELY CAUSE. A refusal that says only "no shapes" sends the
    // reader to check whether their shapes file is broken; the mistake is almost always which
    // URL was passed, and `descriptorUrl` is the one the API hands back most prominently.
    const v = emptyShapesGraphViolation('https://pod.example/ctx/desc-graph');
    ok(v.constraintComponent
      === 'https://markjspivey-xwisee.github.io/interego/ns/iep#shapeDeclaresNoShapes',
      '§3 the refusal carries its own constraint component', v.constraintComponent);
    ok(v.message.includes('https://pod.example/ctx/desc-graph'),
      '§3 and names the shape IRI, which is the caller\'s own input');
    ok(/descriptorUrl/.test(v.message) && /ontology/.test(v.message),
      '§3 and points at the two documents this is nearly always confused with');
    // ★★ A CHECK THAT CANNOT FAIL IS NOT A CHECK. This read
    // `!/10\.|internal|css\./.test(v.message)` and passed for every input the function
    // accepts: the message interpolates exactly ONE value, the caller's own shape IRI, so no
    // argument could put `css.` or an RFC1918 address into it. The sentence beside it claimed
    // the message 'carries no host, address or pod path', which is not what was being tested
    // — two possible reasons to pass is evidence for neither. What IS worth pinning is that
    // the only absolute URL in the sentence is the one the caller sent, which is precisely what
    // a leak of the pod's internal host or of the relay's CSS origin would break.
    const urls = v.message.match(/https?:\/\/[^\s`'"]+/g) ?? [];
    ok(urls.length === 1 && urls[0] === 'https://pod.example/ctx/desc-graph',
      '§3 and the ONLY absolute URL in the refusal is the caller\'s own input — no pod host, '
      + 'no CSS origin, nothing the caller did not already know',
      JSON.stringify(urls));

    // It must NOT be the same component as an unfetchable shape: nothing failed here. The
    // request succeeded and the verdict was a correct trivial pass.
    ok(v.constraintComponent !== 'https://markjspivey-xwisee.github.io/interego/ns/iep#shapeUnfetchable',
      '§3 and is distinct from shapeUnfetchable — the fetch SUCCEEDED, so collapsing the two '
      + 'would send an operator hunting an outage that never happened');
  }

  // ── §4 The response can say it, and only shouts when it should ─────────────
  {
    const applied: ShapeCoverage = { shapeIri: 'https://x/a', source: 'container', declared: 20, applied: 3 };
    const inert: ShapeCoverage = { shapeIri: 'https://x/b', source: 'container', declared: 0, applied: 0 };
    const targetless: ShapeCoverage = { shapeIri: 'https://x/c', source: 'caller', declared: 20, applied: 0 };

    const containerTargetless: ShapeCoverage =
      { shapeIri: 'https://x/d', source: 'container', declared: 20, applied: 0 };

    ok(summarizeConformance([]) === undefined,
      '§4 no shapes ran → no conformance block, rather than an empty one claiming a gate');

    const goodOnly = summarizeConformance([applied, containerTargetless]);
    ok(goodOnly?.unenforced === undefined,
      '§4 `unenforced` is ABSENT when nothing is amiss — a key that is always present is a '
      + 'number the caller must remember to check, which is the silence again');
    ok(goodOnly?.validated.length === 2,
      '§4 while `validated` still reports declared/applied for each');
    ok(goodOnly?.validated.some(c => c.applied === 0),
      '§4 and a CONTAINER contract that applied nothing is ordinary — reported, never alarmed '
      + 'on, or the warning fires on nearly every publish and stops being read');

    const withInert = summarizeConformance([applied, inert]);
    ok(withInert?.unenforced?.length === 1 && withInert.unenforced[0]?.shapeIri === 'https://x/b',
      '§4 and APPEARS, naming the shape, as soon as one constrained nothing');
    ok(withInert?.unenforced?.[0]?.why === 'declares-no-shapes',
      '§4 saying WHICH of the two reasons — one word for both would be this unit\'s own defect '
      + 'moved into its remedy');
    ok(withInert?.validated.length === 2,
      '§4 without dropping it from `validated` — the caller sees the whole run');

    // ★★ THE CASE THE ZERO-DECLARED CHECK CANNOT REACH — AND THE PARAGRAPH THAT STOOD
    // HERE WAS BACKWARDS ABOUT IT. It said turnrecord.ts's `.../ns/harness` 'imports iep + pgsl
    // and lands at declared=41, applied=0'. That was arithmetic over two ontology files (33 + 8)
    // presented as a measurement. The relay's import resolver followed only the FIRST object of
    // a comma-separated list, so that document arrived declaring ZERO and the publish was
    // REFUSED 422 — the opposite outcome, on a call two of our own writers make. The resolver
    // is fixed (see `iriObjectsOf`) and §8 drives the result over the wire instead of computing
    // it. What survives is the SHAPE of the case: a caller naming an ontology that really does
    // import a shapeful document arrives with a healthy `declared` and an `applied` of zero,
    // and this field is the only thing that says so.
    const callerMissed = summarizeConformance([targetless]);
    ok(callerMissed?.unenforced?.length === 1
      && callerMissed.unenforced[0]?.why === 'targets-nothing-here',
      '§4 a CALLER-named shapes file that targets nothing in this graph is reported, which is '
      + 'the ontology-instead-of-shapes mistake that survives a healthy `declared`');
  }

  // ── §5 Source checks for the two things a unit test cannot execute ─────────
  {
    const server = readFileSync(join(here, '..', 'server.ts'), 'utf8');
    const gate = server.slice(server.indexOf('async function runConformanceGate'));
    const body = gate.slice(0, gate.indexOf('\n// ── Scope gate'));

    // ★★ ORDERING, AND IT IS THE HAZARD THIS UNIT NEARLY SHIPPED. An UNPARSEABLE DATA GRAPH
    // returns conforms:false with shapesDeclared:0, because the engine gives up before
    // compiling anything. Testing the zero first answers a malformed graph with "the shape you
    // named declares no shapes" — sending the caller to fix a shape IRI that was never the
    // problem, which is this unit's own defect class reintroduced one line down. The real
    // verdict must be returned BEFORE the coverage record is read.
    const verdictAt = body.indexOf('return { conforms: false, shape: shapeIri, violations: report.results }');
    const emptyAt = body.indexOf('refusesEmptyShapesGraph');
    ok(verdictAt > 0 && emptyAt > 0 && verdictAt < emptyAt,
      '§5 runConformanceGate returns a real violation BEFORE it considers zero-declared, so a '
      + 'malformed DATA graph is never reported as a shapeless shape',
      `verdict@${verdictAt} emptyCheck@${emptyAt}`);

    // The source split is only honest if attribution does not depend on the de-dup order
    // above it — the container copy wins there, so insertion order would silently downgrade a
    // caller-named document to the lenient branch.
    ok(/namedByCaller\.has\(shapeIri\)\s*\?\s*'caller'\s*:\s*'container'/.test(body),
      '§5 source is attributed by membership of the caller list, not by which loop added it');

    ok(/const namedByCaller = new Set\(callerShapeIris\)/.test(body),
      '§5 and that set is built from the caller argument itself');
  }

  // ── §6 The emitted IRI dereferences ────────────────────────────────────────
  {
    const ttl = nsDoc('iep.ttl');
    ok(/(^|\n)iep:shapeDeclaresNoShapes\s+a\s/.test(ttl),
      '§6 iep:shapeDeclaresNoShapes is declared in docs/ns/iep.ttl, so the 422 names a term '
      + 'a reader can resolve');
  }

  // ── §7 The import list is read WHOLE, and only where it is really written ──
  //
  // ★★ THIS IS THE SECTION THE OUTAGE NEEDED. `runConformanceGate` merges `owl:imports` into
  // the shape body before validating, and the extractor was `/owl:imports\s+<([^>]+)>/g` — a
  // global regex, which collects one object per OCCURRENCE of the predicate and therefore
  // stops at the first comma. Turtle writes a repeated predicate as an object list, and this
  // repo's own ontologies are written that way, so the merge silently lost everything after
  // the first import. Nothing here failed, because nothing here looked.
  {
    const HARNESS_IMPORTS = [
      'http://www.w3.org/ns/prov-o',
      'https://markjspivey-xwisee.github.io/interego/ns/pgsl#',
      'https://markjspivey-xwisee.github.io/interego/ns/iep#',
    ];
    const harness = nsDoc('harness.ttl');
    ok(JSON.stringify(iriObjectsOf(harness, 'owl:imports')) === JSON.stringify(HARNESS_IMPORTS),
      '§7 docs/ns/harness.ttl imports prov-o, pgsl AND iep — all three, in document order',
      JSON.stringify(iriObjectsOf(harness, 'owl:imports')));

    // ★ NON-VACUITY, AND THE WHOLE BLAST RADIUS IN ONE LINE. The shipped extractor, spelled
    // out here rather than described, so this assertion fails the day someone reverts to it.
    const shipped = (ttl: string): string[] =>
      [...ttl.matchAll(/owl:imports\s+<([^>]+)>/g)].map(m => m[1]!);
    ok(shipped(harness).length === 1 && shipped(harness)[0] === HARNESS_IMPORTS[0],
      '§7 …and the regex it replaced returned exactly ONE of them — prov-o, which is `http:`, '
      + 'which the egress guard refuses on scheme and then drops as non-fatal, which is how '
      + 'the merged body ended up being harness.ttl alone and declaring zero shapes',
      JSON.stringify(shipped(harness)));

    // Not one document: the object-list form is how this repo writes imports.
    const nsDir = join(here, '..', '..', '..', 'docs', 'ns');
    const truncated = readdirSync(nsDir).filter(f => f.endsWith('.ttl')).filter((f) => {
      const t = readFileSync(join(nsDir, f), 'utf8');
      return iriObjectsOf(t, 'owl:imports').length > shipped(t).length;
    });
    ok(truncated.length >= 10,
      '§7 and it truncated the import list of at least ten documents in docs/ns/, not just one',
      `${truncated.length}: ${truncated.join(', ')}`);
    ok(readdirSync(nsDir).filter(f => f.endsWith('.ttl'))
      .every(f => iriObjectsOf(readFileSync(join(nsDir, f), 'utf8'), 'owl:imports').length
        >= shipped(readFileSync(join(nsDir, f), 'utf8')).length),
      '§7 while never returning FEWER than the old one anywhere — the fix is strictly more of '
      + 'the same document, not a different reading of it');

    // ── The parser's own rules, each one a case that can be got wrong ──
    const P = 'owl:imports';
    ok(JSON.stringify(iriObjectsOf('<s> owl:imports <a> , <b> , <c> .', P)) === '["a","b","c"]',
      '§7 a `.`-terminated object list');
    ok(JSON.stringify(iriObjectsOf('<s> owl:imports <a> ,\n  <b> ;\n  rdfs:label "x" .', P)) === '["a","b"]',
      '§7 a `;`-terminated one, wrapped across lines, stops at the next predicate');
    ok(JSON.stringify(iriObjectsOf('<s> owl:imports <a> , # why\n  <b> .', P)) === '["a","b"]',
      '§7 a comment BETWEEN two objects is skipped, not treated as the end of the list');

    // ★★ AND THE THINGS IT MUST NOT FOLLOW. Every target here becomes a network request the
    // relay makes with its own egress credentials, so a false positive is not a cosmetic
    // over-read — the old regex followed a commented-out import and a quoted one alike.
    ok(iriObjectsOf('# owl:imports <http://elsewhere.example/x>\n<s> a <T> .', P).length === 0,
      '§7 a commented-out import is NOT fetched — the regex it replaced fetched it');
    ok(iriObjectsOf('<s> rdfs:comment "owl:imports <http://elsewhere.example/x>" .', P).length === 0,
      '§7 nor one quoted inside a string literal');
    // ★★ THE LEADING BOUNDARY, WHICH IS THE HALF THAT CAN ACTUALLY BE BROKEN. A document
    // binding a prefix that ENDS in the token hands the relay a fetch target it never meant
    // to offer. The reflex example — `iep:conformsToShape` — is NOT this: it is refused by
    // `collectObjectList` whether the boundary is checked or not, and a mutation confirmed a
    // test of it passes with the boundary removed. Both are asserted; only one is evidence.
    ok(iriObjectsOf('<s> myowl:imports <http://elsewhere.example/x> .', P).length === 0,
      '§7 a prefixed name that merely ENDS in `owl:imports` is not `owl:imports` — otherwise '
      + 'the document chooses a target for the relay\'s own egress');
    ok(iriObjectsOf('<s> owl:importsFrom <a> .', P).length === 0,
      '§7 nor does `owl:importsFrom` match — the token has to end where it ends');
    ok(iriObjectsOf('<s> iep:conformsToShape <urn:iep:shape:X> .', 'iep:conformsTo').length === 0,
      '§7 and `iep:conformsToShape`, which descriptors in this repo really do carry, is never '
      + 'read as a container shape declaration and fetched as a `urn:`');
    ok(JSON.stringify(iriObjectsOf('<s> dct:conformsTo "a profile name" , <c> .', 'dct:conformsTo'))
      === '["c"]',
      '§7 a LITERAL in the middle of the list is stepped over, not treated as its end — '
      + 'stopping there would drop the IRI after it, which is the same silent under-read as '
      + 'reading only the first object, reached from the other side');
    ok(JSON.stringify(iriObjectsOf('<s> dct:conformsTo <a> , ex:pname , <c> .', 'dct:conformsTo'))
      === '["a"]',
      '§7 while a prefixed name, which has no delimiter this scanner can find, STOPS the list '
      + 'rather than being guessed past — an invented IRI here is an invented fetch');
    ok(iriObjectsOf('<s> owl:imports <unterminated', P).length === 0,
      '§7 and an unterminated IRI reference is dropped rather than hanging the scan');

    // ── ★★ THE TWO GUARDS THIS SECTION WAS BLIND TO, AND WHY IT WAS BLIND ──────
    //
    // Everything above draws its text from `docs/ns/`, where the predicate always starts a
    // line and the subject sits on a line of its own. Either of the guards below could be
    // DELETED and every other assertion in this file still passed — measured, one at a time,
    // and the only failures either mutation produces are the ones written here. A ★ comment
    // claiming a guard is load-bearing, over a suite that cannot tell whether it is there, is
    // the same defect this whole round is about: an answer to a question adjacent to the one
    // asked. So the inputs here are written rather than quoted from `docs/ns/`, and
    // that is the point — no document in this repo has this shape, and the scanner is pointed
    // at documents this repo did not write: a pod owner's `.well-known/container-shape` and
    // any Turtle a caller-named shape IRI serves.

    // ★★ A SUBJECT'S OWN `#` IS NOT THE START OF A COMMENT. Without the `<`-skip in
    // `iriObjectsOf` the scan walks INTO the subject IRI, reads its fragment marker as a
    // comment, discards the rest of the line — and reports ZERO declarations for a document
    // that declares two. Reporting nothing where the thing exists but was not carried is the
    // exact failure the scanner replaced a regex to fix, so it must not be reachable from
    // inside the scanner itself.
    const FRAGMENT_SUBJECT = '<https://pod.example/u/x#it> iep:conformsTo <s1> , <s2> .';
    ok(JSON.stringify(iriObjectsOf(FRAGMENT_SUBJECT, 'iep:conformsTo')) === '["s1","s2"]',
      '§7 a subject IRI carrying a `#` on the predicate\'s own line is stepped over whole, not '
      + 'read as a comment that swallows the declarations after it',
      JSON.stringify(iriObjectsOf(FRAGMENT_SUBJECT, 'iep:conformsTo')));
    const FRAGMENT_OBJECT = '<> a <https://markjspivey-xwisee.github.io/interego/ns/iep#'
      + 'ContextDescriptor> ; dct:conformsTo <p1> , <p2> .';
    ok(JSON.stringify(iriObjectsOf(FRAGMENT_OBJECT, 'dct:conformsTo')) === '["p1","p2"]',
      '§7 …and so is an OBJECT IRI carrying one earlier in the same statement — every term IRI '
      + 'this repo publishes has a fragment, so a one-line statement is all it takes');

    // ★★ A SHORT LITERAL CANNOT SPAN A LINE, AND THE BAIL IS CONTAINMENT. A stray or
    // unterminated quote — a truncated body, a hand-written container-shape, any document the
    // relay did not write — otherwise runs the literal scan to END OF FILE and takes every
    // declaration below it with it. Bailing at the newline costs the rest of ONE line.
    const STRAY_QUOTE = '<https://pod.example/n> rdfs:label "unterminated .\n'
      + '<https://pod.example/o> owl:imports <a> , <b> .\n';
    ok(JSON.stringify(iriObjectsOf(STRAY_QUOTE, P)) === '["a","b"]',
      '§7 an unterminated literal costs the rest of ITS line and nothing below it — without '
      + 'the newline bail the scan runs to EOF and one stray quote drops every import in the '
      + 'document',
      JSON.stringify(iriObjectsOf(STRAY_QUOTE, P)));
    // Non-vacuity for the line the bail gives up on: it really is abandoned, so the assertion
    // above is about containment and not about the scanner tolerating the quote.
    ok(iriObjectsOf('<s> rdfs:label "unterminated owl:imports <x> .\n', P).length === 0,
      '§7 while the text after the stray quote on THAT line is still skipped, so the bail '
      + 'narrows the loss rather than ignoring the quote');
  }

  // ── §9 The figures the comments quote are still the measurements ──────────
  //
  // ★★ THE REASON THIS SECTION EXISTS. Two shipped ★-marked comments said "21 of the 33
  // documents in docs/ns/ declare ZERO shapes". Run against the engine it is 23. Nobody had
  // run it — it was a plausible number written beside a real argument, and it stayed there
  // because no assertion could disagree with a comment. A measured figure that nothing
  // re-measures decays into a claim, and a claim in a ★ comment is worse than no comment: it
  // is the sentence the next reader trusts instead of checking.
  //
  // So the comments are now compared to the measurement, not merely accompanied by it. If
  // docs/ns/ gains a shapeless ontology this fails, and the fix is to correct both sentences.
  {
    const nsDir = join(here, '..', '..', '..', 'docs', 'ns');
    const files = readdirSync(nsDir).filter(f => f.endsWith('.ttl'));
    const zero = files.filter(f =>
      validateAgainstShape('<https://x/a> <https://x/b> "c" .\n',
        readFileSync(join(nsDir, f), 'utf8'), OPTS).shapesDeclared === 0);

    // COMMENT LINES ONLY, unwrapped first. Both sentences wrap mid-figure — "(23 of the" then
    // "33 documents in `docs/ns/`" on the next line — so a per-line regex reads zero of them
    // and passes vacuously, which is the failure mode this whole section is about.
    const prose = (src: string): string => readFileSync(join(here, src), 'utf8')
      .split('\n')
      .filter(l => /^\s*(\/\/|\*)/.test(l))
      .map(l => l.replace(/^\s*(\/\/|\*)\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    for (const src of ['../shapes-declared.ts', '../server.ts']) {
      const quoted = [...prose(src).matchAll(/(\d+) of (?:the )?33\b/g)].map(m => Number(m[1]));
      ok(quoted.length > 0 && quoted.every(q => q === zero.length),
        `§9 every "N of 33" figure in ${src.replace('../', '')} equals the engine's own count`,
        `comment says ${JSON.stringify(quoted)}, measured ${zero.length} of ${files.length}: `
        + zero.join(', '));
    }
    ok(files.length === 33,
      '§9 …and the denominator is the real file count, so "of 33" is not stale either',
      `${files.length} .ttl files`);
  }

  await drivenSuite();

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

/**
 * ── §8 THE REPORTING HALF, DRIVEN AGAINST THE REAL RELAY ─────────────────────
 *
 * ★★ WHY THIS EXISTS: EVERYTHING ABOVE PASSED 33/33 WITH THE `conformance` BLOCK DELETED.
 * `summarizeConformance` is tested against hand-built `ShapeCoverage` arrays; nothing
 * asserted that `runConformanceGate` ever FILLS that array, or that the publish handler emits
 * the block. Mutating server.ts's `coverage.push(cover);` to `void cover;` removes the block
 * from every publish response — the container-declared case's ONLY remedy, since that side is
 * deliberately not refused — and this file did not notice. A refusal can be seen from a unit
 * test; a report can only be seen by whoever receives it.
 *
 * ★★ AND IT IS WHERE THE IMPORT LIST BECOMES AN OUTCOME. §7 pins the extractor on text. Only
 * a run can show that reading the whole list changes what the gate ENFORCED, which is the
 * fact that matters: with the shipped regex the fixture publish below merged one of its two
 * imported shape documents and applied one shape; with the list read whole it merges both and
 * applies two. Same call, same fixtures, a different contract actually run.
 *
 * It boots `server.ts` as the child process it is designed to be — the file opens a listener
 * on import, so it cannot be called in-process — against a fake identity server and a pod that
 * really stores what is PUT to it. The pod HAS to store: the relay registers the calling agent
 * on first use and reads that registration back through the scope gate, so a fixture that
 * answers 201 and forgets never gets past 403 and never reaches the shape gate at all.
 *
 * The shape IRIs are served from the CSS origin, which `egress.ts` classifies as `pinned`; a
 * loopback URL from any other origin is refused by the SSRF guard, correctly.
 */
async function drivenSuite(): Promise<void> {
  const SHAPE_A = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.test/v#> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] .
`;
  const SHAPE_B = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.test/v#> .
ex:OtherShape a sh:NodeShape ; sh:targetClass ex:Other ;
  sh:property [ sh:path ex:label ; sh:minCount 1 ] .
`;
  /**
   * A real shapes graph whose target class this graph does not carry — the caller-side
   * REPORT's subject, and deliberately not one of the two above: reusing a shape that DOES
   * apply would have made `applied === 0` unreachable and the assertion unfalsifiable.
   */
  const SHAPE_UNRELATED = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.test/v#> .
ex:AbsentShape a sh:NodeShape ; sh:targetClass ex:NotInThisGraph ;
  sh:property [ sh:path ex:whatever ; sh:minCount 1 ] .
`;
  /** Declares nothing itself and imports nothing — the caller-side refusal's target. */
  const EMPTY_DOC = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/o> a owl:Ontology .
`;
  /** Carries BOTH classes, so "how many shapes applied" can tell one import from two. */
  const GRAPH = `@prefix ex: <https://example.test/v#> .
<https://example.test/d/thing> a ex:Thing ; ex:name "fine" .
<https://example.test/d/other> a ex:Other ; ex:label "also fine" .
`;

  const FAKE_USER_ID = 'u-p7-declared';
  /**
   * ★★ A SECOND POD, REACHED BY A SECOND BEARER — AND THE ONLY WAY TO DRIVE THE OTHER HALF
   * OF THE CONTAINER SCAN. `fetchContainerShapes` falls back to the pod MANIFEST only when
   * `.well-known/container-shape` yields nothing, and it caches its answer per pod URL, so one
   * pod cannot exercise both branches in one run. `injectRestVerifiedIdentity` derives
   * `pod_name` from the verified `userId`, so a token this fixture resolves to a different user
   * lands on a different pod — a different cache entry, a different container-shape lookup.
   */
  const MANIFEST_USER_ID = 'u-p7-manifest';
  const MANIFEST_TOKEN = 'token-for-the-manifest-pod';
  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (q, s) => {
    const token = (q.body as { token?: string } | undefined)?.token ?? '';
    const userId = token === MANIFEST_TOKEN ? MANIFEST_USER_ID : FAKE_USER_ID;
    s.json({ valid: true, userId, agentId: `mcp-client-${userId}`, scope: 'ReadWrite' });
  });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });

  const podApp = express();
  /** Everything the relay PUT to the pod, so a refusal can be checked for landing nothing. */
  const written = new Map<string, string>();
  let importerDoc = '';
  let containerShapeDoc = '';
  podApp.get('/p7-shapes/a', (_q, s) => { s.type('text/turtle').send(SHAPE_A); });
  podApp.get('/p7-shapes/b', (_q, s) => { s.type('text/turtle').send(SHAPE_B); });
  // The same two contracts at their own URLs, so the CONTAINER-declared pair below is fetched
  // separately from the pair the importer merges and neither can stand in for the other.
  podApp.get('/p7-shapes/c', (_q, s) => { s.type('text/turtle').send(SHAPE_A); });
  podApp.get('/p7-shapes/d', (_q, s) => { s.type('text/turtle').send(SHAPE_B); });
  podApp.get(`/${FAKE_USER_ID}/.well-known/container-shape`,
    (_q, s) => { s.type('text/turtle').send(containerShapeDoc); });
  // The manifest pod deliberately has NO `.well-known/container-shape` — the fall-through to
  // the manifest is the branch under test, and it runs only when the preferred source is empty.
  podApp.get('/p7-shapes/m1', (_q, s) => { s.type('text/turtle').send(SHAPE_A); });
  /**
   * Declared by a subject that is NOT the manifest collection. The scan restricts itself to
   * the collection's own block precisely so a `dct:conformsTo` belonging to one descriptor row
   * is never enforced as a CONTAINER-level contract on every publish to the pod — a shape
   * chosen by a different subject than the one asked about. Counted rather than asserted on the
   * response, because "never fetched" is the claim and a fetch is the only way to see it.
   *
   * ★★ AND THE ROW CARRYING IT IS ORDERED FIRST, NAMING THE MANIFEST URL, because the
   * restriction used to be a first-OCCURRENCE text match and this document is what told the
   * two apart. Driven at HEAD in that order: the "collection block" became the tail of the
   * descriptor's statement, the decoy 422'd the publish on a MinCount violation, and the
   * collection's own contracts were never fetched. Every §8 assertion below is written
   * against this ordering, so `decoyFetches === 0` is now a claim about subject position and
   * not about which subject happened to be typed first. See fetchContainerShapes.
   */
  let decoyFetches = 0;
  podApp.get('/p7-shapes/decoy', (_q, s) => {
    decoyFetches += 1;
    s.type('text/turtle').send(SHAPE_A);
  });
  podApp.get('/p7-shapes/importer', (_q, s) => { s.type('text/turtle').send(importerDoc); });
  podApp.get('/p7-shapes/unrelated', (_q, s) => { s.type('text/turtle').send(SHAPE_UNRELATED); });
  podApp.get('/p7-shapes/empty', (_q, s) => { s.type('text/turtle').send(EMPTY_DOC); });
  podApp.use(express.text({ type: () => true, limit: '20mb' }));
  podApp.use((q, s) => {
    const key = decodeURIComponent(q.path);
    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') {
      if (!key.endsWith('/')) written.set(key, typeof q.body === 'string' ? q.body : '');
      s.status(201).end();
      return;
    }
    const hit = written.get(key);
    if (hit === undefined) { s.status(404).end(); return; }
    if (q.method === 'HEAD') { s.type('text/turtle').status(200).end(); return; }
    s.type('text/turtle').status(200).send(hit);
  });

  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);
  // ★ THE IMPORT LIST UNDER TEST, in the form docs/ns/harness.ttl uses: one predicate, two
  // objects, a comma between them. Written here rather than fetched, so this assertion is
  // about the relay's resolver and not about anything on the network.
  // The third target is deliberately absent (404). An import is supplementary vocabulary, not
  // the contract, so losing one must be non-fatal — and the operator line that says so must not
  // announce a refusal that did not happen. Asserted below against the child's own stdout.
  importerDoc = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.test/importer> a owl:Ontology ;
    owl:imports <${pod.base}/p7-shapes/a> ,
                <${pod.base}/p7-shapes/b> ,
                <${pod.base}/p7-shapes/gone> .
`;
  // ★★ THE CONTAINER SCAN HAD THE SAME BUG AND NO TEST AT ALL. `fetchContainerShapes` read
  // `iep:conformsTo` with the same first-object-only regex, so a pod declaring two contracts
  // in one list had the second never fetched and never run — while the publish still answered
  // that the gate passed. Written as an object list here for exactly that reason.
  containerShapeDoc = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<> iep:conformsTo <${pod.base}/p7-shapes/c> ,
                  <${pod.base}/p7-shapes/d> .
`;
  // ★★ THE OTHER SCAN SITE, WHICH HAD NO TEST ANYWHERE. `fetchContainerShapes` reads the pod
  // MANIFEST when `.well-known/container-shape` yields nothing, and reverting THAT loop alone
  // to the old first-object-only regex survived this file and publish-gates together — the
  // half where a pod declaring three contracts had two never fetched while the publish still
  // reported the gate passed. Seeded through the fixture's own store rather than served from a
  // fixed route, so the relay's own manifest write during this publish replaces it the way it
  // would on a real pod instead of being shadowed forever.
  const manifestUrl = `${pod.base}/${MANIFEST_USER_ID}/.well-known/context-graphs`;
  const manifestDoc = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${pod.base}/${MANIFEST_USER_ID}/ctx/some-descriptor> a iep:ContextDescriptor ;
    dct:isPartOf <${manifestUrl}> ;
    dct:conformsTo <${pod.base}/p7-shapes/decoy> .
<${manifestUrl}> a iep:ContextCollection ;
    dct:conformsTo <${pod.base}/p7-shapes/m1> ,
                   <${pod.base}/p7-shapes/empty> .
`;
  written.set(`/${MANIFEST_USER_ID}/.well-known/context-graphs`, manifestDoc);

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${port}`;
  // Never the production default `/app/relay-agent-key.json`: a suite must not write a
  // long-lived private key into a path it does not own.
  const keyFile = join(tmpdir(), `p7-shapes-declared-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CSS_URL: `${pod.base}/`,
      IDENTITY_URL: identity.base,
      RELAY_AGENT_KEY_FILE: keyFile,
    },
    // stdout is kept because the gate's operator log is an ASSERTED SURFACE here, not noise —
    // see the "REFUSED" check below. stderr is kept because if the child cannot boot, "up=false"
    // alone sends the next reader back to reproduce it by hand.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  let childLog = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { childLog = (childLog + c).slice(-40_000); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    childErr = (childErr + c).slice(-1_500);
    childLog = (childLog + c).slice(-40_000);
  });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);

  interface PublishReply { readonly status: number; readonly body: Record<string, unknown> }
  let n = 0;
  /**
   * `shapeIri` of null names NO caller shape at all, which is how the container-declared side
   * is reached honestly: everything in that publish's conformance block came from the pod.
   * `token` selects which pod the call lands on — see MANIFEST_TOKEN.
   */
  const publish = async (
    shapeIri: string | null,
    token = 'any-token-the-fixture-accepts',
  ): Promise<PublishReply> => {
    n += 1;
    const res = await fetch(`${base}/tool/publish_context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        graph_iri: `https://example.test/d/p7-${n}`,
        graph_content: GRAPH,
        visibility: 'public',
        ...(shapeIri === null ? {} : { conforms_to_shapes: [shapeIri] }),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { unparseable: text.slice(0, 300) }; }
    return { status: res.status, body };
  };

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    ok(up, '§8 the relay boots against the fixtures and answers /health',
      `${base} — child stderr tail: ${childErr || '(none)'}`);
    if (!up) return;

    /** By IRI, never by position — the gate runs container shapes before caller ones. */
    const entry = (c: ConformanceSummary | undefined, iri: string): ShapeCoverage | undefined =>
      c?.validated.find(v => v.shapeIri === iri);

    // ── The reporting half, over the wire ──────────────────────────────────
    {
      const importerIri = `${pod.base}/p7-shapes/importer`;
      const r = await publish(importerIri);
      const conf = r.body['conformance'] as ConformanceSummary | undefined;
      ok(r.body['published'] === true,
        '§8 the publish that named a shapes graph SUCCEEDS',
        JSON.stringify(r.body['error'] ?? r.status));
      ok(conf !== undefined,
        '§8 ★★ and the response carries a `conformance` block — the line that fills it '
        + '(`coverage.push`) had no test that ran the relay, so deleting it left this file '
        + 'green while every publish silently stopped saying what the gate enforced',
        JSON.stringify(r.body).slice(0, 240));
      ok(entry(conf, importerIri)?.source === 'caller',
        '§8 naming the shape the caller passed, attributed to the caller',
        JSON.stringify(conf?.validated));

      // ★★ THE IMPORT LIST, AS AN OUTCOME. The importer declares nothing of its own; every
      // number here comes from the two documents it imports in ONE comma-separated list.
      // Shipped regex: shape-a only — declared 2, applied 1. Whole list: declared 4, applied 2.
      ok(entry(conf, importerIri)?.declared === 4,
        '§8 ★★ BOTH imported shape documents are merged, not just the one before the comma',
        `declared=${entry(conf, importerIri)?.declared} (2 = only the first import was followed)`);
      ok(entry(conf, importerIri)?.applied === 2,
        '§8 ★★ …and both contracts actually RAN against this graph — the fix changes what was '
        + 'enforced, not only what was parsed',
        `applied=${entry(conf, importerIri)?.applied} (1 = the second contract never ran)`);

      // ★★ AND THE CONTAINER'S OWN OBJECT LIST, WHICH HAD NO TEST OF ANY KIND. The pod's
      // `.well-known/container-shape` declares two contracts in one `iep:conformsTo` list.
      // Both must appear, attributed to the CONTAINER — the attribution is what decides
      // refuse-versus-report, so a shape that arrives mislabelled is a different decision.
      const c = entry(conf, `${pod.base}/p7-shapes/c`);
      const d = entry(conf, `${pod.base}/p7-shapes/d`);
      ok(c?.source === 'container' && d?.source === 'container',
        '§8 ★★ both container-declared contracts are fetched and run, not just the one before '
        + 'the comma — and both are attributed to the container, not to the caller',
        JSON.stringify(conf?.validated));
      ok(c?.applied === 1 && d?.applied === 1,
        '§8 …and each of them actually selected a node in this graph',
        `c.applied=${c?.applied} d.applied=${d?.applied}`);

      ok(conf?.unenforced === undefined,
        '§8 nothing is flagged unenforced, because nothing was',
        JSON.stringify(conf?.unenforced));

      // ★★ AND THE OPERATOR LOG DOES NOT ANNOUNCE A REFUSAL THAT DID NOT HAPPEN. The importer's
      // third target is absent, and losing an import is non-fatal — but the shared fetch layer
      // ends its give-up path with "Publish is REFUSED (422 shapeUnfetchable); the gate fails
      // closed", which is true for a NAMED shape and false for an import. Observed live on the
      // publish this round exists to repair: the refusal was announced on one line, contradicted
      // on the next, and the response was 200. An operator grepping for the first line hunts a
      // 422 that never happened — the same "answers a different question" defect, in the log.
      const dropped = childLog.split('\n').filter(l => /p7-shapes\/gone/.test(l));
      ok(dropped.length > 0,
        '§8 non-vacuity: the absent import really was attempted and reported',
        childLog.slice(-400));
      ok(dropped.every(l => !/REFUSED/.test(l)),
        '§8 ★★ …and no line about it claims the publish was REFUSED — this publish returned 200',
        dropped.join(' | ').slice(0, 400));
    }

    // ── The refusal, over the wire, and it lands nothing ───────────────────
    {
      const mine = `p7-${n + 1}`;
      const r = await publish(`${pod.base}/p7-shapes/empty`);
      const violations = r.body['violations'] as { constraint?: string }[] | undefined;
      ok(r.body['error'] === 'shape_violation' && r.body['code'] === 422,
        '§8 a CALLER-named document that declares no shapes is refused 422 on the wire',
        JSON.stringify(r.body).slice(0, 200));
      ok(violations?.[0]?.constraint
        === 'https://markjspivey-xwisee.github.io/interego/ns/iep#shapeDeclaresNoShapes',
        '§8 with the constraint component a reader can dereference', JSON.stringify(violations));
      // ★ REFUSED BEFORE THE POD WRITE, not after. This looks for THIS publish's graph IRI
      // rather than counting writes: the relay does its own background writes (agent
      // registration, federation), so a count would be racy while "did this one land" is not.
      ok(![...written.values()].some(v => v.includes(mine)),
        '§8 and nothing from that publish reached the pod', `${written.size} objects stored`);
    }

    // ── …and the caller-side REPORT, which must not become a refusal ───────
    {
      const unrelatedIri = `${pod.base}/p7-shapes/unrelated`;
      const r = await publish(unrelatedIri);
      const conf = r.body['conformance'] as ConformanceSummary | undefined;
      ok(r.body['published'] === true,
        '§8 a caller-named shapes file that targets nothing in this graph still PUBLISHES',
        JSON.stringify(r.body['error'] ?? r.status));
      const flagged = conf?.unenforced?.find(u => u.shapeIri === unrelatedIri);
      ok(flagged?.why === 'targets-nothing-here'
        && flagged.declared === 2 && flagged.applied === 0,
        '§8 and says so — declared, but applied nothing, which is the '
        + 'ontology-instead-of-shapes mistake that survives a healthy `declared`',
        JSON.stringify(conf?.unenforced));
    }

    // ── The container scan's OTHER site: the pod manifest ──────────────────
    //
    // ★★ THE MORE CONSEQUENTIAL HALF OF "ONE SCANNER BOTH CALLERS SHARE", AND THE UNTESTED
    // ONE. `fetchContainerShapes` scans `.well-known/container-shape` first and the pod
    // MANIFEST's collection block only when that yields nothing, so the block above — whose
    // fixture pod serves a container-shape document — never reaches the second site at all.
    // Until this block existed, reverting the manifest loop ALONE to
    // `collectionBlock.matchAll(new RegExp(`${p}\\s+<([^>]+)>`, 'g'))` survived this whole file
    // and publish-gates together: a pod declaring three contracts in one list had two never
    // fetched and never run while the publish still reported that the gate passed. That is the
    // pod-side version of the outage, on the side where nobody is present to notice, and it
    // needed a SECOND POD to be seen at all. Re-applied against this block, two of the
    // assertions below fail and the coverage array shows exactly the truncation — measured.
    //
    // ★ AND IT CARRIES THE SOURCE SPLIT, END TO END, ON ONE DOCUMENT. `/p7-shapes/empty` is
    // the SAME document the block above refuses 422 when a CALLER names it. Declared by the
    // container it must publish and be reported instead, because the pod owner is not the
    // caller and the repair for a pod's profile assertion is a pod write the 422 would have
    // locked out. Two opposite decisions on identical bytes, over the wire, in one run.
    {
      const m1Iri = `${pod.base}/p7-shapes/m1`;
      const emptyIri = `${pod.base}/p7-shapes/empty`;
      const r = await publish(null, MANIFEST_TOKEN);
      const conf = r.body['conformance'] as ConformanceSummary | undefined;
      ok(r.body['published'] === true,
        '§8 a publish naming NO caller shape still runs the pod\'s manifest-declared contracts',
        JSON.stringify(r.body['error'] ?? r.status));
      ok(entry(conf, m1Iri)?.source === 'container' && entry(conf, m1Iri)?.applied === 1,
        '§8 the manifest collection\'s first declared contract is fetched, run, and attributed '
        + 'to the CONTAINER',
        JSON.stringify(conf?.validated));
      const second = entry(conf, emptyIri);
      ok(second?.source === 'container' && second.declared === 0,
        '§8 ★★ and so is the SECOND object of the same `dct:conformsTo` list — the manifest '
        + 'scan reads the whole list, which is the half of the fix no test reached',
        JSON.stringify(conf?.validated));
      ok(conf?.unenforced?.some(u => u.shapeIri === emptyIri && u.why === 'declares-no-shapes')
        === true,
        '§8 ★★ a CONTAINER-declared document that declares no shapes is REPORTED, not refused '
        + '— the identical bytes that 422 a caller — because the pod owner is not the caller '
        + 'and the repair would be a pod write the refusal had just locked out',
        JSON.stringify(conf?.unenforced));
      // ★ AND THE BLOCK RESTRICTION, WITH THREE HALVES OF THE EVIDENCE. "The decoy was never
      // fetched" passes for two reasons — the restriction worked, or nothing here can see a
      // fetch at all — and two possible reasons is evidence for neither. So: the scanner
      // itself, run over the WHOLE manifest, returns all three (it would gladly hand the
      // fetcher the decoy, so the restriction to the collection's own block is what excludes
      // it), and the counter is proved live by fetching the decoy URL directly afterwards.
      //
      // ★★ AND THE THIRD, which is why the assertions above are worth anything: the decoy's
      // row is written FIRST in this manifest and NAMES the manifest URL, so a restriction
      // that is really a first-occurrence text match takes that row's tail as the
      // "collection block". Driven at HEAD in this order, the publish 422'd on the decoy's
      // MinCount and neither m1 nor empty was ever fetched — so the two `source: 'container'`
      // assertions above are what fail if the anchoring regresses, before this one does.
      ok(manifestDoc.indexOf(`${pod.base}/p7-shapes/decoy`) < manifestDoc.indexOf(`<${manifestUrl}> a`),
        '§8 the ordering this rests on: the decoy\'s row precedes the collection\'s own '
        + 'statement, so "the collection\'s block" cannot be satisfied by reading from the top',
        `decoy at ${manifestDoc.indexOf(`${pod.base}/p7-shapes/decoy`)}, `
        + `collection subject at ${manifestDoc.indexOf(`<${manifestUrl}> a`)}`);
      ok(manifestDoc.includes(`dct:isPartOf <${manifestUrl}>`),
        '§8 …and that row names the manifest URL in OBJECT position, which is the occurrence '
        + 'an unanchored match mistook for the subject',
        'the descriptor row no longer references the manifest — the ordering above proves less');
      ok(iriObjectsOf(manifestDoc, 'dct:conformsTo').length === 3
        && iriObjectsOf(manifestDoc, 'dct:conformsTo').includes(`${pod.base}/p7-shapes/decoy`),
        '§8 the manifest really does carry a THIRD `dct:conformsTo`, on a subject that is not '
        + 'the collection, and the scanner returns it when pointed at the whole document',
        JSON.stringify(iriObjectsOf(manifestDoc, 'dct:conformsTo')));
      ok(decoyFetches === 0,
        '§8 …yet it is never fetched — container-level means the collection\'s own block, not '
        + 'every conformsTo the manifest happens to carry, or one descriptor\'s contract would '
        + 'silently become a contract on every publish to the pod',
        `${decoyFetches} fetch(es) of the decoy shape`);
      await fetch(`${pod.base}/p7-shapes/decoy`, { signal: AbortSignal.timeout(10_000) });
      ok(decoyFetches === 1,
        '§8 non-vacuity: that route and its counter are live, so the zero above is a fetch '
        + 'that did not happen and not a fetch nothing could have seen',
        `${decoyFetches}`);
    }
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    // The child mints an X25519 keypair when the file is absent and persists it; the ECDSA
    // compliance wallet lands next to it with `-ecdsa` spliced in. Both, or neither.
    for (const f of [keyFile, keyFile.replace(/\.json$/, '-ecdsa.json')]) {
      try { rmSync(f, { force: true }); } catch { /* the child may never have written it */ }
    }
  }
}

void main();
