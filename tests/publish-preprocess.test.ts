/**
 * publish-preprocess — cleartext-mirror extractor tests.
 *
 * These pin the behavior surfaced by the 2026-04-21 scientific-debate
 * stress test: IRIs mentioned inside a SPARQL ASK query (wrapped in
 * Turtle triple-quoted literals) MUST NOT be lifted as top-level
 * descriptor facts. Likewise for IRIs inside `#` line comments.
 */

import { describe, it, expect } from 'vitest';
import {
  extractRevocationConditions,
  normalizePublishInputs,
  stripStringsAndComments,
} from '@interego/core';

describe('stripStringsAndComments', () => {
  it('preserves total length (indices remain valid)', () => {
    const input = 'foo "bar" # comment\n<x> .';
    expect(stripStringsAndComments(input).length).toBe(input.length);
  });

  it('blanks single-quoted string contents', () => {
    const cleaned = stripStringsAndComments('<a> <p> "conformsTo <x>" .');
    expect(cleaned).not.toContain('<x>');
    expect(cleaned).toContain('<a>');
  });

  it('blanks triple-quoted string contents', () => {
    const turtle = `<a> <p> """
      ASK WHERE { ?d dct:conformsTo <inside> }
    """ .`;
    const cleaned = stripStringsAndComments(turtle);
    expect(cleaned).not.toContain('<inside>');
    expect(cleaned).toContain('<a>');
  });

  it('blanks line comments', () => {
    const cleaned = stripStringsAndComments('# dct:conformsTo <x>\n<a> <p> <b> .');
    expect(cleaned).not.toContain('<x>');
    expect(cleaned).toContain('<b>');
  });

  it('preserves newlines inside triple-quoted strings', () => {
    const input = '"""a\nb\nc"""';
    const out = stripStringsAndComments(input);
    expect(out.match(/\n/g)?.length).toBe(2);
  });
});

describe('normalizePublishInputs — modal-status default', () => {
  it('defaults to Asserted / 0.85 when modalStatus + confidence are unset', () => {
    // Pin the principled default: an explicit publish_context call is
    // semantically an Assertion — the caller stepped over the screening
    // + auto-supersede gates to commit a claim. The user-facing docs
    // (docs/FIRST-HOUR.md, docs/AGENT-INTEGRATION-GUIDE.md, the path-5
    // Hermes provider doc) and the L2 integration shims
    // (integrations/openclaw-memory, integrations/hermes-memory) all
    // encode the same intent: a publish lands as Asserted at 0.85.
    // Callers recording inferred-but-uncommitted observations must pass
    // Hypothetical explicitly.
    const result = normalizePublishInputs({});
    expect(result.semiotic.modalStatus).toBe('Asserted');
    expect(result.semiotic.epistemicConfidence).toBe(0.85);
    expect(result.semiotic.groundTruth).toBe(true); // Asserted → groundTruth = true
  });

  it('still honors explicit modal status', () => {
    expect(normalizePublishInputs({ modalStatus: 'Hypothetical' }).semiotic.modalStatus).toBe('Hypothetical');
    expect(normalizePublishInputs({ modalStatus: 'Counterfactual' }).semiotic.modalStatus).toBe('Counterfactual');
  });
});

describe('normalizePublishInputs — cleartext mirror', () => {
  it('lifts top-level dct:conformsTo to descriptor', () => {
    const result = normalizePublishInputs({
      graphContent: `
        @prefix dct: <http://purl.org/dc/terms/> .
        <urn:claim> dct:conformsTo <https://example.org/schema/v1> .
      `,
    });
    expect(result.conformsTo).toContain('https://example.org/schema/v1');
  });

  it('lifts top-level prov:wasDerivedFrom', () => {
    const result = normalizePublishInputs({
      graphContent: `
        @prefix prov: <http://www.w3.org/ns/prov#> .
        <urn:b> prov:wasDerivedFrom <urn:a> .
      `,
    });
    expect(result.wasDerivedFrom).toContain('urn:a');
  });

  it('does NOT lift dct:conformsTo mentioned inside a SPARQL string literal', () => {
    // This is the exact bug surfaced by the Alpha-revised test: an IRI
    // mentioned inside a `"""ASK ... dct:conformsTo <x> ..."""` must
    // not be treated as a descriptor-level conformsTo claim.
    const result = normalizePublishInputs({
      graphContent: `
        @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
        @prefix dct: <http://purl.org/dc/terms/> .
        <urn:claim> iep:revokedIf [
          iep:successorQuery """
            ASK WHERE {
              ?d dct:conformsTo <https://example.org/schemas/replication-v2> .
            }
          """ ;
          iep:evaluationScope iep:LocalPod ;
          iep:onRevocation iep:DowngradeToHypothetical
        ] .
      `,
    });
    expect(result.conformsTo).not.toContain('https://example.org/schemas/replication-v2');
    expect(result.conformsTo).toEqual([]);
  });

  it('does NOT lift IRIs in # line comments', () => {
    const result = normalizePublishInputs({
      graphContent: `
        # dct:conformsTo <https://example.org/schema/never> — commented out
        @prefix dct: <http://purl.org/dc/terms/> .
        <urn:claim> dct:conformsTo <https://example.org/schema/real> .
      `,
    });
    expect(result.conformsTo).toContain('https://example.org/schema/real');
    expect(result.conformsTo).not.toContain('https://example.org/schema/never');
  });

  it('still extracts the revocation condition when the successorQuery contains IRIs', () => {
    // The inner SPARQL IRI must still be preserved *inside* the
    // revokedIf successorQuery — only the top-level extractor must
    // ignore it. This pins both halves of the two-pass design.
    const result = normalizePublishInputs({
      graphContent: `
        @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
        <urn:claim> iep:revokedIf [
          iep:successorQuery """
            ASK WHERE { ?d dct:conformsTo <https://example.org/schemas/v2> . }
          """ ;
          iep:evaluationScope iep:LocalPod ;
          iep:onRevocation iep:MarkInvalid
        ] .
      `,
    });
    expect(result.semiotic.revokedIf).toBeDefined();
    const rev = result.semiotic.revokedIf!;
    expect(rev.length).toBe(1);
    expect(rev[0]!.successorQuery).toContain('dct:conformsTo <https://example.org/schemas/v2>');
    expect(rev[0]!.evaluationScope).toBe('LocalPod');
    expect(rev[0]!.onRevocation).toBe('MarkInvalid');
  });

  it('deduplicates repeated IRIs', () => {
    const result = normalizePublishInputs({
      graphContent: `
        <urn:a> iep:supersedes <urn:old> , <urn:old> .
        <urn:b> iep:supersedes <urn:old> .
      `,
    });
    expect(result.supersedes).toEqual(['urn:old']);
  });

  it('handles Turtle object-list shorthand: predicate <a>, <b>, <c>', () => {
    // Surfaced 2026-04-21 by the emergent-semiotics demo: a synthesis
    // descriptor cited three contributors via `prov:wasDerivedFrom <a>,
    // <b>, <c>` and only the first IRI was lifted.
    const result = normalizePublishInputs({
      graphContent: `
        @prefix prov: <http://www.w3.org/ns/prov#> .
        <urn:synthesis> prov:wasDerivedFrom
          <urn:contributor:a> ,
          <urn:contributor:b> ,
          <urn:contributor:c> .
      `,
    });
    expect(result.wasDerivedFrom).toContain('urn:contributor:a');
    expect(result.wasDerivedFrom).toContain('urn:contributor:b');
    expect(result.wasDerivedFrom).toContain('urn:contributor:c');
    expect(result.wasDerivedFrom.length).toBe(3);
  });

  it('object-list still respects string-literal boundaries', () => {
    // Combined regression: object-list extraction must not be tricked
    // into matching commas inside SPARQL strings either.
    const result = normalizePublishInputs({
      graphContent: `
        @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
        @prefix prov: <http://www.w3.org/ns/prov#> .
        <urn:synthesis> prov:wasDerivedFrom <urn:real:a> , <urn:real:b> ;
          iep:revokedIf [
            iep:successorQuery """
              SELECT * WHERE {
                ?d prov:wasDerivedFrom <urn:fake:x> , <urn:fake:y> .
              }
            """ ;
            iep:evaluationScope iep:LocalPod ;
            iep:onRevocation iep:MarkInvalid
          ] .
      `,
    });
    expect(result.wasDerivedFrom).toEqual(['urn:real:a', 'urn:real:b']);
  });
});

describe('extractRevocationConditions — bracket matching', () => {
  it('handles nested blank nodes inside revokedIf', () => {
    const turtle = `
      @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
      <urn:x> iep:revokedIf [
        iep:successorQuery "ASK { ?d a [ a iep:Foo ] }" ;
        iep:evaluationScope iep:LocalPod
      ] .
    `;
    const results = extractRevocationConditions(turtle);
    expect(results.length).toBe(1);
    expect(results[0]!.successorQuery).toContain('ASK');
  });

  it('returns [] when successorQuery is missing', () => {
    const turtle = `
      @prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
      <urn:x> iep:revokedIf [
        iep:evaluationScope iep:LocalPod
      ] .
    `;
    expect(extractRevocationConditions(turtle)).toEqual([]);
  });
});
