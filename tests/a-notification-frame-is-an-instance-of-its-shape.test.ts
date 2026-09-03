/**
 * The frame the relay emits IS an instance of the shape the relay publishes.
 *
 * ── ★★ THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `iep:NotificationShape` targets `iep:Notification` and requires `iep:podUrl`,
 * `iep:descriptorUrl` and `iep:eventType`, with optional `dct:created` / `prov:wasAttributedTo`.
 * The relay emitted its SSE and webhook frames under
 *
 *     "@context": "https://markjspivey-xwisee.github.io/interego/ns/iep#"
 *
 * which is the TURTLE NAMESPACE IRI, not the published JSON-LD context document. A namespace IRI
 * defines no terms, so `podUrl`, `descriptorUrl`, `eventType`, `timestamp` and `author` were all
 * undefined terms, `type` was not aliased to `@type`, and the frame expanded to an anonymous node
 * with no type and no properties at all.
 *
 * ★★ AND THE PUBLISHED ONTOLOGY WROTE THAT DOWN INSTEAD OF CLOSING IT — the shape's own comment
 * held a paragraph explaining the mismatch and ending "belongs to whoever owns that decision",
 * on the reasoning that changing the emitted keys or the published context is a wire-format
 * change. That is true of the keys and false of the fix actually available: the keys are
 * UNCHANGED, the published context gained the term definitions, and `@context` now names the
 * document that defines them. A consumer reading raw JSON sees the same keys and values; a
 * consumer that expands stops losing every field.
 *
 * ── WHY IT WAS NEVER CAUGHT ─────────────────────────────────────────────────────────────────
 *
 * Validating an EMPTY graph against a NodeShape conforms — vacuously, because nothing is targeted.
 * So a gate that expanded the frame and asked "does it conform?" would have said yes throughout.
 * The first leg here is therefore not conformance but PRESENCE: the expansion must produce a node
 * typed `iep:Notification` carrying the required properties. Only then is conformance meaningful.
 *
 * Nothing is hand-written: the frame comes from the relay's own builder, the context from the
 * published document on disk, and the shapes from `docs/ns/iep.ttl`. The network is not touched —
 * the document loader serves the published file for its own URL, and fails loudly for anything
 * else rather than reaching out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
import { validateAgainstShape } from '@interego/core';
import {
  buildNotificationEvent,
  NOTIFICATION_CONTEXT_URL,
} from '../deploy/mcp-relay/notification-event.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const DCT = 'http://purl.org/dc/terms/';
const PROV = 'http://www.w3.org/ns/prov#';

const CONTEXT_FILE = new URL('../docs/ns/iep/v1.json', import.meta.url);
const SHAPES = readFileSync(new URL('../docs/ns/iep.ttl', import.meta.url), 'utf8');

/**
 * Serves the published context for its own URL and refuses everything else.
 *
 * A loader that silently returned an empty context would make every leg below pass while proving
 * nothing — the exact failure mode being fixed. It throws instead.
 */
const documentLoader = async (url: string): Promise<{ documentUrl: string; document: unknown }> => {
  if (url !== NOTIFICATION_CONTEXT_URL) {
    throw new Error(`this gate does not reach the network; the frame asked for ${url}, and only `
      + `${NOTIFICATION_CONTEXT_URL} is served from docs/ns/iep/v1.json`);
  }
  return {
    documentUrl: url,
    document: JSON.parse(readFileSync(CONTEXT_FILE, 'utf8')) as unknown,
  };
};

/**
 * The promise half of the jsonld API, named once.
 *
 * `@types/jsonld` declares callback overloads first, so `expand(doc, options)` resolves to the
 * `void`-returning signature and every call site needs a cast. One narrow declaration here is
 * honest about that; casting at each call site would hide which shape is actually relied on.
 */
const jld = jsonld as unknown as {
  expand(doc: unknown, options: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  toRDF(doc: unknown, options: Record<string, unknown>): Promise<string>;
};

const FRAME = buildNotificationEvent('https://pod.example.test/alice/', {
  eventType: 'superseded',
  descriptorUrl: 'https://pod.example.test/alice/context-graphs/d1.ttl',
  graphUrl: 'https://pod.example.test/alice/context-graphs/d1-graph.trig',
  author: 'did:ethr:0x00000000000000000000000000000000000000aa',
  timestamp: '2026-09-03T00:00:00.000Z',
});

async function expanded(): Promise<Record<string, unknown>[]> {
  return await jld.expand(FRAME, { documentLoader });
}

async function nquads(): Promise<string> {
  return await jld.toRDF(FRAME, { documentLoader, format: 'application/n-quads' });
}

describe('the emitted frame points at a context that defines its terms', () => {
  it('names the published context document, not the Turtle namespace IRI', () => {
    expect(FRAME['@context'], 'a namespace IRI is not a context: it defines no terms, so every '
      + 'key in the frame expands to nothing').toBe(NOTIFICATION_CONTEXT_URL);
    expect(FRAME['@context'], 'the context must be a retrievable document').toMatch(/\.json$/);
  });

  it('★ every key the builder emits is defined in the published context', () => {
    // Driven from the frame itself rather than a list, so a key added to the builder without a
    // term definition fails here instead of expanding to nothing in production.
    const ctx = (JSON.parse(readFileSync(CONTEXT_FILE, 'utf8')) as {
      '@context': Record<string, unknown>;
    })['@context'];
    const undefinedTerms = Object.keys(FRAME)
      .filter((k) => !k.startsWith('@'))
      .filter((k) => ctx[k] === undefined);
    expect(
      undefinedTerms,
      'these keys are emitted on every notification and defined nowhere in the published '
        + 'context, so a JSON-LD consumer drops them silently: ' + undefinedTerms.join(', '),
    ).toEqual([]);
  });
});

describe('the frame expands to the properties the shape requires', () => {
  it('★ carries the type and every required property after expansion', async () => {
    // PRESENCE, checked before conformance: an empty graph CONFORMS to a NodeShape, so the
    // conformance leg below is meaningless without this one.
    const [node] = await expanded();
    expect(node, 'the frame expanded to nothing at all').toBeDefined();
    expect(node?.['@type'], 'the frame is not typed iep:Notification, so the shape does not '
      + 'target it and validating it conforms vacuously').toEqual([`${IEP}Notification`]);
    for (const property of [`${IEP}podUrl`, `${IEP}descriptorUrl`, `${IEP}eventType`]) {
      expect(node?.[property], `${property} is required by iep:NotificationShape and is absent `
        + 'from the expanded frame').toBeDefined();
    }
  });

  it('★ timestamp and author expand to dct:created and prov:wasAttributedTo', async () => {
    // These two are the named casualties: undefined terms in the old context, so the values were
    // on the wire and meant nothing.
    const [node] = await expanded();
    expect(node?.[`${DCT}created`], 'timestamp does not expand to dct:created').toBeDefined();
    expect(node?.[`${PROV}wasAttributedTo`], 'author does not expand to prov:wasAttributedTo')
      .toBeDefined();
    expect(node?.['timestamp'], 'timestamp survived expansion as a literal key, which means it '
      + 'was treated as an undefined term').toBeUndefined();
  });

  it('types the URL values as xsd:anyURI, which the shape constrains', async () => {
    const [node] = await expanded();
    const pod = (node?.[`${IEP}podUrl`] as { '@type'?: string }[] | undefined)?.[0];
    expect(pod?.['@type'], 'iep:NotificationShape declares sh:datatype xsd:anyURI on iep:podUrl')
      .toBe('http://www.w3.org/2001/XMLSchema#anyURI');
  });
});

describe('the expanded frame satisfies iep:NotificationShape', () => {
  it('★ conforms, on a graph that is demonstrably not empty', async () => {
    const rdf = await nquads();
    // The guard the conformance answer needs: N-Quads with no lines is a graph that conforms to
    // everything. Six triples are expected — type + 6 properties, minus none.
    const lines = rdf.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length, 'the frame produced no triples, so conformance below is vacuous')
      .toBeGreaterThanOrEqual(6);
    expect(rdf, 'the graph does not name the class the shape targets').toContain(`${IEP}Notification`);

    const report = validateAgainstShape(rdf, SHAPES, { entailment: 'rdfs' });
    expect(
      report.conforms ? '' : report.results.map((r) => `${r.message ?? ''}`).join(' | '),
      'the frame the relay emits does not satisfy the shape the relay publishes',
    ).toBe('');
  });

  it('★ and the shape can still REJECT — an eventType outside its enumeration fails', async () => {
    // Proves the validation above is doing work. `sh:in ("created" "updated" "superseded")`.
    const bad = { ...FRAME, eventType: 'deleted' as 'created' };
    const rdf = await jld.toRDF(bad, { documentLoader, format: 'application/n-quads' });
    const report = validateAgainstShape(rdf, SHAPES, { entailment: 'rdfs' });
    expect(report.conforms, 'an eventType outside the published enumeration was accepted, so '
      + 'the conformance leg above proves nothing').toBe(false);
  });
});
