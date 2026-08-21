/**
 * vldp:EntailmentAuthorityShape actually refuses smuggled execution authority.
 *
 * ★ IT ENFORCED NOTHING, FOR TWO INDEPENDENT REASONS, and either alone was enough.
 *
 *   1. It was sh:sparql-only, and SHACL-SPARQL is not implemented by the engine that runs
 *      it. The anti-authority-smuggling defence was a dereferenceable name over an empty
 *      check — the exact facade this repo keeps finding.
 *   2. It declared NO TARGET, so it selected no focus node and would not have fired even
 *      against a SPARQL-capable engine.
 *
 * The second was found by attributing a "passing" probe's violations and discovering they
 * came from vldp:ConformanceShape instead. Without that attribution step this file would
 * have shipped as proof of a fix that did nothing — a green test over the same facade.
 *
 * ★ WHAT ACTUALLY CHANGED, AND WHAT DID NOT. The class-chain branch is now SHACL Core: a
 * zero-or-more alternative path over rdfs:subClassOf / owl:equivalentClass / owl:sameAs,
 * with sh:not [ sh:in … ]. The SPARQL query's other two branches quantify over "any
 * predicate of this node", and SHACL Core has no wildcard-predicate path, so they stay
 * SPARQL-only and stay unenforced here. Partial real enforcement beats total pretend
 * enforcement, and the shape's own comment says which half is which.
 *
 * ★ THE CASE THAT MATTERS MOST is owl:equivalentClass. sh:targetClass is subclass-aware
 * (rdfs:subClassOf*), so vldp:ConformanceShape already caught subClassOf smuggling by
 * accident of targeting. Equivalence is NOT in that closure — so before this, declaring
 * `ex:Innocent owl:equivalentClass hydra:Operation` and typing a node ex:Innocent smuggled
 * full execution authority past every check in the file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateAgainstShape, parseTrig } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHAPES = readFileSync(join(REPO, 'docs/ns/vault-ld.ttl'), 'utf8');

const P = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix ex: <https://example.org/> .
`;

/** Violations attributed to the entailment shape specifically, by its own message. */
const authorityViolations = (data: string): number =>
  validateAgainstShape(P + data, SHAPES, {}).results
    .filter(r => r.severity === 'Violation' && /reaches an execution-authority class/.test(r.message ?? ''))
    .length;

describe('smuggled execution authority is refused', () => {
  it('accepts a plain note — it constrains, it does not reject everything', () => {
    expect(authorityViolations('ex:n a ex:Note .')).toBe(0);
    expect(validateAgainstShape(P + 'ex:n a ex:Note .', SHAPES, {}).conforms).toBe(true);
  });

  it.each([
    ['directly typed as an authority class', 'ex:n a hydra:Operation .'],
    ['one rdfs:subClassOf hop', 'ex:S rdfs:subClassOf hydra:Operation . ex:n a ex:S .'],
    ['a two-hop subClassOf chain', 'ex:A rdfs:subClassOf hydra:Operation . ex:B rdfs:subClassOf ex:A . ex:n a ex:B .'],
    ['owl:equivalentClass', 'ex:Eq owl:equivalentClass hydra:Operation . ex:n a ex:Eq .'],
    ['owl:sameAs', 'ex:Same owl:sameAs hydra:Operation . ex:n a ex:Same .'],
  ])('%s is caught', (_label, data) => {
    expect(authorityViolations(data)).toBeGreaterThan(0);
  });

  it('★ owl:equivalentClass is caught by THIS shape and nothing else', () => {
    // The load-bearing assertion. sh:targetClass follows rdfs:subClassOf*, so the sibling
    // ConformanceShape catches subclass smuggling for free — and catches equivalence not at
    // all. If this shape regresses to inert, the whole-report check still passes on every
    // subClassOf case and only this one goes red.
    const data = 'ex:Eq owl:equivalentClass hydra:Operation . ex:n a ex:Eq .';
    const all = validateAgainstShape(P + data, SHAPES, {}).results
      .filter(r => r.severity === 'Violation');
    expect(all.length).toBe(1);
    expect(all[0]!.message).toMatch(/reaches an execution-authority class/);
  });

  it('and the shape declares a target, without which it selects nothing', () => {
    // Pins the second half of the original defect: a shape with constraints and no target is
    // indistinguishable at runtime from a shape with no constraints.
    //
    // ★ PARSED, NOT WINDOWED. The first version of this asserted
    // /vldp:EntailmentAuthorityShape[\s\S]{0,900}?sh:targetSubjectsOf/ — a fixed character
    // window between two tokens, which stops being true the moment the shape's comment
    // grows and is right for a reason unrelated to what it checks.
    // tests/a-proxy-that-is-right-until-something-grows.test.ts exists to refuse exactly
    // that, and refused this. The graph answers the question directly.
    const doc = parseTrig(SHAPES);
    const shape = doc.subjects.find(s =>
      s.subject === 'https://relay.interego.xwisee.com/ns/maintainer/vault-ld#EntailmentAuthorityShape');
    expect(shape, 'vldp:EntailmentAuthorityShape is not in the published file').toBeDefined();
    const targets = shape!.properties.get('http://www.w3.org/ns/shacl#targetSubjectsOf' as never) ?? [];
    expect(targets.length, 'the shape declares no target, so it selects no focus node')
      .toBeGreaterThan(0);
  });
});
