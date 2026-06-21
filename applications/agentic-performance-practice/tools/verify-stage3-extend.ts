/**
 * Stage-3 verification: the emergent, self-descriptive, guided standards-extension
 * capability (agp composing Foxxi) + the in-flow performance-support primitive.
 * Uses the repo's own Turtle parser + SHACL engine.
 *
 * Run from context-graphs/: npx tsx applications/agentic-performance-practice/tools/verify-stage3-extend.ts
 */
import { parseTrig } from '../../../packages/core/src/rdf/turtle-parser.js';
import { validateAgainstShape } from '../../../packages/core/src/validation/shacl-engine.js';
import { readShapesTurtle, AGP_NS } from '../src/ontology.js';
import { proposeStandardsExtension } from '../src/standards-extension.js';
import { capabilityCatalog, withGuidance } from '../../_shared/guided-affordance/index.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

console.log('[SHACL] StandardsExtension shape (repo engine)');
const shapes = readShapesTurtle();
const PFX = `@prefix agp: <${AGP_NS}> .\n@prefix ex: <https://example.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const good = PFX + `ex:e1 a agp:StandardsExtension ; agp:extensionKind agp:XapiContextExtension ; agp:extendsStandard "https://x/profile"^^xsd:string .`;
const noStd = PFX + `ex:e2 a agp:StandardsExtension ; agp:extensionKind agp:XapiContextExtension .`;
const noKind = PFX + `ex:e3 a agp:StandardsExtension ; agp:extendsStandard "https://x/profile"^^xsd:string .`;
check('valid standards extension conforms', validateAgainstShape(good, shapes).conforms === true);
check('extension missing the extended-standard is rejected', validateAgainstShape(noStd, shapes).conforms === false);
check('extension missing the kind is rejected', validateAgainstShape(noKind, shapes).conforms === false);

console.log('\n[extend-standards] composes Foxxi standards, self-descriptive + guided');
const xc = proposeStandardsExtension({ kind: 'XapiContextExtension', name: 'collaborationDepth', definition: 'How many distinct peers contributed to the performance.' });
check('xAPI context extension -> a real Profile artifact', (xc.artifact as Record<string, unknown>).type === 'Profile');
check('xAPI extension descriptor is a self-descriptive iep:StandardsExtension', Array.isArray((xc.descriptor as Record<string, unknown>)['@type']) && JSON.stringify(xc.descriptor['@type']).includes('StandardsExtension'));
check('descriptor names the kind + the standard it extends', JSON.stringify(xc.descriptor).includes('XapiContextExtension') && typeof xc.extendsStandard === 'string');
check('result carries in-flow guidance that names the capability', xc._guidance?.teaches === `${AGP_NS}StandardsExtension` && !!xc._guidance.howToLearn);
check('iri derives from the proposed name', xc.iri.endsWith('#collaborationDepth') || xc.iri.endsWith('collaborationDepth'));

const pf = proposeStandardsExtension({ kind: 'XapiProfileFragment', name: 'teamPlay', definition: 'A profile fragment for team play.', concepts: [{ id: 'https://ex/x', type: 'ContextExtension', prefLabel: { en: 'x' } }] });
check('profile fragment reuses the shared performed verb', JSON.stringify((pf.artifact as Record<string, unknown>).concepts).includes('#performed'));

const ler = proposeStandardsExtension({ kind: 'LerTerm', name: 'AgentMastery', definition: 'A mastery record for an agent.' });
const lerArt = ler.artifact as { mediaType?: string; turtle?: string };
check('LER term -> Turtle artifact', lerArt.mediaType === 'text/turtle' && !!lerArt.turtle);
let lerParses = true; try { parseTrig(lerArt.turtle!); } catch { lerParses = false; }
check('LER term Turtle parses + subclasses the LER layer', lerParses && lerArt.turtle!.includes('rdfs:subClassOf') && lerArt.turtle!.includes('ieee-ler'));

const tla = proposeStandardsExtension({ kind: 'TlaTerm', name: 'CompetencyVelocity', definition: 'Rate of competency growth.' });
let tlaParses = true; try { parseTrig((tla.artifact as { turtle: string }).turtle); } catch { tlaParses = false; }
check('TLA term Turtle parses', tlaParses && (tla.artifact as { turtle: string }).turtle.includes('adl-tla'));

console.log('\n[guided-affordance] in-flow performance support primitive');
const wrapped = withGuidance({ ok: true }, { summary: 's', teaches: 'cap' });
check('withGuidance attaches _guidance', (wrapped as Record<string, unknown>)._guidance !== undefined && wrapped.ok === true);
const cat = capabilityCatalog([{ action: 'a', toolName: 't', guidance: { summary: 's', teaches: 'cap', howToLearn: 'doc' } }]) as Record<string, unknown>;
check('capabilityCatalog lists learnable capabilities', Array.isArray(cat.capabilities) && (cat.capabilities as unknown[]).length === 1);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
