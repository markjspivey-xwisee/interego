/**
 * What the SHACL rules engine does that the W3C suite never asks it to.
 *
 * ★ 18 OF 18 ON THE FIRST RUN IS A CLAIM, NOT A FACT. The suite's inference entries cover the
 * spec's own examples, and they cover them well — layers, run-once, conditions, temp triples,
 * the RDFS closure. What they never exercise is everything a CALLER can do that the spec's
 * examples do not: name a rule set, hand in a diverging rule set, hand in a rule type this
 * engine cannot run, or keep its shapes in a different document from its data.
 *
 * Each of those is a way the engine can be wrong while scoring 18 of 18, so each gets a test
 * here rather than a shrug. This is the same lesson as
 * `the-suite-does-not-reach-every-answer.test.ts`: a conformance score measures agreement with
 * a specification and says nothing about the code you wrote around it.
 */
import { describe, it, expect } from 'vitest';
import { inferShaclTriples, ShaclRulesError, parseTrig, type IRI } from '@interego/core';

const PREFIXES = `
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix ex:   <https://example.org/> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
`;

/** `ex:` declared for the SPARQL strings, which is a separate mechanism from @prefix. */
const DECLARE = `
ex: a sh:ShapesGraph ;
  sh:declare [ sh:prefix "ex" ; sh:namespace "https://example.org/" ] ;
  sh:declare [ sh:prefix "rdf" ; sh:namespace "http://www.w3.org/1999/02/22-rdf-syntax-ns#" ] .
`;

const show = (ts: readonly { subject: unknown; predicate: string; object: unknown }[]): string[] =>
  ts.map(t => {
    const term = (x: unknown): string => {
      const v = x as { kind: string; iri?: string; value?: string; id?: string };
      return v.kind === 'iri' ? v.iri! : v.kind === 'literal' ? v.value! : `_:${v.id}`;
    };
    return `${term(t.subject)} ${t.predicate} ${term(t.object)}`;
  }).sort();

describe('a rule set can be named, and then only its rules run', () => {
  const GRAPH = `${PREFIXES}${DECLARE}
ex:Widget a ex:Thing .

ex:RuleA a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:a true } WHERE { ?s a ex:Thing }" .
ex:RuleB a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:b true } WHERE { ?s a ex:Thing }" .
ex:RuleC a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:c true } WHERE { ?s a ex:Thing }" .

ex:SetInner a sh:RuleSet ; sh:hasRule ex:RuleB .
ex:SetOuter a sh:RuleSet ; sh:hasRule ex:RuleA ; sh:includesRuleSet ex:SetInner .
`;

  it('runs every rule in the graph when no rule set is named', () => {
    const { triples } = inferShaclTriples(GRAPH, GRAPH);
    expect(show(triples)).toEqual([
      'https://example.org/Widget https://example.org/a true',
      'https://example.org/Widget https://example.org/b true',
      'https://example.org/Widget https://example.org/c true',
    ]);
  });

  it('runs only the named set — and FOLLOWS sh:includesRuleSet into it', () => {
    // ★ THE TRANSITIVE HALF IS THE HALF THAT BREAKS QUIETLY. A collector that reads sh:hasRule
    // and stops runs ex:RuleA and not ex:RuleB, which is a smaller inference presented with
    // the same confidence as the right one. ex:RuleC is in neither set and must not run.
    const { triples } = inferShaclTriples(GRAPH, GRAPH,
      { ruleSet: 'https://example.org/SetOuter' as IRI });
    expect(show(triples)).toEqual([
      'https://example.org/Widget https://example.org/a true',
      'https://example.org/Widget https://example.org/b true',
    ]);
  });
});

describe('a rule set that cannot finish', () => {
  it('THROWS rather than returning what it had when it hit the iteration guard', () => {
    // ★ A PARTIAL FIXPOINT IS INDISTINGUISHABLE FROM A COMPLETE ONE ONCE RETURNED. This rule
    // mints a fresh blank node every pass, so it never repeats and never settles. Returning
    // the first N rounds would hand back an inference that is simply wrong, with nothing in
    // it saying so — the spec allows the guard precisely so the engine can say "I stopped".
    const diverging = `${PREFIXES}${DECLARE}
ex:Seed a ex:Thing .
ex:Grow a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:next _:n . _:n a ex:Thing } WHERE { ?s a ex:Thing }" .
`;
    expect(() => inferShaclTriples(diverging, diverging, { maxIterations: 5 }))
      .toThrow(/did not reach a fixpoint/);
  });

  it('and the triple ceiling is a guard too, not a silent truncation', () => {
    const diverging = `${PREFIXES}${DECLARE}
ex:Seed a ex:Thing .
ex:Grow a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:next _:n . _:n a ex:Thing } WHERE { ?s a ex:Thing }" .
`;
    expect(() => inferShaclTriples(diverging, diverging, { maxTriples: 20 }))
      .toThrow(/more than 20 triples|did not reach a fixpoint/);
  });
});

describe('a rule type this engine cannot execute', () => {
  it('is a FAILURE, not a rule quietly skipped', () => {
    // §"General Execution Instructions": an engine that cannot execute a rule because it
    // supports none of the rule's types MUST report a failure. Skipping it returns an
    // under-inferred graph that looks exactly like a correctly inferred one.
    const js = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:rule ex:JsRule .
ex:JsRule a sh:JSRule ; sh:jsFunctionName "inferSomething" .
ex:Widget a ex:Thing .
`;
    expect(() => inferShaclTriples(js, js)).toThrow(ShaclRulesError);
    expect(() => inferShaclTriples(js, js)).toThrow(/no rule type this engine supports/);
  });

  it('and a SPARQL rule whose query SHACL forbids is a failure, not an empty inference', () => {
    const forbidden = `${PREFIXES}${DECLARE}
ex:Bad a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?s ex:x true } WHERE { ?s a ex:Thing . MINUS { ?s ex:y true } }" .
ex:Widget a ex:Thing .
`;
    expect(() => inferShaclTriples(forbidden, forbidden)).toThrow(/could not be executed/);
  });
});

describe('shapes and data in SEPARATE documents', () => {
  const SHAPES = `${PREFIXES}${DECLARE}
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:rule [
    a sh:TripleRule ;
    sh:predicate ex:label ;
    sh:object [ <http://www.w3.org/ns/shacl-node-expr#pathValues> ex:name ] ;
    sh:condition [ sh:property [ sh:path ex:name ; sh:minCount 1 ] ] ;
  ] .
`;
  const DATA = `${PREFIXES}
ex:alice a ex:Person ; ex:name "Alice" .
ex:nobody a ex:Person .
`;

  it('evaluates the condition and the node expression across the two graphs', () => {
    // ★ TWO PARSES BOTH START NUMBERING AT _anon0. The shapes here are all blank nodes — the
    // rule, its object expression, its condition, the condition's property shape — and so is
    // anything the data happens to contain. Laying one graph over the other without renaming
    // merges nodes that have nothing to do with each other, and the shape ends up carrying
    // constraints nobody wrote.
    const { triples } = inferShaclTriples(DATA, SHAPES);
    expect(show(triples)).toEqual(['https://example.org/alice https://example.org/label Alice']);
  });

  it('and the caller\'s data document is not modified', () => {
    // The inferences come back as data. A caller that validates the original afterwards must
    // see the graph it handed in, not the graph plus conclusions it never asked to assert.
    const doc = parseTrig(DATA);
    const before = doc.subjects.map(s => [...s.properties.keys()].length).join(',');
    inferShaclTriples(doc, parseTrig(SHAPES));
    expect(doc.subjects.map(s => [...s.properties.keys()].length).join(',')).toBe(before);
  });
});

describe('a blank node in a CONSTRUCT template', () => {
  it('is FRESH for every solution, not one node shared by all of them', () => {
    // ★ THE SUITE USES `BIND (BNODE() AS ?r)` AND NEVER A TEMPLATE `_:r`, so collapsing every
    // solution onto one blank node left it at 18 of 18. The two spellings mean the same thing
    // and only one of them was covered.
    //
    // What collapsing looks like: one tag pointing at both things, and — because the second
    // solution's `ex:kind` triple is then a duplicate of the first — a graph that is a triple
    // SHORTER rather than obviously wrong.
    const g = `${PREFIXES}${DECLARE}
ex:one a ex:Thing . ex:two a ex:Thing .
ex:Tag a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { _:tag ex:about ?s . _:tag ex:kind 'note' } WHERE { ?s a ex:Thing }" .
`;
    const { triples } = inferShaclTriples(g, g);
    expect(triples).toHaveLength(4);
    const tags = new Set(triples
      .filter(t => t.predicate === 'https://example.org/about')
      .map(t => JSON.stringify(t.subject)));
    expect(tags.size, 'both solutions produced the SAME blank node').toBe(2);
  });
});

describe('a template triple whose slot is unbound', () => {
  it('is skipped — the rest of the solution is still asserted', () => {
    // SPARQL §16.2: template triples with an unbound variable are not instantiated. The
    // SOLUTION is not discarded; only that triple is. Discarding the solution silently drops
    // the triples that were perfectly well bound, and it only shows up when the unbound one
    // is written FIRST — which is why the suite, whose templates are all fully bound, cannot
    // see the difference.
    const g = `${PREFIXES}${DECLARE}
ex:named a ex:Thing ; ex:name "A" .
ex:anon  a ex:Thing .
ex:R a sh:SPARQLRule ;
  sh:construct """CONSTRUCT { ?s ex:label ?n . ?s ex:seen true }
                  WHERE { ?s a ex:Thing . OPTIONAL { ?s ex:name ?n } }""" .
`;
    expect(show(inferShaclTriples(g, g).triples)).toEqual([
      'https://example.org/anon https://example.org/seen true',
      'https://example.org/named https://example.org/label A',
      'https://example.org/named https://example.org/seen true',
    ]);
  });
});

describe('sh:order inside a layer', () => {
  it('decides the answer when the rules are RUN-ONCE and one feeds the other', () => {
    // ★ THE SUITE CANNOT SEE THIS, AND A MUTATION PROVED IT: deleting the sh:order sort left
    // the W3C inference entries at 18 of 18. Its ordering fixture uses two ITERATING rules, so
    // the fixpoint repairs any order — whichever runs first, the second pass fixes it.
    //
    // Run-once rules get no second pass. Here the dependent rule is written FIRST in the
    // document, so document order runs it before the value it reads exists, and only sh:order
    // puts them right. Without the sort this infers one triple instead of two, and looks
    // exactly as confident.
    const g = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:rule ex:Second , ex:First .

ex:Second a sh:SPARQLRule ; sh:runOnce true ; sh:order 2 ;
  sh:construct "CONSTRUCT { $this ex:b ?v } WHERE { $this ex:a ?v }" .

ex:First a sh:SPARQLRule ; sh:runOnce true ; sh:order 1 ;
  sh:construct "CONSTRUCT { $this ex:a 1 } WHERE { }" .

ex:widget a ex:Thing .
`;
    expect(show(inferShaclTriples(g, g).triples)).toEqual([
      'https://example.org/widget https://example.org/a 1',
      'https://example.org/widget https://example.org/b 1',
    ]);
  });
});

describe('a derived triple is scaffolding, and so is anything reifying it', () => {
  it('is never reported as an inference, and takes its reifiers with it', () => {
    // ★ ALSO INVISIBLE TO THE SUITE. `sh:defaultValue` and `sh:values` describe triples the
    // VALIDATOR would compute; `sh:expectedPredicate` materialises them so a rule can read
    // one, and the spec deletes them afterwards "except those that were also inferred by
    // rules" — along with their reifiers.
    //
    // The suite's entry never reifies a derived triple, so deleting the deletion changed
    // nothing there. It changes everything here: ex:note would be reported as an inference
    // about a triple that no longer exists.
    const g = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ; sh:targetClass ex:Rect ;
  sh:property ex:AreaShape ;
  sh:rule ex:SawIt .

ex:AreaShape a sh:PropertyShape ; sh:path ex:area ; sh:defaultValue 7 .

ex:SawIt a sh:SPARQLRule ;
  sh:expectedPredicate ex:area ;
  sh:construct """CONSTRUCT {
      $this ex:sawArea ?a .
      _:r rdf:reifies ?t .
      _:r ex:note "about a triple that will not survive"
    } WHERE {
      $this ex:area ?a .
      BIND (TRIPLE($this, ex:area, ?a) AS ?t)
    }""" .

ex:box a ex:Rect .
`;
    // The rule SAW the derived value — so sh:expectedPredicate did its job — and neither the
    // derived triple nor the reifier that points at it is in the result.
    expect(show(inferShaclTriples(g, g).triples))
      .toEqual(['https://example.org/box https://example.org/sawArea 7']);
  });
});

describe('the fixpoint', () => {
  it('reaches the far end of a chain, not just one step along it', () => {
    // The transitive closure is the shape of inference that a single pass gets WRONG rather
    // than incomplete-looking: x1 reaches x2 immediately, x4 only on the third round.
    const g = `${PREFIXES}${DECLARE}
ex:x1 ex:link ex:x2 . ex:x2 ex:link ex:x3 . ex:x3 ex:link ex:x4 .
ex:Step a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?a ex:reaches ?b } WHERE { ?a ex:link ?b }" .
ex:Close a sh:SPARQLRule ;
  sh:construct "CONSTRUCT { ?a ex:reaches ?c } WHERE { ?a ex:reaches ?b . ?b ex:reaches ?c }" .
`;
    const { triples } = inferShaclTriples(g, g);
    expect(show(triples)).toContain('https://example.org/x1 https://example.org/reaches https://example.org/x4');
    expect(triples).toHaveLength(6);       // 3 direct + x1→x3, x2→x4, x1→x4
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  What the adversarial review found after 18 of 18
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ EVERY ONE OF THESE WAS FOUND BY A REVIEWER READING THE SPEC AGAINST THE CODE, not by a
// failing test — the suite was full and every mutant was dead. Each was then handed to two
// skeptics told to REFUTE it, survived both, and reproduced against the build.

describe('a rule linked from more than one shape', () => {
  const GRAPH = `${PREFIXES}${DECLARE}
ex:AShape a sh:NodeShape ; sh:targetClass ex:A ; sh:rule ex:Tag .
ex:BShape a sh:NodeShape ; sh:targetClass ex:B ; sh:rule ex:Tag .
ex:Tag a sh:TripleRule ; sh:predicate ex:tagged ; sh:object true .
ex:a1 a ex:A .
ex:b1 a ex:B .
`;

  it('runs for the target nodes of BOTH of them', () => {
    // ★ THE OWNERSHIP MAP KEPT ONE OWNER. `linked.set(rule, shape)` overwrote, so the rule ran
    // over whichever shape appeared LATER in the document and the other shape's inference went
    // missing — with nothing in the output saying so. Reusing one rule across shapes is the
    // whole point of giving it an IRI.
    expect(show(inferShaclTriples(GRAPH, GRAPH).triples)).toEqual([
      'https://example.org/a1 https://example.org/tagged true',
      'https://example.org/b1 https://example.org/tagged true',
    ]);
  });

  it('and the answer does not depend on which shape is written first', () => {
    // The bug was ORDER-SENSITIVE, so one ordering passes for the wrong reason. Both must.
    const swapped = GRAPH
      .replace('ex:AShape a sh:NodeShape ; sh:targetClass ex:A ; sh:rule ex:Tag .\n', '')
      .replace('ex:Tag a sh:TripleRule',
        'ex:AShape a sh:NodeShape ; sh:targetClass ex:A ; sh:rule ex:Tag .\nex:Tag a sh:TripleRule');
    expect(show(inferShaclTriples(swapped, swapped).triples)).toEqual([
      'https://example.org/a1 https://example.org/tagged true',
      'https://example.org/b1 https://example.org/tagged true',
    ]);
  });
});

describe('a property shape reached from two node shapes', () => {
  it('derives its expected values for the targets of both', () => {
    // Same one-to-many correction, on the other ownership map: `sh:expectedPredicate` looked
    // up the property shape's owner and kept the last one, so the values were derived for one
    // shape's targets and the rule that needed them saw nothing.
    const g = `${PREFIXES}${DECLARE}
ex:AShape a sh:NodeShape ; sh:targetClass ex:A ; sh:property ex:AreaPS ; sh:rule ex:Use .
ex:BShape a sh:NodeShape ; sh:targetClass ex:B ; sh:property ex:AreaPS .
ex:AreaPS a sh:PropertyShape ; sh:path ex:area ; sh:defaultValue 1 .
ex:Use a sh:SPARQLRule ; sh:expectedPredicate ex:area ;
  sh:construct "CONSTRUCT { $this ex:small true } WHERE { $this ex:area ?a }" .
ex:a1 a ex:A .
`;
    expect(show(inferShaclTriples(g, g).triples))
      .toEqual(['https://example.org/a1 https://example.org/small true']);
  });
});

describe('a derived triple that a rule ALSO infers', () => {
  it('survives the cleanup and is reported', () => {
    // ★ "EXCEPT THOSE THAT WERE ALSO INFERRED BY RULES" COULD NEVER FIRE. A rule's output was
    // recorded only when it was NEW to the graph, and an expected-derived triple is already
    // there by the time the rule runs — so nothing was recorded, and the cleanup then deleted
    // a triple a rule genuinely inferred.
    const g = `${PREFIXES}${DECLARE}
ex:RectShape a sh:NodeShape ; sh:targetClass ex:Rect ; sh:property ex:AreaPS ;
  sh:rule ex:AssertArea ; sh:rule ex:UseArea .
ex:AreaPS a sh:PropertyShape ; sh:path ex:area ; sh:defaultValue 1 .
ex:AssertArea a sh:TripleRule ; sh:predicate ex:area ; sh:object 1 .
ex:UseArea a sh:TripleRule ; sh:expectedPredicate ex:area ; sh:predicate ex:hasArea ; sh:object true .
ex:r1 a ex:Rect .
`;
    expect(show(inferShaclTriples(g, g).triples)).toEqual([
      'https://example.org/r1 https://example.org/area 1',
      'https://example.org/r1 https://example.org/hasArea true',
    ]);
  });
});

describe('sh:condition naming a shape that is also a CLASS', () => {
  it('checks the superclasses too, not just the class named', () => {
    // §"Conditions on Shape Rules": if the condition is an instance of both sh:NodeShape and
    // rdfs:Class, the focus nodes must also conform to its non-deactivated superclasses that
    // are themselves class-shapes. Checking only the named shape lets a rule fire on a node
    // that satisfies an empty subclass while violating everything the superclass requires —
    // and by then the rule has already asserted its triples.
    const g = `${PREFIXES}${DECLARE}
ex:Super a sh:NodeShape, rdfs:Class ; sh:property [ sh:path ex:req ; sh:minCount 1 ] .
ex:Sub a sh:NodeShape, rdfs:Class ; rdfs:subClassOf ex:Super .
ex:Shape a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:rule [ a sh:TripleRule ; sh:condition ex:Sub ; sh:predicate ex:ok ; sh:object true ] .
ex:good a ex:Thing, ex:Sub ; ex:req 1 .
ex:bad  a ex:Thing, ex:Sub .
`;
    expect(show(inferShaclTriples(g, g).triples))
      .toEqual(['https://example.org/good https://example.org/ok true']);
  });
});

describe('a DEACTIVATED rule of a type this engine cannot run', () => {
  it('is ignored, not a reason to refuse the whole rule set', () => {
    // "Deactivated rules are ignored by the rules engine" — so there is nothing the engine is
    // "not able to execute", and aborting over a rule the author explicitly switched OFF is a
    // fail-closed that closes on the wrong thing. A shapes graph carrying a disabled sh:JSRule
    // beside its SPARQL rules is ordinary; it used to abort the run.
    const g = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ; sh:targetClass ex:T ; sh:rule ex:Js ; sh:rule ex:Real .
ex:Js a sh:JSRule ; sh:deactivated true ; sh:jsFunctionName "x" .
ex:Real a sh:TripleRule ; sh:predicate ex:seen ; sh:object true .
ex:t1 a ex:T .
`;
    expect(show(inferShaclTriples(g, g).triples))
      .toEqual(['https://example.org/t1 https://example.org/seen true']);
  });
});

describe('the superclass walk behind sh:condition', () => {
  it('continues THROUGH a class that is not itself a shape', () => {
    // ★ "SHACL superclass" is the TRANSITIVE closure of rdfs:subClassOf. Whether a link is
    // itself a class-shape decides only whether its constraints APPLY — not whether the walk
    // continues past it. Skipping the enqueue as well meant one plain rdfs:Class in the middle
    // of a hierarchy hid every shape above it, so a condition that should have refused a node
    // admitted it and the rule fired.
    const g = `${PREFIXES}${DECLARE}
ex:Top a sh:NodeShape, rdfs:Class ; sh:property [ sh:path ex:req ; sh:minCount 1 ] .
ex:Middle a rdfs:Class ; rdfs:subClassOf ex:Top .
ex:Sub a sh:NodeShape, rdfs:Class ; rdfs:subClassOf ex:Middle .
ex:Shape a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:rule [ a sh:TripleRule ; sh:condition ex:Sub ; sh:predicate ex:ok ; sh:object true ] .
ex:bad a ex:Thing, ex:Sub .
ex:good a ex:Thing, ex:Sub ; ex:req 1 .
`;
    expect(show(inferShaclTriples(g, g).triples))
      .toEqual(['https://example.org/good https://example.org/ok true']);
  });
});

describe('a property shape that is BOTH targeted and referenced', () => {
  it('keeps its own targets as well as its owners\'', () => {
    // `owners.get(k) ?? [k]` consulted the property shape's own key only when NOBODY pointed
    // at it, so a shape carrying sh:targetNode AND reached by sh:property silently lost its
    // own targets. §2.1 gives targets to SHAPES; being referenced does not take them away.
    const g = `${PREFIXES}${DECLARE}
ex:AreaPS a sh:PropertyShape ; sh:targetNode ex:own ; sh:path ex:area ; sh:defaultValue 1 .
ex:Owner a sh:NodeShape ; sh:targetClass ex:A ; sh:property ex:AreaPS .
ex:Rules a sh:NodeShape ; sh:targetNode ex:own , ex:a1 ; sh:rule ex:Use .
ex:Use a sh:SPARQLRule ; sh:expectedPredicate ex:area ;
  sh:construct "CONSTRUCT { $this ex:small true } WHERE { $this ex:area ?a }" .
ex:a1 a ex:A .
ex:own a ex:Other .
`;
    expect(show(inferShaclTriples(g, g).triples)).toEqual([
      'https://example.org/a1 https://example.org/small true',
      'https://example.org/own https://example.org/small true',
    ]);
  });
});

describe('a computed sh:targetNode, from the RULES engine', () => {
  it('selects the nodes the query names, with the shapes in a separate document', () => {
    // ★ THE FIRST FIX REACHED ONE OF ITS TWO CALLERS. `findFocusNodes` resolves the selector
    // against the run's shapes graph, and only the validation driver established that scope —
    // the rules engine calls the same code with no validation running, so the selector fell
    // back to the DATA graph, was not found, and the SELECTOR BLANK NODE became the focus
    // node. Measured: the rule tagged `_:shapes._anon1`.
    const shapes = `${PREFIXES}${DECLARE}
ex:Shape a sh:NodeShape ;
  sh:targetNode [ sh:prefixes ex: ; sh:select "SELECT ?person WHERE { ?person a ex:P }" ] ;
  sh:rule [ a sh:TripleRule ; sh:predicate ex:tagged ; sh:object true ] .
`;
    const data = '@prefix ex: <https://example.org/> .\nex:p1 a ex:P .';
    expect(show(inferShaclTriples(data, shapes).triples))
      .toEqual(['https://example.org/p1 https://example.org/tagged true']);
  });
});
