/**
 * The I2IDL glossary as data: I2IDL's release read as published, the two derivations I2IDL-X makes
 * from it (definition provenance in I2IDL's own card wording, and the reuse class of a definition's
 * direct sources), I2IDL-X's surface forms for finding terms in text, and I2IDL-X's Hypothetical
 * layers read from the relay's expanded JSON-LD.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_WORDING, conceptMatcher, glossaryLoader, i2idlCardUrl, parseI2idlGlossary, parseI2idlxDecorations, reuseClassOf, surfaceForms,
} from '../src/i2idl-glossary.js';
import { glossaryJsonLd, i2idlxGraphs } from './support/i2idl-glossary-fixture.js';

const I2 = 'https://id.i2idl.org/concepts/';
const g = parseI2idlGlossary(glossaryJsonLd);
const byId = (id: string) => g.byIri.get(I2 + id)!;

describe('I2IDL\'s release, read as published', () => {
  it('reads the scheme, every concept, and every source with its rights', () => {
    expect(g.title).toBe('I2IDL Digital Learning Glossary');
    expect(g.release).toBe('v0.0.86');
    expect(g.rights).toMatch(/^Mixed rights\. I2IDL-original material defaults to CC BY 4\.0/);
    expect(g.concepts).toHaveLength(6);
    expect(g.sources.size).toBe(5);
    const lrs = byId('learning-record-store-lrs');
    expect(lrs).toMatchObject({ id: 'learning-record-store-lrs', label: 'Learning Record Store (LRS)', altLabels: ['LRS'], definition: 'A store that keeps learning records sent to it.' });
    expect(lrs.broader).toEqual([`${I2}experience-api-xapi`]);
    expect(lrs.evidence.map(e => [e.relation, e.citation])).toEqual([['direct', 'LeBOK §1'], ['supporting', 'Modernizing Learning §1']]);
    expect(i2idlCardUrl(lrs)).toBe('https://www.i2idl.org/glossary#learning-record-store-lrs');
  });

  it('words a definition\'s provenance as I2IDL\'s cards do: direct when any evidence is direct', () => {
    expect(PROVENANCE_WORDING).toEqual({ direct: 'Direct source definition', synthesis: 'I2IDL synthesis supported by source evidence' });
    expect(byId('formative-assessment').provenance).toBe('direct');
    expect(byId('feedback').provenance).toBe('synthesis');
  });

  it('classes reuse by the most restrictive source a definition directly rests on', () => {
    expect(['CC BY 4.0', 'Apache 2.0', 'CC BY-SA 3.0 IGO', 'CC BY-NC-SA 4.0', 'Used with permission', 'IEEE terms apply'].map(reuseClassOf))
      .toEqual(['open', 'open', 'sharealike', 'nc', 'permission', 'permission']);
    expect(byId('learning-record-store-lrs').reuse).toBe('permission');   // LeBOK, direct; the CC BY supporting source does not lift it
    expect(byId('learning-engineering').reuse).toBe('nc');
    expect(byId('experience-api-xapi').reuse).toBe('open');
    expect(byId('feedback').reuse).toBe('open');                        // I2IDL's own synthesis: CC BY 4.0
  });

  it('refuses a document that is not a glossary release', () => {
    expect(() => parseI2idlGlossary({ '@graph': [] })).toThrow(/no skos:ConceptScheme/);
    expect(() => parseI2idlGlossary(null)).toThrow();
  });
});

describe('finding I2IDL terms in text', () => {
  const m = conceptMatcher(g.concepts);

  it('splits "Label (ACR)" and marks single plain words weak', () => {
    expect(surfaceForms('Learning Record Store (LRS)', ['LRS'])).toEqual([
      { form: 'Learning Record Store (LRS)', strong: true }, { form: 'Learning Record Store', strong: true }, { form: 'LRS', strong: true },
    ]);
    expect(surfaceForms('Feedback')).toEqual([{ form: 'Feedback', strong: false }]);
  });

  it('takes the longest form first and never overlaps', () => {
    const found = m.find('A Learning Record Store (LRS) keeps xAPI statements; the LRS answers queries.');
    expect(found.map(f => [f.form, f.iri.slice(I2.length)])).toEqual([
      ['Learning Record Store (LRS)', 'learning-record-store-lrs'], ['xAPI', 'experience-api-xapi'], ['LRS', 'learning-record-store-lrs'],
    ]);
  });

  it('gives a shared form to the concept whose own label carries it', () => {
    // "xAPI" is the IEEE standard's alternate label too; it goes to Experience API (xAPI).
    expect(m.find('xAPI').map(f => f.iri)).toEqual([`${I2}experience-api-xapi`]);
    expect(m.formsOf(`${I2}ieee-xapi-base-standard`).map(f => f.form)).toEqual(['IEEE xAPI Base Standard']);
  });

  it('matches short acronyms by case, longer forms in any case, and weak forms only when asked', () => {
    expect(m.find('the lrs')).toEqual([]);
    expect(m.find('FORMATIVE ASSESSMENT matters').map(f => f.iri)).toEqual([`${I2}formative-assessment`]);
    expect(m.find('Good feedback helps')).toEqual([]);
    expect(m.find('Good feedback helps', { weak: true }).map(f => f.iri)).toEqual([`${I2}feedback`]);
    expect(m.find('feedbacks and pre-feedback', { weak: true })).toEqual([]);   // whole words only
  });
});

describe('I2IDL-X\'s layers, from the relay\'s expanded JSON-LD', () => {
  const d = parseI2idlxDecorations(i2idlxGraphs);

  it('reads each concept\'s referent category with its label and rationale', () => {
    expect(d.referents.get(`${I2}learning-record-store-lrs`)).toEqual({
      category: 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#category-application', label: 'Application or platform',
      rationale: 'A software system people or services use.', basis: 'type',
    });
    expect(d.referents.get(`${I2}formative-assessment`)?.label).toBe('Assessment, evaluation or test');
  });

  it('reads enactments whether their type is written as @type or as rdf:type, and nothing else', () => {
    expect(d.enactments.get(`${I2}learning-record-store-lrs`)).toEqual([{
      action: 'https://relay.interego.xwisee.com/ns/iep/action/foxxi/discover-lrs',
      role: 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#role-realizes', roleLabel: 'realizes',
      status: 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#status-proposed', statusLabel: 'proposed',
      rationale: 'Reads the LRS\'s own about document.', confidence: 0.9,
    }]);
    expect(d.enactments.get(`${I2}formative-assessment`)).toHaveLength(1);
    expect(d.enactments.has(`${I2}feedback`)).toBe(false);
  });
});

describe('the loader', () => {
  const respond = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
  function fakeFetch(fail: { glossary?: boolean; i2idlx?: boolean } = {}) {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('glossary.jsonld')) return fail.glossary ? respond({}, 503) : respond(glossaryJsonLd);
      if (fail.i2idlx) return respond({}, 502);
      if (url.endsWith('/i2idlx')) return respond(i2idlxGraphs.ontology);
      if (url.endsWith('/i2idlx-referents')) return respond(i2idlxGraphs.referents);
      if (url.endsWith('/i2idlx-enactments')) return respond(i2idlxGraphs.enactments);
      return respond({}, 404);
    }) as typeof fetch;
    return { fn, calls };
  }

  it('reads once a day, and shares one read between concurrent callers', async () => {
    let t = 0;
    const f = fakeFetch();
    const load = glossaryLoader({ fetch: f.fn, now: () => t });
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(a?.glossary.concepts).toHaveLength(6);
    expect(a?.decorations?.referents.size).toBe(2);
    expect(f.calls).toHaveLength(4);
    t += 60 * 60_000;
    await load();
    expect(f.calls).toHaveLength(4);
    t += 24 * 60 * 60_000;
    await load();
    expect(f.calls).toHaveLength(8);
  });

  it('answers with I2IDL\'s record alone when I2IDL-X cannot be read, and with nothing while I2IDL cannot', async () => {
    const partial = await glossaryLoader({ fetch: fakeFetch({ i2idlx: true }).fn })();
    expect(partial?.glossary.release).toBe('v0.0.86');
    expect(partial?.decorations).toBeUndefined();
    let t = 0;
    const down = fakeFetch({ glossary: true });
    const load = glossaryLoader({ fetch: down.fn, now: () => t });
    expect(await load()).toBeNull();
    expect(await load()).toBeNull();
    expect(down.calls).toHaveLength(1);   // a failure is not retried on every ask
    t += 61_000;
    await load();
    expect(down.calls).toHaveLength(2);
  });
});
