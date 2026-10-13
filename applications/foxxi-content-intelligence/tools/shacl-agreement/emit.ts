/**
 * Write the RDF readings the Foxxi tests hold to a verdict, with those verdicts, for a second SHACL
 * processor to check (check_pyshacl.py).
 *
 * The Foxxi tests hold each reading to its verdict with the substrate's SHACL processor
 * (@interego/core). Two processors that read the spec the same wrong way agree with each other and
 * with their tests, so the Foxxi SHACL agreement job (.github/workflows/foxxi-shacl-agreement.yml)
 * gives pySHACL the same readings, the same published shapes and the same verdicts. The readings are
 * the ones the tests make:
 *  - the eight documents read through their generated contexts (tests/support/both-readings-cases.ts):
 *    the property shapes each violates and warns by, exactly;
 *  - xAPI statements read through /ns/xapi/context (tests/support/xapi-statement-cases.ts);
 *  - the Open Badges 3.0 and CLR 2.0 credential fixtures (tests/support/credentials/), read through
 *    1EdTech's and W3C's contexts when they were made;
 *  - an Enterprise Learner Record, built by the code that builds them (tests/support/elr-records.ts).
 * For the last three, the verdict is whether the reading conforms and the node shapes its violations
 * belong to, as their tests hold it.
 *
 * usage: npx tsx applications/foxxi-content-intelligence/tools/shacl-agreement/emit.ts <out-dir>
 * It writes <out-dir>/<id>.nq, <out-dir>/<shapes>.shapes.ttl and <out-dir>/expected.json, and exits 1
 * if a reading is not what its case says (one safe mode refuses that should read, or the reverse).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import jsonld from 'jsonld';
import { renderShacl, type OntologyModel } from '../../src/spec-ontology.js';
import { SPEC_MODELS } from '../../src/spec/index.js';
import { COMPLIANCE_MODELS } from '../../src/spec/compliance.model.js';
import { XAPI_MODEL } from '../../src/spec/xapi.model.js';
import { LER_MODEL, OB3_MODEL, CLR_MODEL } from '../../src/spec/ler.model.js';
import { XAPI_CONTEXT_URL, xapiJsonLdContext } from '../../src/spec/xapi-context.js';
import { modelContextUrl, modelJsonLdContext } from '../../src/ns/model-context.js';
import { READING_CASES } from '../../tests/support/both-readings-cases.js';
import { STATEMENT_CASES } from '../../tests/support/xapi-statement-cases.js';
import { CREDENTIAL_CASES } from '../../tests/support/credentials/cases.js';
import { record, documentLoader as elrLoader } from '../../tests/support/elr-records.js';

const out = process.argv[2];
if (!out) { console.error('usage: emit.ts <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });

/** What a reading is held to. `level: 'property'` compares the property shapes named, exactly;
 *  `level: 'node'` compares the node shapes the violations belong to. */
interface Expected {
  readonly shapes: string;
  readonly conforms: boolean;
  readonly level: 'property' | 'node';
  readonly violates: readonly string[];
  /** The shapes named must include `violates`, rather than be exactly them. */
  readonly includes?: boolean;
  readonly warns?: readonly string[];
  readonly name: string;
}
const expected: Record<string, Expected> = {};
const MODELS: Record<string, OntologyModel> = { ...SPEC_MODELS, ...COMPLIANCE_MODELS };
const shapesWritten = new Set<string>();
const shapesFile = (m: OntologyModel): string => {
  if (!shapesWritten.has(m.module)) { writeFileSync(`${out}/${m.module}.shapes.ttl`, renderShacl(m)); shapesWritten.add(m.module); }
  return m.module;
};
let wrong = 0;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** The reading of a document in safe mode, or null where safe mode refuses it. */
async function read(doc: unknown, loader: (url: string) => Promise<unknown>): Promise<string | null> {
  try {
    return await jsonld.toRDF(doc as jsonld.JsonLdDocument, { format: 'application/n-quads', documentLoader: loader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
  } catch (e) {
    if ((e as { details?: { event?: { code?: string } } }).details?.event?.code) return null;
    throw e;
  }
}

// The eight documents, through their generated contexts.
for (const [module, cases] of Object.entries(READING_CASES)) {
  const m = MODELS[module]!;
  const loader = async (url: string) => {
    const document = url === modelContextUrl(m) ? modelJsonLdContext(m) : url === XAPI_CONTEXT_URL ? xapiJsonLdContext() : undefined;
    if (!document) throw new Error(`nothing is fetched: ${url}`);
    return { contextUrl: undefined, documentUrl: url, document };
  };
  for (const c of cases) {
    const nq = await read({ '@context': modelContextUrl(m), ...c.instance }, loader);
    if ((nq === null) !== !!c.refused) { console.error(`${module} / ${c.name}: safe mode ${nq === null ? 'refused it' : 'read it'}, which the case does not say`); wrong++; continue; }
    if (nq === null) continue;
    const id = `${module}--${slug(c.name)}`;
    writeFileSync(`${out}/${id}.nq`, nq);
    expected[id] = { name: c.name, shapes: shapesFile(m), conforms: !(c.violates ?? []).length, level: 'property', violates: [...(c.violates ?? [])].sort(), warns: [...(c.warns ?? [])].sort() };
  }
}

// xAPI statements, through /ns/xapi/context.
const xapiLoader = async (url: string) => {
  if (url !== XAPI_CONTEXT_URL) throw new Error(`nothing is fetched: ${url}`);
  return { contextUrl: undefined, documentUrl: url, document: xapiJsonLdContext() };
};
for (const [name, c] of Object.entries(STATEMENT_CASES)) {
  const nq = await read({ '@context': XAPI_CONTEXT_URL, ...c.stmt }, xapiLoader);
  if ((nq === null) !== !!c.refused) { console.error(`xapi / ${name}: safe mode ${nq === null ? 'refused it' : 'read it'}, which the case does not say`); wrong++; continue; }
  if (nq === null) continue;
  const id = `xapi--${slug(name)}`;
  writeFileSync(`${out}/${id}.nq`, nq);
  const conforms = c.jsonOnly ? true : c.conforms;
  const fault = c.fault === undefined ? undefined : typeof c.fault === 'string' ? c.fault : c.fault.rdf;
  // As the xAPI test holds it: the node shape it names is among those the report names.
  expected[id] = { name, shapes: shapesFile(XAPI_MODEL), conforms, level: 'node', violates: conforms || !fault ? [] : [fault], includes: true };
}

// The credential fixtures, as they were read.
const CREDENTIALS = new URL('../../tests/support/credentials/', import.meta.url);
for (const [name, e] of Object.entries(CREDENTIAL_CASES)) {
  if (e.refused) continue;
  const nq = readFileSync(new URL(`${name}.nq`, CREDENTIALS), 'utf8');
  writeFileSync(`${out}/credential--${name}.nq`, nq);
  const conforms = e.jsonOnly ? true : e.conforms;
  expected[`credential--${name}`] = { name, shapes: shapesFile(e.model), conforms, level: 'node', violates: conforms ? [] : [...(e.faults ?? [])].sort() };
  // A CLR's bundled Open Badges credentials meet the Open Badges shapes in the same reading.
  if (e.model === CLR_MODEL && e.conforms) {
    expected[`credential--${name}--ob3`] = { name: `${name}, its bundled badges`, shapes: shapesFile(OB3_MODEL), conforms: true, level: 'node', violates: [] };
    writeFileSync(`${out}/credential--${name}--ob3.nq`, nq);
  }
}

// An Enterprise Learner Record, as the code builds one.
{
  const nq = await read(await record(), elrLoader);
  if (nq === null) { console.error('the Enterprise Learner Record has no reading'); wrong++; }
  else {
    writeFileSync(`${out}/elr--record.nq`, nq);
    expected['elr--record'] = { name: 'an Enterprise Learner Record', shapes: shapesFile(LER_MODEL), conforms: true, level: 'node', violates: [] };
  }
}

writeFileSync(`${out}/expected.json`, `${JSON.stringify(expected, null, 1)}\n`);
console.log(`${Object.keys(expected).length} readings and ${shapesWritten.size} shapes graphs written to ${out}`);
if (wrong) process.exit(1);
