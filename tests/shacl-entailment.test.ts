/**
 * RDFS subclass entailment — closing a one-triple bypass of every class-targeted shape.
 *
 * ★ THE DEFECT. `validateAgainstShape` accepted an `entailment` option and threw it away
 * (`void options.entailment;`). The relay's publish gate has been passing
 * `{ entailment: 'rdfs' }` the entire time, believing it did something.
 *
 * Because `sh:targetClass` matched direct types only, ONE triple bypassed any
 * class-targeted shape:
 *
 *     ex:Sub rdfs:subClassOf ex:Target .
 *     ex:n a ex:Sub ; ex:anythingAtAll "…" .     # shape targeting ex:Target never fires
 *
 * For a closed privacy shape that is a total bypass with a conforming result. For
 * vault-ld's authority-class check it is precisely the smuggling attack that file
 * documents in its own comment.
 *
 * ★ Entailment stays OPT-IN and OFF by default, because SHACL's own default is
 * direct-type matching and a published shape must mean the same thing here as in
 * pySHACL. The relay turns it on at its gate deliberately.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstShape } from '@interego/core';

const P = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
`;
const SHAPE = P + `
ex:S a sh:NodeShape ; sh:targetClass ex:Turn ; sh:closed true ;
  sh:ignoredProperties ( rdf:type ) ;
  sh:property [ sh:path ex:allowed ; sh:minCount 1 ] .
`;
const conforms = (data: string, rdfs?: boolean) =>
  validateAgainstShape(P + data, SHAPE, rdfs ? { entailment: 'rdfs' } : {}).conforms;

describe('rdfs entailment', () => {
  it('is OFF by default, matching SHACL and every other processor', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" ; ex:secret "s" .`))
      .toBe(true);
  });

  it('ON, a subclass no longer escapes the shape', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" ; ex:secret "s" .`, true))
      .toBe(false);
  });

  it('is transitive across multiple levels', () => {
    expect(conforms(
      `ex:Mid rdfs:subClassOf ex:Turn . ex:Deep rdfs:subClassOf ex:Mid .\nex:n a ex:Deep ; ex:allowed "x" ; ex:secret "s" .`,
      true)).toBe(false);
  });

  it('terminates on a cyclic hierarchy instead of hanging', () => {
    expect(conforms(
      `ex:A rdfs:subClassOf ex:B . ex:B rdfs:subClassOf ex:A . ex:B rdfs:subClassOf ex:Turn .\nex:n a ex:A ; ex:allowed "x" ; ex:secret "s" .`,
      true)).toBe(false);
  });

  it('still accepts a conforming subclass instance — it constrains, it does not reject', () => {
    expect(conforms(`ex:Sub rdfs:subClassOf ex:Turn .\nex:n a ex:Sub ; ex:allowed "x" .`, true))
      .toBe(true);
  });

  it('an unrelated class is unaffected', () => {
    expect(conforms(`ex:Other a rdfs:Class .\nex:n a ex:Other ; ex:whatever "x" .`, true)).toBe(true);
  });
});
