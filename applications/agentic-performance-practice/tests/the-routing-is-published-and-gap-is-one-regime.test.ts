/**
 * The regime→method routing is published data, and gap-analysis belongs to exactly one regime.
 *
 * ★★ WHY THIS FILE EXISTS, AND WHY THE PREVIOUS SUITE WAS NOT ENOUGH.
 *
 * `methodForRegime` was a four-branch if-chain. `ontology/agp.ttl` stated the same routing three
 * more times — in each regime's `rdfs:comment` ("Method: apply established practice"), in each
 * method's `rdfs:label` ("(Evident)", "(Knowable ONLY)") — and `agp:PerformanceMethod`'s own
 * comment admitted where the decision actually lived: "enforced in code by the regime-source
 * discipline, not by SHACL". Four statements of one rule; three unreadable by any machine.
 *
 * The routing is now `agp:routesTo` edges the engine parses. But moving a rule into data only
 * helps if something checks the data, and MEASURED: with the routing extracted, changing
 * `agp:Knowable agp:routesTo agp:GapAnalysis` to `agp:StabiliseFirst` left all 16 existing agp
 * tests GREEN. Deleting an edge was caught (the engine throws); pointing one at the wrong method
 * was not. A rule in data with nothing asserting its content is not better than the if-chain — it
 * is the same rule, one indirection further from the reader.
 *
 * ★ THE LOAD-BEARING CLAIM. This vertical exists to say the gap frame fits Knowable work ONLY;
 * routing any other regime into it is the category error the whole module is written against, and
 * a defect of exactly that shape has already shipped here once (every human was forced into
 * Knowable, so a person doing genuinely Emergent work was always told to go on a course). So the
 * assertion is two-sided: Knowable routes to gap-analysis, AND nothing else does.
 */

import { describe, it, expect } from 'vitest';
import {
  findSubjectsOfType,
  type IRI,
  parseTrig,
  readIriValue,
  readStringValue,
} from '@interego/core';
import { AGP_NS, readOntologyTurtle } from '../src/ontology.js';

const doc = parseTrig(readOntologyTurtle());

/** regime local name -> method IRI, straight from the published graph. */
function publishedRouting(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of findSubjectsOfType(doc, `${AGP_NS}WorkRegime` as IRI)) {
    const iri = typeof s.subject === 'string' ? String(s.subject) : undefined;
    const to = readIriValue(s, `${AGP_NS}routesTo` as IRI);
    if (iri && to) out.set(iri.replace(AGP_NS, ''), String(to).replace(AGP_NS, ''));
  }
  return out;
}

/** method local name -> published wire token. */
function publishedTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of findSubjectsOfType(doc, `${AGP_NS}PerformanceMethod` as IRI)) {
    const iri = typeof s.subject === 'string' ? String(s.subject) : undefined;
    const t = readStringValue(s, `${AGP_NS}methodToken` as IRI);
    if (iri && t) out.set(iri.replace(AGP_NS, ''), t);
  }
  return out;
}

describe('the regime→method routing is published', () => {
  it('publishes an edge for every regime the type admits', () => {
    const routing = publishedRouting();
    // Guard the guard: a parse that found nothing would make every assertion below vacuous.
    expect(routing.size, 'parsed no agp:routesTo edges at all').toBeGreaterThan(0);
    for (const regime of ['Evident', 'Knowable', 'Emergent', 'Turbulent']) {
      expect(routing.get(regime), `no agp:routesTo published for agp:${regime}`).toBeDefined();
    }
    expect(routing.size).toBe(4);
  });

  it('routes each regime to the method its own prose has always named', () => {
    const routing = publishedRouting();
    expect(routing.get('Evident')).toBe('ApplyPractice');
    expect(routing.get('Knowable')).toBe('GapAnalysis');
    expect(routing.get('Emergent')).toBe('DispositionalRead');
    expect(routing.get('Turbulent')).toBe('StabiliseFirst');
  });

  /**
   * The two-sided assertion. "Knowable → gap-analysis" alone would still pass if EVERY regime
   * routed there, which is the exact defect this vertical has shipped before.
   */
  it('gives gap-analysis to Knowable and to nothing else', () => {
    const routing = publishedRouting();
    const toGap = [...routing.entries()].filter(([, m]) => m === 'GapAnalysis').map(([r]) => r);
    expect(toGap, `gap-analysis is Knowable ONLY; these regimes also route to it: ${toGap.join(', ')}`)
      .toEqual(['Knowable']);
  });

  it('publishes a wire token for every method, so the kebab-case spelling is data too', () => {
    const tokens = publishedTokens();
    expect(tokens.size).toBeGreaterThanOrEqual(5);
    expect(tokens.get('ApplyPractice')).toBe('apply-practice');
    expect(tokens.get('GapAnalysis')).toBe('gap-analysis');
    expect(tokens.get('DispositionalRead')).toBe('dispositional-read');
    expect(tokens.get('StabiliseFirst')).toBe('stabilise-first');
    expect(tokens.get('ClassifyFirst')).toBe('classify-first');
  });

  it('routes only to methods that exist and carry a token', () => {
    const tokens = publishedTokens();
    for (const [regime, method] of publishedRouting()) {
      expect(tokens.get(method), `agp:${regime} routes to agp:${method}, which publishes no token`)
        .toBeDefined();
    }
  });

  /**
   * classify-first is the answer to having NO regime, not a regime's method. If an edge ever
   * pointed at it, a classified situation would be told to classify itself.
   */
  it('never routes a regime to classify-first', () => {
    const toClassify = [...publishedRouting().entries()].filter(([, m]) => m === 'ClassifyFirst');
    expect(toClassify.map(([r]) => r)).toEqual([]);
  });
});
