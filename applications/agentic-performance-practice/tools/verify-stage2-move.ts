/**
 * Stage-2 engine-move runtime smoke: proves the theory engine LIVES in agp/src and that the
 * relocated engine still composes Foxxi's xAPI vocab across the vertical boundary.
 *
 * ★ THE SHIM HALF IS GONE BECAUSE THE SHIMS ARE. This used to import each engine module
 * through `foxxi/src/<name>.ts` as well and assert the two were the IDENTICAL function
 * reference — the check that made the transitional re-exports safe. Those seven files are
 * deleted and Foxxi's fourteen import sites now name agp directly, so there is no second
 * spelling left to compare: the assertion would be `agpPA.diagnose === agpPA.diagnose`, which
 * is true of everything and evidence of nothing. Deleted rather than left passing.
 *
 * Run from context-graphs/: npx tsx applications/agentic-performance-practice/tools/verify-stage2-move.ts
 */
import * as agpPA from '../src/performance-architecture.js';
import * as agpAD from '../src/agent-disposition.js';
import * as agpKA from '../src/knowledge-architecture.js';
import { PERFORMED_VERB } from '../../foxxi-content-intelligence/src/learner-record.js';
import { projectTrajectoryToXapi, buildTrajectory } from '../src/agent-trajectory.js';
import { buildAgpProfileDoc, AGP_PROFILE_ID, AGP_PROFILE_PARTS } from '../src/xapi-profile.js';
import { AGP_NS } from '../src/ontology.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// What the deleted shim-identity checks were incidentally proving: the engine is real and
// callable at its canonical home. Asserted directly now, of agp only.
check('agp exports a callable diagnose', typeof agpPA.diagnose === 'function');
check('agp exports a callable recommendInterventions', typeof agpPA.recommendInterventions === 'function');
check('agp exports a callable assessDisposition', typeof agpAD.assessDisposition === 'function');
check('agp exports a callable mapKnowledge', typeof agpKA.mapKnowledge === 'function');

check('relocated engine composes Foxxi PERFORMED_VERB at runtime', typeof PERFORMED_VERB === 'string' && PERFORMED_VERB.includes('performed'), PERFORMED_VERB);
check('projectTrajectoryToXapi + buildTrajectory importable from agp', typeof projectTrajectoryToXapi === 'function' && typeof buildTrajectory === 'function');

console.log('\n[agp xapi profile] composes Foxxi standards, authors its own');
const prof = buildAgpProfileDoc({ generatedAt: '2026-01-01T00:00:00Z' }) as Record<string, unknown>;
check('profile id is the agp profile IRI', prof.id === AGP_PROFILE_ID);
check('profile is a valid ADL Profile doc', prof.type === 'Profile' && Array.isArray(prof.concepts) && Array.isArray(prof.templates) && Array.isArray(prof.patterns));
const concepts = prof.concepts as Array<Record<string, unknown>>;
check('REUSES the shared performed verb (not re-minted)', concepts.some(c => c.type === 'Verb' && String(c.id).endsWith('#performed')) && AGP_PROFILE_PARTS.verbs[0].id === PERFORMED_VERB);
check('adds agp context extensions (capability/actualizedAffordance/regime)', ['capability', 'actualizedAffordance', 'regime'].every(n => concepts.some(c => c.type === 'ContextExtension' && c.id === `${AGP_NS}${n}`)));
const tmpls = prof.templates as Array<Record<string, unknown>>;
const actT = tmpls.find(t => String(t.id).endsWith('/templates/actualized-affordance'));
check('actualized-affordance template uses performed + requires capability', !!actT && actT.verb === PERFORMED_VERB && JSON.stringify(actT.rules).includes(`${AGP_NS}capability`));
check('performance-stream pattern present', (prof.patterns as Array<Record<string, unknown>>).some(p => String(p.id).endsWith('/patterns/agp-performance-stream')));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
