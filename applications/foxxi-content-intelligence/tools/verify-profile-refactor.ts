/**
 * Confirms the buildProfileDoc parameterization (Stage-2 seam 3) did NOT change
 * Foxxi's served profile (conformance depends on it), and that the generic
 * builder works for a composing vertical's own profile.
 *
 * Run from context-graphs/: npx tsx applications/foxxi-content-intelligence/tools/verify-profile-refactor.ts
 */
import { buildFoxxiProfileDoc, buildProfileDoc, FOXXI_PROFILE_PARTS, FOXXI_PROFILE_ID } from '../src/xapi-profile.js';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

const doc = buildFoxxiProfileDoc({ generatedAt: '2026-01-01T00:00:00Z' }) as Record<string, unknown>;
const keys = Object.keys(doc);
check('Foxxi profile id unchanged', doc.id === FOXXI_PROFILE_ID);
check('top-level key order unchanged', JSON.stringify(keys) === JSON.stringify(['@context', 'id', 'type', 'conformsTo', 'prefLabel', 'definition', 'seeAlso', 'versions', 'author', 'concepts', 'templates', 'patterns']), keys.join(','));
const expConcepts = FOXXI_PROFILE_PARTS.verbs.length + FOXXI_PROFILE_PARTS.activityTypes.length + FOXXI_PROFILE_PARTS.extensions.length;
check('concept count = verbs+activityTypes+extensions', (doc.concepts as unknown[]).length === expConcepts, `${(doc.concepts as unknown[]).length} === ${expConcepts}`);
check('templates count preserved', (doc.templates as unknown[]).length === FOXXI_PROFILE_PARTS.templates.length);
check('patterns count preserved', (doc.patterns as unknown[]).length === FOXXI_PROFILE_PARTS.patterns.length);
check('concepts are type-tagged', (doc.concepts as Array<Record<string, unknown>>).every(c => typeof c.type === 'string'));
check('versions id derives from profile id', JSON.stringify(doc.versions).includes(`${FOXXI_PROFILE_ID}/v/1`));

// Generic builder works for a composing vertical's own profile.
const agpDoc = buildProfileDoc({
  id: 'https://example.org/agp/xapi/profile',
  prefLabel: { en: 'Agentic Performance — xAPI Profile' },
  definition: { en: 'Composes the performed verb; adds capability/actualizedAffordance/regime context extensions.' },
  author: { type: 'Organization', name: 'agp' },
  generatedAt: '2026-01-01T00:00:00Z',
  concepts: [{ id: 'https://example.org/agp#capability', type: 'ContextExtension', prefLabel: { en: 'capability' } }],
  templates: [], patterns: [],
}) as Record<string, unknown>;
check('buildProfileDoc honors a custom id', agpDoc.id === 'https://example.org/agp/xapi/profile');
check('buildProfileDoc carries custom concepts', (agpDoc.concepts as unknown[]).length === 1);
check('buildProfileDoc omits seeAlso when absent', !('seeAlso' in agpDoc));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
