/**
 * Stage-1 verification for the agentic-performance-practice vertical.
 * Runs the REPO'S OWN Turtle parser + SHACL engine against the agp: ontology
 * (so the shapes are proven to parse + enforce, not just hand-checked), then
 * checks the dereferenceable serving projection + the affordance manifest.
 *
 * Run from context-graphs/: npx tsx applications/agentic-performance-practice/tools/verify-stage1.ts
 */
import { parseTrig } from '../../../packages/core/src/rdf/turtle-parser.js';
import { validateAgainstShape } from '../../../packages/core/src/validation/shacl-engine.js';
import {
  readOntologyTurtle, readShapesTurtle, renderOntologyJsonLd, renderTermJsonLd, AGP_TERMS, AGP_NS,
} from '../src/ontology.js';
import { agpAffordances } from '../affordances.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

console.log('[ontology] well-formedness (repo Turtle parser)');
const owl = readOntologyTurtle();
let owlOk = true, owlErr = '';
try { parseTrig(owl); } catch (e) { owlOk = false; owlErr = (e as Error).message; }
check('agp.ttl parses as Turtle', owlOk, owlErr || `${owl.length} bytes`);
check('agp.ttl declares the net-new primitives', owl.includes('agp:Actualization') && owl.includes('agp:PerformanceAffordance') && owl.includes('agp:composedOf'));
check('agp.ttl keeps performance-affordance DISTINCT from cg:Affordance', owl.includes('MUST NOT be conflated'));

const shapes = readShapesTurtle();
let shOk = true, shErr = '';
try { parseTrig(shapes); } catch (e) { shOk = false; shErr = (e as Error).message; }
check('agp-shapes.ttl parses as Turtle', shOk, shErr);

console.log('\n[SHACL] the repo engine enforces the model');
const PFX = `@prefix agp: <${AGP_NS}> .\n@prefix ex: <https://example.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const msgs = (r: { results?: Array<{ message?: string }> }) => JSON.stringify((r.results ?? []).map(x => x.message)).slice(0, 240);

const actValid = PFX + `ex:act1 a agp:Actualization ; agp:engages ex:cap1 ; agp:inSituation ex:sit1 ; agp:actualizes ex:aff1 ; agp:yields ex:perf1 .`;
const actMissing = PFX + `ex:act2 a agp:Actualization ; agp:engages ex:cap1 ; agp:inSituation ex:sit1 ; agp:actualizes ex:aff1 .`;
const rv = validateAgainstShape(actValid, shapes);
check('complete actualization conforms', rv.conforms === true, msgs(rv));
const ri = validateAgainstShape(actMissing, shapes);
check('actualization missing yields is rejected', ri.conforms === false && JSON.stringify(ri.results).includes('yields'), msgs(ri));

const capEmpty = PFX + `ex:c1 a agp:Capability .`;
check('empty capability rejected', validateAgainstShape(capEmpty, shapes).conforms === false);
const capGood = PFX + `ex:c2 a agp:Capability ; agp:composedOf ex:skill1 .`;
check('composed capability conforms', validateAgainstShape(capGood, shapes).conforms === true);

const sitGood = PFX + `ex:s1 a agp:PerformanceSituation ; agp:regime agp:Knowable ; agp:regimeSource "derived"^^xsd:string .`;
check('situation with derived regime conforms', validateAgainstShape(sitGood, shapes).conforms === true, msgs(validateAgainstShape(sitGood, shapes)));
const sitBad = PFX + `ex:s2 a agp:PerformanceSituation ; agp:regime agp:Knowable ; agp:regimeSource "guessed"^^xsd:string .`;
check('out-of-vocabulary regimeSource rejected', validateAgainstShape(sitBad, shapes).conforms === false);

const affNoCap = PFX + `ex:a1 a agp:PerformanceAffordance .`;
check('performance-affordance without required capability rejected', validateAgainstShape(affNoCap, shapes).conforms === false);

console.log('\n[serving] dereferenceable projection + affordances');
const jsonld = renderOntologyJsonLd() as Record<string, unknown>;
check('JSON-LD projection has @graph for every term', Array.isArray(jsonld['@graph']) && (jsonld['@graph'] as unknown[]).length === AGP_TERMS.length + 1);
const term = renderTermJsonLd('PerformanceAffordance') as Record<string, unknown> | null;
check('per-term route resolves a class', !!term && String(term['@id']).endsWith('#PerformanceAffordance'));
check('unknown term returns null (bridge serves a back-pointer)', renderTermJsonLd('NotATerm') === null);
check('8 affordances declared', agpAffordances.length === 8);
check('affordance actions are unique', new Set(agpAffordances.map(a => a.action)).size === agpAffordances.length);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
