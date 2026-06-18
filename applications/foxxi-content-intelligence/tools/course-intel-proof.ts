/**
 * Headless proof of the course-intelligence composition (no bridge boot, no pod):
 *   fingerprintAuthoringTool + manifestToAgenticCourse + retrieveCourseContext
 * over the REAL Rustici golf manifest that ships in this repo.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/course-intel-proof.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprintAuthoringTool } from '../src/scorm-fingerprint.js';
import { manifestToAgenticCourse } from '../src/course-graph.js';
import { retrieveCourseContext } from '../src/agentic-rag.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestXml = readFileSync(join(here, '../../../deploy/foxxi-scorm-player/site/course/imsmanifest.xml'), 'utf8');

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = ''): void => { if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

console.log('[1] fingerprint the real golf package (manifest-only)');
const fp = fingerprintAuthoringTool({ manifestXml });
ok('does NOT invent a tool (hand-authored)', fp.toolId === 'hand-authored', `${fp.tool} · conf ${fp.confidence}`);
ok('detects the standard', fp.standard.standardId === 'SCORM_2004', fp.standard.standard);
console.log(`     summary: ${fp.summary}`);

console.log('\n[2] fingerprint a Storyline package (file-tree signals)');
const fp2 = fingerprintAuthoringTool({
  fileList: ['story.html', 'story_content/slides.js', 'html5/data/js/data.js'],
  fileContents: { 'html5/data/js/data.js': '{"projectId":"a","courseId":"b","version":"3.95.0.0"}' },
});
ok('detects Articulate Storyline', fp2.toolId === 'articulate-storyline', `${fp2.tool} v${fp2.version} · conf ${fp2.confidence}`);

console.log('\n[3] manifest → course knowledge-graph');
const built = manifestToAgenticCourse({ manifestXml, courseIri: 'urn:foxxi:course:golf', authoritativeSource: 'urn:foxxi:course:golf' });
ok('course id + title parsed', !!built.structure.courseId && !!built.structure.courseTitle, `${built.structure.courseTitle}`);
ok('topic concepts derived from file tree', built.course.concepts.length >= 3, `concepts: ${built.course.concepts.map(c => c.label).join(', ')}`);
ok('slides derived from content pages', built.course.slides.length >= 5, `${built.course.slides.length} slides`);
ok('spine terms for the PGSL holon', built.spineTerms.length >= 5, `${built.spineTerms.length} terms`);

console.log('\n[4] grounded retrieval over the course KG (key-less)');
const r = retrieveCourseContext({ question: 'How is a golf handicap calculated?', learnerDid: 'urn:demo:asker', primary: built.course });
ok('retrieval returns seed concepts', r.retrieval.seedConcepts.length > 0, `seeds: ${r.retrieval.seedConcepts.map(s => s.conceptLabel).join(', ')}`);
ok('on-topic question is a real graph hit (grounded)', r.retrieval.retrievalKind === 'graph', `retrievalKind=${r.retrieval.retrievalKind}`);
ok('retrieval cites slides from the course', r.retrieval.citedSlides.length > 0, `cited: ${r.retrieval.citedSlides.map(s => s.slideTitle).slice(0, 4).join(' | ')}`);

console.log('\n[5] OFF-topic question → honest fallback (NOT reported as grounded)');
const off = retrieveCourseContext({ question: 'What is the airspeed velocity of an unladen swallow?', learnerDid: 'urn:demo:asker', primary: built.course });
ok('off-topic resolves to fallback retrievalKind', off.retrieval.retrievalKind === 'fallback', `retrievalKind=${off.retrieval.retrievalKind}, seeds=${off.retrieval.seedConcepts.length}`);
ok('grounded gate (retrievalKind===graph && seeds>0) is FALSE for off-topic', !(off.retrieval.retrievalKind === 'graph' && off.retrieval.seedConcepts.length > 0));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
