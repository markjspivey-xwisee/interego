/**
 * @module rdf/virtualized-layer
 * @description Bidirectional virtualized RDF layer over PGSL.
 *
 * Provides:
 *   1. Complete materialized RDF view of the entire system
 *      (PGSL nodes, descriptors, coherence, persistence, constraints, pods)
 *   2. Write-back: RDF mutations (INSERT triples) flow back into PGSL operations
 *   3. Standard SPARQL Protocol support for the server
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance, Value } from '../pgsl/types.js';
import type { ContextDescriptorData } from '../model/types.js';
import type { CoherenceCertificate } from '../pgsl/coherence.js';
import type { PersistenceRegistry } from '../pgsl/persistence.js';
import { mintAtom, ingest } from '../pgsl/lattice.js';
import {
  materializeTriples,
  addTriple,
  executeSparqlString,
} from '../pgsl/sparql-engine.js';
import type { Triple, TripleStore } from '../pgsl/sparql-engine.js';
import { toTurtle } from '../rdf/serializer.js';
import { PGSL_NS } from '../pgsl/rdf.js';

// ── Namespaces ────────────────────────────────────────────────

const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/cg#' as const;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
const DCT_NS = 'http://purl.org/dc/terms/';
const DCAT_NS = 'http://www.w3.org/ns/dcat#';

// ── Types ─────────────────────────────────────────────────────

/** The full system state for RDF virtualization */
export interface SystemState {
  readonly pgsl: PGSLInstance;
  readonly descriptors: readonly ContextDescriptorData[];
  readonly certificates: readonly CoherenceCertificate[];
  readonly persistenceRegistry?: PersistenceRegistry;
  readonly constraints: readonly any[]; // ParadigmConstraint from server
  readonly pods: readonly { url: string; name: string; status: string; descriptorCount: number }[];
}

/** Result of a SPARQL Protocol request */
export interface SparqlProtocolResult {
  readonly contentType: string; // application/sparql-results+json or text/turtle
  readonly body: string;
}

/** Write-back result from an RDF mutation */
export interface WriteBackResult {
  readonly success: boolean;
  readonly triplesAdded: number;
  readonly pgslMutations: number; // atoms/fragments created in PGSL
  readonly errors: readonly string[];
}

// ── Helpers ───────────────────────────────────────────────────

function cgIri(local: string): string {
  return `${CG_NS}${local}`;
}

function pgslIri(local: string): string {
  return `${PGSL_NS}${local}`;
}

function lit(value: string | number, datatype?: string): string {
  if (datatype) return `"${value}"^^${datatype}`;
  return `"${value}"`;
}

function xsdLit(value: string | number, type: string): string {
  return lit(value, `${XSD_NS}${type}`);
}

let _bnodeCounter = 0;
function freshBnode(): string {
  return `_:vl_b${++_bnodeCounter}`;
}

/** Extract the local name from an IRI (after last # or /) */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash >= 0) return iri.slice(slash + 1);
  return iri;
}

// ── 1. materializeSystem ──────────────────────────────────────

/**
 * Creates a COMPLETE triple store from all system state.
 *
 * Materializes PGSL atoms/fragments, context descriptors,
 * coherence certificates, persistence records, paradigm
 * constraints, and pod metadata into a single indexed
 * triple store.
 */
export function materializeSystem(state: SystemState): TripleStore {
  // Start with the PGSL lattice materialization
  const store = materializeTriples(state.pgsl);

  // ── Context Descriptors ────────────────────────────────────
  for (const desc of state.descriptors) {
    const descId = desc.id as string;
    addTriple(store, { subject: descId, predicate: RDF_TYPE, object: cgIri('ContextDescriptor') });

    for (const graph of desc.describes) {
      addTriple(store, { subject: descId, predicate: cgIri('describes'), object: graph as string });
    }

    if (desc.version !== undefined) {
      addTriple(store, {
        subject: descId,
        predicate: cgIri('version'),
        object: xsdLit(desc.version, 'integer'),
      });
    }

    if (desc.validFrom) {
      addTriple(store, {
        subject: descId,
        predicate: cgIri('validFrom'),
        object: xsdLit(desc.validFrom, 'dateTime'),
      });
    }

    if (desc.validUntil) {
      addTriple(store, {
        subject: descId,
        predicate: cgIri('validUntil'),
        object: xsdLit(desc.validUntil, 'dateTime'),
      });
    }

    // Facets
    for (const facet of desc.facets) {
      const facetBnode = freshBnode();
      addTriple(store, { subject: descId, predicate: cgIri('hasFacet'), object: facetBnode });
      addTriple(store, {
        subject: facetBnode,
        predicate: RDF_TYPE,
        object: cgIri(`${facet.type}Facet`),
      });

      // Serialize key facet properties
      if (facet.type === 'Temporal') {
        if (facet.validFrom) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('validFrom'),
            object: xsdLit(facet.validFrom, 'dateTime'),
          });
        }
        if (facet.validUntil) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('validUntil'),
            object: xsdLit(facet.validUntil, 'dateTime'),
          });
        }
      }

      if (facet.type === 'Agent' && facet.assertingAgent) {
        const agentBnode = freshBnode();
        addTriple(store, { subject: facetBnode, predicate: cgIri('assertingAgent'), object: agentBnode });
        if (facet.assertingAgent.label) {
          addTriple(store, {
            subject: agentBnode,
            predicate: cgIri('agentLabel'),
            object: lit(facet.assertingAgent.label),
          });
        }
      }

      if (facet.type === 'Federation') {
        if (facet.origin) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('origin'),
            object: facet.origin as string,
          });
        }
        if (facet.storageEndpoint) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('storageEndpoint'),
            object: facet.storageEndpoint as string,
          });
        }
      }

      if (facet.type === 'Semiotic') {
        if (facet.epistemicConfidence !== undefined) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('epistemicConfidence'),
            object: xsdLit(facet.epistemicConfidence, 'decimal'),
          });
        }
      }

      if (facet.type === 'Trust') {
        if (facet.trustLevel) {
          addTriple(store, {
            subject: facetBnode,
            predicate: cgIri('trustLevel'),
            object: cgIri(facet.trustLevel),
          });
        }
      }
    }
  }

  // ── Coherence Certificates ─────────────────────────────────
  for (const cert of state.certificates) {
    const certId = cert.id;
    addTriple(store, { subject: certId, predicate: RDF_TYPE, object: cgIri('CoherenceCertificate') });
    addTriple(store, { subject: certId, predicate: cgIri('agentA'), object: lit(cert.agentA) });
    addTriple(store, { subject: certId, predicate: cgIri('agentB'), object: lit(cert.agentB) });
    addTriple(store, { subject: certId, predicate: cgIri('topic'), object: lit(cert.topic) });
    addTriple(store, { subject: certId, predicate: cgIri('status'), object: lit(cert.status) });
    addTriple(store, {
      subject: certId,
      predicate: cgIri('semanticOverlap'),
      object: xsdLit(cert.semanticOverlap, 'decimal'),
    });
    addTriple(store, {
      subject: certId,
      predicate: cgIri('verifiedAt'),
      object: xsdLit(cert.verifiedAt, 'dateTime'),
    });
    addTriple(store, {
      subject: certId,
      predicate: cgIri('computationHash'),
      object: lit(cert.computationHash),
    });

    if (cert.sharedStructure) {
      addTriple(store, {
        subject: certId,
        predicate: cgIri('sharedStructure'),
        object: lit(cert.sharedStructure),
      });
    }

    for (const pattern of cert.sharedPatterns) {
      addTriple(store, {
        subject: certId,
        predicate: cgIri('sharedPattern'),
        object: lit(pattern),
      });
    }
  }

  // ── Persistence Records ────────────────────────────────────
  if (state.persistenceRegistry) {
    for (const [uri, records] of state.persistenceRegistry.records) {
      for (const rec of records) {
        addTriple(store, {
          subject: uri as string,
          predicate: cgIri('persistedAt'),
          object: lit(rec.tier),
        });
        if (rec.endpoint) {
          addTriple(store, {
            subject: uri as string,
            predicate: cgIri('persistedEndpoint'),
            object: rec.endpoint,
          });
        }
        if (rec.cid) {
          addTriple(store, {
            subject: uri as string,
            predicate: cgIri('persistedCid'),
            object: lit(rec.cid),
          });
        }
        if (rec.transactionHash) {
          addTriple(store, {
            subject: uri as string,
            predicate: cgIri('transactionHash'),
            object: lit(rec.transactionHash),
          });
        }
      }
    }
  }

  // ── Paradigm Constraints ───────────────────────────────────
  for (const constraint of state.constraints) {
    const cId = constraint.id ?? freshBnode();
    addTriple(store, { subject: cId, predicate: RDF_TYPE, object: cgIri('ParadigmConstraint') });
    if (constraint.operation) {
      addTriple(store, {
        subject: cId,
        predicate: cgIri('operation'),
        object: lit(constraint.operation),
      });
    }
    if (constraint.field) {
      addTriple(store, {
        subject: cId,
        predicate: cgIri('field'),
        object: lit(constraint.field),
      });
    }
    if (constraint.values) {
      for (const v of constraint.values) {
        addTriple(store, {
          subject: cId,
          predicate: cgIri('constraintValue'),
          object: lit(String(v)),
        });
      }
    }
  }

  // ── Pod Metadata ───────────────────────────────────────────
  for (const pod of state.pods) {
    addTriple(store, { subject: pod.url, predicate: RDF_TYPE, object: cgIri('Pod') });
    addTriple(store, { subject: pod.url, predicate: RDF_TYPE, object: `${DCAT_NS}DataService` });
    addTriple(store, { subject: pod.url, predicate: `${DCT_NS}title`, object: lit(pod.name) });
    addTriple(store, { subject: pod.url, predicate: cgIri('podStatus'), object: lit(pod.status) });
    addTriple(store, {
      subject: pod.url,
      predicate: cgIri('descriptorCount'),
      object: xsdLit(pod.descriptorCount, 'integer'),
    });
  }

  return store;
}

// ── 2. executeSparqlProtocol ──────────────────────────────────

/**
 * Standard SPARQL Protocol handler.
 *
 * Materializes the full system view, executes the query,
 * and returns results formatted per the W3C SPARQL Protocol:
 *   - SELECT/ASK -> application/sparql-results+json
 *   - CONSTRUCT  -> text/turtle (matching triples as Turtle)
 */
export function executeSparqlProtocol(
  state: SystemState,
  query: string,
  _accept?: string,
): SparqlProtocolResult {
  const store = materializeSystem(state);

  // Detect CONSTRUCT queries (simplified: return matching triples as Turtle)
  const isConstruct = /^\s*(?:PREFIX[^}]*\n)*\s*CONSTRUCT\b/i.test(query);

  if (isConstruct) {
    // For CONSTRUCT, convert the WHERE pattern into a SELECT,
    // find matching triples, and serialize as Turtle
    const selectified = query
      .replace(/CONSTRUCT\s*\{[^}]*\}/i, 'SELECT *')
      .trim();

    const result = executeSparqlString(store, selectified);
    const triples: string[] = [];

    // Emit prefixes
    triples.push(`@prefix cg: <${CG_NS}> .`);
    triples.push(`@prefix pgsl: <${PGSL_NS}> .`);
    triples.push(`@prefix xsd: <${XSD_NS}> .`);
    triples.push('');

    for (const binding of result.bindings) {
      const s = binding.get('?s') ?? binding.get('?subject');
      const p = binding.get('?p') ?? binding.get('?predicate');
      const o = binding.get('?o') ?? binding.get('?object');
      if (s && p && o) {
        triples.push(`<${s}> <${p}> ${o.startsWith('"') ? o : `<${o}>`} .`);
      }
    }

    return {
      contentType: 'text/turtle',
      body: triples.join('\n'),
    };
  }

  // SELECT / ASK
  const result = executeSparqlString(store, query);

  // Format as SPARQL Results JSON (W3C spec)
  const isAsk = /^\s*(?:PREFIX[^}]*\n)*\s*ASK\b/i.test(query);

  if (isAsk) {
    const body = JSON.stringify({
      head: {},
      boolean: result.boolean ?? result.bindings.length > 0,
    });
    return { contentType: 'application/sparql-results+json', body };
  }

  // SELECT — extract variable names from bindings
  const vars = new Set<string>();
  for (const b of result.bindings) {
    for (const k of b.keys()) {
      vars.add(k.startsWith('?') ? k.slice(1) : k);
    }
  }

  const sparqlResults = {
    head: { vars: [...vars] },
    results: {
      bindings: result.bindings.map(b => {
        const row: Record<string, { type: string; value: string; datatype?: string }> = {};
        for (const [k, v] of b.entries()) {
          const varName = k.startsWith('?') ? k.slice(1) : k;
          if (v === undefined || v === null) continue;
          const strVal = String(v);

          // Detect type
          if (strVal.startsWith('"') && strVal.includes('^^')) {
            const match = strVal.match(/^"([^"]*)"(?:\^\^<?([^>]*)>?)?$/);
            if (match) {
              row[varName] = { type: 'literal', value: match[1]!, datatype: match[2] };
            } else {
              row[varName] = { type: 'literal', value: strVal };
            }
          } else if (strVal.startsWith('_:')) {
            row[varName] = { type: 'bnode', value: strVal.slice(2) };
          } else {
            row[varName] = { type: 'uri', value: strVal };
          }
        }
        return row;
      }),
    },
  };

  return {
    contentType: 'application/sparql-results+json',
    body: JSON.stringify(sparqlResults),
  };
}

// ── 3. writeBackTriples ───────────────────────────────────────

/**
 * Process RDF mutations and flow them back into PGSL.
 *
 * For each triple:
 *   - pgsl:value on an atom URI -> skip (atoms are immutable)
 *   - pgsl:item on a fragment URI -> interpret as "add item to fragment"
 *     -> create new chain via ingest
 *   - cg:describes / cg:hasFacet -> descriptor mutation (log only,
 *     descriptors live on pods)
 *   - NEW triple with unknown subject -> mint subject as atom,
 *     mint object as atom, create chain (subject, predicate-local, object)
 *     This is how external RDF tooling creates PGSL content through
 *     the virtualized layer.
 */
export function writeBackTriples(
  pgsl: PGSLInstance,
  triples: readonly Triple[],
): WriteBackResult {
  let triplesAdded = 0;
  let pgslMutations = 0;
  const errors: string[] = [];

  for (const triple of triples) {
    try {
      const { subject, predicate, object } = triple;

      // Case 1: atom value mutation — skip (immutable)
      if (predicate === pgslIri('value') && subject.startsWith('urn:pgsl:atom:')) {
        // Atoms are immutable; skip silently
        continue;
      }

      // Case 2: add item to fragment
      if (predicate === pgslIri('item') && subject.startsWith('urn:pgsl:fragment:')) {
        // Interpret as: create a new chain that extends this fragment's content
        // We extract the object (should be an atom URI) and ingest
        const objectValue = extractValue(object);
        if (objectValue !== undefined) {
          ingest(pgsl, [objectValue]);
          pgslMutations++;
          triplesAdded++;
        } else if (object.startsWith('urn:pgsl:')) {
          // Object is already a PGSL URI — ingest as-is
          ingest(pgsl, [object as IRI]);
          pgslMutations++;
          triplesAdded++;
        } else {
          errors.push(`Cannot add non-PGSL item to fragment: ${object}`);
        }
        continue;
      }

      // Case 3: descriptor mutations — log only
      if (predicate === cgIri('describes') || predicate === cgIri('hasFacet')) {
        // Descriptors are managed on pods; log but don't modify
        triplesAdded++;
        continue;
      }

      // Case 4: RDF_TYPE triples — skip (informational)
      if (predicate === RDF_TYPE) {
        triplesAdded++;
        continue;
      }

      // Case 5: NEW triple with unknown subject — create PGSL content
      // Mint both subject and object as atoms, then create a chain:
      //   [subject-value, predicate-local-name, object-value]
      const subjectValue = extractValue(subject) ?? subject;
      const objectValue = extractValue(object) ?? stripLiteral(object);
      const predicateLocal = localName(predicate);

      mintAtom(pgsl, String(subjectValue));
      mintAtom(pgsl, predicateLocal);
      mintAtom(pgsl, String(objectValue));
      ingest(pgsl, [String(subjectValue), predicateLocal, String(objectValue)]);
      pgslMutations++;
      triplesAdded++;
    } catch (err: any) {
      errors.push(`Error processing triple <${triple.subject}> <${triple.predicate}> ${triple.object}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    triplesAdded,
    pgslMutations,
    errors,
  };
}

/** Extract the raw value from a PGSL atom URI (urn:pgsl:atom:<value>) */
function extractValue(uri: string): Value | undefined {
  const match = uri.match(/^urn:pgsl:atom:(.+)$/);
  if (!match) return undefined;
  const raw = decodeURIComponent(match[1]!);
  // Try numeric
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** Strip literal delimiters: "value"^^type -> value */
function stripLiteral(s: string): string {
  const match = s.match(/^"([^"]*)"(?:\^\^.*)?$/);
  return match ? match[1]! : s;
}

// ── 4. sparqlUpdateHandler ────────────────────────────────────

/**
 * Parse a simple SPARQL INSERT DATA statement and execute write-back.
 *
 * Supports the form:
 *   INSERT DATA { <s> <p> <o> . <s2> <p2> <o2> . }
 */
export function sparqlUpdateHandler(
  pgsl: PGSLInstance,
  updateQuery: string,
): WriteBackResult {
  const match = updateQuery.match(/INSERT\s+DATA\s*\{([^}]*)\}/is);
  if (!match) {
    return {
      success: false,
      triplesAdded: 0,
      pgslMutations: 0,
      errors: ['Could not parse INSERT DATA statement. Expected: INSERT DATA { <s> <p> <o> . }'],
    };
  }

  const body = match[1]!.trim();
  const triples: Triple[] = [];

  // Parse triple patterns: <s> <p> <o> . or <s> <p> "literal"^^<type> .
  const tripleRegex = /<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|("[^"]*"(?:\^\^<[^>]+>)?))\s*\./g;
  let m: RegExpExecArray | null;

  while ((m = tripleRegex.exec(body)) !== null) {
    const subject = m[1]!;
    const predicate = m[2]!;
    const object = m[3] ?? m[4]!; // IRI or literal
    triples.push({ subject, predicate, object });
  }

  if (triples.length === 0) {
    return {
      success: false,
      triplesAdded: 0,
      pgslMutations: 0,
      errors: ['No triples found in INSERT DATA body.'],
    };
  }

  return writeBackTriples(pgsl, triples);
}

// ── 5. systemToTurtle ─────────────────────────────────────────

/**
 * Full system dump as Turtle.
 *
 * Serializes the ontology prefixes followed by all materialized
 * triples. Useful for export to external RDF tools.
 */
export function systemToTurtle(state: SystemState): string {
  const store = materializeSystem(state);
  const lines: string[] = [];

  // Prefixes
  lines.push(`@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`);
  lines.push(`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`);
  lines.push(`@prefix xsd: <${XSD_NS}> .`);
  lines.push(`@prefix prov: <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl: <${PGSL_NS}> .`);
  lines.push(`@prefix cg: <${CG_NS}> .`);
  lines.push(`@prefix dcat: <${DCAT_NS}> .`);
  lines.push(`@prefix dcterms: <${DCT_NS}> .`);
  lines.push('');

  // Serialize context descriptors via the proper Turtle serializer
  for (const desc of state.descriptors) {
    try {
      lines.push(toTurtle(desc, { prefixes: false }));
      lines.push('');
    } catch {
      // Fall through to triple-level serialization below
    }
  }

  // All triples from the materialized store
  // Group by subject for readable output
  const bySubject = new Map<string, Triple[]>();
  for (const t of store.triples) {
    const existing = bySubject.get(t.subject);
    if (existing) existing.push(t);
    else bySubject.set(t.subject, [t]);
  }

  for (const [subject, subjectTriples] of bySubject) {
    if (subjectTriples.length === 1) {
      const t = subjectTriples[0]!;
      const obj = formatTurtleObject(t.object);
      lines.push(`<${t.subject}> <${t.predicate}> ${obj} .`);
    } else {
      lines.push(`<${subject}>`);
      for (let i = 0; i < subjectTriples.length; i++) {
        const t = subjectTriples[i]!;
        const obj = formatTurtleObject(t.object);
        const term = i === subjectTriples.length - 1 ? ' .' : ' ;';
        lines.push(`    <${t.predicate}> ${obj}${term}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Format an object value for Turtle output */
function formatTurtleObject(obj: string): string {
  if (obj.startsWith('"')) {
    // Fix typed literals: "value"^^datatype → "value"^^<datatype>
    const typedMatch = obj.match(/^(".*?")\^\^(.+)$/);
    if (typedMatch && !typedMatch[2]!.startsWith('<')) {
      return `${typedMatch[1]}^^<${typedMatch[2]}>`;
    }
    return obj;
  }
  if (obj.startsWith('_:')) return obj;
  return `<${obj}>`;
}

// ── 6. systemToJsonLd ─────────────────────────────────────────

/**
 * Simplified JSON-LD representation with @context mapping all namespaces.
 *
 * Returns a JSON-LD document that can be consumed by any JSON-LD processor.
 */
export function systemToJsonLd(state: SystemState): object {
  const store = materializeSystem(state);

  // Build the @graph array from triples
  const subjects = new Map<string, Record<string, any>>();

  for (const t of store.triples) {
    let node = subjects.get(t.subject);
    if (!node) {
      node = { '@id': t.subject };
      subjects.set(t.subject, node);
    }

    const predKey = compactPredicate(t.predicate);

    // Handle rdf:type specially
    if (t.predicate === RDF_TYPE) {
      const existing = node['@type'];
      if (existing) {
        if (Array.isArray(existing)) existing.push(t.object);
        else node['@type'] = [existing, t.object];
      } else {
        node['@type'] = t.object;
      }
      continue;
    }

    // Handle literal vs IRI objects
    const objValue = t.object.startsWith('"')
      ? parseLiteralForJsonLd(t.object)
      : { '@id': t.object };

    const existing = node[predKey];
    if (existing) {
      if (Array.isArray(existing)) existing.push(objValue);
      else node[predKey] = [existing, objValue];
    } else {
      node[predKey] = objValue;
    }
  }

  return {
    '@context': {
      cg: CG_NS,
      pgsl: PGSL_NS,
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      xsd: XSD_NS,
      prov: 'http://www.w3.org/ns/prov#',
      dcat: DCAT_NS,
      dcterms: DCT_NS,
    },
    '@graph': [...subjects.values()],
  };
}

/** Compact a predicate IRI using known prefixes */
function compactPredicate(iri: string): string {
  if (iri.startsWith(CG_NS)) return `cg:${iri.slice(CG_NS.length)}`;
  if (iri.startsWith(PGSL_NS)) return `pgsl:${iri.slice(PGSL_NS.length)}`;
  if (iri.startsWith(DCT_NS)) return `dcterms:${iri.slice(DCT_NS.length)}`;
  if (iri.startsWith(DCAT_NS)) return `dcat:${iri.slice(DCAT_NS.length)}`;
  if (iri.startsWith('http://www.w3.org/ns/prov#')) return `prov:${iri.slice(25)}`;
  if (iri.startsWith('http://www.w3.org/2000/01/rdf-schema#')) return `rdfs:${iri.slice(37)}`;
  return iri;
}

/** Parse a Turtle literal into a JSON-LD value object */
function parseLiteralForJsonLd(lit: string): object | string {
  const match = lit.match(/^"([^"]*)"(?:\^\^<?([^>]*)>?)?$/);
  if (!match) return lit;

  const value = match[1]!;
  const datatype = match[2];

  if (!datatype) return value;

  // Numeric types: return raw value
  if (datatype.endsWith('integer') || datatype.endsWith('nonNegativeInteger')) {
    return { '@value': parseInt(value, 10), '@type': datatype };
  }
  if (datatype.endsWith('double') || datatype.endsWith('decimal')) {
    return { '@value': parseFloat(value), '@type': datatype };
  }
  if (datatype.endsWith('boolean')) {
    return { '@value': value === 'true', '@type': datatype };
  }

  return { '@value': value, '@type': datatype };
}
