/**
 * GAP 5 verification: the mesh projector emits expressive verbs (modal-derived +
 * self-declared) instead of monoculture `performed`, and the profile carries the
 * structural verb templates. Pure (deterministic) — exact deployed source.
 *
 * Run from context-graphs/: npx tsx applications/foxxi-content-intelligence/tools/verify-gap5-verbs.ts
 */
import { projectMeshEntry, type MeshDiscoverEntry } from '../src/mesh-event-projector.js';
import { PERFORMED_VERB, INTENDED_VERB, CONSIDERED_VERB } from '../src/learner-record.js';
import { buildFoxxiProfileDoc } from '../src/xapi-profile.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
const POD = 'https://pod.example/eth-x/';
const base = { descriptorUrl: 'https://pod.example/eth-x/contexts/d-1.json', describes: ['urn:g:1781000000000'] };
const verbOf = (e: Partial<MeshDiscoverEntry>): string =>
  ((projectMeshEntry({ ...base, ...e } as MeshDiscoverEntry, POD)!.statement.verb as { id: string }).id);

console.log('[GAP5] modal-derived verbs (no monoculture)');
check('Asserted -> performed', verbOf({ modalStatus: 'Asserted' }) === PERFORMED_VERB);
check('Hypothetical -> intended', verbOf({ modalStatus: 'Hypothetical' }) === INTENDED_VERB, verbOf({ modalStatus: 'Hypothetical' }));
check('Counterfactual -> considered', verbOf({ modalStatus: 'Counterfactual' }) === CONSIDERED_VERB);
check('Retracted -> voided', verbOf({ modalStatus: 'Retracted' }).endsWith('/voided'));
check('default (no modal) -> performed', verbOf({}) === PERFORMED_VERB);

console.log('\n[GAP5] self-declared verb passthrough (source-provided granularity)');
check('bare token namespaced under Foxxi verbs', verbOf({ modalStatus: 'Asserted', verb: 'reviewed' }).endsWith('#verbs/reviewed'), verbOf({ modalStatus: 'Asserted', verb: 'reviewed' }));
check('full IRI relayed verbatim', verbOf({ modalStatus: 'Asserted', verb: 'https://example.org/v#decided' }) === 'https://example.org/v#decided');
check('declared verb wins over modal default', verbOf({ modalStatus: 'Hypothetical', verb: 'proposed' }).endsWith('#verbs/proposed'));
check('Retracted still voids even with a declared verb', verbOf({ modalStatus: 'Retracted', verb: 'whatever' }).endsWith('/voided'));

console.log('\n[GAP5] profile carries the structural verb templates');
const doc = buildFoxxiProfileDoc({ generatedAt: '2026-01-01T00:00:00Z' }) as Record<string, unknown>;
const tmplIds = (doc.templates as Array<{ id: string }>).map(t => t.id);
check('intended-descriptor template present', tmplIds.some(id => id.endsWith('/templates/intended-descriptor')));
check('considered-descriptor template present', tmplIds.some(id => id.endsWith('/templates/considered-descriptor')));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
