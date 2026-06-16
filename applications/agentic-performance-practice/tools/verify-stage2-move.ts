/**
 * Stage-2 engine-move runtime smoke: proves the theory engine now LIVES in
 * agp/src and that Foxxi's transitional shims re-export the SAME functions at
 * runtime (so Foxxi behaves identically), and that the relocated engine still
 * composes Foxxi's xAPI vocab across the new vertical boundary.
 *
 * Run from context-graphs/: npx tsx applications/agentic-performance-practice/tools/verify-stage2-move.ts
 */
import * as foxxiPA from '../../foxxi-content-intelligence/src/performance-architecture.js';
import * as agpPA from '../src/performance-architecture.js';
import * as foxxiAD from '../../foxxi-content-intelligence/src/agent-disposition.js';
import * as agpAD from '../src/agent-disposition.js';
import * as foxxiKA from '../../foxxi-content-intelligence/src/knowledge-architecture.js';
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

check('shim re-exports diagnose (identical ref)', foxxiPA.diagnose === agpPA.diagnose && typeof agpPA.diagnose === 'function');
check('shim re-exports recommendInterventions (identical ref)', foxxiPA.recommendInterventions === agpPA.recommendInterventions);
check('shim re-exports assessDisposition (identical ref)', foxxiAD.assessDisposition === agpAD.assessDisposition && typeof agpAD.assessDisposition === 'function');
check('shim re-exports mapKnowledge (identical ref)', foxxiKA.mapKnowledge === agpKA.mapKnowledge);
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
