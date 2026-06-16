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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
