/**
 * Independent migration diagnostic: compare small native closures with the
 * retained owlrl 7.1.4 / rdflib 7.1.4 oracle. This never calls a model, publishes,
 * fetches data, or changes an input. Differences remain an unsuccessful gate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Parser, Store } from 'n3';
import { closure, objects, RDF, RDFS, OWL, XSD } from './reasoning.js';

interface Summary {
  input: number;
  closed: number;
  literalTypes: { value: string; language: string; types: string[] }[];
  schema: string[];
  errors: string[];
}
const oracleProgram = String.raw`
import importlib.metadata
import json
import sys
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF, RDFS, OWL
from owlrl import DeductiveClosure, OWLRL_Semantics
from owlrl.Namespaces import ERRNS
assert importlib.metadata.version("rdflib") == "7.1.4"
assert importlib.metadata.version("owlrl") == "7.1.4"
g = Graph().parse(data=sys.stdin.read(), format="turtle")
input_count = len(g)
literals = sorted(set(o for s, p, o in g if isinstance(o, Literal)), key=lambda l: (str(l), l.language or "", str(l.datatype or "")))
DeductiveClosure(OWLRL_Semantics, rdfs_closure=False, axiomatic_triples=False, datatype_axioms=False).expand(g)
types = [{"value": str(l), "language": (l.language or "").lower(), "types": sorted(str(o) for o in g.objects(l, RDF.type))} for l in literals]
schema_predicates = {RDFS.subClassOf, RDFS.subPropertyOf, OWL.equivalentClass, OWL.equivalentProperty}
schema = sorted(" ".join(str(t) for t in (s, p, o)) for s, p, o in g if p in schema_predicates and str(s).startswith("urn:oracle-fixture:"))
errors = sorted(str(m) for e in g.subjects(RDF.type, ERRNS.ErrorMessage) for m in g.objects(e, ERRNS.error))
print(json.dumps({"input": input_count, "closed": len(g), "literalTypes": types, "schema": schema, "errors": errors}, sort_keys=True))
`;
const prefixes = '@prefix : <urn:oracle-fixture:> . @prefix rdf: <' + RDF + '> . @prefix rdfs: <' + RDFS + '> . @prefix owl: <' + OWL + '> . @prefix xsd: <' + XSD + '> . ';
const fixtures: Record<string, string> = {
  'plain literal': ':s :p "plain label" .',
  'language literal': ':s :p "English label"@en .',
  'explicit string literal': ':s :p "typed label"^^xsd:string .',
  'plain and explicit string with the same spelling': ':s :p "same label", "same label"^^xsd:string .',
  'untyped class cycle': ':A rdfs:subClassOf :B . :B rdfs:subClassOf :A .',
  'untyped property cycle': ':p rdfs:subPropertyOf :q . :q rdfs:subPropertyOf :p .',
};
const schemaPredicates = new Set([RDFS + 'subClassOf', RDFS + 'subPropertyOf', OWL + 'equivalentClass', OWL + 'equivalentProperty']);
const receipt: { fixture: string; equal: boolean; oracle: Summary; native: Summary; difference?: string }[] = [];
for (const [name, body] of Object.entries(fixtures)) {
  const turtle = prefixes + body;
  const oracle = JSON.parse(execFileSync(process.env.PYTHON ?? 'python3', ['-I', '-c', oracleProgram], {
    input: turtle, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  })) as Summary;
  const input = new Store(new Parser({ format: 'Turtle' }).parse(turtle));
  const literals = [...new Map([...input].filter(q => q.object.termType === 'Literal').map(q => [q.object.value + '@' + (q.object.termType === 'Literal' ? q.object.language : ''), q.object])).values()];
  const result = closure(input);
  const native: Summary = {
    input: input.size,
    closed: result.graph.size,
    literalTypes: literals.map(l => ({
      value: l.value, language: l.termType === 'Literal' ? l.language.toLowerCase() : '',
      types: objects(result.graph, l, RDF + 'type').map(o => o.value).sort(),
    })).sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.language.localeCompare(b.language)),
    schema: [...result.graph].filter(q => schemaPredicates.has(q.predicate.value) && q.subject.value.startsWith('urn:oracle-fixture:')).map(q => [q.subject, q.predicate, q.object].map(t => t.value).join(' ')).sort(),
    errors: result.errors,
  };
  let difference: string | undefined;
  try { assert.deepEqual(native, oracle); }
  catch (error) { difference = String(error); }
  receipt.push({ fixture: name, equal: difference === undefined, oracle, native, ...(difference ? { difference } : {}) });
}
process.stdout.write('I2IDLX_REASONING_ORACLE_FIXTURES=' + JSON.stringify({
  oracle: { rdflib: '7.1.4', owlrl: '7.1.4' }, fixtures: receipt,
}) + '\n');
if (receipt.some(r => !r.equal)) process.exitCode = 1;
