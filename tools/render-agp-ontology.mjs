// Run from the repository root: node --import tsx tools/render-agp-ontology.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTrig, readStringValue } from '@interego/core';
import { AGP_NS, readOntologyTurtle, readShapesTurtle } from '../applications/agentic-performance-practice/src/ontology.ts';
const path = 'docs/applications/agentic-performance-practice/';
const ttl = readOntologyTurtle();
writeFileSync(path + 'agp.ttl', ttl);
writeFileSync(path + 'agp-shapes.ttl', readShapesTurtle());
const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const merged = new Map();
for (const subject of parseTrig(ttl).subjects) {
  if (typeof subject.subject !== 'string' || !subject.subject.startsWith(AGP_NS)) continue;
  const node = merged.get(subject.subject) ?? { subject: subject.subject, properties: new Map() };
  for (const [predicate, terms] of subject.properties) node.properties.set(predicate, [...(node.properties.get(predicate) ?? []), ...terms]);
  merged.set(subject.subject, node);
}
const nodes = [...merged.values()];
const doc = readFileSync(path + 'agp.html', 'utf8');
const boundary = doc.search(/\s*<h2>(?:Terms|Consulting and intervention methods)/);
const head = doc.slice(0, boundary).replace(/\d+ terms(?: and method resources)?\./, `${nodes.length} terms and method resources.`);
const guidance = '<h2>Consulting and intervention methods</h2><p>The ontology includes a performance consulting and management cycle plus methods for instruction, in-flow support, reference, practice, assessment, coaching, probes, environmental changes and monitoring without intervention. Each profile defines steps, required work products, evidence criteria and revision paths. These are project-authored practice profiles; evidence coverage does not certify quality or prove effects.</p><p><a href="https://foxxi-bridge.interego.xwisee.com/performance/methods?format=markdown">Read and follow the live method catalogue</a>. The full connected graph is included in the Turtle representation above.</p>';
const body = nodes.sort((a,b) => String(a.subject).localeCompare(String(b.subject))).map(s => {
  const id = s.subject.slice(AGP_NS.length);
  const label = readStringValue(s, 'http://www.w3.org/2000/01/rdf-schema#label') ?? id;
  const comment = readStringValue(s, 'http://www.w3.org/2000/01/rdf-schema#comment') ?? readStringValue(s, AGP_NS+'appliesWhen') ?? '';
  return `  <div id="${escape(id)}" class="term"><code>agp:${escape(id)}</code> <span class="kind">${escape(label)}</span><div class="c">${escape(comment)}</div></div>`;
}).join('\n');
writeFileSync(path + 'agp.html', head + guidance + '\n<h2>Terms and method resources</h2>\n' + body + '\n</body>\n</html>\n');
