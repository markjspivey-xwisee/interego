// Mirrors the relay's nsMarkdown() (deploy/mcp-relay/ns-dereference.ts) with Interego's own core functions,
// to preview the HyperMarkdown projection the relay serves for a published /ns graph.
// Usage: ICORE=<path to interego packages/core/src> tsx hmd-render.mts <file.ttl> <graph IRI> <owner> <slug> <out.md>
import { readFileSync, writeFileSync } from 'node:fs';
const { extractAffordancesFromTurtle } = await import(`${process.env.ICORE}/kernel/affordance-extraction.ts`);
const { controlsFromAffordances, renderHypermediaMarkdown } = await import(`${process.env.ICORE}/kernel/hypermedia-markdown.ts`);
const [file, iri, owner, slug, out] = process.argv.slice(2);
const turtle = readFileSync(file, 'utf8');
const isOntology = /\bowl:Ontology\b/.test(turtle);
const descriptorUrl = iri;
const controls = controlsFromAffordances(extractAffordancesFromTurtle(turtle, descriptorUrl, { requireTarget: false }));
const body = [
  `# ${slug}`, ``,
  `A published Interego holon on \`${owner}\`'s pod, projected as a HyperMarkdown`,
  `document. The Turtle / JSON-LD projections linked below are the same graph`,
  `resource — request them by content negotiation.`,
  ...(isOntology ? [``, 'This graph is an `owl:Ontology`; its terms resolve as `#fragment`s of this IRI.'] : []),
  ...(controls.length === 0 ? [``, `This graph publishes no controls.`] : []),
].join('\n');
const md = renderHypermediaMarkdown({
  id: iri, type: isOntology ? 'owl:Ontology' : 'iep:ContextDescriptor', descriptorUrl, title: slug, state: 'published',
  fields: { 'dct:publisher': owner },
  links: [
    { label: 'Signed descriptor (authority)', href: descriptorUrl, rel: 'describedby', type: 'text/turtle' },
    { label: 'Turtle', href: `${iri}?format=turtle`, rel: 'alternate', type: 'text/turtle' },
    { label: 'JSON-LD', href: `${iri}?format=jsonld`, rel: 'alternate', type: 'application/ld+json' },
  ],
  controls, body,
});
writeFileSync(out, md);
process.stdout.write(JSON.stringify({ controls: controls.length, bytes: md.length }) + '\n');
